import type { RecentProject } from "../../desktop/recentProjects";
import { recentProjectFolder } from "../../desktop/recentProjects";
import { interfacePreferences, translateUi as uiText, type UiLocale } from "../i18n/interfacePreferences";

/** The easy start screen shows at most this many recent projects. */
export const EASY_RECENT_LIMIT = 5;

/** How opening a recent project went. "kept": nothing changed (the creator kept the open project, or it was canceled). */
export type EasyRecentOpenOutcome =
  | { kind: "opened" }
  | { kind: "kept" }
  | { kind: "missing" }
  /** `what` is a plain zh-TW message key (plainProblems); `detail` the raw reason for 「查看原因」. */
  | { kind: "failed"; what: string; detail?: string };

/**
 * The recent project files of this computer, for the easy start screen. Desktop only: the plain browser build has no
 * project files to reopen, so its host leaves this out and the list is not shown at all.
 */
export interface EasyRecentProjects {
  /** Newest first (a stable array until the list changes). */
  list(): readonly RecentProject[];
  subscribe(listener: () => void): () => void;
  /** For each path, false when that file no longer exists. */
  exists?(paths: readonly string[]): Promise<readonly boolean[]>;
  open(path: string): Promise<EasyRecentOpenOutcome>;
  /** Takes the project off the list; the file itself is never touched. */
  forget(path: string): void;
}

export type EasyRecentItemState = "ready" | "opening" | "missing" | "failed";

export interface EasyRecentItem {
  path: string;
  name: string;
  openedAt: number;
  /** Shown only when two projects have the same name, so they can be told apart. */
  folder?: string;
  state: EasyRecentItemState;
  /** Plain zh-TW message key and the raw reason, after an open that did not work. */
  problem?: { what: string; detail?: string };
  /** The state came from the creator's own click (announce it), not from the check when the screen opened. */
  announce?: boolean;
}

/** What the start screen shows; pure data and two callbacks, so the screen stays a pure component. */
export interface EasyRecentView {
  items: readonly EasyRecentItem[];
  /** One project is being opened: the others wait. */
  busy: boolean;
  now: number;
  onOpen(path: string): void;
  onForget(path: string): void;
}

const DAY_MS = 86_400_000;
const startOfDay = (time: number) => { const date = new Date(time); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); };

/** 「14:20」 in the interface language's own digits and order, always on a 24-hour clock. */
function clockTime(time: number, locale: UiLocale): string {
  try { return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(time); }
  catch { const date = new Date(time); return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; }
}

function calendarDate(time: number, now: number, locale: UiLocale): string {
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  try { return new Intl.DateTimeFormat(locale, sameYear ? { month: "long", day: "numeric" } : { year: "numeric", month: "long", day: "numeric" }).format(time); }
  catch { return new Date(time).toLocaleDateString(); }
}

/**
 * When a project was last opened, in plain words: 「今天 14:20」, 「昨天」, 「3 天前」, then the date. A time in the
 * future (the computer's clock moved) counts as today.
 */
export function recentOpenedWords(openedAt: number, now: number, locale: UiLocale = interfacePreferences.getSnapshot().locale): string {
  const days = Math.round((startOfDay(now) - startOfDay(openedAt)) / DAY_MS);
  if (days <= 0) return uiText("今天 {time}", { time: clockTime(openedAt, locale) });
  if (days === 1) return uiText("昨天");
  if (days < 7) return uiText("{days} 天前", { days });
  return calendarDate(openedAt, now, locale);
}

/** A project being opened, or one whose open did not work (with the plain reason). */
export type EasyRecentRowState = { state: "opening" } | { state: "failed"; problem: { what: string; detail?: string } };

export interface EasyRecentStates {
  rows: Readonly<Record<string, EasyRecentRowState>>;
  /** Files that are gone (from the check when the screen opened, or from an open). */
  missing: ReadonlySet<string>;
  /** Paths whose state came from the creator's own click. */
  announced: ReadonlySet<string>;
}

/** The first EASY_RECENT_LIMIT projects; a folder line only for names that appear more than once. */
export function easyRecentItems(list: readonly RecentProject[], { rows, missing, announced }: EasyRecentStates): EasyRecentItem[] {
  const visible = list.slice(0, EASY_RECENT_LIMIT);
  const counts = new Map<string, number>();
  for (const item of visible) counts.set(item.name.toLowerCase(), (counts.get(item.name.toLowerCase()) ?? 0) + 1);
  return visible.map(item => {
    const row = rows[item.path] as EasyRecentRowState | undefined;
    const state: EasyRecentItemState = row?.state ?? (missing.has(item.path) ? "missing" : "ready");
    return {
      path: item.path, name: item.name, openedAt: item.openedAt, state,
      ...((counts.get(item.name.toLowerCase()) ?? 0) > 1 ? { folder: recentProjectFolder(item.path) } : {}),
      ...(row?.state === "failed" ? { problem: row.problem } : {}),
      ...(state !== "ready" && state !== "opening" && announced.has(item.path) ? { announce: true } : {}),
    };
  });
}

/** Every zh-TW key the recent list can show (the i18n test checks each has translations). */
export function easyRecentMessageKeys(): string[] {
  return ["最近的作品", "上次打開：{when}", "今天 {time}", "昨天", "{days} 天前", "正在打開…",
    "找不到這個檔案了，可能被移走或刪掉了。", "從清單移除", "查看原因"];
}
