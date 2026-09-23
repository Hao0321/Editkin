import type {
  CaptionStyle,
  EditProject,
  TemplateApplicationSnapshot,
  TemplateCreativeSnapshot,
  TemplateElementOwner,
  TimelineClip,
} from "./types";

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isTemplateElementOwner(value: TemplateElementOwner | undefined): value is TemplateElementOwner {
  return value?.schema === "editkin.template-element-owner/v1";
}

export function templateCreativeSnapshot(clip: TimelineClip): TemplateCreativeSnapshot {
  return {
    clipId: clip.id,
    creativePresent: clip.creative !== undefined,
    lookPresetId: clip.creative?.lookPresetId ?? null,
    effectPresetIds: [...(clip.creative?.effectPresetIds ?? [])],
    transitionIn: clip.creative?.transitionIn ? { ...clip.creative.transitionIn } : null,
    transitionOut: clip.creative?.transitionOut ? { ...clip.creative.transitionOut } : null,
  };
}

export function templateApplicationSnapshot(project: EditProject, clipIds: readonly string[]): TemplateApplicationSnapshot {
  const wanted = new Set(clipIds);
  return {
    editorialProfile: project.editorialProfile,
    aestheticSystem: project.aestheticSystem ? structuredClone(project.aestheticSystem) : null,
    captionStyle: structuredClone(project.captionStyle),
    clips: project.tracks.flatMap((track) => track.clips)
      .filter((clip) => wanted.has(clip.id))
      .map(templateCreativeSnapshot),
  };
}

function restoreCaptionStyle(current: CaptionStyle, applied: CaptionStyle, before: CaptionStyle): CaptionStyle {
  const restored = { ...current };
  for (const key of Object.keys(applied) as Array<keyof CaptionStyle>) {
    if (same(current[key], applied[key])) (restored as Record<string, unknown>)[key] = before[key];
  }
  return restored;
}

/**
 * Removes explicitly owned template elements and conditionally rolls back
 * template-wide settings. A value edited by the user after application is
 * detached from template ownership and therefore preserved.
 */
export function clearTemplateApplicationInPlace(project: EditProject): void {
  project.motionGraphics = project.motionGraphics.filter((graphic) => !isTemplateElementOwner(graphic.templateOwner));
  project.captions = project.captions.filter((caption) => !isTemplateElementOwner(caption.templateOwner));
  project.director.markers = project.director.markers.filter((marker) => !isTemplateElementOwner(marker.templateOwner));

  const application = project.templateApplication;
  if (!application) return;
  const { before, applied } = application;
  if (project.editorialProfile === applied.editorialProfile) project.editorialProfile = before.editorialProfile;
  if (same(project.aestheticSystem ?? null, applied.aestheticSystem)) {
    project.aestheticSystem = before.aestheticSystem ? structuredClone(before.aestheticSystem) : undefined;
  }
  project.captionStyle = restoreCaptionStyle(project.captionStyle, applied.captionStyle, before.captionStyle);

  const beforeByClip = new Map(before.clips.map((clip) => [clip.clipId, clip] as const));
  for (const appliedClip of applied.clips) {
    const clip = project.tracks.flatMap((track) => track.clips).find((item) => item.id === appliedClip.clipId);
    const prior = beforeByClip.get(appliedClip.clipId);
    if (!clip || !prior) continue;
    const creative = structuredClone(clip.creative ?? { effectPresetIds: [] });
    if ((creative.lookPresetId ?? null) === appliedClip.lookPresetId) {
      if (prior.lookPresetId === null) delete creative.lookPresetId;
      else creative.lookPresetId = prior.lookPresetId;
    }
    if (same(creative.effectPresetIds, appliedClip.effectPresetIds)) creative.effectPresetIds = [...prior.effectPresetIds];
    if (same(creative.transitionIn ?? null, appliedClip.transitionIn)) {
      if (prior.transitionIn === null) delete creative.transitionIn;
      else creative.transitionIn = { ...prior.transitionIn };
    }
    if (same(creative.transitionOut ?? null, appliedClip.transitionOut)) {
      if (prior.transitionOut === null) delete creative.transitionOut;
      else creative.transitionOut = { ...prior.transitionOut };
    }
    clip.creative = !prior.creativePresent && !creative.lookPresetId && creative.effectPresetIds.length === 0
      && !creative.transitionIn && !creative.transitionOut && !creative.nativeEffectInstances?.length
      ? undefined
      : creative;
  }
  project.templateApplication = undefined;
}

export function projectWithoutTemplateApplication(project: EditProject): EditProject {
  const cleared = structuredClone(project);
  clearTemplateApplicationInPlace(cleared);
  return cleared;
}
