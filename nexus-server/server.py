"""
Nexus Server - FastAPI WebSocket server for chat and WebRTC signaling
"""

import json
import asyncio
from datetime import datetime
from typing import Dict, Set, Optional, Callable
from dataclasses import dataclass, field
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware


@dataclass
class Client:
    """Represents a connected client"""
    websocket: WebSocket
    client_id: str
    username: str = "Anonymous"
    connected_at: datetime = field(default_factory=datetime.now)
    in_call: bool = False
    has_audio: bool = False
    has_video: bool = False
    has_screen: bool = False


class NexusServer:
    """Main server class handling WebSocket connections, chat, and WebRTC signaling"""

    def __init__(self):
        self.app = FastAPI(title="Nexus Server")
        self.clients: Dict[str, Client] = {}
        self.call_participants: Set[str] = set()
        self.message_history: list = []
        self.event_log: list = []
        self.log_callback: Optional[Callable] = None
        self.stats_callback: Optional[Callable] = None

        # Configure CORS
        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

        # Register routes
        self._setup_routes()

    def _setup_routes(self):
        """Setup WebSocket and HTTP routes"""

        # Import and include dashboard routes
        from dashboard import router as dashboard_router
        self.app.include_router(dashboard_router)

        @self.app.get("/api/stats")
        async def get_stats():
            """API endpoint for dashboard stats"""
            return {
                "clients": len(self.clients),
                "in_call": len(self.call_participants),
                "messages": len(self.message_history),
                "client_list": [
                    {
                        "id": c.client_id,
                        "username": c.username,
                        "in_call": c.in_call,
                        "has_audio": c.has_audio,
                        "has_video": c.has_video,
                        "has_screen": c.has_screen,
                        "connected_at": c.connected_at.strftime("%H:%M:%S")
                    }
                    for c in self.clients.values()
                    if not c.client_id.startswith("dashboard_")  # Exclude dashboard clients
                ]
            }

        @self.app.get("/api/logs")
        async def get_logs():
            """API endpoint for server logs"""
            return {"logs": self.event_log[-100:]}  # Last 100 entries

        @self.app.websocket("/ws/{client_id}")
        async def websocket_endpoint(websocket: WebSocket, client_id: str):
            await self._handle_connection(websocket, client_id)

    def log(self, message: str, level: str = "INFO"):
        """Log a message and notify GUI if callback is set"""
        timestamp = datetime.now().strftime("%H:%M:%S")
        log_entry = f"[{timestamp}] [{level}] {message}"
        self.event_log.append(log_entry)

        # Keep only last 1000 log entries
        if len(self.event_log) > 1000:
            self.event_log = self.event_log[-1000:]

        if self.log_callback:
            self.log_callback(log_entry)

    def update_stats(self):
        """Update stats and notify GUI"""
        if self.stats_callback:
            stats = {
                "clients": len(self.clients),
                "in_call": len(self.call_participants),
                "messages": len(self.message_history),
                "client_list": [
                    {
                        "id": c.client_id,
                        "username": c.username,
                        "in_call": c.in_call,
                        "has_audio": c.has_audio,
                        "has_video": c.has_video,
                        "has_screen": c.has_screen,
                        "connected_at": c.connected_at.strftime("%H:%M:%S")
                    }
                    for c in self.clients.values()
                ]
            }
            self.stats_callback(stats)

    async def _handle_connection(self, websocket: WebSocket, client_id: str):
        """Handle a new WebSocket connection"""
        await websocket.accept()

        client = Client(websocket=websocket, client_id=client_id)
        self.clients[client_id] = client

        self.log(f"Client connected: {client_id}")
        self.update_stats()

        # Send connection confirmation with list of existing users
        existing_users = [
            {
                "client_id": c.client_id,
                "username": c.username,
                "in_call": c.in_call,
                "has_audio": c.has_audio,
                "has_video": c.has_video,
                "has_screen": c.has_screen,
            }
            for c in self.clients.values()
            if c.client_id != client_id  # Don't include self
        ]

        await self._send_to_client(client_id, {
            "type": "connected",
            "client_id": client_id,
            "timestamp": datetime.now().isoformat(),
            "users": existing_users  # Include existing users
        })

        # Notify others of new connection
        await self._broadcast({
            "type": "user_joined",
            "client_id": client_id,
            "username": client.username
        }, exclude=client_id)

        try:
            while True:
                data = await websocket.receive_text()
                await self._handle_message(client_id, data)
        except WebSocketDisconnect:
            await self._handle_disconnect(client_id)
        except Exception as e:
            self.log(f"Error with client {client_id}: {str(e)}", "ERROR")
            await self._handle_disconnect(client_id)

    async def _handle_message(self, client_id: str, raw_data: str):
        """Handle incoming WebSocket message"""
        try:
            data = json.loads(raw_data)
            msg_type = data.get("type")

            self.log(f"Message from {client_id}: {msg_type}")

            handlers = {
                "chat": self._handle_chat,
                "set_username": self._handle_set_username,
                "call_join": self._handle_call_join,
                "call_leave": self._handle_call_leave,
                "offer": self._handle_webrtc_offer,
                "answer": self._handle_webrtc_answer,
                "ice_candidate": self._handle_ice_candidate,
                "media_state": self._handle_media_state,
            }

            handler = handlers.get(msg_type)
            if handler:
                await handler(client_id, data)
            else:
                self.log(f"Unknown message type: {msg_type}", "WARN")

        except json.JSONDecodeError:
            self.log(f"Invalid JSON from {client_id}", "ERROR")

    async def _handle_chat(self, client_id: str, data: dict):
        """Handle chat message"""
        client = self.clients.get(client_id)
        if not client:
            return

        message = {
            "type": "chat",
            "client_id": client_id,
            "username": client.username,
            "content": data.get("content", ""),
            "timestamp": datetime.now().isoformat()
        }

        self.message_history.append(message)

        # Keep only last 500 messages
        if len(self.message_history) > 500:
            self.message_history = self.message_history[-500:]

        await self._broadcast(message)
        self.update_stats()

    async def _handle_set_username(self, client_id: str, data: dict):
        """Handle username change"""
        client = self.clients.get(client_id)
        if not client:
            return

        old_username = client.username
        new_username = data.get("username", "Anonymous")
        client.username = new_username

        self.log(f"Username change: {old_username} -> {new_username}")

        await self._broadcast({
            "type": "username_changed",
            "client_id": client_id,
            "old_username": old_username,
            "new_username": new_username
        })

        self.update_stats()

    async def _handle_call_join(self, client_id: str, data: dict):
        """Handle client joining a call"""
        client = self.clients.get(client_id)
        if not client:
            return

        client.in_call = True
        self.call_participants.add(client_id)

        self.log(f"{client.username} joined the call")

        # Notify all call participants
        await self._broadcast({
            "type": "call_user_joined",
            "client_id": client_id,
            "username": client.username,
            "participants": list(self.call_participants)
        })

        self.update_stats()

    async def _handle_call_leave(self, client_id: str, data: dict):
        """Handle client leaving a call"""
        client = self.clients.get(client_id)
        if not client:
            return

        client.in_call = False
        client.has_audio = False
        client.has_video = False
        client.has_screen = False
        self.call_participants.discard(client_id)

        self.log(f"{client.username} left the call")

        await self._broadcast({
            "type": "call_user_left",
            "client_id": client_id,
            "username": client.username,
            "participants": list(self.call_participants)
        })

        self.update_stats()

    async def _handle_webrtc_offer(self, client_id: str, data: dict):
        """Handle WebRTC offer - forward to target peer"""
        target_id = data.get("target")
        if target_id and target_id in self.clients:
            await self._send_to_client(target_id, {
                "type": "offer",
                "from": client_id,
                "offer": data.get("offer")
            })
            self.log(f"Forwarded offer: {client_id} -> {target_id}")

    async def _handle_webrtc_answer(self, client_id: str, data: dict):
        """Handle WebRTC answer - forward to target peer"""
        target_id = data.get("target")
        if target_id and target_id in self.clients:
            await self._send_to_client(target_id, {
                "type": "answer",
                "from": client_id,
                "answer": data.get("answer")
            })
            self.log(f"Forwarded answer: {client_id} -> {target_id}")

    async def _handle_ice_candidate(self, client_id: str, data: dict):
        """Handle ICE candidate - forward to target peer"""
        target_id = data.get("target")
        if target_id and target_id in self.clients:
            await self._send_to_client(target_id, {
                "type": "ice_candidate",
                "from": client_id,
                "candidate": data.get("candidate")
            })
            self.log(f"Forwarded ICE candidate: {client_id} -> {target_id}")

    async def _handle_media_state(self, client_id: str, data: dict):
        """Handle media state updates (audio/video/screen)"""
        client = self.clients.get(client_id)
        if not client:
            return

        if "audio" in data:
            client.has_audio = data["audio"]
        if "video" in data:
            client.has_video = data["video"]
        if "screen" in data:
            client.has_screen = data["screen"]

        self.log(f"Media state: {client.username} - audio:{client.has_audio}, video:{client.has_video}, screen:{client.has_screen}")

        await self._broadcast({
            "type": "media_state_changed",
            "client_id": client_id,
            "audio": client.has_audio,
            "video": client.has_video,
            "screen": client.has_screen
        })

        self.update_stats()

    async def _handle_disconnect(self, client_id: str):
        """Handle client disconnection"""
        client = self.clients.pop(client_id, None)
        if not client:
            return

        self.call_participants.discard(client_id)

        self.log(f"Client disconnected: {client.username} ({client_id})")

        await self._broadcast({
            "type": "user_left",
            "client_id": client_id,
            "username": client.username
        })

        self.update_stats()

    async def _send_to_client(self, client_id: str, message: dict):
        """Send message to a specific client"""
        client = self.clients.get(client_id)
        if client:
            try:
                await client.websocket.send_text(json.dumps(message))
            except Exception as e:
                self.log(f"Failed to send to {client_id}: {str(e)}", "ERROR")

    async def _broadcast(self, message: dict, exclude: str = None):
        """Broadcast message to all connected clients"""
        for client_id, client in self.clients.items():
            if client_id != exclude:
                try:
                    await client.websocket.send_text(json.dumps(message))
                except Exception:
                    pass


# Global server instance
nexus_server = NexusServer()
app = nexus_server.app
