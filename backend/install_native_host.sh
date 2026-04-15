#!/bin/bash
# Install the native messaging host for Chrome/Chromium

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
NATIVE_HOST_NAME="com.open_tts.native_host"
NATIVE_HOST_SCRIPT="$SCRIPT_DIR/native_host.py"
MANIFEST_TEMPLATE="$SCRIPT_DIR/com.open_tts.native_host.json"

echo "=== Open TTS Native Host Installer ==="
echo ""

# Get extension ID from user
echo "Enter your Chrome extension ID (from chrome://extensions/):"
echo "(Enable 'Developer mode' to see the ID)"
read -r EXTENSION_ID

if [ -z "$EXTENSION_ID" ]; then
    echo "Error: Extension ID is required"
    exit 1
fi

# Determine Chrome native messaging host directory
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    CHROMIUM_HOST_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
elif [[ "$OSTYPE" == "linux"* ]]; then
    # Linux
    HOST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    CHROMIUM_HOST_DIR="$HOME/.config/chromium/NativeMessagingHosts"
else
    echo "Error: Unsupported OS: $OSTYPE"
    exit 1
fi

# Create directories if they don't exist
mkdir -p "$HOST_DIR"

# Create the manifest with proper paths
MANIFEST_CONTENT=$(cat "$MANIFEST_TEMPLATE" | \
    sed "s|__PATH__|$NATIVE_HOST_SCRIPT|g" | \
    sed "s|__EXTENSION_ID__|$EXTENSION_ID|g")

MANIFEST_DEST="$HOST_DIR/$NATIVE_HOST_NAME.json"
echo "$MANIFEST_CONTENT" > "$MANIFEST_DEST"

# Remove old native host if present
OLD_HOST="$HOST_DIR/com.qwen_tts_mlx.native_host.json"
if [ -f "$OLD_HOST" ]; then
    rm "$OLD_HOST"
    echo "✓ Removed old Qwen3-TTS native host manifest"
fi

echo ""
echo "✓ Native messaging host manifest created at:"
echo "  $MANIFEST_DEST"
echo ""

# Make native host script executable
chmod +x "$NATIVE_HOST_SCRIPT"

# Also install for Chromium if directory exists
if [ -d "$(dirname "$CHROMIUM_HOST_DIR")" ]; then
    mkdir -p "$CHROMIUM_HOST_DIR"
    echo "$MANIFEST_CONTENT" > "$CHROMIUM_HOST_DIR/$NATIVE_HOST_NAME.json"
    echo "✓ Also installed for Chromium"
fi

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Next steps:"
echo "1. Reload your extension in chrome://extensions/"
echo "2. Click the extension icon to open the popup"
echo "3. Use the Start/Stop Server buttons"
echo ""
echo "To uninstall, run: ./uninstall_native_host.sh"