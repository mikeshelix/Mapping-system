import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { ASSISTANT_QUESTION_MAX, ZERO_USAGE, readAssistantCap } from '@hazard/core';
import { assistantUsageThisMonth, getSql, recordAssistantUsage, runAssistantTool } from '@hazard/db';
import { getUser } from '@/lib/auth';
import { DEFAULT_ASSISTANT_MODEL, askAssistant, type Effort, type HistoryTurn } from '@/lib/assistant';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const model = () => process.env.ASSISTANT_MODEL || DEFAULT_ASSISTANT_MODEL;
const effort = (): Effort => (['low', 'medium', 'high'].includes(process.env.ASSISTANT_EFFORT ?? '') ? (process.env.ASSISTANT_EFFORT as Effort) : 'medium');
const connected = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
/** Hard ceiling on assistant spend across all organizations in a calendar month, in US dollars. */
function platformBudgetUsd(): number {
  const v = Number(process.env.ASSISTANT_MONTHLY_BUDGET_USD);
  return Number.isFinite(v) && v >= 0 && process.env.ASSISTANT_MONTHLY_BUDGET_USD ? v : 150;
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
  return NextResponse.json({ connected: connected(), cap: l.cap, used: l.used, remaining: l.remaining, available: connected() && l.remaining > 0 && l.budgetLeft });
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

  try {
    const result = await askAssistant({
      create: (params) => client.beta.messages.create(params),
      // The organization comes from the signed-in session, never from the model.
      runTool: (name, input) => runAssistantTool(sql, user.organizationId, name, input),
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
