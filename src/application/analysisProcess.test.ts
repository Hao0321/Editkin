import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAnalysisProcess } from "./analysisProcess";

describe("real owned analysis child lifecycle", () => {
  it("aborts a real delayed child and rejects only after that PID is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-cancel-child-test-")), path = join(root, "pid.json"), abort = new AbortController();
    const operation = runAnalysisProcess(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)", path], { signal: abort.signal, label: "fixture", timeoutMs: 4000 });
    const rejected = operation.then(() => { throw Error("unexpected completion"); }, error => error);
    try {
      let pid = 0; const deadline = Date.now() + 3000;
      while (!pid && Date.now() < deadline) { pid = await readFile(path, "utf8").then(Number, () => 0); if (!pid) await new Promise(done => setTimeout(done, 10)); }
      expect(pid).toBeGreaterThan(0); abort.abort();
      expect(await rejected).toMatchObject({ name: "AbortError" });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { abort.abort(); await rejected; await rm(root, { recursive: true, force: true }); }
  });
  it("distinguishes timeout and nonzero exit from success", async () => {
    await expect(runAnalysisProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { label: "timeout-control", timeoutMs: 80 })).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(runAnalysisProcess(process.execPath, ["-e", "process.exit(3)"], { label: "exit-control", timeoutMs: 1000 })).rejects.toThrow("exit 3");
    const result = await runAnalysisProcess(process.execPath, ["-e", "process.stdout.write('ready')"], { label: "positive", timeoutMs: 1000 });
    expect(result.stdout.toString()).toBe("ready");
  });
});
