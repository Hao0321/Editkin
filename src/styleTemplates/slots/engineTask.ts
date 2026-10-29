import * as z from "zod/v4";
import { styleSlotValuesV1Schema } from "../../domain/styleJobFieldsV1";
import type { MediaAsset } from "../../domain/types";
import { renderStyleTemplateClipV1, type StyleTemplateRenderProgressV1 } from "./renderTemplateClip";

/**
 * The desktop engine task the 「模板片段」 inspector needs (Node only), ready for the engine task registry to dispatch:
 * kind `style_template_render_v1`, the same pattern as `motion_library_render_v1`. The registry passes its host input
 * (the project media cache root and a path resolver that admits only the project's media) and forwards progress.
 *
 * Hook required outside this agent's files: src/application/engineTaskContractV1.ts (request/reply/progress schemas),
 * src/service/engineTaskRegistryV1.ts (dispatch to runStyleTemplateRenderTaskV1), src/desktop/engineTaskHostV1.ts +
 * tauriBridge.ts + apiTypes.ts (`renderStyleTemplateV1`, see slots/renderHost.ts), and src-tauri/src/engine_tasks_v1.rs
 * (admit the kind, its progress stages images/cache/generate/encode/verify/done and the output folder styletpl-clip/<id>).
 */

export const STYLE_TEMPLATE_RENDER_TASK_KIND_V1 = "style_template_render_v1" as const;
export const STYLE_TEMPLATE_RENDER_REPLY_SCHEMA_V1 = "editkin.style-template-render-reply/v1" as const;

const assetRecord = z.object({
  id: z.string().min(1).max(160), name: z.string().max(400), kind: z.enum(["video", "audio", "image"]), uri: z.string().min(1).max(32_768), duration: z.number().finite().nonnegative(),
  width: z.number().optional(), height: z.number().optional(), license: z.string().optional(), provenance: z.string().optional(), redistributable: z.boolean().optional(),
  rightsBasis: z.string().optional(), distributionScope: z.string().optional(),
});

export const styleTemplateRenderInputSchemaV1 = z.strictObject({
  operationId: z.string().regex(/^[a-z0-9-]{8,80}$/),
  templateId: z.string().regex(/^[SH][0-9]+_[a-z0-9_]+$/),
  slots: styleSlotValuesV1Schema,
  width: z.number().int().min(16).max(7680), height: z.number().int().min(16).max(7680), fps: z.number().finite().min(1).max(240),
  durationSeconds: z.number().finite().min(0.5).max(120),
  /** The project assets the picture slots name. */
  assets: z.array(assetRecord).max(6),
});
export type StyleTemplateRenderInputV1 = z.infer<typeof styleTemplateRenderInputSchemaV1>;

export async function runStyleTemplateRenderTaskV1(raw: unknown, host: {
  readonly cacheRoot: string;
  /** Resolves a picture asset's uri to a local file the host admits (project media only). */
  readonly resolveAssetPath: (uri: string) => string | Promise<string>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: StyleTemplateRenderProgressV1) => void;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
}) {
  const input = styleTemplateRenderInputSchemaV1.parse(raw);
  const rendered = await renderStyleTemplateClipV1({ templateId: input.templateId, slots: input.slots,
    project: { width: input.width, height: input.height, fps: input.fps, assets: input.assets as MediaAsset[] }, durationSeconds: input.durationSeconds,
    cacheRoot: host.cacheRoot, resolveAssetPath: host.resolveAssetPath, signal: host.signal, onProgress: host.onProgress,
    ...(host.ffmpegPath && host.ffprobePath ? { ffmpegPath: host.ffmpegPath, ffprobePath: host.ffprobePath } : {}) });
  return { schema: STYLE_TEMPLATE_RENDER_REPLY_SCHEMA_V1, operationId: input.operationId, field: rendered.field, asset: rendered.asset, path: rendered.path,
    cacheHit: rendered.cacheHit, frameCount: rendered.frameCount, durationSeconds: rendered.durationSeconds };
}
