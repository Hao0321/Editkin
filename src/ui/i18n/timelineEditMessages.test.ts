import { describe, expect, it } from "vitest";
import { LIFT_DONE, LIFT_DONE_MANY, LIFT_TEMPLATE_DONE, RIPPLE_DONE, RIPPLE_DONE_MANY, RIPPLE_NOTES, RIPPLE_TEMPLATE_DONE, rippleMessage } from "../../application/timelineRippleEdits";
import { SPLIT_AT_EDGE, SPLIT_NOTHING_HERE } from "../../application/timelineSplitTarget";
import { TEMPLATE_LAYER_LOCKED_MESSAGE } from "../../domain/rippleDelete";
import { TRACK_LOCKED_MESSAGE } from "../../domain/trackLock";
import { createInterfacePreferencesStore, type UiLocale } from "./interfacePreferences";

// The 2026-10-11 timeline status lines (ripple delete and lift with every note, the lock and split refusals, 靜音 and
// 隱藏畫面) come out whole in every language through the real built locale files: no Chinese left in English or
// Spanish, the count and the names kept as typed.
const CJK = /[㐀-鿿]/;
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
const rippleNotes = [undefined, RIPPLE_NOTES.heldAudio, RIPPLE_NOTES.heldVideo, RIPPLE_NOTES.heldBoth, RIPPLE_NOTES.locked, RIPPLE_NOTES.captionsLocked, RIPPLE_NOTES.attachments];
const messages = [
  ...[RIPPLE_DONE, fill(RIPPLE_DONE_MANY, { count: 3 }), fill(RIPPLE_TEMPLATE_DONE, { title: "Bats" })].flatMap(done => rippleNotes.map(note => rippleMessage(done, note))),
  // A ripple that also moved saved title templates after it (application/timelineMotionEdits.ts) keeps its note.
  ...rippleNotes.filter(note => note !== undefined).map(note => rippleMessage(`${RIPPLE_DONE}，後面的標題模板也跟著移好`, note)),
  ...[LIFT_DONE, fill(LIFT_DONE_MANY, { count: 3 }), fill(LIFT_TEMPLATE_DONE, { title: "Bats" })]
    .flatMap(done => [undefined, RIPPLE_NOTES.captionsLocked, RIPPLE_NOTES.liftAttachments].map(note => rippleMessage(done, note))),
  // The same delete when the clip's own title template went with it and later templates moved, with every note.
  ...rippleNotes.filter(note => note !== undefined).map(note => rippleMessage(`${fill(RIPPLE_TEMPLATE_DONE, { title: "Bats" })}，後面的標題模板也跟著移好`, note)),
  // templateEditMessage's own forms after a ripple delete (；一次復原即可還原。): followed, too short, not followed.
  ...[RIPPLE_DONE, fill(RIPPLE_TEMPLATE_DONE, { title: "Bats" })].flatMap(done => [
    `${done}，後面的標題模板也跟著移好；一次復原即可還原。`,
    `${done}；片段太短，標題模板「River」放不下文字，沒有跟著改。把片段拉長後，可以在模板編輯器重新套用；一次復原即可還原。`,
    `${done}；標題模板「River」沒有跟著改，打開模板編輯器可以看原因並重新套用；一次復原即可還原。`]),
  TRACK_LOCKED_MESSAGE, TEMPLATE_LAYER_LOCKED_MESSAGE, SPLIT_NOTHING_HERE, SPLIT_AT_EDGE, "只有畫面軌可以隱藏畫面。",
  // src/ui/EditorShell.tsx: 靜音 and 隱藏畫面 name only what is true afterwards.
  "已取消「Cam 2」的靜音。", "已將「Cam 2」靜音；畫面照常顯示。", "已將「Cam 2」靜音。", "已顯示「Cam 2」的畫面。",
  "已隱藏「Cam 2」的畫面；聲音照常。", "已隱藏「Cam 2」的畫面。", "已切換軌道畫面。", "已切換軌道靜音。",
];

describe("the timeline's status words in every language", () => {
  it("covers every combination the editor can show", () => {
    expect(new Set(messages).size).toBe(messages.length);
    expect(messages.length).toBe(61);
  });
  it.each(["en", "es", "ja", "ko"] as const)("%s", async locale => {
    const store = createInterfacePreferencesStore({});
    expect(await store.setLocale(locale as UiLocale)).toBe(true);
    for (const message of messages) {
      const shown = store.translateStatus(message);
      expect(shown, message).not.toBe(message);
      if (locale === "en" || locale === "es") expect(shown, message).not.toMatch(CJK);
      if (message.includes("Bats")) expect(shown, message).toContain("Bats");
      if (message.includes("River")) expect(shown, message).toContain("River");
      if (message.includes("Cam 2")) expect(shown, message).toContain("Cam 2");
      if (message.includes(" 3 ")) expect(shown, message).toMatch(/3/);
    }
  });
});
