import type { MotionGraphic, MotionVectorV2 } from "../domain/types";
import MotionGeometryControls from "./MotionGeometryControls";

type Patch = Partial<Omit<MotionGraphic, "schema" | "id">>;

/** Controls address the actual fill role used by SVG and formal rendering. */
export default function MotionVectorControls({ graphic, onUpdate }: { graphic: MotionGraphic; onUpdate: (patch: Patch) => void }) {
  const vector = graphic.vectorV2;
  if (!vector) return null;
  if (vector.kind === "spring_panel") return <MotionGeometryControls graphic={graphic} onUpdate={onUpdate} />;
  // Authored element shapes are recompiled from their element, not hand-edited point by point.
  if (vector.kind === "shape") return <div className="motion-vector-controls"><label>原創元素形狀（由元素重新編譯）</label></div>;
  const number = (label: string, value: number, min: number, max: number, step: number, change: (value: number) => MotionVectorV2) =>
    <label key={label}>{label}<input aria-label={`${graphic.name}${label}`} type="number" min={min} max={max} step={step} value={value}
      onChange={event => { if (event.target.value && event.target.validity.valid) onUpdate({ vectorV2: change(Number(event.target.value)) }); }} /></label>;
  const color = (label: string, key: "backgroundColor" | "accentColor" | "textColor") =>
    <label key={label}>{label}<input aria-label={`${graphic.name}${label}`} type="color" value={graphic[key].slice(0, 7)}
      onChange={event => onUpdate({ [key]: event.target.value + graphic[key].slice(7) })} /></label>;
  return <div className="motion-vector-controls">
    {number("圖形高度", vector.heightPixels, 1, 1920, .1, value => ({ ...vector, heightPixels: value }))}
    {vector.kind === "connection_field" ? <>
      {number("點群排列種子", vector.seed, 0, 0xffffffff, 1, value => ({ ...vector, seed: value }))}
      {number("點群數量", vector.points, 8, 64, 1, value => ({ ...vector, points: value }))}
      {number("點半徑", vector.dotRadiusPixels, 1, 12, .5, value => ({ ...vector, dotRadiusPixels: value }))}
      {number("連線粗細", vector.lineWidthPixels, .5, 8, .5, value => ({ ...vector, lineWidthPixels: value }))}
      {([0, 1, 2] as const).map(index => <label key={index}>能力 {index + 1} 色彩<input type="color" aria-label={`${graphic.name}能力色 ${index + 1}`}
        value={(vector.groupColors?.[index] ?? (index === 0 ? graphic.accentColor : graphic.textColor)).slice(0, 7)}
        onChange={event => {
          const colors: [string, string, string] = [...(vector.groupColors ?? [graphic.accentColor.slice(0, 7), graphic.textColor.slice(0, 7), graphic.textColor.slice(0, 7)])];
          colors[index] = event.target.value; onUpdate({ vectorV2: { ...vector, groupColors: colors } });
        }} /></label>)}
      {color("中心色", "accentColor")}{color("連線色", "backgroundColor")}
    </> : vector.kind === "line_grid" ? <>
      {number("網格間距", vector.spacingPixels, 8, 512, 1, value => ({ ...vector, spacingPixels: value }))}
      {number("網格線寬", vector.lineWidthPixels, .25, 8, .25, value => ({ ...vector, lineWidthPixels: value }))}
      {number("主線間隔", vector.majorEvery, 2, 12, 1, value => ({ ...vector, majorEvery: value }))}
      {color("細網格色", "accentColor")}{color("主網格色", "textColor")}
    </> : <>
      {number("揭露影格", vector.revealFrames, 1, 600, 1, value => ({ ...vector, revealFrames: value }))}
      {vector.kind === "step_progress" && number("目前章節", vector.activeStep, 0, vector.steps, 1, value => ({ ...vector, activeStep: value }))}
      {color("圖形顏色", vector.kind === "panel" || vector.kind === "ellipse" ? "backgroundColor" : "accentColor")}
    </>}
  </div>;
}
