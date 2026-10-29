import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { inspectCaptionDelivery } from "../domain/captionDelivery";
import { CaptionDelivery, createCaptionDeliveryReportMemo } from "./CaptionDelivery";

function projectWithCaptions(count: number) {
  const project = createEmptyProject("Caption memo");
  for (let index = 0; index < count; index++) project.captions.push({ id: `cap-${index}`, text: `第 ${index + 1} 句字幕`, start: index * 2, duration: 1.8 });
  return project;
}

describe("caption delivery report memo (performance: no O(captions) check per playhead tick)", () => {
  it("returns the identical report for the same captions array and fps without re-inspecting", () => {
    let calls = 0;
    const memo = createCaptionDeliveryReportMemo(project => { calls++; return inspectCaptionDelivery(project); });
    const project = projectWithCaptions(50);
    const first = memo(project);
    // A playhead tick re-renders with the same project snapshot, or a new project object sharing the captions array.
    expect(memo(project)).toBe(first);
    expect(memo({ ...project, name: "renamed" } as typeof project)).toBe(first);
    expect(calls).toBe(1);
    expect(first.report).toEqual(inspectCaptionDelivery(project));
  });

  it("re-inspects when a caption edit produces a new captions array, and when fps changes", () => {
    let calls = 0;
    const memo = createCaptionDeliveryReportMemo(project => { calls++; return inspectCaptionDelivery(project); });
    const project = projectWithCaptions(3);
    expect(memo(project).report?.counts.overlap).toBeUndefined();
    const overlapping = applyCommand(project, { type: "update_caption", captionId: "cap-0", patch: { duration: 2.5 } });
    expect(overlapping.captions).not.toBe(project.captions);
    expect(memo(overlapping).report?.counts.overlap).toBe(1);
    expect(memo({ ...overlapping, fps: 25 }).report).toEqual(inspectCaptionDelivery({ ...overlapping, fps: 25 }));
    expect(calls).toBe(3);
  });

  it("caches a failed check as an error until the captions change", () => {
    let calls = 0;
    const memo = createCaptionDeliveryReportMemo(project => { calls++; if (project.captions.length === 0) throw Error("boom"); return inspectCaptionDelivery(project); });
    const empty = createEmptyProject("Empty");
    expect(memo(empty)).toEqual({ reportError: "boom" });
    expect(memo(empty)).toEqual({ reportError: "boom" });
    expect(calls).toBe(1);
    expect(memo(projectWithCaptions(1)).report?.cueCount).toBe(1);
  });

  it("still renders the real check summary", () => {
    const html = renderToStaticMarkup(<CaptionDelivery project={projectWithCaptions(4)} onCommand={() => undefined} onSelect={() => undefined} />);
    expect(html).toContain('data-testid="caption-delivery"');
    expect(html).toContain("4 句");
  });
});
