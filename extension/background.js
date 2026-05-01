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

// ── Message handler ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const type = request.type;
  if (type === "TTS_REQUEST") {
    handleTTSRequest(request, sendResponse);
    return true;
  }
    if (type === "TTS_BATCH_REQUEST") {
      // Dead code — content.js now fetches directly to avoid MV3 SW lifetime kill
      sendResponse({ success: false, error: "Deprecated — content.js uses direct fetch." });
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
    ensureServerRunning().then(ok => sendResponse({ success: ok })).catch(() => sendResponse({ success: false }));
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

// ── Native messaging ───────────────────────────────────────────
function sendNativeMessage(command) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { command },
      (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
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
        if (data.model_loaded) {
          markServerKnownRunning();
          return true;
        }
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

// ── Retry helper ───────────────────────────────────────────────
async function fetchWithRetry(url, options = {}, retries = 1, delayMs = 1000) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 30000),
      });
      if (response.ok) {
        markServerKnownRunning();
        return response;
      }
      if (response.status >= 400 && response.status < 500) {
        markServerUnknown();
        const maybeJson = await response.json().catch(() => ({}));
        throw new Error(maybeJson?.detail || `Server error ${response.status}`);
      }
      lastError = new Error(`Server error ${response.status}`);
      markServerUnknown();
    } catch (err) {
      markServerUnknown();
      lastError = err;
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, delayMs));
  }
  throw lastError;
}

// ── Health / Models / Voices ────────────────────────────────────
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

// ── Ensure server running ───────────────────────────────────────
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

// ── Single-chunk TTS (popup preview) ────────────────────────────
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

    const response = await fetchWithRetry(`${SERVER_URL}/v1/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 300000,
    });

    if (!response.ok) {
      const maybeJson = await response.json().catch(() => ({}));
      throw new Error(maybeJson?.detail || `Server error ${response.status}`);
    }

    markServerKnownRunning();
    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "audio/ogg";
    const base64 = arrayBufferToBase64(arrayBuffer);
    const dataUrl = `data:${contentType};base64,${base64}`;

    sendResponse({ success: true, audioData: dataUrl });
  } catch (error) {
    console.error("[Open TTS Background] Error:", error);
    markServerUnknown();
    sendResponse({ success: false, error: error.message });
  }
}

// ── Batch TTS — DEAD CODE (content.js fetches directly now) ──────
// async function handleTTSBatchRequest(request, sendResponse) {
//   try {
//     ...
//     keep function body here until fully tested, but it's disconnected from the router.
// }
async function handleTTSBatchRequest(request, sendResponse) {
  sendResponse({ success: false, error: "Deprecated — content.js uses direct fetch." });
}
