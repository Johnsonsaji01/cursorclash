# CursorClash

Real-time multiplayer cursor battle. Everyone is a cursor: hit nearby cursors, heal when low, scribble messages that fade, and build walls the others can't cross.

- Plain HTTP polling, **no WebSockets**, **no npm dependencies** (Node 20+).
- The game fills the whole browser window; the shared arena is stretched to fit every player's window.
- Served at `/` and also under `/cursorclash/` (with or without a reverse proxy that strips the prefix).

## How a visit works

1. **Quick human check** – type a name and press-and-hold the button for a second.
2. **Menu** – your own private room (nobody else is ever in it, and it isn't a world). Hold your cursor inside a portal for **2.5 seconds** to travel. Click the 🎨 **Customise** object to change your name and colour (free, any time) and the 🛒 **Shop** object to spend coins. The portal at the top is a **random world**; below it is one portal per public world (with live player counts); the **Private world** portal creates an invite-only world.
3. **Pick a colour** – 30 colours, per world. Colours already used by other players are greyed out and crossed out. The server re-checks on join, so two people can't take the same colour.
4. **Fight.**

### Worlds

| Kind | Rules |
| --- | --- |
| Menu | A solo room per player – no other players, ink only, closes when you leave. |
| Public world ("World 1", "World 2", …) | Max **30** players. **World 1 always has bots** to fight: 5 bots minus the number of players, so a world with 5 or more players has none (`BOT_COUNT`). When a public world goes over **20** players and no other public world has room below that, a new one is generated. Empty extra worlds are removed after 2 minutes (World 1 always stays). |
| Private world | Invite link only (`/cursorclash/?w=CODE`). Max 30. **Deleted when only one player has been inside for over 5 minutes** (or when empty for 1 minute). The lone player sees a countdown and a "Copy invite link" button. Max 3 open per network. |

## Controls

| Input | Action |
| --- | --- |
| 1 – 9 | Select a hotbar slot. Slot 1 = fist, 2 = ink, 3 = blocks to begin with – you can rearrange them, but those 3 tools always stay on the hotbar |
| Click / Space | Use the held slot: fist attacks everything in range (5 mana); item slots use the item |
| H / right-click | Heal 35 HP for 25 mana, 4.5 s cooldown |
| D / B | Toggle the ink / block-wall tool (cosmetic ink; walls cost mana by length and last 5 s) |
| Q | Cycle shape: freehand, line, box, circle |
| E | Inventory – click an item, then a slot, to arrange your hotbar (slots 4–9 hold shop items) |
| Esc | Back to the fist / close a window |

Touch devices get Heal / Ink / Block / Shape buttons and a tappable hotbar.

## Coins, the shop and items

- Gold coins appear at random in the worlds (never in the menu) and are picked up by moving over them. Everyone starts with 20 coins. Coins and items belong to a **profile** (a secret id kept in the browser's local storage and in the server's data folder) – clearing the browser data loses the profile.
- Buy items in the menu's shop; they go into the inventory (27 slots) and can be arranged on hotbar slots 4–9. Each item is used up when used.
- **Invisibility** (15 🪙) – other players can't see your cursor for 20 s. **TNT** (30 🪙) – lit at your cursor, 3 s fuse, then shoves everyone but you away and deals 35 damage in a 220-unit radius. **Image paster** (40 🪙) – you give a link when buying; when used, click and drag to size the picture (bigger = more mana). It appears tinted in your colour for everyone and disappears after 10 s.
- The server downloads pasted pictures itself (public web addresses only, PNG/JPEG/GIF/WebP, ≤ 1.5 MB, ≤ 4096 px) and serves them from its own address, so players' browsers never contact the link. Every purchase is logged under *image*; the admin can block websites or purge all stored pictures.
- **Everything is editable in Admin → Shop**: per-item on/off, price, and every property (invisibility time, TNT fuse/radius/damage/push, picture lifetime/size/mana cost), the coin economy (starting coins, coin value, spawn rate and lifetime) and blocked image sites. Settings also has `BOT_COUNT`, `PORTAL_DWELL` and `COIN_R`.

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
npm test             # 96 tests: game rules, walls, worlds, colours, bots, coins, shop, items, bot protection, admin portal
```

Environment variables (all optional): `PORT`, `SECRET` (keeps tickets valid across restarts), `TURNSTILE_SITEKEY`, `TURNSTILE_SECRET`, `TRUST_PROXY`, `HUMAN_CHECK`, `POW_BITS`, `MAX_PLAYERS_PER_IP`, `MAX_PLAYERS`, `PUBLIC_SPAWN_AT`, `PRIVATE_SOLO_SEC`, `DATA_DIR`, `ADMIN_INITIAL_PASSWORD`, `ADMIN_MAX_ATTEMPTS`, `ADMIN_LOCK_SEC`.

## Admin portal (`/admin`)

Open `https://your-site/admin` (or `/cursorclash/admin`).

- **First login:** the starting password is `2468`. Signing in with it only opens a "choose a new password" screen (8+ characters, not `2468`); nothing else in the portal works until you set one. **Do this straight after deploying** – whoever reaches `/admin` first with `2468` can claim it. To avoid that window, set `ADMIN_INITIAL_PASSWORD` to something private before the first start.
- **Lockout:** 5 wrong passwords from one network (IPv4 address or IPv6 /64) lock it out for 15 minutes (`ADMIN_MAX_ATTEMPTS`, `ADMIN_LOCK_SEC`). The correct password is refused during the lock. A signed-in admin can lift a lock from *Security*.
- **Session:** HttpOnly + SameSite=Strict cookie, 12 hours sliding, every request needs a custom header. Changing the password signs out all other sessions. The admin is not affected by game bans.

| Tab | What you get |
| --- | --- |
| Overview | Players online, lobby / public / private counts, worlds open, 24 h peak, active bans, a 24 h players chart, busiest worlds, event counts, latest activity |
| Players | Every connected player with world, IP, kills/deaths, time online; **Kick** or **Ban** (minutes) |
| Worlds | Every world with counts; **close** a world, **create** a public world, **broadcast** a message to one world or all |
| Logs | Everything from the last 24 h (joins, leaves, kills, portals, worlds opening/closing, private worlds, human-check passes/failures, join refusals, rate limits, strikes, bans, admin logins/failures/lockouts, admin actions). Filter by type, text/IP and time; export CSV/JSON; clear |
| Security | Ban any IP (timed or permanent), active bans with unban, auto-clicker strikes, admin lockouts with unlock, status of human check / Turnstile / rate limits |
| Shop | Item prices, on/off and properties, the coin economy, blocked image sites, purge stored pictures; give coins to a player (Players tab) |
| Settings | **Maintenance mode** (blocks new joins with your message, optional kick-all), live game settings (max players, spawn threshold, solo-private timeout, per-network limits, ban length, damage, heal, mana regen, respawn), change password, kick everyone |

**Persistence:** the password, bans, settings (including the shop), player profiles/coins/inventories, pasted pictures, maintenance flag and log are stored as JSON in `DATA_DIR` (default `./data`, `/app/data` in the Docker image). In Coolify add a **persistent storage** volume mounted at `/app/data`; without one a redeploy resets the password to `2468` and empties the log (the portal shows a red "Not saving to disk" badge when that is the case). To reset a forgotten password, delete `admin.json` from the data folder and restart.

## Deploy (Coolify, Dockerfile build pack)

Point the application at this repository, build with the included `Dockerfile`, and set the exposed port to `3000`. `GET /healthz` returns `ok`. All state is in memory, so run a single instance. Set `SECRET` to any long random string so players aren't asked to re-verify after a redeploy. Add a persistent storage volume at `/app/data` for the admin portal, player profiles and pasted pictures.

## Layout

```
server.js        HTTP routing, config defaults, security in front of every API call
lib/hub.js       worlds: menu rooms, public, private; portals; joining; colour checks; cleanup
lib/world.js     one room: combat, bots, coins, items, ink, block walls, collision, portal dwell
lib/shop.js      item/economy definitions and validation (editable from the admin)
lib/profiles.js  coins, inventory and hotbar per player profile
lib/images.js    safe image download + storage for the image paster
lib/security.js  human check, tickets, rate limits, bans, optional Turnstile
lib/admin.js     admin portal: login/lockout, 24 h log, stats, actions, persistence
lib/geometry.js  wall/collision maths (the page carries an identical copy)
lib/colors.js    the 30 colours
public/index.html  the whole client
public/admin.html  the admin portal page
tools/bot.js     fills a local server with test players (needs HUMAN_CHECK=off)
```

## Fill a local server with test players

```
HUMAN_CHECK=off MAX_PLAYERS_PER_IP=50 npm start
node tools/bot.js http://localhost:3000 5 w1
```
