import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createResidentSequenceWorker, renderResidentSceneLinearVideoSequence } from "./residentSceneLinearVideoSequence";

// These are real owned Node child processes with a fixture JSON protocol.
// They verify process lifetime only, not native rendering, pixels, or performance.
const READY = 'process.stdout.write(JSON.stringify({event:"ready"})+"\\n");';
function fixture(script: string, timeoutMs = 2_000, signal?: AbortSignal) {
  return createResidentSequenceWorker({ executable: process.execPath, args: ["-e", script],
    deadlineAt: performance.now() + timeoutMs, signal });
}
function processIsAbsent(pid: number | undefined): boolean {
  if (!pid) return true;
  try { process.kill(pid, 0); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
}

describe("resident sequence owned-worker cancellation", () => {
  it("rejects a pre-aborted sequence before graph access or spawning its executable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "editkin-sequence-no-spawn-"));
    const marker = join(directory, "started.txt");
    const controller = new AbortController();
    const reason = new Error("Owned export cancelled before spawn");
    controller.abort(reason);
    try {
      expect(() => createResidentSequenceWorker({ executable: process.execPath,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");`],
        deadlineAt: performance.now() + 1_000, signal: controller.signal })).toThrow(reason);
      const sequenceInput = { signal: controller.signal } as Parameters<typeof renderResidentSceneLinearVideoSequence>[0];
      await expect(renderResidentSceneLinearVideoSequence(sequenceInput)).rejects.toBe(reason);
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("bounds a worker that never reports ready and observes its actual close", async () => {
    const worker = fixture('setInterval(()=>{},1000);', 400);
    try {
      await expect(worker.ready).rejects.toThrow(/ready timeout|deadline exceeded/);
    } finally { await worker.close(); }
    await worker.closed;
    expect(processIsAbsent(worker.pid)).toBe(true);
  });

  it("rejects all pending requests immediately when the owned process exits without replying", async () => {
    const worker = fixture(`${READY}process.stdin.once("data",()=>process.exit(0));`);
    try {
      await worker.ready;
      const first = worker.request("frame-a");
      const second = worker.request("frame-b");
      const results = await Promise.allSettled([first, second]);
      expect(results.every(result => result.status === "rejected"
        && /exited|closed|EPIPE/.test(String(result.reason)))).toBe(true);
    } finally { await worker.close("owned-session"); }
    expect(processIsAbsent(worker.pid)).toBe(true);
  });

  it("abort rejects submitted work with the original reason and kills the owned process", async () => {
    const controller = new AbortController();
    const worker = fixture(`${READY}process.stdin.resume();setInterval(()=>{},1000);`, 2_000, controller.signal);
    try {
      await worker.ready;
      const request = worker.request("blocked-frame");
      const reason = new Error("Owned pending export cancelled");
      controller.abort(reason);
      await expect(request).rejects.toBe(reason);
      await expect(worker.request("another-frame")).rejects.toBe(reason);
    } finally { await worker.close("owned-session"); }
    expect(processIsAbsent(worker.pid)).toBe(true);
  });

  it("retains the original absolute deadline after a successful request", async () => {
    const worker = fixture(`${READY}require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
      const message=JSON.parse(line);if(message.command==="first")setTimeout(()=>{
        process.stdout.write(JSON.stringify({id:message.id,ok:true,result:{completed:true}})+"\\n");
      },700);
    });`, 1_800);
    try {
      await worker.ready;
      await expect(worker.request("first")).resolves.toEqual({ completed: true });
      const afterFirst = performance.now();
      await expect(worker.request("blocked-second")).rejects.toThrow(/deadline exceeded|timeout/);
      // 350 ms of scheduling margin; a fresh 1800 ms request budget would fail.
      expect(performance.now() - afterFirst).toBeLessThan(1_450);
    } finally { await worker.close(); }
    expect(processIsAbsent(worker.pid)).toBe(true);
  });

  it("uses one bounded cleanup window rather than three independent RPC timeouts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "editkin-sequence-cleanup-"));
    const marker = join(directory, "commands.txt");
    const worker = fixture(`${READY}require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
      require("node:fs").appendFileSync(${JSON.stringify(marker)},JSON.parse(line).command+"\\n");
    });`, 30_000);
    try {
      await worker.ready;
      const start = performance.now();
      await worker.close("owned-session");
      expect(performance.now() - start).toBeLessThan(5_100);
      expect(await readFile(marker, "utf8")).toBe("engine_video_release\n");
      expect(processIsAbsent(worker.pid)).toBe(true);
    } finally {
      await worker.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 7_000);
});
