#!/bin/bash
set -e

cd "$(dirname "$0")"

FRONTEND_PID=""

cleanup() {
  echo ""
  echo "[start] Shutting down..."
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null
  pkill -f "Marginalia-dev" 2>/dev/null
  wait 2>/dev/null
  echo "[start] Done."
}
trap cleanup EXIT INT TERM

# --- 1. Kill leftover processes ---
pkill -f "Marginalia-dev" 2>/dev/null || true
sleep 0.3

# --- 2. Sync Python deps (still needed for screen capture + code execution) ---
echo "[start] Syncing Python dependencies..."
uv sync --quiet 2>/dev/null || true

# --- 3. Build and start Electrobun frontend (includes Bun server) ---
echo "[start] Building frontend..."
bun run build:dev 2>&1 | tail -5

echo "[start] Launching Marginalia..."
npx electrobun dev &
FRONTEND_PID=$!

echo "[start] Marginalia is running. Press Ctrl+C to stop."
wait
