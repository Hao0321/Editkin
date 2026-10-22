import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import * as z from "zod/v4";
import { readBoundedFile } from "../shared/boundedFile";
import { sha256Canonical } from "./autopilotInvocationIdentity";
import { mediaBootstrapRightsSchema } from "./mediaBootstrap";
import { TemplateShortBlockError, parseCreatorFactRef, templateShortGlyphSupported } from "./templateShortBrief";

/** Workspace inputs the creator owns for template Shorts (design §3.3, Hao 2026-10-09): the one-time defaults file
 * (rights per owned scope, never-usable sources, brand mark) and the creator files that back on-screen numbers (M10).
 * Editkin reads them; it never writes or fills them in for the creator. */
export const TEMPLATE_SHORT_DEFAULTS_SCHEMA = "editkin.template-short-defaults/v1" as const;
export const TEMPLATE_SHORT_DEFAULTS_PATH = ".autopilot/template-short-defaults.json";
export const TEMPLATE_SHORT_DEFAULTS_MAX_BYTES = 16 * 1024;
export const TEMPLATE_SHORT_FACT_MAX_BYTES = 64 * 1024;

function scopeSegments(scope: string): string[] | undefined {
  const segments = scope.replace(/[\\/]+$/, "").split(/[\\/]/);
  if (isAbsolute(scope) || /^[a-z]:/i.test(scope) || /^[\\/]/.test(scope)
    || segments.some(segment => !segment || segment === "." || segment === ".." || segment.trim() !== segment)) return undefined;
  return segments;
}
const scopeSchema = z.string().trim().min(1).max(512).refine(scope => scopeSegments(scope) !== undefined, "rights.scope 必須是工作資料夾內的相對路徑（例如 videos）");
export const templateShortDefaultsSchema = z.strictObject({
  schema: z.literal(TEMPLATE_SHORT_DEFAULTS_SCHEMA),
  /** Footage under a scope is the creator's own with this declaration (the four prepare_media_bootstrap rights fields).
   * Anything outside every scope needs its own explicit entry here. */
  rights: z.array(z.strictObject({ scope: scopeSchema, declaration: mediaBootstrapRightsSchema.required() })).min(1).max(16),
  /** File-name stems that are never usable, in any folder (IMG_6172 also excludes IMG_6172.MOV and IMG_6172-proxy.mp4). */
  excludedSources: z.array(z.string().trim().min(1).max(128).regex(/^[^\\/]+$/)).max(64).default([]),
  brandMark: z.string().trim().min(1).max(32).refine(value => Array.from(value).length <= 16, "brandMark 最多 16 字")
    .refine(value => Array.from(value).every(templateShortGlyphSupported), "brandMark 有字型不支援的字").optional(),
  /** The creator confirmed 「這是我自己拍的素材」 for the owned scopes; Editkin never writes this file on its own. */
  confirmedBy: z.literal("creator"),
  confirmedAt: z.iso.datetime({ offset: true }),
}).superRefine((value, context) => {
  // Refinements also run after field issues; only well-formed scopes are compared here.
  const keys = (Array.isArray(value.rights) ? value.rights : []).map(row => scopeSegments(String(row?.scope))?.join("/").toLowerCase()).filter(Boolean);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: ["rights"], message: "rights.scope 不可重複" });
});
export type TemplateShortDefaults = z.output<typeof templateShortDefaultsSchema>;
export type TemplateShortRightsDeclaration = TemplateShortDefaults["rights"][number]["declaration"];

const missingDefaults = () => new TemplateShortBlockError("BLOCK_START", `找不到 ${TEMPLATE_SHORT_DEFAULTS_PATH}。請由創作者建立一次：`
  + `schema「${TEMPLATE_SHORT_DEFAULTS_SCHEMA}」、rights（自有素材的 scope 與 declaration：provenance、rightsBasis、distributionScope、license）、`
  + "excludedSources（永不使用的檔名）、brandMark（選填，最多 16 字）、confirmedBy「creator」、confirmedAt", "defaults");

/** Bounded read of the defaults file: `.autopilot` must be a real directory of the workspace and the file a regular file. */
export async function readTemplateShortDefaults(root: string): Promise<{ defaults: TemplateShortDefaults; sha256: string }> {
  const canonicalRoot = await realpath(root), directory = resolve(canonicalRoot, ".autopilot");
  let content: Buffer;
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || relative(canonicalRoot, await realpath(directory)).toLowerCase() !== ".autopilot") {
      throw new TemplateShortBlockError("BLOCK_START", ".autopilot 必須是工作資料夾內的真實資料夾（不可是連結）", "defaults");
    }
    content = await readBoundedFile(resolve(directory, "template-short-defaults.json"), TEMPLATE_SHORT_DEFAULTS_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw missingDefaults();
    if (error instanceof TemplateShortBlockError) throw error;
    throw new TemplateShortBlockError("BLOCK_START", `${TEMPLATE_SHORT_DEFAULTS_PATH} 無法讀取：${error instanceof Error ? error.message : String(error)}`, "defaults");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content)); }
  catch { throw new TemplateShortBlockError("BLOCK_START", `${TEMPLATE_SHORT_DEFAULTS_PATH} 不是有效的 UTF-8 JSON`, "defaults"); }
  const result = templateShortDefaultsSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new TemplateShortBlockError("BLOCK_START", `${TEMPLATE_SHORT_DEFAULTS_PATH} 的 ${issue.path.map(String).join(".") || "內容"} 不正確：${issue.message}`, "defaults");
  }
  return { defaults: result.data, sha256: sha256Canonical(result.data) };
}

/** Rights for one source, given its canonical (realpath) path relative to the workspace, so a link cannot borrow a
 * scope: an excluded stem is refused even inside an owned scope; otherwise the most specific scope wins, and a source
 * outside every scope is refused until the creator declares it. */
export function resolveTemplateShortSourceRights(defaults: TemplateShortDefaults, workspaceRelativePath: string,
  options: { caseInsensitive?: boolean } = {}): { scope: string; declaration: TemplateShortRightsDeclaration } {
  const caseInsensitive = options.caseInsensitive ?? process.platform === "win32";
  const fold = (value: string) => caseInsensitive ? value.toLowerCase() : value;
  const segments = workspaceRelativePath.split(/[\\/]/).filter(segment => segment && segment !== ".");
  if (!segments.length || isAbsolute(workspaceRelativePath) || /^[a-z]:/i.test(workspaceRelativePath) || segments.includes("..")) {
    throw new TemplateShortBlockError("BLOCK_START", "請先把素材放進工作資料夾", "source.path");
  }
  const name = segments.at(-1)!;
  const excluded = defaults.excludedSources.find(stem => new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9A-Za-z])`, "i").test(name));
  if (excluded) throw new TemplateShortBlockError("BLOCK_START", `${name} 已被創作者排除（excludedSources：${excluded}），永遠不使用`, "source.path");
  const matches = defaults.rights.map(row => ({ row, scope: scopeSegments(row.scope)! }))
    .filter(({ scope }) => scope.length <= segments.length && scope.every((segment, index) => fold(segment) === fold(segments[index])))
    .sort((left, right) => right.scope.length - left.scope.length);
  if (!matches.length) {
    throw new TemplateShortBlockError("BLOCK_START", `${segments.join("/")} 不在已宣告為自有素材的範圍（${defaults.rights.map(row => row.scope).join("、")}）；`
      + `要使用請先在 ${TEMPLATE_SHORT_DEFAULTS_PATH} 的 rights 明確宣告它的權利`, "source.path");
  }
  return { scope: matches[0].row.scope, declaration: structuredClone(matches[0].row.declaration) };
}

/** Contents of the brief's `facts[].ref` creator files: inside the workspace (no link escape), regular, ≤64 KB, UTF-8. */
export async function readTemplateShortFactSources(root: string, facts: ReadonlyArray<{ ref: string }>): Promise<Array<{ ref: string; content: string }>> {
  const canonicalRoot = await realpath(root);
  return Promise.all(facts.map(async ({ ref }, index) => {
    const field = `facts[${index}].ref`, parsed = parseCreatorFactRef(ref);
    if (!parsed) throw new TemplateShortBlockError("BLOCK_BRIEF", `${field} 必須是 creator:<工作資料夾內相對路徑>#<段落>`, field);
    const target = resolve(canonicalRoot, parsed.path);
    try {
      const relation = relative(canonicalRoot, await realpath(target));
      if (!relation || relation.startsWith("..") || isAbsolute(relation)) throw new Error("outside");
      return { ref, content: new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedFile(target, TEMPLATE_SHORT_FACT_MAX_BYTES)) };
    } catch {
      throw new TemplateShortBlockError("BLOCK_BRIEF", `${field}：${parsed.path} 不是工作資料夾內 64 KB 以下的 UTF-8 文字檔`, field);
    }
  }));
}
