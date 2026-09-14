#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# start.sh - GridEvac · Houston, TX
# Starts the FastAPI backend (port 8000) and the Next.js frontend (port 3000).
# Usage: bash start.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

for tool in python3 npm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "❌ $tool is required but not installed."; exit 1; }
done

echo ""
echo "  GridEvac · Houston evacuation routing"
echo ""

# ── Backend ───────────────────────────────────────────────────────────────────
VENV="$ROOT/backend/.venv"
STAMP="$VENV/.requirements.sha"
if [ ! -d "$VENV" ]; then
  echo "🐍 Creating Python virtual environment..."
  python3 -m venv "$VENV"
fi
REQ_HASH="$(shasum "$ROOT/backend/requirements.txt" | cut -d' ' -f1)"
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$REQ_HASH" ]; then
  echo "📦 Installing Python dependencies..."
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q -r "$ROOT/backend/requirements.txt"
  echo "$REQ_HASH" > "$STAMP"
fi

if ! "$VENV/bin/python" "$ROOT/tools/sync_api_mirror.py" --check >/dev/null; then
  echo "⚠️  frontend/api is out of date with backend/. Run: python3 tools/sync_api_mirror.py"
fi

# ── Frontend ─────────────────────────────────────────────────────────────────
if [ ! -d "$ROOT/frontend/node_modules" ]; then
  echo "📦 Installing frontend dependencies..."
  (cd "$ROOT/frontend" && npm ci)
fi

cleanup() {
  echo ""
  echo "🛑 Shutting down GridEvac..."
  kill "${BACKEND_PID:-}" "${FRONTEND_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "📡 Backend  → http://localhost:8000 (docs at /docs)"
(cd "$ROOT/backend" && exec "$VENV/bin/uvicorn" main:app --reload --port 8000) &
BACKEND_PID=$!

echo "🌐 Frontend → http://localhost:3000"
(cd "$ROOT/frontend" && exec npm run dev) &
FRONTEND_PID=$!

echo ""
echo "Press Ctrl+C to stop both servers."
# Exit (and stop the other server) as soon as either process ends.
# Polling instead of `wait -n`, which macOS's bash 3.2 does not support.
while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 1
done
