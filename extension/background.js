const SERVER_URL = "http://127.0.0.1:8000";
const NATIVE_HOST_NAME = "com.open_tts.native_host";

// ---------------------------------------------------------------------------
// Server-known-running cache
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Array buffer → base64 (optimized: batch chunk-based, avoids stack overflow)
// ---------------------------------------------------------------------------

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  const chunkSize = 0x8000; // 32KB
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(""));
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "TTS_REQUEST") {
    handleTTSRequest(request, sendResponse);
    return true;
  }
  if (request.type === "TTS_STREAM_REQUEST") {
    handleTTSStreamRequest(request, sender);
    return true;
  }
  if (request.type === "TTS_BATCH_REQUEST") {
    handleTTSBatchRequest(request, sender);
    return true;
  }
  if (request.type === "GET_VOICES") {
    handleGetVoices(request, sendResponse);
    return true;
  }
  if (request.type === "GET_MODELS") {
    handleGetModels(sendResponse);
    return true;
  }
  if (request.type === "LOAD_MODEL") {
    handleLoadModel(request, sendResponse);
    return true;
  }
  if (request.type === "GET_HEALTH") {
    handleHealth(sendResponse);
    return true;
  }
  if (request.type === "ENSURE_SERVER") {
    ensureServerRunning().then(ok => sendResponse({ success: ok })).catch(() => sendResponse({ success: false }));
    return true;
  }
  if (request.type === "START_SERVER") {
    handleStartServer(sendResponse);
    return true;
  }
  if (request.type === "STOP_SERVER") {
    handleStopServer(sendResponse);
    return true;
  }
  if (request.type === "GET_SERVER_STATUS") {
    handleServerStatus(sendResponse);
    return true;
  }
});

// ---------------------------------------------------------------------------
// Native messaging
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Server management
// ---------------------------------------------------------------------------
async function handleStartServer(sendResponse) {
  try {
    const response = await sendNativeMessage("start");
    markServerUnknown();
    sendResponse({ success: response?.success ?? true, message: response?.message });
  } catch (error) {
    sendResponse({
      success: false,
      error: `Native messaging error: ${error.message}. Make sure the native host is installed (run install_native_host.sh)`,
    });
  }
}

async function handleStopServer(sendResponse) {
  try {
    const response = await sendNativeMessage("stop");
    markServerUnknown();
    sendResponse({ success: response?.success ?? true, message: response?.message });
  } catch (error) {
    sendResponse({
      success: false,
      error: `Native messaging error: ${error.message}. Make sure the native host is installed (run install_native_host.sh)`,
    });
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
      console.error("[Open TTS Background] Native host not available");
      return { success: false, error: "Native host not available. Make sure the native host is installed (run install_native_host.sh)" };
    }

    console.log("[Open TTS Background] Auto-starting server...");
    const response = await sendNativeMessage("start");
    return { success: response?.success ?? true };
  } catch (error) {
    console.error("[Open TTS Background] Auto-start failed:", error);
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

// ---------------------------------------------------------------------------
// Retry helper — 1 retry with 1s delay for transient failures (5xx, network)
// ---------------------------------------------------------------------------

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
      // 4xx = client error, don't retry
      if (response.status >= 400 && response.status < 500) {
        markServerUnknown();
        const maybeJson = await response.json().catch(() => ({}));
        throw new Error(maybeJson?.detail || `Server error ${response.status}`);
      }
      // 5xx = server error, retry
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

// ---------------------------------------------------------------------------
// Health / Models / Voices / Load-model
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Ensure server is running
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Non-streaming TTS request
// Returns base64 data URL — content.js creates Object URL from it
// ---------------------------------------------------------------------------
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
      format: "opus",
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

// ---------------------------------------------------------------------------
// Read with idle timeout
// ---------------------------------------------------------------------------
function readWithTimeout(reader, timeoutMs) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reader.cancel();
      reject(new Error(`Stream read timeout — no data received for ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });
  return reader.read().then(
    (result) => {
      clearTimeout(timer);
      return result;
    },
    (err) => {
      clearTimeout(timer);
      throw err;
    }
  );
}

// ---------------------------------------------------------------------------
// WAV parser helpers — optimized for concatenated WAV streams
// ---------------------------------------------------------------------------

const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46];

function findRiffOffset(buf, start = 0) {
  for (let i = start; i <= buf.length - 4; i++) {
    if (buf[i] === RIFF_MAGIC[0] && buf[i+1] === RIFF_MAGIC[1] &&
        buf[i+2] === RIFF_MAGIC[2] && buf[i+3] === RIFF_MAGIC[3]) {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Streaming TTS request — sends raw ArrayBuffer directly to content.js
// ---------------------------------------------------------------------------
async function handleTTSStreamRequest(request, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  try {
    const serverOk = await ensureServerRunning();
    if (!serverOk) {
      chrome.tabs.sendMessage(tabId, {
        type: "TTS_STREAM_ERROR",
        chunkIndex: request.chunkIndex,
        error: "Server not running or failed to start. Try restarting the server manually.",
      });
      return;
    }

    const body = {
      text: request.text,
      voice: request.voice,
      speed: request.speed,
      language: request.language || "Auto",
      stream: true,
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
      const detail = maybeJson?.detail || `Server error ${response.status}`;
      throw new Error(detail);
    }

    markServerKnownRunning();

    // Check if server fell back to non-streaming (e.g. Fish S2 Pro)
    const fallbackHeader = response.headers.get("X-TTS-Fallback");
    if (fallbackHeader === "non-streaming") {
      const contentType = response.headers.get("content-type") || "audio/ogg";
      const arrayBuffer = await response.arrayBuffer();
      const base64 = arrayBufferToBase64(arrayBuffer);

      chrome.tabs.sendMessage(tabId, {
        type: "TTS_STREAM_CHUNK",
        chunkIndex: request.chunkIndex,
        audioBase64: base64,
        audioMimeType: contentType,
      });

      chrome.tabs.sendMessage(tabId, {
        type: "TTS_STREAM_DONE",
        chunkIndex: request.chunkIndex,
      });
      return;
    }

    // Read streaming response, parse concatenated WAVs, forward raw ArrayBuffer chunks
    const reader = response.body.getReader();
    const bufferParts = [];
    let bufferLength = 0;
    const STREAM_IDLE_TIMEOUT_MS = 30000;

    function flattenBuffer() {
      const result = new Uint8Array(bufferLength);
      let offset = 0;
      for (const part of bufferParts) {
        result.set(part, offset);
        offset += part.length;
      }
      return result;
    }

    while (true) {
      let result;
      try {
        result = await readWithTimeout(reader, STREAM_IDLE_TIMEOUT_MS);
      } catch (readErr) {
        throw new Error(`Stream read failed: ${readErr.message}`);
      }

      const { done, value } = result;
      if (done) break;

      // O(1) append
      bufferParts.push(new Uint8Array(value));
      bufferLength += value.length;

      // Only flatten when we need to parse
      let buffer = flattenBuffer();
      bufferParts.length = 0;
      bufferParts.push(buffer);

      let offset = 0;
      while (offset + 44 <= buffer.length) {
        if (buffer[offset] !== RIFF_MAGIC[0] || buffer[offset+1] !== RIFF_MAGIC[1] ||
            buffer[offset+2] !== RIFF_MAGIC[2] || buffer[offset+3] !== RIFF_MAGIC[3]) {
          const riffOffset = findRiffOffset(buffer, offset);
          if (riffOffset > offset) {
            console.warn(`[Open TTS] Skipping ${riffOffset - offset} corrupted bytes before RIFF`);
            offset = riffOffset;
            continue;
          } else {
            const keep = buffer.slice(Math.max(offset, buffer.length - 3));
            bufferParts.length = 0;
            bufferParts.push(keep);
            bufferLength = keep.length;
            break;
          }
        }

        const wavSize = (buffer[offset+4] | (buffer[offset+5] << 8) |
                        (buffer[offset+6] << 16) | (buffer[offset+7] << 24)) + 8;
        if (offset + wavSize > buffer.length) break;

        const wavData = buffer.slice(offset, offset + wavSize);
        offset += wavSize;

        const base64 = arrayBufferToBase64(
          wavData.buffer.slice(wavData.byteOffset,
                               wavData.byteOffset + wavData.byteLength)
        );

        chrome.tabs.sendMessage(tabId, {
          type: "TTS_STREAM_CHUNK",
          chunkIndex: request.chunkIndex,
          audioBase64: base64,
        });
      }

      if (offset > 0 && offset < buffer.length) {
        const remaining = buffer.slice(offset);
        bufferParts.length = 0;
        bufferParts.push(remaining);
        bufferLength = remaining.length;
      }
    }

    // Process remaining buffer
    if (bufferLength >= 44) {
      const buffer = flattenBuffer();
      const riffOffset = findRiffOffset(buffer);
      const startIdx = riffOffset >= 0 ? riffOffset : (buffer[0] === RIFF_MAGIC[0] ? 0 : -1);
      if (startIdx >= 0 && startIdx < buffer.length) {
        const wavData = buffer.slice(startIdx);
        const base64 = arrayBufferToBase64(
          wavData.buffer.slice(wavData.byteOffset,
                               wavData.byteOffset + wavData.byteLength)
        );
        chrome.tabs.sendMessage(tabId, {
          type: "TTS_STREAM_CHUNK",
          chunkIndex: request.chunkIndex,
          audioBase64: base64,
        });
      }
    }

    chrome.tabs.sendMessage(tabId, {
      type: "TTS_STREAM_DONE",
      chunkIndex: request.chunkIndex,
    });
  } catch (error) {
    console.error("[Open TTS Background] Stream error:", error);
    markServerUnknown();
    chrome.tabs.sendMessage(tabId, {
      type: "TTS_STREAM_ERROR",
      chunkIndex: request.chunkIndex,
      error: error.message || "Unknown streaming error",
    });
  }
}

// ---------------------------------------------------------------------------
// BATCH TTS request — uses /v1/synthesize-batch endpoint.
// Single HTTP call + single gpu_lock for ALL chunks.
// This is the BIG win for multi-chunk scenarios.
// Server returns JSON array of base64-encoded audio chunks.
// ---------------------------------------------------------------------------
async function handleTTSBatchRequest(request, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  try {
    const serverOk = await ensureServerRunning();
    if (!serverOk) {
      chrome.tabs.sendMessage(tabId, {
        type: "TTS_BATCH_ERROR",
        batchId: request.batchId,
        error: "Server not running or failed to start. Try restarting the server manually.",
      });
      return;
    }

    const body = {
      texts: request.texts,
      voice: request.voice,
      speed: request.speed,
      language: request.language || "Auto",
      format: "opus",
    };
    if (request.model) body.model = request.model;

    console.log(`[Open TTS Background] Batch request: ${request.texts.length} texts, ${request.texts.reduce((sum, t) => sum + t.length, 0)} total chars`);

    const response = await fetchWithRetry(`${SERVER_URL}/v1/synthesize-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 600000, // longer timeout for batch
    });

    if (!response.ok) {
      const maybeJson = await response.json().catch(() => ({}));
      throw new Error(maybeJson?.detail || `Server error ${response.status}`);
    }

    markServerKnownRunning();

    const batchResult = await response.json();
    console.log(`[Open TTS Background] Batch complete: ${batchResult.results.length} results, ${batchResult.error_count} errors, ${batchResult.total_time}s`);

    // Send results back to content.js
    chrome.tabs.sendMessage(tabId, {
      type: "TTS_BATCH_RESULT",
      batchId: request.batchId,
      result: batchResult,
    });
  } catch (error) {
    console.error("[Open TTS Background] Batch error:", error);
    markServerUnknown();
    chrome.tabs.sendMessage(tabId, {
      type: "TTS_BATCH_ERROR",
      batchId: request.batchId,
      error: error.message || "Unknown batch error",
    });
  }
}
