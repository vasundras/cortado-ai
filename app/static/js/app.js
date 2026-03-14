/**
 * Cortado — Multimodal CX Agent Client
 *
 * Bidirectional streaming client for the ADK Gemini Live API backend.
 * Follows the official ADK bidi-demo patterns:
 *   - Binary WebSocket frames for audio (PCM 16-bit, 16kHz)
 *   - JSON text frames for text, images
 *   - AudioWorklet processors for recording & playback
 *   - ADK event format (turnComplete, interrupted, transcription, content.parts)
 */

import { startAudioPlayerWorklet } from "./audio-player.js";
import { startAudioRecorderWorklet, stopMicrophone } from "./audio-recorder.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const userId = "cortado-user";
let sessionId = "cortado-" + Date.now() + "-" + Math.random().toString(36).substring(2, 8);
let currentDomain = "wahoo";

let websocket = null;
let isAudioActive = false;

// Audio worklet references
let audioPlayerNode = null;
let audioPlayerContext = null;
let audioRecorderNode = null;
let audioRecorderContext = null;
let micStream = null;

// Camera state
let cameraStream = null;
let cameraInterval = null;
let isCameraActive = false;

// Message bubble state (for streaming text)
let currentAgentBubble = null;
let currentAgentText = "";
let isAgentStreaming = false;

// Transcription bubble state
let currentInputTranscriptionEl = null;
let currentOutputTranscriptionEl = null;
let inputTranscriptionFinished = false;
let hasOutputTranscription = false;

// ---------------------------------------------------------------------------
// DOM elements
// ---------------------------------------------------------------------------
const chatContainer = document.getElementById("chatContainer");
const messagesDiv = document.getElementById("messages");
const welcomeMessage = document.getElementById("welcomeMessage");
const textInput = document.getElementById("textInput");
const btnSend = document.getElementById("btnSend");
const btnMic = document.getElementById("btnMic");
const btnCamera = document.getElementById("btnCamera");
const fileInput = document.getElementById("fileInput");
const connectionStatus = document.getElementById("connectionStatus");
const statusText = connectionStatus.querySelector(".status-text");
const toolIndicator = document.getElementById("toolIndicator");
const toolText = document.getElementById("toolText");
const cameraPreview = document.getElementById("cameraPreview");
const cameraVideo = document.getElementById("cameraVideo");
const cameraCanvas = document.getElementById("cameraCanvas");
const cameraClose = document.getElementById("cameraClose");
const btnStop = document.getElementById("btnStop");
const domainSelect = document.getElementById("domainSelect");
const welcomeTitle = document.getElementById("welcomeTitle");
const welcomeDesc = document.getElementById("welcomeDesc");
const welcomeHint = document.getElementById("welcomeHint");

// Domain-specific welcome content
const DOMAIN_CONFIG = {
    wahoo: {
        title: "Hey! I'm Cortado.",
        desc: 'I\'m your Wahoo KICKR support agent. I can <strong>hear</strong> you, <strong>see</strong> your trainer, and <strong>read</strong> your docs.',
        hint: 'Try: "My KICKR Core 2 won\'t connect to Zwift" or point your camera at your trainer.',
        placeholder: "Describe your issue...",
        cameraMsg: "Camera active — point at your trainer",
    },
    garmin: {
        title: "Cortado here.",
        desc: 'I\'m your Garmin watch support specialist. I can <strong>hear</strong> you, <strong>see</strong> your watch, and <strong>identify your model</strong> from a photo.',
        hint: 'Try: "My Fenix 7 won\'t sync" or show me your watch and I\'ll identify it.',
        placeholder: "What's the situation?",
        cameraMsg: "Camera active — show me your watch",
    },
};

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws/${userId}/${sessionId}`;

    websocket = new WebSocket(wsUrl);

    websocket.onopen = () => {
        setConnectionStatus(true);
        // Send domain selection as the first message
        websocket.send(JSON.stringify({ type: "domain", domain: currentDomain }));
        console.log(`[Cortado] Connected — domain: ${currentDomain}`);
    };

    websocket.onclose = () => {
        setConnectionStatus(false);
        console.log("[Cortado] Disconnected. Reconnecting in 3s...");
        setTimeout(connectWebSocket, 3000);
    };

    websocket.onerror = (err) => {
        console.error("[Cortado] WebSocket error:", err);
    };

    websocket.onmessage = (event) => {
        const adkEvent = JSON.parse(event.data);
        handleADKEvent(adkEvent);
    };
}

function setConnectionStatus(connected) {
    if (connected) {
        connectionStatus.classList.add("connected");
        statusText.textContent = "Connected";
    } else {
        connectionStatus.classList.remove("connected");
        statusText.textContent = "Disconnected";
    }
}

// ---------------------------------------------------------------------------
// ADK event handling (matches official bidi-demo event format)
// ---------------------------------------------------------------------------

function handleADKEvent(event) {
    // Turn complete — finalize all bubbles
    if (event.turnComplete === true) {
        finalizeAgentBubble();
        finalizeTranscriptionBubble(currentOutputTranscriptionEl);
        currentOutputTranscriptionEl = null;
        currentInputTranscriptionEl = null;
        inputTranscriptionFinished = false;
        hasOutputTranscription = false;
        return;
    }

    // Interrupted — stop audio, mark bubbles
    if (event.interrupted === true) {
        if (audioPlayerNode) {
            audioPlayerNode.port.postMessage({ command: "endOfAudio" });
        }
        finalizeAgentBubble();
        finalizeTranscriptionBubble(currentOutputTranscriptionEl);
        currentOutputTranscriptionEl = null;
        currentInputTranscriptionEl = null;
        inputTranscriptionFinished = false;
        hasOutputTranscription = false;
        return;
    }

    // Input transcription (user's spoken words)
    if (event.inputTranscription && event.inputTranscription.text) {
        handleInputTranscription(event.inputTranscription);
        return;
    }

    // Output transcription (agent's spoken words as text)
    if (event.outputTranscription && event.outputTranscription.text) {
        handleOutputTranscription(event.outputTranscription);
        return;
    }

    // Content events (text and/or audio)
    if (event.content && event.content.parts) {
        handleContentParts(event.content.parts, event.partial);
    }
}

function handleInputTranscription(transcription) {
    if (inputTranscriptionFinished) return;

    const text = transcription.text;
    const isFinished = transcription.finished;

    if (!currentInputTranscriptionEl) {
        currentInputTranscriptionEl = addMessage("user", text, true);
    } else {
        if (isFinished) {
            updateBubbleText(currentInputTranscriptionEl, text, false);
        } else {
            const existing = getBubbleText(currentInputTranscriptionEl);
            updateBubbleText(currentInputTranscriptionEl, existing + text, true);
        }
    }

    if (isFinished) {
        currentInputTranscriptionEl = null;
        inputTranscriptionFinished = true;
    }
    scrollToBottom();
}

function handleOutputTranscription(transcription) {
    const text = transcription.text;
    const isFinished = transcription.finished;
    hasOutputTranscription = true;

    // Finalize input transcription when agent starts responding
    if (currentInputTranscriptionEl) {
        finalizeTranscriptionBubble(currentInputTranscriptionEl);
        currentInputTranscriptionEl = null;
        inputTranscriptionFinished = true;
    }

    if (!currentOutputTranscriptionEl) {
        setAgentStreaming(true);
        currentOutputTranscriptionEl = addMessage("agent", text, !isFinished);
    } else {
        if (isFinished) {
            updateBubbleText(currentOutputTranscriptionEl, text, false);
        } else {
            const existing = getBubbleText(currentOutputTranscriptionEl);
            updateBubbleText(currentOutputTranscriptionEl, existing + text, true);
        }
    }

    if (isFinished) {
        currentOutputTranscriptionEl = null;
    }
    scrollToBottom();
}

function handleContentParts(parts, isPartial) {
    for (const part of parts) {
        // Audio data — send to AudioWorklet player
        if (part.inlineData) {
            const mimeType = part.inlineData.mimeType || "";
            if (mimeType.startsWith("audio/pcm") && audioPlayerNode) {
                audioPlayerNode.port.postMessage(base64ToArrayBuffer(part.inlineData.data));
            }
        }

        // Text content
        if (part.text) {
            // Skip thinking/reasoning
            if (part.thought) continue;

            // Skip if output transcription already delivered the text
            if (!isPartial && hasOutputTranscription) continue;

            if (!currentAgentBubble) {
                setAgentStreaming(true);
                currentAgentText = part.text;
                currentAgentBubble = addMessage("agent", currentAgentText, true);
            } else {
                currentAgentText += part.text;
                updateBubbleText(currentAgentBubble, currentAgentText, true);
            }
            scrollToBottom();
        }
    }
}

// ---------------------------------------------------------------------------
// Base64 decoding (handles base64url encoding from Gemini)
// ---------------------------------------------------------------------------

function base64ToArrayBuffer(base64) {
    // Convert base64url to standard base64
    let standard = base64.replace(/-/g, "+").replace(/_/g, "/");
    while (standard.length % 4) standard += "=";

    const binary = window.atob(standard);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function hideWelcome() {
    if (welcomeMessage) welcomeMessage.style.display = "none";
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

function addMessage(role, text, isStreaming = false) {
    hideWelcome();
    const div = document.createElement("div");
    div.className = `message ${role}`;
    if (isStreaming && role === "agent") div.classList.add("streaming");

    if (role === "user") {
        div.innerHTML = `<div class="label">You</div><span class="bubble-text">${escapeHtml(text)}</span>`;
    } else if (role === "agent") {
        div.innerHTML = `<div class="label">Cortado</div><span class="bubble-text">${escapeHtml(text)}</span>`;
    } else {
        div.textContent = text;
    }
    messagesDiv.appendChild(div);
    scrollToBottom();
    return div;
}

function addImageMessage(dataUrl, filename) {
    hideWelcome();
    const div = document.createElement("div");
    div.className = "message user";
    div.innerHTML = `<div class="label">You</div><img src="${dataUrl}" alt="${escapeHtml(filename)}">`;
    messagesDiv.appendChild(div);
    scrollToBottom();
}

function updateBubbleText(el, text, isStreaming) {
    const span = el.querySelector(".bubble-text");
    if (span) span.textContent = text;
    if (isStreaming) {
        el.classList.add("streaming");
    } else {
        el.classList.remove("streaming");
    }
}

function getBubbleText(el) {
    const span = el.querySelector(".bubble-text");
    return span ? span.textContent : "";
}

function finalizeAgentBubble() {
    if (currentAgentBubble) {
        currentAgentBubble.classList.remove("streaming");
        currentAgentBubble = null;
        currentAgentText = "";
    }
    setAgentStreaming(false);
}

function setAgentStreaming(streaming) {
    isAgentStreaming = streaming;
    if (streaming) {
        btnSend.style.display = "none";
        btnStop.style.display = "flex";
    } else {
        btnSend.style.display = "flex";
        btnStop.style.display = "none";
    }
}

function interruptAgent() {
    // Stop audio playback
    if (audioPlayerNode) {
        audioPlayerNode.port.postMessage({ command: "endOfAudio" });
    }
    // Finalize any open bubbles
    finalizeAgentBubble();
    finalizeTranscriptionBubble(currentOutputTranscriptionEl);
    currentOutputTranscriptionEl = null;
    currentInputTranscriptionEl = null;
    inputTranscriptionFinished = false;
    hasOutputTranscription = false;
    // Send an empty text to trigger model interruption
    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ type: "text", text: " " }));
    }
    setAgentStreaming(false);
}

function finalizeTranscriptionBubble(el) {
    if (el) el.classList.remove("streaming");
}

function showToolIndicator(toolName) {
    const names = {
        google_search: "Searching the web...",
    };
    toolText.textContent = names[toolName] || `Running ${toolName}...`;
    toolIndicator.style.display = "flex";
}

function hideToolIndicator() {
    toolIndicator.style.display = "none";
}

function scrollToBottom() {
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// ---------------------------------------------------------------------------
// Text messaging
// ---------------------------------------------------------------------------

function sendText() {
    const text = textInput.value.trim();
    if (!text || !websocket || websocket.readyState !== WebSocket.OPEN) return;

    addMessage("user", text);
    websocket.send(JSON.stringify({ type: "text", text: text }));
    textInput.value = "";
}

// ---------------------------------------------------------------------------
// Audio handling (AudioWorklet — official ADK pattern)
// ---------------------------------------------------------------------------

async function startAudio() {
    try {
        // Start audio output (24kHz playback)
        const [playerNode, playerCtx] = await startAudioPlayerWorklet();
        audioPlayerNode = playerNode;
        audioPlayerContext = playerCtx;

        // Start audio input (16kHz recording)
        const [recorderNode, recorderCtx, stream] = await startAudioRecorderWorklet(
            audioRecorderHandler
        );
        audioRecorderNode = recorderNode;
        audioRecorderContext = recorderCtx;
        micStream = stream;

        isAudioActive = true;
        btnMic.classList.add("active", "recording");
        addMessage("system", "Voice mode active — speak naturally");
        console.log("[Cortado] Audio worklets started");
    } catch (err) {
        console.error("[Cortado] Audio start error:", err);
        addMessage("system", "Could not access microphone. Please allow permissions.");
    }
}

function stopAudio() {
    isAudioActive = false;
    btnMic.classList.remove("active", "recording");

    if (micStream) {
        stopMicrophone(micStream);
        micStream = null;
    }
    if (audioRecorderContext) {
        audioRecorderContext.close();
        audioRecorderContext = null;
    }
    if (audioPlayerContext) {
        audioPlayerContext.close();
        audioPlayerContext = null;
    }
    audioRecorderNode = null;
    audioPlayerNode = null;
}

function audioRecorderHandler(pcmData) {
    // Send audio as raw binary WebSocket frame (official ADK pattern)
    if (websocket && websocket.readyState === WebSocket.OPEN && isAudioActive) {
        websocket.send(pcmData);
    }
}

// ---------------------------------------------------------------------------
// Camera handling
// ---------------------------------------------------------------------------

async function startCamera() {
    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: "environment",
                width: { ideal: 768 },
                height: { ideal: 768 },
            },
        });

        cameraVideo.srcObject = cameraStream;
        cameraPreview.style.display = "block";
        isCameraActive = true;
        btnCamera.classList.add("active");

        // Send frames as images to agent (~1fps, 768x768 recommended by ADK docs)
        cameraCanvas.width = 768;
        cameraCanvas.height = 768;
        const ctx = cameraCanvas.getContext("2d");

        cameraInterval = setInterval(() => {
            if (!isCameraActive) return;
            // Draw video centered/cropped to square 768x768
            const vw = cameraVideo.videoWidth;
            const vh = cameraVideo.videoHeight;
            const size = Math.min(vw, vh);
            const sx = (vw - size) / 2;
            const sy = (vh - size) / 2;
            ctx.drawImage(cameraVideo, sx, sy, size, size, 0, 0, 768, 768);
            cameraCanvas.toBlob(
                (blob) => {
                    if (!blob) return;
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        const b64 = reader.result.split(",")[1];
                        if (websocket && websocket.readyState === WebSocket.OPEN) {
                            websocket.send(
                                JSON.stringify({
                                    type: "image",
                                    data: b64,
                                    mimeType: "image/jpeg",
                                })
                            );
                        }
                    };
                    reader.readAsDataURL(blob);
                },
                "image/jpeg",
                0.8
            );
        }, 1000);

        const camMsg = DOMAIN_CONFIG[currentDomain]?.cameraMsg || "Camera active";
        addMessage("system", camMsg);
    } catch (err) {
        console.error("[Cortado] Camera error:", err);
        addMessage("system", "Could not access camera. Please allow permissions.");
    }
}

function stopCamera() {
    isCameraActive = false;
    btnCamera.classList.remove("active");
    cameraPreview.style.display = "none";

    if (cameraInterval) {
        clearInterval(cameraInterval);
        cameraInterval = null;
    }
    if (cameraStream) {
        cameraStream.getTracks().forEach((t) => t.stop());
        cameraStream = null;
    }
}

// ---------------------------------------------------------------------------
// Image upload
// ---------------------------------------------------------------------------

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const b64 = e.target.result.split(",")[1];
        addImageMessage(e.target.result, file.name);

        if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(
                JSON.stringify({
                    type: "image",
                    data: b64,
                    mimeType: file.type || "image/jpeg",
                })
            );
        }
    };
    reader.readAsDataURL(file);
    event.target.value = "";
}

// ---------------------------------------------------------------------------
// Event binding
// ---------------------------------------------------------------------------

btnSend.addEventListener("click", sendText);
textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendText();
    }
});

btnMic.addEventListener("click", () => {
    if (isAudioActive) {
        stopAudio();
    } else {
        startAudio();
    }
});

btnCamera.addEventListener("click", () => {
    if (isCameraActive) {
        stopCamera();
    } else {
        startCamera();
    }
});

cameraClose.addEventListener("click", stopCamera);
fileInput.addEventListener("change", handleFileUpload);
btnStop.addEventListener("click", interruptAgent);

// ---------------------------------------------------------------------------
// Domain switching
// ---------------------------------------------------------------------------

function switchDomain(domain) {
    if (domain === currentDomain) return;
    currentDomain = domain;

    // Update welcome screen
    const cfg = DOMAIN_CONFIG[domain];
    if (cfg && welcomeTitle) {
        welcomeTitle.textContent = cfg.title;
        welcomeDesc.innerHTML = cfg.desc;
        welcomeHint.textContent = cfg.hint;
        textInput.placeholder = cfg.placeholder;
    }

    // Reset session — new session ID for new domain
    sessionId = "cortado-" + Date.now() + "-" + Math.random().toString(36).substring(2, 8);

    // Stop any active media
    if (isAudioActive) stopAudio();
    if (isCameraActive) stopCamera();

    // Clear chat
    messagesDiv.innerHTML = "";
    if (welcomeMessage) welcomeMessage.style.display = "";

    // Reset bubble state
    currentAgentBubble = null;
    currentAgentText = "";
    currentInputTranscriptionEl = null;
    currentOutputTranscriptionEl = null;
    inputTranscriptionFinished = false;
    hasOutputTranscription = false;
    setAgentStreaming(false);

    // Reconnect with new domain
    if (websocket) {
        websocket.onclose = null; // prevent auto-reconnect loop
        websocket.close();
    }
    connectWebSocket();
}

domainSelect.addEventListener("change", (e) => {
    switchDomain(e.target.value);
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------
connectWebSocket();
