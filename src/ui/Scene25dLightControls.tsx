import type { KeyframeEasing, Scene25dSettings } from "../domain/types";

interface Scene25dLightControlsProps {
  scene: Scene25dSettings;
  playhead: number;
  onChange: (settings: Scene25dSettings) => void;
}

function upsertAtPlayhead<T extends { id: string; time: number }>(items: T[], value: T, playhead: number): T[] {
  const existing = items.findIndex((candidate) => Math.abs(candidate.time - playhead) < .0005);
  return existing >= 0
    ? items.map((candidate, index) => index === existing ? { ...value, id: candidate.id } : candidate)
    : [...items, value].sort((left, right) => left.time - right.time);
}

export function Scene25dLightControls({ scene, playhead, onChange }: Scene25dLightControlsProps) {
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
      <label>環境光<input type="number" min="0" step="0.05" value={scene.ambientLight.intensity} onChange={(event) => onChange({ ...scene, ambientLight: { ...scene.ambientLight, intensity: Number(event.target.value) } })} /></label>
      <label>主光<input type="number" min="0" step="0.05" value={directional.intensity} onChange={(event) => onChange({ ...scene, directionalLight: { ...directional, intensity: Number(event.target.value) } })} /></label>
      {(["R", "G", "B"] as const).map((channel, index) => <label key={`light-color-${channel}`}>主光 {channel}<input type="number" min="0" step="0.05" value={directional.color[index]} onChange={(event) => onChange({ ...scene, directionalLight: { ...directional,
        color: directional.color.map((value, item) => item === index ? Number(event.target.value) : value) as [number, number, number] } })} /></label>)}
      {(["X", "Y", "Z"] as const).map((axis, index) => <label key={`light-direction-${axis}`}>光向 {axis}<input type="number" step="0.05" value={directional.direction[index]} onChange={(event) => onChange({ ...scene, directionalLight: { ...directional,
        direction: directional.direction.map((value, item) => item === index ? Number(event.target.value) : value) as [number, number, number] } })} /></label>)}
    </div>
    <div className="lens-keyframe-controls" data-testid="scene-25d-light-keyframes">
      <button type="button" className="mini-action" disabled={playhead <= 0 || scene.ambientLight.keyframes.length >= 16 || directional.keyframes.length >= 16} onClick={record}>◆ 在 {playhead.toFixed(2)}s 記錄燈光</button>
      {directional.keyframes.map((keyframe) => <div className="lens-keyframe-row" key={keyframe.id}>
        <span>{keyframe.time.toFixed(2)}s · 主光 {keyframe.intensity.toFixed(2)}</span>
        <select aria-label={`${keyframe.time.toFixed(2)} 秒燈光緩動`} value={keyframe.easing} onChange={(event) => updateEasing(keyframe.id, keyframe.time, event.target.value as KeyframeEasing)}>
          <option value="linear">線性</option><option value="hold">停格</option><option value="ease_in">慢進</option><option value="ease_out">慢出</option><option value="ease_in_out">平滑</option><option value="spring_soft">柔和彈性</option>
        </select>
        <button type="button" aria-label={`刪除 ${keyframe.time.toFixed(2)} 秒燈光關鍵幀`} onClick={() => remove(keyframe.id, keyframe.time)}>×</button>
      </div>)}
    </div>
  </>;
}
