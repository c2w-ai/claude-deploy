#!/usr/bin/env bash
# claude-deploy: package the current project and upload it to the
# claude-deploy backend, which deploys it to Railway and returns a public URL.
#
# Usage:  deploy.sh [project-name]
#
# Env:
#   CLAUDE_DEPLOY_BACKEND  Override the default hosted backend URL
#   CLAUDE_DEPLOY_TOKEN    Override the shared hosted-backend client token
#   CLAUDE_DEPLOY_MAX_MB   Override the upload size cap (default 50)
#   CLAUDE_DEPLOY_HOME     Override ~/.claude-deploy (for testing)

set -euo pipefail

BACKEND_URL="${CLAUDE_DEPLOY_BACKEND:-https://api-production-d9b7.up.railway.app}"

# Default client token for the hosted backend. This is a shared, publicly
# published token — it's a speed bump for casual abuse, not a security
# boundary. Operators hosting their own backend should set a private
# CLIENT_TOKEN and tell users to `export CLAUDE_DEPLOY_TOKEN=<your token>`.
DEFAULT_CLAUDE_DEPLOY_TOKEN="b91befe56982335879e74634012ff06f"
CLIENT_TOKEN="${CLAUDE_DEPLOY_TOKEN:-$DEFAULT_CLAUDE_DEPLOY_TOKEN}"

MAX_MB="${CLAUDE_DEPLOY_MAX_MB:-50}"
MAX_BYTES=$((MAX_MB * 1024 * 1024))

CLAUDE_DEPLOY_HOME="${CLAUDE_DEPLOY_HOME:-$HOME/.claude-deploy}"
CLIENT_ID_FILE="$CLAUDE_DEPLOY_HOME/client-id"

say() { printf '%s\n' "$*" >&2; }

# Sanitize a string into a Railway-friendly slug: lowercase, [a-z0-9-], <=24 chars
slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -c 'a-z0-9-\n' '-' \
    | sed -E 's/-+/-/g; s/^-+//; s/-+$//' \
    | cut -c1-24
}

# Compute a stable project slug for upsert: prefer the git remote's last path
# segment (stripped of .git), else the current directory's basename.
compute_project_slug() {
  if command -v git >/dev/null 2>&1 && git rev-parse --show-toplevel >/dev/null 2>&1; then
    local remote
    remote=$(git config --get remote.origin.url 2>/dev/null || true)
    if [ -n "$remote" ]; then
      local base
      base=$(printf '%s' "$remote" | sed -E 's#^.*[/:]##; s#\.git$##')
      if [ -n "$base" ]; then
        slugify "$base"
        return
      fi
    fi
  fi
  slugify "$(basename "$PWD")"
}

# Get or create the per-install client id (random UUID). Stored in
# $CLAUDE_DEPLOY_HOME/client-id so repeat deploys of the same project from
# the same machine upsert the same Railway service.
get_or_create_client_id() {
  if [ -s "$CLIENT_ID_FILE" ]; then
    cat "$CLIENT_ID_FILE"
    return
  fi
  mkdir -p "$CLAUDE_DEPLOY_HOME"
  chmod 700 "$CLAUDE_DEPLOY_HOME" 2>/dev/null || true
  local id
  if command -v uuidgen >/dev/null 2>&1; then
    id=$(uuidgen | tr '[:upper:]' '[:lower:]')
  elif [ -r /proc/sys/kernel/random/uuid ]; then
    id=$(cat /proc/sys/kernel/random/uuid)
  else
    id=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || printf '%s-%s' "$(date +%s)" "$$")
  fi
  printf '%s' "$id" > "$CLIENT_ID_FILE"
  chmod 600 "$CLIENT_ID_FILE" 2>/dev/null || true
  printf '%s' "$id"
}

# Default project name = slug of current directory or arg override
DEFAULT_NAME="$(slugify "$(basename "$PWD")")"
PROJECT_NAME="${1:-$DEFAULT_NAME}"
PROJECT_NAME="${PROJECT_NAME:-app}"

# Upsert identity
CLIENT_ID=$(get_or_create_client_id)
PROJECT_SLUG=$(compute_project_slug)
PROJECT_SLUG=${PROJECT_SLUG:-app}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

TARBALL="$WORK/source.tar.gz"

say "📦 Packaging '$PROJECT_NAME' (slug: $PROJECT_SLUG)..."

package_with_git() {
  # Include tracked files + untracked-but-not-ignored files, excluding deleted ones.
  # `git ls-files -co --exclude-standard` gives us exactly that set.
  git -c core.quotepath=off ls-files -z -co --exclude-standard \
    | tar --null -T - -czf "$TARBALL"
}

package_without_git() {
  tar -czf "$TARBALL" \
    --exclude='./.git' \
    --exclude='./node_modules' \
    --exclude='./.next' \
    --exclude='./.nuxt' \
    --exclude='./dist' \
    --exclude='./build' \
    --exclude='./out' \
    --exclude='./target' \
    --exclude='./.venv' \
    --exclude='./venv' \
    --exclude='./__pycache__' \
    --exclude='./.pytest_cache' \
    --exclude='./.mypy_cache' \
    --exclude='./.cache' \
    --exclude='./.turbo' \
    --exclude='./.parcel-cache' \
    --exclude='./coverage' \
    --exclude='./.DS_Store' \
    .
}

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  package_with_git
else
  package_without_git
fi

SIZE=$(wc -c < "$TARBALL" | tr -d ' ')
if [ "$SIZE" -ge 1024 ]; then
  say "   size: $((SIZE / 1024)) KB"
else
  say "   size: ${SIZE} B"
fi

if [ "$SIZE" -gt "$MAX_BYTES" ]; then
  say "❌ Tarball exceeds ${MAX_MB} MB limit. Add large files to .gitignore or set CLAUDE_DEPLOY_MAX_MB."
  exit 2
fi

if [ "$SIZE" -lt 64 ]; then
  say "❌ Nothing to deploy (tarball is empty). Are you in a project directory?"
  exit 3
fi

say "☁️  Uploading to $BACKEND_URL ..."

# Build curl args without relying on arrays (set -u + empty arrays is fragile on
# older bash). Use curl -K config file.
CURL_CONFIG="$WORK/curl.cfg"
{
  printf 'silent\n'
  printf 'show-error\n'
  printf 'request = POST\n'
  printf 'header = "Content-Type: application/gzip"\n'
  printf 'header = "X-Project-Name: %s"\n' "$PROJECT_NAME"
  printf 'header = "X-Project-Slug: %s"\n' "$PROJECT_SLUG"
  printf 'header = "X-Claude-Deploy-Client: %s"\n' "$CLIENT_ID"
  printf 'header = "X-Client: claude-deploy-plugin/0.2.0"\n'
  if [ -n "$CLIENT_TOKEN" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$CLIENT_TOKEN"
  fi
  printf 'data-binary = "@%s"\n' "$TARBALL"
  printf 'url = "%s/deploy"\n' "${BACKEND_URL%/}"
} > "$CURL_CONFIG"

HTTP_OUT="$WORK/response.json"
set +e
HTTP_CODE=$(curl -o "$HTTP_OUT" -w '%{http_code}' -K "$CURL_CONFIG")
CURL_STATUS=$?
set -e
if [ $CURL_STATUS -ne 0 ]; then
  say "❌ curl failed (exit $CURL_STATUS) — is the backend reachable at $BACKEND_URL?"
  [ -s "$HTTP_OUT" ] && cat "$HTTP_OUT" >&2
  exit 6
fi

if [ "$HTTP_CODE" = "429" ]; then
  say "❌ Rate limit / daily cap reached for hosted backend."
  say "   Response:"
  cat "$HTTP_OUT" >&2 || true
  say ""
  say "   Try again later, or self-host the backend (see README)."
  exit 7
fi

if [ "$HTTP_CODE" = "503" ]; then
  say "❌ Hosted backend is temporarily unavailable (503)."
  say "   Response:"
  cat "$HTTP_OUT" >&2 || true
  say ""
  exit 8
fi

if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "201" ]; then
  say "❌ Backend returned HTTP $HTTP_CODE"
  say "--- response ---"
  cat "$HTTP_OUT" >&2 || true
  say ""
  exit 4
fi

# Extract URL from JSON without requiring jq.
URL=$(tr -d '\n' < "$HTTP_OUT" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

if [ -z "$URL" ]; then
  say "❌ Backend response did not include a 'url' field:"
  cat "$HTTP_OUT" >&2
  exit 5
fi

# Machine-readable line for the slash command to parse.
printf 'DEPLOY_RESULT=%s\n' "$(tr -d '\n' < "$HTTP_OUT")"
say ""
say "✅ Deployed: $URL"
say "   (hosted deploys are auto-cleaned after 24h of inactivity — run /deploy again to refresh)"
