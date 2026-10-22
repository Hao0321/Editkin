import { COLOR_SCOPE_LIMITS_V1, SKIN_HUE_RAY_V1, type ColorScopeBinsV1 } from "../color/colorScopesV1";

export type ColorScopeKindV1 = "waveform" | "parade" | "vectorscope" | "histogram";
const COLORS = ["#ff526f", "#56f2a7", "#55a6ff", "#d6deed"];
export function drawColorScopeV1(canvas: HTMLCanvasElement, kind: ColorScopeKindV1, bins?: ColorScopeBinsV1) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Scope canvas unavailable");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#070b12"; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#354359"; ctx.lineWidth = 1; ctx.fillStyle = "#9dadc3"; ctx.font = "10px sans-serif";
  const left = 25, top = 8, bottom = h - 18, pw = w - left - 8, ph = bottom - top;
  if (kind === "vectorscope") {
    const size = Math.min(w, h), cx = w / 2, cy = h / 2, radius = size * .46;
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy); ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius); ctx.stroke();
    if (bins) {
      const n = COLOR_SCOPE_LIMITS_V1.vectorSize;
      for (let i = 0; i < bins.vectors.length; i++) if (bins.vectors[i]) {
        ctx.fillStyle = `rgba(126,232,203,${Math.min(1, .15 + Math.log1p(bins.vectors[i]) * .15)})`;
        ctx.fillRect(cx + ((i % n) / (n - 1) - .5) * size, cy + (Math.floor(i / n) / (n - 1) - .5) * size, 1.5, 1.5);
      }
    }
    ctx.strokeStyle = "#e6b67a"; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(SKIN_HUE_RAY_V1) * radius, cy - Math.sin(SKIN_HUE_RAY_V1) * radius); ctx.stroke(); ctx.setLineDash([]);
    return;
  }
  for (const value of [0, .5, 1]) {
    const y = bottom - value * ph;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(w - 8, y); ctx.stroke();
    if (kind !== "histogram") ctx.fillText(String(value * 100), 1, y + 3);
  }
  if (kind === "histogram") {
    ctx.fillText("0", left, h - 3); ctx.fillText("255", w - 26, h - 3);
    if (!bins) return;
    // Shared vertical scale across R/G/B/Y' so relative counts remain comparable.
    const max = Math.max(1, ...bins.histogram);
    for (let channel = 0; channel < 4; channel++) {
      ctx.strokeStyle = COLORS[channel]; ctx.beginPath();
      for (let level = 0; level < 256; level++) {
        const x = left + level / 255 * pw, y = bottom - bins.histogram[channel * 256 + level] / max * ph;
        if (level === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    return;
  }
  const { columns, levels } = COLOR_SCOPE_LIMITS_V1;
  if (kind === "parade") for (let channel = 0; channel < 3; channel++) {
    ctx.fillStyle = COLORS[channel]; ctx.fillText(["R", "G", "B"][channel], left + (channel + .5) * pw / 3, h - 3);
  }
  if (!bins) return;
  for (let channel = 0; channel < 3; channel++) {
    ctx.fillStyle = COLORS[channel];
    for (let level = 0; level < levels; level++) for (let column = 0; column < columns; column++) {
      const count = bins.waveform[(channel * levels + level) * columns + column];
      if (!count) continue;
      ctx.globalAlpha = Math.min(1, .18 + Math.log1p(count) * .15);
      const nx = kind === "parade" ? (channel + column / columns) / 3 : column / columns;
      ctx.fillRect(left + nx * pw, bottom - level / (levels - 1) * ph, Math.max(1, pw / columns / (kind === "parade" ? 3 : 1)), 1.5);
    }
  }
  ctx.globalAlpha = 1;
}
