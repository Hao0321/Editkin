import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { parseProject } from "../application/projectCodec";
import { canonicalJson } from "../shared/canonicalJson";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance } from "../application/referenceMotionTemplateInstances";
import type { ReferenceMotionTemplateReusePreparation } from "../application/referenceMotionTemplateReuse";
import { withReferenceMotionPhysicalFonts } from "./referenceMotionPhysicalFonts";
import { registerReferenceMotionTemplateTools } from "./referenceMotionTemplateTools";
import { verifyReferenceMotionPlan } from "./referenceMotionPlanVerification";
import * as storage from "./storage";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type Entry = { options: { inputSchema: { parse(value: unknown): unknown }; annotations?: Record<string, boolean> }; handle: (input: unknown) => Promise<ToolResult> };
const roots: string[] = [], previousWorkspace = process.env.EDITKIN_WORKSPACE;
afterEach(async () => {
  vi.restoreAllMocks();
  if (previousWorkspace === undefined) delete process.env.EDITKIN_WORKSPACE;
  else process.env.EDITKIN_WORKSPACE = previousWorkspace;
  for (const root of roots.splice(0)) {
    const absolute = resolve(root);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("editkin-reuse-mcp-")) throw new Error("Refusing unowned reuse fixture cleanup");
    await rm(absolute, { recursive: true, force: true });
  }
});
function registered() {
  const entries = new Map<string, Entry>();
  const server = { registerTool(name: string, options: unknown, handle: unknown) { entries.set(name, { options, handle } as Entry); } };
  registerReferenceMotionTemplateTools(server as unknown as McpServer);
  return entries;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "editkin-reuse-mcp-")); roots.push(root); process.env.EDITKIN_WORKSPACE = root;
  let project = parseProject(createEmptyProject("MCP new-content reuse control", { id: "reuse-mcp", width: 1080, height: 1920, fps: 30 }));
  project.assets = ["first", "second"].map((name, index) => ({ id: `asset-${name}`, name: `Synthetic ${name}; no publication rights`, kind: "video" as const,
    uri: join(root, `${name}.mp4`), duration: 4, width: 1080, height: 1920, derivatives: { sourceSha256: String(index + 1).repeat(64), generatedAt: "2026-10-03T00:00:00.000Z" } }));
  project.tracks[0].clips = ["first", "second"].map((name, index) => ({ id: `clip-${name}`, trackId: project.tracks[0].id, assetId: `asset-${name}`,
    sourceStart: 0, timelineStart: index * 4, duration: 4, volume: .65, keyframes: [], transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR } }));
  project = parseProject(project);
  let counter = 0;
  const original = await withReferenceMotionPhysicalFonts(dependencies => prepareReferenceMotionTemplateInstance(project, {
    templateId: "level_bridge", clipId: "clip-first", startFrame: 0, durationFrames: 120, title: "FOCUS", kicker: "KEEP", subtitle: "NEW SOURCE",
    sources: [], purpose: "Synthetic original template control", evidenceRefs: ["synthetic:first-window"], graphicCadence: "brisk",
    style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } },
  }, prefix => `${prefix}-original-${++counter}`, dependencies));
  project = parseProject(applyCommand(project, { type: "batch", commands: original.commands }));
  const path = join(root, "saved.editkin.json"); await writeFile(path, JSON.stringify(project));
  const request = { projectPath: path, sourceInstanceId: original.instance.id, expectedInstanceRevision: 1, expectedProjectRevision: project.revision,
    targetClipId: "clip-second", purpose: "Synthetic independently observed second-content purpose", evidenceRefs: ["synthetic:second-window"], sources: [] };
  return { root, path, project, original, request };
}
describe("actual readonly saved-template reuse MCP dispatch", () => {
  it("declares strict readonly reuse and current catalog without granting source replacement or full artwork", async () => {
    const entries = registered(), reuse = entries.get("prepare_reference_motion_template_reuse")!;
    expect(reuse.options.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    const f = await fixture();
    expect(() => reuse.options.inputSchema.parse({ ...f.request, humanApproval: true })).toThrow();
    const { sources: omitted, ...missing } = f.request; void omitted;
    expect(() => reuse.options.inputSchema.parse(missing)).toThrow();
    const catalog = JSON.parse((await entries.get("list_reference_motion_templates")!.handle({})).content[0].text);
    expect(catalog).toMatchObject({ sourceReplacement: false, savedTemplateReuse: { prepareTool: "prepare_reference_motion_template_reuse",
      reuseOriginVerifiedAtAuditAndApply: true, previousQaOrArtworkApprovalReusable: false, installedOrFullProductCertified: false } });
  });
  it("reads a real project without writes, returns a fresh trusted origin, and the true v4 compiler recreates the separate owner", async () => {
    const f = await fixture(), bytes = await readFile(f.path), before = canonicalJson(f.project);
    const reuse = registered().get("prepare_reference_motion_template_reuse")!;
    const response = await reuse.handle(reuse.options.inputSchema.parse(f.request));
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text) as ReferenceMotionTemplateReusePreparation;
    expect(result).toMatchObject({ status: "PREPARED_NOT_APPLIED", readOnly: true, reusedFrom: { sourceInstanceId: f.original.instance.id,
      expectedInstanceRevision: 1, sourceScopeSha256: f.original.instance.appliedScopeSha256 }, reuseBinding: { targetClipId: "clip-second",
      sourceRights: "new_source_validation_required", previousQaOrArtworkApprovalReusable: false } });
    expect(await readFile(f.path)).toEqual(bytes); expect(canonicalJson(f.project)).toBe(before);
    await expect(verifyReferenceMotionPlan(result.planDeclaration, f.project, result.commands)).resolves.toMatchObject({ instanceCount: 1 });
    const reopened = parseProject(JSON.parse(JSON.stringify(applyCommand(f.project, { type: "batch", commands: result.commands }))));
    expect((await inspectReferenceMotionTemplateInstance(reopened, f.original.instance.id)).status).toBe("CURRENT");
    expect((await inspectReferenceMotionTemplateInstance(reopened, result.instance.id)).status).toBe("CURRENT");
    expect(reopened.tracks[0].clips).toEqual(f.project.tracks[0].clips);
  });
  it("retains the externally changed disk project and refuses a stale prepared response", async () => {
    const f = await fixture(), originalRead = storage.readProject;
    const changed = { ...f.project, name: "Controlled concurrent project change", revision: f.project.revision + 1 };
    vi.spyOn(storage, "readProject").mockImplementationOnce(async path => {
      const observed = await originalRead(path);
      await writeFile(f.path, JSON.stringify(changed));
      return observed;
    });
    const reuse = registered().get("prepare_reference_motion_template_reuse")!;
    const response = await reuse.handle(reuse.options.inputSchema.parse(f.request));
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toMatchObject({ status: "BLOCK", error: expect.stringMatching(/changed on disk/) });
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(changed);
  });
});
