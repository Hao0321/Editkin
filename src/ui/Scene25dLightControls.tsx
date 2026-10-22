import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import type { KeyframeEasing, Scene25dSettings } from "../domain/types";
import { NumberEditFieldV1 } from "./NumberEditFieldV1";

interface Scene25dLightControlsProps {
  scene: Scene25dSettings;
  playhead: number;
  editScope?: unknown;
  onChange: (settings: Scene25dSettings) => boolean | void;
}

function upsertAtPlayhead<T extends { id: string; time: number }>(items: T[], value: T, playhead: number): T[] {
  const existing = items.findIndex((candidate) => Math.abs(candidate.time - playhead) < .0005);
  return existing >= 0
    ? items.map((candidate, index) => index === existing ? { ...value, id: candidate.id } : candidate)
    : [...items, value].sort((left, right) => left.time - right.time);
}

export function renderScene25dLightControlsV1({ scene, playhead, editScope, onChange }: Scene25dLightControlsProps) {
  const directional = scene.directionalLight;
  const record = () => {
    const stamp = Math.round(playhead * 1000);
    const ambientKeyframe = { id: `ambient-${stamp}`, time: playhead, intensity: scene.ambientLight.intensity, easing: "ease_in_out" as const };
    const directionalKeyframe = { id: `directional-${stamp}`, time: playhead, color: [...directional.color] as [number, number, number],
      intensity: directional.intensity, direction: [...directional.direction] as [number, number, number], easing: "ease_in_out" as const };
    onChange({ ...scene,
      ambientLight: { ...scene.ambientLight, keyframes: upsertAtPlayhead(scene.ambientLight.keyframes, ambientKeyframe, playhead) },
      directionalLight: { ...directional, keyframes: upsertAtPlayhead(directional.keyframes, directionalKeyframe, playhead) },
    });
  };
  const updateEasing = (id: string, time: number, easing: KeyframeEasing) => onChange({ ...scene,
    ambientLight: { ...scene.ambientLight, keyframes: scene.ambientLight.keyframes.map((candidate) => Math.abs(candidate.time - time) < .0005 ? { ...candidate, easing } : candidate) },
    directionalLight: { ...directional, keyframes: directional.keyframes.map((candidate) => candidate.id === id ? { ...candidate, easing } : candidate) },
  });
  const remove = (id: string, time: number) => onChange({ ...scene,
    ambientLight: { ...scene.ambientLight, keyframes: scene.ambientLight.keyframes.filter((candidate) => Math.abs(candidate.time - time) >= .0005) },
    directionalLight: { ...directional, keyframes: directional.keyframes.filter((candidate) => candidate.id !== id) },
  });
  return <>
    <div className="transform-grid" data-testid="scene-25d-light-controls">
      <label>{uiText("環境光")}<NumberEditFieldV1 min="0" step="0.05" value={scene.ambientLight.intensity} scope={editScope ?? scene} onCommit={value => onChange({ ...scene, ambientLight: { ...scene.ambientLight, intensity: value } })} /></label>
      <label>{uiText("主光")}<NumberEditFieldV1 min="0" step="0.05" value={directional.intensity} scope={editScope ?? scene} onCommit={value => onChange({ ...scene, directionalLight: { ...directional, intensity: value } })} /></label>
      {(["R", "G", "B"] as const).map((channel, index) => <label key={`light-color-${channel}`}>{uiText("主光")}{channel}<NumberEditFieldV1 min="0" step="0.05" value={directional.color[index]} scope={editScope ?? scene} onCommit={value => onChange({ ...scene, directionalLight: { ...directional,
        color: directional.color.map((old, item) => item === index ? value : old) as [number, number, number] } })} /></label>)}
      {(["X", "Y", "Z"] as const).map((axis, index) => <label key={`light-direction-${axis}`}>{uiText("光向")}{axis}<NumberEditFieldV1 step="0.05" value={directional.direction[index]} scope={editScope ?? scene} onCommit={value => onChange({ ...scene, directionalLight: { ...directional,
        direction: directional.direction.map((old, item) => item === index ? value : old) as [number, number, number] } })} /></label>)}
    </div>
    <div className="lens-keyframe-controls" data-testid="scene-25d-light-keyframes">
      <button type="button" className="mini-action" disabled={playhead <= 0 || scene.ambientLight.keyframes.length >= 16 || directional.keyframes.length >= 16} onClick={record}>{uiText("◆ 在")}{playhead.toFixed(2)}{uiText("s 記錄燈光")}</button>
      {directional.keyframes.map((keyframe) => <div className="lens-keyframe-row" key={keyframe.id}>
        <span>{keyframe.time.toFixed(2)}{uiText("s · 主光")}{keyframe.intensity.toFixed(2)}</span>
        <select aria-label={uiText("{value0} 秒燈光緩動", { value0: keyframe.time.toFixed(2) })} value={keyframe.easing} onChange={(event) => updateEasing(keyframe.id, keyframe.time, event.target.value as KeyframeEasing)}>
          <option value="linear">{uiText("線性")}</option><option value="hold">{uiText("停格")}</option><option value="ease_in">{uiText("慢進")}</option><option value="ease_out">{uiText("慢出")}</option><option value="ease_in_out">{uiText("平滑")}</option><option value="spring_soft">{uiText("柔和彈性")}</option>
        </select>
        <button type="button" aria-label={uiText("刪除 {value0} 秒燈光關鍵幀", { value0: keyframe.time.toFixed(2) })} onClick={() => remove(keyframe.id, keyframe.time)}>×</button>
      </div>)}
    </div>
  </>;
}
export function Scene25dLightControls(props: Scene25dLightControlsProps) {
  useI18n();
  return renderScene25dLightControlsV1(props);
}
