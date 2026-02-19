#!/bin/bash

# Create runtime directory for PulseAudio
mkdir -p /tmp/pulse
export XDG_RUNTIME_DIR=/tmp

# Start PulseAudio with system-wide settings
echo "Starting PulseAudio..."
pulseaudio --system --disallow-exit --disallow-module-loading=0 --exit-idle-time=-1 &
sleep 3

# Verify PulseAudio is running
if pulseaudio --check; then
    echo "PulseAudio started successfully"
else
    echo "Warning: PulseAudio failed to start, trying alternative..."
    pulseaudio --start --exit-idle-time=-1 || true
    sleep 2
fi

# Set PulseAudio server for all processes
export PULSE_SERVER=unix:/var/run/pulse/native

# Create ALSA config to route audio through PulseAudio
cat > /etc/asound.conf << 'ALSA_EOF'
pcm.!default {
    type pulse
}
ctl.!default {
    type pulse
}
ALSA_EOF

echo "Created ALSA->PulseAudio bridge config"

# Start Xvfb (virtual framebuffer) for headed browser
echo "Starting Xvfb..."
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99
sleep 1

echo "PulseAudio sinks:"
pactl list sinks short || echo "Could not list sinks"
echo "Default sink:"
pactl info 2>/dev/null | grep "Default Sink" || echo "Could not get default sink"

echo "Starting Nexus Server..."
exec python main.py
