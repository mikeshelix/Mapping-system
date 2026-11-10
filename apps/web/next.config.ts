import { config } from 'dotenv';
import { join } from 'node:path';
import type { NextConfig } from 'next';

// One .env at the repo root is shared by the web app, the worker and the scripts.
config({ path: join(process.cwd(), '..', '..', '.env') });

const nextConfig: NextConfig = {
  transpilePackages: ['@hazard/core', '@hazard/db'],
  serverExternalPackages: ['postgres', 'exceljs'],
  experimental: {
    serverActions: { bodySizeLimit: '25mb' },
  },
};

export default nextConfig;
