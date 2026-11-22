const { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, clipboard, globalShortcut, shell, powerSaveBlocker, Tray, Menu, nativeImage, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Security: a PACKAGED build must refuse remote-debugging / inspector switches. Otherwise any other process
// running as the same user could launch TryDesk with --remote-debugging-port and drive the renderer over CDP,
// which means full access to every IPC (file read/write, input injection). Dev builds (not packaged) still
// allow it, so the CDP diagnostics workflow keeps working.
try {
  if (app.isPackaged && ["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk", "inspect-port"]
      .some((s) => app.commandLine.hasSwitch(s))) {
    app.exit(1);
  }
} catch {}

// Properly-capitalised app name → the user-data folder becomes %APPDATA%\TryDesk (not "trydesk").
// MUST run before any app.getPath("userData") call below.
try { app.setName("TryDesk"); } catch {}
// Started by the TryDesk Windows service (trydesk-service.exe) as SYSTEM in the session that owns the screen: an
// unattended host with its own data folder under %ProgramData% (its own ID, apart from the user's TryDesk), no
// window, no tray, and connections only with the access password set for the service (service.json, written by
// an administrator). MUST be set before anything below reads the user-data path.
const _serviceHost = process.platform === "win32" && process.argv.includes("--service-host");
const _serviceDir = path.join(process.env.ProgramData || "C:\\ProgramData", "TryDesk");
if (_serviceHost) { try { app.setPath("userData", path.join(_serviceDir, "service-host")); } catch {} }
function servicePasswordHash() {
  // In service-host (SYSTEM + Administrators only), not the top folder users can read (that was 1.3.1).
  try { const j = JSON.parse(fs.readFileSync(path.join(_serviceDir, "service-host", "service.json"), "utf8")); return /^[0-9a-f]{32}:[0-9a-f]{64}$/.test(j.passwordHash || "") ? j.passwordHash : ""; } catch { return ""; }
}
// One-time: correct the on-disk case of an older lowercase "trydesk" user-data folder. Windows is
// case-insensitive so all stored data (ID, settings, localStorage) is preserved, this only fixes how the
// folder name is displayed. Done before anything opens a file inside it. A two-step rename forces the
// case change (a direct trydesk→TryDesk rename can be treated as the same path on Windows).
try {
  const _appData = app.getPath("appData");
  const _wrong = fs.readdirSync(_appData).find((n) => n.toLowerCase() === "trydesk" && n !== "TryDesk");
  if (_wrong) {
    const _tmp = path.join(_appData, "TryDesk.tmp-" + Date.now());
    fs.renameSync(path.join(_appData, _wrong), _tmp);
    fs.renameSync(_tmp, path.join(_appData, "TryDesk"));
  }
} catch {}

// GPU fallback: some client PCs (old/VM/RDP GPUs, outdated drivers) fault in the GPU process and show
// a blank window or none at all. Disable hardware acceleration when asked (--no-gpu / TRYDESK_NO_GPU)
// OR when a previous run hit a GPU crash and left the flag below (written automatically, see the
// child-process-gone handler), so the app self-heals on the next launch without the user doing anything.
let _noGpuFlag = null;
try { _noGpuFlag = path.join(app.getPath("userData"), "disable-gpu.flag"); } catch {}
const _flagExists = () => { try { return !!_noGpuFlag && fs.existsSync(_noGpuFlag); } catch { return false; } };
// Hyper-V guests (Windows Sandbox, Hyper-V VMs) can expose the host's GPU through GPU-PV. There, GPU-accelerated
// screen capture (DXGI / WGC frames shared with Chromium's GPU process) terminates the WHOLE VM the moment a
// session starts (Sandbox: "virtual machine exited unexpectedly 0x80370106"), measured; GDI and software
// rendering are fine. Such guests run in software mode. --force-gpu overrides.
function _hyperVGuest() {
  if (process.platform !== "win32") return null;
  if ((process.env.USERNAME || "").toUpperCase() === "WDAGUTILITYACCOUNT") return "windows-sandbox";
  // The TryDesk service's own TryDesk runs as SYSTEM, so the name above doesn't show; the Sandbox's one user folder does.
  try { if (fs.existsSync(path.join(process.env.SystemDrive || "C:", "Users", "WDAGUtilityAccount"))) return "windows-sandbox"; } catch {}
  try {
    const out = require("child_process").execFileSync("reg", ["query", "HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS", "/v", "SystemProductName"], { encoding: "utf8", timeout: 1500, windowsHide: true });
    if (/Virtual Machine/i.test(out)) return "hyper-v";
  } catch {}
  return null;
}
const _vmGuest = process.argv.includes("--force-gpu") ? null : _hyperVGuest();
// The user's own choice (Settings → Lanjutan → GPU acceleration off). Separate from the crash flag above, which
// clears itself after a stable start.
let _userNoGpuFlag = null;
try { _userNoGpuFlag = path.join(app.getPath("userData"), "user-no-gpu.flag"); } catch {}
const _userNoGpu = (() => { try { return !!_userNoGpuFlag && fs.existsSync(_userNoGpuFlag); } catch { return false; } })();
const _forceNoGpu = process.argv.includes("--no-gpu") || !!process.env.TRYDESK_NO_GPU || _flagExists() || !!_vmGuest || _userNoGpu;
if (_forceNoGpu) { try { app.disableHardwareAcceleration(); } catch {} }

// Screen-capture coverage: on some PCs the default DXGI capturer can't see a monitor (HDR on, or the monitor
// hangs off a different GPU), so getSources lists fewer screens than Windows has and that monitor can't be
// streamed, picking it shows another screen. Windows Graphics Capture (WGC) sees every monitor. It is
// switched on only where that gap was detected (flag written by the startup check / get-monitors), so every
// other PC keeps the default capturer. --wgc forces it for testing.
let _wgcFlag = null;
try { _wgcFlag = path.join(app.getPath("userData"), "wgc-capture.flag"); } catch {}
// Inside a Remote Desktop (RDP) session WGC sent only black frames (rented RDP PC, 2026-11-02: black with the
// window full-screen or not), while DXGI capture of the same session showed the desktop. There WGC is switched
// off so Chromium uses DXGI / GDI; in Windows Sandbox (also a remote session) that kept the picture (measured).
// Asked from Windows itself (SM_REMOTESESSION): SESSIONNAME alone missed it in a copy run as administrator, that
// environment has no SESSIONNAME, so WGC stayed on and every capture failed ("Could not start video source", the
// viewer could not connect; rented PC, 2026-11-02).
const _rdpSession = process.platform === "win32" && (() => {
  if (/^RDP-/i.test(process.env.SESSIONNAME || "")) return true;
  try { return !!require("koffi").load("user32.dll").func("int __stdcall GetSystemMetrics(int nIndex)")(0x1000); } catch { return false; }
})();
const _wgcOn = !_rdpSession && (process.argv.includes("--wgc") || (() => { try { return !!_wgcFlag && fs.existsSync(_wgcFlag); } catch { return false; } })());
if (_wgcOn) { try { app.commandLine.appendSwitch("enable-features", "AllowWgcScreenCapturer"); } catch {} }
if (_rdpSession) { try { app.commandLine.appendSwitch("disable-features", "AllowWgcScreenCapturer,AllowWgcWindowCapturer"); } catch {} }
// The service's host renders its sessions in a window that is usually hidden (the user's own TryDesk shows the
// session): its renderer must keep full priority, or a software encoder (no GPU) dropped frames at the start.
if (_serviceHost) { try { app.commandLine.appendSwitch("disable-renderer-backgrounding"); } catch {} }
// Viewer, WebRTC picture: WebRTC's own playout delay grew from ~5 to 30-45 ms after every codec change and after any
// hiccup (a keyframe, a short freeze), then came down by ~1 ms a second, whatever jitterBufferTarget said (owner 17 Nov:
// "delay makin parah ketika ganti codec", "latensi sering naik sendiri"; measured, scratchpad build/codeclag.mjs). With
// the playout delay forced to 0-1 ms WebRTC renders each frame the moment it is decoded (its low-latency path): received
// -> shown ~3 ms instead of 18-45, flat across codec changes. Frames still wait until they are whole (lost packets are
// resent first). The cost: no smoothing on a jittery link (jitterBufferTarget has no effect), the newest frame always
// wins, as in game streaming. A cap of 500 ms (which would have kept jitterBufferTarget working) let the compositor
// queue frames instead: 110-140 ms after a minute. The Android viewer has no such switch and keeps pollStats' buffer.
try { app.commandLine.appendSwitch("force-fieldtrials", "WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:1/"); } catch {}

// Language for text the main process shows itself (dialogs, black-screen overlay, Discord presence). The
// renderer reports the user's choice; until then follow Windows, exactly like the renderer's default.
let _uiLang = null;
const UI_LANGS = new Set(["id", "en", "ms", "zh-CN", "zh-TW", "ja", "ko", "vi", "th", "fil", "es", "pt-BR", "hi", "ru", "fr", "de", "tr", "pl", "it", "nl", "uk", "ar"]);
function uiLang() { if (_uiLang) return _uiLang; try { return /^id\b/i.test(app.getLocale()) ? "id" : "en"; } catch { return "id"; } }
// Other languages: the same file the window uses (renderer/locales/<code>.js), read once.
const _mainLoc = {};
function mainLocale(code) {
  if (code in _mainLoc) return _mainLoc[code];
  let d = null;
  try {
    const raw = fs.readFileSync(path.join(__dirname, "renderer", "locales", code + ".js"), "utf8");
    d = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    d.pc = (d.p || []).map(([re, fl, tpl]) => { try { return [new RegExp(re, fl || ""), String(tpl).replace(/\$/g, "$$$$").replace(/\{(\d)\}/g, "$$$1")]; } catch { return null; } }).filter(Boolean);
  } catch {}
  return (_mainLoc[code] = d);
}
function L(id, en) {
  const l = uiLang();
  if (l === "id") return id;
  if (l === "en") return en;
  const d = mainLocale(l); if (!d) return en;
  const k = String(id).replace(/\s+/g, " ");
  if (d.s && d.s[k] != null) return d.s[k];
  for (const [re, tpl] of d.pc) if (re.test(k)) return k.replace(re, tpl);
  return en;
}

// Make any startup failure VISIBLE (and logged) instead of a silent no-window exit, so a client PC
// that "shows nothing" gives a real error + a log we can read, rather than just vanishing.
let _logFile;
try { _logFile = path.join(app.getPath("userData"), "trydesk-crash.log"); } catch { _logFile = path.join(os.tmpdir(), "trydesk-crash.log"); }
// The log only ever grows (session/capture breadcrumbs), so keep it bounded on users' disks: past ~1 MB,
// keep just the newest 512 KB. Checked at startup and every 200 writes while running.
const LOG_MAX = 1024 * 1024, LOG_KEEP = 512 * 1024;
let _logWrites = 0;
function trimLog() {
  try {
    if (fs.statSync(_logFile).size <= LOG_MAX) return;
    const buf = fs.readFileSync(_logFile);
    const tail = buf.subarray(buf.length - LOG_KEEP);
    const nl = tail.indexOf(10);   // start on a whole line
    fs.writeFileSync(_logFile, nl >= 0 ? tail.subarray(nl + 1) : tail);
  } catch {}
}
trimLog();
function appendLog(line) {
  try { fs.appendFileSync(_logFile, line); } catch {}
  if (++_logWrites % 200 === 0) trimLog();
}
function logCrash(tag, err) {
  appendLog(`[${new Date().toISOString()}] ${tag}: ${(err && err.stack) || err}\n`);
  try { if (app.isReady()) dialog.showErrorBox(L("TryDesk bermasalah saat dijalankan", "TryDesk ran into a problem"), String((err && err.stack) || err).slice(0, 2000) + "\n\nLog: " + _logFile); } catch {}
}
// Quiet breadcrumbs (no dialog) so the log traces how far startup got on a PC where "nothing appears":
// if the file has "boot: module loaded" but not "boot: app ready", Electron never reached our JS.
function logInfo(msg) { appendLog(`[${new Date().toISOString()}] boot: ${msg}\n`); }
// Build stamp (packaged app.asar mtime) so a log shows WHICH build a client PC is really running.
const _buildStamp = (() => { try { return require("original-fs").statSync(path.join(process.resourcesPath, "app.asar")).mtime.toISOString(); } catch { return "dev"; } })();
logInfo(`module loaded, electron ${process.versions.electron}, ${process.platform} ${process.arch}, build ${_buildStamp}, no-gpu=${_forceNoGpu}${_vmGuest ? ` (vm: ${_vmGuest})` : ""}, wgc=${_wgcOn}${_rdpSession ? " (rdp session: wgc off)" : ""}`);
let _windowReady = false;   // true once the renderer has loaded
// A crash BEFORE the window loads is startup-fatal: show it, then EXIT, so a half-dead process
// doesn't linger holding the single-instance lock (which would make the next open "do nothing").
process.on("uncaughtException", (e) => { logCrash("uncaughtException", e); if (!_windowReady) { try { app.exit(1); } catch {} } });
// A rejected promise is NON-fatal (unlike uncaughtException): log it for diagnosis but DON'T pop a scary
// modal, e.g. discord-rpc rejects when Discord isn't running, which must never block the app from launching.
process.on("unhandledRejection", (e) => { appendLog(`[${new Date().toISOString()}] unhandledRejection (non-fatal): ${(e && e.stack) || e}\n`); });

// The real exe to relaunch: the portable build runs from a temp-extracted copy that its wrapper may delete once
// the original exits, so relaunches must target the portable file itself.
const _selfExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
// reason ("gpu" | "wgc") rides along as --relaunched=, so the new window can say why TryDesk just closed and came
// back (user report 12 Nov: "portable kadang close sendiri"; the portable build takes seconds to unpack again).
const relaunchSelf = (reason) => {
  // (--wait-for-pid belongs to the "Run as administrator" start only: a reused PID would delay the restart 8 s)
  const args = process.argv.slice(1).filter((a) => !/^--(relaunched|wait-for-pid)=/.test(String(a)));
  if (reason) args.push("--relaunched=" + reason);
  app.relaunch({ execPath: _selfExe, args });
};
const _relaunchedFor = ((process.argv.find((a) => String(a).startsWith("--relaunched=")) || "").split("=")[1] || "").replace(/[^a-z]/g, "").slice(0, 8);

// Relaunched elevated ("Run as administrator"): wait for the old instance to exit before taking the single-
// instance lock, or the new one would find it still held and quit, leaving nothing running.
const _waitPid = Number((process.argv.find((a) => a.startsWith("--wait-for-pid=")) || "").split("=")[1]) || 0;
if (_waitPid) {
  const until = Date.now() + 8000, nap = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < until) { try { process.kill(_waitPid, 0); } catch { break; } Atomics.wait(nap, 0, 0, 100); }
}

// Single instance: a second launch focuses the existing window instead of spawning a hidden,
// window-less duplicate process (which looks like "nothing happened").
// The other copy says which exe it is: a TryDesk Portable opened while the installed TryDesk sits in the tray (or the
// other way round) closed at once without a word (they share one data folder, so one lock), and looked like the
// portable build "closing by itself" (user report 12 Nov). The copy that keeps running now says so.
const _gotLock = app.requestSingleInstanceLock({ exe: _selfExe, portable: !!process.env.PORTABLE_EXECUTABLE_FILE });
if (!_gotLock) app.quit();
else app.on("second-instance", (_e, argv, _cwd, extra) => {
  // Windows' own start entry (--tray) finding TryDesk already running: nothing to show.
  if ((argv || []).includes("--tray")) return;
  // Asked for by the service's window: take the session over and open what it asked for.
  const want = svcOpenArg(argv);
  if (want) {
    _svcTakeover = true; setTimeout(() => { _svcTakeover = false; }, 20000);
    try { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } catch {}
    if (!_windowReady) _svcOpenWanted = want;   // still loading (e.g. a --tray start): sent once it has loaded
    else { try { mainWindow.webContents.send("svc-open", want); } catch {} }
    return;
  }
  showMainWindow();
  try {
    const other = extra && typeof extra.exe === "string" ? extra.exe : "";
    const real = (p) => { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return path.resolve(p).toLowerCase(); } };   // 8.3 names, junctions
    // Windows only: Portable and Setup share one data folder there. A Linux AppImage runs from a new /tmp mount on
    // every start, so the same file looked like "another copy".
    if (process.platform === "win32" && other && real(other) !== real(_selfExe) && !(argv || []).some((a) => String(a).startsWith("--wait-for-pid="))) {
      logInfo("second instance from another exe (" + (extra.portable ? "portable" : "installed") + "), kept this one");
      mainWindow.webContents.send("other-copy-blocked", { otherPortable: !!extra.portable, thisPortable: !!process.env.PORTABLE_EXECUTABLE_FILE });
    }
  } catch {}
  // An elevated copy from "Run as administrator" lost the race: this copy was started by hand while the portable
  // build was still unpacking the new one. Say so here, or the user just gets a non-admin TryDesk without a word.
  if ((argv || []).some((a) => String(a).startsWith("--wait-for-pid="))) {
    logInfo("relaunch-as-admin: elevated copy found this one already running and quit");
    try { mainWindow.webContents.send("elevated-relaunch-blocked"); } catch {}
  }
});

// Taskbar identity. Packaged builds use "TryDesk" (notifications show that name). A dev run (plain electron.exe)
// gets its own ID, sharing one made Windows show the Electron icon for the real app on a developer's PC.
const AUMID = app.isPackaged ? "TryDesk" : "TryDesk.Dev";
// Windows takes the taskbar and notification icon for an AUMID from the Start Menu shortcut that carries it. A
// "TryDesk.lnk" can end up pointing at an exe that is gone: the portable build's temp copy (a fresh %TEMP% folder
// every launch, deleted on exit) or a removed build folder. From then on every TryDesk window showed a blank icon.
// Point such a shortcut at the exe that stays (the installed TryDesk.exe or the portable file itself). A working
// shortcut (e.g. the installer's) is left alone, and none is created where there was none.
function repairStartMenuShortcut() {
  if (process.platform !== "win32" || !app.isPackaged) return;
  const lnk = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "TryDesk.lnk");
  let cur;
  try { cur = shell.readShortcutLink(lnk); } catch { return; }
  // Compare real long paths: %TEMP% can be an 8.3 short name (C:\Users\JOHNSM~1\...) while the shortcut has the long one.
  const real = (p) => { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return path.resolve(p).toLowerCase(); } };
  const tmp = real(os.tmpdir()) + path.sep;
  const broken = !cur.target || !fs.existsSync(cur.target) || real(cur.target).startsWith(tmp);
  if (!broken || real(_selfExe).startsWith(tmp)) return;
  try {
    shell.writeShortcutLink(lnk, "replace", { target: _selfExe, icon: _selfExe, iconIndex: 0, appUserModelId: AUMID, description: "TryDesk" });
    logInfo(`start-menu shortcut repaired (was ${cur.target || "empty"})`);
  } catch (e) { logInfo("start-menu shortcut repair failed: " + e.message); }
}
// Started by Windows at login ("Mulai saat startup"): come up quietly in the system tray, like AnyDesk.
const _startInTray = process.argv.includes("--tray");
// Opened by the service's window ("Pengaturan" / "Kirim file" there, trydesk-service.exe launch-user): this TryDesk
// takes the session over instead of stepping aside for the service's window, then opens what was asked for.
const SVC_OPEN = new Set(["settings", "files", "open"]);
const svcOpenArg = (argv) => { const a = (argv || []).find((x) => String(x).startsWith("--svc-open=")); const v = a ? String(a).slice(11) : ""; return SVC_OPEN.has(v) ? v : ""; };
let _svcOpenWanted = svcOpenArg(process.argv);   // sent to the page once it has loaded
let _svcTakeover = !!_svcOpenWanted;              // until the service's window has gone (or 20 s)
if (_svcTakeover) setTimeout(() => { _svcTakeover = false; }, 20000);

// ─── System tray (installer AND portable) ─────────────────
// TryDesk lives in the tray while it runs: the X button only hides the window (unless the user turned that off),
// so this PC stays reachable; "Keluar" in the tray menu really quits.
let tray = null, _trayId = "", _trayHosting = false, _quitting = false;
function showMainWindow() {
  if (!mainWindow) return;
  if (serviceToFront()) return;   // the service's session window is the one TryDesk window now

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}
function trayImage() {
  // PNGs (an .ico inside app.asar can't be read by Windows' icon loader); one representation per DPI scale.
  const img = nativeImage.createEmpty();
  for (const [px, scale] of [[16, 1], [20, 1.25], [24, 1.5], [32, 2]]) {
    try { img.addRepresentation({ scaleFactor: scale, buffer: fs.readFileSync(path.join(__dirname, "..", "assets", `tray-${px}.png`)) }); } catch {}
  }
  return img;
}
function refreshTray() {
  if (!tray) return;
  const idLine = _trayId ? `ID ${_trayId}` : L("Belum terhubung ke server", "Not connected to the server");
  tray.setToolTip(`TryDesk, ${_trayHosting ? L("PC ini sedang dikontrol", "This PC is being controlled") : idLine}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `TryDesk · ${idLine}`, enabled: false },
    { type: "separator" },
    { label: L("Buka TryDesk", "Open TryDesk"), click: showMainWindow },
    { label: L("Salin ID", "Copy ID"), enabled: !!_trayId, click: () => clipboard.writeText(_trayId) },
    { type: "separator" },
    { label: L("Keluar", "Quit"), click: requestQuit },
  ]));
}
function createTray() {
  try {
    tray = new Tray(trayImage());
    tray.on("click", showMainWindow);
    tray.on("double-click", showMainWindow);
    refreshTray();
  } catch (e) { logInfo("tray failed: " + e.message); tray = null; }
}
// ─── macOS menu bar ───────────────────────────────────────
// On a Mac, Cmd+C/V/X/A/Z only work in text fields when the app menu has an Edit menu, so it is there while you
// type. While a remote PC is being controlled the menu drops every shortcut: Cmd+C must reach the remote PC (the
// page sends it as Ctrl+C), not copy on this Mac. Cmd+Q asks first when a session is live, like "Keluar" in the tray.
function setMacMenu(controlling) {
  if (process.platform !== "darwin") return;
  const quit = { label: L("Keluar dari TryDesk", "Quit TryDesk"), click: requestQuit };
  if (!controlling) quit.accelerator = "Cmd+Q";
  const appMenu = { label: "TryDesk", submenu: [
    { role: "about", label: L("Tentang TryDesk", "About TryDesk") },
    { type: "separator" },
    controlling ? { label: L("Sembunyikan TryDesk", "Hide TryDesk"), click: () => app.hide() } : { role: "hide", label: L("Sembunyikan TryDesk", "Hide TryDesk") },
    { type: "separator" },
    quit,
  ] };
  const template = controlling ? [appMenu] : [appMenu, { role: "editMenu", label: L("Edit", "Edit") }, { role: "windowMenu", label: L("Jendela", "Window") }];
  try { Menu.setApplicationMenu(Menu.buildFromTemplate(template)); } catch (e) { logInfo("mac menu failed: " + e.message); }
}

// "Keluar": the page asks first when a session is live (same question as before), then calls quit-app.
function requestQuit() {
  if (!mainWindow || !_windowReady) { _quitting = true; app.quit(); return; }
  try { mainWindow.webContents.send("quit-requested"); } catch { _quitting = true; app.quit(); }
}
// A downloaded, verified update installs when the user quits (src/updater.js), not when TryDesk restarts itself.
ipcMain.on("quit-app", () => { _quitting = true; try { if (!_sessionEnding) updater.onUserQuit(); } catch {} app.quit(); });
ipcMain.on("hide-to-tray", (_e, firstTime) => {
  if (!mainWindow) return;
  if (!tray) { _quitting = true; app.quit(); return; }   // no tray → hiding would leave the app unreachable
  mainWindow.hide();
  if (firstTime) {
    try {
      tray.displayBalloon({
        iconType: "info", title: L("TryDesk tetap berjalan", "TryDesk is still running"),
        content: L("PC ini tetap bisa dihubungi. Klik ikon TryDesk di system tray untuk membuka, atau klik kanan → Keluar.",
                   "This PC can still be reached. Click the TryDesk icon in the system tray to open it, or right-click → Quit."),
      });
    } catch {}
  }
});
ipcMain.on("tray-info", (_e, info) => {
  _trayId = typeof info?.id === "string" ? info.id.slice(0, 20) : "";
  refreshTray();
});

let config;
try { config = require("./config.json"); } catch (e) { logCrash("config.json gagal dimuat", e); config = { iceServers: [] }; }
const inputSim = require("./input-simulator");
const discordRPC = require("./discord-rpc");

let mainWindow;
let blackScreenWindows = [];
const inputReady = inputSim.init();

// ─── Full keyboard capture (viewer) ───────────────────────
// While the viewer actively controls a remote PC, we install a low-level keyboard hook so EVERY key —
// including system shortcuts the browser can't see outside fullscreen (Alt+Tab, Win, Alt+Esc, Ctrl+Esc) —
// is forwarded to the remote and swallowed locally. We only swallow while the TryDesk window is focused,
// so the user can always click away (or the window blurs) to get their own keyboard back instantly.
let _kbWantCapture = false, _kbFocused = false, _kbNoticeSent = false, _mouseWant = false;
let _hostCursorHidden = false;   // latest debounced host cursor-capture state (for re-emit on channel open)
let _dmSourceId = null;          // which screen the renderer wants getDisplayMedia to capture (monitor select)
// Re-center target for native game-mouse capture: the physical-pixel center of the display the window is on,
// far from any screen edge so relative moves never get clamped. dipToScreenPoint handles HiDPI scaling.
function recenterMouse(moveCursor) {
  try {
    const { screen } = require("electron");
    const d = screen.getDisplayMatching(mainWindow.getBounds());
    const c = screen.dipToScreenPoint({ x: Math.round(d.bounds.x + d.bounds.width / 2), y: Math.round(d.bounds.y + d.bounds.height / 2) });
    inputSim.setMouseCenter(c.x, c.y);
    // On first engage, physically park the cursor at center so the first captured delta is ~0 (no camera jump).
    if (moveCursor) { try { inputSim.moveMouse(c.x, c.y); } catch {} }
  } catch {}
}
const _CTRL_VKS = new Set([0x11, 0xA2, 0xA3]), _ALT_VKS = new Set([0x12, 0xA4, 0xA5]), _SHIFT_VKS = new Set([0x10, 0xA0, 0xA1]);
let _downVks = new Set(), _escArmed = false;
function _anyDown(set) { for (const v of set) if (_downVks.has(v)) return true; return false; }
// Release control NOW: free the mouse immediately in the main process (don't wait on the renderer round-trip)
// AND tell the renderer so the UI/game-mode state syncs. The guaranteed "give me my PC back".
function releaseControlNow() {
  try { if (_mouseWant) { _mouseWant = false; inputSim.stopMouseHook && inputSim.stopMouseHook(); } } catch {}
  try { mainWindow && mainWindow.webContents.send("release-control"); } catch {}
}
function refreshKeyHook() {
  if (!inputReady || !inputSim.startKeyHook) return;
  if (_kbWantCapture) {
    inputSim.startKeyHook((vk, down) => {
      if (!(_kbWantCapture && _kbFocused)) return false;   // not focused → pass through to the local OS
      if (down) _downVks.add(vk); else _downVks.delete(vk);
      // ESCAPE HATCH 1, Ctrl+Alt+Shift+Esc releases control (mouse + keyboard) so the user can ALWAYS get
      // back to their own PC, even mid-game. It REQUIRES Esc on purpose: a bare Ctrl+Alt+Shift used to fire
      // this, which clashed with the many app/game shortcuts that hold Ctrl+Alt+Shift, now those pass
      // through to the remote, and only the full +Esc combo escapes.
      if (vk === 0x1B && down && _anyDown(_CTRL_VKS) && _anyDown(_ALT_VKS) && _anyDown(_SHIFT_VKS)) {
        releaseControlNow();
        return false;
      }
      // ESCAPE HATCH 2, Pause/Break, the dedicated "give me my PC back" key (never forwarded/swallowed).
      if (vk === 0x13) { if (down) releaseControlNow(); return false; }
      try { mainWindow && mainWindow.webContents.send("captured-key", { vk, down }); } catch {}
      return true;                                         // swallow locally → key only reaches the remote
    });
  } else {
    inputSim.stopKeyHook();
    _downVks.clear(); _escArmed = false;
    _kbNoticeSent = false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 600,
    minWidth: 700,
    minHeight: 500,
    frame: false,
    // Shown once the page has loaded (did-finish-load): the service's host must never show an empty window on the
    // user's desktop, and a --tray start stays in the tray.
    show: false,
    backgroundColor: "#0a0a0f",
    icon: path.join(__dirname, "..", "assets", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,   // a released build has no DevTools at all (the service's host runs as SYSTEM)
      // The service's host does its capture and (without a GPU) its encoding in a window that stays hidden for the
      // whole session when the user's own TryDesk shows it: Chromium must not slow a hidden page's timers down.
      ...(_serviceHost ? { backgroundThrottling: false } : {}),
    },
  });
  // No default menu on Windows/Linux: the window is frameless and the default one only brought Electron's own
  // shortcuts (Ctrl+Shift+I, Ctrl+R) into a window that may belong to the SYSTEM service.
  if (process.platform !== "darwin") { try { Menu.setApplicationMenu(null); } catch {} }
  watchDisplayState(mainWindow);
  // The service's window runs as SYSTEM: a download would open a Windows "Save" dialog as SYSTEM, and from that dialog
  // any program can be started (security audit 22 Nov). The page never downloads anything; refuse it all.
  if (_serviceHost) { try { mainWindow.webContents.session.on("will-download", (e, item) => { e.preventDefault(); try { item.cancel(); } catch {} }); } catch {} }
  if (_serviceHost) mainWindow.webContents.on("before-input-event", (ev, input) => {
    const k = String(input.key || "").toLowerCase();
    if (k === "f12" || (input.control && input.shift && (k === "i" || k === "j" || k === "c")) || (input.control && k === "r") || k === "f5") ev.preventDefault();
  });
  // The taskbar button takes its icon and "pin" target from these window properties, the TryDesk exe itself
  // (for the portable build: the portable file, not its temp-extracted copy).
  try {
    mainWindow.setAppDetails({ appId: AUMID, appIconPath: _selfExe, appIconIndex: 0, relaunchCommand: `"${_selfExe}"`, relaunchDisplayName: "TryDesk" });
  } catch {}
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.on("did-finish-load", () => {
    _windowReady = true; logInfo("renderer loaded" + (_serviceHost ? " (service host)" : ""));
    if (_serviceHost) return;                             // the service's host never shows a window
    if (_svcOpenWanted) { const w = _svcOpenWanted; _svcOpenWanted = ""; try { mainWindow.webContents.send("svc-open", w); } catch {} }
    if (_startInTray && tray) return;                     // Windows login start: stay in the tray
    if (serviceToFront()) return;                         // started during the service's session: one TryDesk window
    try { mainWindow.show(); mainWindow.focus(); } catch {}
  });
  // Alt+F4 / the taskbar's "Close window": same as the X button, hide to the tray, unless really quitting.
  mainWindow.on("close", (e) => {
    // The service's host only shows its window for a request or a running session: Alt+F4 / the taskbar's Close act
    // like its X (the page rejects the request or ends the session, then hides the window). It never quits.
    if (_serviceHost && !_quitting) { e.preventDefault(); try { mainWindow.webContents.send("close-requested"); } catch { mainWindow.hide(); } return; }
    if (_quitting || !tray) return;
    e.preventDefault();
    try { mainWindow.webContents.send("close-requested"); } catch { mainWindow.hide(); }
  });
  // The service's window is up (a request waiting, or a session): the user's own TryDesk steps aside meanwhile, so
  // only one TryDesk window shows (see serviceSessionChanged).
  if (_serviceHost) {
    mainWindow.on("show", () => { _svcWinShown = true; svcPublish(); });
    mainWindow.on("hide", () => { _svcWinShown = false; svcPublish(); });
  } else {
    // Whatever brings this window up while the service's window is up (a notification, a dialog), it goes back.
    mainWindow.on("show", () => { if (_svcUp) setImmediate(keepOutForService); });
  }
  // Only swallow keys while focused; on blur, stop swallowing AND release any held keys on the host so a
  // modifier can't get stuck down when the user clicks away mid-combo.
  mainWindow.on("focus", () => { _kbFocused = true; });
  mainWindow.on("blur", () => { _kbFocused = false; _downVks.clear(); _escArmed = false; try { mainWindow.webContents.send("release-keys"); } catch {} });
  // Keep the game-mouse re-center point correct if the window moves to another monitor / resizes.
  mainWindow.on("move", () => { if (_mouseWant) recenterMouse(); });
  mainWindow.on("resize", () => { if (_mouseWant) recenterMouse(); });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => { if (code !== -3) logCrash("did-fail-load", code + " " + desc + " " + url); });
  // Recover once from a renderer/GPU crash (a blank window) by reloading instead of leaving it dead.
  let _reloaded = false;
  mainWindow.webContents.on("render-process-gone", (_e, d) => {
    logCrash("render-process-gone", d && d.reason);
    // The page that owned them is gone: drop every native effect it had switched on, or the black screen,
    // BlockInput, game-mode mouse trap and held keys would outlive it (and the reloaded page knows nothing).
    try { disableBlackScreen(); } catch {}
    try { disableInputLock(); } catch {}
    try { if (inputReady) inputSim.releaseAll(); } catch {}
    try { _kbWantCapture = false; refreshKeyHook(); setMacMenu(false); } catch {}
    try { _mouseWant = false; inputSim.stopMouseHook && inputSim.stopMouseHook(); } catch {}
    try { stopFast(); stopFastRecv(); stopLoop(); } catch {}   // capture / UDP / sound helpers: the reloaded page can't stop them
    if (!_reloaded) { _reloaded = true; try { mainWindow.reload(); } catch {} }
  });
  // A reload (Settings → reset, or after a crash) starts a page that knows nothing of the helpers the old one ran: they
  // kept capturing, encoding and sending sound to a page that throws it away, until the next session or quit.
  mainWindow.webContents.on("did-start-navigation", (e, _url, isInPlace, isMainFrame) => {
    const main = e && typeof e.isMainFrame === "boolean" ? e.isMainFrame : isMainFrame;
    const same = e && typeof e.isSameDocument === "boolean" ? e.isSameDocument : isInPlace;
    if (main && !same) { try { stopFast(); stopFastRecv(); stopLoop(); } catch {} }
  });
  // Lock navigation down: the app is a single local page. Block opening child windows and block
  // any attempt to navigate the window away from the bundled file (defense if the renderer is abused).
  // One exception: "Satu jendela per monitor" (Control Center › Monitor) opens an empty window of this page for each
  // other monitor of the remote PC, named tdmon-<k>-<monitor>; the page draws the picture and takes the input itself.
  // It is placed on this PC's k-th screen other than the one TryDesk is on (full size), else cascaded beside it.
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === "about:blank" && /^tdmon-\d-\d{1,2}$/.test(String(frameName || "")) && !_serviceHost) {
      return { action: "allow", overrideBrowserWindowOptions: { width: 960, height: 600, minWidth: 320, minHeight: 200, show: false, backgroundColor: "#0b0b0c", autoHideMenuBar: true, title: "TryDesk",
        icon: path.join(__dirname, "..", "assets", process.platform === "win32" ? "icon.ico" : "icon.png") } };
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-create-window", (w, details) => {
    try {
      w.setMenu(null);
      w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      w.webContents.on("will-navigate", (e) => e.preventDefault());
      w.webContents.on("will-redirect", (e) => e.preventDefault());
      w.webContents.on("will-attach-webview", (e) => e.preventDefault());
      // A reload of the app's page leaves no one to draw it: it goes too.
      const closeIt = (e, _url, inPlace, mainFrame) => {
        const same = e && e.isSameDocument != null ? e.isSameDocument : inPlace;
        const top = e && e.isMainFrame != null ? e.isMainFrame : mainFrame;
        if (top && !same) { try { if (!w.isDestroyed()) w.close(); } catch {} }
      };
      mainWindow.webContents.on("did-start-navigation", closeIt);
      w.once("closed", () => { try { mainWindow.webContents.removeListener("did-start-navigation", closeIt); } catch {} });
      const k =Number((/^tdmon-(\d)-/.exec(String(details && details.frameName)) || [])[1]) || 1;
      const here = screen.getDisplayMatching(mainWindow.getBounds());
      const others = screen.getAllDisplays().filter((d) => d.id !== here.id).sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
      const d = others[k - 1];
      if (d) { w.setBounds(d.workArea); w.show(); w.maximize(); }
      else { const b = mainWindow.getBounds(); w.setBounds({ x: b.x + 40 * k, y: b.y + 40 * k, width: 960, height: 600 }); w.show(); }
    } catch (e) { logInfo("monitor window: " + (e && e.message)); try { w.show(); } catch {} }
  });
  // Only the app's own page may load. "Any file://" let a file dropped on the window replace the app, every
  // session died and the native keyboard/mouse hooks stayed engaged with no page left to release them.
  const appPage = require("url").pathToFileURL(path.join(__dirname, "renderer", "index.html")).href.toLowerCase();
  const blockNav = (e, url) => { if (String(url).split(/[?#]/)[0].toLowerCase() !== appPage) e.preventDefault(); };
  mainWindow.webContents.on("will-navigate", blockNav);
  mainWindow.webContents.on("will-redirect", blockNav);
  mainWindow.webContents.on("will-attach-webview", (e) => e.preventDefault());
}

// The DXGI coverage gap described at _wgcFlag: Windows reports more displays than the capturer lists.
async function captureCoverageGap() {
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
  return { gap: screen.getAllDisplays().length > sources.length, sources: sources.length };
}

// The screens Windows can capture. Starting a capture asked for this list three times in a row (get-monitors,
// set-dm-source, then the getDisplayMedia handler), ~0.3 s a call on the test PC whatever the thumbnail size (measured
// 14 Nov 2026). Now get-monitors (a session's capture and each retry start there) asks Windows, and set-dm-source and
// the handler reuse that answer for up to 3 s from when it was asked for; a later monitor switch or re-capture starts at
// set-dm-source and asks again once that time is up. The answer is dropped when Windows reports a screen change, when
// the 3 s display-id poll sees one, and on a switch to or from the secure desktop; an empty or failed answer is never
// kept. No thumbnails: nothing here looks at them.
let _screenList = null;   // { at, p }: the answer being shared
let _screenAsk = null;    // { at, p, gen }: the newest request (it ends after every earlier one), null once it has ended
let _screenGen = 0;       // +1 on every screen change
function screenSources(fresh = false) {
  const now = performance.now();
  if (!fresh && _screenList && now - _screenList.at < 3000) return _screenList.p;
  // Electron hands a caller the request still running with the same options. A request from after the last screen
  // change is shared; one from before it would bring the old list back, so the new request waits for it to end.
  let ask = _screenAsk && _screenAsk.gen === _screenGen ? _screenAsk : null;
  if (!ask) {
    const start = () => desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
    const prev = _screenAsk;
    const mine = ask = _screenAsk = { at: now, p: prev ? prev.p.then(start, start) : start(), gen: _screenGen };
    const done = () => { if (_screenAsk === mine) _screenAsk = null; };
    mine.p.then(done, done);
  }
  const entry = { at: ask.at, p: null };
  entry.p = ask.p.then((list) => {
    if (!list.length && _screenList === entry) _screenList = null;
    return list;
  }, (e) => { if (_screenList === entry) _screenList = null; throw e; });
  _screenList = entry;
  return entry.p;
}
function screenSourcesStale() { _screenList = null; _screenGen++; }

app.whenReady().then(async () => {
  if (!_gotLock) { logInfo("second instance, quitting"); return; }   // a primary instance already owns the window
  logInfo("app ready" + (inputReady && inputSim.isElevated() ? " (administrator)" : ""));
  // A verified update waiting from the last run (src/updater.js) is installed before any window: TryDesk closes,
  // the helper installs it and opens TryDesk again with the same arguments (a Windows start stays in the tray).
  if (updater.atStart()) { _quitting = true; app.exit(0); return; }
  // Relaunch ONCE into WGC before any window exists when a monitor is invisible to the default capturer,
  // so the very first session can already stream it. Bounded wait: never delays startup by more than 2s.
  if (!_wgcOn && _wgcFlag && !_rdpSession) {   // in RDP WGC stays off, so relaunching into it would loop
    try {
      const r = await Promise.race([captureCoverageGap(), new Promise((res) => setTimeout(() => res(null), 2000))]);
      if (r && r.gap) {
        fs.writeFileSync(_wgcFlag, "1");
        logInfo(`capture gap: ${screen.getAllDisplays().length} displays but ${r.sources} capture sources, relaunching with WGC`);
        relaunchSelf("wgc"); app.exit(0); return;
      }
    } catch (e) { logInfo("capture coverage check failed: " + e.message); }
  }
  // Windows shows this as the notification's app name; without it toasts read "electron.app.TryDesk".
  try { app.setAppUserModelId(AUMID); } catch {}
  repairStartMenuShortcut();
  // A notification during this run can create the shortcut pointing at the portable's temp copy; fix it before
  // that copy is deleted.
  app.on("will-quit", repairStartMenuShortcut);
  // The page's Content-Security-Policy is the <meta> in index.html (a response-header CSP never applies to the
  // file:// page, so none is set here).
  try {
    const { session } = require("electron");
    // Grant the permissions the app actually uses, crucially pointerLock/keyboardLock so game mode
    // can capture the mouse, and deny everything else. Without this, Electron can refuse pointer lock
    // and the remote mouse won't move inside captured games. (media/display-capture keep screen share working.)
    const ALLOW = new Set(["pointerLock", "keyboardLock", "fullscreen", "media", "mediaKeySystem", "display-capture", "clipboard-read", "clipboard-sanitized-write"]);
    session.defaultSession.setPermissionRequestHandler((_wc, p, cb) => cb(ALLOW.has(p)));
    // getDisplayMedia support: the MODERN screen-capture path. The legacy desktopCapturer mandatory
    // maxFrameRate hard-caps at 120fps (>120 silently falls back to 30), so high-refresh capture
    // (144/165/180/240) must go through getDisplayMedia. This handler feeds it the screen the renderer
    // selected (set-dm-source) with NO system picker, so capture starts silently like before.
    if (session.defaultSession.setDisplayMediaRequestHandler) {
      session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        screenSources().then((sources) => {
          // Never silently substitute the first screen for a REQUESTED one, that streamed the wrong monitor
          // ("stuck on the previous monitor"). set-dm-source already verified the id, normally against this same
          // list: a miss here means a screen change dropped that list in between → deny, and the renderer falls
          // back to the legacy path.
          const src = sources.find((s) => s.id === _dmSourceId) || (_dmSourceId ? null : sources[0]);
          // audio: "loopback" = capture the host's SYSTEM audio (Windows) so remote audio works. Only
          // materializes into a track when the renderer's getDisplayMedia asks for audio (host start does).
          callback(src ? { video: src, audio: "loopback" } : {});
        }).catch(() => { try { callback({}); } catch {} });
      });
    }
  } catch (e) { logInfo("session setup error: " + e.message); }
  if (!_serviceHost) createTray();
  else { try { fs.writeFileSync(_servicePwFile, servicePwFingerprint(servicePasswordHash())); } catch (e) { logInfo("service-pw.txt not written: " + e.message); } }
  setMacMenu(false);
  // macOS: clicking the Dock icon brings back a window that was closed to the menu bar.
  app.on("activate", showMainWindow);
  try { createWindow(); logInfo("window created"); } catch (e) { logCrash("createWindow gagal", e); try { app.exit(1); } catch {} return; }
  // Watchdog: if the renderer never finishes loading, leave a breadcrumb (diagnose.ps1 reads it).
  // The window waits for the page (show: false), so a page that never loads would leave nothing on screen: show it anyway.
  setTimeout(() => {
    if (_windowReady) return;
    logInfo("WARNING: renderer not loaded after 15s");
    if (!_serviceHost && !(_startInTray && tray)) { try { mainWindow.show(); } catch {} }
  }, 15000);
  // On a GPU-process crash, self-heal: remember to disable acceleration and relaunch once, so a bad
  // GPU/driver on a client PC no longer leaves a blank/missing window.
  let _gpuRelaunched = false;
  app.on("child-process-gone", (_e, d) => {
    const info = d && (d.type + " / " + d.reason);
    if (d && d.type === "GPU" && !_forceNoGpu && !_gpuRelaunched && _noGpuFlag) {
      // Auto-recover from a GPU-process crash silently (no scary error dialog): relaunch once without
      // hardware acceleration so the session keeps working.
      logInfo("child-process-gone: " + info + ", auto-recovering (software render)");
      _gpuRelaunched = true;
      try { fs.writeFileSync(_noGpuFlag, "1"); } catch {}
      try { relaunchSelf("gpu"); app.exit(0); } catch {}
    } else {
      logCrash("child-process-gone", info);   // other child crashes stay visible
    }
  });
  // If we're running software-only because a PAST GPU crash set the flag, clear it after a stable start so
  // the NEXT launch retries hardware acceleration (encode load is now much lower: maintain-resolution +
  // a preset-driven fps cap), instead of staying stuck in slow software mode forever.
  if (_flagExists() && !process.argv.includes("--no-gpu") && !process.env.TRYDESK_NO_GPU) {
    setTimeout(() => { if (_windowReady) { try { fs.unlinkSync(_noGpuFlag); logInfo("cleared disable-gpu.flag, next launch retries GPU"); } catch {} } }, 25000);
  }
  // Watch whether a game/app has captured (hidden) the OS cursor; tell the renderer on change so the
  // viewer can auto-switch to relative mouse (no manual "game mode" toggle). Cheap 250ms poll.
  // Hysteresis: games (esp. with our mouse injection fighting them) make the OS cursor flicker
  // hidden/shown every few hundred ms. Report "hidden" instantly, but only report "shown" after the
  // cursor has stayed visible continuously for 1.5s, so game mode STAYS engaged through the blips
  // instead of spamming on/off (which made the captured mouse unusable).
  let _shownSince = 0;
  // Only matters while someone controls this PC, no 4×/s cursor polling (or log lines) when idle or viewing.
  let _hosting = false;
  ipcMain.on("hosting-state", (_e, on) => {
    _hosting = !!on; _trayHosting = _hosting; refreshTray();
    _hostingNow = _hosting;
    if (_serviceHost) svcPublish();
    if (!_hosting && _adminWindow) { _adminWindow = false; try { mainWindow.webContents.send("host-admin-window", false); } catch {} }
  });
  // An admin window in front (Task Manager, admin CMD) blocks a non-elevated host's input and hides its cursor.
  // Tell the renderer on change, so the viewer sees why control stopped instead of a "frozen" session.
  const _selfElevated = inputReady && inputSim.isElevated();
  let _adminWindow = false;
  setInterval(() => {
    if (!inputReady || !mainWindow || !_hosting || _selfElevated) return;
    const on = inputSim.isForegroundElevated();
    if (on !== _adminWindow) {
      _adminWindow = on; logInfo("admin window in front: " + on);
      try { mainWindow.webContents.send("host-admin-window", on); } catch {}
    }
  }, 500);
  ipcMain.on("request-admin-window-state", () => { try { mainWindow.webContents.send("host-admin-window", _adminWindow); } catch {} });
  setInterval(() => {
    if (!inputReady || !mainWindow || !_hosting) return;
    const raw = inputSim.isCursorHidden();
    const now = Date.now();
    let hidden;
    if (raw) { hidden = true; _shownSince = 0; }
    else { if (!_shownSince) _shownSince = now; hidden = (now - _shownSince) < 1500; }
    if (hidden !== _hostCursorHidden) { _hostCursorHidden = hidden; try { mainWindow.webContents.send("host-cursor-hidden", hidden); } catch {} }
  }, 250);
  // When a viewer's control channel opens, the host re-emits the CURRENT cursor state, so a game that was
  // ALREADY running at connect time (no state change to trigger on) still auto-enables the viewer's game mouse.
  ipcMain.on("request-cursor-state", () => { try { mainWindow.webContents.send("host-cursor-hidden", _hostCursorHidden); } catch {} });
  // Let the renderer append to the same log, so the whole game-mode chain is traceable in one file.
  ipcMain.on("log-info", (_e, m) => logInfo("ui: " + String(m).slice(0, 200)));
  // The renderer turns full keyboard capture on while actively controlling a remote PC (and off while
  // typing in a local field or when the session ends). Pick up the window's current focus immediately.
  try { _kbFocused = mainWindow.isFocused(); } catch {}
  ipcMain.on("set-key-capture", (_e, on) => {
    const want = !!on;
    if (want === _kbWantCapture) return;
    _kbWantCapture = want;
    refreshKeyHook();
    setMacMenu(want);
    if (!want) { try { mainWindow.webContents.send("release-keys"); } catch {} }
  });
  // Native game-mouse capture: engaged automatically when a game is detected on the remote (no click/gesture).
  let _mouseFirstMove = false;
  ipcMain.on("set-mouse-capture", (_e, on) => {
    const want = !!on;
    if (want === _mouseWant) return;
    _mouseWant = want;
    let ok = true;
    if (!inputSim.startMouseHook) { ok = false; }
    else if (want) {
      recenterMouse(true);
      _mouseFirstMove = false;
      ok = inputSim.startMouseHook((evt) => {
        if (!_mouseFirstMove) { _mouseFirstMove = true; logInfo("mouse-capture: first event forwarded (" + evt.t + ")"); }
        try { mainWindow && mainWindow.webContents.send("captured-mouse", evt); } catch {}
      }, () => _mouseWant && _kbFocused);
    } else inputSim.stopMouseHook();
    logInfo("mouse-capture want=" + want + " hookOk=" + ok + " focused=" + _kbFocused);
    try { mainWindow.webContents.send("mouse-capture-result", { want, ok }); } catch {}
  });
  // When the host's own display resolution/scale changes, tell the renderer to re-capture cleanly
  // (prevents the decoder-garbage flicker and keeps remote input mapping aligned to the new size).
  let displayChangeTimer = null, displayForce = false;
  const sendDisplayChanged = (force) => {
    displayForce = displayForce || force;
    // Coalesce bursts (games/sandboxes fire these rapidly), the renderer also no-ops when the captured
    // size is unchanged, so this only ever reaches a real resolution change (or a display that was replaced).
    clearTimeout(displayChangeTimer);
    displayChangeTimer = setTimeout(() => { const f = displayForce; displayForce = false; try { mainWindow && mainWindow.webContents.send("display-changed", f); } catch {} }, 600);
  };
  screen.on("display-metrics-changed", (_e, _display, changed) => {
    if (!changed.some((c) => c === "bounds" || c === "scaleFactor" || c === "rotation")) return;
    sendDisplayChanged(false);
  });
  // A display that is replaced keeps the old capture pointing at nothing: black picture. In a Remote Desktop
  // session that happens on every reconnect / move to the console, often at the SAME size, so the size check
  // above never fires (rented RDP PC, 2026-11-02). New or removed displays force a fresh capture, and a slow
  // poll of the display ids catches the changes Windows doesn't report as events.
  screen.on("display-added", () => sendDisplayChanged(true));
  screen.on("display-removed", () => sendDisplayChanged(true));
  // When the screen layout last changed, for wake-display (a woken monitor is taken away and added again). Any change
  // also drops the shared list of screens (screenSources).
  for (const ev of ["display-added", "display-removed", "display-metrics-changed"]) screen.on(ev, () => { _screenEvAt = Date.now(); screenSourcesStale(); });
  let displayIds = screen.getAllDisplays().map((d) => d.id).join(",");
  setInterval(() => {
    const ids = screen.getAllDisplays().map((d) => d.id).join(",");
    if (ids !== displayIds) { displayIds = ids; logInfo("displays replaced: " + ids); screenSourcesStale(); sendDisplayChanged(true); }
  }, 3000);
  // Persistent panic key: release any host black-screen/input-lock if a session leaves them stuck.
  // (BlockInput swallows physical keys, so while input is locked only Ctrl+Alt+Del breaks it, Windows' rule.)
  // Tell the renderer so the host UI and the viewer's toggles show the truth afterwards.
  // A hotkey belongs to whichever process registers it first. With the Windows service, the service's host and the
  // user's own app both run on this desktop; only the service's host darkens the screen then, so the app yields
  // the key (panic-key-yield) and the service keeps retrying until it holds it.
  ensurePanicKey();
  if (_serviceHost) setInterval(ensurePanicKey, 5000);
  // Discord Rich Presence, "Using TryDesk" on the user's profile (best-effort, silent if unavailable).
  if (!_serviceHost) { try { discordRPC.init(logInfo); } catch (e) { logInfo("discord RPC init skipped: " + e.message); } }
  // The renderer reports session state ("idle" | "hosting" | "viewing") so the presence reflects what's happening.
  ipcMain.on("discord-activity", (_e, state) => { _activity = String(state || "idle"); try { discordRPC.setActivity(_activity); } catch {} });
  ipcMain.on("set-ui-language", (_e, l) => { _uiLang = UI_LANGS.has(l) ? l : "id"; try { discordRPC.setLanguage(_uiLang, L); } catch {} refreshTray(); setMacMenu(_kbWantCapture); });
});
app.on("window-all-closed", () => { try { if (!_sessionEnding) updater.onUserQuit(); } catch {} app.quit(); });
app.on("before-quit", () => { _quitting = true; try { tray && tray.destroy(); } catch {} tray = null; });
app.on("before-quit", () => { try { disableBlackScreen(); } catch {} try { disableInputLock(); } catch {} try { inputSim.stopKeyHook && inputSim.stopKeyHook(); } catch {} try { inputSim.stopMouseHook && inputSim.stopMouseHook(); } catch {} try { discordRPC.shutdown(); } catch {} });

// platform: the page turns Windows-only parts off elsewhere (Linux and macOS are viewer-only builds).
// osRelease: the device's OS, sent along when the app signs in to the server. Windows 10 and 11 share one User-Agent, so
// the build number ("10.0.22631") is the only way to tell them apart; on Linux the distro name is more useful, and on
// a Mac the macOS version ("macOS 26.1"), since os.release() there is the Darwin kernel number.
function osRelease() {
  if (process.platform === "linux") {
    try { const m = fs.readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME="?([^"\n]+)"?/m); if (m) return m[1].slice(0, 60); } catch {}
  }
  if (process.platform === "darwin") { try { return `macOS ${process.getSystemVersion()}`; } catch {} }
  return os.release();
}
ipcMain.handle("get-config", () => ({ ...config, appVersion: app.getVersion(), platform: process.platform, osRelease: osRelease(), rdpSession: _rdpSession, vmGuest: _vmGuest || "", serviceHost: _serviceHost, servicePwHash: _serviceHost ? servicePasswordHash() : "",
  relaunched: _serviceHost ? "" : _relaunchedFor, portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
  testNoChromiumCapture: !app.isPackaged && process.env.TRYDESK_TEST_NO_CHROMIUM_CAPTURE === "1" }));

// Update check: https://trydesk.ai.id/update/version.json says the newest version and the oldest one still considered
// safe ({ latest, minimum, url, notes: { id, en } }). Fetched here (not in the page) so the page's CSP stays as tight
// as it is. Only well-formed fields go back; anything else,offline, a bad answer,is null and blocks nothing.
// TRYDESK_UPDATE_URL lets a local test point the check at http://127.0.0.1 (nothing else is accepted).
const UPDATE_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d+\/[\w./-]*$/.test(process.env.TRYDESK_UPDATE_URL || "") ? process.env.TRYDESK_UPDATE_URL : "https://trydesk.ai.id/update/version.json";
// In-app updates (src/updater.js): downloads come from /downloads/ on the same site as version.json.
const updater = require("./updater").create({
  app, net: require("electron").net, serviceHost: _serviceHost, updateUrl: new URL("/downloads/", UPDATE_URL).href,
  log: (m) => logInfo(m), verifySig: (msg, sig) => edSigned(msg, sig),
  send: (s) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("update-state", s); },
  busy: () => serviceSessionBusy(),
});
// A session (or a request) the Windows service runs for this user: read from the file the service writes for this
// user's TryDesk (service-ui.json, see "svc-ui" below), so it works before any window exists too. A file left by a
// service that is gone means nothing. (Windows review 18 Nov, finding 1: such a session must not be cut by an update.)
function serviceSessionBusy() {
  if (process.platform !== "win32" || _serviceHost) return false;
  let ui = null;
  try { ui = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "service-ui.json"), "utf8")); } catch { return false; }
  if (!ui || !Number.isInteger(ui.pid) || !(ui.state === "session" || ui.state === "request")) return false;
  try { process.kill(ui.pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
// Windows is logging off or shutting down: no install starts then, it could be cut off halfway (review finding 6).
// The verified file stays and installs at the next start.
let _sessionEnding = false;
app.on("browser-window-created", (_e, w) => { w.on("query-session-end", () => { _sessionEnding = true; }); w.on("session-end", () => { _sessionEnding = true; }); });
ipcMain.handle("check-update", async () => {
  try {
    const { net } = require("electron");
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
    const r = await net.fetch(UPDATE_URL, { signal: ctl.signal, cache: "no-store" }).finally(() => clearTimeout(tm));
    if (!r.ok) return null;
    const j = JSON.parse((await r.text()).slice(0, 32768));
    const ver = (v) => (typeof v === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v) ? v : null);
    const str = (v) => (typeof v === "string" ? v : "");
    const url = typeof j.url === "string" && /^https:\/\/(www\.)?trydesk\.ai\.id\//.test(j.url) ? j.url : "https://trydesk.ai.id/downloads/";
    if (!ver(j.latest)) return null;
    // The signature covers the notes as written. Apps up to 1.4.0 cut them to 300 characters first and so rejected
    // any file with longer notes (18 Nov 2026); here the check comes first and only the shown text is shortened.
    const signed = { latest: ver(j.latest), minimum: ver(j.minimum), url, notes: { id: str(j.notes && j.notes.id), en: str(j.notes && j.notes.en) } };
    // The file is signed (scripts/sign-version.mjs, key kept off the website) and checked here: whoever gets into the
    // web hosting can change the page, but can't make every TryDesk refuse to connect ("minimum") or point it at
    // another download. Unsigned or badly signed = no update news at all, never a forced update.
    if (!versionJsonSigned(signed, j.sig)) { logInfo("update check: version.json signature missing or invalid, ignored"); return null; }
    const out = { ...signed, notes: { id: signed.notes.id.slice(0, 600), en: signed.notes.en.slice(0, 600) } };
    const num = (v) => v.split(".").map(Number).reduce((a, b) => a * 1000 + b, 0);
    if (out.minimum && num(out.minimum) > num(out.latest)) out.minimum = null;   // never require what is not released
    // This PC's own download, when the signed download list has one (null: the page keeps the website link).
    out.pkg = updater.setOffer(out.latest, j.files, j.filesSig);
    return out;
  } catch { return null; }
});
ipcMain.handle("update-state", () => updater.state());
ipcMain.on("update-download", () => { updater.download(); });
ipcMain.on("update-pause", () => updater.pause());
ipcMain.on("update-auto", (_e, on) => updater.setAuto(!!on));
ipcMain.on("update-ack-done", () => updater.ackDone());
ipcMain.on("update-retry", () => updater.retry());
// "Pasang sekarang": the page has already asked about live sessions. TryDesk closes and the helper takes over.
ipcMain.handle("update-install", (_e, confirmed) => {
  if (!updater.install(true, confirmed === true)) return false;
  _quitting = true;
  setTimeout(() => { try { app.quit(); } catch { app.exit(0); } }, 600);   // the page shows "Memasang" first
  return true;
});
const VERSION_JSON_PUBKEY = "MCowBQYDK2VwAyEALmgxboidf3mbPwbQKUYPidxLPlSdMvgjQle1fXxJu6E=";   // Ed25519, SPKI
// The signed bytes: the five fields in a fixed order (scripts/sign-version.mjs builds the same string).
function versionJsonCanonical(v) { return JSON.stringify({ latest: v.latest, minimum: v.minimum || "", url: v.url, notes: { id: v.notes.id, en: v.notes.en } }); }
function versionJsonSigned(v, sig) { return edSigned(versionJsonCanonical(v), sig); }
// Ed25519 check against the owner's version key (version.json, and the download list in src/updater.js).
// A local update test (TRYDESK_UPDATE_URL on 127.0.0.1/localhost only) may bring its own throwaway key, so tests
// never need files signed with the real key. Only a dev run or a test build (built with
// -c.extraMetadata.tdUpdateTestBuild=true) takes it: an installed release never does, or a program in the same
// Windows account could serve a fake "signed" update (Windows review 18 Nov, finding 4).
const _updTestBuild = (() => { try { return require("../package.json").tdUpdateTestBuild === true; } catch { return false; } })();
const _testPubKey = (!app.isPackaged || _updTestBuild) && UPDATE_URL.startsWith("http://") && /^[A-Za-z0-9+/=]{40,80}$/.test(process.env.TRYDESK_TEST_PUBKEY || "") ? process.env.TRYDESK_TEST_PUBKEY : "";
function edSigned(msg, sig) {
  try {
    if (typeof sig !== "string" || !/^[A-Za-z0-9+/=]{80,100}$/.test(sig)) return false;
    const crypto = require("crypto");
    const key = crypto.createPublicKey({ key: Buffer.from(_testPubKey || VERSION_JSON_PUBKEY, "base64"), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(String(msg), "utf8"), key, Buffer.from(sig, "base64"));
  } catch { return false; }
}

// ─── LAN direct connection ───────────────────────────────
// "Sambung lewat IP": two PCs on the same network can start a session with no internet and no signaling server.
// The signaling messages travel as one JSON object per line over a plain TCP socket; the session itself is the same
// WebRTC peer connection as always. This file only moves lines: the page decides what a line means (see app.js
// "LAN direct connection"). Off by default; the host only listens while Settings → Koneksi turns it on, only
// accepts private/local addresses, and the page refuses any LAN request unless an access password is set.
const net = require("net");
const LAN_PORT = 7171;
const LAN_MAX_LINE = 64 * 1024, LAN_MAX_IN = 6, LAN_MAX_PER_IP = 2, LAN_MAX_MSG_PER_SEC = 100;
let lanServer = null, lanSeq = 0;
const lanConns = new Map();   // "lan-in:<ip>#n" (someone asking this PC) / "lan:<address>" (this PC asking) -> socket
const lanIp = (a) => String(a || "").replace(/^::ffff:/i, "");
// 10/8, 172.16/12, 192.168/16, loopback, link-local, 100.64/10 (CGNAT, Tailscale/ZeroTier style VPNs), IPv6 ULA/link-local.
const CGNAT_RE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
// 100.64/10 counts as "local" only when this PC itself has such an address (a Tailscale/ZeroTier style VPN). On a
// mobile/ISP connection that range is the carrier's shared network, where other subscribers are not neighbours.
let _cgnatLocal = null;
function cgnatLocal() {
  if (_cgnatLocal === null || Date.now() - _cgnatLocal.at > 60000) {
    let has = false;
    try { for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && CGNAT_RE.test(a.address)) has = true; } catch {}
    _cgnatLocal = { has, at: Date.now() };
  }
  return _cgnatLocal.has;
}
function lanPrivate(ip) {
  ip = lanIp(ip);
  if (CGNAT_RE.test(ip)) return cgnatLocal();
  return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || /^(::1$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(ip);
}
function lanAddrs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && !a.internal && lanPrivate(a.address)) out.push(a.address);
  return out;
}
function lanEmit(ev) { try { mainWindow && mainWindow.webContents.send("lan-event", ev); } catch {} }
// Line framing + limits for one socket, either direction.
function lanWire(id, sock) {
  const incoming = id.startsWith("lan-in:");
  lanConns.set(id, sock);
  sock.setEncoding("utf8");
  sock.setNoDelay(true);
  sock.setKeepAlive(true, 15000);   // a PC that vanished (cable, sleep) is noticed instead of lingering for good
  let buf = "", rlStart = 0, rlCount = 0;
  sock.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const now = Date.now();
      if (now - rlStart > 1000) { rlStart = now; rlCount = 0; }
      if (++rlCount > LAN_MAX_MSG_PER_SEC || line.length > LAN_MAX_LINE) continue;
      let msg; try { msg = JSON.parse(line); } catch { msg = null; }
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") { if (incoming && !sock._tdAsked) { sock.destroy(); return; } continue; }
      // Someone asking this PC must start with a connect-request; a scanner or junk sender is dropped right away.
      if (incoming && !sock._tdAsked) { if (msg.type !== "connect-request") { sock.destroy(); return; } sock._tdAsked = true; }
      lanEmit({ id, kind: "line", msg });
    }
    if (buf.length > LAN_MAX_LINE) sock.destroy();   // a line that never ends
  });
  sock.on("error", () => {});
  sock.on("close", () => { if (lanConns.get(id) === sock) { lanConns.delete(id); lanEmit({ id, kind: "close" }); } });
}
function lanWrite(id, msg) {
  const s = lanConns.get(id);
  if (!s || s.destroyed) return false;
  try { s.write(JSON.stringify(msg) + "\n"); return true; } catch { return false; }
}
// Calls are serialised: a quick on/off/on ends in the state of the last call, never with two listeners or with a
// listener that an "off" sent mid-start missed.
let lanHostChain = Promise.resolve();
ipcMain.handle("lan-host", (_e, opts) => (lanHostChain = lanHostChain.then(() => lanHostSet(opts), () => lanHostSet(opts))));
// The page marks a socket that became a real session; until then it lives at most 90 s (enough for the password rounds).
ipcMain.on("lan-keep", (_e, id) => { const s = lanConns.get(String(id)); if (s) s._tdKept = true; });
const lanHostSet = (opts) => new Promise((resolve) => {
  const on = !!(opts && opts.on);
  const hello = { type: "lan-hello", v: 1, machine: String((opts && opts.machine) || "").slice(0, 64) };
  if (!on) {
    // Stop listening and drop every request still in progress; a session already set up keeps its socket (a codec
    // change still needs it).
    if (lanServer) { try { lanServer.close(); } catch {} lanServer = null; }
    for (const [k, s] of lanConns) if (k.startsWith("lan-in:") && !s._tdKept) { try { s.destroy(); } catch {} }
    return resolve({ ok: true, on: false });
  }
  if (lanServer) { lanServer._hello = hello; return resolve({ ok: true, on: true, port: LAN_PORT, addrs: lanAddrs() }); }
  const srv = net.createServer((sock) => {
    const ip = lanIp(sock.remoteAddress);
    const ins = [...lanConns.keys()].filter((k) => k.startsWith("lan-in:"));
    if (!lanPrivate(ip) || ins.length >= LAN_MAX_IN || ins.filter((k) => k.startsWith(`lan-in:${ip}#`)).length >= LAN_MAX_PER_IP) {
      logInfo(`lan: refused ${ip}`); sock.destroy(); return;
    }
    const id = `lan-in:${ip}#${++lanSeq}`;
    lanWire(id, sock);
    lanWrite(id, srv._hello);
    // No connect-request within 15 s (a port scanner, a half-open attempt), or no accepted session within 90 s: dropped.
    setTimeout(() => { if (!sock._tdAsked && !sock.destroyed) sock.destroy(); }, 15000);
    setTimeout(() => { if (!sock._tdKept && !sock.destroyed) sock.destroy(); }, 90000);
    logInfo(`lan: connection from ${ip}`);
  });
  srv._hello = hello;
  // "::" takes IPv4 and IPv6 on a dual-stack PC; a PC without IPv6 falls back to IPv4 only.
  let host = "::";
  srv.on("error", (err) => {
    if (host === "::" && (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL")) { host = "0.0.0.0"; listen(); return; }
    if (lanServer === srv) lanServer = null;
    logInfo("lan: listen failed: " + err.code);
    resolve({ ok: false, error: err.code === "EADDRINUSE" ? `Port ${LAN_PORT} sudah dipakai program lain` : "Tidak bisa membuka port LAN (" + (err.code || err.message) + ")" });
  });
  const listen = () => srv.listen({ port: LAN_PORT, host, exclusive: true }, () => {
    lanServer = srv;
    logInfo(`lan: listening on ${host}:${LAN_PORT}`);
    resolve({ ok: true, on: true, port: LAN_PORT, addrs: lanAddrs() });
  });
  listen();
});
// This PC asks another one. address = "192.168.1.20", "192.168.1.20:7171", "[fe80::1]:7171" or a LAN host name.
ipcMain.handle("lan-open", (_e, address) => new Promise((resolve) => {
  const a = String(address || "").trim().slice(0, 255);
  const m = a.match(/^\[([0-9a-f:.%a-z]+)\](?::(\d{1,5}))?$/i) || a.match(/^([^:\s]+)(?::(\d{1,5}))?$/) || a.match(/^([0-9a-f:]+)$/i);
  if (!m) return resolve({ ok: false, error: "Alamat IP tidak valid" });
  const host = m[1], port = Number(m[2]) || LAN_PORT;
  if (port < 1 || port > 65535) return resolve({ ok: false, error: "Port tidak valid" });
  const id = "lan:" + a;
  const old = lanConns.get(id); if (old) { lanConns.delete(id); try { old.destroy(); } catch {} }
  const sock = net.connect({ host, port });
  let done = false;
  const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
  const timer = setTimeout(() => { sock.destroy(); finish({ ok: false, error: "Tidak ada TryDesk yang menjawab di alamat ini" }); }, 6000);
  sock.once("connect", () => {
    // Host names are resolved by the OS: whatever they resolve to must still be a local address.
    if (!lanPrivate(sock.remoteAddress)) { sock.destroy(); return finish({ ok: false, error: "Hanya alamat jaringan lokal (LAN) yang bisa dipakai" }); }
    lanWire(id, sock);
    finish({ ok: true, id });
  });
  sock.once("error", (err) => finish({ ok: false, error: err.code === "ECONNREFUSED" ? "PC tujuan tidak menerima koneksi LAN (belum diaktifkan di Pengaturan, atau diblokir firewall)" : err.code === "ENOTFOUND" ? "Nama PC tidak ditemukan di jaringan" : "Tidak bisa terhubung ke alamat ini" }));
}));
ipcMain.on("lan-write", (_e, id, msg) => { if (msg && typeof msg === "object") lanWrite(String(id), msg); });
ipcMain.on("lan-close", (_e, id) => { const s = lanConns.get(String(id)); if (s) { try { s.end(); } catch {} setTimeout(() => { try { s.destroy(); } catch {} }, 1000); } });
// Elevation: report whether the host runs as admin (can control admin windows), and relaunch elevated.
ipcMain.handle("is-elevated", () => {
  // Development builds only: act as "run as administrator" so the admin host path (helper picture + helper sound) can be
  // tested without a UAC prompt.
  if (!app.isPackaged && process.env.TRYDESK_TEST_ADMIN === "1") return true;
  try { return inputSim.isElevated ? inputSim.isElevated() : false; } catch { return false; }
});
// Start-Process -Verb RunAs shows the UAC prompt. Quit ONLY once the elevated copy really started (exit code 0):
// declining UAC used to close TryDesk with nothing reopening. The new copy waits for this PID before locking.
// The quit waits a moment so the page can end its sessions properly first (peers told, server pairing dropped)
// and the user can read that the new window takes a few seconds (the portable build unpacks itself first).
ipcMain.handle("relaunch-as-admin", () => new Promise((resolve) => {
  try {
    // The exe path goes in through the environment, never into the command text: PowerShell also treats the
    // curly quotes ‘ ’ ‚ ‛ as string delimiters, so a folder like "Bob’s" broke (or could inject into) a quoted path.
    const ps = require("child_process").spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command",
      `try { Start-Process -FilePath $env:TD_SELF_EXE -ArgumentList '--wait-for-pid=${process.pid}' -Verb RunAs -ErrorAction Stop; exit 0 } catch { exit 1 }`],
      { stdio: "ignore", windowsHide: true, env: { ...process.env, TD_SELF_EXE: _selfExe } });
    ps.on("exit", (code) => {
      if (code === 0) { logInfo("relaunch-as-admin: elevated copy started, quitting this one"); resolve(true); setTimeout(() => { _quitting = true; try { app.quit(); } catch {} }, 2500); }
      else { logInfo("relaunch-as-admin: UAC declined or failed (code " + code + ")"); resolve(false); }
    });
    ps.on("error", (e) => { logInfo("relaunch-as-admin failed: " + e.message); resolve(false); });
  } catch (e) { logInfo("relaunch-as-admin failed: " + e.message); resolve(false); }
}));

// ─── Windows service (unattended access): src/native/trydesk-service.exe ───
// Install/uninstall run the helper elevated (one UAC prompt). Install copies this TryDesk folder to Program Files
// (the service runs only that copy) and stores the access password hash where only administrators can write.
const _serviceExe = path.join(__dirname, "native", "trydesk-service.exe").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const _serviceIdFile = path.join(_serviceDir, "service-id.txt");
// Which access password the service's host is really using, for the app's Security page (user report 12 Nov: after
// changing the password nobody could tell whether the service had it; Setup installs the service without one). Only
// a fingerprint of the salted hash goes in this user-readable file: it tells "same as mine?" and nothing else.
const _servicePwFile = path.join(_serviceDir, "service-pw.txt");
const servicePwFingerprint = (hash) => hash ? require("crypto").createHash("sha256").update("trydesk-service-pw:" + hash).digest("hex").slice(0, 16) : "none";
// mode: install (app, optional hash) | uninstall | set-password (hash, or "none" to remove it).
function runServiceElevated(mode, args = {}) {
  return new Promise((resolve) => {
    // Paths and the hash go in through the environment, never into the command text (see relaunch-as-admin).
    const ps = require("child_process").spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command",
      "try { $a = switch ($env:TD_SVC_MODE) { 'install' { 'install \"' + $env:TD_SVC_APP + '\" ' + $env:TD_SVC_HASH } 'set-password' { 'set-password ' + $env:TD_SVC_HASH } default { 'uninstall' } }; " +
      "$p = Start-Process -FilePath $env:TD_SVC_EXE -ArgumentList $a.Trim() -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop; exit $p.ExitCode } catch { exit 1223 }"],
      { stdio: "ignore", windowsHide: true, env: { ...process.env, TD_SVC_EXE: _serviceExe, TD_SVC_MODE: mode, TD_SVC_APP: args.app || "", TD_SVC_HASH: args.hash || "" } });
    ps.on("exit", (code) => resolve(code));
    ps.on("error", () => resolve(1));
  });
}
const PW_HASH_RE = /^[0-9a-f]{32}:[0-9a-f]{64}$/;
ipcMain.handle("service-status", () => new Promise((resolve) => {
  if (process.platform !== "win32" || _serviceHost) return resolve({ supported: false });
  let id = ""; try { id = fs.readFileSync(_serviceIdFile, "utf8").trim().replace(/\D/g, "").slice(0, 12); } catch {}
  let pwFp = ""; try { pwFp = fs.readFileSync(_servicePwFile, "utf8").trim(); if (!/^([0-9a-f]{16}|none)$/.test(pwFp)) pwFp = ""; } catch {}
  // Dev builds only (tests): a dev service host with a fake %ProgramData% counts as the running service.
  if (!app.isPackaged && process.env.TRYDESK_TEST_SVC_RUNNING === "1") return resolve({ supported: true, installed: true, state: "RUNNING", id, pwFp });
  // Dev builds only (tests): a fake service read from a file the test changes as it goes ({ installed, state, id }).
  if (!app.isPackaged && process.env.TRYDESK_TEST_SVC_FILE) {
    let t = {}; try { t = JSON.parse(fs.readFileSync(process.env.TRYDESK_TEST_SVC_FILE, "utf8")); } catch {}
    return resolve({ supported: true, installed: !!t.installed, state: String(t.state || ""), id: String(t.id || "").replace(/\D/g, "").slice(0, 12), pwFp: "" });
  }
  require("child_process").execFile("sc.exe", ["query", "TryDeskService"], { windowsHide: true }, (err, out) => {
    const m = /STATE\s*:\s*\d+\s+(\w+)/.exec(String(out || ""));
    resolve({ supported: app.isPackaged && fs.existsSync(_serviceExe), installed: !!m, state: m ? m[1] : "", id, pwFp });
  });
}));
// The app compares its own saved hash the same way (the hash never leaves the renderer's storage otherwise).
ipcMain.handle("service-pw-fingerprint", (_e, hash) => {
  hash = String(hash || "");
  return hash && !PW_HASH_RE.test(hash) ? "" : servicePwFingerprint(hash);
});
ipcMain.handle("service-install", async (_e, hash) => {
  // Dev builds only (tests, "Minta akses admin"): "installs" by marking the fake service file installed (stopped, so
  // the app keeps its own ID); TRYDESK_TEST_SVC_INSTALL_CODE plays a failure (1223 = UAC declined).
  if (!app.isPackaged && process.env.TRYDESK_TEST_SVC_FILE) {
    const code = Number(process.env.TRYDESK_TEST_SVC_INSTALL_CODE || 0);
    if (code === 0) { try { fs.writeFileSync(process.env.TRYDESK_TEST_SVC_FILE, JSON.stringify({ installed: true, state: "STOPPED" })); } catch {} }
    return { ok: code === 0, code };
  }
  if (process.platform !== "win32" || _serviceHost || !app.isPackaged || !fs.existsSync(_serviceExe)) return { ok: false, code: -1 };
  hash = String(hash || "");   // optional: without one, requests get the Accept dialog
  if (hash && !PW_HASH_RE.test(hash)) return { ok: false, code: -2 };
  const code = await runServiceElevated("install", { app: process.execPath, hash });
  logInfo("service install exit " + code);
  return { ok: code === 0, code };
});
ipcMain.handle("service-uninstall", async () => {
  if (process.platform !== "win32" || _serviceHost || !fs.existsSync(_serviceExe)) return { ok: false, code: -1 };
  const code = await runServiceElevated("uninstall");
  logInfo("service uninstall exit " + code);
  return { ok: code === 0, code };
});
// The access password, set or cleared in the app, goes to the service too (admin-only file: one UAC prompt).
ipcMain.handle("service-set-password", async (_e, hash) => {
  if (process.platform !== "win32" || _serviceHost || !fs.existsSync(_serviceExe)) return { ok: false, code: -1 };
  hash = String(hash || "");
  if (hash && !PW_HASH_RE.test(hash)) return { ok: false, code: -2 };
  const code = await runServiceElevated("set-password", { hash: hash || "none" });
  logInfo("service set-password exit " + code);
  return { ok: code === 0, code };
});
// One ID, as with AnyDesk: the app writes the ID it has been using, and the service's host takes it over the first
// time it starts (the app then signs in with a second ID of its own, used only to control other PCs).
const _identityFile = path.join(app.getPath("userData"), "identity.json");
const ID_RE = /^\d{3} \d{3} \d{3}$/, TOKEN_RE = /^[0-9a-f]{16,128}$/i;
const readIdentityFile = () => { try { const j = JSON.parse(fs.readFileSync(_identityFile, "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; } };
ipcMain.on("export-identity", (_e, v) => {
  if (_serviceHost || !v || !ID_RE.test(v.id) || !TOKEN_RE.test(v.token)) return;
  const lang = readIdentityFile().lang;
  try { fs.writeFileSync(_identityFile, JSON.stringify({ id: v.id, token: v.token, ...(lang ? { lang } : {}) })); } catch {}
});
// The language the user picked, kept in the same file: the service's window reads it (service-user-lang).
ipcMain.on("export-ui-lang", (_e, l) => {
  if (_serviceHost || !UI_LANGS.has(l)) return;
  const j = readIdentityFile(); if (j.lang === l) return;
  try { fs.writeFileSync(_identityFile, JSON.stringify({ ...j, lang: l })); } catch {}
});
// The service's host reads it from the profile of the user in its session (passed by the service: --user-profile=).
// (read as that user, from the folder of whoever is signed in now: svcUserJson)
ipcMain.handle("service-user-identity", () => {
  if (!_serviceHost) return null;
  const j = svcUserJson("identity.json");
  return j && ID_RE.test(j.id) && TOKEN_RE.test(j.token) ? { id: j.id, token: j.token } : null;
});
// The language of the user in this session (see export-ui-lang); SYSTEM itself has none, so its window was English.
ipcMain.handle("service-user-lang", () => {
  if (!_serviceHost) return null;
  const j = svcUserJson("identity.json"), l = j && j.lang;
  return UI_LANGS.has(l) ? l : null;
});
// A disconnected session (RDP window closed / disconnected) has no screen at all: Windows draws nothing, so there is
// nothing to capture. The service's host (SYSTEM) moves its own session to the console, as `tscon <id> /dest:console`
// does: the desktop is drawn again and stays unlocked. Only for a connection that already passed the password, and
// never when someone else is logged on at the console (that would throw them off).
ipcMain.handle("service-attach-console", () => {
  if (!_serviceHost) return { ok: false, why: "not the service host" };
  try {
    const koffi = require("koffi"), k32 = koffi.load("kernel32.dll"), wts = koffi.load("wtsapi32.dll");
    const consoleId = k32.func("uint32 __stdcall WTSGetActiveConsoleSessionId()")();
    const pidToSid = k32.func("int __stdcall ProcessIdToSessionId(uint32 pid, _Out_ uint32 *sid)");
    const query = wts.func("int __stdcall WTSQuerySessionInformationW(void *h, uint32 sid, int cls, _Out_ void **buf, _Out_ uint32 *bytes)");
    const free = wts.func("void __stdcall WTSFreeMemory(void *p)");
    const info = (sid, cls, type) => { const b = [null], n = [0]; if (!query(null, sid, cls, b, n) || !b[0]) return null; try { return type === "str" ? koffi.decode(b[0], "char16_t", -1) : koffi.decode(b[0], "int32"); } finally { free(b[0]); } };
    const own = [0]; if (!pidToSid(process.pid, own)) return { ok: false, why: "session unknown" };
    if (consoleId === 0xFFFFFFFF) return { ok: false, why: "no console session" };
    if (own[0] === consoleId) return { ok: false, why: "already on the console" };
    if (info(own[0], 8, "int") !== 4) return { ok: false, why: "session not disconnected" };     // 8 = WTSConnectState, 4 = WTSDisconnected
    if (info(consoleId, 5, "str")) return { ok: false, why: "another user is on the console" };   // 5 = WTSUserName
    const ok = wts.func("int __stdcall WTSConnectSessionW(uint32 logonId, uint32 targetId, const char16_t *pwd, int wait)")(own[0], consoleId, "", 0);
    const err = ok ? 0 : k32.func("uint32 __stdcall GetLastError()")();
    logInfo(`service host: session ${own[0]} -> console ${consoleId}: ${ok ? "moved" : "failed " + err}`);
    return { ok: !!ok, why: ok ? "" : "WTSConnectSession failed " + err };
  } catch (e) { return { ok: false, why: e.message }; }
});
// The service's host reports its TryDesk ID so the normal app can show it (the folder is admin-only; SYSTEM writes).
ipcMain.on("service-id", (_e, id) => {
  if (!_serviceHost) return;
  try { fs.writeFileSync(_serviceIdFile, String(id || "").replace(/\D/g, "").slice(0, 12)); } catch {}
});
// "Generate new ID" while the service runs (owner's video 8 Nov: the button said "new ID" and showed the same number,
// Home kept the service's ID). The PC's ID belongs to the service, so a new one is an administrator's step like the
// service password: one UAC prompt drops a request file in %ProgramData%\TryDesk (SYSTEM/Administrators write only),
// and the service's host, which watches it, signs in fresh.
const _regenReqFile = path.join(_serviceDir, "regen-id.req");
ipcMain.handle("service-regen-id", (e) => new Promise((resolve) => {
  if (process.platform !== "win32" || _serviceHost || !fromMain(e)) return resolve({ ok: false, code: -1 });
  // Fixed text, no input from anywhere: the elevated PowerShell finds the folder from its own %ProgramData%.
  const inner = Buffer.from("Set-Content -LiteralPath (Join-Path $env:ProgramData 'TryDesk\\regen-id.req') -Value 1 -ErrorAction Stop", "utf16le").toString("base64");
  const ps = require("child_process").spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command",
    "try { $p = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-WindowStyle','Hidden','-EncodedCommand',$env:TD_INNER -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop; exit $p.ExitCode } catch { exit 1223 }"],
    { stdio: "ignore", windowsHide: true, env: { ...process.env, TD_INNER: inner } });
  ps.on("exit", (code) => { logInfo("service regen-id request exit " + code); resolve({ ok: code === 0, code }); });
  ps.on("error", () => resolve({ ok: false, code: 1 }));
}));
// The request file is removed only once the page confirms it acted on it (a page still loading would miss the message),
// and a file older than 2 minutes is dropped unread: the app that asked has given up by then, and an old request must
// not end a session hours later when the host starts again (review 10 Nov).
let _regenSentAt = 0;
const _dropRegenReq = () => { try { fs.unlinkSync(_regenReqFile); } catch {} };
if (_serviceHost) app.whenReady().then(() => setInterval(() => {
  let st = null; try { st = fs.statSync(_regenReqFile); } catch { return; }
  if (Date.now() - st.mtimeMs > 120000) { _dropRegenReq(); logInfo("service host: stale new-ID request ignored"); return; }
  if (Date.now() - _regenSentAt < 5000) return;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return;
  _regenSentAt = Date.now();
  logInfo("service host: new ID requested by an administrator");
  try { mainWindow.webContents.send("svc-regen-id"); } catch {}
}, 1000));
ipcMain.on("svc-regen-ack", (e) => { if (_serviceHost && fromMain(e)) { _dropRegenReq(); _regenSentAt = 0; } });
// The app's own identity back from identity.json when its storage lost it: localStorage reaches the disk a few
// seconds late, so a TryDesk closed hard right after its first sign-in (an update's installer, a crash, power off)
// came back with a new ID (Threads report T21, proven 9 Nov). identity.json is written at once.
ipcMain.handle("read-identity", (e) => {
  if (_serviceHost || !fromMain(e)) return null;
  const j = readIdentityFile();
  return ID_RE.test(j.id) && TOKEN_RE.test(j.token) ? { id: j.id, token: j.token } : null;
});
// After the service got a new ID the old one is retired: nothing may bring it back (keeps the language).
ipcMain.on("forget-identity", (e) => {
  if (_serviceHost || !fromMain(e)) return;
  const lang = readIdentityFile().lang;
  try { fs.writeFileSync(_identityFile, JSON.stringify(lang ? { lang } : {})); } catch {}
});

// One TryDesk window during a session (owner's report 7 Nov: the app's Home on the left and the service's "This PC is
// being controlled" on the right). While the PC has the service, a session is hosted by the service's window (SYSTEM),
// so the user's own app steps aside: its window goes to the tray for the session and comes back after it, the way it
// was. The service's host says when it hosts in a file users can read; the app watches it.
// (8 Nov, owner's report with a picture: the app stayed next to the service's Accept dialog, because only a running
// session counted. Now "hosting" means the service's window is up for any reason: a request waiting or a session.)
// (8 Nov, second picture, Windows Sandbox: opening TryDesk again during the service's session, from the desktop
// shortcut, the exe or the tray, brought the app's window back next to the service's: it was only put away once. Now
// it is ONE TryDesk for as long as the service's window is up: any attempt to open the app brings the service's window
// to the front instead, and the app stays in the tray until the service's window is gone.)
const _serviceSessionFile = path.join(_serviceDir, "service-session.json");
let _svcWinShown = false;   // service host: its window is on screen
let _svcPublished = null;   // service host: what the file says now
function writeServiceSession(on) {
  _svcPublished = !!on;
  try { fs.writeFileSync(_serviceSessionFile, JSON.stringify({ hosting: !!on, pid: process.pid, at: Date.now() })); } catch {}
}
// Service host: the state is read from the window itself, every second as well as on its show / hide events, so a
// missed event (restore, minimize) can't leave the file wrong. Only the WINDOW counts: a session the user's own
// TryDesk shows (window hidden here) must not send that TryDesk to the tray.
function svcPublish() {
  if (!_serviceHost) return;
  // (minimized still counts: isVisible() is false for a minimized window, and the user's TryDesk came back then)
  const up = !!mainWindow && !mainWindow.isDestroyed() && (mainWindow.isVisible() || mainWindow.isMinimized());
  if (up !== _svcPublished) writeServiceSession(up);
}
if (_serviceHost) {
  writeServiceSession(false);   // a host that died mid-session left "hosting": not any more
  app.whenReady().then(() => setInterval(svcPublish, 1000));
  // The user's app asks to bring this window to the front (TryDesk opened again during the session): it writes a
  // file in the user's own profile (read as that user, see svcUserWatch).
  app.whenReady().then(() => svcUserWatch("service-front.req", 700, () => {
    if (!_svcPublished || !mainWindow || mainWindow.isDestroyed()) return;
    try { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.moveTop(); mainWindow.focus(); } catch {}
    logInfo("service host: brought to the front (TryDesk opened during the session)");
  }));
}
// ─── One TryDesk: the user's own app shows the service's sessions (owner's decision 8 Nov) ───
// With the service on, the session is the service's (SYSTEM: it survives restarts, sees UAC prompts), but what the
// person at the PC sees is their own TryDesk: the request with Accept / Reject, "this desktop is being controlled",
// Chat and Disconnect. Three small files in the user's own profile (%APPDATA%\TryDesk, readable by that user and
// SYSTEM only) carry it:
//   service-frontend.json  app -> service: "I'm running" (pid + time, every 2 s)
//   service-ui.json        service -> app: idle | request {...} | session {...}, plus the chat
//   service-cmd.json       app -> service: accept / reject (for that request), disconnect, chat text
// Without a running app (quit, PC just restarted, login screen) the service's own window is the fallback, as before.
// Security note (owner told, chose this): Accept in the user's app is as safe as TryDesk without the service; the
// SYSTEM window's Accept could not be clicked by a program running as the user.
const SVC_CMDS = new Set(["accept", "reject", "disconnect", "chat", "file-accept", "file-reject", "file-send"]);
// (the folder comes from the signed-in user's token each time and is read/written as that user: svcUserDir below)
if (_serviceHost) {
  // "Pengaturan" / "Kirim file" in this (SYSTEM) window: the signed-in person's own TryDesk opens, as them, and the
  // session moves there (owner 13 Nov: the service's window must offer the same as TryDesk). This window itself never
  // gets a settings page or a file dialog. trydesk-service.exe does the start (it holds the right to use the person's
  // token); a dev run that isn't SYSTEM just starts this source as the user it already is.
  ipcMain.handle("svc-open-user-app", (e, what) => new Promise((resolve) => {
    if (!fromMain(e) || !SVC_OPEN.has(String(what))) return resolve({ ok: false, code: 2 });
    if (!app.isPackaged && !_asSystem) {
      const args = [app.getAppPath(), `--svc-open=${what}`];
      if (process.env.TRYDESK_DEV_USER_DATA) args.push(`--user-data-dir=${process.env.TRYDESK_DEV_USER_DATA}`);
      if (process.env.TRYDESK_DEV_USER_PORT) args.push(`--remote-debugging-port=${Number(process.env.TRYDESK_DEV_USER_PORT) || 0}`);   // tests only
      try { require("child_process").spawn(process.execPath, args, { detached: true, stdio: "ignore" }).unref(); resolve({ ok: true, code: 0 }); } catch { resolve({ ok: false, code: 1 }); }
      return;
    }
    require("child_process").execFile(_serviceExe, ["launch-user", String(what)], { windowsHide: true, timeout: 15000 }, (err) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      logInfo(`service host: open the user's TryDesk (${what}): ${code ? "failed " + code : "started"}`);
      resolve({ ok: !code, code });
    });
  }));
  // The heartbeat file is the user's, any program they run can write it (audit 19 Nov, TD-VULN-02): the pid in it
  // must be a TryDesk (same program name as this one) in this Windows session, else this window keeps the dialog.
  // (asked once per pid: tasklist is not free)
  const _frontPid = { pid: 0, ok: false, at: 0 };
  const sessionOf = (rows, pid) => { for (const l of rows.split(/\r?\n/)) { const c = l.split('","').map((x) => x.replace(/^"|"$/g, "")); if (Number(c[1]) === pid) return { image: c[0], session: Number(c[3]) }; } return null; };
  // (by full path, as reg.exe is: a bare name started from the SYSTEM host would search the current folder first)
  const _tasklistExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tasklist.exe");
  const tasklistPid = (pid) => new Promise((res) => require("child_process").execFile(_tasklistExe, ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 5000 }, (err, out) => res(err ? null : sessionOf(String(out || ""), pid))));
  async function frontendIsTryDesk(pid) {
    if (_frontPid.pid === pid && Date.now() - _frontPid.at < 60000) return _frontPid.ok;   // a reused pid is checked again
    const [them, me] = await Promise.all([tasklistPid(pid), tasklistPid(process.pid)]);
    const want = path.basename(process.execPath).toLowerCase();   // TryDesk.exe (electron.exe in a source run)
    const ok = !!them && them.image.toLowerCase() === want && (!me || !Number.isInteger(me.session) || me.session === 0 || them.session === me.session);
    _frontPid.pid = pid; _frontPid.ok = ok; _frontPid.at = Date.now();
    if (!ok) logInfo(`service host: heartbeat from pid ${pid} is not a TryDesk in this session (${them ? them.image + " / session " + them.session : "not found"}), ignored`);
    return ok;
  }
  ipcMain.handle("svc-frontend-alive", async () => {
    const j = svcUserJson("service-frontend.json");
    if (!j || !(Date.now() - Number(j.at) < 7000) || !Number.isInteger(j.pid)) { _frontPid.pid = 0; return false; }
    try { process.kill(j.pid, 0); } catch (e) { if (e.code !== "EPERM") { _frontPid.pid = 0; return false; } }
    return frontendIsTryDesk(j.pid);
  });
  ipcMain.on("svc-ui-publish", (_e, ui) => {
    if (!ui || typeof ui !== "object") return;
    svcUserWrite("service-ui.json", JSON.stringify({ ...ui, pid: process.pid, at: Date.now() }));
  });
  app.whenReady().then(() => svcUserWatch("service-cmd.json", 400, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const c = svcUserJson("service-cmd.json");
    if (!c || !SVC_CMDS.has(c.cmd)) return;
    try { mainWindow.webContents.send("svc-cmd", { cmd: c.cmd, n: Number(c.n) || 0, req: Number(c.req) || 0, text: typeof c.text === "string" ? c.text.slice(0, 4000) : "" }); } catch {}
  }));
} else if (process.platform === "win32" && _gotLock) {
  // Only the TryDesk that runs (holds the single-instance lock): a second launch only hands over and quits, and its
  // quitting deleted the heartbeat, so the service showed its own window (found in Windows Sandbox, 8 Nov).
  let cmdN = 0;
  app.whenReady().then(() => {
    const dir = app.getPath("userData");
    // Which TryDesk this person runs: the service's window opens this one (as them) when asked for Settings or files.
    // (not the Portable build: a file anywhere, often in Downloads, and it has no service anyway)
    if (app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE) { try { fs.writeFileSync(path.join(dir, "app-path.json"), JSON.stringify({ exe: _selfExe })); } catch {} }
    const beat = () => { try { fs.writeFileSync(path.join(dir, "service-frontend.json"), JSON.stringify({ pid: process.pid, at: Date.now() })); } catch {} };
    beat(); setInterval(beat, 2000);
    app.on("will-quit", () => { try { fs.unlinkSync(path.join(dir, "service-frontend.json")); } catch {} });   // gone at once, not after 7 s
    const uiFile = path.join(dir, "service-ui.json");
    // A file left by a service host that is gone (crash, uninstall) means nothing: idle.
    const readUi = () => {
      let ui = null; try { ui = JSON.parse(fs.readFileSync(uiFile, "utf8")); } catch {}
      if (!ui || !Number.isInteger(ui.pid)) return { state: "idle" };
      try { process.kill(ui.pid, 0); } catch (e) { if (e.code !== "EPERM") return { state: "idle" }; }
      return ui;
    };
    // The tray says "this PC is being controlled" during the service's session too.
    const send = () => {
      const ui = readUi();
      const t = ui.state === "session" || _svcUp || _activity === "hosting";
      if (t !== _trayHosting) { _trayHosting = t; refreshTray(); }
      try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send("svc-ui", ui); } catch {}
    };
    fs.watchFile(uiFile, { interval: 400 }, send);
    // and every 3 s, so a service host that dies mid-session doesn't leave "being controlled" on screen
    setInterval(() => { if (fs.existsSync(uiFile)) send(); }, 3000);
    ipcMain.handle("svc-ui-now", () => readUi());
  });
  // The File permission of this user, for the service's sessions (read there as this user: svc-user-perms).
  ipcMain.on("svc-perms-save", (e, p) => {
    if (!fromMain(e) || !p || typeof p !== "object") return;
    // All of "Yang boleh dilakukan tamu" (owner 15 Nov: the service window must match the session design with its three
    // switches): files, mouse/keyboard, clipboard, view only.
    // Written whole (temp file + rename), so the service's 3-second read never sees a half-written file.
    const file = path.join(app.getPath("userData"), "service-perms.json"), tmp = file + ".tmp";
    try { fs.writeFileSync(tmp, JSON.stringify({ files: p.files === true, input: p.input !== false, clip: p.clip !== false, viewOnly: p.viewOnly === true, at: Date.now() })); fs.renameSync(tmp, file); } catch {}
  });
  ipcMain.on("svc-cmd", (_e, c) => {
    if (!c || !SVC_CMDS.has(c.cmd)) return;
    const out = { n: ++cmdN + Date.now(), cmd: c.cmd, req: Number(c.req) || 0, text: typeof c.text === "string" ? c.text.slice(0, 4000) : "" };
    try { fs.writeFileSync(path.join(app.getPath("userData"), "service-cmd.json"), JSON.stringify(out)); } catch {}
  });
}
let _activity = "idle";          // this app's own state (from the page): idle | hosting | viewing
let _svcHidWindow = false;       // the window is kept in the tray for the service's session (and comes back after it)
let _svcUp = false;              // user app: the service's window is up right now
function serviceSessionChanged() {
  if (_serviceHost || process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed()) return;
  let j = null; try { j = JSON.parse(fs.readFileSync(_serviceSessionFile, "utf8")); } catch {}
  // A host process that is gone can't be hosting (a SYSTEM process can't be opened from here: EPERM = it runs).
  let alive = false; if (j && j.hosting && Number.isInteger(j.pid)) { try { process.kill(j.pid, 0); alive = true; } catch (e) { alive = e.code === "EPERM"; } }
  _svcUp = !!(j && j.hosting && alive);
  _trayHosting = _svcUp || _activity === "hosting"; refreshTray();
  if (!_svcUp && _svcTakeover) _svcTakeover = false;   // the service's window has made way: normal rules again
  if (_svcUp) keepOutForService();
  else if (_svcHidWindow) {
    _svcHidWindow = false;
    try { mainWindow.showInactive(); } catch {}   // back as it was, without taking the focus
    logInfo("service session over: window back");
  }
}
// While the service's window is up the app's window stays away (not while this app controls another PC itself, and
// not when the service's window itself asked for this TryDesk: then the service's window makes way, see svc-open).
function keepOutForService() {
  if (!_svcUp || _svcTakeover || _activity === "viewing" || !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return false;
  _svcHidWindow = true; mainWindow.hide(); logInfo("service session: window to the tray");
  return true;
}
// TryDesk opened (tray, shortcut, exe) while the service's window is up: that window comes to the front instead.
function serviceToFront() {
  if (!_svcUp || _svcTakeover || _activity === "viewing") return false;
  _svcHidWindow = true;   // the user wanted TryDesk: it opens once the session is over
  try { require("koffi").load("user32.dll").func("int __stdcall AllowSetForegroundWindow(uint32 pid)")(0xFFFFFFFF); } catch {}   // ASFW_ANY
  try { fs.writeFileSync(path.join(app.getPath("userData"), "service-front.req"), String(Date.now())); } catch {}
  logInfo("service session: TryDesk opened, the service's window comes to the front");
  return true;
}
if (!_serviceHost && process.platform === "win32" && _gotLock) {
  app.whenReady().then(() => {
    fs.watchFile(_serviceSessionFile, { interval: 1000 }, serviceSessionChanged);
    serviceSessionChanged();   // a session already running when this app starts
    app.on("will-quit", () => fs.unwatchFile(_serviceSessionFile));
  });
}

// ─── Settings that act on the OS (Settings panel) ───
// Start with Windows: launched with --tray so it comes up in the system tray, not as a window. An entry made by
// an older build (no --tray) still counts as "on" and is replaced when the switch is next changed.
const LOGIN_ARGS = ["--tray"];
const loginOn = (args) => { try { return !!app.getLoginItemSettings({ path: _selfExe, args }).openAtLogin; } catch { return false; } };
ipcMain.handle("get-login-item", () => loginOn(LOGIN_ARGS) || loginOn([]));
ipcMain.handle("set-login-item", (_e, on) => {
  try {
    app.setLoginItemSettings({ openAtLogin: false, path: _selfExe });
    app.setLoginItemSettings({ openAtLogin: !!on, path: _selfExe, args: LOGIN_ARGS });
    return true;
  } catch { return false; }
});
let _powerBlock = null;   // keeps the host's display awake during a session (Settings → "Cegah layar mati")
ipcMain.on("power-save", (_e, on) => {
  try {
    if (on && _powerBlock == null) _powerBlock = powerSaveBlocker.start("prevent-display-sleep");
    else if (!on && _powerBlock != null) { powerSaveBlocker.stop(_powerBlock); _powerBlock = null; }
  } catch {}
});
// P7 (14 Nov 2026): a PC left alone turns its monitor off ("turn off the display after N minutes"), and Windows then
// hardly draws: measured on this PC, the capture took 5.2 s to start instead of 1.2 s and the picture crawled at 2-4
// fps with 0.4-0.5 s of delay until input woke the monitor. That is the unattended PC, the service's case. A session
// that starts wakes it as a key press would: ES_DISPLAY_REQUIRED once resets the display's idle timer (it is not kept
// on: Settings → "Cegah layar mati" does that).
// A monitor that was off for a while is then taken away and added again by Windows for ~3 s (owner's two monitors,
// measured: display-removed/-added in bursts up to 3.2 s after the wake, quiet gaps up to ~1.1 s between them). A
// capture started meanwhile took 2.3-3.3 s, once failed ("Could not start video source"), and saw one "Entire screen"
// for the two monitors: the session then told the viewer there was one monitor. So when Windows said the display was
// off (GUID_CONSOLE_DISPLAY_STATE, watchDisplayState), this waits, at most 4 s, until the monitors are back as they were
// and nothing has changed for 0.7 s (or, for a monitor that comes back without that, 1 s of "on" with no change).
// A display that was on returns at once.
let _setExecState = null, _displayState = -1, _screenEvAt = 0;
const displayLayout = () => screen.getAllDisplays().map((d) => `${d.id}@${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height}`).sort().join(" ");
ipcMain.handle("wake-display", async (e) => {
  if (process.platform !== "win32" || !fromMain(e)) return { woke: false };
  const wasOff = _displayState === 0, before = wasOff ? displayLayout() : "", t0 = Date.now();
  try {
    if (!_setExecState) _setExecState = require("koffi").load("kernel32.dll").func("uint32 __stdcall SetThreadExecutionState(uint32 esFlags)");
    _setExecState(0x00000002);   // ES_DISPLAY_REQUIRED, once
  } catch (err) { logInfo("wake display failed: " + (err && err.message)); return { woke: false }; }
  // Inside a Remote Desktop session the picture is the RDP display, whatever the console's monitor does: no waiting.
  if (!wasOff || _rdpSession) return { woke: false };
  let onAt = 0;
  while (Date.now() - t0 < 4000) {
    await new Promise((r) => setTimeout(r, 50));
    if (_displayState !== 1) continue;
    if (!onAt) onAt = Date.now();
    if (_screenEvAt > t0 ? Date.now() - _screenEvAt > 700 && displayLayout() === before : Date.now() - onAt > 1000) break;
  }
  logInfo(`wake display: the monitors were off, ready after ${Date.now() - t0} ms${displayLayout() === before ? "" : " (layout not as before)"}`);
  return { woke: true, ms: Date.now() - t0 };
});
// Windows' word on the console display (0 off, 1 on, 2 dimmed): a power-setting notification to this window, sent once at
// registration and on every change (WM_POWERBROADCAST / PBT_POWERSETTINGCHANGE). Not known (-1): wake-display waits for
// nothing, as before.
let _pwr = null;
function watchDisplayState(win) {
  if (process.platform !== "win32" || !win) return;
  try {
    if (!_pwr) {
      const koffi = require("koffi"), u32 = koffi.load("user32.dll"), k32 = koffi.load("kernel32.dll");
      koffi.struct("TD_PWR_GUID", { d1: "uint32", d2: "uint16", d3: "uint16", d4: koffi.array("uint8", 8) });
      _pwr = { move: k32.func("void __stdcall RtlMoveMemory(void *dst, uintptr_t src, uintptr_t len)"), reg: u32.func("void * __stdcall RegisterPowerSettingNotification(uintptr_t h, TD_PWR_GUID *g, uint32 flags)") };
    }
    const word = (buf) => (buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0)));
    win.hookWindowMessage(0x0218, (wParam, lParam) => {   // WM_POWERBROADCAST
      try {
        if (word(wParam) !== 0x8013n) return;   // PBT_POWERSETTINGCHANGE
        const b = Buffer.alloc(24); _pwr.move(b, word(lParam), 24);   // POWERBROADCAST_SETTING
        if (b.readUInt32LE(0) === 0x6FE69556 && b.readUInt32LE(16) >= 4) _displayState = b.readUInt32LE(20);
      } catch {}
    });
    _pwr.reg(word(win.getNativeWindowHandle()), { d1: 0x6FE69556, d2: 0x704A, d3: 0x47A0, d4: [0x8F, 0x24, 0xC2, 0x8D, 0x93, 0x6F, 0xDA, 0x47] }, 0);   // GUID_CONSOLE_DISPLAY_STATE
  } catch (err) { logInfo("display state watch failed: " + (err && err.message)); }
}
ipcMain.on("lock-workstation", () => { try { inputSim.lockWorkStation && inputSim.lockWorkStation(); } catch {} });
// Ctrl+Alt+Del from the key panel (owner pick 19 Nov). Windows ignores the keys from a program; only SendSAS from a
// process running as SYSTEM opens that screen, and only when the policy SoftwareSASGeneration lets services do it
// (1 = services, 3 = services and Ease of Access apps). The service's host is that process. The renderer has already
// checked that the viewer may control this PC.
// The policy is read once per run (reg.exe by full path, with a time limit, so the main process never hangs on it).
// Not set at all = Windows' default, which TryDesk may change; a value an administrator set on purpose (0, or 2 =
// Ease of Access only) is respected: 0 stays 0 and Ctrl+Alt+Del is refused, 2 becomes 3 (adds services, keeps theirs).
let _sendSas = null, _sasPolicy = null;
ipcMain.handle("send-sas", () => {
  if (process.platform !== "win32" || !_serviceHost || !_hostingNow) return "unavailable";
  try {
    const { execFileSync } = require("child_process");
    const reg = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
    const key = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System";
    if (_sasPolicy === null) {
      let cur = -1;   // -1 = not set
      try { const m = /SoftwareSASGeneration\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(execFileSync(reg, ["query", key, "/v", "SoftwareSASGeneration"], { encoding: "utf8", windowsHide: true, timeout: 4000 })); if (m) cur = parseInt(m[1], 16); }
      catch (e) {
        // reg.exe ends with 1 when the value isn't there; anything else (a time-out, no access) is not "not set":
        // then nothing is written and the next try reads again
        if (!(e && e.status === 1 && !e.signal)) { logInfo("Ctrl+Alt+Del: policy not readable (" + (e && (e.code || e.status)) + ")"); return "failed"; }
      }
      if (cur === 0) { logInfo("Ctrl+Alt+Del refused: SoftwareSASGeneration is 0 on this PC (set by its administrator)"); _sasPolicy = "off"; }
      else if (cur === 1 || cur === 3) _sasPolicy = "on";
      else {
        execFileSync(reg, ["add", key, "/v", "SoftwareSASGeneration", "/t", "REG_DWORD", "/d", cur === 2 ? "3" : "1", "/f"], { windowsHide: true, timeout: 4000 });
        logInfo(`SoftwareSASGeneration ${cur < 0 ? "not set" : cur} -> ${cur === 2 ? 3 : 1} (Ctrl+Alt+Del from the key panel)`);
        _sasPolicy = "on";
      }
    }
    if (_sasPolicy !== "on") return "policy";
    if (!_sendSas) _sendSas = require("koffi").load(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "sas.dll")).func("void __stdcall SendSAS(int AsUser)");
    _sendSas(0);
    logInfo("Ctrl+Alt+Del sent (SendSAS)");
    return "ok";
  } catch (e) { logInfo("SendSAS failed: " + (e && e.message)); return "failed"; }
});
ipcMain.handle("set-hw-accel", (_e, on) => {
  try { if (on) { if (fs.existsSync(_userNoGpuFlag)) fs.unlinkSync(_userNoGpuFlag); } else fs.writeFileSync(_userNoGpuFlag, "1"); return true; } catch { return false; }
});
ipcMain.handle("get-hw-accel", () => !_userNoGpu);
// External links only to TryDesk's own sites; everything else in the window stays blocked.
//
// Linux AppImage (owner's report 7 Nov, XFCE: "Failed to execute default Web Browser. Input/output error." on the
// update notice's Download): the AppImage launcher (electron-builder's AppRun) prepends TryDesk's own folders to
// LD_LIBRARY_PATH, XDG_DATA_DIRS, PATH and GSETTINGS_SCHEMA_DIR. shell.openExternal hands the link to xdg-open, the
// browser inherits those variables, loads TryDesk's bundled old libraries / missing schemas and fails to start. So on
// Linux the browser is started by us with the AppImage additions removed, trying the common openers in turn; if none
// starts, the user gets the address with a Copy button instead of a dead button. Windows and macOS keep openExternal.
function linuxCleanEnv() {
  const env = { ...process.env };
  const appdir = env.APPDIR;
  if (appdir) {
    const strip = (v) => String(v || "").split(":").filter((p) => p && !p.startsWith(appdir)).join(":");
    for (const k of ["LD_LIBRARY_PATH", "LD_PRELOAD", "XDG_DATA_DIRS", "PATH", "GSETTINGS_SCHEMA_DIR", "GIO_MODULE_DIR", "GDK_PIXBUF_MODULE_FILE", "GTK_PATH", "QT_PLUGIN_PATH", "PYTHONPATH"]) {
      if (!(k in env)) continue;
      const v = strip(env[k]);
      if (v) env[k] = v; else delete env[k];
    }
    for (const k of ["APPDIR", "APPIMAGE", "ARGV0", "OWD"]) delete env[k];
  }
  if (!env.PATH) env.PATH = "/usr/local/bin:/usr/bin:/bin";
  return env;
}
// Starts one opener. Resolves true when it exits with 0, or is still running after 4 s (a browser started directly
// stays open); false when it is missing or exits with an error.
function linuxTry(cmd, args, env) {
  return new Promise((resolve) => {
    let done = false;
    const end = (ok) => { if (!done) { done = true; resolve(ok); } };
    let p;
    try { p = require("child_process").spawn(cmd, args, { env, detached: true, stdio: "ignore" }); } catch { return end(false); }
    p.on("error", () => end(false));
    p.on("exit", (code) => end(code === 0));
    setTimeout(() => { try { p.unref(); } catch {} end(true); }, 4000);
  });
}
async function linuxOpenUrl(url) {
  const env = linuxCleanEnv();
  const tries = [["xdg-open", [url]], ["gio", ["open", url]], ["sensible-browser", [url]], ["x-www-browser", [url]],
    ["firefox", [url]], ["chromium", [url]], ["chromium-browser", [url]], ["google-chrome", [url]], ["brave-browser", [url]]];
  for (const [cmd, args] of tries) if (await linuxTry(cmd, args, env)) return true;
  return false;
}
async function openLink(url) {
  let ok;
  if (process.platform === "linux") ok = await linuxOpenUrl(url);
  else ok = await shell.openExternal(url).then(() => true, () => false);
  if (ok) return true;
  try {
    const r = await dialog.showMessageBox(mainWindow, {
      type: "info", noLink: true, defaultId: 0, cancelId: 1,
      buttons: [L("Salin tautan", "Copy link"), L("Tutup", "Close")],
      title: "TryDesk",
      message: L("Browser tidak bisa dibuka dari TryDesk.", "TryDesk couldn't open your browser."),
      detail: L("Buka alamat ini di browser Anda:\n", "Open this address in your browser:\n") + url,
    });
    if (r.response === 0) clipboard.writeText(url);
  } catch {}
  return false;
}
ipcMain.on("open-external", (_e, href) => {
  try {
    const u = new URL(String(href));
    if (u.protocol === "https:" && /^(trydesk\.ai\.id|www\.trydesk\.ai\.id|github\.com)$/.test(u.hostname)) openLink(u.href);
  } catch {}
});
ipcMain.on("set-discord-enabled", (_e, on) => { try { discordRPC.setEnabled(!!on); } catch {} });
// Native confirm for destructive actions (e.g. Regenerate ID). Returns true only if the user picks OK.
ipcMain.handle("confirm-dialog", async (_e, opts) => {
  opts = opts || {};
  try {
    const r = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: [opts.cancelLabel || L("Batal", "Cancel"), opts.okLabel || "OK"],
      defaultId: 1, cancelId: 0, noLink: true,
      title: opts.title || L("Konfirmasi", "Confirm"),
      message: opts.message || "",
      detail: opts.detail || "",
    });
    return r.response === 1;
  } catch { return false; }
});



let _lastMonitorMap = "";
ipcMain.handle("get-monitors", async () => {
  // Enumerate by OS DISPLAY, screen.getAllDisplays() is the authoritative monitor count/geometry,
  // so every physical monitor is always listed even when desktopCapturer.getSources() under-reports
  // (some Windows GPU/driver setups return fewer "screen" sources than there are displays).
  // Each display gets its own capture id: the exact source matched by display_id when present,
  // otherwise the next unused source positionally, and as a last resort the synthesized Windows
  // source id "screen:<i>:0" (confirmed format) so even an unreported monitor stays capturable.
  const sources = await screenSources(true);
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  if (!displays.length) {
    // No display info at all, fall back to whatever sources exist (or a single synthesized one).
    const list = sources.length ? sources : [{ id: "screen:0:0", name: "Monitor 1" }];
    return list.map((src, i) => ({ sourceId: src.id, index: i, label: src.name || `Monitor ${i + 1}`, boundsX: 0, boundsY: 0, width: 1920, height: 1080, scaleFactor: 1, primary: i === 0 }));
  }
  const usedSrc = new Set();
  // Pass 1: exact match each display to its source by display_id.
  const srcForDisplay = new Map();
  for (const d of displays) {
    const match = sources.find((s) => s.display_id && String(s.display_id) === String(d.id) && !usedSrc.has(s.id));
    if (match) { srcForDisplay.set(d.id, match); usedSrc.add(match.id); }
  }
  // Pass 2: give any still-unmatched display the next unused source (positional fallback).
  const remaining = sources.filter((s) => !usedSrc.has(s.id));
  let ri = 0;
  for (const d of displays) {
    if (!srcForDisplay.has(d.id) && ri < remaining.length) { srcForDisplay.set(d.id, remaining[ri]); usedSrc.add(remaining[ri].id); ri++; }
  }
  // A monitor plugged in mid-run can open the coverage gap too: remember it so the NEXT launch uses WGC.
  if (!_wgcOn && _wgcFlag && !_rdpSession && sources.length < displays.length) { try { fs.writeFileSync(_wgcFlag, "1"); } catch {} }
  // Log the display↔source mapping when it changes, the first thing to read when a monitor won't switch.
  const _map = `wgc=${_wgcOn} displays=[${displays.map((d) => `${d.id}:${d.label || "?"} ${d.size.width}x${d.size.height}@${d.scaleFactor}`).join(", ")}] sources=[${sources.map((s) => `${s.id}/${s.display_id || "-"}`).join(", ")}]`;
  if (_map !== _lastMonitorMap) { _lastMonitorMap = _map; logInfo("monitors " + _map); }
  return displays.map((d, i) => {
    const src = srcForDisplay.get(d.id) || null;
    return {
      sourceId: src ? src.id : `screen:${i}:0`,   // synthesized last-resort id keeps the monitor capturable
      displayId: String(d.id),
      index: i,
      label: (src && src.name) || d.label || `Monitor ${i + 1}`,
      boundsX: d.bounds.x, boundsY: d.bounds.y,
      width: d.size.width, height: d.size.height, scaleFactor: d.scaleFactor,
      primary: d.id === primaryId,
    };
  });
});

// ─── Fast capture path (Windows, host side): src/native/trydesk-capture.exe ───
// Chromium's screen capture tops out near 60 frames a second and adds ~35 ms (measured 2026-11-02); this helper
// captures with DXGI and encodes on the GPU (up to 240 fps, ~2.5 ms from capture to here). It runs as its own process,
// so a driver problem there never takes TryDesk down; when it is missing or exits, the session stays on WebRTC
// capture. Packets go to the renderer as they arrive; the renderer sends them to the viewer.
const _fastExe = path.join(__dirname, "native", "trydesk-capture.exe").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
let _fast = null;   // host end: { proc }
let _fastRecv = null;   // viewer end of the UDP link (the same exe with --recv): { proc }
function fastAvailable() { return process.platform === "win32" && !_forceNoGpu && fs.existsSync(_fastExe); }
// The helper as a plain-frame source only (no encoder, no video device): in a Hyper-V guest (Windows Sandbox, a VM, a
// cloud PC) the GPU path stays off (it took the whole VM down over GPU-PV), but the lock / login screen can only be
// seen through the helper. --raw-only --vm: desktop copy read back on the CPU in the helper's own process, nothing
// shared with Chromium's GPU process (proven in Windows Sandbox with GPU-PV, 17 Nov 2026: lock screen, no VM exit).
const helperVmRaw = () => process.platform === "win32" && !!_vmGuest && fs.existsSync(_fastExe);
ipcMain.handle("native-capture-available", () => fastAvailable() || helperVmRaw());
function stopHelper(ref) {
  const h = ref(); if (!h) return;
  const p = h.proc; h.proc = null;
  try { p.stdin.write('{"cmd":"stop"}\n'); } catch {}
  setTimeout(() => { try { p.kill(); } catch {} }, 1000);
}
function stopFast() { if (_fast) { const h = _fast; _fast = null; stopHelper(() => h); } }
function stopFastRecv() { if (_fastRecv) { const h = _fastRecv; _fastRecv = null; stopHelper(() => h); } }
const fromMain = (e) => mainWindow && !mainWindow.isDestroyed() && e.sender === mainWindow.webContents;
// Secrets (audit 19 Nov 2026, TD-VULN-04a): the access password's key (salt:PBKDF2) is what proves the password, so a
// copy of it is as good as the password for a modified client. It lived in plain localStorage; now it is kept here,
// encrypted by Windows for this user (DPAPI via safeStorage), in userData\secrets.json. A copied profile or a backup
// on another PC / account can't decrypt it. The service's own host keeps using service.json (ProgramData, admin-only).
const SECRET_KEYS = new Set(["accessPasswordHash"]);
const secretFile = () => path.join(app.getPath("userData"), "secrets.json");
function secretsRead() { try { const j = JSON.parse(fs.readFileSync(secretFile(), "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; } }
ipcMain.on("secret-get-sync", (e, key) => {
  // returnValue is sent back the moment it is set, so it is set exactly once
  let out = null;
  if (fromMain(e) && SECRET_KEYS.has(key) && !_serviceHost) {
    try {
      if (!safeStorage.isEncryptionAvailable()) out = { unavailable: true };
      else { const v = secretsRead()[key]; out = { value: typeof v === "string" && v ? safeStorage.decryptString(Buffer.from(v, "base64")) : null }; }
    } catch (err) { logInfo("secret " + key + " can't be read (another PC or user?): " + (err && err.message)); out = { value: null, broken: true }; }
  }
  e.returnValue = out;
});
ipcMain.on("secret-set", (e, key, val) => {
  if (!fromMain(e) || !SECRET_KEYS.has(key) || _serviceHost) return;
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    const all = secretsRead();
    if (val == null || val === "") delete all[key]; else all[key] = safeStorage.encryptString(String(val)).toString("base64");
    const f = secretFile(), tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(all)); fs.renameSync(tmp, f);
  } catch (err) { logInfo("secret " + key + " not saved: " + (err && err.message)); }
});
const udpKeyOk = (k) => typeof k === "string" && /^[0-9a-f]{64}$/i.test(k);
// Addresses the UDP link may be pointed at: this LAN (or a VPN's private range) and this PC itself.
const udpIpOk = (ip) => typeof ip === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && (lanPrivate(ip) || ip.startsWith("127."));
// The helper's stdout: u32 length, u8 type, u8 flags, u16 0, f64 time, payload. Whole packets only, so a frame of
// 500 KB arriving in 64 KB pipe pieces is joined once, not on every piece (at 1 Gbps that copying added up).
function packetReader(proc, onPacket) {
  let parts = [], have = 0;
  proc.stdout.on("data", (chunk) => {
    parts.push(chunk); have += chunk.length;
    for (;;) {
      if (have < 16) return;
      if (parts.length > 1) { parts = [Buffer.concat(parts)]; }
      const buf = parts[0];
      const len = buf.readUInt32LE(0);
      if (len > 64 * 1024 * 1024) { try { proc.kill(); } catch {} return; }   // not our helper talking
      if (have < 16 + len) return;
      onPacket(buf[4], buf[5], buf.readDoubleLE(8), buf.subarray(16, 16 + len));
      const rest = buf.subarray(16 + len); parts = rest.length ? [rest] : []; have = rest.length;
    }
  });
}
ipcMain.handle("fast-capture-available", () => fastAvailable());
ipcMain.handle("fast-capture-start", (e, opts) => {
  const vmRaw = !fastAvailable() && opts && opts.raw === true && helperVmRaw();
  if (!fromMain(e) || !(fastAvailable() || vmRaw)) return { ok: false };
  stopFast();
  const d = screen.getAllDisplays().find((x) => String(x.id) === String(opts && opts.displayId)) || screen.getPrimaryDisplay();
  // DXGI works in physical pixels; Electron's display bounds are DIP.
  let r = process.platform === "win32" ? screen.dipToScreenRect(null, d.bounds) : d.bounds;
  // Development builds only: a screen the helper can't find, so it exits at once ("monitor not found"), as it does on a
  // PC where it can't capture (tests the fallback's failure handling).
  if (!app.isPackaged && process.env.TRYDESK_TEST_HELPER_FAIL === "1") r = { x: -99999, y: -99999, width: 10, height: 10 };
  const fps = Math.max(1, Math.min(240, Math.round(Number(opts && opts.fps) || 60)));
  const mbps = Math.max(1, Math.min(1000, Math.round(Number(opts && opts.mbps) || 50)));
  const udp = udpKeyOk(opts && opts.udp) ? opts.udp : null;   // session key for the UDP link, handed to the helper on stdin (never on the command line)
  let proc;
  try { proc = require("child_process").spawn(_fastExe, ["--rect", `${r.x},${r.y},${r.width},${r.height}`, "--fps", String(fps), "--mbps", String(mbps), ...(udp ? ["--udp"] : []), ...(opts && opts.hevc === true ? ["--hevc"] : []), ...(opts && opts.raw === true ? ["--raw-ok"] : []), ...(vmRaw ? ["--raw-only", "--vm"] : [])], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }); }
  catch (err) { logInfo("fast capture spawn failed: " + err.message); return { ok: false }; }
  const me = { proc };
  _fast = me;
  const send = (ch, payload) => { if (_fast === me && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload); };
  packetReader(proc, (type, flags, t, payload) => {
    if (type === 1) send("fast-capture-packet", { key: !!(flags & 1), t, data: new Uint8Array(payload) });
    else if (type === 2) { const s = payload.toString("utf8"); logInfo("fast capture " + s); send("fast-capture-info", s); }
    // Plain frames (no hardware encoder, see --raw-ok in the helper): width, height, BGRA rows.
    else if (type === 4 && payload.length >= 8) {
      const w = payload.readUInt32LE(0), h = payload.readUInt32LE(4);
      if (w > 0 && h > 0 && payload.length === 8 + w * h * 4) send("fast-capture-raw", { t, w, h, data: new Uint8Array(payload.subarray(8)) });
    }
  });
  proc.on("exit", (code) => { logInfo(`fast capture exited ${code}`); send("fast-capture-ended", { code }); if (_fast === me) _fast = null; });
  proc.on("error", (err) => { logInfo("fast capture error: " + err.message); send("fast-capture-ended", { code: -1 }); if (_fast === me) _fast = null; });
  if (udp) { try { proc.stdin.write(JSON.stringify({ cmd: "udpkey", hex: udp }) + "\n"); } catch {} }
  logInfo(`fast capture start ${r.width}x${r.height}@${r.x},${r.y} fps=${fps} mbps=${mbps}${udp ? " udp" : ""}${opts && opts.hevc === true ? " hevc" : ""}${opts && opts.raw === true ? " raw-ok" : ""}${vmRaw ? " vm-raw-only" : ""}`);
  return { ok: true, ips: udp ? lanAddrs() : [] };
});
// Only the commands the helper knows, with clamped numbers and checked addresses.
ipcMain.on("fast-capture-cmd", (e, cmd) => {
  if (!fromMain(e) || !_fast || !_fast.proc || !cmd) return;
  let line = null;
  if (cmd.cmd === "key") line = '{"cmd":"key"}';
  else if (cmd.cmd === "rate") line = JSON.stringify({ cmd: "rate", mbps: Math.max(1, Math.min(1000, Math.round(Number(cmd.mbps) || 50))), fps: Math.max(1, Math.min(240, Math.round(Number(cmd.fps) || 60))) });
  else if (cmd.cmd === "peer") { const port = Math.round(Number(cmd.port)); if (udpIpOk(cmd.ip) && port > 0 && port < 65536) line = JSON.stringify({ cmd: "peer", ip: cmd.ip, port }); }
  else if (cmd.cmd === "udp") line = JSON.stringify({ cmd: "udp", on: cmd.on ? 1 : 0 });
  if (line) { try { _fast.proc.stdin.write(line + "\n"); } catch {} }
});
ipcMain.on("fast-capture-stop", (e) => { if (fromMain(e)) stopFast(); });
// The PC's sound for a host whose picture comes from the helper (TryDesk run as administrator): Chromium captures
// neither the screen there nor, without the screen, the sound (an audio-only desktop request kills the renderer,
// tested 14 Nov 2026). Same exe with --loopback: 10 ms blocks of 32-bit float PCM, type 3 packets (see the exe).
let _loop = null;
function stopLoop() { if (_loop) { const h = _loop; _loop = null; stopHelper(() => h); } }
ipcMain.handle("loopback-start", (e) => {
  if (!fromMain(e) || process.platform !== "win32" || !fs.existsSync(_fastExe)) return { ok: false };
  stopLoop();
  let proc;
  try { proc = require("child_process").spawn(_fastExe, ["--loopback"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }); }
  catch (err) { logInfo("loopback spawn failed: " + err.message); return { ok: false }; }
  const me = { proc };
  _loop = me;
  const send = (ch, payload) => { if (_loop === me && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload); };
  packetReader(proc, (type, _flags, _t, payload) => {
    // A fresh copy of the samples (offset 0, so the renderer can view them as 32-bit floats).
    if (type === 3 && payload.length > 8) send("loopback-pcm", { rate: payload.readUInt32LE(0), ch: payload.readUInt16LE(4), data: new Uint8Array(payload.subarray(8)) });
    else if (type === 2) { const s = payload.toString("utf8"); logInfo("loopback " + s); send("loopback-info", s); }
  });
  proc.on("exit", (code) => { logInfo(`loopback exited ${code}`); if (_loop === me) { send("loopback-ended", { code }); _loop = null; } });
  proc.on("error", (err) => { logInfo("loopback error: " + err.message); if (_loop === me) { send("loopback-ended", { code: -1 }); _loop = null; } });
  logInfo("loopback start");
  return { ok: true };
});
ipcMain.on("loopback-stop", (e) => { if (fromMain(e)) stopLoop(); });
// Viewer end of the UDP link: the host told us its key, port and LAN addresses; our receiver sends hellos there and
// hands whole frames to the renderer. Returns our own port and addresses so the host can send hellos back too.
ipcMain.handle("fast-udp-recv-start", (e, opts) => {
  if (!fromMain(e) || !fastAvailable() || !opts || !udpKeyOk(opts.key)) return { ok: false };
  stopFastRecv();
  const port = Math.round(Number(opts.port)); if (!(port > 0 && port < 65536)) return { ok: false };
  const ips = (Array.isArray(opts.ips) ? opts.ips : []).filter(udpIpOk).slice(0, 8);
  if (!ips.length) return { ok: false };
  let proc;
  try { proc = require("child_process").spawn(_fastExe, ["--recv", "--port", "0"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }); }
  catch (err) { logInfo("fast udp recv spawn failed: " + err.message); return { ok: false }; }
  const me = { proc };
  _fastRecv = me;
  const send = (ch, payload) => { if (_fastRecv === me && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload); };
  return new Promise((resolve) => {
    let resolved = false;
    const done = (v) => { if (!resolved) { resolved = true; resolve(v); } };
    packetReader(proc, (type, flags, t, payload) => {
      if (type === 1) send("fast-udp-packet", { key: !!(flags & 1), gap: !!(flags & 2), t, data: new Uint8Array(payload) });
      else if (type === 2) {
        const s = payload.toString("utf8"); logInfo("fast udp recv " + s); send("fast-udp-info", s);
        let j = null; try { j = JSON.parse(s); } catch {}
        if (j && j.udpPort > 0) {
          try { proc.stdin.write(JSON.stringify({ cmd: "udpkey", hex: opts.key }) + "\n"); for (const ip of ips) proc.stdin.write(JSON.stringify({ cmd: "peer", ip, port }) + "\n"); } catch {}
          done({ ok: true, port: j.udpPort, ips: lanAddrs() });
        }
      }
    });
    proc.on("exit", (code) => { logInfo(`fast udp recv exited ${code}`); send("fast-udp-ended", { code }); if (_fastRecv === me) _fastRecv = null; done({ ok: false }); });
    proc.on("error", (err) => { logInfo("fast udp recv error: " + err.message); send("fast-udp-ended", { code: -1 }); if (_fastRecv === me) _fastRecv = null; done({ ok: false }); });
    setTimeout(() => done({ ok: false }), 5000);
  });
});
ipcMain.on("fast-udp-recv-stop", (e) => { if (fromMain(e)) stopFastRecv(); });
app.on("will-quit", () => { stopFast(); stopFastRecv(); stopLoop(); });

let captureDisplay = null;
ipcMain.on("set-capture-display", (_e, d) => { captureDisplay = d; });
// "Ikuti kursor": which screen this PC's cursor is on (the id get-monitors gives as displayId).
ipcMain.handle("cursor-display-id", () => { try { return String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id); } catch { return null; } });
// Which screen getDisplayMedia should feed (monitor select). Awaitable so the renderer sets it BEFORE
// calling getDisplayMedia, avoids a race where the handler picks the wrong/first screen.
// Resolves the monitor to a LIVE source now (exact id, else its OS display id) and returns whether one exists;
// false tells the renderer to use the legacy capture path instead of letting getDisplayMedia grab another screen.
ipcMain.handle("set-dm-source", async (_e, id, displayId) => {
  let src = null;
  try {
    const sources = await screenSources();
    src = sources.find((s) => s.id === id) || (displayId ? sources.find((s) => String(s.display_id) === String(displayId)) : null) || null;
  } catch {}
  _dmSourceId = src ? src.id : null;
  return !!src;
});

// pin = true: an incoming-connection request. Windows won't let an app take the foreground on its own, so the window
// went up BEHIND whatever was open and the request ran out unseen ("Tidak ada jawaban", rented PC 2026-11-02): keep
// it on top and flash the taskbar button until the request is answered (pin = false).
ipcMain.on("focus-window", (_e, pin) => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
  if (pin === true) { try { mainWindow.setAlwaysOnTop(true, "floating"); mainWindow.moveTop(); mainWindow.flashFrame(true); } catch {} }
  else if (pin === false) { try { mainWindow.setAlwaysOnTop(false); mainWindow.flashFrame(false); } catch {} }
});
ipcMain.on("minimize-window", () => mainWindow?.minimize());
ipcMain.on("maximize-window", () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on("close-window", () => { _quitting = true; mainWindow?.close(); });

// ─── Secure desktop (UAC prompt, lock screen), service host only ───
// The UAC prompt is drawn on Windows' secure desktop ("Winlogon"), which no program in the user's session can see or
// click, administrator or not: only SYSTEM. So a viewer saw a frozen picture and couldn't answer the prompt (owner's
// report 7 Nov). The service's host IS SYSTEM: while that desktop has the input, the picture and the input go through
// the capture helper, which moves to that desktop (trydesk-capture.cpp, followInputDesktop). This process can't move
// (a thread with windows can't change desktop), so it only watches which desktop is shown.
let _secureDesk = false, _deskApi = null;
function inputDesktopName() {
  try {
    if (!_deskApi) {
      const u = require("koffi").load("user32.dll");
      _deskApi = { open: u.func("void * __stdcall OpenInputDesktop(uint32 flags, int inherit, uint32 access)"),
        info: u.func("int __stdcall GetUserObjectInformationW(void *h, int index, void *buf, uint32 len, _Out_ uint32 *needed)"),
        close: u.func("int __stdcall CloseDesktop(void *h)") };
    }
    const h = _deskApi.open(0, 0, 0x0001);   // DESKTOP_READOBJECTS
    // "" = a desktop this process may not open: for SYSTEM only none (no input desktop right now); for the user's own
    // TryDesk the secure desktop (UAC prompt, lock screen), which only SYSTEM may open
    if (!h) return "";
    const buf = Buffer.alloc(128), need = [0];
    _deskApi.info(h, 2, buf, buf.length, need);   // UOI_NAME
    _deskApi.close(h);
    return buf.toString("utf16le").split("\0")[0];
  } catch { return null; }   // couldn't ask at all (no koffi): unknown, never taken as "secure"
}
// The user's own TryDesk hosting (no service): when a UAC prompt or the lock screen comes up, Windows draws it where
// this process can't look, so the viewer's picture just stops on the last frame and its clicks go nowhere (Threads
// report 19 Nov: "apabila ada UAC, pop up gak muncul di layar ya"). Nothing can capture it from here; what we can do
// is say so on both sides. Two reads in a row (1 s), so the moment of a desktop switch isn't taken for one.
let _blindDesk = false, _blindSeen = 0;
if (!_serviceHost && process.platform === "win32") {
  setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const now = _hostingNow && inputDesktopName() === "";
    _blindSeen = now ? _blindSeen + 1 : 0;
    const blind = _blindSeen >= 2;
    if (blind === _blindDesk || (now && !blind)) return;
    _blindDesk = blind;
    logInfo("input desktop " + (blind ? "is a secure one (UAC prompt / lock screen): the viewer can't see it without the service" : "is back to normal"));
    try { mainWindow.webContents.send("host-blind-desktop", blind); } catch {}
  }, 500);
}
if (_serviceHost && process.platform === "win32") {
  setInterval(() => {
    if (!_hostingNow || !mainWindow || mainWindow.isDestroyed()) { if (_secureDesk) { _secureDesk = false; } return; }
    const name = inputDesktopName();
    const secure = !!name && name.toLowerCase() !== "default";
    if (secure === _secureDesk) return;
    _secureDesk = secure;
    screenSourcesStale();   // the next capture asks Windows for the screens again
    logInfo(`service host: input desktop ${name || "?"}${secure ? " (secure: picture and input through the helper)" : ""}`);
    try { mainWindow.webContents.send("secure-desktop", secure); } catch {}
  }, 300);
}
// Asked as a session starts: does the secure desktop hold the screen right now (lock screen, the login screen after a
// restart, a UAC prompt)? Then the picture comes from the helper from the first frame: Chromium's capture can't see
// that desktop, and its two tries cost ~14 s or sent a black picture (the watcher above only runs while hosting).
ipcMain.handle("secure-desktop-now", (e) => {
  if (!_serviceHost || process.platform !== "win32" || !fromMain(e)) return false;
  const name = inputDesktopName();
  return !!name && name.toLowerCase() !== "default";
});
let _hostingNow = false;   // mirrors "hosting-state" for the watcher above
// Input meant for the secure desktop goes to the helper. Coordinates resolved here exactly as for the normal path.
function helperInput(event, physPoint) {
  const p = _fast && _fast.proc; if (!p) return false;
  let m = null;
  switch (event.action) {
    case "mousemove": if (physPoint) m = { t: "move", x: Math.round(physPoint.x), y: Math.round(physPoint.y) }; break;
    case "mousedown": case "mouseup": m = { t: event.action === "mousedown" ? "down" : "up", b: ["left", "right", "middle"].includes(event.button) ? event.button : "left" }; break;
    case "scroll": m = { t: "wheel", wy: Math.round(-(Number(event.deltaY) || 0) * 120), wx: Math.round((Number(event.deltaX) || 0) * 120) }; break;
    case "keydown": case "keyup": { const vk = Number(event.vk); if (Number.isInteger(vk) && vk > 0 && vk <= 0xFE) m = { t: "key", vk, up: event.action === "keyup" ? 1 : 0 }; break; }
  }
  // Typed text (the phone viewer's on-screen keyboard): the Windows password on the lock or login screen comes this way
  // from a phone. Enter and Tab as keys, everything else as Unicode characters, in short lines the helper reads whole.
  if (event.action === "type") {
    const lines = []; let hex = "";
    const flush = () => { if (hex) { lines.push({ cmd: "in", t: "text", u: hex }); hex = ""; } };
    for (const ch of String(event.text || "").slice(0, 2000)) {
      if (ch === "\r") continue;
      if (ch === "\n" || ch === "\t") { flush(); const vk = ch === "\n" ? 0x0D : 0x09; lines.push({ cmd: "in", t: "key", vk, up: 0 }, { cmd: "in", t: "key", vk, up: 1 }); continue; }
      for (let i = 0; i < ch.length; i++) { hex += ch.charCodeAt(i).toString(16).padStart(4, "0"); if (hex.length >= 400) flush(); }
    }
    flush();
    try { for (const l of lines) p.stdin.write(JSON.stringify(l) + "\n"); } catch {}
    return true;
  }
  if (!m) return true;   // nothing the secure desktop takes (relative game moves): dropped
  try { p.stdin.write(JSON.stringify({ cmd: "in", ...m }) + "\n"); } catch {}
  return true;
}

ipcMain.on("execute-input", (_e, event) => {
  if (!inputReady || !event) return;
  try {
    if (_secureDesk) {
      let pt = null;
      if (event.action === "mousemove") {
        let d = captureDisplay;
        if (!d) { const p = screen.getPrimaryDisplay(); d = { boundsX: 0, boundsY: 0, width: p.size.width, height: p.size.height, scaleFactor: p.scaleFactor }; }
        const nx = Math.min(Math.max(Number(event.x) || 0, 0), 0.9999), ny = Math.min(Math.max(Number(event.y) || 0, 0), 0.9999);
        const dip = { x: d.boundsX + nx * d.width, y: d.boundsY + ny * d.height };
        pt = screen.dipToScreenPoint ? screen.dipToScreenPoint(dip) : { x: dip.x * d.scaleFactor, y: dip.y * d.scaleFactor };
      }
      if (helperInput(event, pt)) return;
    }
    switch (event.action) {
      case "mousemove": {
        // Viewer sends coordinates normalized to 0..1 of the captured monitor
        let d = captureDisplay;
        if (!d) { const p = screen.getPrimaryDisplay(); d = { boundsX: 0, boundsY: 0, width: p.size.width, height: p.size.height, scaleFactor: p.scaleFactor }; }
        // Clamp just inside the monitor so the far edge doesn't resolve to the neighbouring display.
        const nx = Math.min(Math.max(Number(event.x) || 0, 0), 0.9999), ny = Math.min(Math.max(Number(event.y) || 0, 0), 0.9999);
        const dip = { x: d.boundsX + nx * d.width, y: d.boundsY + ny * d.height };
        // DIP → physical pixels. Multiplying by ONE display's scale is only right when every monitor shares
        // it; with mixed DPI (e.g. 4K@200% next to 1080p@100%) clicks landed on the wrong monitor.
        // dipToScreenPoint (Windows) resolves the point against the display it actually lies on.
        const p = screen.dipToScreenPoint ? screen.dipToScreenPoint(dip) : { x: dip.x * d.scaleFactor, y: dip.y * d.scaleFactor };
        inputSim.moveMouse(p.x, p.y);
        break;
      }
      case "mousemove-rel": {
        // Game mode: relative motion so pointer-locked / raw-input games (Minecraft, FPS) move.
        inputSim.moveMouseRelative(event.dx, event.dy);
        break;
      }
      case "mousedown": inputSim.mouseDown(event.button); break;
      case "mouseup": inputSim.mouseUp(event.button); break;
      case "scroll": inputSim.mouseScroll(event.deltaX || 0, event.deltaY || 0); break;
      case "keydown": inputSim.keyDown(event.vk); break;
      case "keyup": inputSim.keyUp(event.vk); break;
      case "type": inputSim.typeText(event.text); break;   // phone viewer's on-screen keyboard
    }
  } catch (err) {
    console.error("Input execution error:", err.message);
  }
});

// Session ended or the link dropped: let go of every key/button the remote still holds on this PC.
ipcMain.on("release-remote-input", () => {
  if (inputReady) { try { inputSim.releaseAll(); } catch {} }
  // On the lock / login screen the keys went in through the helper: let go of the modifiers and buttons there too
  // (a Shift held when the session dropped stayed down on the lock screen; independent review 17 Nov).
  const p = _fast && _fast.proc;
  if (_secureDesk && p) {
    try {
      for (const vk of [0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5]) p.stdin.write(JSON.stringify({ cmd: "in", t: "key", vk, up: 1 }) + "\n");
      for (const b of ["left", "right", "middle"]) p.stdin.write(JSON.stringify({ cmd: "in", t: "up", b }) + "\n");
    } catch {}
  }
});

// ─── Clipboard ────────────────────────────────────────────
ipcMain.handle("clipboard-read", () => clipboard.readText());
// Electron 44+ made clipboard read/write async (Promise); returning it works on both old and new.
ipcMain.handle("clipboard-write", (_e, text) => clipboard.writeText(String(text ?? "")));

// ─── Files on the clipboard (owner 16 Nov: copy files with Ctrl+C on one PC, paste with Ctrl+V on the other) ───
// Windows only. The renderer moves the files with the file-manager queue; here: what files are on the clipboard,
// a fresh folder for files arriving that way, and putting those files on the clipboard. Only files inside that
// folder can ever be put there, so a peer can't make this PC's clipboard point at anything else.
const CLIP_ROOT = path.join(os.tmpdir(), "TryDesk-clip");
const clipPs = (script, env = {}) => new Promise((resolve) => {
  require("child_process").execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " + script],
    { windowsHide: true, timeout: 8000, encoding: "utf8", env: { ...process.env, ...env } }, (err, out) => resolve(err ? null : String(out || "")));
});
// The first file's path (CF "FileNameW"): cheap enough to look at every second, and changes with every new copy.
// Electron 45's clipboard can no longer read the file list (only has / read / readText / write), so Windows is asked
// directly (koffi, as input-simulator.js does): the clipboard's sequence number tells whether anything changed (cheap),
// and only then is the file list (CF_HDROP) read.
let _clipNative = null, _clipCache = { seq: -1, sig: "", paths: [] };
function clipNative() {
  if (_clipNative !== null) return _clipNative;
  _clipNative = false;
  if (process.platform !== "win32") return false;
  try {
    const koffi = require("koffi"), u = koffi.load("user32.dll"), s = koffi.load("shell32.dll");
    _clipNative = {
      seq: u.func("uint32 __stdcall GetClipboardSequenceNumber()"),
      avail: u.func("bool __stdcall IsClipboardFormatAvailable(uint32)"),
      open: u.func("bool __stdcall OpenClipboard(uintptr)"),
      close: u.func("bool __stdcall CloseClipboard()"),
      data: u.func("uintptr __stdcall GetClipboardData(uint32)"),
      dq: s.func("uint32 __stdcall DragQueryFileW(uintptr, uint32, void *, uint32)"),
    };
  } catch (err) { console.warn("clipboard files unavailable:", err && err.message); _clipNative = false; }
  return _clipNative;
}
const CF_HDROP = 15;
function clipFilePaths() {
  const c = clipNative(); if (!c || !c.avail(CF_HDROP) || !c.open(0)) return [];
  try {
    const h = c.data(CF_HDROP); if (!h) return [];
    const n = Math.min(c.dq(h, 0xFFFFFFFF, null, 0), 500), out = [];
    for (let i = 0; i < n; i++) {
      const len = c.dq(h, i, null, 0); if (!len || len > 32767) continue;
      const buf = Buffer.alloc((len + 1) * 2);
      c.dq(h, i, buf, len + 1);
      out.push(buf.toString("utf16le", 0, len * 2));
    }
    return out;
  } catch { return []; } finally { try { c.close(); } catch {} }
}
// "" = no files on the clipboard; otherwise the list of paths (changes with every new copy)
function clipFilesSig() {
  const c = clipNative(); if (!c) return "";
  let seq; try { seq = c.seq(); } catch { return ""; }
  if (seq !== _clipCache.seq) { const paths = clipFilePaths(); _clipCache = { seq, sig: paths.join("\n"), paths }; }
  return _clipCache.sig;
}
ipcMain.handle("clip-files-sig", (e) => (fromMain(e) && !_serviceHost ? clipFilesSig() : ""));
ipcMain.handle("clip-files-read", async (e) => {
  if (!fromMain(e) || _serviceHost || process.platform !== "win32") return { sig: "", entries: [] };
  const sig = clipFilesSig(); if (!sig) return { sig: "", entries: [] };
  const paths = _clipCache.paths.slice(0, 500);
  const entries = [];
  for (const p of paths) {
    if (!path.isAbsolute(p)) continue;
    try { const st = fs.statSync(p); entries.push({ path: p, name: path.basename(p), isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs }); } catch {}
  }
  return { sig, entries };
});
ipcMain.handle("clip-dir", (e) => {
  if (!fromMain(e) || _serviceHost || process.platform !== "win32") return { ok: false, error: "unsupported" };
  try {
    // folders left from earlier days go first
    try { for (const d of fs.readdirSync(CLIP_ROOT)) { const p = path.join(CLIP_ROOT, d); try { if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.rmSync(p, { recursive: true, force: true }); } catch {} } } catch {}
    const dir = path.join(CLIP_ROOT, require("crypto").randomBytes(6).toString("hex"));
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true, path: dir };
  } catch (err) { return { ok: false, error: err.code || err.message }; }
});
ipcMain.handle("clip-files-write", async (e, paths) => {
  if (!fromMain(e) || _serviceHost || process.platform !== "win32" || !Array.isArray(paths) || !paths.length || paths.length > 500) return { ok: false };
  const root = path.resolve(CLIP_ROOT) + path.sep;
  if (!paths.every((p) => typeof p === "string" && path.resolve(p).startsWith(root))) return { ok: false, error: "ditolak" };   // only TryDesk's own folder
  const ok = paths.map((p) => path.resolve(p)).filter((p) => fs.existsSync(p));   // (a name that arrived as " (1)" is left out)
  if (!ok.length) return { ok: false, error: "missing" };
  const res = await clipPs("$p = $env:TD_CLIP | ConvertFrom-Json; Set-Clipboard -LiteralPath $p; 'ok'", { TD_CLIP: JSON.stringify(ok) });
  return { ok: !!res && res.includes("ok"), sig: clipFilesSig() };
});

// ─── File transfer (streaming) ────────────────────────────
const readHandles = new Map();   // id -> { fd, size }
const writeHandles = new Map();  // id -> { fd }
let handleSeq = 0;

const _pickedPaths = new Set();   // files the person picked here (only those may go to the service's outbox)
ipcMain.handle("file-pick", async () => {
  // Development builds only: a fixed file instead of the Open dialog (end-to-end tests).
  if (!app.isPackaged && process.env.TRYDESK_TEST_PICK) { const p = process.env.TRYDESK_TEST_PICK; _pickedPaths.add(p); return [{ path: p, name: path.basename(p), size: fs.statSync(p).size }]; }
  const res = await dialog.showOpenDialog(mainWindow, { properties: ["openFile", "multiSelections"] });
  if (res.canceled) return [];
  return res.filePaths.map((p) => {
    const st = fs.statSync(p);
    _pickedPaths.add(p);
    return { path: p, name: path.basename(p), size: st.size };
  });
});

// Drag and drop (users' reports 9 Nov): files dropped on the window count as picked, like the Open dialog. Folders and
// anything that can't be read are left out, and counted apart so the renderer can say which (folders, or unreadable).
ipcMain.handle("file-dropped", (e, paths) => {
  if (_serviceHost || !fromMain(e) || !Array.isArray(paths)) return { files: [], folders: 0, unreadable: 0 };   // SYSTEM's window sends nothing it was handed
  const files = []; let folders = 0, unreadable = 0;
  for (const p of paths.slice(0, 50)) {
    if (typeof p !== "string" || !path.isAbsolute(p)) { unreadable++; continue; }
    let st = null; try { st = fs.statSync(p); } catch {}
    if (st && st.isDirectory()) { folders++; continue; }
    if (!st || !st.isFile()) { unreadable++; continue; }
    _pickedPaths.add(p);
    files.push({ path: p, name: path.basename(p), size: st.size });
  }
  return { files, folders, unreadable };
});

ipcMain.handle("file-save-dialog", async (_e, name) => {
  // Development builds only: save into a fixed folder instead of the Save dialog (end-to-end tests).
  if (!app.isPackaged && process.env.TRYDESK_TEST_SAVE_DIR) return path.join(process.env.TRYDESK_TEST_SAVE_DIR, path.basename(String(name || "file")));
  const res = await dialog.showSaveDialog(mainWindow, { defaultPath: name });
  return res.canceled ? null : res.filePath;
});

// Reject non-string / empty / NUL-byte paths before any fs call (hardening for the file IPC).
function cleanPath(p) {
  if (typeof p !== "string" || !p || p.indexOf("\0") !== -1) throw new Error("invalid path");
  return p;
}

// Every file handle below answers TryDesk's own window only (as the fast-capture handlers do).
// { path, offset } starts reading part-way: a transfer resumed after a dropped connection (owner 16 Nov, "lanjutkan
// transfer setelah koneksi putus") sends only what the other side doesn't have yet.
ipcMain.handle("file-open-read", (e, arg) => {
  if (!fromMain(e)) throw new Error("not allowed");
  const filePath = arg && typeof arg === "object" ? arg.path : arg;
  const id = `r${++handleSeq}`;
  const fd = fs.openSync(cleanPath(filePath), "r");
  const size = fs.fstatSync(fd).size;
  const off = arg && typeof arg === "object" && Number.isSafeInteger(arg.offset) && arg.offset > 0 ? Math.min(arg.offset, size) : 0;
  readHandles.set(id, { fd, size, pos: off });
  return id;
});

ipcMain.handle("file-read-chunk", (e, { id, length }) => {
  const h = fromMain(e) ? readHandles.get(id) : null;
  if (!h) return null;
  const len = Math.max(1, Math.min(Number(length) || 0, 1024 * 1024));   // never allocate what the caller asks blindly
  const buf = Buffer.alloc(len);
  const at = typeof h.pos === "number" ? h.pos : null;   // (the service's handles have no position: read on in order)
  const n = fs.readSync(h.fd, buf, 0, len, at);
  if (at != null && n > 0) h.pos += n;
  if (n <= 0) return { done: true, chunk: new Uint8Array(0) };
  return { done: false, chunk: new Uint8Array(buf.buffer, buf.byteOffset, n) };
});

ipcMain.handle("file-close-read", (e, id) => {
  const h = fromMain(e) ? readHandles.get(id) : null;
  if (h) { try { fs.closeSync(h.fd); } catch {} readHandles.delete(id); }
});

ipcMain.handle("file-open-write", (e, filePath) => {
  if (!fromMain(e)) throw new Error("not allowed");
  const id = `w${++handleSeq}`;
  const p = cleanPath(filePath);
  writeHandles.set(id, { fd: fs.openSync(p, "w"), path: p });
  return id;
});

// Resumable transfers (16 Nov 2026). A file-manager transfer that carries a resume key ("rk", made by the viewer from
// the source path, size, date and destination) is written into "<name>.<random>.trydesk-part" and renamed when whole.
// When the connection DROPS (not when someone cancels) the part file is kept here under its key; the same transfer
// asked again after reconnecting continues at the part's length instead of starting over. Parts never picked up again
// are removed after 6 hours or when TryDesk quits, so no half files stay behind.
const resumeParts = new Map();   // rk -> { part, final, noClobber, at }
const RESUME_MAX_AGE = 6 * 3600 * 1000;
function resumeSweep() {
  for (const [k, r] of resumeParts) if (Date.now() - r.at > RESUME_MAX_AGE) { try { fs.unlinkSync(r.part); } catch {} resumeParts.delete(k); }
}
app.on("will-quit", () => { for (const r of resumeParts.values()) { try { fs.unlinkSync(r.part); } catch {} } resumeParts.clear(); });
const validRk = (rk) => typeof rk === "string" && rk.length > 0 && rk.length <= 4096;
// How much of a transfer this PC already holds (a download about to resume asks before requesting the rest).
ipcMain.handle("file-resume-have", (e, rk) => {
  if (!fromMain(e) || !validRk(rk)) return 0;
  resumeSweep();
  const r = resumeParts.get(rk); if (!r) return 0;
  try { return fs.statSync(r.part).size; } catch { resumeParts.delete(rk); return 0; }
});

// Open a write handle targeting a directory + name (used by the file manager).
// Returns the resolved path, de-duplicated so an incoming file never silently clobbers an existing one.
ipcMain.handle("file-open-write-in", (e, { dir, name, replace, rk, want }) => {
  if (!fromMain(e)) throw new Error("not allowed");
  cleanPath(dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error("invalid directory");
  // The page cleans the name already; cleaned here again (security audit 22 Nov): no ":" stream names, device names or
  // trailing dots on Windows, whatever the page sent.
  const safeName = process.platform === "win32" ? winSafeName(name || "file") : path.basename(String(name || "file"));
  let target = path.join(dir, safeName);
  if (validRk(rk)) {
    resumeSweep();
    const r = resumeParts.get(rk);
    resumeParts.delete(rk);
    if (r) {
      // Continue the part kept for this transfer, cut to exactly what the sender will send from ("want").
      let have = -1; try { have = fs.statSync(r.part).size; } catch {}
      const to = want == null ? have : Number(want);
      if (have >= 0 && Number.isSafeInteger(to) && to >= 0 && to <= have && path.dirname(r.part) === path.resolve(dir)) {
        const fd = fs.openSync(r.part, "r+");
        fs.ftruncateSync(fd, to);
        const id = `w${++handleSeq}`;
        writeHandles.set(id, { fd, path: r.part, final: r.final, noClobber: r.noClobber, rk, pos: to });
        return { id, path: r.final, have: to };
      }
      try { fs.unlinkSync(r.part); } catch {}   // can't be continued: start over
    }
    // A new resumable transfer: always into a part file, renamed when whole (a name taken by then gets " (1)").
    if (!replace && fs.existsSync(target)) {
      const ext = path.extname(safeName), base = safeName.slice(0, safeName.length - ext.length);
      let n = 1;
      do { target = path.join(dir, `${base} (${n})${ext}`); n++; } while (fs.existsSync(target));
    }
    const part = `${target}.${require("crypto").randomBytes(4).toString("hex")}.trydesk-part`;
    const id = `w${++handleSeq}`;
    writeHandles.set(id, { fd: fs.openSync(part, "wx"), path: part, final: target, noClobber: !replace, rk, pos: 0 });
    return { id, path: target, have: 0 };
  }
  // "Ganti" in File sudah ada: write beside it and swap in only when the whole file arrived (file-close-write), so a
  // cancelled or broken transfer never costs the old file.
  if (replace && fs.existsSync(target) && fs.statSync(target).isFile()) {
    const part = `${target}.${require("crypto").randomBytes(4).toString("hex")}.trydesk-part`;
    const id = `w${++handleSeq}`;
    writeHandles.set(id, { fd: fs.openSync(part, "wx"), path: part, final: target });
    return { id, path: target };
  }
  if (fs.existsSync(target)) {
    const ext = path.extname(safeName);
    const base = safeName.slice(0, safeName.length - ext.length);
    let n = 1;
    do { target = path.join(dir, `${base} (${n})${ext}`); n++; } while (fs.existsSync(target));
  }
  const id = `w${++handleSeq}`;
  writeHandles.set(id, { fd: fs.openSync(target, "w"), path: target });
  return { id, path: target };
});

ipcMain.handle("file-write-chunk", (e, { id, chunk }) => {
  const h = fromMain(e) ? writeHandles.get(id) : null;
  if (!h) return false;
  const buf = Buffer.from(chunk);
  if (typeof h.pos === "number") { fs.writeSync(h.fd, buf, 0, buf.length, h.pos); h.pos += buf.length; }   // (a resumed part is written at its end)
  else fs.writeSync(h.fd, buf, 0, buf.length, null);
  return true;
});

// Deleting a cancelled partial file only ever touches the file THIS handle created, never a path the caller names.
// keep: the connection dropped mid-transfer: a resumable part stays (see resumeParts) for the same transfer later.
ipcMain.handle("file-close-write", (e, { id, deleteFile, keep }) => {
  const h = fromMain(e) ? writeHandles.get(id) : null;
  if (!h) return;
  try { fs.closeSync(h.fd); } catch {}
  writeHandles.delete(id);
  if (keep && h.rk && h.final && h.path !== h.final) { resumeParts.set(h.rk, { part: h.path, final: h.final, noClobber: !!h.noClobber, at: Date.now() }); return { kept: true }; }
  if (h.noClobber && h.final && !deleteFile) {
    // a new file (not "Ganti"): if its name was taken while it travelled, it gets the next free one
    if (fs.existsSync(h.final)) {
      const dir = path.dirname(h.final), ext = path.extname(h.final), base = path.basename(h.final, ext);
      for (let n = 1; n < 1000; n++) { const t = path.join(dir, `${base} (${n})${ext}`); if (!fs.existsSync(t)) { h.final = t; break; } }
    }
    try { fs.renameSync(h.path, h.final); h.path = h.final; } catch { try { fs.unlinkSync(h.path); } catch {} return { swapFailed: true }; }
    markZone(h.path);
    return { path: h.path };
  }
  // The service deletes as the user: the folder is theirs, and a junction swapped in after the file was opened must
  // never make SYSTEM delete a file somewhere else (security review 13 Nov).
  if (deleteFile && h.path) { try { const del = () => fs.unlinkSync(h.path); if (_serviceHost) asUser(del); else del(); } catch {} return; }
  if (h.final) {   // a complete replacement: swap it in over the old file
    const swap = () => { fs.renameSync(h.path, h.final); h.path = h.final; };
    try { if (_serviceHost) asUser(swap); else swap(); }
    catch {
      // The old file is open in another program (or read-only): keep the new one beside it under a free name.
      const keep = () => {
        const dir = path.dirname(h.final), ext = path.extname(h.final), base = path.basename(h.final, ext);
        for (let n = 1; n < 1000; n++) { const t = path.join(dir, `${base} (${n})${ext}`); if (!fs.existsSync(t)) { fs.renameSync(h.path, t); return t; } }
        throw new Error("no free name");
      };
      try { const kept = _serviceHost ? asUser(keep) : keep(); h.path = kept; markZone(h.path); return { swapFailed: true, kept }; }
      catch { try { const del = () => fs.unlinkSync(h.path); if (_serviceHost) asUser(del); else del(); } catch {} return { swapFailed: true }; }
    }
  }
  // Mark a successfully received file as coming from the Internet (Zone 3) so Windows SmartScreen and
  // Office Protected View still warn before it is run/opened, a file pushed over TryDesk is untrusted.
  markZone(h.path);
});
function markZone(p) {
  if (!p || process.platform !== "win32") return;
  const mark = () => fs.writeFileSync(`${p}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n");
  try { if (_serviceHost) asUser(mark); else mark(); } catch {}   // the service writes it as the user (their file)
}

// ─── File transfer in the service's sessions (owner's request 8 Nov, see "One TryDesk") ───
// The person at the PC sends from their own TryDesk and receives into their own Downloads\TryDesk. The service runs
// as SYSTEM, which can open ANY file, so it never opens a path anyone names:
//   send:    the user's TryDesk copies a file the person picked into %APPDATA%\TryDesk\svc-outbox\<16 hex>\; the
//            service opens only that one regular file (no symlink / junction / hard link, inside the user's profile)
//   receive: the service creates a NEW file (never overwrites) in <profile>\Downloads\TryDesk, the folder checked the
//            same way, and marks it as from the Internet (Zone.Identifier, see file-close-write)
// The file manager (browsing this PC's disks) stays off in the service's sessions.
const OUTBOX_ID = /^[0-9a-f]{16}$/;
const _svcProfRoot = (() => { const a = process.argv.find((x) => x.startsWith("--user-profile=")); return a ? a.slice(15) : ""; })();
// Every open below runs AS THE SIGNED-IN USER (Windows impersonation): SYSTEM then gets only what that user could open
// themselves, whatever links, junctions or hard links lie in the way, and redirected folders (Downloads on D:, OneDrive)
// work. Handles opened this way keep working after RevertToSelf. A released service that can't impersonate refuses.
let _w32 = null;
function w32() {
  if (_w32) return _w32;
  const koffi = require("koffi"), k32 = koffi.load("kernel32.dll"), adv = koffi.load("advapi32.dll"), wts = koffi.load("wtsapi32.dll"), sh = koffi.load("shell32.dll"), ole = koffi.load("ole32.dll");
  const GUID = koffi.struct("TD_GUID", { a: "uint32", b: "uint16", c: "uint16", d: koffi.array("uint8", 8) });
  _w32 = { koffi, GUID,
    sessionOf: k32.func("int __stdcall ProcessIdToSessionId(uint32 pid, _Out_ uint32 *sid)"),
    userToken: wts.func("int __stdcall WTSQueryUserToken(uint32 sid, _Out_ void **tok)"),
    impersonate: adv.func("int __stdcall ImpersonateLoggedOnUser(void *tok)"),
    revert: adv.func("int __stdcall RevertToSelf()"),
    close: k32.func("int __stdcall CloseHandle(void *h)"),
    folder: sh.func("int __stdcall SHGetKnownFolderPath(TD_GUID *id, uint32 flags, void *tok, _Out_ void **path)"),
    free: ole.func("void __stdcall CoTaskMemFree(void *p)") };
  return _w32;
}
function svcUserToken() {
  try { const w = w32(), s = [0], t = [null]; if (!w.sessionOf(process.pid, s) || !w.userToken(s[0], t) || !t[0]) return null; return t[0]; } catch { return null; }
}
// Running as SYSTEM (or as a machine account): never do a file call "as is" then, whatever the build.
// (by name, and by the machine-account form the service's environment carries: "SYSTEM" has other names in other
// Windows languages, such as "Système")
const _asSystem = (() => { try { const u = String(os.userInfo().username || ""); return /^(system|syst[eè]me|sistema|systeem)$/i.test(u) || /\$$/.test(u) || /\$$/.test(String(process.env.USERNAME || "")); } catch { return true; } })();
function asUser(fn) {
  const tok = svcUserToken();
  // dev only: a source run that is NOT SYSTEM is already the user. Packaged, or SYSTEM: nobody signed in = refuse.
  if (!tok) { if (app.isPackaged || _asSystem) throw new Error("no signed-in user"); return fn(); }
  const w = w32();
  if (!w.impersonate(tok)) { w.close(tok); throw new Error("impersonation failed"); }
  try { return fn(); }
  finally {
    // Still impersonating after this would run the rest of the service as the user, or worse: stop instead.
    if (!w.revert()) { try { logInfo("RevertToSelf failed: the service host stops"); } catch {} process.exit(1); }
    w.close(tok);
  }
}
// The user's real Downloads / Roaming AppData (they can be moved); the profile folder when there is no token (dev).
function userFolder(guid, fallback) {
  // Nobody signed in (packaged, or SYSTEM): "" — never a guessed folder SYSTEM would then use. Callers check.
  const tok = svcUserToken(); if (!tok) return app.isPackaged || _asSystem ? "" : fallback;
  try {
    const w = w32(), out = [null];
    const id = { a: guid[0], b: guid[1], c: guid[2], d: guid[3] };
    // KF_FLAG_DONT_VERIFY (0x4000): SYSTEM must not touch the folder to check it. The user can point their own
    // folders anywhere (registry, HKCU): a share (\\server\x) would make SYSTEM itself reach out to that machine and
    // hand it this computer's sign-in (audit 19 Nov, TD-VULN-01). Only a local drive path counts.
    if (w.folder(id, 0x4000, tok, out) !== 0 || !out[0]) return fallback;
    let p; try { p = w.koffi.decode(out[0], "char16_t", -1); } finally { w.free(out[0]); }
    return /^[A-Za-z]:\\/.test(p || "") && !/^[A-Za-z]:\\\\/.test(p) ? p : "";
  } catch { return fallback; } finally { try { w32().close(tok); } catch {} }
}
const FOLDERID_Downloads = [0x374DE290, 0x123F, 0x4565, [0x91, 0x64, 0x39, 0xC4, 0x92, 0x5E, 0x46, 0x7B]];
const FOLDERID_RoamingAppData = [0x3EB685DB, 0x65F9, 0x4CF6, [0xA0, 0x3A, 0xE3, 0xEF, 0x65, 0x72, 0x9F, 0x3D]];
const FOLDERID_Profile = [0x5E6C858F, 0x0E22, 0x4760, [0x9A, 0xFE, 0xEA, 0x33, 0x17, 0xB6, 0x71, 0x73]];
// "" when nobody is signed in (never a relative path). Not tied to --user-profile: a host started at the login screen
// serves the user who signs in later in the same session.
const svcOutboxBase = () => { const r = userFolder(FOLDERID_RoamingAppData, _svcProfRoot ? path.join(_svcProfRoot, "AppData", "Roaming") : ""); return r && path.isAbsolute(r) ? path.join(r, "TryDesk", "svc-outbox") : ""; };
const svcInboxDir = () => { const r = userFolder(FOLDERID_Downloads, _svcProfRoot ? path.join(_svcProfRoot, "Downloads") : ""); return r && path.isAbsolute(r) ? path.join(r, "TryDesk") : ""; };
// The signed-in user's own %APPDATA%\TryDesk, looked up from the live token on every call: --user-profile is fixed
// when the host starts (empty at the login screen after a restart, while that user may sign in later). "" = nobody.
// Everything the service reads or writes there goes through svcUserRead / svcUserWrite / svcUserMtime, AS THAT
// USER: the folder is the user's, so a junction or link planted in it must never make SYSTEM read or write
// somewhere else (security review 13 Nov: SYSTEM wrote service-ui.json there itself).
// (cached 3 s: the watchers ask several times a second, and each look-up queries the user's token)
let _svcUserDir = { at: 0, v: "" };
function svcUserDir() {
  if (Date.now() - _svcUserDir.at < 3000) return _svcUserDir.v;
  const r = userFolder(FOLDERID_RoamingAppData, _svcProfRoot ? path.join(_svcProfRoot, "AppData", "Roaming") : "");
  _svcUserDir = { at: Date.now(), v: r && path.isAbsolute(r) ? path.join(r, "TryDesk") : "" };
  return _svcUserDir.v;
}
const svcUserFile = (name) => { const d = svcUserDir(); return d ? path.join(d, name) : ""; };
function svcUserRead(name) { const f = svcUserFile(name); if (!f) return null; try { return asUser(() => fs.readFileSync(f, "utf8")); } catch { return null; } }
function svcUserJson(name) { const t = svcUserRead(name); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } }
function svcUserWrite(name, text) { const f = svcUserFile(name); if (!f) return false; try { asUser(() => fs.writeFileSync(f, text)); return true; } catch { return false; } }
// -1 = nobody signed in / no folder, 0 = the file isn't there, else its time.
function svcUserMtime(name) {
  const f = svcUserFile(name); if (!f) return -1;
  // (only "not there" is 0; a file that can't be looked at counts as "nobody", so nothing fires on it)
  try { return asUser(() => { try { return fs.statSync(f).mtimeMs; } catch (err) { return err.code === "ENOENT" ? 0 : -1; } }); } catch { return -1; }
}
// A changed file in that folder, polled as the user (fs.watchFile would stat it as SYSTEM, on another thread).
// Fires for a change seen after the first look, like fs.watchFile; a file that appears later counts as a change.
function svcUserWatch(name, ms, onChange) {
  let last = null;
  setInterval(() => {
    const m = svcUserMtime(name);
    if (m < 0) return;                    // nobody signed in yet: start looking once someone is
    if (last === null) { last = m; return; }
    if (m > last) { last = m; onChange(); }
  }, ms);
}
// A name that is just a name on Windows: no folders, no reserved device names, no trailing dots or spaces.
function winSafeName(name) {
  let n = path.basename(String(name || "")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").slice(0, 180);
  if (!n || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = "file" + (n ? "_" + n : "");
  return n;
}
if (_serviceHost) {
  ipcMain.handle("svc-outbox-open", (e, id) => {
    if (!fromMain(e) || !OUTBOX_ID.test(String(id))) throw new Error("not allowed");
    const base = svcOutboxBase(); if (!base) throw new Error("no signed-in user");
    const dir = path.join(base, String(id));   // (the folder's NAME is looked up first; every open is as the user)
    return asUser(() => {
      if (!fs.statSync(dir).isDirectory()) throw new Error("not a folder");
      const names = fs.readdirSync(dir); if (names.length !== 1) throw new Error("one file expected");
      const fd = fs.openSync(path.join(dir, names[0]), "r");   // as the user: only what they may read
      const st = fs.fstatSync(fd);
      if (!st.isFile()) { fs.closeSync(fd); throw new Error("not a file"); }
      const rid = `r${++handleSeq}`;
      readHandles.set(rid, { fd, size: st.size });
      return { id: rid, name: names[0], size: st.size };
    });
  });
  ipcMain.handle("svc-outbox-done", (e, id) => {
    if (!fromMain(e) || !OUTBOX_ID.test(String(id)) || !svcOutboxBase()) return;
    const dir = path.join(svcOutboxBase(), String(id));
    try { asUser(() => { for (const n of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, n)); fs.rmdirSync(dir); }); } catch {}
  });
  ipcMain.handle("svc-inbox-open", (e, { name }) => {
    if (!fromMain(e)) throw new Error("not allowed");
    const dir = svcInboxDir();
    if (!dir) throw new Error("no signed-in user");
    return asUser(() => {
      fs.mkdirSync(dir, { recursive: true });   // as the user: theirs, and only where they may write
      const safe = winSafeName(name), ext = path.extname(safe), base = safe.slice(0, safe.length - ext.length);
      for (let n = 0; n < 1000; n++) {
        const target = path.join(dir, n ? `${base} (${n})${ext}` : safe);
        let fd; try { fd = fs.openSync(target, "wx"); } catch (err) { if (err.code === "EEXIST") continue; throw err; }   // new files only
        const id = `w${++handleSeq}`;
        writeHandles.set(id, { fd, path: target });
        return { id, path: target };
      }
      throw new Error("no free name");
    });
  });
} else {
  // The user's TryDesk: copy a file the person picked into the outbox the service may read (one file per folder).
  ipcMain.handle("svc-outbox-put", async (e, filePath) => {
    if (!fromMain(e) || typeof filePath !== "string" || !_pickedPaths.has(filePath)) throw new Error("not allowed");
    const id = require("crypto").randomBytes(8).toString("hex");
    const dir = path.join(app.getPath("userData"), "svc-outbox", id);
    fs.mkdirSync(dir, { recursive: true });
    const name = winSafeName(path.basename(filePath));
    await fs.promises.copyFile(filePath, path.join(dir, name));
    return { id, name, size: fs.statSync(path.join(dir, name)).size };
  });
  // Leftovers of a session that ended mid-send (older than a day) go.
  app.whenReady().then(() => {
    const box = path.join(app.getPath("userData"), "svc-outbox");
    try { for (const n of fs.readdirSync(box)) { const d = path.join(box, n); if (Date.now() - fs.statSync(d).mtimeMs > 86400000) fs.rmSync(d, { recursive: true, force: true }); } } catch {}
  });
}

// ─── Filesystem browsing (file manager) ──────────────────
function listDrives() {
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const d = String.fromCharCode(c) + ":\\";
    try { if (fs.existsSync(d)) drives.push(d); } catch {}
  }
  return drives;
}

// List a directory into { name, path, isDir, size, mtime } rows.
// An empty/null path yields the "This PC" root: a Home shortcut followed by the available drives.
function listDirectory(dirPath, homeDir = os.homedir()) {
  if (!dirPath) {
    const home = homeDir;
    const entries = [{ name: `Home, ${path.basename(home) || home}`, path: home, isDir: true, size: 0, mtime: 0, kind: "home" }];
    for (const d of listDrives()) entries.push({ name: d, path: d, isDir: true, size: 0, mtime: 0, kind: "drive" });
    return { ok: true, path: "", display: "Komputer ini", parent: null, isRoot: true, entries };
  }
  let items;
  try { items = fs.readdirSync(dirPath, { withFileTypes: true }); }
  catch (e) { return { ok: false, error: e.code || e.message, path: dirPath, display: dirPath }; }
  const entries = [];
  for (const it of items) {
    const full = path.join(dirPath, it.name);
    let isDir = false, size = 0, mtime = 0;
    try {
      const st = fs.statSync(full);
      isDir = st.isDirectory(); size = st.size; mtime = st.mtimeMs;
    } catch {
      try { const ls = fs.lstatSync(full); isDir = ls.isDirectory(); size = ls.size; mtime = ls.mtimeMs; }
      catch { isDir = it.isDirectory(); }
    }
    entries.push({ name: it.name, path: full, isDir, size, mtime });
  }
  const parent = path.dirname(dirPath);
  const atRoot = parent === dirPath; // drive root like "C:\" → go up to This PC
  return { ok: true, path: dirPath, display: dirPath, parent: atRoot ? "" : parent, isRoot: false, entries };
}

ipcMain.handle("fs-home", (e) => (fromMain(e) ? os.homedir() : ""));
ipcMain.handle("fs-list", (e, dirPath) => (fromMain(e) ? listDirectory(dirPath) : { ok: false, error: "not allowed", path: "", display: "" }));

// File Transfer tools (16 Nov): new folder, rename, delete, free space, "already there?". The renderer runs them for
// this PC, and for the other PC only after the same permission and path checks as listing (app.js handleFsOp).
// Delete goes to the Recycle Bin, never straight off the disk.
function diskInfo(p) {
  try { const s = fs.statfsSync(path.parse(p).root || p); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { return null; }
}
function fsOpSync(o) {
  const op = o && o.op;
  if (op === "disk") return { ok: true, disk: diskInfo(cleanPath(o.path)) };
  if (op === "mkdir") {
    const dir = cleanPath(o.path), name = winSafeName(o.name);
    const t = path.join(dir, name);
    if (fs.existsSync(t)) return { ok: false, error: "exists", name };
    fs.mkdirSync(t);
    return { ok: true, path: t, name };
  }
  if (op === "mkdirp") {   // a folder being copied over: the whole chain, existing parts are fine
    const p = cleanPath(o.path);
    fs.mkdirSync(p, { recursive: true });
    if (!fs.statSync(p).isDirectory()) return { ok: false, error: "notdir" };
    return { ok: true, path: p };
  }
  if (op === "rename") {
    const from = cleanPath(o.path), name = winSafeName(o.name);
    const to = path.join(path.dirname(from), name);
    if (to === from) return { ok: true, path: to };
    if (fs.existsSync(to) && to.toLowerCase() !== from.toLowerCase()) return { ok: false, error: "exists", name };
    fs.renameSync(from, to);
    return { ok: true, path: to, name };
  }
  if (op === "exists") {   // which of these names are already in dir (for "File sudah ada")
    const dir = cleanPath(o.path);
    const names = Array.isArray(o.names) ? o.names.slice(0, 2000).map((n) => winSafeName(n)) : [];
    const out = [];
    for (const n of names) { try { const st = fs.statSync(path.join(dir, n)); out.push({ name: n, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }); } catch {} }
    return { ok: true, found: out };
  }
  return { ok: false, error: "unknown" };
}
// Why the Recycle Bin refused an item (shell.trashItem only says it failed): a file is opened for reading, then for
// writing, without changing it. "busy" = held open by another program, "perm" = no permission, "gone" = no longer
// there, "" = not known (a folder, or the open worked). (21 Nov: the message only said "1 item tidak bisa dihapus".)
async function whyNoTrash(p) {
  try {
    const st = await fs.promises.lstat(p);
    if (st.isDirectory()) return "";
    for (const mode of ["r", "r+"]) { const h = await fs.promises.open(p, mode); await h.close(); }
    return "";
  } catch (e) {
    const c = e && e.code;
    return c === "EBUSY" ? "busy" : c === "EPERM" || c === "EACCES" ? "perm" : c === "ENOENT" ? "gone" : "";
  }
}
async function fsOpRun(o) {
  try {
    if (o && o.op === "delete") {
      const paths = Array.isArray(o.paths) ? o.paths.slice(0, 500).map(cleanPath) : [];
      let failed = 0; const fails = [];   // which ones and why (at most 20 named), so the message can say it
      for (const p of paths) { try { await shell.trashItem(p); } catch { failed++; if (fails.length < 20) fails.push({ name: path.basename(p), why: await whyNoTrash(p) }); } }
      return { ok: failed === 0, failed, done: paths.length - failed, fails };
    }
    return fsOpSync(o);
  } catch (err) { return { ok: false, error: err.code || err.message }; }
}
ipcMain.handle("fs-op", (e, o) => (fromMain(e) ? fsOpRun(o) : { ok: false, error: "not allowed" }));

// ─── Black screen (privacy mode) ─────────────────────────
const WDA_EXCLUDEFROMCAPTURE = 0x11;

// One cover per display, excluded from capture before it turns opaque (see below). Returns null (and covers nothing)
// when Windows refuses the exclusion: koffi missing, or Windows 10 before 2004, where the flag means "black in
// captures". The viewer would then see a black screen, so the host must say "failed" instead of pretending.
function buildBlackScreenWindow(display) {
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    show: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    transparent: false,
    backgroundColor: "#000000",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  // Click-through: the remote's injected clicks and wheel must reach the apps under the dark cover.
  try { win.setIgnoreMouseEvents(true); } catch {}
  win.loadURL("data:text/html,<body style=\"background:#000;margin:0;cursor:none;overflow:hidden\"><div style=\"display:flex;align-items:center;justify-content:center;height:100vh;color:%23333;font-family:sans-serif;font-size:14px\">" + L("TryDesk - Layar digelapkan", "TryDesk - Screen darkened") + "</div></body>");
  // The exclusion only sticks on a shown window (set before the first show, Windows reports success and the cover
  // still appears in captures: the viewer got a black picture). So: show it fully transparent, exclude it, and only
  // then make it opaque. Neither the viewer nor the person at the PC sees an in-between frame.
  win.setOpacity(0);
  win.showInactive();
  let excluded = false;
  try {
    const hwnd = win.getNativeWindowHandle().readUInt32LE(0);
    excluded = !!inputSim.setWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
  } catch (e) { logInfo("black screen: SetWindowDisplayAffinity threw " + e.message); }
  if (!excluded) { try { win.destroy(); } catch {} return null; }
  win.setOpacity(1);
  // Windows clamps a new window to the size limits of the display it starts on, so a portrait monitor's
  // overlay came out 1080x1080 and left the lower part of the screen visible. Re-apply the exact bounds now
  // that the window sits on its own display.
  try { win.setBounds(display.bounds); } catch {}
  win._tdDisplay = display.id;
  return win;
}

let blackScreenTick = null;
function enableBlackScreen() {
  // Already dark: keep the same covers (closing and re-opening them showed the desktop for a moment).
  if (blackScreenWindows.length) { syncBlackScreen(); return true; }
  // Before Windows 10 2004 (build 19041) the exclude flag silently acts as "show black in captures" instead.
  const build = Number(String(os.release()).split(".")[2] || 0);
  if (process.platform === "win32" && build && build < 19041) { logInfo("black screen: Windows build " + build + " cannot exclude windows from capture"); return false; }
  for (const display of screen.getAllDisplays()) {
    const win = buildBlackScreenWindow(display);
    if (!win) { disableBlackScreen(); logInfo("black screen: capture exclusion refused, not darkening"); return false; }
    blackScreenWindows.push(win);
  }
  // Keep the covers on top and on their displays: a window raised later (Task Manager "always on top", TryDesk's
  // own pinned window) would otherwise sit above them, and mixed-DPI monitors can resize a cover after it opens.
  // The raise itself never moves or resizes a cover (SetWindowPos with NOMOVE | NOSIZE, input-simulator.js).
  clearInterval(blackScreenTick);
  blackScreenTick = setInterval(syncBlackScreen, 1000);
  return true;
}

// Display added, removed, resized, rotated or rescaled while dark: the new area must be covered too.
function syncBlackScreen() {
  if (!blackScreenWindows.length) return;
  const displays = screen.getAllDisplays();
  const live = blackScreenWindows.filter((w) => !w.isDestroyed());
  const byId = new Map(live.map((w) => [w._tdDisplay, w]));
  const keep = [];
  for (const d of displays) {
    let w = byId.get(d.id);
    if (w) byId.delete(d.id);
    else {
      w = buildBlackScreenWindow(d);
      if (!w) {
        // A display we can't cover without blacking out the viewer's picture: half a dark screen is no privacy, so
        // all covers go and the viewer is told it failed (the renderer turns this into privacy-result "failed").
        logInfo("black screen: new display could not be excluded from capture, lifting all covers");
        for (const x of keep.concat([...byId.values()])) { try { x.destroy(); } catch {} }
        blackScreenWindows = [];
        disableBlackScreen();
        try { mainWindow && mainWindow.webContents.send("privacy-released", "failed"); } catch {}
        return;
      }
    }
    const b = w.getBounds();
    if (b.x !== d.bounds.x || b.y !== d.bounds.y || b.width !== d.bounds.width || b.height !== d.bounds.height) { try { w.setBounds(d.bounds); } catch {} }
    try { inputSim.raiseTopmost(w.getNativeWindowHandle().readUInt32LE(0)); } catch {}
    keep.push(w);
  }
  for (const w of byId.values()) { try { w.destroy(); } catch {} }   // its display is gone
  blackScreenWindows = keep;
}

function disableBlackScreen() {
  clearInterval(blackScreenTick); blackScreenTick = null;
  for (const w of blackScreenWindows) { try { w.destroy(); } catch {} }
  blackScreenWindows = [];
}

const PANIC_KEY = "Ctrl+Alt+Shift+Escape";
let panicKeyYielded = false;
function ensurePanicKey() {
  if (panicKeyYielded) return;
  try {
    if (globalShortcut.isRegistered(PANIC_KEY)) return;
    const ok = globalShortcut.register(PANIC_KEY, () => {
      logInfo("panic key: releasing black screen and input lock");
      disableBlackScreen(); disableInputLock();
      try { mainWindow && mainWindow.webContents.send("privacy-released"); } catch {}
    });
    if (!ok && _serviceHost) return;   // the user's app still holds it; retried
    logInfo("panic key " + PANIC_KEY + (ok ? " registered" : " NOT registered (another program holds it)"));
  } catch {}
}
ipcMain.on("panic-key-yield", (_e, yieldIt) => {
  if (_serviceHost) return;
  panicKeyYielded = !!yieldIt;
  try { if (panicKeyYielded) globalShortcut.unregister(PANIC_KEY); else ensurePanicKey(); } catch {}
});

ipcMain.handle("enable-black-screen", () => ({ ok: enableBlackScreen() }));
ipcMain.handle("disable-black-screen", () => { disableBlackScreen(); return true; });

// ─── Lock host input ──────────────────────────────────────
let inputLockActive = false;

// Returns whether the lock really took: Win32 BlockInput fails without administrator rights, and the viewer
// must not be told the host is locked when it isn't.
function enableInputLock() {
  if (inputLockActive) return true;
  inputLockActive = !!inputSim.blockInput(true);
  return inputLockActive;
}

function disableInputLock() {
  // Always attempt to unblock, even if the flag drifted, so input can never stay stuck.
  inputLockActive = false;
  try { inputSim.blockInput(false); } catch {}
}

ipcMain.handle("enable-input-lock", () => enableInputLock());
ipcMain.handle("disable-input-lock", () => { disableInputLock(); return true; });

// ─── The service's host runs as SYSTEM, and its window sits on the user's desktop ───
// Anything there that opens a file dialog, a browser or a file by path would hand SYSTEM to whoever sits at the PC
// (a Save dialog can start any program; a link opens a browser as SYSTEM), and file transfer would read or write
// any file on the PC. All of that is switched off here, after every handler above is registered.
if (_serviceHost) {
  // (file-read-chunk / file-close-read / file-write-chunk / file-close-write stay: they only act on a handle, and here
  // the only handles come from svc-outbox-open and svc-inbox-open, never from a path.)
  const DENY_HANDLE = ["file-pick", "file-save-dialog", "file-open-write", "relaunch-as-admin", "set-login-item",
    "set-hw-accel", "check-update", "lan-host", "lan-open"];
  for (const ch of DENY_HANDLE) { ipcMain.removeHandler(ch); ipcMain.handle(ch, () => { throw new Error("not available in the TryDesk service"); }); }
  // ── The viewer's file manager in the service's sessions (owner 13 Nov: "full akses seperti biasanya") ──
  // Every path-based call runs AS THE SIGNED-IN USER (asUser: synchronous calls on this thread only), so the viewer
  // gets exactly what that person could open themselves; SYSTEM's own rights are never used for a path. Walls:
  //   - local drive paths only ("C:\..."): no \\server (the user's network credentials), no \\?\ or \\.\ (devices),
  //     no ":" after the drive (alternate data streams), no ".asar" (Electron's archive layer);
  //   - after opening, a regular file only (a link to a pipe would block this thread for good);
  //   - new files only ("wx"), names cleaned (winSafeName);
  //   - nobody signed in (login screen) = refused, never a SYSTEM fallback.
  // Each remote list / open is logged (folder or file, result) in the service's own log (administrators only).
  const svcPathOk = (p) => typeof p === "string" && p.length < 2048 && !p.includes("\0") && /^[A-Za-z]:\\/.test(p)
    && p.indexOf(":", 2) === -1 && !/[\\/]{2}/.test(p.slice(2)) && !/\.asar(?:[\\/]|$)/i.test(p);
  const svcHome = () => { const h = userFolder(FOLDERID_Profile, _svcProfRoot); return h && path.isAbsolute(h) ? h : ""; };
  const noUser = (e) => /no signed-in user|impersonation failed/.test(String(e && e.message));
  const svcLog = (what, p, ok) => { try { logInfo(`service files: ${what} ${p} -> ${ok}`); } catch {} };
  // The File permission is the signed-in user's own (Settings → Keamanan in their TryDesk, saved in
  // service-perms.json at every start and whenever it changes), read fresh as that user. Only an explicit "on" counts:
  // no file yet (their TryDesk 1.3.9 hasn't run since the update, and 1.3.8 never let the service open folders),
  // or a file that can't be read or understood = off.
  ipcMain.handle("svc-user-perms", (e) => {
    // Mouse/keyboard and clipboard stay on unless the user turned them off (an older TryDesk wrote only "files", and
    // nobody signed in = the sign-in screen, which must stay controllable); files only on an explicit "on".
    const open = { input: true, clip: true, viewOnly: false };
    if (!fromMain(e)) return { user: false, files: false, ...open };
    const user = !!svcHome();
    if (!user) return { user: false, files: false, ...open };
    const j = svcUserJson("service-perms.json");
    // A file that is there but can't be read or understood is not "no file": say so, and the service keeps what it
    // had (never falls back to "everything allowed" while the user may have set view only).
    if (!j && svcUserMtime("service-perms.json") !== 0) return { user: true, files: false, unknown: true };
    return { user: true, files: !!(j && j.files === true), input: !(j && j.input === false), clip: !(j && j.clip === false), viewOnly: !!(j && j.viewOnly === true) };
  });
  ipcMain.removeHandler("fs-home");
  ipcMain.handle("fs-home", (e) => (fromMain(e) ? svcHome() : ""));
  ipcMain.removeHandler("fs-list");
  ipcMain.handle("fs-list", (e, dirPath) => {
    const no = (error) => ({ ok: false, error, path: String(dirPath || ""), display: String(dirPath || "") });
    if (!fromMain(e)) return no("not allowed");
    if (dirPath && !svcPathOk(dirPath)) { svcLog("list", dirPath, "refused path"); return no("ditolak"); }
    try {
      const home = svcHome();
      if (!home) return no("nouser");
      const res = asUser(() => listDirectory(dirPath || "", home));
      svcLog("list", dirPath || "(this PC)", res.ok ? "ok" : res.error);
      return res;
    } catch (err) { svcLog("list", dirPath || "(this PC)", err.message); return no(noUser(err) ? "nouser" : (err.code || err.message)); }
  });
  ipcMain.removeHandler("fs-op");
  ipcMain.handle("fs-op", (e, o) => {
    if (!fromMain(e) || !o) return { ok: false, error: "not allowed" };
    const ps = o.op === "delete" ? o.paths : [o.path];
    if (!Array.isArray(ps) || !ps.length || !ps.every(svcPathOk)) { svcLog("op " + o.op, String(o.path || ""), "refused path"); return { ok: false, error: "ditolak" }; }
    // SYSTEM has no Recycle Bin of the user's to put things in, and nothing is ever deleted for good from here.
    if (o.op === "delete") return { ok: false, error: "svc-nodelete" };
    try { const r = asUser(() => fsOpSync(o)); svcLog("op " + o.op, String(o.path), r.ok ? "ok" : r.error); return r; }
    catch (err) { return { ok: false, error: noUser(err) ? "nouser" : (err.code || err.message) }; }
  });
  ipcMain.removeHandler("file-open-read");
  ipcMain.handle("file-open-read", (e, filePath) => {
    if (!fromMain(e)) throw new Error("not allowed");
    if (!svcPathOk(filePath)) { svcLog("read", filePath, "refused path"); throw new Error("ditolak"); }
    const { fd, size } = asUser(() => {
      const f = fs.openSync(filePath, "r");
      const st = fs.fstatSync(f);
      if (!st.isFile()) { fs.closeSync(f); throw new Error("not a file"); }
      return { fd: f, size: st.size };
    });
    const id = `r${++handleSeq}`;
    readHandles.set(id, { fd, size });
    svcLog("read", filePath, "ok");
    return id;
  });
  ipcMain.removeHandler("file-open-write-in");
  ipcMain.handle("file-open-write-in", (e, { dir, name, replace } = {}) => {
    if (!fromMain(e)) throw new Error("not allowed");
    if (!svcPathOk(dir)) { svcLog("write", dir, "refused path"); throw new Error("ditolak"); }
    const out = asUser(() => {
      if (!fs.statSync(dir).isDirectory()) throw new Error("invalid directory");
      const safe = winSafeName(name), ext = path.extname(safe), base = safe.slice(0, safe.length - ext.length);
      if (replace) {   // "Ganti": beside the old file, swapped in at the end (file-close-write)
        const target = path.join(dir, safe);
        let st = null; try { st = fs.lstatSync(target); } catch {}
        if (st && st.isFile()) {
          const part = `${target}.${require("crypto").randomBytes(4).toString("hex")}.trydesk-part`;
          const fd = fs.openSync(part, "wx");
          return { fd, path: part, final: target };
        }
      }
      for (let n = 0; n < 1000; n++) {
        const target = path.join(dir, n ? `${base} (${n})${ext}` : safe);
        let fd; try { fd = fs.openSync(target, "wx"); } catch (err) { if (err.code === "EEXIST") continue; throw err; }   // new files only
        if (!fs.fstatSync(fd).isFile()) { fs.closeSync(fd); throw new Error("not a file"); }
        return { fd, path: target };
      }
      throw new Error("no free name");
    });
    const id = `w${++handleSeq}`;
    writeHandles.set(id, out);
    svcLog("write", out.path, "ok");
    return { id, path: out.path };
  });
  for (const ch of ["open-external", "lock-workstation", "set-discord-enabled", "discord-activity"]) ipcMain.removeAllListeners(ch);
  // Hidden again once nothing needs it (no request waiting, no session).
  ipcMain.on("service-hide-window", () => { try { mainWindow && mainWindow.setAlwaysOnTop(false); mainWindow && mainWindow.hide(); } catch {} });
  ipcMain.on("service-show-window", () => { try { if (mainWindow && !mainWindow.isVisible()) mainWindow.showInactive(); } catch {} });
}

app.on("will-quit", () => { disableBlackScreen(); disableInputLock(); });
