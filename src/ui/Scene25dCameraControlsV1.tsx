import type { Scene25dSettings } from "../domain/types";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { NumberEditFieldV1 } from "./NumberEditFieldV1";

interface Props { scene: Scene25dSettings; editScope?: unknown; onChange: (settings: Scene25dSettings) => boolean | void }
/** Parameter edits use the original scene-command owner; camera sampling/rendering and presets are unchanged. */
export function renderScene25dCameraControlsV1({ scene, editScope, onChange }: Props) {
  const vector = (key: "position" | "target" | "up", axis: number, value: number) => {
    if (!Number.isFinite(value)) return;
    const tuple = scene.camera[key].map((current, index) => index === axis ? value : current) as [number, number, number];
    return onChange({ ...scene, camera: { ...scene.camera, [key]: tuple } });
  };
  const scalar = (key: "verticalFovDegrees" | "near" | "far", value: number) => {
    if (Number.isFinite(value)) return onChange({ ...scene, camera: { ...scene.camera, [key]: value } });
  };
  return <div className="transform-grid" role="group" aria-label={uiText("相機參數")} data-testid="scene-25d-camera-controls">
    {(["position", "target", "up"] as const).flatMap(key => (["X", "Y", "Z"] as const).map((axis, index) => {
      const label = uiText(key === "position" ? "相機位置 {axis}" : key === "target" ? "目標位置 {axis}" : "向上方向 {axis}", { axis });
      return <label key={`${key}-${axis}`}>{label}<NumberEditFieldV1 step="0.1" aria-label={label}
        data-testid={`camera-${key}-${axis}`} value={scene.camera[key][index]} scope={editScope ?? scene} onCommit={value => vector(key, index, value)} /></label>;
    }))}
    <label>{uiText("視角")}<NumberEditFieldV1 min="2" max="178" step="1" aria-label={uiText("視角")} data-testid="camera-fov"
      value={scene.camera.verticalFovDegrees} scope={editScope ?? scene} onCommit={value => scalar("verticalFovDegrees", value)} /></label>
    <label>{uiText("近裁切距離")}<NumberEditFieldV1 min="0" step="0.01" aria-label={uiText("近裁切距離")} data-testid="camera-near"
      value={scene.camera.near} scope={editScope ?? scene} onCommit={value => scalar("near", value)} /></label>
    <label>{uiText("遠裁切距離")}<NumberEditFieldV1 min="0" step="0.1" aria-label={uiText("遠裁切距離")} data-testid="camera-far"
      value={scene.camera.far} scope={editScope ?? scene} onCommit={value => scalar("far", value)} /></label>
  </div>;
}
export function Scene25dCameraControlsV1(props: Props) {
  useI18n();
  return renderScene25dCameraControlsV1(props);
}
