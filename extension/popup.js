/* ═══════════════════════════════════════════════════════════════
   OPEN TTS — IMPERIAL EDITION
   Popup Script
   ═══════════════════════════════════════════════════════════════ */

// ── DOM refs ──
const voiceSelect = document.getElementById("voice");
const languageSelect = document.getElementById("language");
const speedInput = document.getElementById("speed");
const speedValue = document.getElementById("speedValue");
const statusDiv = document.getElementById("status");
const modelInfo = document.getElementById("modelInfo");
const previewText = document.getElementById("previewText");
const previewBtn = document.getElementById("previewBtn");
const startServerBtn = document.getElementById("startServerBtn");
const stopServerBtn = document.getElementById("stopServerBtn");
const serverStatus = document.getElementById("serverStatus");
const modelSelect = document.getElementById("model");
const statusLight = document.getElementById("statusLight");
const modelMeta = document.getElementById("modelMeta");
const charCount = document.getElementById("charCount");
const copyTextBtn = document.getElementById("copyTextBtn");
const vizCanvas = document.getElementById("visualizer");
const vizOverlay = document.getElementById("vizOverlay");
const historyToggle = document.getElementById("historyToggle");
const historyPanel = document.getElementById("historyPanel");
const historyList = document.getElementById("historyList");
const historyCount = document.getElementById("historyCount");
const clearHistoryBtn = document.getElementById("clearHistory");
const genCountEl = document.getElementById("genCount");
const latencyEl = document.getElementById("latency");
const themeBtns = document.querySelectorAll(".theme-btn");

const DEFAULTS = {
  model: "qwen3-tts",
  voice: "ryan",
  speed: 1.0,
  language: "Auto",
  previewText: "Hello! Open TTS is ready. Multiple local models running entirely on your Mac.",
  theme: "empire",
};

let currentPreviewAudio = null;
let currentModelId = null;
let audioCtx = null;
let analyser = null;
let vizAnimationId = null;
let generationCounter = 0;

// ── Chrome API wrappers ──
function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
}
function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.sync.set(obj, resolve));
}
function localGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function localSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
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

// ── Theme Engine ──
function setTheme(theme) {
  document.body.setAttribute("data-theme", theme);
  themeBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === theme);
  });
}

function initTheme() {
  themeBtns.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const t = btn.dataset.theme;
      setTheme(t);
      await storageSet({ theme: t });
    });
  });
}

// ── Visualizer ──
const vizCtx = vizCanvas.getContext("2d");

function resizeCanvas() {
  const rect = vizCanvas.parentElement.getBoundingClientRect();
  vizCanvas.width = rect.width;
  vizCanvas.height = rect.height;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

function getAccentColor() {
  const st = getComputedStyle(document.body);
  return st.getPropertyValue("--accent").trim() || "#ff1a1a";
}

function drawVisualizer(dataArray) {
  const w = vizCanvas.width;
  const h = vizCanvas.height;
  const accent = getAccentColor();

  vizCtx.clearRect(0, 0, w, h);

  const bars = 48;
  const barW = w / bars;
  const gap = 1;

  for (let i = 0; i < bars; i++) {
    let val = 0;
    if (dataArray && dataArray.length) {
      const idx = Math.floor((i / bars) * dataArray.length);
      val = dataArray[idx] / 255;
    } else {
      val = (Math.sin(Date.now() / 200 + i * 0.4) + 1) * 0.12;
    }

    const barH = Math.max(2, val * h * 0.85);
    const x = i * barW;
    const y = (h - barH) / 2;

    const grad = vizCtx.createLinearGradient(0, y, 0, y + barH);
    grad.addColorStop(0, accent);
    grad.addColorStop(1, "transparent");

    vizCtx.fillStyle = grad;
    vizCtx.globalAlpha = 0.65 + val * 0.35;
    vizCtx.fillRect(x + gap / 2, y, barW - gap, barH);
  }
  vizCtx.globalAlpha = 1;
}

function startVisualizer(mode = "sim") {
  stopVisualizer();
  vizCanvas.parentElement.classList.add("active");

  if (mode === "audio" && currentPreviewAudio) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (!analyser) {
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        const source = audioCtx.createMediaElementSource(currentPreviewAudio);
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
      }
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      function render() {
        if (!vizAnimationId) return;
        analyser.getByteFrequencyData(dataArray);
        drawVisualizer(dataArray);
        vizAnimationId = requestAnimationFrame(render);
      }
      vizAnimationId = requestAnimationFrame(render);
    } catch (e) {
      startVisualizer("sim");
    }
  } else {
    function renderSim() {
      if (!vizAnimationId) return;
      const sim = new Uint8Array(48);
      const t = Date.now() / 250;
      for (let i = 0; i < 48; i++) {
        sim[i] = Math.abs(Math.sin(t + i * 0.35)) * 55 + Math.random() * 45;
      }
      drawVisualizer(sim);
      vizAnimationId = requestAnimationFrame(renderSim);
    }
    vizAnimationId = requestAnimationFrame(renderSim);
  }
}

function stopVisualizer() {
  if (vizAnimationId) {
    cancelAnimationFrame(vizAnimationId);
    vizAnimationId = null;
  }
  if (vizCtx) {
    vizCtx.clearRect(0, 0, vizCanvas.width, vizCanvas.height);
  }
  if (vizCanvas && vizCanvas.parentElement) {
    vizCanvas.parentElement.classList.remove("active");
  }
}

// ── History Manager ──
const MAX_HISTORY = 20;

async function loadHistory() {
  const data = await localGet(["ttsHistory"]);
  const items = data.ttsHistory || [];
  renderHistory(items);
}

function renderHistory(items) {
  historyCount.textContent = items.length;
  if (items.length === 0) {
    historyList.innerHTML = '<div class="history-empty">No transmissions on record</div>';
    return;
  }
  historyList.innerHTML = "";
  [...items].reverse().forEach((item) => {
    const el = document.createElement("div");
    el.className = "history-item";
    el.innerHTML = `
      <span class="history-text" title="${escapeHtml(item.text)}">${escapeHtml(truncate(item.text, 26))}</span>
      <span class="history-time">${formatTime(item.timestamp)}</span>
      <div class="history-actions-inline">
        <button class="history-btn play-btn" data-id="${item.id}" title="Replay" aria-label="Replay">▶</button>
        <button class="history-btn delete-btn" data-id="${item.id}" title="Delete" aria-label="Delete">✕</button>
      </div>
    `;
    historyList.appendChild(el);
  });

  historyList.querySelectorAll(".play-btn").forEach((btn) => {
    btn.addEventListener("click", () => replayHistoryItem(Number(btn.dataset.id)));
  });
  historyList.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteHistoryItem(Number(btn.dataset.id)));
  });
}

async function addHistoryItem(entry) {
  const data = await localGet(["ttsHistory"]);
  const items = data.ttsHistory || [];
  items.push(entry);
  if (items.length > MAX_HISTORY) items.shift();
  await localSet({ ttsHistory: items });
  renderHistory(items);
}

async function deleteHistoryItem(id) {
  const data = await localGet(["ttsHistory"]);
  let items = data.ttsHistory || [];
  items = items.filter((i) => i.id !== id);
  await localSet({ ttsHistory: items });
  renderHistory(items);
}

async function replayHistoryItem(id) {
  const data = await localGet(["ttsHistory"]);
  const item = (data.ttsHistory || []).find((i) => i.id === id);
  if (!item) return;

  previewText.value = item.text;
  updateCharCount();
  await storageSet({ previewText: item.text });
  await handlePreview(true);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

function formatTime(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function initHistory() {
  loadHistory();
  historyToggle.addEventListener("click", () => {
    historyPanel.classList.toggle("collapsed");
    const expanded = !historyPanel.classList.contains("collapsed");
    historyToggle.setAttribute("aria-expanded", String(expanded));
  });
  historyToggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      historyToggle.click();
    }
  });
  clearHistoryBtn.addEventListener("click", async () => {
    await localSet({ ttsHistory: [] });
    renderHistory([]);
  });
}

// ── Character Counter ──
function updateCharCount() {
  const len = previewText.value.length;
  charCount.textContent = `${len} char${len !== 1 ? "s" : ""}`;
}

// ── Copy Button ──
async function handleCopy() {
  try {
    await navigator.clipboard.writeText(previewText.value);
    copyTextBtn.classList.add("copied");
    setTimeout(() => copyTextBtn.classList.remove("copied"), 1200);
  } catch (e) {}
}

// ── Core Functions (preserved & enhanced) ──

function setStatus(connected, text) {
  statusDiv.textContent = text;
  statusDiv.className = `connection-status ${connected ? "connected" : "disconnected"}`;
}

function setServerUI(state, message) {
  if (state === "running") {
    startServerBtn.disabled = true;
    stopServerBtn.disabled = false;
    statusLight.className = "breathing-light on";
  } else if (state === "stopped") {
    startServerBtn.disabled = false;
    stopServerBtn.disabled = true;
    statusLight.className = "breathing-light off";
  } else if (state === "error") {
    startServerBtn.disabled = false;
    stopServerBtn.disabled = true;
    statusLight.className = "breathing-light off";
  } else {
    startServerBtn.disabled = true;
    stopServerBtn.disabled = true;
    statusLight.className = "breathing-light warn";
  }
  serverStatus.textContent = message;
  serverStatus.className = `server-readout ${state}`;
}

async function handleStartServer() {
  setServerUI("starting", "Initiating sequence...");
  try {
    const response = await runtimeMessage({ type: "START_SERVER" });
    if (response?.success) {
      let ready = false;
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const health = await runtimeMessage({ type: "GET_HEALTH" }).catch(() => null);
        if (health?.success && health?.data?.model_loaded) {
          ready = true;
          break;
        }
      }
      if (ready) {
        try {
          await Promise.all([refreshHealth(), loadModels()]);
          setServerUI("running", "Server operational");
        } catch (e) {
          setServerUI("error", `Startup error: ${e.message}`);
        }
      } else {
        setServerUI("starting", "Loading model assets...");
        pollServerReady();
      }
    } else {
      setServerUI("error", response?.message || "Initiation failed");
    }
  } catch (error) {
    setServerUI("error", `Error: ${error.message}`);
  }
}

function pollServerReady() {
  let attempts = 0;
  const maxAttempts = 20;
  const interval = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(interval);
      setServerUI("error", "Server failed to start");
      return;
    }
    try {
      const health = await runtimeMessage({ type: "GET_HEALTH" });
      if (health?.success && health?.data?.model_loaded) {
        clearInterval(interval);
        try {
          await Promise.all([refreshHealth(), loadModels()]);
          setServerUI("running", "Server operational");
        } catch (e) {
          setServerUI("error", `Startup error: ${e.message}`);
        }
      }
    } catch (e) {}
  }, 1500);
}

async function handleStopServer() {
  setServerUI("starting", "Terminating...");
  try {
    const response = await runtimeMessage({ type: "STOP_SERVER" });
    if (response?.success) {
      setServerUI("stopped", "Server offline");
      setStatus(false, "Server stopped");
      modelInfo.textContent = "Initiate server to use TTS";
      modelMeta.textContent = "—";
      voiceSelect.innerHTML = '<option disabled selected>Start server first</option>';
      modelSelect.innerHTML = '<option disabled selected>Start server first</option>';
    } else {
      setServerUI("error", response?.message || "Termination failed");
    }
  } catch (error) {
    setServerUI("error", `Error: ${error.message}`);
  }
}

async function checkServerStatus() {
  try {
    const healthResponse = await runtimeMessage({ type: "GET_HEALTH" });
    if (healthResponse?.success) {
      if (healthResponse?.data?.model_loaded) {
        setServerUI("running", "Server operational");
        return true;
      } else if (healthResponse?.data?.load_error) {
        setServerUI("error", "Model load failed — reload required");
        return false;
      }
      setServerUI("starting", "Loading model assets...");
      pollServerReady();
      return false;
    }
  } catch (error) {}
  setServerUI("stopped", "Server offline");
  return false;
}

async function loadSettings() {
  const data = await storageGet(["model", "voice", "speed", "language", "previewText", "theme"]);

  const speed = Number(data.speed ?? DEFAULTS.speed);
  speedInput.value = speed.toFixed(1);
  speedValue.textContent = `${speed.toFixed(1)}x`;

  languageSelect.value = data.language || DEFAULTS.language;
  previewText.value = data.previewText || DEFAULTS.previewText;
  currentModelId = data.model || DEFAULTS.model;

  const theme = data.theme || DEFAULTS.theme;
  setTheme(theme);

  updateCharCount();
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
    updateCharCount();
    await storageSet({ previewText: previewText.value });
  });

  modelSelect.addEventListener("change", async () => {
    const selectedModel = modelSelect.value;
    currentModelId = selectedModel;
    await storageSet({ model: selectedModel });

    setServerUI("starting", `Switching to ${modelSelect.options[modelSelect.selectedIndex].text}...`);
    try {
      const response = await runtimeMessage({ type: "LOAD_MODEL", modelId: selectedModel });
      if (response?.success) {
        await loadVoices(selectedModel);
        setServerUI("running", "Server operational");
        updateLanguageVisibility(selectedModel);
        updateModelMeta(selectedModel);
      } else {
        setServerUI("error", response?.error || "Model switch failed");
      }
    } catch (error) {
      setServerUI("error", `Error switching: ${error.message}`);
    }
  });

  previewBtn.addEventListener("click", () => handlePreview(false));
  startServerBtn.addEventListener("click", handleStartServer);
  stopServerBtn.addEventListener("click", handleStopServer);
  copyTextBtn.addEventListener("click", handleCopy);
}

function updateLanguageVisibility(modelId) {
  if (modelId === "fish-s2-pro") {
    languageSelect.disabled = true;
    languageSelect.value = "Auto";
  } else {
    languageSelect.disabled = false;
  }
}

function updateModelMeta(modelId) {
  const meta = {
    "qwen3-tts": "Qwen3-TTS 1.7B — Local MLX inference",
    "fish-s2-pro": "Fish Audio S2 Pro — High quality",
  };
  modelMeta.textContent = meta[modelId] || "Local model";
}

async function loadModels() {
  const response = await runtimeMessage({ type: "GET_MODELS" });
  if (!response?.success) {
    throw new Error(response?.error || "Unable to load models");
  }

  const data = response.data;
  // Cache for loadVoices() — eliminates redundant GET_MODELS roundtrip
  _cachedModelsData = response;

  const saved = await storageGet(["model"]);
  const preferred = saved.model || DEFAULTS.model;

  modelSelect.innerHTML = "";
  data.models.forEach((m) => {
    const option = document.createElement("option");
    option.value = m.id;
    option.textContent = `${m.name}${m.active ? " ●" : ""}`;
    if (m.id === preferred) option.selected = true;
    modelSelect.appendChild(option);
  });

  const activeModel = data.models.find((m) => m.active) || data.models.find((m) => m.id === preferred);
  if (activeModel) {
    await loadVoices(activeModel.id);
    updateLanguageVisibility(activeModel.id);
    updateModelMeta(activeModel.id);
    currentModelId = activeModel.id;
  }
}

// loadVoices: populates voice dropdown without an extra network fetch.
// Reuses model data from loadModels() via a local cache.
let _cachedModelsData = null;

async function loadVoices(modelId) {
  // Use cached models data if available — avoids redundant GET_MODELS roundtrip
  const modelsResponse = _cachedModelsData || await runtimeMessage({ type: "GET_MODELS" });
  if (!_cachedModelsData) _cachedModelsData = modelsResponse;

  const modelData = modelsResponse?.data?.models?.find((m) => m.id === modelId);

  const saved = await storageGet(["voice"]);
  const preferredVoice = saved.voice || DEFAULTS.voice;

  voiceSelect.innerHTML = "";

  if (modelData?.voices?.length) {
    modelData.voices.forEach((v) => {
      const option = document.createElement("option");
      option.value = v.id;
      option.textContent = v.name;
      if (v.id === preferredVoice) option.selected = true;
      voiceSelect.appendChild(option);
    });
  } else {
    voiceSelect.innerHTML = '<option disabled selected>No voices available</option>';
  }
}

async function refreshHealth() {
  try {
    const response = await runtimeMessage({ type: "GET_HEALTH" });
    if (response?.success && response?.data?.model_loaded) {
      const model = response.data.model || DEFAULTS.model;
      const reg = { "qwen3-tts": "Qwen3-TTS 1.7B", "fish-s2-pro": "Fish Audio S2 Pro" };
      setStatus(true, `Connected — ${reg[model] || model}`);
      modelInfo.textContent = `Model: ${reg[model] || model}`;
      updateModelMeta(model);
    } else if (response?.success) {
      setStatus(false, "Server up, model not loaded");
      modelInfo.textContent = response.data?.load_error || "Model not loaded";
    } else {
      setStatus(false, "Server unreachable");
      modelInfo.textContent = "—";
    }
  } catch (e) {
    setStatus(false, "Server unreachable");
    modelInfo.textContent = "—";
  }
}

async function stopAllTabsTTS() {
  // Stop offscreen audio playback via background.js
  try {
    await runtimeMessage({ type: "STOP_TTS" });
  } catch (e) {}
  // Also stop content script state in all tabs
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "STOP_TTS" });
      } catch (e) {}
    }
  } catch (e) {}
}

async function handlePreview(skipHistory = false) {
  await stopAllTabsTTS();

  if (currentPreviewAudio) {
    currentPreviewAudio.pause();
    currentPreviewAudio.src = "";
    currentPreviewAudio = null;
  }

  const text = previewText.value.trim();
  if (!text) return;

  previewBtn.disabled = true;
  const btnTextSpan = previewBtn.querySelector(".btn-text");
  const originalText = btnTextSpan ? btnTextSpan.textContent : "EXECUTE TRANSMISSION";
  if (btnTextSpan) btnTextSpan.textContent = "GENERATING...";

  vizOverlay.textContent = "GENERATING";
  startVisualizer("sim");

  const startTime = performance.now();

  try {
    const settings = await storageGet(["voice", "speed", "language", "model"]);
    const response = await runtimeMessage({
      type: "TTS_REQUEST",
      text,
      voice: settings.voice || DEFAULTS.voice,
      speed: Number(settings.speed) || DEFAULTS.speed,
      language: settings.language || DEFAULTS.language,
      model: settings.model || DEFAULTS.model,
    });

    const latency = Math.round(performance.now() - startTime);
    latencyEl.textContent = `LAT: ${latency}ms`;

    if (response?.success) {
      const dataUrl = response.audioData;
      currentPreviewAudio = new Audio(dataUrl);
      // Speed is applied at synthesis time by the server — don't double-apply playbackRate
      currentPreviewAudio.playbackRate = 1.0;

      generationCounter++;
      genCountEl.textContent = `GEN: ${String(generationCounter).padStart(3, "0")}`;

      if (!skipHistory) {
        await addHistoryItem({
          id: Date.now(),
          text,
          voice: settings.voice || DEFAULTS.voice,
          model: settings.model || DEFAULTS.model,
          speed: Number(settings.speed) || DEFAULTS.speed,
          language: settings.language || DEFAULTS.language,
          timestamp: Date.now(),
        });
      }

      currentPreviewAudio.onplay = () => {
        vizOverlay.textContent = "TRANSMITTING";
        startVisualizer("audio");
      };

      currentPreviewAudio.onended = () => {
        previewBtn.disabled = false;
        if (btnTextSpan) btnTextSpan.textContent = originalText;
        stopVisualizer();
        vizOverlay.textContent = "STANDBY";
      };

      currentPreviewAudio.onerror = () => {
        previewBtn.disabled = false;
        if (btnTextSpan) btnTextSpan.textContent = originalText;
        stopVisualizer();
        vizOverlay.textContent = "STANDBY";
      };

      await currentPreviewAudio.play();
    } else {
      previewBtn.disabled = false;
      if (btnTextSpan) btnTextSpan.textContent = originalText;
      stopVisualizer();
      vizOverlay.textContent = "STANDBY";
      setStatus(false, response?.error || "TTS failed");
    }
  } catch (error) {
    previewBtn.disabled = false;
    if (btnTextSpan) btnTextSpan.textContent = originalText;
    stopVisualizer();
    vizOverlay.textContent = "STANDBY";
    setStatus(false, `Error: ${error.message}`);
  }
}

// ── Initialization ──
async function init() {
  await loadSettings();
  initTheme();
  initHistory();
  wireEvents();
  const isUp = await checkServerStatus();
  if (isUp) {
    await loadModels();
    await refreshHealth();
  }
}

init();
