import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AutoReframeButtonV1, type AutoReframeButtonPropsV1, type AutoReframeLabelsV1 } from "./AutoReframeButtonV1";
import { autoReframeWorkflowFixtureV1 } from "../application/__fixtures__/autoReframeWorkflowV1.fixture";
import { createProjectSession } from "../application/projectSession";
function props(locale: string): AutoReframeButtonPropsV1 {
  const project = autoReframeWorkflowFixtureV1(false), text = `${locale} <&>`, labels = Object.fromEntries(["title", "current", "newProject", "analyze", "apply", "create", "cancel", "idle", "preparing", "analyzing", "applying", "done", "candidate", "graph", "confirmedSubject", "saliencySubject", "help", "unknownCoverage", "crop", "locked", "camera", "dependency", "source", "stale", "subjectChanged", "unavailable", "failed"].map(k => [k, `${text} ${k}`])) as unknown as AutoReframeLabelsV1;
  labels.startPoint = text; labels.endPoint = text; labels.stage = { verify: text, matte: text, source: text, finalize: text }; labels.coverage = (p, v, u) => `${p} ${v} ${u}`; labels.preserved = (a, c, m) => `${a} ${c} ${m}`; labels.newProjectName = s => s;
  return { project, projectSession: createProjectSession(project), clipId: "selected", subject: { kind: "saliency" }, labels, locale, outputWidth: 90, outputHeight: 160 };
}
describe("standalone follow component has no implicit backend or apply capability", () => {
  it.each(["zh-TW", "en", "es", "ja", "ko"])("escapes required %s host copy and exposes an honest unavailable state", locale => {
    const p = props(locale), html = renderToStaticMarkup(<AutoReframeButtonV1 {...p} />);
    expect(html).toContain(`${locale} &lt;&amp;&gt; title`); expect(html).toContain(`${locale} &lt;&amp;&gt; unavailable`);
    expect(html).toContain('aria-live="polite"'); expect(html).not.toContain('data-testid="reframe-apply"'); expect(html).not.toContain('data-testid="reframe-path"');
    expect(html.match(/disabled=""/g)).toHaveLength(3); expect(p.project.tracks[0].clips[0].keyframes).toHaveLength(0);
  });
  it("only enables a new-document workflow when both backend and separate-document owner exist", () => {
    const p = props("en"); p.engineHostReady = true; p.onAnalyze = async () => { throw Error("not called by rendering"); }; p.onNewProject = () => ({ status: "created" });
    const html = renderToStaticMarkup(<AutoReframeButtonV1 {...p} />); expect(html.match(/disabled=""/g)).toHaveLength(1);
    expect(html).toContain('aria-pressed="true" data-testid="reframe-mode-new"'); expect(html).toContain('aria-busy="false"');
  });
  it("does not permit the current-document route to resize a landscape project", () => {
    const p = props("zh-TW"); p.engineHostReady = true; p.onAnalyze = async () => { throw Error("unused"); }; p.onCommand = () => ({ status: "applied" });
    const html = renderToStaticMarkup(<AutoReframeButtonV1 {...p} />); expect(html).toContain('disabled="" data-testid="reframe-mode-current"'); expect(html).not.toContain('data-testid="reframe-apply"');
  });
});
