let widget = null;
let currentAudio = null;
let selectedText = "";
let speakRunId = 0;
let isSpeaking = false;
let isPaused = false;

const MAX_SELECTION_CHARS = 200000;
const CHUNK_TARGET_CHARS = 320;

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
  }, 2200);
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

async function requestChunkAudio(text, settings) {
  const response = await chrome.runtime.sendMessage({
    type: "TTS_REQUEST",
    text,
    voice: settings.voice || "ryan",
    // Keep model synthesis at 1.0x; browser playbackRate gives exact user speed.
    speed: 1.0,
    language: settings.language || "Auto",
  });

  if (!response?.success) {
    throw new Error(response?.error || "Unknown TTS error");
  }

  return response.audioData;
}

function playAudioData(audioData, runId, playbackRate) {
  return new Promise(async (resolve, reject) => {
    try {
      if (runId !== speakRunId) return resolve();
      stopAudio();
      currentAudio = new Audio(audioData);
      currentAudio.playbackRate = Math.max(0.5, Math.min(3.0, Number(playbackRate) || 1.0));
      currentAudio.onended = () => resolve();
      currentAudio.onerror = () => reject(new Error("Audio playback failed"));
      await currentAudio.play();
    } catch (err) {
      reject(err);
    }
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

  try {
    setBusy(true, "Preparing…");

    const settings = await chrome.storage.sync.get(["voice", "speed", "language"]);
    const playbackRate = Number(settings.speed) || 1.0;
    const chunks = splitTextForTTS(text, CHUNK_TARGET_CHARS);

    if (!chunks.length) throw new Error("Nothing to read");

    let idx = 0;
    let nextAudioPromise = requestChunkAudio(chunks[0], settings);

    while (idx < chunks.length) {
      if (runId !== speakRunId) return;

      setBusy(true, `Reading ${idx + 1}/${chunks.length}… tap to pause`);
      const audioData = await nextAudioPromise;

      if (idx + 1 < chunks.length) {
        // Start generating next chunk while current chunk is playing.
        nextAudioPromise = requestChunkAudio(chunks[idx + 1], settings);
      } else {
        nextAudioPromise = null;
      }

      await playAudioData(audioData, runId, playbackRate);
      idx += 1;
    }

    if (runId === speakRunId) {
      setBusy(false, "Speak");
    }
  } catch (error) {
    if (runId === speakRunId) {
      setBusy(false);
      flashError("Couldn’t read. Tap again");
    }
    console.error("Qwen MLX TTS error:", error);
  } finally {
    if (runId === speakRunId) {
      isSpeaking = false;
      isPaused = false;
      widget?.classList.remove("paused");
    }
  }
}
