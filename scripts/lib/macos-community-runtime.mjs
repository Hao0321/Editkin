// Pure helpers and pins for the unsigned community macOS (Apple Silicon) runtime.
// The owner's official stager is scripts/stage-platform-runtime.mjs; nothing here
// replaces its gates. Everything in this module runs on any host so it can be
// unit-tested; only scripts/stage-macos-community-runtime.mjs executes macOS tools.
import { createHash } from "node:crypto";
import { posix } from "node:path";

// Mach-O install names and bundle paths are POSIX paths on every host (the unit
// test also runs on Windows), so path handling here is always POSIX.
const { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } = posix;

// Same pins as scripts/stage-platform-runtime.mjs (asserted by the unit test).
export const COMMUNITY_NODE = Object.freeze({
  version: "22.23.2",
  archive: "node-v22.23.2-darwin-arm64.tar.gz",
  url: "https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-arm64.tar.gz",
  sha256: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
});

export const COMMUNITY_WHISPER_CPP = Object.freeze({
  version: "1.9.2",
  tag: "v1.9.2",
  commit: "306c88f4d1286aec1bf96e544632897886af5501",
  sourceUrl: "https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/306c88f4d1286aec1bf96e544632897886af5501",
  archiveBytes: 9_627_120,
  archiveSha256: "f3585ebf64df3e41b26c45d93bdb38b423ca1de0bf40cc4b6d320254867a75df",
  license: "MIT",
});

// The detached signature of this exact tarball was verified against the FFmpeg
// release signing key (fingerprint below) when the pin was recorded. The build
// accepts only these bytes, from either URL.
export const COMMUNITY_FFMPEG = Object.freeze({
  version: "8.1.2",
  archive: "ffmpeg-8.1.2.tar.xz",
  urls: Object.freeze([
    "https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz",
    "http://archive.ubuntu.com/ubuntu/pool/universe/f/ffmpeg/ffmpeg_8.1.2.orig.tar.xz",
  ]),
  bytes: 11_710_924,
  sha256: "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c",
  signingKeyFingerprint: "FCF986EA15E6E293A5644F10B4322F04D67658D8",
  license: "GPL-2.0-or-later",
});

// Pure-Python wheel for scripts/build-static-font-pack.py. Export requires the
// static render faces that src/render/fontRoot.ts verifies; they are generated
// from public/fonts because the published font pack omits them.
export const COMMUNITY_FONTTOOLS = Object.freeze({
  version: "4.60.2",
  wheel: "fonttools-4.60.2-py3-none-any.whl",
  url: "https://files.pythonhosted.org/packages/79/6c/10280af05b44fafd1dff69422805061fa1af29270bc52dce031ac69540bf/fonttools-4.60.2-py3-none-any.whl",
  bytes: 1_144_610,
  sha256: "73cf92eeda67cf6ff10c8af56fc8f4f07c1647d989a979be9e388a49be26552a",
  minimumPython: Object.freeze([3, 9]),
});

// Homebrew formulae whose bottles provide the external FFmpeg libraries. The
// bundled closure is discovered from the linked binaries, not from this list.
export const COMMUNITY_FFMPEG_HOMEBREW_FORMULAE = Object.freeze(["x264", "x265", "zimg", "libass", "dav1d"]);

export const COMMUNITY_DEPLOYMENT_TARGET = "12.0";

// Autodetection is off so a library that happens to be installed on the build
// host can never enter the closure unnoticed; every external input is explicit.
export const COMMUNITY_FFMPEG_CONFIGURE_ARGS = Object.freeze([
  "--prefix=/opt/editkin-community-ffmpeg",
  "--cc=clang",
  "--arch=arm64",
  "--enable-gpl",
  "--disable-autodetect",
  "--enable-pthreads",
  "--enable-zlib",
  "--enable-bzlib",
  "--enable-iconv",
  "--enable-videotoolbox",
  "--enable-audiotoolbox",
  "--enable-libx264",
  "--enable-libx265",
  "--enable-libzimg",
  "--enable-libass",
  "--enable-libdav1d",
  "--disable-ffplay",
  "--disable-doc",
  "--disable-debug",
  "--enable-static",
  "--disable-shared",
  `--extra-cflags=-mmacosx-version-min=${COMMUNITY_DEPLOYMENT_TARGET}`,
  `--extra-ldflags=-mmacosx-version-min=${COMMUNITY_DEPLOYMENT_TARGET} -Wl,-headerpad_max_install_names`,
]);

// FFmpeg config.h symbols that must be enabled before spending time on make.
export const REQUIRED_FFMPEG_CONFIG_SYMBOLS = Object.freeze([
  "CONFIG_GPL", "CONFIG_ZLIB", "CONFIG_BZLIB", "CONFIG_ICONV", "CONFIG_VIDEOTOOLBOX", "CONFIG_AUDIOTOOLBOX",
  "CONFIG_LIBX264", "CONFIG_LIBX265", "CONFIG_LIBZIMG", "CONFIG_LIBASS", "CONFIG_LIBDAV1D",
  "CONFIG_LIBX264_ENCODER", "CONFIG_LIBX265_ENCODER", "CONFIG_H264_VIDEOTOOLBOX_ENCODER", "CONFIG_HEVC_VIDEOTOOLBOX_ENCODER",
  "CONFIG_PRORES_KS_ENCODER", "CONFIG_ZSCALE_FILTER", "CONFIG_SUBTITLES_FILTER", "CONFIG_ASS_FILTER",
  "CONFIG_TONEMAP_FILTER", "CONFIG_COLORSPACE_FILTER", "CONFIG_LOUDNORM_FILTER", "CONFIG_SIDECHAINCOMPRESS_FILTER",
  "CONFIG_LAVFI_INDEV", "CONFIG_FFMPEG", "CONFIG_FFPROBE",
]);

// Every encoder, decoder, filter and format Editkin's render/analysis code names.
export const REQUIRED_FFMPEG_ENCODERS = Object.freeze([
  "libx264", "libx265", "h264_videotoolbox", "hevc_videotoolbox", "prores_ks", "aac", "ffv1", "mjpeg", "png",
  "rawvideo", "pcm_s16le", "pcm_f32le",
]);
export const REQUIRED_FFMPEG_DECODERS = Object.freeze([
  "h264", "hevc", "prores", "libdav1d", "vp9", "aac", "mp3", "opus", "flac", "pcm_s16le", "png", "mjpeg", "webp",
  "exr", "ffv1", "ass",
]);
export const REQUIRED_FFMPEG_FILTERS = Object.freeze([
  "zscale", "tonemap", "colorspace", "subtitles", "ass", "loudnorm", "sidechaincompress", "lut3d", "geq",
  "perspective", "overlay", "amix", "afade", "atrim", "aresample", "aformat", "scale", "format", "eq", "hue",
  "gblur", "unsharp", "vignette", "curves", "colorbalance", "blend", "premultiply", "unpremultiply", "rotate", "pad",
  "crop", "fps", "select", "scdet", "silencedetect", "hqdn3d", "tpad", "concat", "split", "asplit", "volume",
  "setpts", "asetpts", "trim", "signalstats", "anullsrc", "color", "nullsrc",
]);
export const REQUIRED_FFMPEG_DEVICES = Object.freeze(["lavfi"]);
export const REQUIRED_FFMPEG_MUXERS = Object.freeze([
  "mp4", "mov", "null", "framemd5", "image2", "image2pipe", "f32le", "rawvideo", "wav",
]);
export const REQUIRED_FFMPEG_DEMUXERS = Object.freeze([
  "mov", "matroska", "mp3", "wav", "flac", "aac", "image2", "ass", "lavfi",
]);
export const REQUIRED_FFMPEG_CONFIGURATION_FLAGS = Object.freeze([
  "--enable-gpl", "--enable-libx264", "--enable-libx265", "--enable-libzimg", "--enable-libass", "--enable-libdav1d",
  "--enable-videotoolbox", "--enable-audiotoolbox",
]);

// The owner's closed-world PLATFORM-MANIFEST file set (scripts/macos-bundle-runtime-gate.mjs).
export const PLATFORM_RUNTIME_FILES = Object.freeze([
  "node", "NODE-LICENSE.txt", "ffmpeg", "ffprobe", "FFMPEG-LICENSE.txt", "FFPROBE-LICENSE.txt",
  "hao-core", "editkin-gpu-compositor", "whisper-cli", "WHISPER-LICENSE.txt",
  "WHISPER-PROVENANCE.json", "WHISPER-CAPABILITY.json",
]);
export const RUNTIME_EXECUTABLES = Object.freeze(["node", "ffmpeg", "ffprobe", "hao-core", "editkin-gpu-compositor", "whisper-cli"]);
// Staged under .platform-runtime/font-pack and bundled as font-packs/editkin-open-fonts.
export const COMMUNITY_FONT_PACK_DIRECTORY = "font-pack";
// Added to Contents/Resources/runtime by the Tauri overlay, not by the stager.
export const APP_RUNTIME_ENTRYPOINTS = Object.freeze([
  "service.mjs", "mcp.mjs", "mcp.mjs.material-color-identity.json", "remote.mjs", "demo-source.mp4",
  "editkin-demo-preview.mp4", "PLATFORM-MANIFEST.json",
]);

const REQUIRED_WHISPER_FLAGS = ["--language", "--output-srt", "--translate"];

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function whisperCliHasRequiredCapabilities(helpText) {
  return REQUIRED_WHISPER_FLAGS.every((flag) => helpText.includes(flag));
}

export function requiredWhisperFlags() {
  return [...REQUIRED_WHISPER_FLAGS];
}

const MACH_O_MAGICS = new Set(["feedfacf", "cffaedfe", "feedface", "cefaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);

/** True when the first four bytes are a thin or universal Mach-O magic. */
export function isMachO(header) {
  if (!header || header.length < 4) return false;
  return MACH_O_MAGICS.has(Buffer.from(header.subarray(0, 4)).toString("hex"));
}

/** `lipo -archs` output, e.g. "arm64" or "x86_64 arm64". */
export function parseLipoArchitectures(text) {
  return String(text).trim().split(/\s+/u).filter(Boolean).sort();
}

const DEPENDENCY_COMMANDS = new Set(["LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_REEXPORT_DYLIB", "LC_LOAD_UPWARD_DYLIB", "LC_LAZY_LOAD_DYLIB"]);

/**
 * Parses `otool -l` output for one thin Mach-O: its install name, dependent
 * libraries, LC_RPATH entries and the highest macOS minimum it declares.
 */
export function parseMachOLoadCommands(text) {
  const result = { id: undefined, dependencies: [], rpaths: [], minimumMacOS: undefined };
  let command;
  let platform;
  const minimums = [];
  for (const line of String(text).split(/\r?\n/u)) {
    const commandMatch = /^\s*cmd (LC_[A-Z0-9_]+)\s*$/u.exec(line);
    if (commandMatch) {
      command = commandMatch[1];
      platform = undefined;
      continue;
    }
    const nameMatch = /^\s*name (.+) \(offset \d+\)\s*$/u.exec(line);
    if (nameMatch && command === "LC_ID_DYLIB") {
      result.id = nameMatch[1];
      continue;
    }
    if (nameMatch && DEPENDENCY_COMMANDS.has(command)) {
      result.dependencies.push(nameMatch[1]);
      continue;
    }
    const pathMatch = /^\s*path (.+) \(offset \d+\)\s*$/u.exec(line);
    if (pathMatch && command === "LC_RPATH") {
      result.rpaths.push(pathMatch[1]);
      continue;
    }
    if (command === "LC_BUILD_VERSION") {
      const platformMatch = /^\s*platform (\S+)\s*$/u.exec(line);
      if (platformMatch) platform = platformMatch[1];
      const minimumMatch = /^\s*minos (\d+(?:\.\d+){0,2})\s*$/u.exec(line);
      if (minimumMatch && (platform === "1" || platform === "MACOS" || platform === undefined)) minimums.push(minimumMatch[1]);
      continue;
    }
    if (command === "LC_VERSION_MIN_MACOSX") {
      const versionMatch = /^\s*version (\d+(?:\.\d+){0,2})\s*$/u.exec(line);
      if (versionMatch) minimums.push(versionMatch[1]);
    }
  }
  result.minimumMacOS = maxMacOSVersion(minimums);
  return result;
}

export function compareMacOSVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function maxMacOSVersion(versions) {
  return versions.filter(Boolean).reduce((highest, version) => (
    highest === undefined || compareMacOSVersions(version, highest) > 0 ? version : highest
  ), undefined);
}

export function isSystemInstallName(name) {
  return name.startsWith("/usr/lib/") || name.startsWith("/System/Library/");
}

const FORBIDDEN_PREFIXES = ["/opt/homebrew", "/usr/local", "/Users/", "/private/", "/var/folders/", "/tmp/", "/Volumes/"];

/** Load-command strings that would make a bundled binary depend on its build host. */
export function forbiddenReferenceReasons(name, buildRoots = []) {
  const reasons = [];
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (name === prefix || name.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)) reasons.push(`host path ${prefix}`);
  }
  for (const root of buildRoots.filter(Boolean)) {
    if (name.startsWith(root)) reasons.push(`build directory ${root}`);
  }
  if (name.startsWith("@rpath/")) reasons.push("unresolved @rpath");
  if (name.startsWith("@executable_path/")) reasons.push("@executable_path depends on the launching executable");
  return reasons;
}

/**
 * Audits one bundled Mach-O after relocation. Every dependency must be an OS
 * library or an @loader_path file that exists inside `bundleRoot`; no LC_RPATH
 * may name a host or build path; a dylib install name must be @loader_path.
 * `exists(path)` answers for normalized absolute paths.
 */
export function auditBundledMachO({ file, bundleRoot, loadCommands, exists, buildRoots = [] }) {
  const findings = [];
  const directory = dirname(file);
  for (const dependency of loadCommands.dependencies) {
    if (isSystemInstallName(dependency)) continue;
    if (dependency.startsWith("@loader_path/")) {
      const target = normalize(join(directory, dependency.slice("@loader_path/".length)));
      if (!isInside(bundleRoot, target)) findings.push(`${dependency}: escapes ${bundleRoot}`);
      else if (!exists(target)) findings.push(`${dependency}: missing bundled file`);
      continue;
    }
    const reasons = forbiddenReferenceReasons(dependency, buildRoots);
    findings.push(`${dependency}: ${reasons.length ? reasons.join(", ") : "not an OS library or @loader_path reference"}`);
  }
  // A relative LC_RPATH without @rpath dependencies is inert; a host path is not.
  for (const rpath of loadCommands.rpaths) {
    const reasons = isAbsolute(rpath) && !isSystemInstallName(`${rpath.replace(/\/+$/u, "")}/`)
      ? ["absolute host path", ...forbiddenReferenceReasons(rpath, buildRoots)]
      : forbiddenReferenceReasons(rpath, buildRoots).filter((reason) => !reason.startsWith("@executable_path"));
    if (reasons.length) findings.push(`LC_RPATH ${rpath}: ${reasons.join(", ")}`);
  }
  if (loadCommands.id !== undefined && !loadCommands.id.startsWith("@loader_path/")) {
    findings.push(`LC_ID_DYLIB ${loadCommands.id}: not relocatable`);
  }
  return findings;
}

/**
 * FFmpeg filter-option escaping for a path, identical to escapeFilterPath in
 * src/render/captionAss.ts (asserted by the unit test).
 */
export function escapeFilterOptionPath(path) {
  const option = path.replaceAll("\\", "/").replace(/[\\':\s]/g, "\\$&");
  return option.replace(/[\\'\[\],;\s]/g, "\\$&");
}

export function isInside(root, candidate) {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function expandLoaderPath(value, { loaderDirectory, executableDirectory }) {
  if (value.startsWith("@loader_path/")) return join(loaderDirectory, value.slice("@loader_path/".length));
  if (value === "@loader_path") return loaderDirectory;
  if (value.startsWith("@executable_path/")) return join(executableDirectory, value.slice("@executable_path/".length));
  if (value === "@executable_path") return executableDirectory;
  return value;
}

/** Candidate files dyld would try for one dependency of one image. */
export function dependencyCandidates(dependency, { loaderDirectory, executableDirectory, rpaths }) {
  if (dependency.startsWith("@rpath/")) {
    const leaf = dependency.slice("@rpath/".length);
    return rpaths.map((rpath) => normalize(join(rpath, leaf)));
  }
  return [normalize(expandLoaderPath(dependency, { loaderDirectory, executableDirectory }))];
}

/**
 * Plans a flat closure: every non-OS dylib reachable from `roots` is copied to
 * lib/<install-name leaf>; roots refer to @loader_path/lib/<leaf>, libraries to
 * @loader_path/<leaf>, and all LC_RPATH entries are removed. `inspect(realPath)`
 * returns parseMachOLoadCommands(...) for a file; `realpath(path)` returns the
 * canonical path or undefined when it does not exist. Pure apart from those two.
 */
export async function planLoaderPathClosure({ roots, inspect, realpath }) {
  const inspections = new Map();
  const load = async (path) => {
    if (!inspections.has(path)) inspections.set(path, await inspect(path));
    return inspections.get(path);
  };
  const libraries = new Map();
  const names = new Map();
  const edits = [];
  const queue = [];
  for (const root of roots) {
    const real = await realpath(root);
    if (!real) throw new Error(`Closure root does not exist: ${root}`);
    queue.push({ real, role: "root", executableDirectory: dirname(real), inheritedRpaths: [] });
  }
  const visited = new Set();
  while (queue.length) {
    const item = queue.shift();
    if (visited.has(item.real)) continue;
    visited.add(item.real);
    const commands = await load(item.real);
    const ownRpaths = commands.rpaths.map((rpath) => normalize(expandLoaderPath(rpath, {
      loaderDirectory: dirname(item.real), executableDirectory: item.executableDirectory,
    })));
    const searchRpaths = [...ownRpaths, ...item.inheritedRpaths];
    const changes = [];
    for (const dependency of commands.dependencies) {
      if (isSystemInstallName(dependency)) continue;
      const candidates = dependencyCandidates(dependency, {
        loaderDirectory: dirname(item.real), executableDirectory: item.executableDirectory, rpaths: searchRpaths,
      });
      let resolved;
      for (const candidate of candidates) {
        resolved = await realpath(candidate);
        if (resolved) break;
      }
      // An OS library reached through @rpath would need its LC_RPATH kept; this
      // flat relocation removes every LC_RPATH, so refuse instead of guessing.
      if (!resolved) throw new Error(`Cannot resolve ${dependency} referenced by ${item.real} (candidates: ${candidates.join(", ") || "none"})`);
      if (isSystemInstallName(resolved)) throw new Error(`${dependency} referenced by ${item.real} resolves to the OS library ${resolved} through a relocatable install name`);
      let library = libraries.get(resolved);
      if (!library) {
        const dependencyCommands = await load(resolved);
        const name = basename(dependencyCommands.id ?? resolved);
        const owner = names.get(name);
        if (owner && owner !== resolved) throw new Error(`Two different libraries share the bundled name ${name}: ${owner} and ${resolved}`);
        names.set(name, resolved);
        library = { name, source: resolved, installNames: new Set() };
        libraries.set(resolved, library);
        queue.push({ real: resolved, role: "library", executableDirectory: item.executableDirectory, inheritedRpaths: searchRpaths });
      }
      library.installNames.add(dependency);
      const replacement = item.role === "root" ? `@loader_path/lib/${library.name}` : `@loader_path/${library.name}`;
      if (dependency !== replacement) changes.push([dependency, replacement]);
    }
    const library = libraries.get(item.real);
    edits.push({
      source: item.real,
      role: item.role,
      name: library?.name,
      id: item.role === "library" ? `@loader_path/${library.name}` : undefined,
      changes,
      deleteRpaths: [...commands.rpaths],
    });
  }
  return {
    libraries: [...libraries.values()]
      .map((library) => ({ ...library, installNames: [...library.installNames].sort() }))
      .sort((left, right) => left.name.localeCompare(right.name, "en")),
    edits,
  };
}

/** `install_name_tool` arguments for one planned edit (target appended by the caller). */
export function installNameToolArguments(edit) {
  const args = [];
  if (edit.id) args.push("-id", edit.id);
  for (const [from, to] of edit.changes) args.push("-change", from, to);
  for (const rpath of edit.deleteRpaths) args.push("-delete_rpath", rpath);
  return args;
}

function entriesAfterSeparator(text) {
  const lines = String(text).split(/\r?\n/u);
  const separator = lines.findIndex((line) => /^\s*-{2,}\s*$/u.test(line));
  return separator < 0 ? [] : lines.slice(separator + 1).filter((line) => line.trim());
}

/** `ffmpeg -encoders` / `-decoders`: " V....D libx264  ..." after " ------". */
export function parseCodecList(text) {
  const names = new Set();
  for (const line of entriesAfterSeparator(text)) {
    const match = /^\s*[VASDT?.][.A-Z]{5,7}\s+(\S+)/u.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

/**
 * `ffmpeg -filters`: " TS zscale  V->V  ..." (8.x, after "  ------") or
 * " ..C zscale  V->V  ..." (6.x, no separator). The I/O column identifies entries.
 */
export function parseFilterList(text) {
  const names = new Set();
  for (const line of String(text).split(/\r?\n/u)) {
    const tokens = line.trim().split(/\s+/u);
    if (tokens.length >= 3 && /^[.TSC]{2,3}$/u.test(tokens[0]) && /^[AVN|]+->[AVN|]+$/u.test(tokens[2])) names.add(tokens[1]);
  }
  return names;
}

/**
 * `ffmpeg -devices`/`-muxers`/`-demuxers` after the dashed separator. Flags are
 * " D", "DE", " E" plus an optional device "d" column (8.x); names may be
 * comma-separated aliases ("mov,mp4,m4a"). No format name consists only of D/E/d.
 */
export function parseFormatList(text) {
  const names = new Set();
  for (const line of entriesAfterSeparator(text)) {
    const tokens = line.trim().split(/\s+/u);
    let index = 0;
    while (index < tokens.length - 1 && /^[DEd.]{1,3}$/u.test(tokens[index])) index += 1;
    if (index === 0 || !tokens[index]) continue;
    for (const name of tokens[index].split(",")) if (name) names.add(name);
  }
  return names;
}

export function missingNames(required, available) {
  return required.filter((name) => !available.has(name));
}

export function ffmpegVersionLine(text) {
  return String(text).split(/\r?\n/u)[0]?.trim() ?? "";
}

export function ffmpegConfigurationLine(text) {
  const line = String(text).split(/\r?\n/u).find((candidate) => candidate.trim().startsWith("configuration:"));
  return line ? line.trim().slice("configuration:".length).trim() : "";
}

/** Symbols that FFmpeg's generated config.h defines to 1. */
export function enabledConfigSymbols(configHeader) {
  const enabled = new Set();
  for (const match of String(configHeader).matchAll(/^#define (CONFIG_[A-Z0-9_]+) 1\s*$/gmu)) enabled.add(match[1]);
  return enabled;
}

/** Homebrew keg identity from a resolved library path. */
export function homebrewKegFromPath(path) {
  const match = /^(.*)\/Cellar\/([^/]+)\/([^/]+)\//u.exec(path);
  if (!match) return undefined;
  return { prefix: match[1], formula: match[2], version: match[3], kegRoot: `${match[1]}/Cellar/${match[2]}/${match[3]}` };
}

export function isHomebrewLicenseFile(name) {
  return /^(?:COPYING|LICEN[CS]E|NOTICE|COPYRIGHT|AUTHORS)(?:[._-].*)?$/iu.test(name);
}

/** Paths printed by DYLD_PRINT_LIBRARIES ("dyld[123]: <UUID> /path" or "dyld[123]: /path"). */
export function parseDyldPrintedLibraries(text) {
  const paths = [];
  for (const line of String(text).split(/\r?\n/u)) {
    const match = /^dyld\[\d+\]:\s+(?:<[^>]*>\s+)?(\/.*\S)\s*$/u.exec(line.trim());
    if (match) paths.push(match[1]);
  }
  return paths;
}

export function disallowedLoadedImages(paths, allowedRoots) {
  const allowed = [...allowedRoots, "/usr/lib/", "/System/", "/Library/Apple/"];
  return paths.filter((path) => !allowed.some((root) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)));
}

/**
 * The checks src/render/fontRoot.ts applies to a schema 2 pack, done for every
 * face: each listed render/ face must exist with the recorded size and SHA-256.
 * `files` maps pack-relative paths to { bytes, sha256 }.
 */
export function fontPackFindings(manifest, files) {
  const findings = [];
  if (manifest?.schemaVersion !== 2 || !Array.isArray(manifest.fonts) || !manifest.fonts.length) return ["font manifest is not schema 2"];
  for (const font of manifest.fonts) {
    const source = files[font.file];
    if (!source || source.sha256 !== font.sha256 || source.bytes !== font.bytes) findings.push(`${font.file}: variable source missing or changed`);
    if (!Array.isArray(font.faces) || !font.faces.length) findings.push(`${font.id}: no static faces`);
    for (const face of font.faces ?? []) {
      if (face.file !== `render/EditkinFace-${font.id}-${face.weight}.ttf`) findings.push(`${face.file}: unexpected face path`);
      const actual = files[face.file];
      if (!actual) findings.push(`${face.file}: missing`);
      else if (actual.bytes !== face.bytes || actual.sha256 !== face.sha256) findings.push(`${face.file}: size or SHA-256 differs from the manifest`);
    }
  }
  const provenance = manifest.staticFaceProvenance;
  if (!provenance || files[provenance.file]?.sha256 !== provenance.sha256) findings.push("static-face-provenance.json missing or changed");
  return findings;
}

/** Raises LSMinimumSystemVersion only when a bundled binary requires a newer macOS. */
export function effectiveMinimumMacOS(declared, measured) {
  return measured && compareMacOSVersions(measured, declared) > 0 ? measured : declared;
}
