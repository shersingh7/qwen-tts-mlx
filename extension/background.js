const SERVER_URL = "http://127.0.0.1:8000";
const NATIVE_HOST_NAME = "com.open_tts.native_host";

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "TTS_REQUEST") {
    handleTTSRequest(request, sendResponse);
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

async function handleStartServer(sendResponse) {
  try {
    const response = await sendNativeMessage("start");
    sendResponse({ success: response?.success ?? true, message: response?.message });
  } catch (error) {
    console.error("[Open TTS Background] Start server error:", error);
    sendResponse({
      success: false,
      error: `Native messaging error: ${error.message}. Make sure the native host is installed (run install_native_host.sh)`,
    });
  }
}

async function handleStopServer(sendResponse) {
  try {
    const response = await sendNativeMessage("stop");
    sendResponse({ success: response?.success ?? true, message: response?.message });
  } catch (error) {
    console.error("[Open TTS Background] Stop server error:", error);
    sendResponse({
      success: false,
      error: `Native messaging error: ${error.message}. Make sure the native host is installed (run install_native_host.sh)`,
    });
  }
}

async function handleServerStatus(sendResponse) {
  try {
    const response = await sendNativeMessage("status");
    sendResponse({
      success: true,
      running: response?.running ?? false,
      pid: response?.pid,
    });
  } catch (error) {
    console.error("[Open TTS Background] Server status error:", error);
    sendResponse({ success: false, running: false });
  }
}

async function autoStartServer() {
  try {
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
  console.log("[Open TTS Background] Waiting for server to be ready...");

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`${SERVER_URL}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.model_loaded) {
          console.log("[Open TTS Background] Server is ready!");
          return true;
        }
      }
    } catch {
      // Server not ready yet, continue polling
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  console.error("[Open TTS Background] Server ready check timed out");
  return false;
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${SERVER_URL}${path}`, options);
  const maybeJson = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = maybeJson?.detail || `${response.status} ${response.statusText}`;
    throw new Error(detail);
  }

  return maybeJson;
}

async function handleHealth(sendResponse) {
  try {
    const data = await fetchJson("/health");
    sendResponse({ success: true, data });
  } catch (error) {
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
    const data = await fetchJson(`/v1/load-model?model_id=${encodeURIComponent(modelId)}`, {
      method: "POST",
    });
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

async function handleTTSRequest(request, sendResponse) {
  try {
    // First check if server is running
    const healthCheck = await fetch(`${SERVER_URL}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);

    if (!healthCheck || !healthCheck.ok) {
      const startResult = await autoStartServer();

      if (!startResult.success) {
        sendResponse({
          success: false,
          error: `Failed to start server: ${startResult.error}`,
          serverDown: true,
        });
        return;
      }

      const ready = await waitForServerReady(30000);

      if (!ready) {
        sendResponse({
          success: false,
          error: "Server start timed out. Try starting manually.",
          serverDown: true,
        });
        return;
      }
    }

    console.log("[Open TTS Background] Sending to server - model:", request.model, "voice:", request.voice);

    // Build request body — include model selection
    const body = {
      text: request.text,
      voice: request.voice,
      speed: request.speed,
      language: request.language || "Auto",
    };

    // Only include model param if explicitly set
    if (request.model) {
      body.model = request.model;
    }

    const response = await fetch(`${SERVER_URL}/v1/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000), // 5 minutes timeout
    });

    if (!response.ok) {
      const maybeJson = await response.json().catch(() => ({}));
      throw new Error(maybeJson?.detail || `Server error ${response.status}`);
    }

    const blob = await response.blob();
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    reader.onloadend = () => {
      sendResponse({ success: true, audioData: reader.result });
    };
    reader.onerror = () => {
      sendResponse({ success: false, error: "Failed to read audio data" });
    };
  } catch (error) {
    console.error("[Open TTS Background] Error:", error);
    sendResponse({ success: false, error: error.message });
  }
}