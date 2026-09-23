import type { EditorCommand } from "../domain/commands";
import { projectWithoutTemplateApplication, isTemplateElementOwner, templateApplicationSnapshot } from "../domain/templateApplication";
import type {
  CaptionCue,
  DirectorMarker,
  EditProject,
  MotionGraphic,
  TemplateApplicationState,
  TemplateElementOwner,
} from "../domain/types";

export interface TemplateApplicationIdentity {
  sessionId: string;
  templateId: string;
  templateName: string;
  format: "short" | "long";
  createdAt: string;
}

export function templateElementOwner(identity: TemplateApplicationIdentity, role: string): TemplateElementOwner {
  return {
    schema: "editkin.template-element-owner/v1",
    sessionId: identity.sessionId,
    templateId: identity.templateId,
    format: identity.format,
    role,
  };
}

export function isTemplateGeneratedGraphic(graphic: Pick<MotionGraphic, "templateOwner">): boolean {
  return isTemplateElementOwner(graphic.templateOwner);
}

export function isTemplateGeneratedCaption(caption: Pick<CaptionCue, "templateOwner">): boolean {
  return isTemplateElementOwner(caption.templateOwner);
}

export function isTemplateGeneratedMarker(marker: Pick<DirectorMarker, "templateOwner">): boolean {
  return isTemplateElementOwner(marker.templateOwner);
}

/** Logical base for a new template: prior owned state is rolled back first. */
export function templateApplicationBase(project: EditProject): EditProject {
  return projectWithoutTemplateApplication(project);
}

export function createTemplateApplicationState(
  beforeProject: EditProject,
  appliedProject: EditProject,
  identity: TemplateApplicationIdentity,
  clipIds: readonly string[],
): TemplateApplicationState {
  return {
    schema: "editkin.template-application/v1",
    ...identity,
    before: templateApplicationSnapshot(beforeProject, clipIds),
    applied: templateApplicationSnapshot(appliedProject, clipIds),
  };
}

/** One atomic command performs explicit-element cleanup and conditional rollback. */
export function templateApplicationCleanupCommands(project: EditProject): EditorCommand[] {
  return project.templateApplication || templateOwnedElementCount(project) > 0
    ? [{ type: "clear_template_application" }]
    : [];
}

/** @deprecated The old name now performs full template rollback, not overlay-only cleanup. */
export const templateOverlayCleanupCommands = templateApplicationCleanupCommands;

export function templateOwnedElementCount(project: EditProject): number {
  return project.motionGraphics.filter(isTemplateGeneratedGraphic).length
    + project.captions.filter(isTemplateGeneratedCaption).length
    + project.director.markers.filter(isTemplateGeneratedMarker).length;
}

/** @deprecated Use templateOwnedElementCount. */
export const templateOverlayCount = templateOwnedElementCount;
