#!/usr/bin/env bash
# claude-deploy: package the current project and upload it to the
# claude-deploy hosted backend, which deploys it and returns a public URL.
#
# Usage:  deploy.sh [project-name]
#
# Env:
#   CLAUDE_DEPLOY_BACKEND  Override the default hosted backend URL
#   CLAUDE_DEPLOY_TOKEN    Override the cached Supabase session token
#   CLAUDE_DEPLOY_MAX_MB   Override the upload size cap (default 50)
#   CLAUDE_DEPLOY_HOME     Override ~/.claude-deploy (for testing)
#   CLAUDE_DEPLOY_NO_BROWSER  Set to 1 to print the auth URL instead of opening it

set -euo pipefail

BACKEND_URL="${CLAUDE_DEPLOY_BACKEND:-https://api-production-d9b7.up.railway.app}"

MAX_MB="${CLAUDE_DEPLOY_MAX_MB:-50}"
MAX_BYTES=$((MAX_MB * 1024 * 1024))

CLAUDE_DEPLOY_HOME="${CLAUDE_DEPLOY_HOME:-$HOME/.claude-deploy}"
CLIENT_ID_FILE="$CLAUDE_DEPLOY_HOME/client-id"
AUTH_TOKEN_FILE="$CLAUDE_DEPLOY_HOME/auth-token"

say() { printf '%s\n' "$*" >&2; }

# Sanitize a string into a hosting-friendly slug: lowercase, [a-z0-9-], <=24 chars
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
# $CLAUDE_DEPLOY_HOME/client-id as a fallback identifier for unauthenticated
# flows; the authenticated (Supabase user_id) path is preferred when a valid
# session token is present.
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

# ---------- auth ----------
#
# On first run (or when the cached session is rejected) we go through the
# hosted backend's device-code-like flow:
#   1. POST /auth/start → { session_id, secret, verify_url, poll_url }
#   2. Open verify_url in the user's browser
#   3. Poll poll_url every 2s until status=verified, then cache the returned
#      access_token at $AUTH_TOKEN_FILE
#
# The token is a Supabase JWT. It's sent as Authorization: Bearer on the
# upload request and validated by the backend against Supabase /auth/v1/user.

open_url_in_browser() {
  local u="$1"
  if [ "${CLAUDE_DEPLOY_NO_BROWSER:-}" = "1" ]; then
    return 1
  fi
  if command -v open >/dev/null 2>&1; then
    open "$u" >/dev/null 2>&1 && return 0
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$u" >/dev/null 2>&1 && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import webbrowser,sys; webbrowser.open(sys.argv[1])" "$u" >/dev/null 2>&1 && return 0
  fi
  return 1
}

load_cached_auth_token() {
  if [ -n "${CLAUDE_DEPLOY_TOKEN:-}" ]; then
    printf '%s' "$CLAUDE_DEPLOY_TOKEN"
    return
  fi
  if [ -s "$AUTH_TOKEN_FILE" ]; then
    cat "$AUTH_TOKEN_FILE"
  fi
}

save_auth_token() {
  mkdir -p "$CLAUDE_DEPLOY_HOME"
  chmod 700 "$CLAUDE_DEPLOY_HOME" 2>/dev/null || true
  printf '%s' "$1" > "$AUTH_TOKEN_FILE"
  chmod 600 "$AUTH_TOKEN_FILE" 2>/dev/null || true
}

# Start a sign-in flow and block until verified. Returns the access token
# on stdout. Exits the script with code 9 if the flow fails.
run_auth_flow() {
  local start_out poll_out status
  start_out=$(curl -sS -X POST "${BACKEND_URL%/}/auth/start" -H "Content-Type: application/json" -d '{}' 2>/dev/null || true)
  if [ -z "$start_out" ]; then
    say "❌ Could not reach the claude-deploy backend at $BACKEND_URL"
    exit 9
  fi
  # Parse fields with sed (no jq dependency)
  local session_id verify_url poll_url
  session_id=$(printf '%s' "$start_out" | sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p')
  verify_url=$(printf '%s' "$start_out" | sed -n 's/.*"verify_url":"\([^"]*\)".*/\1/p')
  poll_url=$(printf '%s' "$start_out" | sed -n 's/.*"poll_url":"\([^"]*\)".*/\1/p')
  # JSON string uses \u0026 for &; unescape
  verify_url=$(printf '%b' "${verify_url//\\u0026/&}")
  poll_url=$(printf '%b' "${poll_url//\\u0026/&}")

  if [ -z "$session_id" ] || [ -z "$verify_url" ] || [ -z "$poll_url" ]; then
    say "❌ Unexpected /auth/start response:"
    say "$start_out"
    exit 9
  fi

  say ""
  say "🔐 First-time deploy — let's get you signed in."
  say "   Opening your browser to: $verify_url"
  say ""
  if ! open_url_in_browser "$verify_url"; then
    say "   (Couldn't open a browser automatically — copy and paste the URL above.)"
  fi
  say "   Waiting for you to confirm your email magic link..."

  local start_time=$(date +%s)
  local max_wait=600  # 10 min
  while :; do
    sleep 2
    poll_out=$(curl -sS "$poll_url" 2>/dev/null || true)
    status=$(printf '%s' "$poll_out" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
    case "$status" in
      verified)
        local access_token email
        access_token=$(printf '%s' "$poll_out" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
        email=$(printf '%s' "$poll_out" | sed -n 's/.*"email":"\([^"]*\)".*/\1/p')
        if [ -z "$access_token" ]; then
          say "❌ Session reported verified but no access_token in response."
          exit 9
        fi
        save_auth_token "$access_token"
        say ""
        say "✅ Signed in as $email"
        say ""
        printf '%s' "$access_token"
        return 0
        ;;
      pending|"")
        ;;
      *)
        say "❌ Auth session ended (status=$status)"
        exit 9
        ;;
    esac
    local now=$(date +%s)
    if [ $((now - start_time)) -ge $max_wait ]; then
      say "❌ Timed out waiting for sign-in (10 min). Run /deploy again to retry."
      exit 9
    fi
  done
}

AUTH_TOKEN=$(load_cached_auth_token)
if [ -z "$AUTH_TOKEN" ]; then
  AUTH_TOKEN=$(run_auth_flow)
fi

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

build_curl_config() {
  local token="$1"
  CURL_CONFIG="$WORK/curl.cfg"
  {
    printf 'silent\n'
    printf 'show-error\n'
    printf 'request = POST\n'
    printf 'header = "Content-Type: application/gzip"\n'
    printf 'header = "X-Project-Name: %s"\n' "$PROJECT_NAME"
    printf 'header = "X-Project-Slug: %s"\n' "$PROJECT_SLUG"
    printf 'header = "X-Claude-Deploy-Client: %s"\n' "$CLIENT_ID"
    printf 'header = "X-Client: claude-deploy-plugin/0.3.0"\n'
    printf 'header = "Authorization: Bearer %s"\n' "$token"
    printf 'data-binary = "@%s"\n' "$TARBALL"
    printf 'url = "%s/deploy"\n' "${BACKEND_URL%/}"
  } > "$CURL_CONFIG"
}

do_upload() {
  local token="$1"
  build_curl_config "$token"
  HTTP_OUT="$WORK/response.json"
  set +e
  HTTP_CODE=$(curl -o "$HTTP_OUT" -w '%{http_code}' -K "$CURL_CONFIG")
  CURL_STATUS=$?
  set -e
}

do_upload "$AUTH_TOKEN"
if [ $CURL_STATUS -ne 0 ]; then
  say "❌ curl failed (exit $CURL_STATUS) — is the backend reachable at $BACKEND_URL?"
  [ -s "$HTTP_OUT" ] && cat "$HTTP_OUT" >&2
  exit 6
fi

# If the cached session was rejected, wipe it and force a fresh sign-in ONCE.
if [ "$HTTP_CODE" = "401" ]; then
  say "⚠ Session expired — let's sign you in again."
  rm -f "$AUTH_TOKEN_FILE"
  AUTH_TOKEN=$(run_auth_flow)
  do_upload "$AUTH_TOKEN"
  if [ $CURL_STATUS -ne 0 ]; then
    say "❌ curl failed after re-auth (exit $CURL_STATUS)"
    exit 6
  fi
fi

if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
  say "❌ Authentication rejected after sign-in. Response:"
  cat "$HTTP_OUT" >&2 || true
  say ""
  exit 9
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
