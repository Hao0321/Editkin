import type { EditProject, MediaAsset } from "../domain/types";
import type { HaoDesktopApi } from "./types";
import type { PickedMedia, PrepareMediaResult } from "./mediaTypes";
import { canonicalJson } from "../shared/canonicalJson";
import { referenceMotionReuseSourceIdentity } from "../application/referenceMotionTemplateReuse";
import { referenceMotionSourceSlots, type ReferenceMotionSourceReplacementRequest } from "../application/referenceMotionSourceReplacement";
import { prepareReferenceMotionTemplateSourceReplacement } from "../application/referenceMotionSourceTransaction";
import type { ReferenceMotionTemplateInstanceIdFactory } from "../application/referenceMotionTemplateInstances";
import type { ReferenceMotionTemplatePreparationDependencies } from "../application/referenceMotionTemplates";

type SourceApi = Pick<HaoDesktopApi, "importMediaPaths" | "prepareMedia">;
const changedFile = "這個影片檔和匯入時不同，請重新匯入後再換。";
function diskReadError(error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(/ENOENT|not.*readable.*file|not.*exist|找不到|is_file/i.test(reason)
    ? "找不到這個影片檔，可能已移動或刪除。模板沒有變更。"
    : "無法讀取這個影片檔（權限或格式問題）。模板沒有變更。", { cause: error });
}
/** Disk checks precede glyph compilation. Cache preparation never adds an asset or a timeline clip by itself. */
export async function verifyReferenceMotionSourceFilesForUi(project: EditProject, request: ReferenceMotionSourceReplacementRequest,
  picked: PickedMedia | undefined, api: SourceApi | undefined, signal?: AbortSignal) {
  const signature = canonicalJson([project, request, picked]);
  const check = () => {
    if (signal?.aborted) throw new Error("Template source preparation cancelled");
    if (canonicalJson([project, request, picked]) !== signature) throw new Error("模板已有新版本，請重新開啟後再換。");
  };
  check();
  const instance = project.referenceMotionInstances?.find(instance => instance.id === request.instanceId);
  if (!instance) throw new Error("找不到已保存模板。");
  const before = referenceMotionSourceSlots(project, instance), primary = request.primary ?? before[0];
  const windows = [primary, ...instance.input.sources.map((source, index) => request.sources?.[index] ?? source)];
  const assets = [...project.assets, ...(picked ? [picked.asset] : [])];
  const changed = windows.filter((window, index) => window.assetId !== before[index]?.assetId).map(window => assets.find(asset => asset.id === window.assetId));
  const preparedMedia: PrepareMediaResult[] = [], pickedMedia: PickedMedia[] = [];
  let incoming: MediaAsset | undefined = picked ? structuredClone(picked.asset) : undefined;
  for (const asset of changed) {
    if (!asset || asset.kind !== "video") throw new Error("只能選擇一般影片檔。");
    if (!api) throw new Error("從電腦檢查影片需要桌面版。");
    const measured = await api.importMediaPaths([asset.uri]).catch(error => { throw diskReadError(error); }); check();
    const probe = measured[0]?.asset;
    if (measured.length !== 1 || !probe || referenceMotionReuseSourceIdentity(probe.uri) !== referenceMotionReuseSourceIdentity(asset.uri)
      || probe.kind !== "video" || probe.width !== asset.width || probe.height !== asset.height || Math.abs(probe.duration - asset.duration) > 1 / project.fps
      || asset.displayAspectRatio !== undefined && (probe.displayAspectRatio === undefined || Math.abs(probe.displayAspectRatio - asset.displayAspectRatio) > 1e-6)
      || ["primaries", "transfer", "matrix"].some(key => {
        const saved = asset.color?.[key as "primaries"], live = probe.color?.[key as "primaries"];
        return saved !== undefined && saved !== live;
      })) throw new Error(changedFile);
    // Existing assets need a fresh full-byte check when their import pinned a SHA. Unpinned assets receive the cheap probe above.
    if (asset.id === picked?.asset.id || asset.derivatives?.sourceSha256) {
      const ready = await api.prepareMedia(asset).catch(error => { throw diskReadError(error); }); check();
      if (ready.assetId !== asset.id || !ready.runtimeUrls[asset.id]?.trim() || !/^[a-f\d]{64}$/i.test(ready.derivatives.sourceSha256 ?? "")
        || asset.derivatives?.sourceSha256 && asset.derivatives.sourceSha256.toLowerCase() !== ready.derivatives.sourceSha256.toLowerCase()) throw new Error(changedFile);
      if (asset.id === picked?.asset.id) {
        incoming = { ...incoming!, derivatives: structuredClone(ready.derivatives) };
        preparedMedia.push(ready); pickedMedia.push({ asset: incoming, previewUrl: ready.runtimeUrls[asset.id] });
      }
    }
  }
  check();
  return { incoming, preparedMedia, pickedMedia };
}
export async function prepareReferenceMotionSourceReplacementForUi(project: EditProject, request: ReferenceMotionSourceReplacementRequest,
  picked: PickedMedia | undefined, api: SourceApi | undefined, idFactory: ReferenceMotionTemplateInstanceIdFactory,
  dependencies: ReferenceMotionTemplatePreparationDependencies) {
  const signature = canonicalJson([project, request, picked]);
  const checked = await verifyReferenceMotionSourceFilesForUi(project, request, picked, api, dependencies.signal);
  if (canonicalJson([project, request, picked]) !== signature) throw new Error("模板已有新版本，請重新開啟後再換。");
  const prepared = await prepareReferenceMotionTemplateSourceReplacement(project, request, idFactory, { ...dependencies, pendingImport: checked.incoming });
  if (dependencies.signal?.aborted || canonicalJson([project, request, picked]) !== signature) throw new Error("Template source preparation cancelled or changed");
  // Retain the original live preparation identity so its opaque command context cannot be lost through a spread.
  return Object.assign(prepared, { preparedMedia: checked.preparedMedia, pickedMedia: checked.pickedMedia });
}
