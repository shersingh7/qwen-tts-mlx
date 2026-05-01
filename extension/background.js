// Open TTS — Background Service Worker (v2.2.1)
const SERVER_URL = "http://127.0.0.1:8000";
const NATIVE_HOST_NAME = "com.open_tts.native_host";

// ── Server-known-running cache ───────────────────────────────────
let _serverKnownRunning = false;
let _serverKnownRunningAt = 0;
const SERVER_KNOWN_TTL_MS = 5 * 60 * 1000;

function isServerKnownRunning() {
  if (!_serverKnownRunning) return false;
  if (Date.now() - _serverKnownRunningAt > SERVER_KNOWN_TTL_MS) {
    _serverKnownRunning = false;
    return false;
  }
  return true;
}
function markServerKnownRunning() {
  _serverKnownRunning = true;
  _serverKnownRunningAt = Date.now();
}
function markServerUnknown() {
  _serverKnownRunning = false;
}

// ── Base64 helper (only for non-streaming path) ─────────────────
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 32768;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

// ── Offscreen document lifecycle ─────────────────────────────────
// ONLY the background service worker can use chrome.offscreen API.
// Content scripts delegate to us via ENSURE_OFFSCREEN / SPEAK / etc.

let _offscreenReady = false;

async function ensureOffscreenDoc() {
  if (_offscreenReady) return true;

  const existing = await chrome.offscreen.hasDocument?.().catch(() => null);
  if (existing) {
    _offscreenReady = true;
    return true;
  }

  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("offscreen.html"),
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Local text-to-speech audio playback",
    });
    _offscreenReady = true;
    return true;
  } catch (e) {
    if (e.message?.includes("offscreen") || e.message?.includes("already")) {
      _offscreenReady = true;
      return true;
    }
    console.error("[Open TTS] Failed to create offscreen doc:", e);
    return false;
  }
}

// Forward a message to the offscreen document
async function sendToOffscreen(payload) {
  const ok = await ensureOffscreenDoc();
  if (!ok) throw new Error("Offscreen document not available");
  return chrome.runtime.sendMessage(payload);
}

// ── Message handler ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const type = request.type;

  // Prevent re-processing our own forwarded messages.
  // When background.js forwards SPEAK/STOP/PAUSE/RESUME via
  // chrome.runtime.sendMessage, our own listener would see it again.
  if (request._fromBackground) {
    // This is our own forwarded message — don't re-route it.
    // Let it propagate to offscreen.js (the intended destination).
    return false;
  }

  // SPEAK / STOP / PAUSE / RESUME — route through offscreen doc.
  // Content scripts send these; background creates offscreen doc
  // and forwards. We handle the lifecycle HERE, not in content.js.
  if (["SPEAK", "STOP", "PAUSE", "RESUME"].includes(type)) {
    // Stamp the message so we don't re-process it on broadcast
    const forwarded = { ...request, _fromBackground: true };
    sendToOffscreen(forwarded)
      .then((resp) => sendResponse(resp || { started: true }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  // Popup requested global stop — tell offscreen + all content tabs
  if (type === "STOP_TTS") {
    sendToOffscreen({ type: "STOP", _fromBackground: true }).catch(() => {});
    // Also notify content scripts in all tabs
    chrome.tabs.query({}).then((tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: "STOP_TTS" }).catch(() => {});
      }
    }).catch(() => {});
    sendResponse({ stopped: true });
    return true;
  }

  // Content script asking us to ensure offscreen exists
  if (type === "ENSURE_OFFSCREEN") {
    ensureOffscreenDoc().then((ok) => sendResponse({ success: ok })).catch(() => sendResponse({ success: false }));
    return true;
  }

  if (type === "TTS_REQUEST") {
    handleTTSRequest(request, sendResponse);
    return true;
  }
  if (type === "GET_VOICES") {
    handleGetVoices(request, sendResponse);
    return true;
  }
  if (type === "GET_MODELS") {
    handleGetModels(sendResponse);
    return true;
  }
  if (type === "LOAD_MODEL") {
    handleLoadModel(request, sendResponse);
    return true;
  }
  if (type === "GET_HEALTH") {
    handleHealth(sendResponse);
    return true;
  }
  if (type === "ENSURE_SERVER") {
    ensureServerRunning().then((ok) => sendResponse({ success: ok })).catch(() => sendResponse({ success: false }));
    return true;
  }
  if (type === "START_SERVER") {
    handleStartServer(sendResponse);
    return true;
  }
  if (type === "STOP_SERVER") {
    handleStopServer(sendResponse);
    return true;
  }
  if (type === "GET_SERVER_STATUS") {
    handleServerStatus(sendResponse);
    return true;
  }
});

// ── Native messaging ─────────────────────────────────────────────
function sendNativeMessage(command) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { command },
      (response) => {
        const err = chrome.runtime.lastError;
        if (err) { reject(new Error(err.message)); return; }
        resolve(response);
      }
    );
  });
}

// ── Server management ────────────────────────────────────────────
async function handleStartServer(sendResponse) {
  try {
    const response = await sendNativeMessage("start");
    markServerUnknown();
    sendResponse({ success: response?.success ?? true, message: response?.message });
  } catch (error) {
    sendResponse({ success: false, error: `Native messaging error: ${error.message}. Make sure the native host is installed.` });
  }
}

async function handleStopServer(sendResponse) {
  try {
    const response = await sendNativeMessage("stop");
    markServerUnknown();
    sendResponse({ success: response?.success ?? true, message: response?.message });
  } catch (error) {
    sendResponse({ success: false, error: `Native messaging error: ${error.message}` });
  }
}

async function handleServerStatus(sendResponse) {
  try {
    const response = await sendNativeMessage("status");
    sendResponse({ success: true, running: response?.running ?? false, pid: response?.pid });
  } catch (error) {
    sendResponse({ success: false, running: false });
  }
}

async function autoStartServer() {
  try {
    const statusResponse = await sendNativeMessage("status").catch(() => null);
    if (statusResponse === null) {
      return { success: false, error: "Native host not available. Make sure the native host is installed." };
    }
    const response = await sendNativeMessage("start");
    return { success: response?.success ?? true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function waitForServerReady(timeoutMs = 30000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`${SERVER_URL}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const data = await response.json();
        if (data.model_loaded) { markServerKnownRunning(); return true; }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function fetchJson(path, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const response = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(timeoutMs),
  });
  const maybeJson = await response.json().catch(() => ({}));
  if (!response.ok) {
    markServerUnknown();
    const detail = maybeJson?.detail || `${response.status} ${response.statusText}`;
    throw new Error(detail);
  }
  markServerKnownRunning();
  return maybeJson;
}

// ── Health / Models / Voices ───────────────────────────────────
async function handleHealth(sendResponse) {
  try {
    const data = await fetchJson("/health");
    sendResponse({ success: true, data });
  } catch (error) {
    markServerUnknown();
    sendResponse({ success: false, error: error.message });
  }
}

async function handleGetModels(sendResponse) {
  try {
    const data = await fetchJson("/v1/models");
    sendResponse({ success: true, data });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleLoadModel(request, sendResponse) {
  try {
    const modelId = request.modelId || "qwen3-tts";
    const data = await fetchJson(`/v1/load-model?model_id=${encodeURIComponent(modelId)}`, { method: "POST" });
    sendResponse({ success: true, data });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleGetVoices(request, sendResponse) {
  try {
    const data = await fetchJson("/v1/voices");
    sendResponse({ success: true, data });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

// ── Ensure server running ──────────────────────────────────────
async function ensureServerRunning() {
  if (isServerKnownRunning()) return true;

  const healthCheck = await fetch(`${SERVER_URL}/health`, {
    method: "GET",
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);

  if (healthCheck && healthCheck.ok) {
    markServerKnownRunning();
    return true;
  }

  markServerUnknown();
  const startResult = await autoStartServer();
  if (!startResult.success) return false;
  return await waitForServerReady(30000);
}

// ── Single-chunk TTS (popup preview) ─────────────────────────
async function handleTTSRequest(request, sendResponse) {
  try {
    const serverOk = await ensureServerRunning();
    if (!serverOk) {
      sendResponse({ success: false, error: "Server not running or failed to start.", serverDown: true });
      return;
    }

    const body = {
      text: request.text,
      voice: request.voice,
      speed: request.speed,
      language: request.language || "Auto",
      format: "wav",
    };
    if (request.model) body.model = request.model;

    const response = await fetch(`${SERVER_URL}/v1/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });

    if (!response.ok) {
      const maybeJson = await response.json().catch(() => ({}));
      throw new Error(maybeJson?.detail || `Server error ${response.status}`);
    }

    markServerKnownRunning();
    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "audio/wav";
    const base64 = arrayBufferToBase64(arrayBuffer);
    const dataUrl = `data:${contentType};base64,${base64}`;

    sendResponse({ success: true, audioData: dataUrl });
  } catch (error) {
    console.error("[Open TTS Background] Error:", error);
    markServerUnknown();
    sendResponse({ success: false, error: error.message });
  }
}