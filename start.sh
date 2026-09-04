#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# start.sh - GridEvac AI · Houston, TX
# Starts both the FastAPI backend (port 8000) and Next.js frontend (port 3000)
# Usage: bash start.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "┌────────────────────────────────────────────────┐"
echo "│   ⚡  GridEvac AI  -  Houston, TX              │"
echo "│   Emergency Evacuation Routing System          │"
echo "└────────────────────────────────────────────────┘"
echo ""

# ── Backend ───────────────────────────────────────────────────────────────────
VENV="$ROOT/backend/.venv"

if [ ! -d "$VENV" ]; then
  echo "🐍 Creating Python virtual environment..."
  python3 -m venv "$VENV"
fi

echo "📦 Installing Python dependencies..."
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r "$ROOT/backend/requirements.txt"

echo "📡 Starting FastAPI backend on http://localhost:8000 ..."
cd "$ROOT/backend"
"$VENV/bin/uvicorn" main:app --reload --port 8000 &
BACKEND_PID=$!
cd "$ROOT"

# Brief pause so backend can start before frontend tries to connect
sleep 2

# ── Frontend ─────────────────────────────────────────────────────────────────
echo "🌐 Starting Next.js frontend on http://localhost:3000 ..."
cd "$ROOT/frontend"
npm run dev &
FRONTEND_PID=$!
cd "$ROOT"

echo ""
echo "✅  Both servers are running:"
echo "    Frontend  →  http://localhost:3000"
echo "    Backend   →  http://localhost:8000"
echo "    API docs  →  http://localhost:8000/docs"
echo ""
echo "    Press Ctrl+C to stop."
echo ""

# ── Cleanup ───────────────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "🛑 Shutting down GridEvac AI..."
  kill "$BACKEND_PID"  2>/dev/null || true
  kill "$FRONTEND_PID" 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM

wait
