// Open TTS — Content Script (v2.3.0)
// Handles the "Speak" floating widget on selected text.
// Offscreen document lifecycle is managed by background.js —
// content scripts don't have access to chrome.offscreen API.

let widget = null;
let currentRunId = 0;
let isSpeaking = false;
let isPaused = false;
let savedSelection = "";  // Captured on mouseup, survives mousedown

const MAX_SELECTION_CHARS = 200000;

// ─── Helpers ─────────────────────────────────────────────────────

function removeLegacyWidget() {
  document.querySelectorAll("#qwen-tts-icon-container").forEach((n) => n.remove());
}
removeLegacyWidget();
new MutationObserver(() => removeLegacyWidget())
  .observe(document.documentElement || document.body, { childList: true, subtree: true });

// ─── Widget creation ─────────────────────────────────────────

function createWidget() {
  const container = document.createElement("div");
  container.id = "qwen-tts-widget";

  const btn = document.createElement("button");
  btn.id = "qwen-tts-button";
  btn.type = "button";
  btn.title = "Read selection aloud";

  const glyph = document.createElement("span");
  glyph.className = "qwen-glyph";
  glyph.innerHTML = `
    <span class="qwen-glyph-body"></span>
    <span class="qwen-glyph-cone"></span>
    <span class="qwen-glyph-wave wave1"></span>
    <span class="qwen-glyph-wave wave2"></span>
  `;
  btn.appendChild(glyph);

  const label = document.createElement("span");
  label.id = "qwen-tts-label";
  label.textContent = "Speak";
  container.appendChild(btn);
  container.appendChild(label);

  // CRITICAL FIX: prevent mousedown on the button from clearing the selection.
  // Without this, the browser deselects text on mousedown, so getSelection()
  // returns "" by the time click fires — and the speak button does nothing.
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, true);

  btn.addEventListener("click", onSpeakClick);
  document.body.appendChild(container);
  widget = container;
  return container;
}

function setLabel(text) {
  const label = widget?.querySelector("#qwen-tts-label");
  if (label) label.textContent = text;
}

function showWidgetAtSelection() {
  if (!widget) createWidget();
  // Use saved selection range to position widget — works even if
  // the user clicked the widget (which would have cleared getSelection)
  if (!_lastRect) return;
  const rect = _lastRect;
  const top = Math.max(window.scrollY + 8, window.scrollY + rect.top - 44);
  const left = Math.max(window.scrollX + 8, Math.min(
    window.scrollX + rect.left + rect.width / 2 - 48,
    window.scrollX + document.documentElement.clientWidth - 100
  ));
  widget.style.top = `${top}px`;
  widget.style.left = `${left}px`;
  widget.classList.add("visible");
}

function hideWidget() { widget?.classList.remove("visible"); savedSelection = ""; }
function setBusy(b, t) { widget?.classList.toggle("busy", b); setLabel(t || (b ? "Generating..." : "Speak")); }

function flashError(msg) {
  setLabel(msg);
  widget?.classList.add("error");
  setTimeout(() => { widget?.classList.remove("error"); setLabel("Speak"); }, 3000);
}

// ─── Speak / Pause / Resume / Stop ─────────────────────────
// All messages route through background.js, which owns the offscreen
// document lifecycle. We never touch chrome.offscreen directly.

function sendToBackground(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const err = chrome.runtime.lastError;
      if (err) { reject(new Error(err.message)); return; }
      resolve(response);
    });
  });
}

async function onSpeakClick(e) {
  e.preventDefault();
  e.stopPropagation();

  // Use saved selection — NOT window.getSelection() which may be empty
  // after mousedown on our own button cleared it.
  const text = savedSelection || window.getSelection()?.toString().trim() || "";
  if (!text) return;

  // Toggle off if already playing or pausing
  if (isSpeaking) {
    if (isPaused) {
      await sendToBackground({ type: "RESUME" }).catch(() => {});
      isPaused = false;
      widget?.classList.remove("paused");
      setBusy(true, "Reading... tap to stop");
      return;
    }
    // Actually playing — pause
    await sendToBackground({ type: "PAUSE" }).catch(() => {});
    isPaused = true;
    widget?.classList.add("paused");
    setBusy(true, "Paused — tap to resume");
    return;
  }

  // Full stop-reset
  currentRunId++;
  isSpeaking = true;
  isPaused = false;
  const runId = currentRunId;

  try {
    setBusy(true, "Generating...");

    const settings = await new Promise((resolve) => {
      chrome.storage.sync.get(["voice", "speed", "language", "model"], (data) => {
        resolve({
          voice: data.voice || "ryan",
          speed: Number(data.speed) || 1.0,
          language: data.language || "Auto",
          model: data.model || "qwen3-tts",
        });
      });
    });

    // background.js will ensure offscreen doc exists, then forward to offscreen.js
    await sendToBackground({
      type: "SPEAK",
      text: text.slice(0, MAX_SELECTION_CHARS),
      settings,
    });
  } catch (err) {
    if (runId !== currentRunId) return;
    console.error("[Open TTS] Speak error:", err);
    flashError(err.message || "Couldn't read. Tap again");
    isSpeaking = false;
    isPaused = false;
    setBusy(false, "Speak");
  }
}

// ─── STOP handler from popup ───────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "STOP_TTS") {
    currentRunId++;
    isSpeaking = false;
    isPaused = false;
    widget?.classList.remove("paused");
    setLabel("Speak");
    if (sendResponse) sendResponse({ stopped: true });
    return true;
  }
  if (msg.type === "TTS_STATUS") {
    setBusy(true, msg.label);
    return true;
  }
  if (msg.type === "TTS_ERROR") {
    isSpeaking = false;
    isPaused = false;
    flashError(msg.message || "Error");
    setBusy(false, "Speak");
    return true;
  }
  if (msg.type === "TTS_DONE") {
    isSpeaking = false;
    isPaused = false;
    setBusy(false, "Speak");
    return true;
  }
});

// ─── Selection events ──────────────────────────────────────

let _lastRect = null;

document.addEventListener("mouseup", () => {
  const sel = window.getSelection();
  const text = sel?.toString().trim();
  if (text) {
    savedSelection = text.slice(0, MAX_SELECTION_CHARS);
    if (sel.rangeCount > 0) {
      _lastRect = sel.getRangeAt(0).getBoundingClientRect();
    }
    showWidgetAtSelection();
  } else {
    setTimeout(() => {
      if (!window.getSelection()?.toString().trim()) hideWidget();
    }, 80);
  }
});

document.addEventListener("mousedown", (e) => {
  // Don't hide if clicking our own widget — mousedown is already prevented on the button
  if (widget && widget.contains(e.target)) return;
  hideWidget();
});