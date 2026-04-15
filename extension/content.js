let widget = null;
let currentAudio = null;
let selectedText = "";
let speakRunId = 0;
let isSpeaking = false;
let isPaused = false;

const MAX_SELECTION_CHARS = 200000;
// Optimal chunk size for M2 Pro: ~500 chars = ~8-10 seconds of audio
const CHUNK_TARGET_CHARS = 500;
// Number of chunks to pre-generate ahead while playing
const PREFETCH_COUNT = 2;
// Minimum chunks ready before playback starts
const MIN_BUFFER_BEFORE_PLAY = 2;

function removeLegacyWidget() {
  document.querySelectorAll("#qwen-tts-icon-container").forEach((node) => node.remove());
}

removeLegacyWidget();
const legacyObserver = new MutationObserver(() => removeLegacyWidget());
legacyObserver.observe(document.documentElement || document.body, {
  childList: true,
  subtree: true,
});

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
  if (!widget) return;
  const label = widget.querySelector("#qwen-tts-label");
  if (label) label.textContent = text;
}

function showWidgetAtSelection(text) {
  selectedText = text;

  if (!widget) createWidget();

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  const rect = selection.getRangeAt(0).getBoundingClientRect();
  const top = window.scrollY + rect.top - 44;
  const left = window.scrollX + rect.left + rect.width / 2 - 48;

  const maxLeft = window.scrollX + document.documentElement.clientWidth - 100;
  const safeTop = Math.max(window.scrollY + 8, top);
  const safeLeft = Math.max(window.scrollX + 8, Math.min(left, maxLeft));

  widget.style.top = `${safeTop}px`;
  widget.style.left = `${safeLeft}px`;
  widget.classList.add("visible");
}

function hideWidget() {
  if (widget) widget.classList.remove("visible");
}

function setBusy(busy, labelText = null) {
  if (!widget) return;
  widget.classList.toggle("busy", busy);
  if (labelText) {
    setLabel(labelText);
  } else {
    setLabel(busy ? "Generating…" : "Speak");
  }
}

function flashError(message) {
  if (!widget) return;
  setLabel(message);
  widget.classList.add("error");
  setTimeout(() => {
    widget.classList.remove("error");
    setLabel("Speak");
  }, 3000);
}

function stopAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = "";
    currentAudio = null;
  }
}

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
  const sentences = cleaned.split(/(?<=[.!?])\s+/);
  let current = "";

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) out.push(trimmed);
    current = "";
  };

  for (const sentence of sentences) {
    if (!sentence) continue;

    if (sentence.length > maxChars) {
      if (current) pushCurrent();
      const words = sentence.split(" ");
      let longChunk = "";
      for (const word of words) {
        const candidate = longChunk ? `${longChunk} ${word}` : word;
        if (candidate.length > maxChars && longChunk) {
          out.push(longChunk.trim());
          longChunk = word;
        } else {
          longChunk = candidate;
        }
      }
      if (longChunk.trim()) out.push(longChunk.trim());
      continue;
    }

    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxChars) {
      pushCurrent();
      current = sentence;
    } else {
      current = candidate;
    }
  }

  if (current) pushCurrent();
  return out;
}

/**
 * AudioBuffer: Manages audio chunks with HTMLAudioElement for pitch-preserving playback
 */
class AudioBufferQueue {
  constructor() {
    this.audioBuffers = new Map(); // chunkIndex -> audioData URL
    this.pendingRequests = new Map(); // chunkIndex -> Promise
    this.isStopped = false;
  }

  // Check if a chunk is ready for playback
  isReady(chunkIndex) {
    return this.audioBuffers.has(chunkIndex);
  }

  // Check if a chunk is currently being generated
  isPending(chunkIndex) {
    return this.pendingRequests.has(chunkIndex);
  }

  // Get audio data for a chunk (must be ready)
  getAudioData(chunkIndex) {
    return this.audioBuffers.get(chunkIndex);
  }

  // Start generating a chunk (returns promise that resolves when ready)
  async generateChunk(chunkIndex, text, settings) {
    // Already ready
    if (this.audioBuffers.has(chunkIndex)) {
      return this.audioBuffers.get(chunkIndex);
    }

    // Already being generated
    if (this.pendingRequests.has(chunkIndex)) {
      return this.pendingRequests.get(chunkIndex);
    }

    // Start new generation
    const promise = (async () => {
      try {
        console.log(`[Qwen TTS] Generating chunk ${chunkIndex}, voice: ${settings.voice || "ryan"}`);
        const audioData = await requestChunkAudio(text, settings);
        if (this.isStopped) return null;

        this.audioBuffers.set(chunkIndex, audioData);
        return audioData;
      } catch (error) {
        console.error(`[Qwen TTS] Error generating chunk ${chunkIndex}:`, error);
        throw error;
      } finally {
        this.pendingRequests.delete(chunkIndex);
      }
    })();

    this.pendingRequests.set(chunkIndex, promise);
    return promise;
  }

  // Clean up old buffers to free memory
  cleanup(keepFromIndex) {
    for (const [idx] of this.audioBuffers) {
      if (idx < keepFromIndex) {
        this.audioBuffers.delete(idx);
      }
    }
  }

  stop() {
    this.isStopped = true;
    this.pendingRequests.clear();
    this.audioBuffers.clear();
  }
}

async function requestChunkAudio(text, settings) {
  console.log("[Open TTS] Requesting audio:", {
    model: settings.model || "qwen3-tts",
    voice: settings.voice || "ryan",
    textLength: text.length,
  });

  const response = await chrome.runtime.sendMessage({
    type: "TTS_REQUEST",
    text,
    voice: settings.voice || "ryan",
    speed: 1.0,
    language: settings.language || "Auto",
    model: settings.model || "qwen3-tts",
  });

  if (!response?.success) {
    const errorMsg = response?.error || "Unknown TTS error";
    if (response?.serverDown) {
      throw new Error("Server not running. Run: cd ~/github/qwen-tts-mlx/backend && ./venv/bin/python server.py");
    }
    throw new Error(errorMsg);
  }

  return response.audioData;
}

// Play audio using HTMLAudioElement (preserves pitch when changing speed)
function playAudioData(audioData, runId, playbackRate) {
  return new Promise((resolve, reject) => {
    if (runId !== speakRunId) return resolve();
    stopAudio();

    currentAudio = new Audio(audioData);
    // HTMLAudioElement playbackRate preserves pitch (unlike Web Audio API)
    currentAudio.playbackRate = Math.max(0.5, Math.min(3.0, playbackRate));
    currentAudio.preservesPitch = true;

    currentAudio.onended = () => resolve();
    currentAudio.onerror = (e) => reject(new Error(`Audio playback failed: ${e.message || "unknown error"}`));

    currentAudio.play().catch(reject);
  });
}

document.addEventListener("mouseup", () => {
  const text = window.getSelection()?.toString().trim();
  if (text) {
    showWidgetAtSelection(text.slice(0, MAX_SELECTION_CHARS));
  } else {
    setTimeout(() => {
      if (!window.getSelection()?.toString().trim()) hideWidget();
    }, 80);
  }
});

document.addEventListener("mousedown", (event) => {
  if (!widget) return;
  if (!widget.contains(event.target)) hideWidget();
});

async function onSpeakClick(event) {
  event.preventDefault();
  event.stopPropagation();

  const text = selectedText?.trim();
  if (!text) return;

  // Handle pause/resume for existing playback
  if (isSpeaking) {
    if (currentAudio && !currentAudio.paused && !isPaused) {
      currentAudio.pause();
      isPaused = true;
      widget?.classList.add("paused");
      setBusy(true, "Paused · tap to resume");
      return;
    }

    if (currentAudio && isPaused) {
      await currentAudio.play();
      isPaused = false;
      widget?.classList.remove("paused");
      setBusy(true, "Reading… tap to pause");
      return;
    }

    // If generation is running but no active audio yet, stop the run.
    speakRunId += 1;
    isSpeaking = false;
    isPaused = false;
    widget?.classList.remove("paused");
    stopAudio();
    setBusy(false, "Stopped");
    return;
  }

  const runId = ++speakRunId;
  isSpeaking = true;
  isPaused = false;
  widget?.classList.remove("paused");

  let audioQueue = null;

  try {
    setBusy(true, "Preparing…");

    const settings = await chrome.storage.sync.get(["voice", "speed", "language", "model"]);
    const playbackRate = Number(settings.speed) || 1.0;

    console.log("[Qwen TTS] Settings from storage:", settings);
    console.log("[Qwen TTS] Using voice:", settings.voice || "ryan", "speed:", playbackRate);

    const chunks = splitTextForTTS(text, CHUNK_TARGET_CHARS);

    if (!chunks.length) throw new Error("Nothing to read");

    console.log(`[Qwen TTS] Split into ${chunks.length} chunks`);

    // Initialize audio buffer queue
    audioQueue = new AudioBufferQueue();

    // Pre-generate initial buffer before playing
    const initialBufferCount = Math.min(MIN_BUFFER_BEFORE_PLAY, chunks.length);
    setBusy(true, `Buffering ${initialBufferCount} of ${chunks.length} chunks…`);

    // Start generating initial chunks in parallel
    const initialPromises = [];
    for (let i = 0; i < initialBufferCount; i++) {
      initialPromises.push(audioQueue.generateChunk(i, chunks[i], settings));
    }

    // Wait for initial buffer to be ready
    try {
      await Promise.all(initialPromises);
    } catch (error) {
      console.error("[Qwen TTS] Error generating initial chunks:", error);
      throw error;
    }

    if (runId !== speakRunId || audioQueue.isStopped) return;

    // Begin playback
    let currentIndex = 0;

    // Main playback loop
    while (currentIndex < chunks.length && !audioQueue.isStopped && runId === speakRunId) {
      // Start generating next chunks ahead of time
      for (let ahead = 1; ahead <= PREFETCH_COUNT; ahead++) {
        const futureIdx = currentIndex + ahead;
        if (futureIdx < chunks.length && !audioQueue.isReady(futureIdx) && !audioQueue.isPending(futureIdx)) {
          audioQueue.generateChunk(futureIdx, chunks[futureIdx], settings);
        }
      }

      // Wait for current chunk if not ready yet
      if (!audioQueue.isReady(currentIndex)) {
        setBusy(true, `Reading ${currentIndex + 1}/${chunks.length}… buffering`);
        try {
          await audioQueue.generateChunk(currentIndex, chunks[currentIndex], settings);
        } catch (error) {
          console.error(`[Qwen TTS] Error generating chunk ${currentIndex}:`, error);
          throw error;
        }
      }

      if (audioQueue.isStopped || runId !== speakRunId) break;

      setBusy(true, `Reading ${currentIndex + 1}/${chunks.length}… tap to pause`);

      // Play current chunk
      const audioData = audioQueue.getAudioData(currentIndex);
      try {
        await playAudioData(audioData, runId, playbackRate);
      } catch (error) {
        console.error(`[Qwen TTS] Error playing chunk ${currentIndex}:`, error);
        throw error;
      }

      // Move to next
      currentIndex++;

      // Clean up old buffers
      audioQueue.cleanup(currentIndex);
    }

    if (runId === speakRunId && !audioQueue.isStopped) {
      setBusy(false, "Speak");
    }
  } catch (error) {
    console.error("[Qwen TTS] Error:", error);
    if (runId === speakRunId) {
      setBusy(false);
      const errorMsg = error?.message || "Couldn't read. Tap again";
      flashError(errorMsg);
    }
  } finally {
    if (runId === speakRunId) {
      isSpeaking = false;
      isPaused = false;
      widget?.classList.remove("paused");
    }
    if (audioQueue) {
      audioQueue.stop();
    }
  }
}