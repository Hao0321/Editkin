// Stages the unsigned community macOS (Apple Silicon) runtime into .platform-runtime/
// for `tauri build --config src-tauri/tauri.macos.community.conf.json`.
//
// This is not the owner's official stager (scripts/stage-platform-runtime.mjs),
// which uses a prebuilt FFmpeg dependency absent from this repository. Here FFmpeg
// is built from its pinned, signature-checked source against Homebrew bottles,
// and every non-OS dylib it needs is copied into runtime/lib and rewritten to
// @loader_path. Node.js and whisper.cpp use the same pins as the owner's stager.
// Every Mach-O except the upstream-signed Node.js binary is ad-hoc re-signed.
// The GPU compositor is not staged; see COMMUNITY_OMITTED_RUNTIME_FILES.
//
// Prerequisites (GitHub macos-15 runner): Xcode command-line tools, cmake,
// `brew install pkgconf x264 x265 zimg libass dav1d`, and a release build of
// native/hao-core.
import { spawn } from "node:child_process";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { basename, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_RUNTIME_ENTRYPOINTS,
  auditBundledMachO,
  COMMUNITY_DEPLOYMENT_TARGET,
  COMMUNITY_FFMPEG,
  COMMUNITY_FFMPEG_CONFIGURE_ARGS,
  COMMUNITY_FFMPEG_HOMEBREW_FORMULAE,
  COMMUNITY_FONT_PACK_DIRECTORY,
  COMMUNITY_FONTTOOLS,
  COMMUNITY_NODE,
  COMMUNITY_OMITTED_RUNTIME_FILES,
  COMMUNITY_WHISPER_CPP,
  disallowedLoadedImages,
  enabledConfigSymbols,
  escapeFilterOptionPath,
  ffmpegConfigurationLine,
  ffmpegVersionLine,
  fontPackFindings,
  homebrewKegFromPath,
  installNameToolArguments,
  isHomebrewLicenseFile,
  isMachO,
  maxMacOSVersion,
  missingNames,
  parseCodecList,
  parseDyldPrintedLibraries,
  parseFilterList,
  parseFormatList,
  parseLipoArchitectures,
  parseMachOLoadCommands,
  planLoaderPathClosure,
  PLATFORM_RUNTIME_FILES,
  REQUIRED_FFMPEG_CONFIG_SYMBOLS,
  REQUIRED_FFMPEG_CONFIGURATION_FLAGS,
  REQUIRED_FFMPEG_DECODERS,
  REQUIRED_FFMPEG_DEMUXERS,
  REQUIRED_FFMPEG_DEVICES,
  REQUIRED_FFMPEG_ENCODERS,
  REQUIRED_FFMPEG_FILTERS,
  REQUIRED_FFMPEG_MUXERS,
  requiredWhisperFlags,
  RUNTIME_EXECUTABLES,
  sha256Hex,
  whisperCliHasRequiredCapabilities,
} from "./lib/macos-community-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, ".platform-runtime");
const MINUTE = 60_000;

function log(message) {
  process.stderr.write(`[macos-community-runtime] ${message}\n`);
}

function cleanEnvironment(extra = {}) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DYLD_")));
  return { ...environment, ...extra };
}

function run(executable, args, { cwd, env, input, timeoutMs = 20 * MINUTE, label = basename(executable) } = {}) {
  log(`run ${label}: ${executable} ${args.join(" ")}`);
  return new Promise((resolveRun, rejectRun) => {
    // Build logs go to stderr; stdout carries only the final JSON summary.
    const child = spawn(executable, args, { cwd, env: env ?? cleanEnvironment(), stdio: [input ? "pipe" : "ignore", 2, 2] });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectRun(error); else resolveRun();
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error(`${label} timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.on("error", finish);
    child.on("exit", (code, signal) => finish(code === 0 ? undefined : new Error(`${label} failed: exit ${code ?? signal}`)));
    if (input) {
      child.stdin.on("error", finish);
      child.stdin.end(input);
    }
  });
}

/** Unpacks a downloaded archive that fetchPinned already verified, from memory; no archive file is written. */
function extractVerifiedArchive(body, destination, label) {
  return run("/usr/bin/tar", ["-x", "-f", "-", "-C", destination], { input: body, label: `extract ${label}` });
}

function capture(executable, args, { cwd, env, timeoutMs = 2 * MINUTE, allowFailure = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { cwd, env: env ?? cleanEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectRun(error); else resolveRun({ code, stdout, stderr });
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error(`${basename(executable)} timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-8_000_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000_000); });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (code === 0 || allowFailure) finish(undefined, code ?? signal);
      else finish(new Error(`${basename(executable)} ${args.join(" ")} failed (exit ${code ?? signal}): ${stderr.trim().slice(-3_000)}`));
    });
  });
}

async function hashFile(path) {
  return sha256Hex(await readFile(path));
}

async function fileRecord(path) {
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: sha256Hex(bytes) };
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function realpathOrUndefined(path) {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/** Downloads one pinned artifact. Transport failures try the next URL; wrong bytes fail closed. */
export async function fetchPinned(urls, { bytes, sha256, label }) {
  const failures = [];
  for (const url of urls) {
    let body;
    try {
      log(`download ${label}: ${url}`);
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15 * MINUTE) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (bytes && declared > 0 && declared !== bytes) throw new Error(`Content-Length ${declared} != pinned ${bytes}`);
      body = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const actual = sha256Hex(body);
    if ((bytes && body.length !== bytes) || actual !== sha256) {
      throw new Error(`${label} identity mismatch from ${url}: ${body.length} bytes / ${actual} (expected ${bytes ?? "any"} bytes / ${sha256})`);
    }
    return { body, url };
  }
  throw new Error(`${label} download failed: ${failures.join("; ")}`);
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Staged runtime must not contain symlinks: ${relativePath}`);
    if (entry.isDirectory()) files.push(...await listFiles(join(directory, entry.name), relativePath));
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error(`Staged runtime contains a special file: ${relativePath}`);
  }
  return files;
}

async function isMachOFile(path) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    return isMachO(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function loadCommands(path) {
  return parseMachOLoadCommands((await capture("/usr/bin/otool", ["-l", path])).stdout);
}

async function architectures(path) {
  return parseLipoArchitectures((await capture("/usr/bin/lipo", ["-archs", path])).stdout);
}

async function tail(path, lines) {
  try {
    return (await readFile(path, "utf8")).split(/\r?\n/u).slice(-lines).join("\n");
  } catch (error) {
    return `(could not read ${path}: ${error instanceof Error ? error.message : String(error)})`;
  }
}

async function brewJson(formulae) {
  const { stdout } = await capture("brew", ["info", "--json=v2", ...formulae]);
  const parsed = JSON.parse(stdout);
  return new Map((parsed.formulae ?? []).map((formula) => [formula.name, formula]));
}

async function stageNode(work, candidate) {
  const { body } = await fetchPinned([COMMUNITY_NODE.url], { sha256: COMMUNITY_NODE.sha256, label: `Node.js ${COMMUNITY_NODE.version}` });
  await extractVerifiedArchive(body, work, "Node.js");
  const nodeRoot = join(work, COMMUNITY_NODE.archive.replace(/\.tar\.gz$/u, ""));
  await copyFile(join(nodeRoot, "bin/node"), join(candidate, "node"));
  await copyFile(join(nodeRoot, "LICENSE"), join(candidate, "NODE-LICENSE.txt"));
  const version = (await capture(join(candidate, "node"), ["--version"])).stdout.trim();
  if (version !== `v${COMMUNITY_NODE.version}`) throw new Error(`Staged Node.js reports ${version}, expected v${COMMUNITY_NODE.version}`);
  return { archiveSha256: COMMUNITY_NODE.sha256, version };
}

async function buildFfmpeg(work) {
  const { body, url } = await fetchPinned(COMMUNITY_FFMPEG.urls, { bytes: COMMUNITY_FFMPEG.bytes, sha256: COMMUNITY_FFMPEG.sha256, label: `FFmpeg ${COMMUNITY_FFMPEG.version}` });
  await extractVerifiedArchive(body, work, "FFmpeg");
  const source = join(work, `ffmpeg-${COMMUNITY_FFMPEG.version}`);
  const brewPrefix = (await capture("brew", ["--prefix"])).stdout.trim();
  const pkgConfigDirectories = [join(brewPrefix, "lib/pkgconfig"), join(brewPrefix, "share/pkgconfig")];
  for (const formula of COMMUNITY_FFMPEG_HOMEBREW_FORMULAE) {
    const result = await capture("brew", ["--prefix", "--installed", formula], { allowFailure: true });
    if (result.code !== 0) throw new Error(`Homebrew formula ${formula} is not installed; run: brew install pkgconf ${COMMUNITY_FFMPEG_HOMEBREW_FORMULAE.join(" ")}`);
    pkgConfigDirectories.unshift(join(result.stdout.trim(), "lib/pkgconfig"));
  }
  const env = cleanEnvironment({
    MACOSX_DEPLOYMENT_TARGET: COMMUNITY_DEPLOYMENT_TARGET,
    PKG_CONFIG_PATH: [...pkgConfigDirectories, process.env.PKG_CONFIG_PATH].filter(Boolean).join(":"),
  });
  const modules = await capture("pkg-config", ["--modversion", "x264", "x265", "zimg", "libass", "dav1d"], { env });
  log(`pkg-config modules x264/x265/zimg/libass/dav1d: ${modules.stdout.trim().split(/\r?\n/u).join(", ")}`);
  try {
    await run(join(source, "configure"), [...COMMUNITY_FFMPEG_CONFIGURE_ARGS], { cwd: source, env, timeoutMs: 20 * MINUTE, label: "FFmpeg configure" });
  } catch (error) {
    log(`FFmpeg configure failed; tail of ffbuild/config.log:\n${await tail(join(source, "ffbuild/config.log"), 120)}`);
    throw error;
  }
  const enabled = enabledConfigSymbols(`${await readFile(join(source, "config.h"), "utf8")}\n${await readFile(join(source, "config_components.h"), "utf8")}`);
  const missingSymbols = REQUIRED_FFMPEG_CONFIG_SYMBOLS.filter((symbol) => !enabled.has(symbol));
  if (missingSymbols.length) throw new Error(`FFmpeg configure did not enable: ${missingSymbols.join(", ")}`);
  await run("make", [`-j${Math.max(2, availableParallelism())}`], { cwd: source, env, timeoutMs: 90 * MINUTE, label: "FFmpeg make" });
  for (const program of ["ffmpeg", "ffprobe"]) {
    const info = await stat(join(source, program));
    if (!info.isFile() || info.size <= 0) throw new Error(`FFmpeg build did not produce ${program}`);
  }
  return {
    source,
    sourceUrl: url,
    toolchain: {
      pkgConfigModules: modules.stdout.trim().split(/\r?\n/u),
      pkgConfigPath: env.PKG_CONFIG_PATH,
    },
  };
}

async function bundleFfmpegClosure({ ffmpegSource, candidate, libDirectory }) {
  const roots = ["ffmpeg", "ffprobe"].map((name) => join(ffmpegSource, name));
  const plan = await planLoaderPathClosure({ roots, inspect: loadCommands, realpath: realpathOrUndefined });
  await mkdir(libDirectory, { recursive: true });
  for (const library of plan.libraries) {
    const target = join(libDirectory, library.name);
    await copyFile(library.source, target);
    await chmod(target, 0o644);
  }
  const rootTargets = new Map(await Promise.all(roots.map(async (path) => [await realpath(path), join(candidate, basename(path))])));
  for (const [source, target] of rootTargets) {
    await copyFile(source, target);
    await chmod(target, 0o755);
  }
  for (const edit of plan.edits) {
    const target = edit.role === "root" ? rootTargets.get(edit.source) : join(libDirectory, edit.name);
    if (!target) throw new Error(`No staged target for ${edit.source}`);
    const args = installNameToolArguments(edit);
    if (args.length) await run("/usr/bin/install_name_tool", [...args, target], { label: `install_name_tool ${basename(target)}`, timeoutMs: 2 * MINUTE });
  }
  log(`bundled ${plan.libraries.length} FFmpeg libraries: ${plan.libraries.map((library) => library.name).join(", ")}`);
  return plan;
}

async function buildWhisperCli(work) {
  const { body } = await fetchPinned([COMMUNITY_WHISPER_CPP.sourceUrl], {
    bytes: COMMUNITY_WHISPER_CPP.archiveBytes, sha256: COMMUNITY_WHISPER_CPP.archiveSha256, label: `whisper.cpp ${COMMUNITY_WHISPER_CPP.tag}`,
  });
  await extractVerifiedArchive(body, work, "whisper.cpp");
  const source = join(work, `whisper.cpp-${COMMUNITY_WHISPER_CPP.commit}`);
  const build = join(work, "whisper-build");
  // Same configuration as the owner's macOS stager: static, Metal library embedded.
  const configuration = [
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_OSX_ARCHITECTURES=arm64",
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${COMMUNITY_DEPLOYMENT_TARGET}`,
    "-DBUILD_SHARED_LIBS=OFF",
    "-DWHISPER_BUILD_TESTS=OFF",
    "-DWHISPER_BUILD_EXAMPLES=ON",
    "-DWHISPER_BUILD_SERVER=OFF",
    "-DGGML_NATIVE=OFF",
    "-DGGML_METAL=ON",
    "-DGGML_METAL_EMBED_LIBRARY=ON",
    "-DGGML_ACCELERATE=ON",
    "-DGGML_OPENMP=OFF",
  ];
  const env = cleanEnvironment({ MACOSX_DEPLOYMENT_TARGET: COMMUNITY_DEPLOYMENT_TARGET });
  await run("cmake", ["-S", source, "-B", build, ...configuration], { env, label: "whisper.cpp cmake configure" });
  await run("cmake", ["--build", build, "--config", "Release", "--target", "whisper-cli", "--parallel", String(Math.max(2, availableParallelism()))], { env, timeoutMs: 45 * MINUTE, label: "whisper.cpp build" });
  return {
    binary: join(build, "bin", "whisper-cli"),
    license: join(source, "LICENSE"),
    configuration,
    cmakeVersion: (await capture("cmake", ["--version"])).stdout.split(/\r?\n/u)[0]?.trim(),
    compilerVersion: (await capture("/usr/bin/clang++", ["--version"])).stdout.split(/\r?\n/u)[0]?.trim(),
  };
}

async function findPython() {
  const [major, minor] = COMMUNITY_FONTTOOLS.minimumPython;
  for (const candidate of ["python3.13", "python3.12", "python3.11", "python3.10", "python3", "/usr/bin/python3"]) {
    const result = await capture(candidate, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"]).catch(() => undefined);
    const [actualMajor, actualMinor] = (result?.stdout.trim() ?? "").split(".").map(Number);
    if (actualMajor > major || (actualMajor === major && actualMinor >= minor)) return { executable: candidate, version: result.stdout.trim() };
  }
  throw new Error(`No Python ${major}.${minor}+ found for scripts/build-static-font-pack.py`);
}

/** Generates the static render faces with the repository's own generator and pinned fontTools. */
export async function stageFontPack(work, candidate) {
  const python = await findPython();
  const venv = join(work, "fonttools-venv");
  await run(python.executable, ["-m", "venv", venv], { label: "python venv" });
  // pip downloads the pinned wheel itself; hash-checking mode refuses any other bytes.
  const requirements = join(work, "fonttools-requirements.txt");
  await writeFile(requirements, `fonttools @ ${COMMUNITY_FONTTOOLS.url} --hash=sha256:${COMMUNITY_FONTTOOLS.sha256}\n`, "utf8");
  const venvPython = join(venv, "bin", "python");
  await run(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir", "--no-deps", "--only-binary=:all:", "--require-hashes", "-r", requirements], { label: "pip install fontTools" });
  const installed = (await capture(venvPython, ["-I", "-c", "import fontTools; print(fontTools.__version__)"])).stdout.trim();
  if (installed !== COMMUNITY_FONTTOOLS.version) throw new Error(`fontTools ${installed} installed, expected ${COMMUNITY_FONTTOOLS.version}`);
  const stage = join(work, COMMUNITY_FONT_PACK_DIRECTORY);
  // -B: never leave bytecode caches next to the repository's generator script.
  await run(venvPython, ["-I", "-B", join(root, "scripts/build-static-font-pack.py"), "--source", join(root, "public/fonts"), "--stage", stage, "--workers", String(Math.max(2, availableParallelism()))], {
    env: cleanEnvironment({ PYTHONDONTWRITEBYTECODE: "1" }), label: "build static font faces", timeoutMs: 45 * MINUTE,
  });
  const files = {};
  for (const relativePath of await listFiles(stage)) files[relativePath] = await fileRecord(join(stage, relativePath));
  const manifest = JSON.parse(await readFile(join(stage, "editkin-open-fonts.json"), "utf8"));
  const findings = fontPackFindings(manifest, files);
  if (findings.length) throw new Error(`Generated font pack is inconsistent: ${findings.join("; ")}`);
  const provenance = JSON.parse(await readFile(join(stage, "static-face-provenance.json"), "utf8"));
  if (provenance.fontToolsVersion !== COMMUNITY_FONTTOOLS.version) throw new Error(`Font provenance records fontTools ${provenance.fontToolsVersion}`);
  await cp(stage, join(candidate, COMMUNITY_FONT_PACK_DIRECTORY), { recursive: true, errorOnExist: true, force: false });
  return {
    python: python.version,
    fontTools: { version: COMMUNITY_FONTTOOLS.version, wheel: COMMUNITY_FONTTOOLS.wheel, sha256: COMMUNITY_FONTTOOLS.sha256 },
    faces: manifest.fonts.reduce((count, font) => count + font.faces.length, 0),
    manifestSha256: files["editkin-open-fonts.json"].sha256,
  };
}

/** Removes LC_RPATH entries from a self-contained binary that has no @rpath dependency. */
async function dropUnusedRpaths(path) {
  const commands = await loadCommands(path);
  if (!commands.rpaths.length) return [];
  if (commands.dependencies.some((dependency) => dependency.startsWith("@rpath/"))) {
    throw new Error(`${basename(path)} depends on @rpath libraries; refusing to drop its LC_RPATH entries`);
  }
  await run("/usr/bin/install_name_tool", [...commands.rpaths.flatMap((rpath) => ["-delete_rpath", rpath]), path], { label: `install_name_tool ${basename(path)}` });
  return commands.rpaths;
}

async function collectLicenses({ plan, candidate, ffmpegSource }) {
  const licenseRoot = join(candidate, "licenses");
  await mkdir(join(licenseRoot, "ffmpeg"), { recursive: true });
  for (const name of ["LICENSE.md", "COPYING.GPLv2", "COPYING.LGPLv2.1"]) {
    await copyFile(join(ffmpegSource, name), join(licenseRoot, "ffmpeg", name));
  }
  const kegs = new Map();
  for (const library of plan.libraries) {
    const keg = homebrewKegFromPath(library.source);
    if (!keg) throw new Error(`Bundled library ${library.name} does not come from a Homebrew keg (${library.source}); provenance unknown`);
    kegs.set(keg.formula, keg);
    library.homebrew = keg;
  }
  const metadata = await brewJson([...kegs.keys()]);
  const formulae = {};
  for (const [formula, keg] of [...kegs].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const info = metadata.get(formula);
    if (!info) throw new Error(`brew info has no metadata for ${formula}`);
    const copied = [];
    const destination = join(licenseRoot, formula);
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(keg.kegRoot, { withFileTypes: true })) {
      if (entry.isFile() && isHomebrewLicenseFile(entry.name)) {
        await copyFile(join(keg.kegRoot, entry.name), join(destination, entry.name));
        copied.push(entry.name);
      } else if (entry.isDirectory() && /^LICENSES$/iu.test(entry.name)) {
        for (const nested of await readdir(join(keg.kegRoot, entry.name), { withFileTypes: true })) {
          if (!nested.isFile()) continue;
          await copyFile(join(keg.kegRoot, entry.name, nested.name), join(destination, `LICENSES-${nested.name}`));
          copied.push(`LICENSES/${nested.name}`);
        }
      }
    }
    if (!copied.length) {
      await writeFile(join(destination, "LICENSE-NOT-SHIPPED-BY-HOMEBREW.txt"), `Homebrew installed no license file in the ${formula} ${keg.version} keg.\nDeclared license: ${info.license ?? "unknown"}\nSource: ${info.urls?.stable?.url ?? "unknown"}\n`, "utf8");
      copied.push("LICENSE-NOT-SHIPPED-BY-HOMEBREW.txt");
    }
    formulae[formula] = {
      installedVersion: keg.version,
      stableVersion: info.versions?.stable ?? null,
      license: info.license ?? null,
      homepage: info.homepage ?? null,
      tap: info.tap ?? null,
      source: { url: info.urls?.stable?.url ?? null, sha256: info.urls?.stable?.checksum ?? null },
      licenseFiles: copied.map((name) => `licenses/${formula}/${name.replace(/^LICENSES\//u, "LICENSES-")}`),
    };
  }
  return formulae;
}

async function writeLicenseTexts({ candidate, ffmpegSource }) {
  const header = [
    `Editkin community build of FFmpeg ${COMMUNITY_FFMPEG.version}, configured with --enable-gpl, libx264 and libx265.`,
    "The combined FFmpeg binaries are distributed under the GNU General Public License, version 2 or later.",
    "See COMMUNITY-BUILD-NOTICE.txt for redistribution duties and FFMPEG-PROVENANCE.json for exact sources.",
    "Notices of the bundled third-party libraries are in licenses/.",
    "",
  ].join("\n");
  const text = `${header}\n===== FFmpeg LICENSE.md =====\n\n${await readFile(join(ffmpegSource, "LICENSE.md"), "utf8")}\n\n===== FFmpeg COPYING.GPLv2 =====\n\n${await readFile(join(ffmpegSource, "COPYING.GPLv2"), "utf8")}`;
  await writeFile(join(candidate, "FFMPEG-LICENSE.txt"), text, "utf8");
  await writeFile(join(candidate, "FFPROBE-LICENSE.txt"), text.replace("community build of FFmpeg", "community build of FFmpeg (ffprobe)"), "utf8");
}

const COMMUNITY_NOTICE = `Editkin community macOS build (Apple Silicon) - NOT an official Editkin release
Editkin 社群 macOS 版本（Apple Silicon）－不是 Editkin 官方發行版

This app was built from the public source by the "macOS community desktop" workflow.
It is ad-hoc signed (no Developer ID, not notarized) and meant for the maintainer's
own use and testing.

Bundled runtime components (runtime/):
- FFmpeg ${COMMUNITY_FFMPEG.version}, built from source with --enable-gpl, libx264 and libx265 (GPL-2.0-or-later)
- Homebrew-built libraries that FFmpeg links (runtime/lib; notices in runtime/licenses)
- Node.js ${COMMUNITY_NODE.version} official macOS binary (NODE-LICENSE.txt)
- whisper.cpp ${COMMUNITY_WHISPER_CPP.version} whisper-cli (MIT, WHISPER-LICENSE.txt)
- hao-core built from this repository

Not bundled: editkin-gpu-compositor. It needs the generated ACES 2 output LUTs,
which are not in the public source, so scene-linear ACES 2 output and GPU
preview are unavailable in this build.

Redistribution: FFmpeg in this build contains GPL components. Anyone who
redistributes this app or its DMG must comply with the GNU GPL, including
offering the complete corresponding source code of FFmpeg and of every bundled
library. Versions, source URLs and checksums are recorded in
FFMPEG-PROVENANCE.json. Do not present this build as an official Editkin download.

轉散布注意：此版本的 FFmpeg 含 GPL 元件（libx264、libx265）。轉散布此 App 或 DMG 時，
必須遵守 GNU GPL，並提供 FFmpeg 與每個隨附函式庫的完整對應原始碼；版本、來源網址與雜湊
記錄於 FFMPEG-PROVENANCE.json。請勿將此版本當作 Editkin 官方下載。
`;

/** whisper-cli receipts in the owner's format (validated by scripts/macos-bundle-runtime-gate.mjs). */
export async function writeWhisperReceipts({ candidate, build, version, dependencies, description }) {
  const whisperPath = join(candidate, "whisper-cli");
  const binarySha256 = await hashFile(whisperPath);
  const provenance = {
    schemaVersion: 1,
    component: "whisper.cpp/whisper-cli",
    version: COMMUNITY_WHISPER_CPP.version,
    tag: COMMUNITY_WHISPER_CPP.tag,
    commit: COMMUNITY_WHISPER_CPP.commit,
    source: { url: COMMUNITY_WHISPER_CPP.sourceUrl, bytes: COMMUNITY_WHISPER_CPP.archiveBytes, sha256: COMMUNITY_WHISPER_CPP.archiveSha256 },
    license: { spdx: COMMUNITY_WHISPER_CPP.license, file: "WHISPER-LICENSE.txt", sha256: await hashFile(join(candidate, "WHISPER-LICENSE.txt")) },
    target: { platform: "darwin", arch: "arm64", minimumMacOS: COMMUNITY_DEPLOYMENT_TARGET },
    build: { cmakeVersion: build.cmakeVersion, compilerVersion: build.compilerVersion, configuration: build.configuration, sharedLibraries: false, metal: true, accelerate: true, homebrewRuntimeAllowed: false, codeSignature: "ad-hoc" },
    binary: { name: "whisper-cli", bytes: (await stat(whisperPath)).size, sha256: binarySha256, fileDescription: description },
    // otool's first line names the staged file itself, not a dependency.
    runtimeDependencies: dependencies.split(/\r?\n/u).slice(1).map((line) => line.trim()).filter(Boolean),
  };
  await writeFile(join(candidate, "WHISPER-PROVENANCE.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  const capability = {
    schemaVersion: 1,
    capabilityId: "editkin.automatic-captions.whisper-cli/v1",
    component: "whisper.cpp/whisper-cli",
    version: COMMUNITY_WHISPER_CPP.version,
    commit: COMMUNITY_WHISPER_CPP.commit,
    platform: "darwin",
    arch: "arm64",
    binarySha256,
    provenanceSha256: await hashFile(join(candidate, "WHISPER-PROVENANCE.json")),
    probe: { launched: true, version, requiredFlags: requiredWhisperFlags() },
    capabilities: { monolingualTranscription: true, automaticLanguage: true, srt: true, translateToEnglish: true, localOnly: true },
    routing: { fallbackWhen: "ffmpeg-whisper-filter-unavailable", primaryWhenAvailable: "ffmpeg-whisper-filter" },
  };
  await writeFile(join(candidate, "WHISPER-CAPABILITY.json"), `${JSON.stringify(capability, null, 2)}\n`, "utf8");
  return binarySha256;
}

/**
 * PLATFORM-MANIFEST in the owner's schema 2 format with the community runtime
 * file set (the owner's set minus COMMUNITY_OMITTED_RUNTIME_FILES), plus a
 * community section hashing every other staged file.
 */
export async function writePlatformManifest({ candidate, nodeArchiveSha256, whisperBinarySha256, minimumMacOS, droppedRpaths, fontPack }) {
  const files = {};
  for (const name of PLATFORM_RUNTIME_FILES) files[name] = await hashFile(join(candidate, name));
  const additionalFiles = {};
  const fontPackFiles = {};
  for (const relativePath of await listFiles(candidate)) {
    if (PLATFORM_RUNTIME_FILES.includes(relativePath) || relativePath === "manifest.json") continue;
    if (APP_RUNTIME_ENTRYPOINTS.includes(relativePath)) throw new Error(`Stager must not produce the app entrypoint ${relativePath}`);
    if (relativePath.startsWith(`${COMMUNITY_FONT_PACK_DIRECTORY}/`)) {
      fontPackFiles[relativePath.slice(COMMUNITY_FONT_PACK_DIRECTORY.length + 1)] = await hashFile(join(candidate, relativePath));
    } else {
      additionalFiles[relativePath] = await hashFile(join(candidate, relativePath));
    }
  }
  const manifest = {
    schemaVersion: 2,
    platform: "darwin",
    arch: "arm64",
    nodeVersion: COMMUNITY_NODE.version,
    nodeArchiveSha256,
    whisper: {
      version: COMMUNITY_WHISPER_CPP.version,
      commit: COMMUNITY_WHISPER_CPP.commit,
      sourceArchiveSha256: COMMUNITY_WHISPER_CPP.archiveSha256,
      binarySha256: whisperBinarySha256,
      capabilityReceiptSha256: files["WHISPER-CAPABILITY.json"],
    },
    files,
    community: {
      scope: "editkin.community-macos-runtime/v1",
      officialRelease: false,
      minimumMacOS,
      declaredDeploymentTarget: COMMUNITY_DEPLOYMENT_TARGET,
      ffmpeg: { version: COMMUNITY_FFMPEG.version, sourceSha256: COMMUNITY_FFMPEG.sha256, provenanceSha256: additionalFiles["FFMPEG-PROVENANCE.json"] },
      codeSignature: { node: "upstream Node.js signature (unchanged)", otherMachO: "ad-hoc" },
      omittedRuntimeFiles: [...COMMUNITY_OMITTED_RUNTIME_FILES],
      droppedRpaths,
      additionalFiles,
      fontPack: {
        source: `${COMMUNITY_FONT_PACK_DIRECTORY}/`,
        destination: "font-packs/editkin-open-fonts",
        generator: "scripts/build-static-font-pack.py",
        python: fontPack.python,
        fontTools: fontPack.fontTools,
        faces: fontPack.faces,
        manifestSha256: fontPack.manifestSha256,
        files: fontPackFiles,
      },
    },
  };
  await writeFile(join(candidate, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

async function runtimeChecks({ candidate, fontsDirectory, work }) {
  const ffmpeg = join(candidate, "ffmpeg");
  const ffprobe = join(candidate, "ffprobe");
  const versionText = (await capture(ffmpeg, ["-hide_banner", "-version"])).stdout;
  const configuration = ffmpegConfigurationLine(versionText);
  const missingFlags = REQUIRED_FFMPEG_CONFIGURATION_FLAGS.filter((flag) => !configuration.split(/\s+/u).includes(flag));
  if (!ffmpegVersionLine(versionText).includes(COMMUNITY_FFMPEG.version) || missingFlags.length) {
    throw new Error(`Staged FFmpeg identity mismatch: ${ffmpegVersionLine(versionText)}; missing flags ${missingFlags.join(", ")}`);
  }
  const lists = {
    encoders: parseCodecList((await capture(ffmpeg, ["-hide_banner", "-encoders"])).stdout),
    decoders: parseCodecList((await capture(ffmpeg, ["-hide_banner", "-decoders"])).stdout),
    filters: parseFilterList((await capture(ffmpeg, ["-hide_banner", "-filters"])).stdout),
    devices: parseFormatList((await capture(ffmpeg, ["-hide_banner", "-devices"])).stdout),
    muxers: parseFormatList((await capture(ffmpeg, ["-hide_banner", "-muxers"])).stdout),
    demuxers: parseFormatList((await capture(ffmpeg, ["-hide_banner", "-demuxers"])).stdout),
  };
  const missing = {
    encoders: missingNames(REQUIRED_FFMPEG_ENCODERS, lists.encoders),
    decoders: missingNames(REQUIRED_FFMPEG_DECODERS, lists.decoders),
    filters: missingNames(REQUIRED_FFMPEG_FILTERS, lists.filters),
    devices: missingNames(REQUIRED_FFMPEG_DEVICES, lists.devices),
    muxers: missingNames(REQUIRED_FFMPEG_MUXERS, lists.muxers),
    demuxers: missingNames(REQUIRED_FFMPEG_DEMUXERS, lists.demuxers),
  };
  if (Object.values(missing).some((names) => names.length)) throw new Error(`Staged FFmpeg lacks required components: ${JSON.stringify(missing)}`);
  if (lists.filters.has("whisper")) throw new Error("Staged FFmpeg unexpectedly contains the whisper filter; captions must use the pinned whisper-cli");
  const ffprobeVersion = ffmpegVersionLine((await capture(ffprobe, ["-hide_banner", "-version"])).stdout);

  const loaded = {};
  const allowedRoots = [...new Set([candidate, await realpath(candidate)])];
  const display = (path) => {
    const owner = allowedRoots.find((rootPath) => path.startsWith(`${rootPath}/`));
    return owner ? `runtime/${path.slice(owner.length + 1)}` : path;
  };
  for (const program of [ffmpeg, ffprobe]) {
    const result = await capture(program, ["-hide_banner", "-version"], { env: cleanEnvironment({ DYLD_PRINT_LIBRARIES: "1" }) });
    const images = parseDyldPrintedLibraries(result.stderr);
    const disallowed = disallowedLoadedImages(images, allowedRoots);
    if (disallowed.length) throw new Error(`${basename(program)} loaded host libraries: ${disallowed.join(", ")}`);
    loaded[basename(program)] = images.length
      ? images.map(display)
      : "DYLD_PRINT_LIBRARIES produced no output; relied on the load-command audit";
  }

  const smoke = join(work, "smoke");
  await mkdir(smoke, { recursive: true });
  const assPath = join(smoke, "smoke.ass");
  await writeFile(assPath, [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 320", "PlayResY: 180", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Noto Sans TC,28,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1",
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Editkin 字幕",
    "",
  ].join("\n"), "utf8");
  const quickChecks = [
    ["libx264", ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-f", "null", "-"]],
    ["zscale+libx265", ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1", "-vf", "format=gbrp16le,zscale=matrix=2020_ncl:range=limited,format=yuv420p10le", "-c:v", "libx265", "-preset", "ultrafast", "-f", "null", "-"]],
    ["subtitles(libass)", ["-f", "lavfi", "-i", "color=c=black:s=320x180:d=1", "-vf", `subtitles=filename=${escapeFilterOptionPath(assPath)}:fontsdir=${escapeFilterOptionPath(fontsDirectory)}:wrap_unicode=1`, "-f", "null", "-"]],
  ];
  for (const [label, args] of quickChecks) {
    await capture(ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", ...args], { timeoutMs: 3 * MINUTE });
    log(`quick FFmpeg check passed: ${label}`);
  }

  const engine = JSON.parse((await capture(join(candidate, "hao-core"), ["engine-capabilities"])).stdout);
  if (engine.schema !== "editkin.engine-capabilities/v1" || engine.engine !== "hao-core") throw new Error("hao-core engine-capabilities returned an unexpected identity");

  return {
    version: ffmpegVersionLine(versionText),
    ffprobeVersion,
    configuration,
    components: Object.fromEntries(Object.entries(lists).map(([key, names]) => [key, [...names].sort()])),
    loadedImages: loaded,
    quickChecks: quickChecks.map(([label]) => label),
    haoCoreEngine: { schema: engine.schema, engine: engine.engine },
  };
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(`The community macOS runtime is built only on an Apple Silicon macOS host (host: ${process.platform}/${process.arch})`);
  }
  const corePath = resolve(process.env.HAO_NATIVE_CORE_PATH ?? join(root, "native/hao-core/target/release/hao-core"));
  const fontsDirectory = join(root, "public/fonts");
  for (const required of [corePath, join(fontsDirectory, "NotoSansTC[wght].ttf")]) {
    if (!(await exists(required))) throw new Error(`Missing build input: ${required}`);
  }
  const host = {
    macOS: (await capture("/usr/bin/sw_vers", ["-productVersion"])).stdout.trim(),
    build: (await capture("/usr/bin/sw_vers", ["-buildVersion"])).stdout.trim(),
    arch: process.arch,
    clang: (await capture("/usr/bin/clang", ["--version"])).stdout.split(/\r?\n/u)[0]?.trim(),
    pkgConfig: (await capture("pkg-config", ["--version"])).stdout.trim(),
    homebrew: (await capture("brew", ["--version"])).stdout.split(/\r?\n/u)[0]?.trim(),
  };
  log(`host ${JSON.stringify(host)}`);

  const work = await mkdtemp(join(tmpdir(), "editkin-macos-community-"));
  const workReal = await realpath(work);
  const candidate = resolve(root, `.platform-runtime.stage-${process.pid}`);
  let succeeded = false;
  try {
    await rm(candidate, { recursive: true, force: true });
    await mkdir(candidate, { recursive: true });
    const libDirectory = join(candidate, "lib");

    const node = await stageNode(work, candidate);
    const fontPack = await stageFontPack(work, candidate);
    const ffmpegBuild = await buildFfmpeg(work);
    const closure = await bundleFfmpegClosure({ ffmpegSource: ffmpegBuild.source, candidate, libDirectory });
    const whisper = await buildWhisperCli(work);
    await copyFile(whisper.binary, join(candidate, "whisper-cli"));
    await copyFile(whisper.license, join(candidate, "WHISPER-LICENSE.txt"));
    await copyFile(corePath, join(candidate, "hao-core"));
    for (const executable of RUNTIME_EXECUTABLES) await chmod(join(candidate, executable), 0o755);
    const droppedRpaths = {};
    for (const name of ["whisper-cli", "hao-core"]) {
      const dropped = await dropUnusedRpaths(join(candidate, name));
      if (dropped.length) droppedRpaths[name] = dropped;
    }

    // Ad-hoc sign every Mach-O we built or rewrote; keep Node.js's upstream signature.
    await run("/usr/bin/xattr", ["-cr", candidate], { label: "clear extended attributes" });
    const stagedFiles = await listFiles(candidate);
    const stagedPaths = new Set(stagedFiles.map((relativePath) => normalize(join(candidate, relativePath))));
    const machO = [];
    for (const relativePath of stagedFiles) {
      if (await isMachOFile(join(candidate, relativePath))) machO.push(relativePath);
    }
    for (const relativePath of machO.filter((path) => path !== "node")) {
      await run("/usr/bin/codesign", ["--force", "--sign", "-", join(candidate, relativePath)], { label: `codesign ${relativePath}`, timeoutMs: 2 * MINUTE });
    }
    const minimums = {};
    const buildRoots = [work, workReal];
    for (const relativePath of machO) {
      const path = join(candidate, relativePath);
      await capture("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", path]);
      const archs = await architectures(path);
      if (archs.join(" ") !== "arm64") throw new Error(`${relativePath} is not arm64-only: ${archs.join(" ")}`);
      const commands = await loadCommands(path);
      const findings = auditBundledMachO({ file: path, bundleRoot: candidate, loadCommands: commands, exists: (target) => stagedPaths.has(target), buildRoots });
      if (findings.length) {
        throw new Error(`${relativePath} is not relocatable: ${findings.join("; ")}\n${(await capture("/usr/bin/otool", ["-L", path])).stdout}`);
      }
      minimums[relativePath] = commands.minimumMacOS ?? null;
    }
    const minimumMacOS = maxMacOSVersion(Object.values(minimums).filter(Boolean));
    log(`Mach-O audit passed for ${machO.length} files; highest declared minimum macOS ${minimumMacOS}`);

    const checks = await runtimeChecks({ candidate, fontsDirectory, work });

    // whisper-cli launch probes and receipts, in the owner's receipt format.
    const whisperPath = join(candidate, "whisper-cli");
    const whisperHelp = await capture(whisperPath, ["--help"]);
    if (!whisperCliHasRequiredCapabilities(`${whisperHelp.stdout}\n${whisperHelp.stderr}`)) throw new Error("whisper-cli lacks language/SRT/translate capability");
    const whisperVersionResult = await capture(whisperPath, ["--version"]);
    const whisperVersion = `${whisperVersionResult.stdout}\n${whisperVersionResult.stderr}`.trim();
    if (!whisperVersion.includes(COMMUNITY_WHISPER_CPP.version) && !whisperVersion.includes(COMMUNITY_WHISPER_CPP.commit.slice(0, 7))) {
      throw new Error(`whisper-cli version probe does not match the pin: ${whisperVersion.slice(0, 500)}`);
    }
    const whisperDependencies = (await capture("/usr/bin/otool", ["-L", whisperPath])).stdout.trim();
    if (/(?:\/opt\/homebrew|\/usr\/local|@rpath|@loader_path|@executable_path|whisper-build|editkin-macos-runtime|editkin-macos-community)/iu.test(whisperDependencies)) {
      throw new Error(`whisper-cli has a non-closed runtime dependency: ${whisperDependencies}`);
    }
    const whisperDescription = (await capture("/usr/bin/file", ["-b", whisperPath])).stdout.trim();
    const whisperBinarySha256 = await writeWhisperReceipts({ candidate, build: whisper, version: whisperVersion, dependencies: whisperDependencies, description: whisperDescription });

    // FFmpeg licenses, provenance and the community notice.
    await writeLicenseTexts({ candidate, ffmpegSource: ffmpegBuild.source });
    const formulae = await collectLicenses({ plan: closure, candidate, ffmpegSource: ffmpegBuild.source });
    await writeFile(join(candidate, "COMMUNITY-BUILD-NOTICE.txt"), COMMUNITY_NOTICE, "utf8");
    const libraries = [];
    for (const library of closure.libraries) {
      libraries.push({
        file: `lib/${library.name}`,
        ...await fileRecord(join(libDirectory, library.name)),
        originalInstallNames: library.installNames,
        homebrewFormula: library.homebrew.formula,
        homebrewVersion: library.homebrew.version,
        minimumMacOS: minimums[`lib/${library.name}`] ?? null,
      });
    }
    const ffmpegProvenance = {
      schemaVersion: 1,
      component: "ffmpeg",
      distribution: "editkin-community-unsigned",
      officialRelease: false,
      license: { spdx: COMMUNITY_FFMPEG.license, files: ["FFMPEG-LICENSE.txt", "FFPROBE-LICENSE.txt", "licenses/ffmpeg/LICENSE.md", "licenses/ffmpeg/COPYING.GPLv2"], notice: "COMMUNITY-BUILD-NOTICE.txt" },
      source: {
        version: COMMUNITY_FFMPEG.version,
        url: ffmpegBuild.sourceUrl,
        canonicalUrl: COMMUNITY_FFMPEG.urls[0],
        bytes: COMMUNITY_FFMPEG.bytes,
        sha256: COMMUNITY_FFMPEG.sha256,
        releaseSigningKeyFingerprint: COMMUNITY_FFMPEG.signingKeyFingerprint,
        verification: "Pinned SHA-256 of the release tarball whose detached signature was checked against the FFmpeg release signing key when the pin was recorded; the build only accepts these bytes.",
      },
      build: {
        configureArguments: [...COMMUNITY_FFMPEG_CONFIGURE_ARGS],
        configuration: checks.configuration,
        deploymentTarget: COMMUNITY_DEPLOYMENT_TARGET,
        host,
        pkgConfigModules: ffmpegBuild.toolchain.pkgConfigModules,
        codeSignature: "ad-hoc (codesign --force --sign -)",
      },
      binaries: {
        ffmpeg: await fileRecord(join(candidate, "ffmpeg")),
        ffprobe: await fileRecord(join(candidate, "ffprobe")),
      },
      versions: { ffmpeg: checks.version, ffprobe: checks.ffprobeVersion },
      bundledLibraries: libraries,
      homebrewFormulae: formulae,
      components: checks.components,
      loadedImages: checks.loadedImages,
      minimumMacOS,
    };
    await writeFile(join(candidate, "FFMPEG-PROVENANCE.json"), `${JSON.stringify(ffmpegProvenance, null, 2)}\n`, "utf8");

    await writePlatformManifest({ candidate, nodeArchiveSha256: node.archiveSha256, whisperBinarySha256, minimumMacOS, droppedRpaths, fontPack });

    if (output !== resolve(root, ".platform-runtime")) throw new Error(`Refusing to replace a non-canonical runtime: ${output}`);
    await rm(output, { recursive: true, force: true });
    await rename(candidate, output);
    succeeded = true;
    process.stdout.write(`${JSON.stringify({
      status: "GREEN",
      output,
      minimumMacOS,
      ffmpeg: checks.version,
      ffprobe: checks.ffprobeVersion,
      node: node.version,
      whisper: whisperVersion.split(/\r?\n/u)[0],
      fontPack: { faces: fontPack.faces, fontTools: fontPack.fontTools.version, manifestSha256: fontPack.manifestSha256 },
      bundledLibraries: libraries.map((library) => library.file),
      loadedImages: checks.loadedImages,
    })}\n`);
  } finally {
    if (!succeeded) await rm(candidate, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
