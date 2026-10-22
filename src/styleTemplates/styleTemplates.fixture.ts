import type { StyleCompileProject } from "./compiler";

/**
 * Test fixture: a hand-written plan over synthetic timed words. These words are
 * test data for the compiler and generators only; real proofs use recognizer
 * words (never invented on screen, M10).
 */
export const FIXTURE_WORDS = [
  { id: "w0", text: "結果", start: 0.4, end: 0.8 },
  { id: "w1", text: "顯示", start: 0.82, end: 1.2 },
  { id: "w2", text: "是", start: 1.22, end: 1.3 },
  { id: "w3", text: "零", start: 1.32, end: 1.55 },
  { id: "w4", text: "殘留", start: 1.56, end: 2.0 },
  { id: "w5", text: "我", start: 3.0, end: 3.2 },
  { id: "w6", text: "真正", start: 3.22, end: 3.6 },
  { id: "w7", text: "跑了", start: 3.62, end: 3.9 },
  { id: "w8", text: "五輪", start: 3.92, end: 4.4 },
  { id: "w9", text: "AI", start: 6.0, end: 6.3 },
  { id: "w10", text: "最強", start: 6.32, end: 6.8 },
  { id: "w11", text: "的", start: 6.82, end: 6.9 },
  { id: "w12", text: "時候", start: 6.92, end: 7.3 },
];

export function fixturePlan(template: string, aspect: "9:16" | "16:9" = "9:16") {
  return {
    schema: "editkin.style-plan/v1" as const,
    template,
    aspect,
    words: FIXTURE_WORDS,
    subjects: [{ from: 0, to: 10, box: [0.3, 0.45, 0.7, 0.95] as [number, number, number, number], kind: "face" as const }],
    beats: [
      { kind: "caption" as const, at: 0.4, wordRange: [0, 4] as [number, number], keyword: [3, 4] as [number, number] },
      { kind: "transition" as const, at: 2.5, id: "lightLeak" as const },
      { kind: "caption" as const, at: 3.0, wordRange: [5, 8] as [number, number], keyword: [8, 8] as [number, number] },
      { kind: "transition" as const, at: 3.92, id: "punchIn" as const },
      { kind: "section" as const, at: 5.0, wordRange: [10, 10] as [number, number], duration: 0.9 },
      { kind: "caption" as const, at: 6.0, wordRange: [9, 12] as [number, number] },
      { kind: "sfx" as const, at: 3.92, cue: "pop" as const },
    ],
  };
}

export function fixtureProject(aspect: "9:16" | "16:9" = "9:16"): StyleCompileProject {
  const portrait = aspect === "9:16";
  return {
    width: portrait ? 1080 : 1920, height: portrait ? 1920 : 1080, fps: 30,
    footage: [{ clipId: "clip-a", timelineStart: 0, duration: 5 }, { clipId: "clip-b", timelineStart: 5, duration: 5 }],
  };
}
