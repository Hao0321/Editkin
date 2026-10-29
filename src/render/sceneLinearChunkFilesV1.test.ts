import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { inspectSceneLinearChunkFilesV1 } from "./sceneLinearChunkFilesV1";
const temp = useTempRoots();
function png() {
  const crc = (data: Buffer) => { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (name: string, data: Buffer) => { const out = Buffer.alloc(data.length + 12), type = Buffer.from(name); out.writeUInt32BE(data.length); type.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([type, data])), data.length + 8); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(18))), chunk("IEND", Buffer.alloc(0))]);
}
async function fixture() {
  const directory = await temp.create("c4-png-"), bytes = png(), path = join(directory, "frame-00000007.png"); await writeFile(path, bytes);
  return { directory, bytes, path, input: { directory, startFrame: 7, frameCount: 1, width: 2, height: 2, bitDepth: 8 as const, maximumFrameBytes: 1024, maximumBatchBytes: 2048, expectedBytes: bytes.length } };
}
describe("scene-linear PNG batch identity and bounded relay", () => {
  it("retires a real PNG only after the sink acknowledges it", async () => {
    const f = await fixture(), batch = await inspectSceneLinearChunkFilesV1(f.input);
    await batch.consume(0, async data => { expect(await readFile(f.path)).toEqual(f.bytes); expect(data).toEqual(f.bytes); }); expect(await readdir(f.directory)).toEqual([]);
  });
  it("keeps an unacknowledged PNG on sink failure", async () => {
    const f = await fixture(), batch = await inspectSceneLinearChunkFilesV1(f.input);
    await expect(batch.consume(0, async () => { throw Error("SINK_FAILURE"); })).rejects.toThrow(/SINK_FAILURE/); expect(await readFile(f.path)).toEqual(f.bytes);
  });
  it.each(["extra", "dimension", "bytes"])("refuses a%s mismatch before writing", async mode => {
    const f = await fixture(); if (mode === "extra") await writeFile(join(f.directory, "extra.png"), f.bytes);
    if (mode === "dimension") { const changed = Buffer.from(f.bytes); changed.writeUInt32BE(3, 16); await writeFile(f.path, changed); }
    if (mode === "bytes") f.input.expectedBytes++;
    await expect(inspectSceneLinearChunkFilesV1(f.input)).rejects.toThrow(/LONG_RENDER_OUTPUT_QA/);
  });
  it("rejects file substitution between inspection and consumption", async () => {
    const f = await fixture(), batch = await inspectSceneLinearChunkFilesV1(f.input); await rename(f.path, f.path + ".old"); await writeFile(f.path, f.bytes);
    await expect(batch.consume(0, async () => { throw Error("MUST_NOT_REACH_SINK"); })).rejects.toThrow(/LONG_RENDER_OUTPUT_QA/);
  });
  it("compares and retires only the exact native JSON receipt sidecar", async () => {
    const f = await fixture(), value = { schema: "owned-test-receipt", frames: 1 }, manifest = join(f.directory, "editkin-ocio-display-sequence.json");
    await writeFile(manifest, JSON.stringify(value));
    await expect(inspectSceneLinearChunkFilesV1({ ...f.input, nativeReceipt: { value: {}, maximumBytes: 1024 } })).rejects.toThrow(/LONG_RENDER_OUTPUT_QA/);
    const batch = await inspectSceneLinearChunkFilesV1({ ...f.input, nativeReceipt: { value, maximumBytes: 1024 } });
    expect(batch.manifestBytes).toBeGreaterThan(0); await batch.consume(0, async () => {}); await batch.retireManifest(); expect(await readdir(f.directory)).toEqual([]);
  });
});
