// Language files for the app: src/renderer/locales/<code>.js, one per language, loaded when it is picked
// (app.js loadLocale; main.js reads the same file for its own texts). Each file is the translation of
// src/renderer/locales/source.json (made by scripts/i18n-extract.mjs):
//   window.TD_LOCALE = { "code": "ja", "s": { "<Indonesian>": "<translation>" }, "p": [[regex, flags, template]] }
// The .js file is the translation's home: rebuilding keeps it and only adds or replaces what --from brings.
// Usage:
//   node scripts/i18n-build.mjs --from <folder with <code>/{s1,s2,s3,p}.json or <code>.json>   (merge translations in)
//   node scripts/i18n-build.mjs --check      (every language has every text and every pattern; placeholders kept)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "src", "renderer", "locales");
export const CODES = ["ms", "zh-CN", "zh-TW", "ja", "ko", "vi", "th", "fil", "es", "pt-BR", "hi", "ru", "fr", "de", "tr", "pl", "it", "nl", "uk", "ar"];
const src = JSON.parse(fs.readFileSync(path.join(DIR, "source.json"), "utf8"));
const ph = (s) => (String(s).match(/\{\d\}/g) || []).sort().join(",");

function readLocale(code) {
  const f = path.join(DIR, code + ".js");
  if (!fs.existsSync(f)) return { s: {}, pt: {} };
  const raw = fs.readFileSync(f, "utf8");
  const d = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  return { s: d.s || {}, pt: d.pt || {} };   // pt: pattern key -> template (kept so a rebuild can keep them)
}
function writeLocale(code, s, pt) {
  const keepS = {}, keepP = {};
  for (const k of Object.keys(src.strings)) if (typeof s[k] === "string" && s[k].trim()) keepS[k] = s[k];
  const p = [];
  // A template written for the same Indonesian text under another key ("#P51:Diubah {1}" and "Diubah {1}") serves both.
  const bare = {};
  for (const [k, v] of Object.entries(pt)) { const b = k.replace(/^#P\d+:/, ""); if (!(b in bare)) bare[b] = v; }
  for (const [k, v] of Object.entries(src.patterns)) {
    const tpl = pt[k] || bare[k.replace(/^#P\d+:/, "")];
    if (typeof tpl !== "string" || !tpl.trim()) continue;
    keepP[k] = tpl;
    p.push([v.re, v.flags || "", tpl]);
  }
  // The app tries patterns in order and takes the first match: the most specific (longest fixed text) goes first,
  // or "{1} item" would catch "Kirim 2 item" before "Kirim {1} item" does.
  const fixed = (re) => re.replace(/\((?:[^()\\]|\\.|\((?:[^()\\]|\\.)*\))*\)\??/g, "").replace(/\\(.)/g, "$1").replace(/^\^|\$$/g, "").length;
  p.sort((a, b) => fixed(b[0]) - fixed(a[0]));
  const body = JSON.stringify({ code, s: keepS, pt: keepP, p });
  fs.writeFileSync(path.join(DIR, code + ".js"), `// TryDesk interface text in ${code}. Made by scripts/i18n-build.mjs from translations of source.json; edit with care.\nwindow.TD_LOCALE = ${body};\n`);
  return { s: Object.keys(keepS).length, p: p.length };
}
function check() {
  const problems = [];
  const nS = Object.keys(src.strings).length, nP = Object.keys(src.patterns).length;
  for (const code of CODES) {
    const { s, pt } = readLocale(code);
    const missS = Object.keys(src.strings).filter((k) => !s[k]), missP = Object.keys(src.patterns).filter((k) => !pt[k]);
    if (missS.length || missP.length) problems.push(`${code}: ${missS.length} of ${nS} texts and ${missP.length} of ${nP} patterns missing${missS.length ? ` (e.g. "${missS[0].slice(0, 50)}")` : ""}`);
    for (const [k, v] of Object.entries(s)) if (ph(k) !== ph(v)) problems.push(`${code}: placeholders differ in "${k.slice(0, 50)}"`);
    for (const [k, v] of Object.entries(pt)) if (src.patterns[k] && src.patterns[k].en != null && ph(k.replace(/^#P\d+:/, "")) !== ph(v)) problems.push(`${code}: placeholders differ in pattern "${k.slice(0, 50)}"`);
    for (const v of [...Object.values(s), ...Object.values(pt)]) if (/—/.test(v)) { problems.push(`${code}: em dash in "${v.slice(0, 50)}"`); break; }
  }
  return problems;
}

const argv = process.argv.slice(2);
if (argv.includes("--check")) {
  const p = check();
  if (p.length) { console.log(`FAIL : ${p.length} language problem(s)`); console.log(p.slice(0, 40).map((x) => "  - " + x).join("\n")); process.exit(1); }
  console.log(`PASS : ${CODES.length} languages complete (${Object.keys(src.strings).length} texts, ${Object.keys(src.patterns).length} patterns each)`);
  process.exit(0);
}
const fromAt = argv.indexOf("--from");
const from = fromAt >= 0 ? argv[fromAt + 1] : null;
for (const code of CODES) {
  const cur = readLocale(code);
  if (from) {
    const dir = path.join(from, code), one = path.join(from, code + ".json");
    const parts = fs.existsSync(dir) ? ["s1", "s2", "s3", "p", "delta"].map((f) => path.join(dir, f + ".json")).filter(fs.existsSync) : fs.existsSync(one) ? [one] : [];
    for (const f of parts) {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      for (const [k, v] of Object.entries(j)) { if (typeof v !== "string") continue; if (k in src.patterns) cur.pt[k] = v; else cur.s[k] = v; }
    }
  }
  if (!Object.keys(cur.s).length && !Object.keys(cur.pt).length) continue;
  const n = writeLocale(code, cur.s, cur.pt);
  console.log(`${code.padEnd(6)} texts ${n.s}/${Object.keys(src.strings).length} · patterns ${n.p}/${Object.keys(src.patterns).length}`);
}
