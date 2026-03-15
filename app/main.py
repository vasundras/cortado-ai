"""
Cortado — Multimodal CX Agent Server

FastAPI application with WebSocket-based bidirectional streaming
using Google ADK and the Gemini Live API.

Architecture follows Google's official bidi-demo pattern:
- LiveRequestQueue: Thread-safe FIFO buffer for multimodal input
- Runner: Session lifecycle management
- RunConfig: Configures streaming mode, audio transcription, modalities
- Events forwarded to client via model_dump_json (standard ADK format)

Audio is sent as raw binary WebSocket frames (PCM 16-bit, 16kHz mono).
Text, images, and control messages are sent as JSON text frames.

Supports multiple SOPs via the domain parameter — same tools, different agent.
"""

import asyncio
import base64
import json
import logging
import os
import warnings
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

# Load environment variables BEFORE importing agent
# Walk up to find .env at the project root (one level above app/)
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# Import agent factory and registry after env vars are loaded
from app.cortado_agent.agent import (  # noqa: E402
    SOP_REGISTRY,
    create_agent,
    root_agent,
)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)
warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
APP_NAME = "cortado"

app = FastAPI(
    title="Cortado",
    description="Workflow-free multimodal CX agent — swap the SOP, swap the domain",
    version="1.1.0",
)

# Static files
static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

# ADK components — shared session service, per-domain runners cached
session_service = InMemorySessionService()

# Cache runners per domain so we don't re-create them every connection
_runner_cache: dict[str, Runner] = {}


def get_runner(domain: str) -> Runner:
    """Get or create a Runner for the given domain."""
    if domain not in _runner_cache:
        agent = create_agent(domain)
        _runner_cache[domain] = Runner(
            app_name=APP_NAME,
            agent=agent,
            session_service=session_service,
        )
        logger.info(f"Created runner for domain: {domain}")
    return _runner_cache[domain]


# Pre-create the default runner
_runner_cache["wahoo"] = Runner(
    app_name=APP_NAME,
    agent=root_agent,
    session_service=session_service,
)

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/")
async def root():
    """Serve the main Cortado UI."""
    return FileResponse(Path(__file__).parent / "templates" / "index.html")


@app.get("/health")
async def health():
    """Health check for Cloud Run."""
    return {"status": "healthy", "agent": APP_NAME, "version": "1.1.0"}


@app.get("/tickets")
async def tickets_dashboard():
    """Simple ticket dashboard — shows all support tickets created by the agent."""
    return FileResponse(Path(__file__).parent / "templates" / "tickets.html")


@app.get("/api/tickets")
async def tickets_api():
    """JSON API for support tickets."""
    from app.cortado_agent.tools import tickets_store

    return {"tickets": tickets_store, "count": len(tickets_store)}


@app.get("/api/domains")
async def domains_api():
    """Available SOP domains for the frontend selector."""
    return {
        "domains": [
            {"key": key, "label": cfg["label"]}
            for key, cfg in SOP_REGISTRY.items()
        ]
    }


# ---------------------------------------------------------------------------
# WebSocket streaming endpoint
# ---------------------------------------------------------------------------


@app.websocket("/ws/{user_id}/{session_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: str,
    session_id: str,
) -> None:
    """
    Bidirectional streaming WebSocket endpoint.

    Follows the official ADK bidi-streaming pattern:
    - Binary frames: raw PCM audio (16-bit, 16kHz mono)
    - Text frames (JSON):
        {"type": "text", "text": "user message"}
        {"type": "image", "data": "<base64>", "mimeType": "image/jpeg"}
        {"type": "domain", "domain": "garmin"}  ← domain selection (first msg)
    """
    logger.debug(
        f"WebSocket connection request: user_id={user_id}, session_id={session_id}"
    )
    await websocket.accept()
    logger.debug("WebSocket connection accepted")

    # ==========================================
    # Wait for domain selection (first text message may contain it)
    # Default to wahoo if not specified
    # ==========================================
    domain = "wahoo"

    # ==========================================
    # Session initialization
    # ==========================================

    # We'll set up the runner after we know the domain
    runner = None
    run_config = None
    live_request_queue = LiveRequestQueue()

    def setup_runner(selected_domain: str):
        nonlocal runner, run_config, domain
        domain = selected_domain
        runner = get_runner(domain)

        # Determine response modality based on model architecture
        model_name = runner.agent.model
        is_native_audio = "native-audio" in model_name.lower()

        if is_native_audio:
            run_config_val = RunConfig(
                streaming_mode=StreamingMode.BIDI,
                response_modalities=["AUDIO"],
                input_audio_transcription=types.AudioTranscriptionConfig(),
                output_audio_transcription=types.AudioTranscriptionConfig(),
                session_resumption=types.SessionResumptionConfig(),
            )
        else:
            run_config_val = RunConfig(
                streaming_mode=StreamingMode.BIDI,
                response_modalities=["AUDIO"],
                output_audio_transcription=types.AudioTranscriptionConfig(),
                session_resumption=types.SessionResumptionConfig(),
            )

        return run_config_val

    # Default setup — will be overridden if client sends domain message
    run_config = setup_runner("wahoo")

    # Get or create session
    session = await session_service.get_session(
        app_name=APP_NAME, user_id=user_id, session_id=session_id
    )
    if not session:
        await session_service.create_session(
            app_name=APP_NAME, user_id=user_id, session_id=session_id
        )

    # ==========================================
    # Bidirectional streaming tasks
    # ==========================================
    domain_ready = asyncio.Event()

    async def upstream_task() -> None:
        """Receive messages from WebSocket and push to LiveRequestQueue."""
        logger.debug("upstream_task started")
        while True:
            message = await websocket.receive()

            # Binary frames = raw PCM audio from microphone
            if "bytes" in message:
                audio_data = message["bytes"]
                logger.debug(f"Received audio chunk: {len(audio_data)} bytes")
                live_request_queue.send_realtime(
                    types.Blob(
                        mime_type="audio/pcm;rate=16000",
                        data=audio_data,
                    )
                )

            # Text frames = JSON messages (text, image, video, domain)
            elif "text" in message:
                text_data = message["text"]
                json_message = json.loads(text_data)

                # Domain selection message (sent by client on connect)
                if json_message.get("type") == "domain":
                    selected = json_message.get("domain", "wahoo")
                    if selected in SOP_REGISTRY:
                        setup_runner(selected)
                        logger.info(f"Domain set to: {selected}")
                    domain_ready.set()
                    continue

                if json_message.get("type") == "text":
                    logger.debug(f"Received text: {json_message['text'][:80]}")
                    live_request_queue.send_content(
                        types.Content(
                            parts=[types.Part(text=json_message["text"])]
                        )
                    )

                elif json_message.get("type") == "image":
                    # Camera capture or uploaded image
                    image_data = base64.b64decode(json_message["data"])
                    mime_type = json_message.get("mimeType", "image/jpeg")
                    logger.debug(
                        f"Received image: {len(image_data)} bytes, {mime_type}"
                    )
                    live_request_queue.send_realtime(
                        types.Blob(mime_type=mime_type, data=image_data)
                    )

    async def downstream_task() -> None:
        """Stream ADK events to WebSocket client.

        Wraps run_live() in a retry loop so that when the Gemini bidi
        stream ends (e.g. after an interrupt or idle timeout), we restart
        it with the same session — preserving conversation history.
        """
        await domain_ready.wait()
        logger.debug(f"downstream_task started with domain={domain}")

        while True:
            try:
                async for event in runner.run_live(
                    user_id=user_id,
                    session_id=session_id,
                    live_request_queue=live_request_queue,
                    run_config=run_config,
                ):
                    event_json = event.model_dump_json(
                        exclude_none=True, by_alias=True
                    )
                    logger.debug(f"[SERVER] Event: {event_json[:200]}")
                    await websocket.send_text(event_json)

                # run_live() ended normally (interrupt, idle timeout, etc.)
                # Restart it so the next user message is handled.
                logger.info(
                    "run_live() stream ended — restarting with same session "
                    f"(user={user_id}, session={session_id})"
                )
            except Exception as e:
                # If the WebSocket is closed, the upstream task will also
                # fail and asyncio.gather will handle cleanup.
                logger.error(f"run_live() error: {e}", exc_info=True)
                raise

    # Run both tasks concurrently
    try:
        logger.debug("Starting upstream and downstream tasks")
        await asyncio.gather(upstream_task(), downstream_task())
    except WebSocketDisconnect:
        logger.debug("Client disconnected normally")
    except Exception as e:
        logger.error(f"Streaming error: {e}", exc_info=True)
    finally:
        logger.debug("Closing live_request_queue")
        live_request_queue.close()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8080")),
        reload=True,
    )
