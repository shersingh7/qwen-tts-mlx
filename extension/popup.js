const voiceSelect = document.getElementById("voice");
const languageSelect = document.getElementById("language");
const speedInput = document.getElementById("speed");
const speedValue = document.getElementById("speedValue");
const statusDiv = document.getElementById("status");
const modelInfo = document.getElementById("modelInfo");
const previewText = document.getElementById("previewText");
const previewBtn = document.getElementById("previewBtn");

const DEFAULTS = {
  voice: "ryan",
  speed: 1.0,
  language: "Auto",
  previewText: "Hello! Your MLX voice engine is ready. This text-to-speech runs entirely on your Mac.",
};

let currentPreviewAudio = null;

function setStatus(connected, text) {
  statusDiv.textContent = text;
  statusDiv.className = `status ${connected ? "connected" : "disconnected"}`;
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.sync.set(obj, resolve));
}

function runtimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

async function loadSettings() {
  const data = await storageGet(["voice", "speed", "language", "previewText"]);

  const speed = Number(data.speed ?? DEFAULTS.speed);
  speedInput.value = speed.toFixed(1);
  speedValue.textContent = `${speed.toFixed(1)}x`;

  languageSelect.value = data.language || DEFAULTS.language;
  previewText.value = data.previewText || DEFAULTS.previewText;
}

function wireEvents() {
  speedInput.addEventListener("input", async () => {
    const speed = Number(speedInput.value);
    speedValue.textContent = `${speed.toFixed(1)}x`;
    await storageSet({ speed });
  });

  voiceSelect.addEventListener("change", async () => {
    await storageSet({ voice: voiceSelect.value });
  });

  languageSelect.addEventListener("change", async () => {
    await storageSet({ language: languageSelect.value });
  });

  previewText.addEventListener("input", async () => {
    await storageSet({ previewText: previewText.value });
  });

  previewBtn.addEventListener("click", handlePreview);
}

async function loadVoices() {
  const response = await runtimeMessage({ type: "GET_VOICES" });
  if (!response?.success) {
    throw new Error(response?.error || "Unable to load voices");
  }

  const data = response.data;
  const saved = await storageGet(["voice"]);
  const preferred = (saved.voice || DEFAULTS.voice || "").toLowerCase();

  voiceSelect.innerHTML = "";
  data.voices.forEach((voice) => {
    const option = document.createElement("option");
    option.value = voice.id;
    option.textContent = voice.name;
    if (voice.id.toLowerCase() === preferred) option.selected = true;
    voiceSelect.appendChild(option);
  });

  if (!voiceSelect.value && data.voices.length > 0) {
    voiceSelect.value = data.voices[0].id;
  }

  await storageSet({ voice: voiceSelect.value });
}

async function refreshHealth() {
  const response = await runtimeMessage({ type: "GET_HEALTH" });

  if (!response?.success) {
    throw new Error(response?.error || "Health check failed");
  }

  const health = response.data;
  if (!health.model_loaded) {
    setStatus(false, "Server up, model failed to load");
    modelInfo.textContent = health.load_error || health.model || "Model load failed";
    return;
  }

  setStatus(true, "Connected to local MLX server");
  modelInfo.textContent = `Model: ${health.model}`;
}

async function handlePreview() {
  const text = previewText.value.trim();
  if (!text) {
    setStatus(false, "Preview text is empty");
    return;
  }

  previewBtn.disabled = true;
  previewBtn.textContent = "⏳ Generating…";

  try {
    if (currentPreviewAudio) {
      currentPreviewAudio.pause();
      currentPreviewAudio = null;
    }

    const playbackRate = Number(speedInput.value) || 1.0;

    const response = await runtimeMessage({
      type: "TTS_REQUEST",
      text,
      voice: voiceSelect.value,
      // Keep synthesis speed fixed; playbackRate controls exact user speed.
      speed: 1.0,
      language: languageSelect.value,
    });

    if (!response?.success) {
      throw new Error(response?.error || "Preview failed");
    }

    currentPreviewAudio = new Audio(response.audioData);
    currentPreviewAudio.playbackRate = playbackRate;
    await currentPreviewAudio.play();

    setStatus(true, "Preview playing");
    currentPreviewAudio.onended = () => setStatus(true, "Connected to local MLX server");
  } catch (error) {
    setStatus(false, `Preview failed: ${error.message}`);
  } finally {
    previewBtn.disabled = false;
    previewBtn.textContent = "▶ Play preview";
  }
}

async function init() {
  try {
    await loadSettings();
    wireEvents();
    await Promise.all([refreshHealth(), loadVoices()]);
  } catch (error) {
    setStatus(false, `Disconnected: ${error.message}`);
    modelInfo.textContent = "Check server at 127.0.0.1:8000";
    voiceSelect.innerHTML = "<option disabled selected>Server unavailable</option>";
  }
}

init();
