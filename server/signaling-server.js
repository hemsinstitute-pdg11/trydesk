const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 9100;
const TURN_SECRET = process.env.TURN_SECRET || "";
const TURN_HOST = process.env.TURN_HOST || "";
const TURN_PORT = Number(process.env.TURN_PORT) || 3478;
// TURN credentials: coturn checks the expiry on every request, the periodic Refresh / CreatePermission of a running
// relay too, so a relayed session ends when its login expires. 12 h, renewed every hour: a new session always starts
// with 11 h or more (was 2 h from sign-in, so a relayed session could die after minutes).
const TURN_TTL = 12 * 3600;
// They were only handed out at sign-in, so a TryDesk online for over 2 h (the Windows service, a tray app) had no relay
// left and every session that needed one died after 30 s (Threads report 19 Nov, 1.3.9 "password fails, 25 s").
// Now: fresh ones every hour to every connection ("ice-servers"; older apps ignore the message) and on request
// ("ice-refresh", at most once a minute per connection).
const TURN_PUSH_MS = Number(process.env.TURN_PUSH_MS) >= 1000 ? Number(process.env.TURN_PUSH_MS) : 55 * 60 * 1000;   // env: tests only
const TURN_ASK_GAP_MS = 60 * 1000;
const PRESENCE_GAP_MS = Number(process.env.PRESENCE_GAP_MS) >= 100 ? Number(process.env.PRESENCE_GAP_MS) : 10 * 1000;   // env: tests only
const OWNERS_FILE = process.env.OWNERS_FILE || "";
// Bound the reserved-ID map so churn can't exhaust disk/memory. When it is full, only an ID not seen for
// OWNERS_MIN_IDLE_DAYS loses its reservation (oldest first); a flood of new sign-ins can never push out people who use
// TryDesk (security audit 22 Nov: they could, and their IDs could then be taken over). The env values are for tests.
const envInt = (k, d, min) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= min ? Math.floor(v) : d; };
const OWNERS_CAP = envInt("OWNERS_CAP", 100000, 10);
const OWNERS_MIN_IDLE_DAYS = envInt("OWNERS_MIN_IDLE_DAYS", 180, 1);
// New reservations one network may make per hour (an IPv4 address, or an IPv6 /64 so rotating addresses doesn't help).
const OWNER_MINT_PER_HOUR = envInt("OWNER_MINT_PER_HOUR", 30, 1);
const SEEN_FILE = OWNERS_FILE ? `${OWNERS_FILE}.seen` : "";   // id -> last seen (ms); owners.json keeps its format
// Flood limits. The defaults below; an extension may change them while the server runs (control.setLimits).
//   msgPerSec          messages per second on one connection (ICE can burst, so leave headroom)
//   connReqPer10s      connection requests per 10 s from one connection
//   connReqPerIp10s    the same, per client IP (an office behind one NAT gets four times one connection's share)
//   connPerIp          connections open at once from one IP
//   incomingPerMin     prompts one PC may get per minute, from everyone together
//   incomingPerIpPerMin  prompts one PC may get per minute from one IP
const LIMIT_DEFAULTS = Object.freeze({ msgPerSec: 100, connReqPer10s: 5, connReqPerIp10s: 20, connPerIp: 30, incomingPerMin: 30, incomingPerIpPerMin: 6 });
const LIMIT_RANGE = { msgPerSec: [20, 1000], connReqPer10s: [1, 50], connReqPerIp10s: [2, 200], connPerIp: [2, 500], incomingPerMin: [2, 300], incomingPerIpPerMin: [1, 60] };
const limits = { ...LIMIT_DEFAULTS };
// Oldest app version allowed to connect ("" = no check; self-hosted servers leave it unset). Apps from 1.2.8 also read
// "minimum" from the website's version.json and stop themselves; this reaches the older ones, which never do: they get
// told to update (a server "error" shows as a toast in every version) and their requests are refused.
const MIN_CLIENT_VERSION = /^\d+\.\d+\.\d+$/.test(process.env.MIN_CLIENT_VERSION || "") ? process.env.MIN_CLIENT_VERSION : "";
let minClientVersion = MIN_CLIENT_VERSION;   // the env value, unless an extension changes it (see "Extensions" below)
const UPDATE_URL_TEXT = "trydesk.ai.id/downloads";
function verLess(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}
// The version a client is running: what it reports at sign-in (1.2.0+), else "TryDesk/x.y.z" in the desktop app's
// User-Agent. "" = can't tell (a very old phone app, a script): never blocked on a guess.
function clientVersion(ws, msg) {
  const said = msg.app && typeof msg.app === "object" && typeof msg.app.v === "string" ? msg.app.v : "";
  if (/^\d+\.\d+\.\d+$/.test(said)) return said;
  const m = String(ws.ua || "").match(/TryDesk\/(\d+\.\d+\.\d+)/i);
  return m ? m[1] : "";
}
const tooOld = (ws) => !!(minClientVersion && ws && ws.ver && verLess(ws.ver, minClientVersion));
// Text the app shows as a toast. Apps translate only the texts they already know, so a message added on the server
// later stays Indonesian on an English screen. Apps from 1.3.2 say their language at sign-in and get just that one;
// older ones get both, the system language (Accept-Language) first. Every user-visible server text goes through here.
function say(ws, id, en) {
  if (ws && ws.lang === "id") return id;
  if (ws && ws.lang === "en") return en;
  return ws && ws.sysId ? `${id} · ${en}` : `${en} · ${id}`;
}

const online = new Map();      // id -> ws
const owners = new Map();      // id -> sha256(token) (keeps an ID reserved for the device that owns it)
// Only a hash of the owner token is kept: whoever reads the owners file can't register as someone else's device.
// Files written before 1.3.3 hold the raw 32-hex token; those entries are hashed the first time the device shows up.
const tokenHash = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const ownerMatches = (id, token) => { const v = owners.get(id); return !!v && (v === tokenHash(token) || (v.length === 32 && v === token)); };
// Multi-session: a client (the viewer) may control several remotes at once, so these track SETS,
// not single values. A host stays single-session (it has at most one pairing).
const pending = new Map();     // requesterId -> Set<targetId>  (outgoing requests awaiting accept)
const pairs = new Map();       // id -> Set<peerId>            (active pairings, both directions)
const hosting = new Map();     // hostId -> viewerId           (who is controlling whom: only hosting makes "busy")
const away = new Map();        // id -> timer                  (socket dropped; pairings kept briefly for a re-register)
const AWAY_GRACE_MS = 30000;

if (OWNERS_FILE && fs.existsSync(OWNERS_FILE)) {
  try {
    for (const [id, token] of Object.entries(JSON.parse(fs.readFileSync(OWNERS_FILE, "utf8")))) owners.set(id, token);
    console.log(`Loaded ${owners.size} reserved IDs`);
  } catch (e) {
    console.error("Cannot read owners file:", e.message);
  }
}

// When each reserved ID was last signed in. An ID with no entry yet (a file from before this existed) counts as seen
// when the server started, so nobody's reservation becomes "idle" on the day this change goes live.
const seen = new Map();
const startedAt = Date.now();
if (SEEN_FILE && fs.existsSync(SEEN_FILE)) {
  try {
    for (const [id, t] of Object.entries(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")))) if (owners.has(id) && Number.isFinite(t)) seen.set(id, t);
  } catch (e) {
    console.error("Cannot read seen file:", e.message);
  }
}
const lastSeen = (id) => seen.get(id) || startedAt;
let seenTimer = null;
function saveSeen() {
  if (!SEEN_FILE || seenTimer) return;
  seenTimer = setTimeout(() => {
    seenTimer = null;
    const out = {};
    for (const id of owners.keys()) out[id] = lastSeen(id);
    const tmp = `${SEEN_FILE}.tmp`;
    fs.writeFile(tmp, JSON.stringify(out), (err) => {
      if (err) return console.error("Cannot save seen file:", err.message);
      fs.rename(tmp, SEEN_FILE, () => {});
    });
  }, 60 * 1000);
}
function markSeen(id) { seen.set(id, Date.now()); saveSeen(); }

let saveTimer = null;
function saveOwners() {
  if (!OWNERS_FILE || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = `${OWNERS_FILE}.tmp`;
    fs.writeFile(tmp, JSON.stringify(Object.fromEntries(owners)), (err) => {
      if (err) return console.error("Cannot save owners file:", err.message);
      fs.rename(tmp, OWNERS_FILE, () => {});
    });
  }, 1000);
}

// coturn "use-auth-secret" (TURN REST API): short-lived credentials, the secret never leaves the server
// ttl: apps that renew their login (they say app.ice = 1) get TURN_TTL; older apps can't renew, so theirs lasts
// TURN_TTL_OLD (they sign in again when their connection drops). The credential itself only ever travels inside the
// TLS signaling connection; a sniffer of the TURN traffic sees the username, not the key.
const TURN_TTL_OLD = 7 * 24 * 3600;
function turnServers(id, ttl = TURN_TTL) {
  if (!TURN_SECRET || !TURN_HOST) return [];
  // A random tag, not the TryDesk ID: the TURN username travels in the clear, so a sniffer must not learn which ID sits
  // behind an address. (id is kept in the signature so the function stays the same for callers.)
  void id;
  const username = `${Math.floor(Date.now() / 1000) + ttl}:${crypto.randomBytes(6).toString("hex")}`;
  const credential = crypto.createHmac("sha1", TURN_SECRET).update(username).digest("base64");
  return [{
    urls: [`turn:${TURN_HOST}:${TURN_PORT}?transport=udp`, `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`],
    username,
    credential,
  }];
}

function newId() {
  let id;
  do {
    const n = String(crypto.randomInt(100000000, 1000000000));
    id = `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  } while (online.has(id) || owners.has(id));
  return id;
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function sendTo(id, msg) {
  send(online.get(id), msg);
}

function peersOf(id) { return pairs.has(id) ? [...pairs.get(id)] : []; }

function addPair(a, b) {
  if (!pairs.has(a)) pairs.set(a, new Set());
  if (!pairs.has(b)) pairs.set(b, new Set());
  pairs.get(a).add(b); pairs.get(b).add(a);
}
function removePair(a, b) {
  const sa = pairs.get(a); if (sa) { sa.delete(b); if (!sa.size) pairs.delete(a); }
  const sb = pairs.get(b); if (sb) { sb.delete(a); if (!sb.size) pairs.delete(b); }
  if (hosting.get(a) === b) { hosting.delete(a); note("session-end", { host: a, viewer: b }); }
  if (hosting.get(b) === a) { hosting.delete(b); note("session-end", { host: b, viewer: a }); }
}
// A target is busy only while it is being CONTROLLED by someone still around. A PC that is itself controlling
// other PCs (a technician's machine) can still be asked — the client accepts hosting next to its viewer tabs.
function isHostingBusy(target) {
  const viewer = hosting.get(target);
  return !!viewer && (online.has(viewer) || away.has(viewer)) && !!pairs.get(target) && pairs.get(target).has(viewer);
}
function addPending(req, target) {
  if (!pending.has(req)) pending.set(req, new Set());
  pending.get(req).add(target);
}
function removePending(req, target) {
  const s = pending.get(req); if (s) { s.delete(target); if (!s.size) pending.delete(req); }
}

// Drop ONE pairing (id <-> peer) and tell the peer. Leaves the client's OTHER sessions intact. bye = the client
// ended it on purpose (with a short reason), so the peer neither auto-reconnects nor waits for its own timeout.
function unpairPeer(id, peer, bye = null) {
  if (pairs.get(id) && pairs.get(id).has(peer)) {
    removePair(id, peer);
    sendTo(peer, bye ? { type: "peer-disconnected", fromId: id, bye: true, reason: bye.reason } : { type: "peer-disconnected", fromId: id });
  }
}
// Drop ALL of id's pairings and outgoing requests (used on socket close, and for a legacy
// single-session client that sends "disconnect" without a targetId).
function unpairAll(id) {
  for (const peer of peersOf(id)) { removePair(id, peer); sendTo(peer, { type: "peer-disconnected", fromId: id }); }
  if (pending.has(id)) { for (const target of pending.get(id)) sendTo(target, { type: "request-cancelled", fromId: id }); pending.delete(id); }
}

// Room for one more reservation? When the map is full, the IDs not seen for OWNERS_MIN_IDLE_DAYS (and not online) go,
// longest unseen first, down to 99% of the cap. None idle that long: no room; the new device still works for this
// sign-in, its ID just isn't reserved yet. A full map with nothing to free is re-checked at most every 10 minutes.
let capNoRoomUntil = 0;
function roomForOwner() {
  if (owners.size < OWNERS_CAP) return true;
  const now = Date.now();
  if (now < capNoRoomUntil) return false;
  const cutoff = now - OWNERS_MIN_IDLE_DAYS * 86400000;
  const idle = [];
  for (const id of owners.keys()) { const t = lastSeen(id); if (t <= cutoff && !online.has(id)) idle.push([t, id]); }
  if (!idle.length) { capNoRoomUntil = now + 10 * 60 * 1000; console.warn(`reserved IDs full (${owners.size}), none idle ${OWNERS_MIN_IDLE_DAYS} days: new IDs not reserved for now`); return false; }
  idle.sort((a, b) => a[0] - b[0]);
  const target = Math.max(0, Math.floor(OWNERS_CAP * 0.99));
  for (const [, id] of idle) { if (owners.size <= target) break; owners.delete(id); seen.delete(id); }
  if (owners.size >= OWNERS_CAP) capNoRoomUntil = now + 10 * 60 * 1000;   // a file loaded over the cap: still full
  saveOwners(); saveSeen();
  return owners.size < OWNERS_CAP;
}
// The network a client signs in from: an IPv4 address, or the /64 of an IPv6 one (one household or server gets a
// whole /64, so counting single IPv6 addresses would let one network mint without limit).
function netKey(ip) {
  const s = String(ip || "").trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  if (!s.includes(":")) return s || "?";
  const [head, tail = ""] = s.split("%")[0].split("::");
  const h = head ? head.split(":") : [];
  const t = s.includes("::") ? (tail ? tail.split(":") : []) : [];
  const full = s.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return full.slice(0, 4).map((x) => (parseInt(x, 16) || 0).toString(16)).join(":") + "::/64";
}
const mintTimes = new Map();       // netKey -> [timestamps] of new reservations this hour

// Per-socket flood limiter: a rolling 1s budget for all messages, plus a tighter 10s budget for
// connect-request (stops connection-prompt spam and online password brute-forcing).
function rateOk(ws) {
  const now = Date.now();
  if (now - (ws.rlStart || 0) > 1000) { ws.rlStart = now; ws.rlCount = 0; }
  if (++ws.rlCount === limits.msgPerSec + 1) note("msg-flood", { id: ws.clientId || "", ip: ws.ip });   // once per second at most
  return ws.rlCount <= limits.msgPerSec;
}
// The per-socket budget alone was reset by simply reconnecting, so the same budgets are also kept per client IP
// (an office behind one NAT gets four times a single socket's share) and per target: no PC gets more than
// limits.incomingPerMin prompts a minute, however many IPs ask — a flood could otherwise keep it "busy" for everyone.
// The per-target budget is counted per asking IP first, so one hostile sender can't use up a PC's whole budget and
// lock everyone else out; the overall per-target cap only bites when many IPs pile on together.
const ipReqTimes = new Map();      // ip -> [timestamps]
const targetReqTimes = new Map();  // targetId -> [timestamps]
const pairReqTimes = new Map();    // "targetId|ip" -> [timestamps]
function withinBudget(map, key, windowMs, max, now) {
  const times = (map.get(key) || []).filter((t) => now - t < windowMs);
  if (times.length >= max) { map.set(key, times); return false; }
  times.push(now);
  map.set(key, times);
  return true;
}
function connReqOk(ws) {
  const now = Date.now();
  ws.crTimes = (ws.crTimes || []).filter((t) => now - t < 10000);
  if (ws.crTimes.length >= limits.connReqPer10s) return false;
  if (!withinBudget(ipReqTimes, ws.ip || "?", 10000, limits.connReqPerIp10s, now)) return false;
  ws.crTimes.push(now);
  return true;
}
function incomingOk(target, ip) {
  const now = Date.now();
  return withinBudget(pairReqTimes, `${target}|${ip || "?"}`, 60000, limits.incomingPerIpPerMin, now)
    && withinBudget(targetReqTimes, target, 60000, limits.incomingPerMin, now);
}
// Drop expired entries so the two maps stay small (called from the keep-alive sweep).
function sweepReqBudgets() {
  const now = Date.now();
  for (const [map, windowMs] of [[ipReqTimes, 10000], [targetReqTimes, 60000], [pairReqTimes, 60000], [mintTimes, 3600000]]) {
    for (const [k, times] of map) if (!times.some((t) => now - t < windowMs)) map.delete(k);
  }
}

// A device or address the server operator has blocked: told why in its own words, then dropped.
function refuseBlocked(ws) {
  send(ws, { type: "error", code: "blocked", message: say(ws,
    "Perangkat atau jaringan ini diblokir oleh pengelola server TryDesk.",
    "This device or network has been blocked by the TryDesk server operator.") });
  setTimeout(() => { try { ws.close(4003, "blocked"); } catch {} }, 200);
}

function register(ws, msg) {
  let id = typeof msg.id === "string" ? msg.id : null;
  const token = typeof msg.token === "string" && msg.token.length >= 16 ? msg.token : null;
  // known = this device already owns its ID (false = signing in would hand out a new one)
  const known = !!(id && token && /^\d{3} \d{3} \d{3}$/.test(id) && ownerMatches(id, token));
  if (ext && ext.refuse && ext.refuse({ id, ip: ws.ip, known })) {
    note("blocked", { id, ip: ws.ip });
    return refuseBlocked(ws);
  }

  const valid = id && /^\d{3} \d{3} \d{3}$/.test(id) && token;
  const ownedByOther = valid && owners.has(id) && !ownerMatches(id, token);
  if (!valid || ownedByOther) id = newId();
  else if (online.has(id) && online.get(id) !== ws) {
    // The SAME device re-registering (same ID + owner token) while its previous socket still looks online:
    // after sleep / a Wi-Fi switch the old half-open socket lingers until the ping sweep notices (25-50s).
    // Handing out a fresh ID here changed the user's ID for good — take the ID over instead. The old socket's
    // close handler ignores it because `online` no longer points at it, so live pairings are kept.
    const old = online.get(id);
    if (ownerMatches(id, token)) { try { old.terminate(); } catch {} }
    else id = newId();
  }

  const finalToken = token || crypto.randomBytes(16).toString("hex");
  if (owners.has(id) && ownerMatches(id, finalToken)) {
    // Its own ID: a file from before 1.3.3 held the raw token; it is hashed now.
    if (owners.get(id) !== tokenHash(finalToken)) { owners.set(id, tokenHash(finalToken)); saveOwners(); }
    markSeen(id);
  } else if (!owners.has(id)) {
    // A new reservation: at most OWNER_MINT_PER_HOUR per network an hour, and only while there is room (see
    // roomForOwner). Otherwise the device still signs in with this ID; it is reserved on a later sign-in.
    if (withinBudget(mintTimes, netKey(ws.ip), 3600000, OWNER_MINT_PER_HOUR, Date.now()) && roomForOwner()) {
      owners.set(id, tokenHash(finalToken));
      markSeen(id);
      saveOwners();
    }
  }
  online.set(id, ws);
  ws.clientId = id;
  ws.since = Date.now();
  if (ext) ext.onRegister(ws, msg);
  // Back within the grace period: its pairings are still in place.
  if (away.has(id)) { clearTimeout(away.get(id)); away.delete(id); }
  // Clients from 1.2.1 say which sessions they still have. A pairing the client no longer knows about was left by a
  // previous process (Run as administrator, a crash, quit and reopen): drop it, or it stays "controlling" for good.
  // Older clients send no list and keep the old behaviour.
  if (Array.isArray(msg.live)) {
    const live = new Set(msg.live.filter((p) => typeof p === "string").slice(0, 32));
    for (const peer of peersOf(id)) {
      if (!live.has(peer)) { removePair(id, peer); sendTo(peer, { type: "peer-disconnected", fromId: id }); }
    }
    // A session goes on peer to peer when the server restarts (or a socket stays away past the grace period), but its
    // pairing was gone: the status page counted far fewer running sessions than there were, and the two could no
    // longer relay a codec change or "disconnect" (owner 19 Nov: "1000 lebih terhubung tapi sesi sedikit"). Clients
    // from the next version say whom they are controlled by (hostedBy); the pairing comes back only when BOTH sides
    // say it still runs: the host names the viewer and the viewer lists the host. One side alone can't make one.
    ws.live = live;
    ws.hostedBy = typeof msg.hostedBy === "string" && live.has(msg.hostedBy) ? msg.hostedBy : "";
    const restore = (h, v) => {
      if (hosting.has(h) || !online.has(v)) return;
      addPair(h, v); hosting.set(h, v);
      note("restored", { host: h, viewer: v });
    };
    if (ws.hostedBy) { const v = online.get(ws.hostedBy); if (v && v.live && v.live.has(id)) restore(id, ws.hostedBy); }
    for (const peer of live) { const p = online.get(peer); if (p && p.hostedBy === id && p.live && p.live.has(id)) restore(peer, id); }
  }
  // sdpMac is no longer announced (3 Nov 2026): 1.3.3 viewers demanded a signed answer once it was, and 1.3.3 hosts
  // never sign one, so every 1.3.3 password session hung. While it is absent 1.3.3 takes an unsigned answer; 1.3.4+
  // ignores the flag (its hosts always require the signature once the password is proven). "mac" is still relayed.
  ws.iceRenew = !!(msg.app && typeof msg.app === "object" && msg.app.ice === 1);
  ws.ver = clientVersion(ws, msg);
  // An app too old to connect any more gets no relay login either (audit 19 Nov: it still got a 7-day one).
  send(ws, { type: "registered", clientId: id, token: finalToken, iceServers: tooOld(ws) ? [] : turnServers(id, ws.iceRenew ? TURN_TTL : TURN_TTL_OLD) });
  ws.iceAt = Date.now();
  const lang = msg.app && typeof msg.app === "object" ? msg.app.lang : "";
  ws.lang = lang === "id" || lang === "en" ? lang : "";
  if (tooOld(ws)) send(ws, { type: "error", code: "too-old", targetId: "update", message: say(ws,
    `TryDesk ${ws.ver} sudah terlalu lama dan tidak bisa terhubung lagi. Perbarui ke versi terbaru di ${UPDATE_URL_TEXT}`,
    `TryDesk ${ws.ver} is too old and can no longer connect. Update to the latest version at ${UPDATE_URL_TEXT}`) });
  console.log(`[+] ${id} (${online.size} online)`);
}

function handle(ws, msg) {
  if (msg.type === "register") {
    if (!ws.clientId) register(ws, msg);
    return;
  }
  const me = ws.clientId;
  if (!me) return;

  switch (msg.type) {
    case "ice-refresh": {   // fresh TURN credentials before a connection (see TURN_PUSH_MS)
      if (Date.now() - (ws.iceAskAt || 0) < TURN_ASK_GAP_MS || tooOld(ws)) break;
      ws.iceAskAt = Date.now();
      const ice = turnServers(me);
      if (ice.length) { send(ws, { type: "ice-servers", iceServers: ice }); ws.iceAt = Date.now(); }
      break;
    }
    // Which of the PCs the app shows (its recent ones, favorites, groups) are online now: a green or grey dot on their
    // pictures (owner 19 Nov, concept D9bd: "status online atau offline di terakhir dihubungi atau semua perangkat").
    // At most 60 IDs, at most once every 10 s per connection; nothing about the PC beyond online or not. An app too old
    // to connect gets nothing.
    case "presence": {
      if (Date.now() - (ws.presAt || 0) < PRESENCE_GAP_MS || tooOld(ws)) break;
      ws.presAt = Date.now();
      const ids = Array.isArray(msg.ids) ? [...new Set(msg.ids.filter((x) => typeof x === "string" && /^\d{3} \d{3} \d{3}$/.test(x)))].slice(0, 60) : [];
      send(ws, { type: "presence", ids, on: ids.filter((x) => { const w = online.get(x); return !!w && w.readyState === 1 && !tooOld(w); }) });
      break;
    }
    case "lang":   // the user switched the app's language (1.3.2+)
      if (msg.lang === "id" || msg.lang === "en") ws.lang = msg.lang;
      break;
    case "connect-request": {
      // Errors name the request's target so a client with several tabs closes the right one.
      const target = typeof msg.targetId === "string" ? msg.targetId.slice(0, 16) : "";
      // Something that can never be an ID (the Android app's "td-probe" socket check) is answered at once and costs
      // no budget: it reaches nobody, and counting it used to eat the phone's own connect budget.
      if (!/^\d{3} \d{3} \d{3}$/.test(target)) {
        send(ws, { type: "error", code: "offline", targetId: target, message: "ID tidak ditemukan atau sedang offline" });
        return;
      }
      if (!connReqOk(ws)) {
        note("ratelimit", { id: me, target });
        send(ws, { type: "error", code: "ratelimit", targetId: target, message: "Terlalu banyak permintaan, coba lagi sebentar" });
        return;
      }
      if (target === me || !online.has(target)) {
        send(ws, { type: "error", code: "offline", targetId: target, message: "ID tidak ditemukan atau sedang offline" });
        return;
      }
      if (tooOld(ws)) {
        send(ws, { type: "error", code: "too-old", targetId: target, message: say(ws,
          `TryDesk ${ws.ver} sudah terlalu lama. Perbarui ke versi terbaru di ${UPDATE_URL_TEXT} agar bisa terhubung lagi`,
          `TryDesk ${ws.ver} is too old. Update to the latest version at ${UPDATE_URL_TEXT} to connect again`) });
        return;
      }
      if (tooOld(online.get(target))) {
        send(ws, { type: "error", code: "peer-too-old", targetId: target, message: say(ws,
          `PC tujuan memakai TryDesk versi lama. Minta pemiliknya memperbarui di ${UPDATE_URL_TEXT}`,
          `The remote PC runs an old TryDesk. Ask its owner to update at ${UPDATE_URL_TEXT}`) });
        // The old PC is told too. targetId names the requester, a tab it has no session for, so nothing closes there.
        sendTo(target, { type: "error", code: "peer-too-old-host", targetId: me, message: say(online.get(target),
          `Ada yang mencoba terhubung, tapi TryDesk di PC ini versi lama. Perbarui di ${UPDATE_URL_TEXT}`,
          `Someone tried to connect, but this PC runs an old TryDesk. Update at ${UPDATE_URL_TEXT}`) });
        return;
      }
      // Block controlling your own PC. A second TryDesk instance on the same device shares the
      // owner token (stored per-machine), so same owner token = same machine even though the two
      // instances have different IDs. Remoting it would cause an infinite screen loop / input bounce.
      const myOwner = owners.get(me);
      if (myOwner && myOwner === owners.get(target)) {
        send(ws, { type: "error", code: "self", targetId: target, message: "Tidak bisa me-remote PC Anda sendiri" });
        return;
      }
      // Clear stale state before the "busy" check so an abrupt drop never blocks a fresh request,
      // WITHOUT touching this client's other live sessions. Covers: a stale me<->target half-pair,
      // and target pairings to peers that have already gone offline.
      unpairPeer(me, target);
      for (const peer of peersOf(target)) { if (!online.has(peer) && !away.has(peer)) removePair(target, peer); }
      // A host is single-session: busy while someone (still around) is controlling it.
      if (isHostingBusy(target)) {
        send(ws, { type: "error", code: "busy", targetId: target, message: "Remote desktop sedang dalam sesi lain" });
        return;
      }
      // Counted only for a request that would really pop up on the target (not a self or busy refusal).
      if (!incomingOk(target, ws.ip)) {
        note("ratelimit", { id: me, target });
        send(ws, { type: "error", code: "target-ratelimit", targetId: target, message: say(ws,
          "PC tujuan sedang menerima terlalu banyak permintaan, coba lagi sebentar",
          "The remote PC is getting too many requests, try again in a moment") });
        return;
      }
      addPending(me, target);
      note("request", { from: me, to: target });
      sendTo(target, {
        type: "incoming-connection",
        fromId: me,
        // Only ever a string: String() on a crafted object ({"toString":1}) throws and used to crash the server.
        fromName: (typeof msg.fromName === "string" && msg.fromName.slice(0, 64)) || "TryDesk User",
        // No password here — access-password auth is a server-blind challenge/response (see below).
      });
      break;
    }
    case "cancel-request": {
      // Scoped to a specific target when given (multi-session); legacy clients cancel all.
      if (msg.targetId) {
        if (pending.get(me) && pending.get(me).has(msg.targetId)) {
          removePending(me, msg.targetId);
          sendTo(msg.targetId, { type: "request-cancelled", fromId: me });
        }
      } else if (pending.has(me)) {
        for (const target of pending.get(me)) sendTo(target, { type: "request-cancelled", fromId: me });
        pending.delete(me);
      }
      break;
    }
    case "connection-accepted": {
      const requester = msg.targetId;
      if (!pending.get(requester) || !pending.get(requester).has(me)) return;
      removePending(requester, me);
      unpairPeer(me, requester);          // clear only a stale pairing with this requester
      addPair(me, requester);
      hosting.set(me, requester);         // me (the accepting side) is now being controlled by requester
      note("accepted", { host: me, viewer: requester });
      sendTo(requester, { type: "connection-accepted", fromId: me });
      break;
    }
    case "connection-rejected": {
      const requester = msg.targetId;
      if (!pending.get(requester) || !pending.get(requester).has(me)) return;
      removePending(requester, me);
      const reason = typeof msg.reason === "string" ? msg.reason.slice(0, 160) : "";
      note("rejected", { host: me, viewer: requester, reason });
      sendTo(requester, { type: "connection-rejected", fromId: me, reason });
      break;
    }
    // Server-blind access-password handshake: the server only relays the salt, a one-shot nonce and
    // the viewer's HMAC between a pending pair — it never sees the password. Host → requester.
    case "connection-challenge": {
      const requester = msg.targetId;
      if (!pending.get(requester) || !pending.get(requester).has(me)) return;
      sendTo(requester, {
        type: "connection-challenge", fromId: me,
        salt: typeof msg.salt === "string" ? msg.salt.slice(0, 64) : "",
        nonce: typeof msg.nonce === "string" ? msg.nonce.slice(0, 128) : "",
      });
      break;
    }
    // Requester → host.
    case "connection-response": {
      const targetHost = msg.targetId;
      if (!pending.get(me) || !pending.get(me).has(targetHost)) return;
      sendTo(targetHost, {
        type: "connection-response", fromId: me,
        response: typeof msg.response === "string" ? msg.response.slice(0, 128) : "",
      });
      break;
    }
    case "offer":
    case "answer":
    case "ice-candidate": {
      const peer = msg.targetId;
      if (!peer || !pairs.get(me) || !pairs.get(me).has(peer)) return;
      // mac (1.3.3+): the sender's signature over its offer/answer under the password key; relayed, never checked here.
      sendTo(peer, { type: msg.type, fromId: me, offer: msg.offer, answer: msg.answer, candidate: msg.candidate, ...(typeof msg.mac === "string" ? { mac: msg.mac.slice(0, 128) } : {}) });
      break;
    }
    case "disconnect":
      // Scoped to one peer when given (multi-session); legacy clients drop everything.
      if (msg.targetId) unpairPeer(me, msg.targetId, msg.bye ? { reason: typeof msg.reason === "string" ? msg.reason.slice(0, 120) : "" } : null);
      else unpairAll(me);
      break;
  }
}

// Extensions: an optional module at ./extensions (a file or a folder) for whoever runs a server and wants extra
// moderation or logging. None comes with this repository and the server works the same without one. Only "not there
// at all" is silent: a file missing INSIDE an extension is logged, so a broken install doesn't fail unnoticed.
// What an extension may do through `control`: end a running session, drop a device's connection, change the oldest
// app version allowed, and change the flood limits. Each returns false when there is nothing to act on.
const control = {
  limitDefaults: LIMIT_DEFAULTS,
  limitRange: LIMIT_RANGE,
  limits: () => ({ ...limits }),
  // Whole numbers inside LIMIT_RANGE only; a missing key goes back to its default. All or nothing.
  setLimits(next) {
    const out = {};
    for (const k of Object.keys(LIMIT_DEFAULTS)) {
      const v = next && next[k] !== undefined && next[k] !== null ? Number(next[k]) : LIMIT_DEFAULTS[k];
      if (!Number.isInteger(v) || v < LIMIT_RANGE[k][0] || v > LIMIT_RANGE[k][1]) return false;
      out[k] = v;
    }
    Object.assign(limits, out);
    return true;
  },
  envMinVersion: MIN_CLIENT_VERSION,
  minVersion: () => minClientVersion,
  setMinVersion(v) {
    if (v !== "" && !/^\d+\.\d+\.\d+$/.test(v)) return false;
    minClientVersion = v;
    return true;
  },
  // Both sides get a deliberate "bye": the session closes there and the viewer does not reconnect by itself.
  endSession(host) {
    const viewer = hosting.get(host);
    if (!viewer) return false;
    removePair(host, viewer);
    sendTo(viewer, { type: "peer-disconnected", fromId: host, bye: true, reason: "" });
    sendTo(host, { type: "peer-disconnected", fromId: viewer, bye: true, reason: "" });
    return true;
  },
  // The app reconnects by itself a moment later unless the device is also blocked.
  disconnect(id) {
    const ws = online.get(id);
    if (!ws) return false;
    try { ws.close(4000, "closed by server"); } catch {}
    return true;
  },
};
const EXT_DIR = path.join(__dirname, "extensions");
let ext = null;
try { ext = require(EXT_DIR)({ online, hosting, owners, control }); }
catch (e) {
  const absent = e.code === "MODULE_NOT_FOUND" && !(e.requireStack || []).some((p) => p.startsWith(EXT_DIR));
  if (!absent) console.error("extensions:", e.message);
}
function note(type, info) { if (ext) ext.onEvent(type, info); }

// The public page only says the server is up: how many devices are online — let alone which — is nobody's business.
const server = http.createServer((req, res) => {
  const noStore = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };
  // A path such as "//" makes new URL() throw, and a throw here used to end the whole process.
  let url;
  try { url = new URL(req.url || "/", "http://x"); } catch { res.writeHead(400, noStore); return res.end(); }
  if (ext && ext.handleHttp(req, res, url, noStore)) return;
  res.writeHead(200, noStore);
  res.end("TryDesk signaling server OK\n");
});

// Reject cross-site WebSocket hijacking: the desktop app connects with no browser Origin (or a
// file:// / null origin); a page in someone's browser would send an http(s) Origin — refuse those.
// The Android app (Capacitor) serves its bundle from https://app.trydesk.ai.id inside the WebView; that
// host is ours and never serves a real site, so no third-party page can carry this origin.
const APP_ORIGINS = new Set(["https://app.trydesk.ai.id"]);
const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024,
  verifyClient: ({ origin, req }) => {
    const ok = !origin || origin === "null" || /^(file|app):\/\//i.test(origin) || APP_ORIGINS.has(origin);
    if (!ok) note("bad-origin", { origin, req });
    return ok;
  },
});

const ipCounts = new Map();

// The client's address. X-Forwarded-For is only believed when the connection itself comes from a local or private
// address (a reverse proxy such as the official Caddy). A server exposed directly would otherwise let any client
// pick its own "IP" and get around the per-IP connection limit.
const PRIVATE_PEER = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:)/i;
function clientIp(req) {
  const peer = String((req.socket && req.socket.remoteAddress) || "").replace(/^::ffff:/, "");
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (PRIVATE_PEER.test(peer) && fwd) || peer;
}

wss.on("connection", (ws, req) => {
  // ws emits "error" for a frame over maxPayload or invalid UTF-8; with no listener Node treats it as uncaught and
  // the whole server exits (every session dropped). Registered first, before anything below can return early.
  ws.on("error", () => {});
  const ip = clientIp(req);
  ws.ip = ip;
  ws.ua = String(req.headers["user-agent"] || "").slice(0, 300);
  ws.sysId = /^\s*id\b/i.test(String(req.headers["accept-language"] || ""));   // system language Indonesian
  ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
  if (ipCounts.get(ip) > limits.connPerIp) {
    ipCounts.set(ip, ipCounts.get(ip) - 1);
    note("ip-limit", { req });
    try { ws.close(1013, "too many connections"); } catch {}
    return;
  }
  ws.isAlive = true;
  if (ext) ext.onConnection(ws, req);
  if (ext && ext.refuse && ext.refuse({ ip })) {
    note("blocked", { ip });
    refuseBlocked(ws);
  }
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (data) => {
    if (!rateOk(ws)) return;   // drop floods
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    // One bad message must never take the whole server (and every user's session) down.
    if (msg && typeof msg.type === "string") {
      try { handle(ws, msg); } catch (e) { console.error(`handle(${String(msg.type).slice(0, 32)}) failed: ${e && e.message}`); }
    }
  });

  ws.on("close", () => {
    const n = (ipCounts.get(ip) || 1) - 1;
    if (n <= 0) ipCounts.delete(ip); else ipCounts.set(ip, n);
    const id = ws.clientId;
    if (!id || online.get(id) !== ws) return;
    // Its own outgoing requests end now. Live PAIRINGS are kept for a short grace period: a Wi-Fi switch or
    // sleep drops only this socket while the peer-to-peer session goes on, and the client re-registers within
    // seconds — dropping the pairing made later renegotiation (codec change) and "disconnect" relays vanish.
    // A client that is really gone loses its P2P link too, so its peer ends the session on its own.
    if (pending.has(id)) { for (const target of pending.get(id)) sendTo(target, { type: "request-cancelled", fromId: id }); pending.delete(id); }
    if (peersOf(id).length) {
      clearTimeout(away.get(id));
      away.set(id, setTimeout(() => { away.delete(id); if (!online.has(id)) unpairAll(id); }, AWAY_GRACE_MS));
    }
    // Tell anyone who was still requesting id that it went offline.
    for (const [req, targets] of pending) {
      if (targets.has(id)) {
        removePending(req, id);
        sendTo(req, { type: "error", code: "host-offline", targetId: id, message: "Remote desktop offline" });
      }
    }
    online.delete(id);
    if (owners.has(id)) markSeen(id);   // last seen = when it went offline (see roomForOwner)
    note("offline", { id, ws });
    console.log(`[-] ${id} (${online.size} online)`);
  });
});

// Keeps connections alive through proxies (Render/Cloudflare close idle sockets)
setInterval(() => {
  sweepReqBudgets();
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

// TURN credentials expire after TURN_TTL: every signed-in connection gets fresh ones before that (see TURN_PUSH_MS).
setInterval(() => {
  if (!TURN_SECRET || !TURN_HOST) return;
  const now = Date.now();
  for (const ws of online.values()) {
    if (!ws || !ws.iceRenew || ws.readyState !== 1 || now - (ws.iceAt || 0) < TURN_PUSH_MS) continue;   // older apps ignore it
    send(ws, { type: "ice-servers", iceServers: turnServers(ws.clientId) });
    ws.iceAt = now;
  }
}, Math.min(60 * 1000, Math.max(500, TURN_PUSH_MS / 4)));

// Last line of defence: a bug that slips past the guards above is logged instead of taking every session down.
process.on("uncaughtException", (e) => console.error("uncaught:", e && e.stack || e));

server.listen(PORT, () => console.log(`TryDesk signaling server on port ${PORT}` +
  (minClientVersion ? `, oldest app allowed ${minClientVersion}` : process.env.MIN_CLIENT_VERSION ? `, MIN_CLIENT_VERSION "${process.env.MIN_CLIENT_VERSION}" ignored (use x.y.z)` : "")));
