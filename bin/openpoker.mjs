#!/usr/bin/env node

import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).catch(error => {
  const payload = {
    status: 'failed',
    code: error?.code || 'OPENPOKER_ERROR',
    error: String(error?.message || error).slice(0, 1000)
  };
  console.error(JSON.stringify(payload));
  process.exitCode = error?.code === 'USAGE' ? 2 : 1;
});
