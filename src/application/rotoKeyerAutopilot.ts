import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as z from "zod/v4";
import { CHROMA_KEY_PRESETS } from "../domain/chromaKey";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { findAsset, findClip } from "../domain/editGraph";
import type { ChromaKeySettings, ClipMask, EditProject, RotoMatteSequence } from "../domain/types";
import { compareUtf8Bytes } from "../shared/utf8ByteOrder";
import { attestProductExecutableIdentity, type ProductExecutableRuntimeKey } from "../service/autoRotoServiceArtifact";
import {
  analyzeProductAutoRoto,
  createProductAutoRotoRouteReceipt,
  parseProductAutoRotoRouteReceipt,
  PRODUCT_AUTO_ROTO_ENGINE,
  PRODUCT_AUTO_ROTO_ROUTE_POLICY,
  type ProductAutoRotoRouteReceipt,
} from "./autoRotoNativeProduct";
import {
  readMaterialIntelligence,
  verifyMaterialSemanticsReceipt,
  type MaterialIntelligencePacket,
} from "./materialIntelligence";

const SHA256 = /^[a-f0-9]{64}$/;
const sha256Schema = z.string().regex(SHA256);
const boundedIdSchema = z.string().trim().min(1).max(256);

export const ROTO_KEYER_EVIDENCE_SCHEMA = "hao.editkin.roto-keyer-evidence/v1" as const;
export const ROTO_KEYER_PLAN_SCHEMA = "hao.video-autopilot.roto-keyer-plan/v1" as const;
export const ROTO_KEYER_DECISION_SCHEMA = "hao.video-autopilot.roto-keyer-decision/v1" as const;
export const ROTO_KEYER_ROUTE_RECEIPT_SCHEMA = "editkin.roto-keyer-route-receipt/v1" as const;
export const AUTO_ROTO_PREPARATION_SCHEMA = "editkin.autopilot-auto-roto-preparation/v1" as const;
export const ROTO_KEYER_CAPABILITY_SCHEMA = "editkin.roto-keyer-capability-snapshot/v3" as const;
export const ROTO_KEYER_CONTRACT_REVISION = 3;
export const ROTO_KEYER_MAX_DECISION_TOKENS = 400;
export const ROTO_KEYER_MAX_DECISIONS = 16;

export type RotoKeyerRoute = "no_op" | "manual_mask" | "self_authored_auto_roto" | "self_authored_screen_keyer";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareUtf8Bytes(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function rotoKeyerSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", resolveHash);
  });
  return hash.digest("hex");
}

export async function verifyRotoKeyerSourceFile(sourcePath: string, expectedSha256: string): Promise<void> {
  if (!SHA256.test(expectedSha256)) throw new Error("Roto／Keyer source SHA-256 不合法");
  await access(sourcePath);
  if (await sha256File(sourcePath) !== expectedSha256) throw new Error("Roto／Keyer source file 已在 evidence 建立後改變");
}

async function writeJsonImmutable(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(path, encoded, { encoding: "utf8", flag: "wx" });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (await readFile(path, "utf8") !== encoded) throw new Error("同一 SHA-256 的 Roto／Keyer receipt 內容不一致");
}

function materialDirectory(cacheRoot: string, materialId: string): string {
  if (!SHA256.test(materialId)) throw new Error("Roto／Keyer materialId 不合法");
  return join(resolve(cacheRoot), "material-intelligence", materialId);
}

function evidencePath(cacheRoot: string, materialId: string, receiptSha256: string): string {
  if (!SHA256.test(receiptSha256)) throw new Error("Roto／Keyer evidence receipt SHA-256 不合法");
  return join(materialDirectory(cacheRoot, materialId), "roto-keyer", `${receiptSha256}.json`);
}

function preparationPath(cacheRoot: string, receiptSha256: string): string {
  if (!SHA256.test(receiptSha256)) throw new Error("Auto Roto preparation receipt SHA-256 不合法");
  return join(resolve(cacheRoot), "autopilot-auto-roto", `${receiptSha256}.json`);
}

const evidenceFrameSchema = z.strictObject({
  id: z.string().regex(/^kf-\d+$/),
  sha256: sha256Schema,
  time: z.number().nonnegative(),
});

const rotoKeyerEvidenceInputShape = {
  materialId: sha256Schema,
  sourceSha256: sha256Schema,
  semanticReceiptSha256: sha256Schema,
  assetId: boundedIdSchema,
  clipId: boundedIdSchema,
  observation: z.strictObject({
    subjectPresence: z.enum(["none", "single", "multiple", "ambiguous"]),
    screen: z.enum(["none", "green", "blue", "ambiguous"]),
    screenCoverage: z.number().min(0).max(1),
    edgeClass: z.enum(["solid", "hair_or_fur", "motion_blur", "translucent", "unknown"]),
    confidence: z.number().min(0).max(1),
    evidenceFrameIds: z.array(z.string().regex(/^kf-\d+$/)).min(1).max(8),
    uncertainty: z.string().trim().min(1).max(500).optional(),
    note: z.string().trim().min(1).max(800),
  }),
} as const;

export const rotoKeyerEvidenceInputSchema = z.strictObject(rotoKeyerEvidenceInputShape).superRefine((value, context) => {
  if (new Set(value.observation.evidenceFrameIds).size !== value.observation.evidenceFrameIds.length) {
    context.addIssue({ code: "custom", path: ["observation", "evidenceFrameIds"], message: "證據影格不可重複" });
  }
  if (value.observation.screen === "none" && value.observation.screenCoverage > .08) {
    context.addIssue({ code: "custom", path: ["observation", "screenCoverage"], message: "無色幕判定不可同時聲稱大面積色幕" });
  }
  if ((value.observation.screen === "green" || value.observation.screen === "blue") && value.observation.screenCoverage < .1) {
    context.addIssue({ code: "custom", path: ["observation", "screenCoverage"], message: "色幕覆蓋不足，不可自動 Key" });
  }
  if ((value.observation.screen === "ambiguous" || value.observation.subjectPresence === "ambiguous" || value.observation.confidence < .75)
    && !value.observation.uncertainty) {
    context.addIssue({ code: "custom", path: ["observation", "uncertainty"], message: "含糊或低信心判讀必須明列 uncertainty" });
  }
});

export const rotoKeyerEvidenceReceiptSchema = z.strictObject({
  schema: z.literal(ROTO_KEYER_EVIDENCE_SCHEMA),
  ...rotoKeyerEvidenceInputShape,
  evidenceFrames: z.array(evidenceFrameSchema).min(1).max(8),
  createdAt: z.iso.datetime(),
  receiptSha256: sha256Schema,
});
export type RotoKeyerEvidenceReceipt = z.infer<typeof rotoKeyerEvidenceReceiptSchema>;

export async function recordRotoKeyerEvidence(cacheRoot: string, input: z.infer<typeof rotoKeyerEvidenceInputSchema>): Promise<RotoKeyerEvidenceReceipt> {
  const parsed = rotoKeyerEvidenceInputSchema.parse(input);
  const [packet, semantics] = await Promise.all([
    readMaterialIntelligence(cacheRoot, parsed.materialId),
    verifyMaterialSemanticsReceipt(cacheRoot, parsed.materialId, parsed.semanticReceiptSha256),
  ]);
  if (packet.source.sourceSha256 !== parsed.sourceSha256 || semantics.sourceSha256 !== parsed.sourceSha256) {
    throw new Error("Roto／Keyer 證據的素材 SHA-256 已過期");
  }
  if (packet.source.assetId !== parsed.assetId || packet.source.clipId !== parsed.clipId) {
    throw new Error("Roto／Keyer 證據引用錯誤的素材或片段");
  }
  const frames = new Map(packet.keyframes.map((frame) => [frame.id, frame]));
  const evidenceFrames = parsed.observation.evidenceFrameIds.map((id) => {
    const frame = frames.get(id);
    if (!frame) throw new Error(`Roto／Keyer 證據引用不存在的影格：${id}`);
    return { id, sha256: frame.sha256, time: frame.time };
  });
  const base = { schema: ROTO_KEYER_EVIDENCE_SCHEMA, ...parsed, evidenceFrames, createdAt: new Date().toISOString() };
  const receipt = rotoKeyerEvidenceReceiptSchema.parse({ ...base, receiptSha256: rotoKeyerSha256(base) });
  await writeJsonImmutable(evidencePath(cacheRoot, receipt.materialId, receipt.receiptSha256), receipt);
  return receipt;
}

export async function verifyRotoKeyerEvidence(cacheRoot: string, materialId: string, receiptSha256: string): Promise<RotoKeyerEvidenceReceipt> {
  const receipt = rotoKeyerEvidenceReceiptSchema.parse(JSON.parse(await readFile(evidencePath(cacheRoot, materialId, receiptSha256), "utf8")));
  const { receiptSha256: sealed, ...base } = receipt;
  if (sealed !== receiptSha256 || rotoKeyerSha256(base) !== sealed) throw new Error("Roto／Keyer evidence receipt 完整性驗證失敗");
  const [packet, semantics] = await Promise.all([
    readMaterialIntelligence(cacheRoot, materialId),
    verifyMaterialSemanticsReceipt(cacheRoot, materialId, receipt.semanticReceiptSha256),
  ]);
  if (packet.source.sourceSha256 !== receipt.sourceSha256 || semantics.sourceSha256 !== receipt.sourceSha256
    || packet.source.assetId !== receipt.assetId || packet.source.clipId !== receipt.clipId) {
    throw new Error("Roto／Keyer evidence receipt 已因素材 identity 漂移而失效");
  }
  const frames = new Map(packet.keyframes.map((frame) => [frame.id, frame]));
  for (const frame of receipt.evidenceFrames) {
    const current = frames.get(frame.id);
    if (!current || current.sha256 !== frame.sha256 || current.time !== frame.time) throw new Error(`Roto／Keyer 證據影格已漂移：${frame.id}`);
  }
  return receipt;
}

export interface RotoKeyerRuntimePaths {
  ffmpegPath: string;
  nativeCorePath: string;
  cacheRoot: string;
}

export function defaultRotoKeyerRuntimePaths(): RotoKeyerRuntimePaths {
  const root = process.cwd();
  return {
    ffmpegPath: process.env.HAO_FFMPEG_PATH ?? resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe"),
    nativeCorePath: process.env.HAO_NATIVE_CORE_PATH ?? resolve(root, "native/bin/win32-x64/hao-core.exe"),
    cacheRoot: process.env.EDITKIN_CACHE_ROOT ?? resolve(process.env.EDITKIN_MODEL_ROOT ?? resolve(root, ".editkin-models"), "../media-cache"),
  };
}

export interface ExecutableIdentity {
  available: boolean;
  productAttested: boolean;
  sha256?: string;
  bytes?: number;
  reasonCode: "product-manifest-attested" | "product-identity-rejected" | "unstable-executable" | "runtime-unavailable";
}

async function executableIdentity(path: string, runtimeKey: ProductExecutableRuntimeKey): Promise<ExecutableIdentity> {
  try {
    const attested = attestProductExecutableIdentity(runtimeKey, path);
    return {
      available: true,
      productAttested: true,
      sha256: attested.sha256,
      bytes: attested.bytes,
      reasonCode: "product-manifest-attested",
    };
  } catch {
    try {
      const before = await stat(path);
      if (!before.isFile() || before.size <= 0) {
        return { available: false, productAttested: false, reasonCode: "runtime-unavailable" };
      }
      const sha256 = await sha256File(path);
      const after = await stat(path);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
        return { available: false, productAttested: false, reasonCode: "unstable-executable" };
      }
      return {
        available: true,
        productAttested: false,
        sha256,
        bytes: after.size,
        reasonCode: "product-identity-rejected",
      };
    } catch {
      return { available: false, productAttested: false, reasonCode: "runtime-unavailable" };
    }
  }
}

export interface RotoKeyerCapabilitySnapshot {
  schema: typeof ROTO_KEYER_CAPABILITY_SCHEMA;
  contractRevision: typeof ROTO_KEYER_CONTRACT_REVISION;
  routes: Array<{
    route: RotoKeyerRoute;
    engine: string;
    available: boolean;
    productEligible: boolean;
    qualityState: "editable" | "diagnostic" | "unmeasured" | "not_applicable";
    rights: "editkin-owned" | "not_applicable";
    reasonCode: string;
  }>;
  runtime: { nativeCore: ExecutableIdentity; ffmpeg: ExecutableIdentity };
  productEngineAdmission: {
    mode: "closed_world_route_enum";
    editkinOwnedOnly: true;
    externalModelPacksAllowed: false;
    researchRoutesAllowed: false;
  };
  snapshotSha256: string;
}

export async function inspectRotoKeyerCapabilities(runtime: RotoKeyerRuntimePaths = defaultRotoKeyerRuntimePaths()): Promise<RotoKeyerCapabilitySnapshot> {
  const [nativeCore, ffmpeg] = await Promise.all([
    executableIdentity(runtime.nativeCorePath, "nativeCore"),
    executableIdentity(runtime.ffmpegPath, "ffmpeg"),
  ]);
  const autoAvailable = nativeCore.available && nativeCore.productAttested && ffmpeg.available && ffmpeg.productAttested;
  const base: Omit<RotoKeyerCapabilitySnapshot, "snapshotSha256"> = {
    schema: ROTO_KEYER_CAPABILITY_SCHEMA,
    contractRevision: ROTO_KEYER_CONTRACT_REVISION as 3,
    routes: [
      { route: "no_op", engine: "none", available: true, productEligible: true, qualityState: "not_applicable", rights: "not_applicable", reasonCode: "explicit-no-op" },
      { route: "manual_mask", engine: "editkin-editgraph-manual-mask/v1", available: true, productEligible: true, qualityState: "editable", rights: "editkin-owned", reasonCode: "editable-manual-mask" },
      { route: "self_authored_auto_roto", engine: PRODUCT_AUTO_ROTO_ENGINE, available: autoAvailable, productEligible: autoAvailable, qualityState: "diagnostic", rights: "editkin-owned", reasonCode: autoAvailable ? "self-authored-runtime-ready" : "product-runtime-identity-rejected" },
      { route: "self_authored_screen_keyer", engine: "editkin-chroma-distance-keyer/v1", available: true, productEligible: true, qualityState: "unmeasured", rights: "editkin-owned", reasonCode: "self-authored-green-blue-keyer" },
    ] as RotoKeyerCapabilitySnapshot["routes"],
    runtime: { nativeCore, ffmpeg },
    productEngineAdmission: {
      mode: "closed_world_route_enum",
      editkinOwnedOnly: true,
      externalModelPacksAllowed: false,
      researchRoutesAllowed: false,
    },
  };
  return { ...base, snapshotSha256: rotoKeyerSha256(base) };
}

const routeReceiptSchema = z.strictObject({
  schema: z.literal(ROTO_KEYER_ROUTE_RECEIPT_SCHEMA),
  contractRevision: z.literal(ROTO_KEYER_CONTRACT_REVISION),
  mode: z.literal("product"),
  route: z.enum(["no_op", "manual_mask", "self_authored_auto_roto", "self_authored_screen_keyer"]),
  engine: z.enum(["none", "editkin-editgraph-manual-mask/v1", PRODUCT_AUTO_ROTO_ENGINE, "editkin-chroma-distance-keyer/v1"]),
  status: z.enum(["selected", "no_op"]),
  reasonCode: z.string().trim().min(1).max(128),
  evidenceReceiptSha256: sha256Schema,
  capabilitySnapshotSha256: sha256Schema,
  receiptSha256: sha256Schema,
});

const decisionBudgetSchema = z.strictObject({
  decisionContextTokens: z.number().int().min(1).max(ROTO_KEYER_MAX_DECISION_TOKENS),
  maxSourceDurationSeconds: z.number().min(0).max(14_400),
  maxAnalyzedFrames: z.number().int().min(0).max(172_800),
  maxMatteBytes: z.number().int().min(0).max(8 * 1024 * 1024 * 1024),
  actualSourceDurationSeconds: z.number().min(0).max(14_400),
  actualAnalyzedFrames: z.number().int().min(0).max(172_800),
  actualMatteBytes: z.number().int().min(0).max(8 * 1024 * 1024 * 1024),
});

export const rotoKeyerDecisionSchema = z.strictObject({
  schema: z.literal(ROTO_KEYER_DECISION_SCHEMA),
  projectId: boundedIdSchema,
  projectRevision: z.number().int().nonnegative(),
  materialId: sha256Schema,
  sourceSha256: sha256Schema,
  semanticReceiptSha256: sha256Schema,
  evidenceReceiptSha256: sha256Schema,
  capabilitySnapshotSha256: sha256Schema,
  assetId: boundedIdSchema,
  clipId: boundedIdSchema,
  route: z.enum(["no_op", "manual_mask", "self_authored_auto_roto", "self_authored_screen_keyer"]),
  engine: z.enum(["none", "editkin-editgraph-manual-mask/v1", PRODUCT_AUTO_ROTO_ENGINE, "editkin-chroma-distance-keyer/v1"]),
  screen: z.enum(["green", "blue"]).optional(),
  settingsSha256: sha256Schema.optional(),
  commandSha256: sha256Schema.optional(),
  preparationReceiptSha256: sha256Schema.optional(),
  autoRotoRouteReceiptSha256: sha256Schema.optional(),
  budget: decisionBudgetSchema,
  routeReceipt: routeReceiptSchema,
  humanReview: z.strictObject({
    required: z.literal(true),
    status: z.literal("pending"),
    reviewTarget: z.literal("preview_formal_render_and_reopen"),
  }),
  decisionSha256: sha256Schema,
}).superRefine((decision, context) => {
  const zeroCompute = decision.budget.maxSourceDurationSeconds === 0 && decision.budget.maxAnalyzedFrames === 0
    && decision.budget.maxMatteBytes === 0 && decision.budget.actualSourceDurationSeconds === 0
    && decision.budget.actualAnalyzedFrames === 0 && decision.budget.actualMatteBytes === 0;
  const issue = (path: string[], message: string) => context.addIssue({ code: "custom", path, message });
  if (decision.route === "no_op") {
    if (decision.engine !== "none" || decision.commandSha256 || decision.screen || decision.settingsSha256 || decision.preparationReceiptSha256 || !zeroCompute) issue(["route"], "no-op 不可夾帶引擎、命令、設定或運算");
  } else if (decision.route === "manual_mask") {
    if (decision.engine !== "editkin-editgraph-manual-mask/v1" || !decision.commandSha256 || decision.screen || decision.settingsSha256 || decision.preparationReceiptSha256 || !zeroCompute) issue(["route"], "手動遮罩 decision 綁定不完整");
  } else if (decision.route === "self_authored_screen_keyer") {
    if (decision.engine !== "editkin-chroma-distance-keyer/v1" || !decision.commandSha256 || !decision.screen || !decision.settingsSha256 || decision.preparationReceiptSha256 || !zeroCompute) issue(["route"], "Screen Keyer decision 綁定不完整");
  } else if (decision.engine !== PRODUCT_AUTO_ROTO_ENGINE || !decision.commandSha256 || !decision.preparationReceiptSha256
    || !decision.autoRotoRouteReceiptSha256 || decision.screen || decision.settingsSha256
    || decision.budget.actualSourceDurationSeconds <= 0 || decision.budget.actualAnalyzedFrames <= 0 || decision.budget.actualMatteBytes <= 0) {
    issue(["route"], "Auto Roto decision 綁定不完整");
  }
  if (decision.budget.actualSourceDurationSeconds > decision.budget.maxSourceDurationSeconds
    || decision.budget.actualAnalyzedFrames > decision.budget.maxAnalyzedFrames
    || decision.budget.actualMatteBytes > decision.budget.maxMatteBytes) issue(["budget"], "Auto Roto 實際用量超出綁定預算");
});
export type RotoKeyerDecision = z.infer<typeof rotoKeyerDecisionSchema>;

export const rotoKeyerPlanSchema = z.strictObject({
  schema: z.literal(ROTO_KEYER_PLAN_SCHEMA),
  decisions: z.array(rotoKeyerDecisionSchema).min(1).max(ROTO_KEYER_MAX_DECISIONS),
});
export type RotoKeyerPlan = z.infer<typeof rotoKeyerPlanSchema>;

export interface RotoKeyerMaterialEvidenceBinding {
  materialId: string;
  sourceSha256: string;
  semanticReceiptSha256: string;
  assetId: string;
  clipId: string;
}

/**
 * Proves that every Roto/Keyer decision is covered by the exact semantic
 * material receipt carried by the enclosing v4 plan. Runtime evidence checks
 * alone are not enough: without this binding, audit receipts could omit the
 * material that actually authorized a Roto/Keyer command.
 */
export function assertRotoKeyerMaterialEvidenceBinding(
  plan: { readonly decisions: readonly RotoKeyerDecision[] } | undefined,
  materialEvidence: readonly RotoKeyerMaterialEvidenceBinding[],
): void {
  if (!plan) return;
  for (const decision of plan.decisions) {
    const exact = materialEvidence.some((receipt) => receipt.materialId === decision.materialId
      && receipt.sourceSha256 === decision.sourceSha256
      && receipt.semanticReceiptSha256 === decision.semanticReceiptSha256
      && receipt.assetId === decision.assetId
      && receipt.clipId === decision.clipId);
    if (!exact) {
      throw new Error(`Roto／Keyer decision 缺少 exact v4 semantic material receipt：${decision.materialId}`);
    }
  }
}

function routeEngine(route: RotoKeyerRoute): RotoKeyerDecision["engine"] {
  if (route === "no_op") return "none";
  if (route === "manual_mask") return "editkin-editgraph-manual-mask/v1";
  if (route === "self_authored_auto_roto") return PRODUCT_AUTO_ROTO_ENGINE;
  return "editkin-chroma-distance-keyer/v1";
}

function sealRouteReceipt(input: Omit<z.infer<typeof routeReceiptSchema>, "receiptSha256">): z.infer<typeof routeReceiptSchema> {
  return routeReceiptSchema.parse({ ...input, receiptSha256: rotoKeyerSha256(input) });
}

export function sealRotoKeyerDecision(input: Omit<RotoKeyerDecision, "routeReceipt" | "decisionSha256">): RotoKeyerDecision {
  const routeReceipt = sealRouteReceipt({
    schema: ROTO_KEYER_ROUTE_RECEIPT_SCHEMA,
    contractRevision: ROTO_KEYER_CONTRACT_REVISION,
    mode: "product",
    route: input.route,
    engine: input.engine,
    status: input.route === "no_op" ? "no_op" : "selected",
    reasonCode: input.route === "no_op" ? "explicit-evidence-bound-no-op" : `selected-${input.route}`,
    evidenceReceiptSha256: input.evidenceReceiptSha256,
    capabilitySnapshotSha256: input.capabilitySnapshotSha256,
  });
  const base = { ...input, routeReceipt };
  return rotoKeyerDecisionSchema.parse({ ...base, decisionSha256: rotoKeyerSha256(base) });
}

function verifySealedDecision(decision: RotoKeyerDecision): void {
  const { decisionSha256, ...decisionBase } = decision;
  const { receiptSha256, ...routeBase } = decision.routeReceipt;
  if (rotoKeyerSha256(decisionBase) !== decisionSha256 || rotoKeyerSha256(routeBase) !== receiptSha256) {
    throw new Error("Roto／Keyer decision 或 route receipt 已遭竄改");
  }
  if (decision.routeReceipt.route !== decision.route || decision.routeReceipt.engine !== decision.engine
    || decision.routeReceipt.evidenceReceiptSha256 !== decision.evidenceReceiptSha256
    || decision.routeReceipt.capabilitySnapshotSha256 !== decision.capabilitySnapshotSha256) {
    throw new Error("Roto／Keyer decision 與 route receipt 不一致");
  }
}

function flattenCommands(commands: readonly EditorCommand[]): EditorCommand[] {
  return commands.flatMap((command) => command.type === "batch" ? flattenCommands(command.commands) : [command]);
}

const ALPHA_COMMAND_TYPES = new Set<EditorCommand["type"]>([
  "add_clip_mask", "update_clip_mask", "delete_clip_mask", "set_clip_mask_track",
  "set_clip_mask_keyframe", "freeze_clip_mask_range", "set_clip_chroma_key",
]);

function commandClipId(command: EditorCommand): string | undefined {
  return "clipId" in command && typeof command.clipId === "string" ? command.clipId : undefined;
}

function commandContainsMatte(command: EditorCommand): boolean {
  return (command.type === "add_clip_mask" && command.mask.matteSequence !== undefined)
    || (command.type === "update_clip_mask" && command.patch.matteSequence !== undefined);
}

function clipContainsEmbeddedAlpha(clip: {
  readonly masks?: readonly unknown[];
  readonly chromaKey?: unknown;
}): boolean {
  return clip.chromaKey !== undefined || (clip.masks?.length ?? 0) > 0;
}

function commandContainsEmbeddedAlpha(command: EditorCommand): boolean {
  if (command.type === "add_clip") return clipContainsEmbeddedAlpha(command.clip);
  if (command.type === "add_track") return command.track.clips.some(clipContainsEmbeddedAlpha);
  return false;
}

function assertCommandRoute(decision: RotoKeyerDecision, command: EditorCommand | undefined): void {
  if (decision.route === "no_op") {
    if (command) throw new Error(`no-op decision 不可套用 Alpha command：${decision.clipId}`);
    return;
  }
  if (!command || rotoKeyerSha256(command) !== decision.commandSha256 || commandClipId(command) !== decision.clipId) {
    throw new Error(`Roto／Keyer decision 沒有對應的 exact editable command：${decision.clipId}`);
  }
  if (decision.route === "manual_mask") {
    if (command.type === "set_clip_chroma_key" || !ALPHA_COMMAND_TYPES.has(command.type) || commandContainsMatte(command)) {
      throw new Error("manual_mask 只能綁定不含逐像素 Matte 的手動遮罩命令");
    }
    return;
  }
  if (decision.route === "self_authored_screen_keyer") {
    if (command.type !== "set_clip_chroma_key" || !command.settings?.enabled
      || command.settings.engine !== "editkin-chroma-distance-keyer/v1" || command.settings.screen !== decision.screen
      || rotoKeyerSha256(command.settings) !== decision.settingsSha256) {
      throw new Error("Screen Keyer decision 與 set_clip_chroma_key 命令不一致");
    }
    return;
  }
  const sequence = command.type === "add_clip_mask" ? command.mask.matteSequence
    : command.type === "update_clip_mask" ? command.patch.matteSequence : undefined;
  if (!sequence || sequence.engine !== PRODUCT_AUTO_ROTO_ENGINE || sequence.qualityState !== "diagnostic"
    || sequence.alphaRefinement?.engine !== "editkin-self-authored-optical-alpha-refiner/v1") {
    throw new Error("Auto Roto plan 只能綁定自研 native diagnostic matte 與自研 optical alpha refinement");
  }
}

export function assertRotoKeyerPlanCommandBinding(
  plan: RotoKeyerPlan | undefined,
  commands: readonly EditorCommand[],
  qualityState: string,
  contextTokens: number,
): void {
  const flattened = flattenCommands(commands);
  if (flattened.some(commandContainsEmbeddedAlpha)) {
    throw new Error("Autopilot add_clip／add_track 不可內嵌 Roto／Keyer／Mask 狀態；請先加入乾淨片段，再使用 evidence-bound Alpha command");
  }
  const alphaCommands = flattened.filter((command) => ALPHA_COMMAND_TYPES.has(command.type));
  if (!plan) {
    if (alphaCommands.length) throw new Error("Roto／Keyer／Mask command 必須綁定 hao.video-autopilot.roto-keyer-plan/v1 證據");
    return;
  }
  const parsed = rotoKeyerPlanSchema.parse(plan);
  if (qualityState !== "review_required") throw new Error("Roto／Keyer plan 必須維持 review_required，不可由 AI 自行認證");
  if (new Set(parsed.decisions.map((decision) => decision.clipId)).size !== parsed.decisions.length) throw new Error("同一片段不可有多個互相含糊的 Roto／Keyer decision");
  if (parsed.decisions.reduce((sum, decision) => sum + decision.budget.decisionContextTokens, 0) > contextTokens) {
    throw new Error("Roto／Keyer decision Token 用量超過 v4 plan context budget");
  }
  const commandMatches = new Map<string, EditorCommand[]>();
  for (const command of alphaCommands) {
    const hash = rotoKeyerSha256(command);
    commandMatches.set(hash, [...(commandMatches.get(hash) ?? []), command]);
  }
  for (const decision of parsed.decisions) {
    verifySealedDecision(decision);
    const matches = decision.commandSha256 ? commandMatches.get(decision.commandSha256) ?? [] : [];
    if (matches.length > 1) throw new Error(`Roto／Keyer exact command 重複：${decision.clipId}`);
    assertCommandRoute(decision, matches[0]);
    if (decision.commandSha256) commandMatches.delete(decision.commandSha256);
  }
  if ([...commandMatches.values()].some((matches) => matches.length)) throw new Error("plan 含未綁定證據的 Roto／Keyer／Mask command");
}

function assertEvidenceRoute(evidence: RotoKeyerEvidenceReceipt, route: RotoKeyerRoute, screen?: "green" | "blue"): void {
  const observation = evidence.observation;
  if (route === "self_authored_screen_keyer") {
    if (!screen || observation.screen !== screen || observation.confidence < .75 || observation.screenCoverage < .1) {
      throw new Error("只有高信心、明確且同色的 green／blue backing 證據才能使用 Screen Keyer");
    }
    return;
  }
  if (route === "self_authored_auto_roto") {
    if (observation.screen !== "none" || observation.subjectPresence === "none" || observation.subjectPresence === "ambiguous" || observation.confidence < .6) {
      throw new Error("Auto Roto 需要非色幕、可辨識主體與至少 0.6 證據信心；含糊素材必須 no-op／人工處理");
    }
  }
}

function assertProjectEvidence(project: EditProject, evidence: RotoKeyerEvidenceReceipt): void {
  const clip = findClip(project, evidence.clipId);
  const asset = findAsset(project, evidence.assetId);
  if (clip.assetId !== asset.id || asset.kind === "audio") throw new Error("Roto／Keyer evidence 不是目前可見素材片段");
  if (asset.derivatives?.sourceSha256 && asset.derivatives.sourceSha256 !== evidence.sourceSha256) {
    throw new Error("Roto／Keyer evidence 已因原始素材 SHA-256 漂移而失效");
  }
}

function zeroBudget(decisionContextTokens: number): RotoKeyerDecision["budget"] {
  return {
    decisionContextTokens,
    maxSourceDurationSeconds: 0, maxAnalyzedFrames: 0, maxMatteBytes: 0,
    actualSourceDurationSeconds: 0, actualAnalyzedFrames: 0, actualMatteBytes: 0,
  };
}

export interface BuildRotoKeyerDecisionInput {
  route: Exclude<RotoKeyerRoute, "self_authored_auto_roto">;
  decisionContextTokens: number;
  command?: EditorCommand;
  screen?: "green" | "blue";
  settings?: ChromaKeySettings;
}

export async function buildRotoKeyerDecision(
  project: EditProject,
  evidence: RotoKeyerEvidenceReceipt,
  capability: RotoKeyerCapabilitySnapshot,
  input: BuildRotoKeyerDecisionInput,
): Promise<{ decision: RotoKeyerDecision; command?: EditorCommand }> {
  assertProjectEvidence(project, evidence);
  assertEvidenceRoute(evidence, input.route, input.screen);
  const available = capability.routes.find((candidate) => candidate.route === input.route);
  if (!available?.available || !available.productEligible) throw new Error(`Roto／Keyer capability unavailable：${input.route}`);
  let command = input.command;
  let settings: ChromaKeySettings | undefined;
  if (input.route === "no_op") command = undefined;
  if (input.route === "self_authored_screen_keyer") {
    settings = { ...(input.settings ?? CHROMA_KEY_PRESETS[input.screen!]) };
    command = { type: "set_clip_chroma_key", clipId: evidence.clipId, settings };
  }
  const decision = sealRotoKeyerDecision({
    schema: ROTO_KEYER_DECISION_SCHEMA,
    projectId: project.id,
    projectRevision: project.revision,
    materialId: evidence.materialId,
    sourceSha256: evidence.sourceSha256,
    semanticReceiptSha256: evidence.semanticReceiptSha256,
    evidenceReceiptSha256: evidence.receiptSha256,
    capabilitySnapshotSha256: capability.snapshotSha256,
    assetId: evidence.assetId,
    clipId: evidence.clipId,
    route: input.route,
    engine: routeEngine(input.route),
    ...(input.screen ? { screen: input.screen } : {}),
    ...(settings ? { settingsSha256: rotoKeyerSha256(settings) } : {}),
    ...(command ? { commandSha256: rotoKeyerSha256(command) } : {}),
    budget: zeroBudget(input.decisionContextTokens),
    humanReview: { required: true, status: "pending", reviewTarget: "preview_formal_render_and_reopen" },
  });
  assertCommandRoute(decision, command);
  if (command) applyCommand(project, command);
  return { decision, command };
}

const autoRotoPreparationSchema = z.strictObject({
  schema: z.literal(AUTO_ROTO_PREPARATION_SCHEMA),
  projectId: boundedIdSchema,
  projectRevision: z.number().int().nonnegative(),
  materialId: sha256Schema,
  sourceSha256: sha256Schema,
  evidenceReceiptSha256: sha256Schema,
  capabilitySnapshotSha256: sha256Schema,
  assetId: boundedIdSchema,
  clipId: boundedIdSchema,
  autoRotoRouteReceipt: z.unknown(),
  autoRotoRouteReceiptSha256: sha256Schema,
  matteSequence: z.unknown(),
  command: z.unknown(),
  commandSha256: sha256Schema,
  artifactIdentity: z.strictObject({
    sequenceSha256: sha256Schema,
    sequenceBytes: z.number().int().positive(),
    manifestSha256: sha256Schema,
    previewSetSha256: sha256Schema,
    previewCount: z.number().int().positive(),
  }),
  compute: decisionBudgetSchema,
  createdAt: z.iso.datetime(),
  receiptSha256: sha256Schema,
});
type AutoRotoPreparationReceipt = z.infer<typeof autoRotoPreparationSchema>;

async function assertInsideCache(cacheRoot: string, path: string): Promise<string> {
  const [root, target] = await Promise.all([realpath(resolve(cacheRoot)), realpath(resolve(path))]);
  const relation = relative(root, target);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error("Auto Roto artifact 超出 Editkin cache boundary");
  return target;
}

async function verifyAutoRotoRouteReceipt(receipt: unknown): Promise<ProductAutoRotoRouteReceipt> {
  try {
    const parsed = parseProductAutoRotoRouteReceipt(receipt);
    const expected = createProductAutoRotoRouteReceipt();
    if (parsed.receiptSha256 !== expected.receiptSha256 || parsed.policyVersion !== PRODUCT_AUTO_ROTO_ROUTE_POLICY
      || parsed.selectedEngine !== PRODUCT_AUTO_ROTO_ENGINE) throw new Error("product route identity 漂移");
    return parsed;
  } catch (error) {
    throw new Error("Auto Roto route receipt 不是 closed-world self-authored product route", { cause: error });
  }
}

async function verifyPreparationArtifacts(cacheRoot: string, receipt: AutoRotoPreparationReceipt): Promise<void> {
  const sequence = receipt.matteSequence as RotoMatteSequence;
  if (!sequence || sequence.schema !== "editkin.auto-roto-matte/v1" || sequence.engine !== PRODUCT_AUTO_ROTO_ENGINE
    || sequence.qualityState !== "diagnostic" || sequence.frozen !== true
    || sequence.stale || sequence.alphaRefinement?.engine !== "editkin-self-authored-optical-alpha-refiner/v1"
    || !sequence.framePreviewUris || sequence.framePreviewUris.length !== sequence.frameCount) {
    throw new Error("Auto Roto preparation 不是完整自研 diagnostic frozen matte");
  }
  const [sequencePath, manifestPath, ...previewPaths] = await Promise.all([
    assertInsideCache(cacheRoot, sequence.sequenceUri),
    assertInsideCache(cacheRoot, sequence.manifestUri),
    ...sequence.framePreviewUris.map((path) => assertInsideCache(cacheRoot, path)),
  ]);
  const [sequenceHash, sequenceInfo, manifestHash, ...previewHashes] = await Promise.all([
    sha256File(sequencePath), stat(sequencePath), sha256File(manifestPath), ...previewPaths.map(sha256File),
  ]);
  if (sequenceHash !== receipt.artifactIdentity.sequenceSha256 || sequenceInfo.size !== receipt.artifactIdentity.sequenceBytes
    || manifestHash !== receipt.artifactIdentity.manifestSha256 || previewHashes.length !== receipt.artifactIdentity.previewCount
    || rotoKeyerSha256(previewHashes) !== receipt.artifactIdentity.previewSetSha256) {
    throw new Error("Auto Roto frozen artifact identity 已漂移");
  }
}

export async function verifyAutoRotoPreparation(cacheRoot: string, receiptSha256: string): Promise<AutoRotoPreparationReceipt> {
  const receipt = autoRotoPreparationSchema.parse(JSON.parse(await readFile(preparationPath(cacheRoot, receiptSha256), "utf8")));
  const { receiptSha256: sealed, ...base } = receipt;
  if (sealed !== receiptSha256 || rotoKeyerSha256(base) !== sealed) throw new Error("Auto Roto preparation receipt 已遭竄改");
  const route = await verifyAutoRotoRouteReceipt(receipt.autoRotoRouteReceipt);
  if (route.receiptSha256 !== receipt.autoRotoRouteReceiptSha256) throw new Error("Auto Roto route receipt SHA-256 不一致");
  if (rotoKeyerSha256(receipt.command) !== receipt.commandSha256) throw new Error("Auto Roto preparation command 已遭竄改");
  await verifyPreparationArtifacts(cacheRoot, receipt);
  return receipt;
}

export interface PrepareAutopilotAutoRotoInput {
  initialTime: number;
  initialRect: { x: number; y: number; width: number; height: number };
  maskId: string;
  decisionContextTokens: number;
  computeBudget: { maxSourceDurationSeconds: number; maxAnalyzedFrames: number; maxMatteBytes: number };
  refine?: { temporalStability?: number; feather?: number; edgeShift?: number; contrast?: number };
}

function rectPath(rect: PrepareAutopilotAutoRotoInput["initialRect"]) {
  return [
    { id: "p1", x: rect.x, y: rect.y }, { id: "p2", x: rect.x + rect.width, y: rect.y },
    { id: "p3", x: rect.x + rect.width, y: rect.y + rect.height }, { id: "p4", x: rect.x, y: rect.y + rect.height },
  ];
}

function autoRotoMask(maskId: string, rect: PrepareAutopilotAutoRotoInput["initialRect"], sequence: RotoMatteSequence, refine: PrepareAutopilotAutoRotoInput["refine"]): ClipMask {
  return {
    id: maskId, name: "Video Autopilot Auto Roto", kind: "subject", mode: "add", enabled: true, inverted: false,
    opacity: 1, feather: refine?.feather ?? .01, expansion: refine?.edgeShift ?? 0, path: rectPath(rect), keyframes: [],
    refine: { edgeShift: 0, contrast: Math.min(1, Math.max(0, (refine?.contrast ?? 1.7) / 2.4)), chatterReduction: Math.min(1, Math.max(0, (refine?.temporalStability ?? .22) / .65)) },
    matteSequence: sequence,
  };
}

export async function prepareAutopilotAutoRoto(
  project: EditProject,
  sourcePath: string,
  evidence: RotoKeyerEvidenceReceipt,
  capability: RotoKeyerCapabilitySnapshot,
  input: PrepareAutopilotAutoRotoInput,
  runtime: RotoKeyerRuntimePaths = defaultRotoKeyerRuntimePaths(),
): Promise<{ decision: RotoKeyerDecision; command: EditorCommand; preparationReceiptSha256: string }> {
  assertProjectEvidence(project, evidence);
  assertEvidenceRoute(evidence, "self_authored_auto_roto");
  await verifyRotoKeyerSourceFile(sourcePath, evidence.sourceSha256);
  const routeCapability = capability.routes.find((candidate) => candidate.route === "self_authored_auto_roto");
  if (!routeCapability?.available || !routeCapability.productEligible) throw new Error("self-authored Auto Roto capability unavailable");
  const clip = findClip(project, evidence.clipId);
  const asset = findAsset(project, evidence.assetId);
  if (asset.kind !== "video") throw new Error("Auto Roto product route 目前只接受影片片段");
  const projectedFrames = Math.max(1, Math.ceil(clip.duration * Math.min(12, project.fps)));
  if (clip.duration > input.computeBudget.maxSourceDurationSeconds || projectedFrames > input.computeBudget.maxAnalyzedFrames) {
    throw new Error("Auto Roto request 超出事先綁定的 duration／frame compute budget");
  }
  if (!Object.values(input.initialRect).every(Number.isFinite) || input.initialRect.x < 0 || input.initialRect.y < 0
    || input.initialRect.width < .02 || input.initialRect.height < .02
    || input.initialRect.x + input.initialRect.width > 1 || input.initialRect.y + input.initialRect.height > 1) {
    throw new Error("Auto Roto initialRect 不合法");
  }
  const result = await analyzeProductAutoRoto({
    sourcePath, sourceStart: clip.sourceStart, duration: clip.duration, fps: project.fps,
    sourceWidth: asset.width ?? project.width, sourceHeight: asset.height ?? project.height,
    initialTime: input.initialTime, initialRect: input.initialRect, sourceSha256: evidence.sourceSha256,
    ...input.refine,
  }, {
    ffmpegPath: runtime.ffmpegPath,
    nativeCorePath: runtime.nativeCorePath,
    cacheRoot: runtime.cacheRoot,
  });
  if (result.engine !== PRODUCT_AUTO_ROTO_ENGINE || result.qualityState !== "diagnostic"
    || result.alphaRefinement?.engine !== "editkin-self-authored-optical-alpha-refiner/v1"
    || result.regionMemoryRouting?.requested !== "fixed_baseline"
    || result.regionMemoryRouting.executed !== "fixed_baseline"
    || result.regionMemoryRouting.candidateAttempted !== false
    || result.regionMemoryRouting.deterministicFallback !== false) {
    throw new Error("Auto Roto 執行結果離開 self-authored product route");
  }
  const sequencePath = await assertInsideCache(runtime.cacheRoot, result.sequencePath);
  const manifestPath = await assertInsideCache(runtime.cacheRoot, result.manifestPath);
  const previewPaths = await Promise.all(result.frames.map((frame) => assertInsideCache(runtime.cacheRoot, frame.alphaPath)));
  const [sequenceSha256, sequenceInfo, manifestSha256, ...previewHashes] = await Promise.all([
    sha256File(sequencePath), stat(sequencePath), sha256File(manifestPath), ...previewPaths.map(sha256File),
  ]);
  if (sequenceInfo.size > input.computeBudget.maxMatteBytes || result.frames.length > input.computeBudget.maxAnalyzedFrames) {
    throw new Error("Auto Roto 實際 matte 超出事先綁定的 frame／byte compute budget");
  }
  const matteSequence: RotoMatteSequence = {
    schema: result.schema, engine: result.engine, width: result.width, height: result.height,
    analysisFps: result.analysisFps, frameCount: result.frames.length, sequenceUri: sequencePath,
    sequenceSha256, sequenceBytes: sequenceInfo.size, manifestUri: manifestPath,
    framePreviewUris: previewPaths, frameArtifactUris: previewPaths, meanBoundaryChatter: result.meanBoundaryChatter,
    correctionStrokesApplied: result.correctionStrokesApplied, correctedFrames: result.correctedFrames,
    regionMemoryRouting: {
      schema: "editkin.region-memory-routing/v1", requested: "fixed_baseline", executed: "fixed_baseline",
      candidateAttempted: false, deterministicFallback: false,
    }, alphaRefinement: result.alphaRefinement,
    routeReceipt: result.routeReceipt, frozen: true, qualityState: "diagnostic",
  };
  const existing = clip.masks?.find((mask) => mask.id === input.maskId);
  if (existing && existing.kind !== "subject") throw new Error("Auto Roto 只能更新 subject mask");
  const frozenRange = { fromFrame: 0, toFrame: Math.ceil(clip.duration * project.fps) };
  const command: EditorCommand = existing
    ? { type: "update_clip_mask", clipId: clip.id, maskId: existing.id, patch: { matteSequence, frozenRange, enabled: true } }
    : { type: "add_clip_mask", clipId: clip.id, mask: { ...autoRotoMask(input.maskId, input.initialRect, matteSequence, input.refine), frozenRange } };
  applyCommand(project, command);
  const compute: RotoKeyerDecision["budget"] = {
    decisionContextTokens: input.decisionContextTokens,
    ...input.computeBudget,
    actualSourceDurationSeconds: clip.duration,
    actualAnalyzedFrames: result.frames.length,
    actualMatteBytes: sequenceInfo.size,
  };
  const preparationBase = {
    schema: AUTO_ROTO_PREPARATION_SCHEMA,
    projectId: project.id, projectRevision: project.revision,
    materialId: evidence.materialId, sourceSha256: evidence.sourceSha256,
    evidenceReceiptSha256: evidence.receiptSha256, capabilitySnapshotSha256: capability.snapshotSha256,
    assetId: evidence.assetId, clipId: evidence.clipId,
    autoRotoRouteReceipt: result.routeReceipt,
    autoRotoRouteReceiptSha256: result.routeReceipt.receiptSha256,
    matteSequence, command, commandSha256: rotoKeyerSha256(command),
    artifactIdentity: {
      sequenceSha256, sequenceBytes: sequenceInfo.size, manifestSha256,
      previewSetSha256: rotoKeyerSha256(previewHashes), previewCount: previewHashes.length,
    },
    compute,
    createdAt: new Date().toISOString(),
  };
  const preparation = autoRotoPreparationSchema.parse({ ...preparationBase, receiptSha256: rotoKeyerSha256(preparationBase) });
  await writeJsonImmutable(preparationPath(runtime.cacheRoot, preparation.receiptSha256), preparation);
  const decision = sealRotoKeyerDecision({
    schema: ROTO_KEYER_DECISION_SCHEMA,
    projectId: project.id, projectRevision: project.revision,
    materialId: evidence.materialId, sourceSha256: evidence.sourceSha256,
    semanticReceiptSha256: evidence.semanticReceiptSha256,
    evidenceReceiptSha256: evidence.receiptSha256, capabilitySnapshotSha256: capability.snapshotSha256,
    assetId: evidence.assetId, clipId: evidence.clipId,
    route: "self_authored_auto_roto", engine: PRODUCT_AUTO_ROTO_ENGINE,
    commandSha256: preparation.commandSha256,
    preparationReceiptSha256: preparation.receiptSha256,
    autoRotoRouteReceiptSha256: result.routeReceipt.receiptSha256,
    budget: compute,
    humanReview: { required: true, status: "pending", reviewTarget: "preview_formal_render_and_reopen" },
  });
  return { decision, command, preparationReceiptSha256: preparation.receiptSha256 };
}

export async function inspectRotoKeyerMaterialEvidence(
  project: EditProject,
  cacheRoot: string,
  materialId: string,
  semanticReceiptSha256: string,
): Promise<{ packet: MaterialIntelligencePacket; clipState: unknown }> {
  const [packet, semantics] = await Promise.all([
    readMaterialIntelligence(cacheRoot, materialId),
    verifyMaterialSemanticsReceipt(cacheRoot, materialId, semanticReceiptSha256),
  ]);
  if (packet.source.sourceSha256 !== semantics.sourceSha256) throw new Error("素材與 semantic evidence identity 不一致");
  const clip = findClip(project, packet.source.clipId);
  const asset = findAsset(project, packet.source.assetId);
  if (clip.assetId !== asset.id || (asset.derivatives?.sourceSha256 && asset.derivatives.sourceSha256 !== packet.source.sourceSha256)) {
    throw new Error("素材 evidence 已因專案或 source identity 漂移而失效");
  }
  return {
    packet,
    clipState: {
      clipId: clip.id, assetId: asset.id, kind: asset.kind, duration: clip.duration,
      currentChromaKey: clip.chromaKey ? { enabled: clip.chromaKey.enabled, engine: clip.chromaKey.engine, screen: clip.chromaKey.screen } : undefined,
      masks: (clip.masks ?? []).map((mask) => ({ id: mask.id, kind: mask.kind, enabled: mask.enabled, hasFrozenMatte: Boolean(mask.matteSequence?.frozen), matteEngine: mask.matteSequence?.engine, stale: mask.matteSequence?.stale === true })),
    },
  };
}

export async function verifyRotoKeyerPlanForProject(
  plan: RotoKeyerPlan | undefined,
  commands: readonly EditorCommand[],
  qualityState: string,
  contextTokens: number,
  project: EditProject,
  cacheRoot: string,
  runtime: RotoKeyerRuntimePaths = defaultRotoKeyerRuntimePaths(),
  resolveSourcePath?: (assetId: string) => Promise<string>,
): Promise<{ decisionCount: number; routes: RotoKeyerRoute[]; evidenceReceiptSha256s: string[] }> {
  assertRotoKeyerPlanCommandBinding(plan, commands, qualityState, contextTokens);
  if (!plan) return { decisionCount: 0, routes: [], evidenceReceiptSha256s: [] };
  const capability = await inspectRotoKeyerCapabilities(runtime);
  const flattened = flattenCommands(commands);
  for (const decision of plan.decisions) {
    verifySealedDecision(decision);
    if (decision.projectId !== project.id || decision.projectRevision !== project.revision) throw new Error("Roto／Keyer decision 的專案 revision 已過期");
    const evidence = await verifyRotoKeyerEvidence(cacheRoot, decision.materialId, decision.evidenceReceiptSha256);
    assertProjectEvidence(project, evidence);
    if (resolveSourcePath) await verifyRotoKeyerSourceFile(await resolveSourcePath(evidence.assetId), evidence.sourceSha256);
    if (decision.sourceSha256 !== evidence.sourceSha256 || decision.semanticReceiptSha256 !== evidence.semanticReceiptSha256
      || decision.assetId !== evidence.assetId || decision.clipId !== evidence.clipId) throw new Error("Roto／Keyer decision 與 evidence receipt identity 不一致");
    const targetClip = findClip(project, decision.clipId);
    const hasEnabledPixelMatte = (targetClip.masks ?? []).some((mask) => mask.enabled && mask.matteSequence && !mask.matteSequence.stale);
    if (decision.route === "self_authored_auto_roto" && targetClip.chromaKey?.enabled) {
      throw new Error("Auto Roto route 不可與既有 Screen Keyer 靜默疊加；請先明確移除 Keyer 並重新 audit");
    }
    if (decision.route === "self_authored_screen_keyer" && hasEnabledPixelMatte) {
      throw new Error("Screen Keyer route 不可與既有 Auto Roto Matte 靜默疊加；請先明確停用 Matte 並重新 audit");
    }
    if (decision.capabilitySnapshotSha256 !== capability.snapshotSha256) throw new Error("Roto／Keyer capability snapshot 已漂移，請重新 inspect／build decision");
    const selectedCapability = capability.routes.find((candidate) => candidate.route === decision.route);
    if (!selectedCapability?.available || !selectedCapability.productEligible || selectedCapability.engine !== decision.engine) {
      throw new Error(`Roto／Keyer capability unavailable：${decision.route}`);
    }
    assertEvidenceRoute(evidence, decision.route, decision.screen);
    const command = decision.commandSha256 ? flattened.find((candidate) => rotoKeyerSha256(candidate) === decision.commandSha256) : undefined;
    assertCommandRoute(decision, command);
    if (decision.route === "self_authored_auto_roto") {
      const preparation = await verifyAutoRotoPreparation(cacheRoot, decision.preparationReceiptSha256!);
      if (preparation.projectId !== project.id || preparation.projectRevision !== project.revision
        || preparation.materialId !== decision.materialId || preparation.sourceSha256 !== decision.sourceSha256
        || preparation.evidenceReceiptSha256 !== decision.evidenceReceiptSha256
        || preparation.capabilitySnapshotSha256 !== decision.capabilitySnapshotSha256
        || preparation.commandSha256 !== decision.commandSha256
        || preparation.autoRotoRouteReceiptSha256 !== decision.autoRotoRouteReceiptSha256
        || canonicalJson(preparation.compute) !== canonicalJson(decision.budget)) {
        throw new Error("Auto Roto preparation 與 v4 decision binding 不一致");
      }
    }
  }
  return {
    decisionCount: plan.decisions.length,
    routes: plan.decisions.map((decision) => decision.route),
    evidenceReceiptSha256s: plan.decisions.map((decision) => decision.evidenceReceiptSha256),
  };
}
