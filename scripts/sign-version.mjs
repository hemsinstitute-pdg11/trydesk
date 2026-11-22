// Signs website/update/version.json with the owner's Ed25519 key (%USERPROFILE%\.trydesk\version-signing.pem, never
// in the project or on the website). TryDesk 1.3.3+ checks the signature (main.js: versionJsonSigned) and ignores an
// unsigned or altered file, so a break-in at the web hosting can't force an update or disable every app.
// Run by buat-rilis.ps1 after it sets "latest"; run it by hand after editing the notes or "minimum".
//   node scripts/sign-version.mjs                     signs website/update/version.json (and the release copy if present)
//   node scripts/sign-version.mjs --files <downloads>  also writes + signs the download list for in-app updates
//   node scripts/sign-version.mjs --check             only verifies
//
// The download list ("files", signed separately as "filesSig") names each download of "latest" with its size and
// SHA-256. TryDesk (src/updater.js) installs a downloaded file only when both match this signed list. It is its own
// signature so the five old fields and their "sig" stay exactly as apps 1.3.3-1.4.0 read them.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = path.join(os.homedir(), ".trydesk", "version-signing.pem");
const PUB = "MCowBQYDK2VwAyEALmgxboidf3mbPwbQKUYPidxLPlSdMvgjQle1fXxJu6E=";   // must match VERSION_JSON_PUBKEY in src/main.js
const files = ["website/update/version.json", "rilis/filezilla-website/update/version.json"].map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f));
if (!files.length) { console.error("version.json not found under " + ROOT); process.exit(1); }
const canonical = (j) => JSON.stringify({ latest: j.latest, minimum: j.minimum || "", url: j.url, notes: { id: j.notes.id, en: j.notes.en } });
// The download list's signed bytes (must match filesCanonical in src/updater.js).
const FILE_KEYS = ["win-setup", "win-portable", "mac-arm64", "mac-x64", "linux-appimage", "linux-deb", "android"];
const filesCanonical = (f) => "trydesk-files-v1\n" + JSON.stringify([f.version, ...FILE_KEYS.filter((k) => f[k]).map((k) => [k, f[k].path, f[k].size, f[k].sha256])]);
const NAMES = (v) => ({ "win-setup": `win/TryDesk-Setup-${v}.exe`, "win-portable": `win/TryDesk-Portable-${v}.exe`,
  "mac-arm64": `mac/TryDesk-${v}-mac-arm64.zip`, "mac-x64": `mac/TryDesk-${v}-mac-x64.zip`,
  "linux-appimage": `linux/TryDesk-${v}-x86_64.AppImage`, "linux-deb": `linux/TryDesk-${v}-amd64.deb`, "android": `android/TryDesk-Android-${v}.apk` });
// Apps 1.3.3-1.4.0 cut each note to 300 characters BEFORE checking the signature, so a longer note made every one of
// them reject the whole file (found 18 Nov 2026: the live 1.3.9 notes were 1374 characters, and no app showed the
// update notice). Keep notes short; the full changelog lives on the website.
const NOTE_MAX = 300;

const check = process.argv.includes("--check");
const fi = process.argv.indexOf("--files");
const dlDir = fi > 0 ? path.resolve(process.argv[fi + 1] || "") : "";
if (fi > 0 && !fs.existsSync(dlDir)) { console.error("downloads folder not found: " + dlDir); process.exit(1); }
const pub = crypto.createPublicKey({ key: Buffer.from(PUB, "base64"), format: "der", type: "spki" });
const sha256 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

let list = null;   // built once from --files, written into every copy
if (dlDir && !check) {
  const v = JSON.parse(fs.readFileSync(files[0], "utf8")).latest;
  list = { version: v };
  for (const [k, rel] of Object.entries(NAMES(v))) {
    const f = path.join(dlDir, ...rel.split("/"));
    if (!fs.existsSync(f)) { console.log(`     ${k}: ${rel} not found, left out (that platform keeps the website link)`); continue; }
    list[k] = { path: rel, size: fs.statSync(f).size, sha256: sha256(f) };
    console.log(`     ${k}: ${rel}  ${list[k].size} bytes  ${list[k].sha256.slice(0, 12)}...`);
  }
}

let bad = 0;
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const k of ["id", "en"]) {
    const n = (j.notes && j.notes[k]) || "";
    if (n.length > NOTE_MAX) { console.error(`BAD  ${path.relative(ROOT, f)}: notes.${k} is ${n.length} characters, the most is ${NOTE_MAX} (older apps would reject the file). Shorten it.`); bad++; }
  }
  if (bad) continue;
  if (!check) {
    if (!fs.existsSync(KEY)) { console.error("signing key not found: " + KEY); process.exit(1); }
    const priv = crypto.createPrivateKey(fs.readFileSync(KEY, "utf8"));
    j.sig = crypto.sign(null, Buffer.from(canonical(j), "utf8"), priv).toString("base64");
    if (list) j.files = list;
    // A list for an older version would only be refused by the apps: drop it instead of shipping it.
    if (j.files && j.files.version !== j.latest) { delete j.files; delete j.filesSig; console.log("     download list was for an older version: removed (run with --files to make a new one)"); }
    if (j.files) j.filesSig = crypto.sign(null, Buffer.from(filesCanonical(j.files), "utf8"), priv).toString("base64");
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n", "utf8");
  }
  const ok = typeof j.sig === "string" && crypto.verify(null, Buffer.from(canonical(j), "utf8"), pub, Buffer.from(j.sig, "base64"));
  const fok = !j.files || (j.files.version === j.latest && typeof j.filesSig === "string" && crypto.verify(null, Buffer.from(filesCanonical(j.files), "utf8"), pub, Buffer.from(j.filesSig, "base64")));
  if (!ok || !fok) bad++;
  const n = j.files ? FILE_KEYS.filter((k) => j.files[k]).length : 0;
  console.log(`${ok && fok ? "OK  " : "BAD "} ${path.relative(ROOT, f)}  latest ${j.latest}, minimum ${j.minimum || "-"}, download list: ${j.files ? n + " files" + (fok ? "" : " (signature BAD)") : "none"}`);
}
if (bad) process.exit(1);
