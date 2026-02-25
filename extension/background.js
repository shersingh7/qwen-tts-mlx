const SERVER_URL = "http://127.0.0.1:8000";

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "TTS_REQUEST") {
    handleTTSRequest(request, sendResponse);
    return true;
  }

  if (request.type === "GET_VOICES") {
    handleGetVoices(sendResponse);
    return true;
  }

  if (request.type === "GET_HEALTH") {
    handleHealth(sendResponse);
    return true;
  }
});

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

async function handleGetVoices(sendResponse) {
  try {
    const data = await fetchJson("/v1/voices");
    sendResponse({ success: true, data });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleTTSRequest(request, sendResponse) {
  try {
    const response = await fetch(`${SERVER_URL}/v1/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: request.text,
        voice: request.voice,
        speed: request.speed,
        language: request.language || "Auto",
      }),
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
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}
