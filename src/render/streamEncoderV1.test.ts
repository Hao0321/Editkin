import { describe, expect, it } from "vitest";
import { startStreamEncoderV1 } from "./streamEncoderV1";

const start = (script: string, extra: Partial<Parameters<typeof startStreamEncoderV1>[0]> = {}) => startStreamEncoderV1({
  executable: process.execPath, args: ["-e", script], signal: new AbortController().signal,
  timeoutMs: 5_000, stallMs: 2_000, maximumWriteBytes: 1024 * 1024, ...extra,
});
describe("owned streaming encoder lifecycle (real isolated Node children)", () => {
  it("keeps sequential bytes exact under pipe backpressure and closes after EOF", async () => {
    const encoder = start("let a=[];process.stdin.on('data',b=>a.push(b));process.stdin.on('end',()=>process.stdout.write(require('crypto').createHash('sha256').update(Buffer.concat(a)).digest('hex')))");
    const buffers = [Buffer.alloc(100_000, 1), Buffer.alloc(100_000, 2), Buffer.alloc(100_000, 3)];
    try {
      for (const bytes of buffers) await encoder.write(bytes);
      await encoder.finish();
      const { createHash } = await import("node:crypto");
      expect(encoder.receipt.stdout).toBe(createHash("sha256").update(Buffer.concat(buffers)).digest("hex"));
      expect(encoder.receipt.writes).toBe(3); expect(encoder.closed).toBe(true);
    } finally { await encoder.stop(Error("test cleanup")); }
  }, 10_000);
  it("allows an encoder that closes after the declared final write", async () => {
    const encoder = start("process.stdin.once('data',()=>process.exit(0))", { expectedWrites: 1 });
    try { await encoder.write(Buffer.from("frame")); await encoder.completion; await encoder.finish(); expect(encoder.closed).toBe(true); }
    finally { await encoder.stop(Error("test cleanup")); }
  }, 10_000);
  it("rejects premature zero exit and nonzero exit rather than reporting an output", async () => {
    for (const code of [0, 7]) {
      const encoder = start(`process.exit(${code})`, { expectedWrites: 2 });
      try { await expect(encoder.completion).rejects.toThrow("STREAM_ENCODER_FAILED"); expect(encoder.closed).toBe(true); }
      finally { await encoder.stop(Error("test cleanup")); }
    }
  }, 10_000);
  it("rejects oversize input and overlapping writes", async () => {
    const encoder = start("setTimeout(()=>process.stdin.resume(),500)");
    try {
      await expect(encoder.write(Buffer.alloc(1024 * 1024 + 1))).rejects.toThrow("WRITE_REFUSED");
      const pending = encoder.write(Buffer.alloc(1024 * 1024));
      await expect(encoder.write(Buffer.from("overlap"))).rejects.toThrow("WRITE_REFUSED");
      await pending; await encoder.finish();
    } finally { await encoder.stop(Error("test cleanup")); }
  }, 10_000);
  it("cancellation terminates the owned child before completion", async () => {
    const controller = new AbortController(), encoder = start("setInterval(()=>{},1000)", { signal: controller.signal });
    controller.abort(Error("explicit cancellation"));
    await expect(encoder.completion).rejects.toThrow("explicit cancellation"); expect(encoder.closed).toBe(true);
  }, 10_000);
  it("identical progress counters cannot keep an idle encoder alive", async () => {
    const encoder = start("setInterval(()=>process.stdout.write('out_time_us=0\\ntotal_size=0\\n'),20)", { stallMs: 250 });
    try { await expect(encoder.completion).rejects.toThrow("STREAM_ENCODER_STALLED"); expect(encoder.closed).toBe(true); }
    finally { await encoder.stop(Error("test cleanup")); }
  }, 10_000);
});
