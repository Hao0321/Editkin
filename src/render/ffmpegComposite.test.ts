import { describe, expect, it } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, relative } from "node:path";
import { withFilterGraphArgs } from "./ffmpegComposite";

const exists = (path: string) => stat(path).then(() => true, () => false);

describe("withFilterGraphArgs", () => {
  it("passes short graphs inline without creating a script", async () => {
    let received: string[] = [];
    await withFilterGraphArgs("[0:v]null[vout]", async args => { received = args; });
    expect(received).toEqual(["-filter_complex", "[0:v]null[vout]"]);
  });

  it("writes long graphs to an exclusive private script and removes it afterwards", async () => {
    const graph = `[0:v]${"null,".repeat(3_000)}null[vout]`;
    let scriptPath = "";
    const result = await withFilterGraphArgs(graph, async ([flag, path]) => {
      expect(flag).toBe("-filter_complex_script");
      scriptPath = path;
      expect(basename(dirname(path))).toMatch(/^editkin-filtergraph-/);
      expect(relative(tmpdir(), path).startsWith("..")).toBe(false);
      expect(await readFile(path, "utf8")).toBe(graph);
      if (process.platform !== "win32") {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      }
      return "rendered";
    });
    expect(result).toBe("rendered");
    expect(await exists(dirname(scriptPath))).toBe(false);
  });

  it("removes the script directory when rendering fails", async () => {
    let scriptPath = "";
    await expect(withFilterGraphArgs("x".repeat(9_000), async ([, path]) => {
      scriptPath = path;
      throw new Error("ffmpeg failed");
    })).rejects.toThrow("ffmpeg failed");
    expect(scriptPath).not.toBe("");
    expect(await exists(dirname(scriptPath))).toBe(false);
  });
});
