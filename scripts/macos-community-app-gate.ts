// Verifies a built community Editkin.app (Apple Silicon, ad-hoc signed) the way
// the release app uses it: exact bundled runtime closure and hashes, relocatable
// Mach-O files, FFmpeg capabilities via Editkin's own argument builders, and the
// bundled Node service driven through its resident protocol (import, preview
// proxy, save/reopen, export). Signing/notarization and GUI behaviour are not
// claimed here; the workflow launches the app separately.
//
// Usage: npx tsx scripts/macos-community-app-gate.ts <Editkin.app> [report.json] [--source-root <repo>]
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCommand } from "../src/domain/commands";
import { createDemoProject } from "../src/domain/demo";
import { buildAssFilter } from "../src/render/captionAss";
import { encoderArgs } from "../src/render/ffmpegComposite";
import { HIGH_BIT_DEPTH_ALPHA_ENCODER_ARGS } from "../src/render/highBitDepthAlphaDelivery";
import { probeMedia } from "../src/render/mediaProcess";
import {
  APP_RUNTIME_ENTRYPOINTS,
  auditBundledMachO,
  COMMUNITY_FFMPEG,
  COMMUNITY_NODE,
  compareMacOSVersions,
  disallowedLoadedImages,
  ffmpegConfigurationLine,
  ffmpegVersionLine,
  fontPackFindings,
  isMachO,
  maxMacOSVersion,
  missingNames,
  parseCodecList,
  parseDyldPrintedLibraries,
  parseFilterList,
  parseFormatList,
  parseLipoArchitectures,
  parseMachOLoadCommands,
  PLATFORM_RUNTIME_FILES,
  REQUIRED_FFMPEG_CONFIGURATION_FLAGS,
  REQUIRED_FFMPEG_DECODERS,
  REQUIRED_FFMPEG_DEMUXERS,
  REQUIRED_FFMPEG_DEVICES,
  REQUIRED_FFMPEG_ENCODERS,
  REQUIRED_FFMPEG_FILTERS,
  REQUIRED_FFMPEG_MUXERS,
  whisperCliHasRequiredCapabilities,
} from "./lib/macos-community-runtime.mjs";

const SERVICE_SCHEMA = "editkin.service-stream/v1";
const MINUTE = 60_000;

/** Mirrors runtime_paths() for a release build in src-tauri/src/main.rs. */
export interface BundleLayout {
  app: string;
  resources: string;
  runtime: string;
  node: string;
  service: string;
  ffmpeg: string;
  ffprobe: string;
  whisperCli: string;
  nativeCore: string;
  gpuCompositor: string;
  fontRoot: string;
  colorRoot: string;
  pluginRoot: string;
  creativePackRoot: string;
  personalMusicRoot: string;
}

export function bundleLayout(app: string): BundleLayout {
  const resources = join(app, "Contents", "Resources");
  const runtime = join(resources, "runtime");
  return {
    app, resources, runtime,
    node: join(runtime, "node"),
    service: join(runtime, "service.mjs"),
    ffmpeg: join(runtime, "ffmpeg"),
    ffprobe: join(runtime, "ffprobe"),
    whisperCli: join(runtime, "whisper-cli"),
    nativeCore: join(runtime, "hao-core"),
    gpuCompositor: join(runtime, "editkin-gpu-compositor"),
    fontRoot: join(resources, "font-packs", "editkin-open-fonts"),
    colorRoot: join(resources, "color", "aces2"),
    pluginRoot: join(resources, "plugins"),
    creativePackRoot: join(resources, "creative-packs", "hao-creator-library"),
    personalMusicRoot: join(resources, "personal-packs", "hao-music-library"),
  };
}

type Detail = Record<string, unknown> | string | undefined;
interface StepResult { name: string; status: "PASS" | "WARN" | "FAIL"; detail?: Detail; error?: string; elapsedMs: number }

export class GateReport {
  readonly steps: StepResult[] = [];
  async step(name: string, run: () => Promise<Detail | { warning: string; detail?: Detail }>): Promise<void> {
    const started = Date.now();
    process.stderr.write(`[macos-community-app-gate] ${name}\n`);
    try {
      const value = await run();
      if (value && typeof value === "object" && "warning" in value && typeof value.warning === "string") {
        this.steps.push({ name, status: "WARN", detail: value.detail, error: value.warning, elapsedMs: Date.now() - started });
        process.stderr.write(`[macos-community-app-gate]   WARN ${value.warning}\n`);
      } else {
        this.steps.push({ name, status: "PASS", detail: value as Detail, elapsedMs: Date.now() - started });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.steps.push({ name, status: "FAIL", error: message, elapsedMs: Date.now() - started });
      process.stderr.write(`[macos-community-app-gate]   FAIL ${message}\n`);
    }
  }
  get failed(): StepResult[] { return this.steps.filter((step) => step.status === "FAIL"); }
}

function cleanEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DYLD_"))), ...extra };
}

interface ToolResult { code: number | null; stdout: string; stderr: string }

export function runTool(executable: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string; allowFailure?: boolean } = {}): Promise<ToolResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env ?? cleanEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectRun(error); else resolveRun({ code, stdout, stderr });
    };
    const timeoutMs = options.timeoutMs ?? 2 * MINUTE;
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error(`${basename(executable)} timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-4_000_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000_000); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0 || options.allowFailure) finish(undefined, code);
      else finish(new Error(`${basename(executable)} ${args.join(" ")} exited ${code}: ${stderr.trim().slice(-2_000)}`));
    });
  });
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in bundle: ${relativePath}`);
    if (entry.isDirectory()) files.push(...await listFiles(join(directory, entry.name), relativePath));
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error(`Unexpected special file in bundle: ${relativePath}`);
  }
  return files;
}

async function readHeader(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    return header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Exact runtime closure: PLATFORM-MANIFEST hashes, nothing unexpected, entrypoints present. */
export async function verifyBundleClosure(layout: BundleLayout, sourceRoot?: string): Promise<Detail> {
  const manifest = JSON.parse(await readFile(join(layout.runtime, "PLATFORM-MANIFEST.json"), "utf8"));
  assert(manifest.schemaVersion === 2 && manifest.platform === "darwin" && manifest.arch === "arm64", "PLATFORM-MANIFEST target is not darwin/arm64 schema 2");
  assert(manifest.nodeVersion === COMMUNITY_NODE.version, `PLATFORM-MANIFEST nodeVersion ${manifest.nodeVersion}`);
  assert(manifest.community?.officialRelease === false, "PLATFORM-MANIFEST is not marked as a community build");
  assert(JSON.stringify(Object.keys(manifest.files).sort()) === JSON.stringify([...PLATFORM_RUNTIME_FILES].sort()), "PLATFORM-MANIFEST files are not the closed-world runtime set");
  const expected = new Map<string, string>([...Object.entries(manifest.files as Record<string, string>), ...Object.entries(manifest.community.additionalFiles as Record<string, string>)]);
  const mismatched: string[] = [];
  for (const [relativePath, sha256] of expected) {
    const actual = await sha256File(join(layout.runtime, relativePath)).catch(() => "missing");
    if (actual !== sha256) mismatched.push(`${relativePath}: ${actual}`);
  }
  assert(!mismatched.length, `Bundled runtime differs from PLATFORM-MANIFEST: ${mismatched.join(", ")}`);
  const present = await listFiles(layout.runtime);
  const unexpected = present.filter((path) => !expected.has(path) && !APP_RUNTIME_ENTRYPOINTS.includes(path));
  assert(!unexpected.length, `Unexpected files in Contents/Resources/runtime: ${unexpected.join(", ")}`);
  const missingEntrypoints = APP_RUNTIME_ENTRYPOINTS.filter((path) => !present.includes(path));
  assert(!missingEntrypoints.length, `Missing app runtime entrypoints: ${missingEntrypoints.join(", ")}`);

  const identity = JSON.parse(await readFile(join(layout.runtime, "mcp.mjs.material-color-identity.json"), "utf8"));
  const mcp = await readFile(join(layout.runtime, "mcp.mjs"));
  assert(identity.bundle?.file === "mcp.mjs" && identity.bundle.size === mcp.length && identity.bundle.sha256 === createHash("sha256").update(mcp).digest("hex"), "mcp.mjs does not match its material-color identity sidecar");

  const agentRoot = join(layout.resources, "agent-runtime-v3");
  const agentFiles = await listFiles(agentRoot);
  assert(JSON.stringify(agentFiles) === JSON.stringify(["agent-setup-contract.json", "launcher.mjs", "lib/regular-file.mjs"]), `Unexpected agent runtime files: ${agentFiles.join(", ")}`);

  const fontFiles: Record<string, { bytes: number; sha256: string }> = {};
  for (const relativePath of await listFiles(layout.fontRoot)) {
    const bytes = await readFile(join(layout.fontRoot, relativePath));
    fontFiles[relativePath] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  const fontManifest = JSON.parse(await readFile(join(layout.fontRoot, "editkin-open-fonts.json"), "utf8"));
  const fontFindings = fontPackFindings(fontManifest, fontFiles);
  assert(!fontFindings.length, `Bundled font pack is inconsistent: ${fontFindings.join("; ")}`);
  const fontExpected = manifest.community.fontPack.files as Record<string, string>;
  const fontMismatch = [...new Set([...Object.keys(fontExpected), ...Object.keys(fontFiles)])].filter((path) => fontExpected[path] !== fontFiles[path]?.sha256);
  assert(!fontMismatch.length, `Bundled font pack differs from the staged pack: ${fontMismatch.join(", ")}`);

  for (const required of [join(layout.colorRoot, "editkin-aces2.json"), join(layout.pluginRoot, "README.md")]) {
    await stat(required);
  }
  const compared: Record<string, string> = {};
  if (sourceRoot) {
    for (const [bundled, source] of [
      ["runtime/service.mjs", "desktop-dist/service.mjs"],
      ["runtime/mcp.mjs", "desktop-dist/mcp.mjs"],
      ["runtime/remote.mjs", "desktop-dist/remote.mjs"],
      ["agent-runtime-v3/launcher.mjs", "scripts/editkin-product-mcp-launcher.mjs"],
      ["agent-runtime-v3/lib/regular-file.mjs", "scripts/lib/regular-file.mjs"],
      ["agent-runtime-v3/agent-setup-contract.json", "src/shared/agentSetupContract.json"],
    ]) {
      const actual = await sha256File(join(layout.resources, bundled));
      assert(actual === await sha256File(join(sourceRoot, source)), `${bundled} is not the freshly built ${source}`);
      compared[bundled] = actual;
    }
  }
  return {
    runtimeFiles: present.length,
    manifestFiles: expected.size,
    minimumMacOS: manifest.community.minimumMacOS,
    fontFaces: fontManifest.fonts.reduce((count: number, font: { faces: unknown[] }) => count + font.faces.length, 0),
    sourceComparedEntrypoints: compared,
  };
}

/** Every Mach-O in the bundle: arm64 only, valid signature, relocatable load commands. */
export async function auditMachOFiles(layout: BundleLayout): Promise<Detail> {
  const contents = join(layout.app, "Contents");
  const all = await listFiles(contents);
  const present = new Set(all.map((path) => normalize(join(contents, path))));
  const machO: string[] = [];
  for (const relativePath of all) if (isMachO(await readHeader(join(contents, relativePath)))) machO.push(relativePath);
  const findings: string[] = [];
  const minimums: Record<string, string | null> = {};
  for (const relativePath of machO) {
    const path = join(contents, relativePath);
    const archs = parseLipoArchitectures((await runTool("/usr/bin/lipo", ["-archs", path])).stdout);
    if (archs.join(" ") !== "arm64") findings.push(`${relativePath}: architectures ${archs.join(" ")}`);
    const signature = await runTool("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", path], { allowFailure: true });
    if (signature.code !== 0) findings.push(`${relativePath}: codesign --verify failed: ${signature.stderr.trim()}`);
    const commands = parseMachOLoadCommands((await runTool("/usr/bin/otool", ["-l", path])).stdout);
    const bundleRoot = relativePath.startsWith("Resources/runtime/") ? layout.runtime : contents;
    for (const finding of auditBundledMachO({ file: path, bundleRoot, loadCommands: commands, exists: (target: string) => present.has(target) })) {
      findings.push(`${relativePath}: ${finding}`);
    }
    minimums[relativePath] = commands.minimumMacOS ?? null;
  }
  assert(machO.length >= 7 && machO.includes("MacOS/" + basename(await mainExecutable(layout.app))), `Unexpected Mach-O inventory: ${machO.join(", ")}`);
  assert(!findings.length, findings.join("\n"));
  const minimumMacOS = maxMacOSVersion(Object.values(minimums).filter((value): value is string => Boolean(value)));
  const info = await infoPlist(layout.app);
  assert(!minimumMacOS || compareMacOSVersions(String(info.LSMinimumSystemVersion ?? "0"), minimumMacOS) >= 0,
    `LSMinimumSystemVersion ${info.LSMinimumSystemVersion} is lower than the bundled binaries' minimum ${minimumMacOS}`);
  return { machO: machO.length, minimumMacOS, declaredMinimum: info.LSMinimumSystemVersion, minimums };
}

async function infoPlist(app: string): Promise<Record<string, unknown>> {
  return JSON.parse((await runTool("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(app, "Contents", "Info.plist")])).stdout);
}

async function mainExecutable(app: string): Promise<string> {
  const info = await infoPlist(app);
  return join(app, "Contents", "MacOS", String(info.CFBundleExecutable));
}

export async function verifyFfmpegComponents(layout: BundleLayout, { expectCommunityBuild }: { expectCommunityBuild: boolean }): Promise<Detail> {
  const versionText = (await runTool(layout.ffmpeg, ["-hide_banner", "-version"])).stdout;
  const configuration = ffmpegConfigurationLine(versionText);
  if (expectCommunityBuild) {
    assert(ffmpegVersionLine(versionText).startsWith(`ffmpeg version ${COMMUNITY_FFMPEG.version}`), `Unexpected FFmpeg: ${ffmpegVersionLine(versionText)}`);
    const missingFlags = REQUIRED_FFMPEG_CONFIGURATION_FLAGS.filter((flag) => !configuration.split(/\s+/u).includes(flag));
    assert(!missingFlags.length, `FFmpeg configuration lacks ${missingFlags.join(", ")}`);
  }
  const list = async (flag: string) => (await runTool(layout.ffmpeg, ["-hide_banner", flag])).stdout;
  const available = {
    encoders: parseCodecList(await list("-encoders")),
    decoders: parseCodecList(await list("-decoders")),
    filters: parseFilterList(await list("-filters")),
    devices: parseFormatList(await list("-devices")),
    muxers: parseFormatList(await list("-muxers")),
    demuxers: parseFormatList(await list("-demuxers")),
  };
  const missing = {
    encoders: missingNames(REQUIRED_FFMPEG_ENCODERS, available.encoders),
    decoders: missingNames(REQUIRED_FFMPEG_DECODERS, available.decoders),
    filters: missingNames(REQUIRED_FFMPEG_FILTERS, available.filters),
    devices: missingNames(REQUIRED_FFMPEG_DEVICES, available.devices),
    muxers: missingNames(REQUIRED_FFMPEG_MUXERS, available.muxers),
    demuxers: missingNames(REQUIRED_FFMPEG_DEMUXERS, available.demuxers),
  };
  // A non-macOS development FFmpeg (only used to exercise this script) has no VideoToolbox.
  if (!expectCommunityBuild) missing.encoders = missing.encoders.filter((name) => !name.includes("videotoolbox"));
  const missingAny = Object.entries(missing).filter(([, names]) => names.length);
  assert(!missingAny.length, `FFmpeg lacks required components: ${JSON.stringify(Object.fromEntries(missingAny))}`);
  return {
    version: ffmpegVersionLine(versionText),
    ffprobe: ffmpegVersionLine((await runTool(layout.ffprobe, ["-hide_banner", "-version"])).stdout),
    configuration,
    whisperFilter: available.filters.has("whisper"),
  };
}

/** dyld's own record of every image loaded by the bundled executables. */
export async function verifyLoadedImages(layout: BundleLayout): Promise<Detail | { warning: string; detail?: Detail }> {
  const roots = [...new Set([layout.runtime, await realpath(layout.runtime)])];
  const detail: Record<string, string[]> = {};
  for (const [program, args] of [[layout.ffmpeg, ["-hide_banner", "-version"]], [layout.ffprobe, ["-hide_banner", "-version"]], [layout.nativeCore, ["engine-capabilities"]]] as const) {
    const result = await runTool(program, [...args], { env: cleanEnvironment({ DYLD_PRINT_LIBRARIES: "1" }) });
    const images = parseDyldPrintedLibraries(result.stderr);
    const disallowed = disallowedLoadedImages(images, roots);
    assert(!disallowed.length, `${basename(program)} loaded libraries outside the bundle and OS: ${disallowed.join(", ")}`);
    detail[basename(program)] = images;
  }
  const bundledLibraries = detail.ffmpeg?.filter((path) => roots.some((root) => path.startsWith(`${root}/lib/`))) ?? [];
  if (!detail.ffmpeg?.length) return { warning: "DYLD_PRINT_LIBRARIES printed nothing; the load-command audit is the only evidence", detail };
  assert(bundledLibraries.length > 0, "ffmpeg loaded no library from Contents/Resources/runtime/lib");
  return { bundledLibrariesLoaded: bundledLibraries.length, images: detail };
}

const lavfiVideo = (size = "640x360", seconds = 1) => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30:duration=${seconds}`];
const lavfiAudio = (seconds = 1) => ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`];

async function ffmpegRun(layout: BundleLayout, args: string[], timeoutMs = 3 * MINUTE): Promise<ToolResult> {
  return runTool(layout.ffmpeg, ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", ...args], { timeoutMs });
}

async function signalMaximumLuma(layout: BundleLayout, filter: string, input: string[]): Promise<number> {
  const result = await runTool(layout.ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "info", ...input,
    "-vf", `${filter},signalstats,metadata=mode=print:key=lavfi.signalstats.YMAX`, "-f", "null", "-"], { timeoutMs: 3 * MINUTE });
  const values = [...`${result.stdout}\n${result.stderr}`.matchAll(/lavfi\.signalstats\.YMAX=(\d+)/gu)].map((match) => Number(match[1]));
  assert(values.length > 0, "signalstats produced no YMAX values");
  return Math.max(...values);
}

/** Editkin's own encoder/filter argument builders against the bundled FFmpeg. */
export async function ffmpegFunctionalChecks(layout: BundleLayout, work: string, { videoToolbox }: { videoToolbox: boolean }): Promise<Detail | { warning: string; detail?: Detail }> {
  await mkdir(work, { recursive: true });
  const detail: Record<string, unknown> = {};
  const warnings: string[] = [];

  const x264 = join(work, "libx264.mp4");
  await ffmpegRun(layout, [...lavfiVideo(), ...lavfiAudio(), "-map", "0:v:0", "-map", "1:a:0", ...encoderArgs("libx264"), "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", x264]);
  const x264Probe = await probeMedia(x264, layout.ffprobe);
  assert(x264Probe.codecName === "h264" && x264Probe.width === 640 && x264Probe.audioCodecName === "aac", `libx264 output probe: ${JSON.stringify(x264Probe)}`);
  detail.libx264 = { codec: x264Probe.codecName, pixelFormat: x264Probe.pixelFormat, duration: x264Probe.duration };

  if (videoToolbox) {
    for (const encoder of ["h264_videotoolbox", "hevc_videotoolbox"] as const) {
      const output = join(work, `${encoder}.mp4`);
      const pixel = encoder === "hevc_videotoolbox" ? ["-vf", "format=p010le"] : ["-pix_fmt", "yuv420p"];
      const attempts: Record<string, string> = {};
      let mode: string | undefined;
      for (const [label, extra] of [["hardware", []], ["software (-allow_sw 1)", ["-allow_sw", "1"]]] as const) {
        try {
          await ffmpegRun(layout, [...lavfiVideo(), ...pixel, ...encoderArgs(encoder), ...extra, "-an", output]);
          mode = label;
          break;
        } catch (error) {
          attempts[label] = error instanceof Error ? error.message.slice(-600) : String(error);
        }
      }
      if (mode) {
        const probe = await probeMedia(output, layout.ffprobe);
        assert(probe.codecName === (encoder === "h264_videotoolbox" ? "h264" : "hevc"), `${encoder} output probe: ${JSON.stringify(probe)}`);
        detail[encoder] = { mode, codec: probe.codecName, pixelFormat: probe.pixelFormat };
      } else if (encoder === "h264_videotoolbox" && !Object.values(attempts).some((message) => /-1290[28]|cannot create compression session|no.*encoder/iu.test(message))) {
        throw new Error(`h264_videotoolbox failed for a reason other than missing VideoToolbox encoders: ${JSON.stringify(attempts)}`);
      } else {
        warnings.push(`${encoder} unavailable on this host (Editkin falls back to ${encoder === "h264_videotoolbox" ? "libx264" : "libx265"})`);
        detail[encoder] = { mode: "unavailable-on-host", attempts };
      }
    }
  }

  const hdr = join(work, "libx265-hdr.mp4");
  await ffmpegRun(layout, [...lavfiVideo(), "-vf", "format=gbrp16le,zscale=matrix=2020_ncl:range=limited,format=yuv420p10le", ...encoderArgs("libx265"), "-pix_fmt", "yuv420p10le", "-an", hdr]);
  const hdrProbe = await probeMedia(hdr, layout.ffprobe);
  assert(hdrProbe.codecName === "hevc" && hdrProbe.pixelFormat === "yuv420p10le", `libx265+zscale probe: ${JSON.stringify(hdrProbe)}`);
  detail.libx265Zscale = { codec: hdrProbe.codecName, pixelFormat: hdrProbe.pixelFormat };

  const prores = join(work, "prores-alpha.mov");
  await ffmpegRun(layout, ["-f", "lavfi", "-i", "color=c=red@0.5:s=320x180:d=1,format=yuva444p10le", ...HIGH_BIT_DEPTH_ALPHA_ENCODER_ARGS, "-pix_fmt", "yuva444p10le", prores]);
  const proresProbe = await probeMedia(prores, layout.ffprobe);
  assert(proresProbe.codecName === "prores" && proresProbe.pixelFormat?.startsWith("yuva444"), `prores_ks alpha probe: ${JSON.stringify(proresProbe)}`);
  detail.proresAlpha = { codec: proresProbe.codecName, pixelFormat: proresProbe.pixelFormat };

  await ffmpegRun(layout, [...lavfiVideo("320x180"), "-vf", "format=gbrpf32le,tonemap=hable,format=yuv420p,colorspace=all=bt709:iall=bt601-6-625:fast=1", "-f", "null", "-"]);
  await ffmpegRun(layout, [...lavfiAudio(2), "-f", "lavfi", "-i", "anoisesrc=duration=2:amplitude=0.2:sample_rate=48000",
    "-filter_complex", "[0:a]asplit=2[voice][voicekey];[1:a]volume=0.5[musicbus];[musicbus][voicekey]sidechaincompress=threshold=0.025:ratio=8:attack=25:release=360:makeup=1[duckedmusic];[voice][duckedmusic]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[out]",
    "-map", "[out]", "-f", "null", "-"]);
  detail.colorAndAudioFilters = ["tonemap", "colorspace", "sidechaincompress", "amix", "loudnorm"];

  const fontManifest = JSON.parse(await readFile(join(layout.fontRoot, "editkin-open-fonts.json"), "utf8"));
  const assPath = join(work, "caption.ass");
  const faceFamily = fontManifest.schemaVersion === 2 ? "EditkinFace noto-sans-tc 400" : "Noto Sans TC";
  const fontsDirectory = fontManifest.schemaVersion === 2 ? join(layout.fontRoot, "render") : layout.fontRoot;
  // Without the physical faces libass silently falls back to an OS font, so require them first.
  await stat(fontManifest.schemaVersion === 2 ? join(fontsDirectory, "EditkinFace-noto-sans-tc-400.ttf") : join(fontsDirectory, "NotoSansTC[wght].ttf"));
  await writeFile(assPath, [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 640", "PlayResY: 360", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${faceFamily},64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,10,10,10,1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Editkin 社群字幕 測試",
    "",
  ].join("\n"), "utf8");
  const blank = await signalMaximumLuma(layout, "null", ["-f", "lavfi", "-i", "color=c=black:s=640x360:d=1"]);
  const captioned = await signalMaximumLuma(layout, buildAssFilter(assPath, fontsDirectory), ["-f", "lavfi", "-i", "color=c=black:s=640x360:d=1"]);
  assert(captioned > blank + 100, `Burned caption did not render (YMAX ${captioned} vs blank ${blank})`);
  detail.subtitles = { filter: "subtitles (buildAssFilter, wrap_unicode=1)", fontFamily: faceFamily, blankYmax: blank, captionYmax: captioned };

  const frame = join(work, "demo-frame.png");
  await ffmpegRun(layout, ["-ss", "2", "-i", join(layout.runtime, "demo-source.mp4"), "-frames:v", "1", frame]);
  const png = await readFile(frame);
  assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === 960 && png.readUInt32BE(20) === 540, "Decoded demo frame is not a 960x540 PNG");
  detail.decodedDemoFrame = { width: 960, height: 540 };
  return warnings.length ? { warning: warnings.join("; "), detail } : detail;
}

interface ServiceResponse { ok: boolean; result?: unknown; error?: string; serviceArtifact?: { schema?: string; kind?: string; externalResearchRuntime?: string } }

/** Minimal host for the resident protocol in src/service/residentProtocol.ts. */
class ResidentService {
  private lines: string[] = [];
  private waiters: Array<() => void> = [];
  private buffer = "";
  private stderr = "";
  private sequence = 0;
  private closed = false;

  private constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk) => {
      this.buffer += String(chunk);
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        this.lines.push(this.buffer.slice(0, newline));
        this.buffer = this.buffer.slice(newline + 1);
        newline = this.buffer.indexOf("\n");
      }
      this.wake();
    });
    child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${String(chunk)}`.slice(-16_000); });
    child.on("close", () => { this.closed = true; this.wake(); });
  }

  static async start(node: string, service: string): Promise<ResidentService> {
    const child = spawn(node, [service, "--resident", "--parent-pid", String(process.pid)], { env: cleanEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
    const host = new ResidentService(child);
    const ready = JSON.parse(await host.nextLine(30_000));
    assert(ready.schema === SERVICE_SCHEMA && ready.kind === "ready" && ready.pid === child.pid, `Resident startup frame invalid: ${JSON.stringify(ready)}`);
    return host;
  }

  private wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  private async nextLine(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!this.lines.length) {
      if (this.closed) throw new Error(`Resident service exited: ${this.stderr.trim().slice(-2_000)}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Resident service response timed out; stderr: ${this.stderr.trim().slice(-2_000)}`);
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, remaining);
        this.waiters.push(() => { clearTimeout(timer); resolveWait(); });
      });
    }
    return this.lines.shift()!;
  }

  async request(command: string, payload: Record<string, unknown>, runtime: Record<string, unknown>, timeoutMs: number): Promise<ServiceResponse> {
    const id = `gate:${++this.sequence}`;
    this.child.stdin.write(`${JSON.stringify({ schema: SERVICE_SCHEMA, id, request: { command, payload, runtime } })}\n`);
    const envelope = JSON.parse(await this.nextLine(timeoutMs));
    assert(envelope.schema === SERVICE_SCHEMA && envelope.id === id && envelope.response, `Resident response envelope invalid: ${JSON.stringify(envelope).slice(0, 500)}`);
    const response = envelope.response as ServiceResponse;
    const artifact = response.serviceArtifact;
    // Same admission check as verify_product_response in src-tauri/src/service_pool.rs.
    assert(artifact?.schema === "editkin.auto-roto-service-artifact/v1" && artifact.kind === "product" && artifact.externalResearchRuntime === "disabled",
      `Service artifact is not the product service: ${JSON.stringify(artifact)}`);
    return response;
  }

  async stop(): Promise<number | null> {
    this.child.stdin.end();
    const exited = await Promise.race([
      new Promise<number | null>((resolveExit) => this.child.once("exit", (code) => resolveExit(code))),
      new Promise<"timeout">((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 10_000)),
    ]);
    if (exited === "timeout") {
      this.child.kill("SIGKILL");
      throw new Error("Resident service did not exit after stdin closed");
    }
    return exited;
  }
}

function okResult<T>(response: ServiceResponse, command: string): T {
  assert(response.ok, `${command} failed in the bundled service: ${response.error}`);
  return response.result as T;
}

/** Import → preview proxy → save/reopen → export through the bundled Node service. */
export async function residentServiceSmoke(layout: BundleLayout, work: string): Promise<Detail> {
  await mkdir(join(work, "personal-visual"), { recursive: true });
  await mkdir(join(work, "user-plugins"), { recursive: true });
  // Same keys service_request_value() sends from src-tauri/src/main.rs.
  const runtime = {
    ffmpeg: layout.ffmpeg, ffprobe: layout.ffprobe, whisperCli: layout.whisperCli, nativeCore: layout.nativeCore,
    gpuCompositor: layout.gpuCompositor, assetBase: layout.runtime, cacheRoot: join(work, "media-cache"), modelRoot: join(work, "models"),
    creativePackRoot: layout.creativePackRoot, personalMusicRoot: layout.personalMusicRoot, personalVisualRoot: join(work, "personal-visual"),
    fontRoot: layout.fontRoot, colorRoot: layout.colorRoot, pluginRoots: [layout.pluginRoot, join(work, "user-plugins")],
  };
  const service = await ResidentService.start(layout.node, layout.service);
  const detail: Record<string, unknown> = {};
  try {
    const plugins = okResult<{ plugins?: unknown[] }>(await service.request("list_installed_plugins", {}, runtime, MINUTE), "list_installed_plugins");
    detail.plugins = Array.isArray(plugins.plugins) ? plugins.plugins.length : "ok";

    const demo = join(layout.runtime, "demo-source.mp4");
    const probe = okResult<{ hasVideo: boolean; hasAudio: boolean; width?: number; height?: number; duration: number }>(await service.request("inspect_media", { path: demo }, runtime, MINUTE), "inspect_media");
    assert(probe.hasVideo && probe.hasAudio && probe.width === 960 && probe.height === 540 && Math.abs(probe.duration - 12) < 0.2, `inspect_media: ${JSON.stringify(probe)}`);
    detail.import = { width: probe.width, height: probe.height, duration: probe.duration };

    const prepared = okResult<{ derivatives: { proxyUri?: string; overlayProxyUri?: string; thumbnailUri?: string; waveformUri?: string } }>(
      await service.request("prepare_media", { sourcePath: demo, kind: "video", duration: 12, hasAudio: true, sourceHeight: 540 }, runtime, 10 * MINUTE), "prepare_media");
    assert(prepared.derivatives.proxyUri, "prepare_media returned no preview proxy");
    const proxy = await probeMedia(prepared.derivatives.proxyUri, layout.ffprobe);
    assert(proxy.codecName === "h264" && proxy.pixelFormat === "yuv420p", `Preview proxy probe: ${JSON.stringify(proxy)}`);
    detail.previewProxy = { codec: proxy.codecName, width: proxy.width, height: proxy.height, overlayProxy: Boolean(prepared.derivatives.overlayProxyUri), thumbnail: Boolean(prepared.derivatives.thumbnailUri), waveform: Boolean(prepared.derivatives.waveformUri) };

    let project = createDemoProject();
    project.width = 960;
    project.height = 540;
    project = applyCommand(project, { type: "add_caption", caption: { id: "community-gate-caption", text: "Editkin macOS 社群版 caption", start: 2, duration: 4 } });
    const projectPath = join(work, "community-gate.editkin.json");
    const saved = okResult<{ revision: number }>(await service.request("write_project", { path: projectPath, project, expectedRevision: null }, runtime, MINUTE), "write_project");
    const reopened = okResult<{ revision: number; captions: Array<{ text: string }>; assets: Array<{ uri: string }> }>(await service.request("read_project", { path: projectPath }, runtime, MINUTE), "read_project");
    assert(reopened.revision === saved.revision && reopened.captions[0]?.text === "Editkin macOS 社群版 caption" && reopened.assets[0]?.uri === "demo-source.mp4", "Reopened project differs from the saved project");
    detail.saveReopen = { revision: reopened.revision };

    const outputPath = join(work, "community-gate-export.mp4");
    const rendered = okResult<{ outputPath: string; encoder: string; planner: string; ffmpegVersion: string; duration: number }>(
      await service.request("render_project", { project: reopened, outputPath }, runtime, 30 * MINUTE), "render_project");
    const output = await probeMedia(rendered.outputPath, layout.ffprobe);
    assert(output.hasVideo && output.hasAudio && output.width === 960 && output.height === 540 && Math.abs(output.duration - 12) < 0.2, `Export probe: ${JSON.stringify(output)}`);
    detail.export = { encoder: rendered.encoder, planner: rendered.planner, ffmpegVersion: rendered.ffmpegVersion, codec: output.codecName, duration: output.duration, bytes: (await stat(rendered.outputPath)).size };

    const library = await service.request("list_creative_library", {}, runtime, MINUTE);
    detail.creativeLibrary = library.ok ? "available" : `unavailable as expected without owner packs: ${String(library.error).slice(0, 200)}`;
  } finally {
    detail.serviceExit = await service.stop();
  }
  return detail;
}

export async function nativeHelperChecks(layout: BundleLayout): Promise<Detail> {
  const engine = JSON.parse((await runTool(layout.nativeCore, ["engine-capabilities"])).stdout);
  assert(engine.schema === "editkin.engine-capabilities/v1" && engine.engine === "hao-core", "hao-core engine-capabilities identity mismatch");
  const help = await runTool(layout.whisperCli, ["--help"]);
  assert(whisperCliHasRequiredCapabilities(`${help.stdout}\n${help.stderr}`), "whisper-cli lacks language/SRT/translate flags");
  const compositor = await runTool(layout.gpuCompositor, ["probe"], { allowFailure: true, timeoutMs: MINUTE });
  return {
    haoCore: { schema: engine.schema, residentAudioPhysicalOutput: engine.residentAudio?.physicalOutput ?? null },
    whisperCli: "language/SRT/translate flags present",
    gpuCompositorProbe: { exitCode: compositor.code, stdout: compositor.stdout.trim().slice(0, 1_000), stderr: compositor.stderr.trim().slice(0, 1_000) },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const sourceIndex = args.indexOf("--source-root");
  const sourceRoot = sourceIndex >= 0 ? resolve(args.splice(sourceIndex, 2)[1]) : undefined;
  const [appArgument, reportArgument] = args;
  if (!appArgument) throw new Error("usage: npx tsx scripts/macos-community-app-gate.ts <Editkin.app> [report.json] [--source-root <repo>]");
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("The community app gate runs on Apple Silicon macOS");
  const app = resolve(appArgument);
  const layout = bundleLayout(app);
  const work = await mkdtemp(join(tmpdir(), "editkin-community-gate-"));
  const report = new GateReport();
  try {
    await report.step("bundle runtime closure and hashes", () => verifyBundleClosure(layout, sourceRoot));
    await report.step("Mach-O architecture, signature and relocation audit", () => auditMachOFiles(layout));
    await report.step("FFmpeg version, configuration and components", () => verifyFfmpegComponents(layout, { expectCommunityBuild: true }));
    await report.step("dyld loads only bundled and OS libraries", () => verifyLoadedImages(layout));
    await report.step("hao-core, whisper-cli and GPU compositor launch", () => nativeHelperChecks(layout));
    await report.step("FFmpeg encodes and filters used by Editkin", () => ffmpegFunctionalChecks(layout, join(work, "ffmpeg"), { videoToolbox: true }));
    await report.step("bundled service: import, preview proxy, save/reopen, export", () => residentServiceSmoke(layout, join(work, "service")));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const result = {
    schema: "editkin.macos-community-app-gate/v1",
    status: report.failed.length ? "BLOCK" : "GREEN",
    app,
    claimBoundary: "Verified the exact bundled runtime closure, relocatable arm64 Mach-O files, FFmpeg capabilities through Editkin's argument builders and the bundled service's import/preview/save/export path on this host. GUI behaviour, Gatekeeper, notarization and other Macs are not covered.",
    steps: report.steps,
  };
  const output = resolve(reportArgument ?? ".rd/receipts/macos-community-app-gate.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  for (const step of report.steps) process.stdout.write(`${step.status.padEnd(4)} ${step.name}${step.error ? ` — ${step.error.split("\n")[0]}` : ""}\n`);
  process.stdout.write(`${JSON.stringify({ status: result.status, report: output })}\n`);
  if (report.failed.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
