export function assertGreen(report: Record<string, any>) {
  if (report.schema !== "editkin.temporal-look-project-render-gate/v1" || report.status !== "GREEN") throw new Error("temporal look project render is not GREEN");
  if (report.executionMode !== "resident-gpu-shader-sequence/v1" || report.frameCount !== 15 || report.losslessPixelDifferences !== 0) throw new Error("temporal look intermediate was not lossless");
  if (report.combinedContract !== "decoded-temporal-typography-adjustment/v1" || report.motionContract !== "decoded-temporal-shutter-accumulation/v1"
    || report.typographyContract !== "decoded-temporal-typography-overlays/v1" || report.adjustmentContract !== "decoded-temporal-pre-typography-adjustment/v1") throw new Error("temporal look contracts are incomplete");
  if (report.temporalFramesWithReceipt !== 15 || report.maximumDistinctDecodedTimestampCount < 2 || report.residentFrameRingSize < 8) throw new Error("temporal look decoded receipt is incomplete");
  if (report.captionCueIds?.join() !== "caption-single-colour" || report.motionGraphicIds?.join() !== "title-card" || report.singleColourCaptions !== true) throw new Error("temporal look typography identity is incomplete");
  if (report.captionTextureUploads !== 1 || report.motionGraphicTextureUploads !== 1 || report.framesWithActiveCaptions !== 9 || report.framesWithActiveMotionGraphics !== 8) throw new Error("temporal look typography timeline is incomplete");
  if (report.adjustmentClipIds?.join() !== "adjustment-grade" || report.adjustmentNodeIds?.join() !== "color:adjustment-grade,adjustment:adjustment-grade"
    || report.adjustmentFramesWithReceipt !== 9 || report.adjustmentExecutionMode !== "pre-typography-full-frame/v1") throw new Error("temporal look adjustment identity is incomplete");
  if (report.typographyChangedPixels < 1000 || report.typographyHighDeltaPixels < 500 || report.adjustmentChangedPixels < 1000 || report.adjustmentHighDeltaPixels < 500) throw new Error("temporal look artifact oracles are incomplete");
  if (!report.captionPlanSuppressed || !report.adjustmentPlanSuppressed || !report.typographyProjectSuppressed || !report.adjustmentProjectSuppressed
    || !report.materializedClipReset || !report.sourceProjectImmutable || report.retainedAudioClipCount !== 1) throw new Error("temporal look duplicate-pass suppression is incomplete");
  if (report.overlayCombinedContract !== "decoded-temporal-video-overlay-typography-adjustment/v1"
    || report.overlayCompositeContract !== "decoded-temporal-video-overlay/v1" || report.overlayCompositeFramesWithReceipt !== 15
    || report.overlayAdjustmentBaseLayerCount !== 2 || report.overlayLosslessPixelDifferences !== 0
    || report.overlayChangedPixels < 500 || report.overlayHighDeltaPixels < 100) throw new Error("temporal overlay look contracts or artifact evidence are incomplete");
  if (!report.overlayPlanSuppressed || !report.overlayProjectSuppressed || !report.overlaySourceProjectImmutable || report.overlayRetainedAudioClipCount !== 2
    || report.overlayProductPathCpuPixelCopies !== 0 || report.overlayVerificationReadback !== true) throw new Error("temporal overlay look suppression or zero-copy evidence is incomplete");
  if (report.multiOverlayCombinedContract !== "decoded-temporal-multi-video-overlay-typography-adjustment/v1"
    || report.multiOverlayCompositeContract !== "decoded-temporal-video-overlay/v1"
    || report.multiOverlayClipIds?.join() !== "clip-overlay,clip-overlay-two"
    || report.multiOverlayCompositeFramesWithReceipt !== 15 || report.multiOverlayCompositeLayerCount !== 3
    || report.multiOverlayAdjustmentMinimumBaseLayerCount !== 3 || report.multiOverlayAdjustmentMaximumBaseLayerCount !== 3
    || report.multiOverlayLosslessPixelDifferences !== 0 || report.secondOverlayChangedPixels < 500 || report.secondOverlayHighDeltaPixels < 100) throw new Error("multi-overlay temporal look contracts or artifact evidence are incomplete");
  if (!report.multiOverlayPlanSuppressed || !report.multiOverlayProjectSuppressed || !report.multiOverlaySourceProjectImmutable
    || report.multiOverlayRetainedAudioClipCount !== 3 || report.multiOverlayProductPathCpuPixelCopies !== 0
    || report.multiOverlayVerificationReadback !== true) throw new Error("multi-overlay temporal look suppression or zero-copy evidence is incomplete");
  if (report.multiAdjustmentCombinedContract !== "decoded-temporal-typography-multi-adjustment/v1"
    || report.multiAdjustmentContract !== "decoded-temporal-pre-typography-multi-adjustment/v1"
    || report.multiAdjustmentClipIds?.join() !== "adjustment-grade,adjustment-finish"
    || report.multiAdjustmentFramesWithReceipt !== 9 || report.multiAdjustmentTotalPasses !== 15
    || report.multiAdjustmentMinimumActiveCount !== 1 || report.multiAdjustmentMaximumActiveCount !== 2
    || report.multiAdjustmentBaseLayerCount !== 1 || report.multiAdjustmentLosslessPixelDifferences !== 0
    || report.secondAdjustmentChangedPixels < 500 || report.secondAdjustmentHighDeltaPixels < 100) throw new Error("multi-adjustment temporal look contracts or artifact evidence are incomplete");
  if (!report.multiAdjustmentPlanSuppressed || !report.multiAdjustmentProjectSuppressed || !report.multiAdjustmentSourceProjectImmutable
    || !report.multiAdjustmentCaptionSingleColour || report.multiAdjustmentRetainedAudioClipCount !== 1
    || report.multiAdjustmentProductPathCpuPixelCopies !== 0 || report.multiAdjustmentVerificationReadback !== true) throw new Error("multi-adjustment temporal look suppression or zero-copy evidence is incomplete");
  if (report.particleCombinedContract !== "decoded-temporal-resource-governed-look/v1"
    || report.particleContract !== "decoded-temporal-particle-overlay/v1"
    || report.particleEmitterNodeIds?.join() !== "vfx:particles"
    || report.particleFramesWithReceipt !== 6 || report.particleCeiling !== 48 || report.particleMaximumGpuTextureWrites < 1
    || report.particleAdjustmentMinimumBaseLayerCount !== 1 || report.particleAdjustmentMaximumBaseLayerCount !== 2
    || report.particleLosslessPixelDifferences !== 0 || report.particleChangedPixels < 200 || report.particleHighDeltaPixels < 100) throw new Error("particle temporal look contracts or artifact evidence are incomplete");
  if (!report.particlePlanSuppressed || !report.particleProjectSuppressed || !report.particleSourceProjectImmutable
    || !report.particleCaptionSingleColour || report.particleRetainedAudioClipCount !== 1
    || report.particleProductPathCpuPixelCopies !== 0 || report.particleVerificationReadback !== true) throw new Error("particle temporal look suppression or zero-copy evidence is incomplete");
  if (report.particleMultiAdjustmentCombinedContract !== "decoded-temporal-resource-governed-look/v1"
    || report.particleMultiAdjustmentContract !== "decoded-temporal-pre-typography-multi-adjustment/v1"
    || report.particleMultiAdjustmentClipIds?.join() !== "adjustment-grade,adjustment-finish"
    || report.particleMultiAdjustmentFramesWithReceipt !== 9 || report.particleMultiAdjustmentTotalPasses !== 15
    || report.particleMultiAdjustmentMinimumActiveCount !== 1 || report.particleMultiAdjustmentMaximumActiveCount !== 2
    || report.particleMultiAdjustmentMinimumBaseLayerCount !== 1 || report.particleMultiAdjustmentMaximumBaseLayerCount !== 2
    || report.particleMultiAdjustmentLosslessPixelDifferences !== 0
    || report.particleSecondAdjustmentChangedPixels < 500 || report.particleSecondAdjustmentHighDeltaPixels < 100) throw new Error("particle multi-adjustment temporal look contracts or artifact evidence are incomplete");
  if (!report.particleMultiAdjustmentPlanSuppressed || !report.particleMultiAdjustmentProjectSuppressed
    || !report.particleMultiAdjustmentSourceProjectImmutable || !report.particleMultiAdjustmentCaptionSingleColour
    || report.particleMultiAdjustmentRetainedAudioClipCount !== 1 || report.particleMultiAdjustmentProductPathCpuPixelCopies !== 0
    || report.particleMultiAdjustmentVerificationReadback !== true) throw new Error("particle multi-adjustment suppression or zero-copy evidence is incomplete");
  if (report.particleOverlayCombinedContract !== "decoded-temporal-resource-governed-look/v1"
    || report.particleOverlayParticleContract !== "decoded-temporal-particle-overlay/v1"
    || report.particleOverlayCompositeContract !== "decoded-temporal-video-overlay/v1"
    || report.particleOverlayAdjustmentContract !== "decoded-temporal-pre-typography-adjustment/v1"
    || report.particleOverlayClipIds?.join() !== "clip-overlay" || report.particleOverlayEmitterNodeIds?.join() !== "vfx:particles"
    || report.particleOverlayCompositeFramesWithReceipt !== 15 || report.particleOverlayParticleFramesWithReceipt !== 6
    || report.particleOverlayMinimumBaseLayerCount !== 2 || report.particleOverlayMaximumBaseLayerCount !== 3
    || report.particleOverlayLosslessPixelDifferences !== 0
    || report.particleOverlayParticleChangedPixels < 100 || report.particleOverlayVideoChangedPixels < 500) throw new Error("particle-overlay temporal look contracts or artifact evidence are incomplete");
  if (!report.particleOverlayPlanSuppressed || !report.particleOverlayProjectSuppressed
    || !report.particleOverlaySourceProjectImmutable || !report.particleOverlayCaptionSingleColour
    || report.particleOverlayRetainedAudioClipCount !== 2 || report.particleOverlayProductPathCpuPixelCopies !== 0
    || report.particleOverlayVerificationReadback !== true) throw new Error("particle-overlay suppression or zero-copy evidence is incomplete");
  if (report.particleAnimatedOverlayCombinedContract !== "decoded-temporal-resource-governed-look/v1"
    || report.particleAnimatedOverlayAnimationContract !== "decoded-temporal-video-overlay-transform-animation/v1"
    || report.particleAnimatedOverlayParticleContract !== "decoded-temporal-particle-overlay/v1"
    || report.particleAnimatedOverlayCompositeContract !== "decoded-temporal-video-overlay/v1"
    || report.particleAnimatedOverlayAdjustmentContract !== "decoded-temporal-pre-typography-multi-adjustment/v1"
    || report.particleAnimatedOverlayAdjustmentClipIds?.join() !== "adjustment-grade,adjustment-finish"
    || report.particleAnimatedOverlayAdjustmentFramesWithReceipt !== 9 || report.particleAnimatedOverlayAdjustmentTotalPasses !== 15
    || report.particleAnimatedOverlayAdjustmentMinimumActiveCount !== 1 || report.particleAnimatedOverlayAdjustmentMaximumActiveCount !== 2
    || report.particleAnimatedOverlayClipIds?.join() !== "clip-overlay"
    || report.particleAnimatedOverlayTransformNodeIds?.join() !== "transform:clip-overlay"
    || report.particleAnimatedOverlayKeyframeCount !== 2
    || report.particleAnimatedOverlayCompositeFramesWithReceipt !== 15 || report.particleAnimatedOverlayParticleFramesWithReceipt !== 6
    || report.particleAnimatedOverlayMinimumBaseLayerCount !== 2 || report.particleAnimatedOverlayMaximumBaseLayerCount !== 3
    || report.particleAnimatedOverlayLosslessPixelDifferences !== 0
    || report.particleAnimatedOverlayTransformChangedPixels < 500 || report.particleAnimatedOverlayTransformHighDeltaPixels < 100) throw new Error("particle animated-overlay contracts or artifact evidence are incomplete");
  if (!report.particleAnimatedOverlayPlanSuppressed || !report.particleAnimatedOverlayProjectSuppressed
    || !report.particleAnimatedOverlaySourceProjectImmutable || !report.particleAnimatedOverlayCaptionSingleColour
    || report.particleAnimatedOverlayRetainedAudioClipCount !== 2
    || report.particleAnimatedOverlayProductPathCpuPixelCopies !== 0
    || report.particleAnimatedOverlayVerificationReadback !== true) throw new Error("particle animated-overlay suppression or zero-copy evidence is incomplete");
  if (report.particleOverlayMultiAdjustmentCombinedContract !== "decoded-temporal-resource-governed-look/v1"
    || report.particleOverlayMultiAdjustmentParticleContract !== "decoded-temporal-particle-overlay/v1"
    || report.particleOverlayMultiAdjustmentCompositeContract !== "decoded-temporal-video-overlay/v1"
    || report.particleOverlayMultiAdjustmentContract !== "decoded-temporal-pre-typography-multi-adjustment/v1"
    || report.particleOverlayMultiAdjustmentClipIds?.join() !== "adjustment-grade,adjustment-finish"
    || report.particleOverlayMultiAdjustmentOverlayClipIds?.join() !== "clip-overlay"
    || report.particleOverlayMultiAdjustmentEmitterNodeIds?.join() !== "vfx:particles"
    || report.particleOverlayMultiAdjustmentFramesWithReceipt !== 9 || report.particleOverlayMultiAdjustmentTotalPasses !== 15
    || report.particleOverlayMultiAdjustmentMinimumActiveCount !== 1 || report.particleOverlayMultiAdjustmentMaximumActiveCount !== 2
    || report.particleOverlayMultiAdjustmentCompositeFramesWithReceipt !== 15 || report.particleOverlayMultiAdjustmentParticleFramesWithReceipt !== 6
    || report.particleOverlayMultiAdjustmentMinimumBaseLayerCount !== 2 || report.particleOverlayMultiAdjustmentMaximumBaseLayerCount !== 3
    || report.particleOverlayMultiAdjustmentLosslessPixelDifferences !== 0
    || report.particleOverlaySecondAdjustmentChangedPixels < 500 || report.particleOverlaySecondAdjustmentHighDeltaPixels < 100) throw new Error("particle-overlay multi-adjustment contracts or artifact evidence are incomplete");
  if (!report.particleOverlayMultiAdjustmentPlanSuppressed || !report.particleOverlayMultiAdjustmentProjectSuppressed
    || !report.particleOverlayMultiAdjustmentSourceProjectImmutable || !report.particleOverlayMultiAdjustmentCaptionSingleColour
    || report.particleOverlayMultiAdjustmentRetainedAudioClipCount !== 2
    || report.particleOverlayMultiAdjustmentProductPathCpuPixelCopies !== 0
    || report.particleOverlayMultiAdjustmentVerificationReadback !== true) throw new Error("particle-overlay multi-adjustment suppression or zero-copy evidence is incomplete");
  if (report.particlePartialOverlayCombinedContract !== "decoded-temporal-resource-governed-look/v1"
    || report.particlePartialOverlayParticleContract !== "decoded-temporal-particle-overlay/v1"
    || report.particlePartialOverlayCompositeContract !== "decoded-temporal-video-overlay/v1"
    || report.particlePartialOverlayAdjustmentContract !== "decoded-temporal-pre-typography-adjustment/v1"
    || report.particlePartialOverlayClipIds?.join() !== "clip-overlay" || report.particlePartialOverlayEmitterNodeIds?.join() !== "vfx:particles"
    || report.particlePartialOverlayCompositeFramesWithReceipt !== 9 || report.particlePartialOverlayParticleFramesWithReceipt !== 6
    || report.particlePartialOverlayRangeStartFrame !== 6 || report.particlePartialOverlayRangeDurationFrames !== 9
    || report.particlePartialOverlayMinimumBaseLayerCount !== 1 || report.particlePartialOverlayMaximumBaseLayerCount !== 3
    || report.particlePartialOverlayLosslessPixelDifferences !== 0 || report.particlePartialOverlayInactivePixelDifferences !== 0
    || report.particlePartialOverlayParticleChangedPixels < 100 || report.particlePartialOverlayVideoChangedPixels < 500) throw new Error("particle partial-overlay contracts or artifact evidence are incomplete");
  if (report.particlePartialOverlayPlanGapFrames !== 9 || report.particlePartialOverlayPlanTailFrames !== 9
    || Math.abs((report.particlePartialOverlayProjectTail?.timelineStart ?? -1) - .5) > 1e-6
    || Math.abs((report.particlePartialOverlayProjectTail?.sourceStart ?? -1) - .5) > 1e-6
    || Math.abs((report.particlePartialOverlayProjectTail?.duration ?? -1) - .3) > 1e-6
    || !report.particlePartialOverlayPlanSuppressed || !report.particlePartialOverlayProjectSuppressed
    || !report.particlePartialOverlaySourceProjectImmutable || !report.particlePartialOverlayCaptionSingleColour
    || report.particlePartialOverlayRetainedAudioClipCount !== 2 || report.particlePartialOverlayProductPathCpuPixelCopies !== 0
    || report.particlePartialOverlayVerificationReadback !== true) throw new Error("particle partial-overlay interval suppression is incomplete");
  if (report.particlePartialOverlayMultiAdjustmentCombinedContract !== "decoded-temporal-resource-governed-look/v1"
    || report.particlePartialOverlayMultiAdjustmentParticleContract !== "decoded-temporal-particle-overlay/v1"
    || report.particlePartialOverlayMultiAdjustmentCompositeContract !== "decoded-temporal-video-overlay/v1"
    || report.particlePartialOverlayMultiAdjustmentContract !== "decoded-temporal-pre-typography-multi-adjustment/v1"
    || report.particlePartialOverlayMultiAdjustmentClipIds?.join() !== "adjustment-grade,adjustment-finish"
    || report.particlePartialOverlayMultiAdjustmentOverlayClipIds?.join() !== "clip-overlay"
    || report.particlePartialOverlayMultiAdjustmentEmitterNodeIds?.join() !== "vfx:particles"
    || report.particlePartialOverlayMultiAdjustmentFramesWithReceipt !== 9 || report.particlePartialOverlayMultiAdjustmentTotalPasses !== 15
    || report.particlePartialOverlayMultiAdjustmentMinimumActiveCount !== 1 || report.particlePartialOverlayMultiAdjustmentMaximumActiveCount !== 2
    || report.particlePartialOverlayMultiAdjustmentCompositeFramesWithReceipt !== 9 || report.particlePartialOverlayMultiAdjustmentParticleFramesWithReceipt !== 6
    || report.particlePartialOverlayMultiAdjustmentRangeStartFrame !== 6 || report.particlePartialOverlayMultiAdjustmentRangeDurationFrames !== 9
    || report.particlePartialOverlayMultiAdjustmentMinimumBaseLayerCount !== 1 || report.particlePartialOverlayMultiAdjustmentMaximumBaseLayerCount !== 3
    || report.particlePartialOverlayMultiAdjustmentLosslessPixelDifferences !== 0
    || report.particlePartialOverlaySecondAdjustmentChangedPixels < 500 || report.particlePartialOverlaySecondAdjustmentHighDeltaPixels < 100) throw new Error("particle partial-overlay multi-adjustment contracts or artifact evidence are incomplete");
  if (report.particlePartialOverlayMultiAdjustmentPlanGapFrames !== 9 || report.particlePartialOverlayMultiAdjustmentPlanTailFrames !== 9
    || Math.abs((report.particlePartialOverlayMultiAdjustmentProjectTail?.timelineStart ?? -1) - .5) > 1e-6
    || Math.abs((report.particlePartialOverlayMultiAdjustmentProjectTail?.sourceStart ?? -1) - .5) > 1e-6
    || Math.abs((report.particlePartialOverlayMultiAdjustmentProjectTail?.duration ?? -1) - .3) > 1e-6
    || !report.particlePartialOverlayMultiAdjustmentPlanSuppressed || !report.particlePartialOverlayMultiAdjustmentProjectSuppressed
    || !report.particlePartialOverlayMultiAdjustmentSourceProjectImmutable || !report.particlePartialOverlayMultiAdjustmentCaptionSingleColour
    || report.particlePartialOverlayMultiAdjustmentRetainedAudioClipCount !== 2
    || report.particlePartialOverlayMultiAdjustmentProductPathCpuPixelCopies !== 0
    || report.particlePartialOverlayMultiAdjustmentVerificationReadback !== true) throw new Error("particle partial-overlay multi-adjustment interval suppression is incomplete");
  if (report.partialOverlayCombinedContract !== "decoded-temporal-partial-video-overlay-typography-adjustment/v1"
    || report.partialOverlayCompositeContract !== "decoded-temporal-video-overlay/v1" || report.partialOverlayCompositeFramesWithReceipt !== 9
    || report.partialOverlayRangeStartFrame !== 6 || report.partialOverlayRangeDurationFrames !== 9
    || report.partialOverlayAdjustmentMinimumBaseLayerCount !== 1 || report.partialOverlayAdjustmentMaximumBaseLayerCount !== 2
    || report.partialOverlayLosslessPixelDifferences !== 0 || report.partialOverlayInactivePixelDifferences !== 0
    || report.partialOverlayChangedPixels < 500 || report.partialOverlayHighDeltaPixels < 100) throw new Error("partial temporal overlay look contracts or artifact evidence are incomplete");
  if (report.partialOverlayPlanGapFrames !== 9 || report.partialOverlayPlanTailFrames !== 9
    || Math.abs((report.partialOverlayProjectTail?.timelineStart ?? -1) - .5) > 1e-6
    || Math.abs((report.partialOverlayProjectTail?.sourceStart ?? -1) - .5) > 1e-6
    || Math.abs((report.partialOverlayProjectTail?.duration ?? -1) - .3) > 1e-6
    || !report.partialOverlayCaptionPlanSuppressed || !report.partialOverlayAdjustmentPlanSuppressed
    || !report.partialOverlayTypographyProjectSuppressed || !report.partialOverlayAdjustmentProjectSuppressed
    || !report.partialOverlaySourceProjectImmutable || report.partialOverlayRetainedAudioClipCount !== 2
    || report.partialOverlayProductPathCpuPixelCopies !== 0 || report.partialOverlayVerificationReadback !== true) throw new Error("partial temporal overlay look interval suppression is incomplete");
  if (report.productPathCpuPixelCopies !== 0 || report.verificationReadback !== true || report.programCount !== 0 || report.rejectedNegativeControls?.length !== 15) throw new Error("temporal look safety evidence is incomplete");
  for (const value of [report.executableSha256, report.stackSha256, report.intermediateSha256, report.firstFrameSha256, report.lastFrameSha256]) if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("temporal look identity is incomplete");
}

export function syntheticSelfTest() {
  const report = {
    schema: "editkin.temporal-look-project-render-gate/v1", status: "GREEN", executionMode: "resident-gpu-shader-sequence/v1", frameCount: 15, losslessPixelDifferences: 0,
    combinedContract: "decoded-temporal-typography-adjustment/v1", motionContract: "decoded-temporal-shutter-accumulation/v1", typographyContract: "decoded-temporal-typography-overlays/v1", adjustmentContract: "decoded-temporal-pre-typography-adjustment/v1",
    temporalFramesWithReceipt: 15, maximumDistinctDecodedTimestampCount: 2, residentFrameRingSize: 8,
    captionCueIds: ["caption-single-colour"], motionGraphicIds: ["title-card"], singleColourCaptions: true, captionTextureUploads: 1, motionGraphicTextureUploads: 1, framesWithActiveCaptions: 9, framesWithActiveMotionGraphics: 8,
    adjustmentClipIds: ["adjustment-grade"], adjustmentNodeIds: ["color:adjustment-grade", "adjustment:adjustment-grade"], adjustmentFramesWithReceipt: 9, adjustmentExecutionMode: "pre-typography-full-frame/v1",
    typographyChangedPixels: 3000, typographyHighDeltaPixels: 2000, adjustmentChangedPixels: 4000, adjustmentHighDeltaPixels: 2500,
    captionPlanSuppressed: true, adjustmentPlanSuppressed: true, typographyProjectSuppressed: true, adjustmentProjectSuppressed: true, materializedClipReset: true, sourceProjectImmutable: true, retainedAudioClipCount: 1,
    overlayCombinedContract: "decoded-temporal-video-overlay-typography-adjustment/v1", overlayCompositeContract: "decoded-temporal-video-overlay/v1", overlayCompositeFramesWithReceipt: 15, overlayAdjustmentBaseLayerCount: 2, overlayLosslessPixelDifferences: 0, overlayChangedPixels: 5000, overlayHighDeltaPixels: 3000,
    overlayPlanSuppressed: true, overlayProjectSuppressed: true, overlaySourceProjectImmutable: true, overlayRetainedAudioClipCount: 2, overlayProductPathCpuPixelCopies: 0, overlayVerificationReadback: true,
    multiOverlayCombinedContract: "decoded-temporal-multi-video-overlay-typography-adjustment/v1", multiOverlayCompositeContract: "decoded-temporal-video-overlay/v1", multiOverlayClipIds: ["clip-overlay", "clip-overlay-two"],
    multiOverlayCompositeFramesWithReceipt: 15, multiOverlayCompositeLayerCount: 3, multiOverlayAdjustmentMinimumBaseLayerCount: 3, multiOverlayAdjustmentMaximumBaseLayerCount: 3,
    multiOverlayLosslessPixelDifferences: 0, secondOverlayChangedPixels: 4500, secondOverlayHighDeltaPixels: 2800, multiOverlayPlanSuppressed: true, multiOverlayProjectSuppressed: true,
    multiOverlaySourceProjectImmutable: true, multiOverlayRetainedAudioClipCount: 3, multiOverlayProductPathCpuPixelCopies: 0, multiOverlayVerificationReadback: true,
    multiAdjustmentCombinedContract: "decoded-temporal-typography-multi-adjustment/v1", multiAdjustmentContract: "decoded-temporal-pre-typography-multi-adjustment/v1", multiAdjustmentClipIds: ["adjustment-grade", "adjustment-finish"],
    multiAdjustmentFramesWithReceipt: 9, multiAdjustmentTotalPasses: 15, multiAdjustmentMinimumActiveCount: 1, multiAdjustmentMaximumActiveCount: 2, multiAdjustmentBaseLayerCount: 1,
    multiAdjustmentLosslessPixelDifferences: 0, secondAdjustmentChangedPixels: 4200, secondAdjustmentHighDeltaPixels: 2700, multiAdjustmentPlanSuppressed: true, multiAdjustmentProjectSuppressed: true,
    multiAdjustmentSourceProjectImmutable: true, multiAdjustmentCaptionSingleColour: true, multiAdjustmentRetainedAudioClipCount: 1, multiAdjustmentProductPathCpuPixelCopies: 0, multiAdjustmentVerificationReadback: true,
    particleCombinedContract: "decoded-temporal-resource-governed-look/v1", particleContract: "decoded-temporal-particle-overlay/v1", particleEmitterNodeIds: ["vfx:particles"],
    particleFramesWithReceipt: 6, particleCeiling: 48, particleMaximumGpuTextureWrites: 6, particleAdjustmentMinimumBaseLayerCount: 1, particleAdjustmentMaximumBaseLayerCount: 2,
    particleLosslessPixelDifferences: 0, particleChangedPixels: 3600, particleHighDeltaPixels: 2100, particlePlanSuppressed: true, particleProjectSuppressed: true,
    particleSourceProjectImmutable: true, particleCaptionSingleColour: true, particleRetainedAudioClipCount: 1, particleProductPathCpuPixelCopies: 0, particleVerificationReadback: true,
    particleMultiAdjustmentCombinedContract: "decoded-temporal-resource-governed-look/v1", particleMultiAdjustmentContract: "decoded-temporal-pre-typography-multi-adjustment/v1",
    particleMultiAdjustmentClipIds: ["adjustment-grade", "adjustment-finish"], particleMultiAdjustmentFramesWithReceipt: 9, particleMultiAdjustmentTotalPasses: 15,
    particleMultiAdjustmentMinimumActiveCount: 1, particleMultiAdjustmentMaximumActiveCount: 2, particleMultiAdjustmentMinimumBaseLayerCount: 1, particleMultiAdjustmentMaximumBaseLayerCount: 2,
    particleMultiAdjustmentLosslessPixelDifferences: 0, particleSecondAdjustmentChangedPixels: 4100, particleSecondAdjustmentHighDeltaPixels: 2600,
    particleMultiAdjustmentPlanSuppressed: true, particleMultiAdjustmentProjectSuppressed: true, particleMultiAdjustmentSourceProjectImmutable: true,
    particleMultiAdjustmentCaptionSingleColour: true, particleMultiAdjustmentRetainedAudioClipCount: 1, particleMultiAdjustmentProductPathCpuPixelCopies: 0, particleMultiAdjustmentVerificationReadback: true,
    particleOverlayCombinedContract: "decoded-temporal-resource-governed-look/v1", particleOverlayParticleContract: "decoded-temporal-particle-overlay/v1",
    particleOverlayCompositeContract: "decoded-temporal-video-overlay/v1", particleOverlayAdjustmentContract: "decoded-temporal-pre-typography-adjustment/v1",
    particleOverlayClipIds: ["clip-overlay"], particleOverlayEmitterNodeIds: ["vfx:particles"], particleOverlayCompositeFramesWithReceipt: 15, particleOverlayParticleFramesWithReceipt: 6,
    particleOverlayMinimumBaseLayerCount: 2, particleOverlayMaximumBaseLayerCount: 3, particleOverlayLosslessPixelDifferences: 0,
    particleOverlayParticleChangedPixels: 900, particleOverlayVideoChangedPixels: 4200, particleOverlayPlanSuppressed: true, particleOverlayProjectSuppressed: true,
    particleOverlaySourceProjectImmutable: true, particleOverlayCaptionSingleColour: true, particleOverlayRetainedAudioClipCount: 2,
    particleOverlayProductPathCpuPixelCopies: 0, particleOverlayVerificationReadback: true,
    particleAnimatedOverlayCombinedContract: "decoded-temporal-resource-governed-look/v1",
    particleAnimatedOverlayAnimationContract: "decoded-temporal-video-overlay-transform-animation/v1",
    particleAnimatedOverlayParticleContract: "decoded-temporal-particle-overlay/v1", particleAnimatedOverlayCompositeContract: "decoded-temporal-video-overlay/v1",
    particleAnimatedOverlayAdjustmentContract: "decoded-temporal-pre-typography-multi-adjustment/v1",
    particleAnimatedOverlayAdjustmentClipIds: ["adjustment-grade", "adjustment-finish"],
    particleAnimatedOverlayAdjustmentFramesWithReceipt: 9, particleAnimatedOverlayAdjustmentTotalPasses: 15,
    particleAnimatedOverlayAdjustmentMinimumActiveCount: 1, particleAnimatedOverlayAdjustmentMaximumActiveCount: 2,
    particleAnimatedOverlayClipIds: ["clip-overlay"],
    particleAnimatedOverlayTransformNodeIds: ["transform:clip-overlay"], particleAnimatedOverlayKeyframeCount: 2,
    particleAnimatedOverlayCompositeFramesWithReceipt: 15, particleAnimatedOverlayParticleFramesWithReceipt: 6,
    particleAnimatedOverlayMinimumBaseLayerCount: 2, particleAnimatedOverlayMaximumBaseLayerCount: 3,
    particleAnimatedOverlayLosslessPixelDifferences: 0, particleAnimatedOverlayTransformChangedPixels: 4200, particleAnimatedOverlayTransformHighDeltaPixels: 2600,
    particleAnimatedOverlayPlanSuppressed: true, particleAnimatedOverlayProjectSuppressed: true, particleAnimatedOverlaySourceProjectImmutable: true,
    particleAnimatedOverlayCaptionSingleColour: true, particleAnimatedOverlayRetainedAudioClipCount: 2,
    particleAnimatedOverlayProductPathCpuPixelCopies: 0, particleAnimatedOverlayVerificationReadback: true,
    particleOverlayMultiAdjustmentCombinedContract: "decoded-temporal-resource-governed-look/v1",
    particleOverlayMultiAdjustmentParticleContract: "decoded-temporal-particle-overlay/v1", particleOverlayMultiAdjustmentCompositeContract: "decoded-temporal-video-overlay/v1",
    particleOverlayMultiAdjustmentContract: "decoded-temporal-pre-typography-multi-adjustment/v1",
    particleOverlayMultiAdjustmentClipIds: ["adjustment-grade", "adjustment-finish"], particleOverlayMultiAdjustmentOverlayClipIds: ["clip-overlay"], particleOverlayMultiAdjustmentEmitterNodeIds: ["vfx:particles"],
    particleOverlayMultiAdjustmentFramesWithReceipt: 9, particleOverlayMultiAdjustmentTotalPasses: 15,
    particleOverlayMultiAdjustmentMinimumActiveCount: 1, particleOverlayMultiAdjustmentMaximumActiveCount: 2,
    particleOverlayMultiAdjustmentCompositeFramesWithReceipt: 15, particleOverlayMultiAdjustmentParticleFramesWithReceipt: 6,
    particleOverlayMultiAdjustmentMinimumBaseLayerCount: 2, particleOverlayMultiAdjustmentMaximumBaseLayerCount: 3,
    particleOverlayMultiAdjustmentLosslessPixelDifferences: 0, particleOverlaySecondAdjustmentChangedPixels: 850, particleOverlaySecondAdjustmentHighDeltaPixels: 600,
    particleOverlayMultiAdjustmentPlanSuppressed: true, particleOverlayMultiAdjustmentProjectSuppressed: true, particleOverlayMultiAdjustmentSourceProjectImmutable: true,
    particleOverlayMultiAdjustmentCaptionSingleColour: true, particleOverlayMultiAdjustmentRetainedAudioClipCount: 2,
    particleOverlayMultiAdjustmentProductPathCpuPixelCopies: 0, particleOverlayMultiAdjustmentVerificationReadback: true,
    particlePartialOverlayCombinedContract: "decoded-temporal-resource-governed-look/v1",
    particlePartialOverlayParticleContract: "decoded-temporal-particle-overlay/v1", particlePartialOverlayCompositeContract: "decoded-temporal-video-overlay/v1",
    particlePartialOverlayAdjustmentContract: "decoded-temporal-pre-typography-adjustment/v1", particlePartialOverlayClipIds: ["clip-overlay"], particlePartialOverlayEmitterNodeIds: ["vfx:particles"],
    particlePartialOverlayCompositeFramesWithReceipt: 9, particlePartialOverlayParticleFramesWithReceipt: 6, particlePartialOverlayRangeStartFrame: 6, particlePartialOverlayRangeDurationFrames: 9,
    particlePartialOverlayMinimumBaseLayerCount: 1, particlePartialOverlayMaximumBaseLayerCount: 3, particlePartialOverlayLosslessPixelDifferences: 0, particlePartialOverlayInactivePixelDifferences: 0,
    particlePartialOverlayParticleChangedPixels: 800, particlePartialOverlayVideoChangedPixels: 4000, particlePartialOverlayPlanGapFrames: 9, particlePartialOverlayPlanTailFrames: 9,
    particlePartialOverlayProjectTail: { timelineStart: .5, sourceStart: .5, duration: .3 }, particlePartialOverlayPlanSuppressed: true, particlePartialOverlayProjectSuppressed: true,
    particlePartialOverlaySourceProjectImmutable: true, particlePartialOverlayCaptionSingleColour: true, particlePartialOverlayRetainedAudioClipCount: 2,
    particlePartialOverlayProductPathCpuPixelCopies: 0, particlePartialOverlayVerificationReadback: true,
    particlePartialOverlayMultiAdjustmentCombinedContract: "decoded-temporal-resource-governed-look/v1",
    particlePartialOverlayMultiAdjustmentParticleContract: "decoded-temporal-particle-overlay/v1", particlePartialOverlayMultiAdjustmentCompositeContract: "decoded-temporal-video-overlay/v1",
    particlePartialOverlayMultiAdjustmentContract: "decoded-temporal-pre-typography-multi-adjustment/v1",
    particlePartialOverlayMultiAdjustmentClipIds: ["adjustment-grade", "adjustment-finish"], particlePartialOverlayMultiAdjustmentOverlayClipIds: ["clip-overlay"], particlePartialOverlayMultiAdjustmentEmitterNodeIds: ["vfx:particles"],
    particlePartialOverlayMultiAdjustmentFramesWithReceipt: 9, particlePartialOverlayMultiAdjustmentTotalPasses: 15,
    particlePartialOverlayMultiAdjustmentMinimumActiveCount: 1, particlePartialOverlayMultiAdjustmentMaximumActiveCount: 2,
    particlePartialOverlayMultiAdjustmentCompositeFramesWithReceipt: 9, particlePartialOverlayMultiAdjustmentParticleFramesWithReceipt: 6,
    particlePartialOverlayMultiAdjustmentRangeStartFrame: 6, particlePartialOverlayMultiAdjustmentRangeDurationFrames: 9,
    particlePartialOverlayMultiAdjustmentMinimumBaseLayerCount: 1, particlePartialOverlayMultiAdjustmentMaximumBaseLayerCount: 3,
    particlePartialOverlayMultiAdjustmentLosslessPixelDifferences: 0, particlePartialOverlaySecondAdjustmentChangedPixels: 850, particlePartialOverlaySecondAdjustmentHighDeltaPixels: 600,
    particlePartialOverlayMultiAdjustmentPlanGapFrames: 9, particlePartialOverlayMultiAdjustmentPlanTailFrames: 9,
    particlePartialOverlayMultiAdjustmentProjectTail: { timelineStart: .5, sourceStart: .5, duration: .3 },
    particlePartialOverlayMultiAdjustmentPlanSuppressed: true, particlePartialOverlayMultiAdjustmentProjectSuppressed: true,
    particlePartialOverlayMultiAdjustmentSourceProjectImmutable: true, particlePartialOverlayMultiAdjustmentCaptionSingleColour: true,
    particlePartialOverlayMultiAdjustmentRetainedAudioClipCount: 2, particlePartialOverlayMultiAdjustmentProductPathCpuPixelCopies: 0,
    particlePartialOverlayMultiAdjustmentVerificationReadback: true,
    partialOverlayCombinedContract: "decoded-temporal-partial-video-overlay-typography-adjustment/v1", partialOverlayCompositeContract: "decoded-temporal-video-overlay/v1", partialOverlayCompositeFramesWithReceipt: 9, partialOverlayRangeStartFrame: 6, partialOverlayRangeDurationFrames: 9,
    partialOverlayAdjustmentMinimumBaseLayerCount: 1, partialOverlayAdjustmentMaximumBaseLayerCount: 2, partialOverlayLosslessPixelDifferences: 0, partialOverlayInactivePixelDifferences: 0, partialOverlayChangedPixels: 4000, partialOverlayHighDeltaPixels: 2500,
    partialOverlayPlanGapFrames: 9, partialOverlayPlanTailFrames: 9, partialOverlayProjectTail: { timelineStart: .5, sourceStart: .5, duration: .3 }, partialOverlayCaptionPlanSuppressed: true, partialOverlayAdjustmentPlanSuppressed: true,
    partialOverlayTypographyProjectSuppressed: true, partialOverlayAdjustmentProjectSuppressed: true, partialOverlaySourceProjectImmutable: true, partialOverlayRetainedAudioClipCount: 2, partialOverlayProductPathCpuPixelCopies: 0, partialOverlayVerificationReadback: true,
    productPathCpuPixelCopies: 0, verificationReadback: true, programCount: 0, rejectedNegativeControls: ["missing-runtime", "translation", "outside-range", "third-adjustment", "animated-partial-overlay", "third-overlay", "targeted-fallback", "fifth-particle", "particle-outside-range", "particle-third-adjustment", "particle-partial-video-overlay-third-adjustment", "particle-non-overlapping-video-overlay", "particle-budget", "particle-third-overlay-keyframe", "particle-animated-overlay-third-adjustment"],
    executableSha256: "a".repeat(64), stackSha256: "b".repeat(64), intermediateSha256: "c".repeat(64), firstFrameSha256: "d".repeat(64), lastFrameSha256: "e".repeat(64),
  };
  assertGreen(report); let calibratedNegatives = 0;
  for (const candidate of [{ ...report, status: "BLOCK" }, { ...report, losslessPixelDifferences: 1 }, { ...report, adjustmentFramesWithReceipt: 8 }, { ...report, typographyChangedPixels: 0 }, { ...report, adjustmentPlanSuppressed: false }, { ...report, singleColourCaptions: false }, { ...report, particleFramesWithReceipt: 5 }, { ...report, particleProjectSuppressed: false }, { ...report, particleMultiAdjustmentTotalPasses: 14 }, { ...report, particleOverlayMaximumBaseLayerCount: 2 }, { ...report, particleAnimatedOverlayKeyframeCount: 1 }, { ...report, particleAnimatedOverlayKeyframeCount: 3 }, { ...report, particleOverlayMultiAdjustmentTotalPasses: 14 }, { ...report, particlePartialOverlayPlanTailFrames: 8 }]) {
    let rejected = false; try { assertGreen(candidate); } catch { rejected = true; calibratedNegatives += 1; } if (!rejected) throw new Error("temporal look evaluator accepted a calibrated negative");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: report.schema, calibratedNegatives })}\n`);
}


