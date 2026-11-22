// In-app updates (owner 18 Nov 2026: "Bangun Arah A tapi harus otomatis memperbarui aplikasi termasuk di Linux dan
// MacOS juga tanpa download ulang melalui website TryDesk"; concept gallery "Pembaruan TryDesk", direction A).
//
// How it works:
//  1. main.js check-update reads version.json. Besides the signed version fields it carries a signed download list
//     ("files" + "filesSig", made by scripts/sign-version.mjs): path, size and SHA-256 of every download of "latest".
//     setOffer() gets this PC's entry only when that list's own signature checks out.
//  2. download() fetches the file from trydesk.ai.id/downloads/ in the background (the page starts it only while no
//     session runs, and pauses it when one starts; a paused download resumes where it stopped). The file is kept only
//     when its size and SHA-256 equal the signed list; anything else is deleted and reported ("sig").
//  3. The verified file is installed when the user quits TryDesk, at the next start of TryDesk (the PC was shut down
//     with TryDesk in the tray), or at once with "Pasang sekarang". It is never installed while TryDesk runs a
//     session: quitting asks first when one is live, and the page only offers "Pasang sekarang" behind a question.
//  4. Each kind of install has its own way, all without the website:
//       win-setup       the NSIS Setup, silent (/S --updated), after this process has exited; then TryDesk again
//       win-portable    the new .exe is copied over the old one once its launcher let go of it; then started
//       mac-arm64/x64   the zip is unpacked (ditto) at download time; the .app is swapped after exit (with the Mac's
//                       password only when the app's folder isn't writable), quarantine flag removed, reopened
//       linux-appimage  the AppImage file is replaced (rename over it is safe while it runs) and started again
//       linux-deb       dpkg via pkexec (Linux asks for the password), then TryDesk again
//  5. Never twice in a loop: an install that didn't take (the version is still old at the next start) is tried at
//     most twice, then the page says so and offers the website.
// The service's own window (--service-host, SYSTEM) never updates: the Setup refreshes the service's copy.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

// The download list's signed bytes (must match filesCanonical in scripts/sign-version.mjs).
const FILE_KEYS = ["win-setup", "win-portable", "mac-arm64", "mac-x64", "linux-appimage", "linux-deb", "android"];
const filesCanonical = (f) => "trydesk-files-v1\n" + JSON.stringify([f.version, ...FILE_KEYS.filter((k) => f[k]).map((k) => [k, f[k].path, f[k].size, f[k].sha256])]);
const PATH_RE = /^(win|mac|linux|android)\/TryDesk-[A-Za-z0-9._-]{1,80}\.(exe|zip|AppImage|deb|apk)$/;
const MAX_SIZE = 400 * 1024 * 1024;
const MAX_TRIES = 2;
const verNum = (v) => String(v || "0.0.0").split(".").map(Number).reduce((a, b) => a * 1000 + (b || 0), 0);

// busy(): a session the Windows service runs for this user (its window or a request is up). No install starts on its
// own then (start-up, quitting); only after the user said yes to "Putuskan sesi untuk memasang?" (Windows review
// 18 Nov, finding 1).
function create({ app, net, verifySig, log, serviceHost, updateUrl, send, busy: svcBusy = () => false }) {
  const dir = path.join(app.getPath("userData"), "update");
  const stateFile = path.join(dir, "state.json");
  let st = { auto: true, pending: null, attempts: {}, justUpdated: "", partFor: "" };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) }; } catch {}
  if (!st.attempts || typeof st.attempts !== "object") st.attempts = {};
  const save = () => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(st)); } catch (e) { log("update: state not saved: " + e.message); } };

  let offer = null;      // { version, key, entry, url } from the last verified check
  let dl = null;         // { ctl, received, total } while downloading
  let error = "";        // "sig" | "install" (shown); network trouble stays silent and is retried at the next check
  let busy = false;      // an install has been started
  let lastEmit = 0, emitTimer = null;

  // Which download this copy of TryDesk installs, or "" when it can't update itself (dev run, an unpacked folder,
  // a Mac app started from a quarantined download folder, an unusual Linux install).
  // A dev run against a local test server can pretend to be one kind, to try the download and the page; it never
  // runs an installer (install() only logs).
  const devTest = !app.isPackaged && updateUrl.startsWith("http://") && FILE_KEYS.includes(process.env.TRYDESK_UPDATE_TEST_KIND || "");
  function kind() {
    if (serviceHost) return "";
    if (devTest) return process.env.TRYDESK_UPDATE_TEST_KIND;
    if (!app.isPackaged) return "";
    const exe = process.execPath;
    if (process.platform === "win32") {
      // Portable: only when its folder can be written (not Program Files, not a locked USB stick), or the swap could
      // never happen (Windows review 18 Nov, finding 3). Elsewhere it keeps the website link.
      if (process.env.PORTABLE_EXECUTABLE_FILE) {
        try { const t = path.join(path.dirname(process.env.PORTABLE_EXECUTABLE_FILE), `.trydesk-write-test-${process.pid}`); fs.writeFileSync(t, ""); fs.rmSync(t, { force: true }); return "win-portable"; }
        catch { return ""; }
      }
      return fs.existsSync(path.join(path.dirname(exe), "Uninstall TryDesk.exe")) ? "win-setup" : "";
    }
    if (process.platform === "darwin") {
      const a = macApp();
      if (!a || /\/AppTranslocation\//.test(a)) return "";
      return process.arch === "arm64" ? "mac-arm64" : "mac-x64";
    }
    if (process.platform === "linux") {
      if (process.env.APPIMAGE && fs.existsSync(process.env.APPIMAGE)) return "linux-appimage";
      if (exe.startsWith("/opt/TryDesk/")) return "linux-deb";
    }
    return "";
  }
  function macApp() { const a = path.resolve(process.execPath, "..", "..", ".."); return a.endsWith(".app") ? a : ""; }
  const K = kind();

  function phase() {
    if (busy) return "installing";
    if (dl) return "downloading";
    if (error) return "failed";   // an install that didn't take waits for the user (Coba lagi), the file stays
    if (pendingOk()) return "ready";
    return "idle";
  }
  function pendingOk() {
    const p = st.pending;
    return !!(p && p.kind === K && verNum(p.version) > verNum(app.getVersion()) && fs.existsSync(p.file));
  }
  function state() {
    const p = st.pending;
    return {
      supported: !!K, kind: K, auto: st.auto !== false, phase: phase(), error,
      version: (dl || pendingOk()) ? (dl ? offer && offer.version : p.version) : (offer ? offer.version : ""),
      received: dl ? dl.received : 0, total: dl ? dl.total : (offer ? offer.entry.size : 0),
      justUpdated: st.justUpdated || "", offered: !!offer,
    };
  }
  function emit(force) {
    const now = Date.now();
    if (!force && now - lastEmit < 250) { if (!emitTimer) emitTimer = setTimeout(() => { emitTimer = null; emit(true); }, 260); return; }
    lastEmit = now;
    try { send(state()); } catch {}
  }

  // From check-update: the parsed version.json (its own signature already checked) and the raw download list.
  function setOffer(latest, files, filesSig) {
    offer = null;
    if (!K || !files || typeof files !== "object" || files.version !== latest) return null;
    try {
      for (const k of FILE_KEYS) {
        const e = files[k];
        if (!e) continue;
        if (typeof e.path !== "string" || !PATH_RE.test(e.path) || !Number.isInteger(e.size) || e.size < 1 || e.size > MAX_SIZE || !/^[0-9a-f]{64}$/.test(e.sha256)) return null;
      }
      if (!verifySig(filesCanonical(files), filesSig)) { log("update: download list signature missing or invalid, ignored"); return null; }
    } catch { return null; }
    const entry = files[K];
    if (!entry || verNum(latest) <= verNum(app.getVersion())) { emit(true); return null; }
    offer = { version: latest, key: K, entry, url: new URL(entry.path, updateUrl).href };
    if (st.pending && st.pending.version !== latest && verNum(st.pending.version) < verNum(latest)) dropPending();   // an even newer one
    emit(true);
    return { size: entry.size };
  }

  function hashFileInto(file, hash) {
    return new Promise((res, rej) => { const s = fs.createReadStream(file); s.on("data", (b) => hash.update(b)); s.on("end", res); s.on("error", rej); });
  }
  async function download(retried) {
    if (!offer || dl || busy || !K) return;
    if (pendingOk() && st.pending.version === offer.version) { emit(true); return; }
    const { entry } = offer;
    fs.mkdirSync(dir, { recursive: true });
    const final = path.join(dir, path.basename(entry.path));
    const part = final + ".part";
    let hash = crypto.createHash("sha256"), have = 0;
    try {
      const s = fs.statSync(part);
      if (st.partFor === entry.sha256 && s.size > 0 && s.size < entry.size) { await hashFileInto(part, hash); have = s.size; }
      else fs.rmSync(part, { force: true });
    } catch {}
    st.partFor = entry.sha256; save();
    const ctl = new AbortController();
    dl = { ctl, received: have, total: entry.size };
    error = ""; emit(true);
    let out = null, ok = false;
    try {
      const r = await net.fetch(offer.url, { signal: ctl.signal, cache: "no-store", headers: have ? { Range: `bytes=${have}-` } : {} });
      if (have && r.status !== 206) { have = 0; dl.received = 0; hash = crypto.createHash("sha256"); }
      if (!r.ok) throw new Error("HTTP " + r.status);
      out = fs.createWriteStream(part, { flags: have ? "a" : "w" });
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        dl.received += value.length;
        if (dl.received > entry.size) throw new Error("larger than the signed size");
        hash.update(value);
        if (!out.write(value)) await new Promise((res) => out.once("drain", res));
        emit();
      }
      await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
      out = null;
      const sum = hash.digest("hex");
      if (dl.received !== entry.size || sum !== entry.sha256) {
        try { fs.rmSync(part, { force: true }); } catch {}
        st.partFor = ""; save();
        // A resumed file can be damaged by the break itself: one fresh try before calling it a mismatch.
        if (have && !retried) { log("update: resumed download did not match, trying once from the start"); dl = null; return await download(true); }   // await: this call's finally must not clear the retry's dl
        error = "sig";
        log(`update: ${entry.path} did not match the signed list (size ${dl.received}/${entry.size}, sha ${sum.slice(0, 12)}…), deleted`);
      } else {
        try { fs.rmSync(final, { force: true }); } catch {}
        fs.renameSync(part, final);
        await prepare(final);
        st.pending = { version: offer.version, kind: K, file: final, sha256: entry.sha256, size: entry.size };
        st.partFor = ""; save();
        ok = true;
        log(`update: ${offer.version} downloaded and verified (${entry.size} bytes)`);
      }
    } catch (e) {
      try { out && out.end(); } catch {}
      if (ctl.signal.aborted) log("update: download paused at " + (dl ? dl.received : 0) + " bytes");
      else if (e && e.code === "MAC_UNZIP") { error = "install"; log("update: " + e.message); }
      else log("update: download stopped (" + ((e && e.message) || e) + "), retried later");
    } finally { dl = null; emit(true); }
    return ok;
  }
  function pause() { if (dl) { try { dl.ctl.abort(); } catch {} } }

  // macOS: unpack once, at download time, so the swap after quitting is two renames.
  function prepare(file) {
    if (!K.startsWith("mac-")) return Promise.resolve();
    const stage = path.join(dir, "mac-stage");
    fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
    return new Promise((res, rej) => {
      const p = spawn("/usr/bin/ditto", ["-x", "-k", file, stage], { stdio: "ignore" });
      p.on("error", (e) => rej(Object.assign(new Error("unzip: " + e.message), { code: "MAC_UNZIP" })));
      p.on("exit", (code) => {
        if (code === 0 && fs.existsSync(path.join(stage, "TryDesk.app", "Contents", "Info.plist"))) res();
        else rej(Object.assign(new Error("unzip failed (" + code + ")"), { code: "MAC_UNZIP" }));
      });
    });
  }

  function dropPending() {
    try { for (const f of fs.readdirSync(dir)) if (f !== "state.json") fs.rmSync(path.join(dir, f), { recursive: true, force: true }); } catch {}
    st.pending = null; st.partFor = ""; save();
  }
  // The arguments a restarted TryDesk keeps (--tray from a Windows start, --no-gpu, a test's --user-data-dir ...).
  function keepArgs() {
    const a = process.argv.slice(app.isPackaged ? 1 : 2);
    return a.filter((x) => /^--[a-z]/.test(String(x)) && !/^--(relaunched|wait-for-pid|svc-open)=/.test(String(x)) && String(x).length < 500);
  }
  const cmdQ = (s) => '"' + String(s).replace(/%/g, "%%").replace(/"/g, "") + '"';
  const shQ = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  function runDetached(cmd, args, extra) {
    const c = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true, ...(extra || {}) });
    c.on("error", (e) => log("update: helper failed to start: " + e.message));
    c.unref();
  }
  function sha256Sync(file) {
    const h = crypto.createHash("sha256"), fd = fs.openSync(file, "r"), buf = Buffer.allocUnsafe(1 << 20);
    try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
    return h.digest("hex");
  }

  // Starts the install. Returns true when TryDesk must now exit (the helper waits for this process to end).
  // relaunch: open TryDesk again afterwards (Pasang sekarang, start-up install); false when the user is quitting.
  // confirmed: the user answered "Putuskan dan pasang" while a session ran (the page asks); otherwise a session the
  // Windows service runs for this user keeps the install for later.
  function install(relaunch, confirmed) {
    if (busy || !pendingOk()) return false;
    if (!confirmed) { let b = false; try { b = !!svcBusy(); } catch {} if (b) { log("update: the service is in a session, install waits"); return false; } }
    const p = st.pending;
    // The file sat in this user's folder since it was checked: check it again right before it runs.
    let sum = "";
    try { sum = sha256Sync(p.file); } catch {}
    if (sum !== p.sha256) { log("update: pending file changed since it was verified, deleted"); dropPending(); error = "sig"; emit(true); return false; }
    st.attempts[p.version] = (st.attempts[p.version] || 0) + 1; save();
    const args = relaunch ? keepArgs() : [];
    const pid = process.pid;
    if (devTest) { log(`update: dev test, would install ${p.file} (${K}, ${relaunch ? "then reopen" : "on quit"})`); busy = true; emit(true); return true; }
    try {
      if (K === "win-setup" || K === "win-portable") {
        const exe = K === "win-setup" ? process.execPath : process.env.PORTABLE_EXECUTABLE_FILE;
        const L = ["@echo off", "chcp 65001 >nul", "set n=0"];
        if (K === "win-setup") {
          // wait for this TryDesk to be gone (2 min at most), then the silent Setup (it keeps the install folder).
          // Still running after that: no Setup at all, it would close a TryDesk that didn't quit (review finding 5).
          L.push(":w", `tasklist /FI "PID eq ${pid}" /NH 2>nul | findstr /C:" ${pid} " >nul || goto run`, "set /a n+=1", "if %n% geq 120 goto end", "ping -n 2 127.0.0.1 >nul", "goto w",
            ":run", `${cmdQ(p.file)} /S --updated`, `echo %errorlevel%>${cmdQ(path.join(dir, "setup-exit.txt"))}`);
          if (relaunch) L.push(`start "" ${cmdQ(exe)} ${args.map(cmdQ).join(" ")}`);
        } else {
          // Portable (review finding 3): the new file goes next to the old one first, so a copy that breaks (disk
          // full, antivirus) never leaves a half-written TryDesk. The launcher holds the old .exe until TryDesk has
          // quit, so the rename is retried until it lets go (90 s at most). Whatever happens, TryDesk opens again:
          // the new one, or the old one (which then counts the try and stops after two).
          const nw = exe + ".new";
          L.push(`copy /y ${cmdQ(p.file)} ${cmdQ(nw)} >nul 2>&1 || goto fail`,
            ":w", `move /y ${cmdQ(nw)} ${cmdQ(exe)} >nul 2>&1 && goto run`, "set /a n+=1", "if %n% geq 90 goto fail", "ping -n 2 127.0.0.1 >nul", "goto w",
            ":fail", `del /f /q ${cmdQ(nw)} >nul 2>&1`, ":run");
          if (relaunch) L.push(`start "" ${cmdQ(exe)} ${args.map(cmdQ).join(" ")}`);
        }
        L.push(":end", 'del "%~f0"');
        const script = path.join(dir, "install.cmd");
        fs.writeFileSync(script, L.join("\r\n") + "\r\n", "utf8");
        // /s with the path in an extra pair of quotes: cmd keeps the inner quotes, so a user folder with & ( ) @ ^ in
        // its name ("Budi & Ani") still runs the script (review finding 2).
        runDetached(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${script}""`], { windowsVerbatimArguments: true });
      } else if (K === "linux-appimage") {
        const target = process.env.APPIMAGE, tmp = target + ".update";
        fs.copyFileSync(p.file, tmp); fs.chmodSync(tmp, 0o755); fs.renameSync(tmp, target);   // the running one keeps its own copy
        if (relaunch) app.relaunch({ execPath: target, args });
      } else {
        const lines = ["#!/bin/sh", `i=0; while kill -0 ${pid} 2>/dev/null && [ $i -lt 240 ]; do sleep 0.25; i=$((i+1)); done`];
        if (K === "linux-deb") {
          lines.push(`if command -v pkexec >/dev/null 2>&1; then pkexec /bin/sh -c 'dpkg -i "$1" || apt-get install -f -y' sh ${shQ(p.file)}; else xdg-open ${shQ(p.file)}; fi`);
          if (relaunch) lines.push(`${shQ(process.execPath)} ${args.map(shQ).join(" ")} >/dev/null 2>&1 &`);
        } else {
          const appDir = macApp(), stage = path.join(dir, "mac-stage", "TryDesk.app"), swap = path.join(dir, "swap.sh");
          fs.writeFileSync(swap, ["#!/bin/sh", `A=${shQ(appDir)}; N=${shQ(stage)}`, 'rm -rf "$A.old-update"', 'mv "$A" "$A.old-update" || exit 1',
            'if mv "$N" "$A"; then rm -rf "$A.old-update"; else mv "$A.old-update" "$A"; exit 1; fi', 'xattr -dr com.apple.quarantine "$A" 2>/dev/null', "exit 0"].join("\n") + "\n", { mode: 0o755 });
          // the app's folder writable for this user (dragged in by them, the usual case): no password at all
          lines.push(`if [ -w ${shQ(path.dirname(appDir))} ] && [ -w ${shQ(appDir)} ]; then /bin/sh ${shQ(swap)}; else /usr/bin/osascript -e ${shQ(`do shell script "/bin/sh " & quoted form of "${swap.replace(/"/g, "")}" with administrator privileges`)}; fi`);
          if (relaunch) lines.push(`/usr/bin/open ${shQ(appDir)}${args.length ? " --args " + args.map(shQ).join(" ") : ""}`);
        }
        const script = path.join(dir, "install.sh");
        fs.writeFileSync(script, lines.join("\n") + "\n", { mode: 0o755 });
        runDetached("/bin/sh", [script]);
      }
    } catch (e) { log("update: install could not start: " + e.message); error = "install"; emit(true); return false; }
    busy = true; emit(true);
    log(`update: installing ${p.version} (${K}, try ${st.attempts[p.version]}, ${relaunch ? "then reopen" : "on quit"})`);
    return true;
  }

  // At start, before any window: a verified update waiting from before is installed now (the PC was shut down with
  // TryDesk running, or it was downloaded and TryDesk never quit). Returns true when this process must exit.
  function atStart() {
    try { fs.rmSync(path.join(dir, "install.cmd"), { force: true }); } catch {}
    const p = st.pending;
    if (!p) return false;
    const cur = app.getVersion();
    if (verNum(cur) >= verNum(p.version)) {
      if (cur === p.version) { st.justUpdated = cur; log("update: now running " + cur); }
      dropPending(); st.attempts = {}; save();
      try { if (K.startsWith("mac-")) fs.rmSync(macApp() + ".old-update", { recursive: true, force: true }); } catch {}
      return false;
    }
    if (!K || serviceHost) return false;
    if ((st.attempts[p.version] || 0) >= MAX_TRIES) { error = "install"; log(`update: ${p.version} did not install after ${MAX_TRIES} tries, waiting for the user`); return false; }
    return install(true);
  }
  // The user quit TryDesk (tray Keluar, or X with "close to tray" off): install now, without reopening.
  function onUserQuit() { if (pendingOk() && !busy && !error) install(false); }
  function setAuto(on) { st.auto = !!on; save(); if (!st.auto) pause(); emit(true); }
  function ackDone() { if (st.justUpdated) { st.justUpdated = ""; save(); emit(true); } }
  function retry() {
    if (error === "install" && st.pending) { st.attempts = {}; save(); }
    error = ""; emit(true);
  }

  return { state, setOffer, download, pause, install, atStart, onUserQuit, setAuto, ackDone, retry, kind: () => K, devTest: () => devTest };
}

module.exports = { create, filesCanonical, FILE_KEYS };
