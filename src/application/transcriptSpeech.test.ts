import { describe, expect, it } from "vitest";
import { assessTranscriptSpeech } from "./transcriptSpeech";

describe("which recognizer cues count as speech for the auto edit (roadmap 1.14)", () => {
  it("treats Whisper's ambient-only output as no usable speech", () => {
    // Recognizer output for a no-voice clip with background chatter (IMG_3975, real run 2026-10-10).
    const cues = [
      { start: 0, end: 3.02, text: "." },
      { start: 2.98, end: 4.98, text: "ŋ ŋ ŋ ŋ ŋ ŋ ŋ ŋ" },
      { start: 8.96, end: 11.92, text: "outez, thanks for watching, itted, cherish, thank you very much ;)" },
    ];
    const result = assessTranscriptSpeech(cues, 18.7);
    expect(result.usable).toBe(false);
    expect(result.speechCues).toEqual([]);
    expect(result.discarded.map((cue) => cue.reason)).toEqual(["no-content", "repetition", "recognizer-boilerplate"]);
  });

  it("drops sound descriptions and channel-outro boilerplate but keeps real narration", () => {
    const cues = [
      { start: 0, end: 3, text: "今天帶大家看觀音山的獨角仙" },
      { start: 3, end: 4.5, text: "(people chattering)" },
      { start: 4.5, end: 6, text: "[감사합니다]" },
      { start: 6, end: 9, text: "Hãy subscribe cho kênh Ghiền Mì Gõ" },
      { start: 9, end: 12, text: "樹上停滿了獨角仙" },
      { start: 12, end: 14, text: "字幕由 Amara.org 社群提供" },
      { start: 14, end: 16, text: "♪" },
    ];
    const result = assessTranscriptSpeech(cues, 16);
    expect(result.usable).toBe(true);
    expect(result.speechCues.map((cue) => cue.text)).toEqual(["今天帶大家看觀音山的獨角仙", "樹上停滿了獨角仙"]);
    expect(result.discarded.map((cue) => cue.reason)).toEqual(["sound-description", "sound-description", "recognizer-boilerplate", "recognizer-boilerplate", "no-content"]);
    expect(result.speechSeconds).toBe(6);
  });

  it("keeps ordinary speech, laughter and mixed Chinese/English intact", () => {
    const cues = [
      { start: 0, end: 2, text: "哈哈哈哈" }, { start: 2, end: 5, text: "這個 AI 工具真的很好用" },
      { start: 5, end: 6, text: "OK" }, { start: 6, end: 9, text: "我們下次見" },
    ];
    const result = assessTranscriptSpeech(cues, 9);
    expect(result.speechCues).toHaveLength(4);
    expect(result.usable).toBe(true);
    const short = assessTranscriptSpeech([{ start: 0, end: 1, text: "好。" }, { start: 1, end: 2, text: "對" }, { start: 2, end: 3, text: "a" }, { start: 3, end: 4, text: "7" }], 4);
    expect(short.speechCues.map((cue) => cue.text)).toEqual(["好。", "對", "7"]);
  });

  it("Japanese mixes kanji and kana in one language; a Chinese speaker abroad is not noise", () => {
    const travel = [
      { start: 0, end: 3, text: "我們現在在京都的市場" }, { start: 3, end: 5, text: "いらっしゃいませ" },
      { start: 5, end: 8, text: "抹茶のアイスはいかがですか" }, { start: 8, end: 10, text: "OK thank you" },
    ];
    expect(assessTranscriptSpeech(travel, 10).usable).toBe(true);
  });

  it("drops a bare web address (product whisper-cli on a no-voice clip, IMG_3979) but keeps a sentence that mentions one", () => {
    const ambient = assessTranscriptSpeech([{ start: 0, end: 2, text: " www.mooji.org" }], 5.6);
    expect(ambient.usable).toBe(false);
    expect(ambient.discarded[0].reason).toBe("recognizer-boilerplate");
    expect(assessTranscriptSpeech([{ start: 0, end: 3, text: "打開 github.com 下載" }], 5).speechCues).toHaveLength(1);
    expect(assessTranscriptSpeech([{ start: 0, end: 3, text: "3.5" }, { start: 3, end: 6, text: "這台手機有三點五吋" }], 6).speechCues).toHaveLength(2);
  });

  it("a soup of unrelated languages over ambient sound is not speech", () => {
    // Shape of the FFmpeg-filter recognizer output on IMG_3974 (per-chunk language detection).
    const soup = [
      { start: 0, end: 2, text: "Привет друзья" }, { start: 3, end: 5, text: "多麼好" }, { start: 6, end: 8, text: "그래서요" },
      { start: 9, end: 11, text: "tenga essen" }, { start: 12, end: 14, text: "日本語" },
    ];
    expect(assessTranscriptSpeech(soup, 20).usable).toBe(false);
    const bilingual = [{ start: 0, end: 4, text: "今天用 Claude Code 剪片" }, { start: 4, end: 8, text: "This is the result" }, { start: 8, end: 12, text: "效果比想像中好很多" }];
    expect(assessTranscriptSpeech(bilingual, 12).usable).toBe(true);
  });

  it("one stray line over a long ambient clip is not a talking clip", () => {
    // Product whisper-cli output on the no-voice IMG_3974 (20.1 s): one cue of a base letter plus marks.
    const ambient = assessTranscriptSpeech([{ start: 0, end: 2, text: " ន្្្្្្" }], 20.1);
    expect(ambient.usable).toBe(false);
    expect(ambient.discarded[0].reason).toBe("no-content");
    expect(assessTranscriptSpeech([{ start: 4, end: 4.8, text: "哇好美" }], 30).usable).toBe(false);
    expect(assessTranscriptSpeech([{ start: 4, end: 7, text: "哇這裡的海真的好美" }], 30).usable).toBe(false);
    expect(assessTranscriptSpeech([{ start: 0, end: 3, text: "哇這裡的海真的好美" }], 6).usable).toBe(true);
    expect(assessTranscriptSpeech([{ start: 4, end: 7, text: "哇這裡的海真的好美" }, { start: 20, end: 23, text: "我們再往前走" }], 30).usable).toBe(true);
    expect(assessTranscriptSpeech([], 10).usable).toBe(false);
  });

  it("keeps sparse narration in a long video", () => {
    const cues = Array.from({ length: 12 }, (_, index) => ({ start: index * 50, end: index * 50 + 5, text: `第 ${index + 1} 個步驟先把材料備好` }));
    expect(assessTranscriptSpeech(cues, 600).usable).toBe(true);
  });
});
