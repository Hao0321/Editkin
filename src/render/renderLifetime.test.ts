import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runProcess } from "./mediaProcess";
import { assertRenderActive, publishRenderOutput, renderStageTimeout, withRenderLifetime } from "./renderLifetime";

describe("render cancellation lifetime with owned Node children", () => {
  it("refuses pre-cancelled work before spawning or writing", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel before render"); controller.abort(reason);
    let called = false;
    await expect(withRenderLifetime({ signal: controller.signal }, async () => { called = true; })).rejects.toBe(reason);
    expect(called).toBe(false);
  });
  it("kills a running writer and waits for close before returning cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "editkin-cancel-writer-"));
    const path = join(directory, "writes.txt");
    const controller = new AbortController(); const reason = new Error("user stopped export");
    try {
      const promise = withRenderLifetime({ signal: controller.signal, timeoutMs: 5_000 }, () => runProcess(process.execPath,
        ["-e", "const fs=require('fs');fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>fs.appendFileSync(process.argv[1],'x'),10)", path], 5_000));
      // Wait for the actual child to begin, rather than a fixed startup sleep.
      let pid = 0;
      for (let i = 0; i < 100 && !pid; i++) {
        try { pid = Number.parseInt(await readFile(path, "utf8"), 10); } catch { /* startup */ }
        if (!pid) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(pid).toBeGreaterThan(0);
      controller.abort(reason);
      await expect(promise).rejects.toBe(reason);
      expect(() => process.kill(pid, 0)).toThrow();
      const before = await readFile(path, "utf8");
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(await readFile(path, "utf8")).toBe(before);
    } finally { controller.abort(); await rm(directory, { recursive: true, force: true }); }
  });
  it("uses the same total deadline after a successful stage", async () => {
    await expect(withRenderLifetime({ timeoutMs: 350 }, async () => {
      await runProcess(process.execPath, ["-e", "setTimeout(()=>process.stdout.write('first'),100)"], 5_000);
      expect(renderStageTimeout(5_000)).toBeLessThan(350);
      return runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], 5_000);
    })).rejects.toThrow(/逾時/);
  });
  it("does not return success when uninterruptible work crossed the deadline", async () => {
    await expect(withRenderLifetime({ timeoutMs: 20 }, async () => {
      const end = performance.now() + 35; while (performance.now() < end) { /* CPU work */ }
      assertRenderActive(); return "GREEN";
    })).rejects.toThrow(/總時間逾時/);
  });
  it("keeps concurrent render lifetimes independent", async () => {
    const controller = new AbortController(); const reason = new Error("stop only first export");
    const first = withRenderLifetime({ signal: controller.signal, timeoutMs: 5_000 }, () => runProcess(process.execPath,
      ["-e", "setInterval(()=>{},1000)"], 5_000));
    const second = withRenderLifetime({ timeoutMs: 5_000 }, () => runProcess(process.execPath,
      ["-e", "setTimeout(()=>process.stdout.write('kept'),150)"], 5_000));
    const timer = setTimeout(() => controller.abort(reason), 100);
    try {
      const [a, b] = await Promise.allSettled([first, second]);
      expect(a).toEqual({ status: "rejected", reason });
      expect(b).toMatchObject({ status: "fulfilled", value: { stdout: "kept" } });
    } finally { clearTimeout(timer); controller.abort(); }
  });
  it("preserves complete protocol output beyond diagnostic-tail size", async () => {
    const result = await withRenderLifetime({ timeoutMs: 5_000 }, () => runProcess(process.execPath,
      ["-e", "process.stdout.write(JSON.stringify({data:'a'.repeat(120000)}))"], 5_000, { completeStdoutMaxChars: 200_000 }));
    expect(JSON.parse(result.stdout).data.length).toBe(120_000);
  });
  it("preserves the prior output when cancellation arrives before publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "editkin-cancel-publication-"));
    const temporary = join(directory, "pending.txt"), requested = join(directory, "prior.txt");
    try {
      await writeFile(temporary, "candidate"); await writeFile(requested, "prior");
      const controller = new AbortController();
      await expect(withRenderLifetime({ signal: controller.signal }, async () => {
        controller.abort(new Error("cancel before publish")); await publishRenderOutput(temporary, requested);
      })).rejects.toThrow("cancel before publish");
      expect(await readFile(requested, "utf8")).toBe("prior");
      expect(await readFile(temporary, "utf8")).toBe("candidate");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("replaces the prior output on a successful commit without a delete gap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "editkin-success-publication-"));
    const temporary = join(directory, "pending.txt"), requested = join(directory, "prior.txt");
    try {
      await writeFile(temporary, "candidate"); await writeFile(requested, "prior");
      await withRenderLifetime({}, () => publishRenderOutput(temporary, requested));
      expect(await readFile(requested, "utf8")).toBe("candidate");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
