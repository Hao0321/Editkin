import { describe, expect, it } from "vitest";
import { isSupportedMediaName, partitionSupportedMedia, rejectedMediaMessage } from "./mediaDrop";

describe("workspace media drop", () => {
  it("accepts supported media extensions case-insensitively", () => {
    expect(isSupportedMediaName("C:\\素材\\直式影片.MP4")).toBe(true);
    expect(isSupportedMediaName("訪談.wav")).toBe(true);
    expect(isSupportedMediaName("封面.webp")).toBe(true);
    expect(isSupportedMediaName("C:\\VFX\\beauty-linear.EXR")).toBe(true);
    expect(isSupportedMediaName("C:\\VFX\\editkin-openexr-sequence.json")).toBe(true);
    expect(isSupportedMediaName("C:\\VFX\\random.json")).toBe(false);
  });

  it("rejects directories, project files and executable files", () => {
    const result = partitionSupportedMedia(["clip.mov", "資料夾", "專案.editkin", "setup.exe"], (item) => item);
    expect(result.supported).toEqual(["clip.mov"]);
    expect(result.rejected).toEqual(["資料夾", "專案.editkin", "setup.exe"]);
    expect(rejectedMediaMessage(result.rejected.length)).toContain("3 個檔案");
  });
});
