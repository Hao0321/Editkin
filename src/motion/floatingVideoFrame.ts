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

export function floatingVideoFramePreset(id: typeof FLOATING_VIDEO_FRAME_PRESETS[number]["id"]): Extract<FloatingVideoFrame, { schema: "editkin.floating-video-frame/v1" }> {
  const preset = FLOATING_VIDEO_FRAME_PRESETS.find(item => item.id === id)!;
  return { schema: "editkin.floating-video-frame/v1", style: preset.style,
    size: preset.size, yawDegrees: preset.yawDegrees, pitchDegrees: preset.pitchDegrees,
    ...(preset.id === "portrait_orbit" ? { aspect: preset.aspect, orbit: { ...preset.orbit } } : {}) };
}

/** Explicit new authoring; saved v1 objects and the legacy factory are never upgraded. */
export function floatingVideoFramePresetV2(id: typeof FLOATING_VIDEO_FRAME_PRESETS[number]["id"]): Extract<FloatingVideoFrame, { schema: "editkin.floating-video-frame/v2" }> {
  const legacy = floatingVideoFramePreset(id);
  return { ...legacy, schema: "editkin.floating-video-frame/v2", aspect: id === "portrait_orbit" ? "portrait" : "source",
    mediaFit: "contain", motion: { entranceFrames: 6, exitFrames: 6, travelY: .012 } };
}

export interface FloatingFrameSourceDisplay {
  /** Upright physical display dimensions, or { width: measured upright DAR, height: 1 }. */
  width: number;
  height: number;
}

export interface FloatingFrameLayoutContext extends FloatingFrameSourceDisplay {
  fps: number;
  durationFrames: number;
  localFrame: number;
}

export interface FloatingFrameRenderContext extends FloatingFrameSourceDisplay {
  durationFrames: number;
}

export interface FloatingFrameLayout {
  geometry: FloatingFrameGeometry;
  mediaFit: "cover" | "contain";
  /** Project pixels relative to the inner plane (outer origin + border); no canvas-relative percentages. */
  sourceFit: { left: number; top: number; width: number; height: number; cropped: boolean };
  /** Ideal upright-DAR content inside sourceFit. Export's even raster rounding is bounded to2px/axis. */
  sourceContentRect: { left: number; top: number; width: number; height: number };
  opacity: number;
  visible: boolean;
}

const DEFAULT_FLOATING_FRAME_MOTION = Object.freeze({ entranceFrames: 6, exitFrames: 6, travelY: .012 });

/** No implicit overlap/renormalization: a short clip must explicitly author shorter phases. */
export function assertFloatingFramePhase(value: FloatingVideoFrame, durationFrames: number): void {
  assertFloatingVideoFrame(value);
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 1) throw new Error("浮空影片框需要有效整數總影格數");
  if (value.schema === "editkin.floating-video-frame/v2") {
    const motion = value.motion ?? DEFAULT_FLOATING_FRAME_MOTION;
    if (motion.entranceFrames + motion.exitFrames > durationFrames - 1) throw new Error("浮空影片框進出影格階段重疊，請明示縮短階段");
  }
}

export function assertFloatingVideoFrame(value: FloatingVideoFrame): void {
  const allowed = new Set(["schema", "style", "size", "yawDegrees", "pitchDegrees", "aspect", "centerX", "centerY", "orbit",
    ...(value.schema === "editkin.floating-video-frame/v2" ? ["mediaFit", "motion"] : [])]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error("浮空影片框不接受未知版本欄位");
  if (!["editkin.floating-video-frame/v1", "editkin.floating-video-frame/v2"].includes(value.schema) || !["prism", "graphite", "matte"].includes(value.style)
    || ![value.size, value.yawDegrees, value.pitchDegrees].every(Number.isFinite)
    || value.size < .3 || value.size > .82
    || Math.abs(value.yawDegrees) > 35 || Math.abs(value.pitchDegrees) > 25
    || (value.schema === "editkin.floating-video-frame/v1" && value.aspect !== undefined && !["canvas", "portrait"].includes(value.aspect))
    || ![value.centerX ?? .5, value.centerY ?? .5].every(n => Number.isFinite(n) && n >= .2 && n <= .8)
    || (value.orbit !== undefined && (!Number.isFinite(value.orbit.amplitudeDegrees)
      || !Number.isFinite(value.orbit.periodSeconds) || value.orbit.amplitudeDegrees < 0
      || value.orbit.amplitudeDegrees > 30 || value.orbit.periodSeconds < 2 || value.orbit.periodSeconds > 8))) {
    throw new Error("浮空影片框參數超出安全透視範圍");
  }
  if (value.schema === "editkin.floating-video-frame/v2") {
    const motion = value.motion ?? DEFAULT_FLOATING_FRAME_MOTION;
    if (!["source", "canvas", "portrait"].includes(value.aspect)
      || value.mediaFit !== "contain"
      || (value.centerX !== undefined && typeof value.centerX !== "number")
      || (value.centerY !== undefined && typeof value.centerY !== "number")
      || (value.motion !== undefined && (typeof value.motion !== "object" || value.motion === null))
      || !Number.isInteger(motion.entranceFrames) || motion.entranceFrames < 0 || motion.entranceFrames > 24
      || !Number.isInteger(motion.exitFrames) || motion.exitFrames < 0 || motion.exitFrames > 24
      || !Number.isFinite(motion.travelY) || motion.travelY < 0 || motion.travelY > .03
      || Object.keys(motion).some(key => !["entranceFrames", "exitFrames", "travelY"].includes(key))
      || (value.orbit && Object.keys(value.orbit).some(key => !["amplitudeDegrees", "periodSeconds"].includes(key)))) {
      throw new Error("浮空影片框 v2 需要 source/canvas/portrait、contain 與有界整數進出階段");
    }
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
export function floatingFrameGeometry(value: FloatingVideoFrame, width: number, height: number, localTime = 0,
  source?: FloatingFrameSourceDisplay): FloatingFrameGeometry {
  assertFloatingVideoFrame(value);
  if (![width, height].every(n => Number.isInteger(n) && n >= 64)) throw new Error("浮空影片框畫布尺寸不合法");
  if (value.schema === "editkin.floating-video-frame/v2" && !Number.isFinite(localTime)) throw new Error("浮空影片框 v2 時間必須有限");
  const border = value.style === "matte" ? 2 : even(Math.min(width, height) * .014);
  const legacyHeight = even(height * value.size);
  const plane = value.schema === "editkin.floating-video-frame/v2"
    ? containRaster(width * value.size, height * value.size, value.aspect === "source" ? sourceAspect(source) : value.aspect === "portrait" ? 9 / 16 : width / height)
    : { width: value.aspect === "portrait" ? even(legacyHeight * 9 / 16) : even(width * value.size), height: legacyHeight };
  if (value.schema === "editkin.floating-video-frame/v2") sourceAspect(source);
  const innerWidth = plane.width, innerHeight = plane.height;
  const outerWidth = innerWidth + 2 * border;
  const outerHeight = innerHeight + 2 * border;
  if (outerWidth + 2 * border >= width || outerHeight + 2 * border >= height) throw new Error("浮空影片框超出畫布");
  const orbitPhase = 2 * Math.PI * localTime / (value.orbit?.periodSeconds ?? 1);
  if (value.schema === "editkin.floating-video-frame/v2" && !Number.isFinite(orbitPhase)) throw new Error("浮空影片框 v2 來源影格時間超出有限透視範圍");
  const yaw = (value.yawDegrees + (value.orbit?.amplitudeDegrees ?? 0) * Math.sin(orbitPhase)) * Math.PI / 180;
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
    left: value.schema === "editkin.floating-video-frame/v2" ? Math.round((width - outerWidth) / 2) : (width - outerWidth) / 2,
    top: value.schema === "editkin.floating-video-frame/v2" ? Math.round((height - outerHeight) / 2) : (height - outerHeight) / 2,
    quad: [project(-1, -1), project(1, -1), project(-1, 1), project(1, 1)],
  };
}

function sourceAspect(source?: FloatingFrameSourceDisplay): number {
  if (!source || ![source.width, source.height].every(n => Number.isFinite(n) && n > 0)
    || !Number.isFinite(source.width / source.height) || source.width / source.height <= 0) {
    throw new Error("浮空影片框 v2 缺少有效直立顯示來源尺寸");
  }
  return source.width / source.height;
}

/** Rounds inward by less than two pixels per axis; all source corners remain in the raster. */
function containRaster(maxWidth: number, maxHeight: number, aspect: number): { width: number; height: number } {
  const idealWidth = Math.min(maxWidth, maxHeight * aspect), idealHeight = Math.min(maxHeight, maxWidth / aspect);
  if (![idealWidth, idealHeight].every(n => Number.isFinite(n) && n >= 2)) throw new Error("浮空影片框來源比例無法形成至少 2px 完整平面");
  return { width: Math.floor(idealWidth / 2) * 2, height: Math.floor(idealHeight / 2) * 2 };
}

/** Opaque region eroded by >=4 sigma of the existing alpha blur, never a new authored knob. */
function sourceSafeInset(value: FloatingVideoFrame, width: number, height: number, border: number): number {
  const radius = floatingFrameCornerRadiusPixels(value, width, height, border), blurBuffer = Math.ceil(4 * 1.2);
  // At a source-rectangle corner x=y, the mask's circle distance is sqrt(2)*(radius-x).
  // Full mask alpha is reached at radius-.5; leave the blur buffer inside that boundary.
  const cornerInset = radius - Math.max(0, radius - .5 - blurBuffer) / Math.SQRT2;
  return Math.max(0, Math.ceil(Math.max(floatingFrameFeatherPixels(width, height) + blurBuffer, cornerInset) - border));
}

const smoothstep = (progress: number) => {
  const p = Math.max(0, Math.min(1, progress));
  return p * p * (3 - 2 * p);
};

function phaseAt(value: Extract<FloatingVideoFrame, { schema: "editkin.floating-video-frame/v2" }>, localFrame: number, durationFrames: number) {
  const motion = value.motion ?? DEFAULT_FLOATING_FRAME_MOTION;
  const entrance = motion.entranceFrames === 0 ? 1 : smoothstep(localFrame / motion.entranceFrames);
  const exit = motion.exitFrames === 0 ? 1 : smoothstep((durationFrames - 1 - localFrame) / motion.exitFrames);
  return { opacity: localFrame < 0 || localFrame >= durationFrames ? 0 : entrance * exit,
    travelY: motion.travelY * (exit - entrance) };
}

/** Exact extrema of the admitted homography, not an arbitrary frame subsample.
 * For each source corner, A=3.4-y*sin(p), B=x*cos(p), denominator=A+B*sin(yaw).
 * dX/dyaw is proportional to -(A*sin(yaw)+B); only asin(-B/A) can be interior
 * in the admitted [-65,65] degree yaw interval. Y is monotone in sin(yaw),
 * so endpoint poses suffice. Positive depth makes each fixed-pose rectangle
 * map to a convex quad, whose corners bound all source points. Phase travel
 * is added conservatively independent of yaw, including invisible endpoints.
 */
function assertSourceProjectionEnvelope(value: Extract<FloatingVideoFrame, { schema: "editkin.floating-video-frame/v2" }>, geometry: FloatingFrameGeometry,
  fit: FloatingFrameLayout["sourceFit"], width: number, height: number): void {
  const amplitude = value.orbit?.amplitudeDegrees ?? 0;
  const minYaw = (value.yawDegrees - amplitude) * Math.PI / 180, maxYaw = (value.yawDegrees + amplitude) * Math.PI / 180;
  const pitch = value.pitchDegrees * Math.PI / 180, sinPitch = Math.sin(pitch), cosPitch = Math.cos(pitch);
  const motion = value.motion ?? DEFAULT_FLOATING_FRAME_MOTION;
  const minTravel = motion.exitFrames === 0 ? 0 : -motion.travelY, maxTravel = motion.entranceFrames === 0 ? 0 : motion.travelY;
  const left = geometry.left + geometry.border + fit.left, top = geometry.top + geometry.border + fit.top;
  for (const [px, py] of [[left, top], [left + fit.width, top], [left, top + fit.height], [left + fit.width, top + fit.height]]) {
    const x = 2 * px / width - 1, y = 2 * py / height - 1;
    const a = 3.4 - y * sinPitch, b = x * cosPitch;
    const candidates = [minYaw, maxYaw], stationarySin = -b / a;
    if (Number.isFinite(stationarySin) && Math.abs(stationarySin) <= 1) {
      const stationary = Math.asin(stationarySin);
      if (stationary > minYaw && stationary < maxYaw) candidates.push(stationary);
    }
    for (const yaw of candidates) {
      const denominator = a + b * Math.sin(yaw);
      if (!Number.isFinite(denominator) || denominator <= 0) throw new Error("浮空影片框 v2 來源投影深度不可逆");
      const projectedX = (value.centerX ?? .5) + 3.4 * x * Math.cos(yaw) / (2 * denominator);
      const projectedY = (value.centerY ?? .5) + 3.4 * (y * cosPitch + x * Math.sin(yaw) * sinPitch) / (2 * denominator);
      if (![projectedX, projectedY].every(Number.isFinite) || projectedX < 0 || projectedX > 1
        || projectedY + minTravel < 0 || projectedY + maxTravel > 1) {
        throw new Error("浮空影片框 v2 完整來源投影超出畫布，請縮小或調整中心／旋轉／進出位移");
      }
    }
  }
}

/** Pure random-access preview receipt; no CSS transition, wall clock or prior frame state. */
export function floatingFrameLayout(value: FloatingVideoFrame, width: number, height: number, context: FloatingFrameLayoutContext): FloatingFrameLayout {
  if (!Number.isSafeInteger(context.localFrame) || !Number.isFinite(context.fps) || context.fps <= 0
    || !Number.isFinite(context.localFrame / context.fps)) throw new Error("浮空影片框需要有限影格率與整數本地影格");
  assertFloatingFramePhase(value, context.durationFrames);
  if (value.schema === "editkin.floating-video-frame/v2"
    && (!Number.isFinite(context.durationFrames / context.fps)
      || !Number.isFinite(2 * Math.PI * context.durationFrames / context.fps / (value.orbit?.periodSeconds ?? 1))
      || !Number.isFinite(context.fps * (value.orbit?.periodSeconds ?? 1)))) {
    throw new Error("浮空影片框 v2 衍生影格時間超出有限範圍");
  }
  const aspect = sourceAspect(context);
  const geometry = floatingFrameGeometry(value, width, height, context.localFrame / context.fps, context);
  const { innerWidth, innerHeight } = geometry;
  if (value.schema === "editkin.floating-video-frame/v1") {
    const fitWidth = Math.max(innerWidth, innerHeight * aspect), fitHeight = Math.max(innerHeight, innerWidth / aspect);
    const visible = context.localFrame >= 0 && context.localFrame < context.durationFrames;
    const sourceContentRect = { left: (innerWidth - fitWidth) / 2, top: (innerHeight - fitHeight) / 2, width: fitWidth, height: fitHeight };
    return { geometry, mediaFit: "cover", sourceFit: { ...sourceContentRect, cropped: fitWidth > innerWidth || fitHeight > innerHeight },
      sourceContentRect, opacity: visible ? 1 : 0, visible };
  }
  const inset = sourceSafeInset(value, width, height, geometry.border);
  const fitWidth = innerWidth - 2 * inset, fitHeight = innerHeight - 2 * inset;
  // Admit both the fit viewport and a >=2px complete source; no hidden minimum clamp.
  containRaster(fitWidth, fitHeight, aspect);
  const sourceFit = { left: inset, top: inset, width: fitWidth, height: fitHeight, cropped: false };
  const contentWidth = Math.min(fitWidth, fitHeight * aspect), contentHeight = Math.min(fitHeight, fitWidth / aspect);
  const sourceContentRect = { left: inset + (fitWidth - contentWidth) / 2, top: inset + (fitHeight - contentHeight) / 2,
    width: contentWidth, height: contentHeight };
  if (value.style === "matte" && (geometry.left < floatingFrameMatteShadow(width, height).margin
    || geometry.top < floatingFrameMatteShadow(width, height).margin)) throw new Error("浮空影片框 v2 畫布不足以容納完整柔邊陰影");
  assertSourceProjectionEnvelope(value, geometry, sourceFit, width, height);
  const phase = phaseAt(value, context.localFrame, context.durationFrames);
  const translate = ([x, y]: readonly [number, number]): readonly [number, number] => [x, y + phase.travelY];
  const quad: FloatingFrameGeometry["quad"] = [translate(geometry.quad[0]), translate(geometry.quad[1]), translate(geometry.quad[2]), translate(geometry.quad[3])];
  return { geometry: { ...geometry, quad },
    mediaFit: "contain", sourceFit, sourceContentRect, opacity: phase.opacity, visible: phase.opacity > 0 };
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

export function floatingFrameFfmpegFilters(value: FloatingVideoFrame, width: number, height: number, fps: number,
  context?: FloatingFrameRenderContext): string[] {
  // Caller must first convert to project fps, reset local PTS, and provide this
  // clip's real frame count. `N`/`on` then describe the same integer local clock.
  if (value.schema === "editkin.floating-video-frame/v2" && !context) throw new Error("浮空影片框 v2 輸出缺少來源尺寸與總影格數");
  const layout = value.schema === "editkin.floating-video-frame/v2"
    ? floatingFrameLayout(value, width, height, { ...context!, fps, localFrame: 0 }) : undefined;
  const geometry = value.schema === "editkin.floating-video-frame/v2"
    ? floatingFrameGeometry(value, width, height, 0, context) : floatingFrameGeometry(value, width, height);
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
  const corners = value.schema === "editkin.floating-video-frame/v2"
    ? frameCornerExpressionsV2(value, width, height, fps, context!.durationFrames)
    : value.orbit ? orbitCornerExpressions(value, width, height, fps) : quad.flatMap(([qx, qy]) => [String(Math.round(qx * width)), String(Math.round(qy * height))]);
  const sourceFilters = layout ? [
    // Both consumers contain true upright DAR in this shared viewport. The
    // even raster may differ from ideal sourceContentRect by <=2px/axis.
    `scale=${layout.sourceFit.width}:${layout.sourceFit.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos:reset_sar=1`,
    `pad=${layout.sourceFit.width}:${layout.sourceFit.height}:(ow-iw)/2:(oh-ih)/2:color=${panel}`,
    `pad=${innerWidth}:${innerHeight}:${layout.sourceFit.left}:${layout.sourceFit.top}:color=${panel}`,
  ] : [
    `scale=${innerWidth}:${innerHeight}:force_original_aspect_ratio=increase:flags=lanczos:reset_sar=1`,
    `crop=${innerWidth}:${innerHeight}:(iw-ow)/2:(ih-oh)/2`,
  ];
  return [
    // Fit the original display aspect (including SAR) before cropping. The
    // panel and perspective thereafter operate in square project pixels.
    ...sourceFilters,
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
    ...(value.schema === "editkin.floating-video-frame/v2" ? [
      // Fade the complete assembled panel AND shadow, never just the video.
      `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${framePhaseExpressionsV2(value, context!.durationFrames, "N").opacity}':interpolation=nearest`,
    ] : []),
    `perspective=x0='${corners[0]}':y0='${corners[1]}':x1='${corners[2]}':y1='${corners[3]}':x2='${corners[4]}':y2='${corners[5]}':x3='${corners[6]}':y3='${corners[7]}':sense=destination:interpolation=cubic:eval=${value.schema === "editkin.floating-video-frame/v2" || value.orbit ? "frame" : "init"}`,
    "format=rgba",
  ];
}

function framePhaseExpressionsV2(value: Extract<FloatingVideoFrame, { schema: "editkin.floating-video-frame/v2" }>, durationFrames: number, frame: "N" | "on") {
  const motion = value.motion ?? DEFAULT_FLOATING_FRAME_MOTION;
  const smooth = (numerator: string, denominator: number) => {
    if (denominator === 0) return "1";
    const p = `clip((${numerator})/${denominator},0,1)`;
    return `(${p}*${p}*(3-2*${p}))`;
  };
  const entrance = smooth(frame, motion.entranceFrames), exit = smooth(`${durationFrames - 1}-${frame}`, motion.exitFrames);
  return { opacity: `if(between(${frame},0,${durationFrames - 1}),${entrance}*${exit},0)`,
    travelY: `(${motion.travelY}*(${exit}-${entrance}))` };
}

function frameCornerExpressionsV2(value: Extract<FloatingVideoFrame, { schema: "editkin.floating-video-frame/v2" }>, width: number, height: number, fps: number, durationFrames: number): string[] {
  const yaw = `(${value.yawDegrees * Math.PI / 180}+${(value.orbit?.amplitudeDegrees ?? 0) * Math.PI / 180}*sin(2*PI*on/${fps * (value.orbit?.periodSeconds ?? 1)}))`;
  const pitch = value.pitchDegrees * Math.PI / 180;
  const travelY = framePhaseExpressionsV2(value, durationFrames, "on").travelY;
  return ([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).flatMap(([x, y]) => {
    const xr = `${x}*cos(${yaw})`, zr = `(${-x}*sin(${yaw}))`;
    const yr = `(${y * Math.cos(pitch)}-${zr}*${Math.sin(pitch)})`;
    const depth = `(${y * Math.sin(pitch)}+${zr}*${Math.cos(pitch)})`;
    const perspective = `(3.4/(3.4-${depth}))`;
    return [`${width}*((${xr}*${perspective}+1)/2+${(value.centerX ?? .5) - .5})`,
      `${height}*((${yr}*${perspective}+1)/2+${(value.centerY ?? .5) - .5}+${travelY})`];
  });
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
