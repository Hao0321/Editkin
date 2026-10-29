import type { Scene25dSettings, TimelineClip, Transform3D } from "../domain/types";
import { DEFAULT_TRANSFORM_3D } from "../domain/types";
import type { Transform3dAxisIntentV1 } from "../application/clipAppearanceEditsV1";
import { NumberEditFieldV1 } from "./NumberEditFieldV1";
import { translateUi as t } from "./i18n/interfacePreferences";

/** Numeric drafts only; the caller retains canonical scene/clip command ownership. */
export function Scene25dPlaneControlsV1({ clip, editScope, onChange }: {
  clip: Pick<TimelineClip, "transform3d">; editScope?: unknown;
  onChange: (patch: Partial<Transform3D>, axis?: Transform3dAxisIntentV1) => boolean | void;
}) {
  const transform = clip.transform3d ?? DEFAULT_TRANSFORM_3D;
  return <div className="transform-grid">
    {(["position", "rotationDegrees", "scale"] as const).flatMap(property => (["X", "Y", "Z"] as const).map((axis, index) =>
      <label key={`${property}-${axis}`}>{t(property === "position" ? "位置 " : property === "rotationDegrees" ? "旋轉 " : "縮放 ")}{axis}
        <NumberEditFieldV1 step={property === "rotationDegrees" ? "1" : "0.05"} min={property === "scale" ? "0.01" : undefined}
          value={transform[property][index]} scope={editScope ?? clip} data-testid={`plane-${property}-${axis}`}
          onCommit={value => onChange({ [property]: transform[property].map((old, item) => item === index ? value : old) as [number, number, number] },
            { property, index: index as 0 | 1 | 2 })} />
      </label>))}
  </div>;
}

export function Scene25dLensControlsV1({ scene, editScope, onChange }: {
  scene: Scene25dSettings; editScope?: unknown; onChange: (settings: Scene25dSettings) => boolean | void;
}) {
  const change = (key: "focusDistance" | "aperture" | "maxBlurRadius", value: number) => onChange({ ...scene, depthOfField: { ...scene.depthOfField, [key]: value } });
  return <div className="transform-grid">
    <label className="inspector-toggle-row"><span>{t("啟用景深")}</span><input type="checkbox" checked={scene.depthOfField.enabled} onChange={event => onChange({ ...scene, depthOfField: { ...scene.depthOfField, enabled: event.target.checked } })} data-testid="scene-25d-depth-of-field" /></label>
    <label>{t("對焦距離")}<NumberEditFieldV1 min={scene.camera.near + .01} max={scene.camera.far - .01} step="0.05" value={scene.depthOfField.focusDistance} scope={editScope ?? scene} onCommit={value => change("focusDistance", value)} /></label>
    <label>{t("散景強度")}<NumberEditFieldV1 min="0.1" max="16" step="0.1" value={scene.depthOfField.aperture} scope={editScope ?? scene} onCommit={value => change("aperture", value)} /></label>
    <label>{t("最大半徑")}<NumberEditFieldV1 min="1" max="32" step="1" value={scene.depthOfField.maxBlurRadius} scope={editScope ?? scene} onCommit={value => change("maxBlurRadius", value)} /></label>
  </div>;
}
