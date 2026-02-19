#!/bin/bash

# Start PulseAudio in the background
echo "Starting PulseAudio..."
pulseaudio --start --exit-idle-time=-1

# Wait for PulseAudio to be ready
sleep 2

# Verify PulseAudio is running
if pulseaudio --check; then
    echo "PulseAudio started successfully"
    pactl list sinks short
else
    echo "Warning: PulseAudio failed to start, starting manually..."
    pulseaudio --daemonize=no --exit-idle-time=-1 &
    sleep 2
fi

# Start Xvfb (virtual framebuffer) for headless browser
echo "Starting Xvfb..."
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99
sleep 1

echo "Starting Nexus Server..."
exec python main.py
