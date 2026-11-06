#!/usr/bin/env python3
"""Package a local macOS community build, with independently installed runtimes.

This is not an official, notarized, or portable distribution. Absolute third-party
dynamic libraries remain on the build machine. No official manifest is created.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import tempfile


def capture(arguments, cwd=None):
    result = subprocess.run([str(arg) for arg in arguments], cwd=cwd, check=False,
                            capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError("{} failed ({}): {}".format(
            Path(arguments[0]).name, result.returncode, result.stderr.strip()[-2000:]))
    return result.stdout.strip()


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def regular_file(path):
    path = Path(path).resolve(strict=True)
    if not path.is_file():
        raise ValueError("Expected a regular file: " + path.name)
    return path


def executable(argument, name):
    found = argument or shutil.which(name)
    if not found:
        raise ValueError("Missing {}; supply --{} with an installed executable".format(name, name))
    path = regular_file(found)
    if not os.access(path, os.X_OK):
        raise ValueError("Runtime is not executable: " + name)
    return path


def require_new_output(output):
    if output.suffix != ".app":
        raise ValueError("Output must end in .app")
    if output.exists() or output.is_symlink():
        raise ValueError("Refusing to overwrite an existing application: " + output.name)


def dependencies(binary):
    return list(dict.fromkeys(re.findall(
        r"^\s+(.+?)\s+\(compatibility version", capture(["/usr/bin/otool", "-L", binary]), re.M)))


def require_architecture(binary, architecture):
    if architecture not in capture(["/usr/bin/lipo", "-archs", binary]).split():
        raise ValueError("Runtime does not contain the host architecture: " + binary.name)


def require_absolute_dependencies(binary):
    for dependency in dependencies(binary):
        if not dependency.startswith("/"):
            raise ValueError("Unsupported relative dynamic dependency in {}: {}".format(binary.name, dependency))


def node_libraries(node):
    """Support Homebrew's varying libnode ABI without a recursive dylib bundler.

    The copied executable's relative reference is rewritten to @loader_path.
    All other dependencies must already use absolute host paths; launch probes
    check that this deliberately local dependency set is actually loadable.
    """
    found = {}
    for dependency in dependencies(node):
        if dependency.startswith("/"):
            continue
        name = dependency.rsplit("/", 1)[-1]
        if not dependency.startswith(("@rpath/", "@loader_path/", "@executable_path/")) or not re.fullmatch(r"libnode(?:\.\d+)*\.dylib", name):
            raise ValueError("Unsupported relative dynamic dependency in node: " + dependency)
        source = regular_file(node.parent.parent / "lib" / name)
        require_absolute_dependencies(source)
        if name in found and found[name][0] != source:
            raise ValueError("Conflicting libnode library: " + name)
        found[name] = (source, dependency)
    return found


def copy_file(source, target):
    source = regular_file(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def copy_tree(source, target):
    if source.is_symlink() or not source.is_dir():
        raise ValueError("Resource root must be a real directory: " + source.name)
    for path in source.rglob("*"):
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise ValueError("Resource symlinks and special files are not supported: " + path.name)
    shutil.copytree(source, target)


def copy_notices(binary, target):
    prefix = binary.parent.parent
    copied = []
    for directory in (prefix, prefix / "share/doc", prefix / "share/licenses"):
        if not directory.is_dir() or directory.is_symlink():
            continue
        entries = list(directory.iterdir())
        if directory != prefix:
            entries += [child for folder in entries if folder.is_dir() and not folder.is_symlink()
                        for child in folder.iterdir()]
        for source in entries:
            if source.is_file() and not source.is_symlink() and source.name.upper().startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE")):
                relative = source.relative_to(prefix)
                copy_file(source, target / relative)
                copied.append(relative.as_posix())
    return sorted(set(copied))


def source_record(source):
    # Never serialize absolute source paths (including custom Homebrew prefixes).
    return {"name": source.name, "sha256": sha256(source)}


def dependency_record(dependency):
    kind = "bundle-relative" if dependency.startswith("@") else "system" if dependency.startswith(("/usr/lib/", "/System/Library/")) else "external-host-library"
    return {"name": dependency.rsplit("/", 1)[-1], "kind": kind}


def inventory_names(text):
    return {match.group(1) for match in re.finditer(r"^\s*[.A-Z|]{2,8}\s+(\S+)\s+", text, re.M)}


def runtime_probes(runtime):
    node = json.loads(capture([runtime / "node", "-e",
        "require('node:sqlite'); console.log(JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch,sqlite:true}))"]))
    version = tuple(int(part) for part in node["version"].split(".")[:2])
    if version < (22, 13) or node["platform"] != "darwin":
        raise ValueError("Node 22.13+ for macOS with node:sqlite is required")
    encoders = inventory_names(capture([runtime / "ffmpeg", "-hide_banner", "-encoders"]))
    filters = inventory_names(capture([runtime / "ffmpeg", "-hide_banner", "-filters"]))
    if not {"libx264", "aac"} <= encoders or not {"ass", "subtitles", "drawtext"} <= filters:
        raise ValueError("FFmpeg needs libx264, aac, ass, subtitles and drawtext; select a full-featured build")
    versions = {}
    for name in ("ffmpeg", "ffprobe"):
        line = capture([runtime / name, "-version"]).splitlines()[0]
        match = re.match(name + r" version ([A-Za-z0-9._+~-]+)(?:\s|$)", line)
        if not match:
            raise ValueError("Cannot read runtime version: " + name)
        versions[name] = match.group(1)
    return {"node": node, **versions, "requiredEncodersAndFilters": True}


def publish_app(staged, output):
    # mkdir atomically reserves the destination: even a path appearing after
    # preflight is never replaced by rename(). Both directories share a volume.
    output.mkdir()
    try:
        (staged / "Contents").rename(output / "Contents")
    except BaseException:
        output.rmdir()
        raise


def package(args):
    if platform.system() != "Darwin":
        raise ValueError("Run this packager on the target macOS machine")
    repo = args.repo.resolve(strict=True)
    output = args.output.absolute()
    require_new_output(output)
    output = output.parent.resolve() / output.name
    resources_to_copy = {"public/fonts": "font-packs/editkin-open-fonts",
                         "public/color/aces2": "color/aces2", "plugins": "plugins"}
    for relative in resources_to_copy:
        root = (repo / relative).resolve(strict=True)
        if output == root or root in output.parents:
            raise ValueError("Output must be outside resource input directories")
    binary = regular_file(args.binary or repo / "src-tauri/target/release/editkin")
    if b"editkin.community-desktop-build/v1" not in binary.read_bytes():
        raise ValueError("Expected an explicit community-desktop build")
    sources = {name: executable(getattr(args, name), name) for name in ("node", "ffmpeg", "ffprobe")}
    libraries = node_libraries(sources["node"])
    architecture = platform.machine()
    macos_version = platform.mac_ver()[0]
    if not re.fullmatch(r"\d+(?:\.\d+){1,2}", macos_version):
        raise ValueError("Cannot determine the local macOS version")
    for path in [binary, *sources.values(), *(entry[0] for entry in libraries.values())]:
        require_architecture(path, architecture)
    for name in ("ffmpeg", "ffprobe"):
        require_absolute_dependencies(sources[name])
    # A source checkout alone has no static render faces. Preserve the existing
    # strict gate, including generated metrics, before accepting any font pack.
    capture([sources["node"], repo / "scripts/open-font-gate.mjs", repo / "public/fonts",
             "--generated-dir=" + str(repo / "src/generated"), "--self-test"], cwd=repo)
    package_json = json.loads((repo / "package.json").read_text(encoding="utf-8"))
    config = json.loads((repo / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    revision = capture(["/usr/bin/git", "rev-parse", "HEAD"], cwd=repo)
    if not re.fullmatch(r"[0-9a-f]{40,64}", revision):
        raise ValueError("Cannot determine source revision")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".editkin-community-", dir=output.parent) as temporary:
        app = Path(temporary) / output.name
        resources = app / "Contents/Resources"
        runtime = resources / "runtime"
        runtime.mkdir(parents=True)
        native = app / "Contents/MacOS/editkin"
        copy_file(binary, native)
        native.chmod(0o755)
        records = {}
        bundled_sources = {**sources, **{name: entry[0] for name, entry in libraries.items()}}
        for name, source in bundled_sources.items():
            copy_file(source, runtime / name)
            (runtime / name).chmod(0o755)
            records[name] = {"source": source_record(source),
                             "notices": copy_notices(source, resources / "licenses" / name)}
        for name, (_, dependency) in libraries.items():
            capture(["/usr/bin/install_name_tool", "-change", dependency,
                     "@loader_path/" + name, runtime / "node"])
        copy_file(repo / "desktop-dist/service.mjs", runtime / "service.mjs")
        for name in ("demo-source.mp4", "editkin-demo-preview.mp4"):
            copy_file(repo / "public" / name, runtime / name)
        for source, target in resources_to_copy.items():
            copy_tree(repo / source, resources / target)
        copy_file(repo / "src-tauri/icons/icon.icns", resources / "icon.icns")
        for name in ("LICENSE", "TRADEMARKS.md"):
            copy_file(repo / name, resources / "licenses/Editkin" / name)
        plist = {"CFBundleDevelopmentRegion": "zh_TW", "CFBundleDisplayName": "Editkin (Community)",
                 "CFBundleExecutable": "editkin", "CFBundleIconFile": "icon.icns",
                 "CFBundleIdentifier": config["identifier"], "CFBundleInfoDictionaryVersion": "6.0",
                 "CFBundleName": "Editkin", "CFBundlePackageType": "APPL",
                 "CFBundleShortVersionString": package_json["version"], "CFBundleVersion": package_json["version"],
                 # Third-party tools were verified on this host, not older OS releases.
                 "LSMinimumSystemVersion": macos_version, "NSHighResolutionCapable": True,
                 "NSPrincipalClass": "NSApplication", "LSApplicationCategoryType": "public.app-category.video",
                 "NSHumanReadableCopyright": "GPL-3.0-or-later. Local community build; not an official release."}
        with (app / "Contents/Info.plist").open("wb") as stream:
            plistlib.dump(plist, stream)
        capture(["/usr/bin/plutil", "-lint", app / "Contents/Info.plist"])
        # Only copied files are rewritten or signed. Libraries precede programs.
        for path in [*(runtime / name for name in libraries), *(runtime / name for name in sources), native]:
            capture(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", path])
        probes = runtime_probes(runtime)
        for name, record in records.items():
            record["bundledSha256"] = sha256(runtime / name)
            record["dependencies"] = [dependency_record(value) for value in dependencies(runtime / name)]
        metadata = {"schema": "editkin.local-macos-community-build/v1", "officialRelease": False,
                    "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "sourceRevision": revision, "version": package_json["version"], "architecture": architecture,
                    "nativeBuildInput": source_record(binary), "serviceSha256": sha256(runtime / "service.mjs"),
                    "runtimes": records, "runtimeLaunchProbes": probes,
                    "portability": "Local use only; absolute third-party shared libraries remain on this machine.",
                    "claimBoundary": "Community build, ad-hoc signed. No official release, updater, MCP setup, native GPU/audio, speech models or notarization attestation. UI/edit/export verification is separate."}
        (resources / "LOCAL-COMMUNITY-BUILD.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        capture(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", app])
        capture(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", app])
        publish_app(app, output)
    print(json.dumps({"app": output.name, "officialRelease": False, "adHocSignatureVerified": True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--binary", type=Path)
    for name in ("node", "ffmpeg", "ffprobe"):
        parser.add_argument("--" + name, type=Path, help="Installed executable; defaults to PATH")
    parser.add_argument("--output", type=Path, required=True, help="New .app destination; never overwritten")
    args = parser.parse_args()
    try:
        package(args)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        parser.exit(1, "Packaging failed: {}\n".format(error))


if __name__ == "__main__":
    main()
