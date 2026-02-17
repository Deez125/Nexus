"""
Nexus Server Web Dashboard - HTML/JS dashboard served via FastAPI
"""

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter()

DASHBOARD_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NEXUS Server Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: 'JetBrains Mono', monospace;
            background: #0a0a0a;
            color: #e0e0e0;
            min-height: 100vh;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
        }

        /* Header */
        .header {
            background: #111;
            border: 1px solid #222;
            border-radius: 8px;
            padding: 20px 24px;
            margin-bottom: 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .header h1 {
            font-size: 24px;
            font-weight: 700;
            color: #00ffff;
            letter-spacing: 2px;
        }

        .header .subtitle {
            font-size: 12px;
            color: #666;
            margin-top: 4px;
        }

        .status-badge {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            background: rgba(0, 255, 100, 0.1);
            border: 1px solid rgba(0, 255, 100, 0.3);
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            color: #00ff64;
        }

        .status-dot {
            width: 8px;
            height: 8px;
            background: #00ff64;
            border-radius: 50%;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        /* Grid layout */
        .grid {
            display: grid;
            grid-template-columns: 300px 1fr;
            gap: 20px;
        }

        /* Stats panel */
        .stats-panel {
            background: #111;
            border: 1px solid #222;
            border-radius: 8px;
            padding: 20px;
        }

        .stats-title {
            font-size: 11px;
            font-weight: 600;
            color: #00ffff;
            letter-spacing: 1px;
            margin-bottom: 16px;
        }

        .stat-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 0;
            border-bottom: 1px solid #1a1a1a;
        }

        .stat-row:last-child {
            border-bottom: none;
        }

        .stat-label {
            color: #888;
            font-size: 12px;
        }

        .stat-value {
            color: #00ff64;
            font-size: 14px;
            font-weight: 600;
        }

        /* Clients panel */
        .clients-panel {
            background: #111;
            border: 1px solid #222;
            border-radius: 8px;
            padding: 20px;
            margin-top: 20px;
        }

        .client-row {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 12px;
            background: #0a0a0a;
            border-radius: 6px;
            margin-bottom: 8px;
        }

        .client-header {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .client-avatar {
            width: 32px;
            height: 32px;
            background: linear-gradient(135deg, #7c6aef, #00ffff);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            font-weight: 700;
            color: #fff;
            flex-shrink: 0;
        }

        .client-info {
            flex: 1;
            min-width: 0;
        }

        .client-name {
            font-size: 13px;
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .client-id {
            font-size: 10px;
            color: #666;
            margin-top: 2px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .client-badges {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
        }

        .badge {
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 9px;
            font-weight: 600;
            text-transform: uppercase;
            white-space: nowrap;
        }

        .badge-call {
            background: rgba(0, 255, 100, 0.15);
            color: #00ff64;
        }

        .badge-audio {
            background: rgba(96, 165, 250, 0.15);
            color: #60a5fa;
        }

        .badge-video {
            background: rgba(244, 114, 182, 0.15);
            color: #f472b6;
        }

        .badge-screen {
            background: rgba(251, 191, 36, 0.15);
            color: #fbbf24;
        }

        .no-clients {
            color: #666;
            font-size: 12px;
            text-align: center;
            padding: 20px;
        }

        /* Terminal */
        .terminal-panel {
            background: #0a0a0a;
            border: 1px solid #222;
            border-radius: 8px;
            display: flex;
            flex-direction: column;
            height: calc(100vh - 140px);
        }

        .terminal-header {
            padding: 12px 16px;
            border-bottom: 1px solid #222;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .terminal-title {
            font-size: 11px;
            font-weight: 600;
            color: #00ffff;
            letter-spacing: 1px;
        }

        .terminal-body {
            flex: 1;
            overflow-y: auto;
            padding: 12px 16px;
            font-size: 12px;
            line-height: 1.6;
        }

        .log-entry {
            margin-bottom: 2px;
        }

        .log-info { color: #00ff64; }
        .log-warn { color: #fbbf24; }
        .log-error { color: #ef4444; }
        .log-default { color: #00ff64; }

        /* Footer */
        .footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 16px;
            background: #111;
            border: 1px solid #222;
            border-radius: 8px;
            margin-top: 20px;
            font-size: 11px;
            color: #666;
        }

        /* Responsive */
        @media (max-width: 900px) {
            .grid {
                grid-template-columns: 1fr;
            }
            .terminal-panel {
                height: 400px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>NEXUS</h1>
                <div class="subtitle">Server Control Panel</div>
            </div>
            <div class="status-badge">
                <div class="status-dot"></div>
                ONLINE
            </div>
        </div>

        <div class="grid">
            <div>
                <div class="stats-panel">
                    <div class="stats-title">SERVER STATS</div>
                    <div class="stat-row">
                        <span class="stat-label">Connected Clients</span>
                        <span class="stat-value" id="stat-clients">0</span>
                    </div>
                    <div class="stat-row">
                        <span class="stat-label">In Call</span>
                        <span class="stat-value" id="stat-incall">0</span>
                    </div>
                    <div class="stat-row">
                        <span class="stat-label">Messages Sent</span>
                        <span class="stat-value" id="stat-messages">0</span>
                    </div>
                    <div class="stat-row">
                        <span class="stat-label">Uptime</span>
                        <span class="stat-value" id="stat-uptime">00:00:00</span>
                    </div>
                </div>

                <div class="clients-panel">
                    <div class="stats-title">CONNECTED CLIENTS</div>
                    <div id="clients-list">
                        <div class="no-clients">No clients connected</div>
                    </div>
                </div>
            </div>

            <div class="terminal-panel">
                <div class="terminal-header">
                    <span class="terminal-title">SERVER TERMINAL</span>
                    <span style="color: #666; font-size: 10px;" id="log-count">0 entries</span>
                </div>
                <div class="terminal-body" id="terminal">
                    <div class="log-entry log-info">[STARTUP] Nexus Server Dashboard Connected</div>
                </div>
            </div>
        </div>

        <div class="footer">
            <span id="host-info">Host: Loading...</span>
            <span id="uptime-footer">Uptime: 00:00:00</span>
        </div>
    </div>

    <script>
        // Connect to stats WebSocket
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/dashboard_${Date.now()}`;

        let ws;
        let startTime = Date.now();
        let logCount = 0;

        function connect() {
            ws = new WebSocket(wsUrl);

            ws.onopen = () => {
                console.log('Dashboard connected');
                addLog('[DASHBOARD] Connected to server', 'info');
            };

            ws.onclose = () => {
                console.log('Dashboard disconnected, reconnecting...');
                addLog('[DASHBOARD] Disconnected, reconnecting...', 'warn');
                setTimeout(connect, 3000);
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    handleMessage(data);
                } catch (e) {
                    console.error('Failed to parse message:', e);
                }
            };
        }

        function handleMessage(data) {
            // Handle different message types for dashboard updates
            switch (data.type) {
                case 'connected':
                    // We're a dashboard client, request stats
                    break;
                case 'user_joined':
                    addLog(`[JOIN] ${data.username} connected`, 'info');
                    break;
                case 'user_left':
                    addLog(`[LEAVE] ${data.username} disconnected`, 'info');
                    break;
                case 'call_user_joined':
                    addLog(`[CALL] ${data.username} joined call`, 'info');
                    break;
                case 'call_user_left':
                    addLog(`[CALL] ${data.username} left call`, 'info');
                    break;
                case 'chat':
                    addLog(`[CHAT] ${data.username}: ${data.content.substring(0, 50)}${data.content.length > 50 ? '...' : ''}`, 'default');
                    break;
            }
        }

        function addLog(message, level = 'default') {
            const terminal = document.getElementById('terminal');
            const entry = document.createElement('div');
            entry.className = `log-entry log-${level}`;
            entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
            terminal.appendChild(entry);
            terminal.scrollTop = terminal.scrollHeight;

            logCount++;
            document.getElementById('log-count').textContent = `${logCount} entries`;
        }

        // Poll stats endpoint
        async function fetchStats() {
            try {
                const response = await fetch('/api/stats');
                const stats = await response.json();

                document.getElementById('stat-clients').textContent = stats.clients;
                document.getElementById('stat-incall').textContent = stats.in_call;
                document.getElementById('stat-messages').textContent = stats.messages;

                // Update clients list
                const clientsList = document.getElementById('clients-list');
                if (stats.client_list && stats.client_list.length > 0) {
                    clientsList.innerHTML = stats.client_list.map(client => `
                        <div class="client-row">
                            <div class="client-header">
                                <div class="client-avatar">${client.username.charAt(0).toUpperCase()}</div>
                                <div class="client-info">
                                    <div class="client-name">${client.username}</div>
                                    <div class="client-id">${client.id.substring(0, 16)}...</div>
                                </div>
                            </div>
                            <div class="client-badges">
                                ${client.in_call ? '<span class="badge badge-call">In Call</span>' : '<span class="badge" style="background: rgba(100,100,100,0.15); color: #666;">Not in Call</span>'}
                                ${client.has_audio ? '<span class="badge badge-audio">Audio On</span>' : '<span class="badge" style="background: rgba(100,100,100,0.15); color: #666;">Audio Off</span>'}
                                ${client.has_video ? '<span class="badge badge-video">Video On</span>' : '<span class="badge" style="background: rgba(100,100,100,0.15); color: #666;">Video Off</span>'}
                                ${client.has_screen ? '<span class="badge badge-screen">Screen</span>' : ''}
                            </div>
                        </div>
                    `).join('');
                } else {
                    clientsList.innerHTML = '<div class="no-clients">No clients connected</div>';
                }

            } catch (e) {
                console.error('Failed to fetch stats:', e);
            }
        }

        // Update uptime
        function updateUptime() {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            const hours = Math.floor(elapsed / 3600).toString().padStart(2, '0');
            const minutes = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
            const seconds = (elapsed % 60).toString().padStart(2, '0');
            const uptime = `${hours}:${minutes}:${seconds}`;

            document.getElementById('stat-uptime').textContent = uptime;
            document.getElementById('uptime-footer').textContent = `Uptime: ${uptime}`;
        }

        // Update host info
        document.getElementById('host-info').textContent = `Host: ${window.location.host}`;

        // Start everything
        connect();
        fetchStats();
        setInterval(fetchStats, 2000);
        setInterval(updateUptime, 1000);
    </script>
</body>
</html>
"""

@router.get("/", response_class=HTMLResponse)
async def get_dashboard():
    """Serve the dashboard HTML page"""
    return DASHBOARD_HTML
