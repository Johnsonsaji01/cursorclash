# CursorClash

A playable, shared-arena multiplayer cursor game. Every player can see the others' cursors, move around one page, select weapons, attack opponents, and compete for eliminations. All players have **100 health and 100 mana**. Mana regenerates by **10 per second**. Health regenerates by 3 per second after 5 seconds without taking damage.

**No WebSockets, Socket.IO or Server-Sent Events** are used anywhere. The browser sends a JSON `POST /api/sync` using HTTP `fetch()` every 75 ms. Each response contains the authoritative player positions and game events. Other players' movement is interpolated in the browser for smoother animation.

## Play locally

Requirements: Node.js 20 or newer. No third-party packages or npm install are needed.

```bash
node server.js
```

Open **http://localhost:3000**. To test multiplayer, open the URL in two browser tabs. For other computers on the same network, use `http://YOUR_SERVER_IP:3000` and ensure port 3000 is reachable.

## Coolify / Docker deployment

The included `Dockerfile` is ready for a Git-based Coolify deployment:

1. Create a Git repository and upload the files in this folder, preserving the `public/` directory.
2. In Coolify, choose **New Resource → Application → your Git repository** and select **Dockerfile** as the build pack.
3. Set the application port to **3000** (the app listens on `0.0.0.0:3000` by default).
4. Assign your domain and deploy. Coolify's reverse proxy can forward normal HTTP requests to the container; no WebSocket configuration is required.
5. Open the domain from two browsers to play together. HTTPS is recommended for public deployments.

The app has a `GET /api/health` endpoint for health checks.

Alternatively, build and run manually:

```bash
docker build -t cursorclash .
docker run -d --name cursorclash -p 3000:3000 --restart unless-stopped cursorclash
```

## Controls

- Move your mouse or touch the playfield to move your cursor.
- **Click/tap** to attack; the server selects the nearest living opponent inside your weapon's range (or everyone nearby for Nova).
- Press **1**, **2**, **3**, **4** to switch weapons; **Space** also attacks.
- The server enforces mana costs, damage, cooldowns, eliminations, and 3-second respawns.

| Weapon | Mana | Damage | Range (game units) | Cooldown | Effect |
|:--|--:|--:|--:|--:|:--|
| Spark | 10 | 14 | 250 | 280 ms | Fast strike to nearest enemy |
| Lance | 24 | 34 | 380 | 780 ms | Longer-range precision strike |
| Nova | 36 | 27 | 155 | 1050 ms | Area effect: damages all enemies in range |
| Phantom | 50 | 70 | 520 | 1550 ms | High-damage long-range strike |

An attack consumes mana even if there is no opponent in range. If a weapon is on cooldown or you lack mana, the server rejects the attack without spending mana. Weapons do not cause graphic violence; effects are abstract, glowing cursor lines/rings.

## Architecture

```
Browser A ── HTTP POST /api/sync ──┐
Browser B ── HTTP POST /api/sync ──┤  Node.js server
Browser C ── HTTP POST /api/sync ──┘  authoritative game state in RAM
```

Routes:
- `GET /` — game
- `POST /api/join` — create a player and issue a session token
- `POST /api/sync` — submit cursor position, selected weapon, queued attacks, and last event ID; receive world snapshot and new events
- `POST /api/leave` — remove a player
- `GET /api/health` — server status

The server uses the built-in `node:http` module. No external backend services are required. Sessions and scores exist only in memory, so restarting the server resets the arena. Players absent for 15 seconds are removed. The app is intended for a **single running server instance** (do not horizontally scale without adding shared session/game state). There is a default limit of 60 simultaneous players, but sustained performance depends on server/network capacity, especially with 75 ms polling.

## Configuration

- `PORT`: default `3000`
- `HOST`: default `0.0.0.0`
- Player cap, arena size, regen and weapon stats can be changed near the top of `server.js` (and matching client weapon display data in `public/app.js`/`index.html`).

## Notes

- No accounts, chat, authentication passwords, cookies or database.
- Player names are validated and UI player names are inserted as text, not HTML.
- Session tokens prevent other clients from simply impersonating a player by ID.
- The game is a starting point for private or small public play; production-scale hosting would benefit from stronger API rate-limiting, server-side movement validation, and monitoring.
