// Open TTS — Offscreen Document (v2.3.0)
// Runs at chrome-extension:// origin = autoplay always allowed.
// Handles full synthesis + Web Audio playback.
//
// PIPELINE v2.3: Streaming batch → progressive decode → gapless playback
// Instead of the old "batch → decode all → play all" (15s+ dead silence),
// we now use the streaming batch binary protocol:
//   1. Send all chunks to /v1/synthesize-stream-batch in one HTTP call
//   2. Server generates + returns chunks one-by-one (single gpu_lock hold)
//   3. We decode each chunk as it arrives and schedule it on the AudioContext
//   4. User hears chunk 0 after ~5s instead of ~15s
//
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

// ── Server health cache (offscreen-process level) ────────────
// Avoids redundant /health fetches between SPEAK calls.
let _serverKnownOk = false;
let _serverKnownAt = 0;
const SERVER_CACHE_TTL = 5 * 60 * 1000; // 5 min

function isServerCached() {
  return _serverKnownOk && (Date.now() - _serverKnownAt < SERVER_CACHE_TTL);
}
function markServerOk() { _serverKnownOk = true; _serverKnownAt = Date.now(); }
function markServerStale() { _serverKnownOk = false; }

// ───── Audio helpers ──────────────────────────────────────────

function getAudioContext() {
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function resetPlayback() {
  abortCtl?.abort();
  abortCtl = null;
  for (const s of activeSources) { try { s.stop(0); } catch (_) {} }
  activeSources.clear();
  scheduledCount = 0;
  endedCount = 0;
  // DO NOT close AudioContext — reuse it. Saves 100-500ms per SPEAK.
  // Just reset the scheduling timeline.
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
  if (isServerCached()) return true;

  try {
    const r = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) { markServerStale(); return false; }
    const d = await r.json();
    if (d.model_loaded) { markServerOk(); return true; }
  } catch (_) {}

  // Server not responding — ask background.js to start it
  try {
    const startResult = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "ENSURE_SERVER" }, (resp) => {
        resolve(resp);
      });
    });
    if (startResult?.success) {
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const r = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
          if (r.ok) {
            const d = await r.json();
            if (d.model_loaded) { markServerOk(); return true; }
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  markServerStale();
  return false;
}

// ───── Streaming batch binary protocol ───────────────────────
// Server sends frames:
//   [4 bytes: header-json length N, little-endian uint32]
//   [N bytes: UTF-8 JSON header {index, sample_rate, gen_time, final, error}]
//   [4 bytes: audio-wav length M, little-endian uint32]
//   [M bytes: WAV data (0 if error)]
// Terminal frame: header has {"done": true}

async function* streamBatch(texts, voice, speed, lang, model, signal) {
  const body = {
    texts,
    voice: voice || "ryan",
    speed: Number(speed) || 1.0,
    language: lang || "Auto",
  };
  if (model) body.model = model;

  const response = await fetch(`${SERVER_URL}/v1/synthesize-stream-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(MAX_TIMEOUT),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.detail || `Server error ${response.status}`);
  }

  const reader = response.body.getReader();
  let buf = new Uint8Array(0); // Accumulated unconsumed bytes

  while (true) {
    const { value, done: streamDone } = await reader.read();
    if (value) {
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf);
      merged.set(value, buf.length);
      buf = merged;
    }
    if (streamDone && buf.length === 0) break;

    // Try to parse complete frames from buf
    while (buf.length >= 4) {
      const headerLen = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true);
      if (buf.length < 4 + headerLen + 4) break; // incomplete frame

      const headerBytes = buf.slice(4, 4 + headerLen);
      const header = JSON.parse(new TextDecoder().decode(headerBytes));

      if (header.done) {
        reader.cancel().catch(() => {});
        return;
      }

      const audioLenOffset = 4 + headerLen;
      const audioLen = new DataView(buf.buffer, buf.byteOffset + audioLenOffset, 4).getUint32(0, true);
      const audioOffset = audioLenOffset + 4;

      if (buf.length < audioOffset + audioLen) break; // incomplete audio

      const audioBytes = buf.slice(audioOffset, audioOffset + audioLen);
      buf = buf.slice(audioOffset + audioLen);

      if (header.error) {
        yield { error: header.error, index: header.index };
      } else if (audioLen > 0) {
        yield { audio: audioBytes, index: header.index, sample_rate: header.sample_rate };
      }
    }

    if (streamDone) break;
  }
}

// ───── Decode + schedule progressively ───────────────────────

async function decodeWavBytes(wavBytes) {
  // decodeAudioData needs an ArrayBuffer, not Uint8Array
  const ab = wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength);
  return getAudioContext().decodeAudioData(ab);
}

function scheduleBuffer(buf, index, total) {
  const ctx = getAudioContext();
  if (ctx.state === "suspended") ctx.resume();

  // Gapless scheduling: if we're past the last scheduled end time, start there;
  // otherwise (first chunk or after a long gap), start from now + lead time.
  const startAt = Math.max(nextStartTime, ctx.currentTime + AUDIO_LEAD);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = 1.0; // server applies speed
  src.connect(ctx.destination);
  src.start(startAt);
  nextStartTime = startAt + buf.duration;
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

// ───── Main pipeline (streaming batch) ──────────────────────

async function doSpeak(text, settings) {
  isSpeaking = true;
  isPaused = false;
  resetPlayback();
  abortCtl = new AbortController();

  try {
    status("Preparing...");
    const chunks = splitText(text, CHUNK_TARGET);
    if (!chunks.length) throw new Error("Nothing to read");

    const serverOk = await ensureServer();
    if (!serverOk) throw new Error("Server not running");

    status(`Generating ${chunks.length} chunk(s)...`);

    // Progressive pipeline: decode and schedule each chunk as it arrives
    let totalChunks = chunks.length;
    let decodedCount = 0;
    let anyDecoded = false;

    for await (const frame of streamBatch(
      chunks, settings.voice, settings.speed,
      settings.language, settings.model, abortCtl.signal
    )) {
      if (frame.error) {
        console.error("[TTS Offscreen] Chunk", frame.index, "error:", frame.error);
        continue;
      }
      if (!frame.audio) continue;

      try {
        const audioBuf = await decodeWavBytes(frame.audio);
        decodedCount++;
        if (!anyDecoded) {
          anyDecoded = true;
          // First chunk decoded — user hears audio immediately!
          status(totalChunks > 1 ? `Reading 1/${totalChunks}... tap to stop` : "Reading... tap to stop");
        }
        scheduleBuffer(audioBuf, decodedCount, totalChunks);
      } catch (e) {
        console.error("[TTS Offscreen] Decode chunk", frame.index, e);
      }
    }

    if (!anyDecoded) throw new Error("No playable audio generated");

    markServerOk();

  } catch (err) {
    if (err.name === "AbortError") { done(); return; }
    console.error("[TTS Offscreen] Pipeline error:", err);
    isSpeaking = false; resetPlayback(); markServerStale();
    errMsg(err.message || "Generation failed");
  }
}

// ───── Fallback: non-streaming batch pipeline ───────────────
// Used if streaming batch endpoint fails (e.g. older server)

async function doSpeakFallback(text, settings) {
  isSpeaking = true;
  isPaused = false;
  resetPlayback();
  abortCtl = new AbortController();

  try {
    status("Preparing...");
    const chunks = splitText(text, CHUNK_TARGET);
    if (!chunks.length) throw new Error("Nothing to read");

    const serverOk = await ensureServer();
    if (!serverOk) throw new Error("Server not running");

    status(`Generating ${chunks.length} chunk(s)...`);

    const body = {
      texts: chunks,
      voice: settings.voice || "ryan",
      speed: Number(settings.speed) || 1.0,
      language: settings.language || "Auto",
      format: "wav",
    };
    if (settings.model) body.model = settings.model;

    const r = await fetch(`${SERVER_URL}/v1/synthesize-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortCtl.signal || AbortSignal.timeout(MAX_TIMEOUT),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || `Server error ${r.status}`);
    }

    const batch = await r.json();
    const results = batch.results || [];
    if (!results.length) throw new Error("No audio returned");

    // Progressive decode: decode in order, schedule each as it's ready
    status("Loading audio...");
    const bufs = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.error || !r.audio_base64) { bufs.push(null); continue; }
      try {
        const decoded = await decodeChunk(r.audio_base64);
        bufs.push(decoded);
        if (decoded) {
          // Schedule immediately — don't wait for remaining chunks
          if (!bufs.some(Boolean)) {
            // This is the first successful decode
            status(results.length > 1 ? `Reading 1/${results.length}... tap to stop` : "Reading... tap to stop");
          }
          scheduleBuffer(decoded, i, results.length);
        }
      } catch (e) {
        console.error("[TTS Offscreen] decode chunk", i, e);
        bufs.push(null);
      }
    }

    const playable = bufs.filter(Boolean);
    if (!playable.length) throw new Error("No playable audio generated");
    markServerOk();

  } catch (err) {
    if (err.name === "AbortError") { done(); return; }
    console.error("[TTS Offscreen] Pipeline error:", err);
    isSpeaking = false; resetPlayback(); markServerStale();
    errMsg(err.message || "Generation failed");
  }
}

async function decodeChunk(b64) {
  const str = atob(b64);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return getAudioContext().decodeAudioData(bytes.buffer.slice(0));
}

// ───── Message router ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  const t = request.type;

  if (t === "SPEAK") {
    // Try streaming batch first, fall back to regular batch on failure
    doSpeak(request.text, request.settings || {})
      .catch((err) => {
        console.warn("[TTS Offscreen] Streaming batch failed, falling back:", err);
        return doSpeakFallback(request.text, request.settings || {});
      });
    sendResponse({ started: true });
    return true;
  }
  if (t === "STOP") {
    isSpeaking = false; isPaused = false;
    resetPlayback(); done();
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