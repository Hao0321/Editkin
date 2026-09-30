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
];

const LOCAL_PATHS = [
  String.raw`C:\media\clip.mp4`,
  "C:/media/clip.mp4",
  String.raw`\\?\C:\media\clip.mp4`,
  String.raw`\\?\c:`,
  "/Users/someone/clip.mp4",
  "media/clip.mp4",
];

describe("local media path guard", () => {
  it.each(NETWORK_PATHS)("classifies %s as a network or device path", (path) => {
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
});
