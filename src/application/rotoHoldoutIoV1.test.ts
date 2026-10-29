import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import * as space from "../render/renderDiskSpace";
import { createRotoHoldoutOutputV1, readRotoHoldoutFileV1, rotoHoldoutBudgetV1, rotoHoldoutDigestV1,
  rotoHoldoutFileIdentityV1 } from "./rotoHoldoutIoV1";
import { blankRotoHoldoutPngV1, readRotoHoldoutPngV1, rotoHoldoutAlpha8V1 } from "./rotoHoldoutPngV1";
let root: string; const links: string[] = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "editkin-holdout-io-")); });
afterEach(async () => {
  vi.restoreAllMocks(); for (const p of links.splice(0)) await unlink(p).catch(() => {});
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("editkin-holdout-io-") || (await realpath(root)).toLowerCase() !== resolve(root).toLowerCase()) throw Error("Fixture cleanup boundary");
  await rm(root, { recursive: true, force: true });
});
const check = () => 30000;
describe("holdout PNG plane and bounded local I/O", () => {
  it("preserves fractional 8-bit mask values", () => {
    const data = Buffer.alloc(16 * 16 * 4);
    for (let i = 0; i < 256; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = i; data[i * 4 + 3] = 255; }
    expect([...rotoHoldoutAlpha8V1(PNG.sync.write({ width: 16, height: 16, data }), 16, 16).alpha]).toEqual(Array.from({ length: 256 }, (_, n) => n));
  });
  it("makes a blank template with no implicit foreground or approval", () => {
    const r = rotoHoldoutAlpha8V1(blankRotoHoldoutPngV1(16, 16), 16, 16);
    expect(r.allBackground).toBe(true); expect(r.alpha.every(n => n === 0)).toBe(true);
  });
  it.each(["colour", "transparent"]) ("refuses %s masks", kind => {
    const image = PNG.sync.read(blankRotoHoldoutPngV1(16, 16)); image.data[kind === "colour" ? 0 : 3] = kind === "colour" ? 1 : 0;
    expect(() => rotoHoldoutAlpha8V1(PNG.sync.write(image), 16, 16)).toThrow(/GRAYSCALE/);
  });
  it.each(["size", "16bit", "interlace", "crc", "truncated", "allocation"]) ("refuses malformed %s PNG before accepting labels", kind => {
    let bytes = blankRotoHoldoutPngV1(16, 16); let width = 16, height = 16;
    if (kind === "size") width = 18;
    if (kind === "16bit") bytes[24] = 16;
    if (kind === "interlace") bytes[28] = 1;
    if (kind === "crc") bytes[29] ^= 1;
    if (kind === "truncated") bytes = bytes.subarray(0, 30);
    if (kind === "allocation") { width = 20000; height = 20000; }
    expect(() => readRotoHoldoutPngV1(bytes, width, height)).toThrow();
  });
  it("binds a local file to streamed content and length", async () => {
    const path = join(root, "source.bin"), bytes = Buffer.from("owned source"); await writeFile(path, bytes);
    expect(await rotoHoldoutFileIdentityV1(path, check)).toEqual({ path, bytes: bytes.length, sha256: rotoHoldoutDigestV1(bytes) });
    await expect(readRotoHoldoutFileV1(path, bytes.length - 1)).rejects.toThrow();
  });
  it("rejects a source that changes during its streamed hash", async () => {
    const path = join(root, "source.bin"); await writeFile(path, Buffer.alloc(65536, 12)); let calls = 0;
    await expect(rotoHoldoutFileIdentityV1(path, () => { if (++calls === 2) appendFileSync(path, "changed"); return 30000; })).rejects.toThrow(/CHANGED/);
  });
  it("rejects linked sources", async () => {
    const target = join(root, "source"); await mkdir(target); await writeFile(join(target, "file.bin"), "source");
    const link = join(root, "linked"); await symlink(target, link, "junction"); links.push(link);
    await expect(rotoHoldoutFileIdentityV1(join(link, "file.bin"), check)).rejects.toThrow(/LINK/);
  });
  it("refuses output reuse and path escape", async () => {
    const path = join(root, "output"), output = await createRotoHoldoutOutputV1(path, check);
    await expect(createRotoHoldoutOutputV1(path, check)).rejects.toThrow();
    await expect(output.write("../escaped.txt", "x")).rejects.toThrow(/ESCAPE/);
    await expect(readFile(join(root, "escaped.txt"))).rejects.toThrow();
  });
  it("checks a linked parent before creating a child outside the owned output", async () => {
    const output = await createRotoHoldoutOutputV1(join(root, "output"), check), outside = join(root, "other-owned-fixture"); await mkdir(outside);
    const link = join(output.path, "clips"); await symlink(outside, link, "junction"); links.push(link);
    await expect(output.write("clips/unexpected/file.txt", "x")).rejects.toThrow(/LINK/);
    await expect(readFile(join(outside, "unexpected/file.txt"))).rejects.toThrow();
  });
  it("refuses an exhausted byte budget before writing", async () => {
    const output = await createRotoHoldoutOutputV1(join(root, "output"), check, 1024);
    await expect(output.write("oversized.bin", Buffer.alloc(1025))).rejects.toThrow(/BYTE_BUDGET/);
    expect(output.writtenBytes).toBe(0);
  });
  it.each([undefined, { key: "fixture", root: "D:/", availableBytes: 1024 }])("refuses unknown or insufficient free space", async value => {
    vi.spyOn(space, "probeVolumeSpace").mockResolvedValue(value);
    const output = await createRotoHoldoutOutputV1(join(root, "output"), check);
    await expect(output.write("file.bin", "x")).rejects.toThrow(/VOLUME_RESERVE/);
  });
  it("writes sequences with bounded chunks, without concatenating a clip in RAM", async () => {
    const output = await createRotoHoldoutOutputV1(join(root, "output"), check);
    async function* chunks() { yield Uint8Array.of(1, 2); yield Uint8Array.of(3); }
    const path = await output.sequence("truth/source.alpha8", 3, chunks());
    expect([...await readFile(path)]).toEqual([1, 2, 3]); expect(output.writtenBytes).toBe(3);
  });
  it.each([2, 4])("rejects a sequence length that differs from %s declared bytes", async expected => {
    const output = await createRotoHoldoutOutputV1(join(root, "output"), check);
    async function* chunks() { yield Uint8Array.of(1, 2, 3); }
    await expect(output.sequence("bad.alpha8", expected, chunks())).rejects.toThrow(/SEQUENCE/);
  });
  it("honours cancellation and rejects an invalid deadline", () => {
    const controller = new AbortController(); controller.abort(Error("cancelled"));
    expect(() => rotoHoldoutBudgetV1({ signal: controller.signal })()).toThrow("cancelled");
    for (const timeoutMs of [0, -1, Number.NaN, 120001]) expect(() => rotoHoldoutBudgetV1({ timeoutMs })).toThrow();
  });
});
