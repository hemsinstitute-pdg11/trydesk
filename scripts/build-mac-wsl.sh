#!/bin/bash
# Builds the macOS zips (Apple Silicon + Intel) inside WSL Ubuntu, so a release needs no Mac. buat-rilis.ps1 runs it
# with the project folder as seen from WSL (/mnt/c/...); the zips land in <project>/dist-mac/.
# electron-builder cannot sign on Linux, and Electron's own binaries carry only the linker's signature with no seal
# over the bundle: macOS calls such a download "damaged". So scripts/after-pack.js signs the app ad-hoc with rcodesign
# (open source, https://github.com/indygreg/apple-platform-rs), installed here at a pinned version and checksum.
# Without an Apple Developer ID macOS still asks once (Privacy & Security → Open Anyway, or `xattr -cr` in Terminal).
# The zips are checked with scripts/check-mac-zip.mjs before they leave; an unsealed zip stops the build.
# On a real Mac, scripts/build-mac.sh builds the same zips and electron-builder signs them itself.
set -euo pipefail
SRC="${1:?usage: build-mac-wsl.sh /mnt/c/path/to/project}"
NODE_VER="v22.23.4"
NODE_DIR="$HOME/.local/node"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "-- Node $NODE_VER (nodejs.org) -> $NODE_DIR"
  mkdir -p "$NODE_DIR"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.gz" | tar -xz -C "$NODE_DIR" --strip-components=1
fi
export PATH="$NODE_DIR/bin:$PATH"

RCS_VER="0.29.0"
RCS_SHA="dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002"   # from the release's SHA256SUMS
RCS_DIR="$HOME/.local/rcodesign-$RCS_VER"
if [ ! -x "$RCS_DIR/rcodesign" ]; then
  echo "-- rcodesign $RCS_VER (GitHub indygreg/apple-platform-rs) -> $RCS_DIR"
  T="$(mktemp -d)"
  F="apple-codesign-$RCS_VER-x86_64-unknown-linux-musl.tar.gz"
  curl -fsSL -o "$T/$F" "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/$RCS_VER/$F"
  echo "$RCS_SHA  $T/$F" | sha256sum -c - || { echo "rcodesign checksum mismatch, stopping" >&2; rm -rf "$T"; exit 1; }
  mkdir -p "$RCS_DIR"
  tar -xzf "$T/$F" -C "$RCS_DIR" --strip-components=1
  rm -rf "$T"
fi
export TRYDESK_RCODESIGN="$RCS_DIR/rcodesign"
"$TRYDESK_RCODESIGN" --version

B="$HOME/trydesk-build-mac"
rm -rf "$B/src" "$B/assets" "$B/scripts" "$B/dist"
mkdir -p "$B/scripts"
cp -r "$SRC/src" "$SRC/assets" "$B/"
rm -rf "$B/src/native"   # the Windows-only fast capture helper (Mac builds only view)
cp "$SRC/scripts/after-pack.js" "$SRC/scripts/check-mac-zip.mjs" "$B/scripts/"
cp "$SRC/package.json" "$SRC/package-lock.json" "$SRC/LICENSE" "$SRC/NOTICE" "$SRC/TRADEMARK.md" "$B/"
cd "$B"
npm ci --no-audit --no-fund --loglevel=error
npx electron-builder --mac zip --arm64 --x64 --publish never
node scripts/check-mac-zip.mjs dist/*-mac-arm64.zip dist/*-mac-x64.zip

OUT="${TRYDESK_MAC_OUT:-$SRC/dist-mac}"
rm -rf "$OUT"; mkdir -p "$OUT"
cp dist/*-mac-arm64.zip dist/*-mac-x64.zip "$OUT/"
echo "-- macOS zips:"
(cd "$OUT" && ls -la && sha256sum *)
# The build copy is ~900 MB and npm ci reinstalls it anyway next time; Electron's download cache (~/.cache) stays.
cd "$HOME" && rm -rf "$B"
