import { createHash } from "node:crypto";
import { copyFile, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";

const io = vi.hoisted(() => ({ opened: [] as string[], closed: [] as string[],
  handles: [] as Array<{ path: string; handle: { readonly fd: number }; closeCalls: number; closed: boolean }>,
  afterOpen: undefined as ((path: string) => Promise<void>) | undefined,
  afterActualClose: undefined as ((path: string) => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const path = String(args[0]), handle = await actual.open(...args);
    io.opened.push(path);
    const receipt = { path, handle, closeCalls: 0, closed: false };
    io.handles.push(receipt);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      receipt.closeCalls++;
      await close();
      receipt.closed = true;
      io.closed.push(path);
      await io.afterActualClose?.(path);
    };
    try { await io.afterOpen?.(path); return handle; }
    catch (error) { await handle.close(); throw error; }
  } };
});
import { readBundledFontFace } from "./bundledFontSource";

const realRoot = resolve("public/fonts"), faceId = "EditkinFace-bebas-neue-400";
const spec = bundledFontFaceSpec(faceId);
let owned: string[] = [];
beforeEach(() => { io.opened = []; io.closed = []; io.handles = []; io.afterOpen = undefined; io.afterActualClose = undefined; owned = []; });
afterEach(async () => {
  io.afterOpen = undefined;
  io.afterActualClose = undefined;
  try {
    for (const receipt of io.handles) {
      expect(receipt.closeCalls, receipt.path).toBe(1);
      expect(receipt.closed, receipt.path).toBe(true);
      expect(receipt.handle.fd, receipt.path).toBe(-1);
    }
  } finally {
    // All replacement trees, old ancestors and hardlinks stay inside these owned bases.
    for (const path of owned) await rm(path, { recursive: true, force: true });
  }
});

async function fixture() {
  // Real temporary path: macOS tmpdir() sits under the /var symlink and Windows runners report 8.3 short names.
  const base = await mkdtemp(join(await realpath(tmpdir()), "editkin-selected-font-")); owned.push(base);
  const parent = join(base, "parent"), root = join(parent, "pack"), render = join(root, "render");
  await mkdir(render, { recursive: true });
  const manifest = join(root, "editkin-open-fonts.json"), font = join(root, spec.fontFile);
  await copyFile(join(realRoot, "editkin-open-fonts.json"), manifest);
  await copyFile(join(realRoot, spec.fontFile), font);
  return { base, parent, root, render, manifest, font };
}

describe("selected physical font resource reader", () => {
  it.each(["EditkinFace-noto-sans-tc-700", "EditkinFace-noto-serif-tc-900", "EditkinFace-lxgw-wenkai-mono-tc-400",
    "EditkinFace-bebas-neue-400", "EditkinFace-fredoka-700"])("reads exact licensed static bytes for %s", async id => {
    const expected = bundledFontFaceSpec(id), bytes = await readBundledFontFace(realRoot, id);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(bytes)).toBe(false);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected.sha256);
    expect(Buffer.from(bytes).equals(await readFile(join(realRoot, expected.fontFile)))).toBe(true);
    expect(io.opened).toEqual([join(realRoot, "editkin-open-fonts.json"), join(realRoot, expected.fontFile), join(realRoot, "editkin-open-fonts.json")]);
    expect(io.closed).toEqual(io.opened);
  });

  it.each(["../outside.ttf", "render/EditkinFace-bebas-neue-400.ttf", "https://example.test/font.ttf", "__proto__", "EditkinFace-bebas-neue-900"])(
    "rejects unknown/path identity %j before even checking a nonexistent root", async id => {
      await expect(readBundledFontFace("relative-nonexistent-root", id)).rejects.toThrow(/Unknown/);
      expect(io.opened).toEqual([]);
    });

  it("rejects a relative root and unlisted non-string ID before I/O", async () => {
    await expect(readBundledFontFace("relative", faceId)).rejects.toThrow(/absolute/);
    await expect(readBundledFontFace(realRoot, undefined as unknown as string)).rejects.toThrow(/Unknown/);
    expect(io.opened).toEqual([]);
  });

  it("delivers a copied genuine pack without needing any unselected font", async () => {
    const f = await fixture(), bytes = await readBundledFontFace(f.root, faceId);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(spec.sha256);
    expect(io.closed).toEqual(io.opened);
  });

  it.each(["whitespace", "path", "sha", "weight", "family", "schema"])("rejects a changed manifest (%s) even if locally self-consistent", async change => {
    const f = await fixture(), raw = await readFile(f.manifest), manifest = JSON.parse(raw.toString("utf8"));
    const selected = manifest.fonts.find((font: { id: string }) => font.id === "bebas-neue").faces[0];
    if (change === "path") selected.file = "../../outside.ttf";
    if (change === "sha") { const alternate = Buffer.from("replacement-font"); await writeFile(f.font, alternate); selected.bytes = alternate.length; selected.sha256 = createHash("sha256").update(alternate).digest("hex"); }
    if (change === "weight") selected.weight = 900;
    if (change === "family") selected.family = "EditkinFace fallback 400";
    if (change === "schema") manifest.schemaVersion = 1;
    await writeFile(f.manifest, change === "whitespace" ? Buffer.concat([raw, Buffer.from(" ")]) : JSON.stringify(manifest));
    await expect(readBundledFontFace(f.root, faceId)).rejects.toThrow(/manifest SHA/);
    expect(io.opened).toEqual([f.manifest]); expect(io.closed).toEqual(io.opened);
  });

  it.each(["same-size", "empty", "oversized"])("rejects %s physical bytes with the untouched genuine manifest", async change => {
    const f = await fixture(), genuine = await readFile(f.font);
    if (change === "same-size") { genuine[genuine.length - 1] ^= 1; await writeFile(f.font, genuine); }
    if (change === "empty") await writeFile(f.font, "");
    if (change === "oversized") await writeFile(f.font, Buffer.alloc(16 * 1024 * 1024 + 1));
    await expect(readBundledFontFace(f.root, faceId)).rejects.toThrow(change === "same-size" ? /size or SHA/ : /bounded size/);
    expect(io.closed).toEqual(io.opened);
  });

  it("bounds a manifest before opening it and rejects a directory at a selected file path", async () => {
    const f = await fixture();
    await writeFile(f.manifest, Buffer.alloc(1024 * 1024 + 1));
    await expect(readBundledFontFace(f.root, faceId)).rejects.toThrow(/manifest.*bounded size/);
    expect(io.opened).toEqual([]);
    await copyFile(join(realRoot, "editkin-open-fonts.json"), f.manifest);
    await rm(f.font); await mkdir(f.font);
    await expect(readBundledFontFace(f.root, faceId)).rejects.toThrow(/physical font.*fixed regular file/);
    expect(io.closed).toEqual(io.opened);
  });

  it.each(["root", "parent", "render", "manifest", "font"])("rejects a linked %s without following it", async kind => {
    const f = await fixture();
    let root = f.root;
    if (kind === "root") { root = join(f.base, "linked-pack"); await symlink(f.root, root, "junction"); }
    if (kind === "parent") { const alias = join(f.base, "linked-parent"); await symlink(f.parent, alias, "junction"); root = join(alias, "pack"); }
    if (kind === "render") { const original = join(f.root, "original-render"); await rename(f.render, original); await symlink(original, f.render, "junction"); }
    if (kind === "manifest" || kind === "font") { const path = kind === "manifest" ? f.manifest : f.font, original = `${path}.original`; await rename(path, original); await symlink(original, path, "file"); }
    await expect(readBundledFontFace(root, faceId)).rejects.toThrow(/fixed regular/);
    expect(io.opened).not.toContain(kind === "manifest" ? f.manifest : kind === "font" ? f.font : "no-directory-open");
    expect(io.closed).toEqual(io.opened);
  });

  it.each(["manifest", "font"])("rejects replacement of the opened %s path with identical authentic bytes", async kind => {
    const f = await fixture(), target = kind === "manifest" ? f.manifest : f.font;
    io.afterOpen = async path => {
      if (path !== target) return;
      io.afterOpen = undefined;
      await rename(target, `${target}.old`);
      await copyFile(`${target}.old`, target);
    };
    await expect(readBundledFontFace(f.root, faceId)).rejects.toThrow(/changed/);
    expect(io.closed).toEqual(io.opened);
  });

  it("rejects a manifest replacement after its first handle closes, even when the replacement has identical bytes", async () => {
    const f = await fixture();
    io.afterOpen = async path => {
      if (path !== f.font) return;
      io.afterOpen = undefined;
      await rename(f.manifest, `${f.manifest}.old`);
      await copyFile(`${f.manifest}.old`, f.manifest);
    };
    await expect(readBundledFontFace(f.root, faceId)).rejects.toThrow(/manifest changed/);
    expect(io.closed).toEqual(io.opened);
  });

  it("rejects selected-font replacement after its handle closes while the final manifest is rechecked", async () => {
    const f = await fixture();
    let manifestOpens = 0;
    io.afterOpen = async path => {
      if (path !== f.manifest || ++manifestOpens !== 2) return;
      io.afterOpen = undefined;
      await rename(f.font, `${f.font}.old`);
      await copyFile(`${f.font}.old`, f.font);
    };
    await expect(readBundledFontFace(f.root, faceId)).rejects.toThrow(/physical font changed after read/);
    expect(io.closed).toEqual(io.opened);
  });

  it.each(["render", "root", "parent"])("rejects replacement of %s after the selected handle closes while unchanged hardlinked files keep their identities", async kind => {
    const f = await fixture();
    const replacement = join(f.base, `replacement-${kind}`);
    const replacementPack = kind === "parent" ? join(replacement, "pack") : replacement;
    const replacementRender = kind === "render" ? replacement : join(replacementPack, "render");
    await mkdir(replacementRender, { recursive: true });
    await link(f.font, join(replacementRender, `${faceId}.ttf`));
    if (kind !== "render") await link(f.manifest, join(replacementPack, "editkin-open-fonts.json"));
    io.afterActualClose = async path => {
      if (path !== f.font) return;
      io.afterActualClose = undefined;
      const replaced = kind === "render" ? f.render : kind === "root" ? f.root : f.parent;
      const original = `${replaced}.old`;
      await rename(replaced, original);
      await rename(replacement, replaced);
    };
    await expect(readBundledFontFace(f.root, faceId)).rejects.toThrow(/directory changed/);
    expect(io.closed).toEqual(io.opened);
  });
});
