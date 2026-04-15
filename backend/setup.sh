#!/bin/bash
# Setup script for Open TTS Server
# This script creates a virtual environment and downloads both models

set -e

echo "================================================"
echo "  Open TTS Server Setup"
echo "================================================"

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo ""
echo "[1/5] Checking Python version..."
if ! command -v python3.12 &> /dev/null; then
    echo "⚠️  Python 3.12 not found. Trying python3..."
    PYTHON_CMD="python3"
else
    PYTHON_CMD="python3.12"
fi

$PYTHON_CMD --version

echo ""
echo "[2/5] Creating virtual environment..."
if [ ! -d "venv" ]; then
    $PYTHON_CMD -m venv venv
    echo "✓ Virtual environment created"
else
    echo "✓ Virtual environment already exists"
fi

echo ""
echo "[3/5] Installing dependencies..."
source venv/bin/activate
pip install -U pip
pip install -r requirements.txt
echo "✓ Dependencies installed"

echo ""
echo "[4/5] Downloading Qwen3-TTS model (2.9 GB, 8-bit MLX)..."
echo "Model: mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"
echo ""
hf download mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit \
    --local-dir ./models/qwen3-tts-8bit
echo "✓ Qwen3-TTS downloaded"

echo ""
echo "[5/5] Downloading Fish Audio S2 Pro model (6.3 GB, 8-bit MLX)..."
echo "Model: mlx-community/fish-audio-s2-pro-8bit"
echo ""
hf download mlx-community/fish-audio-s2-pro-8bit \
    --local-dir ./models/fish-audio-s2-pro-8bit
echo "✓ Fish Audio S2 Pro downloaded"

echo ""
echo "================================================"
echo "  ✓ Setup Complete!"
echo "================================================"
echo ""
echo "To start the server:"
echo "  cd $SCRIPT_DIR"
echo "  source venv/bin/activate"
echo "  python server.py"
echo ""
echo "Or use the Chrome extension to start/stop the server."