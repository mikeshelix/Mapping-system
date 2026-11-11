export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Delay before retry number `attempt` (1-based): base, 2x, 4x ... capped. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

export class HttpError extends Error {
  constructor(
    public status: number,
    url: string,
  ) {
    super(`HTTP ${status} from ${url}`);
  }
}

/**
 * fetch with a timeout and retries. Retries network failures, 429 and 5xx with
 * backoff; other statuses are returned to the caller to interpret.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: { attempts?: number; timeoutMs?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
      if (res.status !== 429 && res.status < 500) return res;
      lastError = new HttpError(res.status, url);
      await res.body?.cancel();
    } catch (err) {
      lastError = err;
    }
    if (attempt < attempts) await sleep(backoffMs(attempt, opts.baseDelayMs ?? 1000, 10_000));
  }
  throw lastError;
}
