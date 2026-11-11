// The assistant's request loop, driven by a scripted stand-in for the model. No network, no API key.
import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { MAX_REQUESTS, askAssistant, type CreateMessage, type RunTool } from './assistant';

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type Params = Parameters<CreateMessage>[0];

let nextId = 0;
function reply(stop: string, content: unknown[], usage: Partial<Record<string, number>> = {}): BetaMessage {
  return {
    id: `msg_${nextId++}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_reason: stop,
    content,
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
  } as unknown as BetaMessage;
}
const text = (t: string) => ({ type: 'text', text: t });
const call = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });

/** A model that returns the scripted replies in order and records what it was sent. */
function script(replies: BetaMessage[]) {
  const seen: Params[] = [];
  const create: CreateMessage = async (params) => {
    // Copy: the loop keeps appending to the same messages array.
    seen.push(JSON.parse(JSON.stringify(params)) as Params);
    const next = replies[seen.length - 1];
    if (!next) throw new Error('script ran out');
    return next;
  };
  return { create, seen };
}
const base = { model: 'claude-opus-5-5', effort: 'medium' as const, today: 'Tuesday, November 10, 2026 (UTC)' };

describe('assistant loop', () => {
  it('answers directly when no lookup is needed', async () => {
    const { create, seen } = script([reply('end_turn', [text('Hello.')])]);
    const runTool: RunTool = async () => {
      throw new Error('should not be called');
    };
    const r = await askAssistant({ ...base, create, runTool, question: 'Hi' });
    expect(r).toMatchObject({ status: 'ok', answer: 'Hello.', requests: 1, toolCalls: 0, map: null });
    expect(seen[0]!.messages).toEqual([{ role: 'user', content: 'Today is Tuesday, November 10, 2026 (UTC).\n\nHi' }]);
    // The date travels with the question so the instructions stay identical between requests.
    expect(seen[0]!.system).not.toContain('2026');
    expect(seen[0]!.model).toBe('claude-opus-5-5');
    expect(seen[0]!.output_config).toEqual({ effort: 'medium' });
  });

  it('runs the lookups the model asks for, returns all results in one message, and adds up usage', async () => {
    const { create, seen } = script([
      reply('tool_use', [text('Checking.'), call('a', 'active_hazards', {}), call('b', 'portfolio_summary', { group_by: 'client' })], { input_tokens: 1000, output_tokens: 50 }),
      reply('tool_use', [call('c', 'show_on_map', { property_ids: ['p1'], title: 'Hit by the tornado' })], { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 1000 }),
      reply('end_turn', [text('One property is under a tornado warning.')], { input_tokens: 150, output_tokens: 30, cache_read_input_tokens: 1200, cache_creation_input_tokens: 40 }),
    ]);
    const calls: Array<[string, unknown]> = [];
    const runTool: RunTool = async (name, input) => {
      calls.push([name, input]);
      if (name === 'show_on_map') return { result: { shown: true }, map: { title: 'Hit by the tornado', points: [{ id: 'p1', name: 'A', lon: -95, lat: 29 }], eventId: null, eventName: null, bbox: null } };
      return { result: { tool: name } };
    };
    const r = await askAssistant({ ...base, create, runTool, question: 'What is affected?' });
    expect(r.status).toBe('ok');
    expect(r.answer).toBe('One property is under a tornado warning.');
    expect(r.requests).toBe(3);
    expect(r.toolCalls).toBe(3);
    expect(r.map?.title).toBe('Hit by the tornado');
    expect(r.usage).toEqual({ inputTokens: 1350, outputTokens: 100, cacheReadTokens: 2200, cacheWriteTokens: 40 });
    expect(calls.map((c) => c[0])).toEqual(['active_hazards', 'portfolio_summary', 'show_on_map']);

    // Second request: the model's turn, then one user message holding both results in call order.
    const second = seen[1]!.messages;
    expect(second).toHaveLength(3);
    expect(second[1]!.role).toBe('assistant');
    expect(second[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: '{"tool":"active_hazards"}' },
        { type: 'tool_result', tool_use_id: 'b', content: '{"tool":"portfolio_summary"}' },
      ],
    });
  });

  it('sends earlier turns of the conversation before the new question', async () => {
    const { create, seen } = script([reply('end_turn', [text('Two.')])]);
    await askAssistant({ ...base, create, runTool: async () => ({ result: {} }), question: 'And in Texas?', history: [{ role: 'user', text: 'How many?' }, { role: 'assistant', text: 'Five.' }] });
    expect(seen[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('tells the model when a lookup failed instead of failing the whole answer', async () => {
    const { create, seen } = script([reply('tool_use', [call('a', 'active_hazards', {})]), reply('end_turn', [text('I could not check hazards just now.')])]);
    const r = await askAssistant({
      ...base,
      create,
      runTool: async () => {
        throw new Error('connection refused to 10.0.0.5');
      },
      question: 'q',
    });
    expect(r.status).toBe('ok');
    const result = (seen[1]!.messages[2]!.content as unknown as Array<Record<string, unknown>>)[0]!;
    expect(result.is_error).toBe(true);
    // Internal error details are not passed to the model.
    expect(JSON.stringify(result)).not.toContain('10.0.0.5');
  });

  it('replaces an oversized result with a short error', async () => {
    const { create, seen } = script([reply('tool_use', [call('a', 'search_properties', {})]), reply('end_turn', [text('Too many to list.')])]);
    await askAssistant({ ...base, create, runTool: async () => ({ result: { blob: 'x'.repeat(70_000) } }), question: 'q' });
    const result = (seen[1]!.messages[2]!.content as unknown as Array<{ content: string }>)[0]!;
    expect(result.content.length).toBeLessThan(200);
  });

  it('reports a refusal without running any lookups from that turn', async () => {
    const { create } = script([reply('refusal', [call('a', 'active_hazards', {})])]);
    let ran = false;
    const r = await askAssistant({
      ...base,
      create,
      runTool: async () => {
        ran = true;
        return { result: {} };
      },
      question: 'q',
    });
    expect(r.status).toBe('refused');
    expect(ran).toBe(false);
  });

  it('marks an answer cut off by length as incomplete and does not run a cut-off lookup', async () => {
    const { create } = script([reply('max_tokens', [text('The first part'), call('a', 'active_hazards', {})])]);
    let ran = false;
    const r = await askAssistant({
      ...base,
      create,
      runTool: async () => {
        ran = true;
        return { result: {} };
      },
      question: 'q',
    });
    expect(r).toMatchObject({ status: 'incomplete', answer: 'The first part' });
    expect(ran).toBe(false);
  });

  it('stops after a fixed number of round trips, which bounds what one question can cost', async () => {
    const { create, seen } = script(Array.from({ length: MAX_REQUESTS + 5 }, (_, i) => reply('tool_use', [call(`c${i}`, 'active_hazards', {})])));
    const r = await askAssistant({ ...base, create, runTool: async () => ({ result: {} }), question: 'q' });
    expect(r.status).toBe('incomplete');
    expect(r.requests).toBe(MAX_REQUESTS);
    expect(seen).toHaveLength(MAX_REQUESTS);
    expect(r.usage.inputTokens).toBe(100 * MAX_REQUESTS);
  });
});
