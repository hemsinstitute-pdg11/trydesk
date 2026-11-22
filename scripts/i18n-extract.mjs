// Collects every Indonesian UI text TryDesk shows, with its English, into src/renderer/locales/source.json: the list
// the other languages are translated from (owner 16 Nov 2026: "tambahkan banyak bahasa ... secara menyeluruh").
// Sources: TEXT_EN and TEXT_EN_PATTERNS, the keyed I18N table (+ the data-i18n HTML it fills), fmL(id, en) and
// `lang === "en" ? en : id` in app.js, L(id, en) in main.js, say(ws, id, en) in the signaling server, discord-rpc.js,
// and the Android app's Object.assign(TEXT_EN, {...}) in mobile/web/mobile.js.
// Texts with variable parts become patterns: "Kirim {1} item ke {2}" + a regex that finds them at run time.
// Usage: node scripts/i18n-extract.mjs   (prints counts; --check fails when the list changed and isn't committed)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const app = rd("src/renderer/app.js"), html = rd("src/renderer/index.html"), main = rd("src/main.js");
const server = rd("server/signaling-server.js"), discord = rd("src/discord-rpc.js");

const strings = new Map();   // id -> { en, where }
const patterns = new Map();  // id template -> { en, re, where }
const skipped = [];
const lineAt = (src, i) => src.slice(0, i).split("\n").length;
// (a language code picked in code, "id" / "en", is not text on screen)
const addS = (id, en, where) => { id = id.replace(/\s+/g, " ").trim(); en = String(en).replace(/\s+/g, " ").trim(); if (!id || !/[A-Za-z]/.test(id) || /^[a-z]{2,3}(-[A-Z]{2})?$/.test(id)) return; if (!strings.has(id)) strings.set(id, { en, where }); };
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Read one JS string / template literal starting at i (after spaces). Returns { kind, parts, exprs, end } or null.
function readLit(src, i) {
  while (/\s/.test(src[i])) i++;
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  i++;
  const parts = [""], exprs = [];
  while (i < src.length && src[i] !== q) {
    if (src[i] === "\\") { const c = src[i + 1]; parts[parts.length - 1] += c === "n" ? "\n" : c === "u" ? String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)) : c; i += c === "u" ? 6 : 2; continue; }
    if (q === "`" && src[i] === "$" && src[i + 1] === "{") {
      let depth = 1, j = i + 2;
      while (j < src.length && depth) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; else if (src[j] === "`") { j++; while (j < src.length && src[j] !== "`") { if (src[j] === "\\") j++; j++; } } j++; }
      exprs.push(src.slice(i + 2, j - 1).trim()); parts.push(""); i = j; continue;
    }
    parts[parts.length - 1] += src[i]; i++;
  }
  return { parts, exprs, end: i + 1 };
}
// A pair (id literal, en literal) → a plain string or a pattern.
function addPair(idL, enL, where) {
  if (!idL || !enL) return false;
  const idT = idL.parts.map((p, k) => p + (k < idL.exprs.length ? `{${k + 1}}` : "")).join("");
  if (!idL.exprs.length) {
    // English may still have a plural ending "${n > 1 ? "s" : ""}": shown to translators without it
    addS(idT, enL.parts.join(""), where); return true;
  }
  // English values match the Indonesian ones by their code; a plural ending ("s" or "") is dropped; any other
  // English value that differs only in formatting takes the Indonesian value at the same position.
  const plural = (e) => /\?\s*["'`][^"'`]*["'`]\s*:\s*["'`]["'`]/.test(e);
  let pos = 0;
  const enT = enL.parts.map((p, k) => {
    if (k >= enL.exprs.length) return p;
    const e = enL.exprs[k], at = idL.exprs.indexOf(e);
    if (at >= 0) { pos++; return p + `{${at + 1}}`; }
    if (plural(e)) return p;
    const idx = pos++;
    return p + (idx < idL.exprs.length ? `{${idx + 1}}` : "");
  }).join("");
  const re = "^" + idL.parts.map((p, k) => reEsc(p.replace(/\s+/g, " ")) + (k < idL.exprs.length ? "([\\s\\S]*?)" : "")).join("") + "$";
  const key = idT.replace(/\s+/g, " ").trim();
  if (!patterns.has(key)) patterns.set(key, { en: enT.replace(/\s+/g, " ").trim(), re, where });
  return true;
}
function scanCalls(src, file, re, argSkip = 0) {
  for (const m of src.matchAll(re)) {
    let i = m.index + m[0].length;
    for (let s = 0; s < argSkip; s++) { const c = src.indexOf(",", i); i = c + 1; }
    const a = readLit(src, i); if (!a) { skipped.push(`${file}:${lineAt(src, m.index)} (not a literal)`); continue; }
    let j = a.end; while (/\s/.test(src[j])) j++;
    if (src[j] !== ",") { skipped.push(`${file}:${lineAt(src, m.index)} (one argument)`); continue; }
    const b = readLit(src, j + 1); if (!b) { skipped.push(`${file}:${lineAt(src, m.index)} (2nd not a literal)`); continue; }
    addPair(a, b, `${file}:${lineAt(src, m.index)}`);
  }
}

// 1. TEXT_EN + I18N + TEXT_EN_PATTERNS (the same way audit-rilis.mjs reads them)
const ds = app.indexOf("const TEXT_EN = {"), de = app.indexOf("const TEXT_EN_PATTERNS"), pe = app.indexOf("];", de);
const DICT = new Function(`return ${app.slice(ds + "const TEXT_EN = ".length, app.lastIndexOf("};", de) + 1)}`)();
const PAT = new Function("trCore", `return ${app.slice(de + "const TEXT_EN_PATTERNS = ".length, pe + 1)}`)((x) => x);
const i18nAt = app.indexOf("const I18N = {");
const I18N = new Function(`return ${app.slice(i18nAt + "const I18N = ".length, app.indexOf("\n};", i18nAt) + 2)}`)();
for (const [id, en] of Object.entries(DICT)) addS(id, en, "TEXT_EN");
// The Android app's own texts: mobile/web/mobile.js adds them with Object.assign(TEXT_EN, {...}). Until 17 Nov 2026
// they were left out, so the 20 other languages showed the phone's dock, hints and menus in English.
{
  const mob = rd("mobile/web/mobile.js"), at = mob.indexOf("Object.assign(TEXT_EN, {");
  if (at < 0) { console.log("FAIL : mobile/web/mobile.js has no Object.assign(TEXT_EN, {...}) block"); process.exit(1); }
  const MOB = new Function(`return ${mob.slice(at + "Object.assign(TEXT_EN, ".length, mob.indexOf("});", at) + 1)}`)();
  for (const [id, en] of Object.entries(MOB)) addS(id, en, "mobile.js TEXT_EN");
}
for (const [k, id] of Object.entries(I18N.id)) if (I18N.en[k]) addS(id, I18N.en[k], `I18N.${k}`);
for (const m of html.matchAll(/data-i18n(-ph|-title)?="([\w]+)"/g)) {
  const key = m[2], en = I18N.en[key]; if (!en) continue;
  // the Indonesian text is the element's text / placeholder / title in the HTML
  const tagEnd = html.indexOf(">", m.index), tagStart = html.lastIndexOf("<", m.index), tag = html.slice(tagStart, tagEnd + 1);
  let id = "";
  if (m[1] === "-ph") id = (/placeholder="([^"]*)"/.exec(tag) || [])[1] || "";
  else if (m[1] === "-title") id = (/title="([^"]*)"/.exec(tag) || [])[1] || "";
  else id = html.slice(tagEnd + 1, html.indexOf("<", tagEnd + 1));
  addS(id.replace(/&amp;/g, "&"), en, `html data-i18n ${key}`);
}
// The "Sambung lewat IP" help: whole Indonesian and English blocks with the same structure. Each sentence
// ("unit": the outermost h4 / p / span / small / b / div holding no other block) is one text, HTML kept, paired
// with the English unit at the same place. app.js trHelpBlocks finds the units the same way.
{
  const UNIT = /<(h4|p|span|small|b|div)\b[^>]*>((?:(?!<\/?(?:div|section|span|p|h4|small)\b)[\s\S])*?)<\/\1>/g;
  const lead = /^(?:<svg\b[\s\S]*?<\/svg>|<i\b[^>]*><\/i>)+/;
  const units = (s) => [...s.matchAll(UNIT)].map((m) => m[2].replace(lead, "")).filter((u) => /\p{L}/u.test(u.replace(/<[^>]+>/g, "")));
  const idAt = html.indexOf('<div class="help-id">'), enAt = html.indexOf('<div class="help-en"'), endAt = html.indexOf('<div class="lh-foot">', enAt);
  const ids = units(html.slice(idAt + 21, enAt)), ens = units(html.slice(html.indexOf(">", enAt) + 1, endAt));
  if (ids.length !== ens.length) { console.log(`FAIL : LAN help blocks differ (${ids.length} Indonesian units, ${ens.length} English)`); process.exit(1); }
  ids.forEach((u, k) => addS(u, ens[k], `html help-id unit ${k}`));
}
PAT.forEach(([re, rep], k) => {
  // a readable Indonesian template from the regex: groups become {1}, {2}…
  let n = 0;
  const idT = re.source.replace(/^\^|\$$/g, "").replace(/\((?!\?)(?:[^()\\]|\\.|\((?:[^()\\]|\\.)*\))*\)\??/g, () => `{${++n}}`).replace(/\\(.)/g, "$1");
  const enT = typeof rep === "function" ? null : rep.replace(/\$(\d)/g, "{$1}");
  patterns.set(`#P${k}:` + idT, { en: enT, re: re.source, flags: re.flags, where: `TEXT_EN_PATTERNS[${k}]`, fn: typeof rep === "function" ? rep.toString().slice(0, 300) : undefined, idx: k });
});
// 2. calls with an Indonesian and an English text
scanCalls(app, "app.js", /\bfmL\(/g);
scanCalls(app, "app.js", /\btrL\(/g);
for (const m of app.matchAll(/\blang === "en" \? /g)) {
  const a = readLit(app, m.index + m[0].length); if (!a) continue;
  let j = a.end; while (/\s/.test(app[j])) j++;
  if (app[j] !== ":") continue;
  const b = readLit(app, j + 1); if (!b) continue;
  addPair(b, a, `app.js:${lineAt(app, m.index)} ternary`);
}
scanCalls(main, "main.js", /(?<![\w.])L\(/g);
scanCalls(server, "signaling-server.js", /\bsay\(/g, 1);
// 3. Discord presence
const dTx = new Function(`return ${discord.slice(discord.indexOf("const TEXT = {") + "const TEXT = ".length, discord.indexOf("};", discord.indexOf("const TEXT = {")) + 1)}`)();
for (const k of Object.keys(dTx.id)) addS(dTx.id[k], dTx.en[k], `discord.${k}`);

const out = {
  note: "Generated by scripts/i18n-extract.mjs. Every key is the Indonesian text the app shows; translate the value of 'en' meaning into each language. {1}, {2} stand for names, numbers or other values and must stay in the translation.",
  // kept in the order they were found (TEXT_EN as written): pieces of one sentence stay next to each other
  strings: Object.fromEntries([...strings]),
  patterns: Object.fromEntries([...patterns]),
};
const file = path.join(ROOT, "src/renderer/locales/source.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
const text = JSON.stringify(out, null, 1) + "\n";
if (process.argv.includes("--check")) {
  // compared without "where" (line numbers move with every edit; only the texts matter to the translations)
  const bare = (s) => { const j = JSON.parse(s); for (const g of [j.strings, j.patterns]) for (const v of Object.values(g || {})) delete v.where; return JSON.stringify(j); };
  const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (!old || bare(old) !== bare(text)) { console.log("FAIL : source.json is out of date, run node scripts/i18n-extract.mjs"); process.exit(1); }
  console.log("PASS : source.json up to date"); process.exit(0);
}
fs.writeFileSync(file, text);
console.log(`strings ${strings.size} · patterns ${patterns.size} · skipped ${skipped.length}`);
if (skipped.length) console.log(skipped.slice(0, 40).join("\n"));
