import type { GpuEngineVideoPreviewGraph } from "../render/gpuCompositor";
import type { GpuPreviewApi } from "./gpuPreviewApiTypes";
import type { ResidentGpuPreviewGeneration } from "./residentGpuPreviewGeneration";
import { prepareOffscreenCompositionPreview, validateOffscreenCompositionLoad, validateOffscreenCompositionFrame,
  type PreparedOffscreenCompositionPreview } from "./offscreenCompositionPreviewReceipt";
import type { ImmutableDecodedPngFrameHolder, DecodedImmutablePngFrame } from "./immutableDecodedPngFrame";

type Owner = Pick<ResidentGpuPreviewGeneration<unknown>, "active" | "assertActive" | "engineVideoSessionRef" |
  "engineVideoTargetModeRef" | "loadedEngineVideoStructureRef">;
const owners = new WeakMap<Owner, PreparedOffscreenCompositionPreview>();
export async function renderResidentEngineVideoPng(input: {
  owner: Owner; desktop: GpuPreviewApi; preview: GpuEngineVideoPreviewGraph;
  holder: ImmutableDecodedPngFrameHolder; isCurrent: () => boolean;
}): Promise<{ decoded: DecodedImmutablePngFrame; frame: number;
  value: { motionGraphicIds: readonly string[]; captionIds: readonly string[] } } | undefined> {
  const {owner,desktop,preview,holder,isCurrent}=input;
  if (!isCurrent()) return undefined;
  let expected=owners.get(owner);
  if (owner.engineVideoTargetModeRef.current!=="offscreen" || owner.loadedEngineVideoStructureRef.current!==preview.structureKey || !expected) {
    const status=await desktop.gpuEngineStatus!();
    owner.assertActive(); if (!isCurrent()) return undefined;
    const ready=status.ready as unknown as Record<string, unknown>;
    const metadata=ready?.nativeRuntimeMetadata as Record<string, unknown> | undefined;
    if (!status.available || !metadata) throw new Error("Offscreen preview requires current executable metadata");
    expected=await prepareOffscreenCompositionPreview({preview,sessionId:owner.engineVideoSessionRef.current,ready,
      runtime:{generation:Number(ready.generation),executableSha256:String(metadata.executableSha256),
        executableBytes:Number(metadata.executableBytes),nativeRuntimeMetadata:metadata}});
    owner.assertActive(); if (!isCurrent()) return undefined;
    // Track partial native loading before admission, so failure can retire the
    // exact session/target rather than leaving an untracked native resource.
    owner.engineVideoTargetModeRef.current="offscreen";
    owner.loadedEngineVideoStructureRef.current=preview.structureKey;
    const loaded=await desktop.loadGpuEngineVideoFramePreviewSession!(owner.engineVideoSessionRef.current,preview.graph,preview.assetBindings,preview.timelineFrame);
    validateOffscreenCompositionLoad(expected,loaded);
    owners.set(owner,expected);
  }
  if (!isCurrent()) return undefined;
  const result=await desktop.renderGpuEngineVideoPreviewFrame!(owner.engineVideoSessionRef.current,preview.timelineFrame,
    Math.min(.25,.5*preview.graph.timebase.numerator/preview.graph.timebase.denominator));
  if (result.schema!=="editkin.engine-video-png-preview/v1") throw new Error("Offscreen PNG IPC schema mismatch");
  const validated=validateOffscreenCompositionFrame(expected,preview.timelineFrame,result);
  owner.assertActive(); if (!isCurrent()) return undefined;
  const candidate=await holder.prepare({pngBytes:result.pngBytes,pngSha256:result.pngSha256,
    pixelFnvHash:validated.outputHash,width:validated.width,height:validated.height},isCurrent);
  if (!candidate) return undefined;
  const decoded=holder.publish(candidate,isCurrent);
  return decoded?{decoded,frame:validated.timelineFrame,value:{motionGraphicIds:validated.motionGraphicIds,captionIds:validated.captionIds}}:undefined;
}
