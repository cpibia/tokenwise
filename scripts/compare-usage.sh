#!/bin/sh
# Compares Claude Code token spend before and after tokenwise. Options: --from YYYY-MM-DD, --before YYYY-MM-DD --after YYYY-MM-DD, --days N, --requests N, --classifier sonnet|haiku, --markdown
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.18 or later is required." >&2
  exit 1
fi

node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 22 ]; then
  echo "Node.js 22.18 or later is required (found $(node --version))." >&2
  exit 1
fi

exec node --no-warnings "$(dirname "$0")/compare-usage.ts" "$@"
