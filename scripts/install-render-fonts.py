"""Install the derived EditkinFace render faces into public/fonts/render/.

The render faces are generated build products (gitignored) that the physical
glyph and caption paths read with exact SHA-256 checks. This script derives the
missing faces offline from the five pinned OFL sources with
scripts/build-static-font-pack.py and installs a face only when its bytes match
the size and SHA-256 pinned in public/fonts/editkin-open-fonts.json. It never
replaces an existing file. It needs the fontTools version recorded in
public/fonts/static-face-provenance.json (scripts/render-fonts-requirements.txt).

Run `npm run source:scan` before this script: the scanner reviews only the
committed binaries, and these generated faces are not part of that review.
"""
import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
FONTS = ROOT / "public" / "fonts"


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def installed(path: pathlib.Path, face: dict) -> bool:
    return path.is_file() and not path.is_symlink() and path.stat().st_size == face["bytes"] and digest(path) == face["sha256"]


def main() -> int:
    parser = argparse.ArgumentParser(description="Install the pinned EditkinFace render faces.")
    parser.add_argument("--check", action="store_true", help="only report whether every pinned face is installed")
    parser.add_argument("--workers", type=int, default=max(1, min(4, os.cpu_count() or 1)))
    args = parser.parse_args()

    manifest = json.loads((FONTS / "editkin-open-fonts.json").read_text(encoding="utf-8"))
    faces = [face for font in manifest["fonts"] for face in font["faces"]]
    missing = [face for face in faces if not installed(FONTS / face["file"], face)]
    present_but_different = [face["file"] for face in missing if (FONTS / face["file"]).exists()]
    if present_but_different:
        print(json.dumps({"status": "BLOCK", "reason": "existing render faces differ from their pins; remove them and rerun",
                          "files": present_but_different}))
        return 1
    if not missing or args.check:
        print(json.dumps({"status": "GREEN" if not missing else "MISSING", "faces": len(faces), "missing": [face["id"] for face in missing]}))
        return 0 if not missing else 1

    import fontTools
    expected_version = json.loads((FONTS / "static-face-provenance.json").read_text(encoding="utf-8"))["fontToolsVersion"]
    if fontTools.version != expected_version:
        print(json.dumps({"status": "BLOCK", "reason": f"fontTools {expected_version} is required, found {fontTools.version}"}))
        return 1

    with tempfile.TemporaryDirectory(prefix="editkin-render-faces-") as work:
        stage = pathlib.Path(work) / "stage"
        subprocess.run([sys.executable, str(ROOT / "scripts" / "build-static-font-pack.py"), "--source", str(FONTS),
                        "--stage", str(stage), "--workers", str(args.workers)], check=True, stdout=subprocess.DEVNULL)
        mismatched = [face["id"] for face in missing if not installed(stage / face["file"], face)]
        if mismatched:
            print(json.dumps({"status": "BLOCK", "reason": "derived faces do not reproduce their pinned SHA-256", "faces": mismatched}))
            return 1
        (FONTS / "render").mkdir(exist_ok=True)
        for face in missing:
            target = FONTS / face["file"]
            partial = target.with_name(target.name + ".partial")
            partial.write_bytes((stage / face["file"]).read_bytes())
            if target.exists():
                partial.unlink()
                raise SystemExit(f"{face['file']} appeared during installation; not replacing it")
            os.replace(partial, target)

    still_missing = [face["id"] for face in faces if not installed(FONTS / face["file"], face)]
    print(json.dumps({"status": "GREEN" if not still_missing else "BLOCK", "faces": len(faces), "installed": len(missing), "missing": still_missing}))
    return 0 if not still_missing else 1


if __name__ == "__main__":
    sys.exit(main())
