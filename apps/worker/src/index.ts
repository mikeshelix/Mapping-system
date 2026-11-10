// Worker process: polls hazard feeds, matches properties, queues and sends notifications.
// Each job runs in its own loop, so a failing or slow feed never blocks the others.
import '@hazard/db/src/env';
import { evaluatePendingEvents, getSql } from '@hazard/db';
import { fetchMissingZones, NWS_FEED, pollNwsAlerts } from './nws';
import { createEmailProvider } from './providers';
import { alertOnStaleFeeds, sendQueued } from './sender';
import { backoffMs, errorMessage, log, sleep } from './util';

interface Job {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
}

const sql = getSql();
const email = createEmailProvider();
const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
// NWS asks for no more than one request every 30 seconds.
const nwsPollSeconds = Math.max(30, Number(process.env.NWS_POLL_SECONDS) || 60);
const nwsStaleSeconds = Number(process.env.NWS_STALE_AFTER_SECONDS) || 600;

const jobs: Job[] = [
  { name: 'nws-alerts', intervalMs: nwsPollSeconds * 1000, run: () => pollNwsAlerts(sql) },
  { name: 'nws-zones', intervalMs: 15_000, run: () => fetchMissingZones(sql) },
  { name: 'evaluate', intervalMs: 10_000, run: () => evaluatePendingEvents(sql, { appBaseUrl }) },
  { name: 'send', intervalMs: 10_000, run: () => sendQueued(sql, email) },
  { name: 'feed-health', intervalMs: 60_000, run: () => alertOnStaleFeeds(sql) },
];

let stopping = false;

async function runLoop(job: Job): Promise<void> {
  let failures = 0;
  while (!stopping) {
    try {
      await job.run();
      failures = 0;
    } catch (err) {
      failures++;
      log('error', 'job failed', { job: job.name, failures, error: errorMessage(err) });
    }
    // Back off after failures (up to 15 minutes), then return to the normal schedule.
    const wait = failures ? backoffMs(failures, job.intervalMs, 15 * 60_000) : job.intervalMs;
    const until = Date.now() + wait;
    while (!stopping && Date.now() < until) await sleep(Math.min(500, until - Date.now()));
  }
}

await sql`
  INSERT INTO feed_status (feed, stale_after_seconds) VALUES (${NWS_FEED}, ${nwsStaleSeconds})
  ON CONFLICT (feed) DO UPDATE SET stale_after_seconds = EXCLUDED.stale_after_seconds`;

log('info', 'worker started', { jobs: jobs.map((j) => j.name), emailProvider: email.name, nwsPollSeconds });
const loops = jobs.map(runLoop);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log('info', 'worker stopping', { signal });
  });
}
process.on('unhandledRejection', (err) => log('error', 'unhandled rejection', { error: errorMessage(err) }));

await Promise.all(loops);
await sql.end({ timeout: 5 });
log('info', 'worker stopped');
