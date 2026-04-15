# Open TTS

> Apple Silicon Only — This project uses MLX, which requires an M1/M2/M3/M4 Mac. Not compatible with Intel Macs, Windows, or Linux.

Multi-model, fully local text-to-speech on Apple Silicon. Switch between Qwen3-TTS and Fish Audio S2 Pro — both running MLX-optimized inference with zero cloud calls.

## Features

- **Multi-Model** — Switch between Qwen3-TTS and Fish Audio S2 Pro on the fly
- **Fast** — MLX-optimized for Apple Silicon (M1/M2/M3/M4)
- **Private** — All processing happens locally, no cloud API
- **Model Swap** — One model in VRAM at a time; swap on demand from the extension
- **Multiple Voices** — 9 built-in voices for Qwen3 (Serena, Vivian, Ryan, etc.), SSML voices for Fish S2 Pro
- **Multilingual** — English, Chinese, Japanese, Korean, and auto-detect (Qwen3)
- **Chrome Extension** — Select text on any page and click to hear it
- **Server Control** — Start/Stop server directly from the extension popup

## Models

| Model | Size | Sample Rate | Voices | Strengths |
|-------|------|-------------|--------|-----------|
| Qwen3-TTS (8-bit) | 2.9 GB | 24 kHz | 9 preset + instruct | Multilingual, fast |
| Fish S2 Pro (8-bit) | 6.3 GB | 44.1 kHz | SSML voice tags | High-fidelity, voice cloning ready |

Only one model is loaded at a time. Swap instantly from the extension or API.

## Requirements

- Mac with Apple Silicon (M1/M2/M3/M4)
- macOS 14.0+ (Sonoma or later)
- Python 3.12
- ~10 GB disk space for both models (or ~4 GB for one)

## Quick Start

### 1. Setup (one-time)

```bash
cd backend
chmod +x setup.sh
./setup.sh
```

This will:
- Create a Python virtual environment
- Install dependencies (mlx-audio >= 0.4.2)
- Download both models (Qwen3-TTS 8-bit + Fish S2 Pro 8-bit)

### 2. Install Chrome Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `extension` folder

### 3. Install Native Messaging Host (required for Start/Stop buttons)

```bash
cd backend
./install_native_host.sh
```

When prompted, enter your Chrome extension ID (visible on `chrome://extensions/` page).

**To uninstall:**
```bash
./uninstall_native_host.sh
```

### 4. Use It

1. Click the extension icon in Chrome
2. Select your **model** (Qwen3-TTS or Fish S2 Pro)
3. Click **"▶ Start Server"** — wait for "Server running" status
4. Select any text on any webpage and click the speaker icon to hear it
5. Click **"⏹ Stop Server"** when done

**That's it!** No need to run any terminal commands.

---

<details>
<summary>Manual Server Start (Alternative)</summary>

If you prefer running the server manually from the terminal:

```bash
cd backend
source venv/bin/activate
python server.py
```

The server will start at `http://127.0.0.1:5020`

</details>

### Settings

Click the extension icon to:
- **Select model** — Qwen3-TTS or Fish S2 Pro (auto-swaps on demand)
- **Select voice** — 9 preset voices for Qwen3, SSML voices for Fish
- **Select language** — Auto, English, Chinese, Japanese, Korean (Qwen3 only)
- **Adjust speed** — 0.5x - 3.0x

## Auto-Start on Login (macOS)

```bash
cd backend
./install_launch_agent.sh
```

To uninstall:
```bash
./uninstall_launch_agent.sh
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Server health and loaded model status |
| `/v1/models` | GET | List available models |
| `/v1/voices` | GET | List voices for current or specified model |
| `/v1/load-model` | POST | Swap the active model |
| `/v1/synthesize` | POST | Synthesize speech |

### Example: List Models

```bash
curl http://127.0.0.1:5020/v1/models
```

### Example: Swap Model

```bash
curl -X POST http://127.0.0.1:5020/v1/load-model \
  -H "Content-Type: application/json" \
  -d '{"model": "fish-s2-pro"}'
```

### Example: Synthesize Speech

```bash
# Qwen3-TTS with preset voice
curl -X POST http://127.0.0.1:5020/v1/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is a test.", "model": "qwen3-tts", "voice": "ryan", "speed": 1.0}' \
  --output output.wav

# Fish S2 Pro with SSML voice
curl -X POST http://127.0.0.1:5020/v1/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is a test.", "model": "fish-s2-pro", "voice": "default"}' \
  --output output.wav
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPEN_TTS_DEFAULT_MODEL` | `qwen3-tts` | Model to load at startup |
| `OPEN_TTS_HOST` | `127.0.0.1` | Server host |
| `OPEN_TTS_PORT` | `5020` | Server port |

## Project Structure

```
backend/
  server.py           # FastAPI server (multi-model, lazy loading)
  native_host.py      # Native messaging host for extension
  requirements.txt    # Python dependencies
  setup.sh            # Setup script (downloads both models)
  models/             # Downloaded model files
    qwen3-tts-8bit/
    fish-speech-s2-pro-8bit/
  install_native_host.sh   # Install native host for Start/Stop buttons
  install_launch_agent.sh  # Auto-start on login
extension/
  manifest.json       # Chrome extension config (Open TTS v2.0.0)
  background.js       # Service worker (model management)
  content.js          # Content script (page interaction)
  popup.html/js/css   # Extension popup with model selector
```

## How It Works

1. **Extension** detects text selection on any page
2. **Background script** sends request with selected model to local server
3. **Server** lazy-loads the requested model (swaps if different from current)
4. **MLX** runs inference on Apple Silicon — Qwen3 or Fish S2 Pro
5. **Audio** is generated and played in the browser

For the Start/Stop Server feature:
1. **Extension** sends command to native messaging host
2. **Native host** (Python script) starts/stops the server process
3. **Extension** polls health endpoint to confirm server status

## Troubleshooting

### Server won't start
```bash
# Check if port is in use
lsof -i :5020

# Kill existing process
kill -9 <PID>
```

### Native messaging error
If you see "Native messaging error" when clicking Start/Stop:
1. Make sure you ran `./install_native_host.sh`
2. Make sure you entered the correct extension ID
3. Reload the extension in `chrome://extensions/`

### Model fails to download
- Check internet connection
- Try manual download:
  ```bash
  pip install huggingface-hub
  huggingface-cli download mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit --local-dir backend/models/qwen3-tts-8bit
  huggingface-cli download mlx-community/fish-audio-s2-pro-8bit --local-dir backend/models/fish-speech-s2-pro-8bit
  ```

### Extension shows "Disconnected"
- Make sure the server is running
- Check `http://127.0.0.1:5020/health` in browser

## Credits

- Models: [Qwen3-TTS](https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit), [Fish Audio S2 Pro](https://huggingface.co/mlx-community/fish-audio-s2-pro-8bit)
- Framework: [MLX Audio](https://github.com/Blaizzy/mlx-audio)

## License

MIT License — Use freely for personal or commercial projects.

---

Created by [shersingh7](https://github.com/shersingh7) | Vibe coded with AI assistance