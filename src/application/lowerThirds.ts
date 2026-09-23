import type { EditorCommand } from "../domain/commands";
import type { EditProject, MotionGraphic } from "../domain/types";
import { createMotionGraphic } from "../motion/composition";
import { LOWER_THIRD_PRESETS, type LowerThirdPreset, type LowerThirdPresetId } from "../creative/lowerThirdPresets";

export { LOWER_THIRD_PRESETS };
export type { LowerThirdPreset, LowerThirdPresetId };

export function isLowerThirdGraphic(graphic: Pick<MotionGraphic, "presetId">): boolean {
  return Boolean(graphic.presetId?.startsWith("lower_third_") || graphic.presetId?.startsWith("editkin.lower-third/"));
}

function overlaps(graphic: Pick<MotionGraphic, "timelineStart" | "duration">, start: number, duration: number): boolean {
  return graphic.timelineStart < start + duration && graphic.timelineStart + graphic.duration > start;
}

function cleanText(input: string, label: string, maximum: number): string {
  const value = input.trim().replace(/\s+/gu, " ");
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label}必須是 1–${maximum} 個字`);
  return value;
}

function estimatedAdvance(text: string, fontSize: number): number {
  return [...text].reduce((width, character) => {
    if (/\s/u.test(character)) return width + fontSize * .34;
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x2e80 || code >= 0x1f000) return width + fontSize;
    if (/[ilI1|!.,:;'`]/u.test(character)) return width + fontSize * .32;
    if (/[mwMW@#%&]/u.test(character)) return width + fontSize * .88;
    if (/[A-Z0-9]/u.test(character)) return width + fontSize * .64;
    return width + fontSize * .56;
  }, 0);
}

function adaptiveWidth(text: string, fontSize: number, projectWidth: number, minimum: number, maximum: number): number {
  const padding = Math.max(6, Math.ceil(fontSize * .28)) * 2;
  const desired = (estimatedAdvance(text, fontSize) + padding) / projectWidth + .018;
  return Math.max(minimum, Math.min(maximum, desired));
}

function scaleForCanvasHeight(graphic: MotionGraphic, projectHeight: number): void {
  const scale = projectHeight / 1080;
  graphic.fontSize = Math.max(12, Math.round(graphic.fontSize * scale));
  if (graphic.layoutV2) {
    graphic.layoutV2.minFontSize = Math.max(12, Math.round(graphic.layoutV2.minFontSize * scale));
    graphic.layoutV2.lineGap = Math.round(graphic.layoutV2.lineGap * scale);
  }
}

function fitMotionToDuration(graphic: MotionGraphic, fps: number): void {
  if (!graphic.motionV2) return;
  const frames = Math.max(1, Math.round(graphic.duration * fps));
  if (frames < 2) throw new Error("人物字幕條至少需要 2 個影格的可見畫面。");
  const entranceFrames = Math.min(graphic.motionV2.entrance.durationFrames, Math.max(1, Math.floor(frames * .6)));
  const exitFrames = Math.min(graphic.motionV2.exit.durationFrames, Math.max(1, frames - entranceFrames));
  graphic.motionV2.entrance.durationFrames = entranceFrames;
  graphic.motionV2.exit.durationFrames = exitFrames;
}

function visualEndAt(project: EditProject, time: number): number {
  const frame = 1 / project.fps;
  const active = project.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => track.clips)
    .filter((clip) => time >= clip.timelineStart - frame / 2 && time < clip.timelineStart + clip.duration - frame / 2);
  if (!active.length) throw new Error("播放頭不在畫面片段內；請先移到要顯示人物字幕條的畫面。");
  return Math.max(...active.map((clip) => clip.timelineStart + clip.duration));
}

export function buildLowerThirdCommand(project: EditProject, input: {
  presetId: LowerThirdPresetId;
  personName: string;
  organization: string;
  timelineStart: number;
  duration?: number;
}, idFactory: (prefix: string) => string): EditorCommand {
  const preset = LOWER_THIRD_PRESETS.find((item) => item.id === input.presetId);
  if (!preset) throw new Error(`未知人名 BAR 樣式：${input.presetId}`);
  const personName = cleanText(input.personName, "人名", 18);
  const organization = cleanText(input.organization, "單位／職稱", 28);
  const start = Math.max(0, Math.round(input.timelineStart * project.fps) / project.fps);
  const visibleEnd = visualEndAt(project, start);
  const duration = Math.max(1 / project.fps, Math.min(12, input.duration ?? 5, visibleEnd - start));
  const groupId = idFactory("lower-third");
  const cleanup = project.motionGraphics
    .filter((graphic) => isLowerThirdGraphic(graphic) && overlaps(graphic, start, duration))
    .map((graphic): EditorCommand => ({ type: "delete_motion_graphic", graphicId: graphic.id }));
  const nameGraphic = createMotionGraphic(`${groupId}-name`, "card", personName, start, duration, undefined, preset.nameBar);
  const unitDelay = Math.min(.08, Math.max(0, duration - 1 / project.fps));
  const unitGraphic = createMotionGraphic(`${groupId}-unit`, "tag", organization, start + unitDelay, Math.max(1 / project.fps, duration - unitDelay), undefined, preset.unitBar);
  scaleForCanvasHeight(nameGraphic, project.height);
  scaleForCanvasHeight(unitGraphic, project.height);
  fitMotionToDuration(nameGraphic, project.fps);
  fitMotionToDuration(unitGraphic, project.fps);
  const nameMinimum = Math.max(.2, Math.min(.34, 360 / project.width));
  const unitMinimum = Math.max(.18, Math.min(.32, 310 / project.width));
  const nameMaximum = Math.max(.52, Math.min(.76, 900 / project.width));
  const unitMaximum = Math.max(.56, Math.min(.8, 960 / project.width));
  nameGraphic.width = adaptiveWidth(personName, nameGraphic.fontSize, project.width, nameMinimum, nameMaximum);
  unitGraphic.width = adaptiveWidth(organization, unitGraphic.fontSize, project.width, unitMinimum, unitMaximum);
  return { type: "batch", commands: [...cleanup,
    { type: "add_motion_graphic", graphic: nameGraphic },
    { type: "add_motion_graphic", graphic: unitGraphic },
  ] };
}
