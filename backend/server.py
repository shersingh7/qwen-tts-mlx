import io
import os
import time
from contextlib import asynccontextmanager
from typing import Dict, List, Optional

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from mlx_audio.tts.utils import load_model
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

HOST = os.getenv("OPEN_TTS_HOST", "127.0.0.1")
PORT = int(os.getenv("OPEN_TTS_PORT", "8000"))
WARMUP_TEXT = os.getenv("OPEN_TTS_WARMUP_TEXT", "Warmup")
# Which model to load at startup (default = first entry in MODEL_REGISTRY)
DEFAULT_MODEL_ID = os.getenv("OPEN_TTS_DEFAULT_MODEL", "qwen3-tts")

# ---------------------------------------------------------------------------
# Model registry — each model's metadata in one place
# ---------------------------------------------------------------------------

MODEL_REGISTRY: Dict[str, dict] = {
    "qwen3-tts": {
        "hf_id": "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit",
        "local_dir": "models/qwen3-tts-8bit",
        "display_name": "Qwen3-TTS 1.7B",
        "description": "Fast multilingual TTS with preset voices",
        "tier": 1,
        "default_voice": "ryan",
        "supports_lang_code": True,
        "supports_instruct": True,
        "supports_ref_audio": True,
        "has_preset_voices": True,
        "default_voices": [
            "serena", "vivian", "uncle_fu", "dylan",
            "eric", "ryan", "aiden", "ono_anna", "sohee",
        ],
    },
    "fish-s2-pro": {
        "hf_id": "mlx-community/fish-audio-s2-pro-8bit",
        "local_dir": "models/fish-audio-s2-pro-8bit",
        "display_name": "Fish Audio S2 Pro",
        "description": "High-quality multilingual TTS with voice cloning",
        "tier": 1,
        "default_voice": None,  # Fish uses ref_audio, no preset voices
        "supports_lang_code": False,
        "supports_instruct": True,
        "supports_ref_audio": True,
        "has_preset_voices": False,
        "default_voices": [],  # Fish has no preset voices — uses ref_audio
    },
}

# Fish S2 Pro SSML-style tags that can be used in text for fine control
FISH_VOICE_TAGS = [
    "pause", "emphasis", "laughing", "inhale", "chuckle", "tsk",
    "singing", "excited", "volume up", "echo", "angry", "whisper",
    "screaming", "sad", "shocked", "pitch up", "pitch down",
    "professional broadcast tone",
]

# ---------------------------------------------------------------------------
# Voice metadata
# ---------------------------------------------------------------------------

VOICE_LABELS = {
    "serena": "Serena",
    "vivian": "Vivian",
    "uncle_fu": "Uncle Fu",
    "dylan": "Dylan",
    "eric": "Eric",
    "ryan": "Ryan",
    "aiden": "Aiden",
    "ono_anna": "Ono Anna",
    "sohee": "Sohee",
}

VOICE_ALIASES = {
    "uncle fu": "uncle_fu",
    "uncle_fu": "uncle_fu",
    "ono anna": "ono_anna",
    "ono_anna": "ono_anna",
}

LANG_ALIASES = {
    "auto": "auto",
    "english": "en",
    "en": "en",
    "chinese": "zh",
    "zh": "zh",
    "japanese": "ja",
    "ja": "ja",
    "korean": "ko",
    "ko": "ko",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def normalize_voice(voice: str, supported_voices: List[str]) -> str:
    raw = (voice or "").strip().lower()
    normalized = VOICE_ALIASES.get(raw, raw.replace(" ", "_"))

    if normalized in supported_voices:
        return normalized

    if raw in [v.lower() for v in supported_voices]:
        return raw

    raise HTTPException(
        status_code=400,
        detail=f"Unsupported voice '{voice}'. Try one of: {', '.join(supported_voices)}",
    )


def normalize_language(language: str) -> str:
    raw = (language or "auto").strip().lower()
    if not raw:
        return "auto"
    return LANG_ALIASES.get(raw, "auto")


def title_for_voice(voice_id: str) -> str:
    return VOICE_LABELS.get(voice_id, voice_id.replace("_", " ").title())


def get_model_voices(model_obj, model_id: str) -> List[str]:
    """Resolve supported voices for a loaded model."""
    reg = MODEL_REGISTRY.get(model_id, {})
    if reg.get("has_preset_voices") and hasattr(model_obj, "get_supported_speakers"):
        try:
            return model_obj.get_supported_speakers()
        except Exception:
            pass
    return reg.get("default_voices", [])


# ---------------------------------------------------------------------------
# Model manager — lazy loading with swap
# ---------------------------------------------------------------------------

class ModelManager:
    """Manages TTS model lifecycle: load on demand, swap to free memory."""

    def __init__(self):
        self.loaded_model = None       # The actual MLX model object
        self.loaded_model_id: Optional[str] = None
        self.load_error: Optional[str] = None
        self._loading = False
        self._lock_time = 0

    def is_loaded(self, model_id: str) -> bool:
        return self.loaded_model is not None and self.loaded_model_id == model_id

    def get_or_load(self, model_id: str):
        """Return the model for *model_id*, loading/unloading as needed."""
        if self._loading:
            raise HTTPException(status_code=503, detail="Model is currently loading, please retry")

        if self.is_loaded(model_id):
            return self.loaded_model

        reg = MODEL_REGISTRY.get(model_id)
        if not reg:
            raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")

        # Unload previous model to free VRAM
        if self.loaded_model is not None:
            print(f"Unloading model: {self.loaded_model_id}")
            del self.loaded_model
            self.loaded_model = None
            self.loaded_model_id = None

        # Resolve model path — local dir first, then HF hub ID
        model_path = reg["local_dir"]
        if not os.path.isdir(model_path):
            model_path = reg["hf_id"]

        self._loading = True
        self._lock_time = time.time()
        try:
            print(f"Loading model: {model_id} from {model_path}")
            self.loaded_model = load_model(model_path)
            self.loaded_model_id = model_id
            self.load_error = None

            # Warmup: removes first-request compile lag
            try:
                warmup_kwargs = dict(
                    text=WARMUP_TEXT,
                    speed=1.0,
                    verbose=False,
                    max_tokens=512,
                )
                # Qwen needs voice + lang_code; Fish needs neither for basic generation
                if reg.get("has_preset_voices"):
                    warmup_kwargs["voice"] = reg.get("default_voices", ["ryan"])[0]
                    warmup_kwargs["lang_code"] = "en"
                _ = next(self.loaded_model.generate(**warmup_kwargs))
                print(f"Warmup complete for {model_id}")
            except Exception as warmup_exc:
                print(f"Warmup skipped for {model_id}: {warmup_exc}")

            return self.loaded_model

        except Exception as exc:
            self.load_error = str(exc)
            print(f"Failed to load model {model_id}: {exc}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to load model {model_id}: {exc}",
            )
        finally:
            self._loading = False


manager = ModelManager()


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=100000)
    voice: str = "ryan"
    speed: float = Field(1.0, ge=0.5, le=3.0)
    language: str = "Auto"
    instruct: Optional[str] = None
    model: Optional[str] = None   # Model ID from registry; None = use default


# ---------------------------------------------------------------------------
# App lifespan — eagerly load the default model
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Eagerly load the default model at startup
    try:
        manager.get_or_load(DEFAULT_MODEL_ID)
    except HTTPException:
        pass  # Error stored in manager.load_error

    yield

    # Cleanup
    if manager.loaded_model is not None:
        del manager.loaded_model


app = FastAPI(title="Open TTS Server", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    model = manager.loaded_model
    model_id = manager.loaded_model_id
    supported = get_model_voices(model, model_id) if model else []

    return {
        "status": "ok",
        "engine": "open-tts",
        "model": model_id or DEFAULT_MODEL_ID,
        "model_loaded": model is not None,
        "load_error": manager.load_error,
        "voices": supported,
    }


@app.get("/v1/models")
async def list_models():
    """List all available TTS models and their capabilities."""
    models = []
    for mid, reg in MODEL_REGISTRY.items():
        voices = []
        if manager.is_loaded(mid):
            voices = get_model_voices(manager.loaded_model, mid)
        elif reg.get("default_voices"):
            voices = reg["default_voices"]

        models.append({
            "id": mid,
            "name": reg["display_name"],
            "description": reg["description"],
            "loaded": manager.is_loaded(mid),
            "active": manager.loaded_model_id == mid,
            "supports_lang_code": reg.get("supports_lang_code", False),
            "supports_ref_audio": reg.get("supports_ref_audio", False),
            "voices": [
                {"id": v, "name": title_for_voice(v), "language": "Multilingual"}
                for v in voices
            ],
        })

    return {"models": models}


@app.get("/v1/voices")
async def get_voices():
    """Get voices for the currently loaded model."""
    model = manager.loaded_model
    model_id = manager.loaded_model_id

    if not model or not model_id:
        # Return Qwen3 default voices as fallback
        return {
            "model": None,
            "voices": [
                {"id": v, "name": title_for_voice(v), "language": "Multilingual"}
                for v in MODEL_REGISTRY["qwen3-tts"]["default_voices"]
            ],
        }

    voices = get_model_voices(model, model_id)

    # For Fish S2 Pro, list available SSML tags as "virtual voices"
    reg = MODEL_REGISTRY.get(model_id, {})
    if not reg.get("has_preset_voices") and not voices:
        voices = FISH_VOICE_TAGS

    return {
        "model": model_id,
        "voices": [
            {"id": v, "name": title_for_voice(v), "language": "Multilingual"}
            for v in voices
        ],
    }


@app.post("/v1/load-model")
async def load_model_endpoint(model_id: str = DEFAULT_MODEL_ID):
    """Explicitly load/switch a model. Needed for model swap."""
    if model_id not in MODEL_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")

    try:
        manager.get_or_load(model_id)
        voices = get_model_voices(manager.loaded_model, model_id)
        return {
            "success": True,
            "model": model_id,
            "name": MODEL_REGISTRY[model_id]["display_name"],
            "voices": voices,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/v1/synthesize")
async def synthesize(request: SynthesizeRequest):
    model_id = request.model or DEFAULT_MODEL_ID

    if model_id not in MODEL_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")

    try:
        model = manager.get_or_load(model_id)
    except HTTPException:
        raise

    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    reg = MODEL_REGISTRY.get(model_id, {})
    voices = get_model_voices(model, model_id)

    # Build generation kwargs per model type
    gen_kwargs = dict(
        text=text,
        speed=float(request.speed),
        verbose=False,
        max_tokens=4096,
    )

    # Qwen3-TTS: uses preset voices + lang_code
    if reg.get("has_preset_voices"):
        speaker = normalize_voice(request.voice, voices) if voices else request.voice
        gen_kwargs["voice"] = speaker
        if reg.get("supports_lang_code"):
            gen_kwargs["lang_code"] = normalize_language(request.language)
        if request.instruct and reg.get("supports_instruct"):
            gen_kwargs["instruct"] = request.instruct

    # Fish S2 Pro: no preset voices, uses ref_audio for voice cloning
    else:
        # Pass voice param through — Fish uses it as a hint
        # For proper voice cloning, client should send ref_audio (future)
        if request.voice and voices:
            # If user picked an SSML tag as "voice", inject it as instruct
            if request.voice in FISH_VOICE_TAGS:
                text = f"[{request.voice}] {text}"
                gen_kwargs["text"] = text
        if request.instruct:
            gen_kwargs["instruct"] = request.instruct

    try:
        chunks = list(model.generate(**gen_kwargs))

        if not chunks:
            raise HTTPException(status_code=500, detail="No audio generated")

        sample_rate = chunks[0].sample_rate
        audio_parts = [np.asarray(chunk.audio, dtype=np.float32) for chunk in chunks]
        audio = np.concatenate(audio_parts, axis=0) if len(audio_parts) > 1 else audio_parts[0]

        buffer = io.BytesIO()
        sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
        buffer.seek(0)

        first = chunks[0]
        headers = {
            "X-TTS-Engine": "open-tts",
            "X-TTS-Model": model_id,
            "X-TTS-Voice": request.voice,
            "X-TTS-Lang": gen_kwargs.get("lang_code", "auto"),
            "X-TTS-RTF": f"{getattr(first, 'real_time_factor', 0):.3f}",
        }
        return Response(content=buffer.read(), media_type="audio/wav", headers=headers)

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)