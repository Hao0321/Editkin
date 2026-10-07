#!/bin/bash
# Build a local community app without changing the source checkout or an installed app.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: bash scripts/install-macos-community.sh [--check] [--output /path/App.app]

Builds this Git checkout into a local, ad-hoc-signed macOS community app.
Default output: $HOME/Applications/Editkin Community.app
--check   Check prerequisites only; no downloads or writes.
--output  Choose a new .app path. Existing destinations are never replaced.

Prerequisites: Xcode Command Line Tools, Node >=22.13 (with npm), Rust >=1.92,
Python >=3.9 with venv, and FFmpeg/ffprobe with libx264, AAC, libass and drawtext.
Homebrew example: brew install node@22 rust ffmpeg-full python@3.12
This does not install Homebrew, change macOS security settings, or launch the app.
HELP
}
editkin_check=0
editkin_output="${HOME:?}/Applications/Editkin Community.app"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) editkin_check=1; shift ;;
    --output) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; editkin_output="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = Darwin ] || { echo 'This installer requires macOS.' >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo 'Run as your normal user, without sudo.' >&2; exit 1; }
editkin_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$editkin_root"

# Finder-launched .command files may not inherit the user's shell PATH.
editkin_brew="$(command -v brew || true)"
if [ -z "$editkin_brew" ]; then
  for editkin_candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$editkin_candidate" ]; then editkin_brew="$editkin_candidate"; break; fi
  done
fi
if [ -n "$editkin_brew" ]; then
  editkin_prefix="$("$editkin_brew" --prefix)"
  export PATH="$editkin_prefix/opt/node@22/bin:$editkin_prefix/opt/ffmpeg-full/bin:$editkin_prefix/opt/python@3.12/libexec/bin:$editkin_prefix/bin:$PATH"
fi
if [ -d "$HOME/.cargo/bin" ]; then export PATH="$PATH:$HOME/.cargo/bin"; fi
for editkin_tool in git node npm cargo rustc python3 ffmpeg ffprobe xcrun codesign; do
  command -v "$editkin_tool" >/dev/null || { printf 'Missing %s. See --help for prerequisites.\n' "$editkin_tool" >&2; exit 1; }
done
xcrun --find clang >/dev/null
node --input-type=module -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13))throw Error("Node >=22.13 required");await import("node:sqlite")'
python3 -c 'import sys,venv; assert sys.version_info >= (3,9), "Python >=3.9 required"'
python3 -c 'import subprocess; v=subprocess.check_output(["rustc","--version"],text=True).split()[1].split("."); assert tuple(map(int,v[:2])) >= (1,92), "Rust >=1.92 required"'
editkin_ffmpeg="$(command -v ffmpeg)"
editkin_ffprobe="$(command -v ffprobe)"
editkin_node="$(command -v node)"
for editkin_encoder in libx264 aac; do
  "$editkin_ffmpeg" -hide_banner -encoders 2>/dev/null | awk -v item="$editkin_encoder" '$2 == item {found=1} END {exit !found}' || {
    printf 'FFmpeg is missing encoder %s. Install ffmpeg-full.\n' "$editkin_encoder" >&2; exit 1;
  }
done
for editkin_filter in ass subtitles drawtext; do
  "$editkin_ffmpeg" -hide_banner -filters 2>/dev/null | awk -v item="$editkin_filter" '$2 == item {found=1} END {exit !found}' || {
    printf 'FFmpeg is missing filter %s. Install ffmpeg-full.\n' "$editkin_filter" >&2; exit 1;
  }
done
"$editkin_ffprobe" -version >/dev/null
# Resolve before entering the isolated build, including paths containing spaces.
editkin_output="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$editkin_output")"
case "$editkin_output" in *.app) ;; *) echo '--output must end in .app' >&2; exit 2 ;; esac
[ ! -e "$editkin_output" ] && [ ! -L "$editkin_output" ] || { echo 'Destination exists; choose a new --output path. Nothing was replaced.' >&2; exit 1; }
[ "$(git rev-parse --show-toplevel)" = "$editkin_root" ] || { echo 'Run from an Editkin Git checkout.' >&2; exit 1; }
printf 'Prerequisites OK (%s). Local community build; not an official release.\n' "$(uname -m)"
[ "$editkin_check" -eq 0 ] || exit 0

mkdir -p .rd
editkin_work="$(mktemp -d "$editkin_root/.rd/macos-community.XXXXXX")"
# Copy only Git-tracked working-tree files, never ignored media, caches or secrets.
# Builds and generated fonts remain in .rd; the original source stays unchanged.
python3 - "$editkin_root" "$editkin_work/source" <<'PY'
import pathlib, shutil, subprocess, sys
root, target = map(pathlib.Path, sys.argv[1:])
target.mkdir()
for raw in subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).split(b'\0'):
    if not raw: continue
    rel = pathlib.Path(raw.decode('utf8'))
    if rel.is_absolute() or '..' in rel.parts: raise ValueError('Unsafe tracked path')
    source = root / rel
    if any(p.is_symlink() for p in (source, *source.parents)):
        raise ValueError('Symlink in tracked source: ' + str(rel))
    if not source.is_file(): raise ValueError('Missing tracked source: ' + str(rel))
    dest = target / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, dest)
PY
cd "$editkin_work/source"
printf 'Building in %s\n' "$editkin_work"
npm ci --no-audit --no-fund
python3 -m venv "$editkin_work/venv"
"$editkin_work/venv/bin/python" -m pip install --disable-pip-version-check --only-binary=:all: 'fonttools==4.60.2'
"$editkin_work/venv/bin/python" scripts/build-static-font-pack.py --source public/fonts --stage "$editkin_work/fonts" --workers 2
# Only the disposable source copy receives generated manifests and faces.
python3 - "$editkin_work/fonts" public/fonts <<'PY'
import pathlib, shutil, sys
source, target = map(pathlib.Path, sys.argv[1:])
shutil.rmtree(target)
shutil.copytree(source, target)
PY
node scripts/open-font-gate.mjs public/fonts --generated-dir=src/generated --refresh-generated --self-test
npm run build
node scripts/build-desktop.mjs --community
# objc2 can catch WebKit URL-scheme cancellation exceptions only with unwinding.
# Keep this scoped to this macOS community build, not other release profiles.
export CARGO_PROFILE_RELEASE_PANIC=unwind
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
export CARGO_TARGET_DIR="$editkin_root/.rd/macos-community-target"
export TAURI_CONFIG='{"bundle":{"resources":[]}}'
cargo build --release --locked --manifest-path src-tauri/Cargo.toml --features community-desktop,tauri/custom-protocol
python3 scripts/package-macos-community.py --repo "$editkin_work/source" \
  --binary "$CARGO_TARGET_DIR/release/editkin" --node "$editkin_node" \
  --ffmpeg "$editkin_ffmpeg" --ffprobe "$editkin_ffprobe" --output "$editkin_output"
printf '\nInstalled: %s\nOpen it in Finder when ready. Keep Homebrew dependencies installed.\n' "$editkin_output"
printf 'Build files (removable after verification): %s\n' "$editkin_work"
