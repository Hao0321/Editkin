import { describe, expect, it } from "vitest";
import { activeVideoClip, migrateProject } from "../domain/editGraph";
import { createProjectSession } from "./projectSession";
import { beginEditorialDataGraphicsV1, requireEditorialDataClipV1 } from "./editorialDataGraphicsV1";
import { prepareChallengeProgressV1 } from "./challengeProgressV1";
import { annotationWorkflowFixtureV1 } from "./__fixtures__/annotationWorkflowV1.fixture";
import { admitAnnotationTargetV1, ANNOTATION_STYLE_PROPOSAL_V1 } from "./annotationDraftV1";

describe("picture availability agrees with the existing video selector", () => {
  it.each(["ordinary", "audio-solo", "video-solo", "mute-explicit-visible", "raw-muted"])("keeps %s visible for data and annotation authoring", async mode => {
    const p = annotationWorkflowFixtureV1();
    if (mode === "audio-solo") p.tracks[1].solo = true; if (mode === "video-solo") p.tracks[0].solo = true;
    if (mode.startsWith("mute") || mode === "raw-muted") p.tracks[0].muted = true;
    if (mode === "mute-explicit-visible") p.tracks[0].hidden = false;
    expect(activeVideoClip(p, 2)?.id).toBe("selected");
    const session = createProjectSession(p), context = beginEditorialDataGraphicsV1(session, 0);
    expect(requireEditorialDataClipV1(context, "selected").clip.id).toBe("selected");
    expect(admitAnnotationTargetV1(p, { clipId: "selected", frame: 60, range: { startFrame: 30, endFrame: 90 }, style: ANNOTATION_STYLE_PROPOSAL_V1,
      purpose: "Synthetic visibility", evidenceRefs: ["synthetic:visibility"] }).target.clipId).toBe("selected");
    const result = await prepareChallengeProgressV1(session, { schema: "editkin.challenge-progress/v1", expectedRevision: 0, idPrefix: "visible", clipId: "selected", presetId: "v3_progress_bar", total: "3", percentDecimals: 2,
      states: [{ startFrame: 30, endFrame: 90, completed: "1", label: "進度", evidenceRefs: ["synthetic:visibility"] }] });
    expect(result.hooks[0].text).toBe("33.33%"); expect(session.getSnapshot().history.past).toHaveLength(0);
  });
  it.each(["explicit-hidden", "migrated-legacy-hidden", "locked"])("still refuses %s without changing mute/solo or migration behavior", mode => {
    let p = annotationWorkflowFixtureV1();
    if (mode === "explicit-hidden") p.tracks[0].hidden = true;
    if (mode === "migrated-legacy-hidden") { p.tracks[0].muted = true; delete p.tracks[0].hidden; p = migrateProject(JSON.parse(JSON.stringify(p))); }
    if (mode === "locked") p.tracks[0].locked = true;
    if (mode !== "locked") expect(activeVideoClip(p, 2)).toBeUndefined();
    expect(() => requireEditorialDataClipV1(beginEditorialDataGraphicsV1(createProjectSession(p), 0), "selected")).toThrow();
  });
});
