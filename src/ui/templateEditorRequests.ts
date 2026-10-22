import type { EditProject, MotionGraphic } from "../domain/types";
import type { ReferenceMotionTemplateInstance } from "../domain/referenceMotionInstance";
import { motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { prepareMotionSceneCamera2D, projectMotionScenePoint, type PreparedMotionSceneCamera2D } from "../motion/sceneCamera2d";

/**
 * One way to open the saved-template editor from anywhere: the timeline lane, the main clip's Inspector, the Motion
 * studio hint, or a click on a title in the preview. The editor itself stays where the editor shell renders it; it
 * listens for this request, opens, selects the template and puts the cursor in its title field.
 */

export const TEMPLATE_EDITOR_REQUEST_EVENT = "editkin:open-template-editor";
export type TemplateEditorRequestSource = "timeline" | "inspector" | "motion-studio" | "preview";
export interface TemplateEditorRequestDetail {
  instanceId: string;
  source: TemplateEditorRequestSource;
}

export function isTemplateEditorRequestDetail(value: unknown): value is TemplateEditorRequestDetail {
  if (!value || typeof value !== "object") return false;
  const detail = value as Partial<TemplateEditorRequestDetail>;
  return typeof detail.instanceId === "string" && detail.instanceId.length > 0 && detail.instanceId.length <= 160
    && ["timeline", "inspector", "motion-studio", "preview"].includes(detail.source as string);
}

function eventTarget(target?: EventTarget): EventTarget | undefined {
  return target ?? (typeof document === "undefined" ? undefined : document);
}

/** Ask the editor shell's template editor to open on this template. False when there is no document to ask. */
export function requestTemplateEditor(instanceId: string, source: TemplateEditorRequestSource, target?: EventTarget): boolean {
  const scope = eventTarget(target);
  if (!scope || typeof CustomEvent === "undefined") return false;
  scope.dispatchEvent(new CustomEvent<TemplateEditorRequestDetail>(TEMPLATE_EDITOR_REQUEST_EVENT, { detail: { instanceId, source } }));
  return true;
}

export function subscribeTemplateEditorRequests(handler: (detail: TemplateEditorRequestDetail) => void, target?: EventTarget): () => void {
  const scope = eventTarget(target);
  if (!scope) return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isTemplateEditorRequestDetail(detail)) handler(detail);
  };
  scope.addEventListener(TEMPLATE_EDITOR_REQUEST_EVENT, listener);
  return () => scope.removeEventListener(TEMPLATE_EDITOR_REQUEST_EVENT, listener);
}

/** The saved template that owns each graphic, by graphic id. */
export function templateOwnerByGraphic(project: Pick<EditProject, "referenceMotionInstances">): Map<string, ReferenceMotionTemplateInstance> {
  const owners = new Map<string, ReferenceMotionTemplateInstance>();
  for (const instance of project.referenceMotionInstances ?? []) {
    for (const role of instance.roles) if (role.kind === "graphic") owners.set(role.id, instance);
  }
  return owners;
}

/** Where a graphic's text sits on the canvas at a frame, as fractions of the frame (through a scene camera, as drawn). */
function graphicBox(project: EditProject, graphic: MotionGraphic, frame: number, camera: PreparedMotionSceneCamera2D | undefined): { x: number; y: number; width: number; height: number } {
  if (graphic.schema === "hao.motion-composition/v2") {
    try {
      const box = motionGraphicV2LayoutReceipt(project, graphic).box;
      const projection = camera?.sample(graphic.id, frame);
      const origin = projection ? projectMotionScenePoint({ x: box.x, y: box.y }, projection) : box, scale = projection?.scale ?? 1;
      return { x: origin.x / project.width, y: origin.y / project.height, width: box.width * scale / project.width, height: box.height * scale / project.height };
    } catch { /* Physical layouts may not be prepared here; use the authored slot below. */ }
  }
  const lineHeight = Math.max(graphic.fontSize * 1.5, 24) / Math.max(1, project.height);
  return { x: graphic.x, y: graphic.y, width: graphic.width, height: lineHeight };
}

/**
 * The template whose visible title is under a point of the preview (x/y as fractions of the canvas), at the playhead.
 * The topmost visible graphic wins, the way the preview draws them.
 */
export function templateInstanceAtPoint(project: EditProject, playhead: number, point: { x: number; y: number }): ReferenceMotionTemplateInstance | undefined {
  if (![point.x, point.y, playhead].every(Number.isFinite)) return undefined;
  const owners = templateOwnerByGraphic(project);
  if (!owners.size) return undefined;
  const fps = Number.isFinite(project.fps) && project.fps > 0 ? project.fps : 30, frame = Math.round(playhead * fps);
  let camera: PreparedMotionSceneCamera2D | undefined;
  try { camera = prepareMotionSceneCamera2D(project); } catch { camera = undefined; }
  for (const graphic of [...project.motionGraphics].reverse()) {
    const owner = owners.get(graphic.id);
    if (!owner || (graphic.vectorV2 && !graphic.text.trim())) continue;
    const start = Math.round(graphic.timelineStart * fps), end = start + Math.max(1, Math.round(graphic.duration * fps));
    if (frame < start || frame >= end) continue;
    const box = graphicBox(project, graphic, frame, camera), pad = 0.012;
    if (point.x >= box.x - pad && point.x <= box.x + box.width + pad && point.y >= box.y - pad && point.y <= box.y + box.height + pad) return owner;
  }
  return undefined;
}

/** For the preview: open the editor when a title of a saved template was clicked. True when it opened. */
export function openTemplateEditorAtPoint(project: EditProject, playhead: number, point: { x: number; y: number }, target?: EventTarget): boolean {
  const instance = templateInstanceAtPoint(project, playhead, point);
  return instance ? requestTemplateEditor(instance.id, "preview", target) : false;
}

/** Controls drawn inside the preview keep their own clicks. */
const PREVIEW_CONTROL_SELECTOR = "button, a[href], input, select, textarea, [role='button']";

/** The parts of the preview stage's click event that the hit test reads. */
export interface PreviewStageClick {
  clientX: number;
  clientY: number;
  target: EventTarget | null;
  currentTarget: { getBoundingClientRect(): { left: number; top: number; width: number; height: number }; contains?(node: unknown): boolean };
  stopPropagation(): void;
}

/**
 * The preview stage's onClick: a click on a saved template's title opens that template's editor; a click on a control
 * inside the preview (the play button, a retry button) is left alone. True when the editor was asked to open.
 */
export function openTemplateEditorFromStageClick(event: PreviewStageClick, project: EditProject, playhead: number, target?: EventTarget): boolean {
  const clicked = event.target as { closest?: (selector: string) => unknown } | null;
  const control = typeof clicked?.closest === "function" ? clicked.closest(PREVIEW_CONTROL_SELECTOR) : null;
  if (control && control !== event.currentTarget && (event.currentTarget.contains?.(control) ?? true)) return false;
  const bounds = event.currentTarget.getBoundingClientRect();
  if (!(bounds.width > 0 && bounds.height > 0)) return false;
  const point = { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
  if (!openTemplateEditorAtPoint(project, playhead, point, target)) return false;
  event.stopPropagation();
  return true;
}
