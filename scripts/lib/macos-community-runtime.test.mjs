import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAssFilter } from "../../src/render/captionAss";
import {
  APP_RUNTIME_ENTRYPOINTS,
  auditBundledMachO,
  COMMUNITY_FFMPEG,
  COMMUNITY_FFMPEG_CONFIGURE_ARGS,
  COMMUNITY_FONT_PACK_DIRECTORY,
  COMMUNITY_FONTTOOLS,
  COMMUNITY_NODE,
  COMMUNITY_OMITTED_RUNTIME_FILES,
  COMMUNITY_WHISPER_CPP,
  compareMacOSVersions,
  disallowedLoadedImages,
  effectiveMinimumMacOS,
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
} from "./macos-community-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

function loadCommandsText({ id, dependencies = [], weak = [], rpaths = [], minos = "15.0" }) {
  const lines = ["/some/file:", "Load command 0", "      cmd LC_SEGMENT_64", "  cmdsize 72", "  segname __PAGEZERO"];
  let index = 1;
  const command = (name, body) => {
    lines.push(`Load command ${index++}`, `          cmd ${name}`, "      cmdsize 56", ...body);
  };
  if (id) command("LC_ID_DYLIB", [`         name ${id} (offset 24)`, "   time stamp 1 Thu Jan  1 00:00:01 1970", "      current version 164.0.0", "compatibility version 164.0.0"]);
  lines.push(`Load command ${index++}`, "      cmd LC_BUILD_VERSION", "  cmdsize 32", " platform 1", `    minos ${minos}`, "      sdk 15.2", "   ntools 1", "     tool 3", "  version 1115.7.3");
  for (const name of dependencies) command("LC_LOAD_DYLIB", [`         name ${name} (offset 24)`, "   time stamp 2 Thu Jan  1 00:00:02 1970", "      current version 1.0.0", "compatibility version 1.0.0"]);
  for (const name of weak) command("LC_LOAD_WEAK_DYLIB", [`         name ${name} (offset 24)`, "      current version 1.0.0", "compatibility version 1.0.0"]);
  for (const path of rpaths) command("LC_RPATH", [`         path ${path} (offset 12)`]);
  lines.push(`Load command ${index++}`, "      cmd LC_SOURCE_VERSION", "  cmdsize 16", "  version 0.0");
  return lines.join("\n");
}

describe("community macOS runtime pins", () => {
  it("reuses the owner's Node.js and whisper.cpp pins", () => {
    const stager = read("scripts/stage-platform-runtime.mjs");
    const gate = read("scripts/macos-bundle-runtime-gate.mjs");
    expect(stager).toContain(`const NODE_VERSION = "${COMMUNITY_NODE.version}"`);
    expect(stager).toContain(`sha256: "${COMMUNITY_NODE.sha256}"`);
    expect(COMMUNITY_NODE.url).toBe(`https://nodejs.org/dist/v${COMMUNITY_NODE.version}/${COMMUNITY_NODE.archive}`);
    for (const value of [COMMUNITY_WHISPER_CPP.version, COMMUNITY_WHISPER_CPP.commit, COMMUNITY_WHISPER_CPP.archiveSha256, COMMUNITY_WHISPER_CPP.sourceUrl]) {
      expect(stager).toContain(value);
    }
    expect(stager).toContain("archiveBytes: 9_627_120");
    expect(COMMUNITY_WHISPER_CPP.archiveBytes).toBe(9_627_120);
    expect(gate).toContain(`commit: "${COMMUNITY_WHISPER_CPP.commit}"`);
    expect(gate).toContain(`sourceArchiveSha256: "${COMMUNITY_WHISPER_CPP.archiveSha256}"`);
  });

  it("keeps the owner's PLATFORM-MANIFEST file set minus the omitted files, and the macOS resource mapping", () => {
    const gate = read("scripts/macos-bundle-runtime-gate.mjs");
    const block = /const REQUIRED_FILES = \[([\s\S]*?)\];/u.exec(gate)?.[1] ?? "";
    const owner = [...block.matchAll(/"([^"]+)"/gu)].map((match) => match[1]).sort();
    expect([...PLATFORM_RUNTIME_FILES, ...COMMUNITY_OMITTED_RUNTIME_FILES].sort()).toEqual(owner);
    expect(PLATFORM_RUNTIME_FILES.some((name) => COMMUNITY_OMITTED_RUNTIME_FILES.includes(name))).toBe(false);
    const resources = JSON.parse(read("src-tauri/tauri.macos.conf.json")).bundle.resources;
    for (const name of owner) expect(resources[`../.platform-runtime/${name}`]).toBe(`runtime/${name}`);
    const overlay = JSON.parse(read("src-tauri/tauri.macos.community.conf.json")).bundle.resources;
    for (const name of COMMUNITY_OMITTED_RUNTIME_FILES) expect(overlay[`../.platform-runtime/${name}`]).toBeNull();
    expect(resources["../.platform-runtime/manifest.json"]).toBe("runtime/PLATFORM-MANIFEST.json");
  });

  it("pins FFmpeg, fontTools and a closed configure line", () => {
    expect(COMMUNITY_FFMPEG.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(COMMUNITY_FFMPEG.signingKeyFingerprint).toMatch(/^[A-F0-9]{40}$/u);
    expect(COMMUNITY_FFMPEG.urls.every((url) => url.endsWith(".tar.xz") && url.includes(COMMUNITY_FFMPEG.version))).toBe(true);
    expect(COMMUNITY_FONTTOOLS.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(COMMUNITY_FONTTOOLS.url.endsWith(`/${COMMUNITY_FONTTOOLS.wheel}`)).toBe(true);
    expect(COMMUNITY_FONTTOOLS.wheel).toMatch(/-py3-none-any\.whl$/u);
    expect(COMMUNITY_FFMPEG_CONFIGURE_ARGS).toContain("--disable-autodetect");
    expect(COMMUNITY_FFMPEG_CONFIGURE_ARGS).toContain("--enable-gpl");
    expect(COMMUNITY_FFMPEG_CONFIGURE_ARGS.some((arg) => (arg.includes("whisper") || arg.includes("nonfree") || arg.endsWith("shared")) && !arg.startsWith("--disable-"))).toBe(false);
    expect(REQUIRED_FFMPEG_CONFIG_SYMBOLS).toEqual(expect.arrayContaining(["CONFIG_LIBX264", "CONFIG_ZSCALE_FILTER", "CONFIG_SUBTITLES_FILTER", "CONFIG_H264_VIDEOTOOLBOX_ENCODER"]));
  });
});

describe("Mach-O helpers", () => {
  it("parses install names, dependencies, rpaths and the macOS minimum", () => {
    const parsed = parseMachOLoadCommands(loadCommandsText({
      id: "/opt/homebrew/opt/x264/lib/libx264.164.dylib",
      dependencies: ["/usr/lib/libSystem.B.dylib", "@rpath/libfoo.1.dylib"],
      weak: ["/System/Library/Frameworks/Metal.framework/Versions/A/Metal"],
      rpaths: ["@loader_path/../lib"],
      minos: "15.0",
    }));
    expect(parsed).toEqual({
      id: "/opt/homebrew/opt/x264/lib/libx264.164.dylib",
      dependencies: ["/usr/lib/libSystem.B.dylib", "@rpath/libfoo.1.dylib", "/System/Library/Frameworks/Metal.framework/Versions/A/Metal"],
      rpaths: ["@loader_path/../lib"],
      minimumMacOS: "15.0",
    });
    const legacy = parseMachOLoadCommands("Load command 3\n      cmd LC_VERSION_MIN_MACOSX\n  cmdsize 16\n  version 10.13\n      sdk 10.14\n");
    expect(legacy.minimumMacOS).toBe("10.13");
  });

  it("recognises Mach-O magic and lipo output", () => {
    expect(isMachO(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))).toBe(true);
    expect(isMachO(Buffer.from([0xca, 0xfe, 0xba, 0xbe]))).toBe(true);
    expect(isMachO(Buffer.from("OTTO"))).toBe(false);
    expect(isMachO(Buffer.from([0xcf]))).toBe(false);
    expect(parseLipoArchitectures("arm64\n")).toEqual(["arm64"]);
    expect(parseLipoArchitectures("x86_64 arm64")).toEqual(["arm64", "x86_64"]);
  });

  it("plans a flat @loader_path closure through absolute and @rpath references", async () => {
    const cellar = "/opt/homebrew/Cellar";
    const real = new Map([
      ["/build/ffmpeg", "/build/ffmpeg"],
      ["/build/ffprobe", "/build/ffprobe"],
      ["/opt/homebrew/opt/x264/lib/libx264.164.dylib", `${cellar}/x264/r3222/lib/libx264.164.dylib`],
      ["/opt/homebrew/opt/libass/lib/libass.9.dylib", `${cellar}/libass/0.17.4/lib/libass.9.dylib`],
      ["/opt/homebrew/opt/dav1d/lib/libdav1d.7.dylib", `${cellar}/dav1d/1.5.1/lib/libdav1d.7.dylib`],
      ["/opt/homebrew/opt/freetype/lib/libfreetype.6.dylib", `${cellar}/freetype/2.13.3/lib/libfreetype.6.dylib`],
      ["/opt/homebrew/opt/libpng/lib/libpng16.16.dylib", `${cellar}/libpng/1.6.50/lib/libpng16.16.dylib`],
      [`${cellar}/libunibreak/6.1/lib/libunibreak.6.dylib`, `${cellar}/libunibreak/6.1/lib/libunibreak.6.dylib`],
    ]);
    for (const value of [...real.values()]) real.set(value, value);
    const graph = {
      "/build/ffmpeg": { dependencies: ["/opt/homebrew/opt/x264/lib/libx264.164.dylib", "/opt/homebrew/opt/libass/lib/libass.9.dylib", "/usr/lib/libSystem.B.dylib", "/System/Library/Frameworks/VideoToolbox.framework/Versions/A/VideoToolbox"], rpaths: [] },
      "/build/ffprobe": { dependencies: ["/opt/homebrew/opt/libass/lib/libass.9.dylib", "/opt/homebrew/opt/dav1d/lib/libdav1d.7.dylib", "/usr/lib/libSystem.B.dylib"], rpaths: [] },
      [`${cellar}/x264/r3222/lib/libx264.164.dylib`]: { id: "/opt/homebrew/opt/x264/lib/libx264.164.dylib", dependencies: ["/usr/lib/libSystem.B.dylib"], rpaths: [] },
      [`${cellar}/libass/0.17.4/lib/libass.9.dylib`]: { id: "/opt/homebrew/opt/libass/lib/libass.9.dylib", dependencies: ["/opt/homebrew/opt/freetype/lib/libfreetype.6.dylib", "@rpath/libunibreak.6.dylib"], rpaths: ["@loader_path/../../../libunibreak/6.1/lib"] },
      [`${cellar}/dav1d/1.5.1/lib/libdav1d.7.dylib`]: { id: "@rpath/libdav1d.7.dylib", dependencies: [], rpaths: [] },
      [`${cellar}/freetype/2.13.3/lib/libfreetype.6.dylib`]: { id: "/opt/homebrew/opt/freetype/lib/libfreetype.6.dylib", dependencies: ["/opt/homebrew/opt/libpng/lib/libpng16.16.dylib", "/usr/lib/libz.1.dylib"], rpaths: [] },
      [`${cellar}/libpng/1.6.50/lib/libpng16.16.dylib`]: { id: "/opt/homebrew/opt/libpng/lib/libpng16.16.dylib", dependencies: [], rpaths: [] },
      [`${cellar}/libunibreak/6.1/lib/libunibreak.6.dylib`]: { id: "@rpath/libunibreak.6.dylib", dependencies: [], rpaths: [] },
    };
    const plan = await planLoaderPathClosure({
      roots: ["/build/ffmpeg", "/build/ffprobe"],
      inspect: async (path) => ({ id: undefined, minimumMacOS: undefined, ...graph[path] }),
      realpath: async (path) => real.get(path),
    });
    expect(plan.libraries.map((library) => library.name)).toEqual([
      "libass.9.dylib", "libdav1d.7.dylib", "libfreetype.6.dylib", "libpng16.16.dylib", "libunibreak.6.dylib", "libx264.164.dylib",
    ]);
    const edits = Object.fromEntries(plan.edits.map((edit) => [edit.source, edit]));
    expect(edits["/build/ffmpeg"]).toMatchObject({ role: "root", changes: [
      ["/opt/homebrew/opt/x264/lib/libx264.164.dylib", "@loader_path/lib/libx264.164.dylib"],
      ["/opt/homebrew/opt/libass/lib/libass.9.dylib", "@loader_path/lib/libass.9.dylib"],
    ], deleteRpaths: [] });
    expect(edits[`${cellar}/libass/0.17.4/lib/libass.9.dylib`]).toMatchObject({
      role: "library", name: "libass.9.dylib", id: "@loader_path/libass.9.dylib",
      changes: [["/opt/homebrew/opt/freetype/lib/libfreetype.6.dylib", "@loader_path/libfreetype.6.dylib"], ["@rpath/libunibreak.6.dylib", "@loader_path/libunibreak.6.dylib"]],
      deleteRpaths: ["@loader_path/../../../libunibreak/6.1/lib"],
    });
    expect(installNameToolArguments(edits[`${cellar}/libass/0.17.4/lib/libass.9.dylib`])).toEqual([
      "-id", "@loader_path/libass.9.dylib",
      "-change", "/opt/homebrew/opt/freetype/lib/libfreetype.6.dylib", "@loader_path/libfreetype.6.dylib",
      "-change", "@rpath/libunibreak.6.dylib", "@loader_path/libunibreak.6.dylib",
      "-delete_rpath", "@loader_path/../../../libunibreak/6.1/lib",
    ]);
    expect(plan.libraries.find((library) => library.name === "libass.9.dylib").installNames).toEqual(["/opt/homebrew/opt/libass/lib/libass.9.dylib"]);
    expect(plan.edits.filter((edit) => edit.source === `${cellar}/libass/0.17.4/lib/libass.9.dylib`)).toHaveLength(1);
  });

  it("refuses unresolved dependencies and bundled-name collisions", async () => {
    const inspect = async (path) => ({
      "/build/ffmpeg": { dependencies: ["/opt/homebrew/opt/a/lib/libz.1.dylib", "/opt/homebrew/opt/b/lib/libz.1.dylib"], rpaths: [] },
      "/opt/homebrew/Cellar/a/1/lib/libz.1.dylib": { id: "/opt/homebrew/opt/a/lib/libz.1.dylib", dependencies: [], rpaths: [] },
      "/opt/homebrew/Cellar/b/1/lib/libz.1.dylib": { id: "/opt/homebrew/opt/b/lib/libz.1.dylib", dependencies: [], rpaths: [] },
    })[path];
    const realpath = async (path) => ({
      "/build/ffmpeg": "/build/ffmpeg",
      "/opt/homebrew/opt/a/lib/libz.1.dylib": "/opt/homebrew/Cellar/a/1/lib/libz.1.dylib",
      "/opt/homebrew/opt/b/lib/libz.1.dylib": "/opt/homebrew/Cellar/b/1/lib/libz.1.dylib",
    })[path];
    await expect(planLoaderPathClosure({ roots: ["/build/ffmpeg"], inspect, realpath })).rejects.toThrow(/share the bundled name libz\.1\.dylib/u);
    await expect(planLoaderPathClosure({
      roots: ["/build/ffmpeg"],
      inspect: async () => ({ dependencies: ["@rpath/libmissing.dylib"], rpaths: ["/nowhere"] }),
      realpath: async (path) => (path === "/build/ffmpeg" ? path : undefined),
    })).rejects.toThrow(/Cannot resolve @rpath\/libmissing\.dylib/u);
  });

  it("audits relocated binaries and rejects host references", () => {
    const runtime = "/App/Editkin.app/Contents/Resources/runtime";
    const present = new Set([`${runtime}/lib/libx264.164.dylib`, `${runtime}/lib/libass.9.dylib`]);
    const exists = (path) => present.has(path);
    expect(auditBundledMachO({ file: `${runtime}/ffmpeg`, bundleRoot: runtime, exists, loadCommands: {
      dependencies: ["@loader_path/lib/libx264.164.dylib", "/usr/lib/libSystem.B.dylib"], rpaths: [] } })).toEqual([]);
    expect(auditBundledMachO({ file: `${runtime}/lib/libass.9.dylib`, bundleRoot: runtime, exists, loadCommands: {
      id: "@loader_path/libass.9.dylib", dependencies: ["@loader_path/libx264.164.dylib"], rpaths: ["@loader_path/../lib", "/usr/lib/swift"] } })).toEqual([]);
    const findings = auditBundledMachO({ file: `${runtime}/lib/libass.9.dylib`, bundleRoot: runtime, exists, loadCommands: {
      id: "/opt/homebrew/opt/libass/lib/libass.9.dylib",
      dependencies: ["/opt/homebrew/opt/freetype/lib/libfreetype.6.dylib", "@loader_path/libmissing.dylib", "@loader_path/../../../../escape.dylib", "@rpath/libfoo.dylib", "/usr/local/lib/libbar.dylib"],
      rpaths: ["/opt/homebrew/lib", "/private/var/folders/x/build"],
    }, buildRoots: ["/private/var/folders/x"] });
    expect(findings.join("\n")).toMatch(/libfreetype.*host path \/opt\/homebrew/u);
    expect(findings.join("\n")).toMatch(/libmissing.dylib: missing bundled file/u);
    expect(findings.join("\n")).toMatch(/escape.dylib: escapes/u);
    expect(findings.join("\n")).toMatch(/@rpath\/libfoo.dylib: unresolved @rpath/u);
    expect(findings.join("\n")).toMatch(/libbar.dylib: host path \/usr\/local/u);
    expect(findings.join("\n")).toMatch(/LC_RPATH \/opt\/homebrew\/lib/u);
    expect(findings.join("\n")).toMatch(/LC_RPATH \/private\/var\/folders\/x\/build: .*build directory/u);
    expect(findings.join("\n")).toMatch(/LC_ID_DYLIB \/opt\/homebrew/u);
  });

  it("reads Homebrew kegs, licenses, dyld traces and macOS minimums", () => {
    expect(homebrewKegFromPath("/opt/homebrew/Cellar/x265/4.1/lib/libx265.215.dylib")).toEqual({
      prefix: "/opt/homebrew", formula: "x265", version: "4.1", kegRoot: "/opt/homebrew/Cellar/x265/4.1",
    });
    expect(homebrewKegFromPath("/usr/local/lib/libfoo.dylib")).toBeUndefined();
    expect(["COPYING", "COPYING.LGPLv2.1", "LICENSE.md", "LICENCE", "NOTICE", "AUTHORS"].every(isHomebrewLicenseFile)).toBe(true);
    expect(["README.md", "INSTALL_RECEIPT.json", "LICENSES", "lib"].some(isHomebrewLicenseFile)).toBe(false);
    const trace = [
      "dyld[123]: <8F3C2B4A-1111-2222-3333-444455556666> /App/runtime/ffmpeg",
      "dyld[123]: /App/runtime/lib/libx264.164.dylib",
      "dyld[123]: <AAAA> /usr/lib/libSystem.B.dylib",
      "dyld[123]: <BBBB> /System/Library/Frameworks/VideoToolbox.framework/Versions/A/VideoToolbox",
      "dyld[123]: <CCCC> /opt/homebrew/Cellar/x264/r3222/lib/libx264.164.dylib",
      "dyld[123]: Library not loaded: @loader_path/lib/libfoo.dylib",
      "ffmpeg version 8.1.2",
    ].join("\n");
    const images = parseDyldPrintedLibraries(trace);
    expect(images).toHaveLength(5);
    expect(disallowedLoadedImages(images, ["/App/runtime"])).toEqual(["/opt/homebrew/Cellar/x264/r3222/lib/libx264.164.dylib"]);
    expect(compareMacOSVersions("15.0", "12.0")).toBe(1);
    expect(compareMacOSVersions("12", "12.0.0")).toBe(0);
    expect(compareMacOSVersions("10.13", "11.0")).toBe(-1);
    expect(maxMacOSVersion(["11.0", "15.0", "12.0", undefined])).toBe("15.0");
    expect(maxMacOSVersion([])).toBeUndefined();
    expect(effectiveMinimumMacOS("12.0", "15.0")).toBe("15.0");
    expect(effectiveMinimumMacOS("12.0", "11.0")).toBe("12.0");
    expect(effectiveMinimumMacOS("12.0", undefined)).toBe("12.0");
  });
});

describe("FFmpeg inventory parsers", () => {
  // Formats copied from fftools/opt_common.c printf calls (6.x and 8.x).
  const encoders = [
    "Encoders:", " V..... = Video", " A..... = Audio", " S..... = Subtitle", " .F.... = Frame-level multithreading",
    " ..S... = Slice-level multithreading", " ...X.. = Codec is experimental", " ....B. = Supports draw_horiz_band",
    " .....D = Supports direct rendering method 1", " ------",
    " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)",
    " V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)",
    " VFS... prores_ks            Apple ProRes (iCodec Pro) (codec prores)",
    " A....D aac                  AAC (Advanced Audio Coding)",
    " S..... ass                  ASS (Advanced SubStation Alpha) subtitle",
  ].join("\n");
  const filters8 = [
    "Filters:", "  T.. = Timeline support", "  .S. = Slice threading", "  A = Audio input/output", "  V = Video input/output",
    "  N = Dynamic number and/or type of input/output", "  | = Source or sink filter", "  ------",
    " .. abench            A->A       Benchmark part of a filtergraph.",
    " .S zscale            V->V       Apply resizing, colorspace and bit depth conversion.",
    " .. sidechaincompress AA->A      Sidechain compressor.",
    " .. color             |->V       Provide an uniformly colored input.",
    " .. amix              N->A       Audio mixing.",
  ].join("\n");
  const filters6 = [
    "Filters:", "  T.. = Timeline support", "  .S. = Slice threading", "  ..C = Command support", "  A = Audio input/output",
    " ..C acompressor       A->A       Audio compressor.",
    " .SC zscale            V->V       Apply resizing, colorspace and bit depth conversion.",
    " ... subtitles         V->V       Render text subtitles onto input video using the libass library.",
  ].join("\n");
  const devices = ["Devices:", " D. = Demuxing supported", " .E = Muxing supported", " ---", " D  lavfi           Libavfilter virtual input device", " DE audiotoolbox    AudioToolbox output device"].join("\n");
  const demuxers8 = ["Formats:", " D.. = Demuxing supported", " .E. = Muxing supported", " ..d = Is a device", " ---",
    " D d lavfi           Libavfilter virtual input device", " D   mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV", " D   matroska,webm   Matroska / WebM"].join("\n");
  const muxers6 = ["File formats:", " D. = Demuxing supported", " .E = Muxing supported", " --", "  E mp4             MP4 (MPEG-4 Part 14)", "  E null            raw null video"].join("\n");

  it("parses encoder, decoder, filter, device and format inventories", () => {
    expect([...parseCodecList(encoders)]).toEqual(["libx264", "h264_videotoolbox", "prores_ks", "aac", "ass"]);
    expect([...parseFilterList(filters8)]).toEqual(["abench", "zscale", "sidechaincompress", "color", "amix"]);
    expect([...parseFilterList(filters6)]).toEqual(["acompressor", "zscale", "subtitles"]);
    expect([...parseFormatList(devices)]).toEqual(["lavfi", "audiotoolbox"]);
    expect([...parseFormatList(demuxers8)]).toEqual(["lavfi", "mov", "mp4", "m4a", "3gp", "3g2", "mj2", "matroska", "webm"]);
    expect([...parseFormatList(muxers6)]).toEqual(["mp4", "null"]);
    expect(missingNames(["libx264", "libx265"], parseCodecList(encoders))).toEqual(["libx265"]);
  });

  it("reads version, configuration and config.h symbols", () => {
    const version = "ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with Apple clang version 17.0.0\nconfiguration: --prefix=/opt/editkin-community-ffmpeg --enable-gpl --enable-libx264\nlibavutil      60. 26.100 / 60. 26.100\n";
    expect(ffmpegVersionLine(version)).toBe("ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers");
    expect(ffmpegConfigurationLine(version)).toBe("--prefix=/opt/editkin-community-ffmpeg --enable-gpl --enable-libx264");
    expect(ffmpegConfigurationLine("no configuration here")).toBe("");
    expect([...enabledConfigSymbols("#define CONFIG_LIBX264 1\n#define CONFIG_LIBFDK_AAC 0\n#define CONFIG_ZSCALE_FILTER 1\n")]).toEqual(["CONFIG_LIBX264", "CONFIG_ZSCALE_FILTER"]);
  });

  it("escapes filter paths exactly like Editkin's caption renderer", () => {
    for (const [ass, fonts] of [
      ["/tmp/editkin/captions.ass", "/Applications/Editkin.app/Contents/Resources/font-packs/editkin-open-fonts/render"],
      ["/Users/a b/it's [x],y;z:1.ass", "C:\\Fonts\\Edit kin"],
      ["/tmp/tab\there/new\nline/nbsp\u00a0/ideo\u3000/\u5b57\u5e55 'q'.ass", "D:\\a\\b's;[c],d=e:f"],
    ]) {
      expect(`subtitles=filename=${escapeFilterOptionPath(ass)}:fontsdir=${escapeFilterOptionPath(fonts)}:wrap_unicode=1`).toBe(buildAssFilter(ass, fonts));
    }
  });
});

describe("font pack and bundle configuration", () => {
  const face = (id, weight, sha256 = "a".repeat(64)) => ({ weight, file: `render/EditkinFace-${id}-${weight}.ttf`, bytes: 10, sha256 });
  const manifest = {
    schemaVersion: 2,
    fonts: [{ id: "noto-sans-tc", file: "NotoSansTC[wght].ttf", bytes: 5, sha256: "b".repeat(64), faces: [face("noto-sans-tc", 400), face("noto-sans-tc", 800)] }],
    staticFaceProvenance: { file: "static-face-provenance.json", sha256: "c".repeat(64) },
  };
  const files = {
    "NotoSansTC[wght].ttf": { bytes: 5, sha256: "b".repeat(64) },
    "render/EditkinFace-noto-sans-tc-400.ttf": { bytes: 10, sha256: "a".repeat(64) },
    "render/EditkinFace-noto-sans-tc-800.ttf": { bytes: 10, sha256: "a".repeat(64) },
    "static-face-provenance.json": { bytes: 3, sha256: "c".repeat(64) },
  };

  it("checks every static face the way the renderer verifies requested faces", () => {
    expect(fontPackFindings(manifest, files)).toEqual([]);
    expect(fontPackFindings(manifest, { ...files, "render/EditkinFace-noto-sans-tc-800.ttf": undefined })).toEqual(["render/EditkinFace-noto-sans-tc-800.ttf: missing"]);
    expect(fontPackFindings(manifest, { ...files, "render/EditkinFace-noto-sans-tc-400.ttf": { bytes: 10, sha256: "d".repeat(64) } })[0]).toMatch(/SHA-256 differs/u);
    expect(fontPackFindings({ ...manifest, schemaVersion: 1 }, files)).toEqual(["font manifest is not schema 2"]);
    expect(fontPackFindings({ ...manifest, staticFaceProvenance: { file: "static-face-provenance.json", sha256: "e".repeat(64) } }, files)).toEqual(["static-face-provenance.json missing or changed"]);
  });

  it("documents why the published font pack cannot be bundled as is", () => {
    const published = JSON.parse(read("public/fonts/editkin-open-fonts.json"));
    const present = Object.fromEntries(readdirSync(join(root, "public/fonts")).map((name) => [name, { bytes: 0, sha256: "" }]));
    expect(fontPackFindings(published, present).some((finding) => finding.startsWith("render/") && finding.endsWith("missing"))).toBe(true);
    expect(existsSync(join(root, "scripts/build-static-font-pack.py"))).toBe(true);
  });

  it("maps every file the release runtime resolves and nothing from owner-only roots", () => {
    // JSON Merge Patch (RFC 7396), as tauri applies --config files.
    const merge = (target, patch) => {
      for (const [key, value] of Object.entries(patch)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        if (value === null) delete target[key];
        else if (typeof value === "object" && !Array.isArray(value) && typeof target[key] === "object" && target[key] && !Array.isArray(target[key])) merge(target[key], value);
        else target[key] = value;
      }
      return target;
    };
    const overlay = JSON.parse(read("src-tauri/tauri.macos.community.conf.json"));
    const config = merge(merge(JSON.parse(read("src-tauri/tauri.conf.json")), JSON.parse(read("src-tauri/tauri.macos.conf.json"))), overlay);
    const resources = config.bundle.resources;
    const destinations = new Map(Object.entries(resources).map(([source, destination]) => [destination, source]));
    for (const runtimeFile of [...PLATFORM_RUNTIME_FILES.filter((name) => name !== "manifest.json"), ...APP_RUNTIME_ENTRYPOINTS]) {
      expect(destinations.has(`runtime/${runtimeFile}`), runtimeFile).toBe(true);
    }
    for (const omitted of COMMUNITY_OMITTED_RUNTIME_FILES) expect(destinations.has(`runtime/${omitted}`), omitted).toBe(false);
    for (const destination of ["agent-runtime-v3/launcher.mjs", "agent-runtime-v3/agent-setup-contract.json", "agent-runtime-v3/lib/regular-file.mjs",
      "color/aces2", "plugins", "runtime/lib", "runtime/licenses", "runtime/FFMPEG-PROVENANCE.json", "runtime/COMMUNITY-BUILD-NOTICE.txt"]) {
      expect(destinations.has(destination), destination).toBe(true);
    }
    expect(destinations.get("font-packs/editkin-open-fonts")).toBe(`../.platform-runtime/${COMMUNITY_FONT_PACK_DIRECTORY}`);
    expect(resources["../public/fonts"]).toBeUndefined();
    for (const source of Object.keys(resources)) {
      expect(source.startsWith("../.creative-packs") || source.startsWith("../.personal-packs") || source.startsWith("../vendor")).toBe(false);
      if (!source.startsWith("../.platform-runtime/") && !source.startsWith("../desktop-dist/")) expect(existsSync(join(root, "src-tauri", source)), source).toBe(true);
    }
    const launcherImports = [...read("scripts/editkin-product-mcp-launcher.mjs").matchAll(/from\s+"(\.\.?\/[^"]+)"/gu)].map((match) => match[1]);
    for (const specifier of launcherImports) expect(destinations.has(posix.join("agent-runtime-v3", specifier)), specifier).toBe(true);
    expect(config.bundle.targets).toEqual(["app", "dmg"]);
    expect(config.bundle.macOS).toMatchObject({ minimumSystemVersion: "12.0", signingIdentity: "-" });
    expect(config.build.beforeBuildCommand).toBe("");
    expect(config.identifier).toBe("studio.hao.editkin");
  });

  it("keeps the workflow inside the repository's CI policy", () => {
    const workflow = read(".github/workflows/macos-community-desktop.yml");
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/mu);
    expect(workflow).not.toMatch(/pull_request_target|workflow_run|secrets\.|contents:\s*write|id-token/u);
    const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)/gmu)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/u);
    const pinned = new Set([...read(".github/workflows/source-ci.yml").matchAll(/uses:\s*(\S+)/gu)].map((match) => match[1]));
    for (const action of uses) expect(pinned.has(action), action).toBe(true);
    expect(workflow).toContain("github.actor_id == '126182090'");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    for (const path of [".github/workflows/macos-community-desktop.yml", "scripts/stage-macos-community-runtime.mjs", "scripts/macos-community-app-gate.ts", "scripts/lib/macos-community-runtime.mjs", "src-tauri/tauri.macos.community.conf.json"]) {
      expect(workflow).toContain(`      - ${path}`);
      expect(existsSync(join(root, path)), path).toBe(true);
    }
  });
});
