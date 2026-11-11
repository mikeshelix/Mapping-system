/**
 * The assistant's request loop: send the question, run whichever read-only tools
 * the model asks for, send the results back, repeat until it answers.
 *
 * The API call and the tool runner are passed in, so the loop can be tested
 * without a network or an API key.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { ASSISTANT_SYSTEM, ASSISTANT_TOOLS, ZERO_USAGE, addUsage, type TokenUsage } from '@hazard/core';
import type { MapAction, ToolOutcome } from '@hazard/db';

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

export type CreateMessage = (params: CreateParams) => Promise<BetaMessage>;
export type RunTool = (name: string, input: unknown) => Promise<ToolOutcome>;
export type Effort = 'low' | 'medium' | 'high';

export interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AskResult {
  /** ok: answered. refused: the model declined. incomplete: stopped before a full answer. */
  status: 'ok' | 'refused' | 'incomplete';
  answer: string;
  map: MapAction | null;
  usage: TokenUsage;
  requests: number;
  toolCalls: number;
}

/** A question may take this many round trips to the model before it is cut off, which bounds its cost. */
export const MAX_REQUESTS = 8;
const MAX_TOOL_RESULT_CHARS = 60_000;

export const DEFAULT_ASSISTANT_MODEL = 'claude-opus-5-5';

export async function askAssistant(opts: {
  create: CreateMessage;
  runTool: RunTool;
  model: string;
  effort: Effort;
  question: string;
  history?: HistoryTurn[];
  /** e.g. "Tuesday, November 10, 2026". Sent with the question, not in the system prompt, so the prompt stays cacheable. */
  today: string;
}): Promise<AskResult> {
  const messages: BetaMessageParam[] = [
    ...(opts.history ?? []).map((h): BetaMessageParam => ({ role: h.role, content: h.text })),
    { role: 'user', content: `Today is ${opts.today}.\n\n${opts.question}` },
  ];
  let usage: TokenUsage = ZERO_USAGE;
  let requests = 0;
  let toolCalls = 0;
  let map: MapAction | null = null;
  const done = (status: AskResult['status'], answer: string): AskResult => ({ status, answer, map, usage, requests, toolCalls });

  while (requests < MAX_REQUESTS) {
    requests++;
    const message = await opts.create({
      model: opts.model,
      max_tokens: 16000,
      system: ASSISTANT_SYSTEM,
      tools: ASSISTANT_TOOLS,
      messages,
      // Caches the instructions, tool list and the conversation so far between round trips.
      cache_control: { type: 'ephemeral' },
      output_config: { effort: opts.effort },
      // If the model declines on a safety classifier, the API retries on a fallback model in the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    usage = addUsage(usage, {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    });
    const text = message.content
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('\n')
      .trim();

    if (message.stop_reason === 'refusal') return done('refused', 'The assistant could not answer that question.');
    if (message.stop_reason === 'max_tokens') return done('incomplete', text || 'The answer was too long to finish. Try a narrower question.');
    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }
    const calls = message.content.flatMap((b) => (b.type === 'tool_use' ? [b] : []));
    if (message.stop_reason !== 'tool_use' || calls.length === 0) return done('ok', text || 'The assistant returned no answer.');

    messages.push({ role: 'assistant', content: message.content });
    toolCalls += calls.length;
    const results = await Promise.all(
      calls.map(async (call): Promise<Anthropic.Beta.Messages.BetaToolResultBlockParam> => {
        try {
          const outcome = await opts.runTool(call.name, call.input);
          if (outcome.map) map = outcome.map;
          let content = JSON.stringify(outcome.result);
          if (content.length > MAX_TOOL_RESULT_CHARS) content = JSON.stringify({ error: 'The result was too large. Narrow the filters or lower the limit.' });
          return { type: 'tool_result', tool_use_id: call.id, content };
        } catch {
          // Details stay in the server log; the model only needs to know the lookup failed.
          return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: 'This lookup failed. Try once more or answer without it.' };
        }
      }),
    );
    // All results go back in a single user message, in the order the calls were made.
    messages.push({ role: 'user', content: results });
  }
  return done('incomplete', 'That question needed more lookups than one answer allows. Try asking it in smaller parts.');
}
