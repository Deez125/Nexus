"""
Spotify Bot - Joins WebRTC calls and streams Spotify audio
Uses Playwright to control Spotify Web Player and aiortc for WebRTC
"""

import os
import json
import asyncio
from typing import Optional, Dict, Callable
from dataclasses import dataclass
import aiohttp
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, MediaStreamTrack
from aiortc.contrib.media import MediaPlayer, MediaBlackhole
from playwright.async_api import async_playwright, Browser, Page

# Bot configuration
BOT_CLIENT_ID = "spotify_bot"
BOT_USERNAME = "Spotify"


@dataclass
class BotState:
    """Tracks the bot's current state"""
    is_running: bool = False
    is_in_call: bool = False
    is_playing: bool = False
    current_track: Optional[str] = None
    browser: Optional[Browser] = None
    page: Optional[Page] = None
    ws: Optional[aiohttp.ClientWebSocketResponse] = None
    peer_connections: Dict[str, RTCPeerConnection] = None

    def __post_init__(self):
        if self.peer_connections is None:
            self.peer_connections = {}


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
            self.log("Launching headless browser...")
            playwright = await async_playwright().start()

            # Launch Chromium with audio enabled
            self.state.browser = await playwright.chromium.launch(
                headless=True,
                args=[
                    '--use-fake-ui-for-media-stream',  # Auto-allow media
                    '--use-fake-device-for-media-stream',  # Use fake devices
                    '--autoplay-policy=no-user-gesture-required',  # Allow autoplay
                    '--disable-web-security',
                    '--no-sandbox',
                ]
            )

            # Create browser context with permissions
            context = await self.state.browser.new_context(
                permissions=['microphone', 'camera'],
                viewport={'width': 1280, 'height': 720}
            )

            self.state.page = await context.new_page()
            self.log("Browser launched successfully")

            # Connect to WebSocket server
            await self._connect_websocket()

            self.state.is_running = True
            self.log("Spotify Bot started successfully")
            return True

        except Exception as e:
            self.log(f"Failed to start bot: {str(e)}")
            await self.stop()
            return False

    async def stop(self):
        """Stop the bot and cleanup"""
        self.log("Stopping Spotify Bot...")

        # Leave call if in one
        if self.state.is_in_call:
            await self.leave_call()

        # Close all peer connections
        for pc in self.state.peer_connections.values():
            await pc.close()
        self.state.peer_connections.clear()

        # Close WebSocket
        if self.state.ws:
            await self.state.ws.close()
            self.state.ws = None

        # Close browser
        if self.state.browser:
            await self.state.browser.close()
            self.state.browser = None
            self.state.page = None

        self.state.is_running = False
        self.state.is_in_call = False
        self.log("Spotify Bot stopped")

    async def _connect_websocket(self):
        """Connect to the Nexus server via WebSocket"""
        ws_url = f"{self.server_url}/ws/{BOT_CLIENT_ID}"
        self.log(f"Connecting to {ws_url}...")

        session = aiohttp.ClientSession()
        self.state.ws = await session.ws_connect(ws_url)

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
                    else:
                        self.log(f"Unhandled message type: {msg_type}")

                elif msg.type == aiohttp.WSMsgType.ERROR:
                    self.log(f"WebSocket error: {msg.data}")
                    break

        except Exception as e:
            self.log(f"Message loop error: {str(e)}")

    async def _send(self, data: dict):
        """Send a message via WebSocket"""
        if self.state.ws:
            await self.state.ws.send_str(json.dumps(data))

    async def join_call(self):
        """Join the voice call"""
        if not self.state.is_running:
            self.log("Bot is not running")
            return False

        if self.state.is_in_call:
            self.log("Already in call")
            return True

        self.log("Joining call...")

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

        await self._send({
            "type": "call_leave"
        })

        # Close all peer connections
        for pc in self.state.peer_connections.values():
            await pc.close()
        self.state.peer_connections.clear()

        self.state.is_in_call = False
        self.log("Left call")

    async def open_spotify(self):
        """Open Spotify Web Player in the browser"""
        if not self.state.page:
            self.log("Browser not initialized")
            return False

        self.log("Opening Spotify Web Player...")

        try:
            await self.state.page.goto("https://open.spotify.com")
            await self.state.page.wait_for_load_state("networkidle")
            self.log("Spotify Web Player loaded")
            return True
        except Exception as e:
            self.log(f"Failed to open Spotify: {str(e)}")
            return False

    # WebSocket message handlers
    async def _on_connected(self, data: dict):
        """Handle connection confirmation"""
        self.log(f"Connected to server as {BOT_CLIENT_ID}")

    async def _on_call_user_joined(self, data: dict):
        """Handle when a user joins the call - create peer connection"""
        user_id = data.get("client_id")
        username = data.get("username")

        if user_id == BOT_CLIENT_ID:
            return  # Ignore self

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

        pc = RTCPeerConnection()
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

        # Add audio track (we'll replace this with Spotify audio later)
        # For now, create a silent audio track
        # TODO: Replace with actual Spotify audio capture

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
