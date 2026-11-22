// TryDesk for Android — stand-in for Electron's preload API (window.electronAPI).
// The phone app runs the desktop renderer unchanged (app.js / index.html). It is a VIEWER only: it controls
// a Windows PC but never shares its own screen, so every host-side call (capture, input injection, black
// screen, files on this device…) is answered with "not available" and the matching UI is hidden by mobile.js.
// Loaded BEFORE app.js.
(() => {
  const noop = () => {};
  const value = (v) => () => Promise.resolve(v);
  const unavailable = { ok: false, error: "Tidak tersedia di aplikasi HP" };

  // version.json is signed with the owner's Ed25519 key (scripts/sign-version.mjs; same public key as main.js).
  // true = good signature, false = missing or wrong, null = this WebView can't check Ed25519 (older Chrome).
  const VERSION_JSON_PUBKEY = "MCowBQYDK2VwAyEALmgxboidf3mbPwbQKUYPidxLPlSdMvgjQle1fXxJu6E=";
  // A debug build pointed at a local test server (TdUpdatePlugin, adb extras) brings that server's throwaway key,
  // like the desktop's TRYDESK_TEST_PUBKEY. Release builds never have one.
  let testKey = "", testServer = false;
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function edVerify(text, sig) {
    if (typeof sig !== "string" || !/^[A-Za-z0-9+/=]{80,100}$/.test(sig)) return false;
    let key = null;
    try { key = await crypto.subtle.importKey("spki", b64(testKey || VERSION_JSON_PUBKEY), { name: "Ed25519" }, false, ["verify"]); } catch {}
    if (key) { try { return await crypto.subtle.verify({ name: "Ed25519" }, key, b64(sig), new TextEncoder().encode(String(text))); } catch { return false; } }
    // This WebView has no Ed25519 in WebCrypto (before Chrome 137; found 18 Nov 2026 on an Android 15 emulator with
    // WebView 124, whose Android crypto also only takes its own keystore keys): the check below does the same.
    try { return await ed25519VerifyJs(b64(testKey || VERSION_JSON_PUBKEY).slice(-32), b64(sig), new TextEncoder().encode(String(text))); } catch { return null; }
  }
  // ed25519-js-begin
  // Ed25519 signature check (RFC 8032 5.1.7) in plain BigInt arithmetic, SHA-512 from WebCrypto. Verify only: no
  // secrets here, so speed and constant time don't matter. Accepts exactly when [S]B - [k]A encodes to R, with S < L
  // and A, R valid points (as OpenSSL / Node do); tested against Node's crypto (scratch test, 18 Nov 2026).
  async function ed25519VerifyJs(pub, sig, msg) {
    const P = 2n ** 255n - 19n, L = 2n ** 252n + 27742317777372353535851937790883648493n;
    const mod = (a) => { const r = a % P; return r < 0n ? r + P : r; };
    const pow = (b, e) => { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = mod(r * b); b = mod(b * b); e >>= 1n; } return r; };
    const inv = (a) => pow(a, P - 2n);
    const D = mod(-121665n * inv(121666n)), D2 = mod(2n * D), SQRTM1 = pow(2n, (P - 1n) / 4n);
    const le = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
    const decode = (b) => {
      if (b.length !== 32) return null;
      const x0 = b[31] >> 7, yb = Uint8Array.from(b); yb[31] &= 0x7f;
      const y = le(yb);
      if (y >= P) return null;
      const y2 = mod(y * y), x2 = mod((y2 - 1n) * inv(D * y2 + 1n));
      if (x2 === 0n) { if (x0) return null; return [0n, y, 1n, 0n]; }
      let x = pow(x2, (P + 3n) / 8n);
      if (mod(x * x) !== x2) x = mod(x * SQRTM1);
      if (mod(x * x) !== x2) return null;
      if (Number(x & 1n) !== x0) x = P - x;
      return [x, y, 1n, mod(x * y)];
    };
    const add = (p, q) => {
      const a = mod((p[1] - p[0]) * (q[1] - q[0])), b = mod((p[1] + p[0]) * (q[1] + q[0]));
      const c = mod(p[3] * D2 * q[3]), d = mod(2n * p[2] * q[2]);
      const e = b - a, f = d - c, g = d + c, h = b + a;
      return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
    };
    const mul = (pt, n) => { let r = [0n, 1n, 1n, 0n]; while (n > 0n) { if (n & 1n) r = add(r, pt); pt = add(pt, pt); n >>= 1n; } return r; };
    const encode = (pt) => {
      const zi = inv(pt[2]), x = mod(pt[0] * zi); let y = mod(pt[1] * zi);
      const out = new Uint8Array(32);
      for (let i = 0; i < 32; i++) { out[i] = Number(y & 255n); y >>= 8n; }
      if (x & 1n) out[31] |= 0x80;
      return out;
    };
    if (!(pub instanceof Uint8Array) || pub.length !== 32 || !(sig instanceof Uint8Array) || sig.length !== 64) return false;
    const A = decode(pub), Rb = sig.subarray(0, 32), R = decode(Rb), S = le(sig.subarray(32));
    if (!A || !R || S >= L) return false;
    const B = decode(Uint8Array.from([0x58, ...new Array(31).fill(0x66)]));
    const h = new Uint8Array(await crypto.subtle.digest("SHA-512", Uint8Array.from([...Rb, ...pub, ...msg])));
    const k = le(h) % L;
    const negA = [P - A[0] === P ? 0n : P - A[0], A[1], A[2], A[3] === 0n ? 0n : P - A[3]];
    const chk = encode(add(mul(B, S), mul(negA, k)));
    for (let i = 0; i < 32; i++) if (chk[i] !== Rb[i]) return false;
    return true;
  }
  // ed25519-js-end
  const verifyVersionJson = (v, sig) => edVerify(JSON.stringify({ latest: v.latest, minimum: v.minimum || "", url: v.url, notes: { id: v.notes.id, en: v.notes.en } }), sig);

  // ── In-app updates (owner 18 Nov 2026, direction A; the desktop's src/updater.js) ──
  // The same signed download list as the desktop ("files" + "filesSig" in version.json, scripts/sign-version.mjs):
  // its "android" entry is fetched by the native TdUpdate plugin from trydesk.ai.id/downloads/ only, kept only when
  // size and SHA-256 match, and handed to Android's own installer ("Pasang sekarang"; Android asks every time, and
  // refuses an APK signed with another key). app.js draws every state in the same strip as on the desktop.
  const FILE_KEYS = ["win-setup", "win-portable", "mac-arm64", "mac-x64", "linux-appimage", "linux-deb", "android"];
  const filesCanonical = (f) => "trydesk-files-v1\n" + JSON.stringify([f.version, ...FILE_KEYS.filter((k) => f[k]).map((k) => [k, f[k].path, f[k].size, f[k].sha256])]);
  const PATH_RE = /^(win|mac|linux|android)\/TryDesk-[A-Za-z0-9._-]{1,80}\.(exe|zip|AppImage|deb|apk)$/;
  const verNum = (v) => String(v || "0.0.0").split(".").map(Number).reduce((a, b) => a * 1000 + (b || 0), 0);
  const myVer = () => (window.TD_MOBILE && window.TD_MOBILE.version) || "";
  let ust = { auto: true, justUpdated: "" };
  try { ust = { ...ust, ...JSON.parse(localStorage.getItem("td.update") || "{}") }; } catch {}
  const usave = () => { try { localStorage.setItem("td.update", JSON.stringify(ust)); } catch {} };
  let uNative = false, uReady = null, uOffer = null, uDl = null, uErr = "", uLast = 0, uTimer = null;
  const uCbs = [];
  const updPlugin = () => plugin("TdUpdate");
  // At start: the native side says whether it is there, the test server (debug only), and a verified file waiting
  // from before: newer than this app = ready; this app's own version = it was just installed (shown once).
  // Started on first use (plugin() below is not ready while this file is still loading).
  let _uInit = null;
  const uInit = () => _uInit || (_uInit = uInitRun().catch(noop));
  async function uInitRun() {
    const P = updPlugin();
    if (!P || !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) return;
    let i = null;
    try { i = await P.info(); } catch { return; }
    // A device that forbids installing apps (Google Play Games for PC) keeps the website link, as before.
    if (!i) return;
    if (i.test && i.testKey) { testKey = i.testKey; testServer = true; }
    if (i.blocked) { if (i.ready) P.drop().catch(noop); return; }
    uNative = true;
    const r = i.ready;
    if (r && r.version) {
      if (verNum(r.version) > verNum(myVer())) uReady = { version: r.version, sha256: r.sha256, size: r.size };
      else { if (r.version === myVer()) { ust.justUpdated = r.version; usave(); } P.drop().catch(noop); }
    }
    try { P.addListener("progress", (e) => { if (uDl && e) { uDl.received = Number(e.received) || 0; uEmit(); } }); } catch {}
  }
  function uPhase() { return uDl ? "downloading" : uErr ? "failed" : uReady ? "ready" : "idle"; }
  function uState() {
    return {
      supported: uNative, kind: uNative ? "android" : "", auto: ust.auto !== false, phase: uPhase(), error: uErr,
      version: uDl ? uDl.version : uReady ? uReady.version : uOffer ? uOffer.version : "",
      received: uDl ? uDl.received : 0, total: uDl ? uDl.total : uOffer ? uOffer.size : uReady ? uReady.size : 0,
      justUpdated: ust.justUpdated || "", offered: !!uOffer,
    };
  }
  function uEmit(force) {
    const now = Date.now();
    if (!force && now - uLast < 250) { if (!uTimer) uTimer = setTimeout(() => { uTimer = null; uEmit(true); }, 260); return; }
    uLast = now;
    const s = uState();
    for (const cb of uCbs) { try { cb(s); } catch {} }
  }
  // From checkUpdate, after version.json's own signature checked out: this phone's entry of the signed list.
  async function uSetOffer(latest, files, filesSig) {
    uOffer = null;
    await uInit();
    if (!uNative || !files || typeof files !== "object" || files.version !== latest) return;
    for (const k of FILE_KEYS) {
      const e = files[k];
      if (!e) continue;
      if (typeof e.path !== "string" || !PATH_RE.test(e.path) || !Number.isInteger(e.size) || e.size < 1 || e.size > 400 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(e.sha256)) return;
    }
    if ((await edVerify(filesCanonical(files), filesSig)) !== true) return;
    const e = files.android;
    if (!e || !e.path.startsWith("android/") || verNum(latest) <= verNum(myVer())) { uEmit(true); return; }
    uOffer = { version: latest, path: e.path, size: e.size, sha256: e.sha256 };
    if (uReady && verNum(uReady.version) < verNum(latest)) { uReady = null; updPlugin().drop().catch(noop); }   // an even newer one
    uEmit(true);
  }
  async function uDownload() {
    await uInit();
    if (!uOffer || uDl || !uNative) return;
    if (uReady && uReady.version === uOffer.version) { uEmit(true); return; }
    const o = uOffer;
    uDl = { version: o.version, received: 0, total: o.size };
    uErr = ""; uEmit(true);
    let r = null;
    try { r = await updPlugin().download({ path: o.path, size: o.size, sha256: o.sha256, version: o.version }); } catch {}
    uDl = null;
    if (r && r.ok) uReady = { version: o.version, sha256: o.sha256, size: o.size };
    else if (r && (r.error === "sig" || r.error === "bad")) uErr = "sig";   // deleted, nothing installed
    // net / paused / busy: nothing shown, app.js tries again later (2 minutes) or after the session
    uEmit(true);
  }
  // "Pasang sekarang": true when Android's installer opened (the user still answers there), "permission" when the
  // "install unknown apps" switch was left off, "sig" when the waiting file changed, false otherwise.
  async function uInstall() {
    await uInit();
    if (!uNative || !uReady) return false;
    let r = null;
    try { r = await updPlugin().install(); } catch {}
    if (r && r.ok) return true;
    if (r && r.error === "sig") { uReady = null; uErr = "sig"; uEmit(true); return "sig"; }
    if (r && r.error === "permission") return "permission";
    return false;
  }

  const api = {
    async getConfig() {
      const r = await fetch("config.json", { cache: "no-store" });
      const c = await r.json();
      return { ...c, appVersion: (window.TD_MOBILE && window.TD_MOBILE.version) || "" };
    },
    async confirm(opts = {}) {
      const text = [opts.title, opts.message, opts.detail].filter(Boolean).join("\n\n");
      return window.confirm(text);
    },
    // The phone never polls its own clipboard (that would read whatever the user copied, at any time).
    // Text copied on the PC still lands on the phone through clipboardWrite.
    clipboardRead: value(""),
    async clipboardWrite(text) { try { await navigator.clipboard.writeText(String(text ?? "")); } catch {} },
    // Same list as the desktop (main.js "open-external", audit 19 Nov TD-VULN-06): only TryDesk's site and GitHub.
    openExternal(url) {
      try {
        const u = new URL(String(url || ""));
        if (u.protocol === "https:" && /^(trydesk\.ai\.id|www\.trydesk\.ai\.id|github\.com)$/.test(u.hostname)) window.open(u.href, "_blank", "noopener");
      } catch {}
    },
    logInfo(msg) { try { console.log("[trydesk]", String(msg)); } catch {} },
    getMonitors: value([]),
    isElevated: value(false),
    getLoginItem: value(false),
    setLoginItem: value(false),
    getHwAccel: value(true),
    setHwAccel: value(true),
    setDisplayMediaSource: value(false),
    // Screenshots and session recordings go to the phone's gallery through the native TdFile plugin; app.js
    // writes them with the same calls as on the desktop (a "save as" name, then open / write / close).
    async fileSaveDialog(name) {
      const F = plugin("TdFile"); if (!F) return null;
      try { const r = await F.target({ name: String(name || "") }); return (r && r.path) || null; } catch { return null; }
    },
    async fileOpenWrite(p) {
      const F = plugin("TdFile"); if (!F) throw new Error(unavailable.error);
      return (await F.open({ path: String(p || "") })).id;
    },
    // Sent in pieces of at most 512 KB: a 4K screenshot in one go would be a 10 MB+ string over the bridge.
    async fileWriteChunk(id, chunk) {
      const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      for (let off = 0; off < u8.length; off += 0x80000) {
        const part = u8.subarray(off, off + 0x80000);
        let s = ""; for (let i = 0; i < part.length; i += 0x8000) s += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000));
        await plugin("TdFile").write({ id: String(id), data: btoa(s) });
      }
    },
    async fileCloseWrite(id, deleteFile) { await plugin("TdFile").close({ id: String(id), cancel: !!deleteFile }); },
    filePick: value([]),
    fsHome: value(unavailable),
    fsList: value(unavailable),
    fileOpenRead: () => Promise.reject(new Error(unavailable.error)),
    fileOpenWriteIn: () => Promise.reject(new Error(unavailable.error)),
    enableBlackScreen: value(false),
    enableInputLock: value(false),
    relaunchAsAdmin: value(false),

    // Update check: the same version.json the desktop reads (main.js check-update), same validation. The website
    // allows this app's origin to read it (.htaccess); a failure is null and blocks nothing.
    async checkUpdate() {
      try {
        await uInit();
        let text;
        if (testServer) text = (await updPlugin().testVersionJson()).text;   // debug test server (TdUpdatePlugin)
        else {
          const r = await fetch("https://trydesk.ai.id/update/version.json", { cache: "no-store" });
          if (!r.ok) return null;
          text = await r.text();
        }
        const j = JSON.parse(String(text).slice(0, 32768));
        const ver = (v) => (typeof v === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v) ? v : null);
        const str = (v) => (typeof v === "string" ? v : "");
        if (!ver(j.latest)) return null;
        // The signature covers the notes as written: check first, then shorten what is shown (18 Nov 2026: cutting
        // them to 300 characters before the check made every longer file fail, so no update news showed at all).
        const full = { id: str(j.notes && j.notes.id), en: str(j.notes && j.notes.en) };
        const out = { latest: ver(j.latest), minimum: ver(j.minimum), url: "https://trydesk.ai.id/downloads/", notes: full };
        // Signed by the owner's key (scripts/sign-version.mjs), checked like the desktop does. A WebView without
        // Ed25519 in WebCrypto can't check it: it then shows the news but never enforces "minimum" from an
        // unverified file.
        const signed = await verifyVersionJson({ ...out, url: typeof j.url === "string" ? j.url : out.url }, j.sig);
        if (signed === false) return null;
        if (signed === null) out.minimum = null;
        if (out.minimum && verNum(out.minimum) > verNum(out.latest)) out.minimum = null;   // never require what is not released
        out.notes = { id: full.id.slice(0, 600), en: full.en.slice(0, 600) };
        // This phone's own download from the signed list (only from a verified file; without Ed25519 the strip keeps
        // the website link).
        if (signed === true) await uSetOffer(out.latest, j.files, j.filesSig);
        else { uOffer = null; uEmit(true); }
        return out;
      } catch { return null; }
    },
    // In-app updates: the same calls preload.js gives the desktop page (src/updater.js there).
    async updateState() { await uInit(); return uState(); },
    onUpdateState(cb) { if (typeof cb === "function") uCbs.push(cb); },
    updateDownload() { uDownload(); },
    updatePause() { const P = updPlugin(); if (uDl && P) P.pause().catch(noop); },
    updateAuto(on) { ust.auto = !!on; usave(); if (!ust.auto) api.updatePause(); uEmit(true); },
    updateAckDone() { if (ust.justUpdated) { ust.justUpdated = ""; usave(); uEmit(true); } },
    updateRetry() { uErr = ""; uEmit(true); },
    updateInstall() { return uInstall(); },

    // Connect by IP ("Sambung lewat IP") through the native TdLan plugin — the same calls main.js answers on the
    // desktop. The phone only asks; it never listens (lanHost stays "not available").
    async lanOpen(address) {
      const Lan = lanPlugin();
      if (!Lan) return { ok: false, error: "Tidak tersedia di aplikasi HP" };
      const a = String(address || "").trim();
      const m = a.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/) || a.match(/^([^:\s]+)(?::(\d{1,5}))?$/);
      if (!m) return { ok: false, error: "Alamat IP tidak valid" };
      try { return await Lan.open({ id: "lan:" + a, host: m[1], port: Number(m[2]) || 7171 }); }
      catch (e) { return { ok: false, error: (e && e.message) || "Tidak bisa terhubung ke alamat ini" }; }
    },
    lanWrite(id, msg) { const Lan = lanPlugin(); if (Lan) Lan.write({ id: String(id), line: JSON.stringify(msg) }).catch(noop); },
    lanClose(id) { const Lan = lanPlugin(); if (Lan) Lan.close({ id: String(id) }).catch(noop); },
    onLanEvent(cb) {
      const Lan = lanPlugin(); if (!Lan) return;
      Lan.addListener("lan", (ev) => {
        if (!ev || typeof ev.id !== "string") return;
        if (ev.kind === "close") return cb({ id: ev.id, kind: "close" });
        let msg; try { msg = JSON.parse(ev.line); } catch { return; }
        if (msg && typeof msg === "object" && typeof msg.type === "string") cb({ id: ev.id, kind: "line", msg });
      });
    },
  };
  const _plugins = {};
  function plugin(name) {
    const Cap = window.Capacitor;
    if (!_plugins[name] && Cap) _plugins[name] = Cap.registerPlugin ? Cap.registerPlugin(name) : Cap.Plugins && Cap.Plugins[name];
    return _plugins[name] || null;
  }
  let _lan = null;
  function lanPlugin() {
    const Cap = window.Capacitor;
    if (!_lan && Cap) _lan = Cap.registerPlugin ? Cap.registerPlugin("TdLan") : Cap.Plugins && Cap.Plugins.TdLan;
    return _lan || null;
  }

  // Anything not listed: event subscriptions (on…) do nothing, every other call resolves to null —
  // the same "feature off" answer the desktop gives when a native piece is missing.
  window.electronAPI = new Proxy(api, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === "string" && key.startsWith("on")) return noop;
      return value(null);
    },
  });
})();
