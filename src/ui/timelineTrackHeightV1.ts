import { useState } from "react";

/** 軌道高度 小／中／大: a viewing preference of this computer, never saved in the project. */
export type TimelineTrackHeightV1 = "s" | "m" | "l";
export const TIMELINE_TRACK_HEIGHTS_V1: ReadonlyArray<{ id: TimelineTrackHeightV1; label: string; pixels: number }> = [
  { id: "s", label: "小", pixels: 40 }, { id: "m", label: "中", pixels: 52 }, { id: "l", label: "大", pixels: 76 },
];
const KEY = "editkin.timeline.trackHeight.v1";

export function readTimelineTrackHeightV1(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): TimelineTrackHeightV1 {
  try { const value = storage?.getItem(KEY); return value === "s" || value === "l" ? value : "m"; } catch { return "m"; }
}
export function writeTimelineTrackHeightV1(value: TimelineTrackHeightV1, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage) {
  try { storage?.setItem(KEY, value); } catch { /* A preference only: a blocked storage keeps the session's choice. */ }
}
export function useTimelineTrackHeightV1(): [TimelineTrackHeightV1, (value: TimelineTrackHeightV1) => void] {
  const [height, setHeight] = useState(() => readTimelineTrackHeightV1());
  return [height, value => { setHeight(value); writeTimelineTrackHeightV1(value); }];
}
