let widget = null;
let selectedText = "";
let speakRunId = 0;
let isSpeaking = false;
let isPaused = false;
let currentAbortController = null;

// Web Audio API — required because Chrome blocks <audio>.play() in content scripts
// when the user gesture has expired (which it has after the 5-30 second generation).
let audioCtx = null;
let nextStartTime = 0;
let activeSources = new Set();
let scheduledCount = 0;
let endedCount = 0;
let onAllDone = null;

const MAX_SELECTION_CHARS = 200000;
const CHUNK_TARGET_CHARS = 4000;
const AUDIO_START_LEAD = 0.05; // seconds of lead-in between chunks
const SERVER_URL = "http://127.0.0.1:8000";

// ─── Widget ──────────────────────────────────────────────────────

function removeLegacyWidget() {
  document.querySelectorAll("#qwen-tts-icon-container").forEach(n => n.remove());
}
removeLegacyWidget();
new MutationObserver(() => removeLegacyWidget())
  .observe(document.documentElement || document.body, { childList: true, subtree: true });

function createWidget() {
  const container = document.createElement("div");
  container.id = "qwen-tts-widget";

  const button = document.createElement("button");
  button.id = "qwen-tts-button";
  button.type = "button";
  button.title = "Read selection aloud";

  const glyph = document.createElement("span");
  glyph.className = "qwen-glyph";
  glyph.innerHTML = `
    <span class="qwen-glyph-body"></span>
    <span class="qwen-glyph-cone"></span>
    <span class="qwen-glyph-wave wave1"></span>
    <span class="qwen-glyph-wave wave2"></span>
  `;
  button.appendChild(glyph);

  const label = document.createElement("span");
  label.id = "qwen-tts-label";
  label.textContent = "Speak";

  container.appendChild(button);
  container.appendChild(label);
  button.addEventListener("click", onSpeakClick);
  document.body.appendChild(container);
  widget = container;
  return container;
}

function setLabel(text) {
  const label = widget?.querySelector("#qwen-tts-label");
  if (label) label.textContent = text;
}

function showWidgetAtSelection(text) {
  selectedText = text;
  if (!widget) createWidget();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  const top = Math.max(window.scrollY + 8, window.scrollY + rect.top - 44);
  const left = Math.max(window.scrollX + 8, Math.min(
    window.scrollX + rect.left + rect.width / 2 - 48,
    window.scrollX + document.documentElement.clientWidth - 100
  ));
  widget.style.top = `${top}px`;
  widget.style.left = `${left}px`;
  widget.classList.add("visible");
}

function hideWidget() { widget?.classList.remove("visible"); }

function setBusy(busy, labelText) {
  if (!widget) return;
  widget.classList.toggle("busy", busy);
  setLabel(labelText || (busy ? "Generating..." : "Speak"));
}

function flashError(message) {
  if (!widget) return;
  setLabel(message);
  widget.classList.add("error");
  setTimeout(() => { widget?.classList.remove("error"); setLabel("Speak"); }, 3000);
}

// ─── Audio: Web Audio API (Chrome autoplay-safe) ─────────────────

function getAudioContext() {
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function closeAudioContext() {
  for (const src of activeSources) {
    try { src.stop(); } catch (e) {}
    try { src.disconnect(); } catch (e) {}
  }
  activeSources.clear();
  scheduledCount = 0;
  endedCount = 0;
  if (onAllDone) { onAllDone = null; }
  if (audioCtx && audioCtx.state !== "closed") {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  nextStartTime = 0;
}

function stopAllAudio() {
  currentAbortController?.abort();
  currentAbortController = null;
  closeAudioContext();
}

async function decodeAudioChunk(base64) {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  const ctx = getAudioContext();
  return ctx.decodeAudioData(bytes.buffer.slice(0));
}

function scheduleAllBuffers(audioBuffers, playbackRate) {
  const ctx = getAudioContext();
  // Resume if browser suspended the context (e.g. in background)
  if (ctx.state === "suspended") {
    ctx.resume();
  }

  scheduledCount = 0;
  endedCount = 0;
  nextStartTime = Math.max(nextStartTime, ctx.currentTime) + AUDIO_START_LEAD;

  const currentRunId = speakRunId;

  onAllDone = () => {
    if (currentRunId !== speakRunId) return;
    isSpeaking = false;
    isPaused = false;
    setBusy(false, "Speak");
    closeAudioContext();
  };

  for (let i = 0; i < audioBuffers.length; i++) {
    const buf = audioBuffers[i];
    if (!buf) continue;

    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.playbackRate.value = playbackRate;
    source.connect(ctx.destination);

    source.start(nextStartTime);
    nextStartTime += buf.duration / playbackRate;

    activeSources.add(source);
    scheduledCount++;

    source.onended = () => {
      activeSources.delete(source);
      endedCount++;
      if (endedCount >= scheduledCount && onAllDone) {
        const cb = onAllDone;
        onAllDone = null;
        cb();
      }
    };
  }

  // Edge case: every buffer was null — fire done immediately
  if (scheduledCount === 0 && onAllDone) {
    const cb = onAllDone;
    onAllDone = null;
    cb();
  }
}

// ─── Text splitting ────────────────────────────────────────────

function normalizeText(text) {
  return (text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTextForTTS(text, maxChars = CHUNK_TARGET_CHARS) {
  const cleaned = normalizeText(text);
  if (!cleaned) return [];
  if (cleaned.length <= maxChars) return [cleaned];

  const out = [];
  const flush = (chunk) => { if (chunk.trim()) out.push(chunk.trim()); };

  const paragraphs = cleaned.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (!para.trim()) continue;
    const candidate = current ? `${current}\n\n${para}` : para;

    if (candidate.length > maxChars && current) flush(current), current = "";

    if (para.length > maxChars) {
      if (current) flush(current), current = "";
      const sentences = para.split(/(?<=[.!?])\s+/);
      let sChunk = "";
      for (const s of sentences) {
        if (!s) continue;
        if (s.length > maxChars) {
          if (sChunk) flush(sChunk), sChunk = "";
          const words = s.split(" ");
          let wChunk = "";
          for (const w of words) {
            const next = wChunk ? `${wChunk} ${w}` : w;
            if (next.length > maxChars && wChunk) flush(wChunk), wChunk = w;
            else wChunk = next;
          }
          if (wChunk) flush(wChunk);
          continue;
        }
        const next = sChunk ? `${sChunk} ${s}` : s;
        if (next.length > maxChars) flush(sChunk), sChunk = s;
        else sChunk = next;
      }
      if (sChunk) flush(sChunk);
    } else {
      current = candidate;
      if (current.length > maxChars) flush(current), current = "";
    }
  }
  if (current) flush(current);
  return out;
}

// ─── Server communication (direct fetch — bypasses service worker) ─

async function ensureServerRunning() {
  try {
    const r = await fetch(`${SERVER_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (r.ok) {
      const d = await r.json();
      if (d.model_loaded) return true;
      await new Promise(r => setTimeout(r, 1500));
      return true;
    }
  } catch {}

  let started = false;
  try {
    const r = await chrome.runtime.sendMessage({ type: "ENSURE_SERVER" });
    if (r?.success) started = true;
  } catch {}

  for (let i = 0; i < (started ? 40 : 6); i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const r = await fetch(`${SERVER_URL}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) {
        const d = await r.json();
        if (d.model_loaded) return true;
      }
    } catch {}
  }

  return false;
}

async function synthesizeBatchDirect(texts, settings, signal) {
  const body = {
    texts,
    voice: settings.voice || "ryan",
    speed: Number(settings.speed) || 1.0,
    language: settings.language || "Auto",
    format: "wav",
  };
  if (settings.model) body.model = settings.model;

  const response = await fetch(`${SERVER_URL}/v1/synthesize-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(300000),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.detail || `Server error ${response.status}`);
  }

  return response.json();
}

// ─── Main speak handler ─────────────────────────────────────────

async function onSpeakClick(event) {
  event.preventDefault();
  event.stopPropagation();

  const text = selectedText?.trim();
  if (!text) return;

  // Toggle: pause / resume / stop
  if (isSpeaking) {
    // Already paused — resume
    if (isPaused) {
      if (audioCtx?.state === "suspended") audioCtx.resume();
      isPaused = false;
      widget?.classList.remove("paused");
      setBusy(true, "Reading... tap to stop");
      return;
    }
    // Still playing — pause
    if (scheduledCount > 0 && endedCount < scheduledCount) {
      if (audioCtx?.state === "running") audioCtx.suspend();
      isPaused = true;
      widget?.classList.add("paused");
      setBusy(true, "Paused — tap to resume");
      return;
    }
    // Finished or nothing scheduled — full stop
    speakRunId++;
    isSpeaking = false;
    isPaused = false;
    widget?.classList.remove("paused");
    stopAllAudio();
    setBusy(false, "Speak");
    return;
  }

  const runId = ++speakRunId;
  isSpeaking = true;
  isPaused = false;
  stopAllAudio();
  currentAbortController = new AbortController();

  try {
    // CRITICAL: create AudioContext now while the user gesture is active.
    // Chrome allows AudioContext.start() during a click; it blocks .play()
    // on <audio> elements whose user gesture has expired (which ours has
    // after the 5-30 second generation).
    const ctx = getAudioContext();
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});

    setBusy(true, "Preparing...");

    const chunks = splitTextForTTS(text, CHUNK_TARGET_CHARS);
    if (!chunks.length) throw new Error("Nothing to read");

    const settings = await chrome.storage.sync.get(["voice", "speed", "language", "model"]);
    const playbackRate = Number(settings.speed) || 1.0;

    const serverOk = await ensureServerRunning();
    if (!serverOk) throw new Error("Server not running — start it from the popup");

    setBusy(true, `Generating ${chunks.length} chunk(s)...`);
    const batchResult = await synthesizeBatchDirect(chunks, settings, currentAbortController.signal);

    if (runId !== speakRunId) return;

    const results = batchResult.results || [];
    if (!results.length) throw new Error("No audio returned");

    setBusy(true, "Loading audio...");

    // Decode all base64 responses into AudioBuffers (parallel)
    const decodePromises = results.map(async (r, i) => {
      if (r.error || !r.audio_base64) return null;
      try {
        return await decodeAudioChunk(r.audio_base64);
      } catch (e) {
        console.error(`[Open TTS] Decode error chunk ${i}:`, e);
        return null;
      }
    });
    const audioBuffers = (await Promise.all(decodePromises)).filter(Boolean);

    if (!audioBuffers.length) throw new Error("No playable audio generated");

    // Schedule all chunks for gapless playback via the Web Audio graph.
    // This survives Chrome's autoplay policy because the AudioContext
    // was created during the user click gesture.
    scheduleAllBuffers(audioBuffers, playbackRate);

    setBusy(true, audioBuffers.length > 1
      ? `Reading 1/${audioBuffers.length}... tap to stop`
      : "Reading... tap to stop");

  } catch (error) {
    if (error.name === "AbortError") return;
    console.error("[Open TTS] Error:", error);
    if (runId === speakRunId) flashError(error?.message || "Couldn't read. Tap again");
    isSpeaking = false;
    isPaused = false;
    stopAllAudio();
  } finally {
    currentAbortController = null;
  }
}

// ─── Selection events ────────────────────────────────────────────

document.addEventListener("mouseup", () => {
  const text = window.getSelection()?.toString().trim();
  if (text) showWidgetAtSelection(text.slice(0, MAX_SELECTION_CHARS));
  else setTimeout(() => { if (!window.getSelection()?.toString().trim()) hideWidget(); }, 80);
});

document.addEventListener("mousedown", (e) => {
  if (widget && !widget.contains(e.target)) hideWidget();
});

// ─── STOP handler from popup ─────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "STOP_TTS") {
    speakRunId++;
    isSpeaking = false;
    isPaused = false;
    widget?.classList.remove("paused");
    stopAllAudio();
    setLabel("Speak");
    if (sendResponse) sendResponse({ stopped: true });
    return true;
  }
});
