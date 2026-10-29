import { describe, expect, it } from "vitest";
import { createEmptyProject } from "./editGraph";
import { exportCaptionDelivery } from "./captionDelivery";
import { prepareLongformSidecarBundleV1 } from "./longformSidecarBundleV1";
function fixture() {
  const project = createEmptyProject("Owned chapter clock", { id: "sidecar-owned", fps: 30 });
  project.captions = [
    { id: "cue-A", start: 2.1254, duration: 3.5, text: "Claude Code\n字幕", translation: { text: "Claude Code captions", language: "en" } },
    { id: "cue-B", start: 65.9996, duration: 5, text: "時間軸保留 😃", translation: { text: "Keep timeline 😃", language: "en" } },
  ];
  project.director.markers = [
    { id: "pacing", time: 0, title: "開場提醒", note: "not a chapter", kind: "beat", status: "open", createdAt: project.updatedAt },
    { id: "chapter-B", time: 67.0004, title: "第二章 😃", note: "", kind: "note", status: "open", createdAt: project.updatedAt },
    { id: "chapter-A", time: 1.1254, title: "第一章", note: "", kind: "note", status: "resolved", createdAt: project.updatedAt },
  ];
  return project;
}
describe("longform paired sidecar content", () => {
  it("keeps every legacy SRT byte in all three modes and only explicitly selected actual timeline markers", () => {
    const project = fixture(), original = structuredClone(project);
    for (const mode of ["original", "translation", "bilingual"] as const) {
      const result = prepareLongformSidecarBundleV1(project, ["chapter-B", "chapter-A"], mode);
      expect(result.files[0].text).toBe(exportCaptionDelivery(project, "srt", mode).text);
      expect(result.files[1].text).toBe("00:00:01.125 第一章\n00:01:07.000 第二章 😃\n");
      expect(result.chapters.map(chapter => chapter.sourceTimeSeconds)).toEqual([1.1254, 67.0004]);
      expect(result.files[1].utf8Bytes).toBe(new TextEncoder().encode(result.files[1].text).byteLength);
      expect(result.policy).toMatchObject({ clock: "project_timeline_seconds", platformEligibilityVerified: false });
      expect(result.files[1].text).not.toContain("開場提醒"); expect(result.projectModified).toBe(false);
    }
    expect(project).toEqual(original);
  });
  it("refuses empty, duplicate, unknown and globally ambiguous marker selection rather than dropping rows", () => {
    const project = fixture();
    for (const ids of [[], ["chapter-A", "chapter-A"], ["unknown"], [" chapter-A"], ["x\u0000"]])
      expect(() => prepareLongformSidecarBundleV1(project, ids, "original")).toThrow(/SIDECAR_/);
    project.director.markers.push({ ...project.director.markers[1] });
    expect(() => prepareLongformSidecarBundleV1(project, ["chapter-B"], "original")).toThrow("MARKER_ID");
  });
  it("preserves titles or refuses multiline/control/unpaired/oversized titles without silently trimming", () => {
    const project = fixture();
    for (const title of ["", " 第一章", "第一章 ", "章\n00:00 injected", "章\t節", "章\u0085節", "章\u2028節", "\ud800", "漢".repeat(171)]) {
      project.director.markers[2].title = title;
      expect(() => prepareLongformSidecarBundleV1(project, ["chapter-A"], "original")).toThrow("CHAPTER_TITLE");
    }
  });
  it("refuses out-of-timeline or unrepresentable/colliding chapter times without shifting or inserting zero", () => {
    const project = fixture();
    for (const time of [-1, NaN, Infinity, 70.9996, 71, 86400]) {
      project.director.markers[2].time = time;
      expect(() => prepareLongformSidecarBundleV1(project, ["chapter-A"], "original")).toThrow("CHAPTER_TIME");
    }
    project.director.markers[2].time = 1.0001; project.director.markers[1].time = 1.0002;
    expect(() => prepareLongformSidecarBundleV1(project, ["chapter-A", "chapter-B"], "original")).toThrow("PRECISION_COLLISION");
    project.director.markers[1].time = 1.0001;
    expect(() => prepareLongformSidecarBundleV1(project, ["chapter-A", "chapter-B"], "original")).toThrow("PRECISION_COLLISION");
  });
  it("keeps the legacy empty/overlap/markup/translation refusals instead of delivering a chapter-only pair", () => {
    const project = fixture();
    project.captions = [];
    expect(() => prepareLongformSidecarBundleV1(project, ["chapter-A"], "original")).toThrow();
    project.captions = fixture().captions; project.captions[1].start = 3;
    expect(() => prepareLongformSidecarBundleV1(project, ["chapter-A"], "original")).toThrow();
    project.captions = fixture().captions; project.captions[0].text = "<b>原文</b>";
    expect(() => prepareLongformSidecarBundleV1(project, ["chapter-A"], "original")).toThrow(/SRT/);
    project.captions = fixture().captions; project.captions[0].translation = undefined;
    expect(() => prepareLongformSidecarBundleV1(project, ["chapter-A"], "translation")).toThrow();
  });
  it("bounds marker count, selected chapters and actual UTF-8 chapter delivery bytes", () => {
    const project = fixture(), first = project.director.markers[2];
    expect(() => prepareLongformSidecarBundleV1(project, Array.from({ length: 201 }, (_, i) => `M${i}`), "original")).toThrow("SELECTION");
    project.director.markers = Array.from({ length: 10001 }, (_, i) => ({ ...first, id: `M${i}`, time: i / 300 }));
    expect(() => prepareLongformSidecarBundleV1(project, ["M0"], "original")).toThrow("MARKER_BUDGET");
    project.director.markers = Array.from({ length: 200 }, (_, i) => ({ ...first, id: `M${i}`, time: i / 3, title: "x".repeat(512) }));
    expect(() => prepareLongformSidecarBundleV1(project, project.director.markers.map(marker => marker.id), "original")).toThrow("OUTPUT_BUDGET");
  });
  it("formats hours and Unicode consistently while retaining the exact source clock in metadata", () => {
    const project = fixture(); project.captions[1].start = 3800;
    project.director.markers[2].time = 3723.1254; project.director.markers[2].title = "解説 🧪";
    const result = prepareLongformSidecarBundleV1(project, ["chapter-A"], "original");
    expect(result.files[1].text).toBe("01:02:03.125 解説 🧪\n");
    expect(result.chapters[0].sourceTimeSeconds).toBe(3723.1254);
  });
});
