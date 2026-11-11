import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Whether the Anthropic SDK has something to sign in with. It accepts, in order:
 * ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or a profile saved by `ant auth login`
 * (used on a developer machine; servers should use an API key).
 * Only the presence of the profile file is checked here; the SDK reads it.
 */
export function assistantConnected(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  const profile = process.env.ANTHROPIC_PROFILE || 'default';
  if (!/^[\w.-]+$/.test(profile)) return false;
  return existsSync(join(homedir(), '.config', 'anthropic', 'credentials', `${profile}.json`));
}
