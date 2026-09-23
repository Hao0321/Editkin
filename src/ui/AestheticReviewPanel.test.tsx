import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import postcss from "postcss";
import { resolveAestheticSystem } from "../application/editkinAesthetic";
import { AESTHETIC_BENCHMARKS, BENCHMARK_AXES, evaluateAestheticBenchmarks } from "../domain/aestheticBenchmarks";
import { scoreAestheticReview } from "../domain/aestheticReview";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { projectSchema } from "../domain/schema";
import type { AestheticArtifactBinding, AestheticBenchmarkReview } from "../domain/types";
import { AestheticReviewPanel, createAestheticReviewDraft, formatReviewTime, parseReviewTime, prepareAestheticReviewDraft, sameAestheticArtifact } from "./AestheticReviewPanel";
import { DirectorConsole } from "./DirectorConsole";
import { EDITOR_THEMES } from "./theme";

const artifact: AestheticArtifactBinding = { outputSha256: "a".repeat(64), fps: 30, durationFrames: 300 };
function completeBenchmark(): AestheticBenchmarkReview {
  return { schema: "editkin.aesthetic-benchmark-review/v1", artifact: { ...artifact }, axes: Object.fromEntries(BENCHMARK_AXES.map(axis => [axis, Object.fromEntries(AESTHETIC_BENCHMARKS[axis].map(item => [item.id, { rating: 4.5, evidence: [{ fromFrame: 90, toFrame: 120, observation: "Synthetic unit-test observation, not human approval" }] }]))])) };
}
const makeSystem = () => resolveAestheticSystem("gaming", "shorts");
const props = () => ({ system: makeSystem(), playhead: 3, timelineFps: 30, timelineDurationFrames: 300, onSeek: () => {}, onReviewChange: () => {} });

describe("progressive aesthetic review UI and owner-bound drafts", () => {
  it("uses eight general dimensions and the actual two eight-item rubrics, collapsed by default", () => {
    const html = renderToStaticMarkup(<AestheticReviewPanel {...props()} />);
    expect(html).toContain("一般品質"); expect(html).toContain("MrBeast · 資訊能量"); expect(html).toContain("影視颶風 · 電影工藝");
    expect(html.match(/<select\b/g)).toHaveLength(24);
    expect(html.match(/class="aesthetic-group"/g)).toHaveLength(3);
    expect(html).not.toMatch(/<details[^>]*\sopen(?:[\s=>])/);
    for (const axis of BENCHMARK_AXES) for (const item of AESTHETIC_BENCHMARKS[axis]) expect(html).toContain(`data-testid="aesthetic-criterion-${item.id}"`);
    expect(html).toContain("只能儲存草稿（REVIEW）");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="aesthetic-record-review"/);
    expect(html).not.toContain("完成十維評分"); expect(html).not.toMatch(/<input[^>]*(?:hash|sha256)/i);
  });

  it("does not self-bind a stored review or transfer an old output's evidence to a new one", () => {
    const system = makeSystem(); system.review.benchmarkReview = completeBenchmark();
    const noOwner = createAestheticReviewDraft(system, undefined, 30);
    expect(noOwner.artifact).toBeUndefined(); expect(noOwner.axes).toEqual({});
    const other = createAestheticReviewDraft(system, { ...artifact, outputSha256: "b".repeat(64) }, 30);
    expect(other.artifact?.outputSha256).toBe("b".repeat(64)); expect(other.axes).toEqual({});
    expect(system.review.benchmarkReview).toEqual(completeBenchmark());
    const trusted = createAestheticReviewDraft(system, artifact, 30);
    expect(trusted.artifact).toEqual(artifact); expect(trusted.artifact).not.toBe(artifact);
    expect(trusted.axes.mrbeast_information_energy?.promise_stakes.evidence[0].fromTime).toBe("00:03.000");
  });

  it("keeps legacy evidence readable without displaying stored PASSED as current acceptance", () => {
    const p = props(); p.system.review = scoreAestheticReview(p.system, Object.fromEntries(p.system.dimensions.map(d => [d.id, 5])), { complete: true, benchmarkReview: completeBenchmark(), currentArtifact: artifact });
    expect(p.system.review.status).toBe("PASSED");
    const html = renderToStaticMarkup(<AestheticReviewPanel {...p} />);
    expect(html).toContain("先前輸出的證據（唯讀）"); expect(html).toContain("Synthetic unit-test observation");
    expect(html).toContain("需要重新驗證輸出"); expect(html).not.toContain("PASSED");
    expect(renderToStaticMarkup(<AestheticReviewPanel {...p} currentArtifact={artifact} />)).toContain("PASSED");
  });

  it("does not silently promote an unbound timeline draft when an output first appears", () => {
    const system = makeSystem(); const saved = completeBenchmark(); delete saved.artifact; system.review.benchmarkReview = saved;
    expect(createAestheticReviewDraft(system, undefined, 30).axes.mrbeast_information_energy?.promise_stakes.rating).toBe(4.5);
    expect(createAestheticReviewDraft(system, artifact, 30).axes).toEqual({});
  });

  it.each([24, 25, 30, 60, 30000 / 1001])("round-trips actual frame positions at %s fps", fps => {
    for (const frame of [0, 1, 29, 90, 1777, 80001]) expect(parseReviewTime(formatReviewTime(frame, fps), fps)).toBe(frame);
    expect(parseReviewTime("1:02:03.400", fps)).toBe(Math.round(3723.4 * fps));
    expect(parseReviewTime("3.5", fps)).toBe(Math.round(3.5 * fps));
  });

  it.each(["", "-1", "hello", "0:60", "1:02:70", "Infinity", "0xFF", "1e3", "1::2"])("rejects invalid time input %s instead of dropping evidence", value => {
    expect(parseReviewTime(value, 30)).toBeUndefined();
    const system = makeSystem(); system.review.benchmarkReview = completeBenchmark();
    const draft = createAestheticReviewDraft(system, artifact, 30);
    draft.axes.mrbeast_information_energy!.promise_stakes.evidence[0].fromTime = value;
    expect(prepareAestheticReviewDraft(draft, 30, 300).errors.length).toBeGreaterThan(0);
  });

  it("rejects inverted/out-of-output ranges; blank reasons remain draft, never completed", () => {
    const system = makeSystem(); system.review.benchmarkReview = completeBenchmark();
    const draft = createAestheticReviewDraft(system, artifact, 30);
    draft.axes.mrbeast_information_energy!.promise_stakes.evidence[0].toTime = "00:03.000";
    expect(prepareAestheticReviewDraft(draft, 30, 300).errors).toHaveLength(1);
    draft.axes.mrbeast_information_energy!.promise_stakes.evidence[0].toTime = "00:10.001";
    // 10.001 rounds to the legal end boundary, so test a full extra frame.
    draft.axes.mrbeast_information_energy!.promise_stakes.evidence[0].toTime = "00:10.040";
    expect(prepareAestheticReviewDraft(draft, 30, 300).errors).toHaveLength(1);
    draft.axes.mrbeast_information_energy!.promise_stakes.evidence[0] = { fromTime: "00:03.000", toTime: "00:04.000", observation: "  " };
    const prepared = prepareAestheticReviewDraft(draft, 30, 300);
    expect(prepared.errors).toEqual([]); expect(evaluateAestheticBenchmarks(prepared.benchmarkReview, artifact).complete).toBe(false);
  });

  it("preserves multiple evidence notes and ratings through real commands, schema roundtrip and undo", () => {
    const project = createDemoProject(); project.aestheticSystem = makeSystem();
    project.aestheticSystem.review.benchmarkReview = completeBenchmark();
    const draft = createAestheticReviewDraft(project.aestheticSystem, artifact, 30);
    draft.axes.mrbeast_information_energy!.promise_stakes.evidence.push({ fromTime: "00:05.000", toTime: "00:06.000", observation: "Second actual-row value" });
    const prepared = prepareAestheticReviewDraft(draft, 30, 300);
    const review = scoreAestheticReview(project.aestheticSystem, draft.ratings, { benchmarkReview: prepared.benchmarkReview, currentArtifact: artifact });
    const history = dispatchCommand(createHistory(project), { type: "set_aesthetic_review", review });
    expect(history.past).toHaveLength(1);
    const restored = projectSchema.parse(JSON.parse(JSON.stringify(history.present)));
    expect(restored.aestheticSystem?.review.benchmarkReview?.axes.mrbeast_information_energy?.promise_stakes.evidence).toHaveLength(2);
    expect(restored.aestheticSystem?.review.status).toBe("REVIEW");
    expect(undo(history).present.aestheticSystem?.review.benchmarkReview).toEqual(completeBenchmark());
    expect(applyCommand(project, { type: "set_aesthetic_review", review }).captions).toEqual(project.captions);
  });

  it("compares all output identity fields and requires a valid external owner", () => {
    expect(sameAestheticArtifact(artifact, artifact)).toBe(true);
    expect(sameAestheticArtifact(artifact, { ...artifact, durationFrames: 301 })).toBe(false);
    expect(sameAestheticArtifact(artifact, { ...artifact, fps: 24 })).toBe(false);
    expect(sameAestheticArtifact(undefined, artifact)).toBe(false);
    expect(sameAestheticArtifact({ ...artifact, outputSha256: "" }, artifact)).toBe(false);
  });

  it("integrates aesthetic review as a dedicated DirectorConsole task instead of dumping the score grid", () => {
    const project = createDemoProject(); project.aestheticSystem = makeSystem();
    const html = renderToStaticMarkup(<DirectorConsole project={project} playhead={3} onSeek={() => {}} onCommand={() => {}} onClose={() => {}} />);
    expect(html).toContain("節奏總覽"); expect(html).toContain("時間碼註記"); expect(html).toContain("美感評分");
    expect(html).not.toContain('data-testid="aesthetic-review-panel"'); expect(html).not.toContain('class="aesthetic-grid"');
  });

  it.each(EDITOR_THEMES)("uses the same controls and markup for %s", theme => {
    const ui = <AestheticReviewPanel {...props()} />;
    expect(renderToStaticMarkup(<div data-theme={theme}>{ui}</div>)).toBe(`<div data-theme="${theme}">${renderToStaticMarkup(ui)}</div>`);
  });

  it("keeps source typography >=14px, controls >=44px and responsive min-content guards", () => {
    for (const filename of ["aestheticReviewPanel.css", "directorConsole.css"]) {
      const source = readFileSync(new URL(`./${filename}`, import.meta.url), "utf8");
      postcss.parse(source).walkDecls("font-size", declaration => expect(Number.parseFloat(declaration.value)).toBeGreaterThanOrEqual(14));
      expect(source).not.toMatch(/data-theme|minmax\(360px|minmax\(440px/);
      expect(source).toContain("min-width: 0"); expect(source).toContain("min-height: 44px");
      expect(source).toContain("max-width: 600px");
    }
    const css = readFileSync(new URL("./aestheticReviewPanel.css", import.meta.url), "utf8");
    expect(css).toContain("min-inline-size: 0"); expect(css).toContain("repeat(2,minmax(0,1fr))");
    // Structural protections, not a substitute for the actual iframe geometry/pointer test.
  });
});
