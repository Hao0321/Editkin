/**
 * Editkin module layer (editkin.module/v1): one manifest shape over every
 * module system (motion presets, original elements, motion kit, clip motion,
 * scenes, creative presets, music video, montage, templates, …) so agents and
 * Video Autopilot can discover and prepare any of them through one tool.
 * Existing dedicated tools stay; modules wrap the same compilers.
 */
export const EDITKIN_MODULE_SCHEMA = "editkin.module/v1" as const;
export const EDITKIN_MODULE_INVOCATION_SCHEMA = "editkin.module-invocation/v1" as const;
export const EDITKIN_MODULE_REGISTRY_SCHEMA = "editkin.module-registry-identity/v1" as const;
export const EDITKIN_MODULE_INDEX_SCHEMA = "editkin.module-index/v1" as const;

export const MODULE_KINDS = ["graphic", "clip_motion", "scene", "overlay", "look", "effect", "transition", "text_style",
  "edit_recipe", "music_video", "audio", "asset", "template", "plugin", "background"] as const;
export type ModuleKind = typeof MODULE_KINDS[number];

/** available: prepare_editkin_module compiles it · dedicated_tool: use the named tool (evidence-bound or stateful flows)
 * · planning_only: guidance, no commands · withdrawn: listed for completeness, not usable now. */
export const MODULE_STATUSES = ["available", "dedicated_tool", "planning_only", "withdrawn"] as const;
export type ModuleStatus = typeof MODULE_STATUSES[number];

export const MODULE_FORMATS = ["landscape", "portrait", "square"] as const;
export type ModuleFormat = typeof MODULE_FORMATS[number];
export type ModuleLayer = "clip" | "overlay" | "scene" | "project" | "timeline";

export interface ModuleVariant {
  id: string;
  name: string;
  use?: string;
  family?: string;
  roles?: string[];
  formats?: ModuleFormat[];
  intensity?: string;
  /** Motion library variants: "certified" only while Claude's revision pin matches (certifications.ts); auto-pick never takes "pending". */
  artStatus?: "certified" | "pending";
  /** Style templates (graphic.style_template): false while the template only declares its slots (its art is still being made). */
  implemented?: boolean;
  /** Style templates: the editable slots (text, palette colours, pictures) and the component targets each one feeds. */
  slots?: ModuleVariantSlotsV1;
  /** Style templates: the clip component (renderer-agnostic: svg or mesh3d), its parts, output and length. */
  clip?: { component: string; renderer: string; parts: string[]; output: string; seconds: { default: number; min: number; max: number } };
}

/** Editable slots of a style template variant: labels in the five UI languages, limits, and `component.target:consumer` bindings. */
export interface ModuleVariantSlotsV1 {
  text: Array<{ id: string; label: Record<string, string>; maxLength: number; role: string; required: boolean; consumers: string[] }>;
  color: Array<{ role: string; label: Record<string, string>; default: string | null; consumers: string[] }>;
  image: Array<{ id: string; label: Record<string, string>; aspect: Record<string, number>; fit: string; focal: number[]; placeholder: string | null; required: boolean; consumers: string[] }>;
}

export interface ModuleManifest {
  schema: typeof EDITKIN_MODULE_SCHEMA;
  id: string;
  kind: ModuleKind;
  version: string;
  name: string;
  summary: string;
  status: ModuleStatus;
  /** Request field the chosen variant id fills; absent when variants are informational. */
  variantField?: string;
  variants: ModuleVariant[];
  roles: string[];
  formats: ModuleFormat[];
  layer: ModuleLayer;
  output: { commandTypes: string[]; carriers: string[] };
  requires: string[];
  invoke: { tool: string };
  legacy: { tools: string[] };
  autopilot: { use: string; avoid?: string };
}

export interface ModuleCall {
  projectPath: string;
  variantId?: string;
  inputs: Record<string, unknown>;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Long compilers (motion library renders) report progress here; the MCP tool forwards it as notifications/progress. */
  onProgress?: (progress: { progress: number; total: number; message?: string }) => void;
}

/** One adapter per module: its manifest and, for available modules, the read-only compiler call. */
export interface ModuleAdapter {
  manifest: Omit<ModuleManifest, "schema">;
  /** The request schema the compiler validates (projectPath and the variant field are filled in automatically). */
  inputSchema?: import("zod/v4").ZodType;
  prepare?: (call: ModuleCall) => Promise<Record<string, unknown>>;
}

/** Schema and read-only compiler only; metadata has an independent discovery lifetime. */
export type ModuleRuntimeAdapterV2 = Pick<ModuleAdapter, "inputSchema" | "prepare">;
