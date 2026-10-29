import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runAnalysisProcess } from "./analysisProcess";
describe("bounded analysis stream observers", () => {
  it("hashes stdout without retaining a second raw sequence in memory", async () => {
    const hash = createHash("sha256"); let bytes = 0; const progress: string[] = [];
    const result = await runAnalysisProcess(process.execPath, ["-e", "process.stderr.write('ROTO_V2_PROGRESS 1/1\\n');process.stdout.write(Buffer.alloc(4096,7))"],
      { label: "hash-control", timeoutMs: 3000, maximumStdout: 4096, captureStdout: false,
        onStdout: chunk => { bytes += chunk.length; hash.update(chunk); }, onStderr: chunk => progress.push(chunk) });
    expect(bytes).toBe(4096); expect(result.stdout.length).toBe(0);
    expect(hash.digest("hex")).toBe(createHash("sha256").update(Buffer.alloc(4096, 7)).digest("hex"));
    expect(progress.join("")).toContain("ROTO_V2_PROGRESS 1/1");
  });
  it("still enforces the stdout byte cap with capture disabled", async () => {
    await expect(runAnalysisProcess(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(4096))"],
      { label: "cap-control", timeoutMs: 3000, maximumStdout: 64, captureStdout: false })).rejects.toThrow("stdout");
  });
  it.each(["stdout", "stderr"])("observer %s exceptions stop the child before rejecting", async stream => {
    let pid = 0;
    const operation = runAnalysisProcess(process.execPath, ["-e", `process.${stream}.write(String(process.pid));setInterval(()=>{},1000)`],
      { label: "throw-control", timeoutMs: 3000, ...(stream === "stdout" ? { onStdout: (b: Buffer) => { pid = Number(b.toString()); throw Error("observer failure"); } }
        : { onStderr: (b: string) => { pid = Number(b); throw Error("observer failure"); } }) });
    await expect(operation).rejects.toThrow("observer failure"); expect(pid).toBeGreaterThan(0); expect(() => process.kill(pid, 0)).toThrow();
  });
});
