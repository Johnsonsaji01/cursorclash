# CursorClash

Real-time multiplayer cursor battle. Everyone is a cursor: hit nearby cursors, heal when low, and draw shapes that fade after a few seconds.

- Plain HTTP polling, **no WebSockets**, **no npm dependencies** (Node 20+).
- The game fills the whole browser window; the shared arena is stretched to fit every player's window.
- Served at `/` and also under `/cursorclash/` (with or without a reverse proxy that strips the prefix).

## Controls

| Input | Action |
| --- | --- |
| Click / Space | Attack everything within range of your cursor (5 mana) |
| H / right-click | Heal 35 HP for 25 mana, 4.5 s cooldown |
| D | Toggle draw mode (drawings are visible to everyone and fade after 3.5 s) |
| 1 / 2 / 3 / 4 | Freehand / line / box / circle |
| Esc | Leave draw mode |

Touch devices get Heal / Draw / Shape buttons; tapping attacks.

## Run

```
npm start            # http://localhost:3000   (PORT env var changes the port)
npm test             # two-client multiplayer tests
```

## Deploy (Coolify, Dockerfile build pack)

Point the application at this repository, build with the included `Dockerfile`, and set the exposed port to `3000`. `GET /healthz` returns `ok` for health checks. The game keeps all state in memory, so run a single instance.

## How it works

- `POST /api/join` creates a player and returns a full snapshot.
- `POST /api/sync` (about 18 times a second per player) sends your cursor position and queued actions (attack, heal, drawing points). The response contains every player, your cooldowns, and any events since your last sync.
- The server is authoritative for damage, mana, healing, cooldowns, respawns (2.2 s, then 1.5 s of spawn protection) and drawing lifetime.
- Actions carry increasing ids, so a retried request never applies twice. Players who stop polling for 8 s are removed; a client that was dropped rejoins automatically.

## Optional: fill the arena with test players

```
node tools/bot.js http://localhost:3000 5      # five wandering bots
```
