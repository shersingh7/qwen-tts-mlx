#!/bin/bash
# Uninstall the launch agent

PLIST_NAME="com.qwen-tts.server"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

echo "Uninstalling Qwen3-TTS launch agent..."

# Stop and unload
launchctl stop "$PLIST_NAME" 2>/dev/null || true
launchctl unload "$PLIST_PATH" 2>/dev/null || true

# Remove plist
rm -f "$PLIST_PATH"

echo "✓ Launch agent uninstalled"