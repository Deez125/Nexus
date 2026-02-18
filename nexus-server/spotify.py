"""
Spotify OAuth and API integration for Nexus
"""

import os
import base64
import httpx
from typing import Optional
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import RedirectResponse

router = APIRouter(prefix="/api/spotify", tags=["spotify"])

# Spotify OAuth settings
SPOTIFY_CLIENT_ID = "901552e5f38e47cba01d767dd6a75ea7"
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "9cee60d961ae4e9183194e0d248f05df")
SPOTIFY_REDIRECT_URI_LOCAL = "http://localhost:5173/callback"
SPOTIFY_REDIRECT_URI_PROD = "https://pulpfliction.com/callback"

# Spotify API endpoints
SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize"
SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"
SPOTIFY_API_BASE = "https://api.spotify.com/v1"

# Required scopes for full playback control
SPOTIFY_SCOPES = [
    "streaming",
    "user-read-email",
    "user-read-private",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
    "playlist-read-private",
    "playlist-read-collaborative",
    "user-library-read",
]

# Store tokens in memory (in production, use a proper database)
tokens: dict = {}


def get_redirect_uri(is_local: bool = False) -> str:
    """Get the appropriate redirect URI based on environment"""
    return SPOTIFY_REDIRECT_URI_LOCAL if is_local else SPOTIFY_REDIRECT_URI_PROD


@router.get("/login")
async def spotify_login(local: bool = Query(default=False)):
    """Redirect to Spotify authorization page"""
    redirect_uri = get_redirect_uri(local)
    scope = " ".join(SPOTIFY_SCOPES)

    auth_url = (
        f"{SPOTIFY_AUTH_URL}?"
        f"client_id={SPOTIFY_CLIENT_ID}&"
        f"response_type=code&"
        f"redirect_uri={redirect_uri}&"
        f"scope={scope}&"
        f"show_dialog=true"
    )

    return {"auth_url": auth_url}


@router.get("/callback")
async def spotify_callback(code: str, local: bool = Query(default=False)):
    """Handle OAuth callback and exchange code for tokens"""
    redirect_uri = get_redirect_uri(local)

    # Prepare token request
    auth_header = base64.b64encode(
        f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode()
    ).decode()

    headers = {
        "Authorization": f"Basic {auth_header}",
        "Content-Type": "application/x-www-form-urlencoded",
    }

    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
    }

    async with httpx.AsyncClient() as client:
        response = await client.post(SPOTIFY_TOKEN_URL, headers=headers, data=data)

        if response.status_code != 200:
            raise HTTPException(status_code=400, detail="Failed to get access token")

        token_data = response.json()

        # Store tokens
        tokens["access_token"] = token_data["access_token"]
        tokens["refresh_token"] = token_data.get("refresh_token")
        tokens["expires_in"] = token_data["expires_in"]

        return {
            "access_token": token_data["access_token"],
            "expires_in": token_data["expires_in"],
        }


@router.post("/refresh")
async def refresh_token():
    """Refresh the access token"""
    if "refresh_token" not in tokens:
        raise HTTPException(status_code=400, detail="No refresh token available")

    auth_header = base64.b64encode(
        f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode()
    ).decode()

    headers = {
        "Authorization": f"Basic {auth_header}",
        "Content-Type": "application/x-www-form-urlencoded",
    }

    data = {
        "grant_type": "refresh_token",
        "refresh_token": tokens["refresh_token"],
    }

    async with httpx.AsyncClient() as client:
        response = await client.post(SPOTIFY_TOKEN_URL, headers=headers, data=data)

        if response.status_code != 200:
            raise HTTPException(status_code=400, detail="Failed to refresh token")

        token_data = response.json()
        tokens["access_token"] = token_data["access_token"]

        return {
            "access_token": token_data["access_token"],
            "expires_in": token_data["expires_in"],
        }


@router.get("/token")
async def get_token():
    """Get current access token (for frontend)"""
    if "access_token" not in tokens:
        return {"access_token": None}
    return {"access_token": tokens["access_token"]}


@router.get("/me")
async def get_current_user():
    """Get current user's Spotify profile"""
    if "access_token" not in tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{SPOTIFY_API_BASE}/me",
            headers={"Authorization": f"Bearer {tokens['access_token']}"}
        )

        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail="Failed to get user")

        return response.json()


@router.get("/playlists")
async def get_playlists():
    """Get user's playlists"""
    if "access_token" not in tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{SPOTIFY_API_BASE}/me/playlists?limit=50",
            headers={"Authorization": f"Bearer {tokens['access_token']}"}
        )

        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail="Failed to get playlists")

        return response.json()


@router.get("/player")
async def get_player_state():
    """Get current playback state"""
    if "access_token" not in tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{SPOTIFY_API_BASE}/me/player",
            headers={"Authorization": f"Bearer {tokens['access_token']}"}
        )

        if response.status_code == 204:
            return {"is_playing": False, "item": None}

        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail="Failed to get player state")

        return response.json()


@router.put("/player/play")
async def play(uri: Optional[str] = None, context_uri: Optional[str] = None):
    """Start or resume playback"""
    if "access_token" not in tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    body = {}
    if context_uri:
        body["context_uri"] = context_uri
    if uri:
        body["uris"] = [uri]

    async with httpx.AsyncClient() as client:
        response = await client.put(
            f"{SPOTIFY_API_BASE}/me/player/play",
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
            json=body if body else None
        )

        if response.status_code not in [200, 204]:
            raise HTTPException(status_code=response.status_code, detail="Failed to play")

        return {"status": "playing"}


@router.put("/player/pause")
async def pause():
    """Pause playback"""
    if "access_token" not in tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    async with httpx.AsyncClient() as client:
        response = await client.put(
            f"{SPOTIFY_API_BASE}/me/player/pause",
            headers={"Authorization": f"Bearer {tokens['access_token']}"}
        )

        if response.status_code not in [200, 204]:
            raise HTTPException(status_code=response.status_code, detail="Failed to pause")

        return {"status": "paused"}


@router.post("/player/next")
async def next_track():
    """Skip to next track"""
    if "access_token" not in tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{SPOTIFY_API_BASE}/me/player/next",
            headers={"Authorization": f"Bearer {tokens['access_token']}"}
        )

        if response.status_code not in [200, 204]:
            raise HTTPException(status_code=response.status_code, detail="Failed to skip")

        return {"status": "skipped"}


@router.post("/player/previous")
async def previous_track():
    """Go to previous track"""
    if "access_token" not in tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{SPOTIFY_API_BASE}/me/player/previous",
            headers={"Authorization": f"Bearer {tokens['access_token']}"}
        )

        if response.status_code not in [200, 204]:
            raise HTTPException(status_code=response.status_code, detail="Failed to go previous")

        return {"status": "previous"}


@router.put("/player/shuffle")
async def set_shuffle(state: bool):
    """Toggle shuffle"""
    if "access_token" not in tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    async with httpx.AsyncClient() as client:
        response = await client.put(
            f"{SPOTIFY_API_BASE}/me/player/shuffle?state={str(state).lower()}",
            headers={"Authorization": f"Bearer {tokens['access_token']}"}
        )

        if response.status_code not in [200, 204]:
            raise HTTPException(status_code=response.status_code, detail="Failed to set shuffle")

        return {"shuffle": state}


@router.put("/player/repeat")
async def set_repeat(state: str):
    """Set repeat mode (track, context, off)"""
    if "access_token" not in tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    async with httpx.AsyncClient() as client:
        response = await client.put(
            f"{SPOTIFY_API_BASE}/me/player/repeat?state={state}",
            headers={"Authorization": f"Bearer {tokens['access_token']}"}
        )

        if response.status_code not in [200, 204]:
            raise HTTPException(status_code=response.status_code, detail="Failed to set repeat")

        return {"repeat": state}


@router.put("/player/volume")
async def set_volume(volume_percent: int):
    """Set volume (0-100)"""
    if "access_token" not in tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    async with httpx.AsyncClient() as client:
        response = await client.put(
            f"{SPOTIFY_API_BASE}/me/player/volume?volume_percent={volume_percent}",
            headers={"Authorization": f"Bearer {tokens['access_token']}"}
        )

        if response.status_code not in [200, 204]:
            raise HTTPException(status_code=response.status_code, detail="Failed to set volume")

        return {"volume": volume_percent}


@router.put("/player/seek")
async def seek(position_ms: int):
    """Seek to position in track"""
    if "access_token" not in tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    async with httpx.AsyncClient() as client:
        response = await client.put(
            f"{SPOTIFY_API_BASE}/me/player/seek?position_ms={position_ms}",
            headers={"Authorization": f"Bearer {tokens['access_token']}"}
        )

        if response.status_code not in [200, 204]:
            raise HTTPException(status_code=response.status_code, detail="Failed to seek")

        return {"position_ms": position_ms}


@router.get("/search")
async def search(q: str, type: str = "track,album,artist", limit: int = 20):
    """Search Spotify for tracks, albums, and artists"""
    if "access_token" not in tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{SPOTIFY_API_BASE}/search?q={q}&type={type}&limit={limit}",
            headers={"Authorization": f"Bearer {tokens['access_token']}"}
        )

        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail="Search failed")

        return response.json()


@router.get("/artist/{artist_id}")
async def get_artist(artist_id: str):
    """Get artist details"""
    if "access_token" not in tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{SPOTIFY_API_BASE}/artists/{artist_id}",
            headers={"Authorization": f"Bearer {tokens['access_token']}"}
        )

        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail="Failed to get artist")

        return response.json()


@router.get("/artist/{artist_id}/albums")
async def get_artist_albums(artist_id: str):
    """Get artist's albums and singles"""
    if "access_token" not in tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Request albums, singles, and compilations explicitly
    url = f"{SPOTIFY_API_BASE}/artists/{artist_id}/albums?include_groups=album,single,compilation"
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}

    async with httpx.AsyncClient() as client:
        # Make multiple requests to get more albums
        all_items = []
        response = await client.get(url, headers=headers)

        if response.status_code != 200:
            print(f"Spotify albums error: {response.status_code} - {response.text}")
            raise HTTPException(status_code=response.status_code, detail=f"Failed to get artist albums: {response.text}")

        data = response.json()
        all_items.extend(data.get("items", []))

        # Get next page if available
        next_url = data.get("next")
        if next_url:
            response2 = await client.get(next_url, headers=headers)
            if response2.status_code == 200:
                data2 = response2.json()
                all_items.extend(data2.get("items", []))

        return {"items": all_items}


@router.get("/album/{album_id}")
async def get_album(album_id: str):
    """Get album details with tracks"""
    if "access_token" not in tokens:
        raise HTTPException(status_code=401, detail="Not authenticated")

    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{SPOTIFY_API_BASE}/albums/{album_id}",
            headers={"Authorization": f"Bearer {tokens['access_token']}"}
        )

        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail="Failed to get album")

        return response.json()


# =============================================================================
# Spotify Bot Endpoints - Control the bot that joins calls to stream music
# =============================================================================

@router.post("/bot/start")
async def start_bot():
    """Start the Spotify bot"""
    from spotify_bot import get_bot

    bot = await get_bot()
    success = await bot.start()

    if success:
        return {"status": "started", "message": "Spotify bot started successfully"}
    else:
        raise HTTPException(status_code=500, detail="Failed to start bot")


@router.post("/bot/stop")
async def stop_bot():
    """Stop the Spotify bot"""
    from spotify_bot import get_bot

    bot = await get_bot()
    await bot.stop()

    return {"status": "stopped", "message": "Spotify bot stopped"}


@router.post("/bot/join")
async def bot_join_call():
    """Make the bot join the voice call"""
    from spotify_bot import get_bot

    bot = await get_bot()

    if not bot.state.is_running:
        # Auto-start if not running
        success = await bot.start()
        if not success:
            raise HTTPException(status_code=500, detail="Failed to start bot")

    success = await bot.join_call()

    if success:
        return {"status": "joined", "message": "Bot joined the call"}
    else:
        raise HTTPException(status_code=500, detail="Failed to join call")


@router.post("/bot/leave")
async def bot_leave_call():
    """Make the bot leave the voice call"""
    from spotify_bot import get_bot

    bot = await get_bot()
    await bot.leave_call()

    return {"status": "left", "message": "Bot left the call"}


@router.get("/bot/status")
async def get_bot_status():
    """Get the current bot status"""
    from spotify_bot import get_bot, spotify_bot

    if spotify_bot is None:
        return {
            "is_running": False,
            "is_in_call": False,
            "is_playing": False,
            "current_track": None
        }

    bot = await get_bot()
    return {
        "is_running": bot.state.is_running,
        "is_in_call": bot.state.is_in_call,
        "is_playing": bot.state.is_playing,
        "current_track": bot.state.current_track
    }
