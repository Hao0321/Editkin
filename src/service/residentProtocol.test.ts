import { describe, expect, it } from "vitest";
import { PassThrough, Readable, Writable } from "node:stream";
import { runResidentService, SERVICE_STREAM_SCHEMA as schema } from "./residentProtocol";

const frame = (id: string, command = "echo", payload: Record<string, unknown> = {}) =>
  `${JSON.stringify({ schema, id, request: { command, payload } })}\n`;
function capture() {
  let text = "";
  return {
    output: new Writable({ write(chunk, _encoding, callback) { text += String(chunk); callback(); } }),
    frames: () => text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
  };
}
const artifact = () => ({ kind: "product" });

describe("resident service wire protocol", () => {
  it("preserves IDs, Unicode and response ordering across fragmented input", async () => {
    const wire = Buffer.from(frame("one", "echo", { text: "台灣🎬" }) + frame("two"));
    const chunks = Array.from(wire, byte => Buffer.from([byte]));
    const sink = capture();
    let active = 0; let peak = 0;
    await runResidentService({ input: Readable.from(chunks), output: sink.output, serviceArtifact: artifact,
      dispatch: async request => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return request.payload; } });
    expect(peak).toBe(1);
    expect(sink.frames()).toEqual([
      { schema, kind: "ready", pid: process.pid },
      { schema, id: "one", response: { ok: true, result: { text: "台灣🎬" }, serviceArtifact: artifact() } },
      { schema, id: "two", response: { ok: true, result: {}, serviceArtifact: artifact() } },
    ]);
  });
  it("a command error leaves the worker ready for the next request", async () => {
    const sink = capture();
    await runResidentService({ input: Readable.from([frame("bad", "invalid") + frame("good")]), output: sink.output,
      serviceArtifact: artifact, dispatch: async request => { if (request.command === "invalid") throw new Error("invalid project"); return 42; } });
    expect(sink.frames()[1].response).toMatchObject({ ok: false, error: "invalid project" });
    expect(sink.frames()[2].response).toMatchObject({ ok: true, result: 42 });
  });
  it.each([
    ["malformed", "{bad}\n"],
    ["schema", frame("one").replace(schema, "future")],
    ["unknown field", JSON.stringify({ schema, id: "one", extra: true, request: { command: "echo", payload: {} } }) + "\n"],
    ["payload shape", JSON.stringify({ schema, id: "one", request: { command: "echo", payload: [] } }) + "\n"],
    ["truncated", frame("one").trimEnd()],
    ["invalid UTF8", Buffer.from([0xff, 0x0a])],
  ])("rejects %s without dispatch", async (_name, wire) => {
    const sink = capture(); let calls = 0;
    await expect(runResidentService({ input: Readable.from([wire]), output: sink.output,
      serviceArtifact: artifact, dispatch: async () => { calls++; } })).rejects.toThrow("Service stream protocol");
    expect(calls).toBe(0);
  });
  it("rejects a frame over the byte budget even without a newline", async () => {
    const sink = capture();
    await expect(runResidentService({ input: Readable.from([Buffer.alloc(65, 32)]), output: sink.output,
      serviceArtifact: artifact, dispatch: async () => null, limits: { requestBytes: 64 } })).rejects.toThrow("too large");
  });
  it("rejects duplicate outstanding IDs instead of applying twice", async () => {
    const sink = capture(); const input = new PassThrough(); let calls = 0;
    let finish!: () => void;
    const running = runResidentService({ input, output: sink.output, serviceArtifact: artifact,
      dispatch: async () => { calls++; await new Promise<void>(resolve => { finish = resolve; }); } });
    const rejected = expect(running).rejects.toThrow("duplicate active request id");
    input.end(frame("same") + frame("same"));
    await rejected;
    finish?.();
    expect(calls).toBeLessThanOrEqual(1);
  });
  it("bounds responses and reports a transport failure for oversize results", async () => {
    const sink = capture();
    await expect(runResidentService({ input: Readable.from([frame("one")]), output: sink.output,
      serviceArtifact: artifact, dispatch: async () => "x".repeat(300), limits: { responseBytes: 200 } })).rejects.toThrow("response frame too large");
    expect(sink.frames()).toHaveLength(1);
  });
  it("stops when host aborts even with an unfinished operation", async () => {
    const sink = capture(); const input = new PassThrough(); const lifetime = new AbortController();
    let start!: () => void; const started = new Promise<void>(resolve => { start = resolve; });
    let finish!: () => void;
    const running = runResidentService({ input, output: sink.output, serviceArtifact: artifact, signal: lifetime.signal,
      dispatch: async () => { start(); await new Promise<void>(resolve => { finish = resolve; }); } });
    const rejected = expect(running).rejects.toThrow("host lifetime ended");
    input.write(frame("one")); await started; lifetime.abort(); await rejected; finish();
    expect(sink.frames()).toHaveLength(1);
  });
  it("bounds serial queue without dropping work when its small capacity fills", async () => {
    const sink = capture(); let count = 0;
    await runResidentService({ input: Readable.from([Array.from({ length: 50 }, (_, id) => frame(String(id))).join("")]),
      output: sink.output, serviceArtifact: artifact, limits: { queuedRequests: 2, queuedBytes: 400 },
      dispatch: async () => { await new Promise(resolve => setTimeout(resolve, 1)); return ++count; } });
    expect(count).toBe(50);
    expect(sink.frames().slice(1).map(value => value.id)).toEqual(Array.from({ length: 50 }, (_, id) => String(id)));
  });
});
