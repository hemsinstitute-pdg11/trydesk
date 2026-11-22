// The website in two languages, each at its own address (owner 16 Nov 2026: "Website cukup 2 bahasa saja"):
// Indonesian is written by hand in website/<page>/index.html; English is made from it here into website/en/<page>/,
// with the English text of website/assets/js/i18n.js (the same dictionary the pages already use). Search engines and
// AI crawlers then see each language on its own URL instead of one URL that changes with the visitor's browser.
// Run by buat-rilis.ps1 (step 4c) after update-seo.mjs. Also:
//  - hreflang id / en / x-default (English) on both versions; canonical, og:url, og:locale per language
//  - FAQPage JSON-LD built from the visible FAQ (data-i18n home.faqQn / home.faqAn), so it always says the same
//  - JSON-LD texts translated: a JSON string equal to an Indonesian dictionary value takes its English value
//  - sitemap.xml lists every page in both languages with their alternates (lastmod kept; update-seo.mjs moves it)
//  - llms-full.txt: the docs and FAQ as plain text, Indonesian and English, for AI assistants
// Usage: node scripts/build-site-en.mjs [--check]   (--check: fails if an English text is missing)
//  - the Documentation (docs/ and docs/<topic>/) is written in both languages by build-docs.mjs, run first from here;
//    this script only lists those pages in the sitemap and links to them from the other English pages.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocs, DOCS_PAGES, docsText } from "./build-docs.mjs";
import { withDiscordEmbed } from "./discord-embed.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "website");
const ORIGIN = "https://trydesk.ai.id";
// pages translated here; the docs pages are made by build-docs.mjs (both languages)
export const PAGES = ["", "downloads/", "source/", "source/code/", "sponsor/", "donate/", "privacy/", "terms/"];
const ALL_PAGES = [...PAGES, ...DOCS_PAGES];
const CHECK = process.argv.includes("--check");
const docs = buildDocs({ check: CHECK });
if (!docs.ok) process.exit(1);

const i18nSrc = fs.readFileSync(path.join(SITE, "assets/js/i18n.js"), "utf8");
const dAt = i18nSrc.indexOf("var dict = ");
const dict = new Function("return " + i18nSrc.slice(dAt + 11, i18nSrc.indexOf("\n  };", dAt) + 4))();
const ID = dict.id, EN = dict.en;
const missing = new Set();
const en = (k, fallback) => { if (EN[k] != null) return EN[k]; missing.add(k); return fallback; };
const escText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => escText(s).replace(/"/g, "&quot;");
const plain = (h) => String(h).replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

// End of an element's content: the matching close tag, counting nested tags of the same name.
function innerEnd(html, tag, from) {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  for (let m; (m = re.exec(html));) {
    if (m[1]) { if (--depth === 0) return m.index; }
    else if (!m[0].endsWith("/>")) depth++;
  }
  throw new Error(`no </${tag}> after ${from}`);
}
// Swap the text of every data-i18n / data-i18n-html element (left to right; a translated element's inside is skipped).
function translateElements(html) {
  const open = /<([a-zA-Z][\w-]*)\b[^>]*?\sdata-i18n(-html)?="([^"]+)"[^>]*>/g;
  let out = "", pos = 0;
  for (let m; (m = open.exec(html));) {
    const tag = m[1], isHtml = !!m[2], key = m[3];
    const start = m.index + m[0].length, end = innerEnd(html, tag, start);
    const cur = html.slice(start, end);
    const val = en(key, null);
    out += html.slice(pos, start) + (val == null ? cur : isHtml ? val : escText(val));
    pos = end; open.lastIndex = end;
  }
  return out + html.slice(pos);
}
function translateAttrs(html) {
  return html.replace(/<[a-zA-Z][\w-]*\b[^>]*\sdata-i18n-attr="([^"]+)"[^>]*>/g, (tag, spec) => {
    for (const pair of spec.split(",")) {
      const [attr, key] = pair.split(":").map((x) => (x || "").trim());
      if (!attr || !key) continue;
      const val = en(key, null); if (val == null) continue;
      const re = new RegExp(`(\\s${attr.replace(/[-]/g, "\\-")}=")[^"]*(")`);
      tag = re.test(tag) ? tag.replace(re, (_a, p, q) => p + escAttr(val) + q) : tag;
    }
    return tag;
  });
}
// Relative file links ("../assets/...") become absolute, and links to our pages lead to their English page.
function fixUrls(html, pageUrl) {
  const pagePaths = new Set(ALL_PAGES.map((p) => "/" + p));
  return html.replace(/\s(src|href|srcset|poster)="([^"]*)"/g, (all, attr, val) => {
    const conv = (u) => {
      u = u.trim(); if (!u || /^(#|[a-z][a-z0-9+.-]*:|\/\/)/i.test(u)) return u;
      const abs = u.startsWith("/") ? u : new URL(u, ORIGIN + pageUrl).pathname + (new URL(u, ORIGIN + pageUrl).search) + (new URL(u, ORIGIN + pageUrl).hash);
      const p = abs.split(/[?#]/)[0];
      return pagePaths.has(p) && attr === "href" ? "/en" + abs : abs;
    };
    const v = attr === "srcset" ? val.split(",").map((part) => { const [u, ...rest] = part.trim().split(/\s+/); return [conv(u), ...rest].join(" "); }).join(", ") : conv(val);
    return ` ${attr}="${v}"`;
  });
}
// hreflang block, written into both versions (replaces an earlier one).
function withAlternates(html, page) {
  html = html.replace(/\n\s*<link rel="alternate" hreflang="[^"]+" href="[^"]*">/g, "");
  const block = [["id", `${ORIGIN}/${page}`], ["en", `${ORIGIN}/en/${page}`], ["x-default", `${ORIGIN}/en/${page}`]]
    .map(([l, u]) => `\n  <link rel="alternate" hreflang="${l}" href="${u}">`).join("");
  return html.replace(/(<link rel="canonical" href="[^"]*">)/, `$1${block}`);
}
// FAQPage from the visible questions (both languages; the Indonesian page gets it too).
function withFaq(html, lang) {
  html = html.replace(/\n\s*<script type="application\/ld\+json" data-gen="faq">[\s\S]*?<\/script>/, "");
  const qs = [...html.matchAll(/data-i18n="(home\.faqQ\w+)"/g)].map((m) => m[1]);
  if (!qs.length) return html;
  const t = lang === "en" ? EN : ID;
  const items = qs.map((q) => ({ "@type": "Question", name: plain(t[q]), acceptedAnswer: { "@type": "Answer", text: plain(t[q.replace("faqQ", "faqA")] || "") } })).filter((x) => x.acceptedAnswer.text);
  const ld = JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", inLanguage: lang, mainEntity: items }, null, 2).replace(/\n/g, "\n  ");
  return html.replace("</head>", `  <script type="application/ld+json" data-gen="faq">\n  ${ld}\n  </script>\n</head>`);
}
// JSON-LD in English: a string that is an Indonesian dictionary value becomes the English value.
const idToEn = new Map();
for (const [k, v] of Object.entries(ID)) if (EN[k] != null) { idToEn.set(v, EN[k]); idToEn.set(plain(v), plain(EN[k])); }
function translateLd(html, page) {
  return html.replace(/(<script type="application\/ld\+json"(?! data-gen)[^>]*>)([\s\S]*?)(<\/script>)/g, (all, a, body, b) => {
    let j; try { j = JSON.parse(body); } catch { return all; }
    const walk = (x) => {
      if (typeof x === "string") return idToEn.has(x) ? idToEn.get(x) : x.startsWith(ORIGIN + "/") && ALL_PAGES.includes(x.slice(ORIGIN.length + 1)) ? ORIGIN + "/en/" + x.slice(ORIGIN.length + 1) : x;
      if (Array.isArray(x)) return x.map(walk);
      if (x && typeof x === "object") { const o = {}; for (const [k, v] of Object.entries(x)) o[k] = k === "inLanguage" && typeof v === "string" ? "en" : walk(v); return o; }
      return x;
    };
    const indent = (body.match(/\n(\s*)\{/) || [, "  "])[1];
    return a + "\n" + indent + JSON.stringify(walk(j), null, 2).replace(/\n/g, "\n" + indent) + "\n  " + b;
  });
}
// Each page has its own red sharing picture (website/assets/img/og/<page>-id.png / -en.png, made by
// rilis/catatan/konsep-readme/pembuat-gambar/render.cjs); the English page gets the -en one and this description.
const OG_ALT_EN = {
  "": "Free remote desktop, no account: TryDesk on a red background with the app's Home screen",
  "downloads/": "Download TryDesk: TryDesk on a red background with the app's Home screen",
  "donate/": "Help TryDesk stay alive: a big white heart with a heartbeat line on a red background",
  "sponsor/": "Become a TryDesk sponsor: a big white server stack on a red background",
  "source/": "Open code, yours to check: big code brackets with a red slash on a red background",
  "source/code/": "Browse the code: a big magnifying glass over lines of code on a red background",
  "privacy/": "Privacy policy: a big white padlock on a red background",
  "terms/": "Terms and conditions: a page of rules with a red check mark on a red background",
};
function englishPage(idHtml, page) {
  let h = idHtml;
  h = h.replace(/<html lang="id"/, '<html lang="en"');
  h = translateElements(h);
  h = translateAttrs(h);
  h = translateLd(h, page);
  h = withFaq(h, "en");
  // sharing tags follow the page's own (English) title and description
  const title = plain((h.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || "");
  const desc = (h.match(/<meta name="description"[^>]*\scontent="([^"]*)"/) || [])[1] || "";
  h = h.replace(/(<meta (?:property|name)="(?:og|twitter):title" content=")[^"]*(")/g, `$1${escAttr(title)}$2`)
       .replace(/(<meta (?:property|name)="(?:og|twitter):description" content=")[^"]*(")/g, `$1${desc}$2`)
       .replace(/(<meta property="og:image:alt" content=")[^"]*(")/, `$1${escAttr(OG_ALT_EN[page] || en("og.imageAlt", "TryDesk"))}$2`)
       .replace(/(\/assets\/img\/og\/[a-z]+)-id\.png/g, "$1-en.png")
       .replace(/(<link rel="canonical" href=")https:\/\/trydesk\.ai\.id\/([^"]*")/, `$1${ORIGIN}/en/$2`)
       .replace(/(<meta property="og:url" content=")https:\/\/trydesk\.ai\.id\/([^"]*")/, `$1${ORIGIN}/en/$2`)
       .replace(/\n\s*<meta property="og:locale:alternate" content="[^"]*">/g, "")
       .replace(/<meta property="og:locale" content="id_ID">/, '<meta property="og:locale" content="en_US">\n  <meta property="og:locale:alternate" content="id_ID">');
  h = fixUrls(h, "/" + page);
  h = withAlternates(h, page);
  // the note goes after the doctype (nothing may come before it)
  return h.replace(/^(<!DOCTYPE html>\n?)/i, `$1<!-- Made by scripts/build-site-en.mjs from /${page}index.html; edit the Indonesian page and i18n.js, not this file. -->\n`);
}

const written = [];
for (const page of PAGES) {
  const file = path.join(SITE, page, "index.html");
  let idHtml = fs.readFileSync(file, "utf8");
  // the Indonesian page: hreflang + FAQPage + og:locale:alternate (idempotent)
  let idNew = withFaq(withAlternates(idHtml, page), "id");
  if (!/og:locale:alternate/.test(idNew)) idNew = idNew.replace(/(<meta property="og:locale" content="id_ID">)/, '$1\n  <meta property="og:locale:alternate" content="en_US">');
  idNew = withDiscordEmbed(idNew, "id"); // Discord card with buttons, from the page's own sharing tags
  if (!CHECK && idNew !== idHtml) fs.writeFileSync(file, idNew, "utf8");
  const enHtml = withDiscordEmbed(englishPage(idNew, page), "en");
  const out = path.join(SITE, "en", page, "index.html");
  if (!CHECK) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, enHtml, "utf8"); }
  written.push("/en/" + page);
}

// sitemap: every page in both languages, each with its alternates; lastmod kept per URL (new URLs: today)
const smFile = path.join(SITE, "sitemap.xml");
const oldSm = fs.readFileSync(smFile, "utf8");
const last = new Map([...oldSm.matchAll(/<loc>([^<]+)<\/loc><lastmod>([\d-]+)<\/lastmod>/g)].map((m) => [m[1], m[2]]));
const d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const alts = (p) => `\n    <xhtml:link rel="alternate" hreflang="id" href="${ORIGIN}/${p}"/>\n    <xhtml:link rel="alternate" hreflang="en" href="${ORIGIN}/en/${p}"/>\n    <xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}/en/${p}"/>`;
const urls = ALL_PAGES.flatMap((p) => [`${ORIGIN}/${p}`, `${ORIGIN}/en/${p}`].map((loc) => `  <url>\n    <loc>${loc}</loc><lastmod>${last.get(loc) || last.get(loc.replace("/en/", "/")) || today}</lastmod>${alts(p)}\n  </url>`));
const sm = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`;
if (!CHECK) fs.writeFileSync(smFile, sm, "utf8");

// llms-full.txt: what an AI assistant should know, in plain text, from the same texts as the pages
const section = (t, prefix) => Object.entries(t).filter(([k]) => k.startsWith(prefix)).map(([, v]) => plain(v)).filter(Boolean);
const faq = (t) => Object.keys(t).filter((k) => /^home\.faqQ\w+$/.test(k)).map((q) => `Q: ${plain(t[q])}\nA: ${plain(t[q.replace("faqQ", "faqA")] || "")}`);
const full = [
  "# TryDesk: full reference for AI assistants",
  `Source: ${ORIGIN}/ (Indonesian) and ${ORIGIN}/en/ (English). Generated from the website text by scripts/build-site-en.mjs.`,
  "", "## English", "", "### FAQ", ...faq(EN), "", "### Documentation", docsText("en"),
  "", "## Bahasa Indonesia", "", "### FAQ", ...faq(ID), "", "### Dokumentasi", docsText("id"), "",
].join("\n");
if (!CHECK) fs.writeFileSync(path.join(SITE, "llms-full.txt"), full, "utf8");

// a missing English text would leave Indonesian on an English page: the release stops
if (missing.size) { console.log(`SITE-EN: FAIL ${missing.size} English text(s) missing in i18n.js: ${[...missing].slice(0, 12).join(", ")}`); process.exit(1); }
console.log(`SITE-EN: ${CHECK ? "checked" : "wrote"} ${written.length} English pages (${written.join(" ")}), sitemap ${urls.length} URLs, llms-full.txt ${full.length} chars`);
