// Puts TryDesk's own portable launcher (scripts/portable.nsi: one fixed folder, never emptied under a running copy)
// in place of electron-builder's template before a Windows build. Run by npm "prebuild" / "prebuild:portable".
// Stops the build if electron-builder's template is not the one this copy was made from (an upgrade changed it): then
// scripts/portable.nsi must be redone from the new template first.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(ROOT, "node_modules", "app-builder-lib", "templates", "nsis", "portable.nsi");
const OURS = path.join(ROOT, "scripts", "portable.nsi");
const KNOWN_STOCK = "80fa75cf8cb68f4999eb92afc9f37f8e5b605cb1c3a077821bbc350a9b907a48";   // sha256 of electron-builder 26.x portable.nsi (CRLF normalised)
const sha = (s) => crypto.createHash("sha256").update(s.replace(/\r\n/g, "\n")).digest("hex");

const ours = fs.readFileSync(OURS, "utf8");
const cur = fs.readFileSync(TEMPLATE, "utf8");
if (sha(cur) === sha(ours)) { console.log("portable launcher: TryDesk's already in place"); process.exit(0); }
// An older TryDesk copy (put there by an earlier build) is replaced like the stock template.
const oursBefore = cur.startsWith("; TryDesk's own copy of electron-builder's portable.nsi");
if (sha(cur) !== KNOWN_STOCK && !oursBefore) {
  console.error("portable launcher: electron-builder's portable.nsi changed (" + sha(cur).slice(0, 12) + "), redo scripts/portable.nsi from it");
  process.exit(1);
}
fs.writeFileSync(TEMPLATE, ours);
console.log("portable launcher: TryDesk's in place (fixed folder %TEMP%\\TryDesk-Portable)");
