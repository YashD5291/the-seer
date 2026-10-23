#!/bin/bash
# The Seer installer for macOS (Apple Silicon and Intel).
#
#   curl -fsSL https://github.com/__SEER_REPO__/releases/latest/download/install.sh | bash
#   curl -fsSL https://github.com/__SEER_REPO__/releases/latest/download/install.sh | bash -s -- --uninstall
#
# Installs the helper, the PDF builder, the resume template and the Chrome extension into ~/.theseer
# and registers the helper with Chrome. It never edits your settings file (~/.theseer/config.json) or
# your files and resumes (~/TheSeer), so running it again is safe and updates The Seer.
#
# Everything lives inside main() so that a download cut short runs nothing, and so that no command
# can swallow the rest of the script when it is piped into bash.
set -Eeuo pipefail

REPO='__SEER_REPO__'

HOST_NAME='com.theseer.resumegen'
FROM_TARBALL=''
UNINSTALL=0
WARM_UP=1
OPEN_CHROME=1

ARCH=''
TMP_DIR=''
TARBALL=''
UPDATING=0
SEER_DIR=''
HOST_MANIFEST=''

if [ -t 1 ] && [ -t 2 ]; then
  BOLD=$'\033[1m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=''; YELLOW=''; RED=''; RESET=''
fi

step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
warn() { printf '%swarning:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# A failure in a command substitution that is checked with if/|| must stay quiet, so those substitutions
# start with `trap - ERR` (the ERR trap is inherited by subshells).
on_unexpected_error() {
  local code="$1" line="$2" command="$3"
  printf '%serror:%s the install stopped on line %s (exit %s) while running: %s\n' "$RED" "$RESET" "$line" "$code" "$command" >&2
  printf 'Running the install command again is safe. If it keeps failing, open an issue with this output.\n' >&2
}

cleanup() {
  if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --from <file>   install from a downloaded the-seer-macos-<arch>.tar.gz instead of GitHub
  --no-warm-up    skip preparing the PDF builder now (it is prepared on first use instead)
  --no-open       do not copy the extension folder or open Chrome
  --uninstall     remove The Seer's helper and extension files (your files and resumes stay)
  -h, --help      show this help

Through curl, pass options with: ... | bash -s -- --no-warm-up
EOF
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --from)
        [ "$#" -ge 2 ] || die "--from needs the path of a the-seer-macos-<arch>.tar.gz file"
        FROM_TARBALL="$2"
        shift 2
        ;;
      --uninstall) UNINSTALL=1; shift ;;
      --no-warm-up) WARM_UP=0; shift ;;
      --no-open) OPEN_CHROME=0; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
  done
}

# The helper and the PDF builder are built for macOS 13 (Ventura) and later, which is newer than Chrome
# itself needs, so an older Mac is turned away before anything is downloaded or written.
require_supported_macos() {
  local version major
  version="$(trap - ERR; sw_vers -productVersion)" || die "Could not read the macOS version."
  major="${version%%.*}"
  case "$major" in
    '' | *[!0-9]*) die "Could not read the macOS version (sw_vers reported '$version')." ;;
  esac
  [ "$major" -ge 13 ] || die "The Seer needs macOS 13 (Ventura) or later; this Mac runs macOS $version. Update macOS, then run the install command again."
}

check_environment() {
  [ "$(uname -s)" = 'Darwin' ] || die "The Seer only runs on macOS (this computer reports $(uname -s))."
  if [ "$UNINSTALL" -eq 0 ]; then require_supported_macos; fi
  [ "$(id -u)" -ne 0 ] || die "Run this as your normal user, not with sudo or as root: The Seer installs into your home folder."
  case "${HOME:-}" in
    '' | /) die "Your HOME folder is not set, so there is nowhere to install." ;;
  esac
  [ -d "$HOME" ] || die "Your HOME folder ($HOME) does not exist."
  SEER_DIR="$HOME/.theseer"
  HOST_MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$HOST_NAME.json"
}

# True when this shell is an Intel program running on an Apple Silicon Mac through Rosetta.
running_under_rosetta() {
  [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = '1' ]
}

detect_arch() {
  local machine
  machine="$(uname -m)" || die "Could not tell which kind of Mac this is."
  case "$machine" in
    arm64) ARCH='arm64' ;;
    x86_64) ARCH='x64' ;;
    *) die "Unsupported processor: $machine (The Seer supports Apple Silicon and Intel Macs)." ;;
  esac
  if [ "$ARCH" = 'x64' ] && running_under_rosetta; then
    ARCH='arm64'
    step "Apple Silicon Mac (this Terminal runs under Rosetta; installing the native Apple Silicon build)"
  else
    step "macOS on $machine"
  fi
}

make_temp_dir() {
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/the-seer-install.XXXXXX")" || die "Could not create a temporary folder."
}

# ---- getting the tarball --------------------------------------------------------------------

require_release_repo() {
  local valid='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
  case "$REPO" in
    __*) die "This copy of install.sh has no release to download — use the command from the project's README" ;;
  esac
  [[ "$REPO" =~ $valid ]] || die "This copy of install.sh names an invalid GitHub repository: $REPO"
}

# fetch <url> <file> [show-progress]
fetch() {
  local url="$1" dest="$2" progress="${3:-}"
  local hint="Check your internet connection, and that https://github.com/$REPO/releases has a release."
  # HTTPS only, redirects included, and no TLS older than 1.2.
  local secure=(--proto '=https' --proto-redir '=https' --tlsv1.2)
  if [ -n "$progress" ] && [ -t 2 ]; then
    curl "${secure[@]}" -fL --retry 3 --connect-timeout 20 --progress-bar -o "$dest" "$url" || die "Could not download $url. $hint"
  else
    curl "${secure[@]}" -fsSL --retry 3 --connect-timeout 20 -o "$dest" "$url" || die "Could not download $url. $hint"
  fi
}

verify_checksum() {
  local dir="$1" name="$2" line result
  line="$(awk -v name="$name" '{ file = $2; sub(/^\*/, "", file); if (file == name) { print; exit } }' "$dir/SHA256SUMS")" \
    || die "Could not read the downloaded SHA256SUMS."
  [ -n "$line" ] || die "SHA256SUMS has no entry for $name, so the download cannot be checked."
  if ! result="$(trap - ERR; cd "$dir" && printf '%s\n' "$line" | shasum -a 256 -c 2>&1)"; then
    die "The downloaded $name does not match its checksum, so it was not installed. Try again. ($result)"
  fi
}

download_tarball() {
  local name="the-seer-macos-$ARCH.tar.gz"
  local base="https://github.com/$REPO/releases/latest/download"
  step "Downloading $name"
  fetch "$base/$name" "$TMP_DIR/$name" progress
  fetch "$base/SHA256SUMS" "$TMP_DIR/SHA256SUMS"
  verify_checksum "$TMP_DIR" "$name"
  step "Checked the download against its published checksum"
  TARBALL="$TMP_DIR/$name"
}

use_local_tarball() {
  [ -f "$FROM_TARBALL" ] || die "File not found: $FROM_TARBALL"
  step "Using $FROM_TARBALL (a local file: its checksum is not checked)"
  TARBALL="$FROM_TARBALL"
}

unpack_tarball() {
  local root="$TMP_DIR/unpacked/the-seer" file
  mkdir -p "$TMP_DIR/unpacked" || die "Could not create a temporary folder."
  tar -xzf "$TARBALL" -C "$TMP_DIR/unpacked" || die "Could not unpack $TARBALL — the file may be damaged or incomplete."
  for file in bin/theseer-pdf bin/tectonic templates/default.tex extension/manifest.json; do
    [ -f "$root/$file" ] || die "$TARBALL is not a The Seer release: it has no the-seer/$file"
  done
  step "Unpacked the release"
}

# ---- installing -----------------------------------------------------------------------------

# Copies to a new file and renames it into place. Overwriting a running or recently run executable in
# place can make macOS kill it on its next start; a rename gives the new copy a fresh identity.
install_file() {
  local source="$1" dest="$2" mode="$3"
  cp "$source" "$dest.new" || die "Could not write $dest.new (no space left, or no permission?)"
  chmod "$mode" "$dest.new" || die "Could not set permissions on $dest.new"
  mv -f "$dest.new" "$dest" || die "Could not replace $dest"
}

install_extension() {
  local source="$1" dest="$SEER_DIR/extension"
  rm -rf "$dest.new" || die "Could not clear $dest.new"
  cp -R "$source" "$dest.new" || die "Could not write $dest.new (no space left, or no permission?)"
  rm -rf "$dest" || die "Could not remove the old extension folder $dest"
  mv "$dest.new" "$dest" || die "Could not move the new extension into $dest"
}

install_files() {
  local root="$TMP_DIR/unpacked/the-seer"
  if [ -f "$SEER_DIR/extension/manifest.json" ]; then UPDATING=1; fi
  mkdir -p "$SEER_DIR/bin" "$SEER_DIR/templates" || die "Could not create $SEER_DIR"
  install_file "$root/bin/theseer-pdf" "$SEER_DIR/bin/theseer-pdf" 755
  install_file "$root/bin/tectonic" "$SEER_DIR/bin/tectonic" 755
  install_file "$root/templates/default.tex" "$SEER_DIR/templates/default.tex" 644
  install_extension "$root/extension"
  step "Installed the helper, PDF builder, template and extension into $SEER_DIR"
}

clear_quarantine() {
  local result
  if result="$(trap - ERR; xattr -dr com.apple.quarantine "$SEER_DIR/bin" "$SEER_DIR/templates" "$SEER_DIR/extension" 2>&1)"; then
    step "Cleared macOS download flags from the installed files"
  else
    warn "Could not clear macOS download flags ($result). If macOS blocks the helper, run: xattr -dr com.apple.quarantine ~/.theseer"
  fi
}

check_helper_starts() {
  local version errors="$TMP_DIR/helper-version.err"
  if ! version="$(trap - ERR; "$SEER_DIR/bin/theseer-pdf" --version 2>"$errors")"; then
    die "The helper was installed but does not start on this Mac: $(cat "$errors")"
  fi
  step "The helper starts (version $version)"
}

indent() {
  sed 's/^/    /'
}

run_helper_setup() {
  local helper="$SEER_DIR/bin/theseer-pdf"
  if [ "$WARM_UP" -eq 1 ]; then
    step "Setting up the helper — this also prepares the PDF builder, which takes a couple of minutes the first time"
    if ! "$helper" --setup </dev/null 2>&1 | indent; then die "The helper's setup failed (see the lines above)."; fi
  else
    step "Setting up the helper"
    if ! "$helper" --setup --no-warm-up </dev/null 2>&1 | indent; then die "The helper's setup failed (see the lines above)."; fi
  fi
}

# ---- Chrome ---------------------------------------------------------------------------------

check_chrome_installed() {
  if [ -d '/Applications/Google Chrome.app' ] || [ -d "$HOME/Applications/Google Chrome.app" ]; then
    step "Found Google Chrome"
  else
    warn "Google Chrome is not in /Applications or ~/Applications. The Seer is a Chrome extension: install Chrome from https://www.google.com/chrome/ first."
  fi
}

open_chrome_extensions_page() {
  if printf '%s' "$SEER_DIR/extension" | pbcopy; then
    step "Copied the extension folder path to your clipboard"
  else
    warn "Could not copy the extension folder path to your clipboard; it is printed below."
  fi
  if open -a 'Google Chrome' 'chrome://extensions' </dev/null; then
    step "Opened Chrome's extensions page"
  else
    warn "Could not open Chrome. Open Chrome and go to chrome://extensions by hand."
  fi
}

print_chrome_steps() {
  printf '\n%sLast step: add the extension to Chrome%s\n' "$BOLD" "$RESET"
  if [ "$UPDATING" -eq 1 ]; then
    printf '  Already added? Open chrome://extensions and click the reload arrow on The Seer card. That is all.\n'
    printf '  First time? Follow these steps:\n'
  fi
  printf '  1. In Chrome, open chrome://extensions and turn on "Developer mode" (top right).\n'
  printf '  2. Click "Load unpacked".\n'
  printf '  3. In the file dialog press Cmd+Shift+G, paste this folder (Cmd+V) and press Return, then click "Select":\n'
  printf '       %s\n' "$SEER_DIR/extension"
  printf "  4. The Seer's setup page opens by itself. Follow it to finish.\n\n"
}

install() {
  detect_arch
  make_temp_dir
  if [ -n "$FROM_TARBALL" ]; then
    use_local_tarball
  else
    require_release_repo
    download_tarball
  fi
  unpack_tarball
  install_files
  clear_quarantine
  check_helper_starts
  run_helper_setup
  check_chrome_installed
  if [ "$OPEN_CHROME" -eq 1 ]; then open_chrome_extensions_page; fi
  print_chrome_steps
  printf 'The Seer is installed. Your files and resumes were left alone.\n'
}

# ---- uninstalling ---------------------------------------------------------------------------

uninstall() {
  if [ -e "$HOST_MANIFEST" ]; then
    rm -f "$HOST_MANIFEST" || die "Could not remove $HOST_MANIFEST"
    step "Removed the helper's registration with Chrome"
  else
    step "The helper was not registered with Chrome (nothing to remove)"
  fi
  if [ -e "$SEER_DIR" ]; then
    rm -rf "$SEER_DIR" || die "Could not remove $SEER_DIR"
    step "Removed $SEER_DIR (the helper, PDF builder, template, extension and settings file)"
  else
    step "$SEER_DIR was not there (nothing to remove)"
  fi
  if [ -d "$HOME/TheSeer" ]; then
    step "Kept $HOME/TheSeer — your files and resumes are still there; delete that folder yourself if you want them gone"
  fi
  printf '\n%sOne manual step%s: open chrome://extensions in Chrome, find the "The Seer" card and click "Remove".\n' "$BOLD" "$RESET"
}

main() {
  trap 'on_unexpected_error "$?" "$LINENO" "$BASH_COMMAND"' ERR
  trap cleanup EXIT
  parse_args "$@"
  check_environment
  printf '%sThe Seer installer%s\n' "$BOLD" "$RESET"
  if [ "$UNINSTALL" -eq 1 ]; then uninstall; else install; fi
}

main "$@"
