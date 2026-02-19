"""
Spotify Bot - Joins WebRTC calls and streams Spotify audio
Uses Playwright to control Spotify Web Player and aiortc for WebRTC
"""

import os
import json
import asyncio
from typing import Optional, Dict, Callable
from dataclasses import dataclass, field
import aiohttp
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, MediaStreamTrack, RTCConfiguration, RTCIceServer
from playwright.async_api import async_playwright, Browser, Page, BrowserContext

from audio_capture import PulseAudioCapture, SpotifyAudioTrack, SilentAudioTrack

# Bot configuration
BOT_CLIENT_ID = "spotify_bot"
BOT_USERNAME = "Spotify"

# ICE servers (same as frontend)
ICE_SERVERS = [
    RTCIceServer(urls=["stun:stun.l.google.com:19302"]),
    RTCIceServer(urls=["stun:stun1.l.google.com:19302"]),
    RTCIceServer(
        urls=["turn:openrelay.metered.ca:80"],
        username="openrelayproject",
        credential="openrelayproject"
    ),
    RTCIceServer(
        urls=["turn:openrelay.metered.ca:443"],
        username="openrelayproject",
        credential="openrelayproject"
    ),
]


@dataclass
class BotState:
    """Tracks the bot's current state"""
    is_running: bool = False
    is_in_call: bool = False
    is_playing: bool = False
    is_logged_in: bool = False
    current_track: Optional[str] = None
    browser: Optional[Browser] = None
    context: Optional[BrowserContext] = None
    page: Optional[Page] = None
    ws: Optional[aiohttp.ClientWebSocketResponse] = None
    ws_session: Optional[aiohttp.ClientSession] = None
    peer_connections: Dict[str, RTCPeerConnection] = field(default_factory=dict)
    audio_capture: Optional[PulseAudioCapture] = None
    audio_track: Optional[MediaStreamTrack] = None
    device_id: Optional[str] = None  # Spotify Connect device ID


class SpotifyBot:
    """
    Spotify Bot that joins WebRTC calls and streams audio from Spotify Web Player
    """

    def __init__(self, server_url: str = None):
        # Determine server URL based on environment
        if server_url:
            self.server_url = server_url
        elif os.environ.get("PRODUCTION"):
            self.server_url = "wss://nexus-api.pulpfliction.com"
        else:
            self.server_url = "ws://localhost:8765"

        self.state = BotState()
        self.log_callback: Optional[Callable] = None
        self._message_handlers = {
            "connected": self._on_connected,
            "call_user_joined": self._on_call_user_joined,
            "call_user_left": self._on_call_user_left,
            "offer": self._on_offer,
            "answer": self._on_answer,
            "ice_candidate": self._on_ice_candidate,
        }
        self._playwright = None

    def log(self, message: str):
        """Log a message"""
        print(f"[SpotifyBot] {message}")
        if self.log_callback:
            self.log_callback(message)

    async def start(self):
        """Start the bot - launch browser and connect to server"""
        if self.state.is_running:
            self.log("Bot is already running")
            return False

        self.log("Starting Spotify Bot...")

        try:
            # Launch headless browser with Playwright
            self.log("Launching headless browser with Chrome (Widevine DRM support)...")
            self._playwright = await async_playwright().start()

            # Launch Google Chrome (not Chromium) for Widevine DRM support
            # Chrome is installed at /usr/bin/google-chrome-stable
            self.state.browser = await self._playwright.chromium.launch(
                headless=False,  # Use headed mode with Xvfb for audio output
                executable_path='/usr/bin/google-chrome-stable',
                args=[
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--autoplay-policy=no-user-gesture-required',
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process',
                    # Audio settings - force ALSA to use PulseAudio
                    '--use-fake-ui-for-media-stream',
                    '--disable-gpu',
                    # Enable DRM/Widevine
                    '--enable-features=Widevine',
                ]
            )

            # Create browser context with permissions and bypass CSP
            self.state.context = await self.state.browser.new_context(
                viewport={'width': 1280, 'height': 720},
                user_agent='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                bypass_csp=True  # Bypass Content Security Policy to allow SDK injection
            )

            self.state.page = await self.state.context.new_page()
            self.log("Browser launched successfully")

            # Initialize audio capture
            self.state.audio_capture = PulseAudioCapture()

            # Connect to WebSocket server
            await self._connect_websocket()

            self.state.is_running = True
            self.log("Spotify Bot started successfully")
            return True

        except Exception as e:
            self.log(f"Failed to start bot: {str(e)}")
            import traceback
            traceback.print_exc()
            await self.stop()
            return False

    async def stop(self):
        """Stop the bot and cleanup"""
        self.log("Stopping Spotify Bot...")

        # Leave call if in one
        if self.state.is_in_call:
            await self.leave_call()

        # Stop audio capture
        if self.state.audio_capture:
            self.state.audio_capture.stop()
            self.state.audio_capture = None

        # Close all peer connections
        for pc in self.state.peer_connections.values():
            await pc.close()
        self.state.peer_connections.clear()

        # Close WebSocket
        if self.state.ws:
            await self.state.ws.close()
            self.state.ws = None
        if self.state.ws_session:
            await self.state.ws_session.close()
            self.state.ws_session = None

        # Close browser
        if self.state.context:
            await self.state.context.close()
            self.state.context = None
        if self.state.browser:
            await self.state.browser.close()
            self.state.browser = None
        self.state.page = None

        # Close playwright
        if self._playwright:
            await self._playwright.stop()
            self._playwright = None

        self.state.is_running = False
        self.state.is_in_call = False
        self.state.is_logged_in = False
        self.log("Spotify Bot stopped")

    async def _connect_websocket(self):
        """Connect to the Nexus server via WebSocket"""
        ws_url = f"{self.server_url}/ws/{BOT_CLIENT_ID}"
        self.log(f"Connecting to {ws_url}...")

        self.state.ws_session = aiohttp.ClientSession()
        self.state.ws = await self.state.ws_session.ws_connect(ws_url)

        # Set username
        await self._send({
            "type": "set_username",
            "username": BOT_USERNAME
        })

        # Start message handler loop
        asyncio.create_task(self._message_loop())

        self.log("WebSocket connected")

    async def _message_loop(self):
        """Handle incoming WebSocket messages"""
        try:
            async for msg in self.state.ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    data = json.loads(msg.data)
                    msg_type = data.get("type")

                    handler = self._message_handlers.get(msg_type)
                    if handler:
                        await handler(data)

                elif msg.type == aiohttp.WSMsgType.ERROR:
                    self.log(f"WebSocket error: {msg.data}")
                    break

        except Exception as e:
            self.log(f"Message loop error: {str(e)}")
            import traceback
            traceback.print_exc()

    async def _send(self, data: dict):
        """Send a message via WebSocket"""
        if self.state.ws and not self.state.ws.closed:
            try:
                await self.state.ws.send_str(json.dumps(data))
            except Exception as e:
                self.log(f"Failed to send message: {e}")

    async def join_call(self):
        """Join the voice call"""
        if not self.state.is_running:
            self.log("Bot is not running")
            return False

        # Check if we think we're in a call but the WS is dead
        if self.state.is_in_call:
            if not self.state.ws or self.state.ws.closed:
                self.log("Was in call but WebSocket died, resetting state...")
                self.state.is_in_call = False
                # Clean up stale resources
                if self.state.audio_capture:
                    self.state.audio_capture.stop()
                if self.state.audio_track:
                    self.state.audio_track.stop()
                    self.state.audio_track = None
                for pc in self.state.peer_connections.values():
                    await pc.close()
                self.state.peer_connections.clear()
            else:
                self.log("Already in call")
                return True

        self.log("Joining call...")

        # Start audio capture from PulseAudio
        if self.state.audio_capture:
            self.state.audio_capture.start()
            self.state.audio_track = SpotifyAudioTrack(self.state.audio_capture)
            self.log("Audio capture started")
        else:
            # Fallback to silent track
            self.state.audio_track = SilentAudioTrack()
            self.log("Using silent audio track (capture not available)")

        await self._send({
            "type": "call_join"
        })

        # Update media state - bot has audio
        await self._send({
            "type": "media_state",
            "audio": True,
            "video": False,
            "screen": False
        })

        self.state.is_in_call = True
        self.log("Joined call")
        return True

    async def leave_call(self):
        """Leave the voice call"""
        if not self.state.is_in_call:
            return

        self.log("Leaving call...")

        # Try to send leave message, but don't fail if WS is closed
        try:
            await self._send({
                "type": "call_leave"
            })
        except Exception as e:
            self.log(f"Could not send leave message (WS may be closed): {e}")

        # Stop audio capture
        if self.state.audio_capture:
            self.state.audio_capture.stop()

        # Stop audio track
        if self.state.audio_track:
            self.state.audio_track.stop()
            self.state.audio_track = None

        # Close all peer connections
        for pc in self.state.peer_connections.values():
            await pc.close()
        self.state.peer_connections.clear()

        self.state.is_in_call = False
        self.log("Left call")

    async def open_spotify(self):
        """Initialize Spotify Web Playback SDK in the browser"""
        if not self.state.page:
            self.log("Browser not initialized")
            return False

        self.log("Initializing Spotify Web Playback SDK...")

        try:
            # Get access token from spotify.py
            from spotify import tokens
            access_token = tokens.get("access_token")

            if not access_token:
                self.log("No Spotify access token available - user needs to connect Spotify first")
                return False

            # Capture browser console logs
            self.state.page.on("console", lambda msg: self.log(f"[Browser] {msg.text}"))

            # Navigate to a real HTTPS page first (required for DRM/EME)
            # We'll use open.spotify.com and inject our SDK code
            self.log("Navigating to Spotify (HTTPS context required for DRM)...")
            await self.state.page.goto("https://open.spotify.com", wait_until="domcontentloaded")
            await self.state.page.wait_for_timeout(2000)

            # Now inject the Web Playback SDK
            self.log("Injecting Web Playback SDK...")
            await self.state.page.evaluate(f"""
                (async () => {{
                    // Load the SDK script
                    const script = document.createElement('script');
                    script.src = 'https://sdk.scdn.co/spotify-player.js';
                    document.head.appendChild(script);

                    // Wait for SDK to load
                    await new Promise(resolve => {{
                        window.onSpotifyWebPlaybackSDKReady = resolve;
                    }});

                    const token = '{access_token}';
                    const player = new Spotify.Player({{
                        name: 'Nexus Bot',
                        getOAuthToken: cb => {{ cb(token); }},
                        volume: 1.0
                    }});

                    // Ready
                    player.addListener('ready', ({{ device_id }}) => {{
                        console.log('Ready with Device ID', device_id);
                        window.spotifyDeviceId = device_id;
                        window.spotifyPlayer = player;
                    }});

                    // Not Ready
                    player.addListener('not_ready', ({{ device_id }}) => {{
                        console.log('Device ID has gone offline', device_id);
                    }});

                    // Error handling
                    player.addListener('initialization_error', ({{ message }}) => {{
                        console.error('Init error:', message);
                        window.spotifyInitError = message;
                    }});

                    player.addListener('authentication_error', ({{ message }}) => {{
                        console.error('Auth error:', message);
                        window.spotifyInitError = 'Auth: ' + message;
                    }});

                    player.addListener('account_error', ({{ message }}) => {{
                        console.error('Account error:', message);
                        window.spotifyInitError = 'Account (Premium required): ' + message;
                    }});

                    player.addListener('playback_error', ({{ message }}) => {{
                        console.error('Playback error:', message);
                    }});

                    // Playback status updates
                    player.addListener('player_state_changed', state => {{
                        if (state) {{
                            console.log('State changed:', state);
                            window.spotifyState = state;
                        }}
                    }});

                    await player.connect();
                }})();
            """)

            self.log("SDK injected, waiting for initialization...")
            await self.state.page.wait_for_timeout(5000)  # Wait for SDK to initialize

            # Check if device ID was set
            device_id = await self.state.page.evaluate("window.spotifyDeviceId")
            if device_id:
                self.state.device_id = device_id
                self.log(f"Spotify SDK ready with device ID: {device_id}")
                return True
            else:
                error = await self.state.page.evaluate("window.spotifyInitError || 'Unknown error'")
                self.log(f"Spotify SDK failed to initialize: {error}")
                return False

        except Exception as e:
            self.log(f"Failed to initialize Spotify SDK: {str(e)}")
            import traceback
            traceback.print_exc()
            return False

    async def login_spotify(self, username: str, password: str):
        """Login to Spotify (one-time setup)"""
        if not self.state.page:
            self.log("Browser not initialized")
            return False

        self.log("Logging into Spotify...")

        try:
            # Navigate to login page
            await self.state.page.goto("https://accounts.spotify.com/login", wait_until="domcontentloaded")
            await self.state.page.wait_for_timeout(2000)

            # Fill in credentials
            await self.state.page.fill('input[id="login-username"]', username)
            await self.state.page.fill('input[id="login-password"]', password)

            # Click login button
            await self.state.page.click('button[id="login-button"]')

            # Wait for redirect to Spotify
            await self.state.page.wait_for_url("**/open.spotify.com/**", timeout=30000)

            self.state.is_logged_in = True
            self.log("Logged into Spotify successfully")

            # Save cookies for future sessions
            await self._save_cookies()

            return True

        except Exception as e:
            self.log(f"Failed to login to Spotify: {str(e)}")
            return False

    async def _save_cookies(self):
        """Save browser cookies for persistent sessions"""
        if not self.state.context:
            return

        try:
            cookies = await self.state.context.cookies()
            with open("/app/spotify_cookies.json", "w") as f:
                json.dump(cookies, f)
            self.log("Saved Spotify cookies")
        except Exception as e:
            self.log(f"Failed to save cookies: {e}")

    async def _load_cookies(self):
        """Load saved cookies for persistent sessions"""
        if not self.state.context:
            return False

        try:
            if os.path.exists("/app/spotify_cookies.json"):
                with open("/app/spotify_cookies.json", "r") as f:
                    cookies = json.load(f)
                await self.state.context.add_cookies(cookies)
                self.log("Loaded Spotify cookies")
                return True
        except Exception as e:
            self.log(f"Failed to load cookies: {e}")

        return False

    async def play_track(self, uri: str):
        """Play a specific track/album/playlist by Spotify URI via API"""
        self.log(f"Playing: {uri}")

        # Build the request body based on URI type
        body = {}
        device_param = f"?device_id={self.state.device_id}" if self.state.device_id else ""

        if uri.startswith("spotify:track:"):
            body["uris"] = [uri]
        elif uri.startswith("spotify:album:") or uri.startswith("spotify:playlist:"):
            body["context_uri"] = uri
        else:
            # Try to parse as context URI
            body["context_uri"] = uri

        success = await self._spotify_api_request("PUT", f"/me/player/play{device_param}", body)

        if success:
            self.state.is_playing = True
            self.state.current_track = uri
            self.log("Started playback")

        return success

    async def _spotify_api_request(self, method: str, endpoint: str, json_data: dict = None) -> bool:
        """Make a request to the Spotify API using the stored token"""
        from spotify import tokens

        access_token = tokens.get("access_token")
        if not access_token:
            self.log("No Spotify access token")
            return False

        try:
            import httpx
            async with httpx.AsyncClient() as client:
                headers = {"Authorization": f"Bearer {access_token}"}
                url = f"https://api.spotify.com/v1{endpoint}"

                if method == "PUT":
                    response = await client.put(url, headers=headers, json=json_data)
                elif method == "POST":
                    response = await client.post(url, headers=headers, json=json_data)
                else:
                    response = await client.get(url, headers=headers)

                if response.status_code in [200, 204]:
                    return True
                else:
                    self.log(f"Spotify API error: {response.status_code} - {response.text}")
                    return False
        except Exception as e:
            self.log(f"Spotify API request failed: {str(e)}")
            return False

    async def pause(self):
        """Pause playback via Spotify API"""
        device_param = f"?device_id={self.state.device_id}" if self.state.device_id else ""
        success = await self._spotify_api_request("PUT", f"/me/player/pause{device_param}")
        if success:
            self.state.is_playing = False
            self.log("Paused playback")
        return success

    async def resume(self):
        """Resume playback via Spotify API"""
        device_param = f"?device_id={self.state.device_id}" if self.state.device_id else ""
        success = await self._spotify_api_request("PUT", f"/me/player/play{device_param}")
        if success:
            self.state.is_playing = True
            self.log("Resumed playback")
        return success

    async def skip_next(self):
        """Skip to next track via Spotify API"""
        device_param = f"?device_id={self.state.device_id}" if self.state.device_id else ""
        success = await self._spotify_api_request("POST", f"/me/player/next{device_param}")
        if success:
            self.log("Skipped to next track")
        return success

    async def skip_previous(self):
        """Skip to previous track via Spotify API"""
        device_param = f"?device_id={self.state.device_id}" if self.state.device_id else ""
        success = await self._spotify_api_request("POST", f"/me/player/previous{device_param}")
        if success:
            self.log("Skipped to previous track")
        return success

    # WebSocket message handlers
    async def _on_connected(self, data: dict):
        """Handle connection confirmation"""
        self.log(f"Connected to server as {BOT_CLIENT_ID}")

    async def _on_call_user_joined(self, data: dict):
        """Handle when a user joins the call - create peer connection"""
        user_id = data.get("client_id")
        username = data.get("username")
        participants = data.get("participants", [])

        # If this is our own join event, create connections to all existing participants
        if user_id == BOT_CLIENT_ID:
            self.log(f"Bot joined call, participants: {participants}")
            for participant_id in participants:
                if participant_id != BOT_CLIENT_ID and participant_id not in self.state.peer_connections:
                    self.log(f"Creating peer connection to existing participant: {participant_id}")
                    await self._create_peer_connection(participant_id, create_offer=True)
            return

        self.log(f"{username} joined the call")

        # If we're in the call, create a peer connection to the new user
        if self.state.is_in_call:
            await self._create_peer_connection(user_id, create_offer=True)

    async def _on_call_user_left(self, data: dict):
        """Handle when a user leaves the call"""
        user_id = data.get("client_id")
        username = data.get("username")

        self.log(f"{username} left the call")

        # Close peer connection if exists
        if user_id in self.state.peer_connections:
            await self.state.peer_connections[user_id].close()
            del self.state.peer_connections[user_id]

    async def _on_offer(self, data: dict):
        """Handle incoming WebRTC offer"""
        from_id = data.get("from")
        offer = data.get("offer")

        self.log(f"Received offer from {from_id}")

        # Create peer connection if not exists
        pc = await self._create_peer_connection(from_id, create_offer=False)

        # Set remote description (the offer)
        await pc.setRemoteDescription(RTCSessionDescription(
            sdp=offer["sdp"],
            type=offer["type"]
        ))

        # Create and send answer
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        await self._send({
            "type": "answer",
            "target": from_id,
            "answer": {
                "sdp": pc.localDescription.sdp,
                "type": pc.localDescription.type
            }
        })

        self.log(f"Sent answer to {from_id}")

    async def _on_answer(self, data: dict):
        """Handle incoming WebRTC answer"""
        from_id = data.get("from")
        answer = data.get("answer")

        self.log(f"Received answer from {from_id}")

        pc = self.state.peer_connections.get(from_id)
        if pc:
            await pc.setRemoteDescription(RTCSessionDescription(
                sdp=answer["sdp"],
                type=answer["type"]
            ))

    async def _on_ice_candidate(self, data: dict):
        """Handle incoming ICE candidate"""
        from_id = data.get("from")
        candidate_data = data.get("candidate")

        if not candidate_data:
            return

        pc = self.state.peer_connections.get(from_id)
        if pc and candidate_data.get("candidate"):
            candidate = RTCIceCandidate(
                sdpMid=candidate_data.get("sdpMid"),
                sdpMLineIndex=candidate_data.get("sdpMLineIndex"),
                candidate=candidate_data.get("candidate")
            )
            await pc.addIceCandidate(candidate)

    async def _create_peer_connection(self, peer_id: str, create_offer: bool = False) -> RTCPeerConnection:
        """Create a new peer connection to a peer"""
        self.log(f"Creating peer connection to {peer_id}")

        # Create peer connection with ICE servers
        config = RTCConfiguration(iceServers=ICE_SERVERS)
        pc = RTCPeerConnection(configuration=config)
        self.state.peer_connections[peer_id] = pc

        # Handle ICE candidates
        @pc.on("icecandidate")
        async def on_icecandidate(candidate):
            if candidate:
                await self._send({
                    "type": "ice_candidate",
                    "target": peer_id,
                    "candidate": {
                        "candidate": candidate.candidate,
                        "sdpMid": candidate.sdpMid,
                        "sdpMLineIndex": candidate.sdpMLineIndex
                    }
                })

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            self.log(f"Connection state with {peer_id}: {pc.connectionState}")

        # Add audio track to peer connection
        # Each peer connection needs its own track instance
        if self.state.audio_capture and self.state.audio_capture.is_running:
            track = SpotifyAudioTrack(self.state.audio_capture)
            pc.addTrack(track)
            self.log(f"Added audio track to peer connection with {peer_id}")

        # Create offer if requested
        if create_offer:
            offer = await pc.createOffer()
            await pc.setLocalDescription(offer)

            await self._send({
                "type": "offer",
                "target": peer_id,
                "offer": {
                    "sdp": pc.localDescription.sdp,
                    "type": pc.localDescription.type
                }
            })

            self.log(f"Sent offer to {peer_id}")

        return pc


# Global bot instance
spotify_bot: Optional[SpotifyBot] = None


async def get_bot() -> SpotifyBot:
    """Get or create the global bot instance"""
    global spotify_bot
    if spotify_bot is None:
        spotify_bot = SpotifyBot()
    return spotify_bot
