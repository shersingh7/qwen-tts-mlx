let widget = null;
let selectedText = "";
let speakRunId = 0;
let isSpeaking = false;
let isPaused = false;
let audioQueue = [];
let audioIndex = 0;
let currentAbortController = null;

const MAX_SELECTION_CHARS = 200000;
const CHUNK_TARGET_CHARS = 4000;
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

// ─── Audio cleanup ───────────────────────────────────────────────

function stopAllAudio() {
  currentAbortController?.abort();
  currentAbortController = null;
  for (const a of audioQueue) {
    try { a.pause(); a.src = ""; a.load(); } catch (e) {}
  }
  audioQueue = [];
  audioIndex = 0;
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
  // Fast path: direct health check (no service worker involved)
  try {
    const r = await fetch(`${SERVER_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (r.ok) {
      const d = await r.json();
      if (d.model_loaded) return true;
      // Server up but model warming — give it a moment
      await new Promise(r => setTimeout(r, 1500));
      return true;
    }
  } catch {}

  // Ask background to start server (short-lived message, SW won't die)
  let started = false;
  try {
    const r = await chrome.runtime.sendMessage({ type: "ENSURE_SERVER" });
    if (r?.success) started = true;
  } catch {
    // If SW is dead, try direct start via native host isn't possible from content.
    // We'll retry health check a few times in case another tab's popup started it.
  }

  // Poll health directly until ready (or timeout)
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

// ─── Playback ────────────────────────────────────────────────────

function playNextChunk(runId) {
  if (runId !== speakRunId) return;
  if (audioIndex >= audioQueue.length) {
    isSpeaking = false;
    isPaused = false;
    setBusy(false, "Speak");
    return;
  }

  const audio = audioQueue[audioIndex];
  if (!audio) {
    audioIndex++;
    playNextChunk(runId);
    return;
  }

  const onEnded = () => {
    cleanup();
    audioIndex++;
    setTimeout(() => playNextChunk(runId), 50);
  };

  const onError = () => {
    cleanup();
    console.error("[Open TTS] Audio error chunk", audioIndex);
    audioIndex++;
    setTimeout(() => playNextChunk(runId), 50);
  };

  function cleanup() {
    audio.removeEventListener("ended", onEnded);
    audio.removeEventListener("error", onError);
  }

  audio.addEventListener("ended", onEnded);
  audio.addEventListener("error", onError);

  audio.play().catch(err => {
    console.error("[Open TTS] Play failed:", err);
    cleanup();
    audioIndex++;
    setTimeout(() => playNextChunk(runId), 50);
  });

  const remaining = audioQueue.length - audioIndex;
  setBusy(true, remaining > 1
    ? `Reading ${audioIndex + 1}/${audioQueue.length}... tap to stop`
    : "Reading... tap to stop");
}

// ─── Main speak handler ─────────────────────────────────────────

async function onSpeakClick(event) {
  event.preventDefault();
  event.stopPropagation();

  const text = selectedText?.trim();
  if (!text) return;

  // Toggle: pause / resume / stop
  if (isSpeaking) {
    const currentAudio = audioQueue[audioIndex];
    if (currentAudio && !currentAudio.paused && !isPaused) {
      currentAudio.pause();
      isPaused = true;
      widget?.classList.add("paused");
      setBusy(true, "Paused — tap to resume");
      return;
    }
    if (currentAudio && isPaused) {
      currentAudio.play().catch(() => {});
      isPaused = false;
      widget?.classList.remove("paused");
      setBusy(true, "Reading... tap to stop");
      return;
    }
    // Full stop
    speakRunId++;
    isSpeaking = false;
    isPaused = false;
    widget?.classList.remove("paused");
    stopAllAudio();
    setBusy(false, "Stopped");
    return;
  }

  const runId = ++speakRunId;
  isSpeaking = true;
  isPaused = false;
  stopAllAudio();
  currentAbortController = new AbortController();

  try {
    setBusy(true, "Preparing...");

    const chunks = splitTextForTTS(text, CHUNK_TARGET_CHARS);
    if (!chunks.length) throw new Error("Nothing to read");

    const settings = await chrome.storage.sync.get(["voice", "speed", "language", "model"]);
    const playbackRate = Number(settings.speed) || 1.0;

    // Ensure server is running (fast, service-worker-safe)
    const serverOk = await ensureServerRunning();
    if (!serverOk) throw new Error("Server not running — start it from the popup");

    // DIRECT FETCH — bypasses service worker completely. No "context invalidated".
    setBusy(true, `Generating ${chunks.length} chunk(s)...`);
    const batchResult = await synthesizeBatchDirect(chunks, settings, currentAbortController.signal);

    if (runId !== speakRunId) return; // user stopped while generating

    const results = batchResult.results || [];
    if (!results.length) throw new Error("No audio returned");

    // Build Audio elements from base64 responses
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.error) {
        console.warn(`[Open TTS] Chunk ${i} error:`, r.error);
        continue;
      }
      if (!r.audio_base64) continue;

      const mime = r.mime_type || "audio/wav";
      const dataUrl = `data:${mime};base64,${r.audio_base64}`;
      const audio = new Audio(dataUrl);
      audio.playbackRate = playbackRate;
      audio.preservesPitch = true;
      audioQueue.push(audio);
    }

    if (!audioQueue.length) {
      throw new Error("No playable audio generated");
    }

    // Start sequential playback
    audioIndex = 0;
    playNextChunk(runId);

  } catch (error) {
    if (error.name === "AbortError") {
      // User clicked stop — not a real error
      return;
    }
    console.error("[Open TTS] Error:", error);
    if (runId === speakRunId) flashError(error?.message || "Couldn't read. Tap again");
    isSpeaking = false;
    isPaused = false;
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
