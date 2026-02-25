#!/bin/bash
# Setup script for Qwen3-TTS MLX Local Server
# This script creates a virtual environment and downloads the model

set -e

echo "================================================"
echo "  Qwen3-TTS MLX Local Server Setup"
echo "================================================"

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo ""
echo "[1/4] Checking Python version..."
if ! command -v python3.12 &> /dev/null; then
    echo "⚠️  Python 3.12 not found. Trying python3..."
    PYTHON_CMD="python3"
else
    PYTHON_CMD="python3.12"
fi

$PYTHON_CMD --version

echo ""
echo "[2/4] Creating virtual environment..."
if [ ! -d "venv" ]; then
    $PYTHON_CMD -m venv venv
    echo "✓ Virtual environment created"
else
    echo "✓ Virtual environment already exists"
fi

echo ""
echo "[3/4] Installing dependencies..."
source venv/bin/activate
pip install -U pip
pip install -r requirements.txt
echo "✓ Dependencies installed"

echo ""
echo "[4/4] Downloading Qwen3-TTS model (this may take a few minutes)..."
echo "Model: mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"
echo ""

# Pre-download the model by importing it
python3 -c "
from mlx_audio.tts.utils import load_model
print('Downloading model...')
model = load_model('mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit')
print('Model downloaded and cached!')
"

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
echo "Or use the launch agent for auto-start on login:"
echo "  ./install_launch_agent.sh"
echo ""