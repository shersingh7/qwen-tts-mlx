#!/usr/bin/env python3
"""
Native Messaging Host for Open TTS extension.
Handles start/stop server commands from the Chrome extension.
"""

import json
import os
import signal
import subprocess
import sys
import struct
import time
from pathlib import Path

# Get the directory where this script is located
SCRIPT_DIR = Path(__file__).parent.resolve()
BACKEND_DIR = SCRIPT_DIR  # native_host.py is in backend/
SERVER_SCRIPT = BACKEND_DIR / "server.py"
VENV_PYTHON = BACKEND_DIR / "venv" / "bin" / "python"
PID_FILE = BACKEND_DIR / ".server.pid"
LOG_FILE = BACKEND_DIR / "server.log"

def get_message():
    """Read a message from stdin (Native Messaging protocol)."""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    message_length = struct.unpack("@I", raw_length)[0]
    message = sys.stdin.buffer.read(message_length).decode("utf-8")
    return json.loads(message)

def send_message(message):
    """Send a message to stdout (Native Messaging protocol)."""
    encoded_message = json.dumps(message).encode("utf-8")
    encoded_length = struct.pack("@I", len(encoded_message))
    sys.stdout.buffer.write(encoded_length)
    sys.stdout.buffer.write(encoded_message)
    sys.stdout.buffer.flush()

def send_response(success, message, **extra):
    """Send a response message."""
    response = {"success": success, "message": message, **extra}
    send_message(response)

def is_server_running():
    """Check if the server is running by checking PID file and process."""
    if not PID_FILE.exists():
        return False

    try:
        pid = int(PID_FILE.read_text().strip())
        # Check if process exists
        os.kill(pid, 0)
        return True
    except (ValueError, ProcessLookupError, PermissionError):
        # PID file exists but process doesn't - clean up
        if PID_FILE.exists():
            PID_FILE.unlink()
        return False

def get_server_pid():
    """Get the server PID if running."""
    if not PID_FILE.exists():
        return None
    try:
        return int(PID_FILE.read_text().strip())
    except (ValueError, FileNotFoundError):
        return None

def start_server():
    """Start the TTS server."""
    if is_server_running():
        pid = get_server_pid()
        return True, f"Server already running (PID: {pid})"

    # Determine Python executable
    python_exe = str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable

    # Start the server as a background process
    log_handle = open(LOG_FILE, "a")

    try:
        process = subprocess.Popen(
            [python_exe, str(SERVER_SCRIPT)],
            cwd=str(BACKEND_DIR),
            stdout=log_handle,
            stderr=log_handle,
            start_new_session=True  # Detach from parent process
        )

        # Save PID
        PID_FILE.write_text(str(process.pid))

        # Wait a moment and check if it started successfully
        time.sleep(2)

        # Check if process is still running
        try:
            os.kill(process.pid, 0)
            return True, f"Server started (PID: {process.pid})"
        except ProcessLookupError:
            return False, "Server failed to start. Check server.log for details."

    except Exception as e:
        return False, f"Failed to start server: {str(e)}"

def stop_server():
    """Stop the TTS server."""
    if not is_server_running():
        return True, "Server is not running"

    pid = get_server_pid()
    if pid is None:
        return True, "Server is not running"

    try:
        # Send SIGTERM for graceful shutdown
        os.kill(pid, signal.SIGTERM)

        # Wait for process to terminate
        for _ in range(10):
            time.sleep(0.5)
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                # Process terminated
                if PID_FILE.exists():
                    PID_FILE.unlink()
                return True, "Server stopped successfully"

        # Force kill if still running
        os.kill(pid, signal.SIGKILL)
        time.sleep(0.5)

        if PID_FILE.exists():
            PID_FILE.unlink()

        return True, "Server stopped (force killed)"

    except ProcessLookupError:
        if PID_FILE.exists():
            PID_FILE.unlink()
        return True, "Server was not running"
    except PermissionError:
        return False, "Permission denied. Try stopping manually."
    except Exception as e:
        return False, f"Failed to stop server: {str(e)}"

def get_status():
    """Get the server status."""
    running = is_server_running()
    pid = get_server_pid() if running else None
    return {
        "running": running,
        "pid": pid,
        "message": f"Server running (PID: {pid})" if running else "Server not running"
    }

def main():
    """Main native messaging host loop."""
    while True:
        try:
            message = get_message()
            if message is None:
                break

            command = message.get("command")

            if command == "start":
                success, msg = start_server()
                send_response(success, msg)
            elif command == "stop":
                success, msg = stop_server()
                send_response(success, msg)
            elif command == "status":
                status = get_status()
                send_response(True, status["message"], **status)
            else:
                send_response(False, f"Unknown command: {command}")

        except Exception as e:
            send_response(False, f"Error: {str(e)}")
            break

if __name__ == "__main__":
    main()