import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { ASSISTANT_QUESTION_MAX, PLACES_SYSTEM, PLACES_TOOL, ZERO_USAGE, cleanText, cleanUuid, readAssistantCap, readPlacesCap } from '@hazard/core';
import { assistantUsageThisMonth, getSql, placeLookupsThisMonth, propertyPoint, recordAssistantUsage, recordPlaceLookup, runAssistantTool, type Sql } from '@hazard/db';
import { getUser } from '@/lib/auth';
import { assistantConnected as assistantConnectedCheck } from '@/lib/assistantAuth';
import { DEFAULT_ASSISTANT_MODEL, askAssistant, type Effort, type HistoryTurn, type RunTool } from '@/lib/assistant';
import { GooglePlacesError, googlePlacesEnabled, searchGooglePlaces } from '@/lib/googlePlaces';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const model = () => process.env.ASSISTANT_MODEL || DEFAULT_ASSISTANT_MODEL;
const effort = (): Effort => (['low', 'medium', 'high'].includes(process.env.ASSISTANT_EFFORT ?? '') ? (process.env.ASSISTANT_EFFORT as Effort) : 'medium');
const connected = assistantConnectedCheck;
/** Hard ceiling on assistant spend across all organizations in a calendar month, in US dollars. */
function platformBudgetUsd(): number {
  const v = Number(process.env.ASSISTANT_MONTHLY_BUDGET_USD);
  return Number.isFinite(v) && v >= 0 && process.env.ASSISTANT_MONTHLY_BUDGET_USD ? v : 150;
}

/**
 * The one assistant tool that leaves the platform: a Google Maps place search.
 * Only the search words and, when a property is named, its coordinates are sent to Google.
 */
async function nearbyBusinesses(sql: Sql, user: { id: string; organizationId: string }, rawInput: unknown): ReturnType<RunTool> {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  const query = cleanText(input.query, 120);
  if (!query) return { result: { error: 'Say what kind of business or place to look for.' } };
  const propertyId = cleanUuid(input.property_id);
  const near = cleanText(input.near, 120);
  // The property is looked up inside the signed-in organization, so another organization's id finds nothing.
  const property = propertyId ? await propertyPoint(sql, user.organizationId, propertyId) : null;
  if (propertyId && !property) return { result: { error: 'No property with that id was found in this portfolio.' } };
  if ((await placeLookupsThisMonth(sql)) >= readPlacesCap(process.env.GOOGLE_PLACES_MONTHLY_CAP)) {
    return { result: { error: 'Business lookups have reached their limit for this month. Tell the user they will work again next month.' } };
  }
  const textQuery = near && !property ? `${query} near ${near}` : query;
  const started = Date.now();
  const log = (status: 'ok' | 'error', resultCount: number, error?: string) =>
    recordPlaceLookup(sql, { organizationId: user.organizationId, userId: user.id, query: textQuery, resultCount, status, error, durationMs: Date.now() - started }).catch(() => {});
  try {
    const found = await searchGooglePlaces(textQuery, property ? { lat: property.lat, lon: property.lon } : null);
    await log('ok', found.places.length);
    return {
      result: {
        source: 'Google Maps',
        searched_near: property ? property.name : (near ?? 'the place named in the query'),
        summary: found.summary,
        places: found.places.map((p, i) => ({ ref: i, name: p.name })),
        note: found.places.length === 0 ? 'Google Maps returned no places for this search.' : 'Links to these places are shown to the user under your answer.',
      },
      sources: found.sources,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[assistant] google places', detail);
    // A failed request is still counted: Google may have billed it.
    await log('error', 0, detail);
    const denied = error instanceof GooglePlacesError && (error.status === 401 || error.status === 403);
    return { result: { error: denied ? 'The business lookup is not set up correctly. An administrator needs to check the Google Maps key.' : 'The business lookup failed just now.' } };
  }
}

async function limits(organizationId: string) {
  const sql = getSql();
  const [[org], mine, everyone] = await Promise.all([
    sql`SELECT settings FROM organizations WHERE id = ${organizationId}`,
    assistantUsageThisMonth(sql, organizationId),
    assistantUsageThisMonth(sql, null),
  ]);
  const cap = readAssistantCap(org?.settings);
  return { cap, used: mine.questions, remaining: Math.max(0, cap - mine.questions), budgetLeft: everyone.costUsd < platformBudgetUsd() };
}

/** Whether the assistant can be used right now, and how many questions are left this month. */
export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const l = await limits(user.organizationId);
  return NextResponse.json({ connected: connected(), places: googlePlacesEnabled(), cap: l.cap, used: l.used, remaining: l.remaining, available: connected() && l.remaining > 0 && l.budgetLeft });
}

function readHistory(value: unknown): HistoryTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: HistoryTurn[] = [];
  for (const t of value.slice(-6)) {
    const role = (t as { role?: unknown })?.role;
    const text = (t as { text?: unknown })?.text;
    if ((role === 'user' || role === 'assistant') && typeof text === 'string' && text.trim()) turns.push({ role, text: text.slice(0, 4000) });
  }
  // The API needs the conversation to open with the user.
  while (turns[0] && turns[0].role !== 'user') turns.shift();
  return turns;
}

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { question?: unknown; history?: unknown } | null;
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question) return NextResponse.json({ error: 'Type a question first.' }, { status: 400 });
  if (question.length > ASSISTANT_QUESTION_MAX) {
    return NextResponse.json({ error: `Questions can be at most ${ASSISTANT_QUESTION_MAX} characters.` }, { status: 400 });
  }
  if (!connected()) return NextResponse.json({ error: 'The assistant is not connected yet. An administrator needs to add an Anthropic API key.' }, { status: 503 });

  const l = await limits(user.organizationId);
  if (l.remaining <= 0) {
    return NextResponse.json({ error: `Your organization has used all ${l.cap} assistant questions for this month. An administrator can change the limit in Settings.` }, { status: 429 });
  }
  if (!l.budgetLeft) return NextResponse.json({ error: 'The assistant is paused until next month because its monthly budget has been reached.' }, { status: 429 });

  const sql = getSql();
  const started = Date.now();
  const client = new Anthropic({ timeout: 60_000, maxRetries: 1 });
  const record = (status: 'ok' | 'error' | 'refused' | 'incomplete', r: { usage?: typeof ZERO_USAGE; requests?: number; toolCalls?: number; error?: string }) =>
    recordAssistantUsage(sql, {
      organizationId: user.organizationId,
      userId: user.id,
      question,
      model: model(),
      status,
      requests: r.requests ?? 0,
      toolCalls: r.toolCalls ?? 0,
      usage: r.usage ?? ZERO_USAGE,
      durationMs: Date.now() - started,
      error: r.error ?? null,
    });

  const places = googlePlacesEnabled();
  try {
    const result = await askAssistant({
      create: (params) => client.beta.messages.create(params),
      // The organization comes from the signed-in session, never from the model.
      runTool: (name, input) => (places && name === PLACES_TOOL.name ? nearbyBusinesses(sql, user, input) : runAssistantTool(sql, user.organizationId, name, input)),
      ...(places ? { extra: { tools: [PLACES_TOOL], system: PLACES_SYSTEM } } : {}),
      model: model(),
      effort: effort(),
      question,
      history: readHistory(body?.history),
      today: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) + ' (UTC)',
    });
    const cost = await record(result.status, result);
    return NextResponse.json({
      status: result.status,
      answer: result.answer,
      map: result.map,
      sources: result.sources,
      remaining: Math.max(0, l.remaining - 1),
      // Cost is shown to administrators only; everyone's is stored for billing.
      ...(user.role === 'admin' ? { costUsd: cost } : {}),
    });
  } catch (error) {
    let message = 'The assistant could not answer just now. Please try again.';
    let status = 502;
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      message = 'The assistant is not connected correctly. An administrator needs to check the Anthropic API key.';
      status = 503;
    } else if (error instanceof Anthropic.RateLimitError) {
      message = 'The assistant is busy. Please try again in a minute.';
      status = 429;
    } else if (error instanceof Anthropic.APIConnectionError) {
      message = 'The assistant service could not be reached. Please try again.';
    }
    const detail = error instanceof Anthropic.APIError ? `${error.status ?? ''} ${error.message}` : error instanceof Error ? error.message : String(error);
    console.error('[assistant]', detail);
    // Nothing is billed for a request that failed outright, but the attempt is still logged.
    await record('error', { error: detail }).catch(() => {});
    return NextResponse.json({ error: message }, { status });
  }
}
