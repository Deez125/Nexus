FROM python:3.11-slim

# Install system dependencies for Playwright, aiortc, and PulseAudio
RUN apt-get update && apt-get install -y \
    # Basic tools
    wget \
    gnupg \
    ca-certificates \
    # Playwright dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    # aiortc dependencies
    libavformat-dev \
    libavcodec-dev \
    libavdevice-dev \
    libavutil-dev \
    libswscale-dev \
    libswresample-dev \
    libavfilter-dev \
    libopus-dev \
    libvpx-dev \
    pkg-config \
    # PulseAudio for audio capture
    pulseaudio \
    pulseaudio-utils \
    # X virtual framebuffer for headless GUI
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Install Google Chrome (includes Widevine DRM for Spotify playback)
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Skip Playwright browser install - we use system-installed Google Chrome for Widevine DRM
# Just install dependencies for the browser
RUN playwright install-deps chromium

# Copy application code
COPY . .

# Copy PulseAudio configuration
COPY pulse-config/default.pa /etc/pulse/default.pa
COPY pulse-config/daemon.conf /etc/pulse/daemon.conf

# Create startup script
COPY start.sh /start.sh
RUN chmod +x /start.sh

# Expose port for WebSocket and dashboard
EXPOSE 8765

# Environment variables (can be overridden)
ENV HOST=0.0.0.0
ENV PORT=8765

# Run the server with PulseAudio
CMD ["/start.sh"]
