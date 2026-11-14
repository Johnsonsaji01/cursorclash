# CursorClash

Real-time multiplayer cursor battle. Everyone is a cursor: hit nearby cursors, heal when low, scribble messages that fade, and build walls the others can't cross.

- Plain HTTP polling, **no WebSockets**, **no npm dependencies** (Node 20+).
- The game fills the whole browser window; the shared arena is stretched to fit every player's window.
- Served at `/` and also under `/cursorclash/` (with or without a reverse proxy that strips the prefix).

## How a visit works

1. **Quick human check** – type a name and press-and-hold the button for a second.
2. **Lobby** – a peaceful hall. Hold your cursor inside a portal for **5 seconds** to travel. The portal at the top is a **random world**; below it is one portal per public world (with live player counts); the **Private world** portal creates an invite-only world.
3. **Pick a colour** – 30 colours, per world. Colours already used by other players are greyed out and crossed out. The server re-checks on join, so two people can't take the same colour.
4. **Fight.**

### Worlds

| Kind | Rules |
| --- | --- |
| Lobby | Peaceful, ink only. Up to 30 per lobby instance; more instances open automatically. |
| Public world ("World 1", "World 2", …) | Max **30** players. When a public world goes over **20** players and no other public world has room below that, a new one is generated. Empty extra worlds are removed after 2 minutes (World 1 always stays). |
| Private world | Invite link only (`/cursorclash/?w=CODE`). Max 30. **Deleted when only one player has been inside for over 5 minutes** (or when empty for 1 minute). The lone player sees a countdown and a "Copy invite link" button. Max 3 open per network. |

## Controls

| Input | Action |
| --- | --- |
| Click / Space | Attack everything within range of your cursor (5 mana) |
| H / right-click | Heal 35 HP for 25 mana, 4.5 s cooldown |
| D | **Ink** – cosmetic drawing, visible to everyone, fades after 3.5 s, does nothing |
| B | **Block wall** – solid; other players can't cross it (you can); costs mana by length (5 mana per 100 units, cut short if you can't afford it); disappears after 5 s |
| 1 / 2 / 3 / 4 | Freehand / line / box / circle |
| Esc | Stop drawing |

Touch devices get Heal / Ink / Block / Shape buttons; tapping attacks.

## Bot and macro protection

- **Human check** before anything else: a signed challenge, a small proof-of-work solved in the background, and a press-and-hold button. The server checks the proof, minimum time, hold length and that real pointer/keyboard events were involved. Keyboard and touch users pass too. It produces a signed **ticket** (valid 2 h, bound to the visitor's network) that every join needs.
- **Cloudflare Turnstile (recommended for a public site):** set `TURNSTILE_SITEKEY` and `TURNSTILE_SECRET` and Turnstile becomes a required extra step. Without it, a determined script driving a real browser can still pass the built-in check – it is a speed bump, not a wall.
- **Per-network limits:** challenge/verify/join/request rates, 4 simultaneous players, 3 private worlds.
- **In-game:** a cursor speed cap, and an auto-clicker detector (40 attacks without the cursor moving). A flagged player is removed, their ticket revoked and they must pass the check again; 3 flags in 10 minutes bans the network for 10 minutes.
- Security headers (CSP, no-referrer so invite codes don't leak, no framing).

Behind Cloudflare/Traefik the visitor's address is read from `CF-Connecting-IP` / `X-Forwarded-For`. If the app is ever exposed directly to the internet, set `TRUST_PROXY=0`.

## Run

```
npm start            # http://localhost:3000   (PORT env var changes the port)
npm test             # 50 tests: game rules, walls, worlds, colours, bot protection
```

Environment variables (all optional): `PORT`, `SECRET` (keeps tickets valid across restarts), `TURNSTILE_SITEKEY`, `TURNSTILE_SECRET`, `TRUST_PROXY`, `HUMAN_CHECK`, `POW_BITS`, `MAX_PLAYERS_PER_IP`, `MAX_PLAYERS`, `PUBLIC_SPAWN_AT`, `PRIVATE_SOLO_SEC`.

## Deploy (Coolify, Dockerfile build pack)

Point the application at this repository, build with the included `Dockerfile`, and set the exposed port to `3000`. `GET /healthz` returns `ok`. All state is in memory, so run a single instance. Set `SECRET` to any long random string so players aren't asked to re-verify after a redeploy.

## Layout

```
server.js        HTTP routing, config defaults, security in front of every API call
lib/hub.js       worlds: lobby, public, private; portals; joining; colour checks; cleanup
lib/world.js     one room: combat, healing, ink, block walls, collision, portal dwell
lib/security.js  human check, tickets, rate limits, bans, optional Turnstile
lib/geometry.js  wall/collision maths (the page carries an identical copy)
lib/colors.js    the 30 colours
public/index.html  the whole client
tools/bot.js     fills a local server with test players (needs HUMAN_CHECK=off)
```

## Fill a local server with test players

```
HUMAN_CHECK=off MAX_PLAYERS_PER_IP=50 npm start
node tools/bot.js http://localhost:3000 5 w1
```
