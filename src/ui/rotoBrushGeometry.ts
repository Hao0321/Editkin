export interface RotoBrushRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RotoBrushPoint {
  x: number;
  y: number;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Resolves the actual pixel box painted by `object-fit: contain` inside a viewport.
 * Invalid dimensions fail closed because accepting a point without known media geometry
 * would store a correction at the wrong source coordinate.
 */
export function containedMediaRect(viewport: RotoBrushRect, mediaWidth: number, mediaHeight: number): RotoBrushRect | undefined {
  if (![viewport.left, viewport.top].every(Number.isFinite)
    || !isPositiveFinite(viewport.width)
    || !isPositiveFinite(viewport.height)
    || !isPositiveFinite(mediaWidth)
    || !isPositiveFinite(mediaHeight)) return undefined;

  const scale = Math.min(viewport.width / mediaWidth, viewport.height / mediaHeight);
  const width = mediaWidth * scale;
  const height = mediaHeight * scale;
  return {
    left: viewport.left + (viewport.width - width) / 2,
    top: viewport.top + (viewport.height - height) / 2,
    width,
    height,
  };
}

/** Maps a client-space pointer into normalized source coordinates, or rejects letterbox/pillarbox input. */
export function normalizedContainedMediaPoint(
  viewport: RotoBrushRect,
  mediaWidth: number,
  mediaHeight: number,
  clientX: number,
  clientY: number,
): RotoBrushPoint | undefined {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return undefined;
  const content = containedMediaRect(viewport, mediaWidth, mediaHeight);
  if (!content) return undefined;
  const right = content.left + content.width;
  const bottom = content.top + content.height;
  if (clientX < content.left || clientX > right || clientY < content.top || clientY > bottom) return undefined;
  return {
    x: Math.max(0, Math.min(1, (clientX - content.left) / content.width)),
    y: Math.max(0, Math.min(1, (clientY - content.top) / content.height)),
  };
}
