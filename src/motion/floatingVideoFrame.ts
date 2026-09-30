import type { FloatingVideoFrame } from "../domain/types";

export const FLOATING_VIDEO_FRAME_PRESETS = [
  { id: "matte", name: "自然柔邊浮窗", style: "matte", size: .58, yawDegrees: -12, pitchDegrees: 3 },
  { id: "prism", name: "稜鏡浮空框", style: "prism", size: .68, yawDegrees: -23, pitchDegrees: 10 },
  { id: "graphite", name: "石墨電影框", style: "graphite", size: .72, yawDegrees: 18, pitchDegrees: -8 },
  { id: "portrait_orbit", name: "直式環繞旋轉", style: "prism", size: .72, yawDegrees: 0, pitchDegrees: 3,
    aspect: "portrait", orbit: { amplitudeDegrees: 24, periodSeconds: 3.6 } },
] as const;

/** Browser preview and FFmpeg export fill the plane without distorting footage. */
export const FLOATING_FRAME_MEDIA_FIT = "cover" as const;
export const FLOATING_FRAME_BACKDROP_CSS = "radial-gradient(circle at 50% 42%, #20272C 0%, #11171C 42%, #080B0F 100%)";

/** Inward alpha fade at the outer silhouette; keep the footage itself sharp. */
export function floatingFrameFeatherPixels(width: number, height: number): number {
  return Math.max(2, Math.round(Math.min(width, height) * .016));
}

/** Share the matte silhouette radius between the real preview and export. */
export function floatingFrameCornerRadiusPixels(value: FloatingVideoFrame, width: number, height: number, border: number): number {
  return value.style === "matte" ? Math.max(8, Math.round(Math.min(width, height) * .028)) : Math.max(5, Math.round(border * 1.6));
}

/** Keep the cast shadow outside the feather mask in both preview and export. */
export function floatingFrameMatteShadow(width: number, height: number) {
  const unit = Math.min(width, height) / 1080;
  return { x: 4 * unit, y: 16 * unit, blur: 28 * unit, opacity: .13, margin: Math.max(4, Math.ceil(80 * unit)) };
}

function matteShadowFilters(outerWidth: number, outerHeight: number, radius: number, width: number, height: number): string[] {
  const shadow = floatingFrameMatteShadow(width, height);
  const centerX = shadow.margin + outerWidth / 2 + shadow.x;
  const centerY = shadow.margin + outerHeight / 2 + shadow.y;
  const dx = `abs(X-${centerX})-${outerWidth / 2 - radius}`;
  const dy = `abs(Y-${centerY})-${outerHeight / 2 - radius}`;
  const distance = `hypot(max(${dx},0),max(${dy},0))+min(max(${dx},${dy}),0)-${radius}`;
  const cast = `(${shadow.opacity}*exp(-pow(max(${distance},0),2)/${2 * shadow.blur ** 2}))`;
  const original = "(alpha(X,Y)/255)";
  const alpha = `(${original}+${cast}*(1-${original}))`;
  return [
    `pad=${outerWidth + 2 * shadow.margin}:${outerHeight + 2 * shadow.margin}:${shadow.margin}:${shadow.margin}:color=0x080B0D@0`,
    // Work on the small panel, never a full-canvas blur. Composite in straight
    // RGBA so feathered footage retains its color and the outside gains alpha.
    `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*${alpha}':interpolation=nearest`,
  ];
}

export function floatingFrameBackdropLavfi(width: number, height: number, fps: string, duration: string): string {
  return `gradients=s=${width}x${height}:r=${fps}:d=${duration}:c0=0x20272C:c1=0x080B0F:x0=${Math.round(width / 2)}:y0=${Math.round(height * .42)}:x1=${Math.round(width / 2)}:y1=${Math.round(height * 1.18)}:type=radial`;
}

export function floatingVideoFramePreset(id: typeof FLOATING_VIDEO_FRAME_PRESETS[number]["id"]): FloatingVideoFrame {
  const preset = FLOATING_VIDEO_FRAME_PRESETS.find(item => item.id === id)!;
  return { schema: "editkin.floating-video-frame/v1", style: preset.style,
    size: preset.size, yawDegrees: preset.yawDegrees, pitchDegrees: preset.pitchDegrees,
    ...(preset.id === "portrait_orbit" ? { aspect: preset.aspect, orbit: { ...preset.orbit } } : {}) };
}

export function assertFloatingVideoFrame(value: FloatingVideoFrame): void {
  if (value.schema !== "editkin.floating-video-frame/v1" || !["prism", "graphite", "matte"].includes(value.style)
    || ![value.size, value.yawDegrees, value.pitchDegrees].every(Number.isFinite)
    || value.size < .3 || value.size > .82
    || Math.abs(value.yawDegrees) > 35 || Math.abs(value.pitchDegrees) > 25
    || (value.aspect !== undefined && !["canvas", "portrait"].includes(value.aspect))
    || ![value.centerX ?? .5, value.centerY ?? .5].every(n => Number.isFinite(n) && n >= .2 && n <= .8)
    || (value.orbit !== undefined && (!Number.isFinite(value.orbit.amplitudeDegrees)
      || !Number.isFinite(value.orbit.periodSeconds) || value.orbit.amplitudeDegrees < 0
      || value.orbit.amplitudeDegrees > 30 || value.orbit.periodSeconds < 2 || value.orbit.periodSeconds > 8))) {
    throw new Error("浮空影片框參數超出安全透視範圍");
  }
}

export interface FloatingFrameGeometry {
  innerWidth: number;
  innerHeight: number;
  border: number;
  outerWidth: number;
  outerHeight: number;
  left: number;
  top: number;
  /** TL, TR, BL, BR in normalized project coordinates. */
  quad: readonly [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]];
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** One bounded perspective plane is shared by FFmpeg output and browser preview. */
export function floatingFrameGeometry(value: FloatingVideoFrame, width: number, height: number, localTime = 0): FloatingFrameGeometry {
  assertFloatingVideoFrame(value);
  if (![width, height].every(n => Number.isInteger(n) && n >= 64)) throw new Error("浮空影片框畫布尺寸不合法");
  const border = value.style === "matte" ? 2 : even(Math.min(width, height) * .014);
  const innerHeight = even(height * value.size);
  const innerWidth = value.aspect === "portrait" ? even(innerHeight * 9 / 16) : even(width * value.size);
  const outerWidth = innerWidth + 2 * border;
  const outerHeight = innerHeight + 2 * border;
  if (outerWidth + 2 * border >= width || outerHeight + 2 * border >= height) throw new Error("浮空影片框超出畫布");
  const yaw = (value.yawDegrees + (value.orbit?.amplitudeDegrees ?? 0)
    * Math.sin(2 * Math.PI * localTime / (value.orbit?.periodSeconds ?? 1))) * Math.PI / 180;
  const pitch = value.pitchDegrees * Math.PI / 180;
  const project = (x: number, y: number): readonly [number, number] => {
    const xr = x * Math.cos(yaw);
    const zr = -x * Math.sin(yaw);
    const yr = y * Math.cos(pitch) - zr * Math.sin(pitch);
    const depth = y * Math.sin(pitch) + zr * Math.cos(pitch);
    const perspective = 3.4 / (3.4 - depth);
    return [(xr * perspective + 1) / 2 + (value.centerX ?? .5) - .5,
      (yr * perspective + 1) / 2 + (value.centerY ?? .5) - .5];
  };
  return {
    innerWidth, innerHeight, border, outerWidth, outerHeight,
    left: (width - outerWidth) / 2, top: (height - outerHeight) / 2,
    quad: [project(-1, -1), project(1, -1), project(-1, 1), project(1, 1)],
  };
}

/** Projective matrix in CSS column-major order; input and output use the actual preview size. */
export function floatingFrameCssMatrix(quad: FloatingFrameGeometry["quad"], width: number, height: number): string {
  const source = [[0, 0], [1, 0], [0, 1], [1, 1]];
  const rows: number[][] = [];
  for (let i = 0; i < 4; i += 1) {
    const [x, y] = source[i];
    const [u, v] = quad[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 8; row += 1) if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    if (Math.abs(rows[pivot][col]) < 1e-10) throw new Error("浮空影片框透視矩陣不可逆");
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const divisor = rows[col][col];
    for (let j = col; j <= 8; j += 1) rows[col][j] /= divisor;
    for (let row = 0; row < 8; row += 1) {
      if (row === col) continue;
      const factor = rows[row][col];
      for (let j = col; j <= 8; j += 1) rows[row][j] -= factor * rows[col][j];
    }
  }
  const [a, b, c, d, e, f, g, h] = rows.map(row => row[8]);
  return `matrix3d(${[a, d * height / width, 0, g / width, b * width / height, e, 0, h / height, 0, 0, 1, 0, c * width, f * height, 0, 1].map(n => Number(n.toFixed(12))).join(",")})`;
}

export function floatingFrameFfmpegFilters(value: FloatingVideoFrame, width: number, height: number, fps: number): string[] {
  const geometry = floatingFrameGeometry(value, width, height);
  const { innerWidth, innerHeight, outerWidth, outerHeight, border, left, top, quad } = geometry;
  const prism = value.style === "prism";
  const matte = value.style === "matte";
  const panel = matte ? "0x121516" : prism ? "0x101D32" : "0x16181D";
  const accent = matte ? "0x303536" : prism ? "0x96CCD3" : "0xD4C3A5";
  const edge = matte ? "0x23282A" : prism ? "0x456C78" : "0x66645E";
  const x = Math.round(left);
  const y = Math.round(top);
  const shadow = Math.max(matte ? 16 : 6, Math.round(border * 2));
  const shadowColor = matte ? "0x080B0D" : prism ? "0x173849" : "0x47443E";
  const cornerRadius = floatingFrameCornerRadiusPixels(value, width, height, border);
  const cornerDistance = `hypot(max(max(${cornerRadius}-X,0),X-(W-${cornerRadius + 1})),max(max(${cornerRadius}-Y,0),Y-(H-${cornerRadius + 1})))`;
  const feather = floatingFrameFeatherPixels(width, height);
  const edgeDistance = "min(min(X,W-1-X),min(Y,H-1-Y))";
  const corners = value.orbit ? orbitCornerExpressions(value, width, height, fps) : quad.flatMap(([qx, qy]) => [String(Math.round(qx * width)), String(Math.round(qy * height))]);
  return [
    `scale=${innerWidth}:${innerHeight}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${innerWidth}:${innerHeight}:(iw-ow)/2:(ih-oh)/2`,
    `pad=${outerWidth}:${outerHeight}:${border}:${border}:color=${panel}`,
    `drawbox=x=0:y=0:w=${outerWidth}:h=${Math.max(2, border / 3 | 0)}:color=${accent}:t=fill`,
    `drawbox=x=${outerWidth - Math.max(2, border / 3 | 0)}:y=0:w=${Math.max(2, border / 3 | 0)}:h=${outerHeight}:color=${edge}:t=fill`,
    // Feather the small panel before padding it to the full project canvas.
    // The final perspective keeps its soft alpha while avoiding a full-canvas
    // Gaussian pass for every floating video frame.
    `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(${cornerRadius + .5}-${cornerDistance},0,1)*clip(${edgeDistance}/${feather},0,1)':interpolation=nearest`,
    "gblur=sigma=1.2:steps=2:planes=8",
    ...(matte ? [
      ...matteShadowFilters(outerWidth, outerHeight, cornerRadius, width, height),
      `pad=${width}:${height}:${x - floatingFrameMatteShadow(width, height).margin}:${y - floatingFrameMatteShadow(width, height).margin}:color=black@0`,
    ] : [
    `pad=${width}:${height}:${x}:${y}:color=black@0`,
    `drawbox=x=${x + outerWidth}:y=${y + 3}:w=2:h=${outerHeight}:color=${shadowColor}@0.34:t=fill`,
    `drawbox=x=${x + outerWidth + 2}:y=${y + 4}:w=3:h=${outerHeight}:color=${shadowColor}@0.17:t=fill`,
    `drawbox=x=${x + outerWidth + 5}:y=${y + 5}:w=${Math.max(2, shadow - 5)}:h=${outerHeight}:color=${shadowColor}@0.07:t=fill`,
    `drawbox=x=${x + 3}:y=${y + outerHeight}:w=${outerWidth}:h=2:color=${shadowColor}@0.34:t=fill`,
    `drawbox=x=${x + 4}:y=${y + outerHeight + 2}:w=${outerWidth}:h=3:color=${shadowColor}@0.17:t=fill`,
    `drawbox=x=${x + 5}:y=${y + outerHeight + 5}:w=${outerWidth}:h=${Math.max(2, shadow - 5)}:color=${shadowColor}@0.07:t=fill`,
    ]),
    `perspective=x0='${corners[0]}':y0='${corners[1]}':x1='${corners[2]}':y1='${corners[3]}':x2='${corners[4]}':y2='${corners[5]}':x3='${corners[6]}':y3='${corners[7]}':sense=destination:interpolation=cubic:eval=${value.orbit ? "frame" : "init"}`,
    "format=rgba",
  ];
}

/** The perspective filter exposes `on` (output frame index), matching preview localTime * fps. */
function orbitCornerExpressions(value: FloatingVideoFrame, width: number, height: number, fps: number): string[] {
  if (!value.orbit || !Number.isFinite(fps) || fps <= 0) throw new Error("浮空框環繞旋轉需要有效影格率");
  const fixed = (n: number) => Number(n.toFixed(9)).toString();
  const yaw = `(${fixed(value.yawDegrees * Math.PI / 180)}+${fixed(value.orbit.amplitudeDegrees * Math.PI / 180)}*sin(2*PI*on/${fixed(fps * value.orbit.periodSeconds)}))`;
  const pitch = value.pitchDegrees * Math.PI / 180;
  return ([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).flatMap(([x, y]) => {
    const xr = `${x}*cos(${yaw})`;
    const zr = `(${x === 1 ? "-" : ""}sin(${yaw}))`;
    const yr = `(${fixed(y * Math.cos(pitch))}-${zr}*${fixed(Math.sin(pitch))})`;
    const depth = `(${fixed(y * Math.sin(pitch))}+${zr}*${fixed(Math.cos(pitch))})`;
    const perspective = `(3.4/(3.4-${depth}))`;
    return [`${width}*((${xr}*${perspective}+1)/2+${fixed((value.centerX ?? .5) - .5)})`,
      `${height}*((${yr}*${perspective}+1)/2+${fixed((value.centerY ?? .5) - .5)})`];
  });
}
