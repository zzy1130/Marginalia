#!/bin/bash
set -e

cd "$(dirname "$0")"

BACKEND_PORT=8765
SANDBOX_PORT=8080
BACKEND_PID=""
FRONTEND_PID=""
SANDBOX_IMAGE="opensandbox/code-interpreter:v1.0.1"

cleanup() {
  echo ""
  echo "[start] Shutting down..."
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null
  pkill -f "Marginalia-dev" 2>/dev/null
  lsof -ti:"$BACKEND_PORT" | xargs kill -9 2>/dev/null || true
  wait 2>/dev/null
  echo "[start] Done."
}
trap cleanup EXIT INT TERM

# --- 1. Kill leftover processes ---
lsof -ti:"$BACKEND_PORT" | xargs kill -9 2>/dev/null || true
pkill -f "Marginalia-dev" 2>/dev/null || true
sleep 0.3

# --- 2. Sync Python deps ---
echo "[start] Syncing Python dependencies..."
uv sync --quiet 2>/dev/null || true

# --- 2.5. Check Docker and pre-pull sandbox image ---
if docker info >/dev/null 2>&1; then
  echo "[start] Docker available, sandbox will be enabled."
  if ! docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; then
    echo "[start] Pulling sandbox image (first run, may take a minute)..."
    docker pull "$SANDBOX_IMAGE" &
  fi
else
  echo "[start] Docker not found. Sandbox will use cloud fallback or restricted mode."
fi

# --- 3. Start Python backend ---
echo "[start] Starting backend on port $BACKEND_PORT..."
DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib \
  uv run uvicorn core.server:app --host 127.0.0.1 --port "$BACKEND_PORT" --log-level warning &
BACKEND_PID=$!

# Wait for backend to be ready
for i in $(seq 1 30); do
  if curl -s "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null 2>&1; then
    echo "[start] Backend ready."
    break
  fi
  sleep 0.5
done

if ! curl -s "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null 2>&1; then
  echo "[start] ERROR: Backend failed to start."
  exit 1
fi

# --- 4. Build and start Electrobun frontend ---
echo "[start] Building frontend..."
bun run build:dev 2>&1 | tail -5

echo "[start] Launching Marginalia..."
npx electrobun dev &
FRONTEND_PID=$!

echo "[start] Marginalia is running. Press Ctrl+C to stop."
wait
