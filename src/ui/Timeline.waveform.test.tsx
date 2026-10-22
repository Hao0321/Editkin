import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { interfacePreferences } from "./i18n/interfacePreferences";
import { Timeline } from "./Timeline";
import type { TimelineProps } from "./timelineContract";
import { clipWaveformWindow } from "./timelineWaveform";

// Static server render of the production Timeline (no browser layout): each clip shows only its own part of the
// whole-file waveform, picture clips with sound show it too, and a hidden picture track says so.
const noop = () => {};
function props(project = createDemoProject(), runtimeUrls: Record<string, string> = {}): TimelineProps {
  return { project, duration: 12, playhead: 0, runtimeUrls, onSeek: noop, onSelect: noop, onSelectCaption: noop,
    onMoveClip: noop, onMoveCaption: noop, onTrimClip: noop, onTrimCaption: noop, onAddCaption: noop, onAddTrack: noop,
    onRenameTrack: noop, onToggleTrackLock: noop, onDeleteTrack: noop, onMakePictureInPicture: noop, onPrecompose: noop, onToggleMute: noop, onSplit: noop, onDelete: noop };
}
afterEach(() => interfacePreferences.setMode("simple"));

describe("a clip's own part of the waveform", () => {
  it("places the whole-file image so only sourceStart … sourceStart + duration shows", () => {
    expect(clipWaveformWindow({ sourceStart: 0, duration: 12 }, { duration: 12 })).toEqual({ sourceStart: 0, sourceEnd: 12, leftPercent: -0, widthPercent: 100 });
    // The second half of a 12 s file in a 3 s clip: the image is 4 clips wide and starts 2 clip-widths to the left.
    expect(clipWaveformWindow({ sourceStart: 6, duration: 3 }, { duration: 12 })).toEqual({ sourceStart: 6, sourceEnd: 9, leftPercent: -200, widthPercent: 400 });
    expect(clipWaveformWindow({ sourceStart: 0, duration: 3 }, { duration: 0 })).toBeUndefined();
  });

  it("a split picture clip with sound shows its own window of the waveform along its lower edge; no waveform without one", () => {
    const project = applyCommand(createDemoProject(), { type: "split_clip", clipId: "clip-demo", at: 4, newClipId: "clip-tail" });
    const plain = renderToStaticMarkup(<Timeline {...props(project)} />);
    expect(plain).not.toContain("clip-waveform");
    const html = renderToStaticMarkup(<Timeline {...props(project, { "asset-demo:waveform": "blob:wave", "asset-demo:thumbnail": "blob:thumb" })} />);
    expect(html).toContain('data-testid="timeline-clip-waveform-clip-demo" data-source-start="0" data-source-end="4"');
    expect(html).toContain('data-testid="timeline-clip-waveform-clip-tail" data-source-start="4" data-source-end="12"');
    expect(html).toMatch(/class="clip-waveform under-picture"[^>]*data-testid="timeline-clip-waveform-clip-tail"[^>]*><img src="blob:wave" alt="" draggable="false" style="left:-50%;width:150%"/);
    expect(html).toMatch(/data-testid="timeline-clip-waveform-clip-demo"[^>]*><img src="blob:wave" alt="" draggable="false" style="left:0%;width:300%"/);
    // The picture strip is still there; the waveform no longer replaces it.
    expect(html).toContain('src="blob:thumb"');
  });

  it("a sound clip's waveform fills the clip, cropped to its trimmed part", () => {
    let project = applyCommand(createDemoProject(), { type: "import_asset", asset: { id: "voice", name: "voice.wav", kind: "audio", uri: "D:/owned/voice.wav", duration: 20 } });
    project = applyCommand(project, { type: "add_clip", clip: { id: "vo", assetId: "voice", trackId: "audio-main", timelineStart: 1, sourceStart: 5, duration: 5,
      volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } });
    const html = renderToStaticMarkup(<Timeline {...props(project, { "voice:waveform": "blob:voice" })} />);
    expect(html).toMatch(/class="clip-waveform"[^>]*data-testid="timeline-clip-waveform-vo" data-source-start="5" data-source-end="10"><img src="blob:voice" alt="" draggable="false" style="left:-100%;width:400%"/);
  });
});

describe("track picture and sound state in the track header", () => {
  it("a hidden picture track says so, dims its lane and keeps mute as a sound-only switch", () => {
    interfacePreferences.setMode("advanced");
    const project = applyCommand(applyCommand(createDemoProject(), { type: "toggle_track_hidden", trackId: "video-main" }), { type: "toggle_track_mute", trackId: "audio-main" });
    const html = renderToStaticMarkup(<Timeline {...props(project)} />);
    expect(html).toContain('<span class="track-hidden">畫面已隱藏</span>');
    expect(html).toMatch(/class="track-lane video is-hidden"[^>]*data-track-hidden="true"/);
    expect(html).toMatch(/class="track-lane audio is-muted"/);
    expect(html).toContain('aria-label="主畫面 靜音" aria-pressed="false" title="靜音：只關聲音，畫面照常"');
    expect(html).toContain('aria-label="聲音 靜音" aria-pressed="true" title="靜音"');
  });
  it("the 切開 button is ready without a selection when a clip is under the playhead", () => {
    const at = (playhead: number, selectedClipId?: string) => renderToStaticMarkup(<Timeline {...props()} playhead={playhead} selectedClipId={selectedClipId} />)
      .match(/<button[^>]*data-testid="split-button"[^>]*>/)![0];
    expect(at(3)).not.toContain("disabled");
    expect(at(0)).toContain("disabled");
    expect(at(0, "clip-demo")).not.toContain("disabled");
  });
});
