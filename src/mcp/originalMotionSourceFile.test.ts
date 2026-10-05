import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { canonicalJson } from "../shared/canonicalJson";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { parseProject } from "../application/projectFiles";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { verifyOriginalMotionSourceEvidence, type OriginalMotionSourceRights } from "../application/originalMotionSourceEvidence";
import { ORIGINAL_MOTION_AUTHORING_MAX_BYTES, originalMotionAuthoringFileSchema, originalMotionTextProvider,
  prepareOriginalMotionSourceFile, readOriginalMotionAuthoringSource, type OriginalMotionAuthoringFile } from "./originalMotionSourceFile";

const io = vi.hoisted(() => ({ beforeOpen: undefined as undefined | ((path: string) => Promise<void>) }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
    if (io.beforeOpen) await io.beforeOpen(String(args[0])); return actual.open(...args);
  }) };
});
const roots = new Set<string>(), sourcePath = ".editkin/original-sources/owned.json", fontRoot = resolve("public/fonts");
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const rights: OriginalMotionSourceRights = { origin: "self_authored", medium: "native_vector_and_glyph", contentKind: "authored_illustration",
  realityProof: false, importedReferenceMedia: false, declaration: "Self-authored illustration with native geometry and bundled physical glyphs only." };
afterEach(async () => {
  io.beforeOpen = undefined; vi.restoreAllMocks();
  const resolvedTemp = resolve(tmpdir());
  for (const root of roots) {
    const target = resolve(root), parent = dirname(target);
    const directTempChild = process.platform === "win32" ? parent.toLowerCase() === resolvedTemp.toLowerCase() : parent === resolvedTemp;
    if (!isAbsolute(root) || !isAbsolute(target) || !directTempChild || !/^editkin-original-source-[a-z0-9]+$/i.test(basename(target))) {
      throw new Error("Refusing recursive cleanup outside the owned original-source temp fixture");
    }
    await rm(target, { recursive: true, force: true });
  }
  roots.clear();
});
function fixture(text = false) {
  const project = parseProject(createEmptyProject("Owned authored source", { width: 640, height: 360, fps: 30 }));
  const spec = bundledFontFaceSpec("EditkinFace-bebas-neue-400");
  const payload = originalMotionAuthoringFileSchema.parse({ schema: "editkin.original-motion-authoring/v1", usage: "standalone", audio: "silent", fps: 30, rights,
    authoring: { expectedRevision: 0, sceneId: "owned-scene", intent: "standalone_showcase", reason: "Original authored fixture with an exact focal event",
      startFrame: 0, durationFrames: 90, safeArea: { left: 20, right: 20, top: 20, bottom: 20 },
      style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
        typography: { headingFamily: "Bebas Neue", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
      camera: { initial: { centerX: 320, centerY: 180, zoom: 1 }, dynamics: { stiffness: 120, damping: 24, mass: 1 } },
      elements: text ? [{ id: "owned-object", kind: "text", text: "FOCUS", typographyRole: "heading", fontWeight: 400,
        range: { startFrame: 0, endFrame: 90 }, xPixels: 100, yPixels: 80, widthPixels: 430, fontSize: 48, minFontSize: 32,
        maxLines: 1, lineGapPixels: 0, letterSpacingPixels: 0, colorRole: "text" }]
        : [{ id: "owned-object", kind: "panel", range: { startFrame: 0, endFrame: 90 }, xPixels: 210, yPixels: 130,
          widthPixels: 220, heightPixels: 100, cornerRadiusPixels: 12, colorRole: "accent" }],
      semanticCues: [{ id: "original-focus", frame: 0, purpose: "Present the authored object", graphicIds: ["owned-object"], evidenceRefs: ["authoring:owned"] }] },
    fontBindings: text ? [{ graphicId: "owned-object", faceId: spec.faceId, fontSha256: spec.sha256, manifestSha256: spec.manifestSha256, parserVersion: "opentype.js@1.3.4" }] : [] });
  return { project, payload };
}
async function store(payload: OriginalMotionAuthoringFile | string | Uint8Array) {
  const root = await mkdtemp(join(tmpdir(), "editkin-original-source-")); roots.add(root);
  await mkdir(join(root, ".editkin", "original-sources"), { recursive: true });
  const path = join(root, sourcePath);
  await writeFile(path, typeof payload === "string" || payload instanceof Uint8Array ? payload : `${canonicalJson(payload)}\n`);
  return { root, path };
}

describe("owned original authoring file and actual physical provider", () => {
  it("reads declared paint from real source bytes and independently recompiles the same physical commands", async () => {
    const { project, payload } = fixture(true);
    project.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" };
    payload.usage = "authored_overlay"; payload.audio = "preserve_source_audio"; payload.authoring.intent = "authored_overlay";
    const element = payload.authoring.elements[0];
    if (element.kind !== "text") throw new Error("fixture lost text");
    element.paintV1 = { schema: "editkin.motion-paint/v1", fill: { kind: "solid", color: "#3E8DFA" }, clips: [] };
    const { root } = await store(payload);
    const result = await prepareOriginalMotionSourceFile(project, sourcePath, 0, { workspace: root, fontRoot });
    const source = result.prepared.evidence, provider = originalMotionTextProvider(fontRoot);
    const commands = result.prepared.preparation.commands;
    const editorial = { graphics: result.prepared.preparation.editorialGraphics,
      narrative: { backbone: "Original painted overlay", setupPayoffs: [], beats: [{ id: "promise", range: { startFrame: 0, endFrame: 90 }, role: "promise" as const,
        summary: "Original painted overlay", energy: .5, primaryFocus: "Authored object", evidenceRefs: [`original:${source.sourceSha256}:cue:original-focus`] }] } };
    const dependencies = { prepareText: provider, resolveAuthoringSource: async (expected: { sourcePath: string }) =>
      (await readOriginalMotionAuthoringSource(expected.sourcePath, root)).source };
    try {
      expect((await verifyOriginalMotionSourceEvidence({ schema: "editkin.original-motion-source/v1", sources: [source] }, project,
        commands, editorial, dependencies)).state).toBe("SOURCE_BOUND_REVIEW_REQUIRED");
      const changed = structuredClone(commands);
      if (changed[0].type !== "add_motion_graphic") throw new Error("fixture creation missing");
      changed[0].graphic.paintV1!.fill = { kind: "solid", color: "#FFFFFF" };
      await expect(verifyOriginalMotionSourceEvidence({ schema: "editkin.original-motion-source/v1", sources: [source] }, project,
        changed, editorial, dependencies)).rejects.toThrow();
    } finally { provider.dispose(); }
  });
  it("reads canonical owned bytes and separates full-file SHA from normalized payload SHA", async () => {
    const { payload } = fixture(), { root, path } = await store(payload), loaded = await readOriginalMotionAuthoringSource(sourcePath, root);
    expect(loaded.payload).toEqual(payload);
    expect(loaded.source).toEqual({ sourcePath, sourceSha256: hash(await readFile(path)), sourcePayloadSha256: hash(canonicalJson(payload)), bytes: (await readFile(path)).length });
    expect(loaded.source.sourceSha256).not.toBe(loaded.source.sourcePayloadSha256);
  });

  it("allows unrelated directory content changes while preserving the fixed ancestor chain", async () => {
    const { payload } = fixture(), { root, path } = await store(payload);
    io.beforeOpen = async openedPath => {
      if (resolve(openedPath) !== resolve(path)) return; io.beforeOpen = undefined;
      await writeFile(join(root, ".editkin", "original-sources", "unrelated.json"), "unrelated content");
    };
    const loaded = await readOriginalMotionAuthoringSource(sourcePath, root);
    expect(loaded.payload).toEqual(payload); expect(loaded.source.sourceSha256).toBe(hash(await readFile(path)));
  });

  it("produces file-bound editable vector source with actual source identities and no media substitute", async () => {
    const { project, payload } = fixture(), before = structuredClone(project), { root } = await store(payload);
    const result = await prepareOriginalMotionSourceFile(project, sourcePath, 0, { workspace: root, fontRoot });
    expect(project).toEqual(before); expect(result.prepared.evidence.authoringSource).toEqual(result.source);
    expect(result.prepared.preparation.commands.map(command => command.type)).toEqual(["add_motion_graphic", "add_motion_scene"]);
    expect(result.prepared.preparation).toMatchObject({ status: "PREPARED_NOT_APPLIED", readOnly: true });
    expect(Object.keys(result.source).sort()).toEqual(["bytes", "sourcePath", "sourcePayloadSha256", "sourceSha256"]);
  });

  it("prepares real selected physical bytes and reuses the same bounded provider at live verification", async () => {
    const { project, payload } = fixture(true), { root } = await store(payload);
    const result = await prepareOriginalMotionSourceFile(project, sourcePath, 0, { workspace: root, fontRoot });
    const { graphicId: _graphicId, ...physical } = payload.fontBindings[0];
    expect(result.prepared.evidence.graphicBindings[0].physicalFont).toMatchObject(physical);
    const source = result.prepared.evidence, provider = originalMotionTextProvider(fontRoot);
    try {
      const verified = await verifyOriginalMotionSourceEvidence({ schema: "editkin.original-motion-source/v1", sources: [source] }, project,
        result.prepared.preparation.commands, { graphics: result.prepared.preparation.editorialGraphics,
          narrative: { backbone: "Original illustration", setupPayoffs: [], beats: [{ id: "promise", range: { startFrame: 0, endFrame: 90 }, role: "promise",
            summary: "Original illustration", energy: .5, primaryFocus: "Authored object", evidenceRefs: [`original:${source.sourceSha256}:cue:original-focus`] }] } },
        { prepareText: provider, resolveAuthoringSource: async expected => (await readOriginalMotionAuthoringSource(expected.sourcePath, root)).source });
      expect(verified).toMatchObject({ state: "SOURCE_BOUND_REVIEW_REQUIRED", sourceCount: 1 });
    } finally { provider.dispose(); }
    await expect(provider(payload.fontBindings[0].faceId, "FOCUS")).rejects.toThrow(/disposed/);
  });

  it("requires exact usage, audio, fps and live revision rather than silently rerouting a file", async () => {
    const { project, payload } = fixture(), altered = structuredClone(payload);
    altered.usage = "authored_overlay"; altered.authoring.intent = "authored_overlay"; altered.audio = "preserve_source_audio";
    const overlay = await store(altered);
    expect((await prepareOriginalMotionSourceFile(project, sourcePath, 0, { workspace: overlay.root, fontRoot })).prepared.evidence.authoring.intent).toBe("authored_overlay");
    expect(() => originalMotionAuthoringFileSchema.parse({ ...payload, audio: "preserve_source_audio" })).toThrow(/usage/);
    expect(() => originalMotionAuthoringFileSchema.parse({ ...payload, usage: "authored_overlay" })).toThrow(/usage/);
    const fps = await store({ ...payload, fps: 29.97 });
    await expect(prepareOriginalMotionSourceFile(project, sourcePath, 0, { workspace: fps.root, fontRoot })).rejects.toThrow(/fps/);
    const stale = await store({ ...payload, authoring: { ...payload.authoring, expectedRevision: 1 } });
    await expect(prepareOriginalMotionSourceFile(project, sourcePath, 0, { workspace: stale.root, fontRoot })).rejects.toThrow(/stale/);
    const late = fixture(), lateFile = await store(late.payload); let sourceOpens = 0;
    io.beforeOpen = async openedPath => {
      if (resolve(openedPath) === resolve(lateFile.path) && ++sourceOpens === 2) late.project.name += " changed during final source read";
    };
    await expect(prepareOriginalMotionSourceFile(late.project, sourcePath, 0, { workspace: lateFile.root, fontRoot })).rejects.toThrow(/project changed/);
  });

  it("rejects false or missing font provenance instead of copying caller pins into a receipt", async () => {
    const { project, payload } = fixture(true);
    expect(() => originalMotionAuthoringFileSchema.parse({ ...payload, fontBindings: [] })).toThrow(/font bindings/);
    expect(() => originalMotionAuthoringFileSchema.parse({ ...payload, fontBindings: [payload.fontBindings[0], payload.fontBindings[0]] })).toThrow(/font bindings/);
    for (const wrong of ["sha", "face"] as const) {
      const modified = structuredClone(payload);
      if (wrong === "sha") modified.fontBindings[0].fontSha256 = "a".repeat(64); else modified.fontBindings[0].faceId = "EditkinFace-noto-sans-tc-400";
      const { root } = await store(modified);
      await expect(prepareOriginalMotionSourceFile(project, sourcePath, 0, { workspace: root, fontRoot })).rejects.toThrow(/font provenance/);
    }
  });

  it("rejects duplicate keys, formatting aliases, BOM and more than one trailing newline", async () => {
    const { payload } = fixture(), text = canonicalJson(payload);
    const duplicated = text.replace('"schema":"editkin.original-motion-authoring/v1"', '"schema":"editkin.original-motion-authoring/v1","schema":"editkin.original-motion-authoring/v1"');
    for (const raw of [duplicated, JSON.stringify(payload, null, 2), `\ufeff${text}`, `${text}\n\n`, `${text}\r\n`]) {
      const { root } = await store(raw); await expect(readOriginalMotionAuthoringSource(sourcePath, root)).rejects.toThrow();
    }
    const { root } = await store(text); expect((await readOriginalMotionAuthoringSource(sourcePath, root)).payload).toEqual(payload);
  });

  it("rejects oversized and empty source files before parsing JSON", async () => {
    for (const bytes of [new Uint8Array(ORIGINAL_MOTION_AUTHORING_MAX_BYTES + 1), new Uint8Array(0)]) {
      const { root } = await store(bytes); await expect(readOriginalMotionAuthoringSource(sourcePath, root)).rejects.toThrow(/bounded file size/);
    }
  });

  it("rejects URI, absolute, traversal and wrong-directory inputs before source I/O", async () => {
    const { payload } = fixture(), { root } = await store(payload);
    for (const path of ["../outside.json", "file:///owned.json", join(root, sourcePath), ".editkin/original-sources/../owned.json", "owned.json"]) {
      await expect(readOriginalMotionAuthoringSource(path, root)).rejects.toThrow(/source path/);
    }
    await expect(readOriginalMotionAuthoringSource(sourcePath, ".")).rejects.toThrow(/workspace/);
  });

  it("rejects a directory source and a hard-linked file authority", async () => {
    const { payload } = fixture(), { root, path } = await store(payload);
    await link(path, join(root, "alias.json"));
    await expect(readOriginalMotionAuthoringSource(sourcePath, root)).rejects.toThrow(/unaliased/);
    const other = await store(payload); await rm(other.path); await mkdir(other.path);
    await expect(readOriginalMotionAuthoringSource(sourcePath, other.root)).rejects.toThrow(/regular file/);
  });

  it("rejects a linked dedicated directory without following its authority", async () => {
    const { payload } = fixture(), { root } = await store(payload), dedicated = join(root, ".editkin", "original-sources"), external = join(root, "external");
    await rename(dedicated, external); await symlink(external, dedicated, process.platform === "win32" ? "junction" : "dir");
    await expect(readOriginalMotionAuthoringSource(sourcePath, root)).rejects.toThrow(/ancestors/);
  });

  it("rejects an ancestor replacement before opening and preserves actual handle cleanup", async () => {
    const { payload } = fixture(), { root, path } = await store(payload), directory = join(root, ".editkin", "original-sources");
    io.beforeOpen = async openedPath => {
      if (resolve(openedPath) !== resolve(path)) return; io.beforeOpen = undefined;
      await rename(directory, `${directory}.prior`); await mkdir(directory); await writeFile(path, `${canonicalJson(payload)}\n`);
    };
    await expect(readOriginalMotionAuthoringSource(sourcePath, root)).rejects.toThrow(/changed/);
    // Both original and replacement files remain readable after the refused owned read.
    expect(await readFile(join(`${directory}.prior`, "owned.json"), "utf8")).toBe(`${canonicalJson(payload)}\n`);
    expect(await readFile(path, "utf8")).toBe(`${canonicalJson(payload)}\n`);
  });

  it("detects actual authoring bytes changed during real asynchronous scene preparation", async () => {
    const { project, payload } = fixture(), { root, path } = await store(payload), digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let changed = false;
    vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      if (!changed) {
        changed = true; const altered = structuredClone(payload); altered.rights.declaration += " changed";
        await writeFile(path, `${canonicalJson(altered)}\n`);
      }
      return digest(algorithm, data);
    });
    await expect(prepareOriginalMotionSourceFile(project, sourcePath, 0, { workspace: root, fontRoot })).rejects.toThrow(/source changed/);
    expect(changed).toBe(true);
  });
});
