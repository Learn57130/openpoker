#!/usr/bin/env bash
# OpenPoker setup: checks this computer and says how to start. It installs nothing and changes nothing.
# Run from anywhere: bash scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 20 or newer (https://nodejs.org), then run this again."
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 20 ]; then
  echo "Node.js $(node --version) is too old. Install Node.js 20 or newer (https://nodejs.org), then run this again."
  exit 1
fi

node ./bin/openpoker.mjs doctor
echo
echo "Commands (from this folder):"
echo "  npm start          the table on this computer: http://127.0.0.1:8787"
echo "  npm run lan        friends on your Wi-Fi can join"
echo "  npm run tunnel     friends anywhere can join (needs cloudflared)"
echo "  npm run doctor     check again"
echo "  npm link           (once) to type 'openpoker' anywhere instead"
