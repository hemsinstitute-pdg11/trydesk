const { contextBridge, ipcRenderer, webUtils } = require("electron");

// The monitor windows ("Satu jendela per monitor", about:blank) are drawn by the app's own page: they get no API.
if (location.protocol !== "about:") contextBridge.exposeInMainWorld("electronAPI", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  // In-app updates (src/updater.js): state, background download, install now / on quit.
  updateState: () => ipcRenderer.invoke("update-state"),
  onUpdateState: (cb) => ipcRenderer.on("update-state", (_e, s) => cb(s)),
  updateDownload: () => ipcRenderer.send("update-download"),
  updatePause: () => ipcRenderer.send("update-pause"),
  updateAuto: (on) => ipcRenderer.send("update-auto", !!on),
  updateAckDone: () => ipcRenderer.send("update-ack-done"),
  updateRetry: () => ipcRenderer.send("update-retry"),
  updateInstall: (confirmed) => ipcRenderer.invoke("update-install", confirmed === true),
  confirm: (opts) => ipcRenderer.invoke("confirm-dialog", opts),
  isElevated: () => ipcRenderer.invoke("is-elevated"),
  relaunchAsAdmin: () => ipcRenderer.invoke("relaunch-as-admin"),
  onElevatedRelaunchBlocked: (cb) => ipcRenderer.on("elevated-relaunch-blocked", () => cb()),
  onOtherCopyBlocked: (cb) => ipcRenderer.on("other-copy-blocked", (_e, v) => cb({ otherPortable: !!(v && v.otherPortable), thisPortable: !!(v && v.thisPortable) })),
  // Windows service (unattended access)
  serviceStatus: () => ipcRenderer.invoke("service-status"),
  serviceInstall: (hash) => ipcRenderer.invoke("service-install", String(hash || "")),
  serviceUninstall: () => ipcRenderer.invoke("service-uninstall"),
  setServiceId: (id) => ipcRenderer.send("service-id", String(id || "")),
  serviceAttachConsole: () => ipcRenderer.invoke("service-attach-console"),
  serviceHideWindow: () => ipcRenderer.send("service-hide-window"),
  serviceShowWindow: () => ipcRenderer.send("service-show-window"),
  serviceUserIdentity: () => ipcRenderer.invoke("service-user-identity"),
  serviceSetPassword: (hash) => ipcRenderer.invoke("service-set-password", String(hash || "")),
  servicePwFingerprint: (hash) => ipcRenderer.invoke("service-pw-fingerprint", String(hash || "")),
  exportIdentity: (id, token) => ipcRenderer.send("export-identity", { id: String(id || ""), token: String(token || "") }),
  readIdentity: () => ipcRenderer.invoke("read-identity"),
  forgetIdentity: () => ipcRenderer.send("forget-identity"),
  serviceRegenId: () => ipcRenderer.invoke("service-regen-id"),
  onSvcRegenId: (cb) => ipcRenderer.on("svc-regen-id", () => cb()),
  svcRegenAck: () => ipcRenderer.send("svc-regen-ack"),
  // The user's language, so the service's window (SYSTEM, which has no language of its own) speaks it too.
  exportUiLang: (l) => ipcRenderer.send("export-ui-lang", /^[a-z]{2,3}(-[A-Z]{2})?$/.test(String(l)) ? l : "id"),
  serviceUserLang: () => ipcRenderer.invoke("service-user-lang"),
  getMonitors: () => ipcRenderer.invoke("get-monitors"),
  cursorDisplayId: () => ipcRenderer.invoke("cursor-display-id"),   // "Ikuti kursor": the screen this PC's cursor is on
  // Settings that act on the OS
  getLoginItem: () => ipcRenderer.invoke("get-login-item"),
  setLoginItem: (on) => ipcRenderer.invoke("set-login-item", !!on),
  setPowerSave: (on) => ipcRenderer.send("power-save", !!on),
  wakeDisplay: () => ipcRenderer.invoke("wake-display"),   // resolves once the monitors are ready (see main.js)
  lockWorkstation: () => ipcRenderer.send("lock-workstation"),
  sendSas: () => ipcRenderer.invoke("send-sas"),   // Ctrl+Alt+Del, service host only (see main.js)
  getHwAccel: () => ipcRenderer.invoke("get-hw-accel"),
  setHwAccel: (on) => ipcRenderer.invoke("set-hw-accel", !!on),
  openExternal: (url) => ipcRenderer.send("open-external", String(url || "")),
  setDiscordEnabled: (on) => ipcRenderer.send("set-discord-enabled", !!on),
  setHostingState: (on) => ipcRenderer.send("hosting-state", !!on),
  onPrivacyReleased: (cb) => ipcRenderer.on("privacy-released", (_e, why) => cb(why === "failed" ? "failed" : "")),
  setDisplayMediaSource: (id, displayId) => ipcRenderer.invoke("set-dm-source", id, displayId),
  // Fast capture path (Windows host): native capture + GPU encode in a helper process; H.264 frames come back here.
  fastCaptureAvailable: () => ipcRenderer.invoke("fast-capture-available"),
  nativeCaptureAvailable: () => ipcRenderer.invoke("native-capture-available"),
  fastCaptureStart: (opts) => ipcRenderer.invoke("fast-capture-start", { displayId: String(opts?.displayId || ""), fps: Number(opts?.fps) || 60, mbps: Number(opts?.mbps) || 50, udp: opts?.udp ? String(opts.udp) : "", hevc: !!opts?.hevc, raw: !!opts?.raw }),
  fastCaptureCmd: (cmd) => ipcRenderer.send("fast-capture-cmd", { cmd: String(cmd?.cmd || ""), mbps: Number(cmd?.mbps) || 0, fps: Number(cmd?.fps) || 0, ip: String(cmd?.ip || ""), port: Number(cmd?.port) || 0, on: !!cmd?.on }),
  fastCaptureStop: () => ipcRenderer.send("fast-capture-stop"),
  onFastCapturePacket: (cb) => ipcRenderer.on("fast-capture-packet", (_e, p) => cb(p)),
  onFastCaptureRaw: (cb) => ipcRenderer.on("fast-capture-raw", (_e, p) => cb(p)),
  onFastCaptureInfo: (cb) => ipcRenderer.on("fast-capture-info", (_e, s) => cb(String(s))),
  onFastCaptureEnded: (cb) => ipcRenderer.on("fast-capture-ended", (_e, d) => cb(d)),
  // The PC's sound from the helper (host run as administrator, see main.js loopback-start).
  loopbackStart: () => ipcRenderer.invoke("loopback-start"),
  loopbackStop: () => ipcRenderer.send("loopback-stop"),
  onLoopbackPcm: (cb) => ipcRenderer.on("loopback-pcm", (_e, p) => cb(p)),
  onLoopbackInfo: (cb) => ipcRenderer.on("loopback-info", (_e, s) => cb(String(s))),
  onLoopbackEnded: (cb) => ipcRenderer.on("loopback-ended", (_e, d) => cb(d)),
  // One TryDesk with the service (see main.js "One TryDesk"): service host side, then the user's app side.
  svcFrontendAlive: () => ipcRenderer.invoke("svc-frontend-alive"),
  svcUiPublish: (ui) => ipcRenderer.send("svc-ui-publish", ui),
  svcUserPerms: () => ipcRenderer.invoke("svc-user-perms"),
  svcPermsSave: (p) => ipcRenderer.send("svc-perms-save", { files: !!(p && p.files), input: !(p && p.input === false), clip: !(p && p.clip === false), viewOnly: !!(p && p.viewOnly) }),
  onSvcCmd: (cb) => ipcRenderer.on("svc-cmd", (_e, c) => cb(c)),
  onSvcUi: (cb) => ipcRenderer.on("svc-ui", (_e, ui) => cb(ui)),
  svcUiNow: () => ipcRenderer.invoke("svc-ui-now"),
  // The service's window opens the person's own TryDesk (as them) for Settings / Send file; that TryDesk is told why.
  svcOpenUserApp: (what) => ipcRenderer.invoke("svc-open-user-app", String(what || "")),
  onSvcOpen: (cb) => ipcRenderer.on("svc-open", (_e, what) => cb(String(what || ""))),
  svcCmd: (c) => ipcRenderer.send("svc-cmd", { cmd: String(c?.cmd || ""), req: Number(c?.req) || 0, text: String(c?.text || "").slice(0, 4000) }),
  // Files in the service's sessions (main.js "File transfer in the service's sessions").
  svcOutboxPut: (filePath) => ipcRenderer.invoke("svc-outbox-put", String(filePath || "")),
  svcOutboxOpen: (id) => ipcRenderer.invoke("svc-outbox-open", String(id || "")),
  svcOutboxDone: (id) => ipcRenderer.invoke("svc-outbox-done", String(id || "")),
  svcInboxOpen: (name) => ipcRenderer.invoke("svc-inbox-open", { name: String(name || "") }),
  // Service host: the secure desktop (UAC prompt, lock screen) has the input now (true) or not any more (false).
  onSecureDesktop: (cb) => ipcRenderer.on("secure-desktop", (_e, on) => cb(!!on)),
  secureDesktopNow: () => ipcRenderer.invoke("secure-desktop-now"),
  // Viewer end of the fast path's UDP link (Windows): frames arrive whole from the receiver helper.
  fastUdpRecvStart: (opts) => ipcRenderer.invoke("fast-udp-recv-start", { key: String(opts?.key || ""), port: Number(opts?.port) || 0, ips: Array.isArray(opts?.ips) ? opts.ips.map(String).slice(0, 8) : [] }),
  fastUdpRecvStop: () => ipcRenderer.send("fast-udp-recv-stop"),
  onFastUdpPacket: (cb) => ipcRenderer.on("fast-udp-packet", (_e, p) => cb(p)),
  onFastUdpInfo: (cb) => ipcRenderer.on("fast-udp-info", (_e, s) => cb(String(s))),
  onFastUdpEnded: (cb) => ipcRenderer.on("fast-udp-ended", (_e, d) => cb(d)),
  setCaptureDisplay: (d) => ipcRenderer.send("set-capture-display", d),
  executeInput: (event) => ipcRenderer.send("execute-input", event),
  releaseRemoteInput: () => ipcRenderer.send("release-remote-input"),
  focusWindow: (pin) => ipcRenderer.send("focus-window", typeof pin === "boolean" ? pin : null),
  minimizeWindow: () => ipcRenderer.send("minimize-window"),
  maximizeWindow: () => ipcRenderer.send("maximize-window"),
  closeWindow: () => ipcRenderer.send("close-window"),
  // System tray: hide the window (TryDesk keeps running), quit for real, and keep the tray's ID line current.
  hideToTray: (firstTime) => ipcRenderer.send("hide-to-tray", !!firstTime),
  quitApp: () => ipcRenderer.send("quit-app"),
  setTrayInfo: (info) => ipcRenderer.send("tray-info", { id: String(info?.id || "") }),
  onCloseRequested: (cb) => ipcRenderer.on("close-requested", () => cb()),
  onQuitRequested: (cb) => ipcRenderer.on("quit-requested", () => cb()),

  clipboardRead: () => ipcRenderer.invoke("clipboard-read"),
  clipboardWrite: (text) => ipcRenderer.invoke("clipboard-write", text),
  clipFilesSig: () => ipcRenderer.invoke("clip-files-sig"),
  clipFilesRead: () => ipcRenderer.invoke("clip-files-read"),
  clipDir: () => ipcRenderer.invoke("clip-dir"),
  clipFilesWrite: (paths) => ipcRenderer.invoke("clip-files-write", Array.isArray(paths) ? paths.map(String) : []),

  filePick: () => ipcRenderer.invoke("file-pick"),
  // Files dropped on the window: only real dropped File objects have a path (webUtils), so the page can't name one.
  filesDropped: (files) => ipcRenderer.invoke("file-dropped", Array.from(files || []).slice(0, 50).map((f) => { try { return webUtils.getPathForFile(f); } catch { return ""; } }).filter(Boolean)),
  // File Transfer: files AND folders dropped from Explorer onto the other PC's pane (paths of real dropped File objects only).
  droppedPaths: (files) => Array.from(files || []).slice(0, 200).map((f) => { try { return webUtils.getPathForFile(f); } catch { return ""; } }).filter(Boolean),
  fileSaveDialog: (name) => ipcRenderer.invoke("file-save-dialog", name),
  fileOpenRead: (p, offset) => ipcRenderer.invoke("file-open-read", offset > 0 ? { path: p, offset } : p),
  fileResumeHave: (rk) => ipcRenderer.invoke("file-resume-have", String(rk || "")),
  fileReadChunk: (id, length) => ipcRenderer.invoke("file-read-chunk", { id, length }),
  fileCloseRead: (id) => ipcRenderer.invoke("file-close-read", id),
  fileOpenWrite: (p) => ipcRenderer.invoke("file-open-write", p),
  fileOpenWriteIn: (dir, name, replace, rk, want) => ipcRenderer.invoke("file-open-write-in", { dir, name, replace: !!replace, rk: rk ? String(rk) : undefined, want: Number.isSafeInteger(want) ? want : undefined }),
  fileWriteChunk: (id, chunk) => ipcRenderer.invoke("file-write-chunk", { id, chunk }),
  fileCloseWrite: (id, deleteFile, keep) => ipcRenderer.invoke("file-close-write", { id, deleteFile, keep: !!keep }),

  fsHome: () => ipcRenderer.invoke("fs-home"),
  fsList: (p) => ipcRenderer.invoke("fs-list", p),
  fsOp: (o) => ipcRenderer.invoke("fs-op", o),

  onDisplayChanged: (cb) => ipcRenderer.on("display-changed", (_e, force) => cb(!!force)),
  onHostCursorHidden: (cb) => ipcRenderer.on("host-cursor-hidden", (_e, hidden) => cb(hidden)),
  requestCursorState: () => ipcRenderer.send("request-cursor-state"),
  // An admin window (Task Manager, admin CMD) in front of a non-elevated host: input to it is blocked by Windows.
  onHostAdminWindow: (cb) => ipcRenderer.on("host-admin-window", (_e, on) => cb(!!on)),
  onHostBlindDesktop: (cb) => ipcRenderer.on("host-blind-desktop", (_e, on) => cb(!!on)),
  requestAdminWindowState: () => ipcRenderer.send("request-admin-window-state"),
  logInfo: (msg) => ipcRenderer.send("log-info", String(msg)),
  // The access password's key, kept encrypted by Windows (DPAPI, safeStorage) instead of plain localStorage (audit
  // 19 Nov, TD-VULN-04a). Sync on purpose: read once at start, before anything asks for it.
  secretGet: (key) => ipcRenderer.sendSync("secret-get-sync", String(key)),
  secretSet: (key, val) => ipcRenderer.send("secret-set", String(key), val == null ? null : String(val)),

  // LAN direct connection ("Sambung lewat IP"): main.js moves JSON lines over TCP, app.js speaks the protocol.
  lanHost: (opts) => ipcRenderer.invoke("lan-host", { on: !!opts?.on, machine: String(opts?.machine || "") }),
  lanOpen: (address) => ipcRenderer.invoke("lan-open", String(address || "")),
  lanWrite: (id, msg) => ipcRenderer.send("lan-write", String(id), msg),
  lanClose: (id) => ipcRenderer.send("lan-close", String(id)),
  lanKeep: (id) => ipcRenderer.send("lan-keep", String(id)),
  onLanEvent: (cb) => ipcRenderer.on("lan-event", (_e, ev) => cb(ev)),

  // Full keyboard capture: the renderer switches it on while actively controlling a remote PC.
  setKeyCapture: (on) => ipcRenderer.send("set-key-capture", !!on),
  onCapturedKey: (cb) => ipcRenderer.on("captured-key", (_e, d) => cb(d)),
  onReleaseKeys: (cb) => ipcRenderer.on("release-keys", () => cb()),
  onReleaseControl: (cb) => ipcRenderer.on("release-control", () => cb()),

  // Native game-mouse capture (relative motion for games, no pointer-lock gesture needed).
  setMouseCapture: (on) => ipcRenderer.send("set-mouse-capture", !!on),
  onCapturedMouse: (cb) => ipcRenderer.on("captured-mouse", (_e, d) => cb(d)),
  onMouseCaptureResult: (cb) => ipcRenderer.on("mouse-capture-result", (_e, d) => cb(d)),

  // Discord Rich Presence: report session state so the user's profile shows what TryDesk is doing.
  setDiscordActivity: (state) => ipcRenderer.send("discord-activity", String(state || "idle")),
  setUiLanguage: (lang) => ipcRenderer.send("set-ui-language", /^[a-z]{2,3}(-[A-Z]{2})?$/.test(String(lang)) ? lang : "id"),

  enableBlackScreen: () => ipcRenderer.invoke("enable-black-screen"),
  disableBlackScreen: () => ipcRenderer.invoke("disable-black-screen"),
  panicKeyYield: (yieldIt) => ipcRenderer.send("panic-key-yield", !!yieldIt),
  enableInputLock: () => ipcRenderer.invoke("enable-input-lock"),
  disableInputLock: () => ipcRenderer.invoke("disable-input-lock"),
});
