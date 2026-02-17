"""
Nexus Server - Main Entry Point
Real-time chat and WebRTC signaling server
"""

import sys
import os
from datetime import datetime

# ASCII Art Banner
NEXUS_BANNER = """
    ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗
    ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝
    ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗
    ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║
    ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║
    ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝

    ==================================================
    |  Real-Time Communication Server  v1.0.0        |
    |  WebSocket Chat + WebRTC Signaling             |
    ==================================================
"""


def print_banner():
    """Print the startup banner to console"""
    print(NEXUS_BANNER)
    print(f"    [*] Starting server at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"    [*] Python {sys.version.split()[0]}")
    print()


def run_server(host: str = "0.0.0.0", port: int = 8765):
    """Run the FastAPI server"""
    import uvicorn
    from server import nexus_server

    def terminal_log(message):
        print(message)

    def terminal_stats(stats):
        pass  # Stats available via /api/stats endpoint

    nexus_server.log_callback = terminal_log
    nexus_server.stats_callback = terminal_stats

    print_banner()
    print(f"    [+] WebSocket endpoint: ws://{host}:{port}/ws/{{client_id}}")
    print(f"    [+] Dashboard: http://{host}:{port}/")
    print(f"    [+] Stats API: http://{host}:{port}/api/stats")
    print()
    print("    " + "=" * 50)
    print()

    uvicorn.run(
        nexus_server.app,
        host=host,
        port=port,
        log_level="info",
    )


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Nexus Server - Real-time communication server")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"), help="Host to bind to (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8765)), help="Port to bind to (default: 8765)")

    args = parser.parse_args()

    run_server(args.host, args.port)
