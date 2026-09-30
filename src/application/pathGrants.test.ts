import { describe, expect, it } from "vitest";
import { assertProjectFilePath, isWithinRoot, PathGrants, projectMediaPaths } from "./pathGrants";

describe("PathGrants", () => {
  it("only accepts absolute paths that were granted", () => {
    const grants = new PathGrants("linux");
    grants.grant("/media/clip.mp4");
    expect(grants.has("/media/clip.mp4")).toBe(true);
    expect(grants.has("/media/./clip.mp4")).toBe(true);
    expect(grants.has("/media/other.mp4")).toBe(false);
    expect(grants.has("/media/../etc/passwd")).toBe(false);
    expect(grants.has("clip.mp4")).toBe(false);
    expect(grants.has(undefined)).toBe(false);
    expect(() => grants.assertGranted("/etc/passwd", "never selected")).toThrow("never selected");
  });

  it("matches case-insensitively only on Windows", () => {
    const windows = new PathGrants("win32");
    windows.grant("C:\\Media\\Clip.MP4");
    expect(windows.has("c:\\media\\clip.mp4")).toBe(true);
    const posix = new PathGrants("linux");
    posix.grant("/Media/Clip.mp4");
    expect(posix.has("/media/clip.mp4")).toBe(false);
  });

  it("stays bounded by evicting the oldest grant", () => {
    const grants = new PathGrants("linux");
    for (let index = 0; index <= 10_000; index += 1) grants.grant(`/m/${index}.mp4`);
    expect(grants.has("/m/0.mp4")).toBe(false);
    expect(grants.has("/m/10000.mp4")).toBe(true);
  });
});

describe("project file path guard", () => {
  it("accepts only .editkin.json and .haoedit.json", () => {
    expect(() => assertProjectFilePath("/p/Demo.editkin.json")).not.toThrow();
    expect(() => assertProjectFilePath("/p/Demo.HAOEDIT.JSON")).not.toThrow();
    for (const path of ["/p/.bashrc", "/p/notes.json", "/p/Demo.editkin.json.lock", "/p/a.exe"]) {
      expect(() => assertProjectFilePath(path)).toThrow("副檔名");
    }
  });
});

describe("helpers", () => {
  it("keeps derived files inside their root", () => {
    expect(isWithinRoot("/cache", "/cache/a/proxy.mp4")).toBe(true);
    expect(isWithinRoot("/cache", "/cache/../etc/passwd")).toBe(false);
    expect(isWithinRoot("/cache", "/cache")).toBe(false);
  });

  it("collects only absolute asset locations from a loaded project", () => {
    expect(projectMediaPaths([{ uri: "/m/a.mp4" }, { uri: "creative://pack/asset" }, { uri: "local://x" }, { uri: "rel/b.mp4" }])).toEqual(["/m/a.mp4"]);
  });
});
