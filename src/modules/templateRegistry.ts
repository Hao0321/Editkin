import { createHash } from "node:crypto";
import { AUTOPILOT_MAX_COMMANDS } from "../application/autopilotPlan";
import { MOTION_TREATMENT_FAMILIES, motionCommandFamilies } from "../application/motionTreatment";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { projectDuration } from "../domain/editGraph";
import type { EditProject } from "../domain/types";
import { readProject } from "../mcp/storage";
import { canonicalJson } from "../shared/canonicalJson";
import { editkinModuleRegistry, prepareEditkinModule } from "./moduleRegistry";
import type { ModuleFormat, ModuleLayer } from "./moduleTypes";
import {
  COMPOSITION_TEMPLATES, EDITKIN_TEMPLATE_INDEX_SCHEMA, EDITKIN_TEMPLATE_INVOCATION_SCHEMA, EDITKIN_TEMPLATE_SCHEMA, TEMPLATE_PLACEMENTS,
  type CompositionTemplate, type TemplateSlot, type TemplateSlotOption,
} from "./templateCatalog";

const sha256 = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
const TEMPLATE_ID = /^[a-z]+\.[a-z_]+$/;

type Template = CompositionTemplate & { schema: typeof EDITKIN_TEMPLATE_SCHEMA };
interface TemplateRegistry {
  identity: Readonly<{ schema: "editkin.template-registry-identity/v1"; sha256: string; templateCount: number; moduleRegistrySha256: string }>;
  templates: readonly Template[];
  get(id: string): { template: Template; sha256: string } | undefined;
}

function assertTemplate(template: CompositionTemplate) {
  const fail = (reason: string): never => { throw new Error(`模板 ${template.id} 定義錯誤：${reason}`); };
  const modules = editkinModuleRegistry();
  if (!TEMPLATE_ID.test(template.id)) fail("id 必須是 group.name 小寫");
  if (!template.formats.length) fail("formats 不可空白");
  const checkModule = (moduleId: string, variantIds: readonly string[] | undefined, where: string) => {
    const manifest = modules.get(moduleId)?.manifest;
    if (!manifest) return fail(`${where} 引用未知模組 ${moduleId}`);
    if (manifest.status !== "available") fail(`${where} 的 ${moduleId} 不是 available 模組`);
    for (const format of template.formats) if (!manifest.formats.includes(format)) fail(`${where} 的 ${moduleId} 不支援 ${format}`);
    for (const variantId of variantIds ?? []) {
      const variant = manifest.variants.find(item => item.id === variantId);
      if (!variant) fail(`${where} 的 ${moduleId} 沒有 variant ${variantId}`);
      if (variant?.formats?.length && template.formats.some(format => !variant.formats!.includes(format))) fail(`${where} 的 ${variantId} 不支援模板版型`);
    }
  };
  if (template.base) checkModule(template.base.moduleId, [template.base.variantId], "base");
  if (new Set(template.slots.map(slot => slot.id)).size !== template.slots.length) fail("slot id 重複");
  for (const slot of template.slots) {
    if (!/^[a-z][a-z0-9_]*$/.test(slot.id)) fail(`slot ${slot.id} id 不合法`);
    if (!(TEMPLATE_PLACEMENTS as readonly string[]).includes(slot.placement)) fail(`slot ${slot.id} placement 不合法`);
    if (!Number.isInteger(slot.min) || !Number.isInteger(slot.max) || slot.min < 0 || slot.max < 1 || slot.min > slot.max) fail(`slot ${slot.id} 數量範圍不合法`);
    if (!slot.options.length || new Set(slot.options.map(option => option.moduleId)).size !== slot.options.length) fail(`slot ${slot.id} 選項重複或空白`);
    for (const option of slot.options) {
      checkModule(option.moduleId, option.variantIds, `slot ${slot.id}`);
      if (option.variantIds && !option.variantIds.length) fail(`slot ${slot.id} 的 variantIds 不可空白`);
    }
  }
}

let cached: TemplateRegistry | undefined;

/** Built once, frozen; every slot is checked against the live module registry. */
export function editkinTemplateRegistry(): TemplateRegistry {
  if (cached) return cached;
  const entries = COMPOSITION_TEMPLATES.map(definition => {
    assertTemplate(definition);
    const template = Object.freeze({ schema: EDITKIN_TEMPLATE_SCHEMA, ...structuredClone(definition) }) as Template;
    return { template, sha256: sha256(template) };
  });
  const byId = new Map(entries.map(entry => [entry.template.id, entry]));
  if (byId.size !== entries.length) throw new Error("模板 id 重複");
  const moduleRegistrySha256 = editkinModuleRegistry().identity.sha256;
  const identity = Object.freeze({ schema: "editkin.template-registry-identity/v1" as const,
    sha256: sha256([moduleRegistrySha256, entries.map(entry => [entry.template.id, entry.sha256])]), templateCount: entries.length, moduleRegistrySha256 });
  cached = Object.freeze({ identity, templates: Object.freeze(entries.map(entry => entry.template)), get: (id: string) => byId.get(id) });
  return cached;
}

/** Compact index of every composition template. */
export function listEditkinTemplates(query: { format?: ModuleFormat } = {}) {
  const registry = editkinTemplateRegistry();
  const templates = registry.templates.filter(template => !query.format || template.formats.includes(query.format));
  return {
    schema: EDITKIN_TEMPLATE_INDEX_SCHEMA, registry: registry.identity, total: templates.length,
    templates: templates.map(template => ({ id: template.id, name: template.name, summary: template.summary, bestFor: template.bestFor, formats: template.formats,
      base: template.base ?? null, slots: template.slots.map(slot => ({ id: slot.id, name: slot.name, placement: slot.placement, min: slot.min, max: slot.max,
        modules: slot.options.map(option => option.moduleId) })) })),
    next: "list_editkin_templates({templateId}) shows slot options, variants and guidance; prepare_editkin_template compiles fills.",
  };
}

/** One template in full, with each slot option's module requirements. */
export function describeEditkinTemplate(templateId: string) {
  const registry = editkinTemplateRegistry();
  const entry = registry.get(templateId);
  if (!entry) throw new Error(`未知模板：${templateId}（用 list_editkin_templates 查詢）`);
  const modules = editkinModuleRegistry();
  return { schema: EDITKIN_TEMPLATE_SCHEMA, registry: registry.identity, templateSha256: entry.sha256, template: entry.template,
    slotModules: Object.fromEntries(entry.template.slots.map(slot => [slot.id, slot.options.map(option => {
      const manifest = modules.get(option.moduleId)!.manifest;
      return { moduleId: option.moduleId, variantField: manifest.variantField ?? null, variants: option.variantIds ?? manifest.variants.map(variant => variant.id),
        defaults: option.defaults ?? {}, requires: manifest.requires, output: manifest.output };
    })])),
    fillShape: { slotId: "slot id", moduleId: "optional — defaults to the slot's first option", variantId: "optional — defaults to the option's first variant",
      beatId: "the v4 narrative beat this fill serves (motion treatment needs it); base takes one too: base: {clipIds, beatId}", inputs: "module inputs (list_editkin_modules({moduleId}) shows the schema)" },
    autoFilled: { "graphic.motion_preset": ["expectedRevision", "scope=existing_timeline", "graphicId"] },
  };
}

export interface TemplateFill { slotId: string; moduleId?: string; variantId?: string; beatId?: string; inputs?: Record<string, unknown> }
export interface TemplatePrepareRequest {
  projectPath: string; templateId: string; expectedRevision?: number; base?: { clipIds: string[]; beatId?: string } | null; fills: TemplateFill[];
  /** summary omits the command bodies (dry run for timing, pacing and budget); full returns them for the plan. */
  include?: "summary" | "full";
  /** v4 plan commands kept free for the rest of the plan (aesthetic system, cuts, audio…). */
  reserveCommands?: number;
}

const V4_EDITORIAL_GRAPHICS_CAP = 64;

/** Splits fills, in order, into consecutive groups that each fit one v4 plan next to the reserved commands. */
function planGroups(fills: ReadonlyArray<{ fill: number; commandRange: readonly [number, number]; editorialGraphicsCount: number }>, budget: number) {
  const groups: Array<{ fills: number[]; commandCount: number; editorialGraphicsCount: number; overBudget: boolean }> = [];
  for (const fill of fills) {
    const count = fill.commandRange[1] - fill.commandRange[0], last = groups.at(-1);
    if (last && last.commandCount + count <= budget && last.editorialGraphicsCount + fill.editorialGraphicsCount <= V4_EDITORIAL_GRAPHICS_CAP) {
      last.fills.push(fill.fill); last.commandCount += count; last.editorialGraphicsCount += fill.editorialGraphicsCount;
    } else {
      groups.push({ fills: [fill.fill], commandCount: count, editorialGraphicsCount: fill.editorialGraphicsCount,
        overBudget: count > budget || fill.editorialGraphicsCount > V4_EDITORIAL_GRAPHICS_CAP });
    }
  }
  return groups;
}

function resolveOption(slot: TemplateSlot, fill: TemplateFill): TemplateSlotOption {
  const option = fill.moduleId ? slot.options.find(item => item.moduleId === fill.moduleId) : slot.options[0];
  if (!option) throw new Error(`slot ${slot.id} 不接受模組 ${fill.moduleId}（可用：${slot.options.map(item => item.moduleId).join("、")}）`);
  return option;
}

function projectFormat(project: EditProject): ModuleFormat {
  return project.height > project.width ? "portrait" : project.height === project.width ? "square" : "landscape";
}

interface Window { fill: number; slotId: string; layer: ModuleLayer; start: number; end: number }

/** Time span of the designed (scene/overlay) layers a fill adds. */
function designedWindow(commands: readonly EditorCommand[]): { start: number; end: number } | undefined {
  const spans = commands.flatMap(command => command.type === "add_motion_graphic" ? [[command.graphic.timelineStart, command.graphic.timelineStart + command.graphic.duration]]
    : command.type === "add_clip" && command.clip.floatingFrame ? [[command.clip.timelineStart, command.clip.timelineStart + command.clip.duration]] : []);
  if (!spans.length) return undefined;
  return { start: Math.min(...spans.map(span => span[0])), end: Math.max(...spans.map(span => span[1])) };
}

function pacingWarnings(template: CompositionTemplate, windows: Window[], duration: number): string[] {
  const warnings: string[] = [];
  const sorted = [...windows].sort((a, b) => a.start - b.start || a.end - b.end);
  const round = (value: number) => Math.round(value * 100) / 100;
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1], current = sorted[index];
    if (previous.layer === "scene" && current.layer === "scene" && current.start < previous.end) {
      warnings.push(`全幅場景重疊：${previous.slotId}（fill ${previous.fill}）與 ${current.slotId}（fill ${current.fill}）在 ${round(current.start)}s`);
    } else if (current.start >= previous.end && current.start - previous.end < template.pacing.minDesignedGapSeconds) {
      warnings.push(`設計元素間隔 ${round(current.start - previous.end)}s 少於 ${template.pacing.minDesignedGapSeconds}s：${previous.slotId} → ${current.slotId}（${round(current.start)}s）`);
    }
  }
  const overlays = windows.filter(window => window.layer === "overlay");
  for (const window of overlays) {
    const concurrent = overlays.filter(other => other.start <= window.start && other.end > window.start).length;
    if (concurrent > template.pacing.maxConcurrentOverlays) {
      warnings.push(`${round(window.start)}s 同時有 ${concurrent} 個疊加元素（上限 ${template.pacing.maxConcurrentOverlays}）`);
      break;
    }
  }
  let covered = 0, cursor = -Infinity;
  for (const window of sorted) {
    const start = Math.max(window.start, cursor);
    if (window.end > start) covered += window.end - start;
    cursor = Math.max(cursor, window.end);
  }
  if (duration > 0 && covered / duration > template.pacing.maxDesignedShare) {
    warnings.push(`設計元素佔片長 ${Math.round(covered / duration * 100)}%，超過模板上限 ${Math.round(template.pacing.maxDesignedShare * 100)}%`);
  }
  return warnings;
}

/**
 * Read-only: compiles a composition template's fills through the module layer
 * into one ordered command list, proves the commands compose on an in-memory
 * copy of the project, merges index-bearing carriers and reports motion
 * treatment coverage per family. The project file is never written.
 */
export async function prepareEditkinTemplate(request: TemplatePrepareRequest, context: { environment?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}) {
  const registry = editkinTemplateRegistry();
  const entry = registry.get(request.templateId);
  if (!entry) throw new Error(`未知模板：${request.templateId}（用 list_editkin_templates 查詢）`);
  const { template, sha256: templateSha256 } = entry;
  const project = await readProject(request.projectPath);
  if (request.expectedRevision !== undefined && request.expectedRevision !== project.revision) {
    throw new Error(`專案已變更：預期 revision ${request.expectedRevision}，實際 ${project.revision}`);
  }
  const format = projectFormat(project);
  if (!template.formats.includes(format)) throw new Error(`模板 ${template.id} 只支援 ${template.formats.join("／")}，此專案是 ${format}`);
  if (request.base && !template.base) throw new Error(`模板 ${template.id} 沒有 base 視覺包`);
  if (!request.fills.length && !request.base) throw new Error("至少需要一個 fill 或 base");

  const counts = new Map<string, number>();
  const calls = request.fills.map((fill, index) => {
    const slot = template.slots.find(item => item.id === fill.slotId);
    if (!slot) throw new Error(`模板 ${template.id} 沒有 slot：${fill.slotId}（可用：${template.slots.map(item => item.id).join("、")}）`);
    const count = (counts.get(slot.id) ?? 0) + 1;
    if (count > slot.max) throw new Error(`slot ${slot.id} 最多 ${slot.max} 個 fill`);
    counts.set(slot.id, count);
    const option = resolveOption(slot, fill);
    if (fill.variantId && option.variantIds && !option.variantIds.includes(fill.variantId)) {
      throw new Error(`slot ${slot.id} 的 ${option.moduleId} 不接受 variant ${fill.variantId}（可用：${option.variantIds.join("、")}）`);
    }
    const variantId = fill.variantId ?? option.variantIds?.[0];
    let inputs: Record<string, unknown> = { ...(option.defaults ?? {}), ...(fill.inputs ?? {}) };
    if (option.moduleId === "graphic.motion_preset") {
      inputs = { expectedRevision: project.revision, scope: "existing_timeline", graphicId: `${template.id.replace(/[^a-z0-9]+/g, "-")}-${slot.id}-${count}`, ...inputs };
    }
    return { index, slot, moduleId: option.moduleId, variantId, beatId: fill.beatId, inputs };
  });
  const missing = template.slots.filter(slot => (counts.get(slot.id) ?? 0) < slot.min).map(slot => ({ slotId: slot.id, min: slot.min, filled: counts.get(slot.id) ?? 0 }));

  const modules = editkinModuleRegistry();
  const prepared: Array<{ slotId: string; moduleId: string; variantId?: string; beatId?: string; layer: ModuleLayer; result: Awaited<ReturnType<typeof prepareEditkinModule>> }> = [];
  const compile = async (slotId: string, moduleId: string, variantId: string | undefined, beatId: string | undefined, inputs: Record<string, unknown>) => {
    context.signal?.throwIfAborted();
    const result = await prepareEditkinModule({ projectPath: request.projectPath, moduleId, variantId, inputs }, context).catch((error: unknown) => {
      throw new Error(`slot ${slotId}（${moduleId}${variantId ? `/${variantId}` : ""}）編譯失敗：${error instanceof Error ? error.message : String(error)}`);
    });
    if (result.projectRevision !== null && result.projectRevision !== project.revision) throw new Error(`slot ${slotId} 編譯期間專案已變更，請重新讀取`);
    const manifestLayer = modules.get(moduleId)!.manifest.layer;
    prepared.push({ slotId, moduleId, variantId, beatId, layer: manifestLayer === "scene" && inputs.mode === "overlay" ? "overlay" : manifestLayer, result });
  };
  if (request.base && template.base) await compile("base", template.base.moduleId, template.base.variantId, request.base.beatId, { clipIds: request.base.clipIds });
  for (const call of calls) await compile(call.slot.id, call.moduleId, call.variantId, call.beatId, call.inputs);

  const commands: EditorCommand[] = [];
  const planInstances: Array<Record<string, unknown>> = [];
  const editorialGraphics: unknown[] = [];
  const windows: Window[] = [];
  const fills = prepared.map((item, fill) => {
    const offset = commands.length;
    const own = item.result.commands as unknown as EditorCommand[];
    commands.push(...own);
    const { planDeclaration, editorialGraphics: graphics, declarationIndexes: _declarationIndexes, ...carriers } = item.result.carriers as Record<string, unknown>;
    for (const instance of (planDeclaration as { instances?: Array<Record<string, unknown> & { commandIndexes: number[] }> } | undefined)?.instances ?? []) {
      planInstances.push({ ...instance, commandIndexes: instance.commandIndexes.map(index => index + offset) });
    }
    const editorialGraphicsCount = Array.isArray(graphics) ? graphics.length : 0;
    if (Array.isArray(graphics)) editorialGraphics.push(...graphics);
    const window = item.layer === "scene" || item.layer === "overlay" ? designedWindow(own) : undefined;
    if (window) windows.push({ fill, slotId: item.slotId, layer: item.layer, ...window });
    return { fill, slotId: item.slotId, moduleId: item.moduleId, variantId: item.variantId ?? null, beatId: item.beatId ?? null, layer: item.layer,
      commandRange: [offset, offset + own.length] as const, commandTypes: item.result.commandTypes, commandsSha256: item.result.commandsSha256,
      moduleStatus: item.result.status, editorialGraphicsCount, ...(window ? { window } : {}), carriers };
  });

  let simulated = project;
  commands.forEach((command, index) => {
    try { simulated = applyCommand(simulated, command); }
    catch (error) {
      const owner = fills.find(fill => index >= fill.commandRange[0] && index < fill.commandRange[1])!;
      throw new Error(`模板組合衝突：slot ${owner.slotId}（fill ${owner.fill}）第 ${index - owner.commandRange[0] + 1} 個命令 ${command.type} 無法套用：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const families = commands.map(motionCommandFamilies);
  const motionCoverage = MOTION_TREATMENT_FAMILIES.map(family => {
    const commandIndexes = families.flatMap((list, index) => list.includes(family) ? [index] : []);
    const owners = fills.filter(fill => commandIndexes.some(index => index >= fill.commandRange[0] && index < fill.commandRange[1]));
    return { family, suggestedAction: commandIndexes.length ? "use" as const : "omit" as const, commandIndexes,
      beatIds: [...new Set(owners.flatMap(fill => fill.beatId ? [fill.beatId] : []))], slots: [...new Set(owners.map(fill => fill.slotId))] };
  });
  const warnings = pacingWarnings(template, windows, projectDuration(simulated));
  // The base look/caption package is a visible treatment too: v4 "use" rows need a beat, so the base binds one like any fill.
  const unboundFills = fills.filter(fill => !fill.beatId).map(fill => fill.fill);
  const reserveCommands = request.reserveCommands ?? 10;
  if (!Number.isInteger(reserveCommands) || reserveCommands < 0 || reserveCommands >= AUTOPILOT_MAX_COMMANDS) throw new Error(`reserveCommands 必須是 0–${AUTOPILOT_MAX_COMMANDS - 1} 的整數`);
  const groups = planGroups(fills, AUTOPILOT_MAX_COMMANDS - reserveCommands);
  const full = request.include === "full";

  return {
    schema: EDITKIN_TEMPLATE_INVOCATION_SCHEMA, status: "REVIEW_REQUIRED" as const, readOnly: true, mutationPerformed: false,
    template: { id: template.id, version: template.version, sha256: templateSha256 }, templateRegistrySha256: registry.identity.sha256,
    moduleRegistrySha256: modules.identity.sha256, projectRevision: project.revision,
    checks: { composition: "PASS" as const, slots: missing.length ? "MISSING_REQUIRED" as const : "COMPLETE" as const, pacing: warnings.length ? "WARN" as const : "PASS" as const,
      beats: unboundFills.length ? "UNBOUND" as const : "BOUND" as const,
      v4Budget: groups.some(group => group.overBudget) ? "FILL_OVER_CAP" as const : groups.length > 1 ? "SPLIT_REQUIRED" as const : "SINGLE_PLAN" as const },
    missing, pacingWarnings: warnings, unboundFills,
    include: full ? "full" as const : "summary" as const,
    v4: { commandCap: AUTOPILOT_MAX_COMMANDS, editorialGraphicsCap: V4_EDITORIAL_GRAPHICS_CAP, reserveCommands, groups },
    commandCount: commands.length, commandsSha256: sha256(commands), ...(full ? { commands } : {}), fills,
    carriers: full ? { ...(planInstances.length ? { planDeclaration: { schema: "editkin.reference-motion-plan/v1", instances: planInstances } } : {}),
      ...(editorialGraphics.length ? { editorialGraphics } : {}) } : { planInstanceCount: planInstances.length, editorialGraphicsCount: editorialGraphics.length },
    motionCoverage,
    identity: template.identity,
    next: (full ? "" : "Summary only: rerun with include=\"full\" (through mcp-batch so the bodies land in a capture file) once timing, pacing and v4 groups are right. ")
      + "All indexes are relative to these commands: shift by their final offset in the v4 plan (video-autopilot editkin_modules.py merge does this). "
      + "Split into one v4 plan per v4.groups entry when v4Budget is SPLIT_REQUIRED. Declare editorial.motionTreatment for every family "
      + "(motionCoverage gives command indexes and beat ids; write reasons from material evidence), add editorialGraphics/planDeclaration, then audit_autopilot_plan → apply_autopilot_plan → render and review.",
  };
}
