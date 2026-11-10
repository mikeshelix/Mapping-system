// Loads the repo-root .env for command-line entry points (migrate, seed, worker).
import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env') });
