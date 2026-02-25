import io
import os
from contextlib import asynccontextmanager
from typing import List, Optional

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from mlx_audio.tts.utils import load_model
from pydantic import BaseModel, Field

MODEL_NAME = os.getenv(
    "QWEN_MLX_MODEL",
    "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit",
)
HOST = os.getenv("QWEN_TTS_HOST", "127.0.0.1")
PORT = int(os.getenv("QWEN_TTS_PORT", "8000"))
WARMUP_TEXT = os.getenv("QWEN_TTS_WARMUP_TEXT", "Warmup")

DEFAULT_VOICES = [
    "serena",
    "vivian",
    "uncle_fu",
    "dylan",
    "eric",
    "ryan",
    "aiden",
    "ono_anna",
    "sohee",
]

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


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=100000)
    voice: str = "vivian"
    speed: float = Field(1.0, ge=0.5, le=3.0)
    language: str = "Auto"
    instruct: Optional[str] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.model = None
    app.state.model_load_error = None
    app.state.model_name = MODEL_NAME

    print(f"Loading MLX TTS model: {MODEL_NAME}")
    try:
        app.state.model = load_model(MODEL_NAME)
        print("MLX model loaded successfully")

        # Warmup compile: removes most of the first-request lag.
        try:
            _ = next(
                app.state.model.generate(
                    text=WARMUP_TEXT,
                    voice="ryan",
                    speed=1.0,
                    lang_code="en",
                    verbose=False,
                    max_tokens=512,
                )
            )
            print("Warmup complete")
        except Exception as warmup_exc:
            print(f"Warmup skipped: {warmup_exc}")

    except Exception as exc:
        app.state.model_load_error = str(exc)
        print(f"Failed to load model: {exc}")

    yield


app = FastAPI(title="Qwen3-TTS MLX Local Server", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    model = app.state.model
    supported = []
    if model:
        try:
            supported = model.get_supported_speakers()
        except Exception:
            supported = DEFAULT_VOICES

    return {
        "status": "ok",
        "engine": "mlx-audio",
        "model": app.state.model_name,
        "model_loaded": model is not None,
        "load_error": app.state.model_load_error,
        "voices": supported,
    }


@app.get("/v1/voices")
async def get_voices():
    model = app.state.model
    if not model:
        return {
            "voices": [
                {"id": voice, "name": title_for_voice(voice), "language": "Multilingual"}
                for voice in DEFAULT_VOICES
            ]
        }

    try:
        speakers = model.get_supported_speakers()
    except Exception:
        speakers = DEFAULT_VOICES

    return {
        "voices": [
            {"id": speaker, "name": title_for_voice(speaker), "language": "Multilingual"}
            for speaker in speakers
        ]
    }


@app.post("/v1/synthesize")
async def synthesize(request: SynthesizeRequest):
    model = app.state.model
    if not model:
        raise HTTPException(
            status_code=503,
            detail=app.state.model_load_error or "Model is not loaded",
        )

    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    try:
        speakers = model.get_supported_speakers()
    except Exception:
        speakers = DEFAULT_VOICES

    speaker = normalize_voice(request.voice, speakers)
    lang_code = normalize_language(request.language)

    try:
        chunks = list(
            model.generate(
                text=text,
                voice=speaker,
                speed=float(request.speed),
                lang_code=lang_code,
                instruct=request.instruct,
                verbose=False,
                max_tokens=4096,
            )
        )

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
            "X-TTS-Engine": "mlx-audio",
            "X-TTS-Model": app.state.model_name,
            "X-TTS-Voice": speaker,
            "X-TTS-Lang": lang_code,
            "X-TTS-RTF": f"{getattr(first, 'real_time_factor', 0):.3f}",
        }
        return Response(content=buffer.read(), media_type="audio/wav", headers=headers)

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
