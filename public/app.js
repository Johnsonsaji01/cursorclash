'use strict';

// HTTP-only multiplayer. No WebSocket, Socket.IO or SSE connections.
const $ = id => document.getElementById(id);
const W = 1600, H = 900;
const WEAPONS = {
  spark: { name: 'SPARK', symbol: '✦', cost: 10, range: 250, cooldown: 280, color: '#74f7dc' },
  lance: { name: 'LANCE', symbol: '⌁', cost: 24, range: 380, cooldown: 780, color: '#79b8ff' },
  nova: { name: 'NOVA', symbol: '◉', cost: 36, range: 155, cooldown: 1050, color: '#ffad7c' },
  phantom: { name: 'PHANTOM', symbol: '⌖', cost: 50, range: 520, cooldown: 1550, color: '#a995ff' },
};
const arena = $('arena');
const canvas = $('gameCanvas');
const ctx = canvas.getContext('2d');
let session = null;
let snapshot = null;
let weapon = 'spark';
let chosenColor = '#74f7dc';
let local = { x: W / 2, y: H / 2 };
let view = new Map();
let visualEffects = [];
let lastEventId = 0;
let sequence = 0;
let pendingActions = [];
let sending = false;
let connected = false;
let lastNetworkAttempt = 0;
let lastNotice = '';
let lastNoticeAt = 0;
let toastTimer = null;
let uiUpdatedAt = 0;
let pointerInside = false;
const feedItems = [];

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const digits = n => String(Math.round(n)).padStart(4, '0');

function showToast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 1900);
}
function connectionStatus(value) {
  connected = value;
  $('arenaConnection').textContent = value ? 'SYNCHRONISED' : session ? 'RECONNECTING...' : 'DISCONNECTED';
  document.querySelector('.strip-dot').classList.toggle('connected', value);
}
function setWeapon(id) {
  if (!WEAPONS[id]) return;
  weapon = id;
  document.querySelectorAll('.weapon').forEach(el => {
    el.classList.toggle('selected', el.dataset.weapon === id);
    el.setAttribute('aria-pressed', String(el.dataset.weapon === id));
  });
  const w = WEAPONS[id];
  $('selectedWeaponLabel').textContent = `${w.symbol} ${w.name}`;
  $('selectedWeaponLabel').style.color = w.color;
}
document.querySelectorAll('.weapon').forEach(el => el.addEventListener('click', () => setWeapon(el.dataset.weapon)));

document.querySelectorAll('.color-choice').forEach(el => el.addEventListener('click', () => {
  chosenColor = el.dataset.color;
  document.querySelectorAll('.color-choice').forEach(choice => choice.classList.toggle('active', choice === el));
}));

try { $('nickname').value = localStorage.getItem('cursorclash_name') || ''; } catch {}
$('nickname').value ||= `Cursor${Math.floor(100 + Math.random() * 900)}`;

async function post(path, payload, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('/cursorclash' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: controller.signal, cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) {
      const e = new Error(body.error || `HTTP ${response.status}`);
      e.status = response.status;
      throw e;
    }
    return body;
  } finally { clearTimeout(timer); }
}

$('joinForm').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('nickname').value.trim();
  const button = $('joinButton');
  button.disabled = true;
  button.querySelector('span').textContent = 'CONNECTING...';
  $('joinError').textContent = '';
  try {
    const joined = await post('/api/join', { name, color: chosenColor });
    session = { id: joined.id, token: joined.token };
    snapshot = { me: joined.player, players: [joined.player], online: 1, now: Date.now() };
    local = { x: joined.player.x, y: joined.player.y };
    view = new Map();
    lastEventId = joined.eventId;
    sequence = 0;
    pendingActions = [];
    feedItems.length = 0;
    visualEffects.length = 0;
    connectionStatus(true);
    $('joinScreen').hidden = true;
    $('arenaPrompt').style.display = 'none';
    $('leaveBtn').disabled = false;
    $('chipDot').style.background = chosenColor;
    $('chipName').textContent = joined.player.name;
    try { localStorage.setItem('cursorclash_name', joined.player.name); } catch {}
    addFeed({ type: 'join', who: `${joined.player.name} (you)` });
    updateUI();
    sync();
  } catch (error) {
    $('joinError').textContent = error.message === 'Failed to fetch'
      ? 'Cannot reach the game server.' : error.message;
  } finally {
    button.disabled = false;
    button.querySelector('span').textContent = 'ENTER THE ARENA';
  }
});

async function leave() {
  if (session) {
    try { await post('/api/leave', session, 1300); } catch {}
  }
  session = null;
  snapshot = null;
  pendingActions = [];
  view.clear();
  visualEffects = [];
  connectionStatus(false);
  $('joinScreen').hidden = false;
  $('arenaPrompt').style.display = '';
  $('deathOverlay').hidden = true;
  $('leaveBtn').disabled = true;
  $('chipName').textContent = 'OFFLINE';
  $('chipDot').style.background = '#4c566a';
  $('onlineCount').textContent = '00';
  $('latency').textContent = '— ms';
  $('leaderboard').replaceChildren();
  $('eventFeed').replaceChildren();
}
$('leaveBtn').addEventListener('click', leave);
$('shareBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href.split('#')[0]); showToast('INVITE LINK COPIED'); }
  catch { showToast('COPY THE URL FROM YOUR ADDRESS BAR'); }
});

function mapPointer(e) {
  const rect = canvas.getBoundingClientRect();
  local.x = clamp((e.clientX - rect.left) / rect.width * W, 12, W - 12);
  local.y = clamp((e.clientY - rect.top) / rect.height * H, 12, H - 12);
  $('coordinates').textContent = `[${digits(local.x)}, ${digits(local.y)}]`;
}
canvas.addEventListener('pointermove', e => { pointerInside = true; if (session) mapPointer(e); });
canvas.addEventListener('pointerenter', () => { pointerInside = true; });
canvas.addEventListener('pointerleave', () => { pointerInside = false; });
canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !session) return;
  e.preventDefault();
  mapPointer(e);
  fire();
});
window.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (['1','2','3','4'].includes(e.key)) setWeapon(['spark','lance','nova','phantom'][Number(e.key)-1]);
  if (e.code === 'Space' && session) { e.preventDefault(); fire(); }
});
function fire() {
  if (!session || !snapshot?.me?.alive) return;
  if (pendingActions.length >= 10) return;
  pendingActions.push({ seq: ++sequence, weapon });
  visualEffects.push({ localFlash: true, x: local.x, y: local.y, weapon, start: performance.now() });
}

function addFeed(event) {
  const stamp = new Date();
  feedItems.unshift({ event, time: stamp.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) });
  feedItems.length = Math.min(feedItems.length, 7);
  renderFeed();
}
function renderFeed() {
  const node = $('eventFeed');
  node.replaceChildren();
  if (!feedItems.length) { const empty = document.createElement('div'); empty.className = 'empty-activity'; empty.textContent = 'Waiting for first contact...'; node.append(empty); return; }
  for (const item of feedItems) {
    const row = document.createElement('div'); row.className = 'feed-row';
    const icon = document.createElement('span'); icon.className = 'feed-icon';
    const copy = document.createElement('span'); copy.className = 'feed-text';
    if (item.event.type === 'kill') {
      icon.textContent = '✕';
      copy.textContent = `${item.event.killer} eliminated ${item.event.victim}`;
    } else if (item.event.type === 'join') {
      icon.textContent = '+'; copy.textContent = `${item.event.who} entered the arena`;
    } else { icon.textContent = '↻'; copy.textContent = 'Arena event'; }
    const time = document.createElement('span'); time.className = 'feed-time'; time.textContent = item.time;
    row.append(icon, copy, time); node.append(row);
  }
}
function processEvents(events) {
  for (const event of events) {
    if (event.id <= lastEventId) continue;
    lastEventId = event.id;
    if (event.type === 'shot') {
      visualEffects.push({ ...event, start: performance.now() });
    } else if (event.type === 'kill' || event.type === 'join') {
      addFeed(event);
    } else if (event.type === 'respawn') {
      visualEffects.push({ ...event, start: performance.now() });
    }
  }
}
async function sync() {
  if (!session || sending || performance.now() < lastNetworkAttempt) return;
  sending = true;
  const actions = pendingActions.splice(0, 5);
  const start = performance.now();
  try {
    const data = await post('/api/sync', { ...session, x: local.x, y: local.y,
      weapon, since: lastEventId, actions }, 4000);
    processEvents(data.events);
    lastEventId = Math.max(lastEventId, data.latestEventId);
    snapshot = data;
    connectionStatus(true);
    $('latency').textContent = `${Math.round(performance.now() - start)} ms`;
    if (data.notice && (data.notice !== lastNotice || Date.now() - lastNoticeAt > 1100)) {
      showToast(data.notice.toUpperCase());
      lastNotice = data.notice;
      lastNoticeAt = Date.now();
    }
  } catch (e) {
    pendingActions = [...actions, ...pendingActions].slice(0, 10);
    connectionStatus(false);
    lastNetworkAttempt = performance.now() + 900;
    if (e.status === 401) { showToast('SESSION EXPIRED — PLEASE REJOIN'); leave(); }
  } finally { sending = false; }
}
setInterval(sync, 75);

function updateUI() {
  if (!snapshot) return;
  const me = snapshot.me;
  $('onlineCount').textContent = String(snapshot.online).padStart(2, '0');
  $('healthValue').innerHTML = `${Math.ceil(me.hp)} <small>/ 100</small>`;
  $('manaValue').innerHTML = `${Math.floor(me.mana)} <small>/ 100</small>`;
  $('healthBar').style.width = `${me.hp}%`;
  $('manaBar').style.width = `${me.mana}%`;
  $('kda').innerHTML = `${me.kills} <small>/</small> ${me.deaths}`;
  const dead = !me.alive;
  $('deathOverlay').hidden = !dead;
  if (dead) $('respawnText').textContent = `Respawning in ${Math.max(0, Math.ceil((me.respawnAt - Date.now()) / 1000))}s`;
  const sorted = [...snapshot.players].sort((a,b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name));
  const board = $('leaderboard'); board.replaceChildren();
  sorted.slice(0, 8).forEach((p, i) => {
    const row = document.createElement('div'); row.className = 'leader-row' + (p.id === session?.id ? ' self' : '');
    const name = document.createElement('div'); name.className = 'leader-name';
    const rank = document.createElement('span'); rank.className = 'leader-rank'; rank.textContent = String(i+1).padStart(2, '0');
    const dot = document.createElement('span'); dot.className = 'leader-dot'; dot.style.background = p.color;
    const text = document.createElement('span'); text.className = 'leader-name-text'; text.textContent = p.name + (p.id === session?.id ? ' (YOU)' : '');
    name.append(rank,dot,text);
    const kills = document.createElement('span'); kills.className = 'leader-score'; kills.textContent = p.kills;
    const deaths = document.createElement('span'); deaths.className = 'leader-score'; deaths.textContent = p.deaths;
    row.append(name,kills,deaths); board.append(row);
  });
}

function createWorldView() {
  if (!snapshot) return [];
  const ids = new Set();
  for (const p of snapshot.players) {
    ids.add(p.id);
    if (!view.has(p.id)) view.set(p.id, { x: p.x, y: p.y });
  }
  for (const id of view.keys()) if (!ids.has(id)) view.delete(id);
  return snapshot.players.map(p => {
    const v = view.get(p.id);
    if (p.id === session?.id) { v.x = local.x; v.y = local.y; }
    else { v.x += (p.x - v.x) * 0.22; v.y += (p.y - v.y) * 0.22; }
    return { ...p, x: v.x, y: v.y };
  });
}

function line(x1,y1,x2,y2,color,width = 2,alpha = 1) {
  ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke(); ctx.globalAlpha = 1;
}
function circle(x,y,r,color,width=1,alpha=1) {
  ctx.globalAlpha = alpha; ctx.beginPath(); ctx.arc(x,y,Math.max(0,r),0,Math.PI*2);
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();ctx.globalAlpha = 1;
}
function drawGrid(now) {
  ctx.strokeStyle = '#6a8caf'; ctx.lineWidth = .8;
  for(let x=0;x<=W;x+=64) { ctx.globalAlpha = x%256===0?.16:.065; ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke(); }
  for(let y=0;y<=H;y+=64) { ctx.globalAlpha = y%256===0?.16:.065;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke(); }
  ctx.globalAlpha = 1;
  for(let y=64;y<H;y+=128) for(let x=64;x<W;x+=128){ctx.fillStyle='#668aa7';ctx.globalAlpha=.23;ctx.fillRect(x-1.4,y-1.4,2.8,2.8);}
  ctx.globalAlpha=1;
  // Slowly sweeping, faint scanline; purely decorative.
  const sweep=(now*.045)%H;
  const grad=ctx.createLinearGradient(0,sweep-50,0,sweep+50);
  grad.addColorStop(0,'#74f7dc00');grad.addColorStop(.5,'#74f7dc07');grad.addColorStop(1,'#74f7dc00');
  ctx.fillStyle=grad;ctx.fillRect(0,sweep-50,W,100);
}
function drawPlayer(p, own, now) {
  const {x,y,color} = p;
  if(!p.alive){circle(x,y,28,'#8b98ae',2,.2);return;}
  ctx.save();ctx.translate(x,y);
  ctx.shadowColor=color;ctx.shadowBlur=own?25:14;
  ctx.fillStyle=color;ctx.strokeStyle='#06101a';ctx.lineWidth=3.5;
  ctx.beginPath();ctx.moveTo(-12,-17);ctx.lineTo(-10,26);ctx.lineTo(-1,16);ctx.lineTo(9,35);
  ctx.lineTo(18,30);ctx.lineTo(9,12);ctx.lineTo(24,11);ctx.closePath();ctx.fill();ctx.stroke();
  ctx.shadowBlur=0;
  if(own){circle(0,0,38,color,1.5,.5+Math.sin(now/350)*.15)}
  ctx.restore();
  const name=p.name+(own?' [YOU]':'');
  ctx.font='700 17px ui-monospace, monospace';
  const nameW=ctx.measureText(name).width;
  const badgeW=nameW+22;
  const px=clamp(x+23,10,W-badgeW-10),py=clamp(y-35,20,H-35);
  ctx.fillStyle='#07111de8';ctx.fillRect(px,py-22,badgeW,32);
  ctx.fillStyle=color;ctx.fillRect(px,py-22,3,32);
  ctx.fillStyle='#eef5ff';ctx.fillText(name,px+12,py);
  ctx.fillStyle='#293f53';ctx.fillRect(px,py+14,badgeW,5);
  ctx.fillStyle='#ff8495';ctx.fillRect(px,py+14,badgeW*(p.hp/100),5);
}
function drawShot(e,age){
  const w=WEAPONS[e.weapon];if(!w)return;
  const progress=age/580;
  const alpha=Math.max(0,1-progress);
  const color=w.color;
  circle(e.x,e.y,10+progress*38,color,2,alpha*.8);
  if(e.weapon==='nova'){
    const radius=w.range*Math.min(1,progress*2.8);
    ctx.save();ctx.globalAlpha=alpha*.21;ctx.fillStyle=color;ctx.beginPath();ctx.arc(e.x,e.y,radius,0,Math.PI*2);ctx.fill();ctx.restore();
    circle(e.x,e.y,radius,color,4,alpha);
  }
  for(const hit of e.hits||[]){
    if(e.weapon!=='nova'){
      ctx.save();ctx.shadowColor=color;ctx.shadowBlur=30;line(e.x,e.y,hit.x,hit.y,color,e.weapon==='phantom'?11:6,alpha*.65);ctx.restore();
      line(e.x,e.y,hit.x,hit.y,'#f5ffff',e.weapon==='phantom'?3:2,alpha);
    }
    circle(hit.x,hit.y,15+progress*50,color,3,alpha);
    ctx.font='800 22px ui-monospace,monospace';ctx.fillStyle=color;ctx.globalAlpha=alpha;
    ctx.fillText(`-${hit.damage}`,hit.x+26,hit.y-22-progress*40);ctx.globalAlpha=1;
  }
}
function draw() {
  requestAnimationFrame(draw);
  const now=performance.now();
  ctx.setTransform(canvas.width/W,0,0,canvas.height/H,0,0);
  ctx.clearRect(0,0,W,H);
  drawGrid(now);
  const players=createWorldView();
  const me=players.find(p=>p.id===session?.id);
  if(me?.alive){
    const w=WEAPONS[weapon];
    if(pointerInside){
      circle(me.x,me.y,w.range,w.color,1,.16);
      const target=players.filter(p=>p.id!==me.id&&p.alive&&dist(p,me)<=w.range).sort((a,b)=>dist(a,me)-dist(b,me))[0];
      if(target){line(me.x,me.y,target.x,target.y,w.color,1,.33);circle(target.x,target.y,43,w.color,2,.55+Math.sin(now/130)*.16);}
    }
  }
  players.filter(p=>p.id!==session?.id).forEach(p=>drawPlayer(p,false,now));
  if(me)drawPlayer(me,true,now);
  visualEffects=visualEffects.filter(e=>now-e.start<650);
  for(const e of visualEffects){
    const age=now-e.start;
    if(e.localFlash)circle(e.x,e.y,4+age*.09,WEAPONS[e.weapon].color,2,1-age/650);
    else if(e.type==='shot')drawShot(e,age);
    else if(e.type==='respawn')circle(e.x,e.y,10+age*.2,'#74f7dc',4,1-age/650);
  }
  if(now-uiUpdatedAt>150){uiUpdatedAt=now;updateUI();}
}
requestAnimationFrame(draw);

// Leave promptly if possible, so a closed tab doesn't linger on the leaderboard.
window.addEventListener('pagehide',()=>{
  if(!session)return;
  const data=JSON.stringify(session);
  if(navigator.sendBeacon)navigator.sendBeacon('/cursorclash/api/leave',new Blob([data],{type:'application/json'}));
});
setWeapon('spark');
