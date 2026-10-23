#!/usr/bin/env bash
# Builds one macOS release tarball:
#
#   scripts/build-release.sh <arm64|x64> <out-dir>
#
# Writes <out-dir>/the-seer-macos-<arch>.tar.gz containing
#   the-seer/bin/theseer-pdf        the helper (compiled with Bun)
#   the-seer/bin/tectonic           the PDF builder (pinned release)
#   the-seer/templates/default.tex  the resume template
#   the-seer/extension/             the built Chrome extension
#
# Needs: bun, node, pnpm (with `pnpm install` already run at the repo root), curl, tar, shasum.
# Set SEER_REPO (owner/repo) to bake the install command into the extension's setup page.
set -euo pipefail

# The newest stable Tectonic release that ships both macOS assets, with the SHA-256 of each archive.
TECTONIC_VERSION='0.17.0'
TECTONIC_SHA256_ARM64='a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667'
TECTONIC_SHA256_X64='7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/the-seer-release"
STAGE=''

log() { printf '==> %s\n' "$*"; }
die() { printf 'build-release: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ -n "$STAGE" ]; then rm -rf "$STAGE"; fi
}

usage() {
  die "usage: scripts/build-release.sh <arm64|x64> <out-dir>"
}

require_tools() {
  local tool
  for tool in bun node pnpm curl tar shasum; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed — it is needed to build a release"
  done
  [ -d "$ROOT/node_modules" ] || die "run 'pnpm install' at the repo root first"
}

sha256_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}

# Downloads the pinned Tectonic archive for $1 (aarch64|x86_64) into the cache, checking its SHA-256
# against $2, and prints the archive path.
fetch_tectonic() {
  local cpu="$1" expected="$2"
  local name="tectonic-$TECTONIC_VERSION-$cpu-apple-darwin.tar.gz"
  local archive="$CACHE_DIR/$name"
  local url="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40$TECTONIC_VERSION/$name"

  mkdir -p "$CACHE_DIR"
  if [ -f "$archive" ] && [ "$(sha256_of "$archive")" = "$expected" ]; then
    printf '%s\n' "$archive"
    return
  fi
  curl -fsSL --retry 3 -o "$archive.part" "$url" || die "could not download $url"
  local actual
  actual="$(sha256_of "$archive.part")"
  if [ "$actual" != "$expected" ]; then
    rm -f "$archive.part"
    die "$name has SHA-256 $actual, expected $expected"
  fi
  mv "$archive.part" "$archive"
  printf '%s\n' "$archive"
}

build_extension() {
  if [ -z "${SEER_REPO:-}" ]; then
    printf 'build-release: SEER_REPO is not set — the setup page will show OWNER/REPO in its install command\n' >&2
  fi
  pnpm --dir "$ROOT/apps/extension" build
  node "$ROOT/apps/extension/scripts/stage.mjs" "$STAGE/the-seer/extension"
}

build_helper() {
  local bun_target="$1"
  bun build --compile "--target=$bun_target" "$ROOT/apps/resume-gen/main.ts" \
    --outfile "$STAGE/the-seer/bin/theseer-pdf"
}

add_tectonic() {
  local archive="$1"
  tar -xzf "$archive" -C "$STAGE/the-seer/bin" tectonic || die "$archive does not contain a tectonic binary"
}

pack() {
  local out_dir="$1" tarball="$2"
  chmod 755 "$STAGE/the-seer/bin/theseer-pdf" "$STAGE/the-seer/bin/tectonic"
  # No AppleDouble files, extended attributes (such as quarantine flags) or builder user names in the tarball.
  COPYFILE_DISABLE=1 tar --no-xattrs --uid 0 --gid 0 --uname root --gname wheel \
    -czf "$out_dir/$tarball" -C "$STAGE" the-seer
}

main() {
  [ "$#" -eq 2 ] || usage
  local arch="$1" out_dir="$2" bun_target cpu tectonic_sha tectonic_archive
  case "$arch" in
    arm64) bun_target='bun-darwin-arm64'; cpu='aarch64'; tectonic_sha="$TECTONIC_SHA256_ARM64" ;;
    x64) bun_target='bun-darwin-x64'; cpu='x86_64'; tectonic_sha="$TECTONIC_SHA256_X64" ;;
    *) usage ;;
  esac
  local tarball="the-seer-macos-$arch.tar.gz"

  require_tools
  mkdir -p "$out_dir"
  out_dir="$(cd "$out_dir" && pwd)"
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/the-seer-release.XXXXXX")"
  trap cleanup EXIT
  mkdir -p "$STAGE/the-seer/bin" "$STAGE/the-seer/templates"

  log "Building the extension"
  build_extension
  log "Compiling the helper for macOS $arch"
  build_helper "$bun_target"
  log "Adding the PDF builder (Tectonic $TECTONIC_VERSION)"
  tectonic_archive="$(fetch_tectonic "$cpu" "$tectonic_sha")"
  add_tectonic "$tectonic_archive"
  cp "$ROOT/apps/resume-gen/GEN/GEN-V3.tex" "$STAGE/the-seer/templates/default.tex"
  log "Packing $tarball"
  pack "$out_dir" "$tarball"

  log "Done: $out_dir/$tarball ($(du -h "$out_dir/$tarball" | awk '{print $1}'), sha256 $(sha256_of "$out_dir/$tarball"))"
}

main "$@"
