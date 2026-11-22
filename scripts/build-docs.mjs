// The Documentation, one page per topic (owner pick 17 Nov 2026: concept "Arah C, Seperti Pengaturan aplikasi").
// Writes, from the content below plus the docs.* texts already in website/assets/js/i18n.js:
//   website/docs/index.html            the overview (Ringkasan): latest version, three ways in, every guide
//   website/docs/<slug>/index.html     one page per topic, and website/docs/changelog/index.html
//   website/en/docs/...                the same pages in English (this script writes them; build-site-en.mjs does not)
//   website/assets/js/docs-search.js   the search list for the menu's search field (both languages)
// The layout is the app's own Settings: a menu panel with an icon, a name and one line per entry, rows with 4 px
// between them, small grey section labels. CSS: "Docs (Arah C)" block at the end of website/assets/css/custom.css.
// Behaviour: website/assets/js/docs.js. Old one-page links (/docs/#versi and the like) are sent to their new page
// by docs.js on the overview.
// Run by scripts/build-site-en.mjs (so every release builds it); also by hand: node scripts/build-docs.mjs [--check]
//   --check: build in memory only, fail if a text is missing or a docs.* text of the old page is used nowhere.
// To add a release to the changelog: add it at the top of VERSIONS (both languages). The overview's "what is new"
// takes the first three items of the newest version.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discordEmbed } from "./discord-embed.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "website");
const ORIGIN = "https://trydesk.ai.id";
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

// ---------------------------------------------------------------------------------------------------- content
// A text is either a docs.* (or other) key of i18n.js, a plain string that is the same in both languages, or
// { id, en }. Keys keep the text in one place: the old page's texts and their English are reused as they are.

export const GROUPS = [
  { id: "mulai", ic: "book", t: { id: "Mulai", en: "Getting started" }, d: { id: "Pertama kali, instal, kebutuhan", en: "First time, install, requirements" } },
  { id: "menyambung", ic: "link", t: { id: "Menyambung", en: "Connecting" }, d: { id: "ID, password, lewat IP", en: "ID, password, by IP" } },
  { id: "sesi", ic: "sliders", t: { id: "Selama sesi", en: "During a session" }, d: { id: "Control Center, file, chat", en: "Control Center, files, chat" } },
  { id: "lain", ic: "phone", t: { id: "Dari HP, Mac, Linux", en: "From a phone, Mac, Linux" }, d: { id: "Mengontrol dari perangkat lain", en: "Control from other devices" } },
  { id: "host", ic: "monitor", t: { id: "PC Windows yang dikontrol", en: "The Windows PC you control" }, d: { id: "Layanan, administrator, Pengaturan", en: "Service, administrator, Settings" } },
  { id: "aman", ic: "shield", t: { id: "Keamanan dan privasi", en: "Security and privacy" }, d: { id: "Izin, enkripsi, penipuan", en: "Permissions, encryption, scams" } },
  { id: "ref", ic: "keyboard", t: { id: "Referensi", en: "Reference" }, d: { id: "Pintasan, jaringan, istilah", en: "Shortcuts, network, terms" } },
  { id: "bantuan", ic: "help", t: { id: "Bantuan", en: "Help" }, d: { id: "Masalah, FAQ, changelog", en: "Problems, FAQ, changelog" } },
];

const SHOT = (name, alt, cap, kind) => ["fig", name, alt, cap, kind || "pc"];
const PLAT_ALL = ["win", "and", "mac", "lnx"];

// Pages in menu order. Links to the home page FAQ and the support e-mail sit in the Help group as "links".
export const PAGES = [
  // ---- Mulai
  { slug: "new-here", g: "mulai", ic: "book",
    t: { id: "Baru pertama kali", en: "New to TryDesk" }, d: { id: "Apa itu remote desktop, ID, dan siapa mengontrol siapa.", en: "What remote desktop is, the ID, and who controls whom." },
    k: "host viewer pemula istilah beginner",
    lede: { id: "Penjelasan singkat sebelum Anda menyambung untuk pertama kali.", en: "A short explanation before you connect for the first time." },
    body: [["p", "docs.newP1"], ["h2", "dua", "docs.newH3a"], ["ul", ["docs.newL1", "docs.newL2"]], ["h2", "cara", "docs.newH3b"], ["p", "docs.newP2"],
      ["note", "warn", "docs.newH3c", "docs.newL4"]],
    rel: ["quick-start", "glossary", "scams"] },
  { slug: "quick-start", g: "mulai", ic: "book",
    t: { id: "Mulai cepat", en: "Quick start" }, d: { id: "Tersambung dalam tiga langkah.", en: "Connected in three steps." }, k: "mulai langkah start",
    lede: { id: "Dari dua TryDesk yang terbuka sampai layar PC lain tampil di jendela Anda.", en: "From two open TryDesk windows to the other PC on your screen." },
    body: [["p", "docs.quickP1"], ["ol", ["docs.quickL1", "docs.quickL2", "docs.quickL3"]], ["p", "docs.quickP2"],
      ["fig", "/assets/img/app-preview.png", "docs.quickImgAlt", "docs.quickCap", "pc"]],
    rel: ["connect-by-id", "access-password", "connect-by-ip"] },
  { slug: "install", g: "mulai", ic: "book", plat: true,
    t: { id: "Menginstal TryDesk", en: "Installing TryDesk" }, d: { id: "Setup atau Portable di Windows, lalu Android, Mac, dan Linux.", en: "Setup or Portable on Windows, then Android, Mac and Linux." }, k: "install setup portable unduh download apk update pembaruan perbarui otomatis",
    lede: { id: "Pilih perangkat yang mau dipasangi TryDesk.", en: "Pick the device you are installing TryDesk on." },
    body: [
      ["only", "win", [["p", "docs.instP1"], ["ul", ["docs.instL1", "docs.instL2"]]]],
      ["only", "and", [["p", "docs.andP1"], ["p", { id: "Butuh Android 7.0 atau lebih baru.", en: "Needs Android 7.0 or newer." }]]],
      ["only", "mac", [["p", "docs.macP1"], ["ul", ["docs.macL1", "docs.macL2", "docs.macL3", "docs.macL4"]], ["p", "docs.macFix"]]],
      ["only", "lnx", [["p", { id: "TryDesk untuk Linux dipakai untuk <b>mengontrol PC Windows</b>. Unduh salah satu file di halaman <a href=\"/downloads/\">Download</a>:", en: "TryDesk for Linux is for <b>controlling Windows PCs</b>. Get one of the files on the <a href=\"/downloads/\">Download</a> page:" }],
        ["ul", [{ id: "<b>AppImage</b> (hampir semua distro): izinkan file dijalankan (<code>chmod +x</code>), lalu buka.", en: "<b>AppImage</b> (almost any distro): allow the file to run (<code>chmod +x</code>), then open it." },
          { id: "<b>.deb</b> (Ubuntu dan Debian): pasang lewat aplikasi Software atau apt.", en: "<b>.deb</b> (Ubuntu and Debian): install it with the Software app or apt." }]]]],
      ["h2", "semua", { id: "Untuk semua perangkat", en: "For every device" }], ["p", "docs.instP2"], ["p", "docs.instP3"],
      // in-app updates (owner 18 Nov 2026, src/updater.js)
      ["h2", "perbarui", { id: "Memperbarui TryDesk", en: "Updating TryDesk" }],
      ["p", { id: "Mulai 1.4.0, TryDesk memperbarui dirinya sendiri. Versi baru diunduh di latar, diperiksa dengan tanda tangan TryDesk, lalu dipasang saat TryDesk ditutup atau dibuka lagi. Selama sesi berjalan tidak ada yang dipasang, dan pita di Beranda menunjukkan keadaannya.", en: "From 1.4.0 on, TryDesk updates itself. The new version downloads in the background, is checked against TryDesk's signature, and installs when TryDesk is closed or opened again. Nothing installs while a session runs, and a strip on Home shows where it stands." }],
      // per platform (src/updater.js kinds + mobile TdUpdatePlugin; audited 21 Nov 2026)
      ["ul", [{ id: "<b>Windows Setup</b>: versi baru dipasang diam-diam saat TryDesk ditutup atau dibuka lagi.", en: "<b>Windows Setup</b>: the new version installs quietly when TryDesk closes or opens again." },
        { id: "<b>Windows Portable</b>: file Portable diganti dengan versi baru di tempat yang sama.", en: "<b>Windows Portable</b>: the Portable file is replaced by the new version in the same place." },
        { id: "<b>Mac</b>: TryDesk.app di folder Applications diganti. Bila macOS meminta password Mac, masukkan sekali.", en: "<b>Mac</b>: TryDesk.app in the Applications folder is replaced. If macOS asks for your Mac password, enter it once." },
        { id: "<b>Linux</b>: file AppImage diganti di tempatnya. Versi .deb dipasang lewat jendela izin Linux (password Anda).", en: "<b>Linux</b>: the AppImage is replaced where it is. The .deb version installs through Linux's permission window (your password)." },
        { id: "<b>Android</b>: APK baru diunduh dari trydesk.ai.id dan diperiksa dulu, lalu Android sendiri bertanya \"Perbarui aplikasi ini?\". Pertama kali, Android meminta izin <b>Instal aplikasi tak dikenal</b> untuk TryDesk. Bila izin itu dikunci (misalnya di Google Play Games untuk PC), unduh APK dari halaman Download.", en: "<b>Android</b>: the new APK downloads from trydesk.ai.id and is checked first, then Android itself asks \"Update this app?\". The first time, Android asks to allow <b>Install unknown apps</b> for TryDesk. If that permission is locked (for example in Google Play Games for PC), download the APK from the Download page." },
        { id: "Status pembaruan dan tombol <b>Cek sekarang</b> ada di <span class=\"dc-path\">Pengaturan › Tentang</span>. TryDesk mengecek saat dibuka, lalu tiap 6 jam. Unduhan yang terputus dilanjutkan, dan file yang tanda tangannya tidak cocok tidak pernah dipasang.", en: "The update status and a <b>Check now</b> button are in <span class=\"dc-path\">Settings › About</span>. TryDesk checks when it opens, then every 6 hours. An interrupted download resumes, and a file whose signature doesn't match is never installed." },
        { id: "Untuk pindah dari versi 1.3.9 atau lebih lama ke 1.4.0, unduh sekali lagi dari halaman Download. Pembaruan otomatis berlaku mulai versi sesudah 1.4.0.", en: "To move from 1.3.9 or older to 1.4.0, download it once more from the Download page. Automatic updates apply from the version after 1.4.0." }]],
      ["ul", [{ id: "<b>Windows</b> (Setup dan Portable), <b>macOS</b>, dan <b>Linux AppImage</b>: tanpa langkah apa pun. Bila tidak ingin menunggu, tekan <b>Pasang sekarang</b>.", en: "<b>Windows</b> (Setup and Portable), <b>macOS</b> and <b>Linux AppImage</b>: nothing to do. If you don't want to wait, press <b>Install now</b>." },
        { id: "<b>Android</b> selalu bertanya sekali sebelum memasang. Pertama kali, Android juga meminta izin memasang dari TryDesk.", en: "<b>Android</b> always asks once before it installs. The first time, Android also asks to allow installs from TryDesk." },
        { id: "<b>Linux .deb</b>: Linux meminta password Anda saat memasang. <b>macOS</b> meminta password Mac hanya bila TryDesk ada di folder milik administrator.", en: "<b>Linux .deb</b>: Linux asks for your password while it installs. <b>macOS</b> asks for the Mac's password only when TryDesk sits in a folder owned by an administrator." },
        { id: "Pembaruan wajib (perbaikan keamanan) tampil sebagai pita merah dan sudah diunduh lebih dulu, jadi cukup satu klik.", en: "A required update (a security fix) shows as a red strip and is downloaded ahead, so one click is enough." }]],
      ["p", { id: "Sakelarnya ada di <b>Pengaturan › Tentang › Pembaruan otomatis</b>. Bila dimatikan, TryDesk tetap memberi tahu versi baru dan Anda yang menekan <b>Perbarui</b>.", en: "The switch is in <b>Settings › About › Automatic updates</b>. With it off, TryDesk still tells you about new versions and you press <b>Update</b>." }],
      ["note", "info", { id: "Dari versi lama", en: "From an older version" }, { id: "TryDesk 1.3.9 ke bawah belum punya fitur ini. Pasang 1.4.0 sekali dari halaman <a href=\"/downloads/\">Download</a>; sesudah itu pembaruan berjalan dari aplikasi.", en: "TryDesk 1.3.9 and older don't have this yet. Install 1.4.0 once from the <a href=\"/downloads/\">Download</a> page; after that, updates come from the app." }]],
    rel: ["requirements", "windows-service", "mac"] },
  { slug: "requirements", g: "mulai", ic: "book",
    t: { id: "Kebutuhan sistem", en: "System requirements" }, d: { id: "Versi Windows, Android, macOS, dan Linux yang didukung.", en: "Supported Windows, Android, macOS and Linux versions." }, k: "windows 10 11 android 7 macos 13 linux platform requirements",
    lede: { id: "Perangkat mana yang bisa dikontrol, mana yang bisa mengontrol, dan versi sistemnya.", en: "Which devices can be controlled, which can control, and the system versions." },
    body: [["p", "docs.platP1"],
      ["table", ["docs.platTh1", "docs.platTh2", "docs.platTh3"], [
        ["Windows 10 / 11", "docs.platWinH", "docs.platWinV"], ["Linux (AppImage / .deb)", "docs.platLnxH", "docs.platLnxV"],
        ["Android 7.0+", "docs.platAndH", "docs.platAndV"], ["macOS 13+ (Apple Silicon / Intel)", "docs.platMacH", "docs.platMacV"], ["iOS", "docs.platIosH", "docs.platIosV"]]],
      ["p", "docs.platP2"],
      ["h2", "versi", { id: "Versi sistem", en: "System versions" }],
      ["ul", [{ id: "<b>Windows 10 atau 11.</b> Windows 7 dan 8 tidak didukung. Menggelapkan layar PC yang dikontrol butuh Windows 10 versi 2004 atau lebih baru.", en: "<b>Windows 10 or 11.</b> Windows 7 and 8 are not supported. Darkening the controlled PC's screen needs Windows 10 version 2004 or newer." },
        { id: "<b>Android 7.0</b> atau lebih baru.", en: "<b>Android 7.0</b> or newer." },
        { id: "<b>macOS 13 Ventura</b> atau lebih baru, Apple Silicon atau Intel.", en: "<b>macOS 13 Ventura</b> or newer, Apple Silicon or Intel." },
        { id: "<b>Linux 64-bit</b> (x86_64): AppImage untuk hampir semua distro, .deb untuk Ubuntu dan Debian.", en: "<b>64-bit Linux</b> (x86_64): AppImage for almost any distro, .deb for Ubuntu and Debian." }]],
      ["h2", "belum", "docs.platH3"], ["ul", ["docs.platL1", "docs.platL2", "docs.platL3"]]],
    rel: ["install", "windows-service", "linux"] },
  // ---- Menyambung
  { slug: "connect-by-id", g: "menyambung", ic: "link",
    t: { id: "Menyambung lewat ID", en: "Connecting by ID" }, d: { id: "Ketik ID 9 digit, lalu Hubungkan.", en: "Type the 9-digit ID, then Connect." }, k: "hubungkan id 9 digit connect",
    lede: { id: "Cara menyambung ke PC lain dengan ID-nya, dari mana saja lewat internet.", en: "How to reach another PC by its ID, from anywhere over the internet." },
    body: [["p", "docs.connP1"], SHOT("hubungkan", "docs.shotConnAlt", "docs.shotConnCap"), ["p", "docs.connP2"],
      ["note", "info", { id: "Ada password akses?", en: "Is there an access password?" }, { id: "Ketik di kolom Password sebelum klik Hubungkan, supaya Anda langsung masuk tanpa menunggu Terima. Lihat <a href=\"/docs/access-password/\">Password akses</a>.", en: "Type it in the Password box before you click Connect, so you get in without waiting for Accept. See <a href=\"/docs/access-password/\">Access password</a>." }]],
    rel: ["access-password", "accept", "errors"] },
  { slug: "access-password", g: "menyambung", ic: "link",
    t: { id: "Password akses", en: "Access password" }, d: { id: "Masuk tanpa menunggu Terima di PC milik sendiri.", en: "Get in without waiting for Accept on your own PC." }, k: "password unattended tanpa ditunggui",
    lede: { id: "Untuk PC milik Anda sendiri yang sering dibuka dari jauh, tanpa ada orang yang menekan Terima.", en: "For your own PC that you open from afar, with nobody there to press Accept." },
    body: [["h2", "pasang", { id: "Memasang password di PC Anda", en: "Setting a password on your PC" }], ["p", "docs.accP2"], SHOT("keamanan", "docs.secImgAlt", "docs.secCap", "png"),
      ["h2", "memakai", "docs.connPwH"], ["p", "docs.connPwP1"], ["ul", ["docs.connPwL1", "docs.connPwL2", "docs.connPwL5", "docs.connPwL3", "docs.connPwL4"]],
      SHOT("minta-password", "docs.shotPwAlt", "docs.shotPwCap")],
    rel: ["connect-by-ip", "windows-service", "security"] },
  { slug: "accept", g: "menyambung", ic: "link",
    t: { id: "Menerima permintaan", en: "Accepting a request" }, d: { id: "Layar merah, izin yang diminta, lalu Terima atau Tolak.", en: "The red screen, the rights asked for, then Accept or Decline." }, k: "terima tolak permintaan accept decline",
    lede: { id: "Yang terjadi di PC Anda saat orang lain ingin menyambung.", en: "What happens on your PC when someone wants to connect." },
    body: [["p", "docs.accP1"], SHOT("accept", "docs.accImgAlt", "docs.accCap", "png"), ["p", "docs.accP3"], ["note", "warn", "docs.newH3c", "docs.newL3"]],
    rel: ["access-password", "permissions", "scams"] },
  { slug: "connect-by-ip", g: "menyambung", ic: "link", plat: true, ipGuide: true,
    t: { id: "Sambung lewat IP", en: "Connect by IP" }, d: { id: "Satu jaringan, tanpa internet dan tanpa server.", en: "Same network, no internet and no server." }, k: "lan ip jaringan lokal firewall 7171 network",
    lede: { id: "Sambungkan dua perangkat di jaringan yang sama, misalnya di rumah, kantor, warnet, atau lab, memakai alamat IP. Tidak perlu internet dan tidak lewat server TryDesk.", en: "Connect two devices on the same network, at home, at the office, in an internet cafe or a lab, by IP address. No internet needed, and nothing goes through a TryDesk server." },
    rel: ["access-password", "network", "troubleshooting"] },
  { slug: "devices", g: "menyambung", ic: "link",
    t: { id: "Perangkat dan Favorit", en: "Devices and Favorites" }, d: { id: "Terakhir dihubungi, ganti nama, dan favorit.", en: "Recent devices, renaming, favorites." }, k: "favorit terakhir dihubungi recent favorite",
    lede: { id: "PC yang pernah Anda hubungi, siap disambung lagi dengan satu klik.", en: "The PCs you have reached before, one click away." },
    body: [["p", "docs.connP3"], SHOT("koneksi-terakhir", "docs.shotRecentAlt", "docs.shotRecentCap"),
      ["p", { id: "Titik di sudut gambar setiap PC menunjukkan keadaannya sekarang: <b>hijau</b> berarti PC itu online dan bisa dihubungi, <b>abu-abu</b> berarti offline. PC yang disambung lewat alamat IP tidak punya titik.", en: "The dot on each PC's picture shows its state right now: <b>green</b> means that PC is online and can be reached, <b>grey</b> means it is offline. PCs reached by IP address have no dot." }],
      ["h2", "kelola", { id: "Kelola banyak perangkat", en: "Manage many devices" }],
      ["p", { id: "Untuk yang mengurus banyak PC sekaligus, misalnya kantor atau lab: kelompok, menyambung atau memutus beberapa PC sekaligus, dan mengirim file yang sama ke semuanya. Buka lewat tautan <b>Kelola banyak perangkat</b> di Beranda (di samping Semua perangkat). Panduan lengkapnya ada di <a href=\"/docs/manage-devices/\">Kelola banyak perangkat</a>.", en: "For looking after many PCs at once, such as an office or a lab: groups, connecting or disconnecting several PCs at once, and sending the same file to all of them. Open it with the <b>Manage many devices</b> link on Home (next to All devices). The full guide is at <a href=\"/docs/manage-devices/\">Manage many devices</a>." }]],
    rel: ["manage-devices", "connect-by-id", "tabs"] },
  // Kelola banyak perangkat (1.4.0, src/renderer/app.js ~12170-12870)
  { slug: "manage-devices", g: "menyambung", ic: "link",
    t: { id: "Kelola banyak perangkat", en: "Manage many devices" }, d: { id: "Kelompok, sambung atau putus beberapa PC, kirim file ke semuanya.", en: "Groups, connect or disconnect several PCs, send files to all of them." },
    k: "kelola banyak perangkat kelompok group pilih select sambung beberapa sekaligus kirim file massal manage many devices bulk",
    lede: { id: "Satu layar untuk mengurus banyak PC sekaligus, misalnya di kantor, lab, atau warnet.", en: "One screen for looking after many PCs at once, for example in an office, a lab or an internet cafe." },
    body: [
      ["p", { id: "Sejak 1.4.0, semua PC yang tersimpan tampil sebagai gambar di satu layar. Dari sana Anda bisa mengumpulkannya dalam kelompok, menyambung atau memutus beberapa PC sekaligus, dan mengirim file yang sama ke semuanya. Layar ini ada di TryDesk untuk Windows, macOS, Linux, dan Android.", en: "Since 1.4.0, every saved PC shows as a picture on one screen. From there you can put them into groups, connect or disconnect several PCs at once, and send the same file to all of them. This screen is in TryDesk for Windows, macOS, Linux and Android." }],
      SHOT("kelola", { id: "Layar Kelola banyak perangkat di TryDesk: tab kelompok Semua, Kantor, Toko, dan Lab, delapan PC sebagai gambar dengan titik online, satu PC tersambung bertanda Langsung", en: "TryDesk's Manage many devices screen: group tabs All, Kantor, Toko and Lab, eight PCs as pictures with online dots, one connected PC marked Live" },
        { id: "Kelola banyak perangkat: kelompok di atas, setiap PC sebagai gambar. PC yang tersambung bertanda Langsung, titik hijau berarti online.", en: "Manage many devices: groups at the top, every PC as a picture. A connected PC is marked Live, a green dot means online." }),
      ["h2", "buka", { id: "Membukanya", en: "Opening it" }],
      ["ul", [{ id: "Di <b>Beranda</b>, klik <b>Kelola banyak perangkat</b> di baris Terakhir dihubungi, di samping <b>Semua perangkat</b>.", en: "On <b>Home</b>, click <b>Manage many devices</b> in the Recent row, next to <b>All devices</b>." },
        { id: "Di HP Android: di Beranda, ketuk kartu <b>Kelola banyak perangkat</b> di bawah <b>Satu jaringan? Sambung lewat IP</b>.", en: "On an Android phone: on Home, tap the <b>Manage many devices</b> card under <b>Same network? Connect by IP</b>." },
        { id: "Selama sesi: <span class=\"dc-path\">Control Center › Kelola banyak perangkat</span> (Kembali ke daftar PC). Di HP, Control Center ada di tombol <b>Menu</b>.", en: "During a session: <span class=\"dc-path\">Control Center › Manage many devices</span> (Back to the PC list). On a phone, Control Center is the <b>Menu</b> button." }]],
      ["p", { id: "Yang tampil: 12 PC terakhir yang Anda hubungi, PC favorit, semua PC yang ada di kelompok (tetap tampil walau sudah lama tidak dihubungi), dan PC yang sedang tersambung. Urutannya dari yang terbaru.", en: "What shows: the last 12 PCs you reached, favourite PCs, every PC in a group (it stays even when you have not reached it for a while), and the PCs connected right now. Newest first." }],
      ["h2", "gambar", { id: "Gambar setiap PC", en: "Each PC's picture" }],
      ["ul", [{ id: "PC yang sedang tersambung menampilkan gambar layarnya yang diperbarui setiap detik, dengan tanda <b>Langsung</b>. Klik untuk membuka tabnya.", en: "A connected PC shows a picture of its screen that refreshes every second, marked <b>Live</b>. Click it to open its tab." },
        { id: "PC lain menampilkan gambar terakhir dengan keterangan <b>Terakhir</b> dan waktunya. Klik untuk menyambung seperti biasa.", en: "Other PCs show their last picture with <b>Last seen</b> and the time. Click to connect as usual." },
        { id: "Titik di depan nama: <b>hijau</b> berarti online, <b>abu-abu</b> berarti offline.", en: "The dot before the name: <b>green</b> means online, <b>grey</b> means offline." },
        { id: "Klik kanan gambar untuk <b>Hubungkan</b>, <b>Transfer file</b>, <b>Salin ID</b>, <b>Tambah ke favorit</b>, <b>Ganti nama</b>, atau <b>Hapus dari riwayat</b>.", en: "Right-click a picture for <b>Connect</b>, <b>File transfer</b>, <b>Copy ID</b>, <b>Add to favorites</b>, <b>Rename</b> or <b>Remove from history</b>." }]],
      ["h2", "kelompok", { id: "Kelompok", en: "Groups" }],
      ["ol", [{ id: "Klik tombol <b>+</b> (Kelompok baru) di samping tab kelompok, ketik namanya (paling banyak 24 huruf, misalnya Kantor), lalu <b>Buat kelompok</b>.", en: "Click the <b>+</b> button (New group) next to the group tabs, type its name (up to 24 characters, for example Office), then <b>Create group</b>." },
        { id: "Untuk memasukkan PC: tekan <b>Pilih</b>, klik gambar PC-nya, lalu <b>Kelompok</b> di bilah bawah dan pilih kelompoknya.", en: "To put PCs in it: press <b>Select</b>, click the PCs' pictures, then <b>Group</b> in the bottom bar and pick the group." },
        { id: "Setiap kelompok punya tab sendiri di atas, dengan jumlah PC-nya. Tab <b>Semua</b> selalu ada, dan <b>Tanpa kelompok</b> berisi PC yang belum masuk kelompok mana pun.", en: "Each group gets a tab at the top with its number of PCs. The <b>All</b> tab is always there, and <b>No group</b> holds the PCs that are in no group yet." }]],
      ["p", { id: "Ganti nama atau hapus kelompok lewat tombol pensil (<b>Atur kelompok</b>), atau klik kanan tab kelompoknya. Kalau kelompoknya banyak, geser baris kelompok ke kiri atau kanan (seret dengan mouse, atau putar roda mouse di atasnya). Menghapus kelompok tidak menghapus PC-nya: PC-nya tetap ada di <b>Semua</b>, dan tombol <b>Urungkan</b> muncul selama 6 detik untuk mengembalikannya.", en: "Rename or delete a group with the pencil button (<b>Manage groups</b>), or right-click its tab. With many groups, slide the group row left or right (drag it with the mouse, or turn the mouse wheel over it). Deleting a group never deletes its PCs: they stay in <b>All</b>, and an <b>Undo</b> button shows for 6 seconds to bring it back." }],
      ["h2", "pilih", { id: "Memilih beberapa PC", en: "Selecting several PCs" }],
      ["p", { id: "Tekan <b>Pilih</b>, lalu klik gambar PC yang Anda mau, atau <b>Pilih semua di halaman</b>. Bilah di bawah menunjukkan jumlah yang dipilih dan tombol ini:", en: "Press <b>Select</b>, then click the pictures of the PCs you want, or <b>Select this page</b>. The bar at the bottom shows how many are selected and these buttons:" }],
      ["table", [{ id: "Tombol", en: "Button" }, { id: "Fungsinya", en: "What it does" }], [
        [{ id: "Hubungkan", en: "Connect" }, { id: "Menyambung semua PC terpilih yang belum tersambung.", en: "Connects every selected PC that is not connected yet." }],
        [{ id: "Putuskan", en: "Disconnect" }, { id: "Memutus semua PC terpilih yang sedang tersambung. Layar ini tetap terbuka.", en: "Disconnects every selected PC that is connected. This screen stays open." }],
        [{ id: "Kirim file", en: "Send file" }, { id: "Mengirim file yang sama ke PC terpilih yang sedang tersambung.", en: "Sends the same file to the selected PCs that are connected." }],
        [{ id: "Kelompok", en: "Group" }, { id: "Memindahkan PC terpilih ke kelompok lain, ke Tanpa kelompok, atau ke kelompok baru.", en: "Moves the selected PCs to another group, to No group, or to a new group." }]]],
      ["h2", "sambung", { id: "Menyambung beberapa PC sekaligus", en: "Connecting several PCs at once" }],
      ["ol", [{ id: "Pilih PC-nya, lalu klik <b>Hubungkan</b>.", en: "Select the PCs, then click <b>Connect</b>." },
        { id: "Bila PC-nya memakai password akses, ketik passwordnya sekali. Password ini hanya dipakai untuk sambungan kali ini, lalu dibuang.", en: "If the PCs use an access password, type it once. It is used for this round of connections only, then thrown away." },
        { id: "TryDesk menyambung PC satu per satu (paling banyak 4 tiap 10 detik) dan menunjukkan berapa yang sudah tersambung, menunggu, dan antre. Tekan <b>Hentikan</b> untuk berhenti.", en: "TryDesk connects the PCs one after another (at most 4 every 10 seconds) and shows how many are connected, waiting and queued. Press <b>Stop</b> to stop." }]],
      ["p", { id: "PC tanpa password tetap meminta orang di sana menekan <b>Terima</b>. PC yang gagal menulis alasannya di gambarnya, misalnya Password salah, Ditolak di PC itu, Tidak dijawab, atau Offline. Tombol <b>Coba lagi yang gagal</b> menyambung ulang hanya PC yang gagal.", en: "A PC without a password still asks the person there to press <b>Accept</b>. A PC that fails writes the reason on its picture, such as Wrong password, Declined on that PC, No answer or Offline. <b>Retry the failed ones</b> tries only the PCs that failed." }],
      ["h2", "kirim", { id: "Mengirim file ke banyak PC", en: "Sending files to many PCs" }],
      ["p", { id: "Pilih PC yang sedang tersambung, lalu klik <b>Kirim file</b> dan pilih filenya. Panel di samping menunjukkan kemajuan setiap PC, dan <b>Tambah file</b> menambah file lain. Di setiap PC, orang di sana menekan Terima dan memilih tempat menyimpan. PC yang belum tersambung dilewati. PC yang sedang menjalankan transfer lain gagal dikirimi; kirim lagi setelah transfernya selesai.", en: "Select connected PCs, click <b>Send file</b> and pick the files. A side panel shows each PC's progress, and <b>Add files</b> adds more. On each PC, the person there presses Accept and picks where to save. PCs that are not connected are skipped. A PC already running another transfer fails; send again once that transfer is done." }],
      ["h2", "hp", { id: "Di HP Android", en: "On an Android phone" }],
      ["ul", [{ id: "Semua PC tampil dalam satu halaman yang digulir, dua gambar per baris. Nama PC tampil tanpa ID.", en: "Every PC shows on one page that scrolls, two pictures across. A PC shows its name without the ID." },
        { id: "Tombol pensil (<b>Atur kelompok</b>) dan <b>Pilih</b> ada di bilah atas. Kelompok baru dibuat dari jendela Atur kelompok.", en: "The pencil (<b>Manage groups</b>) and <b>Select</b> are in the top bar. New groups are made from the Manage groups window." },
        { id: "Saat memilih, bilah atas menunjukkan jumlah yang dipilih dan tombol <b>Semua</b>; <b>Hubungkan</b>, <b>Putuskan</b>, dan <b>Kelompok</b> ada di bawah. <b>Kirim file</b> tidak ada, karena TryDesk untuk HP belum bisa mengirim file.", en: "While selecting, the top bar shows how many are selected and an <b>All</b> button; <b>Connect</b>, <b>Disconnect</b> and <b>Group</b> are at the bottom. There is no <b>Send file</b>, because TryDesk for phones cannot send files yet." },
        { id: "HP menyambung paling banyak 4 PC sekaligus.", en: "A phone keeps at most 4 PCs connected at once." },
        { id: "Tombol Kembali Android menutup berurutan: jendela yang terbuka, lalu mode Pilih, lalu layar ini.", en: "Android's Back button closes things in order: an open window, then Select mode, then this screen." }]],
      ["h2", "cari", { id: "Mencari dan tombol keyboard", en: "Search and keyboard" }],
      ["ul", [{ id: "Kotak <b>Cari nama atau ID</b> menyaring gambar saat Anda mengetik.", en: "The <b>Search name or ID</b> box filters the pictures as you type." },
        { id: "<kbd>Esc</kbd> menutup berurutan: jendela kecil yang terbuka, lalu mode Pilih, lalu pencarian, lalu layar ini.", en: "<kbd>Esc</kbd> closes things in order: an open dialog, then Select mode, then the search, then this screen." },
        { id: "<kbd>Enter</kbd> atau <kbd>Spasi</kbd> pada gambar sama dengan mengkliknya.", en: "<kbd>Enter</kbd> or <kbd>Space</kbd> on a picture is the same as clicking it." }]],
      ["note", "info", { id: "Disimpan di PC ini", en: "Kept on this PC" }, { id: "Kelompok dan nama PC hanya disimpan di komputer ini. Di komputer lain, kelompoknya dibuat sendiri lagi.", en: "Groups and PC names are kept on this computer only. On another computer you make the groups again." }]],
    rel: ["devices", "tabs", "file-transfer"] },
  // ---- Selama sesi
  { slug: "control-center", g: "sesi", ic: "sliders",
    t: { id: "Control Center", en: "Control Center" }, h1: { id: "Control <em>Center.</em>", en: "Control <em>Center.</em>" }, d: { id: "Semua kontrol sesi di satu panel kanan.", en: "Every session control in one panel on the right." }, k: "control center panel",
    lede: { id: "Panel di kanan layar selama sesi: kualitas, monitor, suara, keamanan, dan fitur lainnya.", en: "The panel on the right during a session: quality, monitors, sound, security and more." },
    body: [["p", "docs.ccP1"], SHOT("control-center", "docs.shotCcAlt", "docs.shotCcCap"), ["ul", ["docs.ccL1", "docs.ccL2", "docs.ccL3", "docs.ccL4", "docs.ccL5", "docs.ccL6"]], ["p", "docs.ccP2"],
      // ukuran tampilan (1.4.0, src/renderer/app.js ~5941-5984, 10908-10915)
      ["h2", "tampilan", { id: "Ukuran tampilan", en: "Display size" }],
      ["p", { id: "<span class=\"dc-path\">Control Center › Tampilan</span> mengatur ukuran gambar PC itu di jendela Anda: <b>Pas jendela</b> (bawaan), 50%, 75%, 100%, 150%, atau 200%.", en: "<span class=\"dc-path\">Control Center › Display</span> sets the size of that PC's picture in your window: <b>Fit window</b> (the default), 50%, 75%, 100%, 150% or 200%." }],
      ["ul", [{ id: "Sejak 1.4.0, 100% berarti seukuran layar asli PC itu, jadi gambar tidak mengecil lagi saat koneksi menurunkan resolusi kiriman. PC itu harus memakai TryDesk 1.4.0; untuk versi lama dipakai gambar terbesar yang pernah diterima.", en: "Since 1.4.0, 100% means the size of that PC's real screen, so the picture no longer shrinks when the connection lowers the sent resolution. That PC needs TryDesk 1.4.0; for older versions the largest picture received so far is used." },
        { id: "Dengan <b>Semua monitor</b> (lihat <a href=\"/docs/monitors/#semua\">Multi-monitor</a>), gambar selalu pas jendela dan ikut menyesuaikan saat jendela diperbesar, layar penuh, atau Control Center dibuka di samping.", en: "With <b>All monitors</b> (see <a href=\"/docs/monitors/#semua\">Multiple monitors</a>), the picture always fits the window and follows it when the window is enlarged, goes full screen, or Control Center opens beside it." }]]],
    rel: ["quality", "monitors", "file-transfer"] },
  { slug: "quality", g: "sesi", ic: "sliders",
    t: { id: "Kualitas gambar", en: "Picture quality" }, d: { id: "Preset, FPS, resolusi, dan codec.", en: "Presets, FPS, resolution and codec." }, k: "fps codec h.265 av1 resolusi bitrate kualitas",
    lede: { id: "Atur ketajaman dan kelancaran gambar selama sesi, tanpa menyambung ulang.", en: "Set how sharp and smooth the picture is during a session, without reconnecting." },
    body: [["p", "docs.ccL2"], SHOT("kualitas", "docs.shotQualityAlt", "docs.shotQualityCap"), ["p", "docs.ccP2"],
      ["h2", "bawaan", { id: "Kualitas bawaan", en: "Default quality" }],
      ["p", { id: "Kualitas yang dipakai setiap sesi dimulai dipilih di <span class=\"dc-path\">Pengaturan › Kualitas gambar</span>. Setiap pilihan punya keterangan cocok untuk apa. Sejak 1.4.0 bawaannya <b>1000 Mbps dan 240 FPS</b> (dulu 80 Mbps dan 60 FPS), jadi jalur cepat langsung terpakai tanpa mengubah pengaturan.", en: "The quality every session starts with is picked in <span class=\"dc-path\">Settings › Picture quality</span>. Each choice says what it suits. Since 1.4.0 the default is <b>1000 Mbps and 240 FPS</b> (it used to be 80 Mbps and 60 FPS), so the fast path is used without changing any setting." }],
      ["table", [{ id: "Pilihan", en: "Choice" }, { id: "Kecepatan dan FPS", en: "Speed and FPS" }, { id: "Cocok untuk", en: "Suits" }], [
        [{ id: "Bawaan", en: "Default" }, "1000 Mbps · 240 FPS", { id: "Pilihan awal, cocok untuk kebanyakan PC", en: "The starting choice, fits most PCs" }],
        [{ id: "Hemat", en: "Saver" }, "3 Mbps · 15 FPS · 720p", { id: "Internet lambat atau kuota terbatas", en: "Slow internet or a limited data plan" }],
        [{ id: "Seimbang", en: "Balanced" }, "20 Mbps · 30 FPS", { id: "Wi-Fi rumah biasa", en: "Ordinary home Wi-Fi" }],
        [{ id: "Kualitas", en: "Quality" }, "60 Mbps · 60 FPS", { id: "Teks dan gambar lebih tajam", en: "Sharper text and pictures" }],
        ["Ultra", "150 Mbps · 120 FPS", { id: "Jaringan kabel yang cepat", en: "A fast wired network" }],
        ["Gaming", "300 Mbps · 165 FPS", { id: "Bermain game, monitor 165 Hz", en: "Gaming, a 165 Hz monitor" }],
        [{ id: "Maksimal", en: "Maximum" }, "1000 Mbps · 240 FPS", { id: "Satu jaringan lokal, monitor 240 Hz", en: "The same local network, a 240 Hz monitor" }]]],
      ["p", { id: "Kecepatan di atas 300 Mbps hanya terpakai di jalur cepat: Windows ke Windows di jaringan lokal yang sama.", en: "Speeds above 300 Mbps are only used on the fast path: Windows to Windows on the same local network." }],
      ["h2", "lambat", { id: "Di koneksi lambat", en: "On a slow connection" }],
      ["p", { id: "Sejak 1.3.9, di koneksi lambat atau tidak stabil TryDesk menurunkan fps lebih dulu dan mempertahankan resolusi, jadi teks tetap terbaca. Sinyal yang hilang sebentar tidak memutus sesi: layar menulis <b>Koneksi tersendat, menyambung kembali…</b> sementara jalurnya dipulihkan.", en: "Since 1.3.9, on a slow or unsteady connection TryDesk lowers the fps first and keeps the resolution, so text stays readable. A short signal loss does not end the session: the screen says <b>Connection stalled, reconnecting…</b> while the path is restored." }]],
    rel: ["control-center", "network"] },
  { slug: "monitors", g: "sesi", ic: "sliders",
    t: { id: "Multi-monitor", en: "Multiple monitors" }, d: { id: "Pindah antar layar PC tujuan, atau tampilkan semuanya.", en: "Switch between the remote PC's screens, or show them all." }, k: "monitor layar screen display semua all multi",
    lede: { id: "Untuk PC tujuan yang punya lebih dari satu layar.", en: "For a remote PC with more than one screen." },
    body: [["p", "docs.monP"], SHOT("monitor", "docs.shotMonAlt", "docs.shotMonCap"),
      ["h2", "semua", { id: "Semua monitor sekaligus", en: "All monitors at once" }],
      ["p", { id: "Sejak 1.4.0, <span class=\"dc-path\">Control Center › Monitor</span> menampilkan peta layar PC tujuan, sesuai letaknya di PC itu. Ada tiga cara tampil:", en: "Since 1.4.0, <span class=\"dc-path\">Control Center › Monitor</span> shows a map of the remote PC's screens, laid out as they stand on that PC. There are three ways to show them:" }],
      ["ul", [{ id: "<b>Satu monitor</b>: pilih layar di peta. Gambarnya paling besar.", en: "<b>One monitor</b>: pick a screen on the map. Its picture is the largest." },
        { id: "<b>Semua monitor</b>: semua layar berdampingan di jendela sesi.", en: "<b>All monitors</b>: every screen side by side in the session window." },
        { id: "<b>Satu jendela per monitor</b>: setiap layar di jendelanya sendiri, untuk ditaruh di monitor Anda. Tidak ada di HP.", en: "<b>One window per monitor</b>: each screen in a window of its own, to place on your own monitors. Not on phones." }]],
      ["p", { id: "<b>Ikuti kursor</b> memindahkan gambar ke monitor tempat kursor PC itu berada.", en: "<b>Follow the cursor</b> moves the picture to the monitor where that PC's cursor is." }],
      ["note", "info", { id: "Batasnya", en: "Limits" }, { id: "Semua monitor mengirim satu gambar per monitor, jadi butuh internet lebih cepat. Monitor tambahan paling banyak tiga, masing-masing sampai 30 fps. PC tujuan harus memakai TryDesk 1.4.0 atau lebih baru. Saat PC itu di layar kunci atau TryDesk-nya berjalan sebagai administrator, tampilan kembali ke satu monitor.", en: "All monitors sends one picture per monitor, so it needs a faster connection. Up to three extra monitors, each at up to 30 fps. The remote PC must run TryDesk 1.4.0 or newer. While that PC is on its lock screen, or its TryDesk runs as administrator, the view goes back to one monitor." }]],
    rel: ["control-center", "quality"] },
  { slug: "tabs", g: "sesi", ic: "sliders",
    t: { id: "Tab sesi", en: "Session tabs" }, d: { id: "Beberapa PC sekaligus, satu tab per PC.", en: "Several PCs at once, one tab per PC." }, k: "tab multi remote f2",
    lede: { id: "Mengontrol beberapa komputer sekaligus dari satu jendela.", en: "Control several computers at once from one window." },
    body: [["p", "docs.tabP"], SHOT("sesi", "docs.shotSessionAlt", "docs.shotSessionCap")], rel: ["devices", "shortcuts"] },
  { slug: "file-transfer", g: "sesi", ic: "sliders",
    t: { id: "File Transfer", en: "File Transfer" }, h1: { id: "File <em>Transfer.</em>", en: "File <em>Transfer.</em>" }, d: { id: "Dua panel, seret-lepas, dan salin-tempel file.", en: "Two panes, drag and drop, copy and paste." }, k: "file transfer kirim unduh folder ctrl+v send",
    lede: { id: "Memindahkan file dan folder antara PC Anda dan PC yang dikontrol.", en: "Move files and folders between your PC and the one you control." },
    body: [["p", "docs.fileP1"], ["ul", ["docs.fileL1", "docs.fileL2"]], ["p", "docs.fileP2"], SHOT("file", "docs.shotFileAlt", "docs.shotFileCap"),
      ["h2", "seret", { id: "Seret dan lepas", en: "Drag and drop" }], ["p", "docs.fileP3"],
      ["h2", "salin", { id: "Salin-tempel dan transfer yang terputus", en: "Copy and paste, interrupted transfers" }], ["p", "docs.fileP5"],
      ["h2", "layanan", { id: "PC dengan layanan Windows", en: "PCs with the Windows service" }], ["p", "docs.fileP4"]],
    rel: ["chat", "windows-service", "permissions"] },
  { slug: "chat", g: "sesi", ic: "sliders",
    t: { id: "Chat", en: "Chat" }, h1: { id: "<em>Chat.</em>", en: "<em>Chat.</em>" }, d: { id: "Pesan, gambar, dan file selama sesi.", en: "Messages, pictures and files during a session." }, k: "chat pesan message",
    lede: { id: "Bicara dengan orang di depan PC yang Anda kontrol.", en: "Talk to the person in front of the PC you control." },
    body: [["p", "docs.chatP"], SHOT("chat", "docs.shotChatAlt", "docs.shotChatCap")], rel: ["file-transfer"] },
  { slug: "recording", g: "sesi", ic: "sliders",
    t: { id: "Rekam sesi dan screenshot", en: "Recording and screenshots" }, d: { id: "Simpan layar remote ke video atau gambar.", en: "Save the remote screen as a video or picture." }, k: "rekam video webm screenshot record",
    lede: { id: "Menyimpan apa yang tampil di layar PC yang dikontrol.", en: "Keep what is on the controlled PC's screen." },
    body: [["p", "docs.recP"], SHOT("fitur-lainnya", "docs.shotMoreAlt", "docs.shotMoreCap")], rel: ["control-center", "android"] },
  { slug: "game-mode", g: "sesi", ic: "sliders",
    t: { id: "Mode game dan keyboard", en: "Game mode and keyboard" }, d: { id: "Mouse relatif untuk game, Alt+Tab, dan tombol Win.", en: "Relative mouse for games, Alt+Tab and the Win key." }, k: "game mouse alt tab win pause kombinasi tombol keys",
    lede: { id: "Bermain game dari jauh, dan mengirim tombol yang biasanya ditangkap PC Anda sendiri.", en: "Play games remotely, and send keys your own PC would normally keep." },
    body: [["p", "docs.gameP1"], ["p", "docs.gameP2"], ["p", "docs.gameP3"], ["h2", "keyboard", "docs.gameH3"], ["p", "docs.gameP4"],
      ["h2", "kombinasi", "docs.keysH"], ["p", "docs.keysP1"], SHOT("tombol", "docs.shotKeysAlt", "docs.shotKeysCap"), ["p", "docs.keysP2"]],
    rel: ["shortcuts", "android"] },
  // ---- Dari HP, Mac, Linux
  { slug: "android", g: "lain", ic: "phone",
    t: { id: "Dari HP Android", en: "From an Android phone" }, d: { id: "Touchpad, tombol khusus, dan menu sesi.", en: "Touchpad, special keys and the session menu." }, k: "android hp apk touchpad phone",
    lede: { id: "Mengontrol PC Windows dari HP.", en: "Control a Windows PC from your phone." },
    body: [["p", "docs.andP1"], SHOT("android-beranda", "docs.shotAndHomeAlt", "docs.shotAndHomeCap", "phone"),
      ["h2", "sentuh", "docs.andH3a"], ["ul", ["docs.andL1", "docs.andL2", "docs.andL3"]], SHOT("android-sesi", "docs.shotAndSessionAlt", "docs.shotAndSessionCap", "land"),
      ["h2", "tombol", "docs.andH3b"], ["p", "docs.andP2"], SHOT("android-tombol", "docs.shotAndKeysAlt", "docs.shotAndKeysCap", "land"),
      ["h2", "menu", { id: "Menu sesi", en: "Session menu" }], ["p", "docs.andP3"], SHOT("android-menu", "docs.shotAndMenuAlt", "docs.shotAndMenuCap", "phone")],
    rel: ["install", "game-mode", "connect-by-ip"] },
  { slug: "mac", g: "lain", ic: "phone",
    t: { id: "Dari Mac", en: "From a Mac" }, d: { id: "Memasang di macOS dan tombol Cmd.", en: "Installing on macOS and the Cmd key." }, k: "mac macos xattr cmd",
    lede: { id: "Mengontrol PC Windows dari Mac.", en: "Control a Windows PC from a Mac." },
    body: [["p", "docs.macP1"], ["h2", "pasang", "docs.macH"], ["ul", ["docs.macL1", "docs.macL2", "docs.macL3", "docs.macL4"]], ["p", "docs.macFix"],
      ["h2", "tombol", { id: "Tombol di Mac", en: "Keys on a Mac" }], ["p", "docs.macP2"]],
    rel: ["install", "shortcuts"] },
  { slug: "linux", g: "lain", ic: "phone",
    t: { id: "Dari Linux", en: "From Linux" }, d: { id: "AppImage atau .deb untuk mengontrol PC Windows.", en: "AppImage or .deb to control Windows PCs." }, k: "linux appimage deb ubuntu",
    lede: { id: "Mengontrol PC Windows dari komputer Linux.", en: "Control a Windows PC from a Linux computer." },
    body: [["p", { id: "TryDesk untuk Linux (sejak 1.2.1) dipakai untuk <b>mengontrol PC Windows</b>. PC Linux itu sendiri belum bisa dikontrol.", en: "TryDesk for Linux (since 1.2.1) is for <b>controlling Windows PCs</b>. The Linux PC itself cannot be controlled yet." }],
      ["ul", [{ id: "<b>AppImage</b> (hampir semua distro): izinkan file dijalankan (<code>chmod +x</code>), lalu buka.", en: "<b>AppImage</b> (almost any distro): allow the file to run (<code>chmod +x</code>), then open it." },
        { id: "<b>.deb</b> (Ubuntu dan Debian): pasang lewat aplikasi Software atau apt.", en: "<b>.deb</b> (Ubuntu and Debian): install it with the Software app or apt." }]],
      ["p", { id: "Keduanya ada di halaman <a href=\"/downloads/\">Download</a>.", en: "Both are on the <a href=\"/downloads/\">Download</a> page." }],
      ["h2", "greeter", "docs.tbHLinux"], ["p", "docs.tbPLinux"]],
    rel: ["requirements", "install"] },
  // ---- PC Windows yang dikontrol
  { slug: "windows-service", g: "host", ic: "monitor",
    t: { id: "Layanan Windows", en: "Windows service" }, d: { id: "PC tetap bisa dikontrol walau TryDesk ditutup.", en: "The PC stays reachable with TryDesk closed." }, k: "layanan service restart layar kunci lock screen uac pin password masuk sign in win+l",
    lede: { id: "Supaya PC tetap bisa dikontrol walau jendela TryDesk ditutup atau PC baru menyala.", en: "So the PC stays reachable with the TryDesk window closed or right after it starts." },
    body: [["p", "docs.accSvc"], ["h2", "uac", { id: "Dialog UAC dan layar kunci", en: "UAC dialogs and the lock screen" }], ["p", "docs.platL3"], ["p", "docs.platL2"],
      ["p", { id: "Tanpa layanan, Windows menggambar dialog UAC dan layar kunci di tempat yang tidak bisa dilihat TryDesk, jadi gambar di PC pengontrol berhenti. Sejak versi ini pengontrol diberi tahu alasannya, dan orang di PC itu diingatkan untuk menjawabnya sendiri atau memasang layanan.", en: "Without the service, Windows draws the UAC dialog and the lock screen where TryDesk can't look, so the picture on the controlling PC stops. Since this version the controlling side is told why, and the person at that PC is reminded to answer it there or install the service." }],
      // layar kunci lewat layanan (1.4.0, src/main.js ~1899-2047, src/renderer/app.js ~6912-7010)
      ["h2", "kunci", { id: "Masuk dari layar kunci", en: "Signing in from the lock screen" }],
      ["p", { id: "Sejak 1.4.0, PC dengan layanan Windows TryDesk bisa dikontrol saat layarnya terkunci (<kbd>Win</kbd>+<kbd>L</kbd>) atau baru menyala di layar masuk. Layar kunci langsung tampil di PC pengontrol, dan password atau PIN Windows bisa diketik dari jauh, juga dari keyboard HP.", en: "Since 1.4.0, a PC with the TryDesk Windows service can be controlled while it is locked (<kbd>Win</kbd>+<kbd>L</kbd>) or has just started at the sign-in screen. The lock screen shows on the controlling PC right away, and the Windows password or PIN can be typed from afar, also from a phone keyboard." }],
      ["ul", [{ id: "Layanannya terpasang otomatis dengan TryDesk Setup. Untuk TryDesk Portable, pasang di <span class=\"dc-path\">Pengaturan › Layanan Windows</span>, atau lewat <a href=\"/docs/administrator/#minta\">Minta akses admin</a> dari PC pengontrol.", en: "The service comes with TryDesk Setup. For TryDesk Portable, install it in <span class=\"dc-path\">Settings › Windows service</span>, or with <a href=\"/docs/administrator/#minta\">Request admin access</a> from the controlling PC." },
        { id: "Di layar kunci, panel <b>Kombinasi tombol</b> hanya berisi tombol yang sampai ke sana: <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Del</kbd>, <b>Pindah kolom</b> (Tab), <b>Masuk</b> (Enter), <b>Hapus satu huruf</b> (Backspace), dan <b>Tutup</b> (Esc).", en: "On the lock screen, the <b>Key combinations</b> panel only holds the keys that reach it: <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Del</kbd>, <b>Next field</b> (Tab), <b>Sign in</b> (Enter), <b>Delete a letter</b> (Backspace) and <b>Close</b> (Esc)." },
        { id: "Untuk mengunci PC itu lewat layanan, pakai <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Del</kbd>, lalu <b>Kunci</b>.", en: "To lock that PC through the service, use <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Del</kbd>, then <b>Lock</b>." },
        { id: "Tanpa layanan, gambar berhenti di layar terakhir dan pesan kuning menjelaskan bahwa hanya Windows yang bisa melihat layar itu. Mintalah pemiliknya membuka kunci, atau pasang layanannya.", en: "Without the service, the picture stops at the last frame and a yellow message explains that only Windows can see that screen. Ask the owner to unlock it, or install the service." }]],
      ["h2", "file", { id: "File lewat layanan", en: "Files through the service" }], ["p", "docs.fileP4"]],
    rel: ["administrator", "access-password", "settings"] },
  { slug: "administrator", g: "host", ic: "monitor",
    t: { id: "Jendela administrator dan UAC", en: "Administrator windows and UAC" }, d: { id: "Mengontrol jendela admin, menjawab UAC, dan Minta akses admin.", en: "Controlling admin windows, answering UAC, and Request admin access." }, k: "uac administrator admin minta akses admin request admin access izinkan",
    lede: { id: "Jendela yang berjalan sebagai administrator butuh TryDesk dengan hak yang sama.", en: "Windows running as administrator need TryDesk with the same rights." },
    body: [["p", "docs.secL6"], ["p", { id: "Sejak 1.3.7, TryDesk yang dijalankan sebagai administrator juga mengirim layarnya. Bila layar tetap tidak bisa diambil, viewer diberi tahu alasannya dalam beberapa detik.", en: "Since 1.3.7, TryDesk running as administrator sends its screen too. If the screen still cannot be captured, the viewer is told why within a few seconds." }], ["p", "docs.platL3"],
      // Minta akses admin (1.4.0, src/renderer/app.js ~9560-9700; owner tests in rilis/catatan/LAPORAN-PENGGUNA-2026-11-21.md)
      ["h2", "minta", { id: "Minta akses admin", en: "Request admin access" }],
      ["p", { id: "Sejak 1.4.0, saat PC yang Anda kontrol menampilkan jendela UAC, layar kunci, atau jendela administrator yang tidak bisa diklik, pesan kuning di atas layarnya punya tombol <b>Minta akses admin</b>. Tombol yang sama ada di <span class=\"dc-path\">Control Center › Keamanan</span>.", en: "Since 1.4.0, when the PC you control shows a UAC prompt, the lock screen, or an administrator window you cannot click, the yellow message over its screen has a <b>Request admin access</b> button. The same button is in <span class=\"dc-path\">Control Center › Security</span>." }],
      ["ol", [{ id: "Klik <b>Minta akses admin</b>.", en: "Click <b>Request admin access</b>." },
        { id: "Di PC itu muncul <b>Izinkan akses administrator?</b>. Orang di sana menekan <b>Izinkan</b>, lalu <b>Ya</b> di jendela UAC Windows.", en: "That PC shows <b>Allow administrator access?</b>. The person there presses <b>Allow</b>, then <b>Yes</b> on the Windows UAC prompt." },
        { id: "TryDesk memasang layanan Windows di PC itu. Sesi terputus sebentar lalu tersambung ulang sendiri lewat layanan, dan sejak itu jendela UAC, layar kunci, dan jendela administrator bisa dilihat dan diklik dari jauh.", en: "TryDesk installs the Windows service on that PC. The session drops for a moment and reconnects by itself through the service, and from then on UAC prompts, the lock screen and administrator windows can be seen and clicked from afar." }]],
      ["ul", [{ id: "Bila TryDesk di PC itu sudah berjalan sebagai administrator, tidak ada jendela UAC. Saat jendela UAC atau layar kunci sudah tampil di sana, layanannya langsung dipasang tanpa bertanya, jadi tetap bisa dijawab dari jauh.", en: "If TryDesk on that PC already runs as administrator, there is no UAC prompt. When a UAC prompt or the lock screen is already up there, the service installs without asking, so it can still be answered from afar." },
        { id: "Bila tidak dijawab dalam 60 detik, permintaan dianggap ditolak. Setelah ditolak, permintaan berikutnya bisa dikirim 30 detik kemudian.", en: "With no answer within 60 seconds, the request counts as declined. After a decline, a new request can be sent 30 seconds later." },
        { id: "Tombol ini tidak muncul bila layanannya sudah terpasang, PC itu tidak mendukung layanan, atau sesinya mode lihat saja.", en: "The button does not show when the service is already installed, when that PC cannot run the service, or in a view-only session." },
        { id: "Layanannya bisa dilepas lagi di <span class=\"dc-path\">Pengaturan › Layanan Windows</span> di PC itu.", en: "The service can be removed again in <span class=\"dc-path\">Settings › Windows service</span> on that PC." }]],
      ["note", "info", { id: "Lebih aman diminta lebih dulu", en: "Safer to ask first" }, { id: "Bila Anda tahu akan membuka installer atau pengaturan admin di PC itu, minta akses admin sebelum jendela UAC muncul, selagi orang di sana masih bisa menekan Izinkan.", en: "If you know you will open an installer or admin settings on that PC, request admin access before the UAC prompt shows, while the person there can still press Allow." }]],
    rel: ["windows-service", "permissions"] },
  { slug: "settings", g: "host", ic: "monitor",
    t: { id: "Pengaturan", en: "Settings" }, h1: { id: "<em>Pengaturan.</em>", en: "<em>Settings.</em>" }, d: { id: "Ringkasan, Umum, Keamanan, Jaringan, dan lainnya.", en: "Summary, General, Security, Network and more." }, k: "pengaturan settings bahasa tema language theme",
    lede: { id: "Apa yang ada di setiap halaman Pengaturan TryDesk.", en: "What each page of TryDesk's Settings holds." },
    body: [["table", [{ id: "Halaman", en: "Page" }, { id: "Isinya", en: "What it holds" }], [
        [{ id: "Ringkasan", en: "Summary" }, { id: "Keadaan PC ini: siapa yang boleh masuk, kualitas gambar, keadaan setelah restart, dan nama PC. Klik untuk mengubah.", en: "This PC's status: who may connect, picture quality, what happens after a restart, and the PC's name. Click to change." }],
        [{ id: "Umum", en: "General" }, { id: "Nama perangkat, bahasa, tema, saat Windows menyala dan jendela ditutup, dan Discord.", en: "Device name, language, theme, what happens when Windows starts and the window closes, and Discord." }],
        [{ id: "Suara", en: "Sound" }, { id: "Bunyi TryDesk dan volumenya, lalu bunyi mana yang menyala: permintaan masuk dan sambungan, chat, transfer file, dan pemberitahuan. Bisa dibuat diam saat bermain game atau layar penuh.", en: "TryDesk's sounds and their volume, and which ones play: incoming requests and connections, chat, file transfers and notices. They can stay quiet while you play a game or use full screen." }],
        [{ id: "Keamanan", en: "Security" }, { id: "Password akses, izin tamu, ID PC ini, dan pengaman sesi.", en: "Access password, guest rights, this PC's ID and session safety." }],
        [{ id: "Kualitas gambar", en: "Picture quality" }, { id: "Kualitas bawaan, suara dari PC jauh, tampilan sesi, dan format video.", en: "Default quality, sound from the remote PC, session view and video format." }],
        [{ id: "Jaringan", en: "Network" }, { id: "Sambung lewat IP, sambung ulang otomatis, dan batas kecepatan.", en: "Connect by IP, automatic reconnect and the speed limit." }],
        [{ id: "Layanan Windows", en: "Windows service" }, { id: "Aktif setelah restart.", en: "Active after a restart." }],
        [{ id: "Tentang", en: "About" }, { id: "Pembaruan otomatis, versi, kartu grafis, dan reset.", en: "Automatic updates, version, graphics card and reset." }]]],
      ["p", { id: "Pengaturan teknis ada di bagian <b>Pengaturan lanjutan</b> di bawah halamannya.", en: "Technical settings are under <b>Advanced settings</b> at the bottom of a page." }],
      // Every option of TryDesk 1.4.0, in the app's own words (src/renderer/index.html tab-*; audited 21 Nov 2026)
      ["h2", "umum", { id: "Umum", en: "General" }],
      ["ul", [{ id: "<b>Nama perangkat</b>: nama PC ini yang terlihat oleh PC yang Anda hubungi.", en: "<b>Device name</b>: this PC's name as the PCs you connect to see it." },
        { id: "<b>Bahasa</b>: 22 bahasa, berlaku langsung. <b>Ikuti bahasa Windows</b> mengganti bahasa TryDesk mengikuti Windows.", en: "<b>Language</b>: 22 languages, applied at once. <b>Follow the Windows language</b> switches TryDesk along with Windows." },
        { id: "<b>Tema</b>: Gelap, Terang, atau Ikuti Windows.", en: "<b>Theme</b>: Dark, Light or Follow Windows." },
        { id: "<b>Buka TryDesk saat Windows menyala</b>.", en: "<b>Open TryDesk when Windows starts</b>." },
        { id: "<b>Tetap aktif setelah jendela ditutup</b>: TryDesk pindah ke ikon kecil di pojok kanan bawah, jadi PC ini tetap bisa dihubungi. Keluar lewat klik kanan ikon itu.", en: "<b>Keep running after the window is closed</b>: TryDesk moves to the small icon at the bottom right, so this PC can still be reached. Quit by right-clicking that icon." },
        { id: "<b>Tampilkan TryDesk di profil Discord</b>: teman Anda melihat \"Menggunakan TryDesk\".", en: "<b>Show TryDesk on my Discord profile</b>: your friends see \"Using TryDesk\"." }]],
      ["h2", "suara", { id: "Suara", en: "Sound" }],
      ["ul", [{ id: "<b>Bunyi TryDesk</b>: bunyi pendek saat ada kejadian penting, dengan <b>Volume</b> dan tombol <b>Coba</b>.", en: "<b>TryDesk sounds</b>: a short sound when something important happens, with <b>Volume</b> and a <b>Try</b> button." },
        { id: "<b>Bunyi untuk</b>: permintaan masuk dan sambungan, chat (hanya pesan masuk), transfer file (selesai atau gagal), pemberitahuan, versi baru TryDesk, dan klik tombol utama (Hubungkan, Terima, Tolak, Salin). Masing-masing bisa dinyalakan atau dimatikan.", en: "<b>Play a sound for</b>: incoming requests and connections, chat (incoming messages only), file transfers (done or failed), notices, a new TryDesk version, and main button clicks (Connect, Accept, Decline, Copy). Each one can be on or off." },
        { id: "<b>Diam saat mode game</b>: hanya sambungan terputus dan permintaan masuk yang berbunyi. <b>Diam saat layar penuh</b>: pemberitahuan berhasil dan peringatan tidak berbunyi.", en: "<b>Quiet in game mode</b>: only a dropped connection and incoming requests make a sound. <b>Quiet in full screen</b>: success and warning notices stay silent." },
        { id: "<b>Beri tahu saat ada yang ingin masuk</b>: pemberitahuan Windows, tanpa bunyinya sendiri.", en: "<b>Tell me when someone wants to come in</b>: a Windows notification, without a sound of its own." },
        { id: "Selama sesi, bunyi untuk sesi itu saja bisa dimatikan di <span class=\"dc-path\">Control Center › Suara › Bunyi selama sesi ini</span>.", en: "During a session, sounds for that session alone can be turned off in <span class=\"dc-path\">Control Center › Sound › Sounds in this session</span>." }]],
      ["h2", "keamanan", { id: "Keamanan", en: "Security" }],
      ["ul", [{ id: "<b>Password akses</b>: tanpa password, setiap koneksi harus Anda terima dulu. Dengan password, tamu yang tahu password langsung masuk. Minimal 6 karakter, atau 10 karakter untuk Sambung lewat IP. Password disimpan terenkripsi oleh Windows. Lihat <a href=\"/docs/access-password/\">Password akses</a>.", en: "<b>Access password</b>: without one, you accept every connection first. With one, guests who know it come straight in. At least 6 characters, or 10 for Connect by IP. It is stored encrypted by Windows. See <a href=\"/docs/access-password/\">Access password</a>." },
        { id: "<b>Langsung masuk bila password benar</b>: matikan bila Anda tetap ingin menekan Terima walau password benar. <b>Perbarui layanan</b> muncul bila layanan Windows masih menyimpan password lama.", en: "<b>Come straight in with the right password</b>: turn it off if you still want to press Accept even with the right password. <b>Update the service</b> shows when the Windows service still holds the old password." },
        { id: "<b>Yang boleh dilakukan tamu</b>: mouse dan keyboard, salin dan tempel teks, kirim dan ambil file, atau <b>Hanya melihat layar</b> (tamu tidak bisa klik atau mengetik). Lihat <a href=\"/docs/permissions/\">Izin</a>.", en: "<b>What guests may do</b>: mouse and keyboard, copy and paste text, send and receive files, or <b>View the screen only</b> (guests can't click or type). See <a href=\"/docs/permissions/\">Permissions</a>." },
        { id: "<b>ID PC ini</b> dan <b>Buat ID baru</b>: ID lama berhenti berlaku bila Anda membuat yang baru. Lihat <a href=\"/docs/new-id/\">ID baru</a>.", en: "<b>This PC's ID</b> and <b>Generate new ID</b>: the old ID stops working when you make a new one. See <a href=\"/docs/new-id/\">New ID</a>." },
        { id: "<b>Pengaman sesi</b>: <b>Kunci Windows setelah sesi selesai</b>; <b>Putuskan otomatis setelah</b> 30 menit, 1, 2, atau 8 jam (atau tanpa batas); <b>Blokir setelah 3 kali password salah</b>, peminta diblokir 5 sampai 20 menit.", en: "<b>Session safety</b>: <b>Lock Windows when a session ends</b>; <b>Disconnect automatically after</b> 30 minutes, 1, 2 or 8 hours (or no limit); <b>Block after 3 wrong passwords</b>, the requester is blocked for 5 to 20 minutes." },
        { id: "Pengaturan lanjutan, <b>Kontrol jendela administrator</b>: perlu agar klik dan ketik bekerja di jendela seperti CMD admin. TryDesk dibuka ulang dengan izin administrator. Lihat <a href=\"/docs/administrator/\">Jendela administrator dan UAC</a>.", en: "Advanced, <b>Control administrator windows</b>: needed so clicks and typing work in windows like an admin CMD. TryDesk reopens with administrator rights. See <a href=\"/docs/administrator/\">Administrator windows and UAC</a>." }]],
      ["h2", "kualitas", { id: "Kualitas gambar", en: "Picture quality" }],
      ["ul", [{ id: "<b>Kualitas bawaan</b> untuk setiap sesi baru: Bawaan (1000 Mbps, 240 FPS), Hemat, Seimbang, Kualitas, Ultra, Gaming, Maksimal, atau Kustom. Saat sesi berjalan, ubah lewat Control Center. Lihat <a href=\"/docs/quality/\">Kualitas gambar</a>.", en: "<b>Default quality</b> for every new session: Default (1000 Mbps, 240 FPS), Saver, Balanced, Quality, Ultra, Gaming, Maximum or Custom. During a session, change it in Control Center. See <a href=\"/docs/quality/\">Picture quality</a>." },
        { id: "<b>Suara dari PC jauh</b>: <b>Putar suara otomatis saat sesi dimulai</b>, dan volumenya.", en: "<b>Sound from the remote PC</b>: <b>Play sound automatically when a session starts</b>, and its volume." },
        { id: "<b>Tampilan sesi</b>: <b>Ukuran gambar</b> bawaan (Pas dengan jendela, 100%, 75%, atau 50%), dan <b>Tampilkan angka kecepatan</b> (FPS, ping, dan kecepatan di pojok layar).", en: "<b>Session view</b>: the default <b>Picture size</b> (Fit the window, 100%, 75% or 50%), and <b>Show speed numbers</b> (FPS, ping and speed in a corner of the screen)." },
        { id: "Pengaturan lanjutan, <b>Format video</b>: Otomatis (disarankan), AV1, VP9, VP8, H.265, atau H.264. Biarkan Otomatis, kecuali diminta saat ada masalah.", en: "Advanced, <b>Video format</b>: Automatic (recommended), AV1, VP9, VP8, H.265 or H.264. Leave it on Automatic unless you are asked to change it while fixing a problem." }]],
      ["h2", "jaringan", { id: "Jaringan", en: "Network" }],
      ["ul", [{ id: "<b>Sambung lewat IP</b> untuk PC di jaringan yang sama. Lihat <a href=\"/docs/connect-by-ip/\">Sambung lewat IP</a>.", en: "<b>Connect by IP</b> for PCs on the same network. See <a href=\"/docs/connect-by-ip/\">Connect by IP</a>." },
        { id: "<b>Sambung ulang otomatis bila terputus</b>, dan <b>Berhenti menunggu setelah</b> 30 detik, 60 detik, 120 detik, 5 menit, atau tanpa batas.", en: "<b>Reconnect automatically when cut off</b>, and <b>Stop waiting after</b> 30 seconds, 60 seconds, 120 seconds, 5 minutes or no limit." },
        { id: "<b>Jangan biarkan layar mati</b>: layar PC ini tetap menyala selama sesi.", en: "<b>Keep the screen on</b>: this PC's screen stays on during a session." },
        { id: "Pengaturan lanjutan: <b>Batas kecepatan kirim</b> (5 sampai 500 Mbps) supaya internet lain di rumah tidak terganggu, dan <b>Jalur koneksi</b>: Otomatis (langsung dulu, bila tidak bisa lewat server TryDesk), Selalu langsung, atau Selalu lewat server.", en: "Advanced: <b>Upload speed limit</b> (5 to 500 Mbps) so the rest of the home internet isn't disturbed, and <b>Connection route</b>: Automatic (direct first, through the TryDesk server if that fails), Always direct, or Always through the server." }]],
      ["h2", "layanan", { id: "Layanan Windows", en: "Windows service" }],
      ["ul", [{ id: "<b>Status</b> layanan, <b>Pasang layanan</b>, dan <b>Hapus layanan</b>. Tanpa layanan, PC ini hanya bisa dihubungi saat TryDesk terbuka. Tanpa password akses, setiap koneksi tetap meminta Terima. Lihat <a href=\"/docs/windows-service/\">Layanan Windows</a>.", en: "The service <b>Status</b>, <b>Install service</b> and <b>Remove service</b>. Without the service, this PC can only be reached while TryDesk is open. Without an access password, every connection still asks for Accept. See <a href=\"/docs/windows-service/\">Windows service</a>." }]],
      ["h2", "tentang", { id: "Tentang", en: "About" }],
      ["ul", [{ id: "<b>Pembaruan otomatis</b>: dicek saat TryDesk dibuka, lalu tiap 6 jam, dengan tombol <b>Cek sekarang</b>. Lihat <a href=\"/docs/install/#perbarui\">Memperbarui TryDesk</a>.", en: "<b>Automatic updates</b>: checked when TryDesk opens, then every 6 hours, with a <b>Check now</b> button. See <a href=\"/docs/install/#perbarui\">Updating TryDesk</a>." },
        { id: "Versi, lisensi (AGPL-3.0, gratis), dan tautan kode sumber.", en: "Version, licence (AGPL-3.0, free) and a link to the source code." },
        { id: "Pengaturan lanjutan, <b>Pakai kartu grafis (GPU)</b>: matikan bila gambar rusak atau berkedip. Berlaku setelah TryDesk dibuka ulang.", en: "Advanced, <b>Use the graphics card (GPU)</b>: turn it off if the picture breaks up or flickers. Applies after TryDesk reopens." },
        { id: "<b>Kembalikan semua pengaturan</b> ke awal. ID, PC favorit, riwayat koneksi, dan password akses tetap disimpan.", en: "<b>Reset all settings</b> to the start. The ID, favourite PCs, connection history and access password are kept." }]],
      ["p", "docs.instP3"], SHOT("pengaturan-lan", "docs.shotLanAlt", "docs.shotLanCap")],
    rel: ["access-password", "connect-by-ip", "windows-service"] },
  // ---- Keamanan dan privasi
  { slug: "security", g: "aman", ic: "shield",
    t: { id: "Cara TryDesk melindungi sesi", en: "How TryDesk protects a session" }, d: { id: "Enkripsi, jalur langsung, dan password yang tidak dikirim ke server.", en: "Encryption, direct paths and a password the server never sees." }, k: "enkripsi dtls aes keamanan encryption security",
    lede: { id: "Ke mana gambar, input, dan file Anda pergi selama sesi.", en: "Where your picture, input and files go during a session." },
    body: [["p", "docs.secP1"], ["ul", ["docs.secL4"]],
      ["p", { id: "Lewat IP, TryDesk selalu meminta password akses minimal 10 karakter, karena PC Anda menjawab perangkat mana pun di jaringan yang sama yang tahu alamatnya.", en: "By IP, TryDesk always asks for an access password of at least 10 characters, because your PC answers any device on the same network that knows its address." }]],
    rel: ["permissions", "network", "scams"] },
  { slug: "permissions", g: "aman", ic: "shield",
    t: { id: "Izin akses dan mode lihat saja", en: "Permissions and view only" }, d: { id: "Atur apa yang boleh dilakukan orang lain.", en: "Decide what others may do." }, k: "izin lihat saja gelapkan kunci input permissions view only",
    lede: { id: "Yang bisa diatur pemilik PC, dan yang bisa dipakai orang yang mengontrol.", en: "What the PC's owner can set, and what the person in control can use." },
    body: [["ul", ["docs.secL7", "docs.secL3", "docs.secL1", "docs.secL2"]], SHOT("keamanan", "docs.secImgAlt", "docs.secCap", "png"), ["p", "docs.secP2"]],
    rel: ["security", "accept"] },
  { slug: "scams", g: "aman", ic: "shield",
    t: { id: "Menghindari penipuan", en: "Avoiding scams" }, d: { id: "Tanda-tanda penipuan dan apa yang harus dilakukan.", en: "Signs of a scam and what to do." }, k: "penipuan scam bank",
    lede: { id: "Remote desktop sering dipakai penipu. Tiga aturan ini melindungi Anda.", en: "Scammers like remote desktop tools. These three rules protect you." },
    body: [["ul", ["docs.newL3", "docs.newL4", "docs.newL5"]],
      ["note", "warn", { id: "Bila Anda curiga", en: "If you are suspicious" }, { id: "Klik <b>Putuskan</b>, ganti password akses di <span class=\"dc-path\">Pengaturan › Keamanan</span>, lalu buat ID baru. Lihat <a href=\"/docs/new-id/\">Buat ID baru</a>.", en: "Click <b>Disconnect</b>, change the access password in <span class=\"dc-path\">Settings › Security</span>, then make a new ID. See <a href=\"/docs/new-id/\">New ID</a>." }]],
    rel: ["new-id", "access-password", "accept"] },
  { slug: "new-id", g: "aman", ic: "shield",
    t: { id: "Buat ID baru", en: "New ID" }, h1: { id: "Buat ID <em>baru.</em>", en: "A new <em>ID.</em>" }, d: { id: "Ganti ID bila ID lama bocor.", en: "Change the ID if the old one leaked." }, k: "id baru regenerate new",
    lede: { id: "Mengganti nomor ID PC Anda.", en: "Changing your PC's ID number." },
    body: [["p", "docs.secL5"], ["p", { id: "Dengan layanan Windows, Buat ID baru mengganti ID PC ini setelah izin administrator (sejak 1.3.8).", en: "With the Windows service, New ID changes this PC's ID after administrator permission (since 1.3.8)." }]],
    rel: ["scams", "windows-service"] },
  // ---- Referensi
  { slug: "shortcuts", g: "ref", ic: "keyboard",
    t: { id: "Pintasan keyboard", en: "Keyboard shortcuts" }, d: { id: "Ctrl+Alt+Shift+Esc, Pause, F2, dan lainnya.", en: "Ctrl+Alt+Shift+Esc, Pause, F2 and more." }, k: "shortcut pintasan keyboard esc pause f2",
    lede: { id: "Tombol yang dikenal TryDesk, di satu tempat.", en: "The keys TryDesk knows, in one place." },
    body: [["table", [{ id: "Tombol", en: "Keys" }, { id: "Fungsinya", en: "What it does" }], [
        ["<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Esc</kbd>", { id: "Saat mengontrol: mouse dan keyboard kembali ke PC Anda dan layar penuh ditutup. Di PC yang dikontrol: melepaskan layar yang digelapkan.", en: "While controlling: mouse and keyboard return to your PC and full screen closes. On the controlled PC: lifts the darkened screen." }],
        ["<kbd>Pause</kbd>", { id: "Keluar dari Mode game: mouse dan keyboard kembali ke PC Anda.", en: "Leaves Game mode: mouse and keyboard return to your PC." }],
        ["<kbd>F2</kbd>", { id: "Memberi nama tab sesi yang dipilih. Klik dua kali tab juga bisa.", en: "Renames the selected session tab. Double-clicking the tab works too." }],
        ["<kbd>Ctrl</kbd>+<kbd>C</kbd>, <kbd>Ctrl</kbd>+<kbd>V</kbd>", { id: "Salin file di PC Anda, lalu tempel di layar PC remote untuk mengirimnya (Windows ke Windows, sinkron clipboard menyala, sejak 1.3.9).", en: "Copy files on your PC, then paste on the remote screen to send them (Windows to Windows, clipboard sync on, since 1.3.9)." }],
        ["<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Del</kbd>", { id: "Kirim lewat <span class=\"dc-path\">Control Center › Fitur lainnya › Kombinasi tombol</span>.", en: "Send it from <span class=\"dc-path\">Control Center › More features › Key combinations</span>." }],
        ["<kbd>Cmd</kbd> (Mac)", { id: "Dikirim sebagai <kbd>Ctrl</kbd> ke PC.", en: "Sent to the PC as <kbd>Ctrl</kbd>." }],
        ["<kbd>Ctrl</kbd>+<kbd>K</kbd>, <kbd>/</kbd>", { id: "Di dokumentasi ini: membuka kolom cari.", en: "In these docs: opens the search field." }]], true],
      ["p", "docs.gameP4"]],
    rel: ["game-mode", "mac"] },
  { slug: "network", g: "ref", ic: "keyboard",
    t: { id: "Jaringan, port, dan relay", en: "Network, ports and relay" }, d: { id: "Jalur langsung, relay TURN, dan port yang dipakai.", en: "Direct paths, TURN relay and the ports in use." }, k: "port relay turn p2p firewall 7171 443 8443 network",
    lede: { id: "Jalan yang ditempuh sebuah sesi, dan apa yang perlu dibuka di firewall.", en: "The way a session travels, and what a firewall must let through." },
    body: [["h2", "internet", { id: "Lewat internet", en: "Over the internet" }],
      ["ul", [{ id: "Server TryDesk (port <b>443</b>, HTTPS) hanya mempertemukan kedua perangkat lewat ID. Isi layar dan file tidak lewat server.", en: "The TryDesk server (port <b>443</b>, HTTPS) only introduces the two devices by ID. Screen content and files do not pass through it." },
        { id: "TryDesk mencoba jalur langsung (P2P) lebih dulu.", en: "TryDesk tries a direct (P2P) path first." },
        { id: "Bila jaringan memblokir jalur langsung, gambar lewat relay TURN TryDesk di port <b>8443</b>. Tetap terenkripsi, hanya sedikit menambah jeda.", en: "If the network blocks a direct path, the picture goes through TryDesk's TURN relay on port <b>8443</b>. Still encrypted, with a little more delay." }]],
      ["p", "docs.connP2"],
      ["h2", "lan", { id: "Di jaringan lokal", en: "On a local network" }],
      ["ul", [{ id: "<a href=\"/docs/connect-by-ip/\">Sambung lewat IP</a> memakai port <b>TCP 7171</b> dan tidak butuh internet. Izinkan TryDesk untuk jaringan <b>Private</b> di firewall Windows.", en: "<a href=\"/docs/connect-by-ip/\">Connect by IP</a> uses <b>TCP port 7171</b> and needs no internet. Allow TryDesk for <b>Private</b> networks in the Windows firewall." },
        { id: "Antar PC Windows di satu jaringan lokal, jalur cepat bisa memakai UDP milik TryDesk sendiri, terenkripsi AES-256-GCM dengan kunci per sesi.", en: "Between Windows PCs on one local network, the fast path can use TryDesk's own UDP link, encrypted with AES-256-GCM and a key per session." }]],
      ["h2", "kantor", { id: "Firewall kantor atau sekolah", en: "Office or school firewalls" }],
      ["p", { id: "Bila hanya web yang diizinkan, minta pengelola jaringan membuka koneksi keluar ke server TryDesk di port 443 dan 8443. Tanpa port 8443, sesi hanya bisa berjalan bila jalur langsung berhasil.", en: "If only the web is allowed, ask the network admin to open outgoing connections to the TryDesk server on ports 443 and 8443. Without port 8443, a session works only when a direct path succeeds." }]],
    rel: ["connect-by-ip", "security", "troubleshooting"] },
  { slug: "errors", g: "ref", ic: "keyboard", errors: true,
    t: { id: "Arti pesan Gagal tersambung", en: "What the connection errors mean" }, h1: { id: "Arti pesan <em>gagal.</em>", en: "What the errors <em>mean.</em>" }, d: { id: "Setiap pesan dan apa yang harus dicoba.", en: "Each message and what to try." }, k: "error gagal offline sibuk ditolak busy declined",
    lede: { id: "Pesan yang muncul saat sambungan tidak jadi, artinya, dan apa yang bisa dicoba.", en: "The messages you see when a connection does not happen, what they mean, and what to try." },
    rel: ["troubleshooting", "connect-by-ip", "network"] },
  { slug: "glossary", g: "ref", ic: "keyboard",
    t: { id: "Istilah", en: "Glossary" }, h1: { id: "<em>Istilah.</em>", en: "<em>Glossary.</em>" }, d: { id: "Host, viewer, P2P, relay, dan lainnya.", en: "Host, viewer, P2P, relay and more." }, k: "glosarium istilah glossary",
    lede: { id: "Kata-kata yang sering muncul di aplikasi dan di dokumentasi ini.", en: "Words that often come up in the app and in these docs." },
    body: [["table", ["docs.gloTh1", "docs.gloTh2"], [["ID", "docs.gloId"], ["Host", "docs.gloHost"], ["Viewer", "docs.gloViewer"], ["docs.gloAccK", "docs.gloAcc"], ["docs.gloPwK", "docs.gloPw"],
      ["Control Center", "docs.gloCc"], ["P2P", "docs.gloP2p"], ["Relay (TURN)", "docs.gloRelay"], ["docs.gloLanK", "docs.gloLan"]]]],
    rel: ["new-here", "network"] },
  { slug: "self-host", g: "ref", ic: "keyboard",
    t: { id: "Self-host server", en: "Self-hosting the server" }, d: { id: "Jalankan server sinyal sendiri dengan Docker.", en: "Run your own signaling server with Docker." }, k: "docker server self-host",
    lede: { id: "Untuk yang ingin memakai server sendiri, bukan server TryDesk.", en: "For those who want their own server instead of TryDesk's." },
    body: [["p", "docs.srvP1"], ["ul", ["docs.srvL1", "docs.srvL2", "docs.srvL3"]], ["p", "docs.srvP2"]],
    rel: ["network"] },
  // ---- Bantuan
  { slug: "troubleshooting", g: "bantuan", ic: "help", fix: true,
    t: { id: "Pemecahan masalah", en: "Troubleshooting" }, d: { id: "Gagal tersambung, layar hitam, atau lewat relay.", en: "Not connecting, black screen, or going through a relay." }, k: "masalah gagal layar hitam relay problem",
    lede: { id: "Masalah yang paling sering, dan cara mengatasinya.", en: "The most common problems, and how to solve them." },
    body: [["fix", [["docs.tbHFail", "docs.tbPFail"], ["docs.tbH1", "docs.tbP1"], ["docs.tbH2", "docs.tbP2"], ["docs.tbH3", "docs.tbP3"], ["docs.tbHLan", "docs.tbPLan"], ["docs.tbHLinux", "docs.tbPLinux"], ["docs.tbH5", "docs.tbP5"]]],
      ["h2", "kontak", "docs.tbH4"], ["p", "docs.tbP4"]],
    rel: ["errors", "network", "connect-by-ip"] },
  { slug: "faq", g: "bantuan", link: "/#faq", t: { id: "Pertanyaan umum", en: "FAQ" }, d: { id: "Jawaban singkat di halaman utama.", en: "Short answers on the home page." }, k: "faq pertanyaan questions" },
  { slug: "changelog", g: "bantuan", ic: "help", changelog: true,
    t: { id: "Changelog", en: "Changelog" }, h1: { id: "Changelog <em>TryDesk.</em>", en: "TryDesk <em>changelog.</em>" }, d: { id: "Semua perubahan dari 1.1.0 sampai versi terbaru.", en: "Every change from 1.1.0 to the latest version." }, k: "changelog versi riwayat update pembaruan release notes",
    lede: { id: "Semua perubahan TryDesk, versi terbaru di atas. Versi bertanda <b class=\"dc-must\">Pembaruan wajib</b> menutup masalah keamanan: TryDesk yang lebih lama menahan koneksi baru sampai diperbarui.", en: "Every TryDesk change, newest first. Versions marked <b class=\"dc-must\">Required update</b> close a security problem: an older TryDesk holds new connections until it is updated." } },
  { slug: "contact", g: "bantuan", link: "mailto:support@trydesk.ai.id", t: { id: "Hubungi kami", en: "Contact us" }, d: { id: "support@trydesk.ai.id", en: "support@trydesk.ai.id" }, k: "email kontak support contact" },
];

// The Connect-by-IP guide: the app's own "Cara pakai" (src/renderer/index.html, help-id / help-en), word for word.
const IP_STEPS = [
  { t: { id: "Nyalakan Sambung lewat IP", en: "Turn on Connect by IP" }, p: { id: "Di <span class=\"dc-path\">Pengaturan › Jaringan</span>. Saat Windows bertanya soal firewall, pilih Jaringan pribadi, lalu Izinkan akses.", en: "In <span class=\"dc-path\">Settings › Network</span>. When Windows asks about the firewall, choose Private networks, then Allow access." }, w: { id: "Di PC yang mau dikontrol", en: "On the PC you want to control" }, ill: 0 },
  { t: { id: "Pasang password akses", en: "Set an access password" }, p: { id: "Minimal 10 karakter, di <span class=\"dc-path\">Pengaturan › Keamanan</span>. Tanpa password, sambungan lewat IP selalu ditolak.", en: "At least 10 characters, in <span class=\"dc-path\">Settings › Security</span>. Without a password, connecting by IP is always refused." }, w: { id: "Di PC yang mau dikontrol", en: "On the PC you want to control" }, ill: 1 },
  { t: { id: "Lihat alamat IP-nya", en: "Find its IP address" }, p: { id: "Tampil di Beranda, di baris Sambung lewat IP, misalnya <code>192.168.1.20</code>. Alamat PC Anda bisa berbeda.", en: "It shows on Home, in the Connect by IP row, for example <code>192.168.1.20</code>. Your PC's address may differ." }, w: { id: "Di PC yang mau dikontrol", en: "On the PC you want to control" }, ill: 2 },
  { t: { id: "Ketik alamat IP itu, lalu Hubungkan", en: "Type that IP address, then Connect" }, ill: 3, only: {
      win: { id: "Di Beranda, ketik alamat IP di kolom <b>Masukkan ID atau alamat IP</b>, isi password PC tujuan saat diminta, lalu klik <b>Hubungkan</b>.", en: "On Home, type the IP address in the <b>Enter an ID or IP address</b> box, enter the other PC's password when asked, then click <b>Connect</b>." },
      and: { id: "Di tab <b>Hubungkan</b>, ketik alamat IP di kolom ID, isi password, lalu ketuk <b>Hubungkan</b>.", en: "On the <b>Connect</b> tab, type the IP address in the ID box, enter the password, then tap <b>Connect</b>." },
      mac: { id: "Di Beranda, ketik alamat IP di kolom <b>Masukkan ID atau alamat IP</b>, isi password, lalu klik <b>Hubungkan</b>. Bila macOS meminta izin <b>jaringan lokal</b>, izinkan.", en: "On Home, type the IP address in the <b>Enter an ID or IP address</b> box, enter the password, then click <b>Connect</b>. If macOS asks for <b>local network</b> access, allow it." },
      lnx: { id: "Di Beranda, ketik alamat IP di kolom <b>Masukkan ID atau alamat IP</b>, isi password, lalu klik <b>Hubungkan</b>.", en: "On Home, type the IP address in the <b>Enter an ID or IP address</b> box, enter the password, then click <b>Connect</b>." } },
    w: { win: { id: "Di PC yang mengontrol", en: "On the controlling PC" }, and: { id: "Di HP Anda", en: "On your phone" }, mac: { id: "Di Mac Anda", en: "On your Mac" }, lnx: { id: "Di PC Linux Anda", en: "On your Linux PC" } } },
];
const IP_FIX = [
  [{ id: "\"PC tujuan tidak menerima koneksi LAN\"", en: "\"The other PC doesn't accept LAN connections\"" }, { id: "Sakelar Sambung lewat IP di PC tujuan belum menyala, atau firewall memblokir. Di PC tujuan buka <span class=\"dc-path\">Keamanan Windows › Firewall › Izinkan aplikasi</span>, centang TryDesk untuk Private, dan pastikan Wi-Fi atau kabelnya diset sebagai jaringan pribadi.", en: "Connect by IP is off on that PC, or a firewall blocks it. On that PC open <span class=\"dc-path\">Windows Security › Firewall › Allow an app</span>, tick TryDesk for Private, and make sure its Wi-Fi or cable network is set to Private." }],
  [{ id: "\"Tidak ada TryDesk yang menjawab\"", en: "\"No TryDesk answered at this address\"" }, { id: "Kedua perangkat tidak di jaringan yang sama, atau Wi-Fi tamu dan hotspot memisahkan perangkat. Pakai Wi-Fi yang sama atau kabel LAN.", en: "The devices are not on the same network, or a guest Wi-Fi or hotspot keeps devices apart. Use the same Wi-Fi or a LAN cable." }],
  [{ id: "Kemarin bisa, sekarang tidak", en: "It worked before, not now" }, { id: "Alamat IP bisa berubah setelah router dinyalakan ulang. Lihat lagi alamatnya di Beranda PC tujuan.", en: "The IP address can change after the router restarts. Check the address again on that PC's Home." }],
  [{ id: "Ada antivirus dengan firewall sendiri", en: "An antivirus with its own firewall" }, { id: "Sambungan ini memakai port <b>TCP 7171</b>. Izinkan TryDesk juga di antivirus itu.", en: "This connection uses <b>TCP port 7171</b>. Allow TryDesk in that antivirus too." }],
];
const IP_CHECKS = [
  { id: "Kedua perangkat tersambung ke Wi-Fi atau kabel LAN yang sama. Wi-Fi tamu dan hotspot sering memisahkan perangkat.", en: "Both devices are on the same Wi-Fi or LAN cable. Guest Wi-Fi and hotspots often keep devices apart." },
  { id: "TryDesk 1.2.5 atau lebih baru di kedua perangkat.", en: "TryDesk 1.2.5 or newer on both devices." },
  { id: "PC yang mau dikontrol memakai Windows 10 atau 11. Mac, Linux, dan HP hanya bisa mengontrol.", en: "The PC you want to control runs Windows 10 or 11. Macs, Linux and phones can only control." },
];
const IP_COMPARE = [
  [{ id: "Butuh internet", en: "Needs internet" }, { id: "Ya", en: "Yes" }, { id: "Tidak", en: "No" }],
  [{ id: "Dari jaringan lain", en: "From another network" }, { id: "Bisa", en: "Yes" }, { id: "Tidak bisa, harus satu jaringan", en: "No, it must be the same network" }],
  [{ id: "Server TryDesk", en: "TryDesk server" }, { id: "Mempertemukan kedua perangkat", en: "Introduces the two devices" }, { id: "Tidak dipakai", en: "Not used" }],
  [{ id: "Password akses", en: "Access password" }, { id: "Boleh kosong, pemilik PC menekan Terima", en: "Optional, the owner presses Accept" }, { id: "Wajib, minimal 10 karakter", en: "Required, at least 10 characters" }],
  [{ id: "Yang diketik", en: "What you type" }, { id: "ID 9 digit", en: "The 9-digit ID" }, { id: "Alamat IP, misalnya 192.168.1.20", en: "The IP address, for example 192.168.1.20" }],
];

// "What the errors mean": the app's own texts (src/renderer/app.js FAIL_KINDS, SERVER_ERROR_TEXT, TEXT_EN).
const ERRORS = [
  [{ id: "Tidak dijawab.", en: "No answer." }, { id: "Permintaan sudah sampai, tetapi tidak ada yang menekan Terima dalam 30 detik.", en: "The request arrived, but nobody pressed Accept within 30 seconds." }, { id: "Minta pemilik PC menekan Terima saat layar merah muncul, atau masuk dengan <a href=\"/docs/access-password/\">password akses</a>.", en: "Ask the PC's owner to press Accept when the red screen appears, or get in with the <a href=\"/docs/access-password/\">access password</a>." }],
  [{ id: "Ditolak.", en: "Declined." }, { id: "Pemilik PC itu menekan Tolak pada permintaan Anda.", en: "The owner of that PC pressed Decline on your request." }, { id: "Kabari pemilik PC dulu, lalu kirim permintaan lagi.", en: "Let the PC's owner know first, then send the request again." }],
  [{ id: "Offline.", en: "Offline." }, { id: "ID tidak ditemukan, atau TryDesk di PC itu tidak tersambung ke internet.", en: "The ID was not found, or TryDesk on that PC is not connected to the internet." }, { id: "Pastikan TryDesk di PC itu terbuka dan menampilkan Online, lalu periksa lagi ID-nya. Bila satu jaringan, coba <a href=\"/docs/connect-by-ip/\">Sambung lewat IP</a>.", en: "Make sure TryDesk is open on that PC and shows Online, then check the ID again. On the same network? Try <a href=\"/docs/connect-by-ip/\">Connect by IP</a>." }],
  [{ id: "Sibuk.", en: "Busy." }, { id: "PC itu sedang dalam sesi dengan perangkat lain.", en: "That PC is in a session with another device." }, { id: "Coba lagi setelah sesi itu selesai.", en: "Try again when that session ends." }],
  [{ id: "Tidak bisa me-remote PC Anda sendiri", en: "You can't remote into your own PC" }, { id: "ID yang diketik adalah ID PC ini sendiri.", en: "The ID you typed is this PC's own." }, { id: "Ketik ID PC yang lain.", en: "Type the other PC's ID." }],
  [{ id: "Terlalu banyak permintaan, coba lagi sebentar", en: "Too many requests, try again shortly" }, { id: "Server membatasi permintaan yang dikirim terlalu sering.", en: "The server limits requests sent too often." }, { id: "Tunggu sebentar, lalu coba lagi.", en: "Wait a moment, then try again." }],
  [{ id: "PC tujuan sedang menerima terlalu banyak permintaan, coba lagi sebentar", en: "The remote PC is getting too many requests, try again in a moment" }, { id: "PC tujuan menerima banyak permintaan dalam waktu singkat.", en: "The remote PC got many requests in a short time." }, { id: "Tunggu sebentar, lalu coba lagi.", en: "Wait a moment, then try again." }],
  [{ id: "PC tujuan memakai TryDesk versi lama. Minta pemiliknya memperbarui di trydesk.ai.id/downloads", en: "The remote PC runs an old TryDesk. Ask its owner to update at trydesk.ai.id/downloads" }, { id: "TryDesk di PC itu lebih lama dari versi minimum yang aman.", en: "TryDesk on that PC is older than the oldest safe version." }, { id: "Minta pemiliknya mengunduh versi terbaru di halaman <a href=\"/downloads/\">Download</a>.", en: "Ask its owner to get the latest version on the <a href=\"/downloads/\">Download</a> page." }],
  [{ id: "TryDesk di PC ini sudah terlalu lama dan tidak bisa terhubung lagi. Perbarui di trydesk.ai.id/downloads", en: "TryDesk on this PC is too old and can no longer connect. Update at trydesk.ai.id/downloads" }, { id: "TryDesk Anda lebih lama dari versi minimum yang aman.", en: "Your TryDesk is older than the oldest safe version." }, { id: "Unduh versi terbaru di halaman <a href=\"/downloads/\">Download</a>.", en: "Get the latest version on the <a href=\"/downloads/\">Download</a> page." }],
  ...IP_FIX.slice(0, 2).map(([q, a]) => [q, a, { id: "Lihat <a href=\"/docs/connect-by-ip/\">Sambung lewat IP</a>.", en: "See <a href=\"/docs/connect-by-ip/\">Connect by IP</a>." }]),
  [{ id: "Koneksi tersendat, menyambung kembali…", en: "Connection stalled, reconnecting…" }, { id: "Sinyal sempat hilang. TryDesk mencoba memulihkan jalurnya, sampai 15 detik (sejak 1.3.9).", en: "The signal dropped. TryDesk tries to restore the path for up to 15 seconds (since 1.3.9)." }, { id: "Tunggu. Bila sesi tetap putus, sambungkan lagi.", en: "Wait. If the session still ends, connect again." }],
  [{ id: "Gagal tersambung: gambar dari PC remote tidak masuk dalam 30 detik. Coba hubungkan lagi.", en: "Couldn't connect: no picture arrived from the remote PC within 30 seconds. Try connecting again." }, { id: "Sambungan terbentuk, tetapi layar PC tujuan tidak terkirim.", en: "The connection was made, but the remote PC's screen did not come through." }, { id: "Hubungkan lagi. Bila tetap gagal, lihat <a href=\"/docs/troubleshooting/\">Pemecahan masalah</a>.", en: "Connect again. If it keeps failing, see <a href=\"/docs/troubleshooting/\">Troubleshooting</a>." }],
];

// Changelog. Sources: rilis/CATATAN-RILIS.md, website/update/version.json, the old docs version table.
// Dates: rilis/source-versions.json (1.3.4 and newer; owner 17 Nov: 1.3.5 = 7 Nov), CATATAN-RILIS headings before.
// cat: baru | baik | fix | aman. plat: semua | win | and | mac | lnx (space separated). st: must | skip
export const VERSIONS = [
  { v: "1.4.1", date: "2026-11-22", st: "must", sum: { id: "Pembaruan keamanan wajib. Berisi perbaikan keamanan dan tampilan Kelola banyak perangkat yang lebih rapi.", en: "A required security update. It brings security fixes and a tidier Manage many devices layout." }, items: [
    ["aman", "semua", { id: "Perbaikan keamanan.", en: "Security fixes." }],
    ["baik", "semua", { id: "Tampilan Kelola banyak perangkat lebih rapi, juga di Linux. Lihat <a href=\"/docs/manage-devices/\">Kelola banyak perangkat</a>.", en: "A tidier Manage many devices layout, on Linux too. See <a href=\"/docs/manage-devices/\">Manage many devices</a>." }],
  ] },
  { v: "1.4.0", date: "2026-11-21", sum: { id: "Pembaruan keamanan wajib. TryDesk memperbarui dirinya sendiri, banyak PC bisa dikelola sekaligus, semua monitor PC remote bisa tampil sekaligus, dan PC bisa dikontrol saat layar terkunci lewat layanan Windows.", en: "A required security update. TryDesk updates itself, many PCs can be managed at once, all of a remote PC's monitors can show at once, and the PC can be controlled while its screen is locked, through the Windows service." }, items: [
    ["baru", "semua", { id: "Kelola banyak perangkat (Windows, macOS, Linux, dan Android): semua PC tersimpan sebagai gambar, dikumpulkan dalam kelompok, disambung atau diputus beberapa sekaligus, dan dikirimi file yang sama. Lihat <a href=\"/docs/manage-devices/\">Kelola banyak perangkat</a>.", en: "Manage many devices (Windows, macOS, Linux and Android): every saved PC as a picture, put into groups, connected or disconnected several at once, and sent the same file. See <a href=\"/docs/manage-devices/\">Manage many devices</a>." }],
    ["baru", "semua", { id: "Titik online atau offline di gambar setiap PC tersimpan (Terakhir dihubungi, Semua perangkat, Kelola banyak perangkat).", en: "An online or offline dot on every saved PC's picture (Recently connected, All devices, Manage many devices)." }],
    ["baik", "win", { id: "TryDesk yang dijalankan sebagai administrator kini memakai jalur cepat di jaringan lokal, jadi gambarnya tidak lagi tersendat.", en: "TryDesk run as administrator now uses the fast path on a local network, so its picture no longer stutters." }],
    ["baik", "win", { id: "Program pembantu TryDesk kini bernama TryDesk dan berlogo TryDesk di jendela izin Windows.", en: "TryDesk's helper programs now show the TryDesk name and logo in Windows' permission prompts." }],
    ["baik", "semua", { id: "Kualitas bawaan kini 240 FPS dan 1000 Mbps, tidak lagi 60 FPS dan 80 Mbps: tanpa mengubah pengaturan, jalur cepat bisa sampai 240 FPS. Sesi tetap mulai pelan lalu naik sesuai jaringan, dan di jaringan lemah gambar tetap dijaga tajam.", en: "The default quality is now 240 FPS and 1000 Mbps instead of 60 FPS and 80 Mbps: without changing any setting, the fast path can reach 240 FPS. A session still starts gently and rises with the network, and on a weak network the picture is still kept sharp." }],
    ["fix", "win", { id: "TryDesk di Windows Sandbox atau mesin virtual kini mengirim gambar lancar, bukan 4–5 FPS, dan tidak lagi dibatasi 32 FPS seperti sesi Remote Desktop.", en: "TryDesk in Windows Sandbox or a virtual machine now sends a smooth picture instead of 4–5 FPS, and is no longer held to 32 FPS like a Remote Desktop session." }],    ["fix", "win", { id: "TryDesk yang dijalankan sebagai administrator: gambar tidak lagi membeku saat jalur cepat berhenti setelah FPS diganti.", en: "TryDesk run as administrator: the picture no longer freezes when the fast path stops after the FPS was changed." }],
    ["fix", "win", { id: "TryDesk Portable tidak lagi meminta izin Firewall setiap kali dibuka dan tidak lagi menumpuk aturan Firewall baru: kini selalu berjalan dari satu folder tetap.", en: "TryDesk Portable no longer asks for Firewall permission every time it opens, nor piles up new Firewall rules: it now always runs from one fixed folder." }],
    ["baru", "win", { id: "Tombol Minta akses admin saat PC remote menampilkan jendela izin admin (UAC), layar kunci, atau jendela administrator, juga di Control Center › Keamanan. Setelah disetujui di PC itu, TryDesk memasang layanan Windows lalu menyambung ulang sendiri lewat layanan, jadi jendela UAC bisa dilihat dan diklik dari jauh. Lihat <a href=\"/docs/administrator/#minta\">Minta akses admin</a>.", en: "A Request admin access button when the remote PC shows an administrator prompt (UAC), its lock screen or an administrator window, also in Control Center › Security. Once someone at that PC agrees, TryDesk installs its Windows service and reconnects through it by itself, so UAC prompts can be seen and clicked remotely. See <a href=\"/docs/administrator/#minta\">Request admin access</a>." }],    ["baru", "semua", { id: "Panel Kombinasi tombol di samping layar remote: cari pintasan, tahan Ctrl, Alt, Shift, atau Win, dan simpan kombinasi sendiri. Lihat <a href=\"/docs/game-mode/#kombinasi\">Mode game dan keyboard</a>.", en: "A Key combinations panel beside the remote screen: search for a shortcut, hold Ctrl, Alt, Shift or Win, and save your own combinations. See <a href=\"/docs/game-mode/#kombinasi\">Game mode and keyboard</a>." }],
    ["baru", "semua", { id: "Suara untuk permintaan masuk, sambungan, chat, transfer file, dan pemberitahuan, diatur di Pengaturan › Suara. Lihat <a href=\"/docs/settings/\">Pengaturan</a>.", en: "Sounds for incoming requests, connections, chat, file transfers and notices, set in Settings › Sound. See <a href=\"/docs/settings/\">Settings</a>." }],
    ["baik", "win", { id: "Saat PC remote tanpa layanan Windows menampilkan jendela UAC atau layar kunci, pengontrol kini diberi tahu kenapa gambarnya berhenti.", en: "When a remote PC without the Windows service shows a UAC prompt or its lock screen, the controlling side is now told why the picture stopped." }],
    ["baik", "win", { id: "Pesan jendela administrator kini jelas menyebut TryDesk di PC remote (TryDesk di PC Anda tidak perlu). Bila TryDesk di PC remote berjalan sebagai administrator dan jendela UAC atau layar kunci sudah tampil, Minta akses admin langsung memasang layanan tanpa bertanya.", en: "The administrator-window notice now clearly names TryDesk on the remote PC (TryDesk on your PC doesn't need it). When TryDesk on the remote PC runs as administrator and a UAC prompt or the lock screen is already showing, Request admin access installs the service right away without asking." }],
    ["fix", "semua", { id: "Ukuran tampilan 100%, 75%, dan lainnya kini mengikuti layar asli PC remote, jadi gambar tidak lagi mengecil dengan bingkai hitam saat koneksi menurunkan resolusi. Mode Semua monitor ikut membesar saat jendela di-maximize atau layar penuh. Lihat <a href=\"/docs/control-center/#tampilan\">Ukuran tampilan</a>.", en: "The 100%, 75% and other view sizes now follow the remote PC's real screen, so the picture no longer shrinks inside a black frame when the connection lowers the resolution. All-monitors mode now grows when the window is maximized or full screen. See <a href=\"/docs/control-center/#tampilan\">Display size</a>." }],
    ["fix", "semua", { id: "Gulir touchpad (Mac dan laptop) lebih halus: sapuan ringan dua jari tidak lagi menggulir halaman jauh ke bawah.", en: "Touchpad scrolling (Mac and laptops) is smoother: a light two-finger swipe no longer scrolls the page far down." }],
    ["baik", "semua", { id: "Gambar lebih tajam di koneksi tipis dengan preset 120 fps ke atas, dan ukurannya pulih lebih cepat setelah koneksi membaik.", en: "A sharper picture on thin connections with the 120 fps and higher presets, and the size comes back faster once the connection recovers." }],
    ["baik", "and", { id: "HP dan tablet meminta paling tinggi 60 fps dan gambar 1080 baris, dan jeda penghalusnya dikurangi, supaya tidak tersendat.", en: "Phones and tablets ask for at most 60 fps and a 1080-line picture, with less smoothing delay, so the picture doesn't stutter." }],
    ["fix", "semua", { id: "Sambungan lewat relay tidak lagi gagal setelah TryDesk menyala lebih dari 2 jam.", en: "Connections through the relay no longer fail after TryDesk has been running for more than 2 hours." }],
    ["fix", "win", { id: "Perbaikan keamanan dari audit luar: password akses disimpan terenkripsi oleh Windows, jalur UDP menolak paket yang diputar ulang, dan pemasangan layanan menolak folder yang dibelokkan.", en: "Security fixes from an outside audit: the access password is stored encrypted by Windows, the UDP link refuses replayed packets, and the service install refuses a redirected folder." }],
    ["baru", "semua", { id: "Pembaruan langsung dari aplikasi di Windows, macOS, Linux, dan Android: diunduh sendiri di latar, dipasang hanya bila tanda tangannya cocok, saat TryDesk ditutup atau dibuka lagi. Sesi tidak pernah diputus. Lihat <a href=\"/docs/install/#perbarui\">Memperbarui TryDesk</a>.", en: "Updates from inside the app on Windows, macOS, Linux and Android: downloaded by itself in the background, installed only when the signature matches, when TryDesk is closed or opened again. Sessions are never cut off. See <a href=\"/docs/install/#perbarui\">Updating TryDesk</a>." }],
    ["baru", "win", { id: "Layanan Windows: PC bisa dikontrol saat layar terkunci (Win+L). Layar kunci langsung tampil di viewer. Lihat <a href=\"/docs/windows-service/#kunci\">Masuk dari layar kunci</a>.", en: "Windows service: the PC can be controlled while the screen is locked (Win+L). The lock screen shows in the viewer right away. See <a href=\"/docs/windows-service/#kunci\">Signing in from the lock screen</a>." }],
    ["baru", "semua", { id: "Semua monitor sekaligus: Control Center › Monitor menampilkan peta layar PC remote, dengan pilihan Satu monitor, Semua monitor, atau Satu jendela per monitor, plus Ikuti kursor. Lihat <a href=\"/docs/monitors/#semua\">Multi-monitor</a>.", en: "All monitors at once: Control Center › Monitor shows a map of the remote PC's screens, with One monitor, All monitors or One window per monitor, plus Follow the cursor. See <a href=\"/docs/monitors/#semua\">Multiple monitors</a>." }],
    ["baru", "semua", { id: "Password atau PIN Windows bisa diketik dari jauh, juga dari keyboard HP.", en: "The Windows password or PIN can be typed remotely, also from a phone's keyboard." }],
    ["baik", "win", { id: "PC tanpa encoder video di kartu grafis (mesin virtual, Windows Sandbox) juga menampilkan layar kunci.", en: "PCs without a video encoder in the graphics card (virtual machines, Windows Sandbox) show the lock screen too." }],
    ["fix", "win", { id: "Tombol yang tertahan dilepas bila sambungan putus di layar kunci.", en: "Keys held down are released if the connection drops on the lock screen." }],
    ["fix", "semua", { id: "Pemberitahuan versi baru tampil lagi. Sejak 1.3.9 pemberitahuan ini tidak muncul karena catatan versinya terlalu panjang.", en: "The new-version notice shows again. Since 1.3.9 it didn't appear, because the version notes were too long." }],
    ["baik", "and", { id: "Di HP, tombol Kembali kini bertanya Putuskan atau Batal, dan tombol Putar disembunyikan di jendela yang tidak bisa berputar.", en: "On the phone, Back now asks Disconnect or Cancel, and the Rotate button is hidden in windows that can't rotate." }],
    ["fix", "and", { id: "Touchpad Android lebih tepat: saat memakai mouse tidak ada lagi dua kursor, titik klik tidak lagi bergeser di HP berponi, dan sentuhan di area hitam tidak lagi mengklik tepi layar PC.", en: "A more accurate Android touchpad: no second cursor when using a mouse, the click point no longer shifts on phones with a notch, and a touch on the black band no longer clicks the edge of the PC's screen." }],
    ["fix", "win", { id: "ID PC tidak lagi berganti sendiri setelah pembaruan di PC yang memakai layanan Windows.", en: "The PC's ID no longer changes by itself after an update on PCs that use the Windows service." }],
  ] },
  { v: "1.3.9", date: "2026-11-17", sum: { id: "File Transfer baru, salin-tempel file antar PC, 22 bahasa, dan gambar yang tetap tajam di koneksi lambat.", en: "A new File Transfer, copy and paste of files between PCs, 22 languages, and a sharp picture on slow connections." }, items: [
    ["baru", "win", { id: "File Transfer baru: folder bisa dikirim beserta isinya, dibuat, diganti nama, dihapus, dan dicari. File bisa diseret antar-panel, dipilih dengan kotak seret, dan ada menu klik kanan.", en: "A new File Transfer: whole folders can be sent, created, renamed, removed and searched. Files can be dragged between the panes or picked with a drag box, and there is a right-click menu." }],
    ["baru", "win", { id: "Transfer yang terputus karena koneksi hilang dilanjutkan dari bagian terakhir setelah tersambung lagi.", en: "A transfer cut off by a lost connection goes on from where it stopped once you reconnect." }],
    ["baru", "win", { id: "Salin file di satu PC lalu tempel di PC lain dengan Ctrl+C dan Ctrl+V.", en: "Copy files on one PC and paste them on the other with Ctrl+C and Ctrl+V." }],
    ["baru", "semua", { id: "Gambar dan file bisa dikirim lewat chat.", en: "Pictures and files can be sent in the chat." }],
    ["baru", "semua", { id: "TryDesk tersedia dalam 22 bahasa. Pilih di Pengaturan › Umum, atau ikuti bahasa Windows.", en: "TryDesk speaks 22 languages. Pick one in Settings › General, or follow Windows." }],
    ["baru", "semua", { id: "Pengaturan baru dibuka dengan halaman Ringkasan. Satu baris per pengaturan, dan pengaturan teknis ada di Pengaturan lanjutan.", en: "The new Settings open with a Summary page. One line per setting, technical settings under Advanced settings." }],
    ["baru", "win", { id: "Tampilan sesi baru: nama tamu dan sakelar izin saat PC dikontrol, dan layar ditolak yang menjelaskan langkahnya.", en: "A new session look: the guest's name and permission switches while the PC is controlled, and a declined screen that explains what to try." }],
    ["baru", "win", { id: "Layanan Windows: File Manager membuka folder PC dengan hak akses orang yang sedang masuk ke Windows di sana.", en: "Windows service: the file manager opens the PC's folders with the rights of whoever is signed in to Windows there." }],
    ["baik", "win", { id: "Gambar lebih tajam: H.265 dipakai otomatis bila kedua PC mampu, dan kini bisa dipilih juga di jaringan lokal.", en: "A sharper picture: H.265 is used by itself when both PCs can, and can now be picked on a local network too." }],
    ["baik", "semua", { id: "Tersambung lebih cepat, dan beberapa detik pertama sesi tidak lagi tersendat.", en: "Faster connecting, and the first seconds of a session no longer stall." }],
    ["baik", "semua", { id: "Di koneksi lambat gambar tetap tajam: fps diturunkan dulu, bukan resolusi.", en: "On a slow connection the picture stays sharp: the fps goes down first, not the resolution." }],
    ["baik", "win", { id: "Suara PC remote menyala otomatis, juga bila TryDesk dijalankan sebagai administrator.", en: "The remote PC's sound comes on by itself, also when TryDesk runs as administrator." }],
    ["baik", "win", { id: "Password akses tampil sebagai kartu yang jelas, dengan tombol Simpan dan status layanan Windows.", en: "The access password is a clear card, with a Save button and the Windows service's status." }],
    ["fix", "semua", { id: "Sinyal yang hilang sebentar tidak lagi memutus sesi.", en: "A short signal loss no longer ends the session." }],
    ["fix", "semua", { id: "Jeda saat mengganti codec, atau saat layar jarang berubah (mengetik, klik), sudah hilang.", en: "The delay after changing the codec, or when the screen changes only now and then (typing, clicking), is gone." }],
    ["fix", "semua", { id: "Layar remote tidak lagi mengecil sendiri.", en: "The remote screen no longer shrinks by itself." }],
    ["fix", "and", { id: "Gestur kembali di tepi layar tidak lagi menjadi klik di PC remote.", en: "The back gesture at the screen edge no longer turns into a click on the remote PC." }],
    ["aman", "win", { id: "Layanan Windows: celah keamanan lokal ditutup. File di folder pengguna kini dikerjakan dengan hak pengguna, bukan SYSTEM.", en: "Windows service: a local security hole is closed. Files in user folders are now handled with the user's rights, not SYSTEM." }],
  ] },
  { v: "1.3.8", date: "2026-11-10", sum: { id: "Seret file ke layar remote, dan ID PC yang tidak lagi berganti.", en: "Drag files onto the remote screen, and a PC ID that no longer changes." }, items: [
    ["baru", "win", { id: "Seret file ke layar PC yang Anda kontrol untuk mengirimnya, atau ke layar \"sedang dikontrol\" untuk mengirimnya ke viewer.", en: "Drag files onto the screen of the PC you control to send them, or onto the \"being controlled\" screen to send them to the viewer." }],
    ["fix", "win", { id: "ID PC tidak lagi berganti kalau TryDesk ditutup paksa atau di-update tepat setelah pertama dibuka.", en: "The PC's ID no longer changes when TryDesk is force-closed or updated right after its first start." }],
    ["fix", "win", { id: "Dengan layanan Windows, Beranda dan Pengaturan menampilkan ID yang sama.", en: "With the Windows service, Home and Settings show the same ID." }],
    ["fix", "win", { id: "Buat ID baru dengan layanan Windows benar-benar mengganti ID PC ini, setelah izin administrator.", en: "New ID with the Windows service really changes this PC's ID, after administrator permission." }],
  ] },
  { v: "1.3.7", date: "2026-11-08", sum: { id: "Host administrator, satu TryDesk saat layanan aktif, dan dialog UAC dari jarak jauh.", en: "Administrator hosts, one TryDesk with the service on, and UAC dialogs from afar." }, items: [
    ["fix", "win", { id: "TryDesk yang dijalankan sebagai administrator kini mengirim layarnya. Dulu viewer terus memuat sampai gagal.", en: "TryDesk running as administrator now sends its screen. Before, the viewer kept loading until it failed." }],
    ["baik", "win", { id: "Dengan layanan Windows, permintaan masuk, layar sedang dikontrol, Chat, dan Putuskan tampil di TryDesk Anda sendiri.", en: "With the Windows service, incoming requests, the being-controlled screen, Chat and Disconnect show in your own TryDesk." }],
    ["baru", "win", { id: "Transfer file dalam sesi lewat layanan Windows. File masuk ke Unduhan\\TryDesk.", en: "File transfer in sessions through the Windows service. Files go to Downloads\\TryDesk." }],
    ["baru", "win", { id: "Dialog UAC bisa dilihat dan dijawab dari jarak jauh lewat layanan Windows.", en: "UAC dialogs can be seen and answered remotely through the Windows service." }],
    ["fix", "win", { id: "Halaman Semua perangkat kembali menutupi seluruh beranda.", en: "The All devices page covers the whole home screen again." }],
  ] },
  { v: "1.3.6", date: "2026-11-07", st: "skip", sum: { id: "Tidak pernah diunggah. Isinya ikut 1.3.7.", en: "Never uploaded. Its changes shipped in 1.3.7." }, items: [
    ["baik", "win", { id: "Sesi desktop memakai warna gelap Beranda, dan tab sesi lebih rapi.", en: "Desktop sessions use Home's dark colours, and session tabs are tidier." }],
    ["fix", "and", { id: "Tombol Keyboard di dok tidak lagi mepet saat layar mendatar.", en: "The Keyboard button in the dock is no longer squeezed in landscape." }],
    ["fix", "lnx", { id: "Tombol Unduh pada pemberitahuan versi baru kini membuka browser.", en: "The Download button on the new-version notice now opens the browser." }],
  ] },
  { v: "1.3.5", date: "2026-11-07", sum: { id: "Tampilan baru di desktop, Android, dan website.", en: "A new look on desktop, Android and the website." }, items: [
    ["baru", "semua", { id: "Beranda dengan ID besar, baris Terakhir dihubungi, dan halaman Perangkat.", en: "Home with a large ID, the Recent row and a Devices page." }],
    ["baru", "semua", { id: "Layar Gagal tersambung menjelaskan sebabnya, dan permintaan masuk tampil merah penuh.", en: "The could-not-connect screen explains why, and incoming requests fill the screen in red." }],
    ["baik", "semua", { id: "Control Center jadi panel di kanan. Pengaturan jadi halaman, dan tema bisa mengikuti Windows.", en: "Control Center is a panel on the right. Settings are pages, and the theme can follow Windows." }],
    ["baru", "win", { id: "Tab sesi bisa diganti nama.", en: "Session tabs can be renamed." }],
  ] },
  { v: "1.3.4", date: "2026-11-03", st: "must", sum: { id: "Perbaikan wajib untuk 1.3.3.", en: "A required fix for 1.3.3." }, items: [
    ["fix", "semua", { id: "Sambungan dengan password dan Sambung lewat IP tidak lagi macet di Menghubungkan.", en: "Password connections and Connect by IP no longer hang at Connecting." }],
    ["fix", "win", { id: "Layanan Windows tidak lagi menampilkan jendela kosong.", en: "The Windows service no longer shows an empty window." }],
    ["fix", "win", { id: "Sambung lewat IP tetap jalan saat layanan Windows aktif.", en: "Connect by IP keeps working while the Windows service is on." }],
  ] },
  { v: "1.3.3", date: "2026-11-03", st: "must", sum: { id: "Jalur UDP sampai 1000 Mbps di jaringan lokal, dan pembaruan keamanan wajib.", en: "A UDP path up to 1000 Mbps on local networks, and a required security update." }, items: [
    ["baru", "win", { id: "Jalur UDP jalur cepat: bitrate sampai 1000 Mbps antar PC Windows di satu jaringan lokal.", en: "Fast-path UDP link: up to 1000 Mbps between Windows PCs on one local network." }],
    ["aman", "semua", { id: "Sesi berpassword dan pemberitahuan pembaruan ditandatangani.", en: "Password sessions and update notices are signed." }],
    ["aman", "semua", { id: "ID perangkat tidak bisa diganti server.", en: "The server can no longer change a device's ID." }],
    ["aman", "win", { id: "Hash password layanan dipindah ke folder administrator.", en: "The service's password hash moved to an administrators-only folder." }],
  ] },
  { v: "1.3.2", date: "2026-11-02", sum: { id: "Layanan Windows dan jalur cepat sampai 240 FPS.", en: "The Windows service and a fast path up to 240 FPS." }, items: [
    ["baru", "win", { id: "Layanan Windows: PC tetap bisa dikontrol walau jendela TryDesk ditutup. Setup memasangnya.", en: "Windows service: the PC stays reachable with the TryDesk window closed. Setup installs it." }],
    ["baru", "win", { id: "Jalur cepat di PC Windows yang dikontrol: capture dan kompresi di GPU, sampai 240 FPS dengan jeda lebih kecil.", en: "Fast path on the controlled Windows PC: capture and compression on the GPU, up to 240 FPS with less delay." }],
    ["baru", "semua", { id: "Layar password baru.", en: "A new password screen." }],
    ["fix", "semua", { id: "Bitrate tidak lagi tertahan di 80 Mbps.", en: "The bitrate is no longer stuck at 80 Mbps." }],
    ["baik", "semua", { id: "Pesan server mengikuti bahasa aplikasi, dan layar host yang digelapkan lebih andal.", en: "Server messages follow the app's language, and darkening the host's screen is more reliable." }],
    ["baru", "and", { id: "Grid atau daftar di tab Perangkat, dan screenshot serta rekam sesi ke galeri.", en: "Grid or list on the Devices tab, and screenshots and recordings saved to the gallery." }],
  ] },
  { v: "1.3.1", date: "2026-11-01", st: "must", sum: { id: "Pembaruan keamanan wajib.", en: "A required security update." }, items: [
    ["aman", "win", { id: "Alamat jaringan dan pipe dari PC lain ditolak.", en: "Network addresses and pipes from other PCs are refused." }],
    ["aman", "semua", { id: "Pesan palsu dari PC lain tidak ditampilkan. Electron 45.2.1.", en: "Fake messages from another PC are not shown. Electron 45.2.1." }],
    ["fix", "semua", { id: "Ctrl tidak lagi tertahan saat pindah tab.", en: "Ctrl no longer stays held when switching tabs." }],
  ] },
  { v: "1.3.0", date: "2026-11-01", sum: { id: "TryDesk untuk macOS.", en: "TryDesk for macOS." }, items: [
    ["baru", "mac", { id: "TryDesk untuk macOS (Apple Silicon dan Intel) untuk mengontrol PC Windows.", en: "TryDesk for macOS (Apple Silicon and Intel) to control Windows PCs." }],
    ["baru", "mac", { id: "Tombol Cmd dikirim sebagai Ctrl ke PC.", en: "The Cmd key is sent to the PC as Ctrl." }],
  ] },
  { v: "1.2.9", date: "2026-10-30", sum: { id: "Tombol tampilkan password dan versi di Android.", en: "A show-password button, and the version on Android." }, items: [
    ["baru", "semua", { id: "Tombol tampilkan password di kolom sambung dan di kotak password layar Menghubungkan.", en: "A show-password button in the connect box and in the Connecting screen's password box." }],
    ["baru", "and", { id: "Nomor versi tampil di aplikasi Android.", en: "The version number shows in the Android app." }],
    ["fix", "and", { id: "Toolbar tidak lagi terpotong di mode vertikal.", en: "The toolbar is no longer cut off in portrait." }],
  ] },
  { v: "1.2.8", date: "2026-10-29", sum: { id: "Pemberitahuan versi baru dan mode game di Android.", en: "New-version notices, and game mode on Android." }, items: [
    ["baru", "semua", { id: "Pemberitahuan versi baru.", en: "New-version notices." }],
    ["aman", "semua", { id: "Password minimal 10 karakter untuk Sambung lewat IP.", en: "Passwords of at least 10 characters for Connect by IP." }],
    ["baru", "and", { id: "Mode game di Android, dan menu bawah mengambang.", en: "Game mode on Android, and a floating bottom menu." }],
  ] },
  { v: "1.2.7", date: "2026-10-29", sum: { id: "Beranda baru berbentuk kartu.", en: "A new card-style Home." }, items: [
    ["baru", "win and", { id: "Beranda baru berbentuk kartu, dan panduan Sambung lewat IP di aplikasi.", en: "A new card-style Home, and a Connect by IP guide in the app." }],
  ] },
  { v: "1.2.6", date: "2026-10-29", sum: { id: "Perbaikan tampilan.", en: "Layout fixes." }, items: [
    ["fix", "win", { id: "Nama file di manajer file tidak terpotong lagi, dan jendela kecil tetap rapi.", en: "File names in the file manager are no longer cut off, and small windows stay tidy." }],
  ] },
  { v: "1.2.5", date: "2026-10-29", sum: { id: "Sambung lewat IP.", en: "Connect by IP." }, items: [
    ["baru", "semua", { id: "Sambung lewat IP di jaringan lokal, tanpa internet dan tanpa server. Host dan viewer sama-sama butuh 1.2.5 atau lebih baru.", en: "Connect by IP on a local network, with no internet and no server. Host and viewer both need 1.2.5 or newer." }],
  ] },
  { v: "1.2.4", date: "2026-10-29", sum: { id: "Android layar penuh.", en: "Full screen on Android." }, items: [
    ["baru", "and", { id: "Layar penuh dan landscape otomatis selama tersambung, dan tombol putar di toolbar.", en: "Full screen and landscape by themselves while connected, and a rotate button in the toolbar." }],
  ] },
  { v: "1.2.3", date: "2026-10-29", sum: { id: "Mouse lebih responsif.", en: "A more responsive mouse." }, items: [
    ["baik", "semua", { id: "Mouse lebih responsif dan jeda gambar lebih kecil, H.264 dengan encoder GPU. Kanal mouse baru butuh kedua sisi 1.2.3 atau lebih baru.", en: "A more responsive mouse and less picture delay, H.264 with the GPU encoder. The new mouse channel needs 1.2.3 or newer on both sides." }],
  ] },
  { v: "1.2.2", date: "2026-10-29", sum: { id: "Folder unduhan dan ikon taskbar.", en: "Download folders and the taskbar icon." }, items: [
    ["baik", "semua", { id: "Unduhan lebih rapi: satu folder per platform, dan nama file memuat versinya.", en: "Tidier downloads: one folder per platform, and file names carry the version." }],
    ["fix", "win", { id: "Ikon TryDesk di taskbar tidak lagi hilang.", en: "The TryDesk icon no longer disappears from the taskbar." }],
  ] },
  { v: "1.2.1", date: "2026-10-29", sum: { id: "TryDesk untuk Linux.", en: "TryDesk for Linux." }, items: [
    ["baru", "lnx", { id: "TryDesk untuk Linux (viewer).", en: "TryDesk for Linux (viewer)." }],
    ["baik", "win", { id: "Pesan yang jelas saat jendela administrator di PC remote tidak bisa dikontrol.", en: "A clear message when an administrator window on the remote PC cannot be controlled." }],
  ] },
  { v: "1.2.0", date: "2026-10-28", sum: { id: "Lisensi AGPL-3.0.", en: "The AGPL-3.0 licence." }, items: [
    ["baru", "semua", { id: "Lisensi AGPL-3.0 dan kebijakan merek.", en: "The AGPL-3.0 licence and a trademark policy." }],
  ] },
  { v: "1.1.1", date: "2026-10-28", sum: { id: "Rilis keamanan.", en: "A security release." }, items: [
    ["aman", "semua", { id: "Tebakan password dibatasi, dan clipboard tidak bisa ditimpa diam-diam.", en: "Password guesses are limited, and the clipboard cannot be overwritten silently." }],
  ] },
  { v: "1.1.0", date: "2026-10-26", sum: { id: "Aplikasi Android.", en: "The Android app." }, items: [
    ["baru", "and", { id: "Aplikasi Android.", en: "The Android app." }],
    ["baru", "semua", { id: "Kotak password di layar Menghubungkan.", en: "A password box on the Connecting screen." }],
    ["baru", "win", { id: "Terakhir dihubungi bergambar, dan ikon di system tray.", en: "Recent devices with pictures, and a system tray icon." }],
  ] },
];

// Interface words of the docs pages themselves.
const UI = {
  docs: { id: "Dokumentasi", en: "Documentation" }, search: { id: "Cari di dokumentasi", en: "Search the docs" },
  summary: { id: "Ringkasan", en: "Summary" }, summarySub: { id: "Mulai dari sini", en: "Start here" },
  close: { id: "Tutup", en: "Close" }, menu: { id: "Menu dokumentasi", en: "Docs menu" },
  updated: { id: "Diperbarui", en: "Updated" }, related: { id: "Halaman terkait", en: "Related pages" },
  prev: { id: "Sebelumnya", en: "Previous" }, next: { id: "Berikutnya", en: "Next" },
  edit: { id: "Ada yang salah atau kurang jelas di halaman ini? Kirim email ke <a href=\"mailto:support@trydesk.ai.id\">support@trydesk.ai.id</a>.", en: "Something wrong or unclear on this page? Email <a href=\"mailto:support@trydesk.ai.id\">support@trydesk.ai.id</a>." },
  platLabel: { id: "Saya mengontrol dari", en: "I'm controlling from" }, platInstall: { id: "Memasang di", en: "Installing on" },
  device: { id: "Perangkat", en: "Device" }, all: { id: "Semua", en: "All" },
  before: { id: "Sebelum mulai", en: "Before you start" }, steps: { id: "Langkah", en: "Steps" },
  compare: { id: "Lewat ID atau lewat IP?", en: "By ID or by IP?" }, byId: { id: "Lewat ID", en: "By ID" }, byIp: { id: "Lewat IP", en: "By IP" },
  ifFail: { id: "Kalau gagal tersambung", en: "If it doesn't connect" },
  pwWhy: { id: "Kenapa password wajib", en: "Why the password is required" },
  pwWhyP: { id: "Lewat IP, PC Anda menjawab perangkat mana pun di jaringan yang sama yang tahu alamatnya. Karena itu TryDesk menolak sambungan lewat IP bila password akses belum dipasang atau kurang dari 10 karakter.", en: "By IP, your PC answers any device on the same network that knows its address. That is why TryDesk refuses connections by IP when no access password is set, or it is shorter than 10 characters." },
  stepN: { id: "Langkah", en: "Step" }, meaning: { id: "Artinya", en: "What it means" }, tryThis: { id: "Yang bisa dicoba", en: "What to try" },
  startHere: { id: "Mulai dari sini", en: "Start here" }, allGuides: { id: "Semua panduan", en: "All guides" },
  latest: { id: "Versi terbaru", en: "Latest version" }, seeAll: { id: "Lihat semua perubahan", en: "See all changes" }, get: { id: "Unduh", en: "Download" },
  must: { id: "Pembaruan wajib", en: "Required update" }, skip: { id: "Tidak dirilis", en: "Not released" },
  checkVer: { id: "Cek versi Anda di pojok kanan bawah Beranda, atau di <span class=\"dc-path\">Pengaturan › Tentang</span>.", en: "Check your version at the bottom right of Home, or in <span class=\"dc-path\">Settings › About</span>." },
  versions: { id: "versi", en: "versions" }, emptyT: { id: "Tidak ada perubahan untuk perangkat ini.", en: "No changes for this device." },
  emptyP: { id: "Pilih perangkat lain, atau", en: "Pick another device, or" }, showAll: { id: "tampilkan semua", en: "show everything" },
  dlLatest: { id: "Unduh versi terbaru", en: "Download the latest version" }, src: { id: "Kode sumber", en: "Source code" },
  allDevices: { id: "Semua perangkat", en: "All devices" }, noResults: { id: "Tidak ada yang cocok dengan", en: "Nothing matches" }, tryOther: { id: "Coba kata lain, misalnya password, IP, atau file.", en: "Try another word, for example password, IP or file." },
  verCard: { id: "Yang baru", en: "What's new" },
};
const CATS = { baru: { id: "Baru", en: "New" }, baik: { id: "Lebih baik", en: "Improved" }, fix: { id: "Perbaikan", en: "Fixed" }, aman: { id: "Keamanan", en: "Security" } };
const PLATS = { win: "Windows", and: "Android", mac: "macOS", lnx: "Linux" };
// Links of the old one-page Documentation (/docs/#section) and where that section lives now.
export const OLD_ANCHORS = { pemula: "new-here", mulai: "quick-start", platform: "requirements", instal: "install", macos: "mac", hubungkan: "connect-by-id", menerima: "accept",
  "control-center": "control-center", monitor: "monitors", tab: "tabs", file: "file-transfer", chat: "chat", rekam: "recording", tombol: "game-mode", game: "game-mode",
  android: "android", keamanan: "security", server: "self-host", versi: "changelog", masalah: "troubleshooting" };

// ---------------------------------------------------------------------------------------------------- engine
const i18nSrc = fs.readFileSync(path.join(SITE, "assets/js/i18n.js"), "utf8");
const dAt = i18nSrc.indexOf("var dict = ");
const DICT = new Function("return " + i18nSrc.slice(dAt + 11, i18nSrc.indexOf("\n  };", dAt) + 4))();
const used = new Set(), missing = new Set();
const KEY = /^[a-z][a-zA-Z0-9]*\.[a-zA-Z0-9]+$/;
const isKey = (x) => typeof x === "string" && KEY.test(x);
function L(x, lang) {
  if (x == null) return "";
  if (isKey(x)) { used.add(x); const v = DICT[lang][x]; if (v == null) { missing.add(`${lang} ${x}`); return x; } return v; }
  if (typeof x === "string") return x;
  if (x[lang] == null) { missing.add(`${lang} ${JSON.stringify(x).slice(0, 60)}`); return ""; }
  return x[lang];
}
const plain = (h) => String(h).replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const MONTH = { id: ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"], en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] };
const fmtDate = (iso, lang) => { const [y, m, d] = iso.split("-").map(Number); return lang === "en" ? `${MONTH.en[m - 1]} ${d}, ${y}` : `${d} ${MONTH.id[m - 1]} ${y}`; };
const SITE_PAGES = /^\/(docs|downloads|source|sponsor|donate|privacy|terms)(\/|$)|^\/(#|$)/;
const real = PAGES.filter((p) => !p.link);
const bySlug = Object.fromEntries(PAGES.map((p) => [p.slug, p]));
const docUrl = (slug, lang) => (lang === "en" ? "/en" : "") + (slug ? `/docs/${slug}/` : "/docs/");
// Links inside texts: old one-page anchors go to their page; on English pages, our own pages go to /en/.
function links(html, lang) {
  html = html.replace(/href="(?:\/docs\/)?#([\w-]+)"/g, (m, a) => (OLD_ANCHORS[a] ? `href="/docs/${OLD_ANCHORS[a]}/"` : m));
  html = html.replace(/\sclass="text-brand underline"/g, "");
  if (lang === "en") html = html.replace(/href="(\/[^"]*)"/g, (m, u) => (SITE_PAGES.test(u) && !u.startsWith("/en/") ? `href="/en${u}"` : m));
  return html;
}
const T = (x, lang) => links(L(x, lang), lang);
let DATE_ISO = "";
function h1Of(p, lang) {
  if (p.h1) return p.h1[lang];
  const t = L(p.t, lang), i = t.lastIndexOf(" ");
  return i < 0 ? `<em>${t}.</em>` : `${t.slice(0, i)} <em>${t.slice(i + 1)}.</em>`;
}

const IC = {
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 4.9.8c0 1.7-2.4 2-2.4 3.7M12 17h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', chev: '<path d="M9 6l6 6-6 6"/>', down: '<path d="M6 9l6 6 6-6"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  warn: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17h.01"/>', lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  home: '<path d="M4 11l8-7 8 7v9H4z"/><path d="M10 20v-5h4v5"/>', dl: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
};
const ic = (n, cls = "", w = 1.8) => `<svg${cls ? ` class="${cls}"` : ""} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n]}</svg>`;

// figures: docs pictures exist at 1x and @2x (webp, three PNGs)
const FIG = { pc: [960, 600], phone: [412, 915], land: [915, 412], png: [960, 600] };
function figure(name, alt, cap, kind, lang, V) {
  const isPath = name.startsWith("/");
  const ext = kind === "png" ? "png" : "webp";
  const base = isPath ? name.replace(/\.(png|webp)$/, "") : `/assets/img/docs/${name}`, e = isPath ? name.split(".").pop() : ext;
  const [w, h] = FIG[kind] || FIG.pc;
  return `<figure class="dc-shot${kind === "phone" ? " dc-shot-phone" : ""}"><img src="${base}.${e}?v=${V}" srcset="${base}.${e}?v=${V} ${w}w, ${base}@2x.${e}?v=${V} ${w * 2}w" sizes="(max-width: 820px) 100vw, 820px" width="${w}" height="${h}" loading="lazy" decoding="async" alt="${escAttr(plain(L(alt, lang)))}"><figcaption>${T(cap, lang)}</figcaption></figure>`;
}

function blocks(list, lang, V) {
  return list.map((b) => {
    const [kind] = b;
    if (kind === "p") return `<p>${T(b[1], lang)}</p>`;
    if (kind === "h2") return `<h2 id="${b[1]}">${T(b[2], lang)}</h2>`;
    if (kind === "ul") return `<ul>${b[1].map((x) => `<li>${T(x, lang)}</li>`).join("")}</ul>`;
    if (kind === "ol") return `<ol class="dc-ol">${b[1].map((x) => `<li>${T(x, lang)}</li>`).join("")}</ol>`;
    if (kind === "fig") return figure(b[1], b[2], b[3], b[4], lang, V);
    if (kind === "note") return `<div class="dc-note${b[1] === "warn" ? " warn" : ""}">${ic(b[1] === "warn" ? "warn" : "info", "", 1.9)}<div><b>${T(b[2], lang)}</b><p>${T(b[3], lang)}</p></div></div>`;
    if (kind === "table") return `<div class="dc-card dc-table${b[3] ? " stack" : ""}"><table><thead><tr>${b[1].map((h) => `<th scope="col">${T(h, lang)}</th>`).join("")}</tr></thead><tbody>${b[2].map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${T(c, lang)}</th>` : `<td>${T(c, lang)}</td>`)).join("")}</tr>`).join("")}</tbody></table></div>`;
    if (kind === "fix") return `<div class="dc-card dc-fix">${b[1].map(([q, a], i) => `<details${i === 0 ? " open" : ""}><summary>${plain(T(q, lang))}${ic("down", "", 2)}</summary><div><p>${T(a, lang)}</p></div></details>`).join("")}</div>`;
    if (kind === "only") return `<div data-only="${b[1]}"${b[1].split(" ").includes("win") ? "" : " hidden"}>${blocks(b[2], lang, V)}</div>`;
    throw new Error("unknown block " + kind);
  }).join("\n");
}

function platSwitch(p, lang) {
  const label = p.slug === "install" ? UI.platInstall : UI.platLabel;
  return `<div class="dc-plat"><span class="dc-seg-label" id="dc-plat-l">${L(label, lang)}</span><div class="dc-seg" data-plat-switch role="group" aria-labelledby="dc-plat-l">${PLAT_ALL.map((k, i) => `<button type="button" data-v="${k}" aria-pressed="${i === 0}">${PLATS[k]}</button>`).join("")}</div></div>
<noscript><style>[data-only]{display:block!important}[data-only][hidden]{display:block!important}.dc-plat{display:none}</style></noscript>`;
}

function ipIll(i, lang) {
  const sw = '<span class="dc-sw" aria-hidden="true"></span>';
  const w = (id, en) => (lang === "en" ? en : id);
  return [
    `<div class="dc-ill" aria-hidden="true"><div class="dc-ill-row"><span><b>${w("Sambung lewat IP", "Connect by IP")}</b><small>${w("Pengaturan › Jaringan", "Settings › Network")}</small></span>${sw}</div></div>`,
    `<div class="dc-ill" aria-hidden="true"><div class="dc-ill-row dc-ill-col"><span><b>${w("Password akses", "Access password")}</b><small>${w("Pengaturan › Keamanan", "Settings › Security")}</small></span><span class="dc-inp">•••••••••••</span><span class="dc-ok">${ic("check", "", 3)}${w("11 karakter, cukup untuk sambung lewat IP", "11 characters, enough to connect by IP")}</span></div></div>`,
    `<div class="dc-ill" aria-hidden="true"><div class="dc-ill-row"><span><small>${w("Beranda", "Home")}</small><b>${w("Sambung lewat IP", "Connect by IP")}</b></span><span class="dc-ip">192.168.1.20</span><span class="dc-copy">${w("Salin", "Copy")}</span></div></div>`,
    `<div class="dc-ill" aria-hidden="true"><div class="dc-ill-row dc-ill-col"><small>${w("Masukkan ID atau alamat IP", "Enter an ID or IP address")}</small><span class="dc-inp dc-mono">192.168.1.20</span><span class="dc-inp dc-dim">${w("Password PC tujuan", "The other PC's password")}</span><span class="dc-go">${w("Hubungkan", "Connect")}</span></div></div>`,
  ][i];
}
function ipGuide(lang, V) {
  const step = (s, i) => {
    const text = s.only ? PLAT_ALL.map((k) => `<p data-only="${k}"${k === "win" ? "" : " hidden"}>${T(s.only[k], lang)}</p>`).join("") : `<p>${T(s.p, lang)}</p>`;
    const who = s.only ? PLAT_ALL.map((k) => `<span data-only="${k}"${k === "win" ? "" : " hidden"}>${L(s.w[k], lang)}</span>`).join("") : L(s.w, lang);
    return `<li class="dc-step"><span class="dc-step-n" aria-hidden="true">${i + 1}</span><div class="dc-step-t"><h3><span class="dc-sr">${L(UI.stepN, lang)} ${i + 1}: </span>${L(s.t, lang)}</h3>${text}<small>${who}</small></div>${ipIll(s.ill, lang)}</li>`;
  };
  return `<h2 id="sebelum">${L(UI.before, lang)}</h2>
<div class="dc-card dc-checks">${IP_CHECKS.map((c) => `<div class="dc-check">${ic("check", "", 2.2)}<span>${L(c, lang)}</span></div>`).join("")}</div>
<h2 id="langkah">${L(UI.steps, lang)}</h2>
<ol class="dc-card dc-steps">${IP_STEPS.map(step).join("")}</ol>
${figure("pengaturan-lan", "docs.shotLanAlt", "docs.shotLanCap", "pc", lang, V)}
<div class="dc-note warn">${ic("lock", "", 1.9)}<div><b>${L(UI.pwWhy, lang)}</b><p>${L(UI.pwWhyP, lang)}</p></div></div>
<h2 id="beda">${L(UI.compare, lang)}</h2>
<div class="dc-card dc-table"><table><thead><tr><th scope="col"><span class="dc-sr">-</span></th><th scope="col">${L(UI.byId, lang)}</th><th scope="col">${L(UI.byIp, lang)}</th></tr></thead><tbody>${IP_COMPARE.map((r) => `<tr><th scope="row">${L(r[0], lang)}</th><td>${L(r[1], lang)}</td><td>${L(r[2], lang)}</td></tr>`).join("")}</tbody></table></div>
<h2 id="gagal">${L(UI.ifFail, lang)}</h2>
<div class="dc-card dc-fix">${IP_FIX.map(([q, a], i) => `<details${i === 0 ? " open" : ""}><summary>${plain(L(q, lang))}${ic("down", "", 2)}</summary><div><p>${T(a, lang)}</p></div></details>`).join("")}</div>`;
}
function errorsBody(lang) {
  return `<div class="dc-card dc-fix dc-errors">${ERRORS.map(([m, mean, tr], i) => `<details${i === 0 ? " open" : ""}><summary>${plain(L(m, lang))}${ic("down", "", 2)}</summary><div><p><b>${L(UI.meaning, lang)}:</b> ${T(mean, lang)}</p><p><b>${L(UI.tryThis, lang)}:</b> ${T(tr, lang)}</p></div></details>`).join("")}</div>`;
}
function changelogBody(lang) {
  const plat = (pl) => pl.split(" ").map((x) => (x === "semua" ? L(UI.allDevices, lang) : PLATS[x])).join(", ");
  const status = (v, i) => (i === 0 ? L(UI.latest, lang) : v.st === "must" ? `<span class="dc-must">${L(UI.must, lang)}</span>` : v.st === "skip" ? L(UI.skip, lang) : "");
  const rows = VERSIONS.map((v, i) => {
    const groups = ["baru", "baik", "fix", "aman"].map((c) => { const it = v.items.filter((x) => x[0] === c); if (!it.length) return "";
      return `<div data-cgroup><h3 class="dc-cat${c === "aman" ? " sec" : ""}">${L(CATS[c], lang)}</h3><ul>${it.map((x) => `<li data-item data-plat="${x[1]}"><span>${T(x[2], lang)}</span><span class="dc-platx">${plat(x[1])}</span></li>`).join("")}</ul></div>`; }).join("");
    const foot = v.st === "skip" ? "" : `<p class="dc-verfoot"><a href="${lang === "en" ? "/en" : ""}/downloads/">${L(UI.dlLatest, lang)}</a><span aria-hidden="true">·</span><a href="${lang === "en" ? "/en" : ""}/source/">${L(UI.src, lang)}</a></p>`;
    const st = status(v, i);
    return `<details class="dc-ver" id="v${v.v.replace(/\./g, "-")}" data-ver${i === 0 ? " open" : ""}><summary><span class="dc-v">${v.v}</span><span class="dc-vd"><time datetime="${v.date}">${fmtDate(v.date, lang)}</time>${st ? ` · ${st}` : ""}</span><span class="dc-vs">${L(v.sum, lang)}</span>${ic("down", "dc-caret", 2)}</summary><div class="dc-ver-in">${groups}${foot}</div></details>`;
  }).join("\n");
  return `<div class="dc-plat"><span class="dc-seg-label" id="dc-pf">${L(UI.device, lang)}</span><div class="dc-seg" data-filter="plat" role="group" aria-labelledby="dc-pf"><button type="button" data-v="all" aria-pressed="true">${L(UI.all, lang)}</button>${PLAT_ALL.map((k) => `<button type="button" data-v="${k}" aria-pressed="false">${PLATS[k]}</button>`).join("")}</div><span class="dc-count" data-cl-count>${VERSIONS.length} ${L(UI.versions, lang)}</span></div>
<p class="dc-checkver">${L(UI.checkVer, lang)}</p>
<div class="dc-empty" data-cl-empty hidden><b>${L(UI.emptyT, lang)}</b><p>${L(UI.emptyP, lang)} <button type="button" class="dc-linkbtn" data-cl-reset>${L(UI.showAll, lang)}</button>.</p></div>
<div class="dc-card dc-vers">
${rows}
</div>`;
}

// the menu panel (also inside the phone sheet; idp keeps ids unique)
function rail(active, lang, idp) {
  const activeGroup = active ? bySlug[active].g : null;
  const href = (p) => (p.link ? (p.link.startsWith("mailto:") ? `href="${p.link}"` : `href="${lang === "en" ? "/en" + p.link : p.link}"`) : `href="${docUrl(p.slug, lang)}"`);
  return `<div class="dc-search">${ic("search", "", 2)}<label class="dc-sr" for="dc-q-${idp}">${L(UI.search, lang)}</label><input id="dc-q-${idp}" type="search" placeholder="${L(UI.search, lang)}" autocomplete="off" data-search-field="#dc-res-${idp}" data-hide-when-typing="#dc-list-${idp}"${idp === "s" ? " data-autofocus" : ""}></div>
<div class="dc-res" id="dc-res-${idp}" role="list" hidden></div>
<nav class="dc-list" id="dc-list-${idp}" aria-label="${L(UI.docs, lang)}">
<a href="${docUrl("", lang)}" class="dc-row${!active ? " on" : ""}"${!active ? ' aria-current="page"' : ""}>${ic("home")}<span><b>${L(UI.summary, lang)}</b><small>${L(UI.summarySub, lang)}</small></span></a>
${GROUPS.map((g) => { const open = g.id === activeGroup; return `<button type="button" class="dc-row" data-expand="#dc-g-${idp}-${g.id}" aria-expanded="${open}" aria-controls="dc-g-${idp}-${g.id}">${ic(g.ic)}<span><b>${L(g.t, lang)}</b><small>${L(g.d, lang)}</small></span>${ic("down", "dc-caret", 2)}</button>
<div class="dc-sub" id="dc-g-${idp}-${g.id}"${open ? "" : " hidden"}>${PAGES.filter((p) => p.g === g.id).map((p) => `<a ${href(p)}${p.slug === active ? ' class="on" aria-current="page"' : ""}>${L(p.t, lang)}</a>`).join("")}</div>`; }).join("\n")}
</nav>`;
}

function navBar(lang) {
  const D = (k) => DICT[lang][k];
  const a = (href, key, cur) => `<a href="${href}" data-i18n="${key}"${cur ? ' aria-current="page"' : ""}>${D(key)}</a>`;
  const pre = lang === "en" ? "/en" : "";
  const links = [a(`${pre}/#features`, "nav.features"), a(`${pre}/#specs`, "nav.tech"), a(`${pre}/docs/`, "nav.docs", true), a(`${pre}/donate/`, "nav.donate"), a(`${pre}/#faq`, "nav.faq")];
  const prefs = `<button type="button" class="lang-btn js-lang-toggle" aria-label="${escAttr(D("aria.lang"))}" data-i18n-attr="aria-label:aria.lang"><span class="lang-id">ID</span><span class="sep">/</span><span class="lang-en">EN</span></button>`;
  const theme = `<button type="button" class="theme-btn js-theme-toggle" aria-label="${escAttr(D("aria.theme"))}" data-i18n-attr="aria-label:aria.theme"><span class="icon-moon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></span><span class="icon-sun"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg></span></button>`;
  const dlIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
  return `<nav id="nav" class="nav" aria-label="${escAttr(D("aria.mainNav"))}" data-i18n-attr="aria-label:aria.mainNav">
    <a href="${pre}/" class="logo"><svg class="logo-svg" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#d92b25"/><g fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="7.5" y="8.5" width="17" height="11.5" rx="1.8"/><path d="M12.5 24h7M16 20v4"/></g></svg>TryDesk</a>
    <div class="nav-links">
      ${links.join("\n      ")}
    </div>
    <div class="nav-tools">
      ${prefs}
      ${theme}
      <a href="${pre}/downloads/" class="btn btn-pri btn-sm">${dlIcon}<span data-i18n="cta.download">${D("cta.download")}</span></a>
      <button type="button" id="nav-burger" class="burger" aria-label="${escAttr(D("aria.menu"))}" data-i18n-attr="aria-label:aria.menu"><span></span><span></span><span></span></button>
    </div>
  </nav>

  <div id="mobile-menu" class="hidden">
    ${links.join("\n    ")}
    <div class="mm-foot">
      <div class="mm-prefs">
        <span data-i18n="nav.prefs">${D("nav.prefs")}</span>
        <div>
          ${prefs}
          ${theme}
        </div>
      </div>
      <a href="${pre}/downloads/" class="mm-cta"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg><span data-i18n="cta.download">${D("cta.download")}</span></a>
    </div>
  </div>`;
}
function footer(lang) {
  const D = (k) => DICT[lang][k], pre = lang === "en" ? "/en" : "";
  return `<footer class="foot">
    <div class="wrap">
      <div class="foot-card">
        <div class="foot-top">
          <div class="foot-brand"><a href="${pre}/" class="logo"><svg class="logo-svg" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#d92b25"/><g fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="7.5" y="8.5" width="17" height="11.5" rx="1.8"/><path d="M12.5 24h7M16 20v4"/></g></svg>TryDesk</a><p data-i18n="foot.about">${D("foot.about")}</p></div>
          <nav class="foot-links" aria-label="${escAttr(D("foot.nav"))}" data-i18n-attr="aria-label:foot.nav"><div class="foot-col"><h4 data-i18n="foot.product">${D("foot.product")}</h4><a href="${pre}/downloads/" data-i18n="cta.download">${D("cta.download")}</a><a href="${pre}/docs/" data-i18n="nav.docs" aria-current="page">${D("nav.docs")}</a><a href="${pre}/#faq" data-i18n="nav.faq">${D("nav.faq")}</a></div><div class="foot-col"><h4 data-i18n="foot.project">${D("foot.project")}</h4><a href="${pre}/source/" data-i18n="nav.source">${D("nav.source")}</a><a href="${pre}/donate/" data-i18n="nav.donate">${D("nav.donate")}</a><a href="${pre}/sponsor/" data-i18n="nav.sponsor">${D("nav.sponsor")}</a></div><div class="foot-col"><h4 data-i18n="foot.legal">${D("foot.legal")}</h4><a href="${pre}/privacy/" data-i18n="foot.privacy">${D("foot.privacy")}</a><a href="${pre}/terms/" data-i18n="foot.terms">${D("foot.terms")}</a></div></nav>
        </div>
        <div class="foot-bottom"><p class="foot-line" data-i18n="foot.line">${D("foot.line")}</p><a href="mailto:support@trydesk.ai.id" class="foot-mail">support@trydesk.ai.id</a></div>
      </div>
    </div>
  </footer>`;
}

function head(p, lang, V, title, desc) {
  const page = p ? `docs/${p.slug}/` : "docs/";
  const url = `${ORIGIN}${lang === "en" ? "/en" : ""}/${page}`;
  const crumbs = [{ "@type": "ListItem", position: 1, name: "TryDesk", item: `${ORIGIN}${lang === "en" ? "/en" : ""}/` }, { "@type": "ListItem", position: 2, name: L(UI.docs, lang), item: `${ORIGIN}${lang === "en" ? "/en" : ""}/docs/` }];
  if (p) crumbs.push({ "@type": "ListItem", position: 3, name: L(p.t, lang), item: url });
  const ld = { "@context": "https://schema.org", "@graph": [
    { "@type": "TechArticle", headline: title, description: desc, url, inLanguage: lang, dateModified: DATE_ISO, author: { "@type": "Person", "@id": `${ORIGIN}/#drweabo`, name: "DrWeabo" }, about: { "@type": "SoftwareApplication", name: "TryDesk", softwareVersion: VERSION }, image: `${ORIGIN}/assets/img/og/docs-${lang}.png` },
    { "@type": "BreadcrumbList", itemListElement: crumbs }] };
  // every docs page shares the red Documentation picture (website/assets/img/og/docs-<lang>.png)
  const ogAlt = lang === "en" ? "The complete TryDesk guide: TryDesk on a red background with the app's Home screen" : "Panduan lengkap TryDesk: TryDesk di latar merah dengan Beranda aplikasinya";
  return `<!DOCTYPE html>
<html lang="${lang}" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="/assets/js/theme.js?v=${V}"></script>
  <title>${escAttr(title)}</title>
  <meta name="description" content="${escAttr(desc)}">
  <link rel="canonical" href="${url}">
  <link rel="alternate" hreflang="id" href="${ORIGIN}/${page}">
  <link rel="alternate" hreflang="en" href="${ORIGIN}/en/${page}">
  <link rel="alternate" hreflang="x-default" href="${ORIGIN}/en/${page}">
  <meta property="og:title" content="${escAttr(title)}">
  <meta property="og:description" content="${escAttr(desc)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${url}">
  <meta property="og:site_name" content="TryDesk">
  <meta property="og:locale" content="${lang === "en" ? "en_US" : "id_ID"}">
  <meta property="og:locale:alternate" content="${lang === "en" ? "id_ID" : "en_US"}">
  <meta property="og:image" content="${ORIGIN}/assets/img/og/docs-${lang}.png?v=${V}">
  <meta property="og:image:alt" content="${escAttr(ogAlt)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escAttr(title)}">
  <meta name="twitter:description" content="${escAttr(desc)}">
  <meta name="twitter:image" content="${ORIGIN}/assets/img/og/docs-${lang}.png?v=${V}">
  ${discordEmbed({ title, desc, url, image: `${ORIGIN}/assets/img/og/docs-${lang}.png?v=${V}`, alt: ogAlt, lang })}
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <meta name="theme-color" content="#0d0e11">
  <link rel="stylesheet" href="/assets/css/tailwind.css?v=${V}">
  <script type="application/ld+json">
  ${JSON.stringify(ld, null, 2).replace(/\n/g, "\n  ")}
  </script>
  <link rel="stylesheet" href="/assets/css/custom.css?v=${V}">
</head>`;
}

function shell(active, lang, V, mainHtml, label) {
  return `<body class="font-sans antialiased overflow-x-hidden">
  <a class="dc-skip" href="#main">${lang === "en" ? "Skip to content" : "Langsung ke isi"}</a>
  ${navBar(lang)}

  <!-- Documentation (owner pick 17 Nov 2026, "Arah C"): the app's Settings layout. Made by scripts/build-docs.mjs;
       edit that file (or the docs.* texts in i18n.js), not this page. -->
  <div class="page wrap dc-shell">
    <aside class="dc-rail">${rail(active, lang, "r")}</aside>
    <div class="dc-main">
      <button type="button" class="dc-mbtn" data-sheet-open="#dc-sheet" aria-controls="dc-sheet" aria-expanded="false">${ic("list", "", 2)}<span><small>${L(UI.docs, lang)}</small><b>${label}</b></span>${ic("down", "", 2)}</button>
      <main id="main" class="dc-body">
${mainHtml}
      </main>
    </div>
  </div>

  ${footer(lang)}

  <div class="dc-sheet" id="dc-sheet" data-navsheet hidden>
    <div class="dc-sheet-bg" data-close></div>
    <div class="dc-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="dc-sheet-t">
      <div class="dc-sheet-head"><h2 id="dc-sheet-t">${L(UI.docs, lang)}</h2><button type="button" class="dc-sheet-x" data-close aria-label="${L(UI.close, lang)}">${ic("x", "", 2)}</button></div>
      ${rail(active, lang, "s")}
    </div>
  </div>

  <script src="/assets/js/i18n.js?v=${V}"></script>
  <script src="/assets/js/nav.js?v=${V}"></script>
  <script src="/assets/js/docs-search.js?v=${V}"></script>
  <script src="/assets/js/docs.js?v=${V}"></script>
</body>
</html>
`;
}

function pageHtml(p, lang, V, date) {
  const group = GROUPS.find((g) => g.id === p.g);
  const idx = real.indexOf(p), prev = real[idx - 1], next = real[idx + 1];
  let body;
  if (p.ipGuide) body = ipGuide(lang, V);
  else if (p.errors) body = errorsBody(lang);
  else if (p.changelog) body = changelogBody(lang);
  else body = blocks(p.body, lang, V);
  const rel = (p.rel || []).map((s) => bySlug[s]);
  const main = `        <nav class="dc-crumbs" aria-label="${lang === "en" ? "You are here" : "Lokasi"}"><a href="${docUrl("", lang)}">${L(UI.docs, lang)}</a><span aria-hidden="true">/</span><span>${L(group.t, lang)}</span></nav>
        <header class="dc-head"><h1 class="dc-title">${h1Of(p, lang)}</h1><p class="dc-lede">${T(p.lede, lang)}</p>${p.changelog ? "" : `<p class="dc-meta">${L(UI.updated, lang)} <!--DOCS_DATE-->${date[lang]}<!--/DOCS_DATE--> · TryDesk <!--DOCS_VER-->${VERSION}<!--/DOCS_VER--></p>`}</header>
        ${p.plat ? platSwitch(p, lang) : ""}
        <div class="dc-content">
${body}
        </div>
        ${rel.length ? `<h2 class="dc-sec" id="terkait">${L(UI.related, lang)}</h2><div class="dc-card">${rel.map((r) => `<a class="dc-item" href="${docUrl(r.slug, lang)}"><span><b>${L(r.t, lang)}</b><small>${L(r.d, lang)}</small></span>${ic("chev", "", 2)}</a>`).join("")}</div>` : ""}
        <nav class="dc-pn" aria-label="${lang === "en" ? "Previous and next page" : "Halaman sebelum dan sesudah"}">${prev ? `<a href="${docUrl(prev.slug, lang)}"><small>${L(UI.prev, lang)}</small><b>${L(prev.t, lang)}</b></a>` : "<span></span>"}${next ? `<a href="${docUrl(next.slug, lang)}" class="next"><small>${L(UI.next, lang)}</small><b>${L(next.t, lang)}</b></a>` : ""}</nav>
        <p class="dc-edit">${T(UI.edit, lang)}</p>`;
  const title = lang === "en" ? `${plain(L(p.t, lang))} · TryDesk Docs` : `${plain(L(p.t, lang))} · Dokumentasi TryDesk`;
  return head(p, lang, V, title, plain(L(p.d, lang)) + " " + plain(T(p.lede, lang))) + "\n" + shell(p.slug, lang, V, main, L(p.t, lang));
}

function overviewHtml(lang, V, date) {
  const latest = VERSIONS[0];
  const hl = latest.items.slice(0, 3).map((x) => `<li>${ic("check", "", 2.2)}<span>${T(x[2], lang)}</span></li>`).join("");
  const href = (p) => (p.link ? (p.link.startsWith("mailto:") ? `href="${p.link}"` : `href="${lang === "en" ? "/en" + p.link : p.link}"`) : `href="${docUrl(p.slug, lang)}"`);
  const start = [["new-here", "x.p1h", "x.p1p", "book"], ["android", "x.p2h", "x.p2p", "phone"], ["troubleshooting", "x.p3h", "x.p3p", "help"]];
  const cards = GROUPS.map((g) => `<section class="dc-group" aria-labelledby="dc-h-${g.id}"><h2 id="dc-h-${g.id}" class="dc-group-h">${ic(g.ic)}${L(g.t, lang)}</h2><div class="dc-card">${PAGES.filter((p) => p.g === g.id).map((p) => `<a class="dc-item" ${href(p)}><span><b>${L(p.t, lang)}</b><small>${L(p.d, lang)}</small></span>${ic("chev", "", 2)}</a>`).join("")}</div></section>`).join("");
  const main = `        <header class="dc-head"><h1 class="dc-title" data-i18n-html="docs.h1">${L("docs.h1", lang)}</h1><p class="dc-lede" data-i18n="docs.sub">${L("docs.sub", lang)}</p><p class="dc-meta">${L(UI.updated, lang)} <!--DOCS_DATE-->${date[lang]}<!--/DOCS_DATE--> · TryDesk <!--DOCS_VER-->${VERSION}<!--/DOCS_VER--></p></header>
        <section class="dc-vercard" aria-labelledby="dc-ver-h">
          <div><h2 id="dc-ver-h">TryDesk ${latest.v}<span>${L(UI.latest, lang)}, ${fmtDate(latest.date, lang)}</span></h2><ul>${hl}</ul></div>
          <div class="dc-vercard-btns"><a class="btn" href="${docUrl("changelog", lang)}">${L(UI.seeAll, lang)}</a><a class="btn btn-pri" href="${lang === "en" ? "/en" : ""}/downloads/">${ic("dl", "", 2.4)}${L(UI.get, lang)} ${latest.v}</a></div>
        </section>
        <h2 class="dc-sec">${L(UI.startHere, lang)}</h2>
        <div class="dc-card dc-start">${start.map(([s, h, d, i]) => `<a class="dc-item" href="${docUrl(s, lang)}"><span class="dc-ic">${ic(i)}</span><span><b>${L(h, lang)}</b><small>${L(d, lang)}</small></span>${ic("chev", "", 2)}</a>`).join("")}</div>
        <h2 class="dc-sec">${L(UI.allGuides, lang)}</h2>
        <div class="dc-groups">${cards}</div>`;
  const title = L("title.docs", lang), desc = L("desc.docs", lang);
  return head(null, lang, V, plain(title), plain(desc)) + "\n" + shell(null, lang, V, main, L(UI.summary, lang));
}

function searchJs() {
  const list = (lang) => [{ t: L(UI.summary, lang), d: L(UI.summarySub, lang), k: "", g: L(UI.docs, lang), u: docUrl("", lang) }].concat(PAGES.map((p) => ({
    t: plain(L(p.t, lang)), d: plain(L(p.d, lang)), k: p.k || "", g: plain(L(GROUPS.find((g) => g.id === p.g).t, lang)),
    u: p.link ? (p.link.startsWith("mailto:") ? p.link : (lang === "en" ? "/en" : "") + p.link) : docUrl(p.slug, lang) })));
  const ui = (lang) => ({ none: L(UI.noResults, lang), other: L(UI.tryOther, lang) });
  return `// Made by scripts/build-docs.mjs: the docs pages for the menu's search field, in both languages.\nwindow.TD_DOCS = ${JSON.stringify({ id: list("id"), en: list("en"), ui: { id: ui("id"), en: ui("en") }, old: OLD_ANCHORS })};\n`;
}

// every docs.* text of the old one-page Documentation should have found a place (none silently dropped)
function coverage(oldHtml) {
  const keys = new Set([...oldHtml.matchAll(/data-i18n(?:-html)?="(docs\.[\w]+)"/g)].map((m) => m[1]));
  const skip = new Set(["docs.h1", "docs.sub", "docs.updated", "docs.toc", "docs.tocClose", "docs.tocTop", "docs.verH", "docs.verH3a", "docs.verL1", "docs.verL2", "docs.verP1", "docs.verH3b", "docs.verTh1", "docs.verTh2", "docs.verP2",
    "docs.newH", "docs.quickH", "docs.platH", "docs.instH", "docs.connH", "docs.accH", "docs.ccH", "docs.monH", "docs.tabH", "docs.fileH", "docs.chatH", "docs.recH", "docs.gameH", "docs.andH", "docs.secH", "docs.srvH", "docs.tbH",
    "docs.connH3", "docs.connLanH", "docs.connLanP", "docs.accH3", "docs.newH3d", "docs.connPwP1"]);
  return [...keys].filter((k) => !used.has(k) && !skip.has(k) && !/^docs\.(nav\w+|ver\d+)$/.test(k));
}

export function buildDocs({ check = false } = {}) {
  const home = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  const V = (home.match(/\?v=(\d{8}[a-z])/) || [])[1] || "1";
  const hubFile = path.join(SITE, "docs", "index.html");
  const oldHub = fs.existsSync(hubFile) ? fs.readFileSync(hubFile, "utf8") : "";
  const stamp = (oldHub.match(/<!--DOCS_DATE-->([^<]+)<!--\/DOCS_DATE-->/) || [])[1];
  const now = new Date(), iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  let dIso = iso;
  if (stamp) { const m = stamp.match(/^(\d{1,2}) (\w+) (\d{4})$/); const mi = m ? MONTH.id.indexOf(m[2]) : -1; if (mi >= 0) dIso = `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  const date = { id: fmtDate(dIso, "id"), en: fmtDate(dIso, "en") };
  DATE_ISO = dIso;
  const out = new Map();
  for (const lang of ["id", "en"]) {
    const base = lang === "en" ? path.join(SITE, "en", "docs") : path.join(SITE, "docs");
    out.set(path.join(base, "index.html"), overviewHtml(lang, V, date));
    for (const p of real) out.set(path.join(base, p.slug, "index.html"), pageHtml(p, lang, V, date));
  }
  out.set(path.join(SITE, "assets", "js", "docs-search.js"), searchJs());
  const uncovered = oldHub.includes("data-i18n=\"docs.newP1\"") ? coverage(oldHub) : [];
  const problems = [...missing].map((m) => "missing text: " + m).concat(uncovered.map((k) => "old docs text not placed: " + k));
  // a release without its changelog entry stops here (add it at the top of VERSIONS, both languages)
  if (VERSIONS[0].v !== VERSION) problems.push(`changelog: no entry for ${VERSION} at the top of VERSIONS in scripts/build-docs.mjs`);
  if (problems.length) { console.log(`DOCS  : FAIL\n  ${problems.join("\n  ")}`); if (check) process.exit(1); return { ok: false, problems }; }
  if (!check) for (const [f, html] of out) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, html, "utf8"); }
  console.log(`DOCS  : ${check ? "checked" : "wrote"} ${out.size - 1} pages (${real.length + 1} per language) + docs-search.js, date ${date.id}`);
  return { ok: true, pages: ["docs/", ...real.map((p) => `docs/${p.slug}/`)] };
}
export const DOCS_PAGES = ["docs/", ...real.map((p) => `docs/${p.slug}/`)];
// plain text of every docs page, for llms-full.txt
export function docsText(lang) {
  return real.map((p) => {
    let t = `#### ${plain(L(p.t, lang))}\n${plain(T(p.lede, lang))}\n`;
    if (p.body) t += plain(blocks(p.body, lang, "1").replace(/<\/(p|li|h2|tr|figcaption|summary)>/g, "\n")) + "\n";
    if (p.ipGuide) t += plain(ipGuide(lang, "1").replace(/<\/(p|li|h2|h3|tr|summary|span)>/g, " \n")) + "\n";
    if (p.errors) t += plain(errorsBody(lang).replace(/<\/(p|summary)>/g, "\n")) + "\n";
    if (p.changelog) t += VERSIONS.map((v) => `${v.v} (${fmtDate(v.date, lang)}): ${plain(L(v.sum, lang))} ${v.items.map((x) => plain(L(x[2], lang))).join(" ")}`).join("\n") + "\n";
    return t;
  }).join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildDocs({ check: process.argv.includes("--check") });
  if (!r.ok) process.exit(1);
}
