let config = null;
let _gameActive = false;   // native game-mouse capture engaged (declared early, refreshKeyCapture reads it)
let serverUrl = "";
let ws = null;
let myId = null;
let _regenPending = false;   // true while a user-initiated ID regeneration is reconnecting
let _adminTipShown = false;  // one-time "run as admin" hint when hosting without elevation
let serverIceServers = [];
// TURN logins from the server used to last 2 h and came only at sign-in, so a TryDesk online for longer (the
// service, a tray app) had no relay left and sessions that needed one died after 30 s (Threads report 19 Nov, 1.3.9).
// Servers from 19 Nov send fresh ones every hour ("ice-servers") and on request ("ice-refresh"); older servers ignore it.
let serverIceAt = 0;
function iceFresh() { if (serverIceServers.length && Date.now() - serverIceAt > 30 * 60 * 1000) sendSignalNow({ type: "ice-refresh" }); }
// The STUN / TURN list for a connection ("p2p" never uses a relay: TURN entries dropped).
function iceServersFor(proto) {
  const all = [...((typeof config !== "undefined" && config && config.iceServers) || []), ...serverIceServers];
  return proto === "p2p" ? all.filter((s) => ![].concat(s.urls || []).some((u) => /^turns?:/i.test(u))) : all;
}
// The relay list the signaling server sends is only taken for its own servers (security audit 22 Nov): a hacked or
// fake server must not point every app at other hosts, such as machines inside the user's own network. Allowed: the
// signaling server's own host name, a sibling of it (turn.trydesk.ai.id next to desk.trydesk.ai.id; not when the shared
// part is as short as "ai.id" or "co.uk"), or a name a self-hosted build lists in config.json "turnHosts". Only
// turn:/turns:/stun:/stuns: addresses; anything else in an entry is dropped. config.json's own list is trusted as is.
function iceHostAllowed(host) {
  let sig = ""; try { sig = new URL(String((config && config.signalingServer) || "")).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch {}
  host = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || !sig) return false;
  if (host === sig) return true;
  if (config && Array.isArray(config.turnHosts) && config.turnHosts.some((h) => String(h).toLowerCase() === host)) return true;
  const isName = (h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) && !/^\d+(\.\d+){3}$/.test(h);
  if (!isName(sig) || !isName(host)) return false;
  const sp = sig.split("."), hp = host.split(".");
  if (sp.length < 3 || hp.length !== sp.length) return false;
  const parent = sp.slice(1);
  if (parent.length < 3 && parent[parent.length - 1].length <= 2) return false;   // "ai.id", "co.uk": too broad
  return hp.slice(1).join(".") === parent.join(".");
}
function safeServerIce(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list.slice(0, 8)) {
    if (!s || typeof s !== "object") continue;
    const urls = [].concat(s.urls || []).filter((u) => {
      const m = /^(turns?|stuns?):(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/i.exec(String(u));
      return !!m && iceHostAllowed(m[2]);
    }).slice(0, 8);
    if (!urls.length) continue;
    const e = { urls };
    if (typeof s.username === "string" && s.username.length <= 512) e.username = s.username;
    if (typeof s.credential === "string" && s.credential.length <= 512) e.credential = s.credential;
    out.push(e);
  }
  if (list.length && !out.length) { try { window.electronAPI.logInfo("relay list from the server refused (not this server's own hosts)"); } catch {} }
  return out;
}
// Fresh relay logins also go to the connections already running: one relayed longer than the login's 12 h, or one that
// restarts its route after that, kept the old login and lost the relay (audit 19 Nov).
function iceRenewRunning() {
  for (const s of [...sessions.values(), ...(host ? [host] : [])]) {
    if (!s || !s.pc || isLanId(s.peerId) || s.pc.connectionState === "closed") continue;
    try { s.pc.setConfiguration({ ...s.pc.getConfiguration(), iceServers: iceServersFor(s.iceProto || prefGet("protocol")) }); } catch {}
  }
}
let reconnectTimer = null;

// ─── Host-side state (single session: a host is controlled by exactly one viewer) ───
let hostCaptureHeight = 0;        // host side native capture height
let hostCaptureFps = 60;          // host side current capture frame-rate cap
let hostQuality = { bitrate: 1000, fps: 240, resHeight: 0 };
let acceptPending = false;        // an accept dialog is currently open for an incoming request
let acceptTimerHandle = null;
let acceptDlgCancel = null;       // cancels that dialog (resolves it false) if the session ends
let acceptDlgSettle = null;       // settles it either way (a correct password typed meanwhile → true)
let acceptFromId = null;          // who that dialog is for (so their request-cancelled closes it)
let hostingStartTime = null;
let hostingTimerHandle = null;

// ─── App-wide settings (shared across all tabs) ───
let clipboardSync = true;
let autoReconnect = false;
let scaleMode = "fit";            // view scale of the ACTIVE tab (kept in sync with active.scaleMode)

const CHUNK = 64 * 1024;
const BUFFER_HIGH = 8 * 1024 * 1024;
// File data goes out paced, through a small queue. Filling an 8 MB queue as fast as possible made a rented PC's
// network drop the burst and the transfer collapsed to ~0.7 Mbps (twice, two machines); paced at 30 Mbps the
// same 20 MB took 5.6 s (2026-11-02). The rate adapts every 500 ms on what actually LEFT this PC: up while the
// link keeps up with it, down to what left when it clearly can't.
const FILE_QUEUE = 256 * 1024;
function filePacer(ch) {
  let rate = 30e6 / 8, nextAt = 0, winT = performance.now(), winSent = 0, winBuf = ch.bufferedAmount;
  return async (chunk) => {
    // A closed channel keeps its bufferedAmount: without this check a transfer cut off by a disconnect waited here
    // for ever, holding its file open.
    while (ch.bufferedAmount > FILE_QUEUE) { if (ch.readyState !== "open") throw new Error("channel closed"); await sleep(5); }
    if (ch.readyState !== "open") throw new Error("channel closed");
    const now = performance.now();
    if (now - winT >= 500) {
      const leftRate = (winSent - (ch.bufferedAmount - winBuf)) / ((now - winT) / 1000);
      if (leftRate >= rate * 0.85) rate = Math.min(rate * 1.25, 800e6 / 8);
      else if (leftRate < rate * 0.6) rate = Math.max(leftRate * 1.1, 2e6 / 8);
      winT = now; winSent = 0; winBuf = ch.bufferedAmount;
    }
    if (nextAt > now) await sleep(nextAt - now);
    ch.send(chunk);
    const n = chunk.byteLength || chunk.length;
    winSent += n;
    nextAt = Math.max(nextAt, performance.now()) + (n / rate) * 1000;
  };
}

// Quality template, a new viewer tab clones this; editing quality in a tab updates that live
// tab and persists here as the default for the next tab.
// 240 fps unless the person picks less (owner 20 Nov: "di semua komputer ... tidak ada batasan FPS"). It only means "no
// cap": the fast path takes up to that on a clean link; WebRTC sends what the screen gives and keeps its sharpness rules
// (startLinkControl, WEBRTC_RULES_FPS); a weak link still lowers it.
// The bitrate likewise is only a ceiling: WebRTC starts at 4 Mbps and follows its estimate (at most WEBRTC_MAX_MBPS),
// the fast path starts at FAST_START_MAX_MBPS at most and climbs only while the picture needs it.
const DEFAULT_QUALITY = { bitrate: 1000, fps: 240, resHeight: 0, codec: "auto" };
let defaultQuality = { ...DEFAULT_QUALITY };

// ═══════════════════════════════════════════════════════════
//  Per-session state, one Session per remote tab (viewer side)
//  plus one for the host role. Every connection-bound value lives
//  here so multiple remote tabs stay fully independent.
// ═══════════════════════════════════════════════════════════
let sessionSeq = 0;
class Session {
  constructor(peerId, role) {
    this.sid = `s${++sessionSeq}`;
    this.peerId = peerId;
    this.role = role;                 // "viewer" | "host"
    this.pc = null;
    this.dataChannel = null;
    this.fileChannel = null;
    this.localStream = null;          // host only
    this.videoTransceiver = null;     // viewer only
    this.videoTrack = null;           // host only
    this.pendingCandidates = [];
    // display / quality
    this.monitors = [];
    this.currentMonitor = 0;
    this.capChain = Promise.resolve();   // host only: serializes capture swaps (see replaceCaptureTrack)
    this.audioAvailable = false;
    // Settings → Audio → play remote audio automatically (on by default since 14 Nov 2026). Not when this PC is at the same
    // time being controlled by that same PC: its sound would come back through this PC's sound capture as an echo.
    this.audioOn = role === "viewer" && prefGet("autoAudio") && !(host && host.peerId === peerId);
    this.quality = { ...defaultQuality };
    this.scaleMode = role === "viewer" ? prefGet("defScale") : "fit"; // Settings → Tampilan → default scale
    this.viewOnly = false;
    this.blackScreenActive = false;
    this.inputLocked = false;
    // clipboard
    this.clipTimer = null;
    this.lastClipboard = "";
    // stats / timers
    this.statsTimer = null;
    this.statsLast = { bytes: 0, ts: 0 };
    this.disconnectTimer = null;
    this.reconnectAttempts = 0;
    this.sessionTimer = null;
    this.sessionStart = 0;
    this.latencyText = "- ms";
    this.timerText = "00:00";
    // file transfer + file manager (per session)
    this.activeSend = null;
    this.activeRecv = null;
    this.acceptResolver = null;
    this.mgrGetAck = null;
    this.fsPending = new Map();
    this.fsReqSeq = 0;
    this.fm = {
      local:  { path: null, display: "", parent: null, isRoot: false, entries: [], sel: new Set(), sort: { key: "name", asc: true } },
      remote: { path: null, display: "", parent: null, isRoot: false, entries: [], sel: new Set(), sort: { key: "name", asc: true } },
    };
    this.fmQueue = [];
    this.fmQueueSeq = 0;
    this.fmRunning = false;
    // chat (per peer)
    this.chatLog = [];
    this.chatUnread = false;
    // video element (viewer only), created lazily by ensureVideo()
    this.video = null;
    this.hasFrame = false;
    this.label = peerId;              // tab label (updated to monitor name when known)
  }
}

// Viewer tabs, keyed by peerId (the remote being controlled). Insertion order = tab order.
const sessions = new Map();
let active = null;      // active viewer Session (its UI is shown) or null
let host = null;        // the single host Session (we are being controlled) or null

function viewerSessions() { return [...sessions.values()]; }

const PRESETS = {
  hemat:    { bitrate: 3,   fps: 15, resHeight: 720 },
  seimbang: { bitrate: 20,  fps: 30, resHeight: 0 },
  kualitas: { bitrate: 60,  fps: 60, resHeight: 0 },
  ultra:    { bitrate: 150, fps: 120, resHeight: 0 },
  gaming:   { bitrate: 300, fps: 165, resHeight: 0 },
  maksimal: { bitrate: 1000, fps: 240, resHeight: 0 },
};
// The highest bitrate a session may ask for (slider, presets, what the host accepts). Only the fast path's own UDP
// link (Windows to Windows on a LAN, see trydesk-udp.h) can carry it: Chromium's paths are capped below.
const BITRATE_MAX_MBPS = 1000;
// What goes through Chromium stays at 300: its WebRTC video collapsed to ~1 fps above ~350 Mbps (bench run5,
// 2026-11-02) and its data channel tops out near 335 Mbps on one PC. The SDP ceiling and the fast path over the
// data channel use this; a higher slider value simply waits for the UDP link.
const WEBRTC_MAX_MBPS = 300;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const myIdText = $(".id-text");
// Show a 9-digit TryDesk ID as "xxx xxx xxx" so it reads as an ID, not a raw number.
function fmtId(id) {
  // LAN peers ("lan:192.168.1.20", "lan-in:192.168.1.5#3") show their address.
  if (typeof id === "string" && /^lan(-in)?:/.test(id)) return id.replace(/^lan(-in)?:/, "").replace(/#\d+$/, "") + " (LAN)";
  const d = String(id == null ? "" : id).replace(/\s/g, "");
  return /^\d{9}$/.test(d) ? d.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3") : String(id == null ? "" : id);
}
const statusDot = $("#status-dot");
const statusText = $("#status-text");
const remoteIdInput = $("#remote-id");
const remotePasswordInput = $("#remote-password");
const accessPassword = $("#access-password");
const overlaySettings = $("#overlay-settings");
const qualityPanel = $("#quality-panel");
const statsOverlay = $("#stats-overlay");

// The active tab's <video> (per-session). Null on home/hosting screens.
function activeVideo() { return active ? active.video : null; }
// Create (once) the <video> element that renders a viewer session's remote screen.
function ensureVideo(sess) {
  if (sess.video) return sess.video;
  const v = document.createElement("video");
  v.className = "remote-video";
  v.tabIndex = 0;
  v.autoplay = true; v.playsInline = true; v.muted = true;
  v.addEventListener("loadedmetadata", () => { if (sess === active) applyScale(); });
  v.addEventListener("resize", () => {
    if (sess === active) applyScale();
    // NOTE: do NOT dim here. WebRTC continuously adjusts the encoded resolution to match the
    // bandwidth estimate (especially while BWE settles in the first seconds, and under any
    // bitrate cap), each adjustment fires "resize". Dimming on every one of those produced the
    // periodic flicker users saw even on a fast link. A user-initiated monitor switch is masked by
    // the local monitor-switch handler instead.
  });
  v.addEventListener("playing", () => {
    const first = !sess.hasFrame;
    sess.hasFrame = true; if (sess === active) $("#remote-loading")?.classList.add("hidden");
    if (first) renderTabs();   // the tab's dot turns green with the first picture (it stayed orange before)
    // Recent-tile thumbnail: once the picture has settled (refreshed again when the session ends)
    if (sess.role === "viewer" && !sess.thumbTimer) sess.thumbTimer = setTimeout(() => saveThumb(sess), 4000);
  });
  v.addEventListener("loadeddata", () => { if (v.videoWidth) { const first = !sess.hasFrame; sess.hasFrame = true; if (sess === active) $("#remote-loading")?.classList.add("hidden"); if (first) renderTabs(); } });
  $("#video-wrap").appendChild(v);
  sess.video = v;
  return v;
}

// Secrets (audit 19 Nov 2026, TD-VULN-04a): the access password's key no longer sits in plain localStorage. On the
// desktop it is kept encrypted by Windows for this user (main.js, safeStorage); read once here at start and cached.
// Where that isn't available (the phone app, the service's own host, a Linux without a keyring) it stays as before.
const SECRET_KEYS = new Set(["accessPasswordHash"]);
const secretCache = new Map();
let secretsOn = false;
const store = {
  get(key) { if (secretsOn && SECRET_KEYS.has(key)) return secretCache.get(key) ?? null; try { return localStorage.getItem(key); } catch { return null; } },
  set(key, val) {
    // (a plain copy still waiting to be confirmed goes now: from here on the encrypted one is the newest)
    if (secretsOn && SECRET_KEYS.has(key)) { secretCache.set(key, val ?? null); try { window.electronAPI.secretSet(key, val); } catch {} try { localStorage.removeItem(key); } catch {} return; }
    try { val == null ? localStorage.removeItem(key) : localStorage.setItem(key, val); } catch {}
  },
};
(function secretsInit() {
  const api = window.electronAPI;
  if (!api || typeof api.secretGet !== "function") return;
  for (const key of SECRET_KEYS) {
    let r = null; try { r = api.secretGet(key); } catch {}
    if (!r || r.unavailable) return;   // not here: localStorage as before
    let old = null; try { old = localStorage.getItem(key); } catch {}
    let v = r.value || null;
    // A plain copy exists only when an older TryDesk wrote it (first start after the update, or after going back to an
    // older version and changing the password there): it is the newest, so it moves over. The plain copy goes only once
    // the encrypted one reads back the same (the next start): if Windows couldn't save it, the password isn't lost.
    if (old && r.value === old) { try { localStorage.removeItem(key); } catch {} }
    else if (old) { api.secretSet(key, old); v = old; }
    secretCache.set(key, v);
  }
  secretsOn = true;
})();

// ─── i18n ─────────────────────────────────────────────────
// The UI is written in Indonesian; English is TEXT_EN below; every other language is a file in locales/ (made by
// scripts/i18n-build.mjs from translations of locales/source.json), loaded when it is picked. A text a language
// file doesn't have yet shows in English, never in Indonesian. Owner 16 Nov 2026: 21 languages, picked on cards.
let lang = "id";
const LANGS = [
  { c: "id", n: "Bahasa Indonesia", g: "Halo" }, { c: "en", n: "English", g: "Hello" }, { c: "ms", n: "Bahasa Melayu", g: "Helo" },
  { c: "zh-CN", n: "简体中文", g: "你好" }, { c: "zh-TW", n: "繁體中文", g: "你好" }, { c: "ja", n: "日本語", g: "こんにちは" },
  { c: "ko", n: "한국어", g: "안녕하세요" }, { c: "vi", n: "Tiếng Việt", g: "Xin chào" }, { c: "th", n: "ไทย", g: "สวัสดี" },
  { c: "fil", n: "Filipino", g: "Kumusta" }, { c: "es", n: "Español", g: "Hola" }, { c: "pt-BR", n: "Português (Brasil)", g: "Olá" },
  { c: "hi", n: "हिन्दी", g: "नमस्ते" }, { c: "ru", n: "Русский", g: "Привет" }, { c: "fr", n: "Français", g: "Bonjour" },
  { c: "de", n: "Deutsch", g: "Hallo" }, { c: "tr", n: "Türkçe", g: "Merhaba" }, { c: "pl", n: "Polski", g: "Cześć" },
  { c: "it", n: "Italiano", g: "Ciao" }, { c: "nl", n: "Nederlands", g: "Hallo" }, { c: "uk", n: "Українська", g: "Привіт" },
  { c: "ar", n: "العربية", g: "مرحبًا", rtl: true },
];
const LANG_CODES = new Set(LANGS.map((x) => x.c));
let LOC = null;   // { code, s: { Indonesian: translation }, p: [[RegExp, replacement]] } for a language other than id/en
// The language Windows (or the phone) is set to, among the ones TryDesk has; English otherwise.
function sysLang() {
  for (const raw of (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""])) {
    const l = String(raw).toLowerCase();
    if (/^zh-(tw|hk|mo|hant)/.test(l)) return "zh-TW";
    if (/^zh/.test(l)) return "zh-CN";
    if (/^pt/.test(l)) return "pt-BR";
    if (/^(fil|tl)\b/.test(l)) return "fil";
    if (/^(in|id)\b/.test(l)) return "id";
    const base = l.split(/[-_]/)[0];
    if (LANG_CODES.has(base)) return base;
  }
  return "en";
}
function loadLocale(code) {
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = `locales/${code}.js`;
    s.onload = () => { const d = window.TD_LOCALE; s.remove(); resolve(d && d.code === code ? d : null); };
    s.onerror = () => { s.remove(); resolve(null); };
    document.head.appendChild(s);
  });
}
function compileLocale(d) {
  if (!d) return null;
  const p = [];
  for (const [re, flags, tpl] of d.p || []) { try { p.push([new RegExp(re, flags || ""), String(tpl).replace(/\$/g, "$$$$").replace(/\{(\d)\}/g, "$$$1")]); } catch {} }
  return { code: d.code, s: d.s || {}, p };
}
// One text in the current language: Indonesian as written, English given, any other language from its file
// (falling back to the English). Used where code picks the text itself instead of the page translating it.
function trL(id, en) {
  if (lang === "id") return id;
  if (lang === "en" || !LOC) return en;
  // (a translation can equal the Indonesian: Malay "Jeda", "Pilih semua"; that is still the language's own word)
  const k = id.replace(/\s+/g, " ");
  if (LOC.s[k] != null) return LOC.s[k];
  const out = trCore(id);
  return out !== id ? out : en;
}
// The decimal separator and the hour:minute separator of the current language.
const decSep = () => { try { return (1.5).toLocaleString(lang === "fil" ? "en" : lang).replace(/\d/g, "").charAt(0) || "."; } catch { return "."; } };
const timeSep = () => (lang === "id" ? "." : ":");
const I18N = {
  id: {
    // dynamic / toasts
    fav_added: "Ditambahkan ke favorit", fav_removed: "Dihapus dari favorit",
    fav_add_tip: "Tambah ke favorit", fav_remove_tip: "Hapus dari favorit",
    connecting_server: "Menghubungkan ke server...", connected_server: "Terhubung ke server",
    server_disconnected: "Terputus dari server", id_copied: "ID disalin!",
    reconnecting: "Koneksi terputus, mencoba sambung ulang...", reconnect_failed: "Gagal menyambung ulang",
    alias_saved: "Alias disimpan", alias_removed: "Alias dihapus",
    lang_changed: "Bahasa diubah ke Indonesia",
    delete_tip: "Hapus dari riwayat",
    time_now: "Baru saja", time_min: "menit lalu", time_hour: "jam lalu", time_day: "hari lalu",
    id_regenerated: "ID baru berhasil dibuat", ui_regen_id_title: "Buat ID baru", regen_failed: "Gagal membuat ID baru", regen_svc_wait: "ID PC ini dipegang layanan Windows: setujui izin administrator untuk membuat ID baru", regen_svc_cancel: "ID tidak diganti: izin administrator tidak diberikan",
    regen_confirm_title: "Buat ID baru?", regen_confirm_ok: "Ya, buat ID baru", regen_confirm_cancel: "Batal",
    fsd_exit: "Keluar",   // full-screen dock: leave full screen (the plain text "Keluar" is the tray's "Quit")
    regen_confirm_msg: "ID lama Anda akan berhenti berlaku.",
    regen_confirm_detail: "Orang yang menyimpan ID lama tidak bisa tersambung lagi dan harus diberi ID yang baru. Sesi yang sedang berjalan akan terputus.",
  },
  en: {
    // static UI (data-i18n)
    ui_desktop_this: "This desktop", ui_your_id: "Your ID",
    ui_id_note: "Give this ID to the person who will help you.",
    ui_remote_desktop: "Remote Desktop", ui_remote_id: "Remote ID",
    ui_favorites: "Favorites", ui_recent: "Recent Connections", ui_recent_title: "Recent", ui_all: "All",
    ui_quality_img: "Picture quality", ui_network: "Network", ui_service: "Windows service", ui_about: "About",
    ui_connect: "Connect", ui_settings: "Settings", ui_general: "General",
    ui_connection: "Connection", ui_security: "Security", ui_display: "Display",
    ui_audio: "Audio", ui_advanced: "Advanced", ui_language: "Interface language",
    ui_theme: "Theme", ui_device_alias: "Device alias", ui_save: "Save",
    ui_notifications: "Notifications", ui_cancel: "Cancel", ui_disconnect: "Disconnect",
    ui_quality: "Quality", ui_chat: "Chat", ui_keys: "Keys", ui_viewonly: "View only",
    ui_blackscreen: "Black screen", ui_lockinput: "Lock input", ui_file: "File",
    ui_session_active: "Remote Session Active", ui_being_controlled: "Your desktop is being controlled",
    ui_incoming: "Incoming Connection Request", ui_accept: "Accept", ui_reject: "Reject",
    ui_connecting: "Connecting", ui_send_file: "Send File",
    ui_sort_recent: "Most recent", ui_sort_id: "ID number", ui_clear_all: "Clear all",
    // placeholders
    ph_remote_id: "Enter an ID or IP address", ph_password: "Password (if asked)",
    // dynamic / toasts
    fav_added: "Added to favorites", fav_removed: "Removed from favorites",
    fav_add_tip: "Add to favorites", fav_remove_tip: "Remove from favorites",
    connecting_server: "Connecting to server...", connected_server: "Connected to server",
    server_disconnected: "Disconnected from server", id_copied: "ID copied!",
    reconnecting: "Connection lost, reconnecting...", reconnect_failed: "Reconnect failed",
    alias_saved: "Alias saved", alias_removed: "Alias removed",
    lang_changed: "Language changed to English",
    delete_tip: "Remove from history",
    time_now: "Just now", time_min: "min ago", time_hour: "h ago", time_day: "d ago",
    id_regenerated: "New ID generated", ui_regen_id_title: "Generate new ID", regen_failed: "Failed to generate new ID", regen_svc_wait: "This PC's ID belongs to the Windows service: approve the administrator prompt to get a new ID", regen_svc_cancel: "ID not changed: administrator permission was not given",
    regen_confirm_title: "Generate a new ID?", regen_confirm_ok: "Yes, generate new ID", regen_confirm_cancel: "Cancel",
    fsd_exit: "Exit",
    regen_confirm_msg: "Your current ID will stop working.",
    regen_confirm_detail: "Anyone who saved the old ID can no longer connect and needs the new one. A running session will disconnect.",
  },
};
function t(key) {
  if (lang !== "id" && lang !== "en") return I18N.id[key] != null ? trL(I18N.id[key], I18N.en[key] != null ? I18N.en[key] : I18N.id[key]) : (I18N.en[key] != null ? I18N.en[key] : key);
  const l = I18N[lang] || I18N.id;
  return (key in l) ? l[key] : (I18N.id[key] != null ? I18N.id[key] : key);
}
function applyLanguage(l) {
  lang = LANG_CODES.has(l) ? l : "id";
  if (lang === "id" || lang === "en") LOC = null;
  else if (!LOC || LOC.code !== lang) {
    // Until its file is in, the text shows in English; then everything is drawn again in the language.
    LOC = null;
    const want = lang;
    loadLocale(want).then((d) => { if (lang === want && d) { LOC = compileLocale(d); applyLanguage(want); } });
  }
  document.documentElement.setAttribute("lang", lang);
  document.documentElement.setAttribute("dir", LANGS.find((x) => x.c === lang)?.rtl ? "rtl" : "ltr");
  // Kept next to identity.json, for the service's window (see serviceFollowUserLang).
  try { if (!(config && config.serviceHost)) window.electronAPI?.exportUiLang?.(lang); } catch {}
  // ID is the text authored in HTML; capture it once, then toggle to EN from the dictionary.
  $$("[data-i18n]").forEach((el) => {
    if (el._i18nId == null) el._i18nId = el.textContent;
    el.textContent = (lang === "en") ? t(el.getAttribute("data-i18n")) : el._i18nId;   // other languages: the text observer translates the Indonesian
  });
  $$("[data-i18n-ph]").forEach((el) => {
    if (el._i18nPhId == null) el._i18nPhId = el.placeholder;
    el.placeholder = (lang === "en") ? t(el.getAttribute("data-i18n-ph")) : el._i18nPhId;
  });
  $$("[data-i18n-title]").forEach((el) => {
    if (el._i18nTitleId == null) el._i18nTitleId = el.title;
    el.title = (lang === "en") ? t(el.getAttribute("data-i18n-title")) : el._i18nTitleId;
  });
  trTree(document.body);
  try { trHelpBlocks(); } catch {}
  try { fitHomeText(); } catch {}
  // Text built with t() at render time ("1 jam lalu" / "1 h ago" on the tiles) is in the language of that moment;
  // the text map only goes ID → EN, so switching back left it in English. Build the tiles again.
  try { if (typeof renderRecent === "function" && document.querySelector(".recent-tile")) renderRecent(); } catch {}
  try { if (typeof renderUpdateBar === "function") renderUpdateBar(); } catch {}
  try { if (typeof renderTabs === "function" && document.querySelector(".rtab")) renderTabs(); } catch {}   // tab hints are built in the language of that moment
  try { if (typeof kmRefresh === "function") { kmRefresh(); if (KM.panel) kmRenderPanel(); } } catch {}   // Kelola too, even with no recent tile
  // Main process shows its own text (error dialogs, black-screen overlay, Discord presence), keep it in step.
  try { window.electronAPI.setUiLanguage && window.electronAPI.setUiLanguage(lang); } catch {}
  // The server writes some messages itself (update required, too many requests): it answers in this language.
  // (a language the server doesn't speak gets Indonesian, which the text observer then translates)
  try { if (typeof sendSignal === "function") sendSignal({ type: "lang", lang: lang === "en" ? "en" : "id" }); } catch {}
  try { if (typeof paintLangCards === "function") paintLangCards(); } catch {}
  try { if (typeof updateAccessPwUI === "function" && document.getElementById("access-pw-state")) updateAccessPwUI(); } catch {}   // its date is written in the language
}

// App-wide translation via a text map: the UI is authored in Indonesian, and every text node, placeholder,
// tooltip and aria-label whose text appears here is shown in English when the language is EN, including
// text added later (toasts, menus, transfer cards, status lines) and messages that arrive from a peer or the
// signaling server. Strings with variable parts go in TEXT_EN_PATTERNS. See trTree / trObserver below.
const TEXT_EN = {
  // Home: the stage sentence, one word group per text node
  "Masukkan ID,": "Enter an ID,", "lalu": "then", "Hubungkan.": "Connect.",
  // Control Center: labels under the live numbers
  "gambar": "frames", "jeda": "latency", "data": "data",
  // Full-screen dock
  "Kontrol sesi": "Session controls", "Tombol": "Keys", "Menu": "Menu", "Jendela": "Window",
  "Pindah ke monitor berikutnya": "Switch to the next monitor", "Keluar dari layar penuh": "Leave full screen",
  "Keluar dari layar penuh (Ctrl+Alt+Shift+Esc)": "Leave full screen (Ctrl+Alt+Shift+Esc)", "Menu sesi": "Session menu",
  "Menu sesi ada di tombol kecil di atas layar. Keluar dari layar penuh: Ctrl+Alt+Shift+Esc": "The session menu is the small tab at the top of the screen. To leave full screen: Ctrl+Alt+Shift+Esc",
  "Menu sesi ada di tombol kecil di atas layar, termasuk tombol Keluar dari layar penuh.": "The session menu is the small tab at the top of the screen, with the button to leave full screen.",
  // Settings → Keamanan, at a glance
  "Saat ada yang meminta": "When someone asks", "Yang boleh dilakukan": "What they may do", "Setelah restart": "After a restart",
  "Masuk dengan password": "In with the password", "Selalu tanya": "Always ask", "Mouse dan keyboard": "Mouse and keyboard",
  "Hanya melihat": "View only", "Tetap bisa diakses": "Still reachable", "Perlu TryDesk terbuka": "Needs TryDesk open",
  // Combined design, remaining screens
  "Desktop ini": "This desktop", ", online": ", online", ", offline": ", offline", ", menghubungkan": ", connecting",
  "ID baru": "New ID", "Password (jika diminta)": "Password (if asked)",
  "PC ini meminta": "This PC asks for a", "password.": "password.",
  "Desktop ini sedang": "This desktop is being", "dikontrol.": "controlled.",
  "Belum ada koneksi.": "No connections yet.", "Ketik ID PC di atas": "Type a PC's ID above",
  "PC yang pernah Anda hubungi muncul di sini, dengan gambar layar terakhirnya.": "PCs you connect to show up here, with their last screen.",
  "Permintaan masuk": "Incoming request", "Melihat layar": "See the screen", "File": "Files", "Clipboard": "Clipboard",
  "Anda tetap bisa memakai PC ini. Putuskan kapan saja.": "You can keep using this PC. Disconnect at any time.",
  "lama sesi": "session time", "Dikontrol oleh": "Controlled by",
  "tidak menjawab.": "did not answer.", "menolak.": "declined.", "sedang offline.": "is offline.", "sedang sibuk.": "is busy.",
  "Permintaan sudah terkirim, tetapi pemilik PC itu tidak menekan Terima.": "The request arrived, but the PC's owner did not press Accept.",
  "Minta pemilik PC menekan Terima saat layar merah muncul.": "Ask the PC's owner to press Accept when the red screen appears.",
  "Atau minta password akses, supaya tidak perlu menunggu Terima.": "Or ask for the access password, so nobody has to press Accept.",
  "Pemilik PC itu menekan Tolak.": "The PC's owner pressed Decline.", "Pastikan pemilik PC tahu Anda akan menyambung.": "Make sure the PC's owner knows you are connecting.",
  "ID tidak ditemukan, atau TryDesk di PC itu tidak tersambung ke internet.": "The ID was not found, or TryDesk on that PC is not connected to the internet.",
  "Pastikan TryDesk di PC itu terbuka dan menampilkan Online.": "Make sure TryDesk is open on that PC and shows Online.",
  "Jika satu jaringan, coba Sambung lewat IP.": "On the same network? Try Connect by IP.",
  "PC itu sedang dalam sesi dengan perangkat lain.": "That PC is in a session with another device.", "Coba lagi setelah sesi itu selesai.": "Try again when that session ends.",
  "Kembali ke Beranda": "Back to Home", "Coba lagi": "Try again",
  "Kualitas lanjutan ›": "Advanced quality ›", "Ukuran gambar": "Picture size", "Lihat saja (tanpa kontrol)": "View only (no control)",
  "Gelapkan layar PC": "Darken the PC's screen", "Kunci mouse dan keyboard PC": "Lock the PC's mouse and keyboard",
  "Suara dari PC (tidak tersedia)": "Sound from the PC (not available)", "Mode game": "Game mode", "Keluar penuh": "Exit full",
  "Kirim file": "Send file", "Grid": "Grid", "Daftar": "List", "Mode game (mouse relatif)": "Game mode (relative mouse)", "Waktu tunggu": "Timeout",
  "Terima otomatis": "Accept automatically", "Jika password benar, tidak perlu klik Terima": "If the password is right, no need to press Accept",
  "Izin tamu": "Guest permissions", "Hanya melihat": "View only", "Yang boleh dilakukan orang yang mengontrol PC ini.": "What the person controlling this PC may do.",
  "ID perangkat": "Device ID", "Nama, bahasa, dan": "Name, language, and", "tampilan.": "appearance.",
  "Bagaimana PC ini terlihat oleh orang lain, dan bagaimana TryDesk terlihat oleh Anda.": "How this PC looks to others, and how TryDesk looks to you.",
  "Tanpa password, setiap koneksi harus Anda terima dulu di layar ini. Dengan password, tamu yang tahu password langsung masuk.": "Without a password, you accept every connection on this screen first. With a password, a guest who knows it gets in directly.",
  "Gambar dan suara": "Picture and sound", "bawaan.": "defaults.", "Dipakai setiap kali sesi baru dibuka. Saat sesi berjalan, ubah lewat Control Center.": "Used whenever a new session opens. During a session, change it in Control Center.",
  "Waktu tunggu, sambung ulang, jalur koneksi, dan sambung lewat IP di jaringan yang sama.": "Timeout, reconnecting, the connection route, and connecting by IP on the same network.",
  "Tetap bisa dihubungi": "Reachable", "setelah restart.": "after a restart.",
  "Dengan layanan Windows, PC ini tetap bisa dikontrol setelah restart dan saat sesi RDP diputus, dengan ID yang sama. Versi Setup memasangnya otomatis; versi Portable tidak memakai layanan.": "With the Windows service, this PC can still be controlled after a restart and when an RDP session is disconnected, with the same ID. The Setup version installs it; the Portable version does not use the service.",
  "Versi dan": "Version and", "data.": "data.", "Informasi TryDesk, rendering, dan mengembalikan pengaturan ke bawaan.": "About TryDesk, rendering, and resetting the settings.",
  "Buat ID baru": "Generate new ID",
  "Semua perangkat": "All devices", "Kelola banyak perangkat": "Manage many devices", "Belum ada koneksi. PC yang pernah Anda hubungi muncul di sini.": "No connections yet. PCs you connect to show up here.", "Cara sambung lewat IP": "How to connect by IP", "Sambung ulang": "Reconnect", "Jalur koneksi": "Connection route",
  "Sambung lewat IP,": "Connect by IP,", "tanpa internet.": "no internet needed.",
  "Ikuti Windows": "Follow Windows", "Ikuti HP": "Follow phone", "Nama perangkat": "Device name", "Pemberitahuan": "Notifications",
  "Nama ini terlihat oleh PC yang Anda hubungi.": "PCs you connect to see this name.",
  "gambar/detik": "frames/s", "Paket hilang": "Packet loss",
  "Maks": "Max", "Layar": "Screen", "lanjutan.": "settings.", "Volume": "Volume", "Gaming": "Gaming", "Control Center": "Control Center",
  "Server sinyal": "Signal server", "Menunggu PC menerima": "Waiting for the PC to accept", "Jalur langsung (P2P)": "Direct link (P2P)",
  "Pengaturan kualitas": "Quality settings", "Manajer file": "File manager",
  // Settings: the sentence that opens each tab (plain part + red key word)
  "Nama, bahasa, dan": "Name, language and", "suara.": "sound.",
  "Cara PC ini": "How this PC", "tersambung.": "connects.",
  "Siapa yang boleh": "Who may", "masuk.": "come in.",
  "Gambar dan": "Picture and", "tema.": "theme.",
  "Suara dari PC": "Sound from the PC", "remote.": "remote PC.",
  "Data, rendering, dan": "Data, rendering and", "versi.": "version.",
  // General
  "Alias perangkat": "Device alias", "Simpan": "Save",
  "Tunggu transfer yang sedang berjalan selesai": "Wait for the current transfer to finish",
  "Lokasi ini tidak bisa dibuka dari jarak jauh": "This location can't be opened remotely",
  "Nama ini akan ditampilkan saat meminta koneksi ke perangkat lain.": "This name is shown when requesting a connection to other devices.",
  "Bahasa antarmuka": "Interface language", "Notifikasi": "Notifications",
  "Tampilkan notifikasi koneksi masuk": "Show incoming connection notifications",
  "Suara notifikasi": "Notification sound", "Pembaruan otomatis": "Automatic updates",
  "Efek suara": "Sound effects", "Suara klik di tombol utama": "Click sound on the main buttons",
  "Pelan, dan otomatis diam selama sesi remote berjalan.": "Quiet, and silent by itself while a remote session is running.",
  "Periksa pembaruan saat aplikasi dimulai": "Check for updates on startup",
  // Connection
  "Waktu tunggu koneksi": "Connection timeout",
  "30 detik": "30 seconds", "60 detik": "60 seconds", "120 detik": "120 seconds", "5 menit": "5 minutes", "Tanpa batas": "Unlimited",
  "Auto-accept koneksi": "Auto-accept connections",
  "Terima koneksi otomatis jika ada password": "Auto-accept connections when a password is set",
  "Koneksi lewat IP (LAN)": "Connect by IP (LAN)",
  "Izinkan koneksi langsung dari jaringan lokal": "Allow direct connections from the local network",
  "PC lain di jaringan yang sama bisa tersambung dengan mengetik alamat IP PC ini, tanpa internet. Wajib memakai password akses minimal 10 karakter (tab Keamanan). Saat pertama dinyalakan, Windows akan meminta izin firewall.": "Other PCs on the same network can connect by typing this PC's IP address, with no internet. An access password of at least 10 characters is required (Security tab). The first time it is turned on, Windows asks for firewall permission.",
  "PC ini belum tersambung ke jaringan lokal": "This PC is not connected to a local network yet",
  "Masukkan ID atau alamat IP": "Enter an ID or IP address",
  "Masukkan ID 9 digit atau alamat IP": "Enter a 9-digit ID or an IP address",
  "Belum terhubung ke server, untuk PC di jaringan yang sama, ketik alamat IP-nya": "Not connected to the server, for a PC on the same network, type its IP address",
  "Password salah. Coba lagi.": "Wrong password. Try again.",
  "Menunggu password akses": "Waiting for the access password",
  "Koneksi LAN tidak diaktifkan di PC tujuan": "LAN connections are not turned on on the other PC",
  "PC tujuan belum memasang password akses, koneksi lewat IP membutuhkan password": "The other PC has no access password set, connecting by IP requires one",
  "Koneksi LAN hanya bisa dipakai setelah password akses diset (Pengaturan → Keamanan)": "LAN connections only work once an access password is set (Settings → Security)",
  "Tidak bisa membuka port LAN": "Couldn't open the LAN port",
  "Alamat IP tidak valid": "Invalid IP address",
  "Port tidak valid": "Invalid port",
  "Tidak ada TryDesk yang menjawab di alamat ini": "No TryDesk answered at this address",
  "Hanya alamat jaringan lokal (LAN) yang bisa dipakai": "Only local network (LAN) addresses can be used",
  "PC tujuan tidak menerima koneksi LAN (belum diaktifkan di Pengaturan, atau diblokir firewall)": "The other PC doesn't accept LAN connections (not turned on in Settings, or blocked by a firewall)",
  "Nama PC tidak ditemukan di jaringan": "PC name not found on the network",
  "Tidak bisa terhubung ke alamat ini": "Couldn't connect to this address",
  "Alamat ini bukan PC TryDesk": "This address is not a TryDesk PC",
  "Koneksi ke PC tujuan terputus": "The connection to the other PC dropped",
  "Terhubung ke": "Connected to",
  "Pembaruan keamanan wajib": "Security update required",
  // in-app updates (src/updater.js, 18 Nov 2026)
  "Pembaruan": "Updates", "Yang baru": "What's new", "Pasang sekarang": "Install now", "Perbarui": "Update", "Perbarui sekarang": "Update now", "Cek sekarang": "Check now",
  "Pembaruan TryDesk siap. Dipasang saat TryDesk ditutup, sesi ini tidak diputus.": "The TryDesk update is ready. It installs when you quit TryDesk; this session stays connected.",
  "Putuskan sesi untuk memasang?": "Disconnect to install?",
  "Sesi yang berjalan terputus sekitar 15 detik. Setelah TryDesk terbuka lagi, sambungkan ulang dari Terakhir dihubungi.": "The running session ends for about 15 seconds. When TryDesk reopens, reconnect from Recent.",
  "Putuskan dan pasang": "Disconnect and install", "Pasang setelah sesi": "Install after the session",
  "Pembaruan belum bisa dipasang. Coba lagi nanti.": "The update couldn't be installed. Try again later.",
  "Catatan lengkap ada di trydesk.ai.id.": "The full notes are on trydesk.ai.id.",
  "Sebelum dipasang, file diperiksa dengan tanda tangan TryDesk.": "Before it installs, the file is checked against TryDesk's signature.",
  "TryDesk menutup sebentar lalu terbuka lagi.": "TryDesk closes for a moment, then opens again.",
  "Tanda tangan cocok. Dipasang saat TryDesk ditutup atau dibuka lagi.": "Signature checked. It installs when TryDesk is closed or opened again.",
  "Pembaruan belum terpasang": "The update didn't install",
  "Pemasangan tidak selesai. Coba lagi, atau unduh dari website.": "The install didn't finish. Try again, or download it from the website.",
  "Pembaruan dibatalkan": "Update stopped",
  "File yang terunduh tidak cocok dengan tanda tangan TryDesk. File dihapus, tidak ada yang dipasang.": "The downloaded file didn't match TryDesk's signature. It was deleted and nothing was installed.",
  "ID dan pengaturan tetap sama.": "Your ID and settings stayed the same.",
  "Diunduh otomatis setelah sesi selesai.": "It downloads by itself after the session ends.",
  "Versi ini punya celah keamanan yang sudah diperbaiki. Sambungan ditolak sampai diperbarui. Pembaruan sedang diunduh.": "This version has a security flaw that is now fixed. Connections are refused until you update. The update is downloading.",
  "Versi ini punya celah keamanan yang sudah diperbaiki. Pembaruan sudah siap, dan dipasang otomatis dalam 30 detik bila tidak ada sesi.": "This version has a security flaw that is now fixed. The update is ready and installs by itself in 30 seconds if no session is running.",
  "TryDesk sudah versi terbaru": "TryDesk is up to date",
  "Dicek saat TryDesk dibuka, lalu tiap 6 jam.": "Checked when TryDesk opens, then every 6 hours.",
  "Diunduh dan diperiksa. Dipasang saat TryDesk ditutup atau dibuka lagi.": "Downloaded and checked. It installs when TryDesk is closed or opened again.",
  "Diunduh di latar dan diperiksa tanda tangannya, lalu dipasang saat TryDesk ditutup atau dibuka lagi. Sesi tidak pernah diputus.": "Downloaded in the background and checked against its signature, then installed when TryDesk is closed or opened again. Sessions are never cut off.",
  // the phone app's versions (updPhone(): Android asks before every install, and the app keeps running)
  "Tanda tangan cocok. Android bertanya sekali sebelum memasang.": "Signature checked. Android asks once before it installs.",
  "Pembaruan TryDesk siap. Pasang setelah sesi selesai.": "The TryDesk update is ready. Install it after the session.",
  "Versi ini punya celah keamanan yang sudah diperbaiki. Pembaruan sudah diunduh dan diperiksa.": "This version has a security flaw that is now fixed. The update is downloaded and checked.",
  "Izinkan TryDesk memasang aplikasi, lalu ketuk Pasang sekarang lagi.": "Allow TryDesk to install apps, then tap Install now again.",
  "Sesi yang berjalan terputus. Setelah diperbarui, buka TryDesk lagi.": "The running session ends. After the update, open TryDesk again.",
  "Perbarui TryDesk dulu: versi ini punya celah keamanan yang sudah diperbaiki": "Update TryDesk first: this version has a security issue that has been fixed",
  "PC tujuan memakai versi TryDesk lama yang wajib diperbarui": "The other PC runs an old TryDesk version that must be updated",
  "Salin alamat IP": "Copy IP address",
  "Salin": "Copy", "Sambung lewat IP": "Connect by IP", "Belum diatur": "Not set",
  "Atur": "Set", "Ubah": "Change", "Aktif": "On", "Aktifkan": "Turn on", "Tidak ada jaringan": "No network",
  "Hubungkan dan langsung buka Manajer file": "Connect and open the File Manager right away",
  "Satu jaringan? Sambung lewat IP": "Same network? Connect by IP",
  "Cari ID atau nama": "Search ID or name", "Tidak ada yang cocok dengan pencarian.": "Nothing matches your search.",
  "Belum ada favorit. Klik bintang pada sebuah perangkat untuk menyimpannya di sini.": "No favorites yet. Click the star on a device to keep it here.",
  "Belum ada favorit. Ketuk ⋮ pada sebuah perangkat, lalu pilih Tambah ke favorit.": "No favorites yet. Tap ⋮ on a device, then choose Add to favorites.",
  "Belum ada koneksi. Perangkat yang pernah Anda hubungi muncul di sini.": "No connections yet. Devices you connect to show up here.",
  "Sambung lewat IP (LAN)": "Connect by IP (LAN)", "Buka pengaturan LAN": "Open LAN settings", "Mengerti": "Got it",
  "Cara pakai dan kalau gagal tersambung": "How to use it, and what to do if it fails", "Alamat IP disalin": "IP address copied",
  "Jika password akses diset, koneksi dengan password benar langsung diterima tanpa konfirmasi.": "If an access password is set, connections with the correct password are accepted without confirmation.",
  "Mulai saat startup": "Start on startup", "Jalankan TryDesk saat Windows start": "Run TryDesk when Windows starts",
  "Minimalisasi ke tray": "Minimize to tray", "Sembunyikan ke system tray saat ditutup": "Hide to the system tray when closed",
  "Koneksi langsung": "Direct connection", "Prioritaskan koneksi P2P langsung": "Prefer direct P2P connection",
  "Jika gagal, otomatis fallback ke relay TURN server.": "Falls back to the TURN relay server automatically if it fails.",
  "Coba sambung ulang jika koneksi terputus": "Try to reconnect if the connection drops",
  "Batas bandwidth upload": "Upload bandwidth limit",
  "Batasi bandwidth saat menjadi host agar tidak mengganggu aktivitas internet lain.": "Limit bandwidth while hosting so it doesn't disrupt other internet activity.",
  "Protokol koneksi": "Connection protocol",
  "Otomatis (P2P → TURN)": "Automatic (P2P → TURN)", "P2P saja (tidak menggunakan relay)": "P2P only (no relay)", "Relay saja (selalu gunakan TURN)": "Relay only (always use TURN)",
  "Otomatis akan mencoba koneksi P2P terlebih dahulu, lalu fallback ke TURN relay.": "Automatic tries a direct P2P connection first, then falls back to TURN relay.",
  "Pengaturan keepalive": "Keepalive settings",
  "Kirim sinyal keepalive agar koneksi tidak terputus": "Send keepalive signals to prevent disconnects",
  "Cegah layar mati pada host saat sesi aktif": "Prevent the host screen from sleeping during a session",
  // Security
  "Kontrol penuh (administrator)": "Full control (administrator)",
  "Jendela admin (mis. CMD sebagai administrator) hanya bisa dikontrol dari jarak jauh bila TryDesk dijalankan sebagai administrator. Tanpa ini layar tetap terlihat, tapi klik & ketik tidak berfungsi di jendela admin. Dialog UAC tampil di desktop aman Windows dan tidak bisa dilihat atau dikontrol dari jarak jauh.": "Admin windows (e.g. CMD run as administrator) can only be controlled remotely when TryDesk runs as administrator. Without it the screen still shows, but clicks & keystrokes won't work on admin windows. UAC prompts appear on Windows' secure desktop and can't be seen or controlled remotely.",
  "Jalankan sebagai administrator": "Run as administrator",
  "Layanan Windows (akses tanpa pengawasan)": "Windows service (unattended access)",
  "Dengan layanan, PC ini tetap bisa dikontrol setelah restart dan saat sesi RDP diputus (jendela RDP ditutup), seperti AnyDesk. ID PC ini tidak berubah. Tanpa password akses, setiap koneksi tetap meminta Terima. Versi Setup memasangnya otomatis.": "With the service, this PC stays controllable after a restart and while the RDP session is disconnected (RDP window closed), like AnyDesk. This PC's ID doesn't change. Without an access password, every connection still asks for Accept. The Setup version installs it automatically.",
  "Pasang layanan": "Install service", "Hapus layanan": "Remove service",
  "Layanan terpasang. ID PC ini tetap sama.": "Service installed. This PC's ID stays the same.",
  "UAC dibatalkan, password layanan tidak berubah": "UAC cancelled, the service's password didn't change", "Password layanan gagal diubah": "The service's password couldn't be changed",
  "PC ini memakai layanan TryDesk": "This PC uses the TryDesk service",
  "Layanan belum terpasang.": "Service not installed.",
  "Isi password akses dulu (minimal satu kali disimpan), lalu pasang layanan.": "Set an access password first, then install the service.",
  "Memasang layanan… setujui prompt UAC.": "Installing the service… approve the UAC prompt.",
  "Menyimpan password ke layanan… setujui prompt UAC.": "Saving the password to the service… approve the UAC prompt.",
  "Password layanan diperbarui": "Service password updated",
  "Layanan terpasang. ID layanan muncul dalam beberapa detik.": "Service installed. Its ID appears in a few seconds.",
  "UAC dibatalkan, layanan tidak dipasang": "UAC cancelled, service not installed",
  "UAC dibatalkan, layanan tetap terpasang": "UAC cancelled, service still installed",
  "Layanan dihapus": "Service removed",
  "Layanan gagal dipasang": "Service could not be installed", "Layanan gagal dihapus": "Service could not be removed",
  "Password akses tanpa konfirmasi": "Access password (no confirmation)",
  "Jika diset, remote yang memasukkan password ini bisa langsung terhubung tanpa klik Accept.": "If set, a remote entering this password can connect directly without clicking Accept.",
  "Izin akses": "Access permissions", "Izinkan kontrol keyboard & mouse": "Allow keyboard & mouse control",
  "Izinkan transfer file": "Allow file transfer", "Izinkan sinkron clipboard": "Allow clipboard sync",
  "Izinkan remote melihat layar saja (tanpa kontrol)": "Allow remote to view only (no control)",
  "Keamanan sesi": "Session security", "Kunci layar Windows setelah sesi berakhir": "Lock Windows after the session ends",
  "Catat log semua sesi koneksi": "Log all connection sessions",
  "Hanya izinkan koneksi dari IP tertentu. Kosongkan untuk mengizinkan semua IP.": "Only allow connections from specific IPs. Leave empty to allow all.",
  "Batas waktu sesi": "Session time limit",
  "30 menit": "30 minutes", "1 jam": "1 hour", "2 jam": "2 hours", "8 jam": "8 hours",
  "Otomatis putuskan koneksi setelah durasi tertentu.": "Automatically disconnect after a set duration.",
  "Proteksi tambahan": "Extra protection",
  "Konfirmasi ulang untuk fitur sensitif (file, clipboard)": "Re-confirm sensitive features (file, clipboard)",
  "Blokir koneksi setelah 3x password salah (5 menit)": "Block after 3 wrong passwords (5 minutes)",
  // Display
  "Kualitas bawaan": "Default quality",
  "Hemat (3 Mbps / 15 FPS)": "Saver (3 Mbps / 15 FPS)", "Seimbang (20 Mbps / 30 FPS)": "Balanced (20 Mbps / 30 FPS)",
  "Kualitas (60 Mbps / 60 FPS)": "Quality (60 Mbps / 60 FPS)", "Ultra (150 Mbps / 120 FPS)": "Ultra (150 Mbps / 120 FPS)",
  "Gaming (300 Mbps / 165 FPS)": "Gaming (300 Mbps / 165 FPS)", "Maksimal (1000 Mbps / 240 FPS)": "Maximum (1000 Mbps / 240 FPS)",
  "Codec video bawaan": "Default video codec", "Otomatis": "Automatic",
  "AV1 (paling hemat bandwidth)": "AV1 (most bandwidth-efficient)", "VP9 (keseimbangan)": "VP9 (balanced)",
  "VP8 (kompatibilitas tinggi)": "VP8 (high compatibility)", "H.264 (akselerasi hardware)": "H.264 (hardware acceleration)",
  "Tema": "Theme", "Gelap": "Dark", "Terang": "Light", "Tampilan remote": "Remote display",
  "Otomatis tampilkan panel statistik": "Automatically show the stats panel", "Tampilkan kursor remote": "Show remote cursor",
  "Sembunyikan wallpaper host (hemat bandwidth)": "Hide host wallpaper (saves bandwidth)",
  "Nonaktifkan efek visual host (Aero, animasi)": "Disable host visual effects (Aero, animations)",
  "Skala tampilan bawaan": "Default display scale", "Pas jendela (Fit)": "Fit window", "100% (1:1 piksel)": "100% (1:1 pixels)",
  // Audio
  "Audio remote": "Remote audio", "Aktifkan audio remote secara otomatis": "Enable remote audio automatically",
  "Jika aktif, audio dari komputer remote akan otomatis diputar saat sesi dimulai.": "If enabled, audio from the remote computer plays automatically when the session starts.",
  "Volume audio remote": "Remote audio volume", "Mikrofon": "Microphone",
  "Izinkan pengiriman mikrofon ke remote": "Allow sending microphone to the remote",
  "Fitur ini memerlukan izin mikrofon dari sistem operasi.": "This requires microphone permission from the operating system.",
  "Kualitas audio": "Audio quality", "Rendah (hemat bandwidth)": "Low (saves bandwidth)", "Sedang": "Medium", "Tinggi (lossless-like)": "High (lossless-like)",
  // Advanced
  "Rendering": "Rendering", "Gunakan akselerasi hardware GPU": "Use GPU hardware acceleration",
  "Memanfaatkan GPU untuk decode video. Nonaktifkan jika terjadi masalah tampilan.": "Uses the GPU to decode video. Disable if you see display issues.",
  "Buffer jaringan": "Network buffer",
  "Rendah (latensi minimal, mungkin patah-patah)": "Low (minimal latency, may stutter)", "Sedang (seimbang)": "Medium (balanced)", "Tinggi (halus, latensi lebih tinggi)": "High (smooth, higher latency)",
  "Buffer rendah cocok untuk cloud gaming. Buffer tinggi cocok untuk koneksi tidak stabil.": "Low buffer suits cloud gaming. High buffer suits unstable connections.",
  "Koneksi tersendat, menyambung kembali…": "Connection stalled, reconnecting…",
  "Logging": "Logging", "Nonaktif": "Off", "Hanya error": "Errors only", "Informasi": "Info", "Debug (detail penuh)": "Debug (full detail)",
  "Data & pengaturan": "Data & settings", "Ekspor pengaturan": "Export settings", "Impor pengaturan": "Import settings",
  "Reset semua pengaturan ke bawaan": "Reset all settings to default",
  "Tentang": "About", "Versi": "Version", "Lisensi": "License", "Gratis (Freeware)": "Free (Freeware)",
  "Pengaturan": "Settings", "Umum": "General", "Koneksi": "Connection", "Keamanan": "Security", "Tampilan": "Display", "Lanjutan": "Advanced",
  "Misalnya PC-Kantor": "For example Office-PC",
  "Kosong = selalu minta Terima": "Empty = always ask to Accept",
  "Mis: 192.168.1.0/24, 10.0.0.5": "e.g. 192.168.1.0/24, 10.0.0.5",
  "Password minimal 6 karakter": "Password must be at least 6 characters",
  "Password tersimpan (ketik untuk ganti)": "Password saved (type to change)",
  "Password akses disimpan": "Access password saved", "Password akses dihapus": "Access password removed",
  // Access password state (user report 12 Nov)
  "Perbarui layanan": "Update the service", "Cek layanan": "Check service",
  // File manager against a PC answered by its Windows service, and the exact reason a host refuses (email 12 Nov)
  "Unduhan\\TryDesk": "Downloads\\TryDesk",
  "Folder PC ini tidak bisa dibuka dari sini.": "This PC's folders can't be opened from here.",
  "PC ini dilayani layanan Windows TryDesk. File yang Anda kirim tetap bisa: pilih file di kiri lalu klik Kirim. Setelah diterima, file disimpan di folder Unduhan\\TryDesk di PC itu. Untuk mengambil file dari PC itu, minta orang di sana mengirimnya dari TryDesk-nya.": "This PC is answered by the TryDesk Windows service. You can still send files: pick them on the left and click Send. Once accepted, they are saved in the Downloads\\TryDesk folder on that PC. To get a file from that PC, ask the person there to send it from their TryDesk.",
  "PC ini dilayani layanan Windows TryDesk, jadi foldernya tidak bisa dibuka dari sini": "This PC is answered by the TryDesk Windows service, so its folders can't be opened from here",
  "Izin File dimatikan di PC itu (Pengaturan → Keamanan → Izin tamu)": "File permission is off on that PC (Settings → Security → Guest permissions)",
  "Kirim dan ambil file dimatikan di PC itu (Pengaturan → Keamanan → Yang boleh dilakukan tamu)": "Send and receive files is off on that PC (Settings → Security → What guests may do)",
  "Transfer file butuh izin Mouse & keyboard di PC itu (mode lihat saja aktif)": "File transfer needs the Mouse & keyboard permission on that PC (view-only is on)",
  "TryDesk Portable tidak dibuka karena TryDesk ini sudah berjalan. Untuk memakai Portable, keluar dulu lewat ikon TryDesk di tray → Keluar.": "TryDesk Portable didn't open because this TryDesk is already running. To use Portable, quit this one first: TryDesk icon in the tray → Quit.",
  "TryDesk yang terpasang tidak dibuka karena TryDesk ini sudah berjalan. Untuk memakainya, keluar dulu lewat ikon TryDesk di tray → Keluar.": "The installed TryDesk didn't open because this TryDesk is already running. To use it, quit this one first: TryDesk icon in the tray → Quit.",
  "TryDesk dibuka ulang otomatis karena kartu grafis bermasalah. Sekarang TryDesk memakai mode software.": "TryDesk restarted itself because the graphics card had a problem. It now runs in software mode.",
  "TryDesk dibuka ulang sekali supaya semua monitor PC ini bisa ditampilkan.": "TryDesk restarted once so every monitor of this PC can be shown.",
  "Layanan Windows belum memakai password ini": "The Windows service isn't using this password yet",
  "✓ Layanan Windows memakai password yang sama: PC ini bisa diakses tanpa pengawasan, juga setelah restart.": "✓ The Windows service uses the same password: this PC can be reached unattended, also after a restart.",
  "Layanan Windows juga tanpa password: setiap koneksi perlu klik Terima.": "The Windows service has no password either: every connection needs Accept.",
  "Layanan Windows belum memakai password ini, jadi setiap koneksi ke PC ini masih meminta Terima.": "The Windows service isn't using this password yet, so every connection to this PC still asks for Accept.",
  "Layanan Windows masih memakai password sebelumnya, jadi koneksi ke PC ini belum memakai yang baru.": "The Windows service still uses the previous password, so connections to this PC don't use the new one yet.",
  "Layanan Windows masih memakai password lama, jadi yang tahu password itu tetap bisa masuk.": "The Windows service still uses the old password, so anyone who knows it can still get in.",
  "Password akses": "Access password", "Masuk": "Sign in",
  "Tidak ada jawaban dari pemilik PC": "The PC's owner did not answer",
  "PC remote mengizinkan kontrol lagi": "The remote PC allows control again",
  "Kontrol dilepas, mouse & keyboard kembali ke PC ini. Klik layar remote untuk lanjut.": "Control released, mouse & keyboard are back on this PC. Click the remote screen to carry on.",
  "Tip: teks yang disalin sebelum tersambung tidak ikut dikirim, salin ulang setelah tersambung": "Tip: text copied before connecting is not sent, copy it again once connected",
  "✓ Password akses aktif. Koneksi dengan password ini tidak perlu klik Terima.": "✓ Access password is on. Connections with this password don't need Accept.",
  "Belum ada password akses, jadi setiap koneksi perlu klik Terima.": "No access password yet, so every connection needs Accept.",
  "Hapus password akses": "Remove access password", "Tampilkan / sembunyikan": "Show / hide",
  // Access password card, design direction 2 "Kartu kunci" (15 Nov)
  "Belum ada password": "No password yet", "Password aktif": "Password on", "Password baru": "New password",
  "Ganti password": "Change password", "Hapus password": "Remove password", "Buat password": "Create password",
  "Ya, hapus": "Yes, remove", "Ketik password baru": "Type a new password", "Tersimpan": "Saved", "Hapus": "Remove",
  "Setiap koneksi menunggu Anda klik Terima. Buat password bila PC ini sering Anda buka dari jauh.": "Every connection waits for you to click Accept. Create a password if you often open this PC from afar.",
  "Tamu yang tahu password langsung masuk, tanpa Anda klik Terima.": "Guests who know the password get straight in, without you clicking Accept.",
  "Ketik password yang akan Anda pakai dari PC lain.": "Type the password you will use from another PC.",
  "Setelah dihapus, setiap koneksi menunggu Anda klik Terima. Password lama tidak bisa dipakai lagi.": "Once removed, every connection waits for you to click Accept. The old password can't be used any more.",
  "Minimal 6 karakter": "At least 6 characters", "10 karakter atau lebih, untuk Sambung lewat IP": "10 characters or more, for Connect by IP",
  "Layanan Windows memakai password yang sama, jadi PC ini juga bisa diakses setelah restart.": "The Windows service uses the same password, so this PC can also be reached after a restart.",
  "Batas waktu sesi di PC remote tercapai, koneksi diputus": "The remote PC's session time limit was reached, disconnected",
  "Koneksi P2P gagal, coba protokol Otomatis (Pengaturan → Koneksi) agar bisa lewat relay": "P2P connection failed, try the Automatic protocol (Settings → Connection) so it can use the relay",
  "Untuk mengirim file, klik tombol Kirim File": "To send a file, click the Send File button",
  "Sambungkan dulu ke PC lain, lalu seret file ke layarnya untuk mengirim": "Connect to another PC first, then drag files onto its screen to send them",
  "Folder belum bisa dikirim: seret file-filenya": "Folders can't be sent yet: drag the files themselves",
  "Sebagian file tidak dikirim: hanya file yang ada di disk (paling banyak 50 sekaligus)": "Some files weren't sent: only files on disk can be sent (up to 50 at once)",
  "Lepas untuk mengirim file": "Drop to send the files",
  "Untuk mengirim file, buka Control Center → Fitur lainnya → Transfer file": "To send a file, open Control Center → More features → File transfer",
  "PC mengirim file, tetapi aplikasi HP belum bisa menerima file": "The PC sent a file, but the phone app can't receive files yet",
  "Ditolak: aplikasi HP belum bisa menerima file": "Declined: the phone app can't receive files yet",
  "Ditolak: PC remote tidak mengizinkan transfer file": "Declined: the remote PC doesn't allow file transfer",
  "Ditolak: masih ada transfer lain": "Declined: another transfer is still running",
  "ID, favorit, riwayat koneksi dan password akses tetap disimpan. TryDesk akan dimuat ulang.": "Your ID, favorites, connection history and access password are kept. TryDesk will reload.",
  "Tutup TryDesk?": "Close TryDesk?", "Tutup": "Close",
  "PC ini sedang dikontrol dari jarak jauh.": "This PC is being controlled remotely.",
  "Masih ada sesi remote yang terbuka.": "There are still remote sessions open.",
  "Menutup TryDesk memutus semua sesi, dan PC ini tidak bisa dihubungi sampai TryDesk dibuka lagi.": "Closing TryDesk ends every session, and this PC can't be reached until TryDesk is opened again.",
  "Kembali ke sesi": "Back to session",
  "Atau tunggu pemilik PC menekan Terima. Password tidak disimpan.": "Or wait for the PC's owner to click Accept. The password isn't saved.",
  "Lewat IP, hanya password yang bisa membuka akses. Password tidak disimpan.": "Over IP, only the password opens access. The password isn't saved.",
  "Masukkan password": "Enter password", "ID TryDesk": "TryDesk ID", "Jaringan lokal": "Local network",
  "Menunggu password atau persetujuan pemilik PC": "Waiting for the password or the owner's approval", "Memeriksa password…": "Checking password…",
  "Peminta tidak memasukkan password akses. Ia masih bisa mengetiknya, bila benar, koneksi langsung diterima.": "The requester did not enter the access password. They can still type it, if it is right, the connection is accepted at once.",
  "Peminta tidak memasukkan password akses.": "The requester did not enter the access password.",
  "Peminta memasukkan password yang salah dan bisa mencoba lagi.": "The requester entered a wrong password and may try again.",
  "Password benar, tetapi \"Terima koneksi otomatis\" dimatikan di Pengaturan, jadi tetap perlu konfirmasi.": "Correct password, but \"Auto-accept\" is turned off in Settings, so confirmation is still needed.",
  "Password akses dari versi lama perlu diset ulang (Pengaturan → Keamanan)": "The access password from an older version must be set again (Settings → Security)",
  "Saat jendela ditutup": "When the window is closed",
  "Tetap berjalan di system tray (PC tetap bisa dihubungi)": "Keep running in the system tray (this PC stays reachable)",
  "Tombol X menyembunyikan TryDesk ke system tray, seperti AnyDesk. Keluar sepenuhnya lewat klik kanan ikon TryDesk di tray → Keluar. Bila dimatikan, X menutup TryDesk.": "The X button hides TryDesk to the system tray, like AnyDesk. Quit completely by right-clicking the TryDesk icon in the tray → Quit. When off, X closes TryDesk.",
  "Keluar dari TryDesk?": "Quit TryDesk?", "Keluar": "Quit",
  "Jika password akses diset (tab Keamanan), koneksi dengan password benar langsung diterima tanpa konfirmasi. Matikan bila Anda tetap ingin menekan Terima walau password benar.": "If an access password is set (Security tab), connections with the correct password are accepted without confirmation. Turn this off to still click Accept even when the password is right.",
  "Jika diset, orang yang mengontrol PC ini cukup mengetik password ini di kolom Password pada TryDesk mereka (atau saat diminta), mereka langsung masuk tanpa Anda klik Terima. Tanpa password, Anda tetap diminta Terima.": "If set, whoever controls this PC just types this password in the Password field of their TryDesk (or when asked) and gets in without you clicking Accept. Without the password you are still asked to Accept.",
  "Alias dihapus": "Alias removed",
  "Jalankan sebagai administrator?": "Run as administrator?",
  // "Minta akses admin" (hostElevRequest / viewerElevState)
  "Minta akses admin": "Request admin access",
  "Izinkan akses administrator?": "Allow administrator access?",
  "Pengontrol meminta akses administrator supaya bisa melihat dan menjawab jendela izin admin (UAC), layar kunci, dan jendela administrator. Untuk itu TryDesk memasang layanan Windows di PC ini.": "The person controlling this PC asks for administrator access, so they can see and answer administrator prompts (UAC), the lock screen and administrator windows. For that, TryDesk installs its Windows service on this PC.",
  "Windows akan menampilkan prompt UAC: pilih Ya.": "Windows will show a UAC prompt: choose Yes.",
  "Sesi tersambung ulang sendiri lewat layanan. Layanan bisa dihapus kapan saja di Pengaturan › Layanan Windows.": "The session reconnects through the service by itself. You can remove the service at any time in Settings › Windows service.",
  "PC ini belum memakai password akses, jadi sambungan berikutnya tetap perlu diterima di PC ini.": "This PC has no access password yet, so the next connection still has to be accepted on this PC.",
  "Izinkan": "Allow",
  "Layanan terpasang. Pengontrol menyambung ulang lewat layanan.": "Service installed. The person controlling this PC reconnects through it.",
  "PC ini pindah ke layanan TryDesk": "This PC moved to the TryDesk service",
  "TryDesk akan ditutup lalu dibuka lagi dengan izin administrator.": "TryDesk will close and reopen with administrator rights.",
  "Windows akan menampilkan prompt UAC. Sesi yang sedang berjalan akan terputus.": "Windows will show a UAC prompt. Any running session will disconnect.",
  "Batal": "Cancel", "Lanjutkan": "Continue",
  // Home + server status
  "Desktop Ini": "This Desktop", "ID Anda": "Your ID", "Menghubungkan...": "Connecting...",
  "Berikan ID ini ke orang yang akan membantu Anda.": "Give this ID to the person who will help you.",
  "ID Remote": "Remote ID", "Hubungkan": "Connect", "Favorit": "Favorites", "Koneksi Terakhir": "Recent Connections",
  "Terbaru": "Most recent", "Nomor ID": "ID number", "Lainnya": "More", "Terakhir dihubungi": "Recent", "Hapus semua": "Clear all", "Baru saja": "Just now",
  "Menghubungkan ke server...": "Connecting to server...", "Online, siap menerima koneksi": "Online, ready to accept connections",
  "Terputus dari server, mencoba lagi...": "Disconnected from server, retrying...", "Alamat server tidak valid": "Invalid server address",
  "Salin ID": "Copy ID", "Buat ID baru": "Generate new ID", "Masukkan ID remote": "Enter remote ID", "Password (opsional)": "Password (optional)",
  "Tampilan grid": "Grid view", "Tampilan daftar": "List view", "Urutkan": "Sort", "Hapus semua riwayat": "Clear all history",
  "Perkecil": "Minimize", "Perbesar": "Maximize", "Tutup": "Close",
  // Connecting + incoming request
  "Menghubungkan": "Connecting", "Menunggu remote desktop menerima": "Waiting for the remote desktop to accept",
  "Mengirim permintaan": "Sending request", "Menunggu persetujuan": "Waiting for approval", "Membangun koneksi P2P": "Establishing P2P connection",
  "Batalkan": "Cancel", "Membangun koneksi peer-to-peer...": "Establishing peer-to-peer connection...",
  "Permintaan Koneksi Masuk": "Incoming Connection Request", "Dari perangkat": "From device",
  "Dapat melihat layar Anda": "Can see your screen", "Dapat mengontrol keyboard & mouse": "Can control keyboard & mouse",
  "Terima hanya jika Anda mengenal dan mempercayai pengirim.": "Only accept if you know and trust the sender.",
  "Jangan terima jika Anda tidak sedang meminta bantuan. Orang yang mengaku dari bank, toko, atau layanan resmi tidak perlu mengontrol PC Anda.":
    "Don't accept unless you asked for help. Someone who says they are from a bank, a shop or an official service never needs to control your PC.",
  "Dapat membuka & mengirim file di PC ini": "Can open & send files on this PC", "Berbagi clipboard (teks yang disalin)": "Shares the clipboard (copied text)",
  "Untuk mengirim file, buka Kirim File atau Manajer File": "To send files, use Send File or the File Manager",
  // Settings added/reworded in 1.1.0 + their messages
  "Discord": "Discord", "Tampilkan status TryDesk di profil Discord": "Show TryDesk status on my Discord profile",
  "Teman Discord Anda melihat \"Menggunakan TryDesk\" serta apakah Anda sedang mengontrol atau dikontrol.": "Your Discord friends see \"Using TryDesk\" and whether you're controlling or being controlled.",
  "Otomatis akan mencoba koneksi P2P terlebih dahulu, lalu fallback ke TURN relay. \"Relay saja\" hanya berfungsi bila server menyediakan TURN.": "Automatic tries a direct P2P connection first, then falls back to TURN relay. \"Relay only\" works only when the server provides TURN.",
  "Saat menjadi host": "While hosting", "Blokir peminta setelah 3x password salah (5–20 menit)": "Block a requester after 3 wrong passwords (5–20 minutes)",
  "Bawaan (1000 Mbps / 240 FPS)": "Default (1000 Mbps / 240 FPS)", "Kustom (diatur di panel Kualitas)": "Custom (set in the Quality panel)",
  "Dipakai untuk tab remote baru. FPS di atas 120 butuh monitor host dengan refresh rate setinggi itu.": "Used for new remote tabs. Above 120 FPS needs a host monitor with that refresh rate.",
  "Memanfaatkan GPU untuk capture, encode & decode video. Nonaktifkan jika terjadi masalah tampilan. Berlaku setelah TryDesk dibuka ulang.": "Uses the GPU to capture, encode & decode video. Disable it if you see display issues. Takes effect after restarting TryDesk.",
  "Mengembalikan semua pengaturan ke bawaan. ID, favorit, dan riwayat koneksi tetap disimpan.": "Restores every setting to its default. Your ID, favorites and connection history are kept.",
  "Kode sumber": "Source code", "AGPL-3.0, gratis": "AGPL-3.0, free", "Riwayat versi": "Version history", "Fitur per versi": "Features by version","AGPL-3.0 (open source, gratis)": "AGPL-3.0 (open source, free)", "Dibuat oleh": "Made by",
  "© 2026 DrWeabo. TryDesk adalah perangkat lunak bebas di bawah lisensi GNU AGPL-3.0 dan diberikan apa adanya, tanpa garansi. Nama dan logo TryDesk adalah merek DrWeabo; versi modifikasi harus memakai nama lain.":
    "© 2026 DrWeabo. TryDesk is free software under the GNU AGPL-3.0 licence, provided as is, without warranty. The TryDesk name and logo are DrWeabo's trademarks; modified versions must use a different name.",
  "Jendela admin (mis. CMD sebagai administrator) hanya bisa dikontrol dari jarak jauh bila TryDesk dijalankan sebagai administrator. Tanpa ini layar tetap terlihat, tapi klik & ketik tidak berfungsi di jendela admin. Dialog UAC tampil di desktop aman Windows dan tidak bisa dilihat atau dikontrol dari jarak jauh.": "Admin windows (e.g. CMD run as administrator) can only be controlled remotely when TryDesk runs as administrator. Without it the screen still shows, but clicks & keystrokes won't work on admin windows. UAC prompts appear on Windows' secure desktop and can't be seen or controlled remotely.",
  "Permintaan koneksi masuk": "Incoming connection request", "Batas waktu sesi tercapai, koneksi diputus": "Session time limit reached, disconnected",
  "Berlaku setelah TryDesk dibuka ulang": "Takes effect after restarting TryDesk",
  "Reset semua pengaturan?": "Reset all settings?", "Semua pengaturan kembali ke bawaan.": "Every setting goes back to its default.",
  "ID, favorit, dan riwayat koneksi tetap disimpan. TryDesk akan dimuat ulang.": "Your ID, favorites and connection history are kept. TryDesk will reload.",
  "Reset": "Reset", "UAC dibatalkan, TryDesk tetap berjalan tanpa hak administrator": "UAC cancelled, TryDesk keeps running without administrator rights",
  "PC remote hanya mengizinkan melihat layar, klik & ketikan tidak dikirim": "The remote PC only allows viewing, clicks & keystrokes aren't sent",
  "Gagal: file tidak lengkap": "Failed: file incomplete",
  "Gagal menyimpan: disk penuh atau file tidak bisa ditulis": "Couldn't save: the disk is full or the file can't be written",
  "Gagal: folder yang dipilih di PC itu tidak bisa ditulis": "Failed: the folder chosen on that PC can't be written to",
  "Belum ada pengguna yang masuk ke Windows di PC itu, jadi foldernya belum bisa dibuka": "Nobody is signed in to Windows on that PC yet, so its folders can't be opened",
  "Tidak bisa menyimpan di folder itu. Pilih folder lain, misalnya Unduhan.": "Can't save in that folder. Pick another one, such as Downloads.",
  "Kunci input dilepas oleh pengguna di PC remote": "Input lock released by the user on the remote PC",
  "Layar gelap dilepas oleh pengguna di PC remote": "Black screen released by the user on the remote PC",
  "Terima": "Accept", "Tolak": "Reject",
  // Connection results (shown locally, sent by the host, or sent by the signaling server)
  "PC ini hanya menerima koneksi dengan password akses": "This PC only accepts connections with its access password",
  "Koneksi ditolak": "Connection rejected", "Remote desktop memutus koneksi": "The remote desktop ended the connection",
  "Belum terhubung ke server": "Not connected to the server yet", "Masukkan ID 9 digit": "Enter a 9-digit ID",
  "Tidak bisa konek ke diri sendiri": "You can't connect to yourself", "Tab untuk ID ini sudah terbuka": "A tab for this ID is already open",
  "Tidak ada respons dari remote desktop": "No response from the remote desktop", "Remote desktop sedang sibuk": "The remote desktop is busy",
  "Perangkat ini adalah TryDesk untuk HP (hanya mengontrol PC) dan tidak bisa dikontrol": "That device runs TryDesk for phones (it only controls PCs) and can't be controlled",
  "Terlalu banyak percobaan, coba lagi nanti": "Too many attempts, try again later", "Waktu verifikasi habis": "Verification timed out",
  "Password salah": "Wrong password", "Remote gagal membagikan layar": "The remote failed to share its screen",
  "Menyimpan ke Unduhan\\TryDesk...": "Saving to Downloads\\TryDesk...", "File tidak bisa disiapkan untuk dikirim": "The file couldn't be prepared for sending",
  "PC tujuan tidak bisa membagikan layar karena TryDesk di sana berjalan sebagai administrator":"The remote PC can't share its screen because TryDesk there runs as administrator",
  "Layar PC ini tidak bisa diambil saat TryDesk berjalan sebagai administrator. Buka TryDesk biasa, atau pasang layanan TryDesk (Pengaturan → Keamanan) agar jendela admin tetap bisa dikontrol.": "This PC's screen can't be captured while TryDesk runs as administrator. Open TryDesk normally, or install the TryDesk service (Settings → Security) so admin windows can still be controlled.",
  "Koneksi gagal, relay TURN tidak terjangkau": "Connection failed, TURN relay unreachable",
  "Koneksi P2P gagal, server belum menyediakan TURN relay": "P2P connection failed, the server has no TURN relay yet",
  "Koneksi terputus": "Connection lost", "ID tidak ditemukan atau sedang offline": "ID not found or offline",
  "Remote desktop sedang dalam sesi lain": "The remote desktop is in another session",
  "Tidak bisa me-remote PC Anda sendiri": "You can't remote into your own PC",
  "Terlalu banyak permintaan, coba lagi sebentar": "Too many requests, try again shortly", "Remote desktop offline": "Remote desktop offline",
  "TryDesk di PC ini sudah terlalu lama dan tidak bisa terhubung lagi. Perbarui di trydesk.ai.id/downloads": "TryDesk on this PC is too old and can no longer connect. Update at trydesk.ai.id/downloads",
  "PC tujuan memakai TryDesk versi lama. Minta pemiliknya memperbarui di trydesk.ai.id/downloads": "The remote PC runs an old TryDesk. Ask its owner to update at trydesk.ai.id/downloads",
  "Ada yang mencoba terhubung, tapi TryDesk di PC ini versi lama. Perbarui di trydesk.ai.id/downloads": "Someone tried to connect, but this PC runs an old TryDesk. Update at trydesk.ai.id/downloads",
  "Server menolak permintaan ini": "The server refused this request",
  "PC tujuan sedang menerima terlalu banyak permintaan, coba lagi sebentar": "The remote PC is getting too many requests, try again in a moment",
  "Tip: agar jendela admin bisa dikontrol, jalankan TryDesk sebagai administrator (Pengaturan → Keamanan)": "Tip: to control admin windows, run TryDesk as administrator (Settings → Security)",
  "Jendela administrator aktif: pengontrol tidak bisa klik atau mengetik di jendela ini. Jalankan TryDesk sebagai administrator (Pengaturan → Keamanan) agar bisa.": "An administrator window is open: the person controlling this PC can't click or type in it. Run TryDesk as administrator (Settings → Security) to allow it.",
  "Jendela administrator (mis. Task Manager) terbuka di PC remote. Windows memblokir klik, ketikan, dan kursor ke jendela itu. Minta pemilik PC menutupnya, atau menjalankan TryDesk di PC itu sebagai administrator (TryDesk di PC Anda tidak perlu).": "An administrator window (e.g. Task Manager) is open on the remote PC. Windows blocks clicks, typing and the cursor in that window. Ask the PC's owner to close it, or to run TryDesk on that PC as administrator (the TryDesk on your PC doesn't need it).",
  "PC tujuan tidak bisa membagikan layar karena TryDesk di sana berjalan sebagai administrator. Minta pemiliknya membuka TryDesk biasa, atau memasang layanan TryDesk (Pengaturan › Layanan Windows).": "The remote PC can't share its screen because TryDesk there runs as administrator. Ask its owner to open TryDesk normally, or to install the TryDesk service (Settings › Windows service).",
  "Gagal tersambung: gambar dari PC remote tidak masuk dalam 30 detik. Coba hubungkan lagi.": "Couldn't connect: no picture arrived from the remote PC within 30 seconds. Try connecting again.",
  "Koneksi dengan pengontrol tidak terbentuk dalam 30 detik, sesi diakhiri.": "The connection with the viewer didn't come up within 30 seconds, so the session was ended.",
  "Koneksi tidak terbentuk dalam 30 detik": "The connection didn't come up within 30 seconds",
  "TryDesk dibuka ulang sebagai administrator": "TryDesk restarted as administrator",
  "TryDesk untuk Linux saat ini hanya bisa mengontrol PC lain. PC ini belum bisa dikontrol dari jarak jauh.": "TryDesk for Linux can control other PCs for now. This PC can't be controlled remotely yet.",
  "PC ini memakai TryDesk untuk Linux, yang saat ini hanya bisa mengontrol PC lain": "This PC runs TryDesk for Linux, which can only control other PCs for now",
  "TryDesk untuk macOS hanya bisa mengontrol PC Windows. Mac ini tidak bisa dikontrol dari jarak jauh.": "TryDesk for macOS controls Windows PCs. This Mac can't be controlled remotely.",
  "Perangkat ini memakai TryDesk untuk macOS, yang hanya bisa mengontrol PC Windows": "This device runs TryDesk for macOS, which only controls Windows PCs",
  "TryDesk dibuka ulang sebagai administrator. Jendela baru muncul dalam beberapa detik, jangan buka TryDesk lagi sebelum itu.": "TryDesk is restarting as administrator. The new window appears in a few seconds; don't open TryDesk again before then.",
  "TryDesk administrator tidak jadi terbuka karena TryDesk ini sudah berjalan. Klik kanan ikon TryDesk di tray → Keluar, lalu pilih Jalankan sebagai administrator lagi.": "The administrator TryDesk didn't open because this TryDesk was already running. Right-click the TryDesk tray icon → Quit, then choose Run as administrator again.",
  // Hosting screen
  "Sesi Remote Aktif": "Remote Session Active", "Desktop Anda sedang dikontrol": "Your desktop is being controlled",
  "Terhubung dengan": "Connected with", "Layar Anda digelapkan oleh remote": "Your screen has been darkened by the remote",
  "Kirim File": "Send File", "Putuskan": "Disconnect",
  // Remote screen, quality panel, stats, Control Center
  "Terhubung": "Connected", "Pas jendela": "Fit window", "Memuat layar remote…": "Loading remote screen…",
  "Resolusi": "Resolution", "Jalur": "Route", "P2P langsung": "Direct P2P", "P2P lokal": "Local P2P",
  "Pengaturan Kualitas": "Quality Settings", "Hemat": "Saver", "Seimbang": "Balanced", "Kualitas": "Quality", "Maksimal": "Maximum",
  "Kecepatan (bitrate)": "Speed (bitrate)",
  "Geser 1–1000 Mbps. Nilai tinggi = gambar lebih tajam, butuh bandwidth besar. Di atas 300 Mbps hanya lewat jalur cepat UDP (Windows ke Windows, jaringan lokal).": "Slide 1–1000 Mbps. Higher = sharper picture, needs more bandwidth. Above 300 Mbps only over the fast path's UDP link (Windows to Windows, local network).",
  "Asli": "Native", "Codec video": "Video codec", "AV1 (paling hemat)": "AV1 (most efficient)", "AV1 (hemat)": "AV1 (efficient)", "H.264 (kompatibel)": "H.264 (compatible)", "H.265 (lebih tajam)": "H.265 (sharper)",
  "Ganti codec menyambung ulang video sesaat.": "Changing the codec briefly reconnects the video.",
  "Tampilkan statistik": "Show statistics", "Sinkron clipboard": "Clipboard sync",
  "Sinkron clipboard aktif": "Clipboard sync on", "Sinkron clipboard mati": "Clipboard sync off",
  "Kualitas gambar": "Picture quality", "Suara": "Sound", "Fitur lainnya": "More features", "Layar penuh": "Full screen",
  "Keluar layar penuh": "Exit full screen", "Putuskan koneksi": "Disconnect", "Pengaturan lanjutan…": "Advanced settings…",
  "Hanya 1 monitor terdeteksi": "Only 1 monitor detected", "Pindah monitor": "Switch monitor", "Tutup sesi": "Close session", "Tutup tab": "Close tab",
  "Audio remote": "Remote audio", "Audio tidak tersedia di remote": "Audio isn't available on the remote",
  "Audio remote aktif": "Remote audio on", "Audio remote dimatikan": "Remote audio off",
  "Matikan audio remote": "Mute remote audio", "Aktifkan audio remote": "Enable remote audio",
  "Mode lihat saja": "View only", "Mode lihat saja aktif": "View-only mode on", "Mode lihat saja nonaktif": "View-only mode off",
  "Gelapkan layar host": "Darken host screen", "Kunci input host": "Lock host input",
  "Layar remote digelapkan": "Remote screen darkened", "Layar remote dikembalikan": "Remote screen restored",
  "Input remote dikunci": "Remote input locked", "Input remote dibuka": "Remote input unlocked",
  "Kunci input gagal: TryDesk di PC remote harus dijalankan sebagai administrator": "Input lock failed: TryDesk on the remote PC must run as administrator",
  "Layar gelap gagal: TryDesk di PC remote harus dijalankan sebagai administrator": "Black screen failed: TryDesk on the remote PC must run as administrator",
  "Kunci input ditolak: PC remote hanya mengizinkan mode lihat saja": "Input lock refused: the remote PC only allows view-only mode",
  "Layar gelap ditolak: PC remote hanya mengizinkan mode lihat saja": "Black screen refused: the remote PC only allows view-only mode",
  "Layar gelap gagal: Windows di PC remote tidak bisa menyembunyikan penutup dari tangkapan layar (butuh Windows 10 versi 2004 atau lebih baru)": "Black screen failed: Windows on the remote PC can't hide the cover from screen capture (needs Windows 10 version 2004 or newer)",
  "Kunci input dilepas: PC remote mencabut izin kontrol": "Input lock released: the remote PC took back control permission",
  "Layar gelap dilepas: PC remote mencabut izin kontrol": "Black screen released: the remote PC took back control permission",
  "Mode game: AKTIF (klik mematikan)": "Game mode: ON (click to turn off)", "Mode game (mouse)": "Game mode (mouse)",
  "Transfer file": "File transfer", "Kombinasi tombol": "Key combinations", "Kombinasi tombol dikirim": "Key combination sent",
  "Tombol Windows": "Windows key", "Ambil screenshot": "Take screenshot", "Belum ada video": "No video yet",
  "Gagal mengambil gambar": "Failed to capture image", "Rekam sesi": "Record session", "Hentikan rekaman": "Stop recording",
  "Berhenti merekam": "Stop recording", "Mulai merekam sesi": "Recording session", "Belum ada video untuk direkam": "No video to record yet",
  "Perekaman tidak didukung": "Recording isn't supported", "Rekaman dibatalkan": "Recording cancelled",
  "Kontrol aktif kembali": "Control active again", "Sambungkan remote baru": "Connect a new remote",
  // Game mode
  "Mode lihat saja aktif, matikan dulu untuk mode game": "View-only mode is on, turn it off for game mode",
  "🎮 Mode game aktif, tekan Pause (atau Ctrl+Alt+Shift+Esc) untuk lepas kontrol": "🎮 Game mode on, press Pause (or Ctrl+Alt+Shift+Esc) to release control",
  "🎮 Mode game aktif, tekan Esc untuk lepas mouse": "🎮 Game mode on, press Esc to release the mouse",
  "Mode game: klik layar untuk ambil kontrol mouse": "Game mode: click the screen to take mouse control",
  "Mouse tidak bisa dikunci untuk mode game (pointer lock ditolak)": "Couldn't lock the mouse for game mode (pointer lock refused)",
  "Mode game aktif, gerakan mouse relatif. Tekan Esc untuk keluar": "Game mode on, relative mouse movement. Press Esc to exit",
  "Mode game nonaktif": "Game mode off",
  "Kontrol dilepas, mouse & keyboard kembali ke PC ini (buka game lagi untuk lanjut)": "Control released, mouse & keyboard are back on this PC (open the game again to continue)",
  // Chat
  "Chat": "Chat", "Belum ada pesan": "No messages yet", "Pesan baru": "New message", "Anda": "You", "Kirim": "Send", "Ketik pesan": "Type a message",
  "Kirim gambar atau file": "Send a picture or file", "Lepas untuk mengirim di chat": "Drop to send in the chat",
  "Tutup Control Center": "Close Control Center", "Perangkat": "Devices", "Semua": "All", "Kembali": "Back",
  "Memuat aplikasi": "Loading the app", "Nama PC": "PC name", "Kirim kombinasi tombol": "Send a key combination",
  "Jika password akses diset, koneksi dengan password benar langsung diterima tanpa konfirmasi. Matikan bila Anda tetap ingin menekan Terima walau password benar.": "With an access password set, a connection with the right password is let in without asking. Turn this off if you still want to press Accept even when the password is right.",
  "PC lain di jaringan yang sama bisa tersambung dengan mengetik alamat IP PC ini, tanpa internet. Wajib memakai password akses minimal 10 karakter (Keamanan). Saat pertama dinyalakan, Windows akan meminta izin firewall.": "Other PCs on the same network can connect by typing this PC's IP address, without internet. Needs an access password of at least 10 characters (Security). The first time it is turned on, Windows asks for firewall permission.",
  // File transfer + file manager
  "Belum siap untuk transfer": "Not ready to transfer yet", "Satu transfer dulu, lalu ulangi": "One transfer at a time, then try again",
  "Menunggu persetujuan...": "Waiting for approval...", "Dibatalkan": "Cancelled", "Ditolak": "Rejected", "Terkirim": "Sent",
  "Dibatalkan pengirim": "Cancelled by sender", "ukuran file tidak diketahui": "file size unknown", "H.264 · jalur cepat": "H.264 · fast path", "H.265 · jalur cepat": "H.265 · fast path","Transfer file dinonaktifkan di host": "File transfer is disabled on the host",
  "Manajer File": "File Manager", "Komputer ini": "This computer", "Komputer remote": "Remote computer", "Kirim file ke": "Send files to", "PC ini": "This PC",
  "Nama": "Name", "Tanggal": "Date", "Tipe": "Type", "Ukuran": "Size", "Unduh": "Download", "Folder": "Folder",
  "Antrean transfer": "Transfer queue", "Bersihkan": "Clear", "Mulai transfer": "Start transfer", "Memuat…": "Loading…",
  "Folder kosong": "Empty folder", "Pilih folder tujuan dulu": "Choose a destination folder first",
  "Belum ada transfer. Pilih file lalu klik Kirim atau Unduh.": "No transfers yet. Select files, then click Send or Download.",
  "Lanjut": "Resume", "Jeda": "Pause", "Hapus dari daftar": "Remove from list", "Menunggu": "Waiting", "Dijeda": "Paused",
  "Selesai": "Done", "Gagal": "Failed", "Sibuk": "Busy", "ditolak": "rejected", "gagal": "failed",
  "Sesi transfer belum siap": "Transfer session not ready", "Transfer file butuh sesi aktif": "File transfer needs an active session",
  "Naik satu tingkat": "Up one level", "Beranda": "Home", "Muat ulang": "Reload",
  "Kirim ke komputer remote": "Send to remote computer", "Unduh ke komputer ini": "Download to this computer",
  // File Transfer (16 Nov); the lines built while it runs are written in both languages in fmL()
  "Ikuti bahasa Windows": "Follow the Windows language", "Bahasa TryDesk berganti mengikuti bahasa Windows di PC ini.": "TryDesk's language follows the Windows language on this PC.",
  "Berlaku langsung, tanpa membuka ulang TryDesk.": "Takes effect right away, without restarting TryDesk.",
  "Kembali ke layar remote": "Back to the remote screen", "Belum ada transfer berjalan": "No transfer running", "Belum ada transfer": "No transfer",
  "Seret file ke panel lain, atau pilih lalu tekan Kirim": "Drag files to the other pane, or select them and press Send",
  "Antrean": "Queue", "Bersihkan yang selesai": "Clear finished", "Ganti": "Replace", "Simpan keduanya": "Keep both", "Lewati": "Skip",
  "Batalkan transfer": "Cancel transfer", "Lebih baru": "Newer", "Folder baru": "New folder", "Cari": "Search", "Diubah": "Modified",
  "Jenis": "Type", "Pilih disk": "Choose drive", "Pilih semua": "Select all", "Klik untuk mengetik jalur": "Click to type a path", "Jeda semua": "Pause all",
  // Recent / Favorites tile menu
  "Opsi lainnya": "More options", "Salin ID": "Copy ID", "Ganti nama": "Rename",
  // Settings, direction 2 (13 Nov 2026)
  "Jaringan": "Network", "Layanan Windows": "Windows service",
  // The service's window opens the person's own TryDesk (13 Nov)
  "Membuka TryDesk Anda untuk mengirim file…": "Opening your TryDesk to send files…", "Membuka Pengaturan di TryDesk Anda…": "Opening Settings in your TryDesk…",
  "Masuk ke Windows dulu, lalu coba lagi": "Sign in to Windows first, then try again", "TryDesk Anda tidak bisa dibuka": "Your TryDesk couldn't be opened",
  "Tidak ada sesi lewat layanan Windows saat ini": "There is no session through the Windows service right now",
  "TryDesk kini menyala bersama Windows, supaya sesi lewat layanan Windows tampil di sini dengan semua tombol": "TryDesk now starts with Windows, so sessions through the Windows service show here with every button",
  "Disarankan menyala selama layanan Windows terpasang: sesi lewat layanan tampil di jendela ini dengan semua tombol.": "Best left on while the Windows service is installed: sessions through the service show in this window with every button.",
  "Ringkasan": "Summary", "Keadaan PC ini": "This PC's status", "Nama PC, tema, suara": "PC name, theme, sounds",
  "Password dan izin tamu": "Password and guest rights", "Ketajaman dan suara": "Sharpness and sound",
  "Aktif setelah restart": "Active after a restart", "Versi dan reset": "Version and reset", "Semua pengaturan": "All settings",
  "Halaman pengaturan": "Settings pages", "Tutup": "Close",
  "Keadaan PC ini sekarang. Klik kotak untuk mengubah.": "This PC's status right now. Click a box to change it.",
  "Pengaturan TryDesk di HP ini. Ketuk kotak untuk mengubah.": "TryDesk settings on this phone. Tap a box to change it.",
  "Siapa yang boleh masuk": "Who may come in", "Selalu tanya dulu": "Always ask first", "Masuk dengan password": "In with the password",
  "Belum ada password akses": "No access password yet", "Password akses aktif": "Access password on",
  "Perlu TryDesk terbuka": "Needs TryDesk open", "Setelah restart": "After a restart",
  "Versi ini tanpa layanan Windows": "This version has no Windows service", "Layanan Windows terpasang": "Windows service installed",
  "Layanan Windows belum dipasang": "Windows service not installed", "Layanan Windows sedang berhenti": "Windows service is stopped", "Nama PC ini": "This PC's name", "Nama HP ini": "This phone's name",
  "Belum diberi nama": "No name yet", "Terlihat oleh PC lain": "Seen by other PCs", "Sering diubah": "Often changed", "Bahasa": "Language",
  "Buka TryDesk saat Windows menyala": "Open TryDesk when Windows starts",
  "Bagaimana HP ini terlihat oleh PC yang Anda hubungi, dan bagaimana TryDesk terlihat oleh Anda.": "How this phone looks to the PCs you connect to, and how TryDesk looks to you.",
  "PC ini": "This PC", "HP ini": "This phone", "Terlihat oleh PC yang Anda hubungi.": "Seen by the PCs you connect to.",
  "Suara dan pemberitahuan": "Sound and notifications", "Beri tahu saat ada yang ingin masuk": "Tell me when someone wants to come in",
  "Bunyi pemberitahuan": "Notification sound", "Bunyi klik di tombol utama": "Click sound on the main buttons",
  "Pelan, dan diam selama sesi berjalan.": "Quiet, and silent during a session.",
  // Settings › Suara and Control Center › Suara (concept "Suara untuk setiap kejadian", 19 Nov)
  "Nama PC, tema, bahasa": "PC name, theme, language", "Nama HP, tema, bahasa": "Phone name, theme, language",
  "Bunyi dan pemberitahuan": "Sounds and notifications",
  "Bunyi pendek dari TryDesk sendiri. Suara PC yang Anda kontrol diatur di Control Center saat sesi.": "Short sounds from TryDesk itself. The audio of the PC you control is set in Control Center during a session.",
  "Bunyi TryDesk": "TryDesk sounds", "Bunyi pendek saat ada kejadian penting.": "Short sounds when something important happens.",
  "Volume bunyi TryDesk": "TryDesk sound volume", "Coba": "Try", "Bunyi untuk": "Play a sound for",
  "Permintaan masuk dan sambungan": "Requests and connections", "Ada yang ingin masuk, tersambung, terputus.": "Someone wants in, connected, dropped.",
  "Pesan masuk. Pesan terkirim tidak berbunyi.": "Incoming messages. Sent messages stay silent.",
  "Selesai atau gagal.": "Finished or failed.", "Berhasil, gagal, peringatan.": "Success, failure, warning.",
  "Versi baru TryDesk": "New TryDesk version", "Klik tombol utama": "Main button clicks", "Hubungkan, Terima, Tolak, Salin.": "Connect, Accept, Decline, Copy.",
  "Saat sesi berjalan": "During a session", "Diam saat mode game": "Quiet in game mode",
  "Hanya sambungan terputus dan permintaan masuk yang berbunyi.": "Only a dropped connection and requests make a sound.",
  "Diam saat layar penuh": "Quiet in full screen", "Pemberitahuan berhasil dan peringatan tidak berbunyi.": "Success and warning notices stay silent.",
  "Pemberitahuan Windows, tanpa bunyinya sendiri.": "A Windows notification, without its own sound.",
  "Sambungan": "Connection", "Tersambung, terputus, ditolak.": "Connected, dropped, declined.", "Bunyi selama sesi ini": "Sounds in this session",
  // Control Center, Arah 1 (20 Nov)
  "Atur sendiri": "Custom", "sekarang": "now", "Semua mati": "All off", "Menyala": "On", "Mati": "Off", "Tidak tersedia": "Not available",
  "Buka": "Open", "Nyala atau mati": "On or off", "Kualitas lanjutan": "Advanced quality", "Lihat saja": "View only",
  "Layar digelapkan": "Screen darkened", "Input dikunci": "Input locked", "Merekam": "Recording", "Statistik": "Statistics",
  "Klik dan ketikan Anda tidak dikirim.": "Your clicks and typing are not sent.", "Layar PC itu hitam selama sesi.": "That PC's screen stays black during the session.",
  "Mouse dan keyboard PC itu tidak bisa dipakai.": "That PC's mouse and keyboard stop working.", "Ukuran gambar PC itu di jendela ini.": "The size of that PC's picture in this window.",
  "Semua bunyi diatur di Pengaturan › Suara.": "All sounds are set in Settings › Sound.", "Kembali ke daftar PC": "Back to the PC list",
  "Preset": "Preset", "Frame rate": "Frame rate", "Monitor": "Monitor",
  // Key combinations panel (Arah B, 19 Nov)
  "Cari, misalnya task atau win r": "Search, for example task or win r", "Cari kombinasi tombol": "Search key combinations",
  "Hapus pencarian": "Clear search", "Tahan tombol": "Hold keys", "Tahan": "Hold", "Buat kombinasi sendiri": "Make your own combination",
  "Kombinasi baru": "New combination", "Tekan tombolnya di keyboard Anda": "Press the keys on your keyboard",
  "Misalnya Buka tab tertutup": "For example Reopen closed tab", "Tombol yang tidak ada di keyboard Anda": "Keys your keyboard does not have",
  "Disimpan di perangkat ini saja.": "Saved on this device only.", "Rekam ulang": "Record again",
  "Alt ditahan. Tekan Tab untuk memilih jendela, klik Alt lagi untuk melepas.": "Alt is held. Press Tab to pick a window, click Alt again to let go.",
  "Perlu layanan Windows TryDesk di PC itu": "Needs the TryDesk Windows service on that PC", "Pakai Ctrl + Alt + Del, lalu Kunci": "Use Ctrl + Alt + Del, then Lock",
  "Perlu TryDesk versi baru di PC itu": "That PC needs a newer TryDesk",
  "PC itu sedang di layar kunci. Hanya tombol ini yang sampai.": "That PC is on its lock screen. Only these keys reach it.",
  "Coba kata lain, misalnya kunci atau task. Atau simpan sebagai kombinasi Anda sendiri.": "Try another word, like lock or task. Or save it as your own combination.",
  "Buatan Anda": "Your own", "Alat": "Tools", "Teks": "Text", "Tombol satuan": "Single keys",
  "Menu Start": "Start menu", "Jalankan": "Run", "Tampilkan desktop": "Show desktop", "Menu Win + X": "Quick Link menu",
  "Pengaturan Windows": "Windows Settings", "Kunci PC": "Lock PC", "Pindah jendela": "Switch window", "Tutup jendela": "Close window",
  "Semua jendela": "Task view", "Perkecil semua": "Minimize all", "Perbesar jendela": "Maximize window", "Jendela ke kiri": "Snap left",
  "Jendela ke kanan": "Snap right", "Riwayat clipboard": "Clipboard history", "Potong layar": "Snip the screen",
  "Foto jendela aktif": "Capture the active window", "Pilih layar proyektor": "Project to a screen", "Menu Start (cara lama)": "Start menu (classic)",
  "Tempel": "Paste", "Potong": "Cut", "Urungkan": "Undo", "Ulangi": "Redo", "Cari di halaman": "Find on the page",
  "Pindah kolom": "Next field", "Hapus satu huruf": "Delete a letter",
  "Ctrl + Alt + Del perlu layanan Windows TryDesk di PC itu": "Ctrl + Alt + Del needs the TryDesk Windows service on that PC",
  "Lewat layanan Windows: pakai Ctrl + Alt + Del, lalu Kunci": "Through the Windows service: use Ctrl + Alt + Del, then Lock",
  "Kunci PC perlu TryDesk versi baru di PC itu": "Lock PC needs a newer TryDesk on that PC",
  "Ctrl + Alt + Del gagal di PC itu": "Ctrl + Alt + Del didn't work on that PC",
  "Saat Windows menyala dan jendela ditutup": "When Windows starts and the window closes",
  "Tetap aktif setelah jendela ditutup": "Keep running after the window is closed",
  "TryDesk pindah ke ikon kecil di pojok kanan bawah, jadi PC ini tetap bisa dihubungi. Keluar lewat klik kanan ikon itu.": "TryDesk moves to the small icon at the bottom right, so this PC can still be reached. Quit by right-clicking that icon.",
  "Tampilkan TryDesk di profil Discord": "Show TryDesk on my Discord profile", "Teman melihat \"Menggunakan TryDesk\".": "Friends see \"Using TryDesk\".",
  "Tanpa password, setiap koneksi harus Anda terima dulu. Dengan password, tamu yang tahu password langsung masuk.": "Without a password, you accept every connection first. With one, guests who know it come straight in.",
  "Langsung masuk bila password benar": "Come straight in with the right password", "Matikan bila Anda tetap ingin menekan Terima.": "Turn off if you still want to press Accept.",
  "Yang boleh dilakukan tamu": "What guests may do", "Salin dan tempel teks": "Copy and paste text", "Kirim dan ambil file": "Send and receive files",
  "Hanya melihat layar": "View the screen only", "Tamu tidak bisa klik atau mengetik.": "Guests can't click or type.", "ID PC ini": "This PC's ID",
  "ID lama berhenti berlaku bila Anda membuat yang baru.": "The old ID stops working when you make a new one.", "Pengaman sesi": "Session safety",
  "Kunci Windows setelah sesi selesai": "Lock Windows when a session ends", "Putuskan otomatis setelah": "Disconnect automatically after",
  "Blokir setelah 3 kali password salah": "Block after 3 wrong passwords", "Peminta diblokir 5 sampai 20 menit.": "The requester is blocked for 5 to 20 minutes.",
  "Pengaturan lanjutan": "Advanced settings", "Jendela administrator": "Administrator windows", "Kontrol jendela administrator": "Control administrator windows",
  "Perlu agar klik dan ketik bekerja di jendela seperti CMD admin. TryDesk dibuka ulang dengan izin administrator.": "Needed so clicks and typing work in windows like an admin CMD. TryDesk reopens with administrator rights.",
  "Jalankan sebagai admin": "Run as admin",
  "Pilihan awal, cocok untuk kebanyakan PC": "The starting choice, fits most PCs", "Internet lambat atau kuota terbatas": "Slow internet or a limited data plan",
  "Wi-Fi rumah biasa": "Ordinary home Wi-Fi", "Teks dan gambar lebih tajam": "Sharper text and pictures", "Jaringan kabel yang cepat": "A fast wired network",
  "Main game, monitor 165 Hz": "Gaming, 165 Hz monitor", "Satu jaringan lokal, monitor 240 Hz": "Same local network, 240 Hz monitor",
  "Bawaan": "Default", "Kustom": "Custom", "Diatur sendiri di panel Kualitas saat sesi": "Set yourself in the Quality panel during a session",
  "Suara dari PC jauh": "Sound from the remote PC", "Putar suara otomatis saat sesi dimulai": "Play sound automatically when a session starts",
  "Volume suara dari PC jauh": "Remote PC volume", "Tampilan sesi": "Session view", "Ukuran gambar": "Picture size", "Pas dengan jendela": "Fit the window",
  "Tampilkan angka kecepatan": "Show speed numbers", "FPS, ping, dan kecepatan di pojok layar.": "FPS, ping and speed in a corner of the screen.",
  "Format video": "Video format", "Biarkan Otomatis, kecuali diminta saat ada masalah.": "Leave it on Automatic unless you are asked to change it because of a problem.",
  "Otomatis (disarankan)": "Automatic (recommended)", "AV1 (paling hemat data)": "AV1 (uses the least data)", "VP9 (seimbang)": "VP9 (balanced)",
  "VP8 (paling cocok untuk PC lama)": "VP8 (best for older PCs)", "H.264 (dibantu kartu grafis)": "H.264 (helped by the graphics card)",
  "Sambung di jaringan yang sama, sambung ulang, dan batas kecepatan.": "Connecting on the same network, reconnecting, and speed limits.",
  "Jaringan yang sama": "Same network", "Cara pakai": "How to use",
  "Gagal tersambung?": "Didn't connect?",
  "PC ini sedang dikontrol oleh": "This PC is being controlled by", "Boleh": "Allowed", "Tidak boleh": "Not allowed",
  "Tidak boleh selama mouse dan keyboard mati": "Not allowed while mouse and keyboard are off", "Hanya melihat layar (Pengaturan)": "View only (Settings)",
  "Sakelar ini sama dengan Pengaturan › Keamanan.": "These switches are the same as Settings › Security.", "Putuskan sesi": "End session",
  "Tidak dijawab.": "No answer.", "Ditolak.": "Declined.", "Offline.": "Offline.", "Sibuk.": "Busy.",
  "Permintaan sudah sampai, tetapi tidak ada yang menekan Terima dalam 30 detik.": "The request arrived, but nobody pressed Accept within 30 seconds.",
  "Pemilik PC itu menekan Tolak pada permintaan Anda.": "The owner of that PC pressed Decline on your request.",
  "Minta pemilik PC menekan Terima": "Ask the PC's owner to press Accept", "Kotak merah permintaan muncul di layar PC itu.": "The red request box appears on that PC's screen.",
  "Masuk dengan password akses": "Sign in with the access password", "Dengan password, Anda tidak perlu menunggu Terima.": "With the password you don't have to wait for Accept.",
  "Kabari pemilik PC dulu": "Let the PC's owner know first", "Lewat chat atau telepon, lalu kirim permintaan lagi.": "By chat or phone, then send the request again.",
  "Dengan password, Anda langsung masuk tanpa menunggu Terima.": "With the password you get in straight away, without waiting for Accept.",
  "Pastikan TryDesk di PC itu terbuka": "Make sure TryDesk is open on that PC", "Di Beranda PC itu harus tertulis Online.": "That PC's Home must say Online.",
  "Periksa lagi ID-nya": "Check the ID again", "Satu angka salah saja membuat ID tidak ditemukan.": "A single wrong digit means the ID is not found.",
  "Satu jaringan?": "Same network?", "Sambung lewat IP bekerja tanpa internet.": "Connect by IP works without internet.",
  "Coba lagi nanti": "Try again later", "Setelah sesi yang sedang berjalan selesai.": "After the running session ends.",
  "Isi password": "Enter password", "Ubah ID": "Change ID", "ID disalin": "ID copied", "Salin alamat IP": "Copy IP address",
  "Pesan baru · baru saja": "New message · just now", "Buka chat": "Open chat", "Nanti": "Later", "Kembali ke langkah": "Back to the steps", "Kalau gagal tersambung": "If it doesn't connect", "Berikutnya": "Next",
  "PC lain di Wi-Fi atau kabel yang sama bisa tersambung dengan mengetik IP PC ini, tanpa internet. Perlu password akses minimal 10 huruf. Saat pertama dinyalakan, Windows meminta izin firewall.": "Other PCs on the same Wi-Fi or cable can connect by typing this PC's IP, without internet. Needs an access password of at least 10 characters. The first time it is turned on, Windows asks for firewall permission.",
  "Saat tersambung": "While connected", "Sambung ulang otomatis bila terputus": "Reconnect automatically when cut off", "Berhenti menunggu setelah": "Stop waiting after",
  "Saat PC ini dikontrol": "While this PC is controlled", "Jangan biarkan layar mati": "Keep the screen on", "Layar tetap menyala selama sesi.": "The screen stays on during a session.",
  "Batas kecepatan kirim": "Upload speed limit", "Supaya internet lain di rumah tidak terganggu.": "So other internet use at home isn't disturbed.",
  "Jalur koneksi": "Connection route", "Langsung dulu. Bila tidak bisa, lewat server TryDesk.": "Direct first. If that fails, through the TryDesk server.",
  "Selalu langsung": "Always direct", "Selalu lewat server": "Always through the server",
  "PC ini tetap bisa dikontrol setelah restart dan saat sesi RDP diputus, dengan ID yang sama.": "This PC can still be controlled after a restart and when an RDP session is disconnected, with the same ID.",
  "Pilihan": "Options", "Tanpa password akses, setiap koneksi tetap meminta Terima.": "Without an access password, every connection still asks for Accept.",
  "PC ini hanya bisa dihubungi saat TryDesk terbuka.": "This PC can only be reached while TryDesk is open.",
  "Terpasang dan berjalan.": "Installed and running.", "Terpasang, tapi sedang berhenti.": "Installed, but stopped.", "Layanan belum dipasang.": "The service isn't installed.",
  "PC ini bisa dihubungi setelah restart, dengan ID yang sama.": "This PC can be reached after a restart, with the same ID.",
  "Memakai versi Portable?": "Using the Portable version?",
  "Versi Portable tidak memasang layanan, jadi PC ini hanya bisa dihubungi saat TryDesk terbuka. Pakai versi Setup bila PC ini harus tetap bisa dihubungi setelah restart.": "The Portable version doesn't install the service, so this PC can only be reached while TryDesk is open. Use the Setup version if this PC must stay reachable after a restart.",
  "Hanya di TryDesk untuk Windows": "Only in TryDesk for Windows",
  "Layanan Windows membuat PC tetap bisa dihubungi setelah restart. Komputer ini hanya bisa mengontrol PC lain.": "The Windows service keeps a PC reachable after a restart. This computer can only control other PCs.",
  "Informasi TryDesk dan mengembalikan pengaturan ke awal.": "About TryDesk, and putting the settings back to the start.",
  "Kartu grafis": "Graphics card", "Pakai kartu grafis (GPU)": "Use the graphics card (GPU)",
  "Matikan bila gambar rusak atau berkedip. Berlaku setelah TryDesk dibuka ulang.": "Turn off if the picture breaks up or flickers. Takes effect after TryDesk is reopened.",
  "Kembalikan ke awal": "Back to the start", "Kembalikan semua pengaturan": "Reset all settings", "Kembalikan": "Reset",
  "ID, PC favorit, riwayat koneksi, dan password akses tetap disimpan.": "Your ID, favourite PCs, connection history and access password are kept.",
  // Control Center › Monitor (Arah 1, 18 Nov 2026)
  "Cara tampil": "Show", "Satu monitor": "One monitor", "Semua monitor": "All monitors", "Satu jendela per monitor": "One window per monitor",
  "Pilih di peta. Gambar paling besar.": "Pick it on the map. Largest picture.",
  "Berdampingan di jendela ini.": "Side by side in this window.",
  "Taruh di layar Anda sendiri.": "Each on a screen of yours.",
  "Ikuti kursor": "Follow the cursor", "Pindah ke monitor tempat kursor PC itu berada.": "Goes to the monitor where that PC's cursor is.",
  "Klik monitor lain di peta untuk pindah.": "Click another monitor on the map to switch.", "Letaknya sama seperti di PC itu.": "Placed as they are on that PC.",
  "Semua monitor mengirim satu gambar per monitor, jadi butuh internet lebih cepat.": "All monitors sends one picture per monitor, so it needs a faster connection.",
  "Perbarui TryDesk di PC itu untuk melihat semua monitor.": "Update TryDesk on that PC to see all monitors.", "PC itu hanya punya 1 monitor.": "That PC has only 1 monitor.",
  "Jendela terpisah": "Separate windows", "Jendela monitor tidak bisa dibuka.": "The monitor window could not be opened.",
  "mouse Anda di sini": "your mouse is here", "utama": "main",
};
// Text produced earlier through t() (tile tooltips, toasts) is in the DOM in the language of that moment —
// map the I18N dictionary's Indonesian strings too, so a language switch updates it in place.
for (const [k, v] of Object.entries(I18N.id)) if (I18N.en[k] && !(v in TEXT_EN)) TEXT_EN[v] = I18N.en[k];
// Strings with a variable part (an ID, a path, a count…). A function replacement can translate the inner part too.
const TEXT_EN_PATTERNS = [
  [/^· (\d+) untuk pengguna berpengalaman$/, "· $1 for experienced users"],
  [/^✓ Layanan terpasang( \(berhenti\))?(, ID layanan: ([\d ]+))?$/, (_m, stopped, _i, id) => "✓ Service installed" + (stopped ? " (stopped)" : "") + (id ? ", service ID: " + id : "")],
  [/^PC ini memakai layanan TryDesk\. Sambung ke ID ([\d ]+)$/, "This PC uses the TryDesk service. Connect to ID $1"],
  [/^Kembali ke sesi (.+)$/, "Back to session $1"],
  [/^Kembali ke (\d+) sesi berjalan$/, "Back to $1 running sessions"],
  [/^Sesi dengan (.+) masih berjalan$/, "Your session with $1 is still running"],
  [/^Seseorang ingin mengontrol desktop ini\.$/, "Someone wants to control this desktop."],
  [/^(.+) ingin mengontrol desktop ini\.$/, "$1 wants to control this desktop."],
  [/^Ditolak otomatis dalam (\d+) detik$/, "Declined automatically in $1 seconds"],
  [/^Chat · sesi (.+)$/, "Chat · session $1"],
  [/^(\d+) pesan baru · baru saja$/, "$1 new messages · just now"],
  [/^Dikontrol oleh (.+)$/, "Controlled by $1"],
  [/^Menyambung ke (.+)$/, "Connecting to $1"],
  [/^Periksa ID: (.+)$/, "Check the ID: $1"],
  [/^Kualitas lanjutan \((.+)\) ›$/, "Advanced quality ($1) ›"],
  [/^dengan (\d{3} \d{3} \d{3}|\S+)$/, "with $1"],
  [/^(\d+) sesi masih berjalan$/, "$1 sessions are still running"],
  [/^(.+) meminta password akses, buka tab tersebut$/, "$1 asks for its access password, open that tab"],
  [/^Menyambung ulang ke (.+) \((\d+)\/(\d+)\)…$/, "Reconnecting to $1 ($2/$3)…"],
  [/^Meminta akses ke (.+)\.\.\.$/, "Requesting access to $1..."],
  [/^Terhubung ke (.+)$/, "Connected to $1"],
  [/^Alamat PC ini: (.+)$/, "This PC's address: $1"],
  [/^Butuh password (\d+)\+ karakter$/, "Needs a $1+ character password"],
  [/^PC (.+) meminta password akses\.$/, "PC $1 is asking for its access password."],
  [/^PC tujuan perlu password akses minimal (\d+) karakter untuk koneksi lewat IP$/, "The other PC needs an access password of at least $1 characters for connecting by IP"],
  [/^Koneksi LAN hanya bisa dipakai dengan password akses minimal (\d+) karakter \(Pengaturan → Keamanan\)$/, "LAN connections only work with an access password of at least $1 characters (Settings → Security)"],
  [/^TryDesk (\S+) tersedia$/, "TryDesk $1 is available"],
  [/^Anda memakai versi (\S+)\.$/, "You are using version $1."],
  [/^Versi (\S+) punya celah keamanan yang sudah diperbaiki\. Perbarui ke (\S+) untuk bisa terhubung lagi\.$/, "Version $1 has a security issue that has been fixed. Update to $2 to connect again."],
  [/^Port (\d+) sudah dipakai program lain$/, "Port $1 is already used by another program"],
  [/^Tidak bisa membuka port LAN \((.+)\)$/, "Couldn't open the LAN port ($1)"],
  [/^Menghubungkan (.+)…$/, "Connecting $1…"],
  [/^Beralih ke Monitor (\d+)…$/, "Switching to Monitor $1…"],
  [/^Monitor (\d+) · utama$/, "Monitor $1 · primary"],
  [/^Screenshot disimpan: (.+)$/, "Screenshot saved: $1"],
  [/^Rekaman disimpan: (.+)$/, "Recording saved: $1"],
  [/^Tersimpan: (.+)$/, "Saved: $1"],
  [/^Alias disimpan: (.+)$/, "Alias saved: $1"],
  [/^Nama untuk (.+)$/, "Name for $1"],
  [/^(\d+) file ditambahkan ke antrean$/, "$1 file(s) added to the queue"],
  [/^(\d+) file dikirim\. Menunggu orang di PC itu menekan Terima\.$/, "$1 file(s) sent. Waiting for the person at that PC to press Accept."],
  [/^(.+) · ingin dikirim$/, "$1 · wants to send"],
  [/^Tidak bisa membuka folder · (.+)$/, (_, e) => `Can't open folder · ${trCore(e)}`],
  [/^Tidak bisa membuka folder$/, "Can't open folder"],
  [/^Gagal mengunci mouse untuk game: (.+)$/, "Couldn't lock the mouse for game mode: $1"],
  [/^(\d+) menit lalu$/, "$1 min ago"], [/^(\d+) jam lalu$/, "$1 h ago"], [/^(\d+) hari lalu$/, "$1 d ago"],
  [/^Layar (\d+)$/, "Screen $1"],
  [/^hari ini (.+)$/, "today $1"],   // pwWhen's piece on its own (the whole line is the pattern below)
  [/^✓ Password akses aktif, diubah (.+)\. Koneksi dengan password ini tidak perlu klik Terima\.$/, (_m, when) => {
    const MON = { Mei: "May", Agu: "Aug", Okt: "Oct", Des: "Dec" };
    const w = when.replace(/^hari ini /, "today ").replace(/(\d{2})\.(\d{2})$/, "$1:$2").replace(/\b(Mei|Agu|Okt|Des)\b/, (m) => MON[m]);
    return `✓ Access password on, changed ${w}. Connections with this password don't need Accept.`;
  }],
  // the Kartu kunci card's line under the dots: "Diubah hari ini 22.48" / "Diubah 12 Nov 22.48"
  [/^Diubah ((?:hari ini|\d{1,2} \w{3}) \d{2}\.\d{2})$/, (_m, when) => {
    const MON = { Mei: "May", Agu: "Aug", Okt: "Oct", Des: "Dec" };
    return "Changed " + when.replace(/^hari ini /, "today ").replace(/(\d{2})\.(\d{2})$/, "$1:$2").replace(/\b(Mei|Agu|Okt|Des)\b/, (m) => MON[m]);
  }],
  // in-app updates (18 Nov 2026), added at the end: the locales key patterns by their place in this list
  [/^Mengunduh TryDesk (\S+)$/, "Downloading TryDesk $1"], [/^Memasang TryDesk (\S+)$/, "Installing TryDesk $1"],
  [/^TryDesk (\S+) siap dipasang$/, "TryDesk $1 is ready to install"], [/^TryDesk sudah (\S+)$/, "TryDesk is now $1"],
  // Control Center › Monitor (18 Nov 2026), added at the end for the same reason
  [/^(\d+) · utama$/, "$1 · main"],
];

function trCore(core) {
  const k = core.replace(/\s+/g, " ");
  if (LOC && lang !== "en") {
    if (LOC.s[k] != null) return LOC.s[k];
    for (const [re, rep] of LOC.p) if (re.test(k)) return k.replace(re, rep);
  }
  if (TEXT_EN[k] != null) return TEXT_EN[k];
  for (const [re, rep] of TEXT_EN_PATTERNS) if (re.test(k)) return k.replace(re, rep);
  return core;
}
// Translate one string, keeping its surrounding whitespace (text nodes beside icons carry spaces).
function trText(s) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  if (!m[2]) return s;
  const out = trCore(m[2]);
  return out === m[2] ? s : m[1] + out + m[3];
}
// For text that never enters the DOM (native notifications, dialogs).
function tr(s) { return lang !== "id" ? trText(String(s)) : s; }

// User / peer content is never translated: chat bodies, chat-notification text, file and transfer names.
const TR_SKIP = ".lang-card, .help-id, .help-en, .chat-msg, .cn-text, .cn-name, #hosting-name, #fail-who, #chat-with, #keys-with, .kp-own-name, .kp-kbds, .kp-single,.fm-name, .tc-name, #accept-alias, #accept-id, #connect-pw-name, .id-text, #sum-name-v, #set-my-id,.tile-id, .tile-sub-id, .tile-menu-head, .rtab-label, script, style, textarea, .km-gt > span:first-child, .km-gn, .km-dd-n, .km-opt .km-ell, .km-menu .km-ell, .km-pcs, .km-fr-top b, .km-file b";
const TR_ATTRS = ["title", "placeholder", "aria-label"];
// Each node remembers its Indonesian source, so switching back restores it exactly. A node the app rewrote
// since (data no longer equals what we wrote) takes its new text as the source.
// TR_BACK remembers every translation written (text shown -> Indonesian source): a node rebuilt from shown HTML
// (riseWords puts a heading's innerHTML back) is then read as its Indonesian source again, not as new text,
// so switching language later still translates it.
const TR_BACK = new Map();
function trTextNode(n) {
  const el = n.parentElement;
  if (!el || el.closest(TR_SKIP)) return;
  if (n._trOut !== undefined && n.data !== n._trOut) n._trSrc = undefined;
  if (n._trSrc === undefined) n._trSrc = TR_BACK.get(n.data) ?? n.data;
  const want = lang !== "id" ? trText(n._trSrc) : n._trSrc;
  if (want !== n._trSrc && TR_BACK.size < 20000) TR_BACK.set(want, n._trSrc);
  n._trOut = want;
  if (n.data !== want) n.data = want;
}
function trAttrs(el) {
  if (el.closest(TR_SKIP)) return;
  for (const a of TR_ATTRS) {
    const v = el.getAttribute(a);
    if (v == null) continue;
    el._trA = el._trA || {};
    let rec = el._trA[a];
    if (!rec || v !== rec.out) rec = el._trA[a] = { src: v };
    rec.out = lang !== "id" ? trText(rec.src) : rec.src;
    if (v !== rec.out) el.setAttribute(a, rec.out);
  }
}
function trTree(root) {
  if (root.nodeType === 3) return trTextNode(root);
  if (root.nodeType !== 1) return;
  trAttrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.nodeType === 3) trTextNode(n); else trAttrs(n); }
}
// The "Sambung lewat IP" help is written as whole Indonesian and English blocks (bold words inside sentences).
// Other languages show the Indonesian block with each sentence swapped for its translation, the sentence's
// HTML as the key: the same "unit" rule as scripts/i18n-extract.mjs (the outermost h4 / p / span / small / b / div
// holding no other block). A leading icon or empty check mark stays; only b / i / em / strong are let in.
const HELP_UNIT = /^(H4|P|SPAN|SMALL|B|DIV)$/, HELP_BLOCK = "div, section, span, p, h4, small";
function helpUnits(root, out = []) {
  for (const c of root.children) {
    if (c.tagName === "svg") continue;
    if (HELP_UNIT.test(c.tagName) && !c.querySelector(HELP_BLOCK)) { if (/\p{L}/u.test(c.textContent)) out.push(c); }
    else helpUnits(c, out);
  }
  return out;
}
function helpHtml(nodes) {
  return nodes.map((n) => n.nodeType === 3 ? n.data.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;") : n.nodeType === 1 ? n.outerHTML : "").join("");
}
function helpSafe(html) {
  const tpl = document.createElement("template"); tpl.innerHTML = html;
  const clean = (node) => { for (const c of [...node.childNodes]) { if (c.nodeType === 1) { if (!/^(B|I|EM|STRONG|BR)$/.test(c.tagName)) { c.replaceWith(document.createTextNode(c.textContent)); continue; } for (const a of [...c.attributes]) if (a.name !== "class") c.removeAttribute(a.name); clean(c); } else if (c.nodeType !== 3) c.remove(); } };
  clean(tpl.content);
  return tpl.content;
}
function trHelpBlocks() {
  for (const block of $$(".help-id")) for (const el of helpUnits(block)) {
    const kids = [...el.childNodes];
    let k = 0; while (k < kids.length && kids[k].nodeType === 1 && (kids[k].tagName === "svg" || (kids[k].tagName === "I" && !kids[k].textContent))) k++;
    const rest = kids.slice(k);
    if (el._helpSrc == null) { el._helpSrc = helpHtml(rest); el._helpOut = el._helpSrc; }
    const key = el._helpSrc.replace(/\s+/g, " ").trim();
    const want = LOC && lang !== "id" && lang !== "en" && LOC.s[key] != null ? LOC.s[key] : el._helpSrc;
    if (el._helpOut === want) continue;
    rest.forEach((n) => n.remove());
    el.appendChild(want === el._helpSrc ? (() => { const t = document.createElement("template"); t.innerHTML = want; return t.content; })() : helpSafe(want));
    el._helpOut = want;
  }
}
// Beranda was drawn for Indonesian. A longer language ("Введіть ID, потім натисніть «Підключитися».") would run the
// big sentence to four lines over the ID box, and push the fact values to "Не вста…". The sentence gets smaller
// until it fits two lines (never under 22 px); a fact whose value doesn't fit puts it under its name.
function fitHomeText() {
  const h = document.querySelector(".stage-title");
  if (h && h.offsetParent) {
    h.style.fontSize = "";
    const cs = getComputedStyle(h), pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    let fs = parseFloat(cs.fontSize);
    const lines = () => (h.getBoundingClientRect().height - pad) / (fs * (parseFloat(cs.lineHeight) / fs || 1.04));
    for (let i = 0; i < 12 && fs > 22 && lines() > 2.4; i++) { fs -= 2; h.style.fontSize = fs + "px"; }
  }
  for (const f of document.querySelectorAll(".home-facts .fact")) {
    f.classList.remove("stack");
    const v = f.querySelector(".fact-value");
    if (v && v.offsetParent && v.scrollWidth > v.clientWidth + 1) f.classList.add("stack");
  }
}
window.addEventListener("resize", () => { clearTimeout(fitHomeText._t); fitHomeText._t = setTimeout(() => { try { fitHomeText(); } catch {} }, 120); });
// Text that appears or changes later (toasts, menus, status, transfer cards) is translated as it lands.
// Our own writes are recognised (data === _trOut) and settle without looping.
const trObserver = new MutationObserver((muts) => {
  for (const m of muts) {
    if (m.type === "childList") m.addedNodes.forEach(trTree);
    else if (m.type === "characterData") trTextNode(m.target);
    else if (m.type === "attributes") trAttrs(m.target);
  }
});
trObserver.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: TR_ATTRS });

// ─── Motion (Konsep Desain, direction A) ──────────────────
// The 130 bpm grid from the portfolio video: a quarter beat 115 ms (buttons), half 230 ms (panels), one beat 460 ms
// (a screen). Headings rise word by word from behind their line when a screen opens, 115 ms apart, with a small
// spring and no bounce. The words are wrapped only while they move, then the heading's own HTML comes back, so
// the ID/EN translator keeps seeing whole sentences. Nothing moves under "reduce motion".
const motionOff = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function riseWords(el) {
  if (!el || motionOff() || el.offsetParent === null || el.dataset.rising) return;
  const src = el.innerHTML;
  let i = 0;
  const wrap = (node) => {
    for (const n of [...node.childNodes]) {
      if (n.nodeType === 3) {
        const parts = n.textContent.split(/(\s+)/);
        if (!n.textContent.trim()) continue;
        const frag = document.createDocumentFragment();
        for (const p of parts) {
          if (!p) continue;
          if (/^\s+$/.test(p)) { frag.append(p); continue; }
          const outer = document.createElement("span"); outer.className = "rw";
          const inner = document.createElement("span"); inner.textContent = p; inner.style.setProperty("--i", i++);
          outer.append(inner); frag.append(outer);
        }
        n.replaceWith(frag);
      } else if (n.nodeType === 1 && n.tagName !== "BR") wrap(n);
    }
  };
  el.dataset.rising = "1";
  wrap(el);
  setTimeout(() => { el.innerHTML = src; delete el.dataset.rising; }, 460 + i * 115 + 60);
}
// A whole screen or page arriving (one beat): the container fades up 8 px, its heading rises.
// The class comes off when the beat ends: a transform left on a screen (even an identity one) makes it the frame
// for every position:fixed page inside it, so "Semua perangkat" opened 38 px low after any return to Home.
function arrive(el, heading) {
  if (!el || motionOff()) return;
  el.classList.remove("td-arrive"); void el.offsetWidth; el.classList.add("td-arrive");
  el.addEventListener("animationend", function done(e) { if (e.target !== el) return; el.classList.remove("td-arrive"); el.removeEventListener("animationend", done); });
  if (heading) riseWords(heading);
}

// ─── UI helpers ───────────────────────────────────────────
function showScreen(name) {
  const wasHidden = $(`#screen-${name}`)?.classList.contains("hidden");
  $("#fail-view")?.classList.add("hidden");
  if (name !== "home") document.documentElement.classList.remove("devices-open");
  if (name !== "home" && KM && KM.open) setManageOpen(false);   // Kelola banyak perangkat belongs to Beranda too
  if (name !== "home") $("#overlay-lan-help")?.classList.add("hidden");   // the help belongs to Beranda; never over a session
  // the key panel belongs to the remote screen: over Beranda it kept sending keys to a PC not on screen (audit 19 Nov)
  if (name !== "remote" && typeof kp !== "undefined") { try { closeKeysPanel(); } catch {} }
  for (const s of ["home", "connecting", "remote", "hosting"]) {
    $(`#screen-${s}`).classList.toggle("hidden", s !== name);
  }
  // Show titlebar for home/connecting, hide for remote (grip bar replaces it)
  $("#titlebar").style.display = (name === "remote") ? "none" : "";
  refreshKeyCapture();
  renderBackPill();
  renderAdminBanner();
  if (typeof fsDockSync === "function") fsDockSync();
  if (typeof closeTileMenu === "function") closeTileMenu();   // a device's ⋮ menu must not float over another screen
  if (name === "home") setTimeout(() => { try { fitHomeText(); } catch {} }, 0);
  if (wasHidden) {
    const scr = $(`#screen-${name}`);
    arrive(scr, name === "home" ? scr.querySelector(".stage-title") : name === "hosting" ? scr.querySelector(".host-title") : null);
  }
}

// Sessions keep running while Home ("＋") or a connecting tab is on screen, always offer the way back to them.
function renderBackPill() {
  const pill = $("#back-to-session"); if (!pill) return;
  const shown = ["home", "connecting", "hosting"].find((n) => !$(`#screen-${n}`).classList.contains("hidden"));
  const live = viewerSessions().filter((s) => s.pc && !(shown === "connecting" && s === active));
  pill.classList.toggle("hidden", !shown || !live.length);
  // Desktop: a red band under the title bar (concept), so the band pushes the screen down instead of covering it.
  document.documentElement.classList.toggle("has-back-band", !!shown && !!live.length);
  if (!live.length) return;
  const target = live.includes(active) ? active : live[live.length - 1];
  pill._target = target;
  const who = peerName(target.peerId) || fmtId(target.peerId);
  pill.querySelector(".bp-text").textContent = live.length > 1 ? `${live.length} sesi masih berjalan` : `Sesi dengan ${who} masih berjalan`;
  pill.querySelector(".bp-go").textContent = isPhoneUi() ? (live.length > 1 ? `Kembali ke ${live.length} sesi berjalan` : `Kembali ke sesi ${who}`) : "Kembali ke sesi";   // the PC's name when it has one (the bare ID broke over two lines)
}

// Full keyboard capture (native hook, forwards Alt+Tab, Win, Alt+Esc etc. to the remote even outside
// fullscreen) is ON only while we're actively controlling a remote PC: off on Home/Hosting, in view-only,
// and while typing in a local field so the user can still use TryDesk's own inputs.
let _kbReleased = false;   // Pause / Ctrl+Alt+Shift+Esc gave the keyboard back; a click on the remote view takes it again
function refreshKeyCapture() {
  const remote = !$("#screen-remote").classList.contains("hidden");
  const a = document.activeElement;
  // (the key-combination panel too: its recorder and tiles take keys for themselves, never the other PC)
  const typing = a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || !!(a.closest && a.closest("#keys-panel")));
  // Hold keys belong to the session on screen: leaving it (Home, "+") lets them go
  if (!remote) { try { if (kp.held.size) keysReleaseHeld(); } catch {} }   // (try: this can run before kp exists)
  // Also off when the HOST only lets us watch: grabbing Win / Alt+Tab here would just swallow them.
  // Off while File Transfer is open (owner's report 16 Nov: Ctrl+click never picked a second file, so the checkboxes
  // never showed): the native hook swallowed Ctrl, Delete, F2 and Esc before File Transfer could see them.
  const on = !!(remote && active && active.role === "viewer" && !active.viewOnly && !active.hostViewOnly && !typing && !_kbReleased && !fmOpen);
  try { window.electronAPI && window.electronAPI.setKeyCapture && window.electronAPI.setKeyCapture(on); } catch {}
  // Leaving control (view-only, left the remote screen, session closed) must also drop native game-mouse
  // capture so the user's cursor is never left trapped.
  if (!on && _gameActive) setGameCapture(false);
}

// Arah 3 (owner pick 15 Nov): a strip under the title bar with a mark (done / problem / note), the text on one line and
// a close button at the far right; on the phone a card above the tab bar (mobile.css).
const TOAST_BAD = /\b(gagal|tidak bisa|tidak dapat|ditolak|salah|error|offline|terputus|memutus|diputus|tidak ditemukan|belum bisa|tidak didukung|tidak ada respons|tidak menjawab|minimal|failed|couldn't|can't|cannot|refused|declined|wrong|not found|disconnected|not supported|no response|didn't answer)\b/i;   // ("tidak menjawab" showed the grey info mark, 21 Nov)
const TOAST_GOOD = /\b(disalin|tersimpan|disimpan|terkirim|berhasil|copied|saved|sent)\b/i;
const TOAST_IC = {
  good: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M7.8 12.3l2.8 2.8 5.6-5.8"/></svg>',
  bad: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5.5M12 16.5h.01"/></svg>',
  info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 11v5.5M12 7.5h.01"/></svg>',
};
function showToast(message, kind) {
  let toast = $(".toast");
  if (!toast) {
    toast = document.createElement("div"); toast.className = "toast"; toast.setAttribute("role", "status");
    toast.innerHTML = '<span class="tst-ic" aria-hidden="true"></span><span class="tst-tx"></span><button class="tst-x" type="button" aria-label="Tutup"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
    toast.querySelector(".tst-x").addEventListener("click", () => { clearTimeout(toast._t); toast.classList.remove("show"); });
    document.body.appendChild(toast);
    // Its height (one line or more) moves the screens under the title bar down while it shows (style.css "Alert fixes")
    try { new ResizeObserver(() => document.documentElement.style.setProperty("--tst-h", `${toast.offsetHeight}px`)).observe(toast); } catch {}
  }
  const msg = String(message);
  kind = kind || (TOAST_BAD.test(msg) ? "bad" : TOAST_GOOD.test(msg) ? "good" : "info");
  toast.dataset.kind = kind;
  noticeSound(kind);
  toast.querySelector(".tst-ic").innerHTML = TOAST_IC[kind];
  toast.querySelector(".tst-tx").textContent = msg;
  toast.classList.add("show");
  clearTimeout(toast._t);
  // Long enough to read: 3 s for a short note, up to 9 s for a long one (a 150-character notice vanished after 3 s).
  toast._t = setTimeout(() => toast.classList.remove("show"), Math.max(3000, Math.min(9000, String(message).length * 55)));
}

function setStatus(state, text) { statusDot.className = `status-dot ${state}`; statusText.textContent = text; }

const _hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function _pbkdf2(pw, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, key, 256);
}
// Access password is stored as a salted, slow PBKDF2 hash ("saltHex:hashHex") so a leaked store
// can't be brute-forced quickly; it is checked through the HMAC challenge below, never compared directly.
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${_hex(salt.buffer)}:${_hex(await _pbkdf2(pw, salt))}`;
}
const _hexToBytes = (h) => Uint8Array.from((String(h).match(/.{2}/g) || []).map((x) => parseInt(x, 16)));
function _constEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// HMAC-SHA256(keyBytes, msg) → hex. Used for the server-blind access-password challenge/response:
// the signaling server relays only the salt, a one-shot nonce and this HMAC, never the password.
async function _hmacHex(keyBytes, msg) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(String(msg)));
  return _hex(sig);
}
// Viewer side: prove knowledge of the access password against the host's challenge, without the
// password ever leaving this machine. Key = PBKDF2(password, salt), the exact bytes the host stored.
async function answerChallenge(pw, saltHex, nonce) {
  const keyBytes = new Uint8Array(await _pbkdf2(pw || "", _hexToBytes(saltHex)));
  return _hmacHex(keyBytes, nonce);
}
// Host side: recompute the expected HMAC from the stored "saltHex:hashHex" (hashHex IS the key bytes).
async function expectedChallenge(stored, nonce) {
  if (!stored || !stored.includes(":")) return null;      // legacy unsalted hashes can't do HMAC challenge
  const hashHex = stored.split(":")[1];
  return _hmacHex(_hexToBytes(hashHex), nonce);
}
// Viewer side, split in two: derive the key once from the typed password, then answer each nonce with it.
const deriveKeyHex = async (pw, saltHex) => _hex(await _pbkdf2(pw || "", _hexToBytes(saltHex)));
const answerWithKey = (keyHex, nonce) => _hmacHex(_hexToBytes(keyHex), nonce);

// ─── Recent connections & favorites (AnyDesk-style tiles) ──
const STAR_PATH = "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8 5.8 21l1.2-6.9-5-4.9 6.9-1z";
const MONITOR_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`;
let recentSort = "recent";
let recentView = "grid";
function applyRecentView() {
  const list = recentView === "list";
  $("#recent-list")?.classList.toggle("view-list", list);
  $("#favorites-list")?.classList.toggle("view-list", list);
  $("#view-grid")?.classList.toggle("active", !list);
  $("#view-list")?.classList.toggle("active", list);
}

function getRecent() { try { return JSON.parse(store.get("recent") || "[]"); } catch { return []; } }
function addRecent(id) {
  const recent = [{ id, time: Date.now() }, ...getRecent().filter((r) => r.id !== id)].slice(0, 12);
  store.set("recent", JSON.stringify(recent));
  renderRecent();
}
function removeRecent(id) {
  store.set("recent", JSON.stringify(getRecent().filter((r) => r.id !== id)));
  pruneThumbs();
  renderRecent();
}
function clearRecent() { store.set("recent", JSON.stringify([])); pruneThumbs(); renderRecent(); }

// Per-ID custom names ("Rename", as in AnyDesk) and a thumbnail of the remote screen from the last session.
// Both stay on this device only; a thumbnail is dropped as soon as its ID leaves Recent and Favorites.
const getPeerNames = () => { try { return JSON.parse(store.get("peerNames") || "{}") || {}; } catch { return {}; } };
const peerName = (id) => getPeerNames()[id] || "";
function setPeerName(id, name) {
  const m = getPeerNames(); delete m[id];
  name = String(name || "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (name) m[id] = name;
  const ids = Object.keys(m); if (ids.length > 100) delete m[ids[0]];
  store.set("peerNames", Object.keys(m).length ? JSON.stringify(m) : null);
  for (const s of sessions.values()) if (s.role === "viewer" && s.peerId === id) updateSessionLabel(s);
  renderTabs(); renderFavorites(); renderRecent();
}
const getThumbs = () => { try { return JSON.parse(store.get("peerThumbs") || "{}") || {}; } catch { return {}; } };
function pruneThumbs(m = getThumbs()) {
  const keep = new Set([...getRecent(), ...getFavorites()].map((r) => r.id).concat(kmGroupedIds()));   // a PC in a group keeps its picture
  for (const id of Object.keys(m)) if (!keep.has(id)) delete m[id];
  // at most 60 pictures (~20 KB each), newest kept: with a hundred grouped PCs the storage quota (5 MB) filled up
  // and other settings stopped saving. Recent and favorite PCs always keep theirs.
  const must = new Set([...getRecent(), ...getFavorites()].map((r) => r.id));
  const extra = Object.keys(m).filter((id) => !must.has(id));
  for (const id of extra.slice(0, Math.max(0, Object.keys(m).length - 60))) delete m[id];
  store.set("peerThumbs", Object.keys(m).length ? JSON.stringify(m) : null);
}
function saveThumb(sess) {
  const v = sess && sess.role === "viewer" ? sess.video : null;
  if (!v || !v.videoWidth || !v.videoHeight) return;
  try {
    const c = document.createElement("canvas");
    c.width = 320; c.height = Math.max(1, Math.round(320 * v.videoHeight / v.videoWidth));
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    const m = getThumbs(); delete m[sess.peerId]; m[sess.peerId] = c.toDataURL("image/jpeg", 0.72);
    pruneThumbs(m);
    renderFavorites(); renderRecent();
  } catch {}
}

const TILE_ICON = {
  connect: `<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>`,
  files: `<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>`,
  copy: `<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>`,
  star: `<path d="${STAR_PATH}"/>`,
  rename: `<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>`,
  remove: `<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>`,   /* a bin, as drawn in the concept */
  more: `<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>`,
};
const tileSvg = (inner, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const isPhoneUi = () => document.documentElement.classList.contains("td-mobile");

function connectFromTile(id, { files = false } = {}) {
  remoteIdInput.value = id;
  const s = initiateConnection();
  if (!files || !(s instanceof Session)) return;
  if (s.fileChannel && s.fileChannel.readyState === "open") openFileManager();
  else s.openFilesWhenReady = true;      // opened by setupFileChannel once the session's file channel is up
}

function makeTile(id, time, opts = {}) {
  const name = peerName(id);
  const el = document.createElement("div");
  el.className = "recent-tile";
  el.title = `${t("ui_connect")} ${name ? `${name} (${fmtId(id)})` : fmtId(id)}`;
  const preview = document.createElement("div"); preview.className = "tile-preview";
  const thumb = opts.thumbs && opts.thumbs[id];
  if (thumb) { const img = new Image(); img.alt = ""; img.draggable = false; img.src = thumb; preview.classList.add("has-thumb"); preview.appendChild(img); }
  else preview.innerHTML = MONITOR_SVG;
  preview.appendChild(presDot(id));
  const meta = document.createElement("div"); meta.className = "tile-meta";
  // A LAN tile shows the bare address (the "(LAN)" suffix would be cut off) and says LAN on the line below.
  const lanAddr = /^lan:/.test(id) ? id.slice(4) : "";
  const idEl = document.createElement("div"); idEl.className = "tile-id"; idEl.textContent = name || lanAddr || fmtId(id);
  // Concept: name, then the ID, then the time, each on its own line (a PC without a name shows its ID as the name).
  const subEl = document.createElement("div"); subEl.className = "tile-sub";
  if (name) { const pid = document.createElement("span"); pid.className = "tile-sub-id"; pid.textContent = lanAddr || fmtId(id); subEl.append(pid); }
  if (lanAddr) subEl.append(name ? " · LAN" : "LAN");
  const tm = document.createElement("div"); tm.className = "tile-time"; tm.textContent = time;
  meta.append(idEl);
  if (subEl.childNodes.length) meta.append(subEl);
  meta.append(tm);
  const more = document.createElement("button");
  more.className = "tile-more"; more.title = "Opsi lainnya"; more.setAttribute("aria-haspopup", "menu");
  more.innerHTML = tileSvg(TILE_ICON.more, 16);
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    const r = more.getBoundingClientRect();
    openTileMenu(id, el, { fav: opts.fav, x: r.right, y: r.bottom + 4, alignRight: true });
  });
  // The star sits beside the ⋮ under the picture (concept), not on top of the remote screen.
  const foot = document.createElement("div"); foot.className = "tile-foot"; foot.append(meta, makeStarBtn(id, true), more);
  el.append(preview, foot);
  el.addEventListener("click", () => {
    if (el._longPressed) { el._longPressed = false; return; }
    if (el.querySelector(".tile-rename")) return;
    connectFromTile(id);
  });
  el.addEventListener("contextmenu", (e) => { e.preventDefault(); openTileMenu(id, el, { fav: opts.fav, x: e.clientX, y: e.clientY }); });
  // Touch: press and hold opens the same menu
  let lp = null, sx = 0, sy = 0;
  const cancelLp = () => { clearTimeout(lp); lp = null; };
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" || e.target.closest("button, input")) return;
    sx = e.clientX; sy = e.clientY; cancelLp();
    lp = setTimeout(() => { lp = null; el._longPressed = true; openTileMenu(id, el, { fav: opts.fav, x: sx, y: sy }); }, 480);
  });
  el.addEventListener("pointermove", (e) => { if (lp && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancelLp(); });
  el.addEventListener("pointerup", cancelLp);
  el.addEventListener("pointercancel", cancelLp);
  return el;
}
// The sessions card: one tab at a time (Terakhir / Favorit, each with its count), filtered by the search box.
let homeTab = store.get("homeTab") === "fav" ? "fav" : "recent";
const sessMatch = (id, q) => !q || [id, fmtId(id), peerName(id) || ""].some((s) => s.toLowerCase().replace(/\s/g, "").includes(q));
const sessQuery = () => ($("#sess-search")?.value || "").toLowerCase().replace(/\s/g, "");
function renderSessionsView() {
  const recentN = getRecent().length, favN = getFavorites().length, q = sessQuery();
  $("#count-recent").textContent = recentN; $("#count-fav").textContent = favN;
  $$(".sess-tab").forEach((b) => { const on = b.dataset.sess === homeTab; b.classList.toggle("active", on); b.setAttribute("aria-selected", on); });
  $("#recent-section").classList.toggle("hidden", homeTab !== "recent");
  $("#favorites-section").classList.toggle("hidden", homeTab !== "fav");
  $("#recent-clear").classList.toggle("hidden", homeTab !== "recent" || !recentN);
  const shown = $(homeTab === "fav" ? "#favorites-list" : "#recent-list").children.length;
  const empty = $("#sess-empty");
  empty.textContent = shown ? "" : q ? "Tidak ada yang cocok dengan pencarian." : homeTab === "fav" ? (isPhoneUi() ? "Belum ada favorit. Ketuk ⋮ pada sebuah perangkat, lalu pilih Tambah ke favorit." : "Belum ada favorit. Klik bintang pada sebuah perangkat untuk menyimpannya di sini.") : "Belum ada koneksi. Perangkat yang pernah Anda hubungi muncul di sini.";
  empty.classList.toggle("hidden", !!shown);
  // First run (no history at all): the empty state also offers the one action that fills it (direction A).
  if (!shown && !q && homeTab !== "fav" && !recentN) {
    // Concept: one bold line, one line on what will appear here, then the one action.
    const head = document.createElement("b"); head.className = "sess-empty-title"; head.textContent = "Belum ada koneksi.";
    const sub = document.createElement("span"); sub.className = "sess-empty-sub"; sub.textContent = "PC yang pernah Anda hubungi muncul di sini, dengan gambar layar terakhirnya.";
    empty.replaceChildren(head, sub);
    const go = document.createElement("button"); go.type = "button"; go.className = "sess-empty-go"; go.textContent = "Ketik ID PC di atas";
    go.addEventListener("click", () => { if (isPhoneUi()) document.querySelector('.m-tab[data-tab="connect"]')?.click(); remoteIdInput.focus(); });
    empty.append(go);
  }
}
function renderRecent() {
  const q = sessQuery();
  const recent = [...getRecent()].filter((r) => sessMatch(r.id, q)).sort((a, b) => recentSort === "id" ? a.id.localeCompare(b.id) : b.time - a.time);
  const list = $("#recent-list");
  const thumbs = getThumbs();
  list.replaceChildren();
  for (const r of recent) list.appendChild(makeTile(r.id, formatTime(r.time), { fav: false, thumbs }));
  renderSessionsView();
  renderRecentStrip(thumbs);
  kmRefresh();
  try { presAsk(); } catch {}   // a PC new to the list gets its dot (asked again only when the list changed)
}

// ─── Beranda strip (first concept, picture 1): the four latest PCs; "Semua perangkat (n)" opens the full list ───
function renderRecentStrip(thumbs = getThumbs()) {
  const row = $("#rs-row"); if (!row) return;
  const all = [...getRecent()].sort((a, b) => b.time - a.time);
  const ids = new Set([...all.map((r) => r.id), ...getFavorites().map((f) => f.id)]);
  $("#rs-count").textContent = ids.size;
  row.replaceChildren();
  if (!all.length) {
    const e = document.createElement("p"); e.className = "rs-empty";
    e.textContent = "Belum ada koneksi. PC yang pernah Anda hubungi muncul di sini.";
    row.appendChild(e); return;
  }
  for (const r of all.slice(0, 4)) {
    const id = r.id, name = peerName(id), lanAddr = /^lan:/.test(id) ? id.slice(4) : "";
    const b = document.createElement("button"); b.type = "button"; b.className = "rs-item";
    b.title = `${t("ui_connect")} ${name ? `${name} (${lanAddr || fmtId(id)})` : lanAddr || fmtId(id)}`;
    const pic = document.createElement("span"); pic.className = "rs-thumb";
    if (thumbs[id]) { const img = new Image(); img.alt = ""; img.draggable = false; img.src = thumbs[id]; pic.appendChild(img); } else pic.innerHTML = MONITOR_SVG;
    pic.appendChild(presDot(id));
    const txt = document.createElement("span"); txt.className = "rs-text";
    const n = document.createElement("b"); n.textContent = name || lanAddr || fmtId(id);
    const sub = document.createElement("small"); sub.textContent = name ? (lanAddr || fmtId(id)) : formatTime(r.time);
    txt.append(n, sub); b.append(pic, txt);
    b.addEventListener("click", () => connectFromTile(id));
    b.addEventListener("contextmenu", (e) => { e.preventDefault(); openTileMenu(id, b, { x: e.clientX, y: e.clientY }); });
    row.appendChild(b);
  }
}
// ─── Online / offline (owner 19 Nov, concept D9bd: "status online atau offline di terakhir dihubungi atau semua
// perangkat"): a dot on each saved PC's picture, green online, grey offline. The server says which of these IDs are
// online (servers from 19 Nov; an older one never answers and no dot shows). Asked when the list changes and every
// 30 s while this window is shown; LAN PCs (by IP) have no dot. ───
const presence = new Map();   // id -> true (online) / false (offline); missing = not known
let presAskAt = 0, presAskSig = "";
function presIds() {
  const ids = new Set([...getRecent().map((r) => r.id), ...getFavorites().map((f) => f.id), ...(typeof kmGroupedIds === "function" ? kmGroupedIds() : [])]);
  return [...ids].filter((id) => /^\d{3} \d{3} \d{3}$/.test(id) && id !== myId && id !== svcId).slice(0, 60);
}
function presAsk(force = false) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !myId || document.hidden) return;
  const ids = presIds(); if (!ids.length) return;
  const sig = ids.join(",");
  if (!force && sig === presAskSig && Date.now() - presAskAt < 30000) return;
  if (Date.now() - presAskAt < 10500) { clearTimeout(presAsk.t); presAsk.t = setTimeout(() => presAsk(true), 10600 - (Date.now() - presAskAt)); return; }   // the server answers once every 10 s
  presAskAt = Date.now(); presAskSig = sig;
  sendSignalNow({ type: "presence", ids });
}
function presState(id) {
  const s = sessions.get(id);
  if (s && s.role === "viewer" && s.pc && s.everConnected) return true;   // connected to it right now
  return presence.has(id) ? presence.get(id) : null;
}
function presDot(id) {
  const i = document.createElement("i"); i.className = "pres-dot"; i.dataset.presId = id; i.setAttribute("aria-hidden", "true");
  paintPresDot(i); return i;
}
function paintPresDot(i) {
  const st = presState(i.dataset.presId);
  i.classList.toggle("on", st === true); i.classList.toggle("off", st === false);
  i.title = st === true ? trL("Online", "Online") : st === false ? trL("Offline", "Offline") : "";
}
function onPresence(msg) {
  if (!Array.isArray(msg.ids) || !Array.isArray(msg.on)) return;
  const on = new Set(msg.on);
  for (const id of msg.ids) if (typeof id === "string") presence.set(id, on.has(id));
  $$(".pres-dot[data-pres-id]").forEach(paintPresDot);
}
setInterval(() => presAsk(true), 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) presAsk(true); });

function setDevicesOpen(on) {
  document.documentElement.classList.toggle("devices-open", !!on);
  if (on) { closeTileMenu(); $("#screen-home")?.classList.remove("td-arrive"); if (!isPhoneUi()) arrive($(".hcard-sessions"), $(".dev-title")); setTimeout(() => $("#sess-search")?.focus({ preventScroll: true }), 50); }
}

// ─── Tile menu (⋮, right-click, long-press): AnyDesk's Recent Sessions menu ───
let tileMenuEl = null;
function closeTileMenu() { if (tileMenuEl) { tileMenuEl.remove(); tileMenuEl = null; } $(".tile-scrim")?.remove(); }
function openTileMenu(id, tile, { fav = false, x = 0, y = 0, alignRight = false } = {}) {
  closeTileMenu(); closeAllMenus();
  const phone = isPhoneUi();
  const starred = isFavorite(id);
  // A LAN tile ("lan:192.168.1.20") is shown and copied as its bare address.
  const lanAddr = /^lan:/.test(id) ? id.slice(4) : "";
  const items = [
    ["Hubungkan", TILE_ICON.connect, () => connectFromTile(id)],
    !phone && ["Transfer file", TILE_ICON.files, () => connectFromTile(id, { files: true })],
    [lanAddr ? "Salin alamat IP" : "Salin ID", TILE_ICON.copy, () => navigator.clipboard.writeText(lanAddr || id).then(() => showToast(lanAddr ? "Alamat IP disalin" : t("id_copied")), () => {})],
    "-",
    [starred ? t("fav_remove_tip") : t("fav_add_tip"), TILE_ICON.star, () => toggleFavorite(id)],
    ["Ganti nama", TILE_ICON.rename, () => startRename(id, tile)],
    !fav && "-",
    !fav && ["Hapus dari riwayat", TILE_ICON.remove, () => removeRecent(id), true],
  ].filter(Boolean);
  const m = document.createElement("div");
  m.className = "tile-menu"; m.setAttribute("role", "menu");
  const head = document.createElement("div"); head.className = "tile-menu-head";
  const shown = lanAddr ? `${lanAddr} · LAN` : fmtId(id);
  if (phone) {
    // Phone sheet (concept): the PC's last picture, its name, its ID, so the sheet says which PC it is about.
    head.classList.add("tile-menu-card");
    const pic = tile?.querySelector(".tile-preview")?.cloneNode(true);
    if (pic) { pic.querySelectorAll("button").forEach((b) => b.remove()); pic.classList.add("tmc-pic"); head.appendChild(pic); }
    const txt = document.createElement("div"); txt.className = "tmc-text";
    const nm = document.createElement("b"); nm.textContent = peerName(id) || shown;
    txt.appendChild(nm);
    if (peerName(id)) { const sub = document.createElement("span"); sub.textContent = shown; txt.appendChild(sub); }
    head.appendChild(txt);
    const scrim = document.createElement("div"); scrim.className = "tile-scrim";
    scrim.addEventListener("pointerdown", () => closeTileMenu());
    document.body.appendChild(scrim);
  } else head.textContent = peerName(id) ? `${peerName(id)} · ${shown}` : shown;
  m.appendChild(head);
  for (const it of items) {
    if (it === "-") { const sep = document.createElement("div"); sep.className = "tile-menu-sep"; m.appendChild(sep); continue; }
    const [label, icon, fn, danger] = it;
    const b = document.createElement("button");
    b.className = "cc-item" + (danger ? " danger" : ""); b.setAttribute("role", "menuitem");
    b.innerHTML = tileSvg(icon); b.append(document.createTextNode(label));
    b.addEventListener("click", (e) => { e.stopPropagation(); closeTileMenu(); fn(); });
    m.appendChild(b);
  }
  // Focus sits on the menu itself (no ring on a mouse open); the arrow keys walk the items from there.
  m.tabIndex = -1;
  m.addEventListener("keydown", (e) => {
    const btns = [...m.querySelectorAll("button")], i = btns.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = i < 0 ? (e.key === "ArrowDown" ? 0 : btns.length - 1) : (i + (e.key === "ArrowDown" ? 1 : btns.length - 1)) % btns.length;
      btns[next]?.focus();
    }
  });
  document.body.appendChild(m);
  tileMenuEl = m;
  if (!phone) {        // a phone shows it as a bottom sheet (mobile.css)
    const w = m.offsetWidth, h = m.offsetHeight;
    let left = alignRight ? x - w : x, top = y;
    left = Math.max(8, Math.min(left, innerWidth - w - 8));
    if (top + h > innerHeight - 8) top = Math.max(8, (alignRight ? y - 8 : y) - h);
    m.style.left = `${left}px`; m.style.top = `${top}px`;
  }
  m.focus({ preventScroll: true });
}
document.addEventListener("pointerdown", (e) => { if (tileMenuEl && !tileMenuEl.contains(e.target)) closeTileMenu(); }, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && tileMenuEl) { closeTileMenu(); } });
window.addEventListener("resize", closeTileMenu);
window.addEventListener("blur", closeTileMenu);
document.addEventListener("scroll", closeTileMenu, true);

// Inline rename on the tile itself (Enter / click away saves, Esc cancels, empty = back to the ID)
function startRename(id, tile) {
  const idEl = tile && tile.isConnected ? tile.querySelector(".tile-id") : null;
  if (!idEl) return;
  const inp = document.createElement("input");
  inp.className = "tile-rename"; inp.maxLength = 40; inp.value = peerName(id); inp.placeholder = id;
  inp.setAttribute("aria-label", "Nama untuk " + fmtId(id));
  idEl.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    if (save && inp.value.trim() !== peerName(id)) setPeerName(id, inp.value);
    else { renderFavorites(); renderRecent(); }
  };
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  inp.addEventListener("blur", () => finish(true));
  inp.addEventListener("click", (e) => e.stopPropagation());
  inp.addEventListener("pointerdown", (e) => e.stopPropagation());
}

function getFavorites() { try { return JSON.parse(store.get("favorites") || "[]"); } catch { return []; } }
function isFavorite(id) { return getFavorites().some((f) => f.id === id); }
function toggleFavorite(id) {
  let favs = getFavorites();
  const was = favs.some((f) => f.id === id);
  favs = was ? favs.filter((f) => f.id !== id) : [{ id, time: Date.now() }, ...favs].slice(0, 20);
  store.set("favorites", JSON.stringify(favs));
  pruneThumbs();
  renderFavorites(); renderRecent();
  showToast(was ? t("fav_removed") : t("fav_added"));
}
function makeStarBtn(id, tile) {
  const star = document.createElement("button");
  star.className = "fav-star" + (tile ? " tile-star" : "") + (isFavorite(id) ? " active" : "");
  star.title = isFavorite(id) ? t("fav_remove_tip") : t("fav_add_tip");
  star.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="${isFavorite(id) ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8"><path d="${STAR_PATH}"/></svg>`;
  star.addEventListener("click", (e) => { e.stopPropagation(); toggleFavorite(id); });
  return star;
}
function renderFavorites() {
  const q = sessQuery();
  const favs = getFavorites().filter((f) => sessMatch(f.id, q)).sort((a, b) => recentSort === "id" ? a.id.localeCompare(b.id) : 0);
  const list = $("#favorites-list");
  const thumbs = getThumbs();
  list.replaceChildren();
  for (const f of favs) list.appendChild(makeTile(f.id, formatTime(f.time), { fav: true, thumbs }));
  renderSessionsView();
}
function formatTime(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return t("time_now");
  if (mins < 60) return `${mins} ${t("time_min")}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${t("time_hour")}`;
  return `${Math.floor(hours / 24)} ${t("time_day")}`;
}

// ─── Connecting steps UI ──────────────────────────────────
function setConnectStep(step) {
  for (let i = 1; i <= 3; i++) {
    const el = $(`#cstep-${i}`);
    el.classList.toggle("active", i === step);
    el.classList.toggle("done", i < step);
  }
}

// ─── Hosting timer ────────────────────────────────────────
// mm:ss, or h:mm:ss once a session passes an hour.
function fmtDuration(totalSec) {
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
// "PC ini sedang dikontrol" (Arah 3, owner pick 15 Nov): the controller's name in very large type with its ID under
// it; without a name the ID itself is the large line.
function paintHostingWho(peerId, fromName) {
  const nm = stripBidi(String(fromName || "")).trim(), id = /^lan:/.test(String(peerId)) ? String(peerId).slice(4) : fmtId(String(peerId));
  const named = !!nm && nm !== "TryDesk User";
  const big = $("#hosting-name");
  // The screen's arrival animation (riseWords) puts its old text back when it ends: set the name again after it.
  if (big.dataset.rising) setTimeout(() => paintHostingWho(peerId, fromName), 900);
  big.textContent = named ? nm : id;
  $("#hosting-peer-id").textContent = named ? (/^lan:/.test(String(peerId)) ? `IP ${id}` : `ID ${id}`) : "";
  paintHostPerms();
}
// The name to show for a session's other side: the name a guest sent, else the saved name, else the ID / address.
function sessName(sess) {
  if (!sess) return "";
  const pid = String(sess.peerId || ""), id = /^lan:/.test(pid) ? pid.slice(4) : fmtId(pid);
  if (sess.role === "host" || sess.mirror) { const nm = stripBidi(String(sess.fromName || "")).trim(); if (nm && nm !== "TryDesk User") return nm; }
  return peerName(pid) || id;
}
function startHostingTimer() {
  stopHostingTimer();               // (stop first, it clears the start time)
  hostingStartTime = Date.now();
  hostingTimerHandle = setInterval(() => {
    const el = $("#hosting-timer");
    if (el && hostingStartTime) el.textContent = fmtDuration(Math.floor((Date.now() - hostingStartTime) / 1000));
  }, 1000);
}
function stopHostingTimer() {
  if (hostingTimerHandle) { clearInterval(hostingTimerHandle); hostingTimerHandle = null; }
  hostingStartTime = null;
  const el = $("#hosting-timer");
  if (el) el.textContent = "00:00";
}

// ─── Windows service: one ID, as with AnyDesk ─────────────
// While the TryDesk service runs on this PC, its host (SYSTEM) answers for the PC under the ID this app had: the
// app shows that ID, refuses requests itself, and signs in with a second ID kept only to control other PCs.
let svcId = null;   // the service's ID while it runs ("" = running, ID not known yet); null = no service
let svcPwFp = "", myPwFp = { hash: null, fp: "" };   // which access password the service really uses (svcPwState)
const idKeys = () => (svcId !== null ? { id: "viewerId", token: "viewerToken" } : { id: "myId", token: "myToken" });
const shownId = () => (svcId !== null ? svcId : myId);
// While the service runs, this window signs in with a second ID of its own (above). It tells the server which
// service it belongs to, so the server's operator can count one PC instead of two. Information only: the server
// never routes, pairs or allows anything by it. svcProof shows the window really holds that ID's owner token (the
// service took this PC's ID and token over, see main.js identity.json); without it (after "Buat ID baru" the service
// has a token this window never saw) only svc is sent.
const _sha256hex = async (s) => _hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s))));
async function svcLinkInfo() {
  if (svcId === null || !/^\d{3} \d{3} \d{3}$/.test(svcId)) return {};
  const out = { svc: svcId }, tok = store.get("myToken");
  if (store.get("myId") === svcId && typeof tok === "string" && tok.length >= 16) {
    try { out.svcProof = await _sha256hex("trydesk-pc:" + await _sha256hex(tok)); } catch {}
  }
  return out;
}
let _svcLinkSent = null;   // the svcId the current sign-in told the server
// The link goes out only when signing in. The service's ID is usually known a little after it starts ("" until
// then) and changes after "Buat ID baru": sign in once more, but never in the middle of a session or a request.
function svcLinkResync() {
  if (svcId === null || svcId === _svcLinkSent || !/^\d{3} \d{3} \d{3}$/.test(svcId)) return;
  if (!ws || ws.readyState !== WebSocket.OPEN || viewerSessions().length || host || acceptPending || pendingChallenge) return;
  connectSignaling();
}
let _svcLook = null;   // the service's installed/state/password fingerprint at the last check
let _svcInstalled = false;   // the service is installed (running or not)
let _svcSupported = false;   // this TryDesk can install the service (Windows, a real build with trydesk-service.exe)
async function refreshServiceState() {
  if (!window.electronAPI.serviceStatus || window.TD_MOBILE || viewerOnlyDesktop()) return;
  let s = null; try { s = await window.electronAPI.serviceStatus(); } catch {}
  _svcInstalled = !!(s && s.installed);
  _svcSupported = !!(s && s.supported);
  // (still starting counts as running: right after an update reinstalled it, this app opens before the service is
  // up, and its own second ID showed on Home for a moment, Threads report 18 Nov)
  const digits = s && s.installed && (s.state === "RUNNING" || s.state === "START_PENDING") ? String(s.id || "") : null;
  const next = digits === null ? null : /^\d{9}$/.test(digits) ? digits.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3") : "";
  // The service started late (TryDesk opened from the tray while it was still starting), was stopped, removed or
  // reinstalled outside TryDesk: Settings and Home ("Cek layanan") followed only after a restart of TryDesk.
  const look = s ? `${!!s.installed}|${s.state || ""}|${s.pwFp || ""}` : "";
  if (look !== _svcLook) { const first = _svcLook === null; _svcLook = look; if (!first && typeof refreshServiceUI === "function") refreshServiceUI(); }
  if (next === svcId) { svcLinkResync(); return; }   // (a resync put off by a session is tried again here)
  const switched = (next === null) !== (svcId === null);
  svcId = next;
  myIdText.textContent = shownId() ? fmtId(shownId()) : "…";
  try { window.electronAPI.setTrayInfo?.({ id: shownId() ? fmtId(shownId()) : "" }); } catch {}
  { const el = $("#set-my-id"); if (el) el.textContent = shownId() ? fmtId(shownId()) : "-"; }
  // The service's host darkens this screen now, so it needs the panic key (Ctrl+Alt+Shift+Esc), not this app.
  if (switched) { try { window.electronAPI.panicKeyYield?.(svcId !== null); } catch {} }
  if (switched && ws) connectSignaling();   // the other identity
  else svcLinkResync();                     // same identity, the service's ID became known or changed
}
setInterval(() => { if (!(config && config.serviceHost)) refreshServiceState(); }, 30000);

// ─── Signaling ────────────────────────────────────────────
function connectSignaling() {
  clearTimeout(reconnectTimer);
  if (ws) { ws.onclose = null; ws.close(); }
  setStatus("", t("connecting_server"));
  try { ws = new WebSocket(serverUrl); }
  catch { setStatus("error", "Alamat server tidak valid"); return; }

  // app = version + platform + OS release, told to the server when signing in (the server checks it against the
  // connection). The Android app has no osRelease; its User-Agent already names the Android version and model.
  // live = peers this process still has a session with. A fresh start (Run as administrator, a crash, Quit and
  // reopen) sends none, so the server drops pairings the old process left behind instead of keeping them for good.
  // Built when the socket opens, not before: svcId may change while it is still connecting.
  const sock = ws;
  sock.onopen = async () => {
    const linkFor = svcId;   // what this sign-in will name (svcId may change while the proof is worked out)
    // ice: 1 = this app takes fresh TURN logins ("ice-servers"), so the server may give it short-lived ones
    const app = { v: (config && config.appVersion) || "", p: platformName(), lang, ice: 1, ...(config && config.osRelease ? { os: String(config.osRelease).slice(0, 60) } : {}), ...(await svcLinkInfo()) };
    if (ws !== sock || sock.readyState !== WebSocket.OPEN) return;   // replaced or closed meanwhile
    const live = [...viewerSessions(), ...(host ? [host] : [])].filter((s) => s.pc && !isLanId(s.peerId)).map((s) => s.peerId);
    _svcLinkSent = app.svc ? linkFor : null;   // a newer svcId than the one sent gets its own resync
    // hostedBy: the viewer controlling this PC, so the server can count the session again after it restarted (it
    // pairs the two only when that viewer lists this PC too). An older server ignores it.
    const hostedBy = host && host.pc && !isLanId(host.peerId) ? host.peerId : undefined;
    sock.send(JSON.stringify({ type: "register", id: store.get(idKeys().id), token: store.get(idKeys().token), app, live, hostedBy }));
  };
  ws.onmessage = (event) => { let msg; try { msg = JSON.parse(event.data); } catch { return; } onSignal(msg); };
  ws.onclose = () => {
    myId = null; myIdText.textContent = "Offline";
    try { window.electronAPI.setTrayInfo?.({ id: "" }); } catch {}
    setStatus("error", "Terputus dari server, mencoba lagi...");
    reconnectTimer = setTimeout(connectSignaling, 3000);
  };
}
// Desktop builds other than Windows (Linux, macOS) only control other PCs; the phone app has its own layer.
function viewerOnlyDesktop() { return !window.TD_MOBILE && !!config && !!config.platform && config.platform !== "win32"; }
function isMacViewer() { return !window.TD_MOBILE && !!config && config.platform === "darwin"; }
const MAC_CMD = new Set([91, 93, 224]), MODIFIER_VKS = new Set([16, 17, 18, 91, 92, 93, 224]);
function platformName() { return window.TD_MOBILE ? "android" : config && config.platform === "linux" ? "linux" : config && config.platform === "darwin" ? "macos" : "windows"; }
function sendSignal(data) {
  // A signed session keeps its offer/answer and ICE candidates in order. Signing waits for the key, so candidates
  // used to overtake the SDP: harmless on the first connect (the receiver keeps them until the offer is there), but
  // on an ICE restart the receiver already has a description and dropped candidates of the new round, so the
  // restart could not succeed (LAN: host candidates only).
  if (data && (data.type === "offer" || data.type === "answer" || data.type === "ice-candidate")) {
    const s = sessionFor(data.targetId);
    if (s && s.lanKey) { s._sigQ = (s._sigQ || Promise.resolve()).then(() => sendSignalNow(data)).catch(() => {}); return; }
  }
  sendSignalNow(data);
}
function sendSignalNow(data) {
  if (data && isLanId(data.targetId)) return lanSignal(data);
  // Offers and answers of a password session are signed with the password key, on the ID path as on the LAN path:
  // the server only relays them, so a server that swapped the SDP (and with it the encryption fingerprint) would be
  // caught by the other side.
  const s = data && (data.type === "offer" || data.type === "answer") ? sessionFor(data.targetId) : null;
  if (s && s.lanKey) return lanMac(s.lanKey, data.type, data.offer || data.answer).then((mac) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...data, mac })); });
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
// A password session: the SDP must carry a valid signature. Without a key (manual Accept) nothing can be checked.
// The viewer can't tell whether its password was right: the host's owner may have clicked Accept for a wrong or
// empty one, and such a host has no key to sign with. So on the ID path an UNSIGNED answer is taken as that plain
// session; a signed one must be right. The host always insists on a signed offer once the password was proven
// (every TryDesk the server still lets in, 1.3.3+, signs it), which is what stops a taken-over server from sitting
// between the two: it can't sign an offer of its own. (1.3.3 relaxed this when the server didn't announce sdpMac,
// which a taken-over server could simply leave out.)
let serverSdpMac = false;   // kept for the log only: what the server says no longer changes any check
async function sdpMacOk(s, kind, desc, mac) {
  if (!s || !s.lanKey) return true;
  if (mac === undefined && kind === "answer" && s.role === "viewer" && !isLanId(s.peerId)) {
    // A session whose answers were signed (the password was proven) never takes an unsigned one later: on a codec
    // change or a reconnect a taken-over server could otherwise slip its own in (audit 19 Nov).
    if (s.answerSigned) { sessLog(s, "unsigned answer after signed ones: refused"); return false; }
    sessLog(s, "answer unsigned: the host let this session in without the password");
    // Say it (audit 19 Nov, TD-VULN-04c): the person there clicked Terima, so the typed password proved nothing, and
    // this session can't be checked against it. Normal when the password was wrong; a surprise is a reason to hang up.
    // (named, since Kelola may open several PCs at once)
    if (!s.unverifiedSaid) { s.unverifiedSaid = true; showToast(`${peerName(s.peerId) || fmtId(s.peerId)} · ` + trL("PC itu menerima Anda lewat tombol Terima, bukan dengan password yang Anda ketik. Kalau Anda tidak menyangkanya, putuskan sesi ini.", "That PC let you in with its Accept button, not with the password you typed. If you didn't expect this, end the session."), "info"); }
    return true;
  }
  const ok = typeof desc === "object" && !!desc && _constEq(String(mac || "").slice(0, 128), await lanMac(s.lanKey, kind, desc));
  if (ok && kind === "answer" && s.role === "viewer") s.answerSigned = true;
  return ok;
}

// ─── LAN direct connection ("Sambung lewat IP") ───────────
// Two PCs on one network start a session without the signaling server (an office or a warnet PC with no internet,
// like AnyDesk's "direct connection"). main.js (or the phone's TdLan plugin) only carries JSON lines over TCP; this
// part speaks the same messages the server relays, so the rest of the app can't tell the difference. Peer ids:
//   "lan:<address>"    , a PC this one asks (viewer tab), address = what the user typed ("192.168.1.20[:7171]")
//   "lan-in:<ip>#<n>"  , a PC asking this one (host side), one id per socket
// Rules that the server enforces elsewhere are enforced here instead: the host refuses any LAN request unless an
// access password is set, only a correct password gets in (no Accept-dialog fallback for strangers on the network),
// and the offer/answer carry an HMAC under the password key, so someone else on the network can't swap the
// session's DTLS fingerprint (the TCP line itself is not encrypted).
const isLanId = (id) => typeof id === "string" && (id.startsWith("lan:") || id.startsWith("lan-in:"));
const lanIn = (id) => typeof id === "string" && id.startsWith("lan-in:");
// Recognise an IP / IP:port / [IPv6]:port / host name typed in the ID box. A 9-digit ID never matches (no dot/colon).
function parseLanTarget(text) {
  const a = String(text || "").trim().replace(/^lan:/, "");
  if (/^\d{3} ?\d{3} ?\d{3}$/.test(a)) return null;
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d{1,5})?$/.test(a) && a.split(":")[0].split(".").every((n) => Number(n) <= 255)) return a;
  if (/^\[[0-9a-f:.%a-z]+\](:\d{1,5})?$/i.test(a)) return a.toLowerCase();
  if (/^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}(%[\w.-]+)?$/i.test(a)) return a.toLowerCase();   // bare IPv6 (fe80::1)
  if (/^[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9-]{1,63})*(:\d{1,5})?$/i.test(a) && /[a-z]/i.test(a.split(":")[0])) return a.toLowerCase();   // a LAN PC name
  return null;
}
const lanLinks = new Map();   // viewer side: "lan:<addr>" -> { ready, queue, paired, machine }
let lanHostOn = false;
// One random value per install, sent in the host's hello: a viewer that sees its own value is talking to itself.
function lanMachine() {
  let m = store.get("lanMachine");
  if (!m) { m = _hex(crypto.getRandomValues(new Uint8Array(12)).buffer); store.set("lanMachine", m); }
  return m;
}
async function lanMac(keyHex, kind, desc) {
  if (!keyHex || !desc || typeof desc.sdp !== "string") return "";
  return _hmacHex(_hexToBytes(keyHex), `trydesk-lan|${kind}|${desc.type}|${desc.sdp}`);
}
async function lanSignal(data) {
  const id = data.targetId;
  // Through JSON: RTCSessionDescription / RTCIceCandidate can't cross the IPC bridge as objects (toJSON flattens them).
  const out = JSON.parse(JSON.stringify(data)); delete out.targetId;
  // Offers and answers are signed with the password key (see above).
  const s = sessionFor(id);
  if ((out.type === "offer" || out.type === "answer") && s && s.lanKey) out.mac = await lanMac(s.lanKey, out.type, out.offer || out.answer);
  if (lanIn(id)) {
    window.electronAPI.lanWrite(id, out);
    // A refusal or a hang-up ends that socket; the requester opens a new one to try again.
    if (out.type === "connection-rejected" || out.type === "disconnect") window.electronAPI.lanClose(id);
    return;
  }
  let link = lanLinks.get(id);
  if (out.type === "connect-request") {
    if (link) { window.electronAPI.lanClose(id); lanLinks.delete(id); }
    link = { ready: false, queue: [out], paired: false };
    lanLinks.set(id, link);
    const r = await window.electronAPI.lanOpen(id.slice(4)).catch(() => null);
    if (lanLinks.get(id) !== link) return;
    if (!r || !r.ok) { lanLinks.delete(id); onSignal({ type: "error", targetId: id, message: (r && r.error) || "Tidak bisa terhubung ke alamat ini" }); return; }
    // The host speaks first (lan-hello); the queued request goes out once it did, or the attempt fails.
    link.helloTimer = setTimeout(() => { if (lanLinks.get(id) === link && !link.ready) { lanDrop(id); onSignal({ type: "error", targetId: id, message: "Alamat ini bukan PC TryDesk" }); } }, 5000);
    return;
  }
  if (!link) return;
  if (link.ready) window.electronAPI.lanWrite(id, out); else link.queue.push(out);
  if (out.type === "disconnect" || out.type === "cancel-request") lanDrop(id);
}
function lanDrop(id) {
  const link = lanLinks.get(id);
  if (link) clearTimeout(link.helloTimer);
  lanLinks.delete(id);
  window.electronAPI.lanClose(id);
}
// Only the fields each message needs, as the server would relay them; anything else on the line is ignored.
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const desc = (d) => (d && typeof d === "object" && typeof d.sdp === "string" && /^(offer|answer)$/.test(d.type) && d.sdp.length < 60000 ? { type: d.type, sdp: d.sdp } : null);
const cand = (c) => (c && typeof c === "object" && typeof c.candidate === "string" ? { candidate: c.candidate.slice(0, 1000), sdpMid: c.sdpMid == null ? null : str(c.sdpMid, 32), sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null } : null);
async function onLanEvent(ev) {
  if (!ev || !isLanId(ev.id)) return;
  const id = ev.id, m = ev.msg || {};
  if (lanIn(id)) {
    if (ev.kind === "close") { lanRequested.delete(id); onSignal({ type: "request-cancelled", fromId: id }); onSignal({ type: "peer-disconnected", fromId: id }); return; }
    if (ev.kind !== "line") return;
    switch (m.type) {
      case "connect-request":
        // A second request on a socket that already has one is ignored (the server allows one per pair too).
        if (lanRequested.has(id)) return;
        lanRequested.add(id);
        return onSignal({ type: "incoming-connection", fromId: id, fromName: str(m.fromName, 64) || "TryDesk User" });
      case "cancel-request": return onSignal({ type: "request-cancelled", fromId: id });
      case "connection-response": return onSignal({ type: "connection-response", fromId: id, response: str(m.response, 128) });
      case "offer": {
        const d = desc(m.offer);
        if (!d || !host || host.peerId !== id || !host.lanKey) return;
        if (!_constEq(str(m.mac, 128), await lanMac(host.lanKey, "offer", d))) { sessLog(host, "LAN offer with a bad signature ignored"); return; }
        // The signature goes along: onSignal checks every signed session's SDP again (a missing one is refused there).
        return onSignal({ type: "offer", fromId: id, offer: d, mac: str(m.mac, 128) });
      }
      case "ice-candidate": { const c = cand(m.candidate); if (c && host && host.peerId === id) onSignal({ type: "ice-candidate", fromId: id, candidate: c }); return; }
      case "disconnect": return onSignal({ type: "peer-disconnected", fromId: id, ...(m.bye ? { bye: true, reason: str(m.reason, 120) } : {}) });
    }
    return;
  }
  const link = lanLinks.get(id);
  if (!link) return;
  if (ev.kind === "close") {
    lanDrop(id);
    if (link.paired) onSignal({ type: "peer-disconnected", fromId: id });
    else onSignal({ type: "error", targetId: id, message: link.ready ? "Koneksi ke PC tujuan terputus" : "Alamat ini bukan PC TryDesk" });
    return;
  }
  if (ev.kind !== "line") return;
  if (!link.ready) {
    if (m.type !== "lan-hello") return;
    clearTimeout(link.helloTimer);
    if (str(m.machine, 64) && str(m.machine, 64) === lanMachine()) { lanDrop(id); onSignal({ type: "error", targetId: id, message: "Tidak bisa me-remote PC Anda sendiri" }); return; }
    link.ready = true;
    for (const q of link.queue.splice(0)) window.electronAPI.lanWrite(id, q);
    return;
  }
  switch (m.type) {
    case "connection-challenge": return onSignal({ type: "connection-challenge", fromId: id, salt: str(m.salt, 64), nonce: str(m.nonce, 128) });
    case "connection-accepted": link.paired = true; return onSignal({ type: "connection-accepted", fromId: id });
    case "connection-rejected": lanDrop(id); return onSignal({ type: "connection-rejected", fromId: id, reason: str(m.reason, 160) });
    case "answer": {
      const d = desc(m.answer), s = sessions.get(id);
      if (!d || !s || !s.lanKey) return;
      if (!_constEq(str(m.mac, 128), await lanMac(s.lanKey, "answer", d))) { sessLog(s, "LAN answer with a bad signature ignored"); return; }
      return onSignal({ type: "answer", fromId: id, answer: d, mac: str(m.mac, 128) });
    }
    case "ice-candidate": { const c = cand(m.candidate); if (c) onSignal({ type: "ice-candidate", fromId: id, candidate: c }); return; }
    case "disconnect": lanDrop(id); return onSignal({ type: "peer-disconnected", fromId: id, ...(m.bye ? { bye: true, reason: str(m.reason, 120) } : {}) });
  }
}
const lanRequested = new Set();
try { window.electronAPI.onLanEvent((ev) => { onLanEvent(ev).catch((e) => console.warn("lan event", e)); }); } catch {}
// Settings → Koneksi → "Izinkan koneksi langsung dari LAN". Shows the addresses others type to reach this PC.
let lanAddrsNow = [];
// The LAN line itself is not encrypted, so someone recording the network could try passwords offline against what
// they captured. A short password falls quickly; connecting by IP therefore needs one of at least LAN_PW_MIN
// characters. Only the length class is kept (accessPwLan), set when the password is saved.
const LAN_PW_MIN = 10;
const lanPwStrong = () => !!store.get("accessPasswordHash") && store.get("accessPwLan") === "1";
// The "Desktop Ini" card: whether an access password is set, and the address(es) others type to connect by IP.
function renderHomeFacts() {
  const box = $("#home-facts"); if (!box) return;
  const hostable = !viewerOnlyDesktop() && !window.TD_MOBILE;
  box.classList.toggle("hidden", !hostable);
  if (!hostable) return;
  const pw = !!store.get("accessPasswordHash");
  const pv = $("#fact-pw-val");
  // The Windows service answers for this PC: when it does not hold this password, Home says so (Settings explains).
  const sv = pw ? svcPwState() : null, svcOff = sv === "none" || sv === "old";
  pv.textContent = !pw ? "Belum diatur" : svcOff ? "Cek layanan" : "Aktif";
  pv.classList.toggle("on", pw && !svcOff); pv.classList.toggle("warn", svcOff);
  pv.title = svcOff ? "Layanan Windows belum memakai password ini" : "";
  $("#fact-pw-btn").textContent = pw ? "Ubah" : "Atur";
  const lv = $("#fact-lan-val"), lb = $("#fact-lan-btn");
  // LAN on but no (long enough) password: every LAN request is refused, so say that instead of showing an address.
  const needPw = lanHostOn && !lanPwStrong();
  const addr = lanHostOn && !needPw ? (lanAddrsNow[0] || "") : "";
  // (short, so it fits the card at the 700 px minimum window; the hover text says it in full)
  lv.textContent = !lanHostOn ? "Nonaktif" : needPw ? `Password min. ${LAN_PW_MIN}` : addr || "Tidak ada jaringan";
  lv.title = needPw ? `Butuh password ${LAN_PW_MIN}+ karakter` : lanAddrsNow.join(", ");
  lv.classList.toggle("addr", !!addr);
  lv.classList.toggle("warn", needPw);
  lb.textContent = addr ? "Salin" : lanHostOn ? "Atur" : "Aktifkan";
  lb.dataset.go = needPw ? "pw" : "";
  setTimeout(() => { try { fitHomeText(); } catch {} }, 0);   // after the text observer has put them in the language
}
// Open Settings on one tab and bring one setting into view.
function openSettingsAt(tabId, selector) {
  if (overlaySettings.classList.contains("hidden")) toggleSettings();
  $(`.stab[data-tab="${tabId}"]`)?.click();
  const target = selector && $(selector);
  if (target?.closest(".adv-body") && !settingsAdvOpen) { settingsAdvOpen = true; paintSettingsAdv(); }
  const el = target?.closest(".srow, .s-qlist, .sgrp, .lk");
  if (el) setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
}
// "Cara pakai" Sambung lewat IP (Arah 2, 15 Nov): four steps, one per screen, plus the problem list ("Gagal
// tersambung?"). The overlay's data-step and .lh-fixmode pick what CSS shows; the buttons below are relabelled here.
let lanHelpStep = 0, lanHelpFix = false;
function paintLanHelp() {
  const ov = $("#overlay-lan-help"), last = lanHelpStep === 3;
  ov.dataset.step = String(lanHelpStep);
  ov.classList.toggle("lh-fixmode", lanHelpFix);
  const can = !viewerOnlyDesktop() && !window.TD_MOBILE && $("#overlay-settings").classList.contains("hidden");   // already in Settings: no "open settings" button
  $("#btn-lan-help-settings").classList.toggle("hidden", !can || lanHelpFix || lanHelpStep !== 0);
  $("#btn-lan-help-prev").classList.toggle("hidden", !lanHelpFix && lanHelpStep === 0);
  $("#btn-lan-help-prev").textContent = lanHelpFix && !window.TD_MOBILE ? "Kembali ke langkah" : "Kembali";
  $("#btn-lan-help-next").classList.toggle("hidden", lanHelpFix || last);
  $("#btn-lan-help-ok").classList.toggle("hidden", !lanHelpFix && !last);
  $("#btn-lan-help-ok span").textContent = lanHelpFix ? "Mengerti" : "Selesai";
  $("#lan-help-title").textContent = lanHelpFix && window.TD_MOBILE ? "Kalau gagal tersambung" : "Sambung lewat IP";
  $("#overlay-lan-help .help-body").scrollTop = 0;
  const focus = lanHelpFix || last ? $("#btn-lan-help-ok") : $("#btn-lan-help-next");
  focus.focus({ preventScroll: true });
}
let lanHelpOpener = null;
function openLanHelp() {
  lanHelpStep = 0; lanHelpFix = false;
  lanHelpOpener = document.activeElement;
  $("#overlay-lan-help").classList.remove("hidden");
  paintLanHelp();
}
function closeLanHelp() {
  const ov = $("#overlay-lan-help"); if (ov.classList.contains("hidden")) return;
  ov.classList.add("hidden");
  if (lanHelpOpener?.isConnected && lanHelpOpener.offsetParent) lanHelpOpener.focus({ preventScroll: true });   // back where the user was
  lanHelpOpener = null;
}
const lanHelpGo = (step, fix = false) => { lanHelpStep = Math.max(0, Math.min(3, step)); lanHelpFix = fix; paintLanHelp(); };
// One step back: the problem list → the steps, a step → the one before, the first step → closed (Esc keeps closing).
function lanHelpBack() { if (lanHelpFix) lanHelpGo(lanHelpStep); else if (lanHelpStep > 0) lanHelpGo(lanHelpStep - 1); else closeLanHelp(); }
$("#fact-pw-btn").addEventListener("click", () => openSettingsAt("tab-security", "#access-password"));
$("#fact-lan-btn").addEventListener("click", () => {
  const addr = lanHostOn && lanPwStrong() && lanAddrsNow[0];
  if (addr) navigator.clipboard.writeText(addr).then(() => showToast("Alamat IP disalin"), () => {});
  else if ($("#fact-lan-btn").dataset.go === "pw") openSettingsAt("tab-security", "#access-password");
  else openSettingsAt("tab-connection", "#setting-lan");
});
for (const id of ["#btn-lan-help", "#btn-lan-help-2"]) $(id).addEventListener("click", openLanHelp);
$("#btn-lan-help-close").addEventListener("click", closeLanHelp);
$("#btn-lan-help-ok").addEventListener("click", closeLanHelp);
$("#btn-lan-help-next").addEventListener("click", () => lanHelpGo(lanHelpStep + 1));
$("#btn-lan-help-prev").addEventListener("click", () => (lanHelpFix ? lanHelpGo(lanHelpStep) : lanHelpGo(lanHelpStep - 1)));
for (const id of ["#btn-lan-help-fix", "#btn-lan-help-fix-2"]) $(id).addEventListener("click", () => lanHelpGo(lanHelpStep, true));
$("#btn-lan-help-back").addEventListener("click", () => lanHelpGo(lanHelpStep));
$("#btn-lan-help-settings").addEventListener("click", () => { closeLanHelp(); openSettingsAt("tab-connection", "#setting-lan"); });
$("#overlay-lan-help").addEventListener("click", (e) => { if (e.target.id === "overlay-lan-help") closeLanHelp(); });
document.addEventListener("keydown", (e) => {
  if ($("#overlay-lan-help").classList.contains("hidden")) return;
  if (e.key === "Escape") return closeLanHelp();
  // Arrows turn the page only when the help itself has focus and no modifier is held (never inside a text field).
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !e.target.closest?.("#overlay-lan-help") || e.target.matches("input, textarea, select, [contenteditable]")) return;
  if (!lanHelpFix && e.key === "ArrowRight" && lanHelpStep < 3) { e.preventDefault(); lanHelpGo(lanHelpStep + 1); }
  else if (!lanHelpFix && e.key === "ArrowLeft" && lanHelpStep > 0) { e.preventDefault(); lanHelpGo(lanHelpStep - 1); }
});
async function applyLanHost(on, boot) {
  const note = $("#setting-lan-addr");
  if (!window.electronAPI.lanHost || viewerOnlyDesktop() || window.TD_MOBILE) { lanHostOn = false; return; }
  const r = await window.electronAPI.lanHost({ on, machine: lanMachine() }).catch(() => null);
  lanHostOn = !!(r && r.ok && r.on);
  lanAddrsNow = lanHostOn ? (r.addrs || []) : [];
  renderHomeFacts();
  if (on && (!r || !r.ok)) { if (!boot) showToast((r && r.error) || "Tidak bisa membuka port LAN"); const cb = $("#setting-lan"); if (cb && !boot) { cb.checked = false; prefSet("lanDirect", false); } }
  if (on && lanHostOn && !lanPwStrong() && !boot) showToast(`Koneksi LAN hanya bisa dipakai dengan password akses minimal ${LAN_PW_MIN} karakter (Pengaturan → Keamanan)`);
  if (note) {
    const addrs = lanHostOn ? (r.addrs || []) : [];
    note.textContent = !lanHostOn ? "" : addrs.length ? `Alamat PC ini: ${addrs.join(", ")}` : "PC ini belum tersambung ke jaringan lokal";
    note.classList.toggle("hidden", !lanHostOn);
  }
}

async function onSignal(msg) {
  switch (msg.type) {
    case "registered": {
      myId = msg.clientId;
      // The ID and owner token are written down only when this PC had none yet, asked for a new ID itself, or got
      // its own ID back. A server that answered with some other ID (its records lost, or a server that is not
      // ours any more) gets it used for this run only: it can't rewrite who this PC is for good.
      const hadToken = !!store.get(idKeys().token), sameId = store.get(idKeys().id) === msg.clientId;
      const keep = !hadToken || _regenPending || sameId;
      if (keep) { store.set(idKeys().id, msg.clientId); store.set(idKeys().token, msg.token); }
      else { try { window.electronAPI.logInfo("server handed out a different ID; not saved (stored ID kept)"); } catch {} }
      // The service's host takes this ID over when it is installed (identity.json, see main.js). Never a NEW ID while
      // the service is installed but not running: the service already has this PC's ID, and taking this one over
      // changed the PC's ID for good (Threads report 18 Nov, 1.3.8 -> 1.3.9; proven with scratch idrepro).
      if (keep && svcId === null && !(config && config.serviceHost) && !(_svcInstalled && !hadToken)) { try { window.electronAPI.exportIdentity(msg.clientId, msg.token); } catch {} }
      // The service's host notes when it first got an ID of its own (see adopt below).
      if (keep && !hadToken && config && config.serviceHost && !store.get("svcOwnIdAt")) store.set("svcOwnIdAt", String(Date.now()));
      // The service's host has no window: its ID goes to the log (%ProgramData%\TryDesk\service-host), which is
      // what an administrator reads it from until the app shows it.
      if (config && config.serviceHost) { try { window.electronAPI.logInfo("service host id " + msg.clientId + (config.servicePwHash ? " (password set)" : " (no password: requests ask for Accept)")); window.electronAPI.setServiceId(msg.clientId); } catch {} }
      serverIceServers = safeServerIce(msg.iceServers);
      serverIceAt = Date.now();
      serverSdpMac = msg.sdpMac === true;
      setTimeout(() => presAsk(true), 600);   // the saved PCs' online dots (after a reconnect too)
      myIdText.textContent = fmtId(shownId());
      try { window.electronAPI.setTrayInfo?.({ id: fmtId(shownId()) }); } catch {}
      setStatus("connected", "Online, siap menerima koneksi");
      if (_regenPending) { _regenPending = false; showToast(t("id_regenerated") + ": " + fmtId(myId)); }
      break;
    }
    case "ice-servers":   // fresh TURN logins (hourly, or after an ice-refresh)
      { const ice = safeServerIce(msg.iceServers); if (ice.length) { serverIceServers = ice; serverIceAt = Date.now(); iceRenewRunning(); } }
      break;
    case "presence": onPresence(msg); break;   // which saved PCs are online (servers from 19 Nov)
    case "incoming-connection": if (!isLanId(msg.fromId)) iceFresh(); handleIncoming(msg); break;
    case "request-cancelled": {
      // The requester gave up (Cancel / went offline) while we were still asking. Close the accept dialog or
      // drop the password challenge, accepting a dead request left the host capturing and "busy" for good.
      if (acceptFromId === msg.fromId && acceptDlgCancel) acceptDlgCancel();
      if (pendingChallenge && pendingChallenge.fromId === msg.fromId) { clearTimeout(pendingChallenge._t); pendingChallenge = null; }
      // Cancelled after we accepted but while capture was still starting: the server already dropped the request, so
      // our answer would never arrive. Stop now instead of showing "being controlled" and staying busy for 30 s.
      if (host && host.peerId === msg.fromId && !host.everConnected) closeSession(host, false);
      break;
    }
    case "connection-challenge": {
      // Host requires an access password. Prove we know it via HMAC over the host's nonce, the password itself
      // never travels. First round: the typed password, else an "empty" answer (the host
      // then shows its owner the Accept dialog). Another round means the host is still asking (no password, or
      // a wrong one) while its owner sees Accept: let the user type it here, whichever comes first wins.
      const s = sessions.get(msg.fromId);
      if (!s || s.role !== "viewer" || s.pc) return;
      // The host answered, it is now up to its owner (30 s dialog) or to the password; our own "no response"
      // timeout must not close the tab while the user is typing the password.
      clearTimeout(s.requestTimer);
      const salt = String(msg.salt || ""), nonce = String(msg.nonce || "");
      s.pwSalt = salt;
      s.pwRound = (s.pwRound || 0) + 1;
      try {
        let key = null, how = "empty";
        if (s.pendingPassword) { key = await deriveKeyHex(s.pendingPassword, salt); how = "typed"; s.lanKey = key; }
        s.pendingPassword = "";   // one-shot; don't keep the secret around
        // a PC opened from Kelola banyak perangkat says it on its picture (no prompt, no toast per PC)
        // (once the user opened that tab it is an ordinary one: the password box shows)
        if (!key && s.pwRound > 1 && s.bulk && s !== active) { s.savedPassword = ""; kmNote(s.peerId, s.pwLast === "typed" ? "failPw" : "failNeedPw"); return; }
        if (!key && s.pwRound > 1) { showPwPrompt(s, nonce, s.pwLast); return; }
        s.pwLast = how;
        const response = key ? await answerWithKey(key, nonce) : await answerChallenge("", salt, nonce);
        sendSignal({ type: "connection-response", targetId: msg.fromId, response });
      } catch { sendSignal({ type: "connection-response", targetId: msg.fromId, response: "" }); }
      break;
    }
    case "connection-response": { await handleChallengeResponse(msg); break; }
    case "connection-accepted": {
      const s = sessions.get(msg.fromId);
      if (s) sessLog(s, "accepted by the remote PC");
      if (s && s.role === "viewer" && !s.pc) {
        s.pwPrompt = null; renderPwPrompt();
        if (s === active) setConnectStep(3);
        startViewer(s);
      }
      break;
    }
    case "connection-rejected": {
      const s = sessions.get(msg.fromId);
      if (!s) return;
      // The reason comes from the other side, so only TryDesk's own texts are shown (see knownPeerText).
      const reason = knownPeerText(msg.reason, "Koneksi ditolak");
      sessLog(s, "rejected: " + reason.slice(0, 80));
      const fg = s === active && !s.isReconnect;
      closeSession(s, false);
      if (s.bulk && !fg) { kmNote(s.peerId, reason === "Tidak ada jawaban dari pemilik PC" ? "failNoans" : "failDeny"); break; }
      if (!s.isReconnect) playEvent("denied");
      if (!(fg && showFailView(s.peerId, reason === "Tidak ada jawaban dari pemilik PC" ? "noanswer" : reason === "Koneksi ditolak" ? "rejected" : ""))) showToast(reason);
      reconnectFailed(s, reason);
      break;
    }
    case "offer":
      if (host && msg.fromId === host.peerId) {
        if (!(await sdpMacOk(host, "offer", msg.offer, msg.mac))) { sessLog(host, "offer with a bad or missing signature ignored"); break; }
        await onOffer(host, msg.offer);
      }
      break;
    case "answer": {
      const s = sessions.get(msg.fromId);
      if (s && s.pc) {
        if (!(await sdpMacOk(s, "answer", msg.answer, msg.mac))) { sessLog(s, "answer with a bad or missing signature ignored"); break; }
        // An answer to an offer already taken back (negotiate) has nothing to apply to.
        if (s.pc.signalingState !== "have-local-offer") { sessLog(s, "late answer ignored"); break; }
        try { await s.pc.setRemoteDescription(msg.answer); } catch (e) { sessLog(s, "answer not applied: " + (e && e.message)); break; }
        flushCandidates(s);
        // An offer asked for while this one was on its way goes now (negotiate).
        if (s._negAgain && s.pc.signalingState === "stable") { s._negAgain = false; clearTimeout(s._negTimer); negotiate(s).catch(() => {}); }
      }
      break;
    }
    case "ice-candidate": {
      if (!msg.candidate) return;
      const s = sessionFor(msg.fromId);
      if (!s || !s.pc) return;
      if (s.pc.remoteDescription) s.pc.addIceCandidate(msg.candidate).catch(() => {});
      else s.pendingCandidates.push(msg.candidate);
      break;
    }
    case "peer-disconnected": {
      const s = sessionFor(msg.fromId);
      if (!s) break;
      if (msg.bye) { if (!s.byeReceived) onBye(s, msg.reason); break; }   // ended on purpose (see closeSession)
      // The server also reports this when only the SIGNALING link blipped (or the server restarted) while the
      // P2P session is perfectly healthy. A real hang-up closes the data channel within moments, so with a live
      // link wait briefly and only tear down if it really went away.
      const linkUp = () => s.pc && s.pc.connectionState === "connected" && s.dataChannel && s.dataChannel.readyState === "open";
      const stillOurs = () => (s.role === "host" ? host === s : sessions.get(s.peerId) === s);
      const hangUp = () => {
        // Why it ended, for the log: the other PC left the server AND the direct link was already gone (its app
        // closed or restarted, or its network dropped). The "closed (dropped)" line alone didn't say (owner 19 Nov).
        sessLog(s, `the other PC left the server; link ${s.pc ? s.pc.connectionState : "none"}, channel ${s.dataChannel ? s.dataChannel.readyState : "none"}`);
        const reconnect = s.role === "viewer" && autoReconnect && s.everConnected && !s.byeReceived;
        const fg = s === active;
        closeSession(s, false);
        if (reconnect) tryReconnect(s.peerId, s.savedPassword, fg);
        else showToast("Remote desktop memutus koneksi");
      };
      if (linkUp()) setTimeout(() => { if (stillOurs() && !linkUp()) hangUp(); }, 3000);
      else hangUp();
      break;
    }
    case "error": {
      // Errors (target offline/busy) belong to a tab that is still connecting. Newer servers name it in
      // targetId; otherwise fall back to the active tab.
      const s = msg.targetId ? sessions.get(msg.targetId) : active;
      const text = serverErrorText(msg);
      if (s) sessLog(s, "server: " + String(msg.code || msg.message || "").slice(0, 80));
      let failShown = false;
      if (s && s.role === "viewer" && s.pc == null) {
        const fg = s === active && !s.isReconnect;
        closeSession(s, false); reconnectFailed(s, "");   // offline / busy: try again later
        const kind = { offline: "offline", "host-offline": "offline", busy: "busy" }[msg.code] || (text === SERVER_ERROR_TEXT.offline ? "offline" : "");
        // "too many requests" from a run of Kelola: back in the queue, it goes again when the server allows
        if (s.bulk && msg.code === "ratelimit" && KM.bulk.has(s.peerId)) { kmRequeue(s.peerId, s.savedPassword); break; }
        if (s.bulk && !fg) { kmNote(s.peerId, kind === "offline" ? "failOff" : kind === "busy" ? "failBusy" : "failErr"); break; }
        if (fg) failShown = showFailView(s.peerId, kind);
      }
      if (!failShown) showToast(text);
      break;
    }
  }
}

// ─── Gagal tersambung (concept): the PC, why it did not connect, three things to try, Coba lagi ───
// Arah 3 (owner pick 15 Nov): one big word, why, and numbered steps that each carry their own button.
const FAIL_KINDS = {
  noanswer: { big: "Tidak dijawab.", sub: "Permintaan sudah sampai, tetapi tidak ada yang menekan Terima dalam 30 detik.",
    tips: [{ t: "Minta pemilik PC menekan Terima", d: "Kotak merah permintaan muncul di layar PC itu.", act: "copy" },
      { t: "Masuk dengan password akses", d: "Dengan password, Anda tidak perlu menunggu Terima.", act: "pw" }] },
  rejected: { big: "Ditolak.", sub: "Pemilik PC itu menekan Tolak pada permintaan Anda.",
    tips: [{ t: "Kabari pemilik PC dulu", d: "Lewat chat atau telepon, lalu kirim permintaan lagi.", act: "copy" },
      { t: "Masuk dengan password akses", d: "Dengan password, Anda langsung masuk tanpa menunggu Terima.", act: "pw" }] },
  offline: { big: "Offline.", sub: "ID tidak ditemukan, atau TryDesk di PC itu tidak tersambung ke internet.",
    tips: [{ t: "Pastikan TryDesk di PC itu terbuka", d: "Di Beranda PC itu harus tertulis Online." },
      { t: "Periksa lagi ID-nya", d: "Satu angka salah saja membuat ID tidak ditemukan.", act: "edit" },
      { t: "Satu jaringan?", d: "Sambung lewat IP bekerja tanpa internet.", act: "lan" }] },
  busy: { big: "Sibuk.", sub: "PC itu sedang dalam sesi dengan perangkat lain.",
    tips: [{ t: "Coba lagi nanti", d: "Setelah sesi yang sedang berjalan selesai." }] },
};
const FAIL_ACT = { copy: "Salin ID", pw: "Isi password", edit: "Ubah ID", lan: "Cara pakai" };
let failPeer = null;
function showFailView(peerId, kind) {
  const k = FAIL_KINDS[kind];
  if (!k || !peerId) return false;
  failPeer = peerId;
  const lan = /^lan:/.test(peerId), shownId = lan ? peerId.slice(4) : fmtId(peerId), nm = peerName(peerId);
  $("#fail-who").textContent = nm ? `${nm} · ${shownId}` : shownId;
  $("#fail-title").textContent = k.big;
  $("#fail-sub").textContent = k.sub;
  $("#fail-tips").replaceChildren(...k.tips.filter((x) => !(lan && x.act === "lan")).map((tip, i) => {
    const li = document.createElement("li");
    const n = document.createElement("span"); n.className = "ft-n"; n.textContent = String(i + 1);
    const tx = document.createElement("div"), b = document.createElement("b"), s = document.createElement("small");
    b.textContent = tip.t; s.textContent = tip.d; tx.append(b, s); li.append(n, tx);
    if (tip.act) { const btn = document.createElement("button"); btn.type = "button"; btn.className = "btn-secondary ft-act"; btn.dataset.act = tip.act; btn.textContent = lan && tip.act === "copy" ? "Salin alamat IP" : FAIL_ACT[tip.act]; li.append(btn); }
    return li;
  }));
  if (!sessions.size || viewerSessions().every((x) => !x.pc)) showScreen("home");
  if ($("#screen-home").classList.contains("hidden")) return false;   // another session is on screen: a toast is enough
  $("#fail-view").classList.remove("hidden");
  $("#fail-retry").focus({ preventScroll: true });
  return true;
}
$("#fail-home").addEventListener("click", () => { $("#fail-view").classList.add("hidden"); });
// The buttons inside the steps: copy the ID, type the password, fix the ID, or open the Connect-by-IP guide.
$("#fail-tips").addEventListener("click", (e) => {
  const b = e.target.closest(".ft-act"); if (!b || !failPeer) return;
  const lan = /^lan:/.test(failPeer), raw = lan ? failPeer.slice(4) : failPeer;
  if (b.dataset.act === "copy") { navigator.clipboard.writeText(raw).then(() => showToast(lan ? "Alamat IP disalin" : "ID disalin"), () => {}); return; }
  $("#fail-view").classList.add("hidden");
  if (b.dataset.act === "lan") { openLanHelp(); return; }
  remoteIdInput.value = raw;
  if (b.dataset.act === "pw") $("#remote-password")?.focus();
  else { remoteIdInput.focus(); try { remoteIdInput.select(); } catch {} }
});
$("#fail-retry").addEventListener("click", () => {
  $("#fail-view").classList.add("hidden");
  if (!failPeer) return;
  remoteIdInput.value = /^lan:/.test(failPeer) ? failPeer.slice(4) : failPeer;
  initiateConnection();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#fail-view").classList.contains("hidden")) $("#fail-view").classList.add("hidden"); });
// What a server error shows. The server names a code (1.3.3+) and TryDesk has its own text for it; an older server
// sends one of a few fixed texts, which are shown only when they are TryDesk's own. Anything else gets a plain
// message: the server must not be able to put arbitrary text in front of the user.
const SERVER_ERROR_TEXT = {
  offline: "ID tidak ditemukan atau sedang offline", ratelimit: "Terlalu banyak permintaan, coba lagi sebentar",
  self: "Tidak bisa me-remote PC Anda sendiri", busy: "Remote desktop sedang dalam sesi lain", "host-offline": "Remote desktop offline",
  "target-ratelimit": "PC tujuan sedang menerima terlalu banyak permintaan, coba lagi sebentar",
  "too-old": "TryDesk di PC ini sudah terlalu lama dan tidak bisa terhubung lagi. Perbarui di trydesk.ai.id/downloads",
  "peer-too-old": "PC tujuan memakai TryDesk versi lama. Minta pemiliknya memperbarui di trydesk.ai.id/downloads",
  "peer-too-old-host": "Ada yang mencoba terhubung, tapi TryDesk di PC ini versi lama. Perbarui di trydesk.ai.id/downloads",
};
function serverErrorText(msg) {
  const code = typeof msg.code === "string" ? msg.code : "";
  if (Object.prototype.hasOwnProperty.call(SERVER_ERROR_TEXT, code)) return SERVER_ERROR_TEXT[code];
  const m = typeof msg.message === "string" ? msg.message.trim() : "";
  if (m && Object.values(SERVER_ERROR_TEXT).includes(m)) return m;
  return "Server menolak permintaan ini";
}

// Session bar label: "Terhubung ke" + the peer. The prefix is its own element so a narrow window can drop it and
// keep the address/ID itself readable (it used to be cut to "Connected to 1…"). The full text stays as a tooltip.
function setPeerLabel(prefix, peerId, tail = "") {
  const el = $("#remote-peer-id");
  const pre = document.createElement("span"); pre.className = "sb-peer-pre"; pre.textContent = prefix;
  const who = document.createElement("span"); who.textContent = fmtId(peerId) + tail;
  el.replaceChildren(pre, who);
  el.title = `${tr(prefix)} ${fmtId(peerId)}`;
}
// Resolve a signaling peerId to its session (viewer tab or the single host session).
function sessionFor(peerId) {
  return sessions.get(peerId) || (host && host.peerId === peerId ? host : null);
}

// ─── Viewer side ──────────────────────────────────────────
// When this app sent its recent requests through the server (it allows 5 per 10 s): Kelola's queue keeps under it.
const connReqTimes = [];
// From the Connect button (reads the inputs) or from auto-reconnect (own target + password; a background tab's
// reconnect leaves the tab the user is looking at in front).
function initiateConnection(target, password, { background = false } = {}) {
  const fromUi = typeof target !== "string";
  if (updateRequired) return showToast(UPDATE_REFUSED);
  const typed = fromUi ? remoteIdInput.value.trim() : target;
  // An IP address (or a LAN PC name) goes straight to that PC, no server, so no need to be online.
  const lanAddr = parseLanTarget(typed);
  const targetId = lanAddr ? "lan:" + lanAddr : typed;
  if (!lanAddr) {
    if (!myId) return showToast("Belum terhubung ke server, untuk PC di jaringan yang sama, ketik alamat IP-nya");
    if (!/^\d{3} \d{3} \d{3}$/.test(targetId)) return showToast("Masukkan ID 9 digit atau alamat IP");
    if (targetId === myId || (svcId && targetId === svcId)) return showToast("Tidak bisa konek ke diri sendiri");
  }
  if (sessions.has(targetId)) {
    // Double-click on a tile, Enter + click, a second Enter listener: just bring that tab up, a tab still
    // connecting keeps its Connecting screen (Cancel + password box), it is not "already open".
    const s = sessions.get(targetId);
    if (fromUi || !background) switchTab(s);
    if (s.pc) showToast("Tab untuk ID ini sudah terbuka");
    return s;
  }
  // Open a new viewer tab. Any existing tabs keep running in the background.
  const sess = new Session(targetId, "viewer");
  sessions.set(targetId, sess);
  updateSessionLabel(sess);           // a renamed ID shows its name on the tab right away
  // Hold the typed password locally for the challenge/response, it is NEVER sent to the server. savedPassword
  // stays with the tab so an auto-reconnect can answer the host's challenge again.
  sess.pendingPassword = sess.savedPassword = (fromUi ? remotePasswordInput.value : password) || "";
  // The typed password belongs to THIS PC only, clear it so the next tile or ID doesn't silently reuse it
  // (a wrong answer there counts toward that PC's lock-out).
  if (fromUi) remotePasswordInput.value = "";
  if (!background) active = sess;
  renderTabs();
  if (!background) {
    showScreen("connecting");
    renderPwPrompt();
    setConnectStep(1);
    // Concept: the PC's ID large, one small line above it that says what is happening.
    $("#connecting-title").textContent = /^lan:/.test(targetId) ? targetId.slice(4) : fmtId(targetId);
    $("#connecting-text").textContent = `Menyambung ke ${peerName(targetId) || "PC"}`;
  }
  sendSignal({ type: "connect-request", targetId, fromName: store.get("deviceAlias") || "TryDesk User" });
  if (!lanAddr) { connReqTimes.push(Date.now()); iceFresh(); }   // the relay login must still be good when the session needs it
  sessLog(sess, "request sent");
  setTimeout(() => { if (sessions.get(targetId) === sess && !sess.pc && sess === active) setConnectStep(2); }, 500);
  // Never leave a tab on "connecting" forever (no answer, or an error the server sent without naming the tab).
  // Settings → Koneksi → "Waktu tunggu koneksi" (0 = wait indefinitely).
  const waitS = Number(prefGet("connTimeout")) || 0;
  if (waitS > 0) sess.requestTimer = setTimeout(() => {
    if (sessions.get(targetId) === sess && !sess.pc) {
      closeSession(sess, false);
      if (sess.bulk) { kmNote(targetId, "failNoans"); return; }
      showToast("Tidak ada respons dari remote desktop");
      if (sess.isReconnect) tryReconnect(targetId, sess.savedPassword, sess.wasForeground);
    }
  }, waitS * 1000);
  return sess;
}

// The host asked for its access password again (none typed, or a wrong one). Its owner sees the Accept dialog
// at the same moment; typing the right password here gets in at once. The line under the field is empty until a
// wrong password; the waiting line says what else can happen (users expected a saved device to remember the
// password, it doesn't by the owner's choice, so it says so).
const PW_PROMPT_TEXT = { empty: "", typed: "Password salah. Coba lagi." };
const PW_WAIT = {
  id: "Atau tunggu pemilik PC menekan Terima. Password tidak disimpan.",
  lan: "Lewat IP, hanya password yang bisa membuka akses. Password tidak disimpan.",
};
function showPwPrompt(s, nonce, last) {
  s.pwPrompt = { nonce, last: PW_PROMPT_TEXT[last] ? last : "empty" };
  if (s.pwPrompt.last === "typed") playEvent("denied");   // the password typed was wrong
  renderPwPrompt();
  // A tab in the background (or an auto-reconnect) can't show its box, point the user at it.
  if (s !== active || $("#screen-connecting").classList.contains("hidden")) showToast(`${fmtId(s.peerId)} meminta password akses, buka tab tersebut`);
}
function renderPwPrompt() {
  const s = active && active.role === "viewer" && !active.pc ? active : null;
  const p = s && s.pwPrompt;
  $("#connect-pw").classList.toggle("hidden", !p);
  if (!p) return;
  const m = $("#connect-pw-msg");
  const lan = isLanId(s.peerId);   // over LAN only the password gets in (no Accept on the other side)
  m.textContent = PW_PROMPT_TEXT[p.last];
  m.classList.toggle("warn", p.last !== "empty");
  // The PC being opened, as its Recent tile shows it: last picture (or the monitor glyph), name, ID.
  const name = peerName(s.peerId), thumb = getThumbs()[s.peerId], tb = $("#connect-pw-thumb");
  tb.classList.toggle("has-thumb", !!thumb);
  if (thumb) { const img = new Image(); img.alt = ""; img.draggable = false; img.src = thumb; tb.replaceChildren(img); }
  else tb.innerHTML = MONITOR_SVG;
  $("#connect-pw-name").textContent = name || fmtId(s.peerId);
  $("#connect-pw-peer").textContent = name ? fmtId(s.peerId) : lan ? "Jaringan lokal" : "ID TryDesk";
  $("#connect-pw-wait-text").textContent = lan ? PW_WAIT.lan : PW_WAIT.id;
  $("#connect-pw-go").disabled = false;
  $("#connecting-text").textContent = lan ? "Menunggu password akses" : "Menunggu password atau persetujuan pemilik PC";
  const inp = $("#connect-pw-input");
  inp.value = "";
  inp.focus();
}
$("#connect-pw").addEventListener("submit", async (e) => {
  e.preventDefault();
  const s = active, p = s && s.pwPrompt;
  const pw = $("#connect-pw-input").value;
  if (!p || !pw) return;
  $("#connect-pw-go").disabled = true;
  try {
    const key = await deriveKeyHex(pw, s.pwSalt);
    if (sessions.get(s.peerId) !== s || s.pc || s.pwPrompt !== p) return;
    s.pwPrompt = null;
    s.pwLast = "typed";
    s.savedPassword = pw;   // an auto-reconnect answers the next challenge with it
    s.lanKey = key;         // a LAN session signs its offers with it
    sendSignal({ type: "connection-response", targetId: s.peerId, response: await answerWithKey(key, p.nonce) });
  } catch {}
  renderPwPrompt();
  if (s === active && !s.pc) $("#connecting-text").textContent = "Memeriksa password…";
});

async function startViewer(sess) {
  addRecent(sess.peerId);
  if (sess === active) $("#connecting-text").textContent = "Membangun koneksi peer-to-peer...";
  await h265Probe();   // done long before, unless this session started within the first seconds
  if (sessions.get(sess.peerId) !== sess || sess.pc) return;
  createPeer(sess);
  const pc = sess.pc;
  sess.videoTransceiver = pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });
  applyCodecPreference(sess);
  sess.dataChannel = pc.createDataChannel("ctrl", { ordered: true });
  sess.dataChannel.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } onCtrlMessage(sess, ev); };
  sess.dataChannel.onopen = () => {
    sendQuality(sess); startClipboardSync(sess); reapplyBlackScreen(sess);
    if (prefGet("monFollow")) { try { sess.dataChannel.send(JSON.stringify({ __ctrl: "mon-follow", on: true })); } catch {} }
    // Once: text copied BEFORE connecting is deliberately not sent (privacy), say so, or "copy, connect, paste" just seems broken.
    if (clipboardSync && store.get("tipClipBaseline") !== "1" && !document.documentElement.classList.contains("td-mobile")) { store.set("tipClipBaseline", "1"); setTimeout(() => showToast("Tip: teks yang disalin sebelum tersambung tidak ikut dikirim, salin ulang setelah tersambung", "info"), 2500); }
  };
  sess.fileChannel = pc.createDataChannel("file", { ordered: true });
  sess.fileChannel.binaryType = "arraybuffer";
  setupFileChannel(sess, sess.fileChannel);

  const video = ensureVideo(sess);
  pc.ontrack = (event) => {
    // Another monitor of that PC ("Semua monitor"): it has its own picture, never the session's own <video>.
    if (sess.monTx && sess.monTx.includes(event.transceiver)) { monRenderViews(sess); return; }
    // While the fast path shows the picture, a renegotiated WebRTC stream is kept aside for when it ends.
    if (sess.fast && sess.fast.on) { if (event.streams[0]) sess.webrtcStream = event.streams[0]; }
    else if (event.streams[0]) video.srcObject = event.streams[0];
    else { const s = video.srcObject || new MediaStream(); s.addTrack(event.track); video.srcObject = s; }
    video.muted = !(sess.audioOn && sess === active);   // a background tab stays silent (see showActiveVideo)
    video.volume = Number(prefGet("audioVolume")) / 100;
    // Start the receive buffer minimal; pollStats() then adapts it to the MEASURED network jitter —
    // near-zero on a clean LAN (feels instant, good for gaming) and larger only when the link is
    // actually jittery (stays smooth for distant users). A fixed 120ms buffer added real lag on LAN.
    if (event.track && event.track.kind === "video" && event.receiver) {
      sess.videoReceiver = event.receiver;
      // 0 = each frame shown the moment it is decoded (with the playout-delay cap in main.js); pollStats raises it
      // only on a link that needs smoothing.
      try { event.receiver.playoutDelayHint = 0; } catch {}
      try { if ("jitterBufferTarget" in event.receiver) event.receiver.jitterBufferTarget = 0; } catch {}
      sess._jbTarget = 0;
    }
    if (sess === active) {
      showScreen("remote");
      renderTabs();
      setPeerLabel("Terhubung ke", sess.peerId);
      if (!sess.hasFrame) $("#remote-loading")?.classList.remove("hidden");
      showActiveVideo();
      video.focus();
      applyScale();
    }
    startStats(sess);
    startSessionTimer(sess);
  };

  await negotiate(sess);
}

// Make the video encoder start near full quality instead of ramping up from a low bandwidth
// estimate (the cause of the first 10–30s showing a tiny, low-res remote screen). We inject
// Google's x-google-*-bitrate hints into the video codecs so it jumps to full resolution at once.
function boostStartBitrate(sdp, startOverride = 0) {
  // Start at 4 Mbps (WebRTC's start-up probes then reach a fast link's speed within a second or two). 12 Mbps flooded a
  // thin link for the first seconds: the estimate crashed to ~300 kbps and the picture took long to recover. On a LAN a
  // 12 Mbps start didn't lower the delay either (14 Nov 2026, 3 runs each, interleaved: median 73 -> 74 ms, 90 % 93 ->
  // 118 ms), so it stays 4 Mbps everywhere.
  // startOverride (webrtcSeed, P11): the rate a fast path measured. Chromium carries the earlier x-google values into
  // every later offer, so that value is replaced in place (left alone, a re-offer would never change it).
  const startKbps = startOverride > 0 ? Math.round(startOverride) : 4000;
  // The estimate's floor. It was 1200: on a link slower than that WebRTC could never send less, so the queue only grew
  // (lag until the session dropped). 150 lets it follow a link down to mobile-data speeds.
  const minKbps = 150;
  // Only a ceiling for the bandwidth estimate: this offer is made by the viewer, the quality can change without a new
  // offer, and the host's encoder maxBitrate already caps each quality. (It read the viewer's unused hostQuality: 80.)
  const maxKbps = WEBRTC_MAX_MBPS * 1000;
  const extra = `x-google-start-bitrate=${startKbps};x-google-min-bitrate=${minKbps};x-google-max-bitrate=${maxKbps}`;
  const lines = sdp.split(/\r\n/);
  let vStart = lines.findIndex((l) => l.startsWith("m=video"));
  if (vStart < 0) return sdp;
  let vEnd = lines.length;
  for (let i = vStart + 1; i < lines.length; i++) { if (lines[i].startsWith("m=")) { vEnd = i; break; } }
  const section = lines.slice(vStart, vEnd);
  const codecOf = {};
  for (const l of section) { const m = l.match(/^a=rtpmap:(\d+) ([^/]+)\//); if (m) codecOf[m[1]] = m[2].toUpperCase(); }
  const wanted = new Set(Object.entries(codecOf).filter(([, c]) => ["VP8", "VP9", "H264", "H265", "AV1", "AV1X"].includes(c)).map(([pt]) => pt));
  const hasFmtp = new Set();
  for (const l of section) { const m = l.match(/^a=fmtp:(\d+) /); if (m) hasFmtp.add(m[1]); }
  const out = [];
  for (const l of section) {
    const fm = l.match(/^a=fmtp:(\d+) (.*)$/);
    if (fm && wanted.has(fm[1])) {
      if (!/x-google-start-bitrate/.test(fm[2])) out.push(`a=fmtp:${fm[1]} ${fm[2]};${extra}`);
      else out.push(startOverride > 0 ? l.replace(/x-google-start-bitrate=\d+/, `x-google-start-bitrate=${startKbps}`) : l);
      continue;
    }
    out.push(l);
    const rm = l.match(/^a=rtpmap:(\d+) /);
    if (rm && wanted.has(rm[1]) && !hasFmtp.has(rm[1])) { out.push(`a=fmtp:${rm[1]} ${extra}`); hasFmtp.add(rm[1]); }
  }
  return lines.slice(0, vStart).concat(out, lines.slice(vEnd)).join("\r\n");
}

// One offer at a time (independent review, 14 Nov 2026): a second offer while the first one's answer was on its way (an
// ICE restart during a codec fallback, or the WebRTC restart after a fast path, P11) got the first answer applied to it
// and the second one refused. A request meanwhile waits for that answer (case "answer" sends it then); an answer that
// never comes holds it back at most 5 s.
async function negotiate(sess) {
  if (!sess.pc || sess.role !== "viewer") return;
  if (sess._negBusy || (sess.pc.signalingState === "have-local-offer" && performance.now() - (sess._negAt || 0) < 5000)) {
    sess._negAgain = true;
    // The answer may never come (the signaling link reconnecting): try again once the wait is over.
    clearTimeout(sess._negTimer);
    sess._negTimer = setTimeout(() => { if (sess._negAgain && sess.pc) { sess._negAgain = false; negotiate(sess).catch(() => {}); } }, 5200);
    return;
  }
  sess._negBusy = true; sess._negAgain = false; clearTimeout(sess._negTimer);
  try {
    // An offer that got no answer in 5 s is taken back first, so a late answer can't land on the new one.
    if (sess.pc.signalingState === "have-local-offer") { try { await sess.pc.setLocalDescription({ type: "rollback" }); } catch {} }
    const offer = await sess.pc.createOffer();
    offer.sdp = boostStartBitrate(offer.sdp, sess.startKbps);
    await sess.pc.setLocalDescription(offer);
    sess._negAt = performance.now();
    sendSignal({ type: "offer", targetId: sess.peerId, offer: sess.pc.localDescription });
  } finally { sess._negBusy = false; }
}

// ─── H.265 (P4, owner 14 Nov 2026) ───
// "Otomatis" puts H.265 first where this PC decodes it in hardware: at the same bitrate it measured sharper than H.264
// (14 Nov, 3 runs each: LAN text 40.1 -> 42.3 dB, coloured code 43.2 -> 47.6 dB, 5 Mbps code 45.2 -> 47.9 dB, delay the
// same). Chromium has no software H.265 decoder and only lists it where the GPU decodes it, and Media Capabilities must
// call it power-efficient too. The host sends H.265 only when its own GPU encodes it (it is left out of the answer
// otherwise), so H.264 stays the fallback. Only on Windows for now: phones, Macs and Linux PCs list H.265 too, but none
// has been tested with it (they can still choose it by hand, except the phone). Not for a PC where it showed no picture
// (h265Watch).
let _h265Recv = false, _h265Probe = null;
// Asked once, a few seconds after start and before the first session, not while the page loads: getCapabilities can wait
// for the GPU process. Never in the service's window (it only hosts). An H.265 choice this PC can't use is greyed out.
function h265Probe() {
  return _h265Probe || (_h265Probe = (async () => {
    try {
      const caps = RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities("video");
      if (caps && caps.codecs.some((c) => /^video\/h265$/i.test(c.mimeType))) {
        const r = await navigator.mediaCapabilities.decodingInfo({ type: "webrtc", video: { contentType: "video/H265", width: 1920, height: 1080, bitrate: 20e6, framerate: 60 } });
        _h265Recv = !!(r && r.supported && r.powerEfficient);
      }
    } catch {}
    for (const o of document.querySelectorAll('#codec-select option[value="H265"], #setting-default-codec option[value="H265"]')) o.disabled = !_h265Recv;
    try { window.electronAPI?.logInfo?.(`H.265: ${_h265Recv ? "decoded in hardware on this PC" : "not decoded in hardware on this PC"}`); } catch {}
  })());
}
const h265Auto = () => _h265Recv && !window.TD_MOBILE && !!config && config.platform === "win32" && !h265LocalOff();
// A remote PC where H.265 showed no picture: { n: failures, at: last failure, until: blocked until }. Right at the
// fallback 10 minutes (a reconnect then starts on H.264); once H.264 has shown a picture where H.265 didn't, 1 day, and
// 30 days when that happens again within 30 days. A record whose block and history have both run out is removed.
const H265_DAY = 864e5;
const h265Key = (sess) => "noH265." + sess.peerId;
function h265Record(key) {
  let r = null; try { r = JSON.parse(store.get(key) || "null"); } catch {}
  if (r && !(r.until > Date.now()) && !(Date.now() - (r.at || 0) < 30 * H265_DAY)) { store.set(key, null); r = null; }
  return r;
}
function h265Blocked(sess) { if (sess.noH265) return true; const r = h265Record(h265Key(sess)); return !!(r && r.until > Date.now()); }
function h265Remember(sess, confirmed) {
  const key = h265Key(sess), prev = h265Record(key) || { n: 0, at: 0, until: 0 };
  if (!confirmed) { store.set(key, JSON.stringify({ ...prev, until: Math.max(prev.until || 0, Date.now() + 600000) })); return; }
  const n = prev.n >= 1 && Date.now() - prev.at < 30 * H265_DAY ? prev.n + 1 : 1;
  store.set(key, JSON.stringify({ n, at: Date.now(), until: Date.now() + (n >= 2 ? 30 : 1) * H265_DAY }));
  // This PC's own decoder may be the cause: two different remote PCs within 30 days and "Otomatis" stops using H.265 here.
  let l = []; try { l = JSON.parse(store.get("noH265.this") || "[]"); } catch {}
  l = (Array.isArray(l) ? l : []).filter((x) => x && x.id !== sess.peerId && Date.now() - x.at < 30 * H265_DAY);
  l.push({ id: sess.peerId, at: Date.now() });
  store.set("noH265.this", JSON.stringify(l.slice(-5)));
}
function h265LocalOff() { try { const l = JSON.parse(store.get("noH265.this") || "[]"); return Array.isArray(l) && l.filter((x) => x && Date.now() - x.at < 30 * H265_DAY).length >= 2; } catch { return false; } }

// Without a line named: the session's own picture and the other monitors' lines ("Semua monitor") alike.
function applyCodecPreference(sess, tr) {
  if (!tr) { codecPrefOn(sess, sess.videoTransceiver); for (const t of sess.monTx || []) codecPrefOn(sess, t); return; }
  codecPrefOn(sess, tr);
}
function codecPrefOn(sess, tr) {
  if (!tr || !tr.setCodecPreferences) return;
  try {
    const caps = RTCRtpReceiver.getCapabilities("video");
    if (!caps) return;
    const h265 = caps.codecs.filter((c) => /^video\/h265$/i.test(c.mimeType));
    const h264 = caps.codecs.filter((c) => /^video\/h264$/i.test(c.mimeType));
    const others = caps.codecs.filter((c) => !/^video\/h26[45]$/i.test(c.mimeType));
    // With H.265 first, VP8 stays out: when a GPU's H.265 encoder fails, WebRTC asks for VP8 by name, and only when it
    // isn't there does it take the next codec, H.264 (otherwise the host went on in VP8 on its CPU).
    const h265First = () => [...h265, ...h264, ...others.filter((c) => !/^video\/vp8$/i.test(c.mimeType))];
    const want = String(sess.quality.codec || "auto").toLowerCase();
    // "Otomatis" must really go back to the browser's own order. An empty list is meant to reset it, but this
    // Chromium keeps the earlier choice (VP9…), so hand it the default order explicitly.
    // "Otomatis": H.265 where this PC decodes it in hardware (above), then H.264: the codecs GPUs encode and decode
    // in hardware (measured: NVIDIA MFT on the host, ~0.6 ms decode), where VP8/VP9/AV1 run in software on the CPU.
    // Without a hardware H.264 encoder the host falls back to software H.264 by itself. The rest keeps the browser's
    // own order. H.265 is left out wherever it isn't wanted, so a failing encoder can't fall back to it either.
    if (want === "auto" || (want === "h265" && window.TD_MOBILE)) {
      tr.setCodecPreferences(h265.length && h265Auto() && !h265Blocked(sess) ? h265First() : [...h264, ...others]);
      return;
    }
    // Chosen by hand: tried even for a PC remembered as failing (only this session's own fallback stops it).
    if (want === "h265") { tr.setCodecPreferences(h265.length && !sess.noH265 ? h265First() : [...h264, ...others]); return; }
    const pref = caps.codecs.filter((c) => c.mimeType.toLowerCase() === `video/${want}`);
    const rest = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== `video/${want}` && !/^video\/h265$/i.test(c.mimeType));
    if (pref.length) tr.setCodecPreferences([...pref, ...rest]);
  } catch (e) { console.warn("codec pref failed", e); }
}

// The codec the host sends: the first one in the m=video line of its answer.
function firstVideoCodec(sdp) {
  const s = String(sdp || ""), m = /^m=video \d+ \S+ (\d+)/m.exec(s);
  const r = m && new RegExp(`^a=rtpmap:${m[1]} ([^/\\s]+)/`, "m").exec(s);
  return r ? r[1].toUpperCase() : "";
}
// H.265 negotiated but no picture: back to H.264 for this session (h265Fallback). Only while WebRTC carries the picture
// (the fast path pauses its video) and the link is connected. Runs in pollStats (1 s), with the codec that arrives.
//  - nothing decoded since H.265 was negotiated: frames arrive and none decodes for 6 s (the first frame is a keyframe;
//    on a bad link it can take a few seconds to arrive whole: 2 Mbps, 100 ms, 2 % loss gave the first picture at 4 s),
//    or 500 KB without one frame in 8 s, or no video at all for 15 s;
//  - it decoded and then stopped: 30 frames arrive and none decodes for 4 s (a loss heals with the next keyframe);
//  - decoded but never shown in the <video> (the active tab, 30 frames, 5 s).
// If the host's own encoder gives up on H.265, WebRTC moves to H.264 by itself (VP8 is left out, see above): that is
// only remembered.
function h265Watch(sess, inbound, codecMime) {
  if (sess.role !== "viewer" || !sess.pc || !sess.pc.remoteDescription) return;
  const fd = (inbound && inbound.framesDecoded) || 0, fr = (inbound && inbound.framesReceived) || 0, bytes = (inbound && inbound.bytesReceived) || 0;
  const now = Date.now(), codec = String(codecMime || "").toUpperCase();
  // After a fallback: H.264 decoding within 15 s confirms that H.265 was the cause. An offer that changed nothing (lost
  // while the signaling link was reconnecting) goes out once more after 10 s.
  if (sess._h265FellAt) {
    if (fd > sess._h265FellFd && codec === "H264") {
      if (now - sess._h265FellAt < 15000) { h265Remember(sess, true); sessLog(sess, "H.264 shows a picture where H.265 didn't: H.265 stays off for this PC for a while"); }
      sess._h265FellAt = 0;
    } else if (now - sess._h265FellAt > 10000 && !sess._h265Again && fd === sess._h265FellFd) {
      sess._h265Again = true; sessLog(sess, "still no picture after going back to H.264, offering again"); negotiate(sess).catch(() => {});
    } else if (now - sess._h265FellAt > 30000) sess._h265FellAt = 0;
  }
  const sdp = sess.pc.remoteDescription.sdp;
  if (sess._h265Sdp !== sdp) { sess._h265Sdp = sdp; sess._h265On = firstVideoCodec(sdp) === "H265"; sess._h265W = null; sess._h265Other = 0; }
  if (!sess._h265On || sess.noH265 || (sess.fast && sess.fast.on) || sess.pc.connectionState !== "connected") { sess._h265W = null; return; }
  if (codec && codec !== "H265") {
    if (++sess._h265Other >= 2) { sess.noH265 = true; h265Remember(sess, true); sessLog(sess, `the host sends ${codec} instead of H.265: H.265 stays off for this PC for a while`); }
    return;
  }
  sess._h265Other = 0;
  const w = sess._h265W || (sess._h265W = { start: fd, fd, fr, bytes, stall: 0, ticks: 0 });
  w.ticks++;
  if (fd - w.start >= 30 && !sess.hasFrame && sess === active && w.ticks >= 5) { h265Fallback(sess, "decoded but not shown", fd); return; }
  if (fd !== w.fd) { w.fd = fd; w.fr = fr; w.bytes = bytes; w.stall = 0; return; }   // decoding goes on: the stall window starts again
  w.stall++;
  const frames = fr - w.fr, kb = (bytes - w.bytes) / 1000;
  if (fd === w.start) {
    if (frames >= 1 && w.stall >= 6) h265Fallback(sess, `${frames} frames arrived in ${w.stall} s, none decoded`, fd);
    else if (kb > 500 && w.stall >= 8) h265Fallback(sess, `${Math.round(kb)} KB arrived in ${w.stall} s, no frame`, fd);
    else if (!inbound && w.ticks >= 15 && !sess.hasFrame) h265Fallback(sess, "no video at all for 15 s", fd);
  } else if (frames >= 30 && w.stall >= 4) h265Fallback(sess, `${frames} frames arrived in ${w.stall} s, none decoded`, fd);
}
function h265Fallback(sess, why, fd) {
  sess.noH265 = true; sess._h265W = null; sess._h265FellAt = Date.now(); sess._h265FellFd = fd; sess._h265Again = false;
  h265Remember(sess, false);   // 10 minutes: a reconnect right away starts on H.264
  sessLog(sess, `H.265 shows no picture (${why}), back to H.264`);
  applyCodecPreference(sess);
  negotiate(sess).catch(() => {});
}

// ─── Host side ────────────────────────────────────────────
// One outstanding access-password challenge at a time, plus a brute-force cool-down PER REQUESTER: a global
// counter let any stranger who knew the ID lock everyone out (including people with the right password).
let pendingChallenge = null;      // { fromId, fromName, nonce, expires, _t }
const pwFail = new Map();         // requester id -> { count, until }
let autoAcceptWithPassword = true, bruteForceGuard = true;   // Settings → Koneksi / Keamanan
// A LAN requester gets a new id per socket ("lan-in:<ip>#n"): count its wrong answers per address, not per socket.
const pwKey = (id) => String(id).replace(/#\d+$/, "");
const pwBlocked = (id) => { const f = pwFail.get(pwKey(id)); return !!f && f.until > Date.now(); };
// A SECOND, requester-independent budget. The per-id cool-down above is defeated by an attacker who
// rotates its requester ID (the signaling server hands any token-less socket a fresh ID), so wrong
// answers also count toward one global tally. Once it trips, the password challenge is withheld and
// the host falls back to manual Accept, a person at the PC can still let someone in, but automated
// guessing gets no HMAC oracle at all. Verified: rotating-ID guessing no longer bypasses the limit.
const PW_GLOBAL_MAX = 12;                      // total wrong answers (any requester) before withholding the challenge
const PW_GLOBAL_WINDOW = 10 * 60 * 1000;
// One budget per path: wrong answers over the LAN must not switch off password auto-accept for ID callers, and an
// internet attacker who knows the ID must not lock the owner out of LAN connections.
const pwGlobalFail = { id: { times: [], until: 0 }, lan: { times: [], until: 0 } };
const pwPath = (id) => (lanIn(id) ? "lan" : "id");
// Over the LAN the guard is always on, whatever the setting (security audit 22 Nov): that path has no server limits in
// front of it, and anyone on the same network can try passwords as fast as the PC answers.
const pwGuardOn = (id) => bruteForceGuard || lanIn(id);
const pwGlobalBlocked = (id) => pwGuardOn(id) && pwGlobalFail[pwPath(id)].until > Date.now();
function pwFailed(id) {
  if (!pwGuardOn(id)) return;
  id = pwKey(id);
  const f = pwFail.get(id) || { count: 0, until: 0 };
  f.count++;
  // 3rd wrong answer: 5 minutes; every further one adds 5 more (capped at 20).
  if (f.count >= 3) f.until = Date.now() + Math.min(20, 5 * (f.count - 2)) * 60 * 1000;
  pwFail.set(id, f);
  if (pwFail.size > 500) pwFail.delete(pwFail.keys().next().value);
  // Global tally (rolling window): withhold the challenge for 10 min once too many wrong answers pile up in any
  // 10 minutes. A fixed window let a burst straddle the reset and get nearly twice the budget.
  const now = Date.now();
  const g = pwGlobalFail[pwPath(id)];
  g.times = g.times.filter((t) => now - t < PW_GLOBAL_WINDOW);
  g.times.push(now);
  if (g.times.length >= PW_GLOBAL_MAX) g.until = now + PW_GLOBAL_WINDOW;
}

async function handleIncoming(msg) {
  // With the service running, the service's host answers for this PC under its ID; this app only controls others.
  // A LAN request still lands here: the service's host doesn't listen on the LAN port, this app does (password only).
  if (svcId !== null && !lanIn(msg.fromId)) { sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: svcId ? `PC ini memakai layanan TryDesk. Sambung ke ID ${svcId}` : "PC ini memakai layanan TryDesk" }); return; }
  if (updateRequired) { sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: "PC tujuan memakai versi TryDesk lama yang wajib diperbarui" }); return; }
  // The macOS and Linux builds can control other PCs but can't be controlled (screen capture + input are Windows code).
  if (viewerOnlyDesktop()) { sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: isMacViewer() ? "Perangkat ini memakai TryDesk untuk macOS, yang hanya bisa mengontrol PC Windows" : "PC ini memakai TryDesk untuk Linux, yang saat ini hanya bisa mengontrol PC lain" }); return; }
  // An accept dialog or password challenge is already in flight for another requester, reject this
  // one instead of stacking (which would corrupt state and double-start a session).
  // Exception: a LAN password round in progress never makes the PC "busy" for someone asking by ID, a stranger on
  // the network could otherwise keep it busy for everyone. The LAN requester gives way and can try again.
  if (pendingChallenge && lanIn(pendingChallenge.fromId) && !lanIn(msg.fromId) && !pendingChallenge.settle && !acceptPending) {
    const pc = pendingChallenge; clearTimeout(pc._t); pendingChallenge = null;
    sendSignal({ type: "connection-rejected", targetId: pc.fromId, reason: "Remote desktop sedang sibuk" });
  }
  if (acceptPending || pendingChallenge) { sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: "Remote desktop sedang sibuk" }); return; }
  if (host) {
    // Only truly busy if the existing peer connection is still alive. Otherwise it's a stale
    // session left over from an abrupt drop, clear it and accept the new request (no restart needed).
    // No pc yet = the previous accept is still setting up capture: that is busy, not stale.
    const alive = !host.pc || ["new", "connecting", "connected"].includes(host.pc.connectionState);
    if (alive) { sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: "Remote desktop sedang sibuk" }); return; }
    closeSession(host, false);
  }
  // Brute-force cool-down after repeated wrong passwords.
  if (pwBlocked(msg.fromId)) { sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: "Terlalu banyak percobaan, coba lagi nanti" }); return; }

  const savedHash = store.get("accessPasswordHash");
  // Over LAN nobody vouches for the requester (no server, no ID): only the access password lets it in.
  if (lanIn(msg.fromId)) {
    const why = !lanHostOn ? "Koneksi LAN tidak diaktifkan di PC tujuan"
      : !(savedHash && savedHash.includes(":")) ? "PC tujuan belum memasang password akses, koneksi lewat IP membutuhkan password"
      : !lanPwStrong() ? `PC tujuan perlu password akses minimal ${LAN_PW_MIN} karakter untuk koneksi lewat IP`
      : pwGlobalBlocked(msg.fromId) ? "Terlalu banyak percobaan, coba lagi nanti" : "";
    if (why) { sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: why }); return; }
  }
  if (savedHash && savedHash.includes(":") && !pwGlobalBlocked(msg.fromId)) {
    // Password set → server-blind challenge. Relay only the salt + a one-shot nonce; we accept only
    // once the viewer returns a valid HMAC (proving it knows the password), the password never travels.
    const nonce = _hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const salt = savedHash.split(":")[0];
    pendingChallenge = { fromId: msg.fromId, fromName: msg.fromName, nonce, salt, round: 0, settle: null, started: Date.now() };
    pendingChallenge._t = setTimeout(() => {
      if (pendingChallenge && pendingChallenge.fromId === msg.fromId) {
        sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: "Waktu verifikasi habis" });
        pendingChallenge = null;
      }
    }, 30000);
    sendSignal({ type: "connection-challenge", targetId: msg.fromId, salt, nonce });
    prewarmCapture(msg.fromId);
    return;
  }
  // No password (or a legacy unsalted hash that can't do HMAC) → ask the user to accept manually.
  // (The service's host: the Accept card lists "Files" from the signed-in user's permission as it is NOW.)
  if (config && config.serviceHost) await svcPermsRefresh();
  const accepted = await askAccept(msg.fromId, msg.fromName);
  if (!accepted) { sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: declineReason() }); return; }
  await finishAccept(msg.fromId, false, msg.fromName);
}

// Verify the viewer's HMAC answer to our challenge (AnyDesk-style flow):
//  · right password → straight in (or it answers the Accept dialog if that is already up);
//  · no password / wrong one → the owner gets the Accept dialog AND the requester is asked again, so they can
//    still type the password on their side, whichever comes first wins. Wrong answers count toward the
//    per-requester cool-down; once that trips, the request is refused.
const PW_HINT = {
  empty: "Peminta tidak memasukkan password akses. Ia masih bisa mengetiknya, bila benar, koneksi langsung diterima.",
  emptyManual: "Peminta tidak memasukkan password akses.",
  wrong: "Peminta memasukkan password yang salah dan bisa mencoba lagi.",
  okManual: "Password benar, tetapi \"Terima koneksi otomatis\" dimatikan di Pengaturan, jadi tetap perlu konfirmasi.",
};
async function handleChallengeResponse(msg) {
  const pc = pendingChallenge;
  if (!pc || pc.fromId !== msg.fromId || !pc.nonce) return;   // no challenge outstanding for this peer
  clearTimeout(pc._t);
  const nonce = pc.nonce;
  pc.nonce = null; pc.round++;                                  // one answer per nonce
  const response = typeof msg.response === "string" ? msg.response : "";
  const expected = await expectedChallenge(store.get("accessPasswordHash"), nonce);
  const empty = !response || _constEq(response, await answerChallenge("", pc.salt, nonce));
  if (pendingChallenge !== pc) return;                          // cancelled / hosting stopped meanwhile
  // LAN switched off (or the password weakened) while this request was in its password rounds: it ends here.
  if (lanIn(pc.fromId) && (!lanHostOn || !lanPwStrong())) {
    pendingChallenge = null;
    sendSignal({ type: "connection-rejected", targetId: pc.fromId, reason: "Koneksi LAN tidak diaktifkan di PC tujuan" });
    return;
  }
  if (!empty && expected && _constEq(response, expected)) {
    pwFail.delete(pwKey(pc.fromId));
    pc.pwOk = true;   // the viewer holds the password key: this session signs its offer/answer (see finishAccept)
    prewarmRemember(pc.fromId);   // P7: its next request gets the screen prepared during the password round
    if (!autoAcceptWithPassword) { if (!pc.settle) askOwner(pc, PW_HINT.okManual); return; }
    if (pc.settle) pc.settle(true);
    else { pendingChallenge = null; await finishAccept(pc.fromId, true, pc.fromName); }
    return;
  }
  if (!empty) {
    await sleep(1000);                         // throttle: a wrong answer costs a fixed second, capping guess rate
    if (pendingChallenge !== pc) return;       // cancelled / hosting stopped during the delay
    pwFailed(pc.fromId);
    if (pwBlocked(pc.fromId) || pwGlobalBlocked(pc.fromId)) {
      const why = "Terlalu banyak percobaan, coba lagi nanti";
      if (pc.settle) pc.settle(false, why);
      else { pendingChallenge = null; sendSignal({ type: "connection-rejected", targetId: pc.fromId, reason: why }); }
      return;
    }
  }
  // LAN: no Accept dialog for a stranger on the network, the requester simply gets asked for the password again.
  // An empty answer after the first round counts as a wrong one too (an idle requester must not hold the PC), and
  // the whole exchange ends after 90 s or 8 rounds, matching the socket's own 90 s limit in main.js.
  if (lanIn(pc.fromId)) {
    if (empty && pc.round > 1) {
      pwFailed(pc.fromId);
      if (pwBlocked(pc.fromId) || pwGlobalBlocked(pc.fromId)) { pendingChallenge = null; sendSignal({ type: "connection-rejected", targetId: pc.fromId, reason: "Terlalu banyak percobaan, coba lagi nanti" }); return; }
    }
    const left = 90000 - (Date.now() - (pc.started || Date.now()));
    if (pc.round >= 8 || left <= 0) { pendingChallenge = null; sendSignal({ type: "connection-rejected", targetId: pc.fromId, reason: pc.round >= 8 ? "Terlalu banyak percobaan, coba lagi nanti" : "Waktu verifikasi habis" }); return; }
    pc.nonce = _hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
    pc._t = setTimeout(() => { if (pendingChallenge === pc) { pendingChallenge = null; sendSignal({ type: "connection-rejected", targetId: pc.fromId, reason: "Waktu verifikasi habis" }); } }, left);
    sendSignal({ type: "connection-challenge", targetId: pc.fromId, salt: pc.salt, nonce: pc.nonce });
    return;
  }
  const hint = !empty ? PW_HINT.wrong : autoAcceptWithPassword ? PW_HINT.empty : PW_HINT.emptyManual;
  if (!pc.settle) askOwner(pc, hint); else if (!empty) setAcceptHint(hint);
  // Ask the requester again only when a password would still get them in. After an empty answer only on the
  // first round: an older TryDesk answers every challenge "empty" by itself, which would ping-pong forever.
  if (autoAcceptWithPassword && (!empty || pc.round === 1) && pc.round < 8) {
    pc.nonce = _hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
    sendSignal({ type: "connection-challenge", targetId: pc.fromId, salt: pc.salt, nonce: pc.nonce });
  }
}

// The owner's Accept dialog for a password-protected request. A correct password typed meanwhile settles it.
async function askOwner(pc, hint) {
  let reason = "";
  const asked = askAccept(pc.fromId, pc.fromName, hint);
  pc.settle = (ok, why) => { if (why) reason = why; if (acceptDlgSettle) acceptDlgSettle(ok); };
  const ok = await asked;
  if (!reason) reason = declineReason();
  if (pendingChallenge === pc) pendingChallenge = null;
  // Signed only when the password was proven; the owner clicking Accept for an empty or wrong one is a plain session.
  if (ok) await finishAccept(pc.fromId, !!pc.pwOk, pc.fromName);
  else sendSignal({ type: "connection-rejected", targetId: pc.fromId, reason });
}

// ─── P7: the screen is prepared while the password is checked (Windows service, owner 14 Nov 2026) ───
// Through the service the first picture waited for the password round, then the service's own steps, then Chromium's
// capture (1.3 s on a PC with a graphics card, 3.3 s in Windows Sandbox). The capture now starts as soon as a request is
// asked for the password, and finishAccept takes it over once the password is right. Nothing leaves this PC before that:
// the stream is attached to no connection, and it stops as soon as the request ends any other way (wrong password,
// cancelled, timed out, refused).
let _prewarm = null;   // { fromId, ready: Promise<cap|null>, cap, dead, watch }
// A monitor that went dark for lack of input is woken first (main.js "wake-display": with the monitor off the capture
// started 4 s later and then crawled at 2-4 fps until someone touched the PC). Woken again at the accept. It resolves once
// Windows has the monitors back as they were (up to ~4 s after a monitor that was off; at once for one that was on):
// a capture started while Windows re-adds them saw one "Entire screen" for two monitors, or failed.
const wakeDisplay = async () => { try { return await window.electronAPI.wakeDisplay?.(); } catch { return null; } };
// Only for a requester that got in with this password before (within PREWARM_DAYS): anyone who knows the ID could
// otherwise light up the monitor and start a capture with every request, over and over (independent review, 14 Nov).
// Kept by the service's host only, in its own data folder: up to 20 IDs with the time of their last session.
// Each entry carries the password it was proven with (its salt, which every challenge shows anyway): a new password
// empties the list.
const PREWARM_DAYS = 30;
const prewarmPwTag = () => String(store.get("accessPasswordHash") || "").split(":")[0].slice(0, 16);
function prewarmPeers() {
  try {
    const a = JSON.parse(store.get("svc.knownPeers") || "[]"), tag = prewarmPwTag();
    return Array.isArray(a) ? a.filter((x) => x && typeof x.id === "string" && x.pw === tag && Date.now() - Number(x.at) < PREWARM_DAYS * 864e5) : [];
  } catch { return []; }
}
function prewarmRemember(fromId) {
  if (!(config && config.serviceHost)) return;
  const id = String(fromId), a = prewarmPeers().filter((x) => x.id !== id);
  a.push({ id, at: Date.now(), pw: prewarmPwTag() });
  try { store.set("svc.knownPeers", JSON.stringify(a.slice(-20))); } catch {}
}
let _prewarmAt = -1e9;
function prewarmCapture(fromId) {
  if (!(config && config.serviceHost) || host) return;
  if (_prewarm && _prewarm.fromId === fromId && !_prewarm.dead) return;   // the same requester asking again: keep it
  if (!prewarmPeers().some((x) => x.id === String(fromId))) return;
  if (performance.now() - _prewarmAt < 10000) return;   // at most one every 10 s, whoever asks
  _prewarmAt = performance.now();
  prewarmDrop(_prewarm);
  const pw = _prewarm = { fromId, cap: null, dead: false, watch: 0, capStarted: false };
  pw.ready = (async () => {
    try {
      await wakeDisplay();
      if (pw.dead) return null;
      // Lock or login screen up: Chromium's capture would only see black there; the session takes the helper instead.
      if (await window.electronAPI.secureDesktopNow?.().catch(() => false)) return null;
      pw.capStarted = true;   // from here a change of the screens makes this capture stale (onDisplayChanged)
      const t = { monitors: await window.electronAPI.getMonitors(), currentMonitor: 0 };
      t.currentMonitor = Math.max(0, t.monitors.findIndex((m) => m.primary));
      const cap = await hostCapture(t, t.currentMonitor, false);   // P16: the sound follows the picture (hostSoundLater)
      if (pw.dead) { cap.stream.getTracks().forEach((x) => x.stop()); return null; }
      pw.cap = { stream: cap.stream, m: cap.m, monitors: t.monitors, currentMonitor: t.currentMonitor };
      return pw.cap;
    } catch (e) { capLog("prepared capture failed (it starts again after the password): " + (e && e.message)); return null; }
  })();
  // The request is gone without an accept: release the screen. (finishAccept takes it in the same tick it clears the
  // request, so this never races a session that is starting.)
  pw.watch = setInterval(() => {
    if (_prewarm !== pw) { clearInterval(pw.watch); return; }
    if (!(pendingChallenge && pendingChallenge.fromId === fromId) && !(acceptPending && acceptFromId === fromId)) prewarmDrop(pw);
  }, 1000);
}
function prewarmDrop(pw) {
  if (!pw || pw.dead) return;
  pw.dead = true; clearInterval(pw.watch);
  if (_prewarm === pw) _prewarm = null;
  if (pw.cap) pw.cap.stream.getTracks().forEach((t) => t.stop());
}
// finishAccept's first step: the prepared capture for this requester (any other one is released).
function prewarmTake(fromId) {
  const pw = _prewarm;
  if (!pw) return null;
  if (pw.fromId !== fromId) { prewarmDrop(pw); return null; }
  _prewarm = null; clearInterval(pw.watch);
  return pw;
}

// Build the host session + capture + peer once a requester is authorized (manual accept or challenge).
async function finishAccept(fromId, viaPassword, fromName = "") {
  const pw = prewarmTake(fromId);   // P7: the screen prepared during the password round (service only)
  const woke = wakeDisplay();       // P7: a dark monitor (PC left alone) made the start crawl; awaited before the capture
  if (config && config.serviceHost) await svcPermsRefresh();   // what the viewer is told it may do (sendMonitors)
  const sess = new Session(fromId, "host");
  sess.fromName = fromName;
  host = sess;
  // A session that proved the password checks the viewer's offers against the password key (LAN and ID path alike,
  // see sendSignal). A LAN socket also outlives main.js's 90 s limit for requests that never became a session.
  if (lanIn(fromId) || viaPassword) sess.lanKey = String(store.get("accessPasswordHash") || "").split(":")[1] || "";
  if (lanIn(fromId)) { try { window.electronAPI.lanKeep(fromId); } catch {} }
  sessLog(sess, "accepted here, starting screen capture");
  try {
    // A screen that is being replaced right now (RDP window going full screen / reconnecting) can't be captured
    // for a moment: try a few times before telling the viewer "gagal membagikan layar" (rented PC, 2026-11-02).
    let cap = null, lastErr = null;
    // Service host in a disconnected session (RDP closed): nothing is drawn there; move it to the console first.
    if (config && config.serviceHost) {
      await serviceFollowUserLang();   // a password session skips the Accept dialog: the language comes here then
      // "Remote session active" + Disconnect: in the user's own TryDesk when it runs (svcPublish below), else here.
      if (!svcRouted()) serviceShowWindow();
      try {
        const r = await window.electronAPI.serviceAttachConsole();
        sessLog(sess, r.ok ? "session moved to the console" : "session stays: " + r.why);
        // A prepared capture was of the disconnected session (nothing drawn there): it starts again below.
        if (r.ok) { prewarmDrop(pw); await new Promise((res) => setTimeout(res, 3000)); }
      } catch {}
    }
    // P7: the monitors back from being off before anything is captured (at once when they were on).
    await woke;
    // P7: take the capture prepared during the password round (still starting: waiting for it beats starting over).
    if (pw) {
      const got = pw.dead ? null : await pw.ready;
      if (got && !pw.dead && host === sess) {
        pw.dead = true;
        sess.monitors = got.monitors; sess.currentMonitor = got.currentMonitor;
        cap = { stream: got.stream, m: got.m };
        sessLog(sess, "screen capture prepared during the password check");
      } else prewarmDrop(pw);
    }
    // Run as administrator, Chromium's capture can't start (see nativeCaptureStream): the helper goes first there. The
    // service's host (SYSTEM) also counts as elevated, but its Chromium capture works and keeps the fast path.
    const adminHost = !(config && config.serviceHost) && (await window.electronAPI.isElevated().catch(() => false));
    // A virtual machine (Windows Sandbox: its user is always an administrator) is the exception. There the helper only
    // gives plain frames (no hardware encoder, at most 8 a second: measured 4-5 fps), while Chromium's capture works
    // run as administrator too (measured ~30 fps, the Sandbox screen's own limit). Chromium goes first there, the
    // helper stays the fallback (owner 19 Nov: "tes dengan windows sandbox ... lag dan drop FPS", LAN too).
    const adminHelperFirst = adminHost && !(config && config.vmGuest);
    // The service's host while the lock screen, the login screen (after a restart) or a UAC prompt holds the screen:
    // only the helper (SYSTEM, follows that desktop) sees it. It goes first, and the session stays on it until that
    // screen is gone (onSecureDesktop below swaps back to Chromium's capture then, as for a UAC prompt).
    const secureNow = !!(config && config.serviceHost) && !!(await window.electronAPI.secureDesktopNow?.().catch(() => false));
    if (secureNow && !cap) {
      sess.monitors = await window.electronAPI.getMonitors();
      sess.currentMonitor = Math.max(0, sess.monitors.findIndex((m) => m.primary));
      const m = sess.monitors[sess.currentMonitor] || sess.monitors[0];
      try { cap = { stream: await nativeCaptureStream(m, true), m }; sess.forceNative = true; sessLog(sess, "lock / login screen up: native capture helper"); }
      catch (e) { lastErr = e; sessLog(sess, "lock / login screen up, native capture failed: " + (e && e.message) + ", trying Chromium's capture"); }
    }
    if (adminHelperFirst) {
      sess.monitors = await window.electronAPI.getMonitors();
      sess.currentMonitor = Math.max(0, sess.monitors.findIndex((m) => m.primary));
      const m = sess.monitors[sess.currentMonitor] || sess.monitors[0];
      try { cap = { stream: await nativeCaptureStream(m, true), m }; sess.nativeFallback = true; sessLog(sess, "running as administrator: native capture helper"); }
      catch (e) { lastErr = e; sessLog(sess, "running as administrator, native capture failed: " + (e && e.message) + ", trying Chromium's capture"); }
    }
    // Two tries here (each can take ~6 s), then the helper below, which retries the screen on its own.
    for (let i = 0; i < 2 && !cap && host === sess; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1500));
      try {
        sess.monitors = await window.electronAPI.getMonitors();
        sess.currentMonitor = Math.max(0, sess.monitors.findIndex((m) => m.primary));
        cap = await hostCapture(sess, sess.currentMonitor, false);   // P16: the sound follows the picture (hostSoundLater)
      } catch (e) { lastErr = e; sessLog(sess, `capture try ${i + 1} failed: ${e && e.message}`); }
    }
    // Chromium's capture never came up: take the picture from the DXGI helper instead (see nativeCaptureStream).
    if (!cap && host === sess && !adminHelperFirst) {
      try {
        const m = sess.monitors[sess.currentMonitor] || sess.monitors[0];
        cap = { stream: await nativeCaptureStream(m, true), m };
        sess.nativeFallback = true;
        sessLog(sess, "Chromium capture failed, using the native capture helper");
      } catch (e) { sessLog(sess, "native capture fallback failed: " + (e && e.message)); }
    }
    if (!cap) throw lastErr || new Error("capture failed");
    const { stream, m } = cap;
    // Hosting was stopped while capture was starting, release the screen instead of streaming it to nobody.
    if (host !== sess) { stream.getTracks().forEach((t) => t.stop()); if (nativeAudio && stream.getAudioTracks().includes(nativeAudio.gen)) stopNativeAudio(); return; }
    sess.localStream = stream;
    sess.videoTrack = stream.getVideoTracks()[0];
    sess.audioAvailable = stream.getAudioTracks().length > 0;
    hostCaptureHeight = sess.videoTrack.getSettings().height || Math.round(m.height * m.scaleFactor);
    window.electronAPI.setCaptureDisplay(m);
    // One-time hint: an un-elevated host can't control admin/UAC windows (they "freeze" remote control).
    if (!_adminTipShown) { _adminTipShown = true; try { window.electronAPI.isElevated().then((el) => { if (!el) showToast("Tip: agar jendela admin bisa dikontrol, jalankan TryDesk sebagai administrator (Pengaturan → Keamanan)"); }).catch(() => {}); } catch {} }
  } catch (err) {
    prewarmDrop(pw);
    console.error(err);
    sessLog(sess, "no screen capture: " + (err && err.message));
    // This attempt was already closed (the viewer cancelled while the screen was being prepared). If the same viewer is
    // back with a new session, rejecting or closing here would cut that one off: nothing left to do.
    if (host !== sess) return;
    const admin = !(config && config.serviceHost) && (await window.electronAPI.isElevated().catch(() => false));
    // Said on this PC too: the person here can fix it (start TryDesk without "Run as administrator").
    if (admin) showToast(HOST_ADMIN_NO_CAPTURE_HERE);
    sendSignal({ type: "connection-rejected", targetId: fromId, reason: admin ? HOST_ADMIN_NO_CAPTURE : "Remote gagal membagikan layar" });
    closeSession(sess, false); return;
  }

  createPeer(sess);
  const pc = sess.pc;
  sess.localStream.getTracks().forEach((t) => pc.addTrack(t, sess.localStream));
  // P16: the PC's sound comes after the picture (hostSoundLater). A silent stand-in track now gives the answer its audio
  // sender, which the real sound replaces later without a new offer. (The helper's sessions bring their own sound.)
  if (!sess.localStream.getAudioTracks().length && !sess.nativeFallback && typeof MediaStreamTrackGenerator !== "undefined") {
    try { const ph = new MediaStreamTrackGenerator({ kind: "audio" }); hostSoundLater(sess, pc.addTrack(ph, sess.localStream), ph); }
    catch (e) { capLog("sound: no stand-in track (" + (e && e.message) + ")"); }
  }
  // Configure the encoder up-front (maintain-resolution + full bitrate) so the first frames are
  // already full native resolution, instead of waiting for the viewer's quality message to arrive.
  applyQualityToSender(sess, hostQuality);
  pc.ondatachannel = (e) => {
    const ch = e.channel;
    if (typeof ch.label === "string" && ch.label.startsWith("cf:")) { chatRecvChannel(sess, ch); return; }   // a picture / file in the chat
    if (ch.label === "file") {
      sess.fileChannel = ch;
      sess.fileChannel.binaryType = "arraybuffer";
      setupFileChannel(sess, sess.fileChannel);
    } else if (ch.label === "fast") {
      // The viewer's channel for fast-path frames (see "Fast path"); only this host writes to it.
      sess.fastChannel = ch;
      ch.binaryType = "arraybuffer";
      ch.onclose = () => { if (sess.fastChannel === ch) { sess.fastChannel = null; hostFastStop(sess, "channel closed"); } };
    } else if (ch.label === "move") {
      // Pointer position only, unordered and never resent: a lost or late move is just skipped (the next one
      // carries the newer position), so one dropped packet no longer stalls every move behind it.
      sess.moveChannel = ch;
      ch.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } if (ev && ev.action === "mousemove") onHostMove(sess, ev); };
    } else {
      sess.dataChannel = ch;
      sess.dataChannel.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } onCtrlMessage(sess, ev); };
      // caps: tells a 1.2.3+ viewer this host takes pointer moves on the separate "move" channel. An older
      // viewer ignores it; an older host never sends it, so a new viewer keeps everything on this channel.
      // fast:1 = this host can run the fast path (Windows, helper present, not turned off); an older viewer ignores it.
      // chatfiles: 1 = this host takes pictures / files in the chat on "cf:" channels (chatRecvChannel)
      const onCtrlOpen = () => { let fast = 0; try { fast = _fastAvail && fastEnabled() ? 1 : 0; } catch {} try { sess.dataChannel.send(JSON.stringify({ __ctrl: "caps", move: 1, fast, chatfiles: 1, lock: config && config.serviceHost ? 0 : 1, sas: config && config.serviceHost ? 1 : 0, elev: hostElevOk() ? 1 : 0 })); if (_hostSecureDesk || sess.forceNative) sess.dataChannel.send(JSON.stringify({ __ctrl: "secure-desk", on: true })); if (_hostBlindDesk) sess.dataChannel.send(JSON.stringify({ __ctrl: "blind-desk", on: true })); } catch {} startClipboardSync(sess); sendMonitors(sess); try { window.electronAPI.requestCursorState && window.electronAPI.requestCursorState(); } catch {} try { window.electronAPI.requestAdminWindowState?.(); } catch {} };
      sess.dataChannel.onopen = onCtrlOpen;
      if (sess.dataChannel.readyState === "open") onCtrlOpen();
    }
  };

  paintHostingWho(sess.peerId, sess.fromName);
  showScreen("hosting");
  startHostingTimer();
  if (config && config.serviceHost) { svcChat = []; svcPublish({ state: "session", sess: { id: String(sess.peerId), name: stripBidi(String(sess.fromName || "")).trim(), since: Date.now() } }); }
  sendSignal({ type: "connection-accepted", targetId: sess.peerId });
  // If the viewer never sets up the call (it vanished between asking and our accept), don't stay "being
  // controlled", capturing the screen and turning everyone else away as busy. Only for a call that never
  // connected: a live one that is briefly "disconnected" at 30 s gets the normal 5 s grace instead.
  setTimeout(() => { if (host === sess && !sess.everConnected && (!sess.pc || sess.pc.connectionState !== "connected")) closeSession(sess, false); }, 30000);
  window.electronAPI.setHostingState(true);
  // Settings: keep the display awake while being controlled; end the session after the chosen time limit.
  if (prefGet("preventSleep")) window.electronAPI.setPowerSave(true);
  sess.hostStart = Date.now();
  armSessionLimit(sess);
  startLinkControl(sess);
}

// ─── Weak links: sharp picture first, frame rate second (like Chrome Remote Desktop) ───
// Before (measured 12 Nov on a throttled link, 2 Mbps / 200 ms / 2 % loss): a thin or slow link switched the encoder to
// "balanced", and WebRTC kept ~56 fps by cutting the picture to 1280x720, then 960x540: screen text became unreadable
// ("burik") and stayed so. Now the host watches, every second, how sharp the encoder's frames really are (their QP,
// as WebRTC reports it) next to WebRTC's own bandwidth estimate:
//  · frames getting coarse (QP above the codec's "blurry" line) → fewer frames a second, so each gets more bits;
//  · frames fine (QP below the "sharp" line) for 3 s → more frames again, up to the chosen fps;
//  · a hard ceiling from the estimate (never fewer than LINK_MIN_BPP bits a pixel per frame) reacts at once when the
//    link suddenly drops;
//  · only at LINK_MIN_FPS and still coarse for 3 s does the picture get smaller (1/1.5, 1/2, 1/3 of the size), and it
//    grows back after 8 s of room.
// A still desktop sends few, cheap frames, so it keeps the full frame rate; scrolling over a thin link drops to a
// lower rate with readable text. A 5 Mbps link keeps ~56 fps (QP ~21, sharp already); 2 Mbps settles at ~15-20.
const LINK_MIN_FPS = 5;
const WEBRTC_RULES_FPS = 60;   // see startLinkControl: the frame rate its sharpness rules work up to on WebRTC
const LINK_WARMUP_MS = 6000;   // no QP-based frame-rate cuts this long after the session starts (see startLinkControl)
const LINK_SCALES = [1, 1.5, 2, 3];
const LINK_MIN_BPP = 0.02;   // bits a frame per pixel at the least (1920x1080: ~41 kbit), whatever the QP says
// [sharp, blurry] QP lines per codec (H.264 0-51, VP8 0-127, VP9 and AV1 0-255), a little below WebRTC's own
// quality-scaler limits so text stays readable.
const LINK_QP = { h264: [26, 33], h265: [26, 33], vp8: [45, 70], vp9: [100, 150], av1: [100, 150] };   // H.265: same 0-51 scale as H.264
function startLinkControl(sess) {
  clearInterval(sess._qlTimer);
  sess.linkFps = 0; sess.linkScale = 1;           // 0 = no cap from the link
  sess._qpHi = 0; sess._qpLo = 0; sess._scaleUp = 0; sess._scaleDown = 0; sess._bwUp = 0; sess._lFe = null; sess._lcStart = Date.now();
  sess._qlTimer = setInterval(async () => {
    if (host !== sess || !sess.pc) { clearInterval(sess._qlTimer); return; }
    if (sess.fastActive) {   // the fast path carries the picture (its own rate control)
      sess._lFe = null;
      // A cap from before it started must not come back when WebRTC takes over again (5 fps at half size after a
      // short dip): start that from the user's choice.
      if (sess.linkFps || sess.linkScale !== 1) { sess.linkFps = 0; sess.linkScale = 1; applyQualityToSender(sess, { _link: true }); }
      // The health line goes on during the fast path too (what it is set to, and how its link does).
      if (!sess._hlogAt) sess._hlogAt = Date.now();
      else if (Date.now() - sess._hlogAt >= 10000) {
        sess._hlogAt = Date.now();
        sessLog(sess, `health (sending): fast path on, up to ${fastHostRate(sess).fps} fps, ${Math.round(sess.fastMbps || 0)} Mbps now, ${sess.fastUdpUp ? "own UDP link" : "data channel"}, lost on the way ${sess.fastDrops || 0}${adminNative(sess) ? ", helper borrowed from the administrator capture" : ""}`);
      }
      return;
    }
    let out = null, pair = null, tp = null, st;
    try { st = await sess.pc.getStats(); } catch { return; }
    // Only the streamed monitor's sender: with "Semua monitor" the other monitors have senders of their own.
    const mainMid = (sess.pc.getTransceivers().find((t) => t.sender && t.sender.track && t.sender.track === sess.videoTrack) || {}).mid;
    st.forEach((s) => { if (s.type === "outbound-rtp" && s.kind === "video" && (!mainMid || s.mid == null || s.mid === mainMid)) { if (!out || s.mid === mainMid) out = s; } if (s.type === "transport" && s.selectedCandidatePairId) tp = s; });
    st.forEach((s) => { if (s.type === "candidate-pair" && ((tp && s.id === tp.selectedCandidatePairId) || (!tp && !pair && s.nominated && s.state === "succeeded"))) pair = s; });
    noteRtt(sess, pair);   // for the fast path's LAN check (fastLinkInfo)
    const bwe = pair && pair.availableOutgoingBitrate;
    if (!out || !(bwe > 0) || out.framesEncoded == null) return;
    // Frames and their average QP in the last second.
    const fe = out.framesEncoded, qs = out.qpSum;
    const dF = sess._lFe == null ? 0 : fe - sess._lFe, dQ = sess._lQs == null || qs == null ? 0 : qs - sess._lQs;
    sess._lFe = fe; sess._lQs = qs;
    const qp = dF >= 3 && qs != null ? dQ / dF : null;
    const mime = ((out.codecId && st.get(out.codecId)) || {}).mimeType || "";
    const [qpLo, qpHi] = LINK_QP[(mime.split("/")[1] || "").toLowerCase()] || LINK_QP.h264;
    const capH = hostCaptureHeight || out.frameHeight || 1080;
    const capW = (sess.videoTrack && sess.videoTrack.getSettings().width) || Math.round(capH * 16 / 9);
    const userScale = hostQuality.resHeight > 0 && capH > hostQuality.resHeight ? capH / hostQuality.resHeight : 1;
    // The rules below treat a choice above 60 as 60. Chromium's capture gives ~56 new pictures a second (measured
    // 2 Nov), so on WebRTC a high-fps choice only switched to "frames first" and made text blurry on a weak link
    // without adding frames. A cut never goes past what was chosen, and with no cut the encoder keeps the full choice.
    const userFps = Math.min(hostQuality.fps, hostCaptureFps || hostQuality.fps, WEBRTC_RULES_FPS);
    const bwCapAt = (scale) => Math.floor((bwe * 0.85) / (LINK_MIN_BPP * (capW * capH) / (userScale * userScale * scale * scale)));
    let scale = sess.linkScale, cap = sess.linkFps || userFps;
    // P11: just after the fast path handed the picture back (hostFastStop) the estimate is the one from before it, or one
    // a flooded link crushed that the viewer's new start rate (webrtcSeed) is about to replace: no cuts from it, nor from
    // the coarse first frames, for 3 s (measured 14 Nov: one reading of 84 kbps held WebRTC at 5 fps for ~20 s while the
    // estimate was already back at 3.7 Mbps).
    const resumed = Date.now() - (sess._lcResumeAt || 0) < 3000;
    const bwCap = resumed ? Infinity : bwCapAt(scale);
    if (bwCap < cap) cap = Math.max(LINK_MIN_FPS, bwCap);                 // the link suddenly got thinner
    // High-fps presets trade no frames for sharpness: their cap is only what the link carries, every second, so it
    // also comes back up as soon as the estimate does (it could only ever go down).
    // Up only by a real step (10 %, or to the user's choice), so the encoder isn't re-set every second for a few fps.
    if (userFps >= 120) {
      const want = Math.min(userFps, Math.max(LINK_MIN_FPS, bwCap));
      if (want < cap || want >= userFps || want >= cap * 1.1) cap = want;
    }
    // Sharpness only trades frames where the link is the limit: a fast link keeps a fair frame rate whatever the QP
    // (a game at 10 Mbps keeps 30 fps or more), and the high-fps presets (Ultra, Gaming, Maksimal) keep motion first.
    const qpFloor = Math.min(userFps, Math.max(LINK_MIN_FPS, Math.min(30, Math.floor(bwe / 250000))));
    // Not in the first seconds ON A FAST LINK: there the first frames (the keyframe, the encoder still ramping up from
    // the start bitrate) are coarse only because it is starting, and cutting the frame rate took 9-15 s to undo
    // (service sessions without the fast path started choppy, 13 Nov). On a slow or far link (round trip 30 ms and
    // up) the cut stays from the first second: measured 13 Nov, holding it there too let the start flood a 2 Mbps link
    // (9 fps instead of 29) and kept the picture at 1280x720 after the link recovered.
    const rtt = pair && pair.currentRoundTripTime;
    const warming = Date.now() - (sess._lcStart || 0) < LINK_WARMUP_MS && rtt != null && rtt < 0.03;
    // A safety net for the high-fps presets (audit 19 Nov, user report "ngacir tapi layar blurry" over a weak link
    // between islands): their frames went down to 0.02 bit a pixel (~42 kbit for 1080p at 3 Mbps, QP 40-51, smeared
    // text). Frames far above the blurry line for 2 s: at most what gives 0.06 bit a pixel, never under 30 fps, for at
    // least 10 s after the last such reading. Motion still comes first; text stays readable.
    if (userFps >= 120 && qp != null && qp > qpHi + 6 && !warming && !resumed) { if (++sess._hfBad >= 2) sess._hfNetUntil = Date.now() + 10000; }
    else sess._hfBad = 0;
    if (userFps >= 120 && Date.now() < (sess._hfNetUntil || 0)) {
      const sharpCap = Math.floor((bwe * 0.85) / (0.06 * (capW * capH) / (userScale * userScale * scale * scale)));
      cap = Math.min(cap, Math.max(30, sharpCap));
    }
    if (qp != null && qp > qpHi && userFps < 120 && !warming && !resumed) {
      sess._qpLo = 0; sess._bwUp = 0;
      // Coarse: fewer frames (well above the line: at once and by half; just above: after 2 s, by 30 %).
      if (qp > qpHi + 6 || ++sess._qpHi >= 2) { cap = Math.min(cap, Math.max(qpFloor, Math.round(dF * (qp > qpHi + 6 ? 0.5 : 0.7)))); sess._qpHi = 0; }
      if (cap <= LINK_MIN_FPS && dF <= LINK_MIN_FPS + 1) { if (++sess._scaleDown >= 3) { scale = LINK_SCALES[Math.min(LINK_SCALES.length - 1, LINK_SCALES.indexOf(scale) + 1)]; sess._scaleDown = 0; } }
    } else if (qp != null && qp < qpLo) {
      sess._qpHi = 0; sess._scaleDown = 0; sess._bwUp = 0;
      if (++sess._qpLo >= 3 && cap < userFps) { cap = Math.min(userFps, Math.max(LINK_MIN_FPS, bwCap), Math.max(cap + 2, Math.round(cap * 1.3))); sess._qpLo = 0; }
      // Room again at a smaller size: one step bigger after 8 s, if the link can carry LINK_MIN_FPS there (after 4 s
      // when it carries 30 frames there: plenty of room, audit 19 Nov).
      const i = LINK_SCALES.indexOf(scale);
      if (i > 0 && bwCapAt(LINK_SCALES[i - 1]) >= LINK_MIN_FPS * 2) { if (++sess._scaleUp >= (bwCapAt(LINK_SCALES[i - 1]) >= 30 ? 4 : 8)) { scale = LINK_SCALES[i - 1]; sess._scaleUp = 0; } } else sess._scaleUp = 0;
    } else if (qp == null && scale !== 1) {
      // A still screen (under 3 frames a second, so no QP): the picture stayed small long after the link was back,
      // since only sharp frames could grow it and a still screen sends none (audit 19 Nov). A still screen costs almost
      // nothing, so with room for 15 frames at the bigger size for 3 s it grows one step.
      sess._qpHi = 0; sess._qpLo = 0; sess._scaleDown = 0; sess._bwUp = 0;
      const i = LINK_SCALES.indexOf(scale);
      if (i > 0 && bwCapAt(LINK_SCALES[i - 1]) >= 15) { if (++sess._stillUp >= 3) { scale = LINK_SCALES[i - 1]; sess._stillUp = 0; } } else sess._stillUp = 0;
    } else {
      sess._qpHi = 0; sess._qpLo = 0; sess._scaleDown = 0;
      // QP in the middle band (games, video sit there): the cap stayed where a dip had put it for the whole session,
      // even on a fast link. (An encoder that never reports a QP is left as it was: the estimate cap above still lifts.) Lift it only on a link with clear room (at least 30 frames at this
      // size and twice the current cap) for 3 s. Measured 13 Nov: a looser rule (30 % room) also fired on a 1 Mbps
      // link, raised the frame rate too early and pushed the picture down to 960x540.
      // Only at full size: while the picture is still smaller, the size comes back first (the QP-low branch), as
      // before. Lifting fps there kept the QP in the middle band and the picture at 1280x720 after the link recovered.
      // And only in the lower half of the band: lifting at a QP near the line (measured 13 Nov, clean link without
      // the fast path) brought the frames back before the bitrate estimate had grown, and the delay went 120 -> 300 ms.
      // (19 Nov: only near the sharp line, qpLo + 2: from the middle of the band the lift kept pulling text back up to
      // QP 30-33, soft on a thin link)
      if (qp != null && qp <= qpLo + 2 && scale === 1 && cap < userFps && bwCap >= Math.max(30, cap * 2)) { if (++sess._bwUp >= 3) { cap = Math.min(userFps, bwCap, Math.max(cap + 2, Math.round(cap * 1.3))); sess._bwUp = 0; } }
      else sess._bwUp = 0;
    }
    // Every 10 s: the sending side's view in the log (what limits the picture: "cpu" = this PC's encoder can't keep
    // up, "bandwidth" = the link), for lag reports (owner 19 Nov).
    if (!sess._hlogAt) sess._hlogAt = Date.now();
    else if (Date.now() - sess._hlogAt >= 10000) {
      sess._hlogAt = Date.now();
      sessLog(sess, `health (sending): ${Math.round(out.framesPerSecond || 0)} fps sent at ${out.frameWidth || "?"}x${out.frameHeight || "?"}, limit ${out.qualityLimitationReason || "none"}, estimate ${Math.round(bwe / 1000)} kbps, qp ${qp == null ? "-" : qp.toFixed(0)}, rtt ${rtt != null ? Math.round(rtt * 1000) : "?"} ms, encoder ${out.encoderImplementation || "?"}, cap ${sess.linkFps || userFps} fps size 1/${sess.linkScale || 1}, fast path ${sess.fastActive ? "on" : !fastEnabled() ? "turned off here" : _fastAvail ? "ready, not asked" : "no helper on this PC"}`);
    }
    const linkFps = cap >= userFps ? 0 : cap;
    if (linkFps !== sess.linkFps || scale !== sess.linkScale) {
      capLog(`link: estimate ${Math.round(bwe / 1000)} kbps, qp ${qp == null ? "-" : qp.toFixed(0)} -> ${linkFps || userFps} fps, size 1/${scale}`);
      sess.linkFps = linkFps; sess.linkScale = scale;
      applyQualityToSender(sess, { _link: true });
    }
  }, 1000);
}
// Settings → Keamanan → session time limit, counted from the start of the session; changing it while a session
// runs re-arms it. The viewer is told why it was cut off.
function armSessionLimit(sess) {
  if (!sess || sess.role !== "host") return;
  clearTimeout(sess.limitTimer);
  const limitMin = Number(prefGet("sessionLimit")) || 0;
  if (limitMin <= 0) return;
  const left = Math.max(1000, (sess.hostStart || Date.now()) + limitMin * 60 * 1000 - Date.now());
  sess.limitTimer = setTimeout(() => {
    if (host === sess) { showToast("Batas waktu sesi tercapai, koneksi diputus"); closeSession(sess, true, "Batas waktu sesi di PC remote tercapai, koneksi diputus"); }
  }, left);
}

async function onOffer(sess, offer) {
  await sess.pc.setRemoteDescription(offer);
  flushCandidates(sess);
  // "Semua monitor" (monMode): every video m-line after the first is one the viewer added for another monitor. They
  // are sent from here (sendonly); hostApplyMonMode puts that monitor's capture on them.
  const vids = sess.pc.getTransceivers().filter((t) => t.receiver && t.receiver.track && t.receiver.track.kind === "video");
  for (const t of vids.slice(1)) { try { if (t.direction !== "sendonly" && !t.stopped) t.direction = "sendonly"; } catch {} }
  const answer = await sess.pc.createAnswer();
  answer.sdp = boostStartBitrate(answer.sdp);   // host is the video sender, jump to full res immediately
  await sess.pc.setLocalDescription(answer);
  sendSignal({ type: "answer", targetId: sess.peerId, answer: sess.pc.localDescription });
  if (sess.monWant && sess.monWant.length) hostApplyMonMode(sess);
}

// Host-side access permissions, what an incoming remote may do to THIS machine. These are the
// authoritative gates (the viewer's own toggles can be bypassed by a modified client), loaded from
// Settings → Keamanan → Izin akses. See applyAccessSettings().
let allowInput = true, allowFileTransfer = true, allowClipboardPref = true, forceViewOnly = false;

// Control channel router (runs on both sides); bound per session at channel setup.
function onCtrlMessage(sess, ev) {
  if (!ev || typeof ev !== "object") return;   // reject null / non-object payloads
  if (ev.__ctrl === "quality") { if (sess.role === "host") applyQualityToSender(sess, ev); }
  // An older viewer (≤1.3.8) still says when its link looks bad. That switched the encoder to "balanced", which cut the
  // picture to 960x540 at full frame rate (unreadable text); the host's own link control (startLinkControl) decides now.
  else if (ev.__ctrl === "net-mode") { if (sess.role === "host") capLog(`viewer says link ${ev.degraded ? "bad" : "good"} (link control decides)`); }
  else if (ev.__ctrl === "clipboard") { applyRemoteClipboard(sess, ev.text); }
  else if (ev.__ctrl === "clip-files") { applyRemoteClipFiles(sess, ev.files); }
  else if (ev.__ctrl === "monitors") { if (sess.role === "viewer") showMonitors(sess, ev); }
  else if (ev.__ctrl === "select-monitor") { if (sess.role === "host") switchMonitor(sess, ev.index); }
  else if (ev.__ctrl === "mon-mode") { if (sess.role === "host") hostMonMode(sess, ev); }
  else if (ev.__ctrl === "mon-follow") { if (sess.role === "host") hostMonFollow(sess, !!ev.on); }
  else if (ev.__ctrl === "game-auto") { if (sess.role === "viewer") setAutoGame(sess, !!ev.on); }
  else if (ev.__ctrl === "admin-window") { if (sess.role === "viewer") { sess.adminWindow = !!ev.on; if (!ev.on) sess._adminWarned = false; renderAdminBanner(); } }
  else if (ev.__ctrl === "blind-desk") { if (sess.role === "viewer") { sess.blindDesk = !!ev.on; if (!ev.on) sess._blindWarned = false; renderAdminBanner(); } }
  else if (ev.__ctrl === "chat") { onChatReceived(sess, ev.text); }
  else if (ev.__ctrl === "black-screen") { if (sess.role === "host") handleBlackScreen(sess, ev.enabled); }
  else if (ev.__ctrl === "lock-input") { if (sess.role === "host") handleLockInput(sess, ev.enabled); }
  else if (ev.__ctrl === "privacy-result") { if (sess.role === "viewer") onPrivacyResult(sess, ev); }
  else if (ev.__ctrl === "fs-req") { handleFsRequest(sess, ev); }
  else if (ev.__ctrl === "fs-res") { handleFsResponse(sess, ev); }
  else if (ev.__ctrl === "fs-op") { handleFsOp(sess, ev); }
  else if (ev.__ctrl === "fs-opres") { handleFsResponse(sess, ev); }
  else if (ev.__ctrl === "bye") { onBye(sess, ev.reason); }
  else if (ev.__ctrl === "caps") {
    // The host takes pointer moves on an unordered, never-resent channel (see onHostMove).
    if (sess.role === "viewer" && ev.move && !sess.moveChannel && sess.pc) {
      try { sess.moveChannel = sess.pc.createDataChannel("move", { ordered: false, maxRetransmits: 0 }); } catch (e) { console.warn("move channel", e); }
    }
    if (sess.role === "viewer" && ev.fast) { sess.hostHasFast = true; viewerFastOpen(sess); }
    // pictures / files in the chat: this host takes them, and is told this viewer does too (an older host ignores it)
    if (sess.role === "viewer" && ev.chatfiles) { sess.peerChatFiles = true; try { sess.dataChannel.send(JSON.stringify({ __ctrl: "vcaps", chatfiles: 1 })); } catch {} }
    // Key combinations: this host locks Windows on request (lock; not the service's host, which keeps that switched
    // off), and runs as the TryDesk service, the only place Ctrl+Alt+Del can come from (sas). An older host says
    // neither: those two tiles explain why they can't.
    if (sess.role === "viewer") { sess.hostLock = !!ev.lock; sess.hostSas = !!ev.sas; if (sess === active) renderKeysPanel(); }
    // This host can install the TryDesk service when asked ("Minta akses admin" on the banner). An older host says nothing.
    if (sess.role === "viewer") { sess.hostElev = !!ev.elev; if (sess === active) renderAdminBanner(); }
  }
  // "Minta akses admin": the viewer asks, the person at this PC (or the viewer, on an elevated TryDesk) agrees.
  else if (ev.__ctrl === "elev-req") { if (sess.role === "host") hostElevRequest(sess); }
  else if (ev.__ctrl === "elev-state") { if (sess.role === "viewer") viewerElevState(sess, ev); }
  // Host: Lock PC / Ctrl+Alt+Del from the key panel, under the same rule as any other input from this viewer.
  else if (ev.__ctrl === "special-key") {
    if (sess.role !== "host" || !allowInput || forceViewOnly) return;
    sess.lastInputAt = Date.now();
    // At most one lock a minute and one Ctrl+Alt+Del per 3 s: a modified viewer locking in a loop would otherwise
    // keep the person at this PC from ever unlocking it (independent review 19 Nov).
    // (kept for the whole app, not per session: reconnecting must not start a fresh allowance)
    if (ev.key !== "lock" && ev.key !== "sas") return;
    const now = Date.now(), last = _hostSpecialAt[ev.key] || 0;
    if (now - last < (ev.key === "lock" ? 60000 : 3000)) return;
    _hostSpecialAt[ev.key] = now;
    if (ev.key === "lock" && !(config && config.serviceHost)) { try { window.electronAPI.lockWorkstation(); } catch {} }
    else if (ev.key === "sas" && config && config.serviceHost) {
      Promise.resolve(window.electronAPI.sendSas?.()).then((r) => {
        if (r !== "ok") { try { sess.dataChannel.send(JSON.stringify({ __ctrl: "special-key-result", key: "sas", ok: false })); } catch {} }
      }).catch(() => {});
    }
  }
  // Viewer: the other PC could not open its Ctrl+Alt+Del screen (a Windows policy set there, or it failed)
  else if (ev.__ctrl === "special-key-result") { if (sess.role === "viewer" && !ev.ok && sess === active) { playEvent("bad"); showToast("Ctrl + Alt + Del gagal di PC itu", "bad"); } }
  // Viewer: the other PC's lock or sign-in screen came up / went (the key panel shows what reaches it)
  else if (ev.__ctrl === "secure-desk") { if (sess.role === "viewer") { sess.secureDesk = !!ev.on; if (sess === active) renderKeysPanel(); } }
  else if (ev.__ctrl === "vcaps") { if (sess.role === "host") sess.peerChatFiles = !!ev.chatfiles; }
  else if (typeof ev.__ctrl === "string" && ev.__ctrl.startsWith("fast-")) onFastCtrl(sess, ev);
  else if (ev.action === "mousemove" && sess.role === "host") onHostMove(sess, ev);
  // Anything else is a remote input event, only execute it when WE are the host AND control is
  // permitted. A modified viewer cannot force input past this host-side gate.
  else if (sess.role === "host" && allowInput && !forceViewOnly) { sess.lastInputAt = Date.now(); window.electronAPI.executeInput(ev); }
}

// Absolute pointer moves arrive on two channels (hover moves on "move", the move just before a click on "ctrl")
// and "move" may reorder them: each carries a sequence number, and anything older than the newest seen is
// dropped, so a late packet can never pull the cursor back to where it was.
function onHostMove(sess, ev) {
  if (sess.role !== "host" || !allowInput || forceViewOnly) return;
  if (Number.isSafeInteger(ev.s)) {
    if (ev.s <= (sess._moveSeq ?? -1)) return;
    sess._moveSeq = ev.s;
  }
  // "Semua monitor": a move names the monitor it was made over; the point is placed on that monitor. Without a name
  // (one monitor, or an older viewer) it is the streamed one, as before.
  const want = Number.isInteger(ev.mon) && sess.monMode && sess.monMode !== "single" && ev.mon >= 0 && ev.mon < sess.monitors.length ? ev.mon : sess.currentMonitor;
  if (want !== (sess._inputMon ?? sess.currentMonitor)) {
    const m = sess.monitors[want];
    if (m) { sess._inputMon = want; window.electronAPI.setCaptureDisplay(m); }
  }
  window.electronAPI.executeInput(ev);
}

// ─── Fast path (Windows host → any viewer with hardware H.264 decode) ───
// Chromium's own screen capture tops out near 60 fps and adds ~35 ms; on a Windows host the native helper
// (src/native/trydesk-capture.exe, started by main.js) captures with DXGI and encodes on the GPU instead: up to 240 fps,
// ~2.5 ms from capture to here. Its H.264 frames travel on their own data channel ("fast": unordered, never resent, so
// one lost packet never holds the next frame back), and the viewer decodes them with WebCodecs into the same <video>
// (through a MediaStreamTrackGenerator), so scaling, input mapping, screenshots and recording are unchanged.
// The normal WebRTC video keeps running underneath until the first fast frame is on screen, and comes back the moment
// anything fails (helper exits, decode error, viewer gives up): the picture never goes away.
// Negotiation: host "caps" says fast:1 → viewer opens "fast" and sends fast-start → host starts the helper →
// viewer shows the first decoded frame, sends fast-on → host pauses the WebRTC video encoder.
const FAST_CHUNK = 60000;                 // bytes of H.264 per data-channel message (Chromium allows up to 256 KiB)
const FAST_HDR = 20;                      // u8 ver, u8 flags(bit0 key), u16 chunk, u16 chunks, u16 0, u32 seq, f64 captureMs
const FAST_MAX_BUFFERED = 4 * 1024 * 1024;   // ceiling of the channel backlog past which frames are dropped (the link is too slow)
// Weak links (owner's test vs Chrome Remote Desktop, 12 Nov): the fast channel has no congestion control of its own and
// never resends, so on a thin or lossy link it queued up to 4 MB (≈30 s at 1 Mbps: the picture lagged until the session
// dropped) and a keyframe almost never arrived whole (1 % loss over ~150 packets). Now the backlog is limited in TIME at
// the current rate, the rate follows what really leaves this PC, and a link that can't carry FAST_MIN_MBPS (or loses
// frames, or queues up) goes back to plain WebRTC, whose congestion control and resends are made for such links.
const FAST_BACKLOG_S = 0.15;              // at most this many seconds of frames waiting in the channel
const FAST_MIN_MBPS = 8;                  // below this the fast path stops ("weak") and WebRTC carries the picture
// P11 (owner 14 Nov 2026): the fast path started at the full rate, and on a link that couldn't carry it (busy Wi-Fi,
// 15 Mbps) the picture froze for ~3 s with up to 2.6 s of delay before the rate came down, in 1.3.9 too. Now, with a
// viewer that reports how its frames arrive ("fb" in fast-start, fast-q), it starts at half the rate and climbs while
// the frames arrive on time; a queue building up on the way (frames later than the lowest delay seen, for longer than a
// burst) brings the rate down within half a second instead of after seconds of backlog. An older viewer gets the old way.
const FAST_START_FRAC = 0.5;              // start at this share of the chosen bitrate
// ...but never above this: the default became 1000 Mbps (owner 20 Nov, "tidak ada batasan"), and half of it would start
// a Wi-Fi LAN at 500 Mbps. 40 is where the old 80 Mbps default started; the climb (fastClimb) takes it up within seconds
// when the picture needs more.
const FAST_START_MAX_MBPS = 40;
const FAST_Q_LATE_MS = 50;                // frames this much later than the lowest delay seen = a queue on the way
const FAST_STALL_MS = 500, FAST_STALL_STOP_MS = 4000;   // waiting this long for a whole keyframe: a queue / back to WebRTC
// Each cut, and the least time between two: the encoder needs a few frames to follow a cut, and the queue keeps growing
// meanwhile (at 400 ms a second cut came before the first had worked: 56 -> 39 -> 27 Mbps on a link that carried ~50).
const FAST_CUT = 0.7, FAST_CUT_GAP_MS = 800;
const FAST_WEAK_RETRY_S = [60, 120, 300, 600];   // next fast-path try after a weak-link stop, only if the link looks clean
// Sized from the rate, never from more than the chosen number: the data channel stays under it (P6 raises the top on the
// UDP link only, fastCeilMbps), and a rate left above it for a moment (the UDP link just lost) must not make a backlog that
// takes seconds to drain (4 MB at 80 Mbps: ~3 s when a link narrows to 10 Mbps, review 15 Nov).
const fastBacklogMax = (sess) => Math.min(FAST_MAX_BUFFERED, Math.max(256 * 1024, (Math.min(sess.fastMbps || 10, fastHostRate(sess).mbps) * 1e6 / 8) * FAST_BACKLOG_S));
let _fastAvail = null;                    // host: helper present on this PC (asked once)
const fastHostAvailable = async () => { if (_fastAvail === null) { try { _fastAvail = !!(await window.electronAPI.fastCaptureAvailable?.()); } catch { _fastAvail = false; } } return _fastAvail; };
let _fastDecode = null;                   // viewer: WebCodecs hardware H.264 + MediaStreamTrackGenerator available
async function fastDecodeSupported() {
  if (_fastDecode !== null) return _fastDecode;
  _fastDecode = false;
  try {
    if (typeof VideoDecoder === "undefined" || typeof MediaStreamTrackGenerator === "undefined") return false;
    const r = await VideoDecoder.isConfigSupported({ codec: "avc1.640034", hardwareAcceleration: "prefer-hardware", optimizeForLatency: true });
    _fastDecode = !!(r && r.supported);
  } catch {}
  return _fastDecode;
}
// H.265 on the fast path (17 Nov 2026, owner: "ganti ke H.265, statistik tetap H.264, tidak ada bedanya"): the helper
// encodes H.265 when the choice is H.265 and this viewer decodes it in hardware. Otomatis stays H.264 here: through the
// helper and this decoder H.265 was no sharper on screen text at the same rate (NVIDIA RTX 4060, dense text: 35.2 vs
// 35.4 dB at 40 Mbps, 40.2 vs 39.6 dB at 80 Mbps with 23 % more data; scratchpad build/sharp), and H.264 decodes
// everywhere. VP8 / VP9 / AV1 have no fast-path encoder: the choice is kept and WebRTC carries the picture in it.
let _fastHevc = null;
async function fastHevcSupported() {
  if (_fastHevc !== null) return _fastHevc;
  _fastHevc = false;
  try { const r = await VideoDecoder.isConfigSupported({ codec: "hvc1.1.6.L153.B0", hardwareAcceleration: "prefer-hardware", optimizeForLatency: true }); _fastHevc = !!(r && r.supported); } catch {}
  return _fastHevc;
}
// What the fast path should carry for this session's codec choice: "hevc", "h264", or null (no fast path: VP8/VP9/AV1).
async function fastWantCodec(sess) {
  const c = (sess.quality && sess.quality.codec) || "auto";
  if (c === "H264" || c === "auto") return "h264";
  if (c === "H265") return (await fastHevcSupported()) ? "hevc" : "h264";
  return null;
}
// On unless turned off (store "pref.fastPath" = "0"; no Settings switch yet). Not prefGet: that needs a PREFS entry
// and threw here, which silently dropped the whole "caps" message in the first test.
const fastEnabled = () => { try { return store.get("pref.fastPath") !== "0"; } catch { return true; } };
// The fast path's own UDP link (trydesk-udp.h): above WEBRTC_MAX_MBPS the data channel can't keep up, so when both
// ends are Windows PCs with the helper, the host's helper sends its frames straight to the viewer's helper over UDP
// (AES-GCM under a key passed on the control channel), and the data channel is only the fallback. Off with
// store "pref.fastUdp" = "0". The viewer says "udp" in fast-start; the host answers fast-udp {key, port, ips}.
const fastUdpEnabled = () => { try { return store.get("pref.fastUdp") !== "0"; } catch { return true; } };
const fastUdpViewerOk = async () => fastUdpEnabled() && !!window.electronAPI.fastUdpRecvStart && (await fastHostAvailable());   // same exe, so the same check
// Asked once at start-up, so the answers are ready when a session's control channel opens.
fastHostAvailable(); fastDecodeSupported();

// Inside a Remote Desktop session the screen only changes ~32 times a second (the RDP display's refresh,
// measured on a rented PC). Asking for more made capture hammer the session: the user's own RDP view stuttered
// while TryDesk was connected and was smooth again the moment it disconnected (2026-11-02).
// Windows Sandbox also counts as a remote session (SM_REMOTESESSION), but its screen is not 32 Hz any more: through the
// TryDesk service (which isn't asked this) the same Sandbox gave 110 fps and felt smooth, while TryDesk itself stayed at
// 30-32 (owner 20 Nov, with a picture). The cap stays for a real Remote Desktop session.
const RDP_FPS = 32;
const rdpFpsCap = () => (config && config.rdpSession && config.vmGuest !== "windows-sandbox" ? RDP_FPS : 240);

// Pause / resume the WebRTC video encoder on the host (the fast path carries the picture meanwhile). The
// capture behind it is slowed to 1 fps meanwhile too: two full-rate captures of one screen (the helper's and
// this one) doubled the load for nothing. It stays alive, so falling back to WebRTC is still instant.
async function setWebrtcVideoActive(sess, on) {
  const sender = sess.pc && sess.pc.getSenders().find((s) => s.track && s.track.kind === "video");
  if (!sender) return;
  sess._webrtcPaused = !on;   // applyQualityToSender keeps the capture at 1 fps meanwhile
  try { const p = sender.getParameters(); if (!p.encodings || !p.encodings.length) return; p.encodings.forEach((e) => { e.active = on; }); await sender.setParameters(p); } catch (e) { capLog("webrtc video active=" + on + " failed: " + e.message); }
  const t = sender.track;
  if (t && t.readyState === "live") {
    try { await t.applyConstraints({ frameRate: { ideal: on ? hostCaptureFps : 1, max: on ? hostCaptureFps : 1 } }); }
    catch (e) { capLog("capture fps for webrtc active=" + on + " failed: " + e.message); }
  }
}
function fastHostRate(sess) {
  const capMbps = Number(prefGet("bwLimit")) || 0;
  // Over the data channel the bitrate stays at the Chromium ceiling; the UDP link takes the full quality.
  const pathMax = sess && sess.fastUdpUp ? BITRATE_MAX_MBPS : WEBRTC_MAX_MBPS;
  let mbps = Math.min(hostQuality.bitrate, pathMax);
  if (capMbps > 0) mbps = Math.min(mbps, capMbps);
  return { fps: Math.min(rdpFpsCap(), hostQuality.fps), mbps: Math.max(1, Math.round(mbps)) };
}
// P6 (owner 15 Nov 2026): the most the fast path's rate may climb to, in the helper's own units (the logs' "Mbps" for the
// fast path are these units too). The helper tells its encoder 240 fps (trydesk-capture.cpp, MF_MT_FRAME_RATE), so each
// frame gets rate/240: at the chosen 60 fps every frame got a quarter of its share, and no more than a quarter of the
// chosen bitrate ever went out (80 Mbps -> ~20, measured 14 Nov). Now the rate may climb to the chosen bitrate x 240/fps:
// a frame gets up to chosen/fps, so the chosen bitrate can go out when the screen changes at the chosen fps (a 60 Hz
// screen under a higher fps preset still gets chosen x 60/fps; the helper's 1000 limit holds beyond). Only where it was
// safe in the tests and the two reviews (15 Nov):
//  - the fast path's own UDP link (a LAN, Windows to Windows): the data channel keeps the chosen number. There a short
//    Wi-Fi stall at the higher rate overflowed the backlog (frames dropped up to the next keyframe), and a backlog sized
//    for it took seconds to drain when the link narrowed;
//  - a viewer that reports how its frames arrive (P11; older viewers keep the chosen number as the top),
//  - a LAN (hostFastStart; an internet path measured by WebRTC keeps the chosen number),
//  - no queue in this session, or 60 busy seconds without one since the last (sess._fastP6Calm). Until then the top is 85 %
//    of the rate where the last queue began (_fastCeil, at least the chosen number): near what the link carries, without
//    pushing it into a queue again and again,
//  - an encoder that sizes frames as measured (fastRealGuard).
// The start stays where it was (hostFastStart), and every step past it still needs a screen that uses the rate and frames
// that arrive on time (fastClimb), so a slow link is never pushed harder at the start.
const FAST_HELPER_MAX_MBPS = 1000;   // the most the helper takes (main.js and trydesk-capture.cpp clamp to this)
const FAST_P6_CALM_S = 60;
function fastCeilMbps(sess) {
  const r = fastHostRate(sess);
  if (!sess || !sess.fastFb || !sess.fastUdpUp || sess._fastLan !== true || _fastNoP6) return r.mbps;
  const top = Math.min(FAST_HELPER_MAX_MBPS, Math.round((r.mbps * 240) / r.fps));
  if (sess._fastEverLate && (sess._fastP6Calm || 0) < FAST_P6_CALM_S) return Math.max(r.mbps, Math.min(top, Math.round((sess._fastCeil || 0) * 0.85)));
  return top;
}
// P6 guard: the bitrate that really arrives must not end up well above the chosen one. The top past the chosen number
// assumes the helper's encoder gives each frame rate/240 (measured on an NVIDIA card); one that sized frames by their
// timestamps would send up to 240/fps times more there (review, 15 Nov). 3 seconds in a row above 1.25 x the chosen
// bitrate while the rate is past it: the chosen number is the top from then on, for as long as TryDesk runs.
let _fastNoP6 = false;
function fastRealGuard(sess, want, now) {
  const rq = sess.fastFb && sess.fastQ && now - sess.fastQ.at < 1500 ? sess.fastQ : null;
  sess._fastOver = rq && sess.fastMbps > want.mbps && rq.rx > want.mbps * 1250 ? (sess._fastOver || 0) + 1 : 0;
  if (sess._fastOver >= 3 && !_fastNoP6) {
    _fastNoP6 = true;
    capLog(`fast path: ${(rq.rx / 1000).toFixed(1)} Mbps arrive at rate ${sess.fastMbps}, more than the chosen ${want.mbps} Mbps (this encoder sizes frames differently): the chosen number stays the top`);
  }
}
// Is this session going through our TURN relay? Then the fast path stays off: its bitrate would land on the server.
async function viaRelay(sess) {
  try {
    const st = await sess.pc.getStats(); let pid = null, pair = null;
    st.forEach((s) => { if (s.type === "transport" && s.selectedCandidatePairId) pid = s.selectedCandidatePairId; });
    st.forEach((s) => { if (s.type === "candidate-pair" && (s.id === pid || (!pid && s.nominated && s.state === "succeeded"))) pair = s; });
    const local = pair && st.get(pair.localCandidateId), remote = pair && st.get(pair.remoteCandidateId);
    return !!((local && local.candidateType === "relay") || (remote && remote.candidateType === "relay"));
  } catch { return true; }
}
// The fast path only where it can keep up. 14 Nov 2026: on a 20 Mbps link with a 20 ms round trip (a good home internet
// line) it was let in by the viewer's "clean link" check, flooded the link, fell back 2 s later with a blank picture
// and an 864 ms jump in delay. Decided here because only the sending side knows WebRTC's bandwidth estimate.
//  - LAN: the connection runs between this network's own addresses (lanAddrs, no NAT in between) with a lowest round
//    trip of at most FAST_LAN_PAIR_RTT_MS (a VPN with private addresses across the internet is slower). A ping alone
//    can't tell: two fibre lines in one city answer in 3-6 ms with a 10-20 Mbps upload, and a busy Wi-Fi spikes.
//  - addresses not shown (a stricter Chromium): the lowest round trip at most FAST_LAN_RTT_MS.
//  - otherwise only a link whose bandwidth WebRTC has already measured (FAST_WAN_MIN_MBPS): started at 80 % of that,
//    and without the UDP link (that one jumps straight to the full rate).
const FAST_LAN_RTT_MS = 6, FAST_LAN_PAIR_RTT_MS = 15, FAST_WAN_MIN_MBPS = 40;
// Two ICE addresses on one network: both private IPv4 (10/8, 172.16/12, 192.168/16, 169.254/16), or IPv6 in the same
// /64 or both link-local. Measured 14 Nov 2026: two TryDesk windows on one home network connected over their global
// IPv6 addresses (same /64), so private IPv4 alone would have missed it.
function lanAddrs(a, b) {
  const v4 = (s) => { const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(String(s || "")); return m ? [+m[1], +m[2]] : null; };
  const priv = (o) => o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || (o[0] === 169 && o[1] === 254);
  const x = v4(a), y = v4(b);
  if (x || y) return !!(x && y && priv(x) && priv(y));
  const p64 = (s) => {
    s = String(s || "").split("%")[0].toLowerCase();
    if (!s.includes(":") || s.includes(".")) return null;
    const [h, t] = s.split("::"), hp = h ? h.split(":") : [];
    const parts = t === undefined ? hp : [...hp, ...Array(Math.max(0, 8 - hp.length - (t ? t.split(":").length : 0))).fill("0"), ...(t ? t.split(":") : [])];
    return parts.length === 8 ? parts.slice(0, 4).map((n) => parseInt(n, 16) || 0) : null;
  };
  const p = p64(a), q = p64(b);
  if (!p || !q) return false;
  if ((p[0] & 0xffc0) === 0xfe80 && (q[0] & 0xffc0) === 0xfe80) return true;
  return p.every((n, i) => n === q[i]);
}
// The lowest round trip seen on the selected pair this session (the link control reads it every second): one reading
// can land on a Wi-Fi power-save wake-up or a busy moment (14 Nov 2026, test link of 1 ms each way: one start read
// 10 ms and the fast path stayed off), the lowest one is the path itself. A new pair (ICE restart, relay -> direct)
// starts over.
function noteRtt(sess, pair) {
  const r = pair && pair.currentRoundTripTime;
  if (r == null || !(r >= 0)) return;
  if (sess._rttPair !== pair.id) { sess._rttPair = pair.id; sess._rttMin = r; }
  else if (r < sess._rttMin) sess._rttMin = r;
}
async function fastLinkInfo(sess) {
  try {
    const st = await sess.pc.getStats(); let pid = null, pair = null;
    st.forEach((s) => { if (s.type === "transport" && s.selectedCandidatePairId) pid = s.selectedCandidatePairId; });
    st.forEach((s) => { if (s.type === "candidate-pair" && (s.id === pid || (!pid && s.nominated && s.state === "succeeded"))) pair = s; });
    noteRtt(sess, pair);
    const low = pair && sess._rttPair === pair.id && sess._rttMin != null ? sess._rttMin * 1000 : null;
    const l = pair && st.get(pair.localCandidateId), r = pair && st.get(pair.remoteCandidateId);
    return { rttMs: low, nowMs: pair && pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
      aobMbps: pair && pair.availableOutgoingBitrate ? pair.availableOutgoingBitrate / 1e6 : 0, lanPair: lanPairOf(l, r), addrKnown: !!(l && (l.address || l.ip) && r && (r.address || r.ip)) };
  } catch { return { rttMs: null, nowMs: null, aobMbps: 0, lanPair: false, addrKnown: false }; }
}
// Which addresses an ICE pair runs between: a LAN is a direct pair between addresses of one network (lanAddrs). Each
// side is "host" or "prflx" (an address learned from the other side's checks); never "srflx" (found through a NAT) or
// "relay".
function lanPairOf(l, r) {
  const la = l && (l.address || l.ip), ra = r && (r.address || r.ip);
  return !!(la && ra && /^(host|prflx)$/.test(l.candidateType || "") && /^(host|prflx)$/.test(r.candidateType || "") && lanAddrs(la, ra));
}
// TryDesk run as administrator: the helper is already the picture (nativeCaptureStream). The fast path may borrow it:
// before, a busy helper refused the fast path outright, so an admin host on a LAN stayed on decode + WebRTC re-encode
// (measured 19 Nov: p90 246 ms with drops to 20 fps and a 1 s freeze, against 45 ms with the fast path; owner's report
// "saat jalan sebagai administrator ... ngelag dan patah patah"). It hands the helper back when it stops. (The
// service's secure-desktop helper, forceNative, still keeps it.)
const adminNative = (sess) => !!nativeCap && !!sess.nativeFallback && !sess.forceNative;
const nativeBlocksFast = (sess) => !!nativeCap && !adminNative(sess);
async function hostFastStart(sess) {
  if (sess.role !== "host" || host !== sess || nativeBlocksFast(sess) || !fastEnabled() || !(await fastHostAvailable())) { fastCtrl(sess, { __ctrl: "fast-stopped", why: "unavailable" }); return; }
  // P15: a viewer on a LAN pair asks ~1 s into the session (fastLanAtOnce), when this side may have no numbers for the
  // pair yet (16 Nov 2026, test link: "addresses not shown, round trip ?" -> refused, then WebRTC 125-165 ms behind for
  // the minute until the next try). No numbers is no answer: looked at again for up to 2 s.
  let waited = false;
  for (let i = 0; i < 8 && host === sess; i++) {
    const k = await fastLinkInfo(sess);
    if (k.lanPair || k.addrKnown || k.rttMs != null) break;
    waited = true;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (host !== sess) return;
  // The viewer may have given up during that wait (fast-off, channel closed): a helper started now would send to nobody.
  if (waited && !(sess.fastChannel && sess.fastChannel.readyState === "open")) return;
  if (await viaRelay(sess)) { fastCtrl(sess, { __ctrl: "fast-stopped", why: "relay" }); capLog("fast path off: session goes through the TURN relay"); return; }
  const isLan = (k) => (k.lanPair ? (k.rttMs == null || k.rttMs <= FAST_LAN_PAIR_RTT_MS) : (!k.addrKnown && k.rttMs != null && k.rttMs <= FAST_LAN_RTT_MS));
  let lk = await fastLinkInfo(sess);
  // The session can end during these awaits; a helper started after that would run on with nobody to stop it.
  if (host !== sess || nativeBlocksFast(sess)) return;
  // P15: this early the lowest round trip comes from one or two samples, and one slow sample (a Wi-Fi wake-up, see
  // noteRtt) would refuse a LAN for a minute. The session's first ask, on a pair that looks local by its addresses (or
  // shows none), gets up to 1 s of further samples before a refusal.
  if (!sess._fastLanLooked) {
    sess._fastLanLooked = true;
    for (let i = 0; i < 4 && !isLan(lk) && (lk.lanPair || !lk.addrKnown) && host === sess; i++) {
      await new Promise((r) => setTimeout(r, 250));
      lk = await fastLinkInfo(sess);
    }
    if (host !== sess || nativeBlocksFast(sess)) return;
  }
  const lan = isLan(lk);
  if (!lan && !(lk.aobMbps >= FAST_WAN_MIN_MBPS)) {
    capLog(`fast path off: not a LAN (${lk.lanPair ? "local addresses but slow" : lk.addrKnown ? "addresses of different networks" : "addresses not shown"}, lowest round trip ${lk.rttMs == null ? "?" : lk.rttMs.toFixed(1)} ms, estimate ${lk.aobMbps.toFixed(1)} Mbps), WebRTC carries the picture`);
    // "weak" for viewers before this version (the only reason they try again on); "detail" for the newer ones.
    fastCtrl(sess, { __ctrl: "fast-stopped", why: "weak", detail: "not lan" });
    return;
  }
  const m = sess.monitors[sess.currentMonitor] || sess.monitors[0];
  sess.fastUdpUp = false;
  sess.fastFb = !!sess.fastFbWanted; sess.fastQ = null; sess._fastLateAt = 0; sess._fastCutAt = 0; sess._fastCutQ = 0;
  sess._fastLan = lan; sess._fastOver = 0;   // P6: the top past the chosen number only on a LAN (fastCeilMbps)
  // What an earlier fast path of this session learned stays (a retry or a monitor switch starts it again): the rate
  // where the link queued, and that it did.
  if (sess._fastCeil == null) { sess._fastCeil = 0; sess._fastEverLate = false; sess._fastBusyCalm = 0; sess._fastP6Calm = 0; }
  const rate = fastHostRate(sess);
  if (!lan) rate.mbps = Math.min(rate.mbps, Math.max(FAST_MIN_MBPS, Math.floor(lk.aobMbps * 0.8)));
  // P11: half the rate first (never below FAST_MIN_MBPS), and below where this session's link queued before; then up
  // while the viewer's frames arrive on time.
  if (sess.fastFb) {
    const ceil = sess._fastCeil && sess._fastBusyCalm < 30 ? Math.round(sess._fastCeil * 0.85) : Infinity;
    rate.mbps = Math.min(rate.mbps, Math.max(FAST_MIN_MBPS, Math.min(ceil, FAST_START_MAX_MBPS, Math.round(rate.mbps * FAST_START_FRAC))));
  }
  const udpKey = lan && sess.fastUdpWanted && fastUdpEnabled() ? _hex(crypto.getRandomValues(new Uint8Array(32)).buffer) : null;
  capLog(`fast path: ${lan ? "LAN" : "measured link"} (${lk.lanPair ? "local addresses" : lk.addrKnown ? "different networks" : "addresses not shown"}, lowest round trip ${lk.rttMs == null ? "?" : lk.rttMs.toFixed(1)} ms, estimate ${lk.aobMbps.toFixed(1)} Mbps)`);
  // Run as administrator: the helper leaves the WebRTC picture for the fast path (its frames now go to the fast
  // channel; WebRTC's track simply gets none while the fast path shows the picture).
  const borrowed = adminNative(sess) ? nativeCap : null;
  if (borrowed) { borrowed.paused = true; capLog("fast path: borrows the administrator capture helper"); }
  const r = await window.electronAPI.fastCaptureStart({ displayId: m && m.displayId, ...rate, udp: udpKey, hevc: !!sess.fastHevc }).catch(() => ({ ok: false }));
  if (host !== sess) { if (r && r.ok && !(host && host.fastActive)) { try { window.electronAPI.fastCaptureStop(); } catch {} } return; }
  if (!r || !r.ok) { if (borrowed && nativeCap === borrowed) { borrowed.paused = false; borrowed.restart(); } fastCtrl(sess, { __ctrl: "fast-stopped", why: "start failed" }); return; }
  sess.fastActive = true; sess.fastSeq = 0; sess.fastSkipToKey = false;
  sess.fastUdpKey = udpKey; sess.fastUdpIps = Array.isArray(r.ips) ? r.ips : [];
  // Bitrate follows the link (the fast channel has no bandwidth estimate of its own). Frames dropped for a backlog in
  // the last second → down to 80 % of what really LEFT this PC in that second (bytes handed to the channel minus the
  // growth of its queue); 5 clean seconds → 15 % back up, never above the top (the chosen quality; P6: fastCeilMbps). A
  // link that can't carry FAST_MIN_MBPS, or keeps dropping for 3 s, hands the picture back to WebRTC.
  sess.fastMbps = rate.mbps; sess._fastFps = rate.fps; sess.fastDrops = 0; sess.fastClean = 0; sess.fastSent = 0; sess.fastDropSecs = 0;
  sess._fastBuf0 = sess.fastChannel ? sess.fastChannel.bufferedAmount : 0;
  clearInterval(sess.fastRateTimer);
  sess.fastRateTimer = setInterval(() => {
    if (!sess.fastActive) { clearInterval(sess.fastRateTimer); return; }
    const want = fastHostRate(sess);
    const buf = sess.fastChannel ? sess.fastChannel.bufferedAmount : 0;
    const leftMbps = Math.max(0, (sess.fastSent - (buf - sess._fastBuf0)) * 8 / 1e6);
    sess.fastSent = 0; sess._fastBuf0 = buf;
    let mbps = sess.fastMbps;
    const floor = Math.min(FAST_MIN_MBPS, want.mbps);
    const now = performance.now();
    // A cut from the viewer's late report just now (fastQueueReport): drops from the same queue don't cut again.
    const cutJustNow = now - sess._fastCutAt < FAST_CUT_GAP_MS;
    // Drops (a backlog here, frames the UDP link lost) are a queue too: the climb holds and stays below this rate a while.
    if (sess.fastDrops > 0 && sess.fastFb) fastCongested(sess, now);
    fastRealGuard(sess, want, now);
    const top = fastCeilMbps(sess);   // after both: a queue just now or a guard hit already counts (P6)
    if (sess.fastDrops > 0 && !sess.fastUdpUp) {
      sess.fastClean = 0; sess.fastDropSecs++;
      if (leftMbps < floor * 0.9 || sess.fastDropSecs >= 3) {
        capLog(`fast path: link too weak (${leftMbps.toFixed(1)} Mbps got through, ${sess.fastDropSecs} s of drops), back to WebRTC`);
        hostFastStop(sess, "weak link");
        // kbps: what really left this PC, the rate a newer viewer restarts WebRTC at (webrtcSeed, P11)
        fastCtrl(sess, { __ctrl: "fast-stopped", why: "weak", kbps: Math.round(leftMbps * 1000) });
        return;
      }
      if (!cutJustNow) { mbps = Math.max(floor, Math.min(Math.round(mbps * 0.7), Math.round(leftMbps * 0.8))); sess._fastCutAt = now; }
    } else if (sess.fastDrops > 0) {   // UDP link: its own loss reports
      if (!cutJustNow) { mbps = Math.max(3, Math.round(mbps * 0.7)); sess._fastCutAt = now; }
      sess.fastClean = 0;
    } else if (sess.fastFb) {
      sess.fastDropSecs = 0;
      const busy = fastBusy(sess, mbps, now);
      // P6: busy seconds without a queue since the last one (fastCongested sets it back to 0; see fastCeilMbps)
      if (busy && now - sess._fastLateAt > 1500) sess._fastP6Calm = (sess._fastP6Calm || 0) + 1;
      if (sess.fastUdpUp) mbps = fastClimb(sess, mbps, top, now, busy);
      // The data channel climbs as before (15 % after 5 busy seconds, 5 s after the last queue): there a lost piece is
      // never resent and a frame missing one is gone; a 15 Mbps test link froze 4-9 s each time a quicker climb reached
      // ~40 Mbps.
      else if (busy && now - sess._fastLateAt > 5000 && ++sess.fastClean >= 5 && mbps < top) { mbps = Math.min(top, Math.max(mbps + 1, Math.round(mbps * 1.15))); sess.fastClean = 0; }
    } else {
      sess.fastDropSecs = 0;
      if (++sess.fastClean >= 5 && mbps < top) { mbps = Math.min(top, Math.max(mbps + 1, Math.round(mbps * 1.15))); sess.fastClean = 0; }
    }
    if (mbps > top) mbps = top;
    sess.fastDrops = 0;
    if (mbps !== sess.fastMbps) { sess.fastMbps = mbps; window.electronAPI.fastCaptureCmd({ cmd: "rate", fps: want.fps, mbps }); }
  }, 1000);
  capLog(`fast path started (${rate.fps} fps, ${rate.mbps} Mbps${sess.fastFb ? ", climbing while the viewer's frames arrive on time" : ""}${udpKey ? ", udp offered" : ""})`);
}
// P11, host: what a rate carries at fr frames a second. The helper tells its encoder 240 fps (trydesk-capture.cpp,
// MF_MT_FRAME_RATE), so each frame gets mbps/240 and about mbps x fr/240 goes out when the frames use that (measured: 48
// Mbps at 60 fps carried 10-12 Mbps of scrolling text). fr is what the viewer really receives (fast-q "fr"), not the
// chosen fps: a 60 Hz screen gives ~60 under the 240 preset, a video 30 (second review, 14 Nov: with the chosen fps the
// higher presets never counted as busy and never climbed). If the helper ever sizes frames by the real fps, this is mbps.
// (P6 left the helper as it is and lets the rate itself go higher instead: fastCeilMbps.)
const fastMovingKbps = (sess, mbps, fr) => mbps * 1000 * Math.min(1, (fr > 0 ? fr : fastHostRate(sess).fps) / 240);
// P11, host: does the screen really use this rate? The frames that arrived (the viewer's last report, under 1.5 s old)
// were on average at least 60 % of their share of it, at 5 fps or more. While someone reads or types the rate was never
// tested, and the climb holds (otherwise it crept back to the full rate and the next scroll flooded the link).
function fastBusy(sess, mbps, now) {
  const rq = sess.fastQ && now - sess.fastQ.at < 1500 ? sess.fastQ : null;
  return !!rq && rq.fr >= 5 && rq.rx >= 0.6 * fastMovingKbps(sess, mbps, rq.fr);
}
// P11, host: a queue (late frames, a stall, drops) starts or continues an episode. The climb holds, and a new episode
// remembers its rate as more than the link carries (_fastCeil). Returns whether it is a new one.
function fastCongested(sess, now) {
  const fresh = now - sess._fastLateAt > 1500;
  if (fresh) { sess._fastCeil = sess.fastMbps; sess._fastCutQ = 0; }
  sess._fastLateAt = now; sess._fastEverLate = true; sess._fastBusyCalm = 0; sess._fastP6Calm = 0;
  return fresh;
}
// P11, host, once a second on the UDP link: the next rate while the viewer reports its frames. Up only while they arrive
// on time (a report in the last 1.5 s, nothing late or cut for 1.5 s) AND the screen really uses the rate (busy, see the
// rate timer): 20 % a second, 50 % while below half the chosen rate as long as this session's link has never queued
// (after a queue, 50 % steps ran a 15 Mbps link into a 4 s freeze twice in one test). Where a queue began (_fastCeil):
// quickly back up to 85 % of that rate, then 5 % a second only after 10 busy seconds without a queue (climbing 50 % at a
// time ran into the same queue every ~9 s, 150-330 ms of delay each time; 6 s still every ~7 s). The ceiling is forgotten
// after 30 busy seconds without a queue; seconds of reading or typing don't count, the link wasn't tested then.
// wantMbps is the top (fastCeilMbps, P6); "half the chosen rate" stays half the chosen number (fastHostRate), as before P6,
// so the first seconds climb exactly as they did.
function fastClimb(sess, mbps, wantMbps, now, busy) {
  const fresh = sess.fastQ && now - sess.fastQ.at < 1500, calm = now - sess._fastLateAt > 1500 && now - sess._fastCutAt > 1500;
  if (!fresh || !calm || !busy || mbps >= wantMbps) return mbps;
  sess._fastBusyCalm = (sess._fastBusyCalm || 0) + 1;
  const ceil = sess._fastCeil && sess._fastBusyCalm < 30 ? sess._fastCeil : 0;
  if (!ceil) mbps = Math.max(mbps + 1, Math.round(mbps * (mbps < fastHostRate(sess).mbps / 2 && !sess._fastEverLate ? 1.5 : 1.2)));
  else if (mbps < ceil * 0.85) mbps = Math.max(mbps + 1, Math.min(Math.round(ceil * 0.85), Math.round(mbps * 1.2)));
  else if (sess._fastBusyCalm >= 10) mbps = Math.max(mbps + 1, Math.round(mbps * 1.05));
  return Math.min(wantMbps, mbps);
}
// P11, host: the viewer's report on how the fast frames arrive (twice a second while frames flow, 4 a second while they
// queue or stall): q = ms its frames were late over the last ~300 ms (the smallest, so one big keyframe doesn't count),
// st = ms it has waited for a whole keyframe while data kept coming, rx = kbps it received over the last second.
//  · a queue: down at once to 70 %, or to 90 % of what the viewer gets when that is lower (the link's speed while it
//    queues; never below half in one step); again after FAST_CUT_GAP_MS only while the queue isn't draining.
//  · a stall: one cut, another only if it lasts 2 s more (its length grows with every report, so it can't show draining).
function fastQueueReport(sess, ev) {
  if (!sess.fastActive || !sess.fastFb) return;
  const now = performance.now(), q = Math.max(0, Number(ev.q) || 0), st = Math.max(0, Number(ev.st) || 0), rx = Math.max(0, Number(ev.rx) || 0);
  const fr = Math.min(1000, Math.max(0, Number(ev.fr) || 0));
  sess.fastQ = { at: now, q, st, rx, fr };
  const late = q > FAST_Q_LATE_MS, stalled = st > FAST_STALL_MS;
  if (!late && !stalled) return;
  const fresh = fastCongested(sess, now);
  if (now - sess._fastCutAt < (late ? FAST_CUT_GAP_MS : 2000)) return;
  if (late && !fresh && sess._fastCutQ && q < sess._fastCutQ * 0.8) return;
  sess._fastCutAt = now; if (late) sess._fastCutQ = q;
  const want = fastHostRate(sess), floor = sess.fastUdpUp ? Math.min(3, want.mbps) : Math.min(FAST_MIN_MBPS, want.mbps);
  let mbps = Math.round(sess.fastMbps * FAST_CUT);
  if (late && rx > 0 && fr > 0) mbps = Math.min(mbps, Math.round((rx / fastMovingKbps(sess, 1, fr)) * 0.9));
  mbps = Math.max(floor, Math.round(sess.fastMbps * 0.5), mbps);
  if (mbps >= sess.fastMbps) return;
  capLog(`fast path: ${late ? `frames ${Math.round(q)} ms late on the way` : `no whole picture for ${Math.round(st)} ms`} (viewer gets ${(rx / 1000).toFixed(1)} Mbps), ${sess.fastMbps} -> ${mbps} Mbps`);
  sess.fastMbps = mbps; sess.fastClean = 0;
  window.electronAPI.fastCaptureCmd({ cmd: "rate", fps: want.fps, mbps });
}
// Host: what the helper reports (one JSON line each). The UDP port comes with the first info packet; "up"/"lost"
// follow the viewer's hellos and keepalives, "udpDrops" counts frames its sender had to drop.
window.electronAPI?.onFastCaptureInfo?.((s) => {
  const sess = host; if (!sess || !sess.fastActive) return;
  let j = null; try { j = JSON.parse(s); } catch { return; }
  if (j.udpPort > 0 && sess.fastUdpKey) fastCtrl(sess, { __ctrl: "fast-udp", key: sess.fastUdpKey, port: j.udpPort, ips: sess.fastUdpIps });
  if (j.udp === "up" || j.udp === "lost") {
    sess.fastUdpUp = j.udp === "up";
    // Jump to the path's ceiling at once (ramping 15% a second from 300 to 1000 took most of a minute). With a viewer that
    // reports its frames (P11) the rate climbs from where it is instead (50 % a second while far below): a jump to the
    // full rate is what flooded a slow Wi-Fi.
    // P6: the top past the chosen number is the UDP link's only (fastCeilMbps): a lost link sends the data channel no more
    // than the chosen number.
    const want = fastHostRate(sess); sess.fastMbps = sess.fastFb ? Math.min(sess.fastMbps, fastCeilMbps(sess)) : want.mbps; sess.fastClean = 0;
    window.electronAPI.fastCaptureCmd({ cmd: "rate", fps: want.fps, mbps: sess.fastMbps });
    capLog(sess.fastUdpUp ? `fast path: UDP link up (${j.peer || ""}), ${sess.fastMbps} Mbps` : `fast path: UDP link lost, back to the data channel at ${sess.fastMbps} Mbps`);
  }
  if (j.udpDrops > 0) sess.fastDrops = (sess.fastDrops || 0) + j.udpDrops;
});
function hostFastStop(sess, why) {
  if (!sess.fastActive) return;
  sess.fastActive = false;
  sess._lcResumeAt = Date.now();   // P11: the link control leaves WebRTC's stale estimate alone for 3 s (startLinkControl)
  clearInterval(sess.fastRateTimer);
  try { window.electronAPI.fastCaptureStop(); } catch {}
  // Run as administrator: the helper goes back to feeding WebRTC's picture (it starts again in that mode). Also when it
  // wasn't marked borrowed: there is one helper, and fastCaptureStop above has just ended whichever one ran.
  if (nativeCap && (nativeCap.paused || (sess.nativeFallback && !sess.forceNative))) { const c = nativeCap; c.paused = false; c.restart(); }
  setWebrtcVideoActive(sess, true);
  capLog("fast path stopped: " + why);
}
const fastCtrl = (sess, msg) => { try { if (sess.dataChannel && sess.dataChannel.readyState === "open") sess.dataChannel.send(JSON.stringify(msg)); } catch {} };
// ─── Native capture fallback ──────────────────────────────
// When Chromium's own capture can't start at all, TryDesk run as administrator inside an RDP session failed every
// try with "Could not start video source" while its capture process crashed (rented PC, 2026-11-02), the picture
// comes from TryDesk's DXGI helper instead: its H.264 is decoded here and handed to WebRTC as an ordinary video
// track, so every viewer (phone, Mac, old versions) still gets it. The fast path stays off while this runs.
// TryDesk run as administrator ("Jalankan sebagai administrator") is the common case: there Chromium's capture never
// starts at all (DXGI and Windows Graphics Capture both refuse an elevated process, measured 7 Nov on Electron 45.2.1:
// "Could not start video source" in every variant), so this helper is the only picture. It used to count as started
// as soon as the process was spawned: a helper that could not capture on that PC (no H.264 encoder on the GPU, the
// screen not found) exited, was restarted every 1.5 s for ever, and the viewer sat on "loading" until it gave up.
// Now the picture must really arrive, and a helper that keeps failing ends the session with a reason.
let nativeCap = null;
let _helperExitWhy = "";   // the helper's last {"exit":N,"why":"..."} line
window.electronAPI?.onFastCaptureInfo?.((s) => { try { const j = JSON.parse(s); if (j && j.exit != null) _helperExitWhy = String(j.why || "").slice(0, 80); } catch {} });
const NATIVE_FATAL = new Set([2, 4, 5]);   // screen not found, no H.264 encoder, D3D / Media Foundation setup: a retry can't help
const NATIVE_FIRST_FRAME_MS = 8000;
// To the viewer (a peer text: it must be in TEXT_EN to be shown, see knownPeerText) and to the person at this PC.
const HOST_ADMIN_NO_CAPTURE = "PC tujuan tidak bisa membagikan layar karena TryDesk di sana berjalan sebagai administrator";
const HOST_ADMIN_NO_CAPTURE_VIEWER = "PC tujuan tidak bisa membagikan layar karena TryDesk di sana berjalan sebagai administrator. Minta pemiliknya membuka TryDesk biasa, atau memasang layanan TryDesk (Pengaturan › Layanan Windows).";
const HOST_ADMIN_NO_CAPTURE_HERE = "Layar PC ini tidak bisa diambil saat TryDesk berjalan sebagai administrator. Buka TryDesk biasa, atau pasang layanan TryDesk (Pengaturan → Keamanan) agar jendela admin tetap bisa dikontrol.";
// The PC's sound for a session whose picture comes from the helper (run as administrator, or Chromium's capture never
// came up). Chromium can't record the sound there either: without a screen it refuses (an audio-only desktop request
// kills the renderer, tested 14 Nov 2026), so before this such sessions had no sound at all ("Audio tidak tersedia").
// The helper's --loopback mode reads it with WASAPI; its 10 ms float blocks go into an audio MediaStreamTrackGenerator,
// which WebRTC sends exactly like Chromium's own loopback track. The session's video swaps never touch it.
let nativeAudio = null;   // { gen, writer, us, pending, restarts }
async function nativeAudioTrack() {
  if (!window.electronAPI?.loopbackStart || typeof AudioData === "undefined" || typeof MediaStreamTrackGenerator === "undefined") return null;
  stopNativeAudio();
  // Best effort, as with Chromium's own sound: a failure here must never cost the session its picture.
  let gen, na;
  try { gen = new MediaStreamTrackGenerator({ kind: "audio" }); na = nativeAudio = { gen, writer: gen.writable.getWriter(), us: 0, pending: 0, restarts: 0 }; }
  catch (e) { capLog("native sound: no audio track (" + (e && e.message) + ")"); return null; }
  let r = null; try { r = await window.electronAPI.loopbackStart(); } catch {}
  if (!r || !r.ok || nativeAudio !== na) { if (nativeAudio === na) stopNativeAudio(); else { try { gen.stop(); } catch {} } return null; }
  capLog("native sound started");
  return gen;
}
window.electronAPI?.onLoopbackPcm?.((p) => {
  const na = nativeAudio;
  if (!na || !p || !p.data || !(p.rate > 0) || !(p.ch > 0)) return;
  const samples = new Float32Array(p.data.buffer, p.data.byteOffset, Math.floor(p.data.byteLength / 4));
  const frames = Math.floor(samples.length / p.ch); if (!frames) return;
  // Time runs on in microseconds: the device can come back at another sample rate (headset in), and counting frames
  // at the new rate would make the timestamps jump backwards.
  const t = na.us; na.us += frames / p.rate * 1e6;
  // A track that can't keep up drops a block rather than letting the delay grow.
  if (na.pending > 8) return;
  let ad; try { ad = new AudioData({ format: "f32", sampleRate: p.rate, numberOfFrames: frames, numberOfChannels: p.ch, timestamp: Math.round(t), data: samples }); } catch { return; }
  na.pending++;
  na.writer.write(ad).catch(() => { try { ad.close(); } catch {} }).finally(() => { na.pending--; });
});
// The sound helper stopped by itself mid-session (crash, killed): start it again, a few times at most.
window.electronAPI?.onLoopbackEnded?.(() => {
  const na = nativeAudio; if (!na || na.restarts >= 3) return;
  na.restarts++;
  setTimeout(async () => { if (nativeAudio !== na) return; let r = null; try { r = await window.electronAPI.loopbackStart(); } catch {} capLog("native sound restarted: " + !!(r && r.ok)); }, 1000);
});
function stopNativeAudio() {
  if (!nativeAudio) return;
  const na = nativeAudio; nativeAudio = null;
  try { na.writer.close().catch(() => {}); } catch {}
  try { na.gen.stop(); } catch {}
  try { window.electronAPI.loopbackStop(); } catch {}
}
async function nativeCaptureStream(m, withAudio = false) {
  // (in a virtual machine only as plain frames: main.js helperVmRaw)
  const avail = (await fastHostAvailable()) || !!(await window.electronAPI.nativeCaptureAvailable?.().catch(() => false));
  if (!avail || typeof MediaStreamTrackGenerator === "undefined") throw new Error("native capture unavailable");
  stopNativeCapture();
  const gen = new MediaStreamTrackGenerator({ kind: "video" });
  const writer = gen.writable.getWriter();
  let pending = 0, codec = "";
  const dec = new VideoDecoder({
    // A frame the track can't take yet is dropped, not queued: the newest picture is what matters.
    // A decoded picture is what counts as "started" (a packet the decoder can't take would still leave the viewer blank).
    // Capture time 0 = the helper's flush copy (the same picture as the frame before): not handed to WebRTC again.
    output: (frame) => { if (frame.timestamp === 0 && cap.gotFrame) { frame.close(); return; } if (!cap.gotFrame) { cap.gotFrame = true; firstFrame(true); } if (pending > 2) { frame.close(); return; } pending++; writer.write(frame).catch(() => {}).finally(() => { pending--; }); },
    error: (e) => capLog("native capture decode: " + e.message),
  });
  const rate = { fps: Math.min(rdpFpsCap(), hostQuality.fps || 60), mbps: 40 };
  let firstFrame = () => {};
  const started = new Promise((res) => { firstFrame = res; });
  _helperExitWhy = "";
  const cap = nativeCap = {
    m, gen, dec, gotFrame: false, fails: 0, failed: "",
    // Stopped before its first frame (the viewer cancelled): end the wait now instead of after NATIVE_FIRST_FRAME_MS,
    // when the next session may already be using the helper.
    abort: () => firstFrame(false),
    // The helper exited. Before its first frame: a code that can't change by retrying, or 3 tries, fails the start.
    // After: restarts (a display change ends it on purpose, exit 3) until 5 in a row bring no frame.
    ended(code) {
      if (nativeCap !== cap) return;
      cap.fails++;
      capLog(`native capture helper exited (${code}${_helperExitWhy ? ": " + _helperExitWhy : ""})`);
      if (cap.gotFrame ? cap.fails >= 5 : (NATIVE_FATAL.has(code) || cap.fails >= 3)) {
        cap.failed = `helper ${code}${_helperExitWhy ? " (" + _helperExitWhy + ")" : ""}`;
        firstFrame(false);
        if (cap.gotFrame) nativeCaptureFailed(cap);
        return;
      }
      setTimeout(() => cap.restart(), 1500);
    },
    packet(p) {
      cap.fails = 0;
      if (p.key) {
        const c = fastCodecFromSps(p.data) || "avc1.640034";
        if (c !== codec) { codec = c; try { dec.configure({ codec, optimizeForLatency: true }); } catch (e) { capLog("native capture config: " + e.message); } }
      }
      if (dec.state !== "configured") return;
      if (dec.decodeQueueSize > 4 && !p.key) { window.electronAPI.fastCaptureCmd({ cmd: "key" }); return; }
      try { dec.decode(new EncodedVideoChunk({ type: p.key ? "key" : "delta", timestamp: Math.round(p.t * 1000), data: p.data })); } catch {}
    },
    // Plain frames (a PC without a hardware video encoder: VM, Windows Sandbox, server): no decoding, straight to the
    // track; WebRTC encodes them as it does Chromium's capture.
    raw(p) {
      cap.fails = 0;
      if (pending > 2) return;
      let frame;
      try { frame = new VideoFrame(p.data, { format: "BGRX", codedWidth: p.w, codedHeight: p.h, timestamp: Math.max(1, Math.round(p.t * 1000)) }); }
      catch (e) { capLog("native capture plain frame: " + e.message); return; }
      if (!cap.gotFrame) { cap.gotFrame = true; capLog(`native capture: plain frames ${p.w}x${p.h} (no hardware encoder)`); firstFrame(true); }
      pending++; writer.write(frame).catch(() => {}).finally(() => { pending--; });
    },
    // The helper ends on a display change (exit 3): start it again on the same track.
    async restart() {
      if (nativeCap !== cap) return;
      rate.fps = Math.min(rdpFpsCap(), hostQuality.fps || 60);   // the rate chosen now (it may have changed while the fast path held it)
      const r = await window.electronAPI.fastCaptureStart({ displayId: m && m.displayId, ...rate, raw: true }).catch(() => ({ ok: false }));
      if (nativeCap !== cap) return;
      if (r && r.ok) { codec = ""; window.electronAPI.fastCaptureCmd({ cmd: "key" }); capLog("native capture restarted"); }
      else cap.ended(-1);
    },
  };
  const r = await window.electronAPI.fastCaptureStart({ displayId: m && m.displayId, ...rate, raw: true }).catch(() => ({ ok: false }));
  if (!r || !r.ok) { stopNativeCapture(); throw new Error("native capture helper did not start"); }
  window.electronAPI.fastCaptureCmd({ cmd: "key" });
  capLog(`native capture started (${rate.fps} fps)`);
  const ok = await Promise.race([started, new Promise((res) => setTimeout(() => res(false), NATIVE_FIRST_FRAME_MS))]);
  if (!ok || nativeCap !== cap) {
    const why = cap.failed || (nativeCap !== cap ? "stopped" : `no picture within ${NATIVE_FIRST_FRAME_MS / 1000} s`);
    if (nativeCap === cap) stopNativeCapture();
    throw new Error("native capture failed: " + why);
  }
  capLog("native capture: first frame");
  // The session's first capture also takes the sound (best effort, as with Chromium: no output device = no sound).
  const audio = withAudio ? await nativeAudioTrack() : null;
  return new MediaStream(audio ? [gen, audio] : [gen]);
}
// The helper stopped for good during a session: end it with the reason instead of a frozen picture.
function nativeCaptureFailed(cap) {
  const sess = host;
  capLog("native capture gave up: " + cap.failed);
  stopNativeCapture();
  if (!sess || sess.role !== "host") return;
  sessLog(sess, "native capture gave up: " + cap.failed);
  // The service's host only uses the helper for the secure desktop: there the plain reason fits.
  const svc = !!(config && config.serviceHost);
  closeSession(sess, true, svc ? "Remote gagal membagikan layar" : HOST_ADMIN_NO_CAPTURE);
  if (!svc) showToast(HOST_ADMIN_NO_CAPTURE_HERE);
}
function stopNativeCapture() {
  if (!nativeCap) return;
  const c = nativeCap; nativeCap = null;
  try { c.abort && c.abort(); } catch {}
  try { c.dec.close(); } catch {}
  try { c.gen.stop(); } catch {}
  try { window.electronAPI.fastCaptureStop(); } catch {}
}

// Service host: a UAC prompt or the lock screen took the input (main.js watches the desktop). Chromium's capture
// can't see that desktop; the helper (SYSTEM, follows the input desktop) carries the picture until it is gone, and
// main.js sends the viewer's input to the helper meanwhile. A fast-path session needs nothing: its helper follows.
let _hostSecureDesk = false;   // (also told to a viewer when its session opens: its key panel shows what reaches it)
// The helper sends a picture only when the screen changes. Its first one arrives before the track is on the session
// (nativeCaptureStream waits for it), so it is lost, and a still screen (Ctrl+Alt+Del, a UAC prompt) then sends
// nothing more: the viewer kept the last desktop picture for as long as the prompt stayed (Sandbox test 20 Nov; a
// session that STARTS on the lock screen worked only because the password box's caret blinks). Ask for the picture
// again once the track is in place, and while the secure desktop is up, every 1.5 s (a lost packet is repaired too).
function nativeNudge() {
  const c = nativeCap;
  for (const ms of [0, 400, 1200]) setTimeout(() => { if (nativeCap === c && !c.paused) { try { window.electronAPI.fastCaptureCmd({ cmd: "key" }); } catch {} } }, ms);
}
// (also for a session that starts on that desktop: its helper starts before any swap)
setInterval(() => { if (_hostSecureDesk && host && nativeCap && !nativeCap.paused && config && config.serviceHost) { try { window.electronAPI.fastCaptureCmd({ cmd: "key" }); } catch {} } }, 1500);
const _hostSpecialAt = {};     // when a viewer last had this PC locked / sent Ctrl+Alt+Del (see "special-key")
window.electronAPI?.onSecureDesktop?.(async (on) => {
  _hostSecureDesk = !!on;
  const sess = host;
  if (!sess || sess.role !== "host" || !(config && config.serviceHost)) return;
  sessLog(sess, on ? "secure desktop (UAC prompt / lock screen) is up" : "secure desktop gone");
  try { sess.dataChannel && sess.dataChannel.readyState === "open" && sess.dataChannel.send(JSON.stringify({ __ctrl: "secure-desk", on: !!on })); } catch {}
  if (sess.fastActive || sess.nativeFallback) return;
  if (!!sess.forceNative === on) return;
  sess.forceNative = on;
  // The helper shows one monitor only: the others shown at the same time stop (the viewer goes back to one monitor).
  if (on && sess.monExtra && sess.monExtra.size) { hostMonDropExtras(sess); sendMonitors(sess); }
  try { await replaceCaptureTrack(sess, null, false, on ? "secure desktop" : "normal desktop"); }
  catch (e) { capLog("secure desktop swap failed: " + (e && e.message)); if (on) sess.forceNative = false; }
});

// Host: one encoded frame from the helper → chunks on the fast channel.
function hostFastPacket(p) {
  if (nativeCap && !nativeCap.paused) { nativeCap.packet(p); return; }
  const sess = host;
  if (!sess || !sess.fastActive) return;
  const ch = sess.fastChannel;
  if (!ch || ch.readyState !== "open") return;
  // A backlog means the link can't carry this bitrate: drop frames, then restart from a keyframe once it drains.
  const limit = fastBacklogMax(sess);
  if (ch.bufferedAmount > limit) { if (!sess.fastSkipToKey) capLog("fast path backlog, dropping to next keyframe"); sess.fastSkipToKey = true; sess.fastDrops = (sess.fastDrops || 0) + 1; return; }
  if (sess.fastSkipToKey) {
    if (!p.key) { if (ch.bufferedAmount < limit / 4 && !sess._fastKeyAsked) { sess._fastKeyAsked = true; window.electronAPI.fastCaptureCmd({ cmd: "key" }); } return; }
    sess.fastSkipToKey = false; sess._fastKeyAsked = false;
  }
  const data = p.data, seq = (sess.fastSeq = (sess.fastSeq + 1) >>> 0);
  sess.fastSent = (sess.fastSent || 0) + data.length;
  const chunks = Math.max(1, Math.ceil(data.length / FAST_CHUNK));
  for (let i = 0; i < chunks; i++) {
    const part = data.subarray(i * FAST_CHUNK, Math.min(data.length, (i + 1) * FAST_CHUNK));
    const buf = new ArrayBuffer(FAST_HDR + part.length), dv = new DataView(buf);
    dv.setUint8(0, 1); dv.setUint8(1, p.key ? 1 : 0); dv.setUint16(2, i, true); dv.setUint16(4, chunks, true); dv.setUint16(6, 0, true);
    dv.setUint32(8, seq, true); dv.setFloat64(12, p.t, true);
    new Uint8Array(buf, FAST_HDR).set(part);
    try { ch.send(buf); } catch { return; }
  }
}
window.electronAPI?.onFastCapturePacket?.(hostFastPacket);
window.electronAPI?.onFastCaptureRaw?.((p) => { if (nativeCap && !nativeCap.paused && p && p.data) nativeCap.raw(p); });
window.electronAPI?.onFastCaptureEnded?.((d) => {
  if (nativeCap && !nativeCap.paused) { nativeCap.ended(d && d.code); return; }
  const sess = host;
  if (!sess || !sess.fastActive) return;
  hostFastStop(sess, `helper exited (${d && d.code})`);
  fastCtrl(sess, { __ctrl: "fast-stopped", why: `helper ${d && d.code}` });
});
function onFastCtrl(sess, ev) {
  if (sess.role === "host") {
    // A peer can't make this host churn: one start while running, keyframes at most 4 a second.
    if (ev.__ctrl === "fast-start") { if (!sess.fastActive && !sess._fastStarting) { sess._fastStarting = true; sess.fastUdpWanted = !!ev.udp; sess.fastFbWanted = ev.fb === 1; sess.fastHevc = ev.codec === "hevc"; hostFastStart(sess).finally(() => { sess._fastStarting = false; }); } }
    else if (ev.__ctrl === "fast-q") fastQueueReport(sess, ev);
    else if (ev.__ctrl === "fast-on") { if (sess.fastActive) setWebrtcVideoActive(sess, false); }
    else if (ev.__ctrl === "fast-key") { if (sess.fastActive && performance.now() - (sess._fastKeyAt || 0) > 250) { sess._fastKeyAt = performance.now(); window.electronAPI.fastCaptureCmd({ cmd: "key" }); } }
    else if (ev.__ctrl === "fast-off") { hostFastStop(sess, "viewer: " + String(ev.why || "")); }
    // The viewer's receiver is listening: its addresses go to the helper, which sends hellos there as well (so
    // either side's firewall sees outbound traffic first). At most 8 private IPv4 addresses, checked again in main.
    else if (ev.__ctrl === "fast-udp-peer") { if (sess.fastActive && sess.fastUdpKey) { const port = Math.round(Number(ev.port)); for (const ip of (Array.isArray(ev.ips) ? ev.ips : []).slice(0, 8)) if (typeof ip === "string" && port > 0) window.electronAPI.fastCaptureCmd({ cmd: "peer", ip, port }); } }
    else if (ev.__ctrl === "fast-udp-off") { if (sess.fastActive) { sess.fastUdpUp = false; window.electronAPI.fastCaptureCmd({ cmd: "udp", on: 0 }); const want = fastHostRate(sess); sess.fastMbps = sess.fastFb ? Math.min(sess.fastMbps, fastCeilMbps(sess)) : want.mbps; window.electronAPI.fastCaptureCmd({ cmd: "rate", fps: want.fps, mbps: sess.fastMbps }); } }
    else if (ev.__ctrl === "fast-udp-loss") { if (sess.fastActive) sess.fastDrops = (sess.fastDrops || 0) + Math.min(100, Math.max(0, Math.round(Number(ev.n)) || 0)); }
  } else if (ev.__ctrl === "fast-udp") { viewerFastUdpStart(sess, ev); }
  else if (ev.__ctrl === "fast-stopped") {
    // kbps (P11 host): what really left the host before a weak-link stop; it restarts WebRTC (webrtcSeed).
    sess._fastStopKbps = Number(ev.kbps) > 0 ? Math.min(1e6, Math.round(Number(ev.kbps))) : 0;
    viewerFastStop(sess, "host: " + String(ev.why || ""), false);
    // The host's screen changed size (exit 3) or a monitor switch failed: try the fast path again shortly. Waits
    // double each time and stop after 6 tries without a frame: a host whose capture never comes up (an RDP
    // session) restarted the helper every 2 s for as long as the session lasted.
    // "display changed": the host has a fresh display (RDP reconnect), so earlier failures don't count.
    if (ev.why === "display changed") sess._fastRetries = 0;
    if (/^helper 3$|monitor switch|display changed/.test(String(ev.why || ""))) {
      const n = sess._fastRetries = (sess._fastRetries || 0) + 1;
      // After 6 quick tries, once a minute: an RDP window that was minimized for a while (no picture at all)
      // must get the fast path back by itself once it is shown again.
      if (n === 7) sessLog(sess, "fast path: host capture keeps failing, WebRTC meanwhile; retrying every minute");
      setTimeout(() => { if (sessions.get(sess.peerId) === sess && sess.hostHasFast) viewerFastOpen(sess); }, n > 6 ? 60000 : Math.min(30000, 2000 * 2 ** (n - 1)));
    }
    // "relay": ICE often starts on the TURN relay and moves to a direct pair seconds later (rented PC, 2026-11-02:
    // relay at start, srflx<->srflx after), which left the fast path off for the whole session. Ask again
    // while this side no longer sees a relay, a few times.
    else if (ev.why === "relay") {
      const retry = async () => {
        const n = sess._fastRelayRetries = (sess._fastRelayRetries || 0) + 1;
        if (n > 6 || sessions.get(sess.peerId) !== sess || !sess.hostHasFast) return;
        if (await viaRelay(sess)) setTimeout(retry, 10000); else viewerFastOpen(sess);
      };
      setTimeout(retry, 5000);
    }
    // detail "not lan": the host found the link not a LAN and too thin for the fast path before starting it (see
    // hostFastStart; it says "weak" too, which is all a viewer before this version retries on). Asked again a minute
    // later, when WebRTC may have measured more bandwidth, without the growing pauses of a link that really failed.
    else if (ev.why === "weak" || ev.why === "not lan") fastWeakRetry(sess, ev.detail === "not lan" || ev.why === "not lan");
  }
}
// The link proved too weak for the fast path (the host's rate fell below FAST_MIN_MBPS, frames kept getting lost, or
// they queued up): WebRTC carries the picture, and the fast path is tried again later with growing pauses, only when
// the link then looks clean. A refusal before the start ("not lan") isn't counted: a few of them left one try every
// 10 minutes.
function fastWeakRetry(sess, refused = false) {
  const n = refused ? 1 : (sess._fastWeakN = (sess._fastWeakN || 0) + 1);
  const wait = FAST_WEAK_RETRY_S[Math.min(n, FAST_WEAK_RETRY_S.length) - 1] * 1000;
  sessLog(sess, refused ? `fast path: the host sees no LAN, WebRTC carries the picture; next try in ${wait / 1000} s`
    : `fast path: weak link (${n}), WebRTC carries the picture; next try in ${wait / 1000} s if the link is clean`);
  clearTimeout(sess._fastWeakTimer);
  sess._fastWeakTimer = setTimeout(() => { if (sessions.get(sess.peerId) === sess && sess.hostHasFast) viewerFastOpen(sess); }, wait);
}
// The fast path only starts on a link that looks clean in WebRTC's own numbers (see pollStats): low round trip and
// next to no loss. Measured over the first seconds of the session, so it can't judge from nothing.
const FAST_OK_RTT_MS = 100, FAST_OK_LOSS = 0.5;
// A LAN-like link (round trip under 20 ms, no loss) is clear after the first two readings; anything else gets three.
const fastLinkClean = (sess) => {
  const n = sess._statN || 0, rtt = sess._rttAvg, loss = sess._lossAvg || 0;
  if (rtt == null || n < 2) return false;
  if (n === 2) return rtt < 20 && loss === 0;
  return rtt < FAST_OK_RTT_MS && loss < FAST_OK_LOSS;
};
// P15 (16 Nov 2026, owner: lag at the start still there through the Windows service): on a LAN the first 2-4 s of every
// session ran on WebRTC, 60-190 ms behind, then 35-45 ms once the fast path took over (measured), only because the
// check above waits for two of WebRTC's one-second readings, and those start with its first frame. A direct pair
// between addresses of one network (lanPairOf) with a short round trip needs no readings: the host checks the same
// pair again before it starts (hostFastStart), and a link that turns out weak stops the fast path as before. Only
// before WebRTC's first reading, a few looks 250 ms apart; after that the readings decide.
const FAST_LAN_AT_ONCE_TRIES = 4;
async function fastLanAtOnce(sess) {
  if (sess._statN > 0 || (sess._fastLanTries || 0) >= FAST_LAN_AT_ONCE_TRIES) return false;
  sess._fastLanTries = (sess._fastLanTries || 0) + 1;
  try {
    const st = await sess.pc.getStats(); let pid = null, pair = null;
    st.forEach((s) => { if (s.type === "transport" && s.selectedCandidatePairId) pid = s.selectedCandidatePairId; });
    st.forEach((s) => { if (s.type === "candidate-pair" && (s.id === pid || (!pid && s.nominated && s.state === "succeeded"))) pair = s; });
    const rtt = pair && pair.currentRoundTripTime;
    const ok = !!(pair && rtt != null && rtt * 1000 <= FAST_LAN_PAIR_RTT_MS && lanPairOf(st.get(pair.localCandidateId), st.get(pair.remoteCandidateId)));
    if (ok) sessLog(sess, `fast path: LAN pair (round trip ${(rtt * 1000).toFixed(1)} ms), starting it without waiting for WebRTC's readings`);
    return ok;
  } catch { return false; }
}

// Viewer: reassemble frames, decode in order, show. A gap (lost chunk) skips to the next keyframe.
async function viewerFastOpen(sess) {
  if (sess.role !== "viewer" || sess.fastChannel || !sess.pc || !fastEnabled() || !(await fastDecodeSupported())) return;
  if (kmBackground(sess)) return;   // a Kelola tab in the background: WebRTC's light picture (switchTab opens it later)
  if (!(await fastWantCodec(sess))) return;   // VP8 / VP9 / AV1 chosen: WebRTC carries it (setQuality opens again on a change)
  // Wait (up to ~8 s) for WebRTC's first numbers; a link that isn't clean stays on WebRTC and is looked at again later.
  // A LAN pair needs no wait (fastLanAtOnce).
  let early = false;   // asked before WebRTC's readings: the host may first wait up to 2 s for its numbers (hostFastStart)
  if (!fastLinkClean(sess) && !(early = await fastLanAtOnce(sess))) {
    if (sess.fastChannel || sessions.get(sess.peerId) !== sess) return;
    // Before WebRTC's first reading, the LAN check looks again soon (the pair's round trip can come a moment later).
    const soon = !(sess._statN > 0) && (sess._fastLanTries || 0) < FAST_LAN_AT_ONCE_TRIES;
    const tries = soon ? (sess._fastGateTries || 0) : (sess._fastGateTries = (sess._fastGateTries || 0) + 1);
    if ((sess._statN || 0) < 3 && tries <= 8) { clearTimeout(sess._fastGateTimer); sess._fastGateTimer = setTimeout(() => { if (sessions.get(sess.peerId) === sess) viewerFastOpen(sess); }, soon ? 250 : 1000); return; }
    sess._fastGateTries = 0;
    sessLog(sess, `fast path: link not clean (rtt ${Math.round(sess._rttAvg || 0)} ms, loss ${(sess._lossAvg || 0).toFixed(1)} %), staying on WebRTC`);
    fastWeakRetry(sess);
    return;
  }
  if (sess.fastChannel || sessions.get(sess.peerId) !== sess || !sess.pc) return;
  sess._fastGateTries = 0; clearTimeout(sess._fastGateTimer);
  let ch;
  try { ch = sess.pc.createDataChannel("fast", { ordered: false, maxRetransmits: 0 }); } catch (e) { console.warn("fast channel", e); return; }
  ch.binaryType = "arraybuffer";
  sess.fastChannel = ch;
  const f = sess.fast = { frames: new Map(), next: 0, waitKey: true, keyAskedAt: 0, decoder: null, codec: "", gen: null, writer: null, on: false, udpOn: false, stats: { frames: 0, bytes: 0 }, lossAt: [], owdMin: Infinity, owdMinNext: Infinity, owdAt: 0, slowSince: 0,
    q: { min: Infinity, minNext: Infinity, at: 0, win: [], sentAt: 0, rx: [] } };
  const udp = await fastUdpViewerOk();
  f.want = await fastWantCodec(sess) || "h264";
  ch.onopen = () => {
    // fb: this viewer reports how the frames arrive (fast-q, P11), so the host may start lower and climb.
    // codec: what this viewer wants the helper to encode (an older host ignores it and sends H.264).
    fastCtrl(sess, { __ctrl: "fast-start", udp: udp ? 1 : 0, fb: 1, codec: f.want });
    // No picture through it within 6 s (keyframes keep getting lost on the way): the link can't carry it. An early ask
    // gets the host's wait for its numbers (up to 2 s) on top.
    clearTimeout(sess._fastFirstTimer);
    sess._fastFirstTimer = setTimeout(() => { if (sess.fast === f && !f.on) { viewerFastStop(sess, "weak link: no picture in 6 s", true); fastWeakRetry(sess); } }, early ? 8000 : 6000);
  };
  ch.onmessage = (m) => viewerFastChunk(sess, m.data);
}
// Fast path running: a frame was lost on the way (the next one waits for a keyframe). More than 4 in 5 s = a lossy link.
function fastLost(sess) {
  const f = sess.fast; if (!f) return;
  const now = performance.now();
  f.lossAt = f.lossAt.filter((t) => now - t < 5000); f.lossAt.push(now);
  if (f.on && !f.udpOn && f.lossAt.length > 4) { viewerFastStop(sess, "weak link: frames lost", true); fastWeakRetry(sess); return; }
  fastAskKey(sess);
}
// Fast path running: one-way delay of each frame (this PC's clock minus the host's capture time; the clocks' offset
// cancels out against the lowest delay seen). Frames arriving 250 ms later than that for over 1.5 s = they queue up.
function fastDelayCheck(sess, captureMs) {
  const f = sess.fast; if (!f || !f.on || f.udpOn || !(captureMs > 0)) return;
  const now = performance.now(), owd = Date.now() - captureMs;
  if (now - f.owdAt > 10000) { f.owdMin = Math.min(f.owdMinNext, owd); f.owdMinNext = Infinity; f.owdAt = now; }   // a window of 10-20 s
  f.owdMin = Math.min(f.owdMin, owd); f.owdMinNext = Math.min(f.owdMinNext, owd);
  if (owd - f.owdMin > 250) {
    if (!f.slowSince) f.slowSince = now;
    else if (now - f.slowSince > 1500) { viewerFastStop(sess, `weak link: frames ${Math.round(owd - f.owdMin)} ms late`, true); fastWeakRetry(sess); }
  } else f.slowSince = 0;
}
// P11, viewer: every fast frame (data channel and UDP link alike) tells how long it waited on the way: its one-way delay
// above the lowest seen in the last 10-20 s (the two clocks' offset cancels out). The smallest of that over ~300 ms is a
// queue standing on the link (q); a big keyframe alone doesn't raise it. Reported to the host twice a second while frames
// arrive, 4 a second while it passes FAST_Q_LATE_MS or a stall runs. rx: what arrived over the last second.
function fastQueueNote(sess, captureMs, key) {
  const f = sess.fast; if (!f || !f.q || !(captureMs > 0)) return;
  const q = f.q, now = performance.now(), owd = Date.now() - captureMs;
  if (now - q.at > 10000) { q.min = Math.min(q.minNext, owd); q.minNext = Infinity; q.at = now; }
  q.min = Math.min(q.min, owd); q.minNext = Math.min(q.minNext, owd);
  if (!key) q.win.push([now, owd - q.min]);
  while (q.win.length && now - q.win[0][0] > 300) q.win.shift();
  const late = q.win.length >= 2 ? Math.min(...q.win.map((w) => w[1])) : 0;
  // Data still coming, but no picture (st): a frame lost a piece (never resent) and the keyframe asked for doesn't arrive
  // whole either. On a 15 Mbps test link pieces arrived on time while the picture stood still for 9 s, and the host
  // heard nothing. Waiting over FAST_STALL_MS tells the host (it cuts, keyframes get smaller), and after
  // FAST_STALL_STOP_MS WebRTC takes over: its resends are made for such links. The clock starts again after a second
  // without any data (fastDataArrived): a wait across a still screen, when nothing is sent, is no stall.
  if (!f.waitKey) q.stallAt = 0; else if (!q.stallAt) q.stallAt = now;
  const stall = f.on && q.stallAt ? now - q.stallAt : 0;
  if (late > FAST_Q_LATE_MS || stall > FAST_STALL_MS) q.lastLateAt = now;
  q.n = (q.n || 0) + 1;   // frames seen (one note per frame), for fr
  if (!q.rx.length || now - q.rx[q.rx.length - 1][0] >= 250) q.rx.push([now, f.stats.bytes, q.n]);
  while (q.rx.length > 2 && now - q.rx[0][0] > 2000) q.rx.shift();
  if (stall > FAST_STALL_STOP_MS) { viewerFastStop(sess, `weak link: no picture for ${(stall / 1000).toFixed(1)} s while data kept coming`, true); fastWeakRetry(sess); return; }
  if (now - q.sentAt < (late > FAST_Q_LATE_MS || stall > FAST_STALL_MS ? 250 : 500)) return;
  q.sentAt = now;
  const r = fastRxRate(f, 1000);
  fastCtrl(sess, { __ctrl: "fast-q", q: Math.round(late), st: Math.round(stall > FAST_STALL_MS ? stall : 0), rx: r.kbps, fr: r.fps });
}
// Any fast data arrived (every data-channel piece, every UDP frame): a second without any restarts the stall clock.
// (Kept per piece: a keyframe that takes over a second to arrive is still data coming.)
function fastDataArrived(f) {
  if (!f || !f.q) return;
  const now = performance.now();
  if (now - (f.q.lastByteAt || now) > 1000) f.q.stallAt = 0;
  f.q.lastByteAt = now;
}
// The frames switched between the data channel and the UDP link: two paths, two lowest delays.
function fastQueueReset(f) { if (f && f.q) { f.q.min = f.q.minNext = Infinity; f.q.at = 0; f.q.win = []; } }
// What the fast path delivered over the last ~windowMs (at most ~2 s): kbps and frames a second (0 when not known yet).
function fastRxRate(f, windowMs = 2000) {
  const r = f && f.q && f.q.rx; if (!r || r.length < 2) return { kbps: 0, fps: 0 };
  const now = performance.now(), mark = r.find(([t]) => now - t <= windowMs + 125) || r[r.length - 1];
  const ms = now - mark[0];
  if (ms < 400) return { kbps: 0, fps: 0 };
  return { kbps: Math.round(((f.stats.bytes - mark[1]) * 8) / ms), fps: Math.round((((f.q.n || 0) - (mark[2] || 0)) * 1000) / ms) };
}
const fastRxKbps = (f, windowMs = 2000) => fastRxRate(f, windowMs).kbps;
// Viewer end of the UDP link. The host's helper is listening on {port} at one of {ips}; our receiver helper sends
// hellos there and we tell the host where we listen, so its helper can send hellos here as well. Frames then arrive
// whole through onFastUdpPacket; the data channel copies are ignored while the link is up.
let _fastUdpSess = null;   // the one session whose receiver helper runs (one helper per app)
async function viewerFastUdpStart(sess, ev) {
  const f = sess.fast;
  if (sess.role !== "viewer" || !f || f.udpStarted || !(await fastUdpViewerOk())) return;
  if (typeof ev.key !== "string" || !/^[0-9a-f]{64}$/i.test(ev.key)) return;
  // One receiver per app: a second LAN tab took it and the first tab's picture froze for good (audit 19 Nov). A tab
  // in the background leaves it where it is (its frames come over the data channel); the tab in front takes it, and
  // the one that had it is told first, so it switches to its data channel.
  const cur = _fastUdpSess;
  if (cur && cur !== sess && sessions.get(cur.peerId) === cur && cur.fast) {
    if (sess !== active) { sessLog(sess, "fast path: the UDP link stays with the tab in front, frames over the data channel"); return; }
    viewerFastUdpStop(cur, "taken by the tab in front");
  }
  f.udpStarted = true;
  const r = await window.electronAPI.fastUdpRecvStart({ key: ev.key, port: Number(ev.port) || 0, ips: Array.isArray(ev.ips) ? ev.ips : [] }).catch(() => ({ ok: false }));
  if (!r || !r.ok || sess.fast !== f) { if (r && r.ok) try { window.electronAPI.fastUdpRecvStop(); } catch {} return; }
  _fastUdpSess = sess;
  fastCtrl(sess, { __ctrl: "fast-udp-peer", port: r.port, ips: r.ips });
  sessLog(sess, "fast path: UDP link offered, waiting for the host's helper");
}
function viewerFastUdpStop(sess, why) {
  const f = sess.fast;
  if (_fastUdpSess === sess) { _fastUdpSess = null; try { window.electronAPI.fastUdpRecvStop(); } catch {} }
  if (f && f.udpOn) { f.udpOn = false; f.waitKey = true; f.frames.clear(); fastQueueReset(f); fastCtrl(sess, { __ctrl: "fast-udp-off", why }); fastAskKey(sess); sessLog(sess, "fast path: UDP link off (" + why + "), data channel again"); }
}
window.electronAPI?.onFastUdpPacket?.((p) => {
  const sess = _fastUdpSess, f = sess && sess.fast; if (!f || !(p.data instanceof Uint8Array)) return;
  if (!f.udpOn) { f.udpOn = true; f.waitKey = true; f.frames.clear(); fastQueueReset(f); sessLog(sess, "fast path: frames arriving over the UDP link"); }
  f.stats.bytes += p.data.length;
  fastDataArrived(f);
  fastQueueNote(sess, Number(p.t), !!p.key);
  if (sess.fast !== f) return;   // a long stall just handed the picture to WebRTC
  if (p.gap && !p.key) { fastAskKey(sess); return; }   // the receiver skipped a lost frame: decode from the next keyframe
  if (f.waitKey) { if (!p.key) { fastAskKey(sess); return; } f.waitKey = false; }
  viewerFastDecode(sess, { parts: [p.data], key: !!p.key, t: Number(p.t) || 0 });
});
window.electronAPI?.onFastUdpInfo?.((s) => {
  const sess = _fastUdpSess, f = sess && sess.fast; if (!f) return;
  let j = null; try { j = JSON.parse(s); } catch { return; }
  if (j.udp === "lost" && f.udpOn) { f.udpOn = false; f.waitKey = true; f.frames.clear(); fastQueueReset(f); fastAskKey(sess); sessLog(sess, "fast path: UDP link quiet, data channel again"); }
  if (j.udpLost > 0) fastCtrl(sess, { __ctrl: "fast-udp-loss", n: j.udpLost });
});
window.electronAPI?.onFastUdpEnded?.(() => { const sess = _fastUdpSess; if (sess) viewerFastUdpStop(sess, "receiver exited"); });
function fastAskKey(sess) {
  const f = sess.fast; if (!f) return;
  f.waitKey = true;
  if (performance.now() - f.keyAskedAt > 250) { f.keyAskedAt = performance.now(); fastCtrl(sess, { __ctrl: "fast-key" }); }
}
function viewerFastChunk(sess, buf) {
  const f = sess.fast; if (!f || f.udpOn || !(buf instanceof ArrayBuffer) || buf.byteLength <= FAST_HDR) return;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== 1) return;
  const key = !!(dv.getUint8(1) & 1), idx = dv.getUint16(2, true), count = dv.getUint16(4, true), seq = dv.getUint32(8, true), t = dv.getFloat64(12, true);
  // At most 256 chunks (~15 MB) per frame and 64 frames in flight: a misbehaving peer can't make this hoard memory.
  if (!count || idx >= count || count > 256) return;
  if (!f.frames.has(seq) && f.frames.size >= 64) { f.frames.clear(); fastLost(sess); if (sess.fast !== f) return; }
  let fr = f.frames.get(seq);
  if (!fr) { fr = { parts: new Array(count), got: 0, key, t, first: performance.now() }; f.frames.set(seq, fr); }
  if (fr.parts[idx]) return;
  fr.parts[idx] = new Uint8Array(buf, FAST_HDR); fr.got++; fr.last = performance.now();
  f.stats.bytes += buf.byteLength;
  fastDataArrived(f);
  // P11: the queue is read from each frame's FIRST piece as it arrives, not from whole frames: on a flooded link pieces
  // get lost (never resent), whole frames stop coming, and a report built on them went quiet exactly then (a 15 Mbps
  // test froze 4 s twice while the host heard nothing). A first piece isn't held back by its own frame's size either.
  if (idx === 0) { fastQueueNote(sess, t, false); if (sess.fast !== f) return; }
  viewerFastDrain(sess);
}
function viewerFastDrain(sess) {
  const f = sess.fast; if (!f) return;
  for (;;) {
    // Waiting for a keyframe: jump to the newest complete one, drop everything before it.
    if (f.waitKey) {
      let best = null;
      for (const [s, fr] of f.frames) if (fr.key && fr.got === fr.parts.length && (best === null || s > best)) best = s;
      if (best === null) { if (f.frames.size > 60) for (const s of [...f.frames.keys()].slice(0, f.frames.size - 30)) f.frames.delete(s); if (!f.keyAskedAt || performance.now() - f.keyAskedAt > 500) fastAskKey(sess); return; }
      for (const s of [...f.frames.keys()]) if (s < best) f.frames.delete(s);
      f.next = best; f.waitKey = false;
    }
    const fr = f.frames.get(f.next);
    if (fr && fr.got === fr.parts.length) {
      f.frames.delete(f.next); f.next = (f.next + 1) >>> 0;
      fastDelayCheck(sess, fr.t);
      if (sess.fast !== f) return;
      viewerFastDecode(sess, fr);
      continue;
    }
    // The next frame is missing: wait a moment (unordered delivery), then treat it as lost.
    // A frame still arriving counts from its LAST piece: a 1-1.5 MB keyframe (1440p/4K) takes more than 60 ms on a
    // 100 Mbps link, was called lost while it was coming in, and the fast path then switched itself off.
    const waitingSince = fr ? (fr.last || fr.first) : Math.min(...[...f.frames.values()].map((x) => x.first), Infinity);
    if (f.frames.size && (performance.now() - waitingSince > 60 || f.frames.size > 8)) { fastLost(sess); if (sess.fast !== f) return; continue; }
    return;
  }
}
function fastCodecFromSps(au) {
  // H.265 first: its SPS (NAL type 33, header 42 01) gives the hvc1 string (profile, compatibility, tier, level,
  // constraints; ISO 14496-15 annex E). Its other NAL headers never look like an H.264 SPS (x & 31 = 7).
  for (let i = 0; i + 5 < au.length; i++) if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && au[i + 3] === 0x42 && au[i + 4] === 0x01) {
    const b = []; let z = 0;   // the start of the SPS without its emulation-prevention bytes (00 00 03)
    for (let j = i + 5; j < au.length && b.length < 13; j++) { const x = au[j]; if (z >= 2 && x === 3) { z = 0; continue; } z = x === 0 ? z + 1 : 0; b.push(x); }
    if (b.length < 13) return "hvc1.1.6.L153.B0";
    const space = b[1] >> 6, tier = (b[1] >> 5) & 1, prof = b[1] & 31;
    let compat = ((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0, rev = 0;
    for (let k = 0; k < 32; k++) { rev = ((rev << 1) | (compat & 1)) >>> 0; compat >>>= 1; }
    const cons = b.slice(6, 12); while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    return `hvc1.${space ? "ABC"[space - 1] : ""}${prof}.${rev.toString(16).toUpperCase()}.${tier ? "H" : "L"}${b[12]}${cons.map((c) => "." + c.toString(16).toUpperCase().padStart(2, "0")).join("")}`;
  }
  for (let i = 0; i + 6 < au.length; i++) if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && (au[i + 3] & 31) === 7) {
    const h = (x) => x.toString(16).padStart(2, "0");
    return `avc1.${h(au[i + 4])}${h(au[i + 5])}${h(au[i + 6])}`;
  }
  return "";
}
const fastCodecName = (codec) => (/^hvc1|^hev1/.test(codec || "") ? "H.265" : "H.264");
function viewerFastDecode(sess, fr) {
  const f = sess.fast;
  let len = 0; for (const p of fr.parts) len += p.length;
  const au = new Uint8Array(len); let o = 0; for (const p of fr.parts) { au.set(p, o); o += p.length; }
  if (fr.key) {
    const codec = fastCodecFromSps(au) || f.codec || "avc1.640034";
    if (!f.decoder || codec !== f.codec) {
      try { f.decoder && f.decoder.close(); } catch {}
      f.codec = codec;
      f.decoder = new VideoDecoder({ output: (frame) => viewerFastShow(sess, frame), error: (e) => viewerFastStop(sess, "decode error: " + e.message, true) });
      try { f.decoder.configure({ codec, hardwareAcceleration: "prefer-hardware", optimizeForLatency: true }); }
      catch (e) { viewerFastStop(sess, "decoder config: " + e.message, true); return; }
    }
  }
  if (!f.decoder || f.decoder.state !== "configured") return;
  if (f.decoder.decodeQueueSize > 4) { fastAskKey(sess); return; }   // decoder falling behind: skip ahead
  try { f.decoder.decode(new EncodedVideoChunk({ type: fr.key ? "key" : "delta", timestamp: Math.round(fr.t * 1000), data: au })); }
  catch (e) { fastAskKey(sess); }
}
function viewerFastShow(sess, frame) {
  const f = sess.fast;
  if (!f || sessions.get(sess.peerId) !== sess) { frame.close(); return; }
  // Capture time 0: the helper's flush copy of the frame before (trydesk-capture.cpp), decoded only to keep the
  // stream's references; the same picture, so neither shown again nor counted.
  if (frame.timestamp === 0 && f.on) { frame.close(); return; }
  f.stats.frames++; f.lastCaptureMs = frame.timestamp / 1000;
  if (!f.gen) {
    f.gen = new MediaStreamTrackGenerator({ kind: "video" });
    f.writer = f.gen.writable.getWriter();
  }
  if (f.pending > 2) { frame.close(); return; }   // the <video> is behind: drop this frame, the next one is newer
  f.pending = (f.pending || 0) + 1;
  f.writer.write(frame).catch(() => {}).finally(() => { f.pending--; });
  if (!f.on) {
    // First fast frame is in: show the fast track (keeping the WebRTC audio) and let the host pause its WebRTC video.
    f.on = true;
    const v = ensureVideo(sess);
    sess.webrtcStream = sess.webrtcStream || v.srcObject;
    const audio = sess.webrtcStream ? sess.webrtcStream.getAudioTracks() : [];
    // An audio track that hasn't had its first sound yet (the host starts its sound ~10 s after the picture) is added
    // only when that sound arrives. Together with the generated video track it made the <video> hold this whole page
    // until then: ~9 s in which no mouse move or key reached the other PC (owner 17 Nov: "pergerakan terasa lemot"
    // at the start of every session; measured, scratchpad build/startlag.mjs).
    const ms = new MediaStream([f.gen, ...audio.filter((t) => !t.muted)]);
    v.srcObject = ms;
    for (const t of audio.filter((x) => x.muted)) t.addEventListener("unmute", () => { if (v.srcObject === ms && !ms.getAudioTracks().includes(t) && t.readyState === "live") ms.addTrack(t); }, { once: true });
    fastCtrl(sess, { __ctrl: "fast-on" });
    sess._fastRetries = 0;
    sessLog(sess, `fast path on (${f.codec})`);
    // A codec change waited for this (viewerCodecChanged): WebRTC's codec now changes underneath, its video paused.
    if (sess._codecRenegPending) { sess._codecRenegPending = false; setTimeout(() => { if (sessions.get(sess.peerId) === sess && sess.pc) { applyCodecPreference(sess); negotiate(sess).catch(() => {}); } }, 500); }
  }
}
function viewerFastStop(sess, why, tellHost) {
  const hostKbps = sess._fastStopKbps; sess._fastStopKbps = 0;   // cleared even when the fast path is already off here
  const f = sess.fast; if (!f) return;
  // P11: a fast path that gave up on a weak link restarts WebRTC at what the link carried (webrtcSeed), only on evidence
  // of that: the host's figure from its backlog (what really left it), or what arrived here in the last second while
  // frames queued or stalled (then the link was full). What arrives otherwise follows the screen, not the link.
  const full = f.q && performance.now() - (f.q.lastLateAt || -1e9) < 2000;
  const seedKbps = f.on && /weak/.test(String(why)) ? (hostKbps || (full ? fastRxKbps(f, 1000) : 0)) : 0;
  if (_fastUdpSess === sess) { _fastUdpSess = null; try { window.electronAPI.fastUdpRecvStop(); } catch {} }
  sess.fast = null;
  try { f.decoder && f.decoder.state !== "closed" && f.decoder.close(); } catch {}
  try { sess.fastChannel && sess.fastChannel.close(); } catch {}
  sess.fastChannel = null;
  const endFast = () => { try { f.writer && f.writer.close().catch(() => {}); } catch {} try { f.gen && f.gen.stop(); } catch {} };
  if (f.on && sess.video && sess.webrtcStream && !/^session closed/.test(String(why))) webrtcHandOver(sess, endFast);
  else { endFast(); if (f.on && sess.video && sess.webrtcStream) sess.video.srcObject = sess.webrtcStream; }
  if (tellHost) fastCtrl(sess, { __ctrl: "fast-off", why });
  sessLog(sess, "fast path off: " + why);
  // A codec change was waiting for this fast path's first frame, which won't come: WebRTC changes now.
  const reneg = sess._codecRenegPending && why !== "codec change" && !!sess.pc;
  if (reneg) { sess._codecRenegPending = false; applyCodecPreference(sess); }
  if (seedKbps) webrtcSeed(sess, seedKbps);   // renegotiates (with the new codec preference too)
  else if (reneg) negotiate(sess).catch(() => {});
}
// P11: WebRTC's video is paused while the fast path runs, and a fast path that floods the link takes WebRTC's bandwidth
// estimate down with it (14 Nov 2026, LAN narrowed to 6 Mbps: 0.03-0.06 Mbps, first WebRTC picture 2.4 s later, then
// 4-9 fps at 720p and blurred text for ~15 s; 1.3.9 the same). After a weak-link stop this viewer offers again with 80 %
// of what the link carried as WebRTC's start rate: a changed x-google-start-bitrate restarts the host's estimate at that
// rate (boostStartBitrate). Never below the usual 4 Mbps start: a changed value also replaces a healthy estimate, and
// the estimate from before the fast path (it holds while paused) is about that. The picture keeps running meanwhile.
function webrtcSeed(sess, linkKbps) {
  if (!(linkKbps > 0) || sess.role !== "viewer" || !sess.pc || sessions.get(sess.peerId) !== sess) return;
  let kbps = Math.round(Math.min(20000, Math.max(4000, linkKbps * 0.8)));
  if (kbps === (sess.startKbps || 4000)) kbps++;   // the same value would not restart the estimate
  sess.startKbps = kbps;
  sessLog(sess, `WebRTC starts again at ${kbps} kbps (the link carried ${linkKbps} kbps)`);
  negotiate(sess).catch(() => {});   // waits for another renegotiation's answer first (negotiate)
}
// Back from the fast path to WebRTC without a blank screen. The host paused its WebRTC video while the fast path ran,
// and its first frame after that can take seconds (14 Nov 2026, LAN narrowed to 6 Mbps: 2.4 s, WebRTC's estimate had
// fallen to 0.1 Mbps); until a frame reaches the <video> itself it shows nothing (1.3.9: black for 2 s there, 639 ms on
// a still screen). Waiting for WebRTC to decode a frame before switching didn't help: that frame went to no screen, and
// the <video> then waited for the next one (4 s of black). So the <video> takes the WebRTC stream at once, with the last
// fast picture as its poster until its own first frame (at most 10 s): a still picture instead of black.
async function webrtcHandOver(sess, endFast) {
  const v = sess.video, url = await stillOf(v);
  if (sessions.get(sess.peerId) === sess && v && sess.video === v && sess.webrtcStream && !(sess.fast && sess.fast.on)) {
    if (url) v.poster = url;
    v.srcObject = sess.webrtcStream;
    if (url) {
      let gone = false;
      const clear = () => { if (gone) return; gone = true; if (v.getAttribute("poster") === url) v.removeAttribute("poster"); URL.revokeObjectURL(url); };
      try { v.requestVideoFrameCallback(clear); } catch { clear(); }
      setTimeout(clear, 10000);
    }
  } else if (url) URL.revokeObjectURL(url);
  endFast();
}
// The frame a <video> shows now, as a blob: URL (null when it shows none).
function stillOf(v) {
  return new Promise((done) => {
    try {
      if (!v || !(v.videoWidth > 0)) { done(null); return; }
      const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext("2d").drawImage(v, 0, 0);
      c.toBlob((b) => done(b ? URL.createObjectURL(b) : null), "image/jpeg", 0.92);
    } catch { done(null); }
  });
}

// ─── Remote filesystem browsing (serves the peer's file manager) ───
// Only the HOST (the machine being controlled) serves its filesystem, and only when file transfer
// is permitted, a machine must never expose its own files to a host it connected OUT to.
const SVC_NO_USER = "Belum ada pengguna yang masuk ke Windows di PC itu, jadi foldernya belum bisa dibuka";
// An error from the service's file calls in words the viewer can use ("nobody signed in" instead of Electron's
// "Error invoking remote method …").
const svcErrText = (e) => { const m = String((e && e.message) || e); return /no signed-in user|impersonation failed/.test(m) ? SVC_NO_USER : m; };
async function handleFsRequest(sess, ev) {
  if (sess.role !== "host") return;
  if (!sess.dataChannel || sess.dataChannel.readyState !== "open") return;
  // Say WHICH rule refused it (user email 12 Nov: "File transfer permission is on but still disabled").
  // code "svc" = the Windows service's session with nobody signed in to Windows: the viewer's file manager then sends
  // plain offers instead. "error" keeps the old sentence: viewers up to 1.3.8 only have an English text for that one;
  // newer viewers show "detail".
  const refuse = (detail, code) => { try { sess.dataChannel.send(JSON.stringify({ __ctrl: "fs-res", reqId: ev.reqId, res: { ok: false, error: "Transfer file dinonaktifkan di host", detail, code, path: ev.path, display: ev.path || "" } })); } catch {} };
  const NO_USER = SVC_NO_USER;
  if (config && config.serviceHost) await svcPermsRefresh();
  if (!hostFilesAllowed()) {
    if (config && config.serviceHost && !_svcUser) refuse(NO_USER, "svc");
    else refuse(!allowFileTransfer ? "Kirim dan ambil file dimatikan di PC itu (Pengaturan → Keamanan → Yang boleh dilakukan tamu)"
      : "Transfer file butuh izin Mouse & keyboard di PC itu (mode lihat saja aktif)", "denied");
    return;
  }
  let res;
  try {
    const target = ev.home ? await window.electronAPI.fsHome() : ev.path;
    // Empty = the "This PC" root (drives); anything else must be a plain drive path, never \\server or a pipe.
    if (target && !peerPathOk(target)) throw new Error("Lokasi ini tidak bisa dibuka dari jarak jauh");
    res = await window.electronAPI.fsList(target);
  } catch (e) {
    res = { ok: false, error: String(e && e.message || e), path: ev.path, display: ev.path || "" };
  }
  // The service's session: the person at the PC signed out meanwhile.
  if (res && !res.ok && res.error === "nouser") return refuse(NO_USER, "svc");
  // Free space of that drive for the File Transfer card (viewers before 1.3.9 ignore it).
  if (res && res.ok && res.path && window.electronAPI.fsOp) { try { const d = await window.electronAPI.fsOp({ op: "disk", path: res.path }); if (d && d.disk) res.disk = d.disk; } catch {} }
  // A data-channel message is capped at 256 KB, so a big folder (System32, a full Downloads) failed to send
  // and the viewer just timed out. Send it in parts the viewer stitches back together.
  const one = JSON.stringify({ __ctrl: "fs-res", reqId: ev.reqId, res });
  if (new Blob([one]).size <= FS_PART_BYTES || !res.ok || !Array.isArray(res.entries)) { try { sess.dataChannel.send(one); } catch {} return; }
  const parts = [];
  let cur = [], curBytes = 0;
  for (const e of res.entries) {
    const b = new Blob([JSON.stringify(e)]).size + 1;
    if (cur.length && curBytes + b > FS_PART_BYTES - 4096) { parts.push(cur); cur = []; curBytes = 0; }
    cur.push(e); curBytes += b;
  }
  if (cur.length) parts.push(cur);
  for (let i = 0; i < parts.length; i++) {
    while (sess.dataChannel && sess.dataChannel.bufferedAmount > BUFFER_HIGH) await sleep(20);
    try { sess.dataChannel.send(JSON.stringify({ __ctrl: "fs-res", reqId: ev.reqId, part: i, parts: parts.length, res: { ...res, entries: parts[i] } })); } catch { return; }
  }
}
const FS_PART_BYTES = 200_000;

// File Transfer tools on the HOST for the viewer (16 Nov): new folder, rename, delete (Recycle Bin), free space,
// "already there?", and the folder chain of a folder being copied. Same gates as listing: host only, file transfer
// allowed, plain drive paths only.
const FS_OPS = new Set(["mkdir", "mkdirp", "rename", "delete", "disk", "exists"]);
async function handleFsOp(sess, ev) {
  if (sess.role !== "host" || !sess.dataChannel || sess.dataChannel.readyState !== "open") return;
  const reply = (res) => { try { sess.dataChannel.send(JSON.stringify({ __ctrl: "fs-opres", reqId: ev.reqId, res })); } catch {} };
  const o = ev.op && typeof ev.op === "object" ? ev.op : {};
  if (config && config.serviceHost) await svcPermsRefresh();
  if (!hostFilesAllowed()) return reply({ ok: false, error: "denied" });
  if (o.op === "clipdir" || o.op === "clipset") return reply(await clipOpHost(sess, o));   // files through the clipboard
  if (!FS_OPS.has(o.op)) return reply({ ok: false, error: "unknown" });
  const paths = o.op === "delete" ? o.paths : [o.path];
  if (!Array.isArray(paths) || !paths.length || paths.length > 500 || !paths.every(peerPathOk)) return reply({ ok: false, error: "ditolak" });
  // Never a drive root itself (deleting or renaming C:\).
  if ((o.op === "delete" || o.op === "rename") && paths.some((p) => /^[A-Za-z]:[\\/]?$/.test(p))) return reply({ ok: false, error: "ditolak" });
  const name = (n) => (typeof n === "string" && n.length <= 255 ? n : "");
  const clean = { op: o.op, path: o.path, paths: o.op === "delete" ? paths : undefined, name: name(o.name),
    names: Array.isArray(o.names) ? o.names.slice(0, 2000).map(name) : undefined };
  if ((o.op === "mkdir" || o.op === "rename") && !clean.name.trim()) return reply({ ok: false, error: "noname" });
  let res;
  try { res = await window.electronAPI.fsOp(clean); } catch (e) { res = { ok: false, error: svcErrText(e) }; }
  if (o.op !== "disk" && o.op !== "exists") sessLog(sess, `file tool ${o.op} -> ${res && res.ok ? "ok" : (res && res.error)}`);
  reply(res);
}
function requestRemoteOp(sess, op, ms = 10000) {
  return new Promise((resolve, reject) => {
    if (!sess.dataChannel || sess.dataChannel.readyState !== "open") return reject(new Error("no-channel"));
    const reqId = `fo${++sess.fsReqSeq}`;
    // A PC on an older TryDesk never answers: say so instead of waiting forever.
    const timer = setTimeout(() => { sess.fsPending.delete(reqId); reject(new Error("old")); }, ms);
    sess.fsPending.set(reqId, { resolve, reject, timer });
    sess.dataChannel.send(JSON.stringify({ __ctrl: "fs-op", reqId, op }));
  });
}

function requestRemoteList(sess, { path = null, home = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!sess.dataChannel || sess.dataChannel.readyState !== "open") return reject(new Error("no-channel"));
    const reqId = `fs${++sess.fsReqSeq}`;
    const timer = setTimeout(() => { sess.fsPending.delete(reqId); reject(new Error("timeout")); }, 15000);
    sess.fsPending.set(reqId, { resolve, reject, timer });
    sess.dataChannel.send(JSON.stringify({ __ctrl: "fs-req", reqId, path, home }));
  });
}

function handleFsResponse(sess, ev) {
  const reqId = ev.reqId;
  const p = sess.fsPending.get(reqId);
  if (!p) return;
  let res = ev.res;
  // Multi-part listing (big folder): collect every part, then resolve with all entries in order.
  const parts = Number(ev.parts);
  if (Number.isInteger(parts) && parts > 1 && parts <= 1000 && Number.isInteger(ev.part) && ev.part >= 0 && ev.part < parts && res) {
    p.got = p.got || new Array(parts);
    p.got[ev.part] = Array.isArray(res.entries) ? res.entries : [];
    p.head = p.head || res;
    if (p.got.filter(Boolean).length < parts) return;
    res = { ...p.head, entries: p.got.flat() };
  }
  clearTimeout(p.timer);
  sess.fsPending.delete(reqId);
  p.resolve(res);
}

// ─── Host: multi-monitor capture ──────────────────────────
// Capture breadcrumbs in the app log (%APPDATA%\TryDesk\trydesk-crash.log): which monitor/source/path was
// grabbed and why each re-capture happened, how a client PC's monitor-switch or flicker report is diagnosed.
function capLog(msg) { try { window.electronAPI.logInfo("capture " + msg); } catch {} }
// Session steps in the local log (no passwords, no screen content), so a failed connection can be traced later.
function sessLog(sess, msg) { try { window.electronAPI.logInfo(`session ${sess.role} ${sess.peerId}: ${msg}`); } catch {} }

// getDisplayMedia with a deadline: capture swaps run one at a time, so a request main never answers must
// not stall every later swap. A stream that shows up after the deadline is stopped, not leaked.
function displayMediaWithTimeout(constraints, ms = 8000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { done = true; reject(new Error("getDisplayMedia timeout")); }, ms);
    navigator.mediaDevices.getDisplayMedia(constraints).then(
      (s) => { if (done) { s.getTracks().forEach((t) => t.stop()); return; } done = true; clearTimeout(timer); resolve(s); },
      (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); });
  });
}

async function hostCapture(sess, index, withAudio) {
  const m = sess.monitors[index] || sess.monitors[0];
  // Development builds only: make Chromium's capture fail, to test the native capture fallback.
  if (config && config.testNoChromiumCapture) throw new Error("Could not start video source (test)");
  // Capture at the frame rate the CHOSEN PRESET needs (not always max), so GPU/encode load tracks the
  // user's quality choice. HIGH-REFRESH (144/165/180/240) is possible ONLY via getDisplayMedia (the modern
  // capture path). The legacy desktopCapturer mandatory maxFrameRate hard-caps at 120 (>120 silently falls
  // back to 30fps, measured), so getDisplayMedia is primary and desktopCapturer is the fallback (≤120).
  const CAPTURE_FPS_MAX = 240;
  const IDLE_MIN_FPS = 12;   // keep a static screen fresh (cheap repeat frames) → no stale frame / resume stutter
  const wantFps = Math.max(30, Math.min(rdpFpsCap(), CAPTURE_FPS_MAX, Math.round(hostQuality.fps || 60)));
  const W = Math.round(m.width * m.scaleFactor), H = Math.round(m.height * m.scaleFactor);
  let stream, via = "gdm";
  try {
    // Tell main which screen to hand getDisplayMedia (awaited, so it's set before the request), then grab it.
    // getDisplayMedia honors frameRate up to the display refresh, this is what unlocks >120 fps.
    if (!(await window.electronAPI.setDisplayMediaSource(m.sourceId, m.displayId))) throw new Error("monitor not exposed as a capture source");
    // NOTE: getDisplayMedia does NOT support frameRate.min ("min constraints are not supported"), only
    // ideal/max. (The idle-freshness min stays on the legacy fallback below, which does support it.)
    const videoC = { width: { ideal: W }, height: { ideal: H }, frameRate: { ideal: wantFps, max: wantFps } };
    // Audio is best-effort: if loopback audio capture is unsupported, keep the HIGH-FPS video instead of
    // falling all the way back to the ≤120fps legacy path.
    try { stream = await displayMediaWithTimeout({ video: videoC, audio: !!withAudio }); }
    catch (eA) { if (withAudio) { stream = await displayMediaWithTimeout({ video: videoC, audio: false }); } else { throw eA; } }
  } catch (e) {
    console.warn("getDisplayMedia failed, falling back to legacy desktopCapturer (<=120fps):", e.message);
    via = "legacy"; capLog(`gdm failed (${e.message}) -> legacy`);
    const legacyFps = Math.min(120, wantFps);   // legacy ceiling
    const base = { chromeMediaSource: "desktop", chromeMediaSourceId: m.sourceId, maxWidth: W, maxHeight: H, maxFrameRate: legacyFps };
    const mkVideo = (withMin) => ({ mandatory: withMin ? { ...base, minFrameRate: IDLE_MIN_FPS } : { ...base } });
    const tryGet = async (withMin) => {
      if (withAudio) {
        try { return await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: "desktop" } }, video: mkVideo(withMin) }); }
        catch (e2) { console.warn("audio capture failed, video only:", e2.message); }
      }
      return navigator.mediaDevices.getUserMedia({ audio: false, video: mkVideo(withMin) });
    };
    try { stream = await tryGet(true); }
    catch (e3) { console.warn("capture with minFrameRate failed, retrying without:", e3.message); stream = await tryGet(false); }
  }
  // "motion" tells the encoder to favor smooth frame rate over static sharpness —
  // essential for responsive control, video and gaming (default treats desktop as "detail").
  const vt = stream.getVideoTracks()[0];
  if (vt) vt.contentHint = "motion";
  // The ceiling we ASKED for drives the re-capture decision. Not the negotiated rate: that stays below the
  // preset whenever the display refreshes slower (240 on a 165Hz screen), which made every quality/net-mode
  // message trigger yet another re-capture.
  hostCaptureFps = wantFps;
  const got = (vt && vt.getSettings()) || {};
  capLog(`mon=${index} ${m.label || ""} src=${m.sourceId} via=${via} want=${W}x${H}@${wantFps} got=${got.width}x${got.height}@${Math.round(got.frameRate || 0)}`);
  return { stream, m };
}

// P16 (16 Nov 2026, owner: lag at the start through the service, again): a session's first capture asked for the screen
// AND the PC's sound in one request, so the picture waited until Windows had opened the sound device. Measured on the
// owner's PC that night: picture alone 0.5-0.6 s, with the sound 10.4-14.8 s (the helper's own WASAPI start took
// 10.2 s too: the audio device, not Chromium), and past displayMediaWithTimeout's 8 s the session then started late AND
// without sound. Now the picture starts alone and the sound is added here once Windows has it, on the audio sender
// that finishAccept set up with a silent stand-in; the viewer is told (sendMonitors), and its sound starts by itself.
async function hostSoundLater(sess, sender, standIn) {
  const t0 = performance.now();
  const gone = () => host !== sess || !sess.pc || sess.pc.connectionState === "closed";
  let s = null;
  try { s = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: 64 }, height: { max: 64 }, frameRate: { max: 1 } }, audio: true }); }
  catch (e) {
    // getDisplayMedia unavailable (the legacy capture path): Chromium's desktop sound, with a tiny picture it needs
    try {
      const m = sess.monitors[sess.currentMonitor] || sess.monitors[0];
      s = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: "desktop" } }, video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: m && m.sourceId, maxWidth: 64, maxHeight: 64, maxFrameRate: 1 } } });
    } catch (e2) { capLog(`sound unavailable (${e && e.message}; ${e2 && e2.message})`); }
  }
  if (s) s.getVideoTracks().forEach((t) => t.stop());   // only the sound is wanted; the session's picture is its own capture
  const a = s && s.getAudioTracks()[0];
  if (!a || gone()) { if (s) s.getTracks().forEach((t) => t.stop()); if (!a) capLog("sound: none from Windows, the session goes on without it"); return; }
  try { await sender.replaceTrack(a); } catch (e) { capLog("sound: " + (e && e.message)); a.stop(); return; }
  try { standIn.stop(); } catch {}
  if (gone() || !sess.localStream) { a.stop(); return; }
  sess.localStream.addTrack(a);   // stopped with the session's other tracks; monitor switches keep it (swapCaptureTrack)
  sess.audioAvailable = true;
  sendMonitors(sess);
  capLog(`sound on, ${Math.round(performance.now() - t0)} ms after the picture`);
}

function sendMonitors(sess) {
  if (sess.role !== "host" || !sess.dataChannel || sess.dataChannel.readyState !== "open") return;
  sess.dataChannel.send(JSON.stringify({
    __ctrl: "monitors",
    // Where each monitor sits (Windows' display settings, in DIP) and its pixels: the viewer's map and "Semua monitor"
    // draw them as they stand. An older viewer ignores them.
    list: sess.monitors.map((m) => ({ index: m.index, label: m.label, primary: m.primary,
      x: Math.round(m.boundsX || 0), y: Math.round(m.boundsY || 0), w: Math.round(m.width || 0), h: Math.round(m.height || 0),
      pw: Math.round((m.width || 0) * (m.scaleFactor || 1)), ph: Math.round((m.height || 0) * (m.scaleFactor || 1)) })),
    current: sess.currentMonitor,
    // "Semua monitor" works here (not while the picture comes from the helper: run as administrator, lock screen)
    multi: hostMultiOk(sess) ? 1 : 0,
    mode: sess.monMode || "single", follow: sess.monFollow ? 1 : 0,
    audio: sess.audioAvailable,
    // What this host really permits, so the viewer can say so instead of silently dropping clicks and keys.
    perms: { control: hostControlAllowed(), files: hostFilesAllowed() },
  }));
}

// Re-grab the host screen (new monitor or higher capture fps) and swap the video sender track.
// Swaps are SERIALIZED per session: overlapping re-captures (a monitor switch while a quality message
// re-captures for fps) raced on main's single getDisplayMedia source, and the older one could finish last
// and swap the PREVIOUS monitor back in. index null = whatever monitor is current when the swap runs;
// onlyIfChanged skips a swap to the monitor already streaming (checked in order, after earlier swaps land).
// reason is logged: repeated swaps are a stream reset each, so the log shows what caused a flicker.
function replaceCaptureTrack(sess, index, onlyIfChanged = false, reason = "") {
  const run = sess.capChain.then(() => {
    const i = index == null ? Math.min(sess.currentMonitor, Math.max(0, sess.monitors.length - 1)) : index;
    if (onlyIfChanged && i === sess.currentMonitor) return;
    capLog(`swap (${reason}) mon ${sess.currentMonitor} -> ${i}`);
    return swapCaptureTrack(sess, i);
  });
  sess.capChain = run.catch(() => {});
  return run;
}

async function swapCaptureTrack(sess, index) {
  const sender = sess.pc && sess.pc.getSenders().find((s) => s.track && s.track.kind === "video");
  if (!sender) return;
  // A session on the helper (run as administrator: Chromium's capture can't start) stays on it for another screen or
  // frame rate. Before, the swap asked Chromium, failed, and the monitor picker silently did nothing.
  const viaNative = !!sess.forceNative || !!sess.nativeFallback;
  // Run as administrator with the fast path on the borrowed helper: a new frame rate only matters for WebRTC's picture,
  // which is paused. Restarting the helper now took it from the fast path, and the fast path's stop later ended the
  // WebRTC helper instead: the picture froze (test 19 Nov, 240 fps chosen). The helper takes the new rate when it is
  // handed back (nativeCap.restart reads it then).
  if (viaNative && sess.fastActive && nativeCap && nativeCap.paused && index === sess.currentMonitor) { capLog("frame rate changed while the fast path holds the helper: used when it is handed back"); return; }
  const { stream, m } = viaNative ? { stream: await nativeCaptureStream(sess.monitors[index] || sess.monitors[0]), m: sess.monitors[index] || sess.monitors[0] }
    : await hostCapture(sess, index, false);
  const newVideo = stream.getVideoTracks()[0];
  // The session may have closed while this swap waited its turn, release the screen instead of leaking it.
  if (!sess.pc || sess.pc.connectionState === "closed") { stream.getTracks().forEach((t) => t.stop()); if (viaNative) stopNativeCapture(); return; }
  await sender.replaceTrack(newVideo);
  if (viaNative) nativeNudge();   // the picture that started the helper went nowhere (see nativeNudge)
  if (!viaNative) stopNativeCapture();   // Chromium's capture works again: the helper fallback is no longer needed
  if (sess.videoTrack) sess.videoTrack.stop();
  sess.videoTrack = newVideo;
  // Keep localStream's video in sync (audio track preserved) so later applyConstraints target the live track
  if (sess.localStream) { sess.localStream.getVideoTracks().forEach((t) => sess.localStream.removeTrack(t)); sess.localStream.addTrack(newVideo); }
  sess.currentMonitor = index;
  hostCaptureHeight = newVideo.getSettings().height || Math.round(m.height * m.scaleFactor);
  // Remember exactly what we're capturing so a spurious display-metrics event (same size) doesn't trigger
  // a needless re-capture, each re-capture is a real video reset the viewer sees as a flicker.
  sess._capW = m.width; sess._capH = m.height; sess._capSF = m.scaleFactor;
  window.electronAPI.setCaptureDisplay(m);
  sess._inputMon = index;
}

async function switchMonitor(sess, index) {
  if (!Number.isInteger(index) || index < 0 || index >= sess.monitors.length || !sess.pc) return;
  // Run as administrator with the fast path on the borrowed helper: the helper moves to the new monitor for WebRTC
  // first; the viewer starts the fast path again after "monitor switch".
  if (sess.fastActive && nativeCap && nativeCap.paused) { hostFastStop(sess, "monitor switch"); fastCtrl(sess, { __ctrl: "fast-stopped", why: "monitor switch" }); }
  try { await replaceCaptureTrack(sess, index, true, "switch"); applyQualityToSender(sess, hostQuality); }
  catch (e) { console.error("switchMonitor failed", e); }
  // The fast path follows: restart the helper on the new monitor (its first frame is a keyframe at the new size).
  // With the UDP link the helper can't simply restart: the new one has no UDP socket, the viewer froze ~3 s and UDP
  // never came back. Stop the fast path instead; the viewer starts it again for "monitor switch" (with UDP).
  if (sess.fastActive && sess.fastUdpKey) { hostFastStop(sess, "monitor switch"); fastCtrl(sess, { __ctrl: "fast-stopped", why: "monitor switch" }); }
  else if (sess.fastActive) {
    const m = sess.monitors[sess.currentMonitor];
    // At the rate the link control has reached, not the chosen one (that flooded a slow link again at every switch).
    const rate = fastHostRate(sess); if (sess.fastMbps > 0) rate.mbps = Math.min(fastCeilMbps(sess), sess.fastMbps);
    const r = await window.electronAPI.fastCaptureStart({ displayId: m && m.displayId, ...rate, hevc: !!sess.fastHevc }).catch(() => ({ ok: false }));
    if (!r || !r.ok) { hostFastStop(sess, "monitor switch"); fastCtrl(sess, { __ctrl: "fast-stopped", why: "monitor switch" }); }
    else setWebrtcVideoActive(sess, false);   // the new capture track starts at full rate: slow it again
  }
  // Report the monitor actually being streamed, so the viewer's picker never claims a switch that failed.
  sendMonitors(sess);
}

// ─── Monitors, host side: one, all at once, or a window each (Arah 1, owner 18 Nov 2026) ───
// A Threads user with three monitors at home asked to see two or three of the office PC's monitors at once. The viewer
// adds one receive-only video line per extra monitor and names them (mon-mode {mode, map:[{mid, mon}]}); this PC
// captures each of those monitors on its own and sends it on that line. The streamed monitor (currentMonitor) keeps
// its own track, link control and fast path; the others go at most 30 fps and 15 Mbps each.
const MON_EXTRA_MAX = 3, MON_EXTRA_FPS = 30, MON_EXTRA_MBPS = 15;
const hostMultiOk = (sess) => !(sess.forceNative || sess.nativeFallback || nativeCap);
function hostMonMode(sess, ev) {
  if (sess.role !== "host" || !sess.pc) return;
  const mode = ev.mode === "all" || ev.mode === "windows" ? ev.mode : "single";
  const n = sess.monitors.length, seen = new Set();
  const map = mode === "single" || !hostMultiOk(sess) ? [] : (Array.isArray(ev.map) ? ev.map : []).filter((x) =>
    x && typeof x.mid === "string" && /^[\w-]{1,16}$/.test(x.mid) && Number.isInteger(x.mon) && x.mon >= 0 && x.mon < n
    && x.mon !== sess.currentMonitor && !seen.has(x.mon) && seen.add(x.mon)).slice(0, MON_EXTRA_MAX).map((x) => ({ mid: x.mid, mon: x.mon }));
  sess.monMode = map.length ? mode : "single";
  sess.monWant = map;
  capLog(`monitors: ${sess.monMode}${map.length ? " (+ " + map.map((x) => x.mon + 1).join(", ") + ")" : ""}`);
  if (sess.monMode === "single" && sess._inputMon != null && sess._inputMon !== sess.currentMonitor) {
    const m = sess.monitors[sess.currentMonitor]; if (m) window.electronAPI.setCaptureDisplay(m);
    sess._inputMon = sess.currentMonitor;
  }
  hostApplyMonMode(sess);
}
// One at a time with the main capture's swaps (they share main's single getDisplayMedia source).
// Calls made while one is still waiting its turn share it: it reads the latest wish when it starts.
function hostApplyMonMode(sess) {
  if (sess._monApplyQueued) return sess._monApplyQueued;
  const run = sess.capChain.then(() => { sess._monApplyQueued = null; return hostApplyMonModeNow(sess); });
  sess._monApplyQueued = run;
  sess.capChain = run.catch(() => {});
  return run;
}
// With an upload limit set (Settings → Koneksi), the shown monitors share it.
const monShare = (sess) => 1 + ((sess.monWant && sess.monWant.length) || 0);
async function hostApplyMonModeNow(sess) {
  if (!sess.pc || sess.pc.connectionState === "closed") return;
  const extra = sess.monExtra || (sess.monExtra = new Map());
  // The streamed monitor may have changed since the wish came (a switch, a display change): never captured twice.
  const want = (sess.monWant || []).filter((w) => w.mon !== sess.currentMonitor && w.mon < sess.monitors.length);
  const txs = sess.pc.getTransceivers();
  const countBefore = extra.size;
  for (const [mid, x] of [...extra]) {
    const w = want.find((y) => y.mid === mid);
    if (w && w.mon === x.mon && x.track.readyState === "live") continue;
    const t = txs.find((y) => y.mid === mid);
    try { if (t) await t.sender.replaceTrack(null); } catch {}
    try { x.track.stop(); } catch {}
    extra.delete(mid);
  }
  for (const w of want) {
    if (extra.has(w.mid)) continue;
    const t = txs.find((y) => y.mid === w.mid);
    // Not in this PC's description yet (the offer is still on its way): done again once it is answered (onOffer).
    if (!t || !t.sender || t.sender.track === sess.videoTrack || !(t.receiver && t.receiver.track && t.receiver.track.kind === "video")) continue;
    const keepFps = hostCaptureFps;
    let cap = null;
    try { cap = await hostCapture(sess, w.mon, false); }
    catch (e) { capLog(`monitors: monitor ${w.mon + 1} could not be captured (${e && e.message})`); continue; }
    finally { hostCaptureFps = keepFps; }
    const track = cap.stream.getVideoTracks()[0];
    cap.stream.getAudioTracks().forEach((a) => a.stop());
    if (!track) continue;
    // Session over, or the wish changed, while this monitor was being captured: let it go.
    const alive = () => sess.monExtra === extra && sess.pc && sess.pc.connectionState !== "closed"
      && (sess.monWant || []).some((y) => y.mid === w.mid && y.mon === w.mon) && w.mon !== sess.currentMonitor;
    if (!alive()) { track.stop(); continue; }
    const fps = Math.min(MON_EXTRA_FPS, hostQuality.fps || 60);
    track.applyConstraints({ frameRate: { ideal: fps, max: fps } }).catch(() => {});
    try { await t.sender.replaceTrack(track); } catch (e) { track.stop(); capLog("monitors: " + (e && e.message)); continue; }
    if (!alive()) { try { await t.sender.replaceTrack(null); } catch {} track.stop(); continue; }
    try {
      const p = t.sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.degradationPreference = "maintain-resolution";
      const capMbps = Number(prefGet("bwLimit")) || 0;
      const mbps = Math.min(hostQuality.bitrate || MON_EXTRA_MBPS, MON_EXTRA_MBPS, capMbps > 0 ? capMbps / monShare(sess) : Infinity);
      p.encodings[0].maxBitrate = Math.round(Math.max(0.1, mbps) * 1e6);
      p.encodings[0].maxFramerate = fps;
      await t.sender.setParameters(p);
    } catch (e) { capLog("monitors: encoder settings " + (e && e.message)); }
    const m = sess.monitors[w.mon] || {};
    extra.set(w.mid, { mon: w.mon, track, w: m.width, h: m.height, sf: m.scaleFactor });
  }
  if (sess.monExtra !== extra) return;
  // The streamed monitor's share of an upload limit changes with the number of others.
  if (extra.size !== countBefore && Number(prefGet("bwLimit")) > 0) applyQualityToSender(sess, { _link: true }).catch(() => {});
  sendMonitors(sess);
}
// Only the other monitors' pictures (the lock screen took the screen, the session ends).
function hostMonDropExtras(sess) {
  for (const [, x] of sess.monExtra || []) { try { x.track.stop(); } catch {} }
  sess.monExtra = new Map(); sess.monWant = []; sess.monMode = "single";
}
function hostMonStop(sess) {
  hostMonDropExtras(sess);
  clearInterval(sess.monFollowTimer); sess.monFollowTimer = null;
}
// "Ikuti kursor": with one monitor shown, the picture follows the cursor of THIS PC to the monitor it is on (the person
// at this PC moved it, a window was moved by keys). The viewer's own moves never leave the shown monitor.
function hostMonFollow(sess, on) {
  sess.monFollow = on; clearInterval(sess.monFollowTimer); sess.monFollowTimer = null; sess._followHits = 0;
  sendMonitors(sess);
  if (!on || !window.electronAPI.cursorDisplayId) return;
  sess.monFollowTimer = setInterval(async () => {
    if (host !== sess || !sess.pc) { clearInterval(sess.monFollowTimer); return; }
    if ((sess.monMode && sess.monMode !== "single") || sess.monitors.length < 2) { sess._followHits = 0; return; }
    let id = null; try { id = await window.electronAPI.cursorDisplayId(); } catch {}
    const idx = id == null ? -1 : sess.monitors.findIndex((m) => String(m.displayId) === String(id));
    if (sess._followBusy || idx < 0 || idx === sess.currentMonitor) { sess._followHits = 0; return; }
    if (++sess._followHits < 2) return;   // two looks 300 ms apart: a cursor passing over an edge doesn't flip the picture
    sess._followHits = 0;
    capLog(`monitors: the cursor is on monitor ${idx + 1}, the picture follows`);
    // One switch at a time (a capture takes a second or two; the polls go on meanwhile).
    sess._followBusy = true;
    try { await switchMonitor(sess, idx); } finally { sess._followBusy = false; }
  }, 300);
}

// Clamp a peer-supplied quality field to a sane range (a view-only viewer must not be able to poison the
// global hostQuality with fps:1e400 and force an endless re-capture storm). NaN / non-number → keep current.
const _clampNum = (v, lo, hi, cur) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : cur; };
async function applyQualityToSender(sess, q) {
  q = q || {};
  hostQuality = {
    bitrate: _clampNum(q.bitrate, 0.1, BITRATE_MAX_MBPS, hostQuality.bitrate),
    fps: Math.round(_clampNum(q.fps, 1, 240, hostQuality.fps)),
    resHeight: _clampNum(q.resHeight, 0, 4320, hostQuality.resHeight),
  };
  const sender = sess.pc && sess.pc.getSenders().find((s) => s.track && s.track.kind === "video");
  if (!sender) return;
  // If a higher frame rate than the current capture cap is requested, re-capture, the
  // mandatory maxFrameRate set at getUserMedia time is a hard ceiling that applyConstraints can't raise.
  // Never for the link control's own changes (q._link): on an RDP host (capture capped at 32 fps) or the native helper
  // that check is always true, and re-capturing up to once a second froze the picture and fed its own QP spikes.
  // Compared with what the capture can really reach: in an RDP session or Windows Sandbox the capture is capped at
  // RDP_FPS, so "60 > 32" was always true and every session started with one or two needless re-captures (a picture
  // reset and a new keyframe in the first seconds, owner's report 13 Nov: "lag at the start through the service").
  const recapture = !q._link && Math.min(hostQuality.fps, rdpFpsCap()) > hostCaptureFps;
  const setEncoder = () => {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    // Always keep the remote screen SHARP at the chosen resolution: a thin link lowers the frame rate (and only at the
    // very end the size) through the host's link control (startLinkControl), never WebRTC's own "balanced" mode, which
    // cut the picture to 960x540 at full frame rate. (maintain-framerate downscaled to 640x360 on connect.)
    params.degradationPreference = "maintain-resolution";
    const enc = params.encodings[0];
    // Settings → Koneksi → upload bandwidth limit caps whatever the viewer asks for.
    const capMbps = Number(prefGet("bwLimit")) || 0;
    // The clamped values (hostQuality), never the peer's raw ones. Monitors shown at the same time share the limit.
    const mbps = capMbps > 0 ? Math.min(hostQuality.bitrate, Math.max(0.1, capMbps / monShare(sess))) : hostQuality.bitrate;
    enc.maxBitrate = Math.round(mbps * 1_000_000);
    enc.maxFramerate = sess.linkFps ? Math.min(sess.linkFps, hostQuality.fps) : hostQuality.fps;
    enc.networkPriority = "high";
    const userScale = hostQuality.resHeight > 0 && hostCaptureHeight > hostQuality.resHeight ? hostCaptureHeight / hostQuality.resHeight : 1;
    enc.scaleResolutionDownBy = +(userScale * (sess.linkScale || 1)).toFixed(3);
    return sender.setParameters(params);
  };
  // Overlapping quality updates (connect + the viewer's first quality message, link-control changes) can invalidate
  // the parameters this call read ("getParameters() has never been called"), silently dropping the bitrate/fps/
  // degradation settings. Re-read and apply once more so the encoder never keeps stale settings.
  const applyEncoder = async () => {
    try { await setEncoder(); }
    catch (e) { try { await setEncoder(); } catch (e2) { console.warn("setParameters failed", e2); capLog("setParameters failed: " + e2.message); } }
  };
  // The encoder settings go on BEFORE a re-capture too: it can take a second or two, and until then the encoder ran
  // without them (WebRTC's own default downscaled to 640x360 on connect). The sender keeps them across the new track.
  if (recapture) {
    await applyEncoder();
    try { await replaceCaptureTrack(sess, null, false, `fps ${hostQuality.fps}`); } catch (e) { console.warn("recapture for fps failed", e); }
  }
  await applyEncoder();
  // While the fast path carries the picture the WebRTC capture stays at 1 fps (setWebrtcVideoActive). Every quality
  // message used to put it back at full rate, codec changes included: two full captures of one screen until the
  // session ended (17 Nov, measured 1 -> 60 fps after a codec change, scratchpad build/codeclag.mjs).
  if (q.fps != null || recapture) {
    const vt = sess.localStream && sess.localStream.getVideoTracks()[0];
    const fps = sess._webrtcPaused ? 1 : hostQuality.fps;
    if (vt) vt.applyConstraints({ frameRate: { ideal: fps, max: fps } }).catch(() => {});
  }
  // A new quality choice restarts the fast path's rate from the top (the 1 s loop lowers it again if the link can't).
  // With a viewer that reports its frames (P11) a lower choice applies at once and a higher one is climbed to. P6: a frame
  // gets rate/240, so with a higher fps a rate past the chosen number first comes down to keep what really goes out (rate
  // x fps/240) instead of jumping with it; at or below the chosen number nothing changes (as before P6). A lower fps keeps
  // the rate: what goes out can only stay or fall (the screen may give fewer frames than either).
  if (sess.fastActive && !q._link) {
    const r = fastHostRate(sess);
    if (sess.fastFb) {
      let cur = sess.fastMbps || r.mbps;
      if (sess._fastFps && r.fps > sess._fastFps && cur > r.mbps) cur = Math.max(r.mbps, Math.round((cur * sess._fastFps) / r.fps));
      r.mbps = Math.min(fastCeilMbps(sess), cur);
    }
    sess.fastMbps = r.mbps; sess._fastFps = r.fps;
    try { window.electronAPI.fastCaptureCmd({ cmd: "rate", ...r }); } catch {}
  }
}

// Host display resolution/scale changed → refresh the monitor list and re-capture the current
// screen so the stream resets at the new size (clean keyframe) and input mapping stays correct.
let displayRecapturing = false;
if (window.electronAPI && window.electronAPI.onDisplayChanged) {
  window.electronAPI.onDisplayChanged(async (force) => {
    // P7: a capture prepared during a password round is of the screen as it was: started again after the accept. (One
    // still waiting for woken monitors to come back hasn't looked at the screens yet: the change is what it waits for.)
    if (_prewarm && _prewarm.capStarted) prewarmDrop(_prewarm);
    const sess = host;
    if (!sess || sess.role !== "host" || !sess.pc || displayRecapturing) return;
    displayRecapturing = true;
    try {
      sess.monitors = await window.electronAPI.getMonitors();
      const idx = Math.min(sess.currentMonitor, Math.max(0, sess.monitors.length - 1));
      const mon = sess.monitors[idx];
      // Only re-capture when the monitor we're streaming actually changed resolution/scale. Fullscreen games
      // and sandboxes fire display-metrics repeatedly with NO real size change, re-capturing on those was
      // the main cause of the "berkedip-kedip" flicker during gameplay. Skip the no-op events.
      // force: the display itself was replaced (RDP reconnect, move to the console), so the old capture shows
      // black even at the same size, same path as picking the monitor again, which brought the picture back.
      if (force) {
        const wasFast = sess.fastActive;
        await switchMonitor(sess, idx);
        // The fast path may have given up while the display was gone: let the viewer start it again. (One that
        // switchMonitor stopped itself has already told the viewer.)
        if (!wasFast && !sess.fastActive && (await fastHostAvailable())) fastCtrl(sess, { __ctrl: "fast-stopped", why: "display changed" });
      } else if (mon && sess._capW === mon.width && sess._capH === mon.height && sess._capSF === mon.scaleFactor) {
        sendMonitors(sess);   // keep the list fresh, but don't reset the stream
      } else {
        await replaceCaptureTrack(sess, null, false, "display changed");
        applyQualityToSender(sess, hostQuality);
        sendMonitors(sess);
      }
      // The other monitors shown at the same time are captured again at their new size (the viewer re-sends its map
      // when the list it gets has another number of monitors).
      // Only the ones whose size changed (or all, when the displays were replaced); a monitor that is gone is dropped.
      if (sess.monExtra && sess.monExtra.size) {
        sess.monWant = (sess.monWant || []).filter((w) => w.mon < sess.monitors.length);
        for (const [, x] of sess.monExtra) {
          const m = sess.monitors[x.mon];
          if (force || !m || m.width !== x.w || m.height !== x.h || m.scaleFactor !== x.sf) { try { x.track.stop(); } catch {} }
        }
        hostApplyMonMode(sess);
      }
    } catch (e) { console.warn("display-changed recapture failed", e); }
    finally { displayRecapturing = false; }
  });
}

// Reflect the current session state on the user's Discord profile (hosting / viewing / idle).
function updateDiscordPresence() {
  try {
    const live = (s) => s && s.pc && ["new", "connecting", "connected"].includes(s.pc.connectionState);
    let st = "idle";
    if (live(host)) st = "hosting";                                  // someone is controlling THIS pc
    for (const s of sessions.values()) { if (live(s)) { st = "viewing"; break; } }  // we're controlling a pc (takes precedence)
    window.electronAPI && window.electronAPI.setDiscordActivity && window.electronAPI.setDiscordActivity(st);
  } catch {}
}

// ─── Shared WebRTC ────────────────────────────────────────
function createPeer(sess) {
  // Settings → Koneksi → Protokol: "p2p" never uses a relay (TURN entries dropped); "relay" forces every packet
  // through TURN (only works when the server hands out TURN credentials).
  const proto = prefGet("protocol");
  const pc = new RTCPeerConnection({ iceServers: iceServersFor(proto), iceTransportPolicy: proto === "relay" ? "relay" : "all" });
  sess.pc = pc; sess.iceProto = proto;
  sess.pendingCandidates = [];
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ type: "ice-candidate", targetId: sess.peerId, candidate: e.candidate }); };
  // The viewer opens its own channels; the only ones the host opens toward it are pictures / files in the chat.
  // (The host sets its own ondatachannel after this, for the channels the viewer opens.)
  if (sess.role === "viewer") pc.ondatachannel = (e) => { const ch = e.channel; if (typeof ch.label === "string" && ch.label.startsWith("cf:")) chatRecvChannel(sess, ch); else { try { ch.close(); } catch {} } };
  // Accepted but the peer-to-peer link never comes up (the other side stuck or gone): end it on both sides after
  // 30 s with a clear message. Before, the tab waited forever and the server kept showing the pair as "controlling".
  clearTimeout(sess.p2pTimer);
  if (!sess.everConnected) sess.p2pTimer = setTimeout(() => {
    if (sess.pc !== pc || sess.everConnected) return;
    sessLog(sess, `no P2P link after 30 s (state ${pc.connectionState}, ice ${pc.iceConnectionState}), ending`);
    const fg = sess === active || sess.role === "host";
    // An auto-reconnect attempt that doesn't come up just counts as a failed try: no "bye" (that would stop
    // the retries on both ends), the next attempt follows.
    if (sess.isReconnect && sess.role === "viewer") { closeSession(sess, false); reconnectFailed(sess, "no p2p"); return; }
    closeSession(sess, true, "Koneksi tidak terbentuk dalam 30 detik");
    if (fg) showToast(sess.role === "viewer" ? "Gagal tersambung: gambar dari PC remote tidak masuk dalam 30 detik. Coba hubungkan lagi."
      : "Koneksi dengan pengontrol tidak terbentuk dalam 30 detik, sesi diakhiri.");
  }, 30000);
  pc.onconnectionstatechange = () => {
    if (sess.pc !== pc) return;   // a newer pc replaced this one, ignore stale events
    sessLog(sess, "P2P " + pc.connectionState);
    if (pc.connectionState === "connected") {
      clearTimeout(sess.p2pTimer);
      if (sess.role === "viewer" && !sess.everConnected) playEvent(sess.isReconnect ? "back" : "connected", false, sess);
      sess.everConnected = true; sess.reconnectAttempts = 0;
      if (sess.role === "viewer") stopReconnect(sess.peerId);
      else { clearTimeout(lockGraceTimer); blackGraceOnConnect(sess); }   // the viewer came back within the grace period: don't lock
      updateDiscordPresence();
    }
    else if (pc.connectionState === "failed") {
      const target = sess.role === "viewer" ? sess.peerId : null;
      const wasActive = sess === active || sess.role === "host";
      closeSession(sess, false);
      if (target && (autoReconnect || reconnectState.get(target)?.force) && (sess.everConnected || sess.isReconnect)) tryReconnect(target, sess.savedPassword, wasActive);
      else if (wasActive) showToast(prefGet("protocol") === "p2p" ? "Koneksi P2P gagal, coba protokol Otomatis (Pengaturan → Koneksi) agar bisa lewat relay"
        : serverIceServers.length ? "Koneksi gagal, relay TURN tidak terjangkau" : "Koneksi P2P gagal, server belum menyediakan TURN relay");
    } else if (pc.connectionState === "disconnected") {
      // Host: the viewer can't send key/button "up" events while the link is down, don't leave them held
      // here for the grace period (or forever, if it never comes back).
      if (sess.role === "host") { try { window.electronAPI.releaseRemoteInput(); } catch {} }
      // A weak link stalls for a few seconds now and then ("disconnected" = no reply for ~2.5 s); WebRTC usually comes
      // back by itself. Ending the session after 5 s turned every stall into a drop and a full reconnect (owner's test,
      // 12 Nov). Now the viewer restarts ICE after 3 s (and every 6 s after that, a new path if the old one is gone),
      // and the session only ends after 15 s (viewer) / 20 s (host, so it is still there for the viewer's restart).
      if (sess.role === "viewer") {
        clearTimeout(sess.iceRestartTimer);
        const restart = () => {
          if (sess.pc !== pc || pc.connectionState !== "disconnected") return;
          sessLog(sess, "link stalled, restarting ICE");
          if (sess === active) { playEvent("warn"); showToast("Koneksi tersendat, menyambung kembali…"); }
          try { pc.restartIce(); negotiate(sess).catch(() => {}); } catch {}
          sess.iceRestartTimer = setTimeout(restart, 6000);
        };
        sess.iceRestartTimer = setTimeout(restart, 3000);
      }
      clearTimeout(sess.disconnectTimer);
      sess.disconnectTimer = setTimeout(() => {
        // Only act if this is still the same live connection (avoid tearing down a new session)
        if (sess.pc === pc && pc.connectionState === "disconnected") {
          const target = sess.role === "viewer" ? sess.peerId : null;
          const wasActive = sess === active || sess.role === "host";
          closeSession(sess, false);
          if (target && autoReconnect) tryReconnect(target, sess.savedPassword, wasActive);
          else if (wasActive) { if (target) playEvent("lost"); showToast("Koneksi terputus"); }
        }
      }, sess.role === "viewer" ? 15000 : 20000);
    }
  };
}

// Session auto-reconnect (viewer side): after an UNEXPECTED drop, keep trying the same PC, with THAT tab's own
// password, without pulling the user away from another tab. Per PC, with growing pauses;
// each try first waits for our own server link (after sleep / a Wi-Fi switch it is reconnecting too), and a try
// that fails (offline, busy, no answer) schedules the next. A deliberate end (bye) never reconnects.
const RECONNECT_DELAYS = [2, 4, 8, 15, 30];   // seconds before try 1..5
const reconnectState = new Map();              // peerId -> { n, password, foreground, timer }
// force: the other PC just moved to the TryDesk service ("Minta akses admin"): reconnect even with the setting off,
// and give the service time to start first (its first sign-in takes a few seconds).
const SVC_MOVE_DELAYS = [6, 5, 6, 8, 12, 20];
function tryReconnect(target, password = "", foreground = true, force = false) {
  const st = reconnectState.get(target) || { n: 0 };
  if (force) st.force = true;
  if (!autoReconnect && !st.force) return;
  clearTimeout(st.timer);
  const delays = st.force ? SVC_MOVE_DELAYS : RECONNECT_DELAYS;
  if (st.n >= delays.length) { reconnectState.delete(target); showToast(t("reconnect_failed")); return; }
  if (password) st.password = password;
  st.foreground = foreground;
  if (st.n === 0 && !st.force) playEvent("lost");   // the drop itself, not every try after it
  const delay = delays[st.n++] * 1000;
  reconnectState.set(target, st);
  if (!(st.force && st.n === 1)) showToast(`Menyambung ulang ke ${fmtId(target)} (${st.n}/${delays.length})…`);   // (the first: onBye said why)
  const attempt = () => {
    if (reconnectState.get(target) !== st || sessions.has(target)) return;
    // Our own server link isn't back yet. A LAN session ("Sambung lewat IP") doesn't need it: on a network without
    // internet myId never comes, and waiting for it meant the reconnect never ran and never gave up.
    if (!myId && !isLanId(target)) { st.timer = setTimeout(attempt, 1000); return; }
    const s = initiateConnection(target, st.password || "", { background: !st.foreground || (!!active && active.peerId !== target) });
    if (s && typeof s === "object") { s.isReconnect = true; s.wasForeground = st.foreground; }
  };
  st.timer = setTimeout(attempt, delay);
}
function stopReconnect(target) { const st = reconnectState.get(target); if (st) { clearTimeout(st.timer); reconnectState.delete(target); } }
// A failed reconnect try: decide whether another one makes sense.
function reconnectFailed(s, reason = "") {
  if (!s.isReconnect) return;
  // The owner said no, or the password is wrong / locked out: retrying would only nag them.
  if (/ditolak|Password salah|percobaan/i.test(reason)) { stopReconnect(s.peerId); return; }
  tryReconnect(s.peerId, s.savedPassword, s.wasForeground);
}

// "bye" on the control channel = this end was DELIBERATE (Putuskan, tab closed, session time limit), with the
// reason to show. It also ends the other side at once even when the signaling link is down, and it is how
// the other side knows not to auto-reconnect / to lock Windows right away rather than after a grace period.
function sendBye(sess, reason = "") {
  try {
    if (sess.dataChannel && sess.dataChannel.readyState === "open") { sess.dataChannel.send(JSON.stringify({ __ctrl: "bye", reason })); return true; }
  } catch {}
  return false;
}
// Reasons (rejection, end of session) are typed by the OTHER PC and shown as TryDesk's own toast, so a hostile
// peer could write "TryDesk: akun diblokir, hubungi WA ...". Every reason TryDesk sends is a fixed text that also
// sits in TEXT_EN (it gets translated), so that list is the allow-list; anything else shows the plain fallback.
// One reason carries a number (the LAN password length), so it is matched by its exact shape instead.
const KNOWN_PEER_REASON = /^(PC tujuan perlu password akses minimal \d{1,2} karakter untuk koneksi lewat IP|PC ini memakai layanan TryDesk\. Sambung ke ID \d{3} \d{3} \d{3})$/;
function knownPeerText(reason, fallback) {
  const r = typeof reason === "string" ? reason.trim() : "";
  // The host's short reason, with what to do about it (any host version sends the short one)
  if (r === HOST_ADMIN_NO_CAPTURE) return HOST_ADMIN_NO_CAPTURE_VIEWER;
  return r &&(Object.prototype.hasOwnProperty.call(TEXT_EN, r) || KNOWN_PEER_REASON.test(r)) ? r : fallback;
}
function onBye(sess, reason) {
  sess.byeReceived = true;
  if (sess.role === "viewer") stopReconnect(sess.peerId);
  const fg = sess === active;
  closeSession(sess, false);
  // The other PC installed the TryDesk service at our request and ended this session to hand over to it: come back
  // through the service (same ID, same password), where the UAC prompt and the lock screen can be seen.
  if (sess.role === "viewer" && sess.elevMove) {
    showToast(trL("Layanan TryDesk terpasang di PC remote. Menyambung ulang lewat layanan…", "The TryDesk service is installed on the remote PC. Reconnecting through it…"));
    tryReconnect(sess.peerId, sess.savedPassword, fg, true);
    return;
  }
  showToast(knownPeerText(reason, "Remote desktop memutus koneksi"));
}

// Settings → Keamanan → lock Windows after a session. A deliberate end locks right away; an unexpected drop
// (Wi-Fi blip, the viewer's PC crashed) waits a minute so a reconnect doesn't land on the lock screen.
let lockGraceTimer = null;
function lockAfterSession(sess, deliberate) {
  if (!prefGet("lockAfter") || !sess.everConnected) return;
  clearTimeout(lockGraceTimer);
  const lock = () => { try { window.electronAPI.lockWorkstation(); } catch {} };
  if (deliberate) lock();
  else lockGraceTimer = setTimeout(() => { if (!host || !host.everConnected) lock(); }, 60000);
}
// The dark cover kept over an unexpected drop (see closeSession). The same viewer gets 5 s after reconnecting to ask
// for it again (its app does so by itself); anyone else connecting, the panic key, or the end of the grace lifts it.
let blackScreenGrace = false, blackGracePeer = null, blackGraceTimer = null;
function startBlackGrace(peerId) {
  blackScreenGrace = true; blackGracePeer = peerId;
  clearTimeout(blackGraceTimer);
  blackGraceTimer = setTimeout(endBlackGrace, prefGet("lockAfter") ? 62000 : 20000);
}
function endBlackGrace() {
  clearTimeout(blackGraceTimer); blackGraceTimer = null;
  if (!blackScreenGrace) return;
  blackScreenGrace = false;
  if (host && host.blackScreenActive) return;   // the reconnected viewer took the cover over
  try { window.electronAPI.disableBlackScreen(); } catch {}
}
function blackGraceOnConnect(sess) {
  if (!blackScreenGrace) return;
  clearTimeout(blackGraceTimer);
  blackGraceTimer = setTimeout(endBlackGrace, sess.peerId === blackGracePeer ? 5000 : 0);
}
function flushCandidates(sess) { for (const c of sess.pendingCandidates) sess.pc.addIceCandidate(c).catch(() => {}); sess.pendingCandidates = []; }

// Tear down ONE session (a viewer tab, or the single host session) and update the UI.
// Other tabs are left untouched. notify = the user (or a time limit) ended it on purpose: the peer gets a "bye"
// with the reason, and no auto-reconnect follows.
function closeSession(sess, notify = true, reason = "") {
  if (!sess) return;
  const isViewer = sess.role === "viewer";
  const wasActive = sess === active;
  let byeSent = false;
  sessLog(sess, `closed (${notify ? "on purpose" : "dropped"}${reason ? ": " + reason : ""}, was ${sess.everConnected ? "connected" : "never connected"})`);
  clearTimeout(sess.p2pTimer);
  if (notify) { byeSent = sendBye(sess, reason); if (isViewer) { stopReconnect(sess.peerId); wantBlackScreen.delete(sess.peerId); } }
  // Ended on purpose (here, or the other side's bye in onBye): one falling knock, played once this PC is no longer
  // being controlled (a host plays nothing during a session, its sound travels to the viewer).
  if ((notify || sess.byeReceived) && sess.everConnected && !sess.sndOff) setTimeout(() => playEvent("ended"), 0);
  // main.js forgets the lock screen when hosting ends; so does this, or the next viewer's key panel would show the
  // short lock-screen list for its whole session (independent review 19 Nov)
  if (!isViewer && (!host || host === sess)) _hostSecureDesk = false;
  if (isViewer) { clearTimeout(sess.thumbTimer); if (sess.hasFrame) saveThumb(sess); }
  if (isViewer && recordingActive && recordingSess === sess) stopRecording();   // flush & save THIS tab's recording
  // The capture/sound helpers are one per PC: only the session that owns them (the current host, or none left) stops them,
  // never a stale earlier attempt closing late while the next session already uses them.
  if (isViewer) viewerFastStop(sess, "session closed", false); else { hostFastStop(sess, "session closed"); if (!host || host === sess) { stopNativeCapture(); stopNativeAudio(); } }
  // Tell the server to drop THIS specific pairing (targetId scopes it to the right peer so other
  // tabs survive). On an old single-session server, targetId is simply ignored.
  // A deliberate end also says so through the server (bye + reason): the P2P "bye" can't go out when the control
  // channel isn't open (yet), and the peer must still know not to reconnect.
  if (sess.peerId) {
    if (isViewer && !sess.pc) sendSignal({ type: "cancel-request", targetId: sess.peerId });
    else sendSignal(notify ? { type: "disconnect", targetId: sess.peerId, bye: true, reason } : { type: "disconnect", targetId: sess.peerId });
  }

  clearTimeout(sess.disconnectTimer); sess.disconnectTimer = null;
  clearTimeout(sess.requestTimer);
  stopStats(sess);
  stopClipboardSync(sess);
  // dropped, not ended (by us or, with a "bye", by the other side): half-done file transfers wait to go on (fmStash)
  cleanupTransfers(sess, !notify && !sess.byeReceived);
  for (const [, p] of sess.fsPending) { clearTimeout(p.timer); try { p.reject(new Error("closed")); } catch {} }
  sess.fsPending.clear();
  // Closing the connection right after the "bye" would drop it in flight, give it a moment to arrive.
  {
    const dc = sess.dataChannel, fc = sess.fileChannel, pc = sess.pc;
    sess.dataChannel = null; sess.fileChannel = null; sess.pc = null;
    if (pc) pc.onconnectionstatechange = null;
    if (dc) dc.onmessage = null;
    const shut = () => { try { dc && dc.close(); } catch {} try { fc && fc.close(); } catch {} try { pc && pc.close(); } catch {} };
    if (byeSent) setTimeout(shut, 300); else shut();
  }
  if (sess.localStream) { sess.localStream.getTracks().forEach((t) => t.stop()); sess.localStream = null; }
  if (isViewer) monViewerStop(sess); else hostMonStop(sess);
  stopSessionTimer(sess);
  if (sess.video) { try { sess.video.srcObject = null; } catch {} sess.video.remove(); sess.video = null; }
  sess.pendingCandidates = [];
  sess.pwPrompt = null;
  updateDiscordPresence();   // session ended → refresh (likely back to "idle")

  if (sess.role === "host") {
    // Only the CURRENT host session owns the shared host state (privacy overlays, held input, UI), a late
    // teardown of an older, already-replaced one must not undo the live session's.
    if (host !== sess) return;
    // Host teardown, release privacy features defensively and reset host UI.
    try { window.electronAPI.releaseRemoteInput(); } catch {}
    clearTimeout(sess.limitTimer);
    try { window.electronAPI.setPowerSave(false); window.electronAPI.setHostingState(false); } catch {}
    // Settings → Keamanan: lock Windows once a session that really ran has ended (see lockAfterSession).
    lockAfterSession(sess, notify || !!sess.byeReceived);
    if (acceptDlgCancel) acceptDlgCancel();
    if (acceptTimerHandle) { clearInterval(acceptTimerHandle); acceptTimerHandle = null; }
    // An unexpected drop (Wi-Fi blip) while dark keeps the cover a little longer, so the person at this PC doesn't
    // see what the viewer left open while it reconnects; with "lock after session" until Windows has locked.
    if (sess.blackScreenActive && sess.everConnected && !(notify || sess.byeReceived)) startBlackGrace(sess.peerId);
    else { endBlackGrace(); try { window.electronAPI.disableBlackScreen(); } catch {} }
    try { window.electronAPI.disableInputLock(); } catch {}
    stopHostingTimer();
    $("#overlay-accept").classList.add("hidden");
    hostCaptureHeight = 0;
    $("#blackscreen-notice")?.classList.add("hidden");
    host = null;
    if (config && config.serviceHost && !acceptPending) { serviceHideWindow(); svcChat = []; svcXfer.clear(); svcPublish({ state: "idle" }); }
    showScreen(viewerSessions().length ? "remote" : "home");
    if (viewerSessions().length && active) switchTab(active);
    return;
  }

  // Viewer tab teardown
  sessions.delete(sess.peerId);
  if (wasActive) active = null;
  const remaining = viewerSessions();
  if (remaining.length) {
    renderTabs();
    if (wasActive) switchTab(remaining[remaining.length - 1]);
  } else {
    // Last viewer tab closed, reset the shared remote UI and leave the remote screen.
    resetRemoteUI();
    renderTabs();
    showScreen(host ? "hosting" : "home");
  }
}

// Reset the shared remote-screen widgets to defaults (used when the last viewer tab closes).
function resetRemoteUI() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  scaleMode = "fit"; $("#scale-select").value = "fit";
  $("#remote-loading")?.classList.add("hidden");
  qualityPanel.classList.add("hidden");
  if (ccDocked) ccSetDocked(false); else $("#screen-remote").classList.remove("cc-docked");
  $("#monitor-picker").style.display = "none";
  closeAllMenus();
  $("#btn-audio").classList.remove("active"); $("#btn-audio").disabled = true;
  closeChat();
  closeKeysPanel();
  $("#btn-blackscreen")?.classList.remove("active");
  $("#btn-lock-input")?.classList.remove("active");
  $("#btn-viewonly")?.classList.remove("active");
  $("#remote-canvas-container")?.classList.remove("viewonly");
  $("#chat-messages").replaceChildren(Object.assign(document.createElement("div"), { className: "chat-empty", textContent: "Belum ada pesan" }));
  clearChatUnread();
}

// ═══════════════════════════════════════════════════════════
//  Remote tabs (AnyDesk-style): one tab per viewer session + "＋"
// ═══════════════════════════════════════════════════════════
function renderTabs() {
  const bar = $("#remote-tabs");
  if (!bar) return;
  const list = viewerSessions();
  bar.classList.toggle("has-tabs", list.length > 0);
  bar.replaceChildren();
  for (const s of list) {
    const tab = document.createElement("button");
    tab.className = "rtab" + (s === active ? " active" : "") + (s.chatUnread ? " unread" : "");
    tab.dataset.sid = s.sid;
    tab.title = `${s.label} · ${fmtId(s.peerId)}. ${trL("Klik dua kali untuk mengganti nama", "Double-click to rename")}`;
    const dot = s.pc ? (s.hasFrame ? "live" : "wait") : "wait";
    tab.innerHTML =
      `<span class="rtab-dot ${dot}"></span>` +
      `<span class="rtab-label"></span>` +
      `<span class="rtab-close" title="Tutup tab"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>`;
    tab.querySelector(".rtab-label").textContent = s.label;
    tab.addEventListener("click", (e) => {
      if (e.target.closest(".rtab-close")) { e.stopPropagation(); closeSession(s, true); return; }
      if (s !== active) switchTab(s);
    });
    tab.addEventListener("dblclick", (e) => { if (!e.target.closest(".rtab-close")) renameTab(s, tab); });
    tab.addEventListener("keydown", (e) => { if (e.key === "F2") { e.preventDefault(); renameTab(s, tab); } });
    bar.appendChild(tab);
  }
  const add = document.createElement("button");
  add.className = "rtab-add"; add.title = "Sambungkan remote baru";
  add.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  add.addEventListener("click", () => openNewConnection());
  bar.appendChild(add);
  renderBackPill();
  kmRefresh();   // Kelola banyak perangkat shows each PC's state from its tab
  $$(".pres-dot[data-pres-id]").forEach(paintPresDot);   // a PC just connected or disconnected: its dot follows
}

// The "＋" button: show the home screen to start another remote WITHOUT dropping existing tabs.
function openNewConnection() {
  remoteIdInput.value = "";
  remotePasswordInput.value = "";
  closeAllMenus();
  showScreen("home");
  remoteIdInput.focus();
}

// Switch which viewer tab is shown; restore all shared UI from that session.
function switchTab(sess) {
  if (!sess || sess.role !== "viewer") return;
  if (sess !== active) { releaseHeldInput(); keysReleaseHeld(); }
  const prev = active;
  active = sess;
  // Kelola tabs: the one leaving goes back to a light picture, the one coming in gets its full quality and may now
  // start the fast path (a background tab never takes the app's one UDP receiver)
  if (prev && prev !== sess && prev.bulk && prev.pc) { if (prev.fast) viewerFastStop(prev, "tab in the background", true); sendQuality(prev); }
  if (sess.bulk && sess.pc) { sendQuality(sess); if (sess.hostHasFast && !sess.fastChannel) viewerFastOpen(sess); }
  renderAdminBanner();
  renderKeysPanel();   // the panel follows the tab on screen (its name, its lock screen)
  scaleMode = sess.scaleMode;
  // A tab that is still connecting shows the Connecting screen (Cancel, and the password box if its PC asked).
  if (!sess.pc) {
    showScreen("connecting");
    $("#connecting-title").textContent = /^lan:/.test(sess.peerId) ? sess.peerId.slice(4) : fmtId(sess.peerId);
    $("#connecting-text").textContent = sess.pwPrompt ? "Menunggu password atau persetujuan pemilik PC" : `Menyambung ke ${peerName(sess.peerId) || "PC"}`;
    setConnectStep(2);
    renderTabs(); showActiveVideo(); renderPwPrompt();
    return;
  }
  showScreen("remote");
  renderTabs();
  showActiveVideo();
  setPeerLabel(sess.pc ? "Terhubung ke" : "Menghubungkan", sess.peerId, sess.pc ? "" : "…");
  setLatBadge(sess);
  $("#session-timer").textContent = sess.timerText;
  $("#scale-select").value = sess.scaleMode;
  applyScale();
  $("#btn-viewonly").classList.toggle("active", sess.viewOnly);
  $("#remote-canvas-container").classList.toggle("viewonly", sess.viewOnly);
  $("#btn-blackscreen").classList.toggle("active", sess.blackScreenActive);
  $("#btn-lock-input").classList.toggle("active", sess.inputLocked);
  const ab = $("#btn-audio"); ab.disabled = !sess.audioAvailable; ab.classList.toggle("active", sess.audioOn);
  renderMonitorPicker(sess);
  $("#remote-loading")?.classList.toggle("hidden", sess.hasFrame);
  renderChat(sess);
  syncQualityUI();
  closeAllMenus();
  if (sess.video) sess.video.focus();
}

// Show the active session's <video>, hide the rest (all stay live & decoding).
// Only the tab on screen is heard (each tab keeps its own audio on/off for when it is shown again).
function showActiveVideo() {
  for (const s of viewerSessions()) {
    for (const [, v] of s.monVids || []) v.classList.toggle("active", s === active);
    if (!s.video) continue;
    s.video.classList.toggle("active", s === active);
    s.video.muted = !(s === active && s.audioOn);
  }
  monLayout(active && active.role === "viewer" ? active : null);
}

// The service's host window is hidden unless a request is waiting or a session runs (main.js, service-*-window).
const serviceHideWindow = () => { try { window.electronAPI.serviceHideWindow(); } catch {} };
const serviceShowWindow = () => { try { window.electronAPI.serviceShowWindow(); } catch {} };
// SYSTEM has no language of its own, so the service's window was always English (owner's picture, 7 Nov): take the
// language the user picked in their own TryDesk (main.js, export-ui-lang / service-user-lang).
// ─── One TryDesk with the service, service host side (see main.js "One TryDesk") ───
// While the user's own TryDesk runs, this window stays hidden: the request, the session, Chat and Disconnect are
// shown there and answered from there. Without it (quit, after a restart) this window is the fallback, as before.
let svcFront = false;                       // the user's TryDesk is running
// svcRoutedReq: the request the user's own TryDesk was asked to answer (askAccept, routed). An "accept" in
// service-cmd.json counts only for that one: when this window shows the dialog itself, only a click here answers it
// (audit 19 Nov, TD-VULN-02: the file is the user's, any program they run can write it).
let svcRoutedReq = 0;
let svcReqSeq = 0, svcState = { state: "idle" }, svcChat = [], svcChatSeq = 0, svcCmdLast = 0;
const svcXfer = new Map();                  // file transfers of the service's session, shown in the user's TryDesk
function svcPublish(next) {
  if (!(config && config.serviceHost)) return;
  if (next) svcState = next;
  try { window.electronAPI.svcUiPublish({ ...svcState, chat: svcChat.slice(-50), xfers: [...svcXfer.values()] }); } catch {}
}
let svcPubTimer = null;   // progress: at most ~3 updates a second
function svcPublishSoon() { if (!svcPubTimer) svcPubTimer = setTimeout(() => { svcPubTimer = null; svcPublish(); }, 300); }
// The service's transfer card (in its own, usually hidden, window) also reports to the user's TryDesk.
function svcWrapCard(card, x) {
  if (!(config && config.serviceHost)) return card;
  svcXfer.set(x.id, x); svcPublish();
  const end = () => setTimeout(() => { svcXfer.delete(x.id); svcPublish(); }, 8000);
  const w = Object.create(card);
  // The card's own buttons call card.onAccept / onReject: set them there, not on this wrapper (the fallback window's
  // Accept did nothing before, 8 Nov).
  for (const k of ["onAccept", "onReject"]) Object.defineProperty(w, k, { get: () => card[k], set: (f) => { card[k] = f; } });
  return Object.assign(w, {
    setSub(t) { card.setSub(t); x.sub = String(t); svcPublishSoon(); },
    progress(d, total) { card.progress(d, total); x.state = "progress"; x.done = d; svcPublishSoon(); },
    toProgress() { card.toProgress(); x.state = "progress"; svcPublishSoon(); },
    finish(ok) { card.finish(ok); x.state = ok ? "ok" : "fail"; svcPublish(); end(); },
    remove() { card.remove(); svcXfer.delete(x.id); svcPublish(); },
  });
}
// A file the viewer offers: the person at this PC answers (in their TryDesk, or this window as the fallback); a yes
// saves it in their Downloads\TryDesk (no save dialog: that would be SYSTEM's).
function svcOnOffer(sess, ev) {
  const ch = sess.fileChannel;
  const no = (reason) => { try { ch.send(JSON.stringify({ t: "reject", id: ev.id, reason })); } catch {} };
  if (sess.role !== "host" || forceViewOnly || typeof ev.id !== "string" || _safeSize(ev.size) === null) return no("denied");
  if (fileBusy(sess) || sess.svcOffer) return no("busy");
  const name = safeFileName(ev.name);
  const card = svcWrapCard(createCard(sess, ev.id, { dir: "recv", name, size: ev.size, incoming: true }), { id: ev.id, dir: "recv", name, size: ev.size, state: "offer", done: 0, sub: "" });
  const offer = sess.svcOffer = { id: ev.id };
  offer.reject = () => { if (sess.svcOffer !== offer) return; sess.svcOffer = null; no(); card.remove(); };
  offer.accept = async () => {
    if (sess.svcOffer !== offer) return; sess.svcOffer = null;
    if (fileBusy(sess)) { no("busy"); card.remove(); return; }
    let r = null; try { r = await window.electronAPI.svcInboxOpen(name); } catch (e) { sessLog(sess, "service: can't save the file: " + (e && e.message)); }
    if (!r || !card.el.isConnected) { no("denied"); card.remove(); return; }
    sess.activeRecv = { id: ev.id, size: _safeSize(ev.size), received: 0, writeId: r.id, filePath: r.path, canceled: false, card };
    card.toProgress();
    ch.send(JSON.stringify({ t: "accept", id: ev.id }));
  };
  card.onAccept = offer.accept; card.onReject = offer.reject;
}
// The user's TryDesk sends a file: it copied it into the outbox; this host reads only that (main.js checks it).
async function svcSendFromOutbox(outId) {
  const sess = host;
  if (!sess || !sess.fileChannel || sess.fileChannel.readyState !== "open" || fileBusy(sess)) return;
  let r = null; try { r = await window.electronAPI.svcOutboxOpen(outId); } catch (e) { sessLog(sess, "service: outbox refused: " + (e && e.message)); }
  if (!r) { try { window.electronAPI.svcOutboxDone(outId); } catch {} return; }
  await sendOneFile(sess, { name: r.name, size: r.size, readId: r.id });
  try { window.electronAPI.svcOutboxDone(outId); } catch {}
}
const svcRouted = () => !!(config && config.serviceHost && svcFront);
let svcMadeWay = false;   // this session already moved to the user's TryDesk (window hidden here once)
// Service's window: Pengaturan / Kirim file open the person's OWN TryDesk, as them (main.js svc-open-user-app ->
// trydesk-service.exe launch-user). Nobody signed in (login screen): there is no "own TryDesk" to open.
let _svcOpenBusy = 0;
async function svcOpenUserApp(what) {
  if (Date.now() - _svcOpenBusy < 4000) return;   // one start per click burst
  _svcOpenBusy = Date.now();
  showToast(what === "files" ? "Membuka TryDesk Anda untuk mengirim file…" : "Membuka Pengaturan di TryDesk Anda…");
  let r = null; try { r = await window.electronAPI.svcOpenUserApp(what); } catch {}
  if (r && r.ok) return;
  _svcOpenBusy = 0;
  showToast(r && r.code === 3 ? "Masuk ke Windows dulu, lalu coba lagi" : tr("TryDesk Anda tidak bisa dibuka") + (r && r.code ? ` (${r.code})` : ""));
}
if (window.electronAPI?.svcFrontendAlive) {
  setInterval(async () => {
    if (!(config && config.serviceHost)) return;
    let alive = false; try { alive = !!(await window.electronAPI.svcFrontendAlive()); } catch {}
    const was = svcFront; svcFront = alive;
    // The user's TryDesk went away during a request or a session: this window takes over at once.
    // (the request now waits here: from this moment only a click in this window answers it, not the user's file)
    if (was && !alive && (acceptPending || host)) { svcRoutedReq = 0; serviceShowWindow(); if (acceptPending) { try { window.electronAPI.focusWindow(true); } catch {} } }
    // ...and the other way: it is running again (opened from this window's Pengaturan / Kirim file, or by hand) during
    // a session: the session moves there, with its Settings and Send file, and this window makes way. A request
    // waiting here is answered here first.
    // (not only on the change: a TryDesk that came up while a request waited here takes over once it is answered)
    if (alive && host && !acceptPending && !svcMadeWay) { svcMadeWay = true; svcPublish(); serviceHideWindow(); sessLog(host, "service: the user's TryDesk is running, session shown there"); }
    if (!alive || !host) svcMadeWay = false;
  }, 1500);
  // first answer before the first request
  window.electronAPI.svcFrontendAlive().then((a) => { svcFront = !!a; }).catch(() => {});
}
window.electronAPI?.onSvcCmd?.((c) => {
  if (!(config && config.serviceHost) || !c || c.n === svcCmdLast) return;
  svcCmdLast = c.n;
  if ((c.cmd === "accept" || c.cmd === "reject") && acceptPending && svcRoutedReq > 0 && c.req === svcRoutedReq && acceptDlgSettle) acceptDlgSettle(c.cmd === "accept");
  else if (c.cmd === "disconnect" && host) closeSession(host, true);
  else if (c.cmd === "chat" && host && c.text && host.dataChannel && host.dataChannel.readyState === "open") {
    host.dataChannel.send(JSON.stringify({ __ctrl: "chat", text: c.text })); addChatMessage(host, true, c.text);
  }
  else if ((c.cmd === "file-accept" || c.cmd === "file-reject") && host && host.svcOffer && host.svcOffer.id === c.text) (c.cmd === "file-accept" ? host.svcOffer.accept : host.svcOffer.reject)();
  else if (c.cmd === "file-send" && /^[0-9a-f]{16}$/.test(c.text)) svcSendFromOutbox(c.text);
});
async function serviceFollowUserLang() {
  if (!(config && config.serviceHost)) return;
  let l = null; try { l = await window.electronAPI.serviceUserLang?.(); } catch {}
  if (LANG_CODES.has(l) && l !== lang) { applyLanguage(l); $("#setting-language").value = l; }
}

// ─── Accept request (AnyDesk-style with countdown) ────────
const ACCEPT_TIMEOUT = 30; // seconds
// Why the last Accept dialog ended without a yes: nobody answered (timed out) vs. the owner clicked Tolak.
let lastAcceptTimedOut = false;
const declineReason = () => (lastAcceptTimedOut ? "Tidak ada jawaban dari pemilik PC" : "Koneksi ditolak");

function setAcceptHint(text) {
  const el = $("#accept-pw-hint");
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
}

function askAccept(fromId, fromName, hint = "") {
  // The service's host asks too: its window (SYSTEM, on the user's desktop) comes up with just this dialog. Nobody
  // there (lock screen, login screen): it times out like any unanswered request; the password still gets in.
  // A dark cover still up from a dropped session would hide this dialog (the covers sit above every window): the
  // person here must see who is asking, so the cover goes first.
  endBlackGrace();
  // The service's host with the user's TryDesk running: that TryDesk shows and answers this request (svcPublish below).
  const routed = svcRouted();
  return new Promise((resolve) => {
    if (!routed) { try { window.electronAPI.focusWindow(true); } catch {} }   // on top until answered (see main.js)
    $("#accept-id").textContent = fromId;
    setAcceptHint(hint);
    const aliasEl = $("#accept-alias");
    const alias = stripBidi(fromName).trim();   // the requester picks this text: no right-to-left tricks
    // Concept: one sentence that says who wants what ("Laptop-Ibu ingin mengontrol desktop ini.").
    // (This element is skipped by the EN text map because the name is the requester's text: build both languages here.)
    const setAlias = () => { const named = alias && alias !== "TryDesk User";
      aliasEl.textContent = trL(`${named ? alias : "Seseorang"} ingin mengontrol desktop ini.`, `${named ? alias : "Someone"} wants to control this desktop.`); };
    setAlias();
    // The service's window speaks the language of the user at this PC (picked in their own TryDesk).
    if (config && config.serviceHost) serviceFollowUserLang().then(setAlias);
    // Settings → Umum → Notifikasi: tell the user even when TryDesk is behind other windows.
    if (routed) { /* the user's TryDesk notifies */ }
    else {
      // The Windows notification is silent: TryDesk plays its own sound (concept "Suara", 19 Nov), never both.
      if (!document.hasFocus() && prefGet("notifyIncoming")) {
        try { new Notification(tr("Permintaan koneksi masuk"), { body: (alias && alias !== "TryDesk User" ? alias + " · " : "") + fmtId(fromId), silent: true }); } catch {}
      }
      requestSound($("#overlay-accept"));
    }
    // List only what this remote will REALLY be able to do, from the host's current permissions.
    $("#accept-perm-control").classList.toggle("hidden", !hostControlAllowed());
    $("#accept-perm-files").classList.toggle("hidden", !hostFilesAllowed());
    $("#accept-perm-clipboard").classList.toggle("hidden", !(allowClipboardPref && hostControlAllowed()));
    const ov = $("#overlay-accept");
    closeLanHelp();   // the help sits above other dialogs (z 55): a request must never hide behind it
    ov.classList.remove("hidden");
    const timerBar = $("#accept-timer-bar");
    let remaining = ACCEPT_TIMEOUT;
    timerBar.style.width = "100%";
    const countEl = $("#accept-countdown");
    const showCount = () => { if (countEl) countEl.textContent = `Ditolak otomatis dalam ${Math.max(0, remaining)} detik`; };
    showCount();
    acceptPending = true;
    acceptFromId = fromId;
    svcRoutedReq = 0;   // set again just below when the user's TryDesk is the one asked
    if (routed) {
      svcReqSeq++;
      svcRoutedReq = svcReqSeq;
      svcPublish({ state: "request", seq: svcReqSeq, req: { id: String(fromId), name: alias, hint: String(hint || ""), until: Date.now() + ACCEPT_TIMEOUT * 1000,
        perms: { control: hostControlAllowed(), files: hostFilesAllowed(), clipboard: !!(allowClipboardPref && hostControlAllowed()) } } });
    }

    if (acceptTimerHandle) clearInterval(acceptTimerHandle);
    acceptTimerHandle = setInterval(() => {
      remaining--;
      timerBar.style.width = `${(remaining / ACCEPT_TIMEOUT) * 100}%`;
      showCount();
      if (remaining <= 0) done(false, true);
    }, 1000);

    const acc = $("#btn-accept"), rej = $("#btn-reject");
    let settled = false;
    const done = (val, timedOut = false) => {
      if (settled) return;
      settled = true;
      lastAcceptTimedOut = timedOut;
      acceptPending = false;
      svcRoutedReq = 0;
      acceptFromId = null;
      acceptDlgCancel = null;
      acceptDlgSettle = null;
      if (acceptTimerHandle) { clearInterval(acceptTimerHandle); acceptTimerHandle = null; }
      ov.classList.add("hidden");
      // (focus-window always shows the window: not for a request the user's TryDesk answered, or it popped up here)
      if (!routed) { try { window.electronAPI.focusWindow(false); } catch {} }
      if (config && config.serviceHost && !val) { serviceHideWindow(); if (!host) svcPublish({ state: "idle" }); }
      acc.removeEventListener("click", onAcc);
      rej.removeEventListener("click", onRej);
      resolve(val);
    };
    acceptDlgCancel = () => done(false);
    acceptDlgSettle = done;
    const onAcc = () => done(true);
    const onRej = () => done(false);
    acc.addEventListener("click", onAcc);
    rej.addEventListener("click", onRej);
  });
}

// Dim the video briefly while the decoder recovers from a host resolution change, so the
// viewer sees a short clean fade rather than corrupt macroblocks.
function maskResChange(sess) {
  const v = sess.video; if (!v) return;
  v.classList.add("res-switching");
  clearTimeout(sess.resMaskTimer);
  sess.resMaskTimer = setTimeout(() => v.classList.remove("res-switching"), 380);
}

// ─── View scale & pan (viewer), operates on the active tab's video ───
function applyScale() {
  const video = activeVideo();
  const c = $("#remote-canvas-container");
  if (!video) return;
  // "Semua monitor" always fits the stage (the 100 % / 75 % sizes are for one monitor).
  if (active && active.monMode === "all" && (active.monSlots || []).length) { monLayout(active); return; }
  if (scaleMode === "fit") {
    // Skip redundant repaints (resize/loadedmetadata call this too), re-applying the same state
    // re-rasterizes the video layer and causes a visible flicker on every scale switch.
    if (c.classList.contains("fit") && !video.style.width) return;
    c.classList.add("fit"); c.classList.remove("scaled");
    video.style.width = ""; video.style.height = "";
  } else {
    const f = parseFloat(scaleMode) || 1;
    if (video.videoWidth) {
      const base = remoteBaseSize(active, video);
      const w = Math.round(base.w * f) + "px";
      const h = Math.round(base.h * f) + "px";
      if (c.classList.contains("scaled") && video.style.width === w && video.style.height === h) return;
      c.classList.remove("fit"); c.classList.add("scaled");
      video.style.width = w; video.style.height = h;
    } else {
      c.classList.remove("fit"); c.classList.add("scaled");
    }
  }
}
// The remote screen's own size in pixels, which 100 % / 75 % / 150 % are taken from. Not the size of the picture that
// arrives: the link control, a lower "Resolusi" or the first seconds of a session send it smaller, and 100 % then shrank
// into the middle of a black stage (Threads report, 21 Nov 2026: small picture in a black frame, window maximized).
// A 1.4.0 host sends each monitor's pixels; an older one: the largest picture this session has had at that shape.
function remoteBaseSize(sess, video) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const sameShape = (w, h) => w > 0 && h > 0 && Math.abs(w / h - vw / vh) < 0.02;
  const m = sess && (sess.monitors || []).find((x) => x.index === sess.currentMonitor);
  if (m && sameShape(m.pw, m.ph) && m.pw >= vw) return { w: m.pw, h: m.ph };
  if (!sess) return { w: vw, h: vh };
  const b = sess._baseSize;
  if (!b || b.mon !== sess.currentMonitor || !sameShape(b.w, b.h) || vw > b.w) sess._baseSize = { w: vw, h: vh, mon: sess.currentMonitor };
  return sess._baseSize;
}
// "Semua monitor" places its pictures in pixels of the stage: the stage changing size (maximize, full screen, Control
// Center docking, the window dragged bigger) must place them again, or they stay at the old size in a black frame.
try {
  let monRelayout = 0;
  new ResizeObserver(() => {
    if (monRelayout) return;
    monRelayout = requestAnimationFrame(() => { monRelayout = 0; if (active && active.monMode === "all" && (active.monSlots || []).length) monLayout(active); });
  }).observe($("#remote-canvas-container"));
} catch {}

// ─── Viewer: monitors & audio ─────────────────────────────
// A monitor list arrived for a session, store it; render the picker only for the active tab.
function showMonitors(sess, ev) {
  // Sanitize peer-supplied monitor metadata: coerce index to a real integer and label to a string
  // so it can never carry markup into the picker / Control Center labels.
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(-1e5, Math.min(1e5, Math.round(n))) : 0; };
  const before = (sess.monitors || []).length, curBefore = sess.currentMonitor;
  sess.monitors = (Array.isArray(ev.list) ? ev.list : []).slice(0, 16).map((m, i) => ({
    index: Number.isInteger(Number(m && m.index)) ? Number(m.index) : i,
    label: typeof (m && m.label) === "string" ? m.label : "",
    primary: !!(m && m.primary),
    // where it sits on that PC (a host before 1.4.0 sends none: the map then shows them in a row)
    x: num(m && m.x), y: num(m && m.y), w: Math.max(0, num(m && m.w)), h: Math.max(0, num(m && m.h)), pw: Math.max(0, num(m && m.pw)), ph: Math.max(0, num(m && m.ph)),
  }));
  sess.currentMonitor = Number.isInteger(Number(ev.current)) ? Number(ev.current) : 0;
  sess.audioAvailable = !!ev.audio;
  sess.hostMulti = ev.multi === 1 && sess.monitors.length > 1;
  sess.hostFollow = ev.follow === 1;
  // The other side can't show several monitors (any more), or it has another number of them: the views follow.
  if (sess.monMode && sess.monMode !== "single") {
    if (!sess.hostMulti) { sess.monMode = "single"; monApply(sess); }
    else if (sess.monitors.length !== before || sess.currentMonitor !== curBefore) monApply(sess);
    else monRenderViews(sess);
  }
  // The host's permissions can change mid-session: say so each time they flip, not only the first time.
  if (ev.perms) {
    const viewOnly = ev.perms.control === false;
    if (viewOnly !== !!sess.hostViewOnly && (viewOnly || sess.hostViewOnly !== undefined)) {
      showToast(viewOnly ? "PC remote hanya mengizinkan melihat layar, klik & ketikan tidak dikirim" : "PC remote mengizinkan kontrol lagi");
    }
    sess.hostViewOnly = viewOnly;
    sess.hostFiles = ev.perms.files !== false;
    if (sess === active) refreshKeyCapture();
  }
  updateSessionLabel(sess);
  if (sess === active) { renderMonitorPicker(sess); if (ccSub === "monitor") ccRefresh(); }
  renderTabs();
}

// The monitor shown in a viewer session (the map, the old picker, Control Center). From "Semua monitor" a click on one
// monitor shows that monitor alone.
function viewerSelectMonitor(sess, index) {
  if (!sess || !sess.dataChannel || sess.dataChannel.readyState !== "open") return;
  const leaving = sess.monMode && sess.monMode !== "single";
  if (leaving) { sess.monMode = "single"; monApply(sess); }
  if (index === sess.currentMonitor) { ccRefresh(); return; }
  sess.dataChannel.send(JSON.stringify({ __ctrl: "select-monitor", index }));
  sess.currentMonitor = index;
  updateSessionLabel(sess); renderTabs();
  const el = $("#monitor-label"); if (el) el.textContent = `Monitor ${index + 1}`;
  if (sess.video) maskResChange(sess);   // cover the switch transition cleanly
  showToast(`Beralih ke Monitor ${index + 1}…`);
  ccRefresh();
}

// ─── Monitors, viewer side: one, all at once, or a window each (Arah 1, owner 18 Nov 2026) ───
// Gallery: https://claude.ai/artifact/LBqQB7UeLZPbaddiBYb1DD (owner's pick: Arah 1, the map in Control Center).
// "all": the other monitors come on extra receive-only video lines (monTx) and are drawn beside the session's own
// <video>, placed as they stand on that PC; every move names the monitor under the mouse. "windows": each other
// monitor in a window of its own (main.js places them on this PC's other screens).
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const monName = (m) => `${m.index + 1}${m.primary ? " · utama" : ""}`;
async function setMonMode(sess, mode) {
  if (!sess || sess.role !== "viewer" || !sess.pc) return;
  if (mode === "windows" && isPhoneUi()) mode = "all";
  if (mode !== "single" && !sess.hostMulti) {
    showToast(sess.monitors.length > 1 ? "Perbarui TryDesk di PC itu untuk melihat semua monitor." : "PC itu hanya punya 1 monitor.");
    return;
  }
  if (mode === (sess.monMode || "single")) return;
  sess.monMode = mode; sess.monClosed = new Set();
  await monApply(sess);
}
async function monApply(sess) {
  if (!sess.pc) return;
  // A later call (another click, a new monitor list) while this one waits on the offer takes over: this one stops.
  const gen = (sess._monGen = (sess._monGen || 0) + 1);
  const others = () => {
    const closed = sess.monClosed || new Set();
    return (sess.monMode || "single") === "single" ? [] : sess.monitors.filter((m) => m.index !== sess.currentMonitor && !closed.has(m.index)).slice(0, MON_EXTRA_MAX);
  };
  sess.monTx = sess.monTx || [];
  let added = false;
  while (sess.monTx.length < others().length) {
    const t = sess.pc.addTransceiver("video", { direction: "recvonly" });
    applyCodecPreference(sess, t);
    sess.monTx.push(t); added = true;
  }
  if (added) {
    await negotiate(sess);
    for (let i = 0; i < 50 && sess.pc && sess.monTx.some((t) => !t.mid); i++) await sleepMs(100);
    if (!sess.pc || gen !== sess._monGen) return;
  }
  const mode = sess.monMode || "single";
  sess.monSlots = others().map((m, i) => ({ mon: m.index, tx: sess.monTx[i] })).filter((s) => s.tx && s.tx.mid);
  try { sess.dataChannel.send(JSON.stringify({ __ctrl: "mon-mode", mode, map: sess.monSlots.map((s) => ({ mid: s.tx.mid, mon: s.mon })) })); } catch {}
  if (mode !== "single" && !sess.monSlots.length) sess.monMode = "single";
  monRenderViews(sess);
  ccRefresh(); renderTabs();
}
function monStreamOf(slot) { const tr = slot.tx && slot.tx.receiver && slot.tx.receiver.track; return tr ? (slot._ms || (slot._ms = new MediaStream([tr]))) : null; }
// Builds (or takes down) what the mode shows: the extra <video>s and their captions, or the windows.
function monRenderViews(sess) {
  const mode = sess.monMode || "single";
  const slots = mode === "single" ? [] : (sess.monSlots || []);
  sess.monVids = sess.monVids || new Map();
  sess.monWins = sess.monWins || new Map();
  // extra pictures in this window ("all")
  for (const [mon, v] of [...sess.monVids]) if (mode !== "all" || !slots.some((s) => s.mon === mon)) { try { v.srcObject = null; } catch {} v.remove(); sess.monVids.delete(mon); }
  if (mode === "all") for (const s of slots) {
    let v = sess.monVids.get(s.mon);
    if (!v) {
      v = document.createElement("video"); v.className = "remote-video mon-x"; v.autoplay = true; v.playsInline = true; v.muted = true;
      v.dataset.mon = String(s.mon);
      $("#video-wrap").appendChild(v); sess.monVids.set(s.mon, v);
    }
    const ms = monStreamOf(s); if (ms && v.srcObject !== ms) v.srcObject = ms;
  }
  // windows ("windows")
  for (const [mon, w] of [...sess.monWins]) if (mode !== "windows" || !slots.some((s) => s.mon === mon)) { sess.monWins.delete(mon); try { w._tdGone = true; w.close(); } catch {} }
  if (mode === "windows") slots.forEach((s, k) => { if (!sess.monWins.has(s.mon)) { const w = monOpenWindow(sess, s, k + 1); if (w) sess.monWins.set(s.mon, w); } else monWindowStream(sess.monWins.get(s.mon), s); });
  if (sess === active) { showActiveVideo(); monLayout(sess); if (mode !== "all") applyScale(); }
}
// "Semua monitor": the session's own picture and the others, laid out as the monitors stand on that PC, in the stage.
function monLayout(sess) {
  const c = $("#remote-canvas-container"), wrap = $("#video-wrap");
  const on = !!(sess && sess === active && sess.monMode === "all" && sess.video && (sess.monSlots || []).length);
  c.classList.toggle("mon-all", on);
  wrap.querySelectorAll(".mon-cap").forEach((e) => e.remove());
  if (!on) {
    if (sess && sess.video) for (const k of ["left", "top", "width", "height"]) sess.video.style[k] = "";
    if (sess && sess.video) sess.video.classList.remove("mon-here");
    sess && (sess._monCells = null);
    return;
  }
  const cells = [{ mon: sess.currentMonitor, video: sess.video }, ...sess.monSlots.map((s) => ({ mon: s.mon, video: sess.monVids.get(s.mon) }))].filter((x) => x.video);
  const geo = cells.map((x) => sess.monitors.find((m) => m.index === x.mon) || { w: 16, h: 9, x: 0, y: 0 });
  // A host without positions: in a row, bottoms in line.
  const hasPos = geo.every((g) => g.w > 0 && g.h > 0) && geo.some((g) => g.x || g.y);
  const boxes = [];
  if (hasPos) {
    // Sorted by where they stand from left to right; a small gap between neighbours, heights true to each other.
    const order = cells.map((x, i) => i).sort((a, b) => geo[a].x - geo[b].x);
    let cx = 0; for (const i of order) { boxes[i] = { x: cx, y: geo[i].y, w: geo[i].w, h: geo[i].h }; cx += geo[i].w; }
  } else { let cx = 0; geo.forEach((g, i) => { const w = g.w || 1920, h = g.h || 1080; boxes[i] = { x: cx, y: -h, w, h }; cx += w; }); }
  const minY = Math.min(...boxes.map((b) => b.y)), maxY = Math.max(...boxes.map((b) => b.y + b.h)), totW = boxes.reduce((a, b) => Math.max(a, b.x + b.w), 0);
  const W = c.clientWidth, H = c.clientHeight, gap = 8, capH = 24, pad = 16, n = boxes.length;
  const s = Math.max(0.01, Math.min((W - 2 * pad - gap * (n - 1)) / totW, (H - 2 * pad - capH) / (maxY - minY)));
  const order = boxes.map((b, i) => i).sort((a, b) => boxes[a].x - boxes[b].x);
  const usedW = totW * s + gap * (n - 1), x0 = (W - usedW) / 2, y0 = (H - (maxY - minY) * s - capH) / 2;
  order.forEach((i, k) => {
    const b = boxes[i], v = cells[i].video;
    const L = x0 + b.x * s + gap * k, T = y0 + (b.y - minY) * s;
    Object.assign(v.style, { left: `${Math.round(L)}px`, top: `${Math.round(T)}px`, width: `${Math.round(b.w * s)}px`, height: `${Math.round(b.h * s)}px` });
    const m = geo[i], cap = document.createElement("span");
    cap.className = "mon-cap"; cap.dataset.mon = String(cells[i].mon);
    cap.style.left = `${Math.round(L)}px`; cap.style.top = `${Math.round(T + b.h * s + 6)}px`;
    const nm = document.createElement("span"); nm.textContent = monName(m || { index: cells[i].mon }); cap.appendChild(nm);
    const here = document.createElement("span"); here.className = "mon-here-t"; here.textContent = "mouse Anda di sini"; cap.appendChild(here);
    wrap.appendChild(cap);
  });
  sess._monCells = cells;
  monMarkHover(sess, sess._hoverMon ?? sess.currentMonitor);
}
function monMarkHover(sess, mon) {
  sess._hoverMon = mon;
  for (const x of sess._monCells || []) x.video.classList.toggle("mon-here", x.mon === mon);
  $$("#video-wrap .mon-cap").forEach((c) => c.classList.toggle("here", Number(c.dataset.mon) === mon));
}
// Wheel events -> notches for the other PC. A mouse wheel (40 px or more per event) keeps its old speed. A trackpad
// sends many small events (1-10 px each); each one used to become a whole notch, so a light two-finger swipe on a Mac
// scrolled the page far down (macOS audit 17 Nov: 60 px -> 20 notches). Small ones now add up: one notch per 40 px,
// started over when the direction turns.
function makeWheelTicks() {
  const acc = { x: 0, y: 0 };
  const one = (d, k) => {
    if (!d) return 0;
    if (Math.abs(d) >= 40) { acc[k] = 0; return Math.min(10, Math.round(Math.abs(d) / 40)) * Math.sign(d); }
    if (acc[k] && Math.sign(acc[k]) !== Math.sign(d)) acc[k] = 0;
    acc[k] += d;
    const n = Math.trunc(acc[k] / 40);
    acc[k] -= n * 40;
    return n;
  };
  const old = (d) => (d === 0 ? 0 : Math.max(1, Math.min(10, Math.round(Math.abs(d) / 40))) * Math.sign(d));
  // (lines / pages instead of pixels: as before, one event is at least one notch)
  return (e) => (e.deltaMode ? { x: old(e.deltaX), y: old(e.deltaY) } : { x: one(e.deltaX, "x"), y: one(e.deltaY, "y") });
}
// The point under the mouse in a <video> drawn with object-fit: contain, 0..1 of the picture (null outside it).
function pointInVideo(video, e) {
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || !rect.width) return null;
  const scale = Math.min(rect.width / vw, rect.height / vh);
  const w = vw * scale, h = vh * scale;
  const left = rect.left + (rect.width - w) / 2, top = rect.top + (rect.height - h) / 2;
  const x = (e.clientX - left) / w, y = (e.clientY - top) / h;
  return x < 0 || y < 0 || x > 1 || y > 1 ? null : { x, y };
}
// "Satu jendela per monitor": a plain window of this page (same renderer: it shows the picture this page receives),
// opened by name; main.js puts window k on this PC's k-th other screen, full size. Closing it brings that monitor back
// into the session's list (the others stay open); with none left the session shows one monitor again.
function monOpenWindow(sess, slot, k) {
  let w = null;
  try { w = window.open("about:blank", `tdmon-${k}-${slot.mon}`, "width=960,height=600"); } catch {}
  if (!w) { showToast("Jendela monitor tidak bisa dibuka."); return null; }
  const m = sess.monitors.find((x) => x.index === slot.mon) || { index: slot.mon };
  const d = w.document;
  d.title = `${sessName(sess)} · Monitor ${slot.mon + 1}`;
  const st = d.createElement("style");
  st.textContent = "html,body{margin:0;height:100%;background:#0b0b0c;overflow:hidden;font:600 12px Inter,'Segoe UI',sans-serif;color:#e8e8ea}"
    + "video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;outline:none;cursor:default}"
    + ".tab{position:absolute;left:50%;top:0;transform:translateX(-50%);display:flex;align-items:center;gap:7px;height:24px;padding:0 12px;background:#17181b;border:1px solid #2a2b30;border-top:0;border-radius:0 0 8px 8px;z-index:1;pointer-events:none;opacity:.92}"
    + ".tab i{width:6px;height:6px;border-radius:50%;background:#27c093}";
  d.head.appendChild(st);
  d.body.replaceChildren();
  const v = d.createElement("video"); v.autoplay = true; v.muted = true; v.playsInline = true; v.tabIndex = 0;
  const tab = d.createElement("div"); tab.className = "tab";
  const dot = d.createElement("i"); const lab = d.createElement("span"); lab.textContent = `${sessName(sess)} · ${m.index + 1}${m.primary ? " · " + tr("utama") : ""}`;
  tab.append(dot, lab);
  d.body.append(v, tab);
  w._tdSlot = slot; w._tdVideo = v;
  monWindowStream(w, slot);
  // Input: the same messages the session window sends, naming this monitor.
  let lastAt = 0, moveT = null, last = null;
  const flush = () => { moveT = null; lastAt = performance.now(); if (last) sendMoveTo(sess, last); };
  v.addEventListener("mousemove", (e) => {
    const p = pointInVideo(v, e); if (!p) return; p.mon = slot.mon; last = p;
    if (moveT) return; const wait = moveIntervalMs() - (performance.now() - lastAt);
    if (wait <= 0) flush(); else moveT = w.setTimeout(flush, wait);
  });
  const held = new Set(), keys = new Set();
  v.addEventListener("mousedown", (e) => { const p = pointInVideo(v, e); if (!p) return; p.mon = slot.mon; sendMoveTo(sess, p, true); const b = BUTTONS[e.button] || "left"; held.add(b); sendInputTo(sess, { action: "mousedown", button: b }); v.focus(); });
  v.addEventListener("mouseup", (e) => { const b = BUTTONS[e.button] || "left"; held.delete(b); sendInputTo(sess, { action: "mouseup", button: b }); });
  v.addEventListener("contextmenu", (e) => e.preventDefault());
  const wheelTicks = makeWheelTicks();
  v.addEventListener("wheel", (e) => { e.preventDefault(); const t = wheelTicks(e); if (t.x || t.y) sendInputTo(sess, { action: "scroll", deltaX: t.x, deltaY: t.y }); }, { passive: false });
  // Keys as in the session window: on a Mac, Cmd is Ctrl over there (and a key pressed with Cmd gets no keyup on a Mac).
  for (const type of ["keydown", "keyup"]) d.addEventListener(type, (e) => {
    e.preventDefault();
    const mac = isMacViewer(), vk = mac && MAC_CMD.has(e.keyCode) ? 17 : e.keyCode;
    if (mac && e.metaKey && type === "keydown" && !MODIFIER_VKS.has(e.keyCode)) { sendInputTo(sess, { action: "keydown", vk }); sendInputTo(sess, { action: "keyup", vk }); return; }
    if (type === "keydown") keys.add(vk); else keys.delete(vk);
    sendInputTo(sess, { action: type, vk });
  });
  const letGo = () => { for (const b of held) sendInputTo(sess, { action: "mouseup", button: b }); held.clear(); for (const vk of keys) sendInputTo(sess, { action: "keyup", vk }); keys.clear(); };
  w.addEventListener("blur", letGo);
  w.addEventListener("beforeunload", () => {
    letGo();
    if (w._tdGone) return;   // closed by this page (mode changed, session over)
    if (sess.monWins && sess.monWins.get(slot.mon) === w) {
      sess.monWins.delete(slot.mon);
      (sess.monClosed || (sess.monClosed = new Set())).add(slot.mon);
      if (!sess.monWins.size) sess.monMode = "single";
      setTimeout(() => monApply(sess), 0);
    }
  });
  return w;
}
function monWindowStream(w, slot) { try { const ms = monStreamOf(slot); if (ms && w._tdVideo && w._tdVideo.srcObject !== ms) { w._tdVideo.srcObject = ms; w._tdVideo.play().catch(() => {}); } } catch {} }
function monViewerStop(sess) {
  for (const [, v] of sess.monVids || []) { try { v.srcObject = null; } catch {} v.remove(); }
  for (const [, w] of sess.monWins || []) { try { w._tdGone = true; w.close(); } catch {} }
  sess.monVids = new Map(); sess.monWins = new Map(); sess.monSlots = []; sess.monMode = "single"; sess._monCells = null;
  if (sess === active || !active) { $("#remote-canvas-container").classList.remove("mon-all"); $$("#video-wrap .mon-cap").forEach((e) => e.remove()); }
}
function monSetFollow(sess, on) {
  prefSet("monFollow", !!on);
  try { sess.dataChannel.send(JSON.stringify({ __ctrl: "mon-follow", on: !!on })); } catch {}
  sess.hostFollow = !!on; ccRefresh();
}
// The map in Control Center › Monitor: the monitors drawn where they stand on that PC, to scale.
function monMapEl(sess, maxW, maxH) {
  const box = document.createElement("div"); box.className = "ccm-map";
  const ms = sess.monitors;
  const hasPos = ms.every((m) => m.w > 0 && m.h > 0) && ms.some((m) => m.x || m.y);
  // Without positions (one monitor, an older host): in a row, each its own shape when known.
  let rowX = 0;
  const g = ms.map((m) => {
    if (hasPos) return { x: m.x, y: m.y, w: m.w, h: m.h };
    const w = m.w > 0 ? m.w : 1920, h = m.h > 0 ? m.h : 1080, b = { x: rowX, y: 0, w, h }; rowX += w; return b;
  });
  const minX = Math.min(...g.map((b) => b.x)), minY = Math.min(...g.map((b) => b.y));
  const maxX = Math.max(...g.map((b) => b.x + b.w)), maxY = Math.max(...g.map((b) => b.y + b.h));
  const s = Math.min(maxW / (maxX - minX), maxH / (maxY - minY));
  const inner = document.createElement("div"); inner.className = "ccm-map-in";
  inner.style.width = `${Math.round((maxX - minX) * s)}px`; inner.style.height = `${Math.round((maxY - minY) * s)}px`;
  const all = sess.monMode && sess.monMode !== "single";
  ms.forEach((m, i) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "ccm-mon";
    const shown = all ? (m.index === sess.currentMonitor || (sess.monSlots || []).some((x) => x.mon === m.index)) : m.index === sess.currentMonitor;
    if (shown) b.classList.add("sel");
    if (m.ph > m.pw) b.classList.add("tall");
    const gap = 2;
    Object.assign(b.style, { left: `${Math.round((g[i].x - minX) * s) + gap}px`, top: `${Math.round((g[i].y - minY) * s) + gap}px`, width: `${Math.max(14, Math.round(g[i].w * s) - gap * 2)}px`, height: `${Math.max(10, Math.round(g[i].h * s) - gap * 2)}px` });
    const n = document.createElement("b"); n.textContent = String(m.index + 1); b.appendChild(n);
    if (m.primary) { const p = document.createElement("small"); p.textContent = "utama"; b.appendChild(p); }
    b.setAttribute("aria-label", `Monitor ${m.index + 1}`);
    b.setAttribute("aria-pressed", String(shown));
    b.addEventListener("click", (e) => { e.stopPropagation(); viewerSelectMonitor(sess, m.index); });
    inner.appendChild(b);
  });
  box.appendChild(inner);
  return box;
}
// Control Center › Monitor (the concept's panel): the map, three ways to show, Ikuti kursor.
function ccMonitorPanel(cc, el) {
  const sess = active;
  const h = el("h3", "ccm-title"); h.textContent = "Monitor"; cc.appendChild(h);
  // (the list comes with the session's first messages: the panel fills in when it arrives, see showMonitors)
  if (!sess || !sess.monitors.length) return;
  // One monitor (Windows Sandbox, a laptop): the same page, the map with that one and the other ways shown off with
  // the reason in a line that stays in a short window too (18 Nov: the page was empty there, its one line hidden).
  const one = sess.monitors.length < 2;
  const mode = sess.monMode || "single";
  if (!one) {
    const sub = el("p", "ccm-sub");
    sub.textContent = mode === "single" ? "Klik monitor lain di peta untuk pindah." : "Letaknya sama seperti di PC itu.";
    cc.appendChild(sub);
  }
  cc.appendChild(monMapEl(sess, isPhoneUi() ? 300 : 230, !isPhoneUi() && window.innerHeight < 540 ? 64 : 88));
  const lab = el("div", "ccm-label"); lab.textContent = "Cara tampil"; cc.appendChild(lab);
  const group = el("div", "ccm-opts"); group.setAttribute("role", "radiogroup"); group.setAttribute("aria-label", "Cara tampil");
  const opts = [
    ["single", "Satu monitor", "Pilih di peta. Gambar paling besar."],
    ["all", "Semua monitor", "Berdampingan di jendela ini."],
    ...(isPhoneUi() ? [] : [["windows", "Satu jendela per monitor", "Taruh di layar Anda sendiri."]]),
  ];
  for (const [k, title, desc] of opts) {
    const b = el("button", "ccm-opt" + (mode === k ? " on" : "")); b.type = "button";
    b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(mode === k));
    const off = k !== "single" && !sess.hostMulti;
    if (off) b.disabled = true;
    b.innerHTML = `<span class="ccm-rad" aria-hidden="true"></span><span class="ccm-ot"><b></b><small></small></span>`;
    b.querySelector("b").textContent = title;
    const why = one ? "PC itu hanya punya 1 monitor." : "Perbarui TryDesk di PC itu untuk melihat semua monitor.";
    b.querySelector("small").textContent = off && !one ? why : desc;
    if (off) b.title = why;   // the line is hidden in a short window
    if (!off) b.addEventListener("click", (e) => { e.stopPropagation(); setMonMode(sess, k); });
    group.appendChild(b);
  }
  cc.appendChild(group);
  if (one) { const n = el("p", "ccm-note"); n.textContent = "PC itu hanya punya 1 monitor."; cc.appendChild(n); return; }
  const fw = el("button", "ccm-switch"); fw.type = "button"; fw.setAttribute("role", "switch");
  const fOn = !!sess.hostFollow;
  fw.setAttribute("aria-checked", String(fOn));
  if (mode !== "single") fw.disabled = true;
  fw.innerHTML = `<span class="ccm-ot"><b></b><small></small></span><i class="ccp-tog${fOn ? " on" : ""}"></i>`;
  fw.querySelector("b").textContent = "Ikuti kursor";
  fw.querySelector("small").textContent = "Pindah ke monitor tempat kursor PC itu berada.";
  if (mode === "single") fw.addEventListener("click", (e) => { e.stopPropagation(); monSetFollow(sess, !fOn); });
  cc.appendChild(fw);
  if (mode !== "single") { const n = el("p", "ccm-note"); n.textContent = "Semua monitor mengirim satu gambar per monitor, jadi butuh internet lebih cepat."; cc.appendChild(n); }
}

function renderMonitorPicker(sess) {
  const wrap = $("#monitor-picker");
  const menu = $("#monitor-menu");
  wrap.style.display = sess.monitors.length >= 1 ? "" : "none";   // show whenever monitors are known
  const setLabel = () => { const el = $("#monitor-label"); if (el) el.textContent = `Monitor ${sess.currentMonitor + 1}`; };
  setLabel();
  menu.replaceChildren();
  for (const m of sess.monitors) {
    const item = document.createElement("button");
    item.className = "monitor-menu-item" + (m.index === sess.currentMonitor ? " active" : "");
    item.dataset.index = m.index;
    item.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg><span>Monitor ${m.index + 1}${m.primary ? " · utama" : ""}</span>`;
    item.addEventListener("click", () => {
      viewerSelectMonitor(sess, m.index);
      menu.querySelectorAll(".monitor-menu-item").forEach((b) => b.classList.toggle("active", +b.dataset.index === sess.currentMonitor));
      setLabel();
      closeAllMenus();
    });
    menu.appendChild(item);
  }
  const audioBtn = $("#btn-audio");
  audioBtn.disabled = !sess.audioAvailable;
  audioBtn.title = sess.audioAvailable ? "Audio remote" : "Audio tidak tersedia di remote";
}

// Tab label: the name given to this ID (Rename on a Recent tile), else the active monitor's name when known
// (AnyDesk-style), else the peer ID.
// The tab names the PC (its saved name, else its ID), as in concept B; which monitor is shown lives in Control
// Center's Monitor row. Double-click a tab to rename the PC (the same name as on its Recent tile).
function updateSessionLabel(sess) {
  sess.label = peerName(sess.peerId) || fmtId(sess.peerId);
}
function renameTab(sess, tab) {
  const label = tab.querySelector(".rtab-label");
  if (!label || tab.querySelector(".rtab-edit")) return;
  const input = document.createElement("input");
  input.className = "rtab-edit"; input.type = "text"; input.maxLength = 40;
  input.value = peerName(sess.peerId) || "";
  input.placeholder = fmtId(sess.peerId);
  input.setAttribute("aria-label", trL("Nama PC", "PC name"));
  label.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    if (save) setPeerName(sess.peerId, input.value);
    renderTabs(); try { renderRecent(); } catch {}
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("blur", () => finish(true));
}

function toggleAudio() {
  const sess = active; if (!sess || !sess.audioAvailable) return;
  sess.audioOn = !sess.audioOn;
  if (sess.video) { sess.video.muted = !sess.audioOn; if (sess.audioOn) sess.video.play().catch(() => {}); }   // sess is the active tab
  $("#btn-audio").classList.toggle("active", sess.audioOn);
  showToast(sess.audioOn ? "Audio remote aktif" : "Audio remote dimatikan");
}

// ─── Chat (per session: the active viewer tab, or the host session) ───
// The session the user is looking at: on the "being controlled" screen that is the host session, even when a
// viewer tab is also open, otherwise chat replies / sent files went to the wrong person.
function onHostingScreen() { return (!!host || !!svcMirror) && !$("#screen-hosting").classList.contains("hidden"); }
function curChatSess() { return onHostingScreen() ? (host || svcMirror) : (active || host || svcMirror); }
function chatOpen() { return !$("#chat-panel").classList.contains("hidden"); }
function openChat() {
  const sess = curChatSess(); if (!sess) return;
  closeKeysPanel();   // one panel on the right at a time
  $("#chat-with").textContent = sessName(sess);
  $("#chat-panel").classList.remove("hidden");
  paintChatKick(); clearInterval(chatKickTimer); chatKickTimer = setInterval(paintChatKick, 1000);
  sess.chatUnread = false;
  // The "Pesan baru" card for this session is answered now (it sat half under the panel at 700 px for its 6 s).
  const key = String(sess.sid || sess.peerId || "");
  for (const c of $$("#chat-notif-stack .chat-notif")) if (c.dataset.sess === key && !c.dataset.leaving) { c.dataset.leaving = "1"; c.classList.remove("show"); setTimeout(() => c.remove(), 240); }
  renderChat(sess);
  renderTabs();
  $("#chat-input").focus();
}
function closeChat() {
  $("#chat-panel").classList.add("hidden");
  clearInterval(chatKickTimer); chatKickTimer = null;
}
// "Chat · sesi 12:48": the running time of the session the chat belongs to.
let chatKickTimer = null;
function paintChatKick() {
  const sess = curChatSess();
  if (!sess) { closeChat(); return; }   // the session ended while the chat was open
  const el = sess && (sess.role === "host" || sess.mirror) ? $("#hosting-timer") : $("#session-timer");
  const tm = el && /\d/.test(el.textContent) ? el.textContent.trim() : "";
  $("#chat-kick").textContent = tm ? `Chat · sesi ${tm}` : "Chat";
}
function chatTime(at) {
  if (!at) return "";
  const d = new Date(at), h = String(d.getHours()).padStart(2, "0"), m = String(d.getMinutes()).padStart(2, "0");
  return `${h}${timeSep()}${m}`;
}
function toggleChat() { chatOpen() ? closeChat() : openChat(); }
function clearChatUnread() { $("#chat-unread").classList.add("hidden"); $("#chat-unread-host").classList.add("hidden"); }
function showChatUnread() { $("#chat-unread").classList.remove("hidden"); $("#chat-unread-host").classList.remove("hidden"); }

// Rebuild the chat panel from a session's log and sync its unread badge.
function renderChat(sess) {
  const box = $("#chat-messages");
  if (!sess || !sess.chatLog.length) {
    box.replaceChildren(Object.assign(document.createElement("div"), { className: "chat-empty", textContent: "Belum ada pesan" }));
  } else {
    // Bubbles in groups per sender; the time goes under the last bubble of a group (a new group after 5 minutes too).
    const out = [];
    sess.chatLog.forEach((m, i) => {
      out.push(chatMsgEl(sess, m));
      const nx = sess.chatLog[i + 1];
      if (!nx || nx.mine !== m.mine || (nx.at && m.at && nx.at - m.at > 300000)) {
        const tm = document.createElement("div"); tm.className = `chat-time ${m.mine ? "me" : "them"}`; tm.textContent = chatTime(m.at); out.push(tm);
      }
    });
    box.replaceChildren(...out);
    box.scrollTop = box.scrollHeight;
  }
  (sess && sess.chatUnread) ? showChatUnread() : clearChatUnread();
}

function addChatMessage(sess, mine, text, file) {
  sess.chatLog.push(file ? { mine, file, at: Date.now() } : { mine, text, at: Date.now() });
  if (sess.chatLog.length > 300) { const old = sess.chatLog.shift(); if (old && old.file && old.file.url) URL.revokeObjectURL(old.file.url); }
  if (sess === curChatSess() && chatOpen()) appendChatMsg(sess);
}
// One chat bubble: text, or a picture / file sent in the chat (chatSendFiles)
function chatMsgEl(sess, m) {
  const el = document.createElement("div");
  el.className = `chat-msg ${m.mine ? "me" : "them"}`;
  if (!m.file) { el.textContent = m.text; return el; }
  el.classList.add("chat-att"); el.dataset.cf = m.file.id;
  chatPaintAtt(sess, m, el);
  return el;
}
function chatPaintAtt(sess, m, el) {
  const f = m.file, img = f.img && f.url;
  el.classList.toggle("img", !!img);
  const state = f.state === "sending" ? fmL(`Mengirim ${Math.floor((f.done || 0) * 100 / Math.max(1, f.size))}%`, `Sending ${Math.floor((f.done || 0) * 100 / Math.max(1, f.size))}%`)
    : f.state === "failed" ? (f.why === "denied" ? fmL("Ditolak: PC itu tidak mengizinkan file", "Refused: that PC doesn't allow files") : fmL("Gagal terkirim", "Not sent"))
    : f.saved ? fmL("Tersimpan", "Saved") : "";
  el.innerHTML = (img ? `<img class="ca-img" alt="">` : `<div class="ca-file"><span class="ca-ic" aria-hidden="true">${FM_IC.file}</span><div class="ca-tx"><b></b><small></small></div></div>`) +
    `<div class="ca-foot"><small class="ca-st"></small>${f.state === "done" && f.blob ? `<button class="ca-save" type="button"></button>` : ""}</div>`;
  if (img) { const i = el.querySelector(".ca-img"); i.src = f.url; i.alt = f.name; i.title = f.name; }
  else { el.querySelector(".ca-tx b").textContent = f.name; el.querySelector(".ca-tx small").textContent = fmSize(f.size); el.querySelector(".ca-tx b").title = f.name; }
  el.querySelector(".ca-st").textContent = state;
  el.querySelector(".ca-foot").classList.toggle("hidden", !state && !(f.state === "done" && f.blob));
  const sv = el.querySelector(".ca-save");
  if (sv) { sv.textContent = fmL("Simpan", "Save"); sv.addEventListener("click", () => chatSaveAtt(sess, m)); }
}
// the bubble of an attachment changed (progress, sent, refused, saved): repaint it where it is
function chatRepaint(sess, m) {
  if (sess !== curChatSess() || !chatOpen()) return;
  const el = $(`#chat-messages .chat-att[data-cf="${CSS.escape(m.file.id)}"]`);
  if (el) chatPaintAtt(sess, m, el);
}
function appendChatMsg(sess) {
  const box = $("#chat-messages"), log = sess.chatLog, m = log[log.length - 1], prev = log[log.length - 2];
  if (!m) return;
  box.querySelector(".chat-empty")?.remove();
  // same sender within 5 minutes: the time moves down under the new bubble
  if (prev && prev.mine === m.mine && !(m.at && prev.at && m.at - prev.at > 300000)) { const last = box.lastElementChild; if (last && last.classList.contains("chat-time")) last.remove(); }
  const el = chatMsgEl(sess, m);
  const tm = document.createElement("div"); tm.className = `chat-time ${m.mine ? "me" : "them"}`; tm.textContent = chatTime(m.at);
  box.append(el, tm);
  box.scrollTop = box.scrollHeight;
}

function sendChat() {
  const sess = curChatSess(); if (!sess) return;
  const input = $("#chat-input");
  const text = input.value.trim();
  if (sess.mirror) {   // the service's session: the service sends it
    if (!text) return;
    try { window.electronAPI.svcCmd({ cmd: "chat", text }); } catch {}
    addChatMessage(sess, true, text); input.value = ""; return;
  }
  if (!text || !sess.dataChannel || sess.dataChannel.readyState !== "open") return;
  sess.dataChannel.send(JSON.stringify({ __ctrl: "chat", text }));
  addChatMessage(sess, true, text);
  input.value = "";
}

function onChatReceived(sess, text) {
  if (typeof text !== "string" || !text) return;
  // A peer flooding chat must not bury the app in cards and Windows notifications: cap the length, and
  // drop messages beyond 20 per 10 s from one session.
  const now = Date.now();
  sess.chatTimes = (sess.chatTimes || []).filter((t) => now - t < 10000);
  if (sess.chatTimes.length >= 20) return;
  sess.chatTimes.push(now);
  text = text.slice(0, 4000);
  addChatMessage(sess, false, text);
  // The service's host: the user's own TryDesk shows the chat (svcPublish).
  if (config && config.serviceHost && sess === host) { svcChat.push({ seq: ++svcChatSeq, text }); if (svcChat.length > 50) svcChat.shift(); svcPublish(); }
  const viewing = sess === curChatSess() && chatOpen();
  if (!viewing) { sess.chatUnread = true; if (sess === curChatSess()) showChatUnread(); renderTabs(); }
  // Notify unless the chat is already open AND the window is focused (user is actively reading).
  if (!(viewing && document.hasFocus())) showChatNotification(sess, text);
}

// ─── Pictures and files in the chat (owner 17 Nov: "chat harusnya bisa drag and drop dan copy paste file gambar atau
// file lainnya") ───
// Dropped on the chat, pasted into its typing box (Ctrl+V: a screenshot, or files copied in Explorer) or picked with
// the paper clip. Each one goes on its own data channel "cf:<id>" (header, the bytes, "end"; the receiver answers ok
// or why not), so input and File Transfer never wait behind it. Up to 25 MB each, kept in memory on both sides; the
// receiver saves it with Simpan (a Save dialog, marked as from the Internet like any received file). The PC being
// controlled takes them only while its "send and receive files" permission is on. Pictures are shown only as
// PNG / JPEG / GIF / WebP / BMP that really decode. Both ends must say they can ("caps" / "vcaps": chatfiles), because
// a TryDesk before this one would take a channel it doesn't know for its control channel.
const CHAT_FILE_MAX = 25 * 1024 * 1024, CHAT_IMG = /^image\/(png|jpeg|gif|webp|bmp)$/;
const chatFilesOk = (sess) => !!sess && !sess.mirror && !(config && config.serviceHost) && !!sess.pc && !!sess.peerChatFiles && !!sess.dataChannel && sess.dataChannel.readyState === "open";
function chatSendFiles(files) {
  const sess = curChatSess(); if (!sess) return;
  if (!chatFilesOk(sess)) {
    showToast(sess.mirror || (config && config.serviceHost) ? fmL("File belum bisa dikirim lewat chat di sesi layanan Windows", "Files can't be sent through the chat in a Windows service session yet")
      : fmL("PC itu perlu TryDesk terbaru untuk menerima file di chat", "That PC needs the latest TryDesk to get files in the chat"));
    return;
  }
  for (const file of [...files].slice(0, 10)) {
    if (!file) continue;
    if (!file.size && !file.type) { showToast(fmL("Folder belum bisa dikirim lewat chat: pakai Transfer File", "Folders can't be sent through the chat: use File Transfer")); continue; }
    if (file.size > CHAT_FILE_MAX) { showToast(fmL(`${file.name}: lebih dari 25 MB, kirim lewat Transfer File`, `${file.name}: over 25 MB, send it with File Transfer`)); continue; }
    chatSendOne(sess, file);
  }
}
function chatSendOne(sess, file) {
  const id = "cf" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const img = CHAT_IMG.test(file.type || "");
  const name = safeFileName(file.name || (img ? "image." + (file.type.split("/")[1] || "png") : "file")).slice(0, 200);   // (a file name, as Windows names a pasted picture)
  const m = { mine: true, at: Date.now(), file: { id, name, size: file.size, mime: file.type || "", img, url: img ? URL.createObjectURL(file) : null, blob: null, state: "sending", done: 0 } };
  addChatMessage(sess, true, null, m.file); m.file = sess.chatLog[sess.chatLog.length - 1].file;
  // here too a "picture" shows as one only when it really decodes (otherwise a broken-picture sign)
  if (img) createImageBitmap(file).then((b) => { try { b.close(); } catch {} }, () => { m.file.img = false; try { URL.revokeObjectURL(m.file.url); } catch {} m.file.url = null; chatRepaint(sess, m); });
  const fail = (why) => { if (m.file.state !== "sending") return; m.file.state = "failed"; m.file.why = why; chatRepaint(sess, m); };
  let ch; try { ch = sess.pc.createDataChannel("cf:" + id, { ordered: true }); } catch { return fail(); }
  ch.binaryType = "arraybuffer";
  ch.onopen = async () => {
    try {
      ch.send(JSON.stringify({ id, name, size: file.size, mime: m.file.mime }));
      const buf = new Uint8Array(await file.arrayBuffer());
      ch.bufferedAmountLowThreshold = 256 * 1024;
      let painted = 0;
      for (let o = 0; o < buf.length; o += 16384) {
        if (ch.readyState !== "open" || m.file.state !== "sending") throw new Error("closed");
        if (ch.bufferedAmount > 1024 * 1024) await new Promise((r) => { ch.onbufferedamountlow = () => { ch.onbufferedamountlow = null; r(); }; });
        ch.send(buf.subarray(o, Math.min(o + 16384, buf.length)));
        m.file.done = Math.min(buf.length, o + 16384);
        if (performance.now() - painted > 150) { painted = performance.now(); chatRepaint(sess, m); }
      }
      ch.send(JSON.stringify({ end: true }));
    } catch { fail(); }
  };
  ch.onmessage = (e) => {
    let r; try { r = JSON.parse(e.data); } catch { return; }
    if (r.ok) { m.file.state = "done"; m.file.done = m.file.size; chatRepaint(sess, m); } else fail(r.why);
    setTimeout(() => { try { ch.close(); } catch {} }, 300);
  };
  ch.onclose = () => fail();
}
// a channel "cf:<id>" from the other side: one picture or file for this chat
function chatRecvChannel(sess, ch) {
  ch.binaryType = "arraybuffer";
  let head = null, got = 0, done = false;
  const parts = [];
  const refuse = (why) => { done = true; parts.length = 0; try { ch.send(JSON.stringify({ ok: false, why })); } catch {} setTimeout(() => { try { ch.close(); } catch {} }, 500); };
  ch.onmessage = (e) => {
    if (done) return;
    if (typeof e.data !== "string") {
      if (!head) return refuse("bad");
      const u8 = new Uint8Array(e.data);
      got += u8.byteLength;
      if (got > head.size) return refuse("size");
      parts.push(u8);
      return;
    }
    let j; try { j = JSON.parse(e.data); } catch { return refuse("bad"); }
    if (!head) {
      if ((sess.role === "host" && !hostFilesAllowed()) || (config && config.serviceHost) || document.documentElement.classList.contains("td-mobile")) return refuse("denied");
      const now = Date.now();
      sess.chatFileTimes = (sess.chatFileTimes || []).filter((t) => now - t < 10000);
      if (sess.chatFileTimes.length >= 6) return refuse("busy");   // a flood: 6 per 10 s at most
      sess.chatFileTimes.push(now);
      if (!Number.isSafeInteger(j.size) || j.size < 0 || j.size > CHAT_FILE_MAX || typeof j.name !== "string") return refuse("size");
      head = { id: String(j.id || "").replace(/[^\w-]/g, "").slice(0, 40) || ("cf" + now), name: safeFileName(j.name).slice(0, 200) || "file", size: j.size, mime: typeof j.mime === "string" ? j.mime.slice(0, 100) : "" };
      return;
    }
    if (!j.end) return;
    if (got !== head.size) return refuse("short");
    done = true;
    const isImg = CHAT_IMG.test(head.mime);
    const blob = new Blob(parts, { type: isImg ? head.mime : "application/octet-stream" });
    const land = (asImg) => {
      addChatMessage(sess, false, null, { id: head.id, name: head.name, size: head.size, mime: head.mime, img: asImg, url: asImg ? URL.createObjectURL(blob) : null, blob, state: "done" });
      try { ch.send(JSON.stringify({ ok: true })); } catch {}
      const viewing = sess === curChatSess() && chatOpen();
      if (!viewing) { sess.chatUnread = true; if (sess === curChatSess()) showChatUnread(); renderTabs(); }
      if (!(viewing && document.hasFocus())) showChatNotification(sess, asImg ? fmL("Mengirim gambar", "Sent a picture") : fmL(`Mengirim file ${head.name}`, `Sent the file ${head.name}`));
    };
    // a "picture" is shown only when it really is one
    if (isImg) createImageBitmap(blob).then((b) => { try { b.close(); } catch {} land(true); }, () => land(false));
    else land(false);
  };
}
// Simpan: a Save dialog, then the bytes through the same file IPC as received files (marked as from the Internet)
async function chatSaveAtt(sess, m) {
  const f = m.file; if (!f || !f.blob) return;
  let p; try { p = await chooseSavePath(f.name); } catch { p = null; }
  if (!p) return;
  let id;
  try {
    id = await window.electronAPI.fileOpenWrite(p);
    const buf = new Uint8Array(await f.blob.arrayBuffer());
    for (let o = 0; o < buf.length; o += 1024 * 1024) {
      if ((await window.electronAPI.fileWriteChunk(id, buf.subarray(o, Math.min(o + 1024 * 1024, buf.length)))) === false) throw new Error("write");
    }
    await window.electronAPI.fileCloseWrite(id, false);
    f.saved = true; chatRepaint(sess, m);
    showToast(fmL(`Tersimpan: ${p}`, `Saved: ${p}`));
  } catch {
    if (id) { try { await window.electronAPI.fileCloseWrite(id, true); } catch {} }
    showToast(tr("Tidak bisa menyimpan di folder itu. Pilih folder lain, misalnya Unduhan."));
  }
}

// Slick in-app chat toast + native Windows notification when the app isn't focused.
function showChatNotification(sess, text) {
  playEvent("chatIn", false, sess);
  const focusSession = () => {
    if (sess.role === "viewer" && sessions.has(sess.peerId)) switchTab(sess);
    else if (sess.role === "host") showScreen("hosting");
    openChat();
  };
  if (!(sess === curChatSess() && chatOpen())) {
    let stack = $("#chat-notif-stack");
    if (!stack) { stack = document.createElement("div"); stack.id = "chat-notif-stack"; document.body.appendChild(stack); }
    // Owner 15 Nov: a guest typing many messages piled card on card up past the top of the window. One card per
    // session: a new message updates it ("3 pesan baru", the latest text) and starts its timer again.
    const key = String(sess.sid || sess.peerId || "");
    const open = [...stack.querySelectorAll(".chat-notif")].find((c) => c.dataset.sess === key && !c.dataset.leaving);
    if (open) { open._update(text); return notifyNative(); }
    const card = document.createElement("div");
    card.dataset.sess = key;
    // Arah 3 (owner pick 15 Nov): who wrote it, the message, and Buka chat / Nanti; a close button level with the name.
    card.className = "chat-notif cn3";
    card.innerHTML = `
      <div class="cn-head"><span class="cn-av" aria-hidden="true"></span><div class="cn-who"><b class="cn-name"></b><small>Pesan baru · baru saja</small></div>
      <button class="cn-close" type="button" aria-label="Tutup"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
      <div class="cn-text"></div>
      <div class="cn-acts"><button class="btn-connect cn-open" type="button">Buka chat</button><button class="btn-secondary cn-later" type="button">Nanti</button></div>`;
    const who = sessName(sess);
    card.querySelector(".cn-name").textContent = who;
    const av = card.querySelector(".cn-av");
    if (/^[\d\s.:]+$/.test(who)) av.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>';
    else av.textContent = ([...who][0] || "?").toUpperCase();
    card.querySelector(".cn-text").textContent = text;
    let timer, count = 1;
    const remove = () => { clearTimeout(timer); card.dataset.leaving = "1"; card.classList.remove("show"); setTimeout(() => card.remove(), 240); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(remove, 6000); };
    card._update = (t2) => {
      count++;
      card.querySelector(".cn-text").textContent = t2;
      card.querySelector(".cn-who small").textContent = `${count} pesan baru · baru saja`;
      if (!card.matches(":hover")) arm();
    };
    card.addEventListener("click", (e) => {
      if (e.target.closest(".cn-close, .cn-later")) { e.stopPropagation(); return remove(); }
      try { window.electronAPI.focusWindow(); } catch {}
      focusSession(); remove();
    });
    card.addEventListener("mouseenter", () => clearTimeout(timer));
    card.addEventListener("mouseleave", arm);
    stack.appendChild(card);
    // At most two cards on screen (two sessions at once); the oldest goes.
    const live = [...stack.querySelectorAll(".chat-notif")].filter((c) => !c.dataset.leaving);
    for (const old of live.slice(0, Math.max(0, live.length - 2))) { old.dataset.leaving = "1"; old.classList.remove("show"); setTimeout(() => old.remove(), 240); }
    requestAnimationFrame(() => card.classList.add("show"));
    arm();
  }
  notifyNative();
  // One Windows notification per session every 5 s at most; the in-app cards and the chat still show everything.
  function notifyNative() {
    if (document.hasFocus() || Date.now() - (sess.lastChatNotify || 0) <= 5000) return;
    sess.lastChatNotify = Date.now();
    try {
      const n = new Notification(tr("Pesan baru"), { body: text.slice(0, 160), silent: true });   // TryDesk plays its own sound
      n.onclick = () => { try { window.electronAPI.focusWindow(); } catch {} focusSession(); };
    } catch {}
  }
}

// ─── Black screen (privacy mode) ──────────────────────────
// handleBlackScreen runs on the HOST side (sess = host). toggleBlackScreen is the viewer control.
// Black screen and input lock act on THIS machine, so they obey the same host-side permission as input: a
// viewer the host limited to view-only (or with control switched off) may not darken or lock it. The host
// reports the real outcome so the viewer's toggle never claims something that didn't happen.
const hostControlAllowed = () => allowInput && !forceViewOnly;
// Files and clipboard are control too: dropping an .exe into the Startup folder or replacing the clipboard is
// taking over the PC. A view-only / no-control host serves neither, whatever the file-transfer toggle says.
const hostFilesAllowed = () => allowFileTransfer && hostControlAllowed();
// A file name sent by the peer becomes a bare base name, never a path that pre-points the save dialog or the
// file manager at another folder (e.g. "..\..\Startup\update.exe").
// Right-to-left override and the other bidi controls let "invoice<RLO>fdp.exe" show up as "invoiceexe.pdf".
const BIDI_CTRL = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const stripBidi = (s) => String(s || "").replace(BIDI_CTRL, "");
// A path the PEER asks the host to list/read/write must be a plain drive path ("C:\..."). "\\server\share",
// "\\?\", "\\.\pipe\..." were refused nowhere: a pipe blocks the read forever (the whole host app freezes,
// panic key included) and a UNC path makes Windows send this user's NTLM hash to whatever server the peer names.
// A device name anywhere in the path (C:\COM1, C:\x\CONIN$) opens a device instead of a file and can block the same way.
const peerPathOk = (p) => typeof p === "string" && /^[A-Za-z]:[\\/]/.test(p) && !p.includes("\0")
  && !p.slice(3).split(/[\\/]/).some((seg) => /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\.|$)/i.test(seg));
const safeFileName = (n) => {
  let s = stripBidi(n).split(/[\\/]/).pop().replace(/[:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+$/, "").replace(/[ .]+$/, "").slice(0, 200);
  // Windows reserved device names (CON, NUL, COM1…) would make the write hang or misbehave, prefix them.
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) s = "_" + s;
  return s || "file";
};
// A peer-declared transfer size → a safe non-negative integer, or null ("unknown"). Rejects NaN/Infinity so the
// disk-fill guard in onFileChunk (taken >= rec.size) can never be defeated by a non-numeric size.
const _safeSize = (v) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null);
function sendPrivacyResult(sess, feature, enabled, ok, reason) {
  if (sess.dataChannel && sess.dataChannel.readyState === "open") {
    try { sess.dataChannel.send(JSON.stringify({ __ctrl: "privacy-result", feature, enabled, ok, reason })); } catch {}
  }
}

// The host answers every request to darken: ok, or why not. Hosts before 1.3.2 only ever answered a refusal.
async function handleBlackScreen(sess, enabled) {
  if (enabled && !hostControlAllowed()) { sendPrivacyResult(sess, "black-screen", true, false, "denied"); return; }
  // Requests are numbered: an "off" that arrives while the covers are still being made wins, and the late answer
  // of the earlier "on" is dropped instead of claiming a dark screen (main handles the two calls in order).
  const req = sess.blackReq = (sess.blackReq || 0) + 1;
  if (!enabled) {
    sess.blackScreenActive = false;
    try { await window.electronAPI.disableBlackScreen(); } catch {}
    $("#blackscreen-notice").classList.add("hidden");
    return;
  }
  let ok = false;
  try { const r = await window.electronAPI.enableBlackScreen(); ok = r === true || !!(r && r.ok); } catch {}
  if (sess.blackReq !== req) return;
  // The session may have ended while the covers were being made: nobody would be left to lift them.
  if (host !== sess) { try { window.electronAPI.disableBlackScreen(); } catch {} return; }
  sess.blackScreenActive = ok;
  $("#blackscreen-notice").classList.toggle("hidden", !ok);
  sendPrivacyResult(sess, "black-screen", true, ok, ok ? "" : "failed");
}

// Redraw the open Control Center sub-menu so its check marks follow what the host reported.
function ccRefreshFlyout() { if (ccFlyoutCat === "security" && ccFlyoutRow) { try { ccOpenFlyout(ccFlyoutCat, ccFlyoutRow); } catch {} } }

function toggleBlackScreen() {
  const sess = active; if (!sess || !sess.dataChannel || sess.dataChannel.readyState !== "open") return;
  sess.blackScreenActive = !sess.blackScreenActive;
  sess.dataChannel.send(JSON.stringify({ __ctrl: "black-screen", enabled: sess.blackScreenActive }));
  $("#btn-blackscreen").classList.toggle("active", sess.blackScreenActive);
  // Remembered per PC, so an auto-reconnect after a network drop darkens the screen again.
  wantBlackScreen.set(sess.peerId, sess.blackScreenActive);
  clearTimeout(sess.blackAckTimer);
  if (!sess.blackScreenActive) { showToast("Layar remote dikembalikan"); return; }
  // "Darkened" is said once the host confirms it. An older host stays silent on success, so silence counts too.
  sess.blackAckTimer = setTimeout(() => { if (sess.blackScreenActive && sess.pc) showToast("Layar remote digelapkan"); }, 2500);
}
const wantBlackScreen = new Map();
// After a reconnect: ask for the dark screen again if the viewer had it on before the drop.
function reapplyBlackScreen(sess) {
  if (sess.role !== "viewer") return;
  // A connection made by hand starts fresh: only an automatic reconnect carries the wish over (the old one could
  // be left over from a session the host ended, and would darken a later session nobody asked to darken).
  if (!sess.isReconnect) { wantBlackScreen.delete(sess.peerId); return; }
  if (!wantBlackScreen.get(sess.peerId) || sess.blackScreenActive) return;
  if (!sess.dataChannel || sess.dataChannel.readyState !== "open") return;
  sess.blackScreenActive = true;
  sess.dataChannel.send(JSON.stringify({ __ctrl: "black-screen", enabled: true }));
  if (sess === active) $("#btn-blackscreen").classList.add("active");
}

// ─── Lock host input ──────────────────────────────────────
async function handleLockInput(sess, enabled) {
  if (!enabled) { sess.inputLocked = false; window.electronAPI.disableInputLock(); return; }
  if (!hostControlAllowed()) { sendPrivacyResult(sess, "lock-input", true, false, "denied"); return; }
  let ok = false;
  try { ok = !!(await window.electronAPI.enableInputLock()); } catch {}
  sess.inputLocked = ok;
  if (!ok) sendPrivacyResult(sess, "lock-input", true, false, "admin");
}

// Host: the local panic key (Ctrl+Alt+Shift+Esc) dropped the black screen / input lock, update this UI and tell the viewer.
if (window.electronAPI && window.electronAPI.onPrivacyReleased) {
  // why "failed": main had to lift the covers because a display that appeared mid-session couldn't be excluded from
  // capture (only the dark screen is affected then, not the input lock).
  window.electronAPI.onPrivacyReleased((why) => {
    blackScreenGrace = false;
    const sess = host; if (!sess) return;
    $("#blackscreen-notice")?.classList.add("hidden");
    if (sess.blackScreenActive) { sess.blackScreenActive = false; sendPrivacyResult(sess, "black-screen", true, false, why === "failed" ? "failed" : "released"); }
    if (why === "failed") return;
    if (sess.inputLocked) { sess.inputLocked = false; sendPrivacyResult(sess, "lock-input", true, false, "released"); }
  });
}

// Viewer: the host refused or couldn't apply black screen / input lock, undo the optimistic toggle and say why.
function onPrivacyResult(sess, ev) {
  if (ev.feature === "black-screen") clearTimeout(sess.blackAckTimer);
  if (ev.ok) {
    if (ev.feature === "black-screen" && sess.blackScreenActive) showToast("Layar remote digelapkan");
    return;
  }
  if (ev.feature === "lock-input") { sess.inputLocked = false; if (sess === active) $("#btn-lock-input").classList.remove("active"); }
  else if (ev.feature === "black-screen") { sess.blackScreenActive = false; wantBlackScreen.delete(sess.peerId); if (sess === active) $("#btn-blackscreen").classList.remove("active"); }
  else return;
  ccRefreshFlyout();
  // Whole sentences (not "${what} gagal"), so each one is a TEXT_EN key the release audit can find.
  const lock = ev.feature === "lock-input";
  showToast(ev.reason === "admin" ? (lock ? "Kunci input gagal: TryDesk di PC remote harus dijalankan sebagai administrator" : "Layar gelap gagal: TryDesk di PC remote harus dijalankan sebagai administrator")
    : ev.reason === "failed" && !lock ? "Layar gelap gagal: Windows di PC remote tidak bisa menyembunyikan penutup dari tangkapan layar (butuh Windows 10 versi 2004 atau lebih baru)"
    : ev.reason === "released" ? (lock ? "Kunci input dilepas oleh pengguna di PC remote" : "Layar gelap dilepas oleh pengguna di PC remote")
    : ev.reason === "revoked" ? (lock ? "Kunci input dilepas: PC remote mencabut izin kontrol" : "Layar gelap dilepas: PC remote mencabut izin kontrol")
    : (lock ? "Kunci input ditolak: PC remote hanya mengizinkan mode lihat saja" : "Layar gelap ditolak: PC remote hanya mengizinkan mode lihat saja"));
}

function toggleLockInput() {
  const sess = active; if (!sess || !sess.dataChannel || sess.dataChannel.readyState !== "open") return;
  sess.inputLocked = !sess.inputLocked;
  sess.dataChannel.send(JSON.stringify({ __ctrl: "lock-input", enabled: sess.inputLocked }));
  $("#btn-lock-input").classList.toggle("active", sess.inputLocked);
  showToast(sess.inputLocked ? "Input remote dikunci" : "Input remote dibuka");
}

// ─── Key combinations (Arah B "Panel", owner pick 19 Nov) ─────
// A panel on the right like the chat: tiles in groups, search, Hold (Ctrl/Alt/Shift/Win stay down until let go, as
// on the phone's keys bar), combinations of one's own saved on this device, and a short list while the other PC
// shows its lock screen. Names are Indonesian here; the text observer translates them like every other label.
const KEY_LABEL = { 8: "⌫", 9: "Tab", 13: "Enter", 16: "Shift", 17: "Ctrl", 18: "Alt", 27: "Esc", 32: "Space", 33: "PgUp", 34: "PgDn", 35: "End", 36: "Home",
  37: "←", 38: "↑", 39: "→", 40: "↓", 44: "PrtSc", 45: "Ins", 46: "Del", 91: "Win", 92: "Win", 93: "Menu", 186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/", 192: "`", 219: "[", 220: "\\", 221: "]", 222: "'" };
function keyLabel(vk) {
  if (KEY_LABEL[vk]) return KEY_LABEL[vk];
  if ((vk >= 48 && vk <= 57) || (vk >= 65 && vk <= 90)) return String.fromCharCode(vk);
  if (vk >= 112 && vk <= 135) return "F" + (vk - 111);
  if (vk >= 96 && vk <= 105) return "Num " + (vk - 96);
  return "#" + vk;
}
// (sp: "lock" = Lock PC through Windows' own LockWorkStation, "sas" = Ctrl+Alt+Del through the TryDesk service)
const KEY_GROUPS = [
  { n: "Windows", items: [
    { n: "Menu Start", k: [91] }, { n: "Jalankan", k: [91, 82], al: "run" }, { n: "File Explorer", k: [91, 69], al: "explorer" },
    { n: "Tampilkan desktop", k: [91, 68], al: "desktop" }, { n: "Menu Win + X", k: [91, 88] }, { n: "Pengaturan Windows", k: [91, 73], al: "settings" },
    { n: "Kunci PC", k: [91, 76], sp: "lock", al: "lock" }, { n: "Ctrl + Alt + Del", k: [17, 18, 46], sp: "sas", al: "cad sas security" } ] },
  { n: "Jendela", items: [
    { n: "Pindah jendela", k: [18, 9], al: "switch alt tab" }, { n: "Tutup jendela", k: [18, 115], al: "close" }, { n: "Semua jendela", k: [91, 9], al: "task view" },
    { n: "Perkecil semua", k: [91, 77], al: "minimize" }, { n: "Perbesar jendela", k: [91, 38], al: "maximize" },
    { n: "Jendela ke kiri", k: [91, 37], al: "snap left" }, { n: "Jendela ke kanan", k: [91, 39], al: "snap right" } ] },
  { n: "Alat", items: [
    { n: "Task Manager", k: [17, 16, 27], al: "task" }, { n: "Riwayat clipboard", k: [91, 86], al: "clipboard" },
    { n: "Potong layar", k: [91, 16, 83], al: "snip screenshot" }, { n: "Print Screen", k: [44], al: "screenshot" },
    { n: "Foto jendela aktif", k: [18, 44], al: "screenshot window" }, { n: "Pilih layar proyektor", k: [91, 80], al: "project" },
    { n: "Menu Start (cara lama)", k: [17, 27], al: "start" } ] },
  { n: "Teks", items: [
    { n: "Salin", k: [17, 67], al: "copy" }, { n: "Tempel", k: [17, 86], al: "paste" }, { n: "Potong", k: [17, 88], al: "cut" }, { n: "Urungkan", k: [17, 90], al: "undo" },
    { n: "Ulangi", k: [17, 89], al: "redo" }, { n: "Pilih semua", k: [17, 65], al: "select all" }, { n: "Simpan", k: [17, 83], al: "save" }, { n: "Cari di halaman", k: [17, 70], al: "find" } ] },
];
const KEY_SINGLE = [27, 9, 13, 46, 45, 36, 35, 33, 34, 8, ...Array.from({ length: 12 }, (_, i) => 112 + i)];
// What reaches the lock / sign-in screen (the TryDesk service's helper presses keys there; Ctrl+Alt+Del opens it).
const KEY_LOCKED = [{ n: "Ctrl + Alt + Del", k: [17, 18, 46], sp: "sas" }, { n: "Pindah kolom", k: [9] }, { n: "Masuk", k: [13] }, { n: "Hapus satu huruf", k: [8] }, { n: "Tutup", k: [27] }];
const kp = { held: new Set(), heldSess: null, rec: [], query: "" };
function keysOwn() { try { const a = JSON.parse(store.get("keyCombos") || "[]"); return Array.isArray(a) ? a.filter((c) => c && Array.isArray(c.k) && c.k.length) : []; } catch { return []; } }
function keysOwnSave(list) { store.set("keyCombos", JSON.stringify(list.slice(0, 40))); }
function keysOpen() { return !$("#keys-panel").classList.contains("hidden"); }
function kbdHtml(vks) { return `<span class="kp-kbds">${vks.map((v) => `<kbd>${escapeHtml(keyLabel(v))}</kbd>`).join("")}</span>`; }
function comboText(vks) { return vks.map(keyLabel).join(" + "); }

function openKeysPanel() {
  const sess = active; if (!sess || sess.role !== "viewer") return;
  closeAllMenus(); if (chatOpen()) closeChat();
  $("#keys-panel").classList.remove("hidden");
  kp.query = ""; $("#keys-search").value = ""; keysRecClose();
  renderKeysPanel();
  // (on a phone the search box would raise the keyboard over the list)
  if (!isPhoneUi()) { try { $("#keys-search").focus({ preventScroll: true }); } catch {} }
}
function closeKeysPanel() {
  const p = $("#keys-panel"); if (!p || p.classList.contains("hidden")) return;
  keysReleaseHeld();   // nothing stays pressed on the other PC once the panel is gone
  keysRecClose();
  p.classList.add("hidden");
}
function toggleKeysPanel() { keysOpen() ? closeKeysPanel() : openKeysPanel(); }

function renderKeysPanel() {
  if (!keysOpen()) return;
  const sess = active;
  if (!sess || sess.role !== "viewer") { closeKeysPanel(); return; }
  if (kp.heldSess && kp.heldSess !== sess) keysReleaseHeld();
  $("#keys-with").textContent = sessName(sess);
  const locked = !!sess.secureDesk, q = kp.query.trim().toLowerCase();
  $("#keys-search-row").classList.toggle("hidden", locked);
  $("#keys-hold").classList.toggle("hidden", locked);
  $("#keys-foot").classList.toggle("hidden", locked);
  $("#keys-search-clear").classList.toggle("hidden", !kp.query);
  $$("#keys-hold .kp-chip").forEach((c) => { const on = kp.held.has(+c.dataset.vk); c.classList.toggle("on", on); c.setAttribute("aria-pressed", String(on)); });
  const hint = $("#keys-hint"), h = [...kp.held];
  hint.classList.toggle("hidden", !h.length || locked);
  if (h.length) hint.textContent = h.includes(18) && h.length === 1 ? "Alt ditahan. Tekan Tab untuk memilih jendela, klik Alt lagi untuk melepas."
    : fmL(`Ditahan: ${comboText(h)}. Klik lagi untuk melepas.`, `Held: ${comboText(h)}. Click again to let go.`);
  const body = $("#keys-body");
  const tile = (it, own, i) => {
    const off = it.sp === "sas" && !sess.hostSas, offLock = it.sp === "lock" && !sess.hostLock;
    const note = off ? "Perlu layanan Windows TryDesk di PC itu" : offLock ? (sess.hostSas ? "Pakai Ctrl + Alt + Del, lalu Kunci" : "Perlu TryDesk versi baru di PC itu") : "";
    return `<div class="kp-tile-w"><button class="kp-tile${own ? " own" : ""}" type="button" data-i="${i}"${own ? ` data-own="1" title="${escapeAttr(it.n)}"` : ""}${off || offLock ? ' aria-disabled="true"' : ""}>` +
      `<b class="${own ? "kp-own-name" : ""}">${escapeHtml(it.n)}</b>${kbdHtml(it.k)}${note ? `<small>${note}</small>` : ""}</button>` +
      (own ? `<button class="kp-del" type="button" data-del="${i}" aria-label="${escapeAttr(fmL(`Hapus kombinasi ${it.n}`, `Remove the combination ${it.n}`))}" title="Hapus"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>` : "") + `</div>`;
  };
  kp.list = [];
  const add = (it, own) => { kp.list.push(it); return tile(it, own, kp.list.length - 1); };
  let out = "";
  if (locked) {
    out = `<p class="kp-locked">${escapeHtml(tr("PC itu sedang di layar kunci. Hanya tombol ini yang sampai."))}</p><div class="kp-grid">${KEY_LOCKED.map((it) => add(it)).join("")}</div>`;
  } else {
    const own = keysOwn();
    const hay = (it) => `${it.n} ${tr(it.n)} ${it.al || ""} ${it.k.map(keyLabel).join(" ")}`.toLowerCase();
    const hit = (it) => !q || q.split(/\s+/).every((t) => hay(it).includes(t));
    const groups = [{ n: "Buatan Anda", items: own, own: true }, ...KEY_GROUPS];
    let n = 0;
    if (q) {
      // one list, names that match first
      const all = groups.flatMap((g) => g.items.map((it) => ({ it, own: !!g.own }))).filter((x) => hit(x.it));
      const nameHit = (x) => (`${x.it.n} ${tr(x.it.n)}`.toLowerCase().includes(q.split(/\s+/)[0]) ? 0 : 1);
      all.sort((a, b) => nameHit(a) - nameHit(b));
      n = all.length;
      if (n) out = `<div class="kp-grid">${all.map((x) => add(x.it, x.own)).join("")}</div>`;
    } else {
      for (const g of groups) {
        if (!g.items.length) continue;
        out += `<div class="kp-gh">${escapeHtml(g.n)}</div><div class="kp-grid">${g.items.map((it) => add(it, !!g.own)).join("")}</div>`;
      }
      out += `<div class="kp-gh">Tombol satuan</div><div class="kp-singles">${KEY_SINGLE.map((vk) => { kp.list.push({ n: keyLabel(vk), k: [vk] }); return `<button type="button" class="kp-single" data-i="${kp.list.length - 1}">${escapeHtml(keyLabel(vk))}</button>`; }).join("")}</div>`;
      n = 1;
    }
    if (!n) out = `<div class="kp-empty"><b>${escapeHtml(fmL(`Tidak ada yang cocok dengan "${kp.query.trim()}".`, `Nothing matches "${kp.query.trim()}".`))}</b><p>Coba kata lain, misalnya kunci atau task. Atau simpan sebagai kombinasi Anda sendiri.</p><button class="btn-secondary" type="button" id="btn-keys-empty-new">Buat kombinasi sendiri</button></div>`;
  }
  body.innerHTML = out;
  $("#btn-keys-empty-new")?.addEventListener("click", keysRecOpen);
}

// Send one combination to the session on screen. Keys held with Tahan are down already: only the rest go.
function sendCombo(vks, label) {
  const sess = active; if (!sess || sess.role !== "viewer") return;
  if (sess.viewOnly) { playEvent("warn"); return showToast("Mode lihat saja aktif"); }
  if (!sess.dataChannel || sess.dataChannel.readyState !== "open") return;
  const go = vks.filter((v) => !kp.held.has(v) || kp.heldSess !== sess);
  for (const vk of go) sendInputTo(sess, { action: "keydown", vk });
  for (let i = go.length - 1; i >= 0; i--) sendInputTo(sess, { action: "keyup", vk: go[i] });
  const what = label || comboText(vks);
  showToast(fmL(`Terkirim: ${what}`, `Sent: ${what}`), "info");
}
// Lock PC / Ctrl+Alt+Del: asked of the other PC's TryDesk, which does it the way Windows allows (keys from a program
// can't lock Windows or open its Ctrl+Alt+Del screen).
function sendSpecialKey(sp, vks) {
  const sess = active; if (!sess || sess.role !== "viewer") return;
  if (sess.viewOnly) { playEvent("warn"); return showToast("Mode lihat saja aktif"); }
  if (sp === "sas" && !sess.hostSas) { playEvent("warn"); return showToast("Ctrl + Alt + Del perlu layanan Windows TryDesk di PC itu"); }
  if (sp === "lock" && !sess.hostLock) { playEvent("warn"); return showToast(sess.hostSas ? "Lewat layanan Windows: pakai Ctrl + Alt + Del, lalu Kunci" : "Kunci PC perlu TryDesk versi baru di PC itu"); }
  try { sess.dataChannel.send(JSON.stringify({ __ctrl: "special-key", key: sp })); } catch { return; }
  const what = comboText(vks);
  showToast(fmL(`Terkirim: ${what}`, `Sent: ${what}`), "info");
}
function keysToggleHold(vk) {
  const sess = active; if (!sess || sess.role !== "viewer") return;
  if (sess.viewOnly) { playEvent("warn"); return showToast("Mode lihat saja aktif"); }
  if (kp.heldSess && kp.heldSess !== sess) keysReleaseHeld();
  if (kp.held.has(vk)) { kp.held.delete(vk); sendInputTo(sess, { action: "keyup", vk }); }
  else { kp.held.add(vk); kp.heldSess = sess; sendInputTo(sess, { action: "keydown", vk }); }
  if (!kp.held.size) kp.heldSess = null;
  renderKeysPanel();
  // The keyboard goes back to the other PC, so "hold Alt, press Tab" works with the real Tab key.
  if (kp.held.size) { try { document.activeElement && document.activeElement.blur(); } catch {} refreshKeyCapture(); }
}
function keysReleaseHeld() {
  const s = kp.heldSess;
  // key-ups go even if the session turned view-only meanwhile, or a key would stay down over there
  if (s) for (const vk of kp.held) { try { if (s.dataChannel && s.dataChannel.readyState === "open") s.dataChannel.send(JSON.stringify({ action: "keyup", vk })); } catch {} }
  kp.held.clear(); kp.heldSess = null;
  if (keysOpen()) { $$("#keys-hold .kp-chip").forEach((c) => { c.classList.remove("on"); c.setAttribute("aria-pressed", "false"); }); $("#keys-hint").classList.add("hidden"); }
}

// Own combinations: press the keys (or pick ones the keyboard lacks), name it, save it on this device.
function keysRecOpen() {
  kp.rec = [];
  $("#keys-rec-name").value = "";
  $("#keys-rec").classList.remove("hidden"); $("#keys-foot").classList.add("hidden");
  keysRecPaint();
  try { $("#keys-rec-pad").focus({ preventScroll: true }); } catch {}
}
function keysRecClose() {
  const r = $("#keys-rec"); if (!r || r.classList.contains("hidden")) return;
  r.classList.add("hidden");
  if (keysOpen() && !(active && active.secureDesk)) $("#keys-foot").classList.remove("hidden");
}
function keysRecPaint() {
  const pad = $("#keys-rec-pad");
  pad.innerHTML = kp.rec.length ? kbdHtml(kp.rec) : `<span class="kp-pad-hint">${escapeHtml(tr("Tekan tombolnya di keyboard Anda"))}</span>`;
  pad.classList.toggle("has", kp.rec.length > 0);
  $("#btn-keys-rec-save").disabled = !kp.rec.length;
}
function keysRecAdd(vk) {
  if (vk === 92) vk = 91;   // the right Windows key is the Windows key
  if (kp.rec.includes(vk) || kp.rec.length >= 4) return;
  // modifiers first, in the usual order, then the key itself
  const ORDER = [91, 17, 18, 16];
  kp.rec.push(vk);
  kp.rec.sort((a, b) => (ORDER.includes(a) ? ORDER.indexOf(a) : 9) - (ORDER.includes(b) ? ORDER.indexOf(b) : 9));
  keysRecPaint();
}
function keysRecSave() {
  if (!kp.rec.length) return;
  const name = $("#keys-rec-name").value.trim().slice(0, 40) || comboText(kp.rec);
  const list = keysOwn(); list.unshift({ n: name, k: kp.rec.slice() });
  keysOwnSave(list);
  keysRecClose();
  kp.query = ""; $("#keys-search").value = "";
  renderKeysPanel();
  showToast(fmL(`Tersimpan: ${name}`, `Saved: ${name}`));
}

{
  const panel = $("#keys-panel");
  $("#btn-keys-close").addEventListener("click", closeKeysPanel);
  $("#keys-search").addEventListener("input", (e) => { kp.query = e.target.value; renderKeysPanel(); });
  $("#keys-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); panel.querySelector(".kp-tile:not([aria-disabled])")?.click(); }
    else if (e.key === "Escape") { e.stopPropagation(); if (kp.query) { kp.query = ""; e.target.value = ""; renderKeysPanel(); } else closeKeysPanel(); }
  });
  $("#keys-search-clear").addEventListener("click", () => { kp.query = ""; $("#keys-search").value = ""; renderKeysPanel(); $("#keys-search").focus(); });
  $$("#keys-hold .kp-chip").forEach((c) => c.addEventListener("click", () => keysToggleHold(+c.dataset.vk)));
  $("#keys-body").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      const it = kp.list[+del.dataset.del]; if (!it) return;
      keysOwnSave(keysOwn().filter((c) => !(c.n === it.n && c.k.join() === it.k.join())));
      renderKeysPanel(); showToast(fmL(`Dihapus: ${it.n}`, `Removed: ${it.n}`), "info");
      return;
    }
    const b = e.target.closest("[data-i]"); if (!b) return;
    const it = kp.list[+b.dataset.i]; if (!it) return;
    if (it.sp) sendSpecialKey(it.sp, it.k); else sendCombo(it.k, b.classList.contains("kp-single") ? it.n : comboText(it.k));
  });
  $("#btn-keys-new").addEventListener("click", keysRecOpen);
  $("#btn-keys-rec-close").addEventListener("click", keysRecClose);
  $("#btn-keys-rec-again").addEventListener("click", () => { kp.rec = []; keysRecPaint(); $("#keys-rec-pad").focus(); });
  $("#btn-keys-rec-save").addEventListener("click", keysRecSave);
  $("#keys-rec-name").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); keysRecSave(); } });
  $$("#keys-rec-add button").forEach((b) => b.addEventListener("click", () => keysRecAdd(+b.dataset.vk)));
  $("#keys-rec-pad").addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !kp.rec.length && !e.ctrlKey && !e.altKey) return;   // Tab alone still moves on
    e.preventDefault(); e.stopPropagation();
    if (e.key === "Escape" && !kp.rec.length) return keysRecClose();
    const vk = isMacViewer() && MAC_CMD.has(e.keyCode) ? 17 : e.keyCode;
    if (vk === 8 && kp.rec.length && !e.ctrlKey && !e.altKey && !e.shiftKey) { kp.rec.pop(); return keysRecPaint(); }
    keysRecAdd(vk);
  });
  // Escape anywhere in the panel closes it (the recorder first)
  panel.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.stopPropagation();
    if (!$("#keys-rec").classList.contains("hidden")) keysRecClose(); else closeKeysPanel();
  });
  window.addEventListener("blur", () => { if (kp.held.size) keysReleaseHeld(); });
}

// ─── Screenshot ───────────────────────────────────────────
async function chooseScreenshotPath(name) { return window.electronAPI.fileSaveDialog(name); }

async function takeScreenshot() {
  const video = activeVideo();
  if (!video || !video.videoWidth) return showToast("Belum ada video");
  const c = document.createElement("canvas");
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext("2d").drawImage(video, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  if (!blob) return showToast("Gagal mengambil gambar");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const name = `TryDesk-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`;
  const savePath = await chooseScreenshotPath(name);
  if (!savePath) return;
  const id = await window.electronAPI.fileOpenWrite(savePath);
  await window.electronAPI.fileWriteChunk(id, bytes);
  await window.electronAPI.fileCloseWrite(id, false);
  playEvent("shot");
  showToast(`Screenshot disimpan: ${savePath}`);
}

// ─── Session recording (viewer) ───────────────────────────
let mediaRecorder = null, recordingActive = false, recordingSess = null;   // recordingSess = the tab being recorded
let recWriteId = null, recPath = "", recChain = Promise.resolve();
function isRecording() { return recordingActive; }
function toggleRecording() { recordingActive ? stopRecording() : startRecording(); }

// Ask WHERE first, then stream each 1-second chunk straight into that file. Holding the whole recording in RAM
// (~3.6 GB per hour at 8 Mbps, then copied again to save) crashed the renderer and lost long recordings.
async function startRecording() {
  const video = activeVideo();
  const stream = video && video.srcObject;
  if (!stream) return showToast("Belum ada video untuk direkam");
  let mime = "";
  for (const t of ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) { mime = t; break; }
  }
  const name = `TryDesk-rekaman-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.webm`;
  const savePath = await window.electronAPI.fileSaveDialog(name);
  if (!savePath) return showToast("Rekaman dibatalkan");
  try { mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined); }
  catch { return showToast("Perekaman tidak didukung"); }
  const id = recWriteId = await window.electronAPI.fileOpenWrite(savePath);
  recPath = savePath; recChain = Promise.resolve();
  mediaRecorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const d = e.data;
    recChain = recChain.then(async () => window.electronAPI.fileWriteChunk(id, new Uint8Array(await d.arrayBuffer()))).catch(() => {});
  };
  mediaRecorder.onstop = saveRecording;
  mediaRecorder.start(1000);
  recordingActive = true;
  recordingSess = active;
  showRecordingIndicator(true);
  playEvent("recOn");
  showToast("Mulai merekam sesi");
}

function stopRecording() {
  recordingSess = null;
  if (!mediaRecorder) { recordingActive = false; showRecordingIndicator(false); return; }
  recordingActive = false;
  showRecordingIndicator(false);
  playEvent("recOff");
  try { mediaRecorder.stop(); } catch {}
}

// Recorder stopped: let the last queued chunk land, then close the file.
async function saveRecording() {
  mediaRecorder = null;
  const id = recWriteId, savePath = recPath; recWriteId = null;
  await recChain;
  if (!id) return;
  await window.electronAPI.fileCloseWrite(id, false);
  showToast(`Rekaman disimpan: ${savePath}`);
}

function showRecordingIndicator(on) {
  let el = $("#rec-indicator");
  if (on && !el) {
    el = document.createElement("div");
    el.id = "rec-indicator";
    el.innerHTML = `<span class="rec-dot"></span>REC`;
    el.title = "Berhenti merekam";
    el.addEventListener("click", stopRecording);
    document.body.appendChild(el);
  } else if (!on && el) el.remove();
}

// ─── Clipboard sync (per session) ─────────────────────────
// Two separate switches: the viewer's "Sinkron clipboard" (Control Center) governs the tabs WE control; the
// host permission "Izinkan sinkron clipboard" (plus control being allowed at all) governs the session in
// which someone controls THIS PC. Neither one silently switches off the other role.
const clipAllowed = (sess) => (sess.role === "host" ? allowClipboardPref && hostControlAllowed() : clipboardSync);
function startClipboardSync(sess) {
  stopClipboardSync(sess);
  if (sess.role !== "host" && !clipboardSync) return;
  // Only text copied DURING the session is shared: whatever already sat in the clipboard (a password copied an
  // hour ago) is the baseline, never sent to a peer the moment the connection opens.
  sess.lastClipboard = undefined;
  window.electronAPI.clipboardRead().then((t) => { if (sess.lastClipboard === undefined) sess.lastClipboard = t; }, () => { sess.lastClipboard = ""; });
  sess.clipTimer = setInterval(async () => {
    if (sess.lastClipboard === undefined) return;   // baseline not read yet
    if (!sess.dataChannel || sess.dataChannel.readyState !== "open") return;
    // The host's permission covers BOTH directions, never hand this PC's clipboard (passwords, tokens…) to a
    // viewer when the host switched clipboard sharing off or only lets them watch.
    if (!clipAllowed(sess)) return;
    // Only the tab on screen shares: a background tab (another customer) must not receive what was just
    // copied from this one. Switching to that tab shares the current clipboard then, a deliberate paste.
    // Also require window focus and not view-only, so a copy made elsewhere (a password manager) isn't
    // forwarded to the remote while the user isn't actively pasting into this session.
    if (sess.role === "viewer" && (sess !== active || !document.hasFocus() || sess.viewOnly || sess.hostViewOnly)) return;
    let text; try { text = await window.electronAPI.clipboardRead(); } catch { return; }
    // A data-channel message tops out at 256 KB; bigger text would throw on every tick, so skip it.
    // Empty text is not sent: files (or a picture) on the clipboard read as "", and sending that would wipe the other
    // PC's clipboard, files copied there included.
    if (text && text !== sess.lastClipboard && new Blob([text]).size <= 250_000) {
      sess.lastClipboard = text;
      try { sess.dataChannel.send(JSON.stringify({ __ctrl: "clipboard", text })); } catch {}
    }
    clipFilesTick(sess);
  }, 1200);
  clipFilesStart(sess);
}
function stopClipboardSync(sess) { if (sess && sess.clipTimer) { clearInterval(sess.clipTimer); sess.clipTimer = null; } }
async function applyRemoteClipboard(sess, text) {
  if (!clipAllowed(sess)) return;   // includes: a view-only remote may not rewrite this PC's clipboard
  // Extra guard for the viewer side: a PC we control must not silently rewrite THIS machine's clipboard
  // (e.g. swap in a different payment address) from a background tab, while unfocused, or when that remote
  // only reported view-only. Clipboard sharing is a deliberate foreground act.
  if (sess.role === "viewer" && (sess !== active || !document.hasFocus() || sess.viewOnly || sess.hostViewOnly)) return;
  if (typeof text !== "string" || text.length > 2_000_000) return;   // reject non-string / oversized peer payloads
  if (!text) return;   // an older TryDesk sends "" when its clipboard holds files: that must not wipe the files copied here
  sess.lastClipboard = text;
  // Text that came from a PC we control must not travel on to whoever is controlling THIS PC.
  if (host && host !== sess) host.lastClipboard = text;
  try { await window.electronAPI.clipboardWrite(text); } catch {}
}
// ─── Files through the clipboard (owner 16 Nov: "salin-tempel file Ctrl+C / Ctrl+V", as AnyDesk and RustDesk do) ───
// Windows to Windows, same switches as text (clipboard sharing) plus the host's "send and receive files" permission.
// This PC → the PC we control: files copied here, then Ctrl+V on the remote screen: TryDesk sends them first (the File
//   Transfer queue) into a new folder there, puts them on that PC's clipboard, then passes the Ctrl+V on, so they land
//   wherever that PC pastes. The files already on the clipboard when the session began are never sent this way.
// The PC we control → this PC: files copied there while the viewer is working on it (its own input in the last
//   seconds) are announced; this side downloads them into a new folder and puts them on this PC's clipboard.
// Files that came across one way are never sent back the other way.
const CLIP_FILES_MAX = 2 * 1024 ** 3;
let localClipSig = "";   // viewer: first path of the files on this PC's clipboard ("" = none)
async function refreshLocalClipSig() { try { localClipSig = (await window.electronAPI.clipFilesSig()) || ""; } catch { localClipSig = ""; } return localClipSig; }
window.addEventListener("focus", () => { if (window.electronAPI && window.electronAPI.clipFilesSig) refreshLocalClipSig(); });
const clipFilesOk = () => !!(window.electronAPI && window.electronAPI.clipFilesSig) && !(config && config.serviceHost) && !document.documentElement.classList.contains("td-mobile");
async function clipFilesStart(sess) {
  if (!clipFilesOk()) return;
  let sig = ""; try { sig = (await window.electronAPI.clipFilesSig()) || ""; } catch {}
  if (sess.role === "host") sess.hostFilesSig = sig;   // already there before: not announced
  else { sess.localClipBase = sig; localClipSig = sig; }
}
async function clipFilesTick(sess) {
  if (!clipFilesOk() || sess.clipBusy) return;
  if (sess.role === "viewer") { if (sess === active && document.hasFocus()) refreshLocalClipSig(); return; }
  // host: a new set of files on this PC's clipboard, copied while the viewer was at the controls
  if (sess.hostFilesSig === undefined || !clipAllowed(sess) || !hostFilesAllowed()) return;
  let sig = ""; try { sig = (await window.electronAPI.clipFilesSig()) || ""; } catch { return; }
  if (sig === sess.hostFilesSig) return;
  sess.hostFilesSig = sig;
  if (!sig || Date.now() - (sess.lastInputAt || 0) > 10000) return;   // copied by the person at this PC, not the viewer
  let r; try { r = await window.electronAPI.clipFilesRead(); } catch { return; }
  const files = ((r && r.entries) || []).slice(0, 200).map((e) => ({ path: e.path, name: e.name, isDir: !!e.isDir, size: e.size || 0, mtime: e.mtime || 0 }));
  if (!files.length || !sess.dataChannel || sess.dataChannel.readyState !== "open") return;
  try { sess.dataChannel.send(JSON.stringify({ __ctrl: "clip-files", files })); } catch {}
}
// viewer: the PC we control copied files: bring them to this PC's clipboard
async function applyRemoteClipFiles(sess, files) {
  if (!clipFilesOk() || sess.role !== "viewer" || !clipAllowed(sess)) return;
  if (sess !== active || !document.hasFocus() || sess.viewOnly || sess.hostViewOnly) return;
  if (!Array.isArray(files) || !files.length || files.length > 200) return;
  const items = files.filter((f) => f && typeof f.path === "string" && peerPathOk(f.path) && typeof f.name === "string" && f.name && f.name.length <= 255)
    .map((f) => ({ path: f.path, name: f.name, isDir: !!f.isDir, size: Number.isSafeInteger(f.size) && f.size >= 0 ? f.size : 0, mtime: Number(f.mtime) || 0 }));
  if (!items.length || !sess.fileChannel || sess.fileChannel.readyState !== "open") return;
  if (items.reduce((a, f) => a + f.size, 0) > CLIP_FILES_MAX) return showToast(fmL("File yang disalin lebih dari 2 GB: pakai Transfer File", "The copied files are over 2 GB: use File Transfer"));
  const d = await window.electronAPI.clipDir().catch(() => null);
  if (!d || !d.ok) return;
  sess.clipBusy = true;
  showToast(fmL(`Menyalin ${items.length} item dari PC remote...`, `Copying ${items.length} item(s) from the remote PC...`));
  fmEnqueue("down", { sess, items, destDir: d.path, fresh: true, onAll: async (ok) => {
    sess.clipBusy = false;
    if (!ok) return showToast(fmL("File dari PC remote tidak bisa disalin", "The files from the remote PC couldn't be copied"));
    const paths = items.map((f) => fmJoin(d.path, safeFileName(f.name)));
    const w = await window.electronAPI.clipFilesWrite(paths).catch(() => null);
    if (!w || !w.ok) return showToast(fmL("File dari PC remote tidak bisa disalin", "The files from the remote PC couldn't be copied"));
    sess.clipFromRemoteSig = w.sig; localClipSig = w.sig;
    showToast(fmL(`${items.length} item siap ditempel di PC ini (Ctrl+V)`, `${items.length} item(s) ready to paste on this PC (Ctrl+V)`));
  } });
}
// viewer: should this Ctrl+V on the remote screen carry this PC's files across?
function clipPasteWanted(sess) {
  return clipFilesOk() && !!sess && sess.role === "viewer" && clipboardSync && !sess.viewOnly && !sess.hostViewOnly && !sess.clipBusy
    && !!localClipSig && localClipSig !== sess.localClipBase && localClipSig !== sess.clipFromRemoteSig
    && !!sess.fileChannel && sess.fileChannel.readyState === "open";
}
let sendPasteChord = () => {};   // set with the key forwarding (it knows which keys are held)
async function clipPasteToRemote(sess) {
  const sig = localClipSig;
  const done = () => { sess.clipBusy = false; if (sess === active) sendPasteChord(); };
  sess.clipBusy = true;
  try {
    // the same files again: they are already over there, put them back on that clipboard
    if (sess.clipUp && sess.clipUp.sig === sig) {
      await requestRemoteOp(sess, { op: "clipset", paths: sess.clipUp.paths }, 15000).catch(() => null);
      return done();
    }
    const r = await window.electronAPI.clipFilesRead().catch(() => null);
    const items = (r && r.entries) || [];
    if (!items.length) return done();
    const d = await requestRemoteOp(sess, { op: "clipdir" }, 10000).catch((e) => ({ ok: false, error: e && e.message }));
    if (!d || !d.ok || typeof d.path !== "string") {
      showToast(d && (d.error === "old" || d.error === "unknown") ? fmL("PC itu perlu TryDesk terbaru untuk menempel file", "That PC needs the latest TryDesk to paste files")
        : d && d.error === "denied" ? fmL("PC itu tidak mengizinkan file atau clipboard", "That PC doesn't allow files or the clipboard") : fmL("File tidak bisa ditempel di PC itu", "The files couldn't be pasted on that PC"));
      sess.clipBusy = false; return;
    }
    showToast(fmL(`Mengirim ${items.length} item untuk ditempel...`, `Sending ${items.length} item(s) to paste...`));
    fmEnqueue("up", { sess, items, destDir: d.path, fresh: true, onAll: async (ok) => {
      if (!ok) { sess.clipBusy = false; return showToast(fmL("File tidak bisa ditempel di PC itu", "The files couldn't be pasted on that PC")); }
      const paths = items.map((f) => fmJoin(d.path, safeFileName(f.name)));
      const s = await requestRemoteOp(sess, { op: "clipset", paths }, 15000).catch(() => null);
      if (!s || !s.ok) { sess.clipBusy = false; return showToast(fmL("File tidak bisa ditempel di PC itu", "The files couldn't be pasted on that PC")); }
      sess.clipUp = { sig, paths };
      done();
    } });
  } catch { sess.clipBusy = false; }
}
// host: the viewer's two clipboard tools (in handleFsOp's gate: file transfer allowed)
async function clipOpHost(sess, o) {
  if (!clipFilesOk() || !clipAllowed(sess)) return { ok: false, error: "denied" };
  if (o.op === "clipdir") return window.electronAPI.clipDir().catch(() => ({ ok: false }));
  const paths = Array.isArray(o.paths) ? o.paths.filter((p) => typeof p === "string" && p.length < 1024).slice(0, 500) : [];
  const r = await window.electronAPI.clipFilesWrite(paths).catch(() => null);
  if (r && r.ok) sess.hostFilesSig = r.sig;   // our own paste: not announced back
  return { ok: !!(r && r.ok) };
}

// Start/stop clipboard polling across the viewer tabs (the Control Center toggle; the host side has its own permission).
function restartClipboardAll() {
  for (const s of viewerSessions()) {
    if (clipboardSync) startClipboardSync(s); else stopClipboardSync(s);
  }
}

// ─── File transfer ────────────────────────────────────────
function setupFileChannel(sess, ch) {
  ch.onmessage = (m) => {
    if (typeof m.data === "string") { let ev; try { ev = JSON.parse(m.data); } catch { return; } onFileControl(sess, ev); }
    else onFileChunk(sess, m.data);
  };
  // "Transfer file" from a Recent tile: open the file manager as soon as this session can carry files
  ch.addEventListener("open", () => {
    // transfers cut off by a dropped connection to this PC go on now, each file from where it stopped
    if (fmStash.has(sess.peerId)) setTimeout(() => { if (sess.fileChannel === ch && ch.readyState === "open") fmResumeStash(sess); }, 600);
    if (!sess.openFilesWhenReady) return;
    sess.openFilesWhenReady = false;
    setTimeout(() => { if (sess === active && sess.fileChannel === ch && ch.readyState === "open") openFileManager(); }, 400);
  });
}

function fileBusy(sess) { return !!(sess.activeSend || sess.activeRecv); }

async function chooseSavePath(name) { return window.electronAPI.fileSaveDialog(name); }

async function startSendFiles(dropped, toSess) {
  // The service's window (SYSTEM) never shows a file dialog: the person's own TryDesk opens and picks the files.
  if (config && config.serviceHost) return svcOpenUserApp("files");
  const sess = toSess || curChatSess();
  if (sess && sess.mirror) return svcMirrorSendFiles(dropped);   // the service's session: the service sends it
  if (!sess || !sess.fileChannel || sess.fileChannel.readyState !== "open") return showToast("Belum siap untuk transfer");
  const files = dropped || await window.electronAPI.filePick();
  for (const f of files) {
    if (fileBusy(sess)) { showToast("Satu transfer dulu, lalu ulangi"); break; }
    await sendOneFile(sess, f);
  }
}

// onProg (optional, Kelola banyak perangkat): ("prog", sent, total) · ("done") · ("fail", 0, total, why)
function sendOneFile(sess, file, onProg) {
  return new Promise(async (resolve) => {
    const ch = sess.fileChannel;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    sess.activeSend = { id, canceled: false, resolve };
    const card = svcWrapCard(createCard(sess, id, { dir: "send", name: file.name, size: file.size }), { id, dir: "send", name: file.name, size: file.size, state: "wait", done: 0, sub: "" });
    card.setSub("Menunggu persetujuan...");
    sess.acceptResolver = null;
    ch.send(JSON.stringify({ t: "offer", id, name: file.name, size: file.size }));

    const accepted = await new Promise((r) => { sess.acceptResolver = r; });
    sess.acceptResolver = null;
    if (accepted !== true || sess.activeSend?.canceled) {
      const why = accepted === "lost" ? "lost" : sess.activeSend?.rejectReason;
      const whyText = accepted === true ? "Dibatalkan" : why === "lost" ? "Koneksi terputus" : why === "phone" ? "Ditolak: aplikasi HP belum bisa menerima file" : why === "denied" ? "Ditolak: PC remote tidak mengizinkan transfer file" : why === "busy" ? "Ditolak: masih ada transfer lain" : why === "folder" ? "Gagal: folder yang dipilih di PC itu tidak bisa ditulis" : "Ditolak";
      card.setSub(whyText);
      card.finish(false);
      if (onProg) onProg("fail", 0, file.size, tr(whyText));
      sess.activeSend = null; resolve(); return;
    }

    let readId;
    try {
      readId = file.readId || await window.electronAPI.fileOpenRead(file.path);   // (the service: opened by svc-outbox-open)
      let sent = 0;
      const pace = filePacer(ch);
      while (true) {
        if (sess.activeSend?.canceled) throw new Error("canceled");
        const { done, chunk } = await window.electronAPI.fileReadChunk(readId, CHUNK);
        if (done) break;
        await pace(chunk);
        sent += chunk.byteLength || chunk.length;
        // Count what has left this PC, not what is queued: with up to 8 MB queued on a slow link the bar ran
        // ahead and said "Terkirim" while the data was still here (rented PC, 2026-11-02).
        card.progress(Math.max(0, sent - ch.bufferedAmount), file.size);
        if (onProg) onProg("prog", Math.max(0, sent - ch.bufferedAmount), file.size);
      }
      await window.electronAPI.fileCloseRead(readId);
      ch.send(JSON.stringify({ t: "done", id }));
      while (ch.bufferedAmount > 0 && ch.readyState === "open") {
        if (sess.activeSend?.canceled) throw new Error("canceled");
        card.progress(Math.max(0, sent - ch.bufferedAmount), file.size);
        await sleep(100);
      }
      card.setSub("Terkirim"); card.finish(true); playEvent("fileDone");
      if (onProg) onProg("done", file.size, file.size);
    } catch (e) {
      if (readId) window.electronAPI.fileCloseRead(readId);
      try { ch.send(JSON.stringify({ t: "cancel", id })); } catch {}   // the channel may be gone (disconnect)
      card.setSub("Dibatalkan"); card.finish(false);
      if (onProg) onProg("fail", 0, file.size, "");
    }
    if (sess.activeSend && sess.activeSend.id === id) sess.activeSend = null;
    resolve();
  });
}

async function onFileControl(sess, ev) {
  const ch = sess.fileChannel;
  if (ev.t === "offer" && config && config.serviceHost) return svcOnOffer(sess, ev);   // the service's own path (Downloads\TryDesk)
  if (ev.t === "offer") {
    if (fileBusy(sess) || (sess.role === "host" && !hostFilesAllowed())) { ch.send(JSON.stringify({ t: "reject", id: ev.id, reason: fileBusy(sess) ? "busy" : "denied" })); return; }
    // The phone app has no file storage yet: say so on both sides instead of a silent "Ditolak".
    if (document.documentElement.classList.contains("td-mobile")) {
      ch.send(JSON.stringify({ t: "reject", id: ev.id, reason: "phone" }));
      showToast("PC mengirim file, tetapi aplikasi HP belum bisa menerima file");
      return;
    }
    // Without a real size the disk-fill guard in onFileChunk can't cap the write: refuse instead of trusting it.
    if (_safeSize(ev.size) === null) { ch.send(JSON.stringify({ t: "reject", id: ev.id, reason: "denied" })); return; }
    const name = safeFileName(ev.name);
    const card = createCard(sess, ev.id, { dir: "recv", name, size: ev.size, incoming: true });
    card.onAccept = async () => {
      const savePath = await chooseSavePath(name);
      if (!card.el.isConnected) return;   // the sender withdrew the offer while the save dialog was open
      if (!savePath) { ch.send(JSON.stringify({ t: "reject", id: ev.id })); card.remove(); return; }
      // A second offer accepted while the first is still being written would orphan the first file handle.
      if (fileBusy(sess)) { ch.send(JSON.stringify({ t: "reject", id: ev.id, reason: "busy" })); card.remove(); showToast("Tunggu transfer yang sedang berjalan selesai"); return; }
      // A folder this user can't write to (C:\, Program Files) or a file another app holds open: say no and tell
      // both sides. The uncaught error used to leave the sender on "waiting for approval" for good.
      let writeId;
      try { writeId = await window.electronAPI.fileOpenWrite(savePath); }
      catch {
        ch.send(JSON.stringify({ t: "reject", id: ev.id, reason: "folder" }));   // older senders show a plain "Ditolak"
        card.remove(); showToast("Tidak bisa menyimpan di folder itu. Pilih folder lain, misalnya Unduhan.");
        return;
      }
      sess.activeRecv = { id: ev.id, size: _safeSize(ev.size), received: 0, writeId, filePath: savePath, canceled: false, card };
      card.toProgress();
      ch.send(JSON.stringify({ t: "accept", id: ev.id }));
    };
    card.onReject = () => { ch.send(JSON.stringify({ t: "reject", id: ev.id })); card.remove(); };
  } else if (ev.t === "accept") {
    if (sess.activeSend && sess.activeSend.id === ev.id && sess.acceptResolver) sess.acceptResolver(true);
  } else if (ev.t === "reject") {
    if (sess.activeSend && sess.activeSend.id === ev.id && sess.acceptResolver) { sess.activeSend.rejectReason = ev.reason || ""; sess.acceptResolver(false); }
  } else if (ev.t === "done") {
    if (sess.activeRecv && sess.activeRecv.id === ev.id) {
      const rec = sess.activeRecv; sess.activeRecv = null;
      await writtenAll(rec);
      // A transfer that ended short is not "saved": drop the partial file and say so.
      const complete = !rec.writeFailed && (!(rec.size > 0) || rec.received === rec.size);
      rec.closed = true;
      await window.electronAPI.fileCloseWrite(rec.writeId, !complete);
      rec.card.setSub(complete ? `Tersimpan: ${rec.filePath}` : "Gagal: file tidak lengkap"); rec.card.finish(complete); playEvent(complete ? "fileDone" : "fileFail");
    }
  } else if (ev.t === "cancel") {
    if (sess.activeRecv && sess.activeRecv.id === ev.id) {
      const rec = sess.activeRecv; sess.activeRecv = null;
      await discardRecv(rec);
      rec.card.setSub("Dibatalkan pengirim"); rec.card.finish(false);
    } else if (sess.activeSend && sess.activeSend.id === ev.id) { sess.activeSend.canceled = true; }
    else if (typeof ev.id === "string") {   // the sender withdrew an offer we hadn't answered yet
      // (incoming cards only: a "cancel" for a send of ours that already said "Terkirim" must not remove that card)
      $(`#transfer-stack .transfer-card[data-sid="${sess.sid}"][data-dir="recv"][data-id="${CSS.escape(ev.id)}"]`)?.remove();
    }
  }
  // ── File manager protocol (dual-pane queue; no save dialogs) ──
  else if (ev.t === "m-put") {
    // Peer wants to upload ev.name into our ev.destDir. Only the host serves the file manager,
    // and only when file transfer is permitted, never expose a machine we connected OUT to.
    if (config && config.serviceHost) await svcPermsRefresh();   // the signed-in user's own File permission, now
    if (sess.role !== "host" || !hostFilesAllowed() || !(Number.isSafeInteger(ev.size) && ev.size >= 0) || !peerPathOk(ev.destDir)) { ch.send(JSON.stringify({ t: "m-putok", id: ev.id, ok: false, err: "ditolak" })); return; }
    if (fileBusy(sess)) { ch.send(JSON.stringify({ t: "m-putok", id: ev.id, ok: false, err: "busy" })); return; }
    try {
      // replace = the viewer chose "Ganti" in File sudah ada (the old file is swapped out only once this one is whole).
      // rk = resumable: a part of this file kept from a dropped connection is continued; "have" tells the sender where.
      const rk = typeof ev.rk === "string" && ev.rk.length <= 4096 && !(config && config.serviceHost) ? ev.rk : undefined;
      const w = await window.electronAPI.fileOpenWriteIn(ev.destDir, safeFileName(ev.name), ev.replace === true, rk);
      const have = rk ? fmOff(w.have, ev.size) : 0;
      sess.activeRecv = { id: ev.id, size: _safeSize(ev.size), received: have, taken: have, writeId: w.id, filePath: w.path, mgr: true, rk };
      ch.send(JSON.stringify({ t: "m-putok", id: ev.id, ok: true, have }));
    } catch (e) {
      ch.send(JSON.stringify({ t: "m-putok", id: ev.id, ok: false, err: svcErrText(e) }));
    }
  } else if (ev.t === "m-putok") {
    if (sess.activeSend && sess.activeSend.id === ev.id && sess.activeSend.onAck) sess.activeSend.onAck(ev);
  } else if (ev.t === "m-done") {
    // We are the receiver; sender finished streaming.
    if (sess.activeRecv && sess.activeRecv.id === ev.id) {
      const rec = sess.activeRecv; const filePath = rec.filePath; sess.activeRecv = null;
      await writtenAll(rec);
      const complete = !rec.writeFailed && (!(rec.size > 0) || rec.received === rec.size);
      rec.closed = true;
      const cr = await window.electronAPI.fileCloseWrite(rec.writeId, !complete);   // a short file is removed, not kept
      // "Ganti" over a file another program holds: the new copy was kept under a free name, the old one is unchanged.
      const inuse = complete && cr && cr.swapFailed;
      const landed = (cr && cr.path) || filePath;   // a resumable file whose name was taken meanwhile got " (1)"
      if (rec.onDone) { if (complete && !inuse) rec.onDone(landed); else if (rec.item && rec.item._wake) rec.item._wake(inuse ? new Error("inuse") : undefined); }
      else ch.send(JSON.stringify({ t: "m-complete", id: ev.id, ok: complete && !inuse, err: inuse ? "inuse" : undefined, path: landed }));
    }
  } else if (ev.t === "m-complete") {
    if (sess.activeSend && sess.activeSend.id === ev.id && sess.activeSend.onDone) sess.activeSend.onDone(ev);
  } else if (ev.t === "m-get") {
    // Peer wants to download ev.remotePath from us. Host-only + permission-gated (see m-put).
    if (config && config.serviceHost) await svcPermsRefresh();
    if (sess.role !== "host" || !hostFilesAllowed() || !peerPathOk(ev.remotePath)) { ch.send(JSON.stringify({ t: "m-got", id: ev.id, ok: false, err: "ditolak" })); return; }
    if (fileBusy(sess)) { ch.send(JSON.stringify({ t: "m-got", id: ev.id, ok: false, err: "busy" })); return; }
    try {
      // off = the viewer kept the first part of this file (dropped connection): send from there. The service's own
      // reader can't start part-way, so it says nothing and the viewer takes the whole file.
      const off = !(config && config.serviceHost) && Number.isSafeInteger(ev.off) && ev.off > 0 && (!Number.isSafeInteger(ev.size) || ev.off <= ev.size) ? ev.off : 0;
      const readId = await window.electronAPI.fileOpenRead(ev.remotePath, off);
      sess.activeSend = { id: ev.id, canceled: false, paused: false, readId, mgr: true, size: ev.size };
      ch.send(JSON.stringify(off ? { t: "m-got", id: ev.id, ok: true, off } : { t: "m-got", id: ev.id, ok: true }));
    } catch (e) {
      ch.send(JSON.stringify({ t: "m-got", id: ev.id, ok: false, err: svcErrText(e) }));
    }
  } else if (ev.t === "m-got") {
    if (sess.mgrGetAck && sess.mgrGetAck.id === ev.id) sess.mgrGetAck.resolve(ev);
  } else if (ev.t === "m-ready") {
    // We are the sender for a download; receiver is ready, stream now.
    if (sess.activeSend && sess.activeSend.id === ev.id && sess.activeSend.mgr) streamManagerChunks(sess, sess.activeSend);
  } else if (ev.t === "m-pause") {
    if (sess.activeSend && sess.activeSend.id === ev.id) sess.activeSend.paused = !!ev.paused;
  } else if (ev.t === "m-cancel") {
    if (sess.activeRecv && sess.activeRecv.id === ev.id) {
      const rec = sess.activeRecv; sess.activeRecv = null;
      await discardRecv(rec);
    }
    if (sess.activeSend && sess.activeSend.id === ev.id) {
      sess.activeSend.canceled = true;
      // An upload of ours already fully sent waits for "m-complete", which a receiver that gave up (disk full) never
      // sends: answer that wait here, or the queue item hung on "active".
      if (sess.activeSend.onDone) { try { sess.activeSend.onDone({ ok: false }); } catch {} }
      if (!sess.activeSend.streaming) {   // stream never started (or legacy), clear it here so we don't stay busy
        if (sess.activeSend.readId) { try { await window.electronAPI.fileCloseRead(sess.activeSend.readId); } catch {} }
        if (sess.activeSend.mgr) sess.activeSend = null;
      }
    }
  }
}

// Stream an already-open read handle (download, sender side) to the file channel.
async function streamManagerChunks(sess, send) {
  const ch = sess.fileChannel;
  send.streaming = true;
  const pace = filePacer(ch);
  try {
    while (true) {
      if (send.canceled) throw new Error("canceled");
      while (send.paused && !send.canceled) await sleep(120);
      const { done, chunk } = await window.electronAPI.fileReadChunk(send.readId, CHUNK);
      if (done) break;
      await pace(chunk);
    }
    await window.electronAPI.fileCloseRead(send.readId);
    ch.send(JSON.stringify({ t: "m-done", id: send.id }));
  } catch {
    try { await window.electronAPI.fileCloseRead(send.readId); } catch {}
  }
  if (sess.activeSend && sess.activeSend.id === send.id) sess.activeSend = null;
}

// Chunks arrive faster than the disk IPC answers, so writes are CHAINED per transfer (in order, one at a time)
// and "done" waits for the chain (writtenAll) before checking the size. Checking right away, while the last
// chunks were still in flight, called complete files short and deleted them.
function onFileChunk(sess, buf) {
  const rec = sess.activeRecv;
  if (!rec) return;
  // Enforce the advertised size: never write more bytes than declared (disk-fill DoS guard).
  const taken = rec.taken || 0;
  if (rec.size != null && taken >= rec.size) return;
  let u8 = new Uint8Array(buf);
  if (rec.size != null && taken + u8.byteLength > rec.size) u8 = u8.subarray(0, Math.max(0, rec.size - taken));
  if (!u8.byteLength) return;
  rec.taken = taken + u8.byteLength;
  rec.chain = (rec.chain || Promise.resolve()).then(async () => {
    if (rec.closed) return;
    // false = main has no such write handle (anymore): the bytes went nowhere. Counting them made a file with
    // holes look complete ("Tersimpan").
    if ((await window.electronAPI.fileWriteChunk(rec.writeId, u8)) === false) throw new Error("write handle gone");
    rec.received += u8.byteLength;
    if (rec.card) rec.card.progress(rec.received, rec.size);
  }).catch(() => {
    if (rec.writeFailed) return;
    rec.writeFailed = true;
    // Disk full or the file can't be written: stop the sender now. It used to stream the whole file (gigabytes)
    // into nothing, the receiver then deleted it, and the sender's card still said "Terkirim".
    if (sess.activeRecv !== rec) return;
    sess.activeRecv = null;
    discardRecv(rec);
    if (rec.item && rec.item._wake) { rec.item._wake(); return; }   // our own file-manager download: its catch tells the host
    try { sess.fileChannel.send(JSON.stringify({ t: rec.mgr ? "m-cancel" : "cancel", id: rec.id })); } catch {}
    if (rec.card && !rec.mgr) {
      rec.card.setSub("Gagal menyimpan: disk penuh atau file tidak bisa ditulis"); rec.card.finish(false); playEvent("fileFail");
      if (rec.card.el) rec.card.el.dataset.id = "";   // the sender's answering "cancel" must not remove this message
    }
  });
}
// Wait until every chunk received so far is on disk.
const writtenAll = (rec) => (rec && rec.chain ? rec.chain : Promise.resolve());
// Stop writing and remove the partial file (cancel / disconnect), after any write already under way.
function discardRecv(rec) {
  if (!rec || rec.closed) return Promise.resolve();
  rec.closed = true;
  return writtenAll(rec).then(() => window.electronAPI.fileCloseWrite(rec.writeId, true)).catch(() => {});
}

// keep = the connection dropped (nobody ended it): a resumable file-manager transfer keeps what arrived (main.js
// resumeParts) and the viewer keeps its unfinished queue (fmStash), to go on after reconnecting. Ended on purpose:
// everything half-done is removed, as before.
function cleanupTransfers(sess, keep = false) {
  if (sess.activeSend) sess.activeSend.canceled = true;
  // A download the peer asked for (m-get) but never started streaming still holds its file open.
  const s = sess.activeSend;
  if (s && s.mgr && s.readId && !s.streaming) { s.streaming = true; window.electronAPI.fileCloseRead(s.readId).catch(() => {}); }
  if (sess.activeRecv) {
    const rec = sess.activeRecv;
    if (keep && rec.mgr && rec.rk && !rec.closed && !rec.writeFailed) { rec.closed = true; writtenAll(rec).then(() => window.electronAPI.fileCloseWrite(rec.writeId, false, true)).catch(() => {}); }
    else discardRecv(rec);
    sess.activeRecv = null;
  }
  if (keep) fmStashQueue(sess);
  // a send still waiting for Terima ends now as failed (audit 19 Nov: it waited forever, and Kelola's "send to many"
  // row stayed at 0 %)
  if (sess.acceptResolver) { const r = sess.acceptResolver; sess.acceptResolver = null; try { r("lost"); } catch {} }
  sess.activeSend = null; sess.acceptResolver = null;
  sess.mgrGetAck = null;
  $$(`#transfer-stack .transfer-card[data-sid="${sess.sid}"]`).forEach((el) => el.remove());
  fmResetAll(sess);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function createCard(sess, id, { dir, name, size, incoming }) {
  const el = document.createElement("div");
  el.className = "transfer-card";
  el.dataset.id = id;
  el.dataset.sid = sess.sid;
  el.dataset.dir = dir === "send" ? "send" : "recv";
  const arrow = dir === "send" ? "↑" : "↓";
  el.innerHTML = `
    <div class="tc-top">
      <span class="tc-icon">${arrow}</span>
      <div class="tc-meta"><div class="tc-name"></div><div class="tc-sub"></div></div>
      <button class="tc-close" title="Tutup">✕</button>
    </div>
    <div class="tc-progress" style="display:none"><div class="tc-bar"></div></div>
    <div class="tc-actions" style="display:none"></div>`;
  el.querySelector(".tc-name").textContent = name;
  el.querySelector(".tc-sub").textContent = fmtBytes(size);
  $("#transfer-stack").appendChild(el);

  const bar = el.querySelector(".tc-bar");
  const sub = el.querySelector(".tc-sub");
  const prog = el.querySelector(".tc-progress");
  const actions = el.querySelector(".tc-actions");

  const ctrl = {
    el,
    onAccept: null, onReject: null,
    setSub(t) { sub.textContent = t; },
    progress(done, total) { prog.style.display = ""; bar.style.width = `${total ? (done / total * 100).toFixed(1) : 0}%`; sub.textContent = `${fmtBytes(done)} / ${fmtBytes(total)}`; },
    toProgress() { actions.style.display = "none"; prog.style.display = ""; },
    finish(ok) { prog.style.display = ""; bar.style.width = "100%"; bar.classList.toggle("done", ok); setTimeout(() => ctrl.remove(), 6000); },
    remove() { el.remove(); },
  };

  let answered = false;   // incoming offer: Accept/Reject already chosen
  el.querySelector(".tc-close").addEventListener("click", () => {
    if (dir === "send" && sess.activeSend && sess.activeSend.id === id) {
      sess.activeSend.canceled = true;
      // Still waiting for the receiver: withdraw the offer and stop waiting, otherwise the send never ends
      // and the session stays "busy" for every later transfer.
      if (sess.acceptResolver) { try { sess.fileChannel.send(JSON.stringify({ t: "cancel", id })); } catch {} sess.acceptResolver(false); }
    }
    if (dir === "recv" && sess.activeRecv && sess.activeRecv.id === id) { sess.fileChannel.send(JSON.stringify({ t: "cancel", id })); discardRecv(sess.activeRecv); sess.activeRecv = null; }
    else if (incoming && !answered && ctrl.onReject) { answered = true; ctrl.onReject(); return; }   // closing an unanswered offer = reject it
    ctrl.remove();
  });

  if (incoming) {
    actions.style.display = "";
    const acc = document.createElement("button"); acc.className = "tc-btn accept"; acc.textContent = "Terima";
    const rej = document.createElement("button"); rej.className = "tc-btn"; rej.textContent = "Tolak";
    acc.addEventListener("click", () => { if (answered) return; answered = true; ctrl.onAccept && ctrl.onAccept(); });
    rej.addEventListener("click", () => { if (answered) return; answered = true; ctrl.onReject && ctrl.onReject(); });
    actions.append(acc, rej);
    sub.textContent = `${fmtBytes(size)} · ingin dikirim`;
  }
  return ctrl;
}

// ═══════════════════════════════════════════════════════════
//  File Transfer (owner's final concept 16 Nov: "Pilihan 2 + Atas A")
// ═══════════════════════════════════════════════════════════
// Two panes (this PC, the other PC), each opened by a PC card (free space, disk) and one path row; the strip at the
// bottom holds the progress and every action (Jeda, Antrean, Unduh, Kirim). Kirim/Unduh start at once (no separate
// "start" step). Folders go too (walked into files, their folders made on the other side). Drag and drop works between
// the panes and from Windows Explorer onto the other PC's pane. The overlay is bound to ONE session at a time (fmSess);
// per-session state lives on the Session (sess.fm / fmQueue / fmJobs).
let fmSess = null;
let fmOpen = false;
const fmL = (id, en) => trL(id, en);
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }

const FM_IC = {
  dir: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  desk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M8 20.5h8M12 16.5v4"/></svg>',
  drive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01M10 16h.01"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  newf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v6M9 14h6"/></svg>',
  ren: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="3.6" height="14" rx="1"/><rect x="13.9" y="5" width="3.6" height="14" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l12-7.2a1 1 0 0 0 0-1.72l-12-7.2A1 1 0 0 0 7 4.8z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
};

// Sizes and dates as the concept writes them: "3,2 MB", "15/11 22.02" (English: "3.2 MB", "15/11 22:02").
function fmSize(n) {
  if (!(n >= 0)) return "";
  const ds = decSep(), d = (v, k) => v.toFixed(k).replace(".", ds);
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${n < 10240 ? d(n / 1024, 1).replace(/[.,]0$/, "") : Math.round(n / 1024)} KB`;
  if (n < 1073741824) return `${d(n / 1048576, 1)} MB`;
  const g = n / 1073741824;
  return g >= 10 ? `${Math.round(g)} GB` : `${d(g, 1)} GB`;
}
function fmDate(ms, full) {
  if (!ms) return "";
  const t = new Date(ms), p = (v) => String(v).padStart(2, "0");
  const sep = timeSep();
  const other = t.getFullYear() !== new Date().getFullYear();
  const yr = other || full ? `/${full ? t.getFullYear() : String(t.getFullYear()).slice(2)}` : "";
  return `${p(t.getDate())}/${p(t.getMonth() + 1)}${yr}<span class="tm${other && !full ? " ty" : ""}"> ${p(t.getHours())}${sep}${p(t.getMinutes())}</span>`;
}
const FM_TYPES = [
  [/^(xlsx?|xlsm|ods)$/, "Excel", "Excel"], [/^csv$/, "CSV", "CSV"], [/^(docx?|odt|rtf)$/, "Word", "Word"],
  [/^(pptx?|odp)$/, "PowerPoint", "PowerPoint"], [/^pdf$/, "PDF", "PDF"],
  [/^(jpe?g|png|gif|webp|bmp|heic|svg|ico|tiff?)$/, "Gambar", "Image"], [/^(mp4|mkv|mov|avi|wmv|webm|m4v)$/, "Video", "Video"],
  [/^(mp3|wav|flac|m4a|aac|ogg|opus)$/, "Audio", "Audio"], [/^(zip|rar|7z|tar|gz|bz2|xz|iso)$/, "Arsip", "Archive"],
  [/^(exe|msi|bat|cmd|ps1|appx|msix)$/, "Aplikasi", "Application"], [/^(txt|log|md|ini|cfg|json|xml|ya?ml)$/, "Teks", "Text"],
];
function fmType(e) {
  if (e.isDir) return { s: "Folder", l: "Folder" };
  const ext = e.name.includes(".") ? e.name.split(".").pop().toLowerCase() : "";
  let s = ext.toUpperCase();
  if (/^(DOCX|XLSX|PPTX)$/.test(s)) s = s.slice(0, 3); else if (s === "JPEG") s = "JPG"; else if (s.length > 4) s = s.slice(0, 4);
  for (const [re, id, en] of FM_TYPES) if (re.test(ext)) {
    const n = fmL(id, en);
    return { s: s || n, l: /^(Gambar|Video|Audio|Arsip)$/.test(id) ? `${n} ${s}` : n };
  }
  return { s: s || "File", l: s ? fmL(`File ${s}`, `${s} file`) : "File" };
}
function fmEta(sec) {
  if (!(sec > 0) || !isFinite(sec)) return "";
  if (sec < 60) return fmL(`sisa ${Math.max(1, Math.round(sec))} detik`, `${Math.max(1, Math.round(sec))} s left`);
  if (sec < 3600) return fmL(`sisa ${Math.round(sec / 60)} menit`, `${Math.round(sec / 60)} min left`);
  return fmL(`sisa ${(sec / 3600).toFixed(1).replace(".", ",")} jam`, `${(sec / 3600).toFixed(1)} h left`);
}
const fmJoin = (a, b) => `${String(a).replace(/[\\/]+$/, "")}\\${b}`;
const fmBase = (p) => String(p).replace(/[\\/]+$/, "").split(/[\\/]/).pop();
const fmPeer = () => (fmSess ? (peerName(fmSess.peerId) || (/^lan:/.test(fmSess.peerId) ? fmSess.peerId.slice(4) : fmtId(fmSess.peerId))) : "");
const fmSt = (side) => fmSess.fm[side];
const fmPane = (side) => $(`#fm-${side}`);
const fmOther = (side) => (side === "local" ? "remote" : "local");

function fmBuildPane(side) {
  const p = `fm-${side}`;
  fmPane(side).innerHTML =
    `<div class="fmx-card nodisk" id="${p}-card"><span class="fmx-ic">${FM_IC.desk}<span class="fmx-dot"></span></span>` +
      `<div class="fmx-tx"><b id="${p}-who"></b><small id="${p}-free"></small></div>` +
      `<button class="fmx-chip" id="${p}-drive" type="button" title="Pilih disk">${FM_IC.drive}<span class="ct" id="${p}-dl">C:</span>${FM_IC.chev}</button>` +
      `<div class="fmx-bar"><i id="${p}-bar"></i></div></div>` +
    `<div class="fmx-pth">` +
      `<button class="fmx-ib" id="${p}-back" type="button" title="Kembali" aria-label="Kembali" disabled>${FM_IC.left}</button>` +
      `<button class="fmx-ib" id="${p}-refresh" type="button" title="Muat ulang" aria-label="Muat ulang">${FM_IC.refresh}</button>` +
      `<div class="fmx-pbox" id="${p}-pbox" title="Klik untuk mengetik jalur">${FM_IC.open}<span class="fmx-segs" id="${p}-segs"></span></div>` +
      `<button class="fmx-ib tool" id="${p}-new" type="button" title="Folder baru" aria-label="Folder baru">${FM_IC.newf}</button>` +
      `<button class="fmx-ib tool" id="${p}-ren" type="button" title="Ganti nama" aria-label="Ganti nama" disabled>${FM_IC.ren}</button>` +
      `<button class="fmx-ib tool" id="${p}-del" type="button" title="Hapus" aria-label="Hapus" disabled>${FM_IC.del}</button>` +
      `<label class="fmx-srch" id="${p}-srch" title="Cari">${FM_IC.search}<input id="${p}-q" type="text" placeholder="Cari" spellcheck="false" autocomplete="off" aria-label="Cari"></label>` +
    `</div>` +
    `<div class="fmx-head" id="${p}-head"><span class="fmx-ck" id="${p}-all" role="checkbox" aria-label="Pilih semua"></span>` +
      `<span class="fmx-col" data-key="name">Nama${FM_IC.chev}</span><span class="fmx-col" data-key="mtime">Diubah${FM_IC.chev}</span>` +
      `<span class="fmx-col" data-key="type">Jenis${FM_IC.chev}</span><span class="fmx-col" data-key="size">Ukuran${FM_IC.chev}</span></div>` +
    `<div class="fmx-list" id="${p}-list" tabindex="0"></div>` +
    `<div class="fmx-foot"><span id="${p}-selinfo"></span><span id="${p}-count"></span></div>`;
}

// ── Loading a folder ───────────────────────────────────────
async function fmLoad(side, pathArg, { home = false, back = false, keepSel = false } = {}) {
  if (!fmSess) return;
  const sess = fmSess, st = fmSt(side), listEl = $(`#fm-${side}-list`);
  const prev = st.path, my = st.loadSeq = (st.loadSeq || 0) + 1;
  if (!st.entries.length) listEl.innerHTML = `<div class="fmx-empty">${fmL("Memuat…", "Loading…")}</div>`;
  let res;
  try {
    res = side === "local"
      ? await window.electronAPI.fsList(home ? await window.electronAPI.fsHome() : pathArg)
      : await requestRemoteList(sess, { path: pathArg, home });
  } catch (e) {
    res = { ok: false, error: String(e && e.message || e), path: pathArg, display: pathArg || "" };
  }
  if (fmSess !== sess || st.loadSeq !== my) return;   // another folder was asked for meanwhile: that one wins
  // The other PC is answered by its Windows service: no folders to browse, but files can still be SENT (each one an
  // offer the person there accepts; it lands in their Downloads\TryDesk). Said as a note, not as an error.
  st.svc = side === "remote" && !!res && !res.ok && res.code === "svc";
  if (st.svc) {
    st.path = null; st.entries = []; st.sel.clear(); st.disk = null;
    fmPaintPath(side, tr("Unduhan\\TryDesk"));
    listEl.innerHTML = `<div class="fmx-empty note"><b>${fmL("Folder PC ini tidak bisa dibuka dari sini.", "This PC's folders can't be opened from here.")}</b><span>${fmL("PC ini dilayani layanan Windows TryDesk. File yang Anda kirim tetap bisa: pilih file di kiri lalu klik Kirim. Setelah diterima, file disimpan di folder Unduhan\\TryDesk di PC itu. Untuk mengambil file dari PC itu, minta orang di sana mengirimnya dari TryDesk-nya.", "This PC is served by the TryDesk Windows service. You can still send files: select them on the left and click Send. Once accepted they are saved in Downloads\\TryDesk on that PC. To get files from that PC, ask the person there to send them from their TryDesk.")}</span></div>`;
    fmPaintCard(side); fmApplySel(side);
    return;
  }
  if (!res || !res.ok) {
    const why = res && (typeof res.detail === "string" && res.detail ? res.detail : res.error);
    listEl.innerHTML = `<div class="fmx-empty err">${escapeHtml(tr("Tidak bisa membuka folder"))}${why ? ` · ${escapeHtml(fmErrText(tr(why)))}` : ""}</div>`;
    st.sel.clear(); st.shown = []; fmApplySel(side);
    return;
  }
  if (!back && prev != null && prev !== res.path && !(st.hist.length && st.hist[st.hist.length - 1] === prev)) st.hist.push(prev);
  if (st.hist.length > 50) st.hist.shift();
  const changed = st.path !== res.path;
  st.path = res.path; st.display = res.display; st.parent = res.parent; st.isRoot = res.isRoot;
  st.entries = res.entries || [];
  if (changed) { st.filter = ""; const q = $(`#fm-${side}-q`); if (q) q.value = ""; $(`#fm-${side}-srch`)?.classList.remove("open"); }
  if (!keepSel || changed) st.sel.clear();
  else for (const p of [...st.sel]) if (!st.entries.some((e) => e.path === p)) st.sel.delete(p);
  st.disk = side === "remote" ? (res.disk || null) : st.disk;
  if (side === "local" && res.path) { window.electronAPI.fsOp({ op: "disk", path: res.path }).then((d) => { if (fmSess === sess && st.path === res.path) { st.disk = d && d.disk; fmPaintCard(side); } }).catch(() => {}); }
  fmRenderPane(side, changed);
}

function fmPaintCard(side) {
  const st = fmSt(side), p = `#fm-${side}`;
  $(`${p}-who`).textContent = side === "local" ? fmL("PC ini", "This PC") : fmPeer();
  const d = st.disk, card = $(`${p}-card`);
  card.classList.toggle("nodisk", !d || !(d.total > 0));
  $(`${p}-free`).innerHTML = d && d.total > 0 ? `${fmSize(d.free)} ${fmL("kosong", "free")}<span class="fmx-of"> ${fmL("dari", "of")} ${fmSize(d.total)}</span>` : "";
  $(`${p}-bar`).style.width = d && d.total > 0 ? `${Math.round((1 - d.free / d.total) * 100)}%` : "0";
  const m = /^([A-Za-z]):/.exec(st.path || "");
  $(`${p}-dl`).textContent = m ? `${m[1].toUpperCase()}:` : "PC";
}

// The path as folder names you can click; clicking the box elsewhere turns it into a field to type a path.
function fmPaintPath(side, text) {
  const st = fmSt(side), segsEl = $(`#fm-${side}-segs`);
  segsEl.replaceChildren();
  if (text != null || st.isRoot || !st.path) {
    const s = document.createElement("span"); s.className = "fmx-seg cur"; s.textContent = text != null ? text : tr("Komputer ini"); segsEl.append(s); return;
  }
  const parts = st.path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  let acc = "";
  parts.forEach((name, i) => {
    acc = i === 0 ? `${name}\\` : fmJoin(acc, name);
    const last = i === parts.length - 1;
    if (last && i > 0) { const more = document.createElement("span"); more.className = "fmx-more"; more.textContent = "…"; segsEl.append(more); }
    if (i > 0) { const sep = document.createElement("span"); sep.className = "fmx-sep" + (last ? " last" : ""); sep.textContent = "\\"; segsEl.append(sep); }
    const b = document.createElement(last ? "span" : "button");
    b.className = "fmx-seg" + (last ? " cur" : ""); b.textContent = name;
    if (!last) { b.type = "button"; b.dataset.go = acc; b.title = fmL(`Buka ${acc}`, `Open ${acc}`); }
    segsEl.append(b);
  });
  fmFitPath(side);
}
// A long path keeps the end (the folder that is open): the first folder names give way to "…" one by one.
function fmFitPath(side) {
  const segsEl = $(`#fm-${side}-segs`); if (!segsEl || !segsEl.clientWidth) return;
  const kids = [...segsEl.children];
  kids.forEach((k) => { k.style.display = ""; });
  const lead = segsEl.querySelector(".fmx-lead") || (() => { const s = document.createElement("span"); s.className = "fmx-lead"; s.textContent = "…"; segsEl.prepend(s); return s; })();
  lead.style.display = "none";
  const more = segsEl.querySelector(".fmx-more");
  if (more && getComputedStyle(more).display !== "none") return;   // narrow pane: CSS already shows "…\Anda"
  const names = kids.filter((k) => k.classList.contains("fmx-seg") && !k.classList.contains("cur"));
  for (let i = 0; segsEl.scrollWidth > segsEl.clientWidth + 1 && i < names.length; i++) {
    lead.style.display = "";
    names[i].style.display = "none";
    const sep = names[i].previousElementSibling; if (sep && sep.classList.contains("fmx-sep")) sep.style.display = "none";
  }
}

const fmRenaming = { local: false, remote: false };
function fmRenderPane(side, fresh) {
  const st = fmSt(side), listEl = $(`#fm-${side}-list`);
  if (fmRenaming[side]) { st.renderLater = true; return; }   // never throw away a name being typed
  fmPaintCard(side); fmPaintPath(side);
  $(`#fm-${side}-back`).disabled = !st.hist.length;
  $$(`#fm-${side}-head .fmx-col`).forEach((c) => {
    c.classList.toggle("sorted", c.dataset.key === st.sort.key);
    c.classList.toggle("desc", c.dataset.key === st.sort.key && !st.sort.asc);
  });
  const q = (st.filter || "").toLowerCase();
  const ghosts = fmGhostsFor(side);
  let rows = st.entries.filter((e) => !q || e.name.toLowerCase().includes(q));
  rows = fmSortEntries([...rows, ...ghosts.filter((g) => !rows.some((e) => e.name.toLowerCase() === g.name.toLowerCase()))], st.sort);
  st.shown = rows.filter((e) => !e.ghost).map((e) => e.path);
  if (q) for (const p of [...st.sel]) if (!st.shown.includes(p)) st.sel.delete(p);   // a search hides it: it is no longer picked
  if (!rows.length) {
    listEl.innerHTML = `<div class="fmx-empty">${q ? fmL("Tidak ada yang cocok", "No matches") : fmL("Folder kosong", "Empty folder")}</div>`;
  } else {
    const html = rows.map((e, i) => {
      const t = fmType(e), on = !e.ghost && st.sel.has(e.path);
      return `<div class="fmx-row${e.isDir ? " dir" : ""}${on ? " on" : ""}${e.ghost ? " ghost run" : ""}${fresh && i < 24 ? " enter" : ""}" style="--i:${i}"` +
        `${e.ghost ? ` data-ghost="${escapeAttr(e.jid)}"` : ` data-path="${escapeAttr(e.path)}" draggable="true"`}>` +
        `<span class="fmx-ck${on ? " on" : ""}"></span>` +
        `<div class="fmx-n">${e.isDir ? FM_IC.dir : FM_IC.file}<span title="${escapeAttr(e.name)}">${escapeHtml(e.name)}${e.ghost ? `<b class="fmx-in"> · ${fmL("masuk", "incoming")}</b>` : ""}</span></div>` +
        `<span class="fmx-m">${e.isDir && e.kind ? "" : fmDate(e.mtime)}</span>` +
        `<span class="fmx-t"><span class="ts">${escapeHtml(t.s)}</span><span class="tl">${escapeHtml(t.l)}</span></span>` +
        `<span class="fmx-s">${e.isDir ? "" : fmSize(e.size)}</span></div>`;
    }).join("");
    listEl.innerHTML = html;
  }
  fmApplySel(side);
  fmPaintRuns();
}

function fmSortEntries(entries, sort) {
  const mul = sort.asc ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;   // folders first, always
    let r = 0;
    switch (sort.key) {
      case "mtime": r = (a.mtime || 0) - (b.mtime || 0); break;
      case "size": r = (a.size || 0) - (b.size || 0); break;
      case "type": r = fmType(a).l.localeCompare(fmType(b).l); break;
      default: r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    }
    if (r === 0) r = a.name.localeCompare(b.name, undefined, { numeric: true });
    return r * mul;
  });
}

// ── Selection: click = only this one, Ctrl = add/remove, Shift = a range. Checkboxes appear at 2 or more. ──
function fmApplySel(side) {
  const st = fmSt(side), pane = fmPane(side);
  $$(`#fm-${side}-list .fmx-row[data-path]`).forEach((r) => {
    const on = st.sel.has(r.dataset.path);
    r.classList.toggle("on", on); r.querySelector(".fmx-ck")?.classList.toggle("on", on);
  });
  const n = st.sel.size, all = st.shown && st.shown.length;
  pane.classList.toggle("ckm", n >= 2);
  const hc = $(`#fm-${side}-all`);
  hc.classList.toggle("on", !!all && n >= all); hc.classList.toggle("mid", n > 0 && n < all);
  const picked = st.entries.filter((e) => st.sel.has(e.path));
  const dirs = picked.filter((e) => e.isDir).length, files = picked.length - dirs;
  const bytes = picked.reduce((a, e) => a + (e.isDir ? 0 : e.size || 0), 0);
  $(`#fm-${side}-selinfo`).innerHTML = !n ? escapeHtml(fmL("Belum ada yang dipilih", "Nothing selected"))
    : `<b>${escapeHtml(fmL(`${n} dipilih`, `${n} selected`))}</b>${dirs && files ? `<span class="fx"> · ${escapeHtml(fmL(`${dirs} folder, ${files} file`, `${dirs} folder${dirs > 1 ? "s" : ""}, ${files} file${files > 1 ? "s" : ""}`))}</span>` : ""}${bytes ? ` · ${fmSize(bytes)}` : ""}`;
  $(`#fm-${side}-count`).textContent = st.svc ? "" : fmL(`${st.entries.length} item`, `${st.entries.length} item${st.entries.length === 1 ? "" : "s"}`);
  const writable = !st.svc && !!st.path && !st.isRoot;
  $(`#fm-${side}-new`).disabled = !writable;
  $(`#fm-${side}-ren`).disabled = !writable || n !== 1;
  $(`#fm-${side}-del`).disabled = !writable || !n;
  fmUpdateActionBar();
}
function fmClearOther(side) { const o = fmOther(side), so = fmSt(o); if (so.sel.size) { so.sel.clear(); fmApplySel(o); } }
function fmSelectClick(side, row, e) {
  fmClearOther(side);
  const st = fmSt(side), p = row.dataset.path, order = st.shown || [];
  if (e.target.closest(".fmx-ck") || e.ctrlKey || e.metaKey) { if (st.sel.has(p)) st.sel.delete(p); else st.sel.add(p); st.anchor = p; }
  else if (e.shiftKey && st.anchor && order.includes(st.anchor)) {
    const a = order.indexOf(st.anchor), b = order.indexOf(p);
    st.sel.clear(); for (let k = Math.min(a, b); k <= Math.max(a, b); k++) st.sel.add(order[k]);
  } else { st.sel.clear(); st.sel.add(p); st.anchor = p; }
  fmApplySel(side);
}

function fmUpdateActionBar() {
  if (!fmSess) return;
  const L0 = fmSt("local"), R0 = fmSt("remote");
  const upN = L0.sel.size, downN = R0.sel.size, peer = fmPeer();
  const up = $("#fm-send-btn"), down = $("#fm-recv-btn");
  const canUp = upN > 0 && (R0.svc || (!!R0.path && !R0.isRoot));
  const canDown = downN > 0 && !R0.svc && !!L0.path && !L0.isRoot;
  up.disabled = !canUp; down.disabled = !canDown;
  up.classList.toggle("go", canUp); down.classList.toggle("go", canDown && !canUp);
  // ID / EN split the label so "ke Budi" can drop on a narrow window. Other languages need their own word order
  // for the destination, so the button says only "Kirim 2 item" (the arrow shows the way) and the whole sentence
  // (the same text as the right-click menu) is its hover text.
  const whole = lang !== "id" && lang !== "en";
  $("#fm-send-label").innerHTML = !upN ? escapeHtml(fmL("Kirim", "Send")) : whole ? escapeHtml(fmL(`Kirim ${upN} item`, `Send ${upN} items`))
    : `${escapeHtml(fmL(`Kirim ${upN} item`, `Send ${upN} item${upN > 1 ? "s" : ""}`))}<span class="fmx-bt"> ${escapeHtml(fmL(`ke ${peer}`, `to ${peer}`))}</span>`;
  $("#fm-recv-label").innerHTML = !downN ? escapeHtml(fmL("Unduh", "Download")) : whole ? escapeHtml(fmL(`Unduh ${downN} item`, `Download ${downN} items`))
    : `${escapeHtml(fmL(`Unduh ${downN} item`, `Download ${downN} item${downN > 1 ? "s" : ""}`))}<span class="fmx-bt"> ${escapeHtml(fmL("ke PC ini", "to this PC"))}</span>`;
  $("#fm-send-label").title = whole && upN ? fmL(`Kirim ${upN} item ke ${peer}`, `Send ${upN} items to ${peer}`) : "";
  $("#fm-recv-label").title = whole && downN ? fmL(`Unduh ${downN} item ke PC ini`, `Download ${downN} items to this PC`) : "";
  // The pane files would land in has a thin red edge on its path box.
  fmPane("remote").classList.toggle("dst", upN > 0 && !downN);
  fmPane("local").classList.toggle("dst", downN > 0 && !upN);
}

// ── Tools: new folder, rename, delete (this PC directly, the other PC over the session) ──
async function fmOp(side, op, ms) {
  if (side === "local") return window.electronAPI.fsOp(op);
  try { return await requestRemoteOp(fmSess, op, ms); }
  catch (e) { return { ok: false, error: String(e && e.message) === "old" ? "old" : "nochan" }; }
}
function fmOpError(r) {
  const e = r && r.error;
  if (e === "old") return fmL("PC itu tidak menjawab. TryDesk di sana mungkin versi lama (perbarui untuk memakai tombol ini), atau koneksinya lambat.", "That PC didn't answer. TryDesk there may be older (update it to use this button), or the connection is slow.");
  if (e === "ditolak" || e === "denied") return fmL("Tidak diizinkan di PC itu", "Not allowed on that PC");
  if (e === "noname") return fmL("Ketik nama dulu", "Type a name first");
  if (e === "nochan") return fmL("Sesi terputus", "The session ended");
  if (e === "exists") return fmL("Nama itu sudah dipakai di folder ini", "That name is already used in this folder");
  if (e === "denied") return fmL("Kirim dan ambil file dimatikan di PC itu", "Sending and getting files is turned off on that PC");
  if (e === "svc-nodelete") return fmL("Hapus tidak tersedia saat PC itu dilayani layanan Windows TryDesk", "Delete isn't available while that PC is served by the TryDesk Windows service");
  if (e === "EPERM" || e === "EACCES") return fmL("Tidak ada izin untuk mengubah item ini", "No permission to change this item");
  if (e === "EBUSY") return fmL("Item sedang dipakai program lain", "The item is in use by another program");
  return fmL(`Gagal${e ? `: ${e}` : ""}`, `Failed${e ? `: ${e}` : ""}`);
}
async function fmNewFolder(side) {
  const st = fmSt(side); if (!st.path || st.isRoot || st.svc) return;
  const base = fmL("Folder baru", "New folder");
  let r = null;
  for (let k = 1; k <= 30; k++) {
    r = await fmOp(side, { op: "mkdir", path: st.path, name: k === 1 ? base : `${base} (${k})` });
    if (!r || r.error !== "exists") break;
  }
  if (!r || !r.ok) return showToast(fmOpError(r));
  await fmLoad(side, st.path, { keepSel: false });
  st.sel.clear(); st.sel.add(r.path); fmApplySel(side);
  fmStartRename(side, r.path);
}
function fmStartRename(side, path) {
  const st = fmSt(side);
  path = path || [...st.sel][0];
  const row = path && $(`#fm-${side}-list .fmx-row[data-path="${CSS.escape(path)}"]`);
  if (!row) return;
  const nameEl = row.querySelector(".fmx-n span"), old = fmBase(path);
  const inp = document.createElement("input"); inp.className = "fmx-ren"; inp.value = old; inp.spellcheck = false;
  nameEl.replaceWith(inp); row.draggable = false; fmRenaming[side] = true;
  const dot = old.lastIndexOf(".");
  inp.focus(); inp.setSelectionRange(0, dot > 0 && !row.classList.contains("dir") ? dot : old.length);
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true; fmRenaming[side] = false;
    const v = inp.value.trim();
    if (!save || !v || v === old) { fmRenderPane(side); return; }
    const r = await fmOp(side, { op: "rename", path, name: v });
    if (!r || !r.ok) { showToast(fmOpError(r)); fmRenderPane(side); return; }
    await fmLoad(side, st.path, { keepSel: false });
    st.sel.clear(); st.sel.add(r.path); fmApplySel(side);
  };
  inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); });
  inp.addEventListener("blur", () => finish(true));
  inp.addEventListener("click", (e) => e.stopPropagation());
  inp.addEventListener("dblclick", (e) => e.stopPropagation());
}
async function fmDelete(side) {
  const st = fmSt(side), paths = [...st.sel];
  if (!paths.length || !st.path || st.isRoot) return;
  const one = paths.length === 1 ? fmBase(paths[0]) : "";
  const ok = await appConfirm({
    title: one ? fmL(`Hapus ${one}?`, `Delete ${one}?`) : fmL(`Hapus ${paths.length} item?`, `Delete ${paths.length} items?`),
    message: side === "local" ? fmL("Item dipindah ke Recycle Bin PC ini, dan masih bisa dikembalikan dari sana.", "The items go to this PC's Recycle Bin and can be restored from there.")
      : fmL(`Item dipindah ke Recycle Bin di PC ${fmPeer()}, dan masih bisa dikembalikan dari sana.`, `The items go to the Recycle Bin on ${fmPeer()} and can be restored from there.`),
    detail: fmL("File yang terlalu besar untuk Recycle Bin, atau di disk tanpa Recycle Bin (misalnya flashdisk), terhapus permanen.", "Files too big for the Recycle Bin, or on a drive without one (a USB stick, for example), are deleted for good."),
    okLabel: fmL("Hapus", "Delete"), cancelLabel: fmL("Batal", "Cancel"),
  });
  if (!ok || !fmSess) return;
  let r = { ok: true, failed: 0 }; const fails = [];
  for (let k = 0; k < paths.length; k += 400) {   // the other PC takes at most 500 at once
    const x = await fmOp(side, { op: "delete", paths: paths.slice(k, k + 400) }, 120000);
    // which items failed and why (TryDesk after 1.4.0 says it; an older one on the other side only counts them)
    if (x && Array.isArray(x.fails)) for (const f of x.fails.slice(0, 20)) if (f && typeof f.name === "string" && f.name) fails.push({ name: f.name.slice(0, 80), why: typeof f.why === "string" ? f.why : "" });
    if (!x || !x.ok) { r = { ok: false, error: x && x.error, failed: (r.failed || 0) + ((x && x.failed) || (x && x.ok === false && !x.failed ? Math.min(400, paths.length - k) : 0)) }; if (x && !x.failed) break; }
  }
  if (!r || !r.ok) showToast(r && r.failed ? fmDeleteFailText(r.failed, fails) : fmOpError(r), "bad");
  await fmLoad(side, st.path);
}
// "Laporan.xlsx tidak bisa dihapus. Item sedang dipakai program lain. Tutup program itu, lalu coba lagi." / "3 item tidak
// bisa dihapus: a, b, c" (21 Nov: it only said "1 item tidak bisa dihapus", not which one or why).
function fmDeleteFailText(n, fails) {
  const why = (w) => (w === "busy" ? `${fmL("Item sedang dipakai program lain", "The item is in use by another program")}. ${fmL("Tutup program itu, lalu coba lagi", "Close that program, then try again")}.`
    : w === "perm" ? `${fmL("Tidak ada izin untuk mengubah item ini", "No permission to change this item")}.` : "");
  if (n === 1 && fails.length === 1) { const w = why(fails[0].why); return `${fmL(`${fails[0].name} tidak bisa dihapus`, `${fails[0].name} couldn't be deleted`)}${w ? `. ${w}` : ""}`; }
  const head = fmL(`${n} item tidak bisa dihapus`, n === 1 ? "1 item couldn't be deleted" : `${n} items couldn't be deleted`);
  if (!fails.length) return head;
  const names = fails.slice(0, 3).map((f) => f.name).join(", ") + (n > 3 ? `, +${n - 3}` : "");
  const same = fails.every((f) => f.why && f.why === fails[0].why) ? why(fails[0].why) : "";
  return `${head}: ${names}${same ? `. ${same}` : ""}`;
}

// Disk button: the drives of that PC (and its home folder).
async function fmDriveMenu(side) {
  const menu = $("#fm-drive-menu"), chip = $(`#fm-${side}-drive`);
  if (!menu.classList.contains("hidden") && menu.dataset.side === side) { menu.classList.add("hidden"); return; }
  let res;
  try { res = side === "local" ? await window.electronAPI.fsList(null) : await requestRemoteList(fmSess, { path: null }); } catch { res = null; }
  if (!res || !res.ok) return showToast(fmL("Daftar disk tidak bisa dibuka", "Couldn't list the drives"));
  const cur = (fmSt(side).path || "").slice(0, 2).toUpperCase();
  menu.replaceChildren();
  for (const e of res.entries || []) {
    const b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "menuitem");
    const isHome = e.kind === "home";
    b.innerHTML = `${isHome ? FM_IC.home : FM_IC.drive}<span></span>`;
    b.querySelector("span").textContent = isHome ? fmL("Folder pengguna", "User folder") : e.name.replace(/\\$/, "");
    if (!isHome && e.name.slice(0, 2).toUpperCase() === cur) b.classList.add("cur");
    b.addEventListener("click", () => { menu.classList.add("hidden"); fmLoad(side, e.path); });
    menu.append(b);
  }
  const fr = $("#fmx").getBoundingClientRect(), cr = chip.getBoundingClientRect();
  menu.dataset.side = side;
  menu.style.top = `${cr.bottom - fr.top + 6}px`;
  menu.style.left = ""; menu.style.right = `${fr.right - cr.right}px`;
  menu.classList.remove("hidden");
}

// ── Right-click menu (owner's pick 16 Nov: Arah A, a plain list like Windows 11: icon, name, key on the right) ──
// On picked items: Kirim/Unduh, Ganti nama, Hapus, Salin jalur, Pilih semua (a single folder also gets Buka).
// On empty space: Folder baru, Muat ulang, Pilih semua, Urutkan menurut (a submenu). Arrow keys, Enter, Esc work.
const FMC = {
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  all: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8.2 12.4l2.7 2.7 5-5.2"/></svg>',
  sort: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};
let fmCtx = null;   // { side, el, sub, level }
function fmCtxClose() {
  if (!fmCtx) return;
  fmCtx.el.remove(); if (fmCtx.sub) fmCtx.sub.remove();
  const back = fmCtx.side; fmCtx = null;
  try { $(`#fm-${back}-list`).focus({ preventScroll: true }); } catch {}
}
function fmCanMove(side) {
  const L0 = fmSt("local"), R0 = fmSt("remote");
  return side === "local" ? (R0.svc || (!!R0.path && !R0.isRoot)) : (!R0.svc && !!L0.path && !L0.isRoot);
}
async function fmCopyPaths(side) {
  const st = fmSt(side), order = st.shown || [];
  const paths = order.filter((p) => st.sel.has(p));
  if (!paths.length) return;
  try { await navigator.clipboard.writeText(paths.join("\r\n")); showToast(paths.length === 1 ? fmL("Jalur disalin", "Path copied") : fmL(`${paths.length} jalur disalin`, `${paths.length} paths copied`)); }
  catch { showToast(fmL("Jalur tidak bisa disalin", "Couldn't copy the path")); }
}
function fmSelectAll(side) {
  const st = fmSt(side); fmClearOther(side);
  (st.shown || []).forEach((p) => st.sel.add(p)); fmApplySel(side);
}
function fmSortBy(side, key, asc) {
  const st = fmSt(side);
  if (key) st.sort.key = key;
  if (asc != null) st.sort.asc = asc;
  fmRenderPane(side);
}
function fmCtxItems(side, onRow) {
  const st = fmSt(side), peer = fmPeer();
  const writable = !st.svc && !!st.path && !st.isRoot;
  if (onRow) {
    const picked = st.entries.filter((e) => st.sel.has(e.path)), n = picked.length, one = n === 1 ? picked[0] : null;
    const items = [];
    if (one && one.isDir) items.push({ ic: FM_IC.open, label: fmL("Buka", "Open"), key: "Enter", act: () => fmLoad(side, one.path) });
    items.push(side === "local"
      ? { ic: FMC.right, label: fmL(`Kirim ${n} item ke ${peer}`, `Send ${n} item${n > 1 ? "s" : ""} to ${peer}`), pri: true, dis: !fmCanMove("local"), act: () => fmEnqueue("up") }
      : { ic: FM_IC.left, label: fmL(`Unduh ${n} item ke PC ini`, `Download ${n} item${n > 1 ? "s" : ""} to this PC`), pri: true, dis: !fmCanMove("remote"), act: () => fmEnqueue("down") });
    items.push("-",
      { ic: FM_IC.ren, label: fmL("Ganti nama", "Rename"), key: "F2", dis: !writable || n !== 1, act: () => fmStartRename(side) },
      { ic: FM_IC.del, label: fmL("Hapus", "Remove"), key: "Del", dis: !writable, act: () => fmDelete(side) },
      "-",
      { ic: FMC.copy, label: fmL("Salin jalur", "Copy path"), key: "Ctrl+Shift+C", act: () => fmCopyPaths(side) },
      "-",
      { ic: FMC.all, label: fmL("Pilih semua", "Select all"), key: "Ctrl+A", dis: !(st.shown || []).length, act: () => fmSelectAll(side) });
    return items;
  }
  const byName = st.sort.key === "name";
  const sub = [
    { ic: st.sort.key === "name" ? FMC.tick : "", label: fmL("Nama", "Name"), chk: true, act: () => fmSortBy(side, "name") },
    { ic: st.sort.key === "mtime" ? FMC.tick : "", label: fmL("Diubah", "Modified"), chk: true, act: () => fmSortBy(side, "mtime") },
    { ic: st.sort.key === "type" ? FMC.tick : "", label: fmL("Jenis", "Type"), chk: true, act: () => fmSortBy(side, "type") },
    { ic: st.sort.key === "size" ? FMC.tick : "", label: fmL("Ukuran", "Size"), chk: true, act: () => fmSortBy(side, "size") },
    "-",
    { ic: st.sort.asc ? FMC.tick : "", label: byName ? fmL("Naik (A ke Z)", "Ascending (A to Z)") : fmL("Naik", "Ascending"), chk: true, act: () => fmSortBy(side, null, true) },
    { ic: !st.sort.asc ? FMC.tick : "", label: byName ? fmL("Turun (Z ke A)", "Descending (Z to A)") : fmL("Turun", "Descending"), chk: true, act: () => fmSortBy(side, null, false) },
  ];
  return [
    { ic: FM_IC.newf, label: fmL("Folder baru", "New folder"), key: "Ctrl+Shift+N", dis: !writable, act: () => fmNewFolder(side) },
    { ic: FM_IC.refresh, label: fmL("Muat ulang", "Reload"), key: "F5", act: () => fmLoad(side, st.path, { keepSel: true }) },
    { ic: FMC.all, label: fmL("Pilih semua", "Select all"), key: "Ctrl+A", dis: !(st.shown || []).length, act: () => fmSelectAll(side) },
    "-",
    { ic: FMC.sort, label: fmL("Urutkan menurut", "Sort by"), sub, dis: st.svc || !st.entries.length },
  ];
}
function fmCtxEl(items, sub) {
  const m = document.createElement("div");
  m.className = "fmx-ctx" + (sub ? " sub" : ""); m.setAttribute("role", "menu");
  for (const it of items) {
    if (it === "-") { const s = document.createElement("div"); s.className = "fmx-cs"; s.setAttribute("role", "separator"); m.append(s); continue; }
    const b = document.createElement("div");
    b.className = "fmx-ci" + (it.pri ? " pri" : "") + (it.dis ? " dis" : "") + (it.chk ? " chk" : "") + (it.sub ? " has" : "");
    b.setAttribute("role", "menuitem"); if (it.dis) b.setAttribute("aria-disabled", "true"); if (it.sub) b.setAttribute("aria-haspopup", "menu");
    b.innerHTML = `${it.ic || "<i></i>"}<span></span>${it.sub ? `<kbd>${FMC.chev}</kbd>` : it.key ? `<kbd></kbd>` : ""}`;
    b.querySelector("span").textContent = it.label;
    if (it.key && !it.sub) b.querySelector("kbd").textContent = it.key;
    b._it = it;
    m.append(b);
  }
  return m;
}
// Placed at the pointer, kept inside File Transfer: opens to the left / upwards when there is no room.
function fmCtxPlace(el, x, y, alignRight) {
  const box = $("#fmx").getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  let left = x - box.left, top = y - box.top, ox = "0", oy = "0";
  if (alignRight || left + w > box.width - 8) { left = Math.max(8, (alignRight ? alignRight - box.left : left) - w); ox = "100%"; }
  if (top + h > box.height - 8) { const up = top - h; top = up >= 8 ? up : Math.max(8, box.height - h - 8); oy = up >= 8 ? "100%" : "0"; }
  el.style.left = `${Math.round(left)}px`; el.style.top = `${Math.round(top)}px`; el.style.transformOrigin = `${ox} ${oy}`;
}
function fmCtxHot(menu, item) {
  menu.querySelectorAll(".fmx-ci.on").forEach((x) => x.classList.remove("on"));
  if (item) item.classList.add("on");
}
function fmCtxOpenSub(item, focus) {
  if (!fmCtx || !item || !item._it.sub || item._it.dis) return;
  if (fmCtx.sub && fmCtx.subOf === item) { if (focus) { fmCtx.level = 1; fmCtxHot(fmCtx.sub, fmCtx.sub.querySelector(".fmx-ci:not(.dis)")); } return; }
  if (fmCtx.sub) fmCtx.sub.remove();
  const sub = fmCtxEl(item._it.sub, true);
  $("#fmx").append(sub);
  const r = item.getBoundingClientRect(), box = $("#fmx").getBoundingClientRect();
  const roomRight = r.right - 4 + sub.offsetWidth <= box.right - 8;
  fmCtxPlace(sub, roomRight ? r.right - 4 : r.left + 4, r.top - 6, roomRight ? 0 : r.left + 4);
  fmCtx.sub = sub; fmCtx.subOf = item;
  fmCtxWire(sub, true);
  if (focus) { fmCtx.level = 1; fmCtxHot(sub, sub.querySelector(".fmx-ci:not(.dis)")); }
}
function fmCtxCloseSub() { if (fmCtx && fmCtx.sub) { fmCtx.sub.remove(); fmCtx.sub = null; fmCtx.subOf = null; fmCtx.level = 0; } }
function fmCtxRun(item) {
  if (!item || item._it.dis) return;
  if (item._it.sub) return fmCtxOpenSub(item, true);
  const act = item._it.act;
  fmCtxClose();
  if (act) act();
}
function fmCtxWire(menu, isSub) {
  menu.addEventListener("pointermove", (e) => {
    const it = e.target.closest(".fmx-ci"); if (!it || !fmCtx) return;
    fmCtxHot(menu, it); fmCtx.level = isSub ? 1 : 0;
    if (!isSub) { if (it._it.sub) fmCtxOpenSub(it, false); else fmCtxCloseSub(); }
  });
  menu.addEventListener("click", (e) => { e.stopPropagation(); fmCtxRun(e.target.closest(".fmx-ci")); });
  menu.addEventListener("contextmenu", (e) => e.preventDefault());
}
function fmCtxOpen(side, x, y, onRow) {
  fmCtxClose();
  $("#fm-drive-menu").classList.add("hidden");
  const el = fmCtxEl(fmCtxItems(side, onRow), false);
  $("#fmx").append(el);
  fmCtxPlace(el, x, y);
  fmCtx = { side, el, sub: null, subOf: null, level: 0 };
  fmCtxWire(el, false);
}
// Arrow keys move, Enter or Space picks, Right opens the submenu, Left or Esc steps back.
function fmCtxKey(e) {
  if (!fmCtx) return false;
  const menu = fmCtx.level && fmCtx.sub ? fmCtx.sub : fmCtx.el;
  const items = [...menu.querySelectorAll(".fmx-ci:not(.dis)")], cur = menu.querySelector(".fmx-ci.on");
  const k = e.key;
  if (k === "ArrowDown" || k === "ArrowUp") {
    const i = items.indexOf(cur), n = items.length; if (!n) return true;
    fmCtxHot(menu, items[k === "ArrowDown" ? (i + 1) % n : (i <= 0 ? n - 1 : i - 1)]);
    if (!fmCtx.level) { const h = menu.querySelector(".fmx-ci.on"); if (!(h && h._it.sub)) fmCtxCloseSub(); }
  } else if (k === "Enter" || k === " ") fmCtxRun(cur);
  else if (k === "ArrowRight") { if (!fmCtx.level && cur && cur._it.sub) fmCtxOpenSub(cur, true); }
  else if (k === "ArrowLeft") { if (fmCtx.level) { fmCtxCloseSub(); fmCtxHot(fmCtx.el, fmCtx.subOf || fmCtx.el.querySelector(".fmx-ci.has")); } }
  else if (k === "Escape") { if (fmCtx.level) { const of = fmCtx.subOf; fmCtxCloseSub(); fmCtxHot(fmCtx.el, of); } else fmCtxClose(); }
  else if (k === "Tab") fmCtxClose();
  else return false;
  e.preventDefault(); e.stopPropagation();
  return true;
}
function fmCtxFromEvent(side, e) {
  e.preventDefault();
  if (!fmSess) return;
  const st = fmSt(side);
  const row = e.target.closest && e.target.closest(".fmx-row");
  if (row && row.classList.contains("ghost")) return;
  if (row && row.dataset.path) {
    // Like Explorer: right-click on an item that isn't picked picks only it; on a picked one, the menu is for all of them.
    if (!st.sel.has(row.dataset.path)) { fmClearOther(side); st.sel.clear(); st.sel.add(row.dataset.path); st.anchor = row.dataset.path; fmApplySel(side); }
    fmCtxOpen(side, e.clientX, e.clientY, true);
  } else {
    if (st.sel.size) { st.sel.clear(); fmApplySel(side); }
    fmCtxOpen(side, e.clientX, e.clientY, false);
  }
}
// The Menu key or Shift+F10: the menu opens at the first picked row (or the top of the list).
function fmCtxFromKey(side) {
  const st = fmSt(side), list = $(`#fm-${side}-list`);
  const first = (st.shown || []).find((p) => st.sel.has(p));
  const row = first && [...list.querySelectorAll(".fmx-row[data-path]")].find((r) => r.dataset.path === first);
  const r = (row || list).getBoundingClientRect();
  fmCtxOpen(side, r.left + 40, r.top + (row ? r.height : 12), !!row);
  fmCtxHot(fmCtx.el, fmCtx.el.querySelector(".fmx-ci:not(.dis)"));
}

// ── Transfers ──────────────────────────────────────────────
// A job is what the person picked (a file, or a folder with everything in it); its items are the single files the
// queue moves one by one. Each item names the folder it lands in; folders are made just before their first file.
async function fmWalk(sess, side, root, out, rel = "", depth = 0) {
  if (depth > 40 || out.files.length >= 5000) return;
  let res;
  try { res = side === "local" ? await window.electronAPI.fsList(root) : await requestRemoteList(sess, { path: root }); } catch { res = null; }
  if (!res || !res.ok) { out.unreadable++; return; }
  out.dirs.push(rel);
  for (const e of res.entries || []) {
    if (e.isDir) await fmWalk(sess, side, e.path, out, rel ? fmJoin(rel, e.name) : e.name, depth + 1);
    else if (out.files.length < 5000) out.files.push({ path: e.path, name: e.name, size: e.size, mtime: e.mtime || 0, rel });
  }
}

// sess / fresh / onAll: the clipboard's files (clipFiles*) use the same queue for a session whose File Transfer may be
// closed, into a new empty folder (nothing there to clash with); onAll(ok) runs once every one of them has ended.
async function fmEnqueue(dir, { destDir = null, items = null, sess: forSess = null, fresh = false, onAll = null } = {}) {
  const sess = forSess || fmSess; if (!sess) return;
  const fromSide = dir === "up" ? "local" : "remote", toSide = dir === "up" ? "remote" : "local";
  const fromSt = sess.fm[fromSide], toSt = sess.fm[toSide];
  const picked = items || fromSt.entries.filter((e) => fromSt.sel.has(e.path));
  if (!picked.length) return;
  // The other PC's Windows service (fmLoad: st.svc): no destination folder, the files go as offers (Downloads\TryDesk).
  if (dir === "up" && toSt.svc && !fresh) {
    const files = picked.filter((e) => !e.isDir);
    if (picked.length > files.length) showToast(fmL("Folder belum bisa dikirim ke PC ini: kirim file-filenya", "Folders can't be sent to this PC yet: send their files"));
    if (!files.length) return;
    fromSt.sel.clear(); fmApplySel(fromSide);
    showToast(fmL(`${files.length} file dikirim. Menunggu orang di PC itu menekan Terima.`, `${files.length} file(s) sent. Waiting for the person at that PC to press Accept.`));
    startSendFiles(files.map((e) => ({ path: e.path, name: e.name, size: e.size })), sess);
    return;
  }
  const dest = destDir || toSt.path;
  if (!dest || (!destDir && toSt.isRoot)) { showToast(tr("Pilih folder tujuan dulu")); return; }
  // Files with the same name already there: ask (File sudah ada). Folders with the same name are merged.
  let have = [];
  if (fresh) have = [];
  else if (dest === toSt.path) have = toSt.entries.map((e) => ({ name: e.name, isDir: e.isDir, size: e.size, mtime: e.mtime }));
  else { const r = await fmOp(toSide, { op: "exists", path: dest, names: picked.map((e) => e.name) }).catch(() => null); have = (r && r.found) || []; }
  const clash = picked.filter((e) => !e.isDir && have.some((h) => !h.isDir && h.name.toLowerCase() === e.name.toLowerCase()));
  const choice = new Map();
  let all = null;
  for (let k = 0; k < clash.length; k++) {
    const e = clash[k];
    if (all) { choice.set(e.path, all); continue; }
    const h = have.find((x) => x.name.toLowerCase() === e.name.toLowerCase());
    const ans = await fmAskDup(dir, e, h, dest, clash.length - k - 1);
    if (!ans) return;   // Batalkan transfer
    choice.set(e.path, ans.v);
    if (ans.all) all = ans.v;
  }
  const todo = picked.filter((e) => choice.get(e.path) !== "skip");
  if (!items) { fromSt.sel.clear(); fmApplySel(fromSide); }
  if (!todo.length) { if (onAll) onAll(false); return; }
  if (!sess.fmJobs) sess.fmJobs = [];
  if (!sess.fmJobs.some((j) => j.status === "queued" || j.status === "active")) sess.fmBatch = (sess.fmBatch || 0) + 1;
  const group = onAll ? { left: todo.length, ok: true, onAll } : null;
  for (const e of todo) {
    const jid = `j${Date.now()}-${++sess.fmQueueSeq}`;
    const job = { jid, dir, name: e.name, isDir: !!e.isDir, srcPath: e.path, destDir: dest, total: e.isDir ? 0 : (e.size || 0), done: 0, count: 1, status: "queued", batch: sess.fmBatch, items: [], group };
    sess.fmJobs.push(job);
    if (!e.isDir) {
      job.items.push(fmItem(sess, job, { name: e.name, size: e.size, mtime: e.mtime, srcPath: e.path, destDir: dest, replace: choice.get(e.path) === "replace" }));
    } else {
      job.status = "prep"; fmPaint();
      const out = { files: [], dirs: [], unreadable: 0 };
      await fmWalk(sess, fromSide, e.path, out);
      const top = fmJoin(dest, safeFileName(e.name));
      for (const rel of out.dirs) job.items.push(fmItem(sess, job, { mkOnly: true, ensureDir: rel ? fmJoin(top, rel) : top }));
      for (const f of out.files) {
        const to = f.rel ? fmJoin(top, f.rel) : top;
        job.items.push(fmItem(sess, job, { name: f.name, size: f.size, mtime: f.mtime, srcPath: f.path, destDir: to }));
      }
      job.total = out.files.reduce((a, f) => a + (f.size || 0), 0); job.count = out.files.length;
      if (out.unreadable) showToast(fmL(`${e.name}: ${out.unreadable} folder tidak bisa dibaca dan dilewati`, `${e.name}: ${out.unreadable} folder(s) couldn't be read and were skipped`));
      if (have.some((h) => h.isDir && h.name.toLowerCase() === e.name.toLowerCase())) showToast(fmL(`Folder ${e.name} sudah ada di tujuan: isinya digabung, file dengan nama sama disimpan dengan nama baru`, `Folder ${e.name} already exists there: the contents are merged, files with the same name get a new name`));
      if (out.files.length >= 5000) showToast(fmL(`${e.name}: hanya 5000 file pertama yang dipindah`, `${e.name}: only the first 5000 files are moved`));
      job.status = "queued";
    }
    for (const it of job.items) sess.fmQueue.push(it);
  }
  if (fmSess === sess && fmOpen) { fmPaint(); fmRenderPane(toSide); }
  fmStartQueue(sess);
}
function fmItem(sess, job, o) {
  return { id: `m${Date.now()}-${++sess.fmQueueSeq}`, dir: job.dir, job, name: o.name || "", size: o.size || 0, mtime: o.mtime || 0, srcPath: o.srcPath || "",
    destDir: o.destDir || o.ensureDir, ensureDir: o.ensureDir || null, mkOnly: !!o.mkOnly, replace: !!o.replace,
    status: "queued", sent: 0, paused: false, canceled: false };
}
// The resume key of a transfer: the same file (path, size, date) to the same place. A file changed since gets a new
// key, so it is sent whole again instead of finishing an old copy.
const fmRk = (i) => JSON.stringify([i.dir, i.srcPath, i.size || 0, Math.round(i.mtime || 0), i.destDir, i.name, !!i.replace]).slice(0, 4000);
const fmOff = (v, size) => (Number.isSafeInteger(v) && v > 0 && v <= size ? v : 0);

// Transfers cut off by a dropped connection (owner 16 Nov: "lanjutkan transfer setelah koneksi putus"). The unfinished
// part of the queue waits here per PC; the next session to that PC picks it up as soon as it can carry files, and
// each file continues where it stopped (the receiving side kept what it had, see main.js resumeParts).
const fmStash = new Map();   // peerId -> { at, jobs: [{ job, items }] }
function fmStashQueue(sess) {
  if (!sess || sess.role !== "viewer" || !sess.peerId || !sess.fmJobs) return;
  const jobs = [];
  for (const j of sess.fmJobs) {
    const left = j.items.filter((i) => !i.canceled && (i.status === "queued" || i.status === "active"));
    if (!left.length) continue;
    jobs.push({ job: j, items: left });
  }
  if (jobs.length) fmStash.set(sess.peerId, { at: Date.now(), jobs });
}
function fmResumeStash(sess) {
  const st = sess && sess.role === "viewer" && fmStash.get(sess.peerId);
  if (!st) return;
  fmStash.delete(sess.peerId);
  if (Date.now() - st.at > 6 * 3600 * 1000) return;   // the other PC dropped its parts after 6 hours as well
  if (!sess.fmJobs) sess.fmJobs = [];
  sess.fmBatch = (sess.fmBatch || 0) + 1;
  let n = 0;
  for (const { job: old, items } of st.jobs) {
    const job = { ...old, jid: `j${Date.now()}-${++sess.fmQueueSeq}`, status: "queued", batch: sess.fmBatch, err: null, items: [] };
    job.done = old.items.filter((i) => i.status === "done").reduce((a, i) => a + (i.size || 0), 0);
    for (const i of items) {
      const it = fmItem(sess, job, i);
      job.items.push(it); sess.fmQueue.push(it);
      if (!it.mkOnly) n++;
    }
    sess.fmJobs.push(job);
  }
  if (!n && !sess.fmQueue.some((i) => i.status === "queued")) return;
  showToast(fmL(`Melanjutkan ${n} transfer yang tadi terputus`, `Resuming ${n} transfer(s) cut off earlier`));
  if (fmSess === sess && fmOpen) { fmPaint(); fmRenderPane("local"); fmRenderPane("remote"); }
  fmStartQueue(sess);
}

// File sudah ada: compare the two, then Ganti / Simpan keduanya / Lewati (once, or for every other clash too).
function fmAskDup(dir, e, h, dest, more) {
  return new Promise((resolve) => {
    const w = $("#fm-dup"), peer = fmPeer();
    $("#fm-dup-title").innerHTML = `${escapeHtml(e.name)} <em>${escapeHtml(fmL("sudah ada.", "already exists."))}</em>`;
    const where = fmBase(dest) || dest;
    $("#fm-dup-where").textContent = dir === "up" ? fmL(`Di folder ${where} PC ${peer}. Bandingkan, lalu pilih:`, `In the ${where} folder on ${peer}. Compare, then choose:`)
      : fmL(`Di folder ${where} PC ini. Bandingkan, lalu pilih:`, `In the ${where} folder on this PC. Compare, then choose:`);
    const dl = (x) => `<dt>${escapeHtml(fmL("Diubah", "Modified"))}</dt><dd>${fmDate(x.mtime, true).replace(/<[^>]+>/g, "")}</dd><dt>${escapeHtml(fmL("Jenis", "Type"))}</dt><dd>${escapeHtml(fmType({ name: e.name }).l)}</dd><dt>${escapeHtml(fmL("Ukuran", "Size"))}</dt><dd>${fmSize(x.size || 0)}</dd>`;
    $("#fm-dup-a-h").textContent = dir === "up" ? fmL("Yang dikirim", "Being sent") : fmL("Yang diunduh", "Being downloaded");
    $("#fm-dup-b-h").textContent = fmL("Yang sudah ada", "Already there");
    $("#fm-dup-a").innerHTML = dl(e); $("#fm-dup-b").innerHTML = dl(h || {});
    const newer = (e.mtime || 0) > ((h && h.mtime) || 0);
    $("#fm-dup-a-new").classList.toggle("hidden", !newer); $("#fm-dup-b-new").classList.toggle("hidden", newer || !((h && h.mtime) > (e.mtime || 0)));
    let v = newer ? "replace" : "keep";
    const opts = $$("#fm-dup .fmx-opt");
    const paint = () => opts.forEach((b) => { b.classList.toggle("sel", b.dataset.v === v); b.setAttribute("aria-checked", b.dataset.v === v ? "true" : "false"); });
    paint();
    $("#fm-dup-all-row").classList.toggle("hidden", !more);
    $("#fm-dup-all").checked = false;   // one click must not replace files that are newer at the destination
    $("#fm-dup-all-label").textContent = fmL(`Pakai untuk ${more} file lain yang juga sudah ada`, `Use for ${more} other file${more > 1 ? "s" : ""} that also exist`);
    const ctl = new AbortController();
    opts.forEach((b) => b.addEventListener("click", () => { v = b.dataset.v; paint(); }, { signal: ctl.signal }));
    const end = (ans) => { ctl.abort(); w.classList.add("hidden"); fmDupOpen = null; resolve(ans); };
    fmDupOpen = () => end(null);
    $("#fm-dup-ok").addEventListener("click", () => end({ v, all: more > 0 && $("#fm-dup-all").checked }), { signal: ctl.signal });
    $("#fm-dup-cancel").addEventListener("click", () => end(null), { signal: ctl.signal });
    w.classList.remove("hidden");
    $("#fm-dup-ok").focus();
  });
}
let fmDupOpen = null;

function fmGhostsFor(side) {
  if (!fmSess || !fmSess.fmJobs) return [];
  const st = fmSt(side), want = side === "remote" ? "up" : "down";
  return fmSess.fmJobs.filter((j) => j.dir === want && j.status === "active" && j.destDir === st.path)
    .map((j) => ({ ghost: true, jid: j.jid, name: j.name, isDir: j.isDir, size: j.total, mtime: Date.now() }));
}

function fmJobPct(j) { return j.total > 0 ? Math.min(100, Math.floor((j.done / j.total) * 100)) : (j.status === "done" ? 100 : 0); }
function fmJobSent(j) {
  const cur = j.items.find((i) => i.status === "active");
  return Math.min(j.total, j.done + (cur ? cur.sent || 0 : 0));
}
// Red fill + percent on the row being moved (in the pane it leaves) and on its "masuk" row (in the pane it enters).
function fmPaintRuns() {
  if (!fmSess) return;
  const jobs = fmSess.fmJobs || [];
  $$("#fmx .fmx-row.run[data-path]").forEach((r) => { if (!jobs.some((j) => j.status === "active" && j.srcPath === r.dataset.path)) { r.classList.remove("run"); r.style.removeProperty("--p"); const s = r.querySelector(".fmx-s"); if (s && s.dataset.was != null) { s.textContent = s.dataset.was; delete s.dataset.was; } } });
  for (const j of jobs) {
    if (j.status !== "active") continue;
    const pct = j.total > 0 ? Math.min(100, Math.floor((fmJobSent(j) / j.total) * 100)) : 0;
    const from = j.dir === "up" ? "local" : "remote";
    const rows = [$(`#fm-${from}-list .fmx-row[data-path="${CSS.escape(j.srcPath)}"]`), $(`#fmx .fmx-row[data-ghost="${CSS.escape(j.jid)}"]`)];
    for (const r of rows) {
      if (!r) continue;
      r.classList.add("run"); r.style.setProperty("--p", pct);
      const s = r.querySelector(".fmx-s"); if (s) { if (s.dataset.was == null && r.dataset.path) s.dataset.was = s.textContent; s.textContent = `${pct}%`; }
    }
  }
}

// The bottom strip and the queue drawer.
let _fmPaintT = 0;
function fmPaintSoon() { if (_fmPaintT) return; _fmPaintT = setTimeout(() => { _fmPaintT = 0; fmPaint(); }, 120); }
function fmPaint() {
  if (!fmSess || !fmOpen) return;
  const sess = fmSess, jobs = (sess.fmJobs || []).filter((j) => j.status !== "removed");
  const batch = jobs.filter((j) => j.batch === sess.fmBatch);
  const live = batch.filter((j) => j.status === "active" || j.status === "queued" || j.status === "prep");
  const counted = batch.filter((j) => j.status !== "canceled" && j.status !== "error");
  const total = counted.reduce((a, j) => a + j.total, 0), sent = counted.reduce((a, j) => a + (j.status === "done" ? j.total : fmJobSent(j)), 0);
  const act = batch.find((j) => j.status === "active") || batch.find((j) => j.status === "prep");
  const curItem = sess.fmQueue.find((i) => i.status === "active");
  const paused = !!sess.fmPaused || !!(curItem && curItem.paused);
  const speed = !paused && curItem && curItem.speed ? curItem.speed : 0;
  const pct = total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : (live.length ? 0 : 100);
  const ring = $("#fm-ring"), long = $("#fm-st-long"), short = $("#fm-st-short"), sub = $("#fm-st-sub");
  const peer = fmPeer();
  if (live.length && act) {
    const k = batch.indexOf(act) + 1, n = batch.length, up = act.dir === "up";
    const verb = act.status === "prep" ? fmL("Menyiapkan", "Preparing") : up ? fmL("Mengirim", "Sending") : fmL("Mengunduh", "Downloading");
    long.textContent = `${verb} ${act.name} · ${fmL(`${k} dari ${n}`, `${k} of ${n}`)}`;
    short.textContent = `${verb} ${fmL(`${k} dari ${n}`, `${k} of ${n}`)} · ${pct}%`;
    const eta = speed ? fmEta((total - sent) / speed) : "";
    sub.textContent = paused ? `${fmL("Dijeda", "Paused")} · ${fmSize(sent)} / ${fmSize(total)}`
      : [`${fmSize(sent)} / ${fmSize(total)}`, speed ? `${fmSize(speed)}/s` : "", eta].filter(Boolean).join(" · ");
    ring.classList.remove("done");
  } else if (batch.length) {
    const ok = batch.filter((j) => j.status === "done").length, bad = batch.filter((j) => j.status === "error").length;
    long.textContent = !ok && !bad ? fmL("Transfer dibatalkan", "Transfer cancelled") : bad ? fmL(`Selesai, ${bad} gagal`, `Finished, ${bad} failed`) : fmL(`Selesai · ${ok} item`, `Done · ${ok} item${ok === 1 ? "" : "s"}`);
    short.textContent = long.textContent;
    const last = [...batch].reverse().find((j) => j.status === "done") || batch[batch.length - 1];
    sub.textContent = !ok ? (bad ? fmErrText(batch.find((j) => j.err) && batch.find((j) => j.err).err) : "") : last.dir === "up" ? fmL(`Tersimpan di PC ${peer}, ${last.destDir}`, `Saved on ${peer}, ${last.destDir}`) : fmL(`Tersimpan di ${last.destDir}`, `Saved in ${last.destDir}`);
    ring.classList.toggle("done", !bad && ok > 0);
  } else {
    long.textContent = fmL("Belum ada transfer berjalan", "No transfer running");
    short.textContent = fmL("Belum ada transfer", "No transfer");
    sub.textContent = fmL("Seret file ke panel lain, atau pilih lalu tekan Kirim", "Drag files to the other pane, or select them and press Send");
    ring.classList.remove("done");
  }
  sub.title = sub.textContent;   // longer languages cut this line next to a wide button: the whole hint on hover
  // Nothing arrived (all failed or cancelled): an empty ring, not a full one.
  const ringPct = live.length ? pct : batch.some((j2) => j2.status === "done") ? 100 : 0;
  ring.querySelector(".fgc").style.strokeDashoffset = String(88 - (88 * ringPct) / 100);
  const pz = $("#fm-pause-all");
  pz.disabled = !live.length; pz.classList.toggle("paused", !!sess.fmPaused);
  pz.title = sess.fmPaused ? fmL("Lanjutkan", "Resume") : fmL("Jeda", "Pause"); pz.setAttribute("aria-label", pz.title);
  $("#fm-queue-count").textContent = jobs.length ? String(jobs.length) : "";
  fmPaintRuns();
  if (!$("#fm-drawer").classList.contains("hidden")) fmPaintDrawer();
}
function fmPaintDrawer() {
  const sess = fmSess, jobs = (sess.fmJobs || []).filter((j) => j.status !== "removed"), peer = fmPeer();
  const counted = jobs.filter((j) => j.status !== "canceled" && j.status !== "error");
  const total = counted.reduce((a, j) => a + j.total, 0), sent = counted.reduce((a, j) => a + (j.status === "done" ? j.total : fmJobSent(j)), 0);
  const curItem = sess.fmQueue.find((i) => i.status === "active"), speed = (!sess.fmPaused && curItem && !curItem.paused && curItem.speed) || 0;
  $("#fm-dsum").textContent = jobs.length ? [fmL(`${jobs.length} item`, `${jobs.length} item${jobs.length === 1 ? "" : "s"}`), `${fmSize(sent)} / ${fmSize(total)}`, speed ? `${fmSize(speed)}/s` : "", speed ? fmEta((total - sent) / speed) : ""].filter(Boolean).join(" · ") : "";
  $("#fm-dbar").style.width = `${total ? Math.floor((sent / total) * 100) : 0}%`;
  $("#fm-pause-all2").textContent = sess.fmPaused ? fmL("Lanjutkan semua", "Resume all") : fmL("Jeda semua", "Pause all");
  $("#fm-pause-all2").disabled = !jobs.some((j) => j.status === "active" || j.status === "queued");
  $("#fm-queue-clear").disabled = !jobs.some((j) => j.status === "done" || j.status === "error" || j.status === "canceled");
  const list = $("#fm-queue-list");
  if (!jobs.length) { list.innerHTML = `<div class="fmx-qempty">${escapeHtml(fmL("Belum ada transfer. Pilih file lalu tekan Kirim atau Unduh, atau seret ke panel lain.", "No transfers yet. Select files and press Send or Download, or drag them to the other pane."))}</div>`; return; }
  // Rows are kept and updated in place, so buttons under the mouse don't jump while progress ticks.
  const keep = new Map([...list.querySelectorAll(".fmx-q")].map((r) => [r.dataset.jid, r]));
  const frag = [];
  for (const j of jobs) {
    const pct = fmJobPct({ ...j, done: j.status === "done" ? j.total : fmJobSent(j) });
    const what = j.isDir ? fmL(`Folder · ${j.count} file · ${fmSize(j.total)}`, `Folder · ${j.count} file${j.count === 1 ? "" : "s"} · ${fmSize(j.total)}`) : `${fmType({ name: j.name }).l} · ${fmSize(j.total)}`;
    const line1 = `${j.dir === "up" ? fmL(`Ke ${peer}`, `To ${peer}`) : fmL(`Dari ${peer}`, `From ${peer}`)} · ${what}`;
    const cur = j.items.find((i) => i.status === "active");
    const line2 = j.status === "active" ? (sess.fmPaused || (cur && cur.paused) ? fmL("Dijeda", "Paused") : [cur && cur.speed ? `${fmSize(cur.speed)}/s` : "", cur && cur.speed ? fmEta((j.total - fmJobSent(j)) / cur.speed) : `${pct}%`].filter(Boolean).join(" · "))
      : j.status === "queued" ? fmL("Menunggu", "Waiting") : j.status === "prep" ? fmL("Menyiapkan…", "Preparing…")
      : j.status === "done" ? fmL("Selesai", "Done") : j.status === "canceled" ? fmL("Dibatalkan", "Cancelled") : `${fmL("Gagal", "Failed")}${j.err ? `: ${j.err}` : ""}`;
    let r = keep.get(j.jid);
    if (!r) { r = document.createElement("div"); r.className = "fmx-q enter"; r.dataset.jid = j.jid; r.addEventListener("animationend", () => r.classList.remove("enter"), { once: true }); r.innerHTML = `<svg class="fmx-ring" viewBox="0 0 36 36"><circle class="bgc" cx="18" cy="18" r="14" fill="none" stroke-width="4"/><circle class="fgc" cx="18" cy="18" r="14" fill="none" stroke-width="4" stroke-linecap="round" transform="rotate(-90 18 18)"/></svg><div><b></b><small></small><small></small></div><span class="fmx-qa"></span>`; }
    r.classList.toggle("err", j.status === "error");
    r.querySelector(".fmx-ring").classList.toggle("done", j.status === "done");
    r.querySelector(".fgc").style.strokeDashoffset = String(88 - (88 * (j.status === "done" ? 100 : pct)) / 100);
    r.querySelector("b").textContent = j.name;
    const sm = r.querySelectorAll("small"); sm[0].textContent = line1; sm[1].textContent = line2;
    const acts = r.querySelector(".fmx-qa"), want = j.status === "active" ? "pa" : j.status === "queued" ? "x" : j.status === "prep" ? "" : "rm";
    const key = want + (j.status === "active" && cur && cur.paused ? "p" : "");
    if (acts.dataset.k !== key) {
      acts.dataset.k = key; acts.replaceChildren();
      const mk = (ic, title, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "fmx-ib"; b.title = title; b.setAttribute("aria-label", title); b.innerHTML = ic; b.addEventListener("click", fn); acts.append(b); };
      if (want === "pa") mk(cur && cur.paused ? FM_IC.play : FM_IC.pause, cur && cur.paused ? fmL("Lanjutkan", "Resume") : fmL("Jeda", "Pause"), () => { const c = j.items.find((i) => i.status === "active"); if (c) fmTogglePause(c); });
      if (want === "pa" || want === "x") mk(FM_IC.x, fmL("Batalkan", "Cancel"), () => fmCancelJob(j));
      if (want === "rm") mk(FM_IC.x, fmL("Hapus dari daftar", "Remove from list"), () => { j.status = "removed"; fmPaint(); });
    }
    frag.push(r);
  }
  const kids = list.children;
  if (frag.length !== kids.length || frag.some((r, i) => kids[i] !== r)) list.replaceChildren(...frag);
}

function fmProgress(i, sent) {
  const now = performance.now();
  i.sent = sent;
  if (i._lastTs != null) {
    const dt = (now - i._lastTs) / 1000;
    if (dt >= 0.4) { const sp = Math.max(0, (sent - i._lastBytes) / dt); i.speed = i.speed ? i.speed * 0.6 + sp * 0.4 : sp; i._lastTs = now; i._lastBytes = sent; }
  } else { i._lastTs = now; i._lastBytes = sent; }
  fmPaintSoon();
}

function fmTogglePause(i) {
  i.paused = !i.paused;
  if (i.dir === "down") { try { fmSess.fileChannel.send(JSON.stringify({ t: "m-pause", id: i.id, paused: i.paused })); } catch {} }
  fmPaint();
}
function fmPauseAll() {
  const sess = fmSess; if (!sess) return;
  sess.fmPaused = !sess.fmPaused;
  const cur = sess.fmQueue.find((i) => i.status === "active");
  if (cur && cur.paused !== sess.fmPaused) fmTogglePause(cur);
  fmPaint();
}
function fmCancelItem(i) {
  i.canceled = true;
  if (i.status === "active") {
    try { fmSess.fileChannel.send(JSON.stringify({ t: "m-cancel", id: i.id })); } catch {}
    if (fmSess.activeSend && fmSess.activeSend.id === i.id) fmSess.activeSend.canceled = true;
    if (i._wake) i._wake();   // end whatever the transfer is waiting on, so its cleanup runs
    return;                   // fmStartQueue's catch marks it canceled
  }
  if (i.status === "queued") i.status = "canceled";
}
function fmCancelJob(j) {
  for (const i of j.items) if (i.status === "queued" || i.status === "active") fmCancelItem(i);
  if (j.status === "queued") j.status = "canceled";
  fmPaint();
}

// The queue belongs to the session it was started on, captured once, because fmSess changes when the user
// opens the file manager on another tab while this queue is still running.
// Queue errors in words (codes from this PC, the other PC, or the session).
function fmErrText(m) {
  const s = String(m || "");
  if (s === "inuse") return fmL("File di tujuan sedang dipakai program lain. File baru disimpan dengan nama lain.", "The file at the destination is in use by another program. The new file was saved under another name.");
  if (s === "old") return fmL("PC itu tidak menjawab: TryDesk di sana mungkin versi lama, atau koneksinya lambat", "That PC didn't answer: TryDesk there may be older, or the connection is slow");
  if (s === "ditolak" || s === "denied" || s === "not allowed") return fmL("Tidak diizinkan di PC itu", "Not allowed on that PC");
  if (/no-channel|nochan|channel|closed/i.test(s)) return fmL("Sesi terputus", "The session ended");
  if (/invalid directory|ENOENT/i.test(s)) return fmL("Folder tujuan tidak ada lagi", "The destination folder no longer exists");
  if (/EPERM|EACCES/.test(s)) return fmL("Tidak ada izin di folder itu", "No permission in that folder");
  if (/ENOSPC|disk/i.test(s)) return fmL("Disk penerima penuh", "The receiving disk is full");
  // (cut at 60 it broke words: "…izin Mouse & keyboard di PC itu (mode li"; long texts now end at a whole word)
  return s.length <= 160 ? s : `${s.slice(0, Math.max(s.lastIndexOf(" ", 157), 100))}…`;
}
async function fmStartQueue(sess = fmSess) {
  if (!sess || sess.fmRunning) return;
  if (!sess.fileChannel || sess.fileChannel.readyState !== "open") { showToast(tr("Sesi transfer belum siap")); return; }
  sess.fmRunning = true;
  const paint = () => { if (fmSess === sess) fmPaint(); };
  try {
    while (true) {
      const item = sess.fmQueue.find((i) => i.status === "queued");
      if (!item) break;
      while (sess.fmPaused && !item.canceled) await sleep(150);
      const job = item.job;
      if (item.canceled || (job && job.status === "canceled")) { item.status = "canceled"; fmJobCheck(sess, job); continue; }
      item.status = "active"; item.sent = 0; item._lastTs = null; item.speed = 0;
      if (job && job.status === "queued") { job.status = "active"; if (fmSess === sess && fmOpen) fmRenderPane(job.dir === "up" ? "remote" : "local"); }
      paint();
      try {
        // Each folder of a folder being copied is made just before its files (made again every time: it may have been
        // deleted or renamed since an earlier copy).
        if (item.ensureDir) {
          const r = item.dir === "up" ? await requestRemoteOp(sess, { op: "mkdirp", path: item.ensureDir }, 30000).catch((e) => ({ ok: false, error: String(e && e.message) }))
            : await window.electronAPI.fsOp({ op: "mkdirp", path: item.ensureDir });
          if (!r || !r.ok) throw new Error(r && r.error === "old" ? fmL("PC itu perlu TryDesk terbaru untuk menerima folder", "That PC needs the latest TryDesk to receive folders") : fmErrText(r && r.error) || "mkdir");
        }
        if (!item.mkOnly) {
          if (item.paused !== !!sess.fmPaused) item.paused = !!sess.fmPaused;
          if (item.dir === "up") await fmUpload(item, sess);
          else await fmDownload(item, sess);
        }
        if (!item.canceled) { item.status = "done"; item.sent = item.size; if (job) job.done += item.size || 0; }
        else item.status = "canceled";   // cancelled while nothing could be woken (a folder being made): it still ends
      } catch (e) {
        if (item.canceled) item.status = "canceled";
        else {
          item.status = "error"; item.err = fmErrText(e && e.message || e); if (job) job.err = item.err;
          // A folder that could not be made (or a PC too old to make one): the rest of that job can't land either.
          if (item.ensureDir && job) for (const o of job.items) if (o.status === "queued") { o.status = "error"; o.err = item.err; }
        }
      }
      fmJobCheck(sess, job);
      paint();
    }
  } finally {
    sess.fmRunning = false;
    if (!sess.fmQueue.some((i) => i.status === "queued")) sess.fmPaused = false;   // the next Send never starts paused
    paint();
  }
}
// A job ends when its last item does: refresh the pane it landed in, once.
function fmJobCheck(sess, job) {
  if (!job || job.status === "done" || job.status === "error" || job.status === "removed") return;
  if (job.items.some((i) => i.status === "queued" || i.status === "active")) return;
  const errs = job.items.filter((i) => i.status === "error");
  job.status = job.items.every((i) => i.status === "canceled") ? "canceled" : errs.length ? "error" : "done";
  // A failure sounds at once; success once the whole queue is through (ten files = one sound).
  if (job.status === "error") playEvent("fileFail", false, sess);
  else if (job.status === "done" && !sess.fmQueue.some((i) => i.status === "queued" || i.status === "active")) playEvent("fileDone", false, sess);
  if (errs.length && job.isDir) job.err = fmL(`${errs.length} file gagal`, `${errs.length} file(s) failed`);
  if (job.group) { const g = job.group; if (job.status !== "done") g.ok = false; if (--g.left === 0) { try { g.onAll(g.ok); } catch {} } }
  if (fmSess === sess && fmOpen) {
    const to = job.dir === "up" ? "remote" : "local";
    if (fmSt(to).path === job.destDir) fmLoad(to, fmSt(to).path, { keepSel: true });
    else fmRenderPane(to);
    fmPaintRuns();
  }
}

// Each wait inside a transfer is registered as item._wake so a cancel can end it: the transfer then throws
// "canceled" through its own catch, which closes the file, deletes a partial download and frees the session.
function fmWait(item, setup) {
  return new Promise((resolve, reject) => {
    item._wake = (err) => reject(err || new Error("canceled"));
    setup(resolve);
  }).finally(() => { item._wake = null; });
}

function fmUpload(item, sess) {
  return new Promise(async (resolve, reject) => {
    sess.activeSend = { id: item.id, canceled: false, paused: false, mgr: true };
    let readId;
    try {
      const ackP = fmWait(item, (r) => { sess.activeSend.onAck = r; });
      // rk: a receiver that kept part of this very file (dropped connection) answers how much it has ("have")
      sess.fileChannel.send(JSON.stringify({ t: "m-put", id: item.id, name: item.name, size: item.size, destDir: item.destDir, replace: item.replace === true, rk: fmRk(item) }));
      const ack = await ackP;
      if (!ack.ok) throw new Error(ack.err === "busy" ? tr("Sibuk") : (ack.err || tr("ditolak")));
      const off = fmOff(ack.have, item.size);   // an older TryDesk sends no "have": the whole file, as before
      readId = await window.electronAPI.fileOpenRead(item.srcPath, off);
      let sent = off;
      item.sent = off; item._lastTs = null;
      if (off) fmProgress(item, off);
      const send = sess.activeSend;   // kept: an "m-cancel" from the receiver may clear sess.activeSend meanwhile
      const doneP = new Promise((r) => { send.onDone = r; });
      const pace = filePacer(sess.fileChannel);
      while (true) {
        if (item.canceled || send.canceled) throw new Error("canceled");
        while (item.paused && !item.canceled) await sleep(120);
        const { done, chunk } = await window.electronAPI.fileReadChunk(readId, CHUNK);
        if (done) break;
        await pace(chunk);
        sent += chunk.byteLength || chunk.length;
        fmProgress(item, sent);
      }
      await window.electronAPI.fileCloseRead(readId); readId = null;
      sess.fileChannel.send(JSON.stringify({ t: "m-done", id: item.id }));
      const fin = await fmWait(item, (r) => doneP.then(r));
      if (fin && fin.ok === false) throw new Error(fin.err === "inuse" ? "inuse" : tr("gagal"));   // short file discarded, or "Ganti" over a file in use
      if (sess.activeSend === send) sess.activeSend = null;
      resolve();
    } catch (e) {
      if (readId) { try { await window.electronAPI.fileCloseRead(readId); } catch {} }
      try { sess.fileChannel.send(JSON.stringify({ t: "m-cancel", id: item.id })); } catch {}
      if (sess.activeSend && sess.activeSend.id === item.id) sess.activeSend = null;
      reject(e);
    }
  });
}

function fmDownload(item, sess) {
  return new Promise(async (resolve, reject) => {
    try {
      // The size from the host's listing caps what we write (disk-fill guard); without one, don't download.
      if (_safeSize(item.size) === null) throw new Error(tr("ukuran file tidak diketahui"));
      // Part of this file kept from a dropped connection: ask the host for the rest only ("off").
      const rk = fmRk(item);
      let have = 0; try { have = fmOff(await window.electronAPI.fileResumeHave(rk), item.size); } catch {}
      const gotP = fmWait(item, (r) => { sess.mgrGetAck = { id: item.id, resolve: r }; });
      sess.fileChannel.send(JSON.stringify({ t: "m-get", id: item.id, remotePath: item.srcPath, name: item.name, size: item.size, off: have || undefined }));
      const got = await gotP; sess.mgrGetAck = null;
      if (!got.ok) throw new Error(got.err === "busy" ? tr("Sibuk") : (got.err || tr("gagal")));
      // an older host (or the Windows service) answers without "off": it sends from the start, so we write from the start
      const off = have && got.off === have ? have : 0;
      const w = await window.electronAPI.fileOpenWriteIn(item.destDir, safeFileName(item.name), item.replace === true, rk, off);
      const { id: writeId, path: filePath } = w;
      if ((w.have || 0) !== off) { await window.electronAPI.fileCloseWrite(writeId, true); throw new Error(tr("gagal")); }   // the kept part vanished meanwhile: the retry starts over
      item.sent = off; item._lastTs = null;
      if (off) fmProgress(item, off);
      const doneP = fmWait(item, (r) => { item._dlDone = r; });
      sess.activeRecv = {
        id: item.id, size: _safeSize(item.size), received: off, taken: off, writeId, filePath, mgr: true, item, rk,
        onDone: () => item._dlDone && item._dlDone(),
        card: { progress: (done) => fmProgress(item, done), setSub() {}, finish() {}, remove() {} },
      };
      if (item.paused) { try { sess.fileChannel.send(JSON.stringify({ t: "m-pause", id: item.id, paused: true })); } catch {} }
      sess.fileChannel.send(JSON.stringify({ t: "m-ready", id: item.id }));
      await doneP;
      resolve();
    } catch (e) {
      if (sess.activeRecv && sess.activeRecv.id === item.id) { const rec = sess.activeRecv; sess.activeRecv = null; await discardRecv(rec); }
      try { sess.fileChannel.send(JSON.stringify({ t: "m-cancel", id: item.id })); } catch {}
      sess.mgrGetAck = null;
      reject(e);
    }
  });
}

function fmRefreshSide(side) {
  const st = fmSt(side);
  if (st.path != null && !st.isRoot) fmLoad(side, st.path, { keepSel: true });
}

// ── Drag and drop ──────────────────────────────────────────
// Between the panes: rows are dragged to the other pane (its open folder, or the folder row under the pointer).
// From Windows Explorer: onto the other PC's pane only. Dropping on the pane something came from does nothing.
const FM_DND = "application/x-trydesk-fm";
let fmDrag = null;
function fmDropTarget(side, e) {
  const types = [...((e.dataTransfer && e.dataTransfer.types) || [])];
  const internal = types.includes(FM_DND);
  if (internal ? !fmDrag || fmDrag.side === side : !(types.includes("Files") && side === "remote")) return null;
  const st = fmSt(side);
  const row = e.target.closest && e.target.closest(".fmx-row.dir[data-path]");
  if (row && !(internal && fmSt(fmDrag.side).sel.has(row.dataset.path))) return { side, dest: row.dataset.path, row, internal };
  if (st.svc && !internal) return { side, dest: null, internal };
  if (!st.path || st.isRoot) return null;
  return { side, dest: st.path, internal };
}
function fmClearDrop() {
  $$("#fmx .fmx-pane.drop-on").forEach((p) => p.classList.remove("drop-on"));
  $$("#fmx .fmx-row.hot").forEach((r) => r.classList.remove("hot"));
  $$("#fmx .fmx-hint").forEach((h) => h.remove());
}
function fmShowDrop(t) {
  const pane = fmPane(t.side);
  $$("#fmx .fmx-row.hot").forEach((r) => { if (r !== t.row) r.classList.remove("hot"); });
  if (t.row) t.row.classList.add("hot");
  pane.classList.add("drop-on");
  let h = pane.querySelector(".fmx-hint");
  if (!h) { h = document.createElement("div"); h.className = "fmx-hint"; h.innerHTML = `${FM_IC.down}<span></span>`; pane.append(h); }
  const where = t.dest || tr("Unduhan\\TryDesk");
  const txt = t.row ? fmL(`Lepas ke folder ${fmBase(t.dest)}`, `Drop into the ${fmBase(t.dest)} folder`)
    : t.side === "remote" ? fmL(`Lepas untuk mengirim ke ${where}`, `Drop to send to ${where}`) : fmL(`Lepas untuk mengunduh ke ${where}`, `Drop to download to ${where}`);
  if (h.dataset.t !== txt) { h.dataset.t = txt; h.querySelector("span").textContent = txt; }
}
// Box selection, as in Windows File Explorer (owner 16 Nov: "bisa memilih setiap file melalui klik kanan tahan").
// Hold the left or right button anywhere in the list except on a file's icon or name (those still drag the file
// to the other pane) and drag: a box appears and every row it touches is picked. Ctrl keeps what was already
// picked. Near the top or bottom edge the list scrolls by itself. A box drawn with the right button opens no menu.
const fmBoxJust = { local: false, remote: false };   // a box just ended: its own click / menu event is not a click
function fmBoxInit(side) {
  const list = $(`#fm-${side}-list`);
  let b = null;
  const contentPt = (cx, cy) => { const r = list.getBoundingClientRect(); return { x: cx - r.left + list.scrollLeft, y: cy - r.top + list.scrollTop }; };
  const paint = () => {
    const p = contentPt(b.cx, b.cy);
    const x = Math.max(0, Math.min(b.x0, p.x)), y = Math.max(0, Math.min(b.y0, p.y));
    const w = Math.min(list.scrollWidth, Math.max(b.x0, p.x)) - x, h = Math.min(list.scrollHeight, Math.max(b.y0, p.y)) - y;
    Object.assign(b.el.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
    // rows the box touches (top to bottom; the rows span the list's width, so height decides)
    const st = fmSt(side), lr = list.getBoundingClientRect(), hit = [];
    for (const row of list.querySelectorAll(".fmx-row[data-path]")) {
      const rr = row.getBoundingClientRect(), top = rr.top - lr.top + list.scrollTop;
      if (top < y + h && top + rr.height > y) hit.push(row.dataset.path);
    }
    const next = new Set(b.add ? b.base : []); hit.forEach((p) => next.add(p));
    if (next.size !== st.sel.size || [...next].some((p) => !st.sel.has(p))) { st.sel = next; if (hit.length) st.anchor = hit[0]; fmApplySel(side); }
  };
  const tick = () => {
    if (!b || !b.moved) return;
    const r = list.getBoundingClientRect(), edge = 28;
    const dy = b.cy < r.top + edge ? -Math.ceil((r.top + edge - b.cy) / 3) : b.cy > r.bottom - edge ? Math.ceil((b.cy - (r.bottom - edge)) / 3) : 0;
    if (dy) { list.scrollTop += dy; paint(); }
    b.raf = requestAnimationFrame(tick);
  };
  const move = (e) => {
    if (!b || e.pointerId !== b.pid) return;
    b.cx = e.clientX; b.cy = e.clientY;
    if (!b.moved) {
      if (Math.hypot(e.clientX - b.sx, e.clientY - b.sy) < 5) return;
      b.moved = true;
      if (fmCtx) fmCtxClose();
      fmClearOther(side);
      b.el = document.createElement("div"); b.el.className = "fmx-band"; list.append(b.el);
      try { list.setPointerCapture(e.pointerId); } catch {}
      b.raf = requestAnimationFrame(tick);
    }
    paint();
  };
  const end = (e) => {
    if (!b || (e && e.pointerId !== b.pid)) return;
    cancelAnimationFrame(b.raf);
    if (b.el) b.el.remove();
    if (b.row) b.row.draggable = true;
    if (b.moved) fmBoxJust[side] = true;
    try { list.releasePointerCapture(b.pid); } catch {}
    b = null;
  };
  list.addEventListener("pointerdown", (e) => {
    fmBoxJust[side] = false;   // a new press: whatever comes now is a real click
    if (!fmSess || (e.button !== 0 && e.button !== 2) || fmRenaming[side] || e.pointerType === "touch") return;
    if (e.target.closest(".fmx-n svg, .fmx-n > span, .fmx-ck, input, .fmx-band")) return;   // a file's icon / name: dragging it sends the file
    const lr = list.getBoundingClientRect();
    if (e.clientX >= lr.left + list.clientWidth) return;   // the scroll bar
    const row = e.target.closest(".fmx-row[data-path]");
    if (row) row.draggable = false;   // from here the row is not dragged as a file
    const p = contentPt(e.clientX, e.clientY);
    b = { x0: p.x, y0: p.y, sx: e.clientX, sy: e.clientY, cx: e.clientX, cy: e.clientY, pid: e.pointerId, add: e.ctrlKey || e.metaKey, base: new Set(fmSt(side).sel), moved: false, row };
    list.focus({ preventScroll: true });
  });
  list.addEventListener("pointermove", move);
  list.addEventListener("pointerup", end);
  list.addEventListener("pointercancel", end);
  list.addEventListener("lostpointercapture", (e) => { if (b && b.moved) end(e); });
  // the click / menu that ends a box is not a click on a row
  const swallow = (e) => { if ((b && b.moved) || fmBoxJust[side]) { fmBoxJust[side] = false; e.stopImmediatePropagation(); e.preventDefault(); } };
  list.addEventListener("click", swallow, true);
  list.addEventListener("contextmenu", swallow, true);
}
function fmDndInit(side) {
  const pane = fmPane(side), list = $(`#fm-${side}-list`);
  list.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".fmx-row[data-path]"); if (!row || !fmSess) return;
    const st = fmSt(side);
    fmClearOther(side);
    if (!st.sel.has(row.dataset.path)) { st.sel.clear(); st.sel.add(row.dataset.path); st.anchor = row.dataset.path; fmApplySel(side); }
    const picked = st.entries.filter((x) => st.sel.has(x.path));
    fmDrag = { side };
    e.dataTransfer.setData(FM_DND, side); e.dataTransfer.effectAllowed = "copy";
    $("#fm-ghost-n").textContent = String(picked.length);
    $("#fm-ghost-name").textContent = picked[0] ? picked[0].name : "";
    const bytes = picked.reduce((a, x) => a + (x.isDir ? 0 : x.size || 0), 0);
    $("#fm-ghost-sub").textContent = [picked.length > 1 ? fmL(`dan ${picked.length - 1} lainnya`, `and ${picked.length - 1} more`) : "", bytes ? fmSize(bytes) : ""].filter(Boolean).join(" · ");
    try { e.dataTransfer.setDragImage($("#fm-ghost"), 22, 22); } catch {}
    const drag = fmDrag;
    requestAnimationFrame(() => { if (fmDrag === drag) $$(`#fm-${side}-list .fmx-row.on`).forEach((r) => r.classList.add("lifted")); });
  });
  list.addEventListener("dragend", () => { fmDrag = null; fmClearDrop(); $$("#fmx .fmx-row.lifted").forEach((r) => r.classList.remove("lifted")); });
  pane.addEventListener("dragover", (e) => {
    e.preventDefault(); e.stopPropagation();
    const t = fmSess && fmDropTarget(side, e);
    if (!t) { if (e.dataTransfer) e.dataTransfer.dropEffect = "none"; fmClearDrop(); return; }
    e.dataTransfer.dropEffect = "copy";
    fmShowDrop(t);
  });
  pane.addEventListener("dragleave", (e) => { if (!pane.contains(e.relatedTarget)) fmClearDrop(); });
  pane.addEventListener("drop", async (e) => {
    e.preventDefault(); e.stopPropagation();
    const t = fmSess && fmDropTarget(side, e);
    fmClearDrop();
    if (!t) return;
    if (t.internal) { const from = fmDrag && fmDrag.side; fmDrag = null; if (from) fmEnqueue(from === "local" ? "up" : "down", { destDir: t.dest }); return; }
    // From Windows Explorer: the dropped files and folders (their paths come only from real dropped File objects).
    const paths = window.electronAPI.droppedPaths ? window.electronAPI.droppedPaths([...e.dataTransfer.files]) : [];
    if (!paths.length) return showToast(fmL("Hanya file dan folder yang ada di disk yang bisa dikirim", "Only files and folders on a disk can be sent"));
    const items = [];
    for (const p of paths.slice(0, 200)) {
      const parent = p.replace(/[\\/][^\\/]+[\\/]?$/, "") || p, name = fmBase(p);
      const r = await window.electronAPI.fsOp({ op: "exists", path: /^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent, names: [name] }).catch(() => null);
      const f = r && r.found && r.found[0];
      if (f) items.push({ path: p, name, isDir: f.isDir, size: f.size, mtime: f.mtime });
    }
    if (!items.length) return;
    fmEnqueue("up", { destDir: t.dest, items });
  });
}

// ── Open / close ───────────────────────────────────────────
function openFileManager() {
  const sess = curChatSess();
  if (!sess || !sess.fileChannel || sess.fileChannel.readyState !== "open") { showToast(tr("Transfer file butuh sesi aktif")); return; }
  fmSess = sess;
  for (const s of ["local", "remote"]) { const st = sess.fm[s]; st.hist = st.hist || []; st.filter = ""; const q = $(`#fm-${s}-q`); if (q) q.value = ""; $(`#fm-${s}-srch`)?.classList.remove("open"); }
  try { releaseHeldInput && releaseHeldInput(); } catch {}   // nothing stays pressed on the other PC while this is open
  closeAllMenus();
  fmOpen = true;
  refreshKeyCapture();   // the keyboard is File Transfer's while it is open (Ctrl+click, Delete, F2, Esc)
  // Under whichever top bar is showing (the title bar, or the session bar with the tabs and window buttons), so the
  // window can still be minimised or closed and the session stays in view, as in the concept.
  const ov = $("#overlay-files");
  const bar = ["#session-bar", "#titlebar"].map((s) => $(s)).find((el) => el && el.offsetParent !== null && el.getBoundingClientRect().height > 0);
  ov.style.top = bar ? `${Math.round(bar.getBoundingClientRect().bottom)}px` : "0px";
  ov.classList.remove("hidden");
  $("#fm-drawer").classList.add("hidden"); $("#fm-scrim").classList.add("hidden"); $("#fm-drive-menu").classList.add("hidden");
  for (const s of ["local", "remote"]) {
    const st = sess.fm[s];
    fmPaintCard(s);
    if (st.path) fmLoad(s, st.path, { keepSel: true }); else fmLoad(s, null, { home: true });
  }
  fmPaint();
}

function closeFileManager() {
  fmCtxClose();
  fmOpen = false;
  if (fmDupOpen) fmDupOpen();
  $("#overlay-files").classList.add("hidden");
  refreshKeyCapture();   // back to the remote screen: its keys go to the other PC again
}

// Reset one session's file-manager state; close the overlay if it's the one being shown.
function fmResetAll(sess) {
  if (!sess) return;
  sess.fmQueue.length = 0;
  if (sess.fmJobs) sess.fmJobs.length = 0;
  sess.fmRunning = false; sess.fmPaused = false;
  if (sess.fmMade) sess.fmMade.clear();
  sess.fm.local.sel.clear(); sess.fm.remote.sel.clear();
  if (fmSess === sess && fmOpen) { closeFileManager(); fmSess = null; }
}

function fmToggleDrawer(open) {
  const d = $("#fm-drawer"), s = $("#fm-scrim");
  const on = open == null ? d.classList.contains("hidden") : open;
  d.classList.toggle("hidden", !on); s.classList.toggle("hidden", !on);
  if (on) { $("#fm-drawer h3").innerHTML = fmL("Antrean <em>transfer.</em>", "Transfer <em>queue.</em>"); fmPaintDrawer(); try { $("#fm-drawer-close").focus({ focusVisible: false }); } catch {} }
}

function fmInit() {
  fmBuildPane("local"); fmBuildPane("remote");
  try { new ResizeObserver(() => { if (fmOpen && fmSess) { fmFitPath("local"); fmFitPath("remote"); } }).observe($("#fmx")); } catch {}
  $("#fm-close").addEventListener("click", closeFileManager);
  $("#fm-send-btn").addEventListener("click", () => fmEnqueue("up"));
  $("#fm-recv-btn").addEventListener("click", () => fmEnqueue("down"));
  $("#fm-pause-all").addEventListener("click", fmPauseAll);
  $("#fm-pause-all2").addEventListener("click", fmPauseAll);
  $("#fm-queue-btn").addEventListener("click", () => fmToggleDrawer());
  $("#fm-drawer-close").addEventListener("click", () => fmToggleDrawer(false));
  $("#fm-scrim").addEventListener("click", () => fmToggleDrawer(false));
  $("#fm-queue-clear").addEventListener("click", () => {
    if (!fmSess || !fmSess.fmJobs) return;
    for (const j of fmSess.fmJobs) if (j.status === "done" || j.status === "error" || j.status === "canceled") j.status = "removed";
    fmSess.fmQueue = fmSess.fmQueue.filter((i) => i.status === "queued" || i.status === "active");
    fmPaint(); fmPaintDrawer();
  });
  document.addEventListener("pointerdown", (e) => { if (fmCtx && !(e.target.closest && e.target.closest(".fmx-ctx"))) fmCtxClose(); }, true);
  window.addEventListener("blur", () => fmCtxClose());
  window.addEventListener("resize", () => fmCtxClose());
  document.addEventListener("click", (e) => {
    const m = $("#fm-drive-menu");
    if (!m.classList.contains("hidden") && !e.target.closest("#fm-drive-menu") && !e.target.closest(".fmx-chip")) m.classList.add("hidden");
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!fmOpen || e.defaultPrevented) return;
    if (fmCtx && fmCtxKey(e)) return;
    if (e.key !== "Escape") return;
    if (e.target.closest && e.target.closest(".fmx-ren, .fmx-pathin")) return;
    if (e.target.matches && e.target.matches(".fmx-srch input") && e.target.value) return;
    if (document.querySelector(".overlay.app-confirm")) return;
    e.stopPropagation();
    if (fmDupOpen) return fmDupOpen();
    if (!$("#fm-drive-menu").classList.contains("hidden")) return $("#fm-drive-menu").classList.add("hidden");
    if (!$("#fm-drawer").classList.contains("hidden")) return fmToggleDrawer(false);
    const busy = ["local", "remote"].find((s) => fmSess && fmSt(s).sel.size);
    if (busy) { fmSt(busy).sel.clear(); return fmApplySel(busy); }
    closeFileManager();
  }, true);
  for (const side of ["local", "remote"]) {
    const P = `#fm-${side}`, list = $(`${P}-list`);
    $(`${P}-back`).addEventListener("click", () => { if (!fmSess) return; const st = fmSt(side); const p = st.hist.pop(); if (p !== undefined) fmLoad(side, p || null, { back: true }); });
    $(`${P}-refresh`).addEventListener("click", () => { if (fmSess) fmLoad(side, fmSt(side).path, { keepSel: true }); });
    $(`${P}-new`).addEventListener("click", () => fmSess && fmNewFolder(side));
    $(`${P}-ren`).addEventListener("click", () => fmSess && fmStartRename(side));
    $(`${P}-del`).addEventListener("click", () => fmSess && fmDelete(side));
    $(`${P}-drive`).addEventListener("click", () => fmSess && fmDriveMenu(side));
    // Path box: a folder name goes there; anywhere else turns the box into a field (Enter opens, Esc gives up).
    $(`${P}-pbox`).addEventListener("click", (e) => {
      if (!fmSess) return;
      const go = e.target.closest("[data-go]");
      if (go) return fmLoad(side, go.dataset.go);
      const box = $(`${P}-pbox`), st = fmSt(side);
      if (box.classList.contains("editing") || st.svc) return;
      box.classList.add("editing");
      const segs = $(`${P}-segs`); segs.style.display = "none";
      const inp = document.createElement("input"); inp.className = "fmx-pathin"; inp.value = st.isRoot ? "" : (st.path || ""); inp.spellcheck = false;
      box.append(inp); inp.focus(); inp.select();
      let done = false;
      const end = (go2) => { if (done) return; done = true; inp.remove(); segs.style.display = ""; box.classList.remove("editing"); fmFitPath(side); if (go2 != null) fmLoad(side, go2 || null); };
      inp.addEventListener("keydown", (k) => { k.stopPropagation(); if (k.key === "Enter") end(inp.value.trim()); else if (k.key === "Escape") end(null); });
      inp.addEventListener("blur", () => end(null));
    });
    // Search: filters the open folder as you type. In a narrow pane it starts as a magnifier button.
    const srch = $(`${P}-srch`), q = $(`${P}-q`);
    srch.addEventListener("click", () => { srch.classList.add("open"); q.focus(); });
    q.addEventListener("input", () => { if (!fmSess) return; fmSt(side).filter = q.value.trim(); fmRenderPane(side); });
    q.addEventListener("keydown", (e) => { if (e.key === "Escape" && q.value) { e.stopPropagation(); q.value = ""; fmSt(side).filter = ""; fmRenderPane(side); } });
    q.addEventListener("blur", () => { if (!q.value) srch.classList.remove("open"); });
    $(`${P}-all`).addEventListener("click", () => {
      if (!fmSess) return; const st = fmSt(side);
      if (st.sel.size >= (st.shown || []).length) st.sel.clear(); else { fmClearOther(side); (st.shown || []).forEach((p) => st.sel.add(p)); }
      fmApplySel(side);
    });
    $$(`${P}-head .fmx-col`).forEach((c) => c.addEventListener("click", () => {
      if (!fmSess) return; const st = fmSt(side);
      if (st.sort.key === c.dataset.key) st.sort.asc = !st.sort.asc; else { st.sort.key = c.dataset.key; st.sort.asc = true; }
      fmRenderPane(side);
    }));
    list.addEventListener("click", (e) => {
      if (!fmSess) return;
      const row = e.target.closest(".fmx-row[data-path]");
      if (!row) { const st = fmSt(side); if (st.sel.size) { st.sel.clear(); fmApplySel(side); } return; }
      fmSelectClick(side, row, e);
    });
    list.addEventListener("contextmenu", (e) => fmCtxFromEvent(side, e));
    list.addEventListener("scroll", () => { if (fmCtx) fmCtxClose(); }, { passive: true });
    list.addEventListener("dblclick", (e) => {
      const row = e.target.closest(".fmx-row.dir[data-path]");
      if (row && fmSess && !e.target.closest(".fmx-ck")) fmLoad(side, row.dataset.path);
    });
    list.addEventListener("keydown", (e) => {
      if (!fmSess || e.target !== list) return;
      const st = fmSt(side);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); fmClearOther(side); (st.shown || []).forEach((p) => st.sel.add(p)); fmApplySel(side); }
      else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); fmCtxFromKey(side); }
      else if (e.key === "F5") { e.preventDefault(); fmLoad(side, st.path, { keepSel: true }); }
      else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); if (!st.svc && st.path && !st.isRoot) fmNewFolder(side); }
      else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "c") { e.preventDefault(); fmCopyPaths(side); }
      else if (e.key === "Delete" && st.sel.size) { e.preventDefault(); fmDelete(side); }
      else if (e.key === "F2" && st.sel.size === 1) { e.preventDefault(); fmStartRename(side); }
      else if (e.key === "Enter" && st.sel.size === 1) { const p = [...st.sel][0], en = st.entries.find((x) => x.path === p); if (en && en.isDir) { e.preventDefault(); fmLoad(side, p); } }
      else if (e.key === "Backspace" || (e.altKey && e.key === "ArrowLeft")) { e.preventDefault(); $(`${P}-back`).click(); }
    });
    fmDndInit(side);
    fmBoxInit(side);
  }
}

// ─── Quality control (viewer) ─────────────────────────────
// Quality is edited for the active tab (or the default template on the home screen).
function qualityOf() { return active ? active.quality : defaultQuality; }
// A tab opened by Kelola banyak perangkat that isn't in front only feeds its picture on the page (redrawn once a
// second): it asks its PC for a light picture, and for its full quality again once it is in front (audit 19 Nov: N
// background PCs at 80 Mbps / 60 fps split the link and the decoder with the one being worked on).
const KM_PREVIEW_Q = { bitrate: 1, fps: 2, resHeight: 360 };
const kmBackground = (sess) => !!sess && !!sess.bulk && sess !== active;
function sendQuality(sess) {
  if (sess && sess.dataChannel && sess.dataChannel.readyState === "open") {
    const q = kmBackground(sess) ? KM_PREVIEW_Q : sess.quality;
    // A phone or tablet asks for at most 60 fps and a 1080-line picture: a 1440p / 4K host at 120-240 fps only loads
    // its decoder (often into software decoding) and its Wi-Fi, and a 60 Hz screen shows no more (user report 19 Nov:
    // "pake trydesk di tab nyambung ke pc, tampilannya lag lag").
    const mob = !!window.TD_MOBILE;
    const fps = mob ? Math.min(60, q.fps) : q.fps;
    const resHeight = mob && !(q.resHeight > 0 && q.resHeight <= 1080) ? 1080 : q.resHeight;
    sess.dataChannel.send(JSON.stringify({ __ctrl: "quality", bitrate: q.bitrate, fps, resHeight }));
  }
}

function syncQualityUI() {
  const q = qualityOf();
  $("#bitrate-slider").value = q.bitrate; paintSlider($("#bitrate-slider"));
  $("#bitrate-number").value = Math.min(q.bitrate, BITRATE_MAX_MBPS);   // an older saved 500 shows as the real ceiling
  $$("#fps-row .chip").forEach((c) => c.classList.toggle("active", +c.dataset.fps === q.fps));
  $$("#res-row .chip").forEach((c) => c.classList.toggle("active", +c.dataset.scale === q.resHeight));
  $("#codec-select").value = q.codec;
  const match = Object.entries(PRESETS).find(([, p]) => p.bitrate === q.bitrate && p.fps === q.fps && p.resHeight === q.resHeight);
  $$(".preset-btn").forEach((b) => b.classList.toggle("active", match && b.dataset.preset === match[0]));
}

function saveQuality() { store.set("quality", JSON.stringify(defaultQuality)); }

function setQuality(patch, { reconnectCodec = false } = {}) {
  const q = qualityOf();
  Object.assign(q, patch);
  Object.assign(defaultQuality, q);   // remember as the default for the next tab
  saveQuality();
  syncQualityUI();
  if (active) sendQuality(active);
  if (reconnectCodec && active && active.pc && active.role === "viewer") viewerCodecChanged(active);
}
// The codec choice changed during a session. The fast path (LAN) carries H.264 or H.265: one running in another codec
// stops (WebRTC shows the picture for that moment) and starts again in the new one; VP8 / VP9 / AV1 stay on WebRTC.
// WebRTC's own codec is changed while its video is paused under a running fast path, so its freeze and keyframe after
// a renegotiation never reach the screen; without a fast path it changes at once.
async function viewerCodecChanged(sess) {
  const want = sess.hostHasFast && fastEnabled() ? await fastWantCodec(sess) : null;
  if (sessions.get(sess.peerId) !== sess || !sess.pc) return;
  const f = sess.fast;
  let reopen = false;
  if (f && f.want !== want) { viewerFastStop(sess, "codec change", true); reopen = !!want; }
  else if (!f && want) reopen = true;
  else if (f && !f.on) { sess._codecRenegPending = true; return; }   // starting: changed once its first frame is in
  if (reopen) {
    sess._codecRenegPending = true;
    await viewerFastOpen(sess);
    if (sess.fast || !sess._codecRenegPending) return;   // opening: changed on its first frame (or when it stops)
    sess._codecRenegPending = false;                      // not opened now (link not clean): WebRTC changes at once
  }
  applyCodecPreference(sess); negotiate(sess).catch(() => {});
}

// ─── Stats (viewer, per session) ──────────────────────────
function startStats(sess) {
  stopStats(sess);
  sess.statsLast = { bytes: 0, ts: 0 };
  sess.statsTimer = setInterval(() => pollStats(sess).then(() => { if (sess === active) ccSyncStats(); }), 1000);
}
// Session bar latency, design direction A: the number large, the unit small (red in CSS), as in the portfolio
// video. The text stays "28 ms" (the phone toolbar mirrors this badge's textContent).
function setLatBadge(sess) {
  const b = $("#rt-latency-badge"); if (!b) return;
  const m = /^(\d+)/.exec(sess.latencyText || "");
  b.className = `sb-badge sb-lat ${sess.latencyClass || ""}`;
  b.innerHTML = `<b>${m ? m[1] : "-"}</b> <small>ms</small>`;
  const d = $("#fsd-lat"); if (d && sess === active) d.innerHTML = b.innerHTML;   // the full-screen dock shows it too
}
function stopStats(sess) { if (sess && sess.statsTimer) { clearInterval(sess.statsTimer); sess.statsTimer = null; } }

async function pollStats(sess) {
  if (!sess.pc) return;
  const show = sess === active;      // only the active tab writes to the shared stats widgets
  let inbound, pair, codecMime;
  const stats = await sess.pc.getStats();
  let selectedPairId;
  stats.forEach((s) => { if (s.type === "transport" && s.selectedCandidatePairId) selectedPairId = s.selectedCandidatePairId; });
  const mainMid = sess.videoTransceiver && sess.videoTransceiver.mid;   // "Semua monitor": the others have their own
  stats.forEach((s) => {
    if (s.type === "inbound-rtp" && s.kind === "video" && (!mainMid || s.mid == null || s.mid === mainMid)) { if (!inbound || s.mid === mainMid) inbound = s; }
    if (s.type === "candidate-pair" && (s.id === selectedPairId || (!pair && s.nominated && s.state === "succeeded"))) pair = s;
  });
  if (inbound) {
    const now = performance.now();
    if (sess.statsLast.ts && show) {
      const dt = (now - sess.statsLast.ts) / 1000;
      const mbps = ((inbound.bytesReceived - sess.statsLast.bytes) * 8) / dt / 1_000_000;
      $("#stat-bitrate").textContent = `${mbps.toFixed(1)} Mbps`;
    }
    sess.statsLast = { bytes: inbound.bytesReceived, ts: now };
    if (show) {
      $("#stat-fps").textContent = inbound.framesPerSecond != null ? `${Math.round(inbound.framesPerSecond)}` : "-";
      const total = (inbound.packetsReceived || 0) + (inbound.packetsLost || 0);
      $("#stat-loss").textContent = total ? `${((inbound.packetsLost || 0) / total * 100).toFixed(1)}%` : "0%";
    }
    if (inbound.codecId) { const c = stats.get(inbound.codecId); if (c) codecMime = c.mimeType.replace("video/", ""); }
  }
  h265Watch(sess, inbound, codecMime);
  // Adaptive low-latency receive buffer: size it to the measured jitter instead of a fixed value.
  // Clean LAN (jitter ~0) → ~6ms (feels instant); jittery/distant link → grows up to ~160ms to stay smooth.
  if (sess.videoReceiver) {
    // Smooth the measurement (EMA) and only retune when it moves meaningfully, constantly resizing the
    // jitter buffer each tick caused its own playout stutter that read as flicker.
    const jitterMs = inbound && inbound.jitter != null ? inbound.jitter * 1000 : 0;
    sess._jitterAvg = sess._jitterAvg == null ? jitterMs : sess._jitterAvg * 0.8 + jitterMs * 0.2;
    // Sized from the network jitter only. The old floor of ~2.5 frames at the MEASURED fps was the main mouse
    // lag: an ordinary desktop is mostly still (≈10 fps sent), so the buffer grew to 110–170 ms on a clean link
    // (measured 130 ms at RTT 0). WebRTC's own jitter buffer still holds what bursty delivery needs on top.
    // A bad link (flagged last tick) may go deeper to stay smooth; a clean one stays at ~10–20 ms.
    // 17 Nov: a clean link gets 0. On the desktop apps main.js forces WebRTC's playout delay to 0-1 ms (every frame shown
    // the moment it is decoded; its own estimate grew to 30-45 ms after each codec change or hiccup), so there this
    // target no longer matters. The Android viewer has no such switch: there a link flagged bad or with a jitter over
    // 15 ms (off again under 8) still gets a buffer to stay smooth.
    const smooth = !!sess._netDegradedV || sess._jitterAvg > (sess._jbSmooth ? 8 : 15);
    sess._jbSmooth = smooth;
    // (phone / tablet: half of that, so smoothing never shows as lag; user report 19 Nov "di tab lag lag")
    const jbCap = window.TD_MOBILE ? (sess._netDegradedV ? 120 : 60) : (sess._netDegradedV ? 250 : 120);
    const target = smooth ? Math.max(12, Math.min(jbCap, Math.round(sess._jitterAvg * 2) + 10)) : 0;
    if (sess._jbTarget == null || (target === 0) !== (sess._jbTarget === 0) || Math.abs(target - sess._jbTarget) >= 10) {
      sess._jbTarget = target;
      try { sess.videoReceiver.jitterBufferTarget = target; } catch {}
      try { sess.videoReceiver.playoutDelayHint = target / 1000; } catch {}
    }
  }
  if (show) {
    const v = sess.video;
    $("#stat-res").textContent = (v && v.videoWidth) ? `${v.videoWidth}×${v.videoHeight}` : "-";
    $("#stat-codec").textContent = codecMime || "-";
  }
  // Fast path on: the picture comes from the fast channel, not the (paused) WebRTC video, show its numbers.
  const fst = sess.fast && sess.fast.on ? sess.fast.stats : null;
  if (fst) {
    const now = performance.now(), dt = fst.at ? (now - fst.at) / 1000 : 0;
    if (show && dt > 0) {
      $("#stat-fps").textContent = `${Math.round((fst.frames - fst.lastFrames) / dt)}`;
      $("#stat-bitrate").textContent = `${(((fst.bytes - fst.lastBytes) * 8) / dt / 1e6).toFixed(1)} Mbps`;
      $("#stat-codec").textContent = fastCodecName(sess.fast.codec) === "H.265" ? "H.265 · jalur cepat" : "H.264 · jalur cepat";
      $("#stat-loss").textContent = "-";
    }
    fst.at = now; fst.lastFrames = fst.frames; fst.lastBytes = fst.bytes;
  }
  if (pair) {
    const rtt = pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;
    sess.latencyText = rtt != null ? `${rtt} ms` : "- ms";
    sess.latencyClass = rtt == null ? "" : rtt < 60 ? "lat-good" : rtt < 160 ? "lat-ok" : "lat-bad";
    if (show) {
      $("#stat-latency").textContent = rtt != null ? `${rtt} ms` : "-";
      setLatBadge(sess);
      const local = stats.get(pair.localCandidateId);
      const type = local ? local.candidateType : "";
      $("#stat-route").textContent = type === "relay" ? "Relay (TURN)" : type === "host" ? "P2P lokal" : "P2P langsung";
    }
  }
  // Every 10 s while connected: one line in the log with what the stats panel shows (owner 19 Nov: "1.3.9 dan 1.4.0
  // sama sama ngelag ... jaringan saya atau server?" and the log said only "P2P connected"). So a lag report can be
  // read back: route, round trip, frames, data, loss, jitter, decoder, dropped frames and freezes.
  if (inbound && sess.role === "viewer") {
    const ff = sess.fast && sess.fast.stats ? sess.fast.stats : null;
    const now = Date.now(), base = { at: now, bytes: inbound.bytesReceived || 0, fd: inbound.framesDecoded || 0, recv: inbound.packetsReceived || 0, lost: inbound.packetsLost || 0, drop: inbound.framesDropped || 0, fz: inbound.freezeCount || 0, fzd: inbound.totalFreezesDuration || 0, ffr: ff ? ff.frames || 0 : 0, fby: ff ? ff.bytes || 0 : 0 };
    const h = sess._hlog || (sess._hlog = base);
    if (now - h.at >= 10000) {
      const dt = (now - h.at) / 1000;
      const local = pair && stats.get(pair.localCandidateId), remote = pair && stats.get(pair.remoteCandidateId);
      const dRecv = base.recv - h.recv, dLost = base.lost - h.lost;
      const fastOn = !!(sess.fast && sess.fast.on);
      // Above ~56 fps only the fast path goes (Chromium's capture gives ~56): say why it isn't running, and what was chosen.
      const want = sess.quality && sess.quality.fps ? `${sess.quality.fps} chosen` : "";
      const fps = fastOn && sess.fast.stats ? `${Math.max(0, Math.round((base.ffr - (h.ffr || 0)) / dt))} fps on the fast path at ${Math.max(0, (base.fby - (h.fby || 0)) * 8 / dt / 1e6).toFixed(1)} Mbps (${want || "?"})`
        : `${Math.round((base.fd - h.fd) / dt)} fps (${want ? want + ", " : ""}fast path ${sess.hostHasFast ? "offered but off" : "not offered by the other PC"})`;
      const rtt = pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : "?";
      const v = sess.video;
      sessLog(sess, `health: route ${local ? local.candidateType : "?"}/${remote ? remote.candidateType : "?"}${local && local.protocol ? " " + local.protocol : ""}, rtt ${rtt} ms, ${fps}, ${((base.bytes - h.bytes) * 8 / dt / 1e6).toFixed(1)} Mbps, loss ${(dRecv + dLost) > 0 ? (dLost / (dRecv + dLost) * 100).toFixed(1) : "0.0"}%, jitter ${inbound.jitter != null ? Math.round(inbound.jitter * 1000) : "?"} ms, ${v && v.videoWidth ? v.videoWidth + "x" + v.videoHeight : "?"} ${codecMime || "?"} (${inbound.decoderImplementation || "?"}), dropped ${base.drop - h.drop}, freezes ${base.fz - h.fz} (${(base.fzd - h.fzd).toFixed(1)} s)`);
      sess._hlog = base;
    }
  }
  // ─── Link health (viewer) ────────────
  // Per-tick packet loss + RTT, smoothed. A clearly bad link lets the receive buffer above grow deeper; the fast path
  // only starts on a clean one (fastLinkClean). Until 1.3.8 this also told the host to switch to "balanced", which cut
  // the picture to 960x540 (unreadable): the host's link control (startLinkControl) handles thin links now, so the
  // "net-mode" message is no longer sent (an older host would still act on it).
  if (inbound && sess.role === "viewer" && sess.dataChannel && sess.dataChannel.readyState === "open") {
    sess._statN = (sess._statN || 0) + 1;
    const recv = inbound.packetsReceived || 0, lost = inbound.packetsLost || 0;
    const dRecv = recv - (sess._lastRecv || 0), dLost = lost - (sess._lastLost || 0);
    sess._lastRecv = recv; sess._lastLost = lost;
    const lossPct = (dRecv + dLost) > 0 ? (dLost / (dRecv + dLost)) * 100 : 0;
    sess._lossAvg = sess._lossAvg == null ? lossPct : sess._lossAvg * 0.7 + lossPct * 0.3;
    const rttMs = pair && pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : 0;
    sess._rttAvg = sess._rttAvg == null ? rttMs : sess._rttAvg * 0.7 + rttMs * 0.3;
    const bad = sess._lossAvg > 4 || sess._rttAvg > 250;      // clearly bad link
    const good = sess._lossAvg < 1.2 && sess._rttAvg < 150;   // clearly good link
    const want = sess._netDegradedV ? !good : bad;            // sticky both ways → no flapping
    if (want !== !!sess._netDegradedV) { sess._netDegradedV = want; sessLog(sess, `link looks ${want ? "bad" : "good"} (loss ${sess._lossAvg.toFixed(1)} %, rtt ${Math.round(sess._rttAvg)} ms)`); }
  }
}

// ─── Input capture (viewer) ───────────────────────────────
function sendInput(ev) { sendInputTo(active, ev); }
// To one session (a monitor's own window sends to its session even when another tab is active).
function sendInputTo(sess, ev) {
  if (!sess || sess.viewOnly) return;
  if (sess.role === "viewer" && sess.dataChannel && sess.dataChannel.readyState === "open") sess.dataChannel.send(JSON.stringify(ev));
}
// Pointer position. With a 1.2.3+ host it goes on the unordered "move" channel at up to 125 Hz; otherwise (or
// when ordering matters, i.e. right before a click) on the ordered control channel at 60 Hz as before. The
// sequence number lets the host drop moves that arrive late (onHostMove).
const moveChannelOpen = (s) => !!(s && s.moveChannel && s.moveChannel.readyState === "open");
const moveIntervalMs = () => (moveChannelOpen(active) ? 8 : 16);
function sendMove(p, ordered = false) { sendMoveTo(active, p, ordered); }
function sendMoveTo(sess, p, ordered = false) {
  if (!sess || sess.viewOnly || sess.role !== "viewer") return;
  // The move channel backed up (a lossy uplink): moves queued and arrived late. Only the newest point matters, so it
  // waits a moment and goes alone (audit 19 Nov).
  if (!ordered && moveChannelOpen(sess) && sess.moveChannel.bufferedAmount > 2048) {
    sess._moveLate = p;
    if (!sess._moveLateT) sess._moveLateT = setTimeout(() => { sess._moveLateT = 0; const q = sess._moveLate; sess._moveLate = null; if (q && sessions.get(sess.peerId) === sess) sendMoveTo(sess, q); }, 30);
    return;
  }
  sess._moveSeqOut = (sess._moveSeqOut || 0) + 1;
  // "Semua monitor" / a monitor's own window: the monitor the point is on (a host before 1.4.0 ignores it)
  const msg = JSON.stringify(Number.isInteger(p.mon) ? { action: "mousemove", x: p.x, y: p.y, s: sess._moveSeqOut, mon: p.mon } : { action: "mousemove", x: p.x, y: p.y, s: sess._moveSeqOut });
  if (!ordered && moveChannelOpen(sess)) { try { sess.moveChannel.send(msg); return; } catch {} }
  if (sess.dataChannel && sess.dataChannel.readyState === "open") sess.dataChannel.send(msg);
}
function normalizedPoint(e) {
  // "Semua monitor": the picture under the mouse, and which monitor it is.
  const sess = active;
  if (sess && sess.monMode === "all" && sess._monCells) {
    for (const c of sess._monCells) {
      const p = pointInVideo(c.video, e);
      if (p) { p.mon = c.mon; if (sess._hoverMon !== c.mon) monMarkHover(sess, c.mon); return p; }
    }
    return null;
  }
  const video = activeVideo();
  if (!video) return null;
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.min(rect.width / vw, rect.height / vh);
  const w = vw * scale, h = vh * scale;
  const left = rect.left + (rect.width - w) / 2, top = rect.top + (rect.height - h) / 2;
  const x = (e.clientX - left) / w, y = (e.clientY - top) / h;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x, y };
}
const BUTTONS = ["left", "middle", "right"];
const remoteButtonsDown = new Set();   // buttons pressed on the remote screen and not yet released there
// Releases every key/button still held on the active remote (set up with the input listeners). switchTab calls it
// first: keyups go to the active tab, so a Ctrl held while switching tabs would otherwise stay down on the old PC.
let releaseHeldInput = () => {};
let panning = false, panStart = null;

// ── Game mode: pointer-lock + relative mouse (for Minecraft/FPS and any pointer-capturing game) ──
let gameMode = false, gameSens = 1, accDx = 0, accDy = 0, relTimer = null;
// Host px per displayed CSS px, so a relative move maps 1:1 to the remote screen.
function videoScale() {
  const video = activeVideo(); if (!video) return 1;
  const rect = video.getBoundingClientRect(); const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || !rect.width) return 1;
  // Capped at 1, as before "fit" stretched the picture to the window (1.3.9): a picture that is smaller than the
  // window (1080p host on a 4K viewer, or the link control lowering the size mid-game) must not slow the mouse down.
  return Math.max(0.0001, Math.min(1, rect.width / vw, rect.height / vh));
}
function flushRel() {
  relTimer = null; const dx = accDx, dy = accDy; accDx = accDy = 0;
  if (Math.round(dx) || Math.round(dy)) sendInput({ action: "mousemove-rel", dx, dy });
}
function toggleGameMode() {
  const sess = active;
  if (!sess || sess.role !== "viewer") return;
  if (sess.viewOnly) { showToast("Mode lihat saja aktif, matikan dulu untuk mode game"); return; }
  setGameCapture(!_gameActive);   // native capture (same path auto uses); reliable because the window is focused
}

// Write a line to the app's crash log (traces the game-mode chain for diagnosis).
const dlog = (m) => { try { window.electronAPI && window.electronAPI.logInfo && window.electronAPI.logInfo(m); } catch {} };
// Lock the pointer SYNCHRONOUSLY so the user's click still counts as the activation gesture.
// (A promise-based requestPointerLock({unadjustedMovement}) fallback ran in an async callback where
// the gesture is already gone, so Chromium refused the lock, that broke game capture. Keep it plain.)
function lockPointer(el) {
  try { el.requestPointerLock(); } catch (e) { try { showToast("Gagal mengunci mouse untuk game: " + e.message); } catch {} }
}

// Automatic game mode: the host tells us when a game/app captures its cursor; the viewer switches to
// NATIVE relative-mouse capture (main-process low-level hook) with NO user action, no toggle, no click, no
// pointer-lock gesture. The game gets true 360° mouse-look; Pause/Break releases it.
let _pendingGame = false;   // pointer-lock fallback is armed when native capture can't install
function setGameCapture(on) {
  if (on === _gameActive) return;
  _gameActive = on;
  const c = $("#remote-canvas-container");
  if (c) c.classList.toggle("game-mode", on);
  dlog("setGameCapture " + (on ? "ON" : "OFF"));
  try { window.electronAPI && window.electronAPI.setMouseCapture && window.electronAPI.setMouseCapture(on); } catch {}
  if (on) {
    // Force keyboard capture ON too, so the ESCAPE keys (Pause, Ctrl+Alt+Shift+Esc) are always caught, otherwise
    // the mouse could be locked to the remote with no way back.
    try { window.electronAPI && window.electronAPI.setKeyCapture && window.electronAPI.setKeyCapture(true); } catch {}
    showGameBanner(true);
  } else {
    _pendingGame = false;
    showGameBanner(false);
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch {}
  }
  // Every button that shows game mode follows the real state (owner, 6 Nov: it stayed "on" after game mode ended).
  try { ccRefresh(); } catch {}
  document.dispatchEvent(new CustomEvent("td-game-mode", { detail: on }));
}
// Persistent on-screen reminder of how to get the mouse/keyboard back while game mode holds them captive.
function showGameBanner(on) {
  let b = $("#game-banner");
  if (on) {
    if (!b) {
      b = document.createElement("div");
      b.id = "game-banner";
      // Mac and Linux lock the mouse with the browser's pointer lock, which Esc always releases (no Pause key there).
      b.textContent = viewerOnlyDesktop() ? "🎮 Mode game aktif, tekan Esc untuk lepas mouse" : "🎮 Mode game aktif, tekan Pause (atau Ctrl+Alt+Shift+Esc) untuk lepas kontrol";
      document.body.appendChild(b);
    }
    b.style.display = "";
  } else if (b) b.style.display = "none";
}
// Main reports whether the native mouse hook installed. If it couldn't, fall back to the proven
// pointer-lock path so game mouse still works (engages on the next click).
if (window.electronAPI && window.electronAPI.onMouseCaptureResult) {
  window.electronAPI.onMouseCaptureResult(({ want, ok }) => {
    dlog("mouse-capture-result want=" + want + " ok=" + ok);
    if (want && !ok && _gameActive) { _pendingGame = true; showToast("Mode game: klik layar untuk ambil kontrol mouse"); lockPointer($("#remote-canvas-container")); }
  });
}
function setAutoGame(sess, on) {
  // AUTO game-mouse DISABLED. The host "cursor hidden" signal false-positives during normal use (many
  // apps hide the cursor while typing/idle), which wrongly locked + re-centered the viewer's mouse
  // ("cursor jumps to center"), blocked clicking the UI ("can't change FPS"), and looked like flicker.
  // Game mouse is now MANUAL only: Control Center -> Fitur lainnya -> "Mode game (mouse)".
  dlog("game-auto received on=" + on + " (ignored, game mouse is manual only)");
}
// An admin window (Task Manager, admin CMD) in front of a non-elevated host: Windows drops our clicks and keys and
// hides the cursor over it. Host: tell the viewer, and say once here how to allow it. Viewer: show why, until it closes.
let _adminHintShown = false;
window.electronAPI?.onHostAdminWindow?.((on) => {
  if (!host || host.role !== "host") return;
  if (host.dataChannel && host.dataChannel.readyState === "open") {
    try { host.dataChannel.send(JSON.stringify({ __ctrl: "admin-window", on })); } catch {}
  }
  if (on && !_adminHintShown) {
    _adminHintShown = true;
    showToast("Jendela administrator aktif: pengontrol tidak bisa klik atau mengetik di jendela ini. Jalankan TryDesk sebagai administrator (Pengaturan → Keamanan) agar bisa.");
  }
});
// A UAC prompt or the lock screen on a PC hosting without the service (main.js "host-blind-desktop"): Windows draws it
// where TryDesk can't look, so the viewer's picture stops. Host: tell the viewer, and say once here what to do.
// Viewer: say why the picture stopped, until it is back.
let _hostBlindDesk = false, _blindHintShown = false;
window.electronAPI?.onHostBlindDesktop?.((on) => {
  _hostBlindDesk = on;
  if (!host || host.role !== "host") return;
  if (host.dataChannel && host.dataChannel.readyState === "open") {
    try { host.dataChannel.send(JSON.stringify({ __ctrl: "blind-desk", on })); } catch {}
  }
  if (on && !_blindHintShown) {
    _blindHintShown = true;
    showToast(trL("Pengontrol tidak bisa melihat jendela izin admin (UAC) atau layar kunci ini. Jawab sendiri di PC ini. Supaya pengontrol bisa, pasang layanan di Pengaturan › Layanan Windows.", "The person controlling this PC can't see this administrator prompt (UAC) or lock screen. Answer it here yourself. To let them, install the service in Settings › Windows service."));
  }
});
// ─── "Minta akses admin" (request elevation, Discord report 19 Nov: "gaada request elevation kaya rustdesk") ───
// A UAC prompt or the lock screen is drawn where only SYSTEM can look, so running TryDesk as administrator doesn't
// help there (the reporter tried); only the TryDesk service can. The viewer asks from the banner; this PC asks its
// person (on an elevated TryDesk the viewer can answer that box itself: it can already do anything an administrator
// can), installs the service exactly as Settings › Windows service does, then ends this session so the viewer comes
// back through the service with the same ID and password.
let _elevBusy = false, _elevNoUntil = 0;
function hostElevOk() {
  return !!(config && config.platform === "win32" && !config.serviceHost && _svcSupported && !_svcInstalled && allowInput && !forceViewOnly);
}
async function hostElevRequest(sess) {
  const say = (s) => { try { if (sess.dataChannel && sess.dataChannel.readyState === "open") sess.dataChannel.send(JSON.stringify({ __ctrl: "elev-state", s })); } catch {} };
  if (host !== sess || !sess.everConnected) return;
  if (!hostElevOk()) { say(_svcInstalled ? "installed" : "unsupported"); return; }
  // one question at a time, and a "no" holds for 30 s: a modified viewer can't keep this PC's person clicking it away
  if (_elevBusy || Date.now() < _elevNoUntil) { say("busy"); return; }
  _elevBusy = true;
  try {
    say("asking");
    sessLog(sess, "the viewer asks for administrator access (TryDesk service)");
    const elevated = await window.electronAPI.isElevated().catch(() => false);
    const saved = store.get("accessPasswordHash"), hash = /^[0-9a-f]{32}:[0-9a-f]{64}$/.test(saved || "") ? saved : "";
    // Owner's decision 21 Nov 2026 ("Pasang tanpa bertanya"): TryDesk here runs as administrator AND a UAC prompt or the
    // lock screen covers the screen right now. The question would sit behind it where nobody can answer (an unattended
    // PC stayed stuck: the viewer only got "no answer" after 60 s), and this viewer can already do anything an
    // administrator can here. So the service goes in straight away; the person at this PC sees a note afterwards.
    if (elevated && _hostBlindDesk) {
      sessLog(sess, "administrator access: TryDesk runs as administrator and the secure screen is up, installing the service without the question");
      await hostElevInstall(sess, say, hash, true);
      return;
    }
    try { window.electronAPI.focusWindow(true); } catch {}   // on top until answered, as for a connection request
    // Nobody answers within a minute (nobody at this PC, or a UAC prompt still covers the screen): taken as "no".
    let unanswered = false;
    const noAnswer = setTimeout(() => { unanswered = true; document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); }, 60000);
    const ok = await appConfirm({
      title: tr("Izinkan akses administrator?"),
      message: tr("Pengontrol meminta akses administrator supaya bisa melihat dan menjawab jendela izin admin (UAC), layar kunci, dan jendela administrator. Untuk itu TryDesk memasang layanan Windows di PC ini."),
      detail: [elevated ? "" : tr("Windows akan menampilkan prompt UAC: pilih Ya."),
        tr("Sesi tersambung ulang sendiri lewat layanan. Layanan bisa dihapus kapan saja di Pengaturan › Layanan Windows."),
        hash ? "" : tr("PC ini belum memakai password akses, jadi sambungan berikutnya tetap perlu diterima di PC ini.")].filter(Boolean).join(" "),
      okLabel: tr("Izinkan"), cancelLabel: tr("Tolak"),
    });
    clearTimeout(noAnswer);
    try { window.electronAPI.focusWindow(false); } catch {}
    if (host !== sess) return;
    if (!ok) { _elevNoUntil = Date.now() + 30000; say(unanswered ? "noanswer" : "denied"); sessLog(sess, "administrator access " + (unanswered ? "not answered in 60 s" : "declined here")); return; }
    await hostElevInstall(sess, say, hash, elevated);
  } finally { _elevBusy = false; }
}
// Installs the service for the viewer (as Settings › Windows service does) and hands the session over to it.
async function hostElevInstall(sess, say, hash, elevated) {
  {
    say(elevated ? "installing" : "uac");
    let r; try { r = await window.electronAPI.serviceInstall(hash); } catch { r = { ok: false, code: 1 }; }
    sessLog(sess, "service install for the viewer: " + (r.ok ? "done" : "failed, code " + r.code));
    if (!r.ok) {
      if (r.code === 1223) _elevNoUntil = Date.now() + 30000;
      say(r.code === 1223 ? "uac-no" : "failed");
      showToast(r.code === 1223 ? "UAC dibatalkan, layanan tidak dipasang" : tr("Layanan gagal dipasang") + ` (${r.code})`);
      await refreshServiceState(); refreshServiceUI();
      return;
    }
    store.set("svcPwHash", hash || "none"); store.set("svcPwAt", String(Date.now()));
    say("ready");
    showToast(tr("Layanan terpasang. Pengontrol menyambung ulang lewat layanan."));
    // (a moment for "ready" to arrive first: the viewer reconnects only when it knows why the session ended)
    await sleep(400);
    if (host === sess) closeSession(sess, true, "PC ini pindah ke layanan TryDesk");
    await refreshServiceState(); refreshServiceUI();
  }
}
// Viewer: what the other PC did with the request. Fixed texts only (the state is a word from a short list).
const ELEV_PENDING = new Set(["sent", "asking", "uac", "installing", "ready"]);
function viewerElevState(sess, ev) {
  const s = String(ev.s || "");
  const text = {
    asking: trL("Permintaan terkirim. Tunggu jawaban di PC remote.", "Request sent. Waiting for an answer on the remote PC."),
    uac: trL("Seseorang di PC remote perlu memilih Ya pada prompt UAC untuk memasang layanan TryDesk.", "Someone at the remote PC needs to choose Yes on the UAC prompt to install the TryDesk service."),
    installing: trL("PC remote sedang memasang layanan TryDesk…", "The remote PC is installing the TryDesk service…"),
    denied: trL("Permintaan akses admin ditolak di PC remote.", "The request for admin access was declined on the remote PC."),
    noanswer: tr("Tidak ada jawaban dari pemilik PC"),
    "uac-no": trL("Prompt UAC di PC remote dibatalkan, layanan tidak dipasang.", "The UAC prompt on the remote PC was cancelled; the service wasn't installed."),
    failed: trL("Layanan TryDesk gagal dipasang di PC remote.", "The TryDesk service couldn't be installed on the remote PC."),
    installed: trL("Layanan TryDesk sudah terpasang di PC remote. Putuskan lalu sambung lagi untuk memakainya.", "The TryDesk service is already installed on the remote PC. Disconnect and connect again to use it."),
    unsupported: trL("PC remote tidak bisa memasang layanan TryDesk dari sini.", "The remote PC can't install the TryDesk service from here."),
    busy: trL("Tunggu sebentar, permintaan sebelumnya belum selesai.", "Please wait, the previous request isn't finished yet."),
  }[s];
  if (!text && s !== "ready") return;
  sess.elevState = s;
  if (s === "ready") sess.elevMove = true;
  else if (sess === active) { playEvent(["denied", "noanswer", "uac-no", "failed", "unsupported"].includes(s) ? "bad" : "warn"); showToast(text); }
  if (sess === active) renderAdminBanner();
}
function requestElevation() {
  const s = active;
  if (!s || s.role !== "viewer" || !s.hostElev || !s.dataChannel || s.dataChannel.readyState !== "open") return;
  if (ELEV_PENDING.has(s.elevState)) return;
  try { s.dataChannel.send(JSON.stringify({ __ctrl: "elev-req" })); } catch { return; }
  s.elevState = "sent";
  renderAdminBanner();
}
// The banner: its text, and the request button when that PC can take one.
function adminBannerEl() {
  let b = $("#admin-banner");
  if (!b) {
    b = document.createElement("div"); b.id = "admin-banner"; b.setAttribute("role", "status");
    const t = document.createElement("span"); t.className = "ab-text";
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "ab-act"; btn.textContent = tr("Minta akses admin");
    btn.addEventListener("click", requestElevation);
    b.append(t, btn); document.body.appendChild(b);
  }
  return b;
}
function setAdminBanner(b, text) {
  b.querySelector(".ab-text").textContent = text;
  const can = !!(active && active.hostElev && !ELEV_PENDING.has(active.elevState));
  const act = b.querySelector(".ab-act");
  act.textContent = tr("Minta akses admin");   // again on every show: the language may have changed since it was made
  act.hidden = !can;
  b.style.display = "";
}
function renderAdminBanner() {
  let b = $("#admin-banner");
  const onRemote = !!active && !$("#screen-remote").classList.contains("hidden");
  if (onRemote && active.blindDesk) {
    if ((!b || b.style.display === "none" || b.dataset.kind !== "blind") && !active._blindWarned) { active._blindWarned = true; playEvent("warn"); }
    b = adminBannerEl();
    b.dataset.kind = "blind";
    setAdminBanner(b, trL("PC remote sedang menampilkan jendela izin admin (UAC) atau layar kunci. Hanya Windows yang bisa melihatnya, jadi gambar berhenti di sini. Minta pemilik PC menjawabnya, atau pasang layanan TryDesk di PC itu (Pengaturan › Layanan Windows) supaya Anda bisa melihat dan mengkliknya.", "The remote PC is showing an administrator prompt (UAC) or its lock screen. Only Windows can see it, so the picture stops here. Ask the PC's owner to answer it, or install the TryDesk service on that PC (Settings › Windows service) so you can see and click it."));
    return;
  }
  if (b) b.dataset.kind = "admin";
  const on = !!(active && active.adminWindow && !$("#screen-remote").classList.contains("hidden"));
  if (!on) { if (b) b.style.display = "none"; return; }
  if ((!b || b.style.display === "none") && !active._adminWarned) { active._adminWarned = true; playEvent("warn"); }   // it just appeared (once, not on every tab switch)
  b = adminBannerEl();
  // "di PC itu": the Discord reporter (19 Nov) ran HIS OWN TryDesk as administrator, which can't help.
  setAdminBanner(b, tr("Jendela administrator (mis. Task Manager) terbuka di PC remote. Windows memblokir klik, ketikan, dan kursor ke jendela itu. Minta pemilik PC menutupnya, atau menjalankan TryDesk di PC itu sebagai administrator (TryDesk di PC Anda tidak perlu)."));
}

// Host side: relay the host cursor-capture state to the connected viewer.
if (window.electronAPI && window.electronAPI.onHostCursorHidden) {
  window.electronAPI.onHostCursorHidden((hidden) => {
    const dc = host && host.dataChannel && host.dataChannel.readyState;
    dlog("host-cursor-hidden=" + hidden + " host=" + !!host + " role=" + (host && host.role) + " dc=" + dc);
    if (host && host.role === "host" && host.dataChannel && host.dataChannel.readyState === "open") {
      try { host.dataChannel.send(JSON.stringify({ __ctrl: "game-auto", on: !!hidden })); dlog("sent game-auto on=" + !!hidden); } catch (e) { dlog("send game-auto failed: " + e.message); }
    }
  });
}

function setupInputCapture() {
  const container = $("#remote-canvas-container");
  document.addEventListener("pointerlockerror", () => { dlog("pointerlock ERROR (refused)"); showToast("Mouse tidak bisa dikunci untuk mode game (pointer lock ditolak)"); });
  document.addEventListener("pointerlockchange", () => {
    gameMode = document.pointerLockElement === container;
    dlog("pointerlockchange gameMode=" + gameMode);
    container.classList.toggle("game-mode", gameMode);
    if (!gameMode) { accDx = accDy = 0; if (relTimer) { clearTimeout(relTimer); relTimer = null; } }
    // Esc released the pointer lock (fallback path, Mac/Linux): game mode is over, so say so everywhere.
    if (!gameMode && _gameActive) setGameCapture(false);
    showToast(gameMode ? "Mode game aktif, gerakan mouse relatif. Tekan Esc untuk keluar" : "Mode game nonaktif");
  });
  let lastMove = null, lastSentAt = 0, moveTimer = null;
  const flushMove = () => { moveTimer = null; lastSentAt = performance.now(); if (lastMove) sendMove(lastMove); };
  const canPan = () => scaleMode !== "fit";
  container.addEventListener("mousemove", (e) => {
    if (gameMode && document.pointerLockElement === container) {
      const sc = videoScale();
      accDx += (e.movementX || 0) / sc * gameSens;
      accDy += (e.movementY || 0) / sc * gameSens;
      if (!relTimer) relTimer = setTimeout(flushRel, 8);
      return;
    }
    if (panning) {
      container.scrollLeft = panStart.sl - (e.clientX - panStart.x);
      container.scrollTop = panStart.st - (e.clientY - panStart.y);
      return;
    }
    lastMove = normalizedPoint(e);
    if (!lastMove || moveTimer) return;
    const wait = moveIntervalMs() - (performance.now() - lastSentAt);
    if (wait <= 0) flushMove(); else moveTimer = setTimeout(flushMove, wait);
  });
  container.addEventListener("mousedown", (e) => {
    if (_pendingGame && !gameMode && document.pointerLockElement !== container) {
      lockPointer(container);
      e.preventDefault(); return;   // this click engages game control; game gets the next clicks
    }
    if (gameMode && document.pointerLockElement === container) {
      e.preventDefault();
      sendInput({ action: "mousedown", button: BUTTONS[e.button] || "left" });
      return;
    }
    if (canPan() && e.button === 1) {   // pan with middle-mouse drag only, never hijack Space
      panning = true;
      container.classList.add("panning");
      panStart = { x: e.clientX, y: e.clientY, sl: container.scrollLeft, st: container.scrollTop };
      e.preventDefault();
      return;
    }
    const p = normalizedPoint(e); if (!p) return;
    sendMove(p, true);   // on the ordered channel, so it is applied before the click that follows
    const b = BUTTONS[e.button] || "left";
    remoteButtonsDown.add(b);
    sendInput({ action: "mousedown", button: b });
  });
  const endPan = () => { if (panning) { panning = false; container.classList.remove("panning"); } };
  container.addEventListener("mouseup", (e) => {
    if (gameMode && document.pointerLockElement === container) { sendInput({ action: "mouseup", button: BUTTONS[e.button] || "left" }); return; }
    if (panning) return endPan();
    const b = BUTTONS[e.button] || "left";
    remoteButtonsDown.delete(b);
    sendInput({ action: "mouseup", button: b });
  });
  // A drag that started on the remote screen but is released over the tab strip / session bar (outside the
  // video) must still release the button on the host, or it stays held and every later move drags.
  window.addEventListener("mouseup", (e) => {
    endPan();
    const b = BUTTONS[e.button] || "left";
    if (remoteButtonsDown.has(b) && !container.contains(e.target)) { remoteButtonsDown.delete(b); sendInput({ action: "mouseup", button: b }); }
  });
  window.addEventListener("blur", () => {
    for (const b of remoteButtonsDown) sendInput({ action: "mouseup", button: b });
    remoteButtonsDown.clear();
  });
  container.addEventListener("contextmenu", (e) => e.preventDefault());
  const wheelTicks = makeWheelTicks();
  container.addEventListener("wheel", (e) => {
    e.preventDefault();
    const t = wheelTicks(e);
    if (t.x || t.y) sendInput({ action: "scroll", deltaX: t.x, deltaY: t.y });
  }, { passive: false });
  const pressedKeys = new Set();
  // macOS viewer: Cmd does on a Mac what Ctrl does on Windows, so Cmd reaches the remote PC as Ctrl. Its own key
  // codes (91/93, 224 in some layouts) would be the Windows key and the Menu key there: Cmd+C would arrive as Win+C.
  // (MAC_CMD / MODIFIER_VKS: next to isMacViewer, the monitor windows use them too)
  for (const type of ["keydown", "keyup"]) {
    document.addEventListener(type, (e) => {
      if (!active || active.role !== "viewer" || $("#screen-remote").classList.contains("hidden")) return;
      // File Transfer is open over the session: its keys (Delete, F2, Ctrl+A, Enter) are for it, never the other PC.
      if (fmOpen) { if (pressedKeys.size) releaseAllKeys(); return; }
      const a = document.activeElement;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT")) return;
      // The key-combination panel has the focus (a tile, the recorder): its keys are for it, never the other PC.
      if (a && a.closest && a.closest("#keys-panel")) { if (pressedKeys.size) releaseAllKeys(); return; }
      // Forward every key to the remote (Space included). preventDefault stops the browser from
      // scrolling the page or triggering its own shortcuts so the keystroke only goes to the host.
      e.preventDefault();
      const mac = isMacViewer();
      const vk = mac && MAC_CMD.has(e.keyCode) ? 17 : e.keyCode;
      // macOS sends no keyup for a key pressed while Cmd is held, so that key (the C of Cmd+C) is let go right
      // away; otherwise it would stay pressed on the remote PC.
      if (mac && e.metaKey && type === "keydown" && !MODIFIER_VKS.has(e.keyCode)) {
        sendInput({ action: "keydown", vk });
        sendInput({ action: "keyup", vk });
        return;
      }
      if (pasteHook(vk, type === "keydown")) return;
      if (type === "keydown") pressedKeys.add(vk); else pressedKeys.delete(vk);
      sendInput({ action: type, vk });
    });
  }
  // Ctrl+V while this PC's clipboard holds files copied here: the files go over first (clipPasteToRemote), then the
  // Ctrl+V follows (sendPasteChord). The V is held back meanwhile; Ctrl reaches the other PC as usual.
  let swallowV = false;
  function pasteHook(vk, down) {
    if (vk !== 86) return false;
    if (!down) { if (swallowV) { swallowV = false; return true; } return false; }
    if (!pressedKeys.has(17) || pressedKeys.has(16) || pressedKeys.has(18) || !clipPasteWanted(active)) return false;
    swallowV = true;
    clipPasteToRemote(active);
    return true;
  }
  sendPasteChord = () => {
    const held = pressedKeys.has(17);
    if (!held) sendInput({ action: "keydown", vk: 17 });
    sendInput({ action: "keydown", vk: 86 }); sendInput({ action: "keyup", vk: 86 });
    if (!held) sendInput({ action: "keyup", vk: 17 });
  };
  // Release every still-held key when the viewer loses focus (Alt+Tab, click away, minimize). Without
  // this a lost keyup leaves Ctrl/Alt/Shift "stuck down" on the host, breaking typing, copy/paste and
  // shortcuts afterwards. Covers the #1 cause of "keyboard tidak sinkron".
  function releaseAllKeys() {
    if (!pressedKeys.size) return;
    for (const vk of pressedKeys) sendInput({ action: "keyup", vk });
    pressedKeys.clear();
  }
  window.addEventListener("blur", releaseAllKeys);
  document.addEventListener("visibilitychange", () => { if (document.hidden) releaseAllKeys(); });
  releaseHeldInput = () => {
    releaseAllKeys();
    for (const b of remoteButtonsDown) sendInput({ action: "mouseup", button: b });
    remoteButtonsDown.clear();
  };

  // Keys captured natively in the main process (system shortcuts like Alt+Tab/Win that the browser never
  // sees outside fullscreen) arrive here and are forwarded to the host exactly like local keys.
  if (window.electronAPI && window.electronAPI.onCapturedKey) {
    window.electronAPI.onCapturedKey(({ vk, down }) => {
      if (!active || active.role !== "viewer" || $("#screen-remote").classList.contains("hidden")) return;
      // (the hook is switched off while the key panel has the focus; a key already on its way is dropped)
      const fa = document.activeElement;
      if (fa && fa.closest && fa.closest("#keys-panel")) { if (pressedKeys.size) releaseAllKeys(); return; }
      if (pasteHook(vk, down)) return;
      if (down) pressedKeys.add(vk); else pressedKeys.delete(vk);
      sendInput({ action: down ? "keydown" : "keyup", vk });
    });
  }
  // Main process asks us to release all held keys (window lost focus, capture turned off) so no modifier
  // sticks down on the host.
  if (window.electronAPI && window.electronAPI.onReleaseKeys) window.electronAPI.onReleaseKeys(releaseAllKeys);
  // Mouse captured natively in the main process (game mode) → forward to the host exactly like local input.
  if (window.electronAPI && window.electronAPI.onCapturedMouse) {
    window.electronAPI.onCapturedMouse((m) => {
      if (!active || active.role !== "viewer" || active.viewOnly || $("#screen-remote").classList.contains("hidden")) return;
      // Batch moves into the 8ms accumulator (flushRel) so a high-polling-rate mouse doesn't flood the
      // data channel with 1000 messages/sec (which would congest it and add stutter).
      if (m.t === "move") { const sc = videoScale(); accDx += m.dx / sc * gameSens; accDy += m.dy / sc * gameSens; if (!relTimer) relTimer = setTimeout(flushRel, 8); }
      else if (m.t === "down") sendInput({ action: "mousedown", button: m.b });
      else if (m.t === "up") sendInput({ action: "mouseup", button: m.b });
      else if (m.t === "wheel") sendInput({ action: "scroll", deltaX: 0, deltaY: -Math.sign(m.d) });   // notch per event, matching local wheel direction
      else if (m.t === "hwheel") sendInput({ action: "scroll", deltaX: Math.sign(m.d), deltaY: 0 });
    });
  }
  // Pause/Break pressed locally → release native game capture (frees the mouse) so the user can click away.
  if (window.electronAPI && window.electronAPI.onReleaseControl) {
    window.electronAPI.onReleaseControl(() => {
      setGameCapture(false);
      releaseAllKeys();
      // Really hand the keyboard back too (until the user clicks into the remote view again), and leave
      // fullscreen, Esc itself goes to the remote, so this is the way out.
      _kbReleased = true;
      refreshKeyCapture();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      showToast("Kontrol dilepas, mouse & keyboard kembali ke PC ini. Klik layar remote untuk lanjut.");
    });
  }
  // Pause capture while a local text field is focused (so the user can type in TryDesk's own UI), resume after.
  document.addEventListener("focusin", refreshKeyCapture);
  document.addEventListener("focusout", () => setTimeout(refreshKeyCapture, 0));
}

// ─── Settings overlay ─────────────────────────────────────
// Settings always opens on Ringkasan (direction 2); openSettingsAt() then moves to the page it wants.
function toggleSettings() {
  // The service's window (SYSTEM) has no Settings of its own: it opens the person's own TryDesk at Settings instead.
  if (config && config.serviceHost) { svcOpenUserApp("settings"); return; }
  if (overlaySettings.classList.toggle("hidden") === false) {
    syncDefaultQualityUI();
    showSettingsTab("tab-home", true);
    tidySettings();
    arrive(overlaySettings.querySelector(".settings-panel"), $("#tab-home .stitle"));
  }
}

// Settings pages: the page's title rises again each time another page opens (one beat). On a phone a page opens
// on its own (the menu is the list under Ringkasan) and the header names it, with the back arrow to Ringkasan.
const SETTINGS_PAGE_NAMES = { "tab-general": "Umum", "tab-sound": "Suara","tab-security": "Keamanan", "tab-display": "Kualitas gambar", "tab-connection": "Jaringan", "tab-service": "Layanan Windows", "tab-advanced": "Tentang" };
function showSettingsTab(id, quiet) {
  const tab = $(`.stab[data-tab="${id}"]`), pane = $(`#${id}`); if (!tab || !pane) return;
  const was = tab.classList.contains("active");
  $$(".stab").forEach((t) => { const on = t === tab; t.classList.toggle("active", on); if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current"); });
  $$(".settings-tab-content").forEach((c) => c.classList.toggle("hidden", c !== pane));
  const page = id !== "tab-home";
  overlaySettings.classList.toggle("s-page", page);
  // (texts here are set in Indonesian; the text observer shows them in English and keeps the Indonesian as source)
  const head = $("#settings-head-title");
  if (head) head.textContent = page && isPhoneUi() ? (SETTINGS_PAGE_NAMES[id] || "") : "Pengaturan";
  if (!page) renderSettingsHome();
  const cnt = pane.closest(".settings-body"); if (cnt && !was) { cnt.scrollTop = 0; pane.scrollTop = 0; }
  if (!was && !quiet) arrive(pane, pane.querySelector(".stitle"));
}
$$(".stab").forEach((tab) => tab.addEventListener("click", () => showSettingsTab(tab.dataset.tab)));

// "Pengaturan lanjutan" on each page: technical rows stay out of a beginner's way until asked for. One choice for
// every page (opening it on one page opens it everywhere), kept for this run only.
let settingsAdvOpen = false;
function paintSettingsAdv() {
  $$("#overlay-settings .adv-toggle").forEach((b) => {
    b.setAttribute("aria-expanded", String(settingsAdvOpen)); b.classList.toggle("open", settingsAdvOpen);
    const body = b.nextElementSibling; if (body && body.classList.contains("adv-body")) body.hidden = !settingsAdvOpen;
  });
}
$$("#overlay-settings .adv-toggle").forEach((b) => b.addEventListener("click", () => { settingsAdvOpen = !settingsAdvOpen; paintSettingsAdv(); }));
// A row can be hidden on some builds (phone, macOS/Linux, already admin): a group, its heading, and an advanced part
// with nothing left in it disappear as well, and the advanced button counts only what it really holds.
const rowShown = (r) => !r.classList.contains("hidden") && !r.classList.contains("m-hide") && r.style.display !== "none";
function tidySettings() {
  for (const g of $$("#overlay-settings .sgrp")) {
    const any = [...g.children].some(rowShown);
    g.classList.toggle("s-empty", !any);
    const h = g.previousElementSibling; if (h && h.classList.contains("sect")) h.classList.toggle("s-empty", !any);
  }
  for (const b of $$("#overlay-settings .adv-toggle")) {
    const body = b.nextElementSibling; const n = body ? [...body.querySelectorAll(".srow")].filter(rowShown).length : 0;
    b.classList.toggle("s-empty", !n); body?.classList.toggle("s-empty", !n);
    const c = b.querySelector(".adv-count"); if (c) c.textContent = n ? `· ${n} untuk pengguna berpengalaman` : "";
  }
  // Ringkasan's quick row for start-up follows the real one (gone on macOS/Linux/phone).
  const src = $("#setting-startup")?.closest(".srow"), mir = $('[data-mirror="#setting-startup"]')?.closest(".srow");
  if (src && mir) mir.classList.toggle("hidden", !rowShown(src));
  paintSettingsAdv();
}
// Ringkasan's quick controls are mirrors of the real ones on the pages (one source of truth, saved in one place).
$$("#overlay-settings [data-mirror]").forEach((m) => m.addEventListener("change", () => {
  const s = $(m.dataset.mirror); if (!s) return;
  if (s.type === "checkbox") s.checked = m.checked; else s.value = m.value;
  s.dispatchEvent(new Event("change"));
}));
function syncSettingsMirrors() {
  $$("#overlay-settings [data-mirror]").forEach((m) => { const s = $(m.dataset.mirror); if (!s) return; if (m.type === "checkbox") m.checked = s.checked; else m.value = s.value; });
}
// Ringkasan: four facts read from the same places the pages use; a click opens the page (and the field) that changes it.
function renderSettingsHome() {
  syncSettingsMirrors();
  const pw = !!store.get("accessPasswordHash");
  // (Indonesian on purpose: the text observer translates and keeps the source, so a language switch follows)
  $("#sum-in-v").textContent = pw ? "Masuk dengan password" : "Selalu tanya dulu";
  $("#sum-in-h").textContent = pw ? "Password akses aktif" : "Belum ada password akses";
  const q = qualityChoice();
  $("#sum-q-v").textContent = q.name; $("#sum-q-h").textContent = q.nums;
  const svcSupported = $("#service-group") && $("#service-group").style.display !== "none";
  // installed ("on") is not enough: a stopped service ("warn") does not answer after a restart either
  const st = $("#service-state"), inst = !!st?.classList.contains("on"), on = inst && !st.classList.contains("warn");
  $("#sum-svc-v").textContent = on ? "Tetap bisa dihubungi" : "Perlu TryDesk terbuka";
  $("#sum-svc-h").textContent = !svcSupported ? "Versi ini tanpa layanan Windows" : on ? "Layanan Windows terpasang" : inst ? "Layanan Windows sedang berhenti" : "Layanan Windows belum dipasang";
  const alias = store.get("deviceAlias");
  $("#sum-name-v").textContent = alias || tr("Belum diberi nama");   // a name the user typed is never translated (TR_SKIP)
  // A PC that cannot be controlled (phone, macOS, Linux) has no one coming in and nothing to keep after a restart.
  const hostable = !viewerOnlyDesktop() && !window.TD_MOBILE;
  for (const id of ["#sum-in", "#sum-svc"]) $(id)?.classList.toggle("hidden", !hostable);
}
$$("#tab-home .s-tile").forEach((t) => t.addEventListener("click", () => openSettingsAt(t.dataset.tab, t.dataset.go)));

// Kualitas bawaan as rows: name, what it suits, and the numbers. The hidden select stays the source of truth (its
// change handler stores the default); "Kustom" only appears when the quality panel set something of its own.
const QUALITY_ROWS = Object.entries({
  default:  ["Bawaan", "Pilihan awal, cocok untuk kebanyakan PC"],
  hemat:    ["Hemat", "Internet lambat atau kuota terbatas"],
  seimbang: ["Seimbang", "Wi-Fi rumah biasa"],
  kualitas: ["Kualitas", "Teks dan gambar lebih tajam"],
  ultra:    ["Ultra", "Jaringan kabel yang cepat"],
  gaming:   ["Gaming", "Main game, monitor 165 Hz"],
  maksimal: ["Maksimal", "Satu jaringan lokal, monitor 240 Hz"],
  custom:   ["Kustom", "Diatur sendiri di panel Kualitas saat sesi"],
}).map(([v, [name, hint]]) => [v, name, hint]);
const qNums = (p) => `${p.bitrate} Mbps · ${p.fps} FPS`;
function qualityChoice() {
  const v = $("#setting-default-quality")?.value || "default";
  const row = QUALITY_ROWS.find((r) => r[0] === v) || QUALITY_ROWS[0];
  const p = v === "default" ? DEFAULT_QUALITY : PRESETS[v] || defaultQuality;
  return { v, name: row[1], nums: qNums(p) };
}
function renderQualityList() {
  const box = $("#s-quality"), sel = $("#setting-default-quality"); if (!box || !sel) return;
  const cur = sel.value;
  box.textContent = "";
  for (const [v, name, hint] of QUALITY_ROWS) {
    if (v === "custom" && cur !== "custom") continue;
    const p = v === "default" ? DEFAULT_QUALITY : v === "custom" ? defaultQuality : PRESETS[v]; if (!p) continue;
    const b = document.createElement("button");
    b.type = "button"; b.className = "s-qopt" + (v === cur ? " on" : ""); b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(v === cur)); b.dataset.v = v;
    const dot = document.createElement("span"); dot.className = "s-qdot";
    const tx = document.createElement("span"); tx.className = "srow-tx";
    const nb = document.createElement("b"); nb.textContent = name;
    const hs = document.createElement("small"); hs.textContent = hint;
    const nm = document.createElement("small"); nm.className = "s-qnum-under"; nm.textContent = qNums(p);
    tx.append(nb, hs, nm);
    const num = document.createElement("em"); num.className = "s-qnum"; num.textContent = qNums(p);
    b.append(dot, tx, num);
    if (v !== "custom") b.addEventListener("click", () => { sel.value = v; sel.dispatchEvent(new Event("change")); renderQualityList(); });
    box.appendChild(b);
  }
}

// Device alias
$("#btn-save-alias").addEventListener("click", () => {
  const alias = $("#device-alias").value.trim();
  store.set("deviceAlias", alias || null);
  showToast(alias ? `Alias disimpan: ${alias}` : "Alias dihapus");
});

// Theme
// Tema: Gelap / Terang / Ikuti Windows (on a phone: Ikuti HP), shown as one segment in Settings → Umum.
const _lightMq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
function applyTheme(theme) {
  const light = theme === "light" || (theme === "system" && !!_lightMq && _lightMq.matches);
  if (light) document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
  $$(".theme-seg button").forEach((b) => { const on = b.dataset.v === theme; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); });
}
_lightMq?.addEventListener?.("change", () => { if (store.get("theme") === "system") applyTheme("system"); });
$("#setting-theme").addEventListener("change", (e) => {
  applyTheme(e.target.value);
  store.set("theme", e.target.value);
});
$$(".theme-seg button").forEach((b) => b.addEventListener("click", () => { const s = $("#setting-theme"); s.value = b.dataset.v; s.dispatchEvent(new Event("change")); }));
// Back: from a page to Ringkasan on a phone, otherwise out of Settings.
function settingsBack() {
  if (isPhoneUi() && overlaySettings.classList.contains("s-page")) { showSettingsTab("tab-home"); return true; }
  $("#btn-settings-close").click(); return false;
}
$("#btn-settings-back").addEventListener("click", settingsBack);

// Language (owner's pick 16 Nov, "Arah B"): a card per language with its greeting, its own name, and its name in the
// language on screen; "Ikuti bahasa Windows" follows the system. The two <select>s stay as the one stored value.
for (const sel of ["#setting-language", '[data-mirror="#setting-language"]']) {
  const s = $(sel); if (!s) continue;
  s.replaceChildren(...LANGS.map((x) => Object.assign(document.createElement("option"), { value: x.c, textContent: x.n })));
}
function setLang(code, fromSystem) {
  store.set("lang", fromSystem ? "system" : code);
  applyLanguage(code);
  $("#setting-language").value = lang;
  renderSettingsHome();   // its name tile is skipped by the text observer (a user's name), so it is rewritten here
  showToast(LANGS.find((x) => x.c === lang)?.n || lang);
}
$("#setting-language").addEventListener("change", (e) => setLang(e.target.value, false));
function paintLangCards() {
  const host = $("#lang-cards"); if (!host) return;
  const followSys = store.get("lang") === "system" || !store.get("lang");
  const sw = $("#setting-lang-system"); if (sw) sw.checked = followSys;
  let names = null; try { names = new Intl.DisplayNames([lang], { type: "language" }); } catch {}
  if (!host.childElementCount) {
    for (const x of LANGS) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "lang-card"; b.dataset.lang = x.c; b.setAttribute("role", "radio"); b.lang = x.c;
      b.innerHTML = "<b></b><span></span><small></small>";
      b.querySelector("b").textContent = x.g; b.querySelector("span").textContent = x.n;
      // only the Arabic words run right to left; the card itself lines up with the others
      if (x.rtl) for (const t of b.querySelectorAll("b, span")) t.dir = "rtl";
      b.addEventListener("click", () => setLang(x.c, false));
      host.append(b);
    }
  }
  for (const b of host.children) {
    const on = b.dataset.lang === lang;
    b.classList.toggle("on", on); b.setAttribute("aria-checked", on ? "true" : "false");
    let local = ""; try { local = names ? names.of(b.dataset.lang) : ""; } catch {}
    const small = b.querySelector("small"); small.textContent = local && local !== b.querySelector("span").textContent ? local : "";
    small.lang = lang;
  }
}
$("#setting-lang-system")?.addEventListener("change", (e) => { if (e.target.checked) setLang(sysLang(), true); else { store.set("lang", lang); paintLangCards(); } });

// Auto-reconnect
$("#setting-auto-reconnect").addEventListener("change", (e) => {
  autoReconnect = e.target.checked;
  store.set("autoReconnect", autoReconnect ? "1" : "0");
});

// ─── Preferences (Settings panel) ─────────────────────────
// Every control in the panel is saved under its key and APPLIED where it matters, nothing there is decoration.
// Booleans persist as "1"/"0". apply(value, atStartup) runs on load and on every change.
const PREFS = {
  notifyIncoming: { el: "#setting-notify-incoming", def: true },
  notifySound:    { el: "#setting-notify-sound", def: true },
  uiSound:        { el: "#setting-ui-sound", def: true, apply: (v, boot) => { if (v && !boot) uiSound("switch"); } },
  // Settings → Suara (concept "Suara untuk setiap kejadian", 19 Nov). notifySound above is the "Permintaan masuk dan
  // sambungan" switch now (same saved value as the old "Bunyi pemberitahuan").
  snd:            { el: "#setting-snd", def: true, apply: (v) => { $$("#tab-sound .snd-dep").forEach((r) => { r.classList.toggle("s-off", !v); r.querySelectorAll("input, button").forEach((i) => { i.disabled = !v; }); }); } },
  sndVolume:      { el: "#setting-snd-volume", def: "60",
                    apply: (v) => { $("#setting-snd-volume-num").textContent = `${v}%`; paintSlider($("#setting-snd-volume")); if (_sfxOut) _sfxOut.gain.value = sfxGain(); } },
  sndChat:        { el: "#setting-snd-chat", def: true },
  sndFile:        { el: "#setting-snd-file", def: true },
  sndNotice:      { el: "#setting-snd-notice", def: true },
  sndUpdate:      { el: "#setting-snd-update", def: true },
  sndQuietGame:   { el: "#setting-snd-quiet-game", def: true },
  sndQuietFs:     { el: "#setting-snd-quiet-fs", def: true },
  closeToTray:    { el: "#setting-close-to-tray", def: true },
  discord:        { el: "#setting-discord", def: true, apply: (v) => window.electronAPI.setDiscordEnabled(v) },
  connTimeout:    { el: "#setting-timeout", def: "60" },
  autoAcceptPw:   { el: "#setting-autoaccept", def: true, apply: (v) => { autoAcceptWithPassword = v; } },
  lanDirect:      { el: "#setting-lan", def: false, apply: (v, boot) => { applyLanHost(v, boot); } },
  bwLimit:        { el: "#setting-bw-limit", def: "0", apply: (_v, boot) => { if (!boot && host && host.pc) applyQualityToSender(host, hostQuality); } },
  protocol:       { el: "#setting-connection-protocol", def: "auto" },
  preventSleep:   { el: "#setting-prevent-sleep", def: false, apply: (v, boot) => { if (!boot && host && host.pc) window.electronAPI.setPowerSave(v); } },
  lockAfter:      { el: "#setting-lock-after-session", def: false },
  sessionLimit:   { el: "#setting-session-timeout", def: "0", apply: (_v, boot) => { if (!boot && host) armSessionLimit(host); } },
  bruteForce:     { el: "#setting-brute-force", def: true, apply: (v) => { bruteForceGuard = v; } },
  defScale:       { el: "#setting-default-scale", def: "fit" },
  autoStats:      { el: "#setting-autostats", def: false, key: "showStats",
                    apply: (v) => { statsOverlay.classList.toggle("hidden", !v); const cb = $("#stats-toggle"); if (cb) cb.checked = v; } },
  // On by default (14 Nov 2026, users: "the remote PC's sound never comes through"): with it off the sound did arrive,
  // but the <video> stayed muted until the session's audio button was found. Someone who turned it off keeps "0".
  autoAudio:      { el: "#setting-auto-audio", def: true },
  // Control Center › Monitor › Ikuti kursor (no switch in Settings): asked of every PC this one connects to
  monFollow:      { el: "#pref-mon-follow", def: false },
  audioVolume:    { el: "#setting-audio-volume", def: "100",
                    apply: (v) => { $("#setting-audio-volume-num").textContent = `${v}%`; paintSlider($("#setting-audio-volume")); for (const s of viewerSessions()) if (s.video) s.video.volume = v / 100; } },
};
function prefGet(name) {
  const p = PREFS[name];
  const raw = store.get(p.key || "pref." + name);
  if (raw == null) return p.def;
  return typeof p.def === "boolean" ? raw === "1" : raw;
}
function prefSet(name, v) {
  const p = PREFS[name];
  store.set(p.key || "pref." + name, typeof p.def === "boolean" ? (v ? "1" : "0") : String(v));
  if (p.apply) p.apply(v, false);
}
function initPrefs() {
  for (const [name, p] of Object.entries(PREFS)) {
    const el = $(p.el); if (!el) continue;
    const v = prefGet(name);
    if (el.type === "checkbox") el.checked = v; else el.value = v;
    if (p.apply) p.apply(v, true);
    el.addEventListener(el.type === "range" ? "input" : "change", () => prefSet(name, el.type === "checkbox" ? el.checked : el.value));
  }
  // The stats toggle on the remote screen and this setting are the same preference.
  $("#stats-toggle").addEventListener("change", (e) => { const s = $("#setting-autostats"); if (s) s.checked = e.target.checked; });
  // OS-level settings: Windows is the source of truth.
  window.electronAPI.getLoginItem().then((on) => { $("#setting-startup").checked = !!on; }).catch(() => {});
  $("#setting-startup").addEventListener("change", (e) => window.electronAPI.setLoginItem(e.target.checked));
  window.electronAPI.getHwAccel().then((on) => { $("#setting-hw-accel").checked = !!on; }).catch(() => {});
  $("#setting-hw-accel").addEventListener("change", async (e) => {
    await window.electronAPI.setHwAccel(e.target.checked);
    showToast("Berlaku setelah TryDesk dibuka ulang");
  });
  // Default quality / codec for NEW tabs (the per-tab quality panel also updates this default).
  $("#setting-default-quality").addEventListener("change", (e) => {
    const p = e.target.value === "default" ? DEFAULT_QUALITY : PRESETS[e.target.value];
    if (!p) return;
    defaultQuality = { ...defaultQuality, bitrate: p.bitrate, fps: p.fps, resHeight: p.resHeight };
    store.set("quality", JSON.stringify(defaultQuality));
  });
  $("#setting-default-codec").addEventListener("change", (e) => {
    defaultQuality = { ...defaultQuality, codec: e.target.value };
    store.set("quality", JSON.stringify(defaultQuality));
  });
  $("#btn-reset-settings").addEventListener("click", resetSettings);
  // About: real version + links that open in the browser (navigation inside the window is blocked).
  const ver = `TryDesk v${config.appVersion || ""}`.trim();
  $("#about-version").textContent = ver; $("#status-version").textContent = ver;
  $$("[data-external]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); window.electronAPI.openExternal(a.href); }));
}
// Reflect the CURRENT default quality/codec whenever Settings opens (the quality panel may have changed them).
function syncDefaultQualityUI() {
  const q = defaultQuality;
  const match = Object.entries({ default: DEFAULT_QUALITY, ...PRESETS }).find(([, p]) => p.bitrate === q.bitrate && p.fps === q.fps && (p.resHeight || 0) === (q.resHeight || 0));
  $("#setting-default-quality").value = match ? match[0] : "custom";
  $("#setting-default-codec").value = q.codec || "auto";
  renderQualityList();
}
async function resetSettings() {
  const ok = await appConfirm({
    title: tr("Reset semua pengaturan?"), message: tr("Semua pengaturan kembali ke bawaan."),
    detail: tr("ID, favorit, riwayat koneksi dan password akses tetap disimpan. TryDesk akan dimuat ulang."),
    okLabel: tr("Reset"), cancelLabel: tr("Batal"),
  });
  if (!ok) return;
  // Credentials are not "settings": wiping the access password would silently make an unattended PC ask
  // for Accept on every connection.
  // (groups and own key combinations are the user's data like favorites: the dialog promises they stay)
  const KEEP = new Set(["myId", "myToken", "favorites", "recent", "recentConnections", "accessPasswordHash", "peerNames", "peerThumbs", "lang", "deviceGroups", "keyCombos"]);
  try { for (const k of Object.keys(localStorage)) if (!KEEP.has(k)) localStorage.removeItem(k); } catch {}
  try { await window.electronAPI.setLoginItem(false); await window.electronAPI.setHwAccel(true); } catch {}
  location.reload();
}
// Someone wants to come in: the knock plays now and once more after 10 s if the request is still on screen, then
// stays quiet until it is answered or declined by itself (concept "Suara", 19 Nov).
function requestSound(ov) {
  playEvent("request");
  clearTimeout(requestSound._t);
  requestSound._t = setTimeout(() => { if (ov && !ov.classList.contains("hidden")) playEvent("request", true); }, 10000);
}

// ─── Button feel: spring press + click sound ──────────────
// The main buttons give way under the finger and spring back, the way a Remotion spring() moves: a damped
// oscillator from 0 to 1 (mass 1; stiffness / damping per motion). The math is written here, not taken from
// Remotion, whose licence doesn't fit AGPL. The `scale` property is used so it stacks with each button's own
// hover/active transform. Off when the system asks for reduced motion.
const PRESS_SEL = "#btn-connect, #btn-connect-files, #connect-pw-go, #btn-accept, #btn-reject, #btn-copy, #btn-stop-hosting, #btn-cancel-connect, #btn-lan-help-ok, #btn-lan-help-next, .view-btn, .m-tab";
const SPRING_PRESS = { mass: 1, stiffness: 520, damping: 32 };     // quick, no wobble going in
const SPRING_RELEASE = { mass: 1, stiffness: 240, damping: 13 };   // back out with one small overshoot
const reducedMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
function springProgress(t, { mass = 1, stiffness = 100, damping = 10 } = {}) {
  const w0 = Math.sqrt(stiffness / mass), zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
}
function springScale(el, to, cfg) {
  cancelAnimationFrame(el._springRaf);
  if (reducedMotion.matches || !("scale" in el.style)) { el._springAt = 1; el.style.scale = ""; return; }
  const from = el._springAt ?? 1, t0 = performance.now();
  const w0 = Math.sqrt(cfg.stiffness / cfg.mass), zeta = cfg.damping / (2 * Math.sqrt(cfg.stiffness * cfg.mass));
  const settle = Math.min(1.2, Math.log(1000) / (Math.min(zeta, 1) * w0));   // seconds until the motion is under 0.1 %
  const step = (now) => {
    const t = (now - t0) / 1000;
    if (t >= settle) { el._springAt = to; el.style.scale = to === 1 ? "" : String(to); return; }
    el._springAt = from + (to - from) * springProgress(t, cfg);
    el.style.scale = el._springAt.toFixed(4);
    el._springRaf = requestAnimationFrame(step);
  };
  el._springRaf = requestAnimationFrame(step);
}
function pressTarget(e) { const b = e.target.closest && e.target.closest(PRESS_SEL); return b && !b.disabled ? b : null; }
document.addEventListener("pointerdown", (e) => { const b = pressTarget(e); if (b) { b._pressed = true; springScale(b, 0.95, SPRING_PRESS); } }, true);
const pressRelease = (b) => { if (b && b._pressed) { b._pressed = false; springScale(b, 1, SPRING_RELEASE); } };
// Release by the element itself, not pressTarget: a button disabled mid-press must still spring back.
for (const type of ["pointerup", "pointercancel"]) document.addEventListener(type, (e) => pressRelease(e.target.closest && e.target.closest(PRESS_SEL)), true);
// Sliding the finger off the button lets it go too (leave doesn't bubble, but capture still sees it).
document.addEventListener("pointerleave", (e) => { if (e.target.matches && e.target.matches(PRESS_SEL)) pressRelease(e.target); }, true);
// Enter / Space has no pointer: a short dip and back, so the keyboard gets the same answer.
document.addEventListener("click", (e) => {
  if (e.detail !== 0) return;
  const b = pressTarget(e); if (!b) return;
  springScale(b, 0.95, SPRING_PRESS);
  setTimeout(() => springScale(b, 1, SPRING_RELEASE), 90);
}, true);

// Click sounds (owner's pick 16 Nov: "Arah B, Ketukan", short firm taps like a good trackpad or keyboard). Made here
// with Web Audio: a burst of filtered noise for the tap and a short low tone for its body, so there is no recording,
// no licence and nothing to download. Played on the buttons that start or answer a connection. Silent while any
// remote session runs, in either direction: the host's sound can travel to the viewer, and nobody wants clicks over a
// remote PC's audio. Settings → Suara.
// Volume (Settings → Suara): 60 % gives 0.51, the old fixed level.
const sfxGain = () => { try { return 0.85 * (Number(prefGet("sndVolume")) || 0) / 100; } catch { return 0.5; } };
const SOUND_SEL = { accept: "#btn-accept", reject: "#btn-reject", copy: "#btn-copy", click: "#btn-connect, #btn-connect-files, #connect-pw-go, #btn-stop-hosting, #btn-cancel-connect", switch: ".view-btn" };
let _sfxCtx = null, _sfxOut = null, _sfxNoise = null;
function sfxCtx() {
  if (!_sfxCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    _sfxCtx = new AC();
    _sfxOut = _sfxCtx.createGain(); _sfxOut.gain.value = sfxGain(); _sfxOut.connect(_sfxCtx.destination);
    // One tenth of a second of white noise, reused by every tap.
    _sfxNoise = _sfxCtx.createBuffer(1, Math.ceil(_sfxCtx.sampleRate * 0.1), _sfxCtx.sampleRate);
    const d = _sfxNoise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (_sfxCtx.state === "suspended") { try { const r = _sfxCtx.resume(); if (r && r.catch) r.catch(() => {}); } catch {} }
  return _sfxCtx;
}
// the tap: noise through a band-pass filter, a 2 ms attack and a fast fall
function sfxTap(freq, q, dur, peak, at = 0) {
  const c = sfxCtx(), t = c.currentTime + 0.005 + at;
  const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  s.buffer = _sfxNoise; f.type = "bandpass"; f.frequency.value = freq; f.Q.value = q;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(_sfxOut); s.start(t); s.stop(t + dur + 0.02);
}
// the body: a short sine that may slide in pitch
function sfxTone(f0, f1, attack, decay, peak, at = 0) {
  const c = sfxCtx(), t = c.currentTime + 0.005 + at, o = c.createOscillator(), g = c.createGain();
  o.type = "sine"; o.frequency.setValueAtTime(f0, t); if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  o.connect(g); g.connect(_sfxOut); o.start(t); o.stop(t + attack + decay + 0.02);
}
const SFX = {
  click: () => { sfxTap(2800, 1.4, 0.022, 0.55); sfxTone(170, 90, 0.002, 0.04, 0.34); },
  accept: () => { sfxTap(2200, 1.6, 0.02, 0.45); sfxTap(3600, 1.6, 0.03, 0.5, 0.07); sfxTone(660, 880, 0.003, 0.09, 0.12, 0.07); },   // two taps going up
  reject: () => { sfxTap(3000, 1.6, 0.02, 0.45); sfxTap(1600, 1.4, 0.035, 0.5, 0.075); sfxTone(150, 80, 0.002, 0.06, 0.32, 0.075); },   // two taps going down
  copy: () => { sfxTap(3400, 2, 0.018, 0.45); sfxTone(1800, 1800, 0.002, 0.04, 0.1, 0.01); },
  switch: () => sfxTap(5200, 2.2, 0.012, 0.32),
  // Event sounds (owner pick 19 Nov, concept "Suara untuk setiap kejadian", Set 1 Ketukan): the same taps with a small
  // tone. Up for good news, down for bad, a double knock for someone at the door.
  request: () => { sfxTap(2300, 1.5, 0.025, 0.55); sfxTap(2300, 1.5, 0.025, 0.55, 0.14); sfxTone(880, 880, 0.004, 0.16, 0.16, 0.32); sfxTone(1175, 1175, 0.004, 0.24, 0.16, 0.44); },
  connected: () => { sfxTap(2200, 1.6, 0.02, 0.45); sfxTap(3600, 1.6, 0.03, 0.5, 0.07); sfxTone(660, 990, 0.003, 0.14, 0.13, 0.07); },
  ended: () => { sfxTap(3000, 1.6, 0.02, 0.4); sfxTap(1800, 1.4, 0.03, 0.42, 0.09); sfxTone(392, 262, 0.003, 0.18, 0.14, 0.09); },
  lost: () => { sfxTap(2600, 1.5, 0.02, 0.45); sfxTap(2000, 1.5, 0.02, 0.45, 0.08); sfxTap(1500, 1.4, 0.03, 0.48, 0.16); sfxTone(440, 294, 0.004, 0.28, 0.16, 0.16); },
  back: () => { sfxTap(2600, 1.6, 0.02, 0.4); sfxTone(587, 587, 0.003, 0.08, 0.12, 0.02); sfxTone(880, 880, 0.003, 0.14, 0.12, 0.1); },
  denied: () => { sfxTap(3000, 1.6, 0.02, 0.45); sfxTap(1600, 1.4, 0.035, 0.5, 0.075); sfxTone(150, 80, 0.002, 0.08, 0.34, 0.075); },
  chatIn: () => { sfxTap(3200, 2, 0.018, 0.4); sfxTone(988, 988, 0.003, 0.07, 0.13, 0.01); sfxTone(1319, 1319, 0.003, 0.12, 0.13, 0.08); },
  fileDone: () => { sfxTap(2800, 1.6, 0.02, 0.4); sfxTone(784, 784, 0.003, 0.07, 0.12, 0.02); sfxTone(1047, 1047, 0.003, 0.07, 0.12, 0.09); sfxTone(1319, 1319, 0.003, 0.16, 0.12, 0.16); },
  fileFail: () => { sfxTap(2000, 1.4, 0.03, 0.45); sfxTone(392, 392, 0.003, 0.1, 0.15, 0.02); sfxTone(311, 311, 0.003, 0.2, 0.15, 0.12); },
  good: () => { sfxTap(3000, 1.8, 0.018, 0.38); sfxTone(1047, 1047, 0.003, 0.1, 0.11, 0.01); },
  bad: () => { sfxTap(1400, 1.3, 0.04, 0.5); sfxTone(196, 147, 0.003, 0.14, 0.3, 0.01); },
  warn: () => { sfxTap(2400, 1.6, 0.02, 0.4); sfxTone(740, 740, 0.003, 0.07, 0.12, 0.01); sfxTone(740, 740, 0.003, 0.09, 0.12, 0.12); },
  update: () => { sfxTap(3400, 2, 0.016, 0.3); sfxTone(659, 659, 0.004, 0.12, 0.1, 0.02); sfxTone(880, 880, 0.004, 0.2, 0.1, 0.13); },
  shot: () => { sfxTap(5000, 2.4, 0.012, 0.4); sfxTap(1200, 1, 0.05, 0.35, 0.05); },
  recOn: () => { sfxTap(2800, 1.6, 0.018, 0.35); sfxTone(880, 880, 0.004, 0.16, 0.12, 0.01); },
  recOff: () => { sfxTap(2200, 1.6, 0.018, 0.35); sfxTone(587, 587, 0.004, 0.16, 0.12, 0.01); },
};
let _sndAt = 0;   // when TryDesk last made any sound (a notice right after a click or an event stays quiet)
// A session through the TryDesk service is shown here as svcMirror (declared further down: read safely)
function svcMirrorOn() { try { return !!svcMirror; } catch { return false; } }
function uiSound(name, force = false) {
  if (!force && (!prefGet("snd") || !prefGet("uiSound") || host || svcMirrorOn() || viewerSessions().some((s) => s.pc))) return;
  _sndAt = Date.now();
  try { (SFX[name] || SFX.click)(); } catch {}
}
// Which switch in Settings → Suara each event follows.
const SND_GROUP = { request: "notifySound", connected: "notifySound", ended: "notifySound", lost: "notifySound", back: "notifySound", denied: "notifySound",
  chatIn: "sndChat", fileDone: "sndFile", fileFail: "sndFile", good: "sndNotice", bad: "sndNotice", warn: "sndNotice", shot: "sndNotice",
  recOn: "sndNotice", recOff: "sndNotice", update: "sndUpdate" };
const _sndLast = {};
function playEvent(name, again = false, sess = null) {   // (sess: the session the event belongs to, for its own mute)
  try {
    if (!SFX[name] || !prefGet("snd")) return false;
    const g = SND_GROUP[name]; if (g && !prefGet(g)) return false;
    // This PC is being controlled (here, or through the TryDesk service: svcMirror): everything it plays travels to
    // the other side, so only a new request sounds here.
    if ((host || svcMirrorOn()) && name !== "request") return false;
    // "ended" right after another sound (a red notice that closed the session) stays quiet: one sound per moment
    if (name === "ended" && Date.now() - _sndAt < 400) return false;
    if (viewerSessions().some((s) => s.pc)) {
      const s = sess || active;
      if (s && s.sndOff && name !== "request") return false;   // Control Center › Suara › Bunyi selama sesi ini
      if (_gameActive && prefGet("sndQuietGame") && name !== "lost" && name !== "request") return false;
      if (document.documentElement.classList.contains("fs-session") && prefGet("sndQuietFs") && (name === "good" || name === "warn")) return false;
    }
    // The same event at most once per 2 s (a burst of chat messages: once per 3 s).
    const now = Date.now();
    if (!again && now - (_sndLast[name] || 0) < (name === "chatIn" ? 3000 : 2000)) return false;
    _sndLast[name] = now; _sndAt = now;
    SFX[name]();
    return true;
  } catch { return false; }
}
// Settings → Suara → Coba: a sample at the chosen volume, even right after another sound.
$("#btn-snd-try")?.addEventListener("click", () => { _sndAt = Date.now(); try { SFX.chatIn(); } catch {} });
// A green or red notice sounds unless something else just did (the event it belongs to, or the click that caused it).
function noticeSound(kind) {
  if (kind !== "good" && kind !== "bad") return;
  const at = Date.now();
  setTimeout(() => { try { if (_sndAt < at - 400) playEvent(kind); } catch {} }, 0);
}
document.addEventListener("click", (e) => {
  if (!e.target.closest) return;
  for (const [name, sel] of Object.entries(SOUND_SEL)) {
    const b = e.target.closest(sel);
    if (b && !b.disabled && !(name === "switch" && b.classList.contains("active"))) { uiSound(name); return; }
  }
}, true);

// ─── Event listeners ──────────────────────────────────────
$("#btn-connect").addEventListener("click", initiateConnection);
$("#recent-sort").addEventListener("change", (e) => { recentSort = e.target.value; renderRecent(); renderFavorites(); });
$$(".sess-tab").forEach((b) => b.addEventListener("click", () => { homeTab = b.dataset.sess; store.set("homeTab", homeTab); renderSessionsView(); }));
$("#sess-search").addEventListener("input", () => { renderRecent(); renderFavorites(); });
$("#sess-search").addEventListener("keydown", (e) => { if (e.key === "Escape" && e.target.value) { e.stopPropagation(); e.target.value = ""; renderRecent(); renderFavorites(); } });
// Connect and open the File Manager as soon as the session's file channel is up (as "Transfer file" on a tile).
$("#btn-connect-files").addEventListener("click", () => {
  const s = initiateConnection();
  if (!(s instanceof Session)) return;
  if (s.fileChannel && s.fileChannel.readyState === "open") openFileManager();
  else s.openFilesWhenReady = true;
});
$("#recent-clear").addEventListener("click", clearRecent);
$("#rs-all").addEventListener("click", () => setDevicesOpen(true));
$("#dev-back").addEventListener("click", () => setDevicesOpen(false));
$("#fact-lan-help").addEventListener("click", (e) => { e.stopPropagation(); $("#btn-lan-help").click(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.documentElement.classList.contains("devices-open") && !tileMenuEl && !document.querySelector(".tile-rename")) setDevicesOpen(false);
}, true);   // capture: runs before the tile menu's own Escape, so Escape on an open menu closes only the menu
// The ⋮ beside grid/list (concept): sorting and "clear all" in one small menu, same look as a tile's menu.
$("#recent-more").addEventListener("click", (e) => {
  e.stopPropagation();
  if (tileMenuEl) { closeTileMenu(); return; }
  closeAllMenus();
  const btn = e.currentTarget, phone = isPhoneUi();
  const check = `<polyline points="20 6 9 17 4 12"/>`;
  const items = [
    ["head", "Urutkan"],
    ["Terbaru", recentSort === "recent" ? check : "", () => { const s = $("#recent-sort"); s.value = "recent"; s.dispatchEvent(new Event("change")); }],
    ["Nomor ID", recentSort === "id" ? check : "", () => { const s = $("#recent-sort"); s.value = "id"; s.dispatchEvent(new Event("change")); }],
  ];
  // Phone (complete concept): grid / list live in this menu instead of two buttons on the row.
  if (phone) items.push("-", ["head", "Tampilan"],
    ["Grid", recentView === "grid" ? check : "", () => $("#view-grid").click()],
    ["Daftar", recentView === "list" ? check : "", () => $("#view-list").click()]);
  if (homeTab === "recent" && getRecent().length) items.push("-", ["Hapus semua riwayat", TILE_ICON.remove, clearRecent, true]);
  const m = document.createElement("div");
  m.className = "tile-menu"; m.setAttribute("role", "menu"); m.tabIndex = -1;
  for (const it of items) {
    if (it === "-") { const sep = document.createElement("div"); sep.className = "tile-menu-sep"; m.appendChild(sep); continue; }
    if (it[0] === "head") { const h = document.createElement("div"); h.className = "tile-menu-head"; h.textContent = it[1]; m.appendChild(h); continue; }
    const [label, icon, fn, danger] = it;
    const b = document.createElement("button");
    b.className = "cc-item" + (danger ? " danger" : ""); b.setAttribute("role", "menuitem");
    b.innerHTML = tileSvg(icon || ""); b.append(document.createTextNode(label));
    b.addEventListener("click", (ev) => { ev.stopPropagation(); closeTileMenu(); fn(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  tileMenuEl = m;
  if (!phone) {
    const r = btn.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
    let top = r.bottom + 4; if (top + h > innerHeight - 8) top = Math.max(8, r.top - 4 - h);
    m.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`; m.style.top = `${top}px`;
  }
  m.focus({ preventScroll: true });
});
$("#view-grid").addEventListener("click", () => { recentView = "grid"; store.set("recentView", "grid"); applyRecentView(); });
$("#view-list").addEventListener("click", () => { recentView = "list"; store.set("recentView", "list"); applyRecentView(); });
$("#btn-cancel-connect").addEventListener("click", () => { if (active) { stopReconnect(active.peerId); closeSession(active, false); } });
$("#btn-disconnect").addEventListener("click", () => { if (active) closeSession(active, true); });
$("#btn-stop-hosting").addEventListener("click", () => { if (host) closeSession(host, true); else if (svcMirror) { try { window.electronAPI.svcCmd({ cmd: "disconnect" }); } catch {} } });

// ─── One TryDesk with the service, the user's app side (see main.js "One TryDesk") ───
// The service's request and session are shown here, in this TryDesk, with the same dialog and screen as a session of
// its own: Accept / Reject, "this desktop is being controlled", the timer, Chat, Disconnect. The answers go back to
// the service. A session of this app itself (none while the service runs) is never touched.
let svcMirror = null;            // the service's session shown here: { peerId, fromName, chatLog, mirror: true, role: "host" }
let svcMirrorReq = 0, svcMirrorChatSeen = 0, svcMirrorReqEnd = null;
function svcMirrorEndRequest() { if (svcMirrorReqEnd) { const f = svcMirrorReqEnd; svcMirrorReqEnd = null; f(); } }
function svcMirrorShowRequest(seq, r) {
  svcMirrorEndRequest();
  svcMirrorReq = seq;
  const alias = stripBidi(String(r.name || "")).trim(), named = alias && alias !== "TryDesk User";
  $("#accept-id").textContent = String(r.id || "");
  $("#accept-alias").textContent = trL(`${named ? alias : "Seseorang"} ingin mengontrol desktop ini.`, `${named ? alias : "Someone"} wants to control this desktop.`);
  setAcceptHint(r.hint || "");
  const p = r.perms || {};
  $("#accept-perm-control").classList.toggle("hidden", !p.control);
  $("#accept-perm-files").classList.toggle("hidden", !p.files);
  $("#accept-perm-clipboard").classList.toggle("hidden", !p.clipboard);
  const ov = $("#overlay-accept"), bar = $("#accept-timer-bar"), countEl = $("#accept-countdown");
  const until = Number(r.until) || Date.now() + ACCEPT_TIMEOUT * 1000;
  const tick = () => {
    const left = Math.max(0, Math.round((until - Date.now()) / 1000));
    bar.style.width = `${(left / ACCEPT_TIMEOUT) * 100}%`;
    if (countEl) countEl.textContent = `Ditolak otomatis dalam ${left} detik`;
    if (left <= 0) svcMirrorEndRequest();   // the service times it out too
  };
  tick(); const timer = setInterval(tick, 1000);
  closeLanHelp();   // never behind the help
  ov.classList.remove("hidden");
  try { window.electronAPI.focusWindow(true); } catch {}   // on top until answered, as for a request of its own
  if (!document.hasFocus() && prefGet("notifyIncoming")) {
    try { new Notification(tr("Permintaan koneksi masuk"), { body: (named ? alias + " · " : "") + fmtId(String(r.id || "")), silent: true }); } catch {}
  }
  requestSound(ov);
  const acc = $("#btn-accept"), rej = $("#btn-reject");
  const answer = (cmd) => () => { try { window.electronAPI.svcCmd({ cmd, req: seq }); } catch {} svcMirrorEndRequest(); };
  const onAcc = answer("accept"), onRej = answer("reject");
  acc.addEventListener("click", onAcc); rej.addEventListener("click", onRej);
  svcMirrorReqEnd = () => {
    clearInterval(timer); ov.classList.add("hidden");
    acc.removeEventListener("click", onAcc); rej.removeEventListener("click", onRej);
    try { window.electronAPI.focusWindow(false); } catch {}
  };
}
function svcMirrorShowSession(s, chat) {
  const id = String(s.id || "");
  if (!svcMirror || svcMirror.peerId !== id) {
    svcMirror = { peerId: id, fromName: String(s.name || ""), chatLog: [], chatUnread: false, mirror: true, role: "host", sid: "svc" };
    svcMirrorChatSeen = 0;
    paintHostingWho(id, svcMirror.fromName);
    document.documentElement.classList.add("svc-mirror");
    startHostingTimer(); hostingStartTime = Number(s.since) || Date.now();
    if (!viewerSessions().some((x) => x.pc)) showScreen("hosting");   // not over this app's own remote view
  }
  for (const m of chat || []) if (m && m.seq > svcMirrorChatSeen) { svcMirrorChatSeen = m.seq; onChatReceived(svcMirror, String(m.text || "")); }
}
// Transfers of the service's session, drawn with the same cards as a session of this app.
const svcMirrorCards = new Map();   // id -> { card, state }
function svcMirrorXfers(list) {
  const seen = new Set();
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || typeof x.id !== "string") continue;
    seen.add(x.id);
    let m = svcMirrorCards.get(x.id);
    if (!m) {
      const incoming = x.dir === "recv" && x.state === "offer";
      const card = createCard(svcMirror || { sid: "svc" }, x.id, { dir: x.dir === "send" ? "send" : "recv", name: String(x.name || "file"), size: Number(x.size) || 0, incoming });
      if (incoming) {
        card.onAccept = () => { try { window.electronAPI.svcCmd({ cmd: "file-accept", text: x.id }); } catch {} card.toProgress(); card.setSub("Menyimpan ke Unduhan\\TryDesk..."); };
        card.onReject = () => { try { window.electronAPI.svcCmd({ cmd: "file-reject", text: x.id }); } catch {} card.remove(); };
      }
      m = { card, state: "" }; svcMirrorCards.set(x.id, m);
    }
    if (x.state === "progress") m.card.progress(Number(x.done) || 0, Number(x.size) || 0);
    else if (x.sub && x.state !== "ok" && x.state !== "fail") m.card.setSub(String(x.sub));
    if ((x.state === "ok" || x.state === "fail") && m.state !== x.state) { if (x.sub) m.card.setSub(String(x.sub)); m.card.finish(x.state === "ok"); }
    m.state = x.state;
  }
  // gone from the service's list: finished cards remove themselves; an unanswered offer that vanished goes now
  for (const [id, m] of svcMirrorCards) if (!seen.has(id)) { if (m.state !== "ok" && m.state !== "fail") m.card.remove(); svcMirrorCards.delete(id); }
}
// Send from this TryDesk during the service's session: the picked files go to the outbox one by one.
async function svcMirrorSendFiles(dropped) {
  const files = dropped || await window.electronAPI.filePick();
  for (const f of files) {
    let r = null; try { r = await window.electronAPI.svcOutboxPut(f.path); } catch {}
    if (!r) { showToast("File tidak bisa disiapkan untuk dikirim"); continue; }
    try { window.electronAPI.svcCmd({ cmd: "file-send", text: r.id }); } catch {}
    // one at a time, as in a session of this app: wait until the service reports this file finished
    const t0 = Date.now();
    while (svcMirror && Date.now() - t0 < 3600e3) {
      await sleep(500);
      const done = [...svcMirrorCards.values()].some((m) => m.card.el.querySelector(".tc-name")?.textContent === r.name && (m.state === "ok" || m.state === "fail"));
      if (done || (Date.now() - t0 > 15000 && ![...svcMirrorCards.values()].some((m) => m.card.el.querySelector(".tc-name")?.textContent === r.name))) break;
    }
  }
}
// This TryDesk was opened by the service's window (its Pengaturan / Kirim file): do what was asked there. For files,
// the service's session shows here first (svc-ui, within a few seconds), then the file dialog opens for it.
window.electronAPI?.onSvcOpen?.(async (what) => {
  for (let i = 0; i < 50 && !config; i++) await sleep(200);
  if (config && config.serviceHost) return;
  if (what === "settings") { if (overlaySettings.classList.contains("hidden")) toggleSettings(); return; }
  if (what === "files") {
    for (let i = 0; i < 75 && !(svcMirror && !document.hidden); i++) await sleep(200);
    if (svcMirror) svcMirrorSendFiles(); else showToast("Tidak ada sesi lewat layanan Windows saat ini");
  }
});
function svcMirrorEnd() {
  svcMirrorEndRequest();
  svcMirrorXfers([]);
  if (!svcMirror) return;
  const m = svcMirror; svcMirror = null;
  document.documentElement.classList.remove("svc-mirror");
  if (!host) stopHostingTimer();
  if (chatOpen() && !host && !active) closeChat();   // it was this session's chat
  if (!host && !$("#screen-hosting").classList.contains("hidden")) showScreen("home");
}
function onSvcUi(ui) {
  if (!ui || window.TD_MOBILE || (config && config.serviceHost)) return;
  if (ui.state === "request" && ui.req && ui.seq) {
    if (Number(ui.req.until) > Date.now() && ui.seq !== svcMirrorReq) svcMirrorShowRequest(ui.seq, ui.req);
  } else if (ui.state === "session" && ui.sess) { svcMirrorEndRequest(); svcMirrorShowSession(ui.sess, ui.chat); svcMirrorXfers(ui.xfers); }
  else svcMirrorEnd();
}
window.electronAPI?.onSvcUi?.(onSvcUi);

// Grip bar buttons (mini titlebar during remote)
$("#grip-minimize").addEventListener("click", () => window.electronAPI.minimizeWindow());
$("#grip-maximize").addEventListener("click", () => window.electronAPI.maximizeWindow());
$("#grip-close").addEventListener("click", () => { if (active) closeSession(active, true); });

// The whole page goes fullscreen, not just the remote view: chat, file manager, transfer cards, key combos and
// toasts are page-level layers and would otherwise be invisible (while chat still took the keyboard).
$("#btn-fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});

$("#remote-canvas-container").addEventListener("mousedown", () => { if (_kbReleased) { _kbReleased = false; refreshKeyCapture(); } }, true);
$("#back-to-session").addEventListener("click", (e) => { const s = e.currentTarget._target; if (s && sessions.get(s.peerId) === s) switchTab(s); });

// ─── Remote toolbar: Control Center + monitor dropdowns ───
function positionMenu(menu, btn) {
  const r = btn.getBoundingClientRect();
  menu.style.top = Math.round(r.bottom + 8) + "px";
  // right-align under the trigger, clamped to the viewport
  const left = Math.min(Math.max(8, r.right - menu.offsetWidth), window.innerWidth - menu.offsetWidth - 8);
  menu.style.left = Math.round(left) + "px";
}
let ccFlyoutCat = null, ccFlyoutRow = null;
function closeAllMenus() {
  // The docked Control Center (desktop) is a panel, not a menu: it stays until Control Center or its × is pressed.
  if (!(typeof ccDocked !== "undefined" && ccDocked)) $("#control-center")?.classList.add("hidden");
  $("#cc-flyout")?.classList.add("hidden");
  $("#monitor-menu")?.classList.add("hidden");
  if (!(typeof ccDocked !== "undefined" && ccDocked)) $("#btn-control-center")?.classList.remove("open");
  $("#btn-monitor")?.classList.remove("open");
  ccFlyoutCat = null; ccFlyoutRow = null;
}

// ─── Nested Control Center (StarDesk-style categories + flyouts) ───
const ccSvg = (inner, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${inner}</svg>`;
const CC_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`;
const CC_ICON = {
  monitor: `<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>`,
  quality: `<path d="M3 12h4l3-9 4 18 3-9h4"/>`,
  window: `<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>`,
  sound: `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14"/>`,
  security: `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>`,
  more: `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>`,
  x: `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`,
};
const CC_PRESET_LABELS = { hemat: "Hemat", seimbang: "Seimbang", kualitas: "Kualitas", ultra: "Ultra", gaming: "Gaming", maksimal: "Maksimal" };
const CC_SCALES = [["fit", "Pas jendela"], ["1", "100%"], ["0.75", "75%"], ["0.5", "50%"], ["1.5", "150%"], ["2", "200%"]];
const CC_CATS = [
  { key: "monitor", label: "Monitor", value: () => !active ? "" : active.monMode === "all" ? "Semua monitor" : active.monMode === "windows" ? "Jendela terpisah" : `Monitor ${active.currentMonitor + 1}` },
  { key: "quality", label: "Kualitas gambar", value: () => { const m = ccPresetMatch(); return m ? CC_PRESET_LABELS[m] : `${qualityOf().fps} FPS`; } },
  { key: "window", label: "Tampilan", value: () => { const s = CC_SCALES.find(([v]) => v === scaleMode); return s ? s[1] : ""; } },
  { key: "sound", label: "Suara" },
  { key: "security", label: "Keamanan" },
  { key: "more", label: "Fitur lainnya" },
];
function ccPresetMatch() { const q = qualityOf(); const e = Object.entries(PRESETS).find(([, p]) => p.bitrate === q.bitrate && p.fps === q.fps && p.resHeight === q.resHeight); return e ? e[0] : null; }
function ccStatsShown() { return !statsOverlay.classList.contains("hidden"); }
// Control Center › Fitur lainnya › Kombinasi tombol opens the panel (Arah B); it stays until closed.
function ccShowKeyMenu() { openKeysPanel(); }
function ccToggleStats() {
  const on = !ccStatsShown();
  statsOverlay.classList.toggle("hidden", !on);
  const cb = $("#stats-toggle"); if (cb) cb.checked = on;
  store.set("showStats", on ? "1" : "0");
}
function ccToggleClipboard() {
  clipboardSync = !clipboardSync;
  const cb = $("#clipboard-toggle"); if (cb) cb.checked = clipboardSync;
  store.set("clipboardSync", clipboardSync ? "1" : "0");
  restartClipboardAll();
  showToast(clipboardSync ? "Sinkron clipboard aktif" : "Sinkron clipboard mati");
}

function ccItems(cat) {
  const sess = active;
  switch (cat) {
    case "monitor":
      if (!sess || !sess.monitors.length) return [{ label: "Hanya 1 monitor terdeteksi", disabled: true }];
      return sess.monitors.map((m) => ({
        label: `Monitor ${m.index + 1}${m.primary ? " · utama" : ""}`,
        active: m.index === sess.currentMonitor && (sess.monMode || "single") === "single",
        run: () => viewerSelectMonitor(sess, m.index),
      }));
    case "quality": {
      const q = qualityOf();
      const out = [{ header: "Preset" }];
      const pm = ccPresetMatch();
      for (const [k, label] of Object.entries(CC_PRESET_LABELS)) out.push({ label, active: pm === k, run: () => setQuality(PRESETS[k]) });
      out.push({ divider: true }, { header: "Frame rate" });
      for (const f of [30, 60, 120, 144, 165, 180, 240]) out.push({ label: `${f} FPS`, active: q.fps === f, run: () => setQuality({ fps: f }) });
      out.push({ divider: true }, { header: "Resolusi" });
      for (const [v, label] of [[0, "Asli"], [1080, "1080p"], [720, "720p"], [480, "480p"]]) out.push({ label, active: q.resHeight === v, run: () => setQuality({ resHeight: v }) });
      out.push({ divider: true }, { header: "Codec" });
      for (const [v, label] of [["auto", "Otomatis"], ["AV1", "AV1 (hemat)"], ["VP9", "VP9"], ["VP8", "VP8"], ["H265", "H.265"], ["H264", "H.264"]]) out.push({ label, active: q.codec === v, run: () => setQuality({ codec: v }, { reconnectCodec: true }) });
      out.push({ divider: true }, { label: "Pengaturan lanjutan…", close: true, run: () => $("#btn-quality").click() });
      return out;
    }
    case "window":
      return CC_SCALES.map(([v, label]) => ({ label, active: scaleMode === v, run: () => { scaleMode = v; if (active) active.scaleMode = v; const s = $("#scale-select"); if (s) s.value = v; applyScale(); } }));
    case "sound": {
      const out = !sess || !sess.audioAvailable ? [{ label: "Audio tidak tersedia di remote", disabled: true }]
        : [{ label: sess.audioOn ? "Matikan audio remote" : "Aktifkan audio remote", active: sess.audioOn, run: toggleAudio }, { slider: true }];
      // TryDesk's own sounds for this session only (concept "Suara", 19 Nov); Settings → Suara stays as it is.
      if (sess) out.push({ divider: true }, { header: "Bunyi TryDesk" },
        { label: "Bunyi selama sesi ini", active: !sess.sndOff, run: () => { sess.sndOff = !sess.sndOff; ccRefreshFlyout(); } });
      return out;
    }
    case "security":
      return [
        { label: "Mode lihat saja", active: !!sess && sess.viewOnly, run: () => $("#btn-viewonly").click() },
        { label: "Gelapkan layar host", active: !!sess && sess.blackScreenActive, run: toggleBlackScreen },
        { label: "Kunci input host", active: !!sess && sess.inputLocked, run: toggleLockInput },
        // Before opening something that asks for administrator rights (an installer), not only once the banner says so.
        ...(sess && sess.hostElev && !ELEV_PENDING.has(sess.elevState) ? [{ label: "Minta akses admin", close: true, run: requestElevation }] : []),
      ];
    case "more":
      // Two groups (owner, 7 Nov: the mixed list looked untidy): the four things that open something, then the
      // four on/off switches. One line between the groups, none between rows.
      return [
        { label: "Transfer file", close: true, run: openFileManager },
        { label: "Chat", close: true, run: toggleChat },
        { label: "Kombinasi tombol", close: true, run: ccShowKeyMenu },
        { label: "Ambil screenshot", close: true, run: takeScreenshot },
        { divider: true },
        { label: _gameActive ? "Mode game: AKTIF (klik mematikan)" : "Mode game (mouse)", active: _gameActive, close: true, run: toggleGameMode },
        { label: isRecording() ? "Hentikan rekaman" : "Rekam sesi", active: isRecording(), run: toggleRecording },
        { label: "Tampilkan statistik", active: ccStatsShown(), run: ccToggleStats },
        { label: "Sinkron clipboard", active: clipboardSync, run: ccToggleClipboard },
      ];
  }
  return [];
}

// Direction A: the session's live numbers open Control Center, big with a small red unit (as in the portfolio
// video). They are read from the stats widgets pollStats already fills for the active tab, every second.
const CC_STATS = [["cc-st-fps", "fps", "gambar"], ["cc-st-lat", "ms", "jeda"], ["cc-st-mbps", "Mbps", "data"]];
function ccSyncStats() {
  const f = $("#cc-st-fps"); if (!f || $("#control-center").classList.contains("hidden")) return;
  const num = (sel) => { const m = /\d+(\.\d+)?/.exec($(sel)?.textContent || ""); return m ? m[0] : null; };
  const mb = num("#stat-bitrate");
  f.textContent = num("#stat-fps") ?? "-";
  $("#cc-st-lat").textContent = num("#stat-latency") ?? "-";
  $("#cc-st-mbps").textContent = mb == null ? "-" : String(Math.round(parseFloat(mb)));
}
// ─── Control Center as a panel docked on the right (desktop) ───
// The remote picture gets narrower, nothing is covered; it stays open until Control Center or its × is pressed. Full
// screen and the phone open the same content as a menu. "Pengaturan lanjutan" opens the quality panel in the same place.
let ccDocked = false;
const ccDockMode = () => !isPhoneUi() && !document.documentElement.classList.contains("fs-session");
function ccSetDocked(on) {
  ccDocked = !!on && ccDockMode();
  const cc = $("#control-center");
  cc.style.maxHeight = "";   // the full-screen limit (fsMenuAbove) must not follow the panel into the docked place
  // Leaving: keep the docked look until the panel has slid out (it used to turn into the floating menu for 140 ms).
  const leavingDocked = !ccDocked && cc.classList.contains("cc-panel-docked") && !cc.classList.contains("hidden") && !motionOff();
  if (!leavingDocked) cc.classList.toggle("cc-panel-docked", ccDocked);
  $("#screen-remote").classList.toggle("cc-docked", ccDocked || (!qualityPanel.classList.contains("hidden") && ccDockMode()));
  clearTimeout(ccSetDocked.t);
  cc.classList.remove("cc-leaving");
  if (ccDocked) { ccSub = null; ccRender(); cc.classList.remove("hidden"); $("#btn-control-center").classList.add("open"); ccSyncStats(); }
  else if (!cc.classList.contains("hidden") && !motionOff()) {
    // Out in a quarter beat (it came in on a half), then hidden; the screen widens back in the same move.
    cc.classList.add("cc-leaving"); $("#btn-control-center").classList.remove("open");
    ccSetDocked.t = setTimeout(() => { cc.classList.remove("cc-leaving"); if (!ccDocked) { cc.classList.add("hidden"); cc.classList.remove("cc-panel-docked"); } }, 140);
  } else { cc.classList.add("hidden"); $("#btn-control-center").classList.remove("open"); }
  try { applyScale(); } catch {}
}
function ccRefresh() { if (!$("#control-center").classList.contains("hidden")) { ccRender(); ccSyncStats(); } }
// Owner round 2 (6 Nov night): the OLD Control Center list (icon, name, value, ›) inside the panel. A category opens
// in the same panel with "‹ Control Center" to go back; the live numbers stay on top. One level, nothing floats.
let ccSub = null;
// ─── Control Center, Arah 1 "Daftar rapi" (owner pick 20 Nov 2026; gallery T23KjQs31TE59RR8Lk5ddJ, plan row D9bg) ───
// The same list in two cards; every row says how it stands; each page inside has one title pattern. Kualitas gambar
// is six presets plus three "Atur sendiri" rows that open in place, and Kualitas lanjutan is a page of its own.
let ccAcc = null;     // the open "Atur sendiri" row on Kualitas gambar: "fps" | "res" | "codec" | null
let ccFlash = null;   // the control just used: it gets a short move on the next render (the list is rebuilt each time)
const CCA_ICON = {
  display: `<rect x="3" y="4" width="18" height="14" rx="2"/><rect x="7.5" y="8" width="9" height="6" rx="1"/>`,
  fs: `<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>`, fsout: `<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>`,
  more: `<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="1.3" fill="currentColor" stroke="none"/>`,
  bell: `<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>`,
  sliders: `<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  eye: `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>`,
  moon: `<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>`,
  lock: `<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`,
  stats: `<path d="M5 20V11M12 20V5M19 20v-6"/>`,
  clip: `<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>`,
  game: `<rect x="2" y="7" width="20" height="11" rx="4"/><path d="M7 12.5h4M9 10.5v4M15.5 12h.01M18 14h.01"/>`,
  rec: `<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>`,
  folder: `<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`, chat: `<path d="M4 5h16v11H9l-5 4z"/>`,
  keys: `<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>`,
  camera: `<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>`,
  touch: `<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M5 15h14"/>`,
};
const CCA_ARROW = `<svg class="cca-ar" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`;
const CCA_DOWN = `<svg class="cca-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;
// Which "Fitur lainnya" item is a switch, its icon, and the short name the list row shows when it is on.
const CCA_MORE = [[/^Mode game/, "game", "Mode game"], [/^(Rekam sesi|Hentikan rekaman)$/, "rec", "Merekam"], [/^Tampilkan statistik$/, "stats", "Statistik"], [/^Sinkron clipboard$/, "clip", "Clipboard"]];
const CCA_OPEN = { "Transfer file": "folder", "Chat": "chat", "Kombinasi tombol": "keys", "Ambil screenshot": "camera" };
function ccBuildA1(cc, el) {
  const sess = active, phone = isPhoneUi();
  const rerender = () => { ccRender(); ccSyncStats(); };
  const go = (sub) => { ccSub = sub; rerender(); };
  // a short line of parts, each in its own node so the language map translates each word on its own
  const parts = (box, list, sep) => list.forEach((p, i) => { if (i) box.append(sep); const s = el("span"); s.textContent = p; box.append(s); });
  const card = (cls) => { const c = el("div", "cca-card" + (cls ? " " + cls : "")); cc.appendChild(c); return c; };
  const label = (text, extra) => { const l = el("div", "cca-lab"); const s = el("span"); s.textContent = text; l.append(s); if (extra) { const em = el("em"); em.textContent = extra; l.append(em); } cc.appendChild(l); return l; };
  const note = (text, into = cc) => { const p = el("p", "cca-note"); p.textContent = text; into.appendChild(p); return p; };
  const row = (box, { icon, title, sub, subList, hot, arrow = true, k, run, disabled }) => {
    const b = el("button", "cca-row"); b.type = "button"; if (k) b.dataset.k = k;
    b.innerHTML = `${icon ? ccSvg(icon) : ""}<span class="cca-tx"><b></b></span>${arrow ? CCA_ARROW : ""}`;
    b.querySelector("b").textContent = title;
    if (sub || subList) { const s = el("small", hot ? "hot" : ""); if (subList) parts(s, subList.list, subList.sep); else s.textContent = sub; b.querySelector(".cca-tx").append(s); }
    if (disabled) b.disabled = true; else b.addEventListener("click", (e) => { e.stopPropagation(); run(); });
    box.appendChild(b); return b;
  };
  const sw = (box, { icon, title, desc, on, k, run, disabled }) => {
    const b = el("button", "cca-row cca-sw" + (ccFlash === k ? " fl" : "")); b.type = "button"; b.dataset.k = k;
    b.setAttribute("role", "switch"); b.setAttribute("aria-checked", String(!!on));
    b.innerHTML = `${icon ? ccSvg(icon) : ""}<span class="cca-tx"><b></b></span><i class="ccp-tog${on ? " on" : ""}" aria-hidden="true"></i>`;
    b.querySelector("b").textContent = title;
    if (desc) { const s = el("small"); s.textContent = desc; b.querySelector(".cca-tx").append(s); }
    if (disabled) b.disabled = true; else b.addEventListener("click", (e) => { e.stopPropagation(); ccFlash = k; run(); rerender(); });
    box.appendChild(b); return b;
  };
  const radio = (box, { title, detail, on, k, run, two }) => {
    const b = el("button", "cca-rad" + (on ? " on" : "") + (two ? " two" : "") + (ccFlash === k ? " fl" : "")); b.type = "button"; b.dataset.k = k;
    b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(!!on));
    b.innerHTML = `<span class="cca-rd" aria-hidden="true"></span><span class="cca-tx"><b></b></span>`;
    b.querySelector("b").textContent = title;
    if (detail) { const s = el("em"); s.textContent = detail; b.querySelector(".cca-tx").append(s); }
    b.addEventListener("click", (e) => { e.stopPropagation(); ccFlash = k; run(); rerender(); });
    box.appendChild(b); return b;
  };
  const chips = (box, n, list) => {
    const g = el("div", "cca-chips"); g.style.setProperty("--n", n);
    for (const [k, text, on, run] of list) {
      const b = el("button", "cca-chip" + (on ? " on" : "") + (ccFlash === k ? " fl" : "")); b.type = "button"; b.textContent = text;
      b.setAttribute("aria-pressed", String(!!on));
      b.addEventListener("click", (e) => { e.stopPropagation(); ccFlash = k; run(); rerender(); });
      g.appendChild(b);
    }
    box.appendChild(g); return g;
  };
  const title = (text) => { const t = el("h3", "cca-title"); t.textContent = text; cc.appendChild(t); };
  const q = qualityOf(), pm = ccPresetMatch();
  const vol = Math.round(((activeVideo()?.volume) ?? 1) * 100);

  if (!ccSub) {
    // the live numbers in their own card (CC_STATS ids: ccSyncStats fills them every second)
    const st = el("div", "cc-stats");
    st.innerHTML = CC_STATS.map(([id, unit, lab]) => `<div><span class="cc-st-num"><b id="${id}">-</b><small>${unit}</small></span><span class="cc-st-label">${lab}</span></div>`).join("");
    cc.appendChild(st);
    const cat = (k) => CC_CATS.find((c) => c.key === k);
    const c1 = card();
    row(c1, { icon: CC_ICON.monitor, title: "Monitor", sub: cat("monitor").value(), k: "nav-monitor", run: () => go("monitor") });
    row(c1, { icon: CC_ICON.quality, title: "Kualitas gambar", subList: { list: [pm ? CC_PRESET_LABELS[pm] : "Atur sendiri", `${q.fps} fps`], sep: " · " }, k: "nav-quality", run: () => go("quality") });
    row(c1, { icon: CCA_ICON.display, title: "Tampilan", sub: cat("window").value(), k: "nav-window", run: () => go("window") });
    const c2 = card();
    const sndList = !sess || !sess.audioAvailable ? ["Tidak tersedia"] : sess.audioOn ? ["Menyala", `${vol}%`] : ["Mati"];
    row(c2, { icon: CC_ICON.sound, title: "Suara", subList: { list: sndList, sep: " · " }, k: "nav-sound", run: () => go("sound") });
    const secOn = ccItems("security").filter((it) => it.active).map((it) => ({ "Mode lihat saja": "Lihat saja", "Gelapkan layar host": "Layar digelapkan", "Kunci input host": "Input dikunci" }[it.label]));
    row(c2, { icon: CC_ICON.security, title: "Keamanan", subList: { list: secOn.length ? secOn : ["Semua mati"], sep: ", " }, hot: secOn.length > 0, k: "nav-security", run: () => go("security") });
    const moreOn = ccItems("more").filter((it) => it.active).map((it) => (CCA_MORE.find(([re]) => re.test(it.label)) || [])[2]).filter(Boolean);
    row(c2, { icon: CCA_ICON.more, title: "Fitur lainnya", subList: { list: moreOn.length ? moreOn : ["Semua mati"], sep: ", " }, k: "nav-more", run: () => go("more") });
    // back to Kelola banyak perangkat (owner 19 Nov: here, not as an extra button in the session bar); the phone too
    // since Kelola came to Android (21 Nov), the same way back as on a PC
    const c3 = card("cca-tight");
    row(c3, { icon: KM_ICON.grid, title: "Kelola banyak perangkat", sub: "Kembali ke daftar PC", k: "kelola",
      run: () => { ccSub = null; if (ccDocked) ccSetDocked(false); else ccClose(); showScreen("home"); setManageOpen(true); } });
    if (!phone) {
      const full = !!document.fullscreenElement;
      const f = row(c3, { icon: full ? CCA_ICON.fsout : CCA_ICON.fs, title: full ? "Keluar layar penuh" : "Layar penuh", arrow: false, k: "fs",
        run: () => { $("#btn-fullscreen").click(); if (!ccDocked) ccClose(); } });
      f.classList.add("cc-fs-leaf");
    }
    return;
  }
  if (ccSub === "monitor") { ccMonitorPanel(cc, el); return; }
  if (ccSub === "quality") {
    title("Kualitas gambar");
    const nl = el("p", "cca-now"); nl.innerHTML = `<span>sekarang</span>: <b id="cc-st-fps">-</b> fps · <b id="cc-st-lat">-</b> ms · <b id="cc-st-mbps">-</b> Mbps`; cc.appendChild(nl);
    label("Preset", pm ? "" : "Atur sendiri");
    const pc = card(); pc.setAttribute("role", "radiogroup");
    for (const [k, lab] of Object.entries(CC_PRESET_LABELS)) radio(pc, { title: lab, detail: `${PRESETS[k].fps} fps · ${PRESETS[k].bitrate} Mbps`, on: pm === k, k: "p-" + k, run: () => setQuality(PRESETS[k]) });
    label("Atur sendiri");
    const ac = card();
    const vrow = (key, name, value, n, list, after) => {
      const open = ccAcc === key;
      const b = el("button", "cca-row cca-vrow" + (open ? " open" : "")); b.type = "button"; b.setAttribute("aria-expanded", String(open)); b.dataset.k = "acc-" + key;
      b.innerHTML = `<span class="cca-tx"><b></b></span><span class="cca-val"></span>${CCA_DOWN}`;
      b.querySelector("b").textContent = name; b.querySelector(".cca-val").textContent = value;
      b.addEventListener("click", (e) => { e.stopPropagation(); ccAcc = open ? null : key; ccFlash = open ? null : "acc-open-" + key; rerender(); });
      ac.appendChild(b);
      if (!open) return;
      const wrap = el("div", "cca-acc" + (ccFlash === "acc-open-" + key ? " fl" : "")), inner = el("div", "cca-pad");
      chips(inner, n, list); if (after) note(after, inner);
      wrap.appendChild(inner); ac.appendChild(wrap);
    };
    vrow("fps", "Frame rate", `${q.fps} FPS`, 4, [30, 60, 120, 144, 165, 180, 240].map((f) => ["fps-" + f, String(f), q.fps === f, () => setQuality({ fps: f })]));
    vrow("res", "Resolusi", q.resHeight ? `${q.resHeight}p` : "Asli", 4, [[0, "Asli"], [1080, "1080p"], [720, "720p"], [480, "480p"]].map(([v, t]) => ["res-" + v, t, q.resHeight === v, () => setQuality({ resHeight: v })]));
    const CODECS = [["auto", "Otomatis"], ["AV1", "AV1"], ["VP9", "VP9"], ["VP8", "VP8"], ["H265", "H.265"], ["H264", "H.264"]];
    vrow("codec", "Codec video", (CODECS.find(([v]) => v === q.codec) || CODECS[0])[1], 3, CODECS.map(([v, t]) => ["codec-" + v, t, q.codec === v, () => setQuality({ codec: v }, { reconnectCodec: true })]), "Ganti codec menyambung ulang video sesaat.");
    const lc = card(); lc.classList.add("cca-gap");
    row(lc, { icon: CCA_ICON.sliders, title: "Kualitas lanjutan", subList: { list: ["Kecepatan (bitrate)", `${q.bitrate} Mbps`], sep: ": " }, k: "adv", run: () => go("adv") })
      .querySelector("small").classList.add("wrap");   // "Kecepatan (bitrate): 1000 Mbps" is longer than the row in some languages
    return;
  }
  if (ccSub === "adv") {
    title("Kualitas lanjutan");
    label("Kecepatan (bitrate)");
    const c = card();
    const s = el("div", "cca-sld");
    const r = document.createElement("input"); r.type = "range"; r.min = "1"; r.max = String(BITRATE_MAX_MBPS); r.value = String(Math.min(q.bitrate, BITRATE_MAX_MBPS)); r.setAttribute("aria-label", "Kecepatan (bitrate)");
    const o = el("output"); o.textContent = `${r.value} Mbps`;
    r.addEventListener("input", () => { o.textContent = `${r.value} Mbps`; });
    r.addEventListener("change", () => { setQuality({ bitrate: clampBitrate(r.value) }); });
    r.addEventListener("click", (e) => e.stopPropagation());
    s.append(r, o); c.appendChild(s);
    note("Geser 1–1000 Mbps. Nilai tinggi = gambar lebih tajam, butuh bandwidth besar. Di atas 300 Mbps hanya lewat jalur cepat UDP (Windows ke Windows, jaringan lokal).");
    const c2 = card(); c2.classList.add("cca-gap");
    sw(c2, { icon: CCA_ICON.stats, title: "Tampilkan statistik", on: ccStatsShown(), k: "sw-stats", run: ccToggleStats });
    if (!phone) sw(c2, { icon: CCA_ICON.clip, title: "Sinkron clipboard", on: clipboardSync, k: "sw-clip", run: ccToggleClipboard });
    return;
  }
  if (ccSub === "window") {
    title("Tampilan");
    if (!phone) note("Ukuran gambar PC itu di jendela ini.").classList.add("cca-lead");
    let c = card(); c.setAttribute("role", "radiogroup");
    ccItems("window").forEach((it, i) => {
      if (it.divider) { c = card(); c.classList.add("cca-gap"); return; }
      radio(c, { title: it.label, on: !!it.active, k: "w-" + i, run: () => { it.run(); if (it.close && !ccDocked) ccClose(); } });
    });
    return;
  }
  if (ccSub === "sound") {
    title("Suara");
    const c = card(); c.classList.add("cca-top");
    const avail = !!sess && sess.audioAvailable;
    sw(c, { icon: CC_ICON.sound, title: "Suara dari PC", desc: avail ? "" : "Audio tidak tersedia di remote", on: avail && sess.audioOn, k: "sw-snd", run: toggleAudio, disabled: !avail });
    if (avail) {
      const s = el("div", "cca-sld cca-vol");
      const r = document.createElement("input"); r.type = "range"; r.min = "0"; r.max = "100"; r.value = String(vol); r.setAttribute("aria-label", "Volume"); r.disabled = !sess.audioOn;
      const o = el("output"); o.textContent = `${vol}%`;
      r.addEventListener("input", () => { const v = activeVideo(); if (v) v.volume = r.value / 100; o.textContent = `${r.value}%`; });
      r.addEventListener("click", (e) => e.stopPropagation());
      s.append(r, o); c.appendChild(s);
    }
    if (sess) {
      label("Bunyi TryDesk");
      const c2 = card();
      sw(c2, { icon: CCA_ICON.bell, title: "Bunyi selama sesi ini", on: !sess.sndOff, k: "sw-td", run: () => { sess.sndOff = !sess.sndOff; } });
      note("Semua bunyi diatur di Pengaturan › Suara.");
    }
    return;
  }
  if (ccSub === "security") {
    title("Keamanan");
    const c = card(); c.classList.add("cca-top");
    const items = ccItems("security");
    const D = { "Mode lihat saja": [CCA_ICON.eye, "Klik dan ketikan Anda tidak dikirim."], "Gelapkan layar host": [CCA_ICON.moon, "Layar PC itu hitam selama sesi."], "Kunci input host": [CCA_ICON.lock, "Mouse dan keyboard PC itu tidak bisa dipakai."] };
    items.forEach((it, i) => { const [icon, desc] = D[it.label] || ["", ""]; sw(c, { icon, title: it.label, desc, on: !!it.active, k: "sec-" + i, run: it.run, disabled: it.disabled }); });
    return;
  }
  if (ccSub === "more") {
    title("Fitur lainnya");
    const items = ccItems("more").filter((it) => !it.divider && !it.header);
    const opens = items.filter((it) => CCA_OPEN[it.label]), toggles = items.filter((it) => CCA_MORE.some(([re]) => re.test(it.label)));
    if (opens.length) {
      label("Buka");
      const c = card("cca-tight");
      opens.forEach((it, i) => row(c, { icon: CCA_ICON[CCA_OPEN[it.label]], title: it.label, arrow: it.label !== "Ambil screenshot", k: "open-" + i,
        run: () => { if (it.run) it.run(); if (it.close && !ccDocked) ccClose(); else rerender(); } }));
    }
    if (toggles.length) {
      label("Nyala atau mati");
      const c = card("cca-tight");
      toggles.forEach((it, i) => { const [, icon, short] = CCA_MORE.find(([re]) => re.test(it.label));
        sw(c, { icon: CCA_ICON[icon], title: short === "Merekam" ? "Rekam sesi" : short === "Statistik" ? "Tampilkan statistik" : short === "Clipboard" ? "Sinkron clipboard" : "Mode game", on: !!it.active, k: "more-" + i,
          run: () => { if (it.run) it.run(); if (it.close && !ccDocked) ccClose(); } }); });
    }
  }
}
function ccRender() {
  const cc = $("#control-center");
  const keepScroll = cc.scrollTop;
  // Going into a category or back: the rows below the numbers slide in (half a beat). A switch flipping inside the
  // same view re-renders without moving.
  if (ccRender.last !== ccSub && !motionOff()) {
    cc.classList.remove("cc-swap", "cc-swap-back"); void cc.offsetWidth;
    cc.classList.add(ccSub ? "cc-swap" : "cc-swap-back");
    clearTimeout(ccRender.t); ccRender.t = setTimeout(() => cc.classList.remove("cc-swap", "cc-swap-back"), 400);
  }
  ccRender.last = ccSub;
  cc.replaceChildren();
  cc.classList.add("cc-panel");
  cc.classList.add("cc-a1");
  const pageChanged = ccRender.lastSub !== ccSub;
  if (pageChanged) ccAcc = null;   // an open "Atur sendiri" row closes when the page changes
  ccRender.lastSub = ccSub;
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  // Head
  const head = el("div", "ccp-head");
  if (ccSub) {
    const back = el("button", "ccp-back"); back.type = "button";
    back.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="15 18 9 12 15 6"/></svg><span></span>`;
    back.lastChild.textContent = ccSub === "adv" ? "Kualitas gambar" : "Control Center";
    back.addEventListener("click", (e) => { e.stopPropagation(); ccSub = ccSub === "adv" ? "quality" : null; ccRender(); ccSyncStats(); });
    head.appendChild(back);
  } else {
    const title = el("h3", "ccp-title"); title.textContent = "Control Center"; head.appendChild(title);
  }
  const x = el("button", "ccp-x"); x.type = "button"; x.innerHTML = ccSvg(CC_ICON.x, 15); x.title = "Tutup"; x.setAttribute("aria-label", "Tutup Control Center");
  x.addEventListener("click", (e) => { e.stopPropagation(); ccSub = null; if (ccDocked) ccSetDocked(false); else ccClose(); });
  head.appendChild(x); cc.appendChild(head);
  ccBuildA1(cc, el);
  cc.scrollTop = pageChanged ? 0 : keepScroll;
  ccFlash = null;
  if (document.documentElement.classList.contains("fs-session") && !cc.classList.contains("hidden") && !isPhoneUi()) fsMenuAbove(cc, $("#fsd-menu"));
}
function ccOpenAdvanced() {
  qualityPanel.classList.remove("hidden");
  $("#btn-quality").classList.add("active");
  syncQualityUI();
  $("#screen-remote").classList.toggle("cc-docked", ccDockMode());
  $("#control-center").classList.add("hidden");   // the advanced panel takes the same place; "‹ Control Center" brings it back
  try { applyScale(); } catch {}
}
function ccOpenFlyout(cat, rowEl) {
  ccFlyoutCat = cat; ccFlyoutRow = rowEl;
  const fly = $("#cc-flyout");
  fly.replaceChildren();
  for (const it of ccItems(cat)) {
    if (it.divider) { const d = document.createElement("div"); d.className = "cc-divider"; fly.appendChild(d); continue; }
    if (it.header) { const h = document.createElement("div"); h.className = "cc-flyout-header"; h.textContent = it.header; fly.appendChild(h); continue; }
    if (it.slider) {
      const w = document.createElement("div"); w.className = "cc-flyout-slider";
      const lab = document.createElement("span"); lab.textContent = "Volume";
      const r = document.createElement("input"); r.type = "range"; r.min = "0"; r.max = "100"; r.value = String(Math.round(((activeVideo()?.volume) ?? 1) * 100));
      r.addEventListener("input", () => { const v = activeVideo(); if (v) v.volume = r.value / 100; });
      r.addEventListener("click", (e) => e.stopPropagation());
      w.append(lab, r); fly.appendChild(w); continue;
    }
    const b = document.createElement("button"); b.className = "cc-leaf" + (it.active ? " active" : "");
    if (it.disabled) b.disabled = true;
    b.innerHTML = `<span class="cc-leaf-check">${it.active ? CC_CHECK : ""}</span><span>${it.label}</span>`;
    if (!it.disabled) b.addEventListener("click", (e) => { e.stopPropagation(); if (it.run) it.run(); if (it.close) ccClose(); else ccOpenFlyout(cat, rowEl); });
    fly.appendChild(b);
  }
  fly.classList.remove("hidden");
  ccPositionFlyout(fly, rowEl);
  $$("#control-center .cc-cat").forEach((r) => r.classList.toggle("open", r.dataset.cat === cat));
}

function ccPositionFlyout(fly, rowEl) {
  const panel = $("#control-center").getBoundingClientRect();
  const row = rowEl.getBoundingClientRect();
  const fw = fly.offsetWidth, fh = fly.offsetHeight;
  let left = panel.left - fw - 6;
  if (left < 8) left = Math.min(panel.right + 6, window.innerWidth - fw - 8);
  left = Math.max(8, Math.min(left, window.innerWidth - fw - 8));
  const top = Math.max(8, Math.min(row.top, window.innerHeight - fh - 8));
  fly.style.left = Math.round(left) + "px";
  fly.style.top = Math.round(top) + "px";
}

function ccClose() { closeAllMenus(); }

$("#btn-control-center").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("#control-center"), btn = $("#btn-control-center");
  if (ccDockMode()) { closeAllMenus(); ccSetDocked(!ccDocked); return; }
  const open = menu.classList.contains("hidden");
  closeAllMenus();
  if (open) { ccSub = null; ccRender(); menu.classList.remove("hidden"); btn.classList.add("open"); positionMenu(menu, btn); ccSyncStats(); }
});
$("#control-center").addEventListener("click", (e) => {
  const cat = e.target.closest(".cc-cat");
  e.stopPropagation();
  if (!cat) return;
  if (ccFlyoutCat === cat.dataset.cat) {
    $("#cc-flyout").classList.add("hidden");
    $$("#control-center .cc-cat").forEach((r) => r.classList.remove("open"));
    ccFlyoutCat = null; ccFlyoutRow = null;
  } else ccOpenFlyout(cat.dataset.cat, cat);
});
document.addEventListener("click", (e) => { if (!e.target.closest(".cc-wrap")) closeAllMenus(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAllMenus(); });
document.addEventListener("fullscreenchange", () => {
  const fs = !!document.fullscreenElement;
  $("#btn-fullscreen")?.classList.toggle("active", fs);
  // Keyboard Lock (fullscreen-only, browser limit) lets the remote view capture system shortcuts like
  // Alt+Tab, the Win key and Esc so they reach the host instead of the local OS. Outside fullscreen the
  // OS always grabs them, so system shortcuts forward only in fullscreen.
  try {
    if (fs && navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock();
    else if (!fs && navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
  } catch {}
  // Full screen has no session bar: a docked Control Center steps away (the dock's Menu opens the same content).
  if (fs && ccDocked) ccSetDocked(false);
  fsDockSync();
});

// ─── Full-screen dock (design direction C) ───
// In full screen the session bar steps away (html.fs-session) and #fs-dock floats at the bottom centre with the
// session's latency and the actions people reach for. It shows for 2 s after entering full screen and whenever the
// pointer comes within 90 px of the bottom edge; it stays while hovered, focused or while its menu is open.
// Every handler stops the click so the page-level "click outside closes menus" handlers don't undo it.
let fsDockTimer = null, fsWasOn = false, fsHintShown = false;
function fsDockSync() {
  const dock = $("#fs-dock"); if (!dock) return;
  const on = !!document.fullscreenElement && !$("#screen-remote").classList.contains("hidden") && !document.documentElement.classList.contains("td-mobile");
  document.documentElement.classList.toggle("fs-session", on);
  if (!on) { clearTimeout(fsDockTimer); dock.classList.add("hidden"); dock.classList.remove("at-top"); fsHandleSync(); fsWasOn = false; return; }
  const entering = !fsWasOn; fsWasOn = true;
  if (entering) {
    dock.classList.remove("at-top");
    // Once per app run: say where the menu is and how to leave (Esc itself goes to the remote PC in full screen).
    // (the chord is caught by the Windows key hook only; elsewhere the dock's Keluar button is the way out)
    // The shortcut only works where the Windows key hook runs: Windows, while this session has the keyboard.
    const chord = !!(config && config.platform === "win32" && active && !active.viewOnly && !active.hostViewOnly && !_kbReleased);
    const ex = $("#fsd-exit"); if (ex) ex.title = tr(chord ? "Keluar dari layar penuh (Ctrl+Alt+Shift+Esc)" : "Keluar dari layar penuh");
    if (!fsHintShown) { fsHintShown = true; showToast(chord ? "Menu sesi ada di tombol kecil di atas layar. Keluar dari layar penuh: Ctrl+Alt+Shift+Esc" : "Menu sesi ada di tombol kecil di atas layar, termasuk tombol Keluar dari layar penuh."); }
  }
  fsDockWake(entering ? 4000 : 2000);
}
// The tab at the top centre: always there in full screen, hidden only while the dock it opened sits under it.
function fsHandleSync() {
  const h = $("#fs-handle"), dock = $("#fs-dock"); if (!h || !dock) return;
  const fs = document.documentElement.classList.contains("fs-session");
  const dockTop = !dock.classList.contains("hidden") && dock.classList.contains("at-top");
  h.classList.toggle("hidden", !fs || dockTop);
  h.setAttribute("aria-expanded", String(!dock.classList.contains("hidden")));
}
function fsDockLabels() {
  const sess = active;
  $("#fsd-peer").textContent = sess ? (sess.label || fmtId(sess.peerId)) : "";
  $("#fsd-monitor-label").textContent = `Layar ${sess ? sess.currentMonitor + 1 : 1}`;
  $("#fsd-lat").innerHTML = $("#rt-latency-badge").innerHTML;   // <b>n</b> <small>ms</small> from setLatBadge
}
function fsDockWake(ms = 2000) {
  const dock = $("#fs-dock");
  if (!document.documentElement.classList.contains("fs-session")) return;
  fsDockLabels();
  dock.classList.remove("hidden");
  fsHandleSync();
  clearTimeout(fsDockTimer);
  fsDockTimer = setTimeout(() => {
    const busy = dock.matches(":hover") || dock.contains(document.activeElement) || !$("#control-center").classList.contains("hidden");
    if (busy) fsDockWake(); else { dock.classList.add("hidden"); fsHandleSync(); }
  }, ms);
}
// The menu sits on the far side of the dock from the screen edge: above a bottom dock (growing upwards), below a
// dock opened from the top tab. Never taller than the room it has (it scrolls inside instead), and placed again
// whenever its content changes (a category used to grow down under the dock, 7 Nov).
function fsMenuAbove(menu, btn) {
  menu.classList.remove("hidden");
  const r = btn.getBoundingClientRect();
  const below = $("#fs-dock").classList.contains("at-top");
  menu.style.maxHeight = `${Math.max(160, Math.round(below ? window.innerHeight - r.bottom - 18 : r.top - 18))}px`;
  menu.style.top = `${below ? Math.round(r.bottom + 10) : Math.max(8, r.top - menu.offsetHeight - 10)}px`;
  menu.style.left = `${Math.round(Math.min(Math.max(8, r.left + r.width / 2 - menu.offsetWidth / 2), window.innerWidth - menu.offsetWidth - 8))}px`;
  // a notice shown meanwhile stands left of this menu, bottoms level (style.css "Alert fixes" 3)
  const mr = menu.getBoundingClientRect(), root = document.documentElement.style;
  root.setProperty("--fsm-l", `${Math.round(mr.left)}px`); root.setProperty("--fsm-b", `${Math.round(window.innerHeight - mr.bottom)}px`);
}
document.addEventListener("mousemove", (e) => {
  // (pointer locked in game mode: clientY no longer moves, it must not wake the dock on every delta)
  if (!document.documentElement.classList.contains("fs-session") || document.pointerLockElement || e.clientY <= window.innerHeight - 90) return;
  const dock = $("#fs-dock");
  if (dock.classList.contains("at-top") && !dock.classList.contains("hidden")) return;   // opened from the top tab: stays there
  dock.classList.remove("at-top"); fsDockWake();
}, { passive: true });
$("#fs-handle")?.addEventListener("click", (e) => {
  e.stopPropagation();
  const dock = $("#fs-dock");
  if (!dock.classList.contains("hidden") && dock.classList.contains("at-top")) { closeAllMenus(); dock.classList.add("hidden"); fsHandleSync(); return; }
  closeAllMenus();
  dock.classList.add("at-top"); fsDockWake(4000);
});
const fsDockOn = (id, fn) => $(id).addEventListener("click", (e) => { e.stopPropagation(); fn(e); fsDockWake(); });
fsDockOn("#fsd-keys", () => { closeAllMenus(); toggleKeysPanel(); });
fsDockOn("#fsd-monitor", () => {
  const list = ccItems("monitor").filter((it) => it.run);
  if (list.length < 2) { showToast("Hanya 1 monitor terdeteksi"); return; }
  const i = list.findIndex((it) => it.active);
  list[(i + 1) % list.length].run();
});
fsDockOn("#fsd-menu", () => {
  const menu = $("#control-center"), open = menu.classList.contains("hidden");
  closeAllMenus();
  if (!open) return;
  ccSub = null; ccRender(); fsMenuAbove(menu, $("#fsd-menu")); ccSyncStats();
});
fsDockOn("#fsd-file", () => { closeAllMenus(); openFileManager(); });
fsDockOn("#fsd-chat", () => { closeAllMenus(); toggleChat(); });
fsDockOn("#fsd-exit", () => { closeAllMenus(); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); });
fsDockOn("#fsd-disconnect", () => { closeAllMenus(); $("#btn-disconnect").click(); });

// Session timer (per session; only the active tab writes to #session-timer)
function startSessionTimer(sess) {
  sess.sessionStart = Date.now();
  clearInterval(sess.sessionTimer);
  const tick = () => {
    const s = Math.max(0, Math.floor((Date.now() - sess.sessionStart) / 1000));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    const txt = (hh ? String(hh).padStart(2, "0") + ":" : "") + String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
    sess.timerText = txt;
    if (sess === active) { const el = $("#session-timer"); if (el) el.textContent = txt; }
  };
  tick(); sess.sessionTimer = setInterval(tick, 1000);
}
function stopSessionTimer(sess) {
  if (sess && sess.sessionTimer) { clearInterval(sess.sessionTimer); sess.sessionTimer = null; }
  if (sess) sess.timerText = "00:00";
  if (!active) { const el = $("#session-timer"); if (el) el.textContent = "00:00"; }
}

$("#btn-viewonly").addEventListener("click", () => {
  const sess = active; if (!sess) return;
  sess.viewOnly = !sess.viewOnly;
  $("#btn-viewonly").classList.toggle("active", sess.viewOnly);
  $("#remote-canvas-container").classList.toggle("viewonly", sess.viewOnly);
  showToast(sess.viewOnly ? "Mode lihat saja aktif" : "Kontrol aktif kembali");
  refreshKeyCapture();
});

// Quality panel open/close
$("#btn-quality").addEventListener("click", () => {
  if (qualityPanel.classList.contains("hidden")) { ccOpenAdvanced(); return; }
  qualityPanel.classList.add("hidden"); $("#btn-quality").classList.remove("active");
  if (ccDocked) ccSetDocked(true); else { $("#screen-remote").classList.remove("cc-docked"); try { applyScale(); } catch {} }
});
// "‹ Control Center": back to the panel underneath (it stays docked; in full screen it opens again above the dock).
$("#btn-quality-back").addEventListener("click", (e) => {
  e.stopPropagation();
  qualityPanel.classList.add("hidden"); $("#btn-quality").classList.remove("active");
  if (ccDockMode()) { ccSetDocked(true); ccSub = "quality"; ccRender(); ccSyncStats(); }
  else { ccRender(); $("#control-center").classList.remove("hidden"); if (!isPhoneUi()) fsMenuAbove($("#control-center"), $("#fsd-menu")); ccSyncStats(); }
});
$("#btn-quality-close").addEventListener("click", () => {
  qualityPanel.classList.add("hidden");
  if (ccDocked) ccSetDocked(false);
  $("#screen-remote").classList.remove("cc-docked"); try { applyScale(); } catch {}
  $("#btn-quality").classList.remove("active");
});

// View scale (applies to the active tab; each session's <video> binds its own resize listeners)
$("#scale-select").addEventListener("change", (e) => { scaleMode = e.target.value; if (active) active.scaleMode = scaleMode; applyScale(); });

// Presets
$$(".preset-btn").forEach((b) => b.addEventListener("click", () => setQuality(PRESETS[b.dataset.preset])));

// Bitrate slider + number
// Sliders (concept): a 4 px line, red up to the value, white knob with a red ring. The red part is a CSS variable
// kept in step with the value here, because a range input has no "filled part" of its own in Chromium.
function paintSlider(el) {
  if (!el) return;
  const min = Number(el.min) || 0, max = Number(el.max) || 100;
  el.style.setProperty("--pct", `${((Number(el.value) - min) / (max - min || 1)) * 100}%`);
}
document.addEventListener("input", (e) => { if (e.target.classList?.contains("slider")) paintSlider(e.target); });
document.querySelectorAll(".slider").forEach(paintSlider);
$("#bitrate-slider").addEventListener("input", (e) => { $("#bitrate-number").value = e.target.value; });
$("#bitrate-slider").addEventListener("change", (e) => setQuality({ bitrate: clampBitrate(e.target.value) }));
$("#bitrate-number").addEventListener("change", (e) => { const v = clampBitrate(e.target.value); e.target.value = v; $("#bitrate-slider").value = v; paintSlider($("#bitrate-slider")); setQuality({ bitrate: v }); });
function clampBitrate(v) { return Math.min(BITRATE_MAX_MBPS, Math.max(1, Math.round(+v) || 1)); }

// FPS + resolution chips
$$("#fps-row .chip").forEach((c) => c.addEventListener("click", () => setQuality({ fps: +c.dataset.fps })));
$$("#res-row .chip").forEach((c) => c.addEventListener("click", () => setQuality({ resHeight: +c.dataset.scale })));

// Codec
$("#codec-select").addEventListener("change", (e) => setQuality({ codec: e.target.value }, { reconnectCodec: true }));

// Stats toggle
$("#stats-toggle").addEventListener("change", (e) => {
  statsOverlay.classList.toggle("hidden", !e.target.checked);
  store.set("showStats", e.target.checked ? "1" : "0");
});

// Clipboard toggle
$("#clipboard-toggle").addEventListener("change", (e) => {
  clipboardSync = e.target.checked;
  store.set("clipboardSync", clipboardSync ? "1" : "0");
  restartClipboardAll();
  showToast(clipboardSync ? "Sinkron clipboard aktif" : "Sinkron clipboard mati");
});

// File transfer buttons
$("#btn-send-file").addEventListener("click", () => startSendFiles());
$("#btn-host-send-file").addEventListener("click", () => startSendFiles());

// Audio + monitor
$("#btn-audio").addEventListener("click", toggleAudio);
// Monitor switcher dropdown
$("#btn-monitor").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("#monitor-menu"), btn = $("#btn-monitor");
  const open = menu.classList.contains("hidden");
  closeAllMenus();
  if (open) { menu.classList.remove("hidden"); btn.classList.add("open"); positionMenu(menu, btn); }
});

// Chat
$("#btn-chat").addEventListener("click", toggleChat);
$("#btn-host-chat").addEventListener("click", toggleChat);
$("#btn-chat-close").addEventListener("click", closeChat);
$("#btn-chat-send").addEventListener("click", sendChat);
$("#chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
// Pictures and files in the chat: the paper clip, Ctrl+V in the typing box, or dropped on the chat
// Never in the service's window: it runs as SYSTEM, and the Windows "Open" dialog there could start any program as
// SYSTEM (security audit 22 Nov). The paper clip and the file input are removed there (init), this click checks it
// again, and fileInputGuard below refuses any file-input click while the config is unknown or in the service.
$("#btn-chat-attach").addEventListener("click", () => { if (!config || config.serviceHost) return; $("#chat-file-pick")?.click(); });
(function fileInputGuard() {
  const isFileInput = (t) => !!t && t.tagName === "INPUT" && String(t.type || "").toLowerCase() === "file";
  const stop = (e) => { if (isFileInput(e.target) && (!config || config.serviceHost)) { e.preventDefault(); e.stopImmediatePropagation(); } };
  window.addEventListener("click", stop, true);
  window.addEventListener("auxclick", stop, true);
  window.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && isFileInput(e.target) && (!config || config.serviceHost)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  // showPicker() bypasses click events: closed off here too (the page's CSP already allows no injected script).
  try { const sp = HTMLInputElement.prototype.showPicker; if (sp) HTMLInputElement.prototype.showPicker = function () { if (isFileInput(this) && (!config || config.serviceHost)) throw new DOMException("not available", "NotAllowedError"); return sp.call(this); }; } catch {}
})();
$("#chat-file-pick").addEventListener("change", (e) => { const fl = [...(e.target.files || [])]; e.target.value = ""; if (fl.length) chatSendFiles(fl); });
$("#chat-input").addEventListener("paste", (e) => {
  const fl = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (!fl.length) return;   // text pastes as usual
  e.preventDefault();
  chatSendFiles(fl);
});
{
  const panel = $("#chat-panel");
  let depth = 0;
  const files = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
  // (kept from the window's own drop, which would send the files to the remote PC instead)
  panel.addEventListener("dragenter", (e) => { if (!files(e)) return; e.preventDefault(); e.stopPropagation(); depth++; panel.classList.add("dropping"); setDropReady(false); });
  panel.addEventListener("dragover", (e) => { if (!files(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "copy"; });
  panel.addEventListener("dragleave", (e) => { if (!files(e)) return; e.stopPropagation(); if (--depth <= 0) { depth = 0; panel.classList.remove("dropping"); } });
  panel.addEventListener("drop", (e) => {
    if (!files(e)) return;
    e.preventDefault(); e.stopPropagation(); depth = 0; panel.classList.remove("dropping");
    _dragDepth = 0; setDropReady(false);   // the window's own drop never sees this one
    const fl = [...(e.dataTransfer.files || [])];
    if (fl.length) chatSendFiles(fl);
  });
}

// Shortcut keys
$("#btn-keys").addEventListener("click", (e) => { e.stopPropagation(); toggleKeysPanel(); });

// Screenshot
$("#btn-screenshot").addEventListener("click", takeScreenshot);

// Black screen + lock input
$("#btn-blackscreen").addEventListener("click", toggleBlackScreen);
$("#btn-lock-input").addEventListener("click", toggleLockInput);

$("#btn-copy").addEventListener("click", () => { const id = shownId(); if (id) navigator.clipboard.writeText(id).then(() => showToast(t("id_copied"))); });

// In-app confirmation (combined design, direction A). It replaces the native Windows message box, which could not
// follow TryDesk's look, theme or language switch: a one-line title, the explanation, then Batal and the action.
// Batal has the focus first (the safe answer); Escape, Batal or a click outside the box answer "no".
function appConfirm({ title, message, detail, okLabel, cancelLabel }) {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "overlay app-confirm"; ov.setAttribute("role", "alertdialog"); ov.setAttribute("aria-modal", "true"); ov.setAttribute("aria-labelledby", "app-confirm-title");
    const box = document.createElement("div"); box.className = "app-confirm-box";
    // Concept: the title's last word in red ("Buat ID baru?"), as every big sentence in the app.
    const h = document.createElement("h3"); h.id = "app-confirm-title";
    { const t0 = String(title || ""), cut = t0.lastIndexOf(" ");
      if (cut > 0) { const em = document.createElement("em"); em.textContent = t0.slice(cut + 1); h.append(t0.slice(0, cut + 1), em); } else h.textContent = t0; }
    const p1 = document.createElement("p"); p1.className = "acf-msg"; p1.textContent = message || "";
    const row = document.createElement("div"); row.className = "acf-actions";
    const no = document.createElement("button"); no.type = "button"; no.className = "btn-secondary"; no.textContent = cancelLabel || tr("Batal");
    const yes = document.createElement("button"); yes.type = "button"; yes.className = "btn-connect acf-ok"; yes.textContent = okLabel || "OK";
    if (cancelLabel === false) no.hidden = true;   // a notice with one answer ("Tutup")
    row.append(no, yes);
    box.append(h, p1);
    if (detail) { const p2 = document.createElement("p"); p2.className = "acf-detail"; p2.textContent = detail; box.append(p2); }
    box.append(row); ov.append(box);
    const prev = document.activeElement;
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); } };
    function done(v) { document.removeEventListener("keydown", onKey, true); ov.remove(); try { prev && prev.focus(); } catch {} resolve(v); }
    no.addEventListener("click", () => done(false));
    yes.addEventListener("click", () => done(true));
    ov.addEventListener("click", (e) => { if (e.target === ov) done(false); });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(ov);
    (no.hidden ? yes : no).focus();
  });
}

// Opt-in ID rotation: drop the stored identity and reconnect so the server issues a FRESH id+token.
// The persistent-by-default ID is preserved; this is a deliberate, confirmed security action.
async function regenerateId() {
  let ok = false;
  try {
    if (window.electronAPI && window.electronAPI.confirm) {
      ok = await appConfirm({
        title: t("regen_confirm_title"), message: t("regen_confirm_msg"), detail: t("regen_confirm_detail"),
        okLabel: t("regen_confirm_ok"), cancelLabel: t("regen_confirm_cancel"),
      });
    } else { ok = window.confirm(t("regen_confirm_msg") + "\n\n" + t("regen_confirm_detail")); }
  } catch { ok = false; }
  if (!ok) return;
  // With the Windows service this PC's ID is the service's (Home shows it): the service gets the new one, after an
  // administrator's yes (UAC). Before 9 Nov this dropped an ID nobody used and showed the app's second ID as "new".
  if (svcId !== null && !(config && config.serviceHost)) return regenerateServiceId();
  dropIdentityAndReconnect();
}
// End any live sessions first (they belong to the OLD id) and any request still being answered, then sign in with no
// stored identity: the server issues a fresh id+token.
function dropIdentityAndReconnect() {
  try { for (const s of [...sessions.values()]) closeSession(s, true); } catch {}
  try { if (host) closeSession(host, true); } catch {}
  try { if (acceptDlgCancel) acceptDlgCancel(); } catch {}
  if (pendingChallenge) { clearTimeout(pendingChallenge._t); pendingChallenge = null; }
  store.set("myId", null); store.set("myToken", null);
  // identity.json too, or a TryDesk closed before the new ID arrives would take the old one back at its next start
  // (review 10 Nov). The service's host keeps no identity.json of its own (main.js ignores this there).
  if (!(config && config.serviceHost)) { try { window.electronAPI.forgetIdentity?.(); } catch {} }
  myId = null; _regenPending = true;
  myIdText.textContent = "…";
  setStatus("", t("connecting_server"));
  connectSignaling();
}
// The service's host: an administrator asked for a new ID (main.js watches %ProgramData%\TryDesk\regen-id.req).
window.electronAPI?.onSvcRegenId?.(() => {
  if (!(config && config.serviceHost)) return;
  try { window.electronAPI.svcRegenAck?.(); } catch {}   // main deletes the request file only now
  store.set("svcAdopted", "1"); dropIdentityAndReconnect();
});
async function regenerateServiceId() {
  const before = svcId;
  showToast(t("regen_svc_wait"));
  let r = null; try { r = await window.electronAPI.serviceRegenId(); } catch {}
  if (!r || !r.ok) { showToast(r && r.code === 1223 ? t("regen_svc_cancel") : t("regen_failed")); return; }
  myIdText.textContent = "…";
  for (let i = 0; i < 30; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    await refreshServiceState();
    if (svcId && svcId !== before) {
      // Only now is the old ID retired: the app's copy and identity.json must not bring it back later (service
      // removed, restart). Before the service confirmed, a failure would have cost the PC its ID (review 10 Nov).
      if (store.get("myId") === before) { store.set("myId", null); store.set("myToken", null); }
      try { window.electronAPI.forgetIdentity?.(); } catch {}
      showToast(t("id_regenerated") + ": " + fmtId(svcId)); return;
    }
  }
  myIdText.textContent = shownId() ? fmtId(shownId()) : "…";
  showToast(t("regen_failed"));
}
$("#btn-regen-id")?.addEventListener("click", regenerateId);

// Elevation: show "Run as administrator" in Security settings only when the host isn't elevated (so admin/UAC
// windows, which otherwise freeze remote control, can be controlled too).
async function refreshElevationUI() {
  try {
    const cfg = config || await window.electronAPI.getConfig();
    const el = cfg && cfg.platform && cfg.platform !== "win32" ? true : await window.electronAPI.isElevated();   // Windows-only setting
    const g = $("#admin-group"); if (g) g.style.display = el ? "none" : "";
    return el;
  } catch { return true; }
}
$("#btn-run-admin")?.addEventListener("click", async () => {
  let ok = true;
  try {
    if (window.electronAPI.confirm) ok = await appConfirm({
      title: tr("Jalankan sebagai administrator?"),
      message: tr("TryDesk akan ditutup lalu dibuka lagi dengan izin administrator."),
      detail: tr("Windows akan menampilkan prompt UAC. Sesi yang sedang berjalan akan terputus."),
      okLabel: tr("Lanjutkan"), cancelLabel: tr("Batal"),
    });
  } catch {}
  if (ok) {
    let started = false;
    try { started = await window.electronAPI.relaunchAsAdmin(); } catch {}
    if (!started) { showToast("UAC dibatalkan, TryDesk tetap berjalan tanpa hak administrator"); return; }
    // The elevated copy is starting and this one quits in a moment: end every session properly first, so the
    // other side is told why and the server drops the pairing (it used to stay "controlling" after the restart).
    const why = "TryDesk dibuka ulang sebagai administrator";
    try { for (const s of viewerSessions()) closeSession(s, true, why); if (host) closeSession(host, true, why); } catch {}
    showToast("TryDesk dibuka ulang sebagai administrator. Jendela baru muncul dalam beberapa detik, jangan buka TryDesk lagi sebelum itu.");
  }
});
// Windows service (unattended access): installed with the current access password; its host has its own ID.
async function refreshServiceUI() {
  const g = $("#service-group"); if (!g || !window.electronAPI?.serviceStatus) return;
  let s; try { s = await window.electronAPI.serviceStatus(); } catch { s = null; }
  g.style.display = s && s.supported ? "" : "none";
  if (!s || !s.supported) return;
  const st = $("#service-state");
  st.textContent = s.installed ? (s.state === "RUNNING" ? "Terpasang dan berjalan." : "Terpasang, tapi sedang berhenti.") : "Layanan belum dipasang.";
  st.classList.toggle("on", !!s.installed);
  st.classList.toggle("warn", !!s.installed && s.state !== "RUNNING");
  const sub = $("#service-sub");
  if (sub) sub.textContent = s.installed ? "PC ini bisa dihubungi setelah restart, dengan ID yang sama." : "PC ini hanya bisa dihubungi saat TryDesk terbuka.";
  $("#service-install-row")?.classList.toggle("hidden", !!s.installed);
  $("#service-remove-row")?.classList.toggle("hidden", !s.installed);
  // With the service, this TryDesk starts with Windows (in the tray), so the service's sessions show HERE with
  // Settings and Send file instead of in the service's own window (owner 13 Nov). Switched on once; a person who
  // turns it off afterwards keeps it off.
  $("#startup-svc-note")?.classList.toggle("hidden", !s.installed);
  // (the first call runs while the app is still loading its config: wait for it)
  for (let i = 0; i < 100 && s.installed && !config; i++) await sleep(100);
  if (s.installed && config && !config.serviceHost && store.get("svcAutoStart") !== "1") {
    try {
      if (await window.electronAPI.getLoginItem()) store.set("svcAutoStart", "1");
      else if (await window.electronAPI.setLoginItem(true)) {
        store.set("svcAutoStart", "1");   // (only once it worked: a failed try is tried again next time)
        const cb = $("#setting-startup"); if (cb) cb.checked = true;
        showToast("TryDesk kini menyala bersama Windows, supaya sesi lewat layanan Windows tampil di sini dengan semua tombol");
      }
    } catch {}
  }
  // The service line under the password follows (svcPwFp: what the service's host really uses, see svcPwState).
  svcPwFp = s.installed && s.state === "RUNNING" ? String(s.pwFp || "") : "";
  await refreshMyPwFp();
  updateAccessPwUI();
}
// Installed with the current access password, if there is one (without: every request asks Accept). The app
// switches to its second ID right away, before the service's host signs in with this PC's ID.
$("#btn-service-install")?.addEventListener("click", async () => {
  const saved = store.get("accessPasswordHash"), hash = /^[0-9a-f]{32}:[0-9a-f]{64}$/.test(saved || "") ? saved : "";
  showToast("Memasang layanan… setujui prompt UAC.");
  let r; try { r = await window.electronAPI.serviceInstall(hash); } catch { r = { ok: false, code: 1 }; }
  if (r.ok) { store.set("svcPwHash", hash || "none"); store.set("svcPwAt", String(Date.now())); showToast("Layanan terpasang. ID PC ini tetap sama."); }
  else showToast(r.code === 1223 ? "UAC dibatalkan, layanan tidak dipasang" : tr("Layanan gagal dipasang") + ` (${r.code})`);
  await refreshServiceState(); await refreshServiceUI();
});
$("#btn-service-remove")?.addEventListener("click", async () => {
  let r; try { r = await window.electronAPI.serviceUninstall(); } catch { r = { ok: false, code: 1 }; }
  if (r.ok) store.set("svcPwHash", null);
  showToast(r.ok ? "Layanan dihapus" : r.code === 1223 ? "UAC dibatalkan, layanan tetap terpasang" : tr("Layanan gagal dihapus") + ` (${r.code})`);
  await refreshServiceState(); refreshServiceUI();
});
refreshServiceUI();
// Security at a glance (design direction C): three cells with the REAL state, read from the same places the
// settings below use. Re-rendered whenever one of those changes; a click opens the setting that changes it.
function renderSecSummary() {
  const box = $("#sec-summary"); if (!box) return;
  const pw = !!store.get("accessPasswordHash");
  $("#sec-in").textContent = pw ? "Masuk dengan password" : "Selalu tanya";
  $("#sec-ctl").textContent = $("#setting-allow-input")?.checked ? "Mouse dan keyboard" : "Hanya melihat";
  const svcShown = $("#service-group") && $("#service-group").style.display !== "none";
  $("#sec-svc-cell").classList.toggle("hidden", !svcShown);
  { const st = $("#service-state"); $("#sec-svc").textContent = st?.classList.contains("on") && !st.classList.contains("warn") ? "Tetap bisa diakses" : "Perlu TryDesk terbuka"; }
}
for (const sel of ["#access-pw-state", "#service-state"]) { const el = $(sel); if (el) new MutationObserver(renderSecSummary).observe(el, { childList: true, characterData: true, subtree: true, attributes: true }); }
const svcGroup = $("#service-group"); if (svcGroup) new MutationObserver(renderSecSummary).observe(svcGroup, { attributes: true, attributeFilter: ["style"] });
$("#setting-allow-input")?.addEventListener("change", renderSecSummary);
// (the "Setelah restart" cell's setting lives on the service page)
$$("#sec-summary .sec-cell").forEach((c) => c.addEventListener("click", () => openSettingsAt(c.id === "sec-svc-cell" ? "tab-service" : "tab-security", c.dataset.go)));
renderSecSummary();
// Beranda (direction A): "Desktop ini, online". The word follows the status dot, so it is always the real state.
(() => {
  const st = $("#home-state"), dot = $("#status-dot"); if (!st || !dot) return;
  const sync = () => { const c = dot.className; st.textContent = /\bconnected\b/.test(c) ? ", online" : /\berror\b/.test(c) ? ", offline" : ", menghubungkan"; };
  new MutationObserver(sync).observe(dot, { attributes: true, attributeFilter: ["class"] }); sync();
})();
// Another TryDesk exe (Portable vs Setup) was opened while this one runs: it closed at once, say why (12 Nov report).
window.electronAPI?.onOtherCopyBlocked?.((v) => showToast(v.otherPortable
  ? "TryDesk Portable tidak dibuka karena TryDesk ini sudah berjalan. Untuk memakai Portable, keluar dulu lewat ikon TryDesk di tray → Keluar."
  : "TryDesk yang terpasang tidak dibuka karena TryDesk ini sudah berjalan. Untuk memakainya, keluar dulu lewat ikon TryDesk di tray → Keluar."));
window.electronAPI?.onElevatedRelaunchBlocked?.(() =>showToast("TryDesk administrator tidak jadi terbuka karena TryDesk ini sudah berjalan. Klik kanan ikon TryDesk di tray → Keluar, lalu pilih Jalankan sebagai administrator lagi."));
refreshElevationUI();
// Access password: type → saved (as a salted hash) when the field is left or Enter is pressed; the trash button
// removes it. The eye button keeps focus in the field, so what you typed can be checked before it is saved.
// When the password was last changed, in words: "hari ini 22.48" or "12 Nov 22.48" (the EN text map turns both).
function pwWhen(ms) {
  const d = new Date(Number(ms)); if (!ms || isNaN(d)) return "";
  // Other languages: the date and time the way that language writes them ("heute 22:48", "今天 22:48")
  if (lang !== "id") {
    try {
      const hm = new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
      const day = d.toDateString() === new Date().toDateString() ? new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(0, "day") : new Intl.DateTimeFormat(lang, { day: "numeric", month: "short" }).format(d);
      return `${day} ${hm}`;
    } catch {}
  }
  const hm = String(d.getHours()).padStart(2, "0") + "." + String(d.getMinutes()).padStart(2, "0");
  const MON = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  return d.toDateString() === new Date().toDateString() ? `hari ini ${hm}` : `${d.getDate()} ${MON[d.getMonth()]} ${hm}`;
}
// Whether the Windows service holds the same password as this app: "same", "none" (the service has none while the
// app has one: Setup installs it that way), "old" (another one), or null (no service / not known). The service's
// host writes a fingerprint of what it really uses (svcPwFp, read with the service status); the fingerprint of this
// app's hash comes from the main process (myPwFp). Right after a successful write the service restarts, so for a
// minute the app's own record (svcPwHash + svcPwAt) counts instead of the file it has not rewritten yet.
async function refreshMyPwFp() {
  const h = store.get("accessPasswordHash") || "";
  if (myPwFp.hash === h) return;
  try { myPwFp = { hash: h, fp: (await window.electronAPI.servicePwFingerprint?.(h)) || "" }; } catch { myPwFp = { hash: h, fp: "" }; }
}
function svcPwState() {
  const installed = !!$("#service-state")?.classList.contains("on");
  if (!installed) return null;
  const mine = store.get("accessPasswordHash") || "none", rec = store.get("svcPwHash");
  if (rec === mine && Date.now() - Number(store.get("svcPwAt") || 0) < 60000) return "same";
  if (svcPwFp && myPwFp.hash === (store.get("accessPasswordHash") || "") && myPwFp.fp) {
    if (svcPwFp === myPwFp.fp) return "same";
    return svcPwFp === "none" ? "none" : "old";
  }
  if (rec == null) return null;
  return rec === mine ? "same" : "old";
}
// Design direction 2 "Kartu kunci" (owner's pick 15 Nov): one card whose data-mode is the state. "none" / "on" follow
// what is stored; "edit" (typing a new one) and "del" (asking before removing) last until Simpan / Batal / Ya, hapus.
// Saved only by Simpan or Enter, no longer when the field loses focus (a half-typed password used to be saved by a
// click elsewhere), and Hapus asks first. The stored password is only a salted hash, so it can never be shown: the eye
// lives inside the field, for what is being typed.
let pwMode = null;   // null = follow the stored state; "edit" or "del" while the user is in them
const PW_TEXT = {
  none: ["Belum ada password", ".", "Setiap koneksi menunggu Anda klik Terima. Buat password bila PC ini sering Anda buka dari jauh."],
  on: ["Password aktif", ".", "Tamu yang tahu password langsung masuk, tanpa Anda klik Terima."],
  edit: ["Password baru", ".", "Ketik password yang akan Anda pakai dari PC lain."],
  del: ["Hapus password", "?", "Setelah dihapus, setiap koneksi menunggu Anda klik Terima. Password lama tidak bisa dipakai lagi."],
};
function pwHints() {
  const n = accessPassword.value.length;
  $("#pw-hint-min").classList.toggle("ok", n >= 6);
  $("#pw-hint-lan").classList.toggle("ok", n >= LAN_PW_MIN);
}
function setPwEye(show) {
  accessPassword.type = show ? "text" : "password";
  const b = $("#btn-toggle-pass"); b.setAttribute("aria-pressed", String(show));
  b.innerHTML = show ? EYE_OFF : EYE_ON;
}
function setPwMode(m) {
  pwMode = m;
  if (m === "edit") { accessPassword.value = ""; setPwEye(false); pwHints(); }
  if (m !== "edit") accessPassword.value = "";
  updateAccessPwUI();
  if (m === "edit") accessPassword.focus();
  else if (m === "del") $("#btn-pw-del-no").focus();
  else ($("#btn-pw-change").offsetParent ? $("#btn-pw-change") : $("#btn-pw-create")).focus({ preventScroll: true });
}
function updateAccessPwUI(justSaved = false) {
  const set = !!store.get("accessPasswordHash");
  if (pwMode === "del" && !set) pwMode = null;
  const mode = pwMode || (set ? "on" : "none");
  $("#access-pw-card").dataset.mode = mode;
  const t = PW_TEXT[mode];
  $("#access-pw-title").textContent = mode === "edit" && set ? "Ganti password" : t[0];
  $("#access-pw-mark").textContent = t[1];
  $("#access-pw-desc").textContent = t[2];
  // When it was changed, under the eight dots (owner's change to the concept)
  const st = $("#access-pw-state"), when = pwWhen(store.get("accessPwAt"));
  st.textContent = set ? (when ? trL(`Diubah ${when}`, `Changed ${when}`) : "Tersimpan") : "";
  st.classList.toggle("on", set);
  const sv = svcPwState(), box = $("#access-pw-svc");
  // Shown only where it matters: a password that the service doesn't use yet (or still an old one), and on "on" the
  // quiet confirmation that it does. Not inside the typing or asking steps.
  const svText = sv === "same"
    ? (set ? "Layanan Windows memakai password yang sama, jadi PC ini juga bisa diakses setelah restart." : "")
    : sv === "none" ? "Layanan Windows belum memakai password ini, jadi setiap koneksi ke PC ini masih meminta Terima."
    : sv === "old" ? (set ? "Layanan Windows masih memakai password sebelumnya, jadi koneksi ke PC ini belum memakai yang baru." : "Layanan Windows masih memakai password lama, jadi yang tahu password itu tetap bisa masuk.")
    : "";
  box.classList.toggle("hidden", !svText || mode === "edit" || mode === "del");
  box.classList.toggle("on", sv === "same"); box.classList.toggle("warn", sv === "old" || sv === "none");
  $("#access-pw-svc-text").textContent = svText;
  $("#btn-pw-svc-retry").classList.toggle("hidden", !(sv === "old" || sv === "none"));
  if (justSaved) for (const el of [st, box]) { el.classList.remove("saved"); void el.offsetWidth; el.classList.add("saved"); }
  renderHomeFacts();
}
$("#btn-toggle-pass").addEventListener("mousedown", (e) => e.preventDefault());   // focus stays in the field
$("#btn-toggle-pass").addEventListener("click", () => { setPwEye(accessPassword.type === "password"); accessPassword.focus(); });
$("#btn-pw-create").addEventListener("click", () => setPwMode("edit"));
$("#btn-pw-change").addEventListener("click", () => setPwMode("edit"));
$("#btn-pw-cancel").addEventListener("click", () => setPwMode(null));
$("#btn-clear-pass").addEventListener("click", () => setPwMode("del"));
$("#btn-pw-del-no").addEventListener("click", () => setPwMode(null));
$("#btn-pw-del-yes").addEventListener("click", async () => {
  pwMode = null;
  store.set("accessPasswordHash", null); store.set("accessPwLan", null); store.set("accessPwAt", String(Date.now()));
  accessPassword.value = "";
  await refreshMyPwFp();
  updateAccessPwUI(true);
  $("#btn-pw-create").focus({ preventScroll: true });
  showToast("Password akses dihapus");
  await syncServicePassword(null);
});
// The service's host answers for this PC while it runs: the password goes to it too (one UAC prompt). What the
// service ended up with is remembered (svcPwHash) and shown under the field, so a declined prompt is not missed.
async function syncServicePassword(hash) {
  // Installed is enough: set-password does not need the service running, and a stopped service keeping the old
  // password would take it again at the next boot (review 12 Nov).
  if (svcId === null && !$("#service-state")?.classList.contains("on")) return;
  showToast("Menyimpan password ke layanan… setujui prompt UAC.");
  let r; try { r = await window.electronAPI.serviceSetPassword(hash || ""); } catch { r = { ok: false, code: 1 }; }
  if (r.ok) {
    store.set("svcPwHash", hash || "none"); store.set("svcPwAt", String(Date.now()));
    showToast("Password layanan diperbarui");
    // The service restarts and rewrites its fingerprint; read it again once it is back.
    for (const ms of [12000, 45000, 90000, 180000]) setTimeout(() => refreshServiceUI(), ms);
  } else {
    // Known from now on: the service keeps whatever it had, which is not this one.
    if (store.get("svcPwHash") == null) store.set("svcPwHash", "unknown-old");
    showToast(r.code === 1223 ? "UAC dibatalkan, password layanan tidak berubah" : tr("Password layanan gagal diubah") + ` (${r.code})`);
  }
  await refreshMyPwFp();
  updateAccessPwUI(true);
}
// One run at a time: a double-click opened two UAC prompts.
let _pwSvcSyncing = false;
$("#btn-pw-svc-retry").addEventListener("click", async () => {
  if (_pwSvcSyncing) return;
  _pwSvcSyncing = true; $("#btn-pw-svc-retry").disabled = true;
  try { await syncServicePassword(store.get("accessPasswordHash")); }
  finally { _pwSvcSyncing = false; $("#btn-pw-svc-retry").disabled = false; }
});
let _pwSaving = false;   // blur + Simpan + Enter in quick succession save once (one UAC prompt, not two)
async function saveAccessPassword() {
  const value = accessPassword.value;
  if (_pwSaving) return;
  if (!value) { if (pwMode === "edit") { showToast("Password minimal 6 karakter"); accessPassword.focus(); } return; }   // nothing typed: the saved password stays
  if (value.length < 6) { showToast("Password minimal 6 karakter"); accessPassword.focus(); return; }
  _pwSaving = true;
  try { await saveAccessPasswordNow(value); } finally { _pwSaving = false; }
}
async function saveAccessPasswordNow(value) {
  accessPassword.value = "";
  store.set("accessPasswordHash", await hashPassword(value));
  store.set("accessPwLan", value.length >= LAN_PW_MIN ? "1" : "0");
  store.set("accessPwAt", String(Date.now()));
  accessPassword.value = "";
  setPwEye(false);
  pwMode = null;
  await refreshMyPwFp();
  updateAccessPwUI(true);
  $("#btn-pw-change").focus({ preventScroll: true });
  showToast("Password akses disimpan");
  await syncServicePassword(store.get("accessPasswordHash"));
}
// Saved by the Simpan button or Enter only (Kartu kunci); Escape is Batal. The two hints light up as they are met.
$("#btn-save-pass").addEventListener("mousedown", (e) => e.preventDefault());   // keep focus: one save
$("#btn-save-pass").addEventListener("click", () => saveAccessPassword());
accessPassword.addEventListener("input", pwHints);
accessPassword.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); saveAccessPassword(); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setPwMode(null); }
});

// Digits are grouped as an ID ("123 456 789"); anything with a dot, colon or letter is left alone, an IP address
// or a LAN PC name (see parseLanTarget).
remoteIdInput.addEventListener("input", (e) => {
  const v = e.target.value;
  if (/[.,:\[\]a-z]/i.test(v)) { e.target.value = v.replace(/\s/g, "").replace(/,/g, ".").slice(0, 64); return; }   // (a phone keypad may offer "," for ".")
  const d = v.replace(/\D/g, "").slice(0, 9); e.target.value = d.match(/.{1,3}/g)?.join(" ") || "";
});
remoteIdInput.addEventListener("keydown", (e) => { if (e.key === "Enter") initiateConnection(); });
remotePasswordInput.addEventListener("keydown", (e) => { if (e.key === "Enter") initiateConnection(); });
// Eye button inside the password fields the viewer types into (home card and the Connecting screen's prompt), so a
// typed password can be checked before connecting. Like the settings one it keeps focus in the field.
const EYE_ON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19M14.12 14.12a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
function addPwEye(input) {
  const wrap = document.createElement("div"); wrap.className = "pw-field";
  input.replaceWith(wrap); wrap.appendChild(input);
  const b = document.createElement("button"); b.type = "button"; b.className = "pw-eye"; b.title = "Tampilkan / sembunyikan";
  b.setAttribute("aria-pressed", "false"); b.innerHTML = EYE_ON;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password"; b.innerHTML = show ? EYE_OFF : EYE_ON; b.setAttribute("aria-pressed", String(show));
    input.focus();
  });
  wrap.appendChild(b);
}
addPwEye(remotePasswordInput);
addPwEye($("#connect-pw-input"));

$("#btn-minimize").addEventListener("click", () => window.electronAPI.minimizeWindow());
$("#btn-maximize").addEventListener("click", () => window.electronAPI.maximizeWindow());
// Quitting TryDesk ends every session and makes this PC unreachable until it is started again, ask first
// when something is running (a helper on the host's desktop could otherwise cut themselves off by accident).
async function confirmQuit(fromTray) {
  const live = !!host || viewerSessions().length > 0;
  if (!live) return true;
  if (fromTray) { try { window.electronAPI.focusWindow(); } catch {} }   // the question needs its context
  let ok = false;
  try {
    ok = await appConfirm({
      title: tr(fromTray ? "Keluar dari TryDesk?" : "Tutup TryDesk?"),
      message: tr(host ? "PC ini sedang dikontrol dari jarak jauh." : "Masih ada sesi remote yang terbuka."),
      detail: tr("Menutup TryDesk memutus semua sesi, dan PC ini tidak bisa dihubungi sampai TryDesk dibuka lagi."),
      okLabel: tr(fromTray ? "Keluar" : "Tutup"), cancelLabel: tr("Batal"),
    });
  } catch { ok = true; }
  if (ok) { try { for (const s of viewerSessions()) closeSession(s, true); if (host) closeSession(host, true); } catch {} }
  return ok;
}
// X (and Alt+F4 / the taskbar's Close): to the system tray like AnyDesk, sessions keep running, the PC stays
// reachable. With that setting off, X quits as before. The phone app has no tray (and no X).
async function onCloseButton() {
  // The service's window only exists for a request or a session: X answers it (Reject / Disconnect), then it goes away.
  if (config && config.serviceHost) {
    if (acceptPending && acceptDlgCancel) acceptDlgCancel();
    else if (host) closeSession(host, true);
    else serviceHideWindow();
    return;
  }
  if (prefGet("closeToTray") && window.electronAPI.hideToTray) {
    const first = store.get("tipTray") !== "1";
    if (first) store.set("tipTray", "1");
    window.electronAPI.hideToTray(first);
    return;
  }
  if (await confirmQuit(false)) window.electronAPI.closeWindow();
}
$("#btn-close").addEventListener("click", onCloseButton);
window.electronAPI.onCloseRequested?.(onCloseButton);
window.electronAPI.onQuitRequested?.(async () => { if (await confirmQuit(true)) window.electronAPI.quitApp(); });

$("#btn-settings").addEventListener("click", toggleSettings);
$("#btn-settings-close").addEventListener("click", toggleSettings);
// Picture 2: while Settings is open the title bar says "Pengaturan"; Keamanan shows this PC's ID with "Buat ID baru".
{
  const tbName = $("#titlebar .titlebar-logo span") || $(".titlebar-logo span");
  const sync = () => {
    const open = !overlaySettings.classList.contains("hidden");
    if (tbName && !isPhoneUi()) tbName.textContent = open ? "Pengaturan" : "TryDesk";
    // The ID others connect to: the service's while it runs (myId is then the app's second ID, used only to
    // control other PCs; showing it here gave two different IDs, owner's picture 8 Nov).
    if (open) { const el = $("#set-my-id"); if (el) el.textContent = shownId() ? fmtId(shownId()) : "-"; }
  };
  new MutationObserver(sync).observe(overlaySettings, { attributes: true, attributeFilter: ["class"] });
  $("#btn-regen-id-2")?.addEventListener("click", () => $("#btn-regen-id").click());
  // Settings shows the same ID as Home at every moment (owner 13 Nov: after "Buat ID baru" Home changed but the
  // open Settings page kept the old number until it was closed and opened again). Home's ID is the one place every
  // path writes to (sign-in, a new ID, the service's ID), so Settings copies it: "…" while the new one is on its way.
  const homeId = myIdText, setId = $("#set-my-id");
  if (homeId && setId) new MutationObserver(() => { setId.textContent = homeId.textContent || "-"; })
    .observe(homeId, { childList: true, characterData: true, subtree: true });
}
overlaySettings.addEventListener("click", (e) => { if (e.target === overlaySettings) toggleSettings(); });

// ─── Host access permissions (Settings → Keamanan → Izin akses) ───
function applyAccessSettings() {
  allowInput = store.get("allowInput") !== "0";
  allowFileTransfer = store.get("allowFile") !== "0";
  allowClipboardPref = store.get("allowClipboard") !== "0";
  forceViewOnly = store.get("forceViewOnly") === "1";
  const set = (id, val) => { const el = $(id); if (el) el.checked = val; };
  set("#setting-allow-input", allowInput);
  set("#setting-allow-file", allowFileTransfer);
  set("#setting-allow-clipboard", allowClipboardPref);
  set("#setting-allow-viewonly", forceViewOnly);
}
// Changed while someone is connected: tell them right away, and if control was just taken away, let go of any
// key or mouse button they were holding (its "up" would now be dropped by the gate and stay stuck).
// The three switches on "PC ini sedang dikontrol" ARE the Settings ones (Keamanan > Yang boleh dilakukan tamu): a change
// here sets that checkbox and fires its own change handler, so it is saved and reaches the guest at once, as from Settings.
const HOST_PERM_SW = [["#host-perm-input", "#setting-allow-input"], ["#host-perm-clip", "#setting-allow-clipboard"], ["#host-perm-file", "#setting-allow-file"]];
function paintHostPerms() {
  const ctl = hostControlAllowed();
  // The service's session follows this user's permissions too (svcPermsSave → service-perms.json, read every 3 s).
  const fileEff = hostFilesAllowed();
  const rows = { "#host-perm-input": [allowInput && !forceViewOnly, ctl], "#host-perm-clip": [allowClipboardPref, allowClipboardPref && ctl], "#host-perm-file": [allowFileTransfer, fileEff] };
  for (const [id, [on, eff]] of Object.entries(rows)) {
    const sw = $(id); if (!sw) continue;
    sw.checked = on;
    sw.disabled = id === "#host-perm-input" && forceViewOnly;
    const why = eff ? "Boleh"
      : id === "#host-perm-input" && forceViewOnly ? "Hanya melihat layar (Pengaturan)"
      : on && !ctl ? "Tidak boleh selama mouse dan keyboard mati" : "Tidak boleh";
    sw.closest(".h3-perm").querySelector(".h3-ps").textContent = why;
  }
}
for (const [mine, setting] of HOST_PERM_SW) $(mine)?.addEventListener("change", (e) => {
  const s = $(setting); if (!s) return;
  s.checked = e.target.checked; s.dispatchEvent(new Event("change"));
  paintHostPerms();
});
function hostPermsChanged() {
  if (!host) return;
  if (!hostControlAllowed()) {
    try { window.electronAPI.releaseRemoteInput(); } catch {}
    try { window.electronAPI.disableInputLock(); } catch {}
    if (host.inputLocked) { host.inputLocked = false; sendPrivacyResult(host, "lock-input", true, false, "revoked"); }
    // A viewer who darkened this screen must not keep it dark after control is revoked, restore it too, and say
    // so, or the viewer's toggle keeps claiming a dark screen the person here can now see.
    if (host.blackScreenActive) {
      try { window.electronAPI.disableBlackScreen(); } catch {}
      host.blackScreenActive = false;
      $("#blackscreen-notice")?.classList.add("hidden");
      sendPrivacyResult(host, "black-screen", true, false, "revoked");
    }
  }
  if (!hostFilesAllowed()) {
    if (host.activeRecv) { discardRecv(host.activeRecv); host.activeRecv = null; }
    if (host.activeSend) host.activeSend.canceled = true;
  }
  sendMonitors(host);
}
$("#setting-allow-input")?.addEventListener("change", (e) => { allowInput = e.target.checked; store.set("allowInput", allowInput ? "1" : "0"); svcPermsSave(); hostPermsChanged(); });
$("#setting-allow-file")?.addEventListener("change", (e) => { allowFileTransfer = e.target.checked; store.set("allowFile", allowFileTransfer ? "1" : "0"); svcPermsSave(); hostPermsChanged(); });
// The Windows service's sessions follow this user's File permission too (owner 13 Nov: "full akses seperti biasanya"):
// it is saved for the service whenever it changes, and once at start. (Not by the service's own host, nor elsewhere.)
function svcPermsSave() {
  if ((config && config.serviceHost) || window.TD_MOBILE || viewerOnlyDesktop()) return;
  try { window.electronAPI.svcPermsSave?.({ files: allowFileTransfer, input: allowInput, clip: allowClipboardPref, viewOnly: forceViewOnly }); } catch {}
}
// The service's host: the signed-in user's File permission, read fresh before every folder or file request.
let _svcUser = false;   // someone is signed in to Windows in the service's session
async function svcPermsRefresh() {
  if (!(config && config.serviceHost)) return;
  let p = null; try { p = await window.electronAPI.svcUserPerms(); } catch {}
  const was = hostFilesAllowed(), wasCtl = hostControlAllowed(), wasClip = allowClipboardPref && wasCtl;
  _svcUser = !!(p && p.user);
  allowFileTransfer = !!(p && p.user && p.files);
  // The user's other three permissions too (owner 15 Nov). Not read (IPC failed, or the file there is unreadable):
  // keep what we had, never open up on an error. Files are off then anyway (above).
  if (p && !p.unknown) { allowInput = p.input !== false; allowClipboardPref = p.clip !== false; forceViewOnly = p.viewOnly === true; }
  // Taken away (in the user's TryDesk, or the user signed out) while a session runs: stop what is under way, whoever
  // noticed it first (the timer or a request). Given back: tell the viewer too, or it keeps "view only".
  if (host && ((was && !hostFilesAllowed()) || (wasCtl && !hostControlAllowed()))) hostPermsChanged();
  else if (host && (was !== hostFilesAllowed() || wasCtl !== hostControlAllowed() || wasClip !== (allowClipboardPref && hostControlAllowed()))) sendMonitors(host);
  paintHostPerms();
}
$("#setting-allow-clipboard")?.addEventListener("change", (e) => { allowClipboardPref = e.target.checked; store.set("allowClipboard", allowClipboardPref ? "1" : "0"); svcPermsSave(); hostPermsChanged(); });
$("#setting-allow-viewonly")?.addEventListener("change", (e) => { forceViewOnly = e.target.checked; store.set("forceViewOnly", forceViewOnly ? "1" : "0"); svcPermsSave(); hostPermsChanged(); });
// Settings changed while "PC ini sedang dikontrol" is on screen: its switches follow.
for (const id of ["#setting-allow-input", "#setting-allow-file", "#setting-allow-clipboard", "#setting-allow-viewonly"]) $(id)?.addEventListener("change", paintHostPerms);

// Drag and drop (users' reports 9 Nov: "can't drag and drop files while remoting"). Files dropped on the remote screen
// go to that PC; dropped on "this PC is being controlled" they go to the viewer. Same offer and Accept card as Send
// file. A drop never navigates the window away (main blocks that too).
function dropTarget() {
  if (config && config.serviceHost) return null;
  if (!$("#screen-remote").classList.contains("hidden") && active && active.role === "viewer") return active;
  if (onHostingScreen()) return host || svcMirror;
  return null;
}
const isFileDrag = (e) => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files"));
let _dragDepth = 0;
const setDropReady = (on) => { const h = document.documentElement; h.dataset.drop = trL("Lepas untuk mengirim file", "Drop to send the files"); h.classList.toggle("drop-ready", on); };
// While File Transfer is open its panes take drops themselves (the other PC's pane sends to the folder open there;
// this PC's pane takes none): the window never sends a drop on its own then (it used to send a file dropped on this
// PC's pane to the other PC).
window.addEventListener("dragenter", (e) => { if (fmOpen || !isFileDrag(e)) return; e.preventDefault(); _dragDepth++; if (dropTarget()) setDropReady(true); });
window.addEventListener("dragleave", (e) => { if (!isFileDrag(e)) return; if (--_dragDepth <= 0) { _dragDepth = 0; setDropReady(false); } });
// "copy" even without a session, so the drop arrives and can say what to do instead of a silent no-entry cursor.
window.addEventListener("dragover", (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = isFileDrag(e) ? "copy" : "none"; });
window.addEventListener("drop", async (e) => {
  e.preventDefault(); _dragDepth = 0; setDropReady(false);
  if (fmOpen) return;
  const list = e.dataTransfer && e.dataTransfer.files;
  if (!list || !list.length) return;
  const sess = dropTarget();
  if (!sess) return showToast("Sambungkan dulu ke PC lain, lalu seret file ke layarnya untuk mengirim");
  let r = null; try { r = await window.electronAPI.filesDropped?.([...list]); } catch {}   // File objects cross the bridge, a FileList does not
  const sent = (r && r.files && r.files.length) || 0;
  // Not sent: folders, plus anything with no file on disk (dragged out of a zip, a browser, an e-mail), unreadable,
  // or past the first 50 (review 10 Nov: these used to vanish without a word).
  if (r && r.folders) showToast("Folder belum bisa dikirim: seret file-filenya");
  else if (list.length > sent) showToast("Sebagian file tidak dikirim: hanya file yang ada di disk (paling banyak 50 sekaligus)");
  if (sent) startSendFiles(r.files, sess.mirror ? null : sess);
});

// ─── Update check ─────────────────────────────────────────
// version.json on the website (see main.js check-update): a newer release gets a dismissable notice on the home
// screen; a version below "minimum" (raised only after a security fix) gets a red notice and refuses to open or accept
// connections until updated. A failed check (offline, LAN without internet) changes nothing.
let updateInfo = null, updateRequired = false;
function verCmp(a, b) {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}
const appVer = () => (config && /^\d+\.\d+\.\d+$/.test(config.appVersion || "") ? config.appVersion : "");
// In-app updates (src/updater.js, owner 18 Nov 2026, direction A): this PC's own download comes from trydesk.ai.id in
// the background and is installed only when it matches the signed download list; it installs when TryDesk is closed
// or opened again, or now with "Pasang sekarang" (which asks first when a session is live). The download waits while
// a session runs (the picture keeps the bandwidth). Every state shows in the one strip on Beranda (#update-bar),
// built like the session notice; a required update is the red version of it. Builds without it (a dev run, an
// unpacked folder) keep the old notice with the website link. The phone app (mobile-shim.js + TdUpdatePlugin.java)
// gives the same calls; there "Pasang sekarang" opens Android's own install dialog, and the app keeps running.
let upd = null;                     // the updater's state (main.js update-state), null when there is none
let updNextTry = 0, updReqTimer = null, updPrevPhase = "";
const updOn = () => !!(window.electronAPI.updateState && config && !config.serviceHost);
const updPhone = () => !!window.TD_MOBILE;
const updInApp = () => !!(upd && upd.supported && (upd.offered || upd.phase !== "idle"));
// (svcMirror: a session the Windows service runs for this PC, shown here; an update must not cut it either)
const sessionLive = () => !!host || viewerSessions().length > 0 || !!svcMirror;
const mb = (n) => (n / 1048576).toFixed(n >= 104857600 ? 0 : 1);
const UPD_IC = {
  dl: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  ready: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>',
  shield: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  good: TOAST_IC.good, bad: TOAST_IC.bad,
};
async function checkUpdate() {
  if (!appVer() || !window.electronAPI.checkUpdate) return;
  let info = null;
  try { info = await window.electronAPI.checkUpdate(); } catch {}
  if (updOn()) { try { upd = await window.electronAPI.updateState(); } catch {} }
  if (info && info.latest) {
    updateInfo = info;
    updateRequired = !!info.minimum && verCmp(appVer(), info.minimum) < 0;
  }
  updNextTry = 0; updMaybeDownload();
  renderUpdateBar(); renderUpdSettings();
}
// Download when allowed (Pembaruan otomatis on, or a required update), never during a session, and after a failed
// try not again for 2 minutes (offline PCs don't hammer the website).
function updMaybeDownload() {
  if (!updOn() || !upd || !upd.supported || !upd.offered || upd.phase !== "idle") return;
  if (!(upd.auto || updateRequired) || sessionLive() || Date.now() < updNextTry) return;
  updNextTry = Date.now() + 120000;
  window.electronAPI.updateDownload();
}
if (window.electronAPI.onUpdateState) window.electronAPI.onUpdateState((s) => {
  upd = s;
  // ready while a session runs: one short notice, nothing else changes
  if (s.phase === "ready" && updPrevPhase === "downloading" && sessionLive()) showToast(updPhone() ? "Pembaruan TryDesk siap. Pasang setelah sesi selesai." : "Pembaruan TryDesk siap. Dipasang saat TryDesk ditutup, sesi ini tidak diputus.", "good");
  updPrevPhase = s.phase;
  renderUpdateBar(); renderUpdSettings();
});
// Every 5 s: a session that starts pauses the download, the end of the last one resumes it; a required update that
// is ready installs by itself 30 s after the last session ended (connections are refused until then anyway).
setInterval(() => {
  if (!updOn() || !upd) return;
  if (upd.phase === "downloading" && sessionLive()) { window.electronAPI.updatePause(); updNextTry = 0; return; }
  updMaybeDownload();
  // (not on the phone: Android asks before every install, so its dialog would pop up by itself again and again;
  // not on a PC with the Windows service: its Setup asks Windows for permission, which nobody may be there to give)
  const autoReq = !updPhone() && svcId === null && updateRequired && upd.phase === "ready" && !sessionLive() && !updBusyUi;
  if (autoReq && !updReqTimer) updReqTimer = setTimeout(() => { updReqTimer = null; if (updateRequired && upd && upd.phase === "ready" && !sessionLive()) updInstallNow(); }, 30000);
  if (!autoReq && updReqTimer) { clearTimeout(updReqTimer); updReqTimer = null; }
}, 5000);

let updBusyUi = false;
async function updInstallNow() {
  if (updBusyUi) return;
  let confirmed = false;   // the user said yes while a session ran: main.js may then cut a service session too
  if (sessionLive()) {
    const ok = await appConfirm({
      // the title is split for its red last word, so it is translated here (as every appConfirm title)
      title: tr("Putuskan sesi untuk memasang?"),
      message: tr(updPhone() ? "Sesi yang berjalan terputus. Setelah diperbarui, buka TryDesk lagi." : "Sesi yang berjalan terputus sekitar 15 detik. Setelah TryDesk terbuka lagi, sambungkan ulang dari Terakhir dihubungi."),
      okLabel: tr("Putuskan dan pasang"), cancelLabel: tr("Pasang setelah sesi"),
    });
    if (!ok) return;
    confirmed = true;
    try { for (const s of viewerSessions()) closeSession(s, true); if (host) closeSession(host, true); } catch {}
  }
  updBusyUi = true;
  let ok = false;
  try { ok = await window.electronAPI.updateInstall(confirmed); } catch {}
  // The phone hands the file to Android's dialog and keeps running (the user may still cancel there): no
  // "Memasang" state; a switch left off or a changed file says so instead.
  if (updPhone()) {
    updBusyUi = false;
    if (ok === "permission") showToast("Izinkan TryDesk memasang aplikasi, lalu ketuk Pasang sekarang lagi.", "bad");
    else if (!ok) showToast("Pembaruan belum bisa dipasang. Coba lagi nanti.", "bad");
    renderUpdateBar(); renderUpdSettings();
    return;
  }
  if (!ok) { updBusyUi = false; showToast("Pembaruan belum bisa dipasang. Coba lagi nanti.", "bad"); }
}
// "Yang baru": the release notes in the bottom sheet TryDesk uses for questions, with the next step as its button.
async function updShowNotes() {
  const i = updateInfo, ph = upd ? upd.phase : "idle";
  const v = (upd && (upd.justUpdated && ph === "idle" ? upd.justUpdated : upd.version)) || (i && i.latest) || "";
  const note = (i && i.notes && (lang === "id" ? i.notes.id : (i.notes[lang] || i.notes.en))) || "";
  const size = upd && upd.total ? ` · ${mb(upd.total)} MB` : "";
  const act = ph === "ready" ? "Pasang sekarang" : (ph === "idle" && updInApp() && !upd.justUpdated) ? "Perbarui" : "";
  const ok = await appConfirm({
    title: `TryDesk ${v}`,
    message: note || tr("Catatan lengkap ada di trydesk.ai.id."),
    detail: tr("Sebelum dipasang, file diperiksa dengan tanda tangan TryDesk.") + (appVer() && v !== appVer() ? ` (${appVer()} → ${v}${size})` : ""),
    okLabel: tr(act || "Tutup"), cancelLabel: act ? tr("Nanti") : false,
  });
  if (!ok || !act) return;
  if (act === "Pasang sekarang") updInstallNow();
  else { updNextTry = 0; if (upd) upd.phase = "idle"; window.electronAPI.updateDownload(); }
}

function renderUpdateBar() {
  const bar = $("#update-bar"), i = updateInfo, cur = appVer();
  if (!bar) return;
  const newer = !!i && !!cur && verCmp(cur, i.latest) < 0;
  const u = updOn() && upd && upd.supported ? upd : null;
  const ph = u ? u.phase : "idle";
  const v = (u && u.version) || (i && i.latest) || "";
  let mode = "";
  if (updBusyUi || ph === "installing") mode = "installing";
  else if (ph === "ready" || ph === "downloading" || ph === "failed") mode = ph;
  else if (newer) mode = "available";
  else if (u && u.justUpdated) mode = "done";
  const key = `${mode}:${mode === "done" ? u.justUpdated : v}`;
  const show = !!mode && (updateRequired || mode === "installing" || store.get("updateDismissed") !== key);
  bar.classList.toggle("hidden", !show);
  bar.classList.toggle("required", updateRequired && mode !== "done");
  if (!show) return;
  // A new version: one sound when its notice first shows, never in the middle of a session.
  if ((mode === "available" || mode === "ready") && renderUpdateBar._snd !== key) {
    renderUpdateBar._snd = key;
    if (!host && !svcMirrorOn() && !viewerSessions().some((s) => s.pc)) playEvent("update");
  }
  const note = (i && i.notes && (lang === "id" ? i.notes.id : (i.notes[lang] || i.notes.en))) || "";
  const inApp = !!u && (u.offered || ph !== "idle");
  let ic = "dl", kind = "info", title = "", text = "", main = "", notes = false, prog = -1;
  if (mode === "installing") { title = `Memasang TryDesk ${v}`; text = "TryDesk menutup sebentar lalu terbuka lagi."; }
  else if (mode === "downloading") { title = `Mengunduh TryDesk ${v}`; prog = u.total ? Math.min(100, Math.round(100 * u.received / u.total)) : 0; text = `${prog}% · ${mb(u.received)} / ${mb(u.total)} MB`; }
  else if (mode === "ready") { ic = "ready"; kind = "good"; title = `TryDesk ${v} siap dipasang`; text = updPhone() ? "Tanda tangan cocok. Android bertanya sekali sebelum memasang." : "Tanda tangan cocok. Dipasang saat TryDesk ditutup atau dibuka lagi."; notes = true; main = "Pasang sekarang"; }
  else if (mode === "failed") {
    ic = "bad"; kind = "bad"; main = "Coba lagi";
    if (u.error === "install") { title = "Pembaruan belum terpasang"; text = "Pemasangan tidak selesai. Coba lagi, atau unduh dari website."; }
    else { title = "Pembaruan dibatalkan"; text = "File yang terunduh tidak cocok dengan tanda tangan TryDesk. File dihapus, tidak ada yang dipasang."; }
  } else if (mode === "done") { ic = "good"; kind = "good"; title = `TryDesk sudah ${u.justUpdated}`; text = "ID dan pengaturan tetap sama."; notes = true; }
  else {   // available
    title = `TryDesk ${v} tersedia`;
    if (inApp) { notes = true; main = "Perbarui"; text = u.auto && sessionLive() ? "Diunduh otomatis setelah sesi selesai." : (note || `Anda memakai versi ${cur}.`); }
    else { main = "Unduh"; text = note || `Anda memakai versi ${cur}.`; }
  }
  if (updateRequired && mode !== "done") {
    ic = "shield"; title = "Pembaruan keamanan wajib";
    if (mode === "installing") text = "TryDesk menutup sebentar lalu terbuka lagi.";
    else if (mode === "downloading") text = "Versi ini punya celah keamanan yang sudah diperbaiki. Sambungan ditolak sampai diperbarui. Pembaruan sedang diunduh.";
    else if (mode === "ready") { text = updPhone() || svcId !== null ? "Versi ini punya celah keamanan yang sudah diperbaiki. Pembaruan sudah diunduh dan diperiksa." : "Versi ini punya celah keamanan yang sudah diperbaiki. Pembaruan sudah siap, dan dipasang otomatis dalam 30 detik bila tidak ada sesi."; main = "Perbarui sekarang"; notes = false; }
    else if (mode === "failed") { /* the failure text says what to do */ }
    else { text = `Versi ${cur} punya celah keamanan yang sudah diperbaiki. Perbarui ke ${i.latest} untuk bisa terhubung lagi.`; main = inApp ? "Perbarui sekarang" : "Unduh"; notes = false; }
  }
  bar.dataset.kind = kind;
  $("#update-ic").innerHTML = UPD_IC[ic];
  $("#update-title").textContent = title;
  $("#update-text").textContent = text;
  $("#update-prog").classList.toggle("hidden", prog < 0);
  if (prog >= 0) $("#update-prog i").style.width = prog + "%";
  // a failure also offers the website (the text says "atau unduh dari website")
  const nb = $("#update-notes"), site = mode === "failed";
  nb.classList.toggle("hidden", !notes && !site);
  nb.textContent = site ? "Unduh" : "Yang baru";
  nb.dataset.act = site ? "site" : "notes";
  const btn = $("#update-download");
  btn.classList.toggle("hidden", !main);
  btn.classList.toggle("pri", !!main && !updateRequired);
  if (main) { btn.textContent = main; btn.dataset.act = main === "Unduh" ? "site" : mode === "failed" ? "retry" : mode === "ready" || main === "Perbarui sekarang" && mode === "ready" ? "install" : "download"; }
  if (updateRequired && mode === "ready") btn.dataset.act = "install";
  $("#update-dismiss").classList.toggle("hidden", updateRequired || mode === "installing");
}
// Settings › Tentang › Pembaruan: the switch and one line saying where the update stands.
function renderUpdSettings() {
  const box = $("#upd-settings");
  if (!box) return;
  const on = updOn() && upd && upd.supported;
  box.hidden = !on;
  if (!on) return;
  $("#setting-auto-update").checked = !!upd.auto;
  const ph = upd.phase, v = upd.version || (updateInfo && updateInfo.latest) || "";
  const newer = !!updateInfo && verCmp(appVer(), updateInfo.latest) < 0;
  let t0 = "TryDesk sudah versi terbaru", d0 = "Dicek saat TryDesk dibuka, lalu tiap 6 jam.", b0 = "Cek sekarang";
  if (ph === "downloading") { t0 = `Mengunduh TryDesk ${v}`; d0 = `${upd.total ? Math.round(100 * upd.received / upd.total) : 0}% · ${mb(upd.received)} / ${mb(upd.total)} MB`; b0 = ""; }
  else if (ph === "ready") { t0 = `TryDesk ${v} siap dipasang`; d0 = updPhone() ? "Tanda tangan cocok. Android bertanya sekali sebelum memasang." : "Diunduh dan diperiksa. Dipasang saat TryDesk ditutup atau dibuka lagi."; b0 = "Pasang sekarang"; }
  else if (ph === "installing") { t0 = `Memasang TryDesk ${v}`; d0 = "TryDesk menutup sebentar lalu terbuka lagi."; b0 = ""; }
  else if (ph === "failed") { t0 = upd.error === "install" ? "Pembaruan belum terpasang" : "Pembaruan dibatalkan"; d0 = upd.error === "install" ? "Pemasangan tidak selesai. Coba lagi, atau unduh dari website." : "File yang terunduh tidak cocok dengan tanda tangan TryDesk. File dihapus, tidak ada yang dipasang."; b0 = "Coba lagi"; }
  else if (newer && upd.offered) { t0 = `TryDesk ${v} tersedia`; d0 = upd.auto && sessionLive() ? "Diunduh otomatis setelah sesi selesai." : `Anda memakai versi ${appVer()}.`; b0 = "Perbarui"; }
  $("#upd-status-t").textContent = t0;
  $("#upd-status-d").textContent = d0;
  const b = $("#btn-upd-action");
  b.classList.toggle("hidden", !b0);
  if (b0) { b.textContent = b0; b.className = b0 === "Pasang sekarang" || b0 === "Perbarui" ? "btn-apply" : "btn-secondary"; }
}
const UPDATE_REFUSED = "Perbarui TryDesk dulu: versi ini punya celah keamanan yang sudah diperbaiki";
$("#update-download").addEventListener("click", (e) => {
  const act = e.currentTarget.dataset.act || "site";
  if (act === "install") return updInstallNow();
  if (act === "retry") { if (upd && upd.error === "install") { window.electronAPI.updateRetry(); updInstallNow(); return; } window.electronAPI.updateRetry(); updNextTry = 0; window.electronAPI.updateDownload(); return; }
  if (act === "download") { updNextTry = 0; window.electronAPI.updateDownload(); return; }
  window.electronAPI.openExternal((updateInfo && updateInfo.url) || "https://trydesk.ai.id/downloads/");
});
$("#update-notes").addEventListener("click", (e) => {
  if (e.currentTarget.dataset.act === "site") return window.electronAPI.openExternal((updateInfo && updateInfo.url) || "https://trydesk.ai.id/downloads/");
  updShowNotes();
});
$("#update-dismiss").addEventListener("click", () => {
  const ph = upd && upd.supported ? upd.phase : "idle";
  if (upd && upd.justUpdated && ph === "idle" && !(updateInfo && verCmp(appVer(), updateInfo.latest) < 0)) { window.electronAPI.updateAckDone(); store.set("updateDismissed", `done:${upd.justUpdated}`); }
  else {
    const mode = ph === "ready" || ph === "downloading" || ph === "failed" ? ph : "available";
    store.set("updateDismissed", `${mode}:${(upd && upd.version) || (updateInfo && updateInfo.latest) || ""}`);
  }
  renderUpdateBar();
});
$("#setting-auto-update")?.addEventListener("change", (e) => { window.electronAPI.updateAuto?.(e.target.checked); updNextTry = 0; setTimeout(updMaybeDownload, 300); });
$("#btn-upd-action")?.addEventListener("click", () => {
  const ph = upd ? upd.phase : "idle";
  if (ph === "ready") return updInstallNow();
  if (ph === "failed") { const inst = upd.error === "install"; window.electronAPI.updateRetry(); if (inst) return updInstallNow(); updNextTry = 0; window.electronAPI.updateDownload(); return; }
  if (ph === "idle" && upd && upd.offered && updateInfo && verCmp(appVer(), updateInfo.latest) < 0) { updNextTry = 0; window.electronAPI.updateDownload(); return; }
  checkUpdate();
});

// ─── Kelola banyak perangkat (owner 19 Nov, concept D9bd version 7, direction A) ───────────────────────────────────
// A new page of its own (Semua perangkat is unchanged): every saved PC as a picture, groups, select many, connect /
// disconnect many, send one file to many, and a click on a connected PC opens its tab. Entry: the link beside
// "Semua perangkat (n)" on Beranda; back from a session: the first item of Control Center. Desktop only.
// Stage 2 (Kontrol bersama) and the online/offline dot (needs a server addition) are not part of this.
var KM_ICON = {
  check: `<polyline points="20 6 9 17 4 12"/>`,
  plus: `<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`,
  pen: `<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>`,
  trash: `<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>`,
  search: `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`,
  layers: `<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>`,
  down: `<polyline points="6 9 12 15 18 9"/>`,
  left: `<polyline points="15 18 9 12 15 6"/>`,
  right: `<polyline points="9 18 15 12 9 6"/>`,
  x: `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`,
  arrow: `<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>`,
  file: `<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>`,
  unplug: `<path d="M19 5 5 19"/><path d="M8.5 8.5 6 11a4 4 0 0 0 5.7 5.7l2.5-2.5"/><path d="m15.5 15.5 2.5-2.5A4 4 0 0 0 12.3 7.3L9.8 9.8"/>`,
  alert: `<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`,
  retry: `<polyline points="23 4 23 10 17 10"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/>`,
  grid: `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>`,
  eye: `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`,
};
const kmSvg = (k, s = 15) => tileSvg(KM_ICON[k], s);
var KM_FAIL = new Set(["failPw", "failNeedPw", "failDeny", "failNoans", "failOff", "failBusy", "failErr"]);
var KM = {
  open: false, group: "all", page: 0, q: "", select: false, sel: new Set(), panel: null, edit: null, removing: null,
  undo: null, undoTimer: 0, bulk: new Map(), queue: [], queueTimer: 0, files: null, fromManage: false, last: {}, liveTimer: 0,
  segLeft: 0, perPage: 8, narrow: false,
};

// Groups live on this PC only (localStorage), like Favorit: { list: [{k, name}], of: {id: k}, seq }.
function kmGroups() {
  try { const g = JSON.parse(store.get("deviceGroups") || "null"); if (g && Array.isArray(g.list)) return { list: g.list, of: g.of || {}, seq: g.seq || 0 }; } catch {}
  return { list: [], of: {}, seq: 0 };
}
// (kept while seq > 0 even when empty: a fresh seq after deleting the last group gave the next one the same key, and
// Urungkan then put the old group's PCs into the new one)
function kmSaveGroups(g) { store.set("deviceGroups", g.list.length || Object.keys(g.of).length || g.seq > 0 ? JSON.stringify(g) : null); }
// A PC in a group stays on the page (and keeps its picture) even after it left the 12 latest.
function kmGroupedIds() { return Object.keys(kmGroups().of); }
const kmGroupName = (g, k) => (k === "all" ? trL("Semua", "All") : k === "none" ? trL("Tanpa kelompok", "No group") : (g.list.find((x) => x.k === k) || {}).name || "");

function kmDevices() {
  const g = kmGroups(), seen = new Map();
  for (const r of getRecent()) seen.set(r.id, r.time);
  for (const f of getFavorites()) if (!seen.has(f.id)) seen.set(f.id, f.time || 0);
  for (const id of Object.keys(g.of)) if (!seen.has(id)) seen.set(id, 0);
  for (const s of viewerSessions()) if (!seen.has(s.peerId)) seen.set(s.peerId, Date.now());
  return [...seen].map(([id, time]) => ({ id, time, g: g.of[id] && g.list.some((x) => x.k === g.of[id]) ? g.of[id] : null })).sort((a, b) => b.time - a.time);
}
const kmShown = (id) => (/^lan:/.test(id) ? id.slice(4) : fmtId(id));
const kmLabel = (id) => peerName(id) || kmShown(id);

// What a PC is doing right now: from its tab (if any) and from the connect-many run.
function kmState(id) {
  const s = sessions.get(id), b = KM.bulk.get(id);
  if (s && s.role === "viewer") {
    if (s.pc && s.everConnected) return "conn";
    if (b && KM_FAIL.has(b.st)) return b.st;
    if (!s.pc && s.pwRound >= 1) return "wait";
    return "connecting";
  }
  // A run's "connecting" / "waiting" with no tab left: that tab was closed, disconnected or timed out after it had
  // connected (audit 19 Nov: the picture then stayed "Menyambung…" and couldn't be clicked). Back to plain.
  if (b && (b.st === "connecting" || b.st === "wait")) { KM.bulk.delete(id); return "idle"; }
  if (b) return b.st;
  return "idle";
}
const kmBusy = (st) => st === "connecting" || st === "wait" || st === "queue";
function kmStateText(st) {
  return ({
    connecting: trL("Menyambung…", "Connecting…"), wait: trL("Menunggu Terima di PC itu", "Waiting for Accept on that PC"),
    queue: trL("Antre", "Queued"), failPw: trL("Password salah", "Wrong password"), failNeedPw: trL("Minta password", "Asks for a password"),
    failDeny: trL("Ditolak di PC itu", "Declined on that PC"), failNoans: trL("Tidak ada jawaban", "No answer"),
    failOff: trL("Offline", "Offline"), failBusy: trL("Sedang sibuk", "Busy"), failErr: trL("Gagal tersambung", "Could not connect"),
  })[st] || "";
}
// Called from the signaling code (connection-challenge / rejected / error / time-out) for a tab opened here.
function kmNote(id, st) {
  // "Wrong password" stays the reason when that PC's Accept dialog then times out (it was turning into "No answer",
  // and the user tried the same wrong password again)
  const was = KM.bulk.get(id);
  if (st === "failNoans" && was && (was.st === "failPw" || was.st === "failNeedPw")) return;
  KM.bulk.set(id, { ...(was || {}), st, at: Date.now() });
  kmRefresh();
}

// ── opening / closing the page ──
function setManageOpen(on) {
  KM.open = !!on;
  document.documentElement.classList.toggle("manage-open", KM.open);
  if (KM.open) {
    document.documentElement.classList.remove("devices-open");
    closeTileMenu();
    KM.last = {};
    kmRender({ fx: "tiles" });
    if (!motionOff()) arrive($("#km"), $("#km-title"));
    clearInterval(KM.liveTimer); KM.liveTimer = setInterval(kmLive, 1000);
  } else {
    clearInterval(KM.liveTimer); KM.panel = null; KM.edit = null; KM.select = false; KM.sel.clear(); kmCloseMenu();
  }
}
function kmRefresh() { if (KM && KM.open) kmRender(); }

// ── the page ──
function kmEl(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function kmBtn(cls, html, fn, attrs = {}) {
  const b = kmEl("button", cls, html); b.type = "button";
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) b.setAttribute(k, v === true ? "" : v);
  if (fn) b.addEventListener("click", (e) => { e.stopPropagation(); fn(e, b); });
  return b;
}
function kmInGroup(devs) {
  let list = KM.group === "all" ? devs : KM.group === "none" ? devs.filter((d) => !d.g) : devs.filter((d) => d.g === KM.group);
  const q = KM.q.trim().toLowerCase().replace(/\s+/g, "");
  if (q) list = list.filter((d) => d.id.replace(/\s/g, "").toLowerCase().includes(q) || (peerName(d.id) || "").toLowerCase().replace(/\s+/g, "").includes(q));
  return list;
}

function kmRender(opts = {}) {
  const root = $("#km"); if (!root) return;
  const g = kmGroups(), devs = kmDevices();
  if (KM.group !== "all" && KM.group !== "none" && !g.list.some((x) => x.k === KM.group)) KM.group = "all";
  if (KM.group === "none" && !devs.some((d) => !d.g)) KM.group = "all";
  const fx = new Set(opts.fx ? [opts.fx] : []);
  if (KM.last.group !== undefined && KM.last.group !== KM.group) fx.add("tiles");
  if (KM.last.page !== undefined && KM.last.group === KM.group && KM.last.page !== KM.page) fx.add(KM.page > KM.last.page ? "next" : "prev");
  if (KM.select && !KM.last.select) fx.add("bar");
  root.classList.remove("fx-tiles", "fx-next", "fx-prev", "fx-bar");
  if (!motionOff()) { void root.offsetWidth; for (const f of fx) root.classList.add("fx-" + f); }

  // Keyboard focus survives the redraw (audit 19 Nov: every click / live update dropped it to the page body, so
  // picking several PCs with the keyboard meant tabbing through the whole page each time).
  const ae = document.activeElement;
  const fsel = opts.focus || (ae && root.contains(ae) && ae.id !== "km-search"
    ? (ae.dataset.id ? `[data-id="${CSS.escape(ae.dataset.id)}"]` : ae.dataset.k ? `[data-k="${CSS.escape(ae.dataset.k)}"]` : ae.id ? "#" + CSS.escape(ae.id) : null) : null);
  KM.narrow = kmNarrow(root);
  kmRenderRow(g, devs);
  kmRenderBanner();
  const list = kmInGroup(devs);
  const pages = Math.max(1, Math.ceil(list.length / KM.perPage));
  KM.page = Math.min(KM.page, pages - 1);
  kmRenderGrid(list.slice(KM.page * KM.perPage, KM.page * KM.perPage + KM.perPage), devs, list);
  // One page with one row (1-4 PCs, as on a new install): the row sits right under the groups. Sharing the room out
  // (meant for two rows) left it floating a third down an empty page (owner's Linux report 22 Nov, "terlihat rusak").
  $("#km-grid")?.classList.toggle("km-one", pages === 1 && list.length <= KM_COLS);
  kmRenderFoot(list, pages);
  // how many pictures fit: measured from the real grid (columns and whole rows, see kmFit)
  const fit = kmFit();
  // a new fit keeps the first picture shown on screen (was: back to page 1 on any resize)
  if (fit && fit !== KM.perPage) { const first = KM.page * KM.perPage; KM.perPage = fit; KM.page = Math.floor(first / fit); return kmRender({ ...opts, focus: fsel }); }
  KM.last = { group: KM.group, page: KM.page, select: KM.select };
  KM.sig = kmSig();
  if (fsel) { const n = root.querySelector(fsel); if (n && document.activeElement !== n) { try { n.focus({ preventScroll: true }); } catch {} } }
}
const kmSig = () => kmDevices().map((d) => d.id + "=" + kmState(d.id)).join("|");
// How many pictures a page holds: 8, four across and two down, at every window size (owner 21 Nov: "cukup 8
// perangkat aja yang tampil"); a bigger window shows them bigger. Only when two rows can't fit (a very low window)
// does a page hold one row. The room the rows don't use is shared out above, between and under them (.km-grid
// align-content), not left as one empty band under the pictures ("kenapa ada slot kosong").
const KM_COLS = 4, KM_ROWS = 2, KM_PHONE_MAX = 4;
// A narrow window picks the group from a list; the phone keeps the sliding group row (Android concept, owner 21 Nov).
const kmNarrow = (root) => root.clientWidth < 820 && !isPhoneUi();
function kmFit() {
  const grid = $("#km-grid"); if (!grid || !grid.clientWidth) return 0;
  // The phone: every PC on one page that scrolls, two across (the Android concept); no pages.
  if (isPhoneUi()) { grid.style.gridTemplateRows = ""; return 999; }
  const cs = getComputedStyle(grid);
  const gapR = parseFloat(cs.rowGap) || 14, gapC = parseFloat(cs.columnGap) || 16;
  // the line under each picture (name, status), measured on a drawn tile: one line, see .km-meta
  const t = grid.querySelector(".km-tile"), th = t && t.querySelector(".km-th");
  const metaH = t && th && t.offsetHeight > th.offsetHeight ? t.offsetHeight - th.offsetHeight : 27;
  const avail = grid.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const w = (grid.clientWidth - (KM_COLS - 1) * gapC) / KM_COLS, tileH = w * 9 / 16 + metaH;
  const rows = Math.max(1, Math.min(KM_ROWS, Math.floor((avail + gapR) / (tileH + gapR))));
  grid.style.gridTemplateRows = `repeat(${rows}, min-content)`;   // (a last page with one row keeps it in place)
  return KM_COLS * rows;
}

// Row: groups (slides when they are many), Kelompok baru, Atur | search, Pilih — one line (owner 19 Nov).
function kmRenderRow(g, devs) {
  const row = $("#km-row"); if (!row) return;
  const keepLeft = row.querySelector(".km-segw")?.scrollLeft ?? KM.segLeft;
  const focusSearch = document.activeElement && document.activeElement.id === "km-search";
  const caret = focusSearch ? document.activeElement.selectionStart : null;
  row.replaceChildren();
  const keys = ["all", ...g.list.map((x) => x.k), ...(devs.some((d) => !d.g) && g.list.length ? ["none"] : [])];
  const count = (k) => (k === "all" ? devs.length : k === "none" ? devs.filter((d) => !d.g).length : devs.filter((d) => d.g === k).length);
  if (KM.narrow) {
    const dd = kmBtn("km-dd", `${kmSvg("layers", 14)}<span class="km-dd-n"></span><small>${count(KM.group)}</small>${kmSvg("down", 14)}`, (e, b) => kmGroupMenu(b, keys, count), { "aria-haspopup": "menu", id: "km-dd" });
    dd.querySelector(".km-dd-n").textContent = kmGroupName(g, KM.group);
    row.append(dd);
  } else {
    const w = kmEl("div", "km-segw"), seg = kmEl("div", "km-seg sess-tabs"); seg.setAttribute("role", "tablist");
    for (const k of keys) {
      const b = kmBtn("km-gt sess-tab" + (KM.group === k ? " active" : "") + (KM.removing === k ? " km-gone" : "") + (KM.born === k ? " km-born" : ""), "", () => kmSetGroup(k), { role: "tab", "aria-selected": String(KM.group === k), "data-k": k });
      const n = kmEl("span"); n.textContent = kmGroupName(g, k);
      const c = kmEl("span", "sess-count"); c.textContent = count(k);
      b.append(n, c);
      if (k !== "all" && k !== "none") b.addEventListener("contextmenu", (e) => { e.preventDefault(); kmGroupCtx(k, b); });
      seg.appendChild(b);
    }
    w.appendChild(seg);
    w.addEventListener("scroll", () => { KM.segLeft = w.scrollLeft; kmSegMask(w); });
    w.addEventListener("wheel", (e) => { if (w.scrollWidth > w.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { w.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
    kmDragScroll(w);
    row.append(w);
  }
  // Icons only (owner 21 Nov: "kelompok baru cukup tombol icon + dan manage cukup tombol icon tulis", the page was too
  // full); the words stay as the tooltip and for screen readers.
  const nb = kmBtn("km-ib", kmSvg("plus", 16), () => kmOpenPanel("newgroup"), { title: trL("Kelompok baru", "New group"), "aria-label": trL("Kelompok baru", "New group"), id: "km-newgroup" });
  const mb = kmBtn("km-ib", kmSvg("pen", 15), () => kmOpenPanel("gmanage"), { title: trL("Ganti nama atau hapus kelompok", "Rename or delete groups"), "aria-label": trL("Atur kelompok", "Manage groups"), id: "km-gmanage" });
  const sp = kmEl("span", "km-sp");
  const srch = kmEl("label", "km-search sess-search", kmSvg("search", 14));
  const inp = kmEl("input"); inp.type = "text"; inp.id = "km-search"; inp.autocomplete = "off"; inp.spellcheck = false;
  inp.placeholder = trL("Cari nama atau ID", "Search name or ID"); inp.value = KM.q;
  // (not mid-composition: Japanese / Chinese / Korean typing builds a word first, and a redraw would break it)
  const onSearch = (e) => { if (e.isComposing) return; KM.q = inp.value; KM.page = 0; kmRender(); };
  inp.addEventListener("input", onSearch);
  inp.addEventListener("compositionend", onSearch);
  srch.appendChild(inp);
  const pick = kmBtn("km-btn" + (KM.select ? " km-btn-quiet" : ""), "", () => { KM.select = !KM.select; KM.sel.clear(); kmRender(); }, { id: "km-pick" });
  pick.textContent = KM.select ? trL("Batal", "Cancel") : trL("Pilih", "Select");
  if (isPhoneUi()) kmPhoneHead(mb, pick);   // the phone: pencil and Pilih sit in the top bar, the row is only the groups
  else row.append(nb, mb, sp, srch, pick);
  const w = row.querySelector(".km-segw");
  if (w) {
    w.scrollLeft = keepLeft;
    const on = w.querySelector(".active");
    if (on && w.scrollWidth > w.clientWidth) {
      const x = on.offsetLeft;
      if (x + on.offsetWidth > w.scrollLeft + w.clientWidth - 36) w.scrollLeft = x + on.offsetWidth - w.clientWidth + 36;
      if (x < w.scrollLeft + 36) w.scrollLeft = Math.max(0, x - 36);
    }
    kmSegMask(w);
  }
  if (focusSearch) { inp.focus({ preventScroll: true }); if (caret != null) inp.setSelectionRange(caret, caret); }
}
// The phone's top bar (Android concept, owner 21 Nov): ‹ title, pencil, Pilih. While picking: ×, "N dipilih", Semua
// (every PC of the group shown). New groups are made from the pencil's window; the phone has no search (concept).
function kmPhoneHead(mb, pick) {
  const head = $("#km .km-head"); if (!head) return;
  head.querySelector(".km-hact")?.remove(); head.querySelector(".km-hsel")?.remove();
  head.classList.toggle("km-head-sel", KM.select);
  if (KM.select) {
    const box = kmEl("span", "km-hsel");
    const x = kmBtn("km-ib", kmSvg("x", 18), () => { KM.select = false; KM.sel.clear(); kmRender(); }, { "aria-label": trL("Batal", "Cancel") });
    const n = kmEl("span", "km-cnt"); n.textContent = trL(`${KM.sel.size} dipilih`, `${KM.sel.size} selected`);
    const all = kmBtn("km-ghost", "", () => { kmInGroup(kmDevices()).forEach((d) => KM.sel.add(d.id)); kmRender(); }); all.textContent = trL("Semua", "All");
    box.append(x, n, all); head.appendChild(box);
    return;
  }
  const box = kmEl("span", "km-hact");
  pick.className = "km-ghost"; box.append(mb, pick); head.appendChild(box);
}
// The group row slides sideways by dragging it with the mouse too (owner 21 Nov: "tidak bisa scroll ke samping kiri
// atau kanan", and no scrollbar). A drag never counts as a click on the group it started on.
function kmDragScroll(w) {
  let d = null;
  w.addEventListener("pointerdown", (e) => { if (e.button === 0 && e.pointerType === "mouse" && w.scrollWidth > w.clientWidth) d = { x: e.clientX, left: w.scrollLeft, moved: false, id: e.pointerId }; });
  w.addEventListener("pointermove", (e) => {
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 5) return;
    if (!d.moved) { d.moved = true; try { w.setPointerCapture(e.pointerId); } catch {} w.classList.add("km-drag"); }
    w.scrollLeft = d.left - dx;
  });
  const up = () => {
    if (!d) return; const moved = d.moved; d = null; w.classList.remove("km-drag");
    if (moved) { const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); }; w.addEventListener("click", stop, { capture: true, once: true }); setTimeout(() => w.removeEventListener("click", stop, { capture: true }), 0); }
  };
  w.addEventListener("pointerup", up); w.addEventListener("pointercancel", up);
}
function kmSegMask(w) {
  const over = w.scrollWidth > w.clientWidth + 1;
  w.classList.toggle("ovl", over && w.scrollLeft > 1);
  w.classList.toggle("ovr", over && w.scrollLeft < w.scrollWidth - w.clientWidth - 1);
}
function kmSetGroup(k) { if (KM.group !== k) { KM.group = k; KM.page = 0; } kmCloseMenu(); kmRender(); }

function kmRenderBanner() {
  const bn = $("#km-banner"); if (!bn) return;
  bn.replaceChildren();
  if (KM.undo) {
    const tx = kmEl("span", "km-bn-tx"); tx.textContent = trL(`Kelompok ${KM.undo.name} dihapus. PC di dalamnya tetap ada di Semua.`, `Deleted the ${KM.undo.name} group. Its PCs stay in All.`);
    const u = kmBtn("km-btn", "", kmUndo); u.textContent = trL("Urungkan", "Undo");
    bn.append(kmEl("span", "km-bn-ic", kmSvg("check", 16)), tx, u);
    bn.className = "km-bn km-bn-ok"; return;
  }
  const failed = kmDevices().filter((d) => KM_FAIL.has(kmState(d.id)));
  if (failed.length && !KM.dismissFail) {
    const tx = kmEl("span", "km-bn-tx");
    const b = kmEl("b"); b.textContent = trL(`${failed.length} PC gagal tersambung.`, `${failed.length} PC${failed.length !== 1 ? "s" : ""} could not connect.`);
    tx.append(b, " ", trL("Alasannya tertulis di gambarnya.", "The reason is written on its picture."));
    const r = kmBtn("km-btn", `${kmSvg("retry", 14)}<span></span>`, () => kmRetryFailed());
    r.lastChild.textContent = trL("Coba lagi yang gagal", "Retry the failed ones");
    const x = kmBtn("km-ib", kmSvg("x", 15), () => { KM.dismissFail = true; for (const d of failed) KM.bulk.delete(d.id); kmRender(); }, { "aria-label": trL("Tutup", "Close") });
    bn.append(kmEl("span", "km-bn-ic bad", kmSvg("alert", 16)), tx, r, x);
    bn.className = "km-bn"; return;
  }
  bn.className = "km-bn hidden";
}

function kmRenderGrid(page, devs, list) {
  const grid = $("#km-grid"); if (!grid) return;
  grid.replaceChildren();
  grid.classList.toggle("km-select", KM.select);
  if (!devs.length) return grid.appendChild(kmEmpty("monitor", trL("Belum ada perangkat", "No devices yet"), trL("PC yang pernah Anda hubungkan muncul di sini bersama gambar layar terakhirnya. Kelompokkan nanti, misalnya Kantor dan Rumah.", "PCs you connect to show up here with their last screen. Group them later, for example Office and Home."), trL("Hubungkan PC pertama", "Connect your first PC"), () => { setManageOpen(false); remoteIdInput.focus(); }));
  if (!list.length && KM.q) return grid.appendChild(kmEmpty("search", trL(`Tidak ada PC yang cocok dengan "${KM.q}".`, `No PC matches "${KM.q}".`), "", trL("Hapus pencarian", "Clear search"), () => { KM.q = ""; kmRender(); }, true));
  if (!list.length) return grid.appendChild(kmEmpty("layers", trL("Kelompok ini masih kosong", "This group is empty"), trL("Pilih PC di Semua, lalu tekan Kelompok untuk memindahkannya ke sini.", "Select PCs in All, then press Group to move them here."), trL("Pilih PC", "Select PCs"), () => { KM.group = "all"; KM.page = 0; KM.select = true; KM.sel.clear(); kmRender(); }));
  const thumbs = getThumbs();
  page.forEach((d, i) => grid.appendChild(kmTile(d, thumbs, i)));
}
function kmEmpty(icon, title, text, btn, fn, quiet) {
  const e = kmEl("div", "km-empty");
  const ill = kmEl("span", "km-empty-ill", icon === "monitor" ? MONITOR_SVG : kmSvg(icon, 22));
  const b = kmEl("b"); b.textContent = title;
  e.append(ill, b);
  if (text) { const p = kmEl("p"); p.textContent = text; e.appendChild(p); }
  if (btn) { const x = kmBtn(quiet ? "km-btn" : "btn-connect km-cta", "", fn); x.textContent = btn; e.appendChild(x); }
  return e;
}
function kmTile(d, thumbs, i) {
  const st = kmState(d.id), sel = KM.sel.has(d.id), live = st === "conn";
  const t = kmEl("div", "km-tile" + (sel ? " sel" : "") + (kmBusy(st) || st === "failPw" || st === "failDeny" ? " dim" : "") + (KM.chg && KM.chg.has(d.id) ? " chg" : ""));
  t.setAttribute("role", "button"); t.tabIndex = 0; t.dataset.id = d.id; t.style.setProperty("--i", i);
  if (KM.select) t.setAttribute("aria-pressed", String(sel));
  const th = kmEl("span", "km-th");
  if (live) { const c = kmEl("canvas", "km-live"); c.width = 320; c.height = 180; c.dataset.id = d.id; th.appendChild(c); kmPaintLive(c); }
  else if (thumbs[d.id]) { const img = new Image(); img.alt = ""; img.draggable = false; img.src = thumbs[d.id]; th.appendChild(img); }
  else th.appendChild(kmEl("span", "km-noimg", MONITOR_SVG));
  if (live) { const l = kmEl("span", "km-tl", "<i></i><span></span>"); l.lastChild.textContent = trL("Langsung", "Live"); th.appendChild(l); }
  else if (d.time && thumbs[d.id]) { const l = kmEl("span", "km-tl km-last"); l.textContent = trL(`Terakhir ${formatTime(d.time)}`, `Last seen ${formatTime(d.time)}`); th.appendChild(l); }
  if (kmBusy(st)) { const m = kmEl("span", "km-mid", `<span class="km-lbl"><i class="km-spin"></i><span></span></span>`); m.querySelector(".km-lbl span").textContent = kmStateText(st); th.appendChild(m); }
  if (KM.select) th.appendChild(kmEl("span", "km-ck" + (sel ? " on" : "") + (KM.picked === d.id ? " pop" : ""), sel ? kmSvg("check", 13) : ""));
  const meta = kmEl("span", "km-meta");
  const nm = kmEl("b", "km-nm tile-id"); nm.textContent = kmLabel(d.id);   // tile-id: the shared tile menu renames it in place
  // online / offline: a dot before the name (concept: "cukup tanda titik ... teks online gaperlu")
  const nmw = kmEl("span", "km-nmw"); const pd = presDot(d.id); pd.classList.add("km-pd"); nmw.append(pd, nm);
  meta.appendChild(nmw);
  if (peerName(d.id)) { const id = kmEl("span", "km-id"); id.textContent = kmShown(d.id); meta.appendChild(id); }
  if (KM_FAIL.has(st) || kmBusy(st)) { const s = kmEl("span", "km-st " + (KM_FAIL.has(st) ? "fail" : "busy")); s.textContent = kmStateText(st); meta.appendChild(s); }
  t.append(th, meta);
  t.setAttribute("aria-label", `${kmLabel(d.id)}, ${live ? trL("Tersambung", "Connected") : kmStateText(st) || kmShown(d.id)}`);
  if (peerName(d.id)) t.title = `${kmLabel(d.id)} · ${kmShown(d.id)}`;   // the ID, where the tile has no room for it
  t.addEventListener("click", (e) => { if (!e.target.closest("input")) kmPick(d.id); });
  t.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === t) { e.preventDefault(); kmPick(d.id); } });
  t.addEventListener("contextmenu", (e) => { e.preventDefault(); openTileMenu(d.id, t, { x: e.clientX, y: e.clientY }); });
  return t;
}
function kmPaintLive(c) {
  const s = sessions.get(c.dataset.id), v = s && s.video;
  if (!v || !v.videoWidth) return;
  try { c.getContext("2d").drawImage(v, 0, 0, c.width, c.height); } catch {}
}
// Connected PCs refresh their picture once a second while the page is open (a still from the running session, so
// nothing extra is sent over the network; the lighter "preview stream" is a later step).
function kmLive() {
  if (!KM.open || document.hidden) return;
  $$("#km-grid canvas.km-live").forEach(kmPaintLive);
  // a connection that finished or failed since the last render: redraw (states are read, not pushed)
  if (KM.panel && KM.panel !== "files") return;   // never redraw under an open window (it would drop what is typed)
  const sig = kmSig();
  if (sig !== KM.sig) {
    const was = Object.fromEntries((KM.sig || "").split("|").map((p) => p.split("=")));
    KM.chg = new Set(sig.split("|").map((p) => p.split("=")).filter(([id, s]) => was[id] && was[id] !== s).map(([id]) => id));
    kmRender(); KM.chg = null;
  }
}
function kmPick(id) {
  if (KM.select) { KM.sel.has(id) ? KM.sel.delete(id) : KM.sel.add(id); KM.picked = id; kmRender(); KM.picked = null; return; }
  const st = kmState(id), s = sessions.get(id);
  if (st === "conn" && s) { setManageOpen(false); switchTab(s); return; }
  if (kmBusy(st)) { if (s) { setManageOpen(false); switchTab(s); } return; }
  KM.bulk.delete(id);
  // a failed PC whose tab is still waiting (wrong password, the other PC's dialog still up): start again in front, so
  // the password box shows (audit 19 Nov: it opened that tab without one and went home silently 30 s later)
  if (s && !s.pc) closeSession(s, true);
  setManageOpen(false);
  connectFromTile(id);
}

function kmRenderFoot(list, pages) {
  const f = $("#km-foot"); if (!f) return;
  f.replaceChildren();
  if (KM.select) {
    f.className = "km-foot km-selbar";
    const devs = kmDevices().filter((d) => KM.sel.has(d.id));
    const nc = devs.filter((d) => kmState(d.id) === "conn").length, nOther = devs.filter((d) => kmState(d.id) !== "conn" && !kmBusy(kmState(d.id))).length;
    const mk0 = (icon, text, fn, on, cls = "km-btn") => { const b = kmBtn(cls, `${kmSvg(icon, 18)}<span></span>`, fn); b.lastChild.textContent = text; b.disabled = !on; return b; };
    if (isPhoneUi()) {
      // The phone (Android concept): the count is in the top bar; the actions fill the bottom, icon over word. No
      // "Kirim file": the phone app has no file transfer at all. A phone keeps at most 4 PCs connected (concept:
      // 4 live pictures on a phone), so Hubungkan says so instead of opening a fifth.
      const all = kmDevices(), live = all.filter((d) => kmState(d.id) === "conn" || kmBusy(kmState(d.id))).length;
      const go = () => { if (live + nOther > KM_PHONE_MAX) { playEvent("warn"); return showToast(trL(`Di HP paling banyak ${KM_PHONE_MAX} PC tersambung sekaligus.`, `A phone keeps at most ${KM_PHONE_MAX} PCs connected at once.`)); } kmOpenPanel("pw"); };
      f.className = "km-foot km-selbar km-pact";
      f.append(
        mk0("arrow", trL("Hubungkan", "Connect"), go, nOther > 0, "km-btn km-red"),
        mk0("unplug", trL("Putuskan", "Disconnect"), () => kmDisconnect(), nc > 0),
        mk0("layers", trL("Kelompok", "Group"), () => kmOpenPanel("move"), KM.sel.size > 0),
      );
      return;
    }
    const cnt = kmEl("span", "km-cnt"); cnt.textContent = trL(`${KM.sel.size} dipilih`, `${KM.sel.size} selected`);
    f.appendChild(cnt);
    if (!KM.narrow) { const all = kmBtn("km-link", "", () => { const pg = kmInGroup(kmDevices()).slice(KM.page * KM.perPage, KM.page * KM.perPage + KM.perPage); pg.forEach((d) => KM.sel.add(d.id)); kmRender(); }); all.textContent = trL("Pilih semua di halaman", "Select this page"); f.appendChild(all); }
    f.appendChild(kmEl("span", "km-sp"));
    const mk = (icon, text, fn, on, cls = "km-btn") => { const b = kmBtn(cls, `${kmSvg(icon, 14)}<span></span>`, fn); b.lastChild.textContent = text; b.disabled = !on; return b; };
    f.append(
      mk("file", trL("Kirim file", "Send file"), () => kmSendFiles(), nc > 0),
      mk("layers", trL("Kelompok", "Group"), () => kmOpenPanel("move"), KM.sel.size > 0),
      mk("unplug", trL("Putuskan", "Disconnect"), () => kmDisconnect(), nc > 0),
      mk("arrow", trL("Hubungkan", "Connect"), () => kmOpenPanel("pw"), nOther > 0, "btn-connect km-go"),
    );
    return;
  }
  f.className = "km-foot";
  const run = [...KM.bulk.entries()].filter(([id, b]) => b.run);
  const busy = run.filter(([id]) => kmBusy(kmState(id)));
  if (busy.length) {
    const c = run.filter(([id]) => kmState(id) === "conn").length, w = run.filter(([id]) => ["connecting", "wait"].includes(kmState(id))).length, q = run.filter(([id]) => kmState(id) === "queue").length;
    const sum = kmEl("span", "km-sum", `<i class="km-spin"></i><span></span>`);
    sum.lastChild.textContent = trL(`Menyambungkan ${run.length} PC · ${c} tersambung, ${w} menunggu, ${q} antre`, `Connecting ${run.length} PC${run.length !== 1 ? "s" : ""} · ${c} connected, ${w} waiting, ${q} queued`);
    const done = run.length - busy.length, bar = kmEl("span", "km-prog", `<i style="width:${Math.round(done / run.length * 100)}%"></i>`);
    const stop = kmBtn("km-btn km-btn-quiet", "", kmStopBulk); stop.textContent = trL("Hentikan", "Stop");
    f.append(sum, bar, kmEl("span", "km-sp"), stop);
    return;
  }
  if (isPhoneUi()) { f.className = "km-foot km-foot-none"; return; }   // the phone: no summary and no pages (concept)
  const all = kmDevices(), c = all.filter((d) => kmState(d.id) === "conn").length;
  const sum = kmEl("span", "km-sum", `<i class="km-dot"></i><span></span>`);
  sum.lastChild.textContent = trL(`${c} tersambung · ${all.length} PC tersimpan`, `${c} connected · ${all.length} saved PC${all.length !== 1 ? "s" : ""}`);
  f.append(sum, kmEl("span", "km-sp"));
  const pg = kmEl("span", "km-pager");
  const prev = kmBtn("km-ib", kmSvg("left", 16), () => { KM.page = Math.max(0, KM.page - 1); kmRender(); }, { "aria-label": trL("Halaman sebelumnya", "Previous page") });
  const next = kmBtn("km-ib", kmSvg("right", 16), () => { KM.page = Math.min(pages - 1, KM.page + 1); kmRender(); }, { "aria-label": trL("Halaman berikutnya", "Next page") });
  prev.disabled = KM.page === 0; next.disabled = KM.page >= pages - 1;
  const n = kmEl("span"); n.textContent = `${KM.page + 1} / ${pages}`;
  pg.append(prev, n, next);
  f.appendChild(pg);
}

// ── connect many: a password once (kept only with each queued PC until its request goes), every PC still shows
//    Accept or checks its own password. The server lets an app send 5 requests in any 10 s, counting every request
//    (audit 19 Nov: a burst of 4 then one every 2.2 s made PCs 6, 7 and 8 fail): at most 4 in any 10 s here, so one
//    stays free for a connect by hand, and a "too many" refusal goes back in the queue. ──
function kmQueueTick() {
  const now = Date.now();
  while (connReqTimes.length && now - connReqTimes[0] > 10500) connReqTimes.shift();
  while (KM.queue.length && connReqTimes.length < 4) { const q = KM.queue.shift(); kmStartOne(q.id, q.pw); }
  if (!KM.queue.length) { clearInterval(KM.queueTimer); KM.queueTimer = 0; }
}
function kmQueueRun() { kmQueueTick(); if (KM.queue.length && !KM.queueTimer) KM.queueTimer = setInterval(kmQueueTick, 400); }
function kmConnectMany(ids, pw) {
  KM.dismissFail = false;
  // PCs of an earlier run that are done (connected or failed) leave the "Menyambungkan N PC" count
  for (const [id, b] of [...KM.bulk]) if (b.run && !kmBusy(kmState(id))) KM.bulk.delete(id);
  // each PC keeps the password it was queued with (a second run with another password changes only its own PCs)
  for (const id of ids) { KM.bulk.set(id, { st: "queue", run: true }); KM.queue = KM.queue.filter((q) => q.id !== id); KM.queue.push({ id, pw: pw || "" }); }
  kmQueueRun();
  kmRender();
}
function kmRequeue(id, pw = "") {
  const b = KM.bulk.get(id), s = sessions.get(id);
  if (s && !s.pc) closeSession(s, false);
  KM.bulk.set(id, { ...(b || {}), st: "queue", run: true });
  KM.queue.unshift({ id, pw });
  kmQueueRun(); kmRefresh();
}
function kmStartOne(id, pw) {
  const b = KM.bulk.get(id); if (!b || b.st !== "queue") return;
  b.st = "connecting";
  const had = sessions.has(id);
  const s = initiateConnection(id, pw, { background: true });
  // only a tab opened here is a Kelola one: a tab the user opened by hand meanwhile keeps its own prompts
  if (s instanceof Session) { if (!had) s.bulk = true; } else KM.bulk.set(id, { st: "failErr", run: true });
  kmRefresh();
}
function kmStopBulk() {
  clearInterval(KM.queueTimer); KM.queueTimer = 0; KM.queue = [];
  kmKeepPage(() => {
    for (const [id, b] of [...KM.bulk]) {
      if (!b.run) continue;
      const s = sessions.get(id);
      if (s && !s.everConnected) closeSession(s, true);
      KM.bulk.delete(id);
    }
  });
  kmRender();
}
// Closing tabs from the page: when the one in front goes, the app switches to another tab's remote screen, which
// closed the page (audit 19 Nov: "Putuskan" threw the user into another PC). The page stays where it was.
function kmKeepPage(fn) {
  const was = KM.open;
  fn();
  if (was && !KM.open) { showScreen("home"); setManageOpen(true); }
}
function kmRetryFailed() {
  const ids = kmDevices().filter((d) => KM_FAIL.has(kmState(d.id))).map((d) => d.id);
  kmKeepPage(() => { for (const id of ids) { const s = sessions.get(id); if (s && !s.everConnected) closeSession(s, true); } });
  KM.select = true; KM.sel = new Set(ids);
  kmOpenPanel("pw");
}
function kmDisconnect() {
  let n = 0;
  kmKeepPage(() => { for (const id of [...KM.sel]) { const s = sessions.get(id); if (s && kmState(id) === "conn") { closeSession(s, true); n++; } } });
  KM.select = false; KM.sel.clear();
  if (n) showToast(trL(`${n} PC diputus.`, `Disconnected ${n} PC${n !== 1 ? "s" : ""}.`), "good");
  kmRender();
}

// ── send one file (or a few) to many: picked once, each PC gets them one after the other ──
async function kmSendFiles(more) {
  const targets = (KM.files && more ? KM.files.targets : [...KM.sel]).filter((id) => kmState(id) === "conn");
  if (!targets.length) return;
  let files;
  try { files = await window.electronAPI.filePick(); } catch { files = null; }
  if (!files || !files.length) return;
  const old = more && KM.files ? KM.files : null, rows = old ? old.rows : new Map();
  const allFiles = [...(old ? old.all : []), ...files];
  KM.files = { all: allFiles, names: allFiles.map((f) => f.name), size: allFiles.reduce((a, f) => a + (f.size || 0), 0), targets: old ? old.targets : [...KM.sel], rows };
  for (const id of KM.files.targets) if (!rows.has(id)) rows.set(id, { p: 0, st: kmState(id) === "conn" ? "wait" : "skip", note: "", queue: [], running: false });
  KM.panel = "files"; kmRenderPanel(true);
  for (const id of targets) {
    const s = sessions.get(id), row = rows.get(id);
    // "Tambah file" while this PC is still receiving: the new files follow (audit 19 Nov: they were dropped and the
    // row still ended "Selesai")
    if (row.running) { row.queue.push(...files); continue; }
    if (!s || !s.fileChannel || s.fileChannel.readyState !== "open") { row.st = "fail"; row.note = trL("Belum siap untuk transfer", "Not ready for a transfer"); continue; }
    if (fileBusy(s)) { row.st = "fail"; row.note = trL("Masih ada transfer lain", "Another transfer is still running"); continue; }
    row.queue = [...files]; row.running = true; row.note = "";
    (async () => {
      while (row.queue.length) {
        const f = row.queue.shift();
        row.st = "send"; row.p = 0; kmFilesPaint();
        await sendOneFile(s, f, (kind, done, total, why) => {
          if (kind === "prog") row.p = total ? Math.min(99, Math.round(done / total * 100)) : 0;
          if (kind === "done") { row.p = 100; row.st = "done"; }
          if (kind === "fail") { row.st = "fail"; row.note = why || trL("Dibatalkan", "Canceled"); }
          kmFilesPaint();
        });
        if (row.st === "fail") { row.queue = []; break; }
      }
      row.running = false;
    })();
  }
  kmFilesPaint();
}
function kmFilesPaint() {
  const box = $("#km-files-rows"); if (!box || !KM.files) return;
  for (const [id, r] of KM.files.rows) {
    const el = box.querySelector(`[data-id="${CSS.escape(id)}"]`); if (!el) continue;
    const pct = el.querySelector(".km-fr-p"), bar = el.querySelector(".km-fr-bar i");
    pct.textContent = r.st === "skip" ? trL("Belum tersambung, dilewati", "Not connected, skipped") : r.st === "fail" ? trL("Gagal", "Failed") : r.st === "done" ? trL("Selesai", "Done") : r.st === "wait" ? trL("Menunggu", "Waiting") : r.p + "%";
    // why it failed: its own line under the name, so a long reason never hides which PC it is
    let why = el.querySelector(".km-fr-why");
    if (r.st === "fail" && r.note) { if (!why) { why = kmEl("p", "km-fr-why"); el.appendChild(why); } why.textContent = r.note; } else if (why) why.remove();
    pct.className = "km-fr-p " + (r.st === "done" ? "ok" : r.st === "fail" ? "bad" : r.st === "skip" ? "muted" : "");
    if (bar) { bar.style.width = (r.st === "done" ? 100 : r.p) + "%"; bar.classList.toggle("ok", r.st === "done"); }
  }
}

// ── panels: password, files, new group, move, Atur kelompok ──
function kmOpenPanel(p) {
  if (p === "newgroup") { KM.fromManage = KM.panel === "gmanage"; KM.fromMove = KM.panel === "move"; }
  KM.panel = p; if (p === "gmanage") KM.edit = null;
  kmCloseMenu(); kmRenderPanel(true);
}
function kmClosePanel() {
  if (KM.panel === "newgroup" && KM.fromManage) { KM.fromManage = false; return kmOpenPanel("gmanage"); }
  if (KM.panel === "newgroup" && KM.fromMove) { KM.fromMove = false; return kmOpenPanel("move"); }
  KM.panel = null; KM.edit = null; kmRenderPanel();
}
function kmModal(title, body, acts, cls = "") {
  const ov = kmEl("div", "km-scrim");
  const d = kmEl("div", "km-dlg " + cls); d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true");
  const h = kmEl("h3"); h.textContent = title; d.setAttribute("aria-label", title);
  const a = kmEl("div", "km-acts"); a.append(...acts);
  d.append(h, ...body, a); ov.appendChild(d);
  ov.addEventListener("pointerdown", (e) => { if (e.target === ov) kmClosePanel(); });
  return ov;
}
function kmRenderPanel(opened) {
  const host = $("#km-panel"); if (!host) return;
  host.replaceChildren();
  if (!KM.panel) return;
  const btn = (cls, text, fn) => { const b = kmBtn(cls, "", fn); b.textContent = text; return b; };
  let node;
  if (KM.panel === "pw") {
    const devs = kmDevices().filter((d) => KM.sel.has(d.id) && kmState(d.id) !== "conn" && !kmBusy(kmState(d.id)));
    if (!devs.length) { KM.panel = null; return; }
    const list = kmEl("div", "km-pcs");
    for (const d of devs) { const r = kmEl("div"); const b = kmEl("b", "km-ell"); b.textContent = kmLabel(d.id); const s = kmEl("span", "km-id"); s.textContent = kmShown(d.id); r.append(b, s); list.appendChild(r); }
    const lab = kmEl("label"); lab.textContent = trL("Password akses (jika PC memakai password)", "Access password (if the PCs use one)"); lab.htmlFor = "km-pw";
    const fld = kmEl("div", "km-fld");
    const inp = kmEl("input"); inp.type = "password"; inp.id = "km-pw"; inp.autocomplete = "off";
    const eye = kmBtn("km-eye", kmSvg("eye", 16), () => {
      inp.type = inp.type === "password" ? "text" : "password";
      eye.setAttribute("aria-label", inp.type === "password" ? trL("Tampilkan password", "Show password") : trL("Sembunyikan password", "Hide password"));
    }, { "aria-label": trL("Tampilkan password", "Show password") });
    fld.append(inp, eye);
    const note = kmEl("p", "km-note"); note.textContent = trL("Dipakai sekali untuk PC ini saja, lalu dibuang. PC tanpa password akan meminta Terima di layarnya.", "Used once for these PCs, then thrown away. A PC without a password asks for Accept on its screen.");
    const go = () => { const pw = inp.value; inp.value = ""; const ids = devs.map((d) => d.id); KM.panel = null; KM.select = false; KM.sel.clear(); kmRenderPanel(); kmConnectMany(ids, pw); };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
    const ok = kmBtn("btn-connect km-go", `${kmSvg("arrow", 14)}<span></span>`, go); ok.lastChild.textContent = trL(`Hubungkan ${devs.length} PC`, `Connect ${devs.length} PC${devs.length !== 1 ? "s" : ""}`);
    node = kmModal(trL(`Hubungkan ${devs.length} PC`, `Connect ${devs.length} PC${devs.length !== 1 ? "s" : ""}`), [list, lab, fld, note], [btn("km-btn km-btn-quiet", trL("Batal", "Cancel"), kmClosePanel), ok]);
  } else if (KM.panel === "newgroup") {
    const lab = kmEl("label"); lab.textContent = trL("Nama kelompok", "Group name"); lab.htmlFor = "km-ng";
    const inp = kmEl("input", "km-in"); inp.id = "km-ng"; inp.maxLength = 24; inp.value = "";
    inp.placeholder = trL("Misalnya Kantor", "For example Office");
    const make = () => {
      const name = inp.value.trim(); if (!name) { inp.focus(); inp.classList.add("km-need"); setTimeout(() => inp.classList.remove("km-need"), 400); return; }
      const g = kmGroups(); g.seq += 1; const k = "g" + g.seq; g.list.push({ k, name });
      // made from "Pindahkan ke kelompok": the picked PCs go into it (audit 19 Nov: it was made empty and the
      // selection was lost)
      const moved = KM.fromMove ? [...KM.sel] : [];
      for (const id of moved) g.of[id] = k;
      kmSaveGroups(g);
      const back = KM.fromManage; KM.fromManage = false; KM.fromMove = false;
      KM.group = k; KM.page = 0; KM.select = false; KM.sel.clear(); KM.born = k; setTimeout(() => { KM.born = null; }, 400);
      KM.panel = back ? "gmanage" : null; kmRender(); kmRenderPanel(back);
      const n = moved.length;
      showToast(n ? trL(`Kelompok ${name} dibuat, ${n} PC dipindah ke sana.`, `Group ${name} created, ${n} PC${n !== 1 ? "s" : ""} moved into it.`) : trL(`Kelompok ${name} dibuat.`, `Group ${name} created.`), "good");
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); make(); } });
    node = kmModal(trL("Kelompok baru", "New group"), [lab, inp], [btn("km-btn km-btn-quiet", trL("Batal", "Cancel"), kmClosePanel), btn("btn-connect km-go", trL("Buat kelompok", "Create group"), make)]);
  } else if (KM.panel === "move") {
    const g = kmGroups(), opts = kmEl("div", "km-opts");
    const target = (k) => () => {
      const g2 = kmGroups(), n = KM.sel.size;
      for (const id of KM.sel) { if (k) g2.of[id] = k; else delete g2.of[id]; }
      kmSaveGroups(g2); KM.panel = null; KM.select = false; KM.sel.clear(); kmRender(); kmRenderPanel();
      showToast(k ? trL(`${n} PC dipindah ke ${kmGroupName(g2, k)}.`, `Moved ${n} PC${n !== 1 ? "s" : ""} to ${kmGroupName(g2, k)}.`) : trL(`${n} PC dikeluarkan dari kelompoknya.`, `Took ${n} PC${n !== 1 ? "s" : ""} out of their group.`), "good");
    };
    for (const x of g.list) { const b = kmBtn("km-opt", `${kmSvg("layers", 15)}<span class="km-ell"></span><small></small>`, target(x.k)); b.children[1].textContent = x.name; b.lastChild.textContent = Object.values(g.of).filter((v) => v === x.k).length; opts.appendChild(b); }
    const none = kmBtn("km-opt km-opt-none", `${kmSvg("x", 15)}<span></span>`, target(null)); none.lastChild.textContent = trL("Tanpa kelompok", "No group");
    const nb = kmBtn("km-opt km-opt-new", `${kmSvg("plus", 15)}<span></span>`, () => kmOpenPanel("newgroup")); nb.lastChild.textContent = trL("Kelompok baru", "New group");
    opts.append(none, nb);
    node = kmModal(trL(`Pindahkan ${KM.sel.size} PC ke kelompok`, `Move ${KM.sel.size} PC${KM.sel.size !== 1 ? "s" : ""} to a group`), [opts], [btn("km-btn km-btn-quiet", trL("Batal", "Cancel"), kmClosePanel)]);
  } else if (KM.panel === "gmanage") {
    const g = kmGroups(), list = kmEl("div", "km-gl"), ed = KM.edit || {};
    for (const x of g.list) {
      const n = Object.values(g.of).filter((v) => v === x.k).length;
      const r = kmEl("div", "km-gr" + (KM.removing === x.k ? " km-gone" : "") + (ed.k === x.k ? " " + ed.mode : ""));
      if (ed.k === x.k && ed.mode === "ren") {
        const inp = kmEl("input", "km-in"); inp.id = "km-gr-name"; inp.maxLength = 24; inp.value = x.name; inp.setAttribute("aria-label", trL("Nama kelompok", "Group name"));
        const save = () => { const v = inp.value.trim(); const g2 = kmGroups(), it = g2.list.find((y) => y.k === x.k); if (v && it && v !== it.name) { const old = it.name; it.name = v; kmSaveGroups(g2); showToast(trL(`Kelompok ${old} sekarang bernama ${v}.`, `The ${old} group is now called ${v}.`), "good"); } KM.edit = null; kmRender(); kmRenderPanel(); };
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); KM.edit = null; kmRenderPanel(); } });
        r.append(inp, btn("km-btn km-btn-quiet", trL("Batal", "Cancel"), () => { KM.edit = null; kmRenderPanel(); }), btn("btn-connect km-go", trL("Simpan", "Save"), save));
      } else if (ed.k === x.k && ed.mode === "del") {
        const q = kmEl("span", "km-gq"); q.textContent = n ? trL(`Hapus ${x.name}? ${n} PC tetap ada di Semua.`, `Delete ${x.name}? Its ${n} PC${n !== 1 ? "s" : ""} will stay in All.`) : trL(`Hapus ${x.name}? Kelompok ini kosong.`, `Delete ${x.name}? It is empty.`);
        r.append(q, btn("km-btn km-btn-quiet", trL("Batal", "Cancel"), () => { KM.edit = null; kmRenderPanel(); }), btn("km-btn km-danger", trL("Hapus kelompok", "Delete group"), () => kmDeleteGroup(x.k)));
      } else {
        const nm = kmEl("b", "km-gn km-ell"); nm.textContent = x.name;
        const c = kmEl("small"); c.textContent = trL(`${n} PC`, `${n} PC${n !== 1 ? "s" : ""}`);
        r.append(nm, c,
          kmBtn("km-ib", kmSvg("pen", 15), () => { KM.edit = { k: x.k, mode: "ren" }; kmRenderPanel(true); }, { title: trL("Ganti nama", "Rename"), "aria-label": `${trL("Ganti nama", "Rename")}: ${x.name}` }),
          kmBtn("km-ib km-del", kmSvg("trash", 15), () => { KM.edit = { k: x.k, mode: "del" }; kmRenderPanel(true); }, { title: trL("Hapus kelompok", "Delete group"), "aria-label": `${trL("Hapus kelompok", "Delete group")}: ${x.name}` }));
      }
      list.appendChild(r);
    }
    if (!g.list.length) { const p = kmEl("p", "km-gnone"); p.textContent = trL("Belum ada kelompok.", "No groups yet."); list.appendChild(p); }
    const note = kmEl("p", "km-note"); note.textContent = trL("Menghapus kelompok tidak menghapus PC di dalamnya. PC itu tetap ada di Semua.", "Deleting a group never deletes its PCs. They stay in All.");
    const nb = kmBtn("km-btn km-btn-quiet km-left", `${kmSvg("plus", 13)}<span></span>`, () => kmOpenPanel("newgroup")); nb.lastChild.textContent = trL("Kelompok baru", "New group");
    node = kmModal(trL("Atur kelompok", "Manage groups"), [note, list], [nb, btn("km-btn", trL("Selesai", "Done"), kmClosePanel)]);
  } else if (KM.panel === "files") {
    const f = KM.files; if (!f) { KM.panel = null; return; }
    const nt = f.targets.length;
    const side = kmEl("aside", "km-side"); side.setAttribute("aria-label", trL(`Kirim file ke ${nt} PC`, `Send a file to ${nt} PC${nt !== 1 ? "s" : ""}`));
    const sh = kmEl("div", "km-sh"); const t = kmEl("b"); t.textContent = trL(`Kirim file ke ${nt} PC`, `Send a file to ${nt} PC${nt !== 1 ? "s" : ""}`);
    sh.append(t, kmBtn("km-ib", kmSvg("x", 15), () => { KM.panel = null; kmRenderPanel(); }, { "aria-label": trL("Tutup", "Close") }));
    const fi = kmEl("div", "km-file", kmSvg("file", 18)); const fn = kmEl("div", "km-ell"); const b = kmEl("b"); b.textContent = f.names.length > 1 ? trL(`${f.names[0]} dan ${f.names.length - 1} lainnya`, `${f.names[0]} and ${f.names.length - 1} more`) : f.names[0]; const sm = kmEl("small"); sm.textContent = fmtBytes(f.size); fn.append(b, sm); fi.appendChild(fn);
    const dest = kmEl("p", "km-dest"); dest.textContent = trL("Di tiap PC, orangnya menekan Terima lalu memilih tempat menyimpan.", "At each PC, the person presses Accept and picks where to save it.");
    const rows = kmEl("div", "km-rows"); rows.id = "km-files-rows";
    for (const id of f.targets) { const r = kmEl("div", "km-fr"); r.dataset.id = id; const top = kmEl("div", "km-fr-top"); const nm = kmEl("b", "km-ell"); nm.textContent = kmLabel(id); top.append(nm, kmEl("span", "km-fr-p")); r.append(top); if ((f.rows.get(id) || {}).st !== "skip") r.appendChild(kmEl("div", "km-fr-bar", "<i></i>")); rows.appendChild(r); }
    const sf = kmEl("div", "km-sf");
    const add = kmBtn("km-btn", `${kmSvg("plus", 14)}<span></span>`, () => kmSendFiles(true)); add.lastChild.textContent = trL("Tambah file", "Add files");
    sf.append(add, btn("km-btn", trL("Tutup", "Close"), () => { KM.panel = null; kmRenderPanel(); }));
    side.append(sh, fi, dest, rows, sf);
    node = side;
  }
  if (!node) return;
  if (opened && !motionOff()) node.classList.add("km-in-fx");
  host.appendChild(node);
  kmFilesPaint();
  if (opened) setTimeout(() => {
    const f = host.querySelector(".km-gr.ren input, .km-gr.del .km-danger, #km-pw, #km-ng, .km-opt, .km-dlg .km-go, .km-side .km-ib");
    if (f) { f.focus({ preventScroll: true }); if (f.select) f.select(); }
  }, 30);
}
function kmDeleteGroup(k) {
  KM.edit = null; KM.removing = k; kmRender(); kmRenderPanel();
  setTimeout(() => {
    KM.removing = null;
    const g = kmGroups(), idx = g.list.findIndex((x) => x.k === k); if (idx < 0) return;
    const it = g.list[idx], members = Object.keys(g.of).filter((id) => g.of[id] === k);
    for (const id of members) delete g.of[id];
    g.list.splice(idx, 1); kmSaveGroups(g);
    if (KM.group === k) { KM.group = "all"; KM.page = 0; }
    KM.undo = { k, idx, name: it.name, members };
    clearTimeout(KM.undoTimer); KM.undoTimer = setTimeout(() => { KM.undo = null; kmRefresh(); }, 6000);
    kmRender(); kmRenderPanel();
  }, motionOff() ? 0 : 240);
}
function kmUndo() {
  const u = KM.undo; if (!u) return;
  const g = kmGroups();
  if (!g.list.some((x) => x.k === u.k)) g.list.splice(Math.min(u.idx, g.list.length), 0, { k: u.k, name: u.name });
  for (const id of u.members) g.of[id] = u.k;
  kmSaveGroups(g); KM.undo = null; clearTimeout(KM.undoTimer);
  KM.born = u.k; setTimeout(() => { KM.born = null; }, 400);
  kmRender(); if (KM.panel) kmRenderPanel();
}

// ── small menus: right-click on a group (Ganti nama / Hapus), and the group list when the window is narrow ──
function kmCloseMenu() { if (tileMenuEl && tileMenuEl.classList.contains("km-menu")) closeTileMenu(); }
function kmMenu(anchor, head, items) {
  closeTileMenu();
  const m = kmEl("div", "tile-menu km-menu"); m.setAttribute("role", "menu"); m.tabIndex = -1;
  if (head) { const h = kmEl("div", "tile-menu-head"); h.textContent = head; m.appendChild(h); }
  for (const it of items) {
    if (it === "-") { m.appendChild(kmEl("div", "tile-menu-sep")); continue; }
    const b = kmEl("button", "cc-item" + (it.danger ? " danger" : "") + (it.on ? " active" : ""), it.icon ? tileSvg(it.icon) : ""); b.type = "button"; b.setAttribute("role", it.radio ? "menuitemradio" : "menuitem");
    if (it.radio) b.setAttribute("aria-checked", String(!!it.on));
    const l = kmEl("span", "km-ell"); l.textContent = it.label; b.appendChild(l);
    if (it.count != null) { const c = kmEl("small", "km-mc"); c.textContent = it.count; b.appendChild(c); }
    b.addEventListener("click", (e) => { e.stopPropagation(); closeTileMenu(); it.fn(); });
    m.appendChild(b);
  }
  m.addEventListener("keydown", (e) => {
    const btns = [...m.querySelectorAll("button")], i = btns.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); btns[i < 0 ? 0 : (i + (e.key === "ArrowDown" ? 1 : btns.length - 1)) % btns.length]?.focus(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeTileMenu(); anchor.focus(); }
  });
  document.body.appendChild(m); tileMenuEl = m;
  const r = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
  let left = Math.max(8, Math.min(r.left, innerWidth - w - 8)), top = r.bottom + 4;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 4);
  m.style.left = left + "px"; m.style.top = top + "px";
  m.focus({ preventScroll: true });
}
function kmGroupCtx(k, anchor) {
  const g = kmGroups();
  kmMenu(anchor, kmGroupName(g, k), [
    { label: trL("Ganti nama", "Rename"), icon: KM_ICON.pen, fn: () => { KM.panel = "gmanage"; KM.edit = { k, mode: "ren" }; kmRenderPanel(true); } },
    { label: trL("Hapus kelompok", "Delete group"), icon: KM_ICON.trash, danger: true, fn: () => { KM.panel = "gmanage"; KM.edit = { k, mode: "del" }; kmRenderPanel(true); } },
  ]);
}
function kmGroupMenu(anchor, keys, count) {
  const g = kmGroups();
  kmMenu(anchor, "", [
    ...keys.map((k) => ({ label: kmGroupName(g, k), count: count(k), radio: true, on: KM.group === k, icon: KM.group === k ? KM_ICON.check : "", fn: () => kmSetGroup(k) })),
    "-",
    { label: trL("Atur kelompok", "Manage groups"), icon: KM_ICON.pen, fn: () => kmOpenPanel("gmanage") },
  ]);
}

// ── wiring ──
function kmInit() {
  const root = $("#km"); if (!root) return;
  $("#rs-manage")?.addEventListener("click", () => setManageOpen(true));
  $("#km-back")?.addEventListener("click", () => setManageOpen(false));
  document.addEventListener("keydown", (e) => {
    if (!KM.open || e.key !== "Escape" || document.querySelector(".overlay:not(.hidden), .overlay.app-confirm")) return;
    if (tileMenuEl) return;   // the menu closes itself
    if (document.querySelector(".km .tile-rename")) return;   // Esc cancels a PC rename, it doesn't close the page
    e.preventDefault(); e.stopPropagation();
    if (KM.edit) { KM.edit = null; kmRenderPanel(); }
    else if (KM.panel) kmClosePanel();
    else if (KM.select) { KM.select = false; KM.sel.clear(); kmRender(); }
    else if (KM.q) { KM.q = ""; kmRender(); }
    else setManageOpen(false);
  }, true);
  let rt = 0;
  const refit = () => { if (!KM.open) return; clearTimeout(rt); rt = setTimeout(() => { const f = kmFit(), narrow = kmNarrow(root); if ((f && f !== KM.perPage) || narrow !== KM.narrow) { if (f && f !== KM.perPage) { const first = KM.page * KM.perPage; KM.perPage = f; KM.page = Math.floor(first / f); } kmRender(); } }, 80); };
  new ResizeObserver(refit).observe(root);
  // (the window's own resize too: in a test going from a wide window back to 960 x 600 the page once kept the wide
  // window's 7 columns)
  window.addEventListener("resize", refit);
}

kmInit();

// ─── Init ─────────────────────────────────────────────────
(async () => {
  config = await window.electronAPI.getConfig();
  serverUrl = config.signalingServer;
  if (viewerOnlyDesktop()) {
    // Say what this build does instead of offering an ID nobody can connect to; hide Windows-only settings.
    // Plain Indonesian: the text observer translates it and keeps it as the source, so a later language switch works.
    const note = $(".id-note"); if (note) { note.removeAttribute("data-i18n"); note.textContent = isMacViewer() ? "TryDesk untuk macOS hanya bisa mengontrol PC Windows. Mac ini tidak bisa dikontrol dari jarak jauh." : "TryDesk untuk Linux saat ini hanya bisa mengontrol PC lain. PC ini belum bisa dikontrol dari jarak jauh."; }
    $("#setting-startup")?.closest(".srow")?.style.setProperty("display", "none");
    // The service page explains itself instead of standing empty.
    const t = $("#service-none-t"), d = $("#service-none-d");
    if (t) t.textContent = "Hanya di TryDesk untuk Windows";
    if (d) d.textContent = "Layanan Windows membuat PC tetap bisa dihubungi setelah restart. Komputer ini hanya bisa mengontrol PC lain.";
  }
  // Only a PC that can be controlled listens for LAN requests; the macOS, Linux and phone builds still connect BY IP.
  if (viewerOnlyDesktop() || window.TD_MOBILE) $("#setting-lan")?.closest(".srow")?.style.setProperty("display", "none");
  try { const saved = JSON.parse(store.get("quality")); if (saved) defaultQuality = { ...DEFAULT_QUALITY, ...saved }; } catch {}
  clipboardSync = store.get("clipboardSync") !== "0";
  $("#clipboard-toggle").checked = clipboardSync;
  applyAccessSettings();
  svcPermsSave();   // the service's sessions follow this user's File permission (no-op in the service's own host)
  initPrefs();
  // Service host: the access password is the one an administrator set for the service (service.json), never one
  // left in this profile; without it every request is refused (askAccept above).
  if (config.serviceHost) {
    store.set("accessPasswordHash", config.servicePwHash || null); autoAcceptWithPassword = true;
    // Files: the viewer's file manager works as the signed-in user (main.js asUser), with THAT user's File permission
    // (svcPermsRefresh, read fresh before each request). Off until it has been read; this window's own store keeps
    // "0" (it has no Settings). Turned off in the user's TryDesk during a session: a transfer under way stops.
    store.set("allowFile", "0"); applyAccessSettings();
    // Kept fresh every 3 s too (a request card shown before any request reads it is never older than that).
    svcPermsRefresh();
    setInterval(svcPermsRefresh, 3000);
    document.documentElement.classList.add("svc-host");
    // No file picker in the SYSTEM window (security audit 22 Nov): the paper clip and its file input go away.
    try { $("#btn-chat-attach")?.remove(); document.querySelectorAll('input[type="file"]').forEach((i) => i.remove()); } catch {}
    // First start: take over the ID the user's own TryDesk has been using, so the PC keeps its ID. Until that
    // identity exists (an app older than this one never wrote it), check again every 10 s while idle.
    // Only right after the service's install: once the service has answered under an ID of its own for 10 minutes
    // (or since a version that didn't note when), that ID is the one people know, and a later identity.json must not
    // replace it (Threads report 18 Nov: the ID changed when 1.3.9 could finally read a file 1.3.8 could not).
    const adopt = async () => {
      if (store.get("svcAdopted") === "1") return;
      const ownAt = Number(store.get("svcOwnIdAt")) || 0;
      if (store.get("myToken") && (!ownAt || Date.now() - ownAt > 10 * 60 * 1000)) {
        store.set("svcAdopted", "1");
        try { window.electronAPI.logInfo("service host keeps its own ID (nothing to take over after the install)"); } catch {}
        return;
      }
      let u = null; try { u = await window.electronAPI.serviceUserIdentity(); } catch {}
      // Checked again after the wait: a new ID requested meanwhile must not be undone by the old one (review 10 Nov).
      if (!u || host || acceptPending || store.get("svcAdopted") === "1") return;
      store.set("svcAdopted", "1");
      if (u.id === store.get("myId")) return;
      store.set("myId", u.id); store.set("myToken", u.token);
      if (ws) connectSignaling();
    };
    await adopt();
    const t = setInterval(() => { if (store.get("svcAdopted") === "1") clearInterval(t); else adopt(); }, 10000);
  } else {
    // H.265 (P4): the phone app doesn't offer it (not tested on a phone); elsewhere the check runs once, after the start.
    if (window.TD_MOBILE) document.querySelectorAll('option[value="H265"]').forEach((o) => o.remove());
    setTimeout(() => { h265Probe(); }, 3000);
    // This PC's own ID lost from storage (closed hard right after its first sign-in): take it back from identity.json.
    if (!window.TD_MOBILE && !store.get("myToken")) {
      let j = null; try { j = await window.electronAPI.readIdentity?.(); } catch {}
      if (j) { store.set("myId", j.id); store.set("myToken", j.token); try { window.electronAPI.logInfo("ID restored from identity.json"); } catch {} }
    }
    await refreshServiceState();
    // Setup installs the service before the new app ever opened, so identity.json did not exist yet and the service
    // signed in with a NEW ID ("the ID changed after the update", Threads T21). The app never wrote it while the
    // service ran: write this PC's own ID now, and the service (still waiting to adopt one) takes it over.
    if (svcId !== null && !window.TD_MOBILE && store.get("myId") && store.get("myToken")) {
      let j = null; try { j = await window.electronAPI.readIdentity?.(); } catch {}
      if (!j) { try { window.electronAPI.exportIdentity(store.get("myId"), store.get("myToken")); } catch {} }
    }
    try { onSvcUi(await window.electronAPI.svcUiNow?.()); } catch {}   // a service session already running at start
  }
  checkUpdate(); setInterval(checkUpdate, 6 * 3600 * 1000);   // at start, then every 6 hours
  syncDefaultQualityUI();
  // A pre-1.0 unsalted hash can't do the challenge, so it silently meant "always ask Accept", drop it and say so.
  const pwHash = store.get("accessPasswordHash");
  if (pwHash && !pwHash.includes(":")) { store.set("accessPasswordHash", null); setTimeout(() => showToast("Password akses dari versi lama perlu diset ulang (Pengaturan → Keamanan)"), 1500); }
  // TryDesk closed and opened itself again (main.js relaunchSelf): say why, or it looks like a crash (12 Nov report).
  const why = config && config.relaunched;
  if (why === "gpu") setTimeout(() => showToast("TryDesk dibuka ulang otomatis karena kartu grafis bermasalah. Sekarang TryDesk memakai mode software."), 1200);
  else if (why === "wgc") setTimeout(() => showToast("TryDesk dibuka ulang sekali supaya semua monitor PC ini bisa ditampilkan."), 1200);
  updateAccessPwUI();
  store.set("pwKeys", null);   // left by 1.1.0 test builds' "remember password" (feature removed)
  // Restore device alias
  const savedAlias = store.get("deviceAlias");
  if (savedAlias) $("#device-alias").value = savedAlias;
  // Restore theme (only dark/light supported now; normalize older values)
  if (isPhoneUi()) $$(".theme-seg-system").forEach((b) => { b.textContent = "Ikuti HP"; });
  const savedTheme = ["light", "system"].includes(store.get("theme")) ? store.get("theme") : "dark";
  applyTheme(savedTheme);
  $("#setting-theme").value = savedTheme;
  if (store.get("theme") && store.get("theme") !== savedTheme) store.set("theme", savedTheme);
  // Restore language
  // Until the user picks a language (or with "Ikuti bahasa Windows"), follow Windows among TryDesk's languages.
  const savedLang = store.get("lang") && store.get("lang") !== "system" && LANG_CODES.has(store.get("lang")) ? store.get("lang") : sysLang();
  $("#setting-language").value = savedLang;
  applyLanguage(savedLang);
  if (config.serviceHost) serviceFollowUserLang();
  // Restore auto-reconnect
  autoReconnect = store.get("autoReconnect") === "1";
  $("#setting-auto-reconnect").checked = autoReconnect;
  recentView = store.get("recentView") === "list" ? "list" : "grid";
  syncQualityUI();
  renderFavorites();
  renderRecent();
  applyRecentView();
  setupInputCapture();
  fmInit();
  renderTabs();
  connectSignaling();
})();
