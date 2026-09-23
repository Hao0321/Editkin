import { describe, expect, it } from "vitest";
import { runProcess, resolveMediaPath } from "./mediaProcess";

describe("leaf media process runner", () => {
  it("collects the final stdout bytes before resolving", async () => {
    const result = await runProcess(process.execPath,["-e","process.stdout.write('x'.repeat(90000));process.stdout.write('FINAL');process.stderr.write('tail')"],5000);
    expect(result.stdout).toHaveLength(90005); expect(result.stdout.endsWith("FINAL")).toBe(true); expect(result.stderr).toBe("tail");
  });
  it("reports a timeout after the owned child closes", async () => {
    await expect(runProcess(process.execPath,["-e","setInterval(()=>{},1000)"],100)).rejects.toThrow("逾時");
  });
  it("rejects unsuccessful exit and keeps bounded diagnostics", async () => {
    await expect(runProcess(process.execPath,["-e","process.stderr.write('known failure');process.exitCode=7"],5000)).rejects.toThrow("exit 7: known failure");
  });
  it("has no browser-local URI fallback", () => {
    expect(()=>resolveMediaPath("local://test","D:/assets")).toThrow("瀏覽器");
    expect(()=>resolveMediaPath("movie.mov")).toThrow("無法解析");
  });
});
