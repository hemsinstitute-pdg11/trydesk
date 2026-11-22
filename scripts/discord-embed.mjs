// Discord "Component Embeds" (https://docs.discord.com/developers/link-previews/component-embeds): when a TryDesk link
// is pasted in Discord, Discord shows this card instead of the plain preview: red side line, the page title as a link,
// the description, the page's red picture and three link buttons (Visit website, Download, Guide).
// Rules from Discord: JSON in <head>, server-rendered, max 3,000 bytes, one Container (type 17), buttons only link
// style (5) with label/url. The Open Graph tags stay as the fallback (and for WhatsApp, X, Facebook).
// Used by build-site-en.mjs (main pages, both languages) and build-docs.mjs (docs pages).
const ORIGIN = "https://trydesk.ai.id";
const RED = 0xd92b25;
const LABELS = {
  id: ["Kunjungi Website", "Unduh", "Panduan"],
  en: ["Visit website", "Download", "Guide"],
};
const md = (s) => String(s).replace(/([\\[\]*_~`>#|])/g, "\\$1");
const unent = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export function discordEmbed({ title, desc, url, image, alt, lang }) {
  const pre = lang === "en" ? "/en" : "";
  const [visit, dl, guide] = LABELS[lang === "en" ? "en" : "id"];
  const item = { media: { url: image } };
  if (alt) item.description = unent(alt).slice(0, 256);
  const payload = { component: { type: 17, accent_color: RED, components: [
    { type: 10, content: `-# TryDesk\n### [${md(unent(title))}](${url})\n${md(unent(desc))}` },
    { type: 12, items: [item] },
    { type: 1, components: [
      { type: 2, style: 5, label: visit, url: `${ORIGIN}${pre}/` },
      { type: 2, style: 5, label: dl, url: `${ORIGIN}${pre}/downloads/` },
      { type: 2, style: 5, label: guide, url: `${ORIGIN}${pre}/docs/` },
    ] },
  ] } };
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  if (Buffer.byteLength(json) > 3000) throw new Error(`discord embed over 3000 bytes for ${url}`);
  return `<script id="discord:component-embed" type="application/json">${json}</script>`;
}

// Adds (or refreshes) the card in a finished page, taking everything from the page's own sharing tags.
export function withDiscordEmbed(html, lang) {
  const get = (re) => (html.match(re) || [])[1];
  const title = get(/<meta property="og:title" content="([^"]*)"/);
  const desc = get(/<meta property="og:description" content="([^"]*)"/);
  const url = get(/<meta property="og:url" content="([^"]*)"/);
  const image = get(/<meta property="og:image" content="([^"]*)"/);
  const alt = get(/<meta property="og:image:alt" content="([^"]*)"/);
  const clean = html.replace(/\n?\s*<script id="discord:component-embed"[^>]*>[\s\S]*?<\/script>/, "");
  if (!title || !url || !image) return clean;
  const tag = discordEmbed({ title, desc: desc || "", url, image, alt, lang });
  return clean.replace(/(\n\s*)<\/head>/, (m, nl) => `${nl}  ${tag}${nl}</head>`);
}
