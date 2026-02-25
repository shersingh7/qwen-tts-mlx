#!/bin/bash
# Install launch agent for auto-starting the TTS server on login

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PLIST_NAME="com.qwen-tts.server"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

echo "Installing Qwen3-TTS launch agent..."

# Create the plist file
cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_NAME</string>
    <key>ProgramArguments</key>
    <array>
        <string>$SCRIPT_DIR/venv/bin/python</string>
        <string>server.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$SCRIPT_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$SCRIPT_DIR/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$SCRIPT_DIR/stderr.log</string>
</dict>
</plist>
EOF

echo "✓ Created $PLIST_PATH"

# Load the launch agent
launchctl load "$PLIST_PATH" 2>/dev/null || true

echo "✓ Launch agent loaded"
echo ""
echo "The TTS server will now start automatically on login."
echo "To start it now: launchctl start $PLIST_NAME"
echo "To stop it: launchctl stop $PLIST_NAME"
echo "To uninstall: ./uninstall_launch_agent.sh"