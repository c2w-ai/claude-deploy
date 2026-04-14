#!/usr/bin/env bash
# Run the claude-deploy backend locally. Needs a Railway project token
# (CD_TARGET_TOKEN) scoped to the user-apps project + environment.
#
# Usage:  bash scripts/run-backend-local.sh
# Env:
#   PORT              default 3030
#   CD_TARGET_TOKEN   required — Railway project token for user-apps project

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PORT="${PORT:-3030}"

# Set CD_TARGET_TOKEN in your shell before running this script.
# Get one by creating a Railway project token for your user-apps project
# (Project → Settings → Tokens in the Railway dashboard, or via the
# projectTokenCreate GraphQL mutation).
export CD_TARGET_TOKEN="${CD_TARGET_TOKEN:-}"

if [ -z "${CD_TARGET_TOKEN:-}" ]; then
  echo "❌ CD_TARGET_TOKEN is not set."
  echo ""
  echo "   Create a Railway project token for your user-apps project:"
  echo "   Project → Settings → Tokens, or via the GraphQL API."
  echo ""
  exit 1
fi

if ! command -v railway >/dev/null 2>&1; then
  echo "❌ 'railway' CLI not found on PATH. Install from https://docs.railway.com/guides/cli"
  exit 1
fi

# Sanity check the token by running a harmless command with it.
if ! RAILWAY_TOKEN="$CD_TARGET_TOKEN" railway status >/dev/null 2>&1; then
  echo "⚠ CD_TARGET_TOKEN set but 'railway status' fails. Token may be expired or invalid."
  echo "   Proceeding anyway — the server will surface errors on the first deploy."
fi

echo "▶ claude-deploy backend"
echo "   PORT=$PORT"
echo "   CD_TARGET_TOKEN=${CD_TARGET_TOKEN:0:8}…${CD_TARGET_TOKEN: -4}"
echo ""
echo "   clients should set: export CLAUDE_DEPLOY_BACKEND=http://localhost:$PORT"
echo ""

exec node "$HERE/backend/server.js"
