"""Marginalia Python backend — FastAPI + SSE."""

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware

logger = logging.getLogger("marginalia.server")

BACKEND_PORT = 8765
SSE_HEARTBEAT_INTERVAL = 10


@asynccontextmanager
async def lifespan(app: FastAPI):
    from core.sandbox import init_sandbox_manager
    mgr = await init_sandbox_manager()
    if mgr.is_available:
        logger.info("Sandbox ready")
    else:
        logger.warning("Sandbox unavailable — running with restricted fallback")
    yield
    await mgr.shutdown()


app = FastAPI(title="Marginalia Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
async def health():
    from core.sandbox import get_sandbox_manager
    try:
        mgr = get_sandbox_manager()
        sandbox_status = "available" if mgr.is_available else "fallback"
    except RuntimeError:
        sandbox_status = "initializing"
    return {"status": "ok", "sandbox": sandbox_status}


@app.post("/api/chat")
async def chat(request: Request):
    body = await request.json()
    prompt = body.get("text", "")

    from core.agent import run_query, capture_context

    screen_ctx = capture_context()

    queue: asyncio.Queue = asyncio.Queue()

    async def producer():
        try:
            async for msg_type, data in run_query(prompt, [], screen_ctx):
                await queue.put((msg_type, data))
        except Exception as e:
            await queue.put(("error", str(e)))
        finally:
            await queue.put(None)

    async def event_stream():
        task = asyncio.create_task(producer())
        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=SSE_HEARTBEAT_INTERVAL)
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                if item is None:
                    break
                msg_type, data = item
                event = json.dumps({"type": msg_type, "data": data or ""})
                yield f"data: {event}\n\n"
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    return StreamingResponse(event_stream(), media_type="text/event-stream")
