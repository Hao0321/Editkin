import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../shared/canonicalJson";
import { originalMotionScene2dInputSchema } from "../application/originalMotionScene2d";
import { readOriginalMotionAuthoringSource, originalMotionAuthoringFileSchema, prepareOriginalMotionSourceFile } from "./originalMotionSourceFile";
import { createEmptyProject } from "../domain/editGraph";

function authoredFile(focused: boolean) {
  return originalMotionAuthoringFileSchema.parse({ schema: "editkin.original-motion-authoring/v1", usage: "standalone", audio: "silent", fps: 30,
    rights: { origin: "self_authored", medium: "native_vector_and_glyph", contentKind: "authored_illustration", realityProof: false,
      importedReferenceMedia: false, declaration: "Owned source ingress control, not a rendered film or real product demonstration" },
    authoring: { sceneId: "file-ingress", expectedRevision: 0, intent: "standalone_showcase", reason: "作者檔案入口明示對焦，保留一般靜止相機能力",
      startFrame: 0, durationFrames: 90, safeArea: { left: 20, right: 20, top: 20, bottom: 20 },
      style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
        typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
      camera: { initial: { centerX: 320, centerY: 180, zoom: 1 }, dynamics: { stiffness: 120, damping: 24, mass: 1 } },
      elements: [{ id: "panel", kind: "panel", range: { startFrame: 0, endFrame: 90 }, xPixels: 40, yPixels: 40, widthPixels: 560,
        heightPixels: 280, cornerRadiusPixels: 12, colorRole: "accent" }],
      semanticCues: [{ id: "panel-purpose", frame: 0, purpose: "同一原始作者版本的明示焦點", graphicIds: ["panel"], evidenceRefs: ["brief:focus-ingress"],
        ...(focused ? { focus: { centerX: 320, centerY: 180, zoom: 1 } } : {}) }] }, fontBindings: [] });
}

async function file(focused: boolean) {
  const root = await mkdtemp(join(tmpdir(), "editkin-focus-file-ingress-"));
  await mkdir(join(root, ".editkin", "original-sources"), { recursive: true });
  const path = ".editkin/original-sources/created.json", payload = authoredFile(focused), bytes = canonicalJson(payload) + "\n";
  await writeFile(join(root, path), bytes);
  return { root, path, payload, bytes };
}

describe("canonical authored file focus prerequisite", () => {
  it("admits the actual immutable explicitly focused authored file without changing its payload or clock", async () => {
    const f = await file(true), loaded = await readOriginalMotionAuthoringSource(f.path, f.root);
    expect(loaded.payload).toEqual(f.payload); expect(loaded.source.bytes).toBe(Buffer.byteLength(f.bytes));
    expect(await readFile(join(f.root, f.path), "utf8")).toBe(f.bytes);
  });
  it("rejects actual focus-free file preparation before touching the deliberately missing font directory or project", async () => {
    const f = await file(false), project = createEmptyProject("Ingress control", { width: 640, height: 360, fps: 30 }), before = structuredClone(project);
    await expect(prepareOriginalMotionSourceFile(project, f.path, 0, { workspace: f.root, fontRoot: join(f.root, "deliberately-missing-fonts") }))
      .rejects.toThrow(/^ORIGINAL_SOURCE_FOCUS_REQUIRED:/);
    expect(project).toEqual(before); expect(await readFile(join(f.root, f.path), "utf8")).toBe(f.bytes);
  });
  it("preserves the general static-camera author schema and does not append an inferred focus", () => {
    const payload = authoredFile(false), before = structuredClone(payload);
    expect(originalMotionScene2dInputSchema.parse(payload.authoring).semanticCues[0].focus).toBeUndefined();
    expect(payload).toEqual(before);
  });
});
