import { describe, expect, it } from "vitest";
import { splitManyDone } from "../../application/templateFollowEditActions";
import { BLADE_TOO_CLOSE, SPLIT_NOTHING_HERE } from "../../application/timelineSplitTarget";
import { DELETE_LEFT_DONE, DELETE_LEFT_TEMPLATE_DONE, DELETE_RIGHT_DONE, DELETE_RIGHT_TEMPLATE_DONE, DELETE_SIDE_NOTHING_HERE, RIPPLE_NOTES,
  rippleMessage } from "../../application/timelineRippleEdits";
import { TEMPLATE_REBUILD_TOO_SHORT } from "../../application/referenceMotionTemplateInstances";
import { templateEditMessage } from "../../application/timelineMotionEdits";
import { BLADE_HELP, BLADE_TOOL_HELP, SELECT_TOOL_BACK, SELECT_TOOL_HELP } from "../timelineContract";
import { createInterfacePreferencesStore, type UiLocale } from "./interfacePreferences";

// The status lines of the 剪刀 tool, Ctrl+B, Shift+click and Q / W come out whole in every language through the real built
// locale files: every combination the editor can say (each ripple note, the title-template words), names and numbers kept.
const CJK = /[㐀-鿿]/;
const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, name: string) => values[name]);
const notes = [RIPPLE_NOTES.heldAudio, RIPPLE_NOTES.heldVideo, RIPPLE_NOTES.heldBoth, RIPPLE_NOTES.locked, RIPPLE_NOTES.captionsLocked, RIPPLE_NOTES.attachments];
const stale = (reason: string) => ({ needsReapply: [{ instanceId: "t", title: "River", reason }] });
const tooShort = stale(TEMPLATE_REBUILD_TOO_SHORT), other = stale("這個模板或字型的版本已經更新。");
const deleteDone = [DELETE_LEFT_DONE, DELETE_RIGHT_DONE, fill(DELETE_LEFT_TEMPLATE_DONE, { title: "Bats" }), fill(DELETE_RIGHT_TEMPLATE_DONE, { title: "Bats" })];
const followed = "後面的標題模板也跟著移好";
const messages = [
  BLADE_HELP, BLADE_TOOL_HELP, SELECT_TOOL_HELP, SELECT_TOOL_BACK, BLADE_TOO_CLOSE, SPLIT_NOTHING_HERE, DELETE_SIDE_NOTHING_HERE,
  // Shift+click: several clips cut at one time, plain and with the title templates they change.
  `${splitManyDone(6, 3)}。`, templateEditMessage(splitManyDone(6, 3), { needsReapply: [] }), templateEditMessage(splitManyDone(6, 3), tooShort),
  templateEditMessage(splitManyDone(6, 3), other),
  // Q / W: plain with every note, the later templates that moved along with every note, and the template words alone.
  ...deleteDone.flatMap(done => [rippleMessage(done), ...notes.map(note => rippleMessage(done, note)),
    ...notes.map(note => rippleMessage(`${done}，${followed}`, note)), templateEditMessage(done, { needsReapply: [] }, followed),
    templateEditMessage(done, tooShort, followed), templateEditMessage(done, other, followed)]),
];

describe("the 剪刀 tool's and Q / W's status words in every language", () => {
  it("covers every combination", () => {
    expect(new Set(messages).size).toBe(messages.length);
    expect(messages).toHaveLength(11 + 4 * 16);
    expect(templateEditMessage(splitManyDone(6, 3), tooShort)).toContain("片段太短");
  });
  it.each(["en", "es", "ja", "ko"] as const)("%s", async locale => {
    const store = createInterfacePreferencesStore({});
    expect(await store.setLocale(locale as UiLocale)).toBe(true);
    for (const message of messages) {
      const shown = store.translateStatus(message);
      expect(shown, message).not.toBe(message);
      if (locale === "en" || locale === "es") expect(shown, message).not.toMatch(CJK);
      for (const kept of ["Bats", "River", "6.00", "3"]) if (message.includes(kept)) expect(shown, message).toContain(kept);
    }
  });
});
