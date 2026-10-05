import type { McpServer } from "@modelcontextprotocol/server";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { parseProject } from "../application/projectFiles";
import { canonicalJson } from "../shared/canonicalJson";
import { REFERENCE_MOTION_TEMPLATES, REFERENCE_MOTION_SEMANTIC_REPLACE_CONTRACT,
  referenceMotionTemplateInputSchema, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { registerReferenceMotionTemplateTools } from "../mcp/referenceMotionTemplateTools";
import ReferenceMotionTemplateControls, { type ManualReferenceMotionTemplate } from "./ReferenceMotionTemplateControls";

// Actual component handlers with retained hook slots. This is not a mounted UI,
// native Logo test, media decode or artwork acceptance. MCP preparation below
// keeps the real physical-font provider and compiler; only project storage is controlled.
const slots = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
const storage = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => {
  const index = slots.cursor++; if (!(index in slots.values)) slots.values[index] = initial;
  return [slots.values[index], (next: unknown) => { slots.values[index] = typeof next === "function"
    ? (next as (value: unknown) => unknown)(slots.values[index]) : next; }];
} }));
vi.mock("../mcp/storage", () => ({ readProject: storage.read }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function projectFixture() {
  const project = createEmptyProject("Synthetic strike authoring metadata", { id: "strike-authoring", width: 1080, height: 1920, fps: 30 });
  project.assets = [{ id: "synthetic-source", name: "Synthetic source metadata only", kind: "video",
    uri: "D:/synthetic/strike-authoring-no-media-read.mp4", duration: 8, width: 640, height: 360,
    displayAspectRatio: 16 / 9, color: { interpretation: "rec709" } }];
  project.tracks[0].clips = [{ id: "primary", trackId: project.tracks[0].id, assetId: "synthetic-source", timelineStart: 0,
    sourceStart: 0, duration: 8, volume: .7, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  return parseProject(project);
}
function inputFixture(): ReferenceMotionTemplateInput {
  return { templateId: "strike_reframe", clipId: "primary", startFrame: 0, durationFrames: 240,
    title: "看清真正重點", previousText: "只靠堆疊效果", kicker: "讀清楚", subtitle: "先講清楚再呈現",
    purpose: "Synthetic strict authoring control, not platform or brand verification", evidenceRefs: ["synthetic:authoring-control"] };
}
function uiFixture() {
  const project = projectFixture(), apply = vi.fn<(input: ManualReferenceMotionTemplate) => void>(), cancel = vi.fn();
  let busy = false;
  function render() {
    slots.cursor = 0;
    return elements(ReferenceMotionTemplateControls({ clip: project.tracks[0].clips[0], assets: project.assets,
      portrait: true, fps: project.fps, busy, onApply: apply, onCancel: cancel }));
  }
  function find(attribute: string, value: string) {
    const result = render().find(element => element.props[attribute] === value);
    if (!result) throw new Error(`Actual strike control missing: ${attribute}=${value}`);
    return result;
  }
  const change = (label: string, value: string) => (find("aria-label", label).props.onChange as
    (event: { target: { value: string } }) => void)({ target: { value } });
  const toggle = (label: string, checked: boolean) => (find("aria-label", label).props.onChange as
    (event: { target: { checked: boolean } }) => void)({ target: { checked } });
  const click = () => (find("data-testid", "apply-reference-motion-template").props.onClick as () => void)();
  change("參考 Motion 模板", "strike_reframe"); change("模板主標題", "看清真正重點"); change("刪線原句", "只靠堆疊效果");
  return { render, find, change, toggle, click, apply, cancel, setBusy: (value: boolean) => { busy = value; } };
}

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type CapturedTool = { inputSchema: z.ZodType; handler: (request: unknown) => Promise<ToolResult> };
function toolsFixture(project: EditProject) {
  const tools = new Map<string, CapturedTool>();
  const register = vi.fn((name: string, configuration: unknown, handler: unknown) => {
    const config = configuration as { inputSchema: z.ZodType };
    tools.set(name, { inputSchema: config.inputSchema, handler: handler as CapturedTool["handler"] });
  });
  storage.read.mockImplementation(async () => structuredClone(project));
  registerReferenceMotionTemplateTools({ registerTool: register } as unknown as McpServer,
    { EDITKIN_FONT_ROOT: resolve(dirname(fileURLToPath(import.meta.url)), "../../public/fonts") });
  async function call(name: string, request: unknown) {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Actual registered tool missing: ${name}`);
    const result = await tool.handler(tool.inputSchema.parse(request));
    const content = result.content.find(item => item.type === "text");
    if (!content?.text) throw new Error("Actual tool omitted complete JSON text result");
    return { result, body: JSON.parse(content.text) as Record<string, unknown> };
  }
  return { tools, call };
}
beforeEach(() => { slots.values = []; slots.cursor = 0; storage.read.mockReset(); });

describe("strict opt-in semantic strike authoring", () => {
  it("keeps omitted historical input omitted and retains both explicit legal presentations", () => {
    const historical = referenceMotionTemplateInputSchema.parse(inputFixture());
    expect(Object.hasOwn(historical, "strikePresentation")).toBe(false);
    expect(Object.hasOwn(historical, "brandMark")).toBe(false);
    for (const strikePresentation of ["legacy_layout", "semantic_replace_v1"] as const) {
      expect(referenceMotionTemplateInputSchema.parse({ ...inputFixture(), strikePresentation }).strikePresentation).toBe(strikePresentation);
    }
    expect(referenceMotionTemplateInputSchema.shape.strikePresentation.parse("semantic_replace_v1")).toBe("semantic_replace_v1");
    expect(REFERENCE_MOTION_SEMANTIC_REPLACE_CONTRACT).toMatchObject({ id: "editkin.strike-semantic-replacement/v1",
      focus: "same_anchor", oldPhrase: "exits_before_replacement", ink: "editkin.motion-vector-annotation/v1",
      persistentEyebrow: "first_and_last_frame", supportLine: "physical_title_bounds", brandMark: "text_wordmark_not_image_logo" });
  });
  it("rejects presentation or wordmark on every other family and rejects wordmarks on legacy or omitted mode", () => {
    for (const recipe of REFERENCE_MOTION_TEMPLATES.filter(item => item.id !== "strike_reframe")) {
      for (const strikePresentation of ["legacy_layout", "semantic_replace_v1"]) {
        expect(referenceMotionTemplateInputSchema.safeParse({ ...inputFixture(), templateId: recipe.id, strikePresentation }).success).toBe(false);
      }
      expect(referenceMotionTemplateInputSchema.safeParse({ ...inputFixture(), templateId: recipe.id, brandMark: "自己的字標" }).success).toBe(false);
    }
    for (const strikePresentation of [undefined, "legacy_layout"]) {
      expect(referenceMotionTemplateInputSchema.safeParse({ ...inputFixture(), strikePresentation, brandMark: "自己的字標" }).success).toBe(false);
    }
  });
  it("counts wordmarks by Unicode codepoints, rejects blank/overlong/image carriers, and keeps strict unknown-field refusal", () => {
    const semantic = { ...inputFixture(), strikePresentation: "semantic_replace_v1" as const };
    const sixteen = "🟦".repeat(16);
    expect(referenceMotionTemplateInputSchema.parse({ ...semantic, brandMark: ` ${sixteen} ` }).brandMark).toBe(sixteen);
    expect(referenceMotionTemplateInputSchema.parse({ ...semantic, brandMark: " 原創文字 " }).brandMark).toBe("原創文字");
    for (const brandMark of [" ", "字".repeat(17), "🟦".repeat(17), { uri: "third-party-logo.svg" }]) {
      expect(referenceMotionTemplateInputSchema.safeParse({ ...semantic, brandMark }).success).toBe(false);
    }
    expect(referenceMotionTemplateInputSchema.safeParse({ ...semantic, logoAssetId: "unbound-image" }).success).toBe(false);
    expect(referenceMotionTemplateInputSchema.safeParse({ ...semantic, strikePresentation: "semantic_replace_v2" }).success).toBe(false);
  });
});

describe("actual new strike UI handlers", () => {
  it("submits explicit semantic replacement and brisk by default with the wordmark off", () => {
    const ui = uiFixture(); expect(ui.find("aria-label", "刪線呈現").props.value).toBe("semantic_replace_v1");
    expect(ui.find("aria-label", "加入文字字標").props.checked).toBe(false);
    expect(ui.render().some(node => node.props["aria-label"] === "模板文字字標")).toBe(false);
    ui.click(); expect(ui.apply).toHaveBeenCalledTimes(1);
    expect(ui.apply.mock.calls[0][0]).toMatchObject({ templateId: "strike_reframe", strikePresentation: "semantic_replace_v1",
      graphicCadence: "brisk", title: "看清真正重點", previousText: "只靠堆疊效果" });
    expect(Object.hasOwn(ui.apply.mock.calls[0][0], "brandMark")).toBe(false);
  });
  it("only forwards an explicitly enabled, trimmed wordmark and blocks blank or excessive enabled text", () => {
    const ui = uiFixture(); ui.toggle("加入文字字標", true);
    expect(ui.find("data-testid", "apply-reference-motion-template").props.disabled).toBe(true);
    ui.click(); expect(ui.apply).not.toHaveBeenCalled();
    ui.change("模板文字字標", "字".repeat(17));
    expect(ui.find("data-testid", "apply-reference-motion-template").props.disabled).toBe(true);
    ui.click(); expect(ui.apply).not.toHaveBeenCalled();
    ui.change("模板文字字標", "  我的原創字標  "); ui.click();
    expect(ui.apply.mock.calls[0][0].brandMark).toBe("我的原創字標");
    ui.toggle("加入文字字標", false); ui.click(); expect(Object.hasOwn(ui.apply.mock.calls[1][0], "brandMark")).toBe(false);
  });
  it("allows sixteen astral codepoints instead of restricting wordmarks to sixteen UTF16 units", () => {
    const ui = uiFixture(), mark = "🟦".repeat(16); ui.toggle("加入文字字標", true); ui.change("模板文字字標", mark);
    expect(ui.find("aria-label", "模板文字字標").props.maxLength).toBe(32);
    expect(ui.find("data-testid", "apply-reference-motion-template").props.disabled).toBe(false);
    ui.click(); expect(ui.apply.mock.calls[0][0].brandMark).toBe(mark);
  });
  it("honors explicit legacy and prevents inactive mode or family from leaking the wordmark", () => {
    const ui = uiFixture(); ui.toggle("加入文字字標", true); ui.change("模板文字字標", "我的字標");
    ui.change("刪線呈現", "legacy_layout");
    expect(ui.render().some(node => node.props["aria-label"] === "加入文字字標")).toBe(false);
    ui.click(); expect(ui.apply.mock.calls[0][0].strikePresentation).toBe("legacy_layout");
    expect(Object.hasOwn(ui.apply.mock.calls[0][0], "brandMark")).toBe(false);
    ui.change("參考 Motion 模板", "level_bridge"); ui.click();
    const other = ui.apply.mock.calls[1][0];
    expect(Object.hasOwn(other, "strikePresentation")).toBe(false); expect(Object.hasOwn(other, "brandMark")).toBe(false);
    expect(other.templateId).toBe("level_bridge"); expect(other.graphicCadence).toBe("brisk");
  });
  it("refuses busy presentation/wordmark changes and submission, while keeping actual cancellation", () => {
    const ui = uiFixture(); ui.toggle("加入文字字標", true); ui.change("模板文字字標", "我的字標"); ui.setBusy(true);
    expect(ui.render().find(node => node.type === "fieldset")?.props.disabled).toBe(true);
    ui.change("刪線呈現", "legacy_layout"); ui.change("模板文字字標", "被阻擋"); ui.toggle("加入文字字標", false); ui.click();
    expect(ui.find("aria-label", "刪線呈現").props.value).toBe("semantic_replace_v1");
    expect(ui.find("aria-label", "模板文字字標").props.value).toBe("我的字標");
    expect(ui.find("aria-label", "加入文字字標").props.checked).toBe(true); expect(ui.apply).not.toHaveBeenCalled();
    (ui.find("data-testid", "cancel-reference-motion-template").props.onClick as () => void)(); expect(ui.cancel).toHaveBeenCalledTimes(1);
    ui.setBusy(false); ui.click(); expect(ui.apply.mock.calls[0][0].brandMark).toBe("我的字標");
  });
});

describe("actual registered MCP strike authoring adapter", () => {
  it("declares the new optional text presentation separately from immutable recipe descriptors and image Logo support", async () => {
    const f = toolsFixture(projectFixture()), result = await f.call("list_reference_motion_templates", {});
    expect(result.result.isError).toBeUndefined();
    expect(result.body).toMatchObject({ generation: 2, persistentProjectSchema: 10,
      execution: "v4 audit/apply/render required", strikePresentationCapabilities: {
        strike_reframe: { newAuthoringDefault: "semantic_replace_v1", historicalOmittedDefault: "legacy_layout",
          supported: ["legacy_layout", "semantic_replace_v1"], authoringGeneration: 2,
          brandMark: { kind: "editable_text", optIn: true, maximumCodepoints: 16, imageLogoSupported: false } },
        savedInstanceAutomaticUpgrade: false, brandOwnership: "caller_declared_not_verified" } });
    expect(result.body.templates).toEqual(REFERENCE_MOTION_TEMPLATES); expect(storage.read).not.toHaveBeenCalled();
  });
  it("preserves cross-field refusal in the actual safeExtended MCP input schema before any storage read", () => {
    const f = toolsFixture(projectFixture()), schema = f.tools.get("prepare_reference_motion_template")!.inputSchema;
    expect(schema.safeParse({ ...inputFixture(), projectPath: "owned-project.json", templateId: "level_bridge",
      strikePresentation: "semantic_replace_v1" }).success).toBe(false);
    expect(schema.safeParse({ ...inputFixture(), projectPath: "owned-project.json", brandMark: "未綁呈現" }).success).toBe(false);
    expect(schema.safeParse({ ...inputFixture(), projectPath: "owned-project.json", strikePresentation: "semantic_replace_v1",
      brandMark: "自己的字標" }).success).toBe(true);
    expect(storage.read).not.toHaveBeenCalled();
  });
  it("prepares omitted new-authoring strike as explicit semantic using actual physical glyphs without mutating the project", async () => {
    const project = projectFixture(), before = canonicalJson(project), f = toolsFixture(project);
    const result = await f.call("prepare_reference_motion_template", { ...inputFixture(), projectPath: "owned-project.json" });
    expect(result.result.isError).toBeUndefined();
    expect(result.body).toMatchObject({ instance: { authoringGeneration: 2, input: {
      templateId: "strike_reframe", strikePresentation: "semantic_replace_v1", graphicCadence: "brisk" } },
      preparation: { schema: "editkin.reference-motion-template-preparation/v2", applied: false } });
    const bindings = result.body.physicalLayoutBindings as { physicalFont: { faceId: string; fontSha256: string } }[];
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings.every(binding => binding.physicalFont.faceId.includes("noto-") && /^[a-f0-9]{64}$/.test(binding.physicalFont.fontSha256))).toBe(true);
    expect(canonicalJson(project)).toBe(before); expect(storage.read).toHaveBeenCalledTimes(2);
  }, 20_000);
  it("respects explicit legacy at real MCP preparation and does not upgrade other families", async () => {
    const project = projectFixture(), f = toolsFixture(project);
    const legacy = await f.call("prepare_reference_motion_template", { ...inputFixture(), projectPath: "owned-project.json", strikePresentation: "legacy_layout" });
    expect(legacy.result.isError).toBeUndefined();
    expect(legacy.body).toMatchObject({ instance: { input: { templateId: "strike_reframe", strikePresentation: "legacy_layout" } } });
    const other = await f.call("prepare_reference_motion_template", { ...inputFixture(), templateId: "level_bridge", projectPath: "owned-project.json" });
    expect(other.result.isError).toBeUndefined();
    const otherInput = (other.body.instance as { input: ReferenceMotionTemplateInput }).input;
    expect(Object.hasOwn(otherInput, "strikePresentation")).toBe(false); expect(Object.hasOwn(otherInput, "brandMark")).toBe(false);
  }, 20_000);
  it("refuses the new prepared presentation if the real adapter reads a changed project before returning commands", async () => {
    const project = projectFixture(), f = toolsFixture(project), changed = structuredClone(project);
    changed.revision += 1;
    storage.read.mockReset().mockResolvedValueOnce(structuredClone(project)).mockResolvedValueOnce(changed);
    const result = await f.call("prepare_reference_motion_template", { ...inputFixture(), projectPath: "owned-project.json" });
    expect(result.result.isError).toBe(true);
    expect(result.body).toMatchObject({ status: "BLOCK" });
    expect(result.body.error).toMatch(/Motion template project changed on disk during preparation/);
    expect(Object.hasOwn(result.body, "commands")).toBe(false); expect(storage.read).toHaveBeenCalledTimes(2);
  }, 20_000);
});
