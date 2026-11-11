'use client';

import { useEffect, useRef, useState } from 'react';
import { ASSISTANT_QUESTION_MAX } from '@hazard/core';
import type { MapAction } from '@hazard/db';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  /** Shown to administrators only. */
  costUsd?: number | null;
  mapTitle?: string;
  problem?: boolean;
}
interface Status {
  connected: boolean;
  available: boolean;
  cap: number;
  remaining: number;
}

const EXAMPLES = [
  'Which properties are affected right now, worst first?',
  'How much declared value is under a severe or extreme hazard?',
  'Which client has the most properties affected?',
  'What hazards have hit our Texas properties in the last 30 days?',
];

/** Ask questions about the portfolio in plain language. Answers come from read-only lookups and can move the map. */
export function AssistantPanel({ onMap }: { onMap: (action: MapAction | null) => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/assistant', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Status | null) => setStatus(s))
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [turns, busy]);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    // Earlier turns that failed are not sent back as conversation.
    const history = turns.filter((t) => !t.problem).map((t) => ({ role: t.role, text: t.text }));
    setTurns((prev) => [...prev, { role: 'user', text: q }]);
    setQuestion('');
    setBusy(true);
    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, history }),
      });
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        answer?: string;
        status?: string;
        map?: MapAction | null;
        remaining?: number;
        costUsd?: number | null;
      };
      if (!res.ok || !json.answer) {
        setTurns((prev) => [...prev, { role: 'assistant', text: json.error ?? 'The assistant could not answer just now. Please try again.', problem: true }]);
        return;
      }
      setTurns((prev) => [
        ...prev,
        { role: 'assistant', text: json.answer!, costUsd: json.costUsd, mapTitle: json.map?.title, problem: json.status !== 'ok' },
      ]);
      if (json.map) onMap(json.map);
      if (typeof json.remaining === 'number') setStatus((s) => (s ? { ...s, remaining: json.remaining!, available: s.available && json.remaining! > 0 } : s));
    } catch {
      setTurns((prev) => [...prev, { role: 'assistant', text: 'The assistant could not be reached. Check your connection and try again.', problem: true }]);
    } finally {
      setBusy(false);
    }
  }

  const off = status !== null && !status.available;
  return (
    <div className="assistant">
      {status && !status.connected && (
        <div className="flash error">The assistant is not connected yet. An administrator needs to add an Anthropic API key.</div>
      )}
      {status && status.connected && !status.available && (
        <div className="flash error">The assistant has reached its limit for this month. An administrator can review this in Settings.</div>
      )}
      {turns.length === 0 && (
        <section>
          <p className="muted">Ask about your properties and the hazards affecting them. Answers come from your own data, and the map moves to what is found.</p>
          {EXAMPLES.map((e) => (
            <button key={e} type="button" className="example" disabled={busy || off} onClick={() => void ask(e)}>
              {e}
            </button>
          ))}
        </section>
      )}
      <div className="turns">
        {turns.map((t, i) => (
          <div key={i} className={`turn ${t.role}${t.problem ? ' problem' : ''}`}>
            {t.text}
            {t.mapTitle && <div className="small muted">Shown on the map: {t.mapTitle}</div>}
            {typeof t.costUsd === 'number' && <div className="small muted">Cost of this answer: ${t.costUsd.toFixed(4)}</div>}
          </div>
        ))}
        {busy && <div className="turn assistant muted">Looking that up…</div>}
        <div ref={end} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask(question);
            }
          }}
          maxLength={ASSISTANT_QUESTION_MAX}
          rows={3}
          placeholder="Ask about your portfolio"
          aria-label="Question for the assistant"
          disabled={off}
        />
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <button type="submit" disabled={busy || off || !question.trim()}>
            {busy ? 'Asking…' : 'Ask'}
          </button>
          {turns.length > 0 && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setTurns([]);
                onMap(null);
              }}
            >
              New conversation
            </button>
          )}
        </div>
      </form>
      <p className="small muted">
        {status?.connected ? `${status.remaining.toLocaleString()} of ${status.cap.toLocaleString()} questions left this month. ` : ''}
        Answers are written by an AI model from your portfolio data and can be wrong; check figures before acting on them. Questions and the
        portfolio details needed to answer them are sent to Anthropic.
      </p>
    </div>
  );
}
