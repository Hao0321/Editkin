import type { ClipLayout } from "../domain/types";

export const DEFAULT_PIP_LAYOUT: ClipLayout = {
  crop: { x: 0, y: 0, width: 1, height: 1 },
  viewport: { x: 0.66, y: 0.06, width: 0.29, height: 0.29 },
};
