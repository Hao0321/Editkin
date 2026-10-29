import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import type { MotionGraphic, MotionVectorV2 } from "../domain/types";
import { assertContinuityVectorFrameRange } from "../domain/motionContinuityContract";
import type { SpringGeometryTrack } from "../motion/springGeometryTrack";
import { NumberEditFieldV1, type NumberEditControlV1 } from "./NumberEditFieldV1";
import type { GraphicNumberGestureStartV1 } from "../application/graphicParameterGestureV1";

type Patch = Partial<Omit<MotionGraphic, "schema" | "id">>;
type ContinuityVector = Extract<MotionVectorV2, { kind: "spring_panel" }>;
type Property = "left" | "top" | "right" | "bottom" | "cornerRadius";
const properties: readonly Property[] = ["left", "top", "right", "bottom", "cornerRadius"];
const labels: Record<Property, string> = { left: "左緣", top: "上緣", right: "右緣", bottom: "下緣", cornerRadius: "圓角半徑" };

function targetAt(geometry: SpringGeometryTrack, property: Property, frame: number): number {
  const track = geometry[property]; let target = track.initialTarget;
  for (const event of track.events) { if (event.frame > frame) break; target = event.target; }
  return target;
}

/** Original native inputs edit the stored tracks; no CSS animation or baked path. */
export function renderMotionGeometryControlsV1({ graphic, editScope, onNumberGestureStart, onNumberDraftRejected, onUpdate }: { graphic: MotionGraphic; editScope?: unknown; onNumberGestureStart?: GraphicNumberGestureStartV1; onNumberDraftRejected?: () => void; onUpdate: (patch: Patch) => boolean | void }) {
  const vector = graphic.vectorV2;
  if (vector?.kind !== "spring_panel") return null;
  const geometry = vector.geometry, fps = geometry.left.fps, durationFrames = Math.round(graphic.duration * fps);
  const count = properties.reduce((total, property) => total + geometry[property].events.length, 0);

  const validate = (candidate: ContinuityVector, control?: NumberEditControlV1 | HTMLButtonElement) => {
    const input = control && "valueAsNumber" in control ? control : control?.closest("fieldset")?.querySelector("input");
    input?.setCustomValidity?.("");
    try {
      assertContinuityVectorFrameRange({ ...graphic, vectorV2: candidate }, fps);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "幾何參數不合法";
      input?.setCustomValidity?.(message); input?.reportValidity?.();
      return false;
    }
  };
  const commit = (candidate: ContinuityVector, control?: NumberEditControlV1 | HTMLButtonElement) =>
    validate(candidate, control) && onUpdate({ vectorV2: candidate }) !== false;
  const replaceTrack = (property: Property, track: SpringGeometryTrack[Property]): ContinuityVector =>
    ({ ...vector, geometry: { ...geometry, [property]: track } });
  const number = (label: string, value: number, min: number, max: number, step: number,
    change: (value: number) => ContinuityVector) => <label key={label}>{label}<NumberEditFieldV1 aria-label={`${graphic.name}${label}`}
      min={min} max={max} step={step} value={value} scope={editScope ?? graphic} onCommit={(next, control) => {
        control?.setCustomValidity?.("");
        return control?.validity?.valid === false ? false : commit(change(next), control);
      }} onGestureStart={onNumberGestureStart ? () => onNumberGestureStart(graphic.id, { parameterId: `geometry.${label}`, initial: value,
        patch: next => { const candidate = next === value ? vector : change(next); assertContinuityVectorFrameRange({ ...graphic, vectorV2: candidate }, fps); return { vectorV2: candidate }; } }) : undefined}
      onDraftSample={(_next, control) => { control.setCustomValidity?.(""); return control.validity?.valid !== false; }}
      onDraftConfirm={(next, control) => { control.setCustomValidity?.(""); return control.validity?.valid === false ? false : validate(next === value ? vector : change(next), control); }}
      onDraftRejected={onNumberDraftRejected} /></label>;
  const initial = (property: Property, position: number) => replaceTrack(property,
    { ...geometry[property], initialPosition: position, initialTarget: position, initialVelocity: 0 });
  const setEvent = (property: Property, index: number, key: "frame" | "target", value: number) => {
    const track = geometry[property], events = track.events.map((event, current) => current === index ? { ...event, [key]: value } : { ...event });
    if (key === "frame") events.sort((left, right) => left.frame - right.frame);
    return replaceTrack(property, { ...track, events });
  };
  return <div className="motion-vector-controls motion-geometry-controls">
    <p>{uiText("固定畫布 {width} × {height} px；前景；事件 {count} / 32。影格為此圖形的本地影格。", { width: geometry.envelope.width, height: geometry.envelope.height, count })}</p>
    <p>{uiText("同一輪廓沿各邊連續變形；目標改變時保留位置與速度。初始輪廓修改會把該邊起始速度設為 0。")}</p>
    {(["backgroundColor", "accentColor"] as const).map(key => <label key={key}>{key === "backgroundColor" ? uiText("填色") : uiText("邊框色")}
      <input type="color" aria-label={`${graphic.name}${key === "backgroundColor" ? uiText("填色") : uiText("邊框色")}`} value={graphic[key].slice(0, 7)}
        onChange={event => onUpdate({ [key]: event.currentTarget.value + graphic[key].slice(7) })} /></label>)}
    <fieldset><legend>{uiText("初始輪廓")}</legend>
      {number("初始左緣", geometry.left.initialPosition, 0, geometry.envelope.width, .1, value => initial("left", value))}
      {number("初始上緣", geometry.top.initialPosition, 0, geometry.envelope.height, .1, value => initial("top", value))}
      {number("初始寬度", geometry.right.initialPosition - geometry.left.initialPosition, .1, geometry.envelope.width, .1,
        value => initial("right", geometry.left.initialPosition + value))}
      {number("初始高度", geometry.bottom.initialPosition - geometry.top.initialPosition, .1, geometry.envelope.height, .1,
        value => initial("bottom", geometry.top.initialPosition + value))}
      {number("初始圓角半徑", geometry.cornerRadius.initialPosition, 0, Math.min(geometry.envelope.width, geometry.envelope.height) / 2, .1,
        value => initial("cornerRadius", value))}
    </fieldset>
    {properties.map(property => {
      const track = geometry[property], last = track.events.at(-1), nextFrame = last ? last.frame + 1 : 1;
      const maximum = property === "top" || property === "bottom" ? geometry.envelope.height : property === "cornerRadius"
        ? Math.min(geometry.envelope.width, geometry.envelope.height) / 2 : geometry.envelope.width;
      return <fieldset key={property}><legend>{labels[property]}{uiText("目標")}</legend>
        {number(`${labels[property]}剛性`, track.spring.stiffness, 1, 1000, 1, value => replaceTrack(property, { ...track, spring: { ...track.spring, stiffness: value } }))}
        {number(`${labels[property]}阻尼`, track.spring.damping, 0, 100, .1, value => replaceTrack(property, { ...track, spring: { ...track.spring, damping: value } }))}
        {number(`${labels[property]}質量`, track.spring.mass, .05, 10, .05, value => replaceTrack(property, { ...track, spring: { ...track.spring, mass: value } }))}
        {track.events.map((event, index) => <div key={`${property}:${index}`}>
          {number(`${labels[property]}事件 ${index + 1} 影格`, event.frame, 0, durationFrames - 1, 1, value => setEvent(property, index, "frame", value))}
          {number(`${labels[property]}事件 ${index + 1} 目標`, event.target, 0, maximum, .1, value => setEvent(property, index, "target", value))}
          {(property === "right" || property === "bottom") && number(`${property === "right" ? "寬度" : "高度"}事件 ${index + 1} 目標`,
            event.target - targetAt(geometry, property === "right" ? "left" : "top", event.frame), .1, maximum, .1,
            value => setEvent(property, index, "target", targetAt(geometry, property === "right" ? "left" : "top", event.frame) + value))}
          <button type="button" aria-label={uiText("{value0}移除{value1}事件 {value2}", { value0: graphic.name, value1: labels[property], value2: index + 1 })} onClick={event =>
            commit(replaceTrack(property, { ...track, events: track.events.filter((_, current) => current !== index) }), event.currentTarget)}>{uiText("移除事件")}</button>
        </div>)}
        {(property === "right" || property === "bottom") && <small>{uiText("寬度／高度目標以同影格已宣告的左緣／上緣目標為基準。")}</small>}
        <button type="button" aria-label={uiText("{value0}新增{value1}事件", { value0: graphic.name, value1: labels[property] })} disabled={count >= 32 || nextFrame >= durationFrames}
          onClick={event => commit(replaceTrack(property, { ...track, events: [...track.events,
            { frame: nextFrame, target: last?.target ?? track.initialTarget }] }), event.currentTarget)}>{uiText("新增事件")}</button>
      </fieldset>;
    })}
  </div>;
}
export default function MotionGeometryControls(props: Parameters<typeof renderMotionGeometryControlsV1>[0]) {
  useI18n();
  return renderMotionGeometryControlsV1(props);
}
