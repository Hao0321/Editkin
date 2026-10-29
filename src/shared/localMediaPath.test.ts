import { describe, expect, it } from "vitest";
import { assertLocalMediaPath, isWindowsNetworkPath } from "./localMediaPath";
import { analyzeSceneCuts } from "../application/sceneDetection";
import { inspectMedia } from "../application/inspectMedia";
import { analyzeAutomaticCaptionTranscript } from "../application/automaticCaptions";
import { probeMedia, resolveMediaPath } from "../render/mediaProcess";

const NETWORK_PATHS = [
  String.raw`\\host\share\clip.mp4`,
  "//host/share/clip.mp4",
  String.raw`\\?\UNC\host\share\clip.mp4`,
  "//?/UNC/host/share/clip.mp4",
  String.raw`\\.\pipe\name`,
  String.raw`\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\clip.mp4`,
  String.raw`\\?\GLOBALROOT\Device\HarddiskVolume1\clip.mp4`,
  String.raw`\??\UNC\host\share\clip.mp4`,
  String.raw`\??\C:\media\clip.mp4`,
  "/??/UNC/host/share/clip.mp4",
];

const DEVICE_NAME_PATHS = [
  String.raw`C:\media\NUL`,
  String.raw`C:\media\nul.txt`,
  String.raw`C:\x\CON`,
  String.raw`C:\media\aux.mp4`,
  String.raw`C:\media\PRN`,
  String.raw`C:\media\COM1`,
  String.raw`C:\media\com9.mp4`,
  String.raw`C:\media\LPT1`,
  String.raw`C:\media\lpt9.wav`,
  String.raw`C:\media\COM¹`,
  String.raw`C:\media\com².mp4`,
  String.raw`C:\media\COM³`,
  String.raw`C:\media\LPT¹.mp4`,
  String.raw`C:\media\lpt²`,
  String.raw`C:\media\LPT³`,
  String.raw`C:\media\CONIN$`,
  String.raw`C:\media\conout$.mp4`,
  String.raw`C:\media\nul.`,
  String.raw`C:\media\NUL .txt`,
  String.raw`C:\media\NUL `,
  String.raw`C:\media\Nul.tar.gz`,
  "C:/media/nul.mp4",
  "C:NUL",
  String.raw`C:\media\NUL:stream`,
  "nul.mp4",
  // Conservative choices: a non-final component, a verbatim path, COM0 and LPT0.
  String.raw`C:\media\NUL\clip.mp4`,
  String.raw`\\?\C:\media\NUL`,
  String.raw`C:\media\COM0.mp4`,
  String.raw`C:\media\LPT0.mp4`,
];

const LOCAL_PATHS = [
  String.raw`C:\media\clip.mp4`,
  "C:/media/clip.mp4",
  String.raw`\\?\C:\media\clip.mp4`,
  String.raw`\\?\c:`,
  "/Users/someone/clip.mp4",
  "media/clip.mp4",
  String.raw`C:\media\null.mp4`,
  String.raw`C:\media\console.mp4`,
  String.raw`C:\media\COM10.mp4`,
  String.raw`C:\media\LPT10.mp4`,
  String.raw`C:\media\clip.nul.mp4`,
  String.raw`C:\media\auxiliary\clip.mp4`,
  String.raw`C:\media\nul-cut\clip.mp4`,
];

describe("local media path guard", () => {
  it.each([...NETWORK_PATHS, ...DEVICE_NAME_PATHS])("classifies %s as a network or device path", (path) => {
    expect(isWindowsNetworkPath(path)).toBe(true);
    expect(() => assertLocalMediaPath(path, "win32")).toThrow("拒絕網路共用或裝置路徑");
  });

  it.each(LOCAL_PATHS)("keeps %s usable", (path) => {
    expect(isWindowsNetworkPath(path)).toBe(false);
    expect(() => assertLocalMediaPath(path, "win32")).not.toThrow();
  });

  it("does not reject double-slash POSIX paths", () => {
    expect(() => assertLocalMediaPath("//host/share/clip.mp4", "linux")).not.toThrow();
    expect(() => assertLocalMediaPath("//host/share/clip.mp4", "darwin")).not.toThrow();
  });

  it.each(["/Users/someone/NUL", "/media/con.mp4", "/media/COM1", String.raw`\??\C:\media\clip.mp4`])("keeps %s usable on POSIX", (path) => {
    expect(() => assertLocalMediaPath(path, "linux")).not.toThrow();
    expect(() => assertLocalMediaPath(path, "darwin")).not.toThrow();
  });

  it("refuses a UNC source before any process or file access on Windows", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const unc = String.raw`\\attacker\share\clip.mp4`;
      await expect(inspectMedia(unc, "/nonexistent/ffprobe")).rejects.toThrow("拒絕網路共用或裝置路徑");
      await expect(analyzeSceneCuts({ sourcePath: unc } as never, { ffmpegPath: "/nonexistent/ffmpeg" })).rejects.toThrow("拒絕網路共用或裝置路徑");
      await expect(probeMedia(unc, "/nonexistent/ffprobe")).rejects.toThrow("拒絕網路共用或裝置路徑");
      await expect(analyzeAutomaticCaptionTranscript({ sourcePath: unc } as never, {} as never)).rejects.toThrow("拒絕網路共用或裝置路徑");
      // node:path follows the host OS, so use the slash form that is absolute everywhere.
      expect(() => resolveMediaPath("//attacker/share/clip.mp4")).toThrow("拒絕網路共用或裝置路徑");
      expect(() => resolveMediaPath("clip.mp4", unc)).toThrow("拒絕網路共用或裝置路徑");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("refuses a DOS device name or NT object path before any process or file access on Windows", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      for (const source of [String.raw`C:\media\CON`, String.raw`C:\media\com1.mp4`, String.raw`\??\UNC\attacker\share\clip.mp4`]) {
        await expect(inspectMedia(source, "/nonexistent/ffprobe")).rejects.toThrow("拒絕網路共用或裝置路徑");
        await expect(analyzeSceneCuts({ sourcePath: source } as never, { ffmpegPath: "/nonexistent/ffmpeg" })).rejects.toThrow("拒絕網路共用或裝置路徑");
        await expect(probeMedia(source, "/nonexistent/ffprobe")).rejects.toThrow("拒絕網路共用或裝置路徑");
        await expect(analyzeAutomaticCaptionTranscript({ sourcePath: source } as never, {} as never)).rejects.toThrow("拒絕網路共用或裝置路徑");
        expect(() => resolveMediaPath(source)).toThrow("拒絕網路共用或裝置路徑");
        expect(() => resolveMediaPath("clip.mp4", source)).toThrow("拒絕網路共用或裝置路徑");
      }
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
