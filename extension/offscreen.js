// Open TTS — Offscreen Document (v2.2.1)
// Runs at chrome-extension:// origin = autoplay always allowed.
// Handles full synthesis + Web Audio playback.
// Speed is applied at synthesis time by the server — we do NOT re-apply
// playbackRate to avoid double-speed (X^2) effect.
// ──────────────────────────────────────────────────────────────

const SERVER_URL = "http://127.0.0.1:8000";
const CHUNK_TARGET = 4000;
const AUDIO_LEAD = 0.05;
const MAX_TIMEOUT = 300000;

let audioCtx = null;
let nextStartTime = 0;
let activeSources = new Set();
let scheduledCount = 0;
let endedCount = 0;
let abortCtl = null;
let isSpeaking = false;
let isPaused = false;

// ───── Audio helpers ──────────────────────────────────────────

function getAudioContext() {
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function closeAudio() {
  abortCtl?.abort();
  abortCtl = null;
  for (const s of activeSources) { try { s.stop(0); } catch (_) {} }
  activeSources.clear();
  scheduledCount = 0;
  endedCount = 0;
  if (audioCtx && audioCtx.state !== "closed") {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  nextStartTime = 0;
}

// ───── Notify background (→ content.js) ──────────────────────

function status(label) { chrome.runtime.sendMessage({ type: "TTS_STATUS", label }).catch(() => {}); }
function done() { chrome.runtime.sendMessage({ type: "TTS_DONE" }).catch(() => {}); }
function errMsg(message) { chrome.runtime.sendMessage({ type: "TTS_ERROR", message }).catch(() => {}); }

// ───── Text chunking ─────────────────────────────────────────

function norm(t) {
  return (t || "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
}

function splitText(text, maxChars = CHUNK_TARGET) {
  const cleaned = norm(text);
  if (!cleaned) return [];
  if (cleaned.length <= maxChars) return [cleaned];
  const out = [];
  const flush = c => { if (c.trim()) out.push(c.trim()); };
  for (const para of cleaned.split(/\n\n+/)) {
    if (!para.trim()) continue;
    if (para.length > maxChars) {
      for (const sent of para.split(/(?<=[.!?])\s+/)) {
        if (!sent) continue;
        if (sent.length > maxChars) {
          let buf = "";
          for (const w of sent.split(" ")) {
            if (!w) continue;
            const next = buf ? `${buf} ${w}` : w;
            if (next.length > maxChars && buf) { flush(buf); buf = w; }
            else buf = next;
          }
          if (buf) flush(buf);
        } else {
          const last = out[out.length - 1];
          const cand = last ? `${last} ${sent}` : sent;
          if (cand.length <= maxChars) out[out.length - 1] = cand;
          else out.push(sent);
        }
      }
    } else {
      const last = out[out.length - 1];
      const cand = last ? `${last}\n\n${para}` : para;
      if (cand.length <= maxChars) out[out.length - 1] = cand;
      else out.push(para);
    }
  }
  return out;
}

// ───── Server ────────────────────────────────────────────────

async function ensureServer() {
  try {
    const r = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
    const d = await r.json();
    return !!d.model_loaded;
  } catch (_) {
    // Server not responding — ask background.js to start it
    try {
      const startResult = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "ENSURE_SERVER" }, (resp) => {
          resolve(resp);
        });
      });
      if (startResult?.success) {
        // Wait for server to be ready (up to 30s)
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 500));
          try {
            const r = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
            if (r.ok) {
              const d = await r.json();
              if (d.model_loaded) return true;
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
    return false;
  }
}

async function synthBatch(texts, voice, speed, lang, model, signal) {
  const body = {
    texts,
    voice: voice || "ryan",
    speed: Number(speed) || 1.0,
    language: lang || "Auto",
    format: "wav",
  };
  if (model) body.model = model;
  const r = await fetch(`${SERVER_URL}/v1/synthesize-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(MAX_TIMEOUT),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.detail || `Server error ${r.status}`);
  }
  return r.json();
}

async function decodeChunk(b64) {
  const str = atob(b64);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return getAudioContext().decodeAudioData(bytes.buffer.slice(0));
}

function scheduleBuffers(bufs) {
  // Server already applies speed during synthesis. Play at 1.0x to avoid double-speed.
  const playbackRate = 1.0;
  const ctx = getAudioContext();
  if (ctx.state === "suspended") ctx.resume();

  nextStartTime = Math.max(nextStartTime, ctx.currentTime) + AUDIO_LEAD;
  scheduledCount = 0;
  endedCount = 0;

  for (let i = 0; i < bufs.length; i++) {
    const buf = bufs[i];
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = playbackRate;
    src.connect(ctx.destination);
    src.start(nextStartTime);
    nextStartTime += buf.duration / playbackRate;
    activeSources.add(src);
    scheduledCount++;

    src.onended = () => {
      activeSources.delete(src);
      endedCount++;
      if (scheduledCount > 1) {
        status(`Reading ${endedCount}/${scheduledCount}... tap to stop`);
      }
      if (endedCount >= scheduledCount) { isSpeaking = false; done(); }
    };
  }
  if (scheduledCount === 0) { isSpeaking = false; done(); }
}

// ───── Main pipeline ──────────────────────────────────────────

async function doSpeak(text, settings) {
  isSpeaking = true;
  isPaused = false;
  closeAudio();
  abortCtl = new AbortController();

  try {
    status("Preparing...");
    const chunks = splitText(text, CHUNK_TARGET);
    if (!chunks.length) throw new Error("Nothing to read");

    const serverOk = await ensureServer();
    if (!serverOk) throw new Error("Server not running");

    status(`Generating ${chunks.length} chunk(s)...`);
    const batch = await synthBatch(
      chunks, settings.voice, settings.speed,
      settings.language, settings.model, abortCtl.signal
    );

    const results = batch.results || [];
    if (!results.length) throw new Error("No audio returned");

    status("Loading audio...");
    const decoded = await Promise.all(
      results.map(async (r, i) => {
        if (r.error || !r.audio_base64) return null;
        try { return await decodeChunk(r.audio_base64); }
        catch (e) { console.error("[TTS Offscreen] decode chunk", i, e); return null; }
      })
    );
    const bufs = decoded.filter(Boolean);
    if (!bufs.length) throw new Error("No playable audio generated");

    status(bufs.length > 1 ? `Reading 1/${bufs.length}... tap to stop` : "Reading... tap to stop");
    scheduleBuffers(bufs);

  } catch (err) {
    if (err.name === "AbortError") { done(); return; }
    console.error("[TTS Offscreen] Pipeline error:", err);
    isSpeaking = false; closeAudio(); errMsg(err.message || "Generation failed");
  }
}

// ───── Message router ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  const t = request.type;

  if (t === "SPEAK") {
    doSpeak(request.text, request.settings || {});
    sendResponse({ started: true });
    return true;
  }
  if (t === "STOP") {
    isSpeaking = false; isPaused = false;
    closeAudio(); done();
    sendResponse({ stopped: true });
    return true;
  }
  if (t === "PAUSE") {
    if (audioCtx?.state === "running") {
      audioCtx.suspend(); isPaused = true; status("Paused — tap to resume");
    }
    sendResponse({ paused: true });
    return true;
  }
  if (t === "RESUME") {
    if (audioCtx?.state === "suspended") {
      audioCtx.resume(); isPaused = false; status("Reading... tap to stop");
    }
    sendResponse({ resumed: true });
    return true;
  }
});