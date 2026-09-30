import * as z from "zod/v4";
import { resolveBundledFontFace } from "../typography/fontFaces";

const color = z.string().regex(/^#[\da-f]{6}$/i);
export const motionSceneStyleSchema = z.strictObject({
  palette: z.strictObject({ surface: color, text: color, accent: color, muted: color, separator: color }),
  typography: z.strictObject({ headingFamily: z.string().trim().min(1).max(80), bodyFamily: z.string().trim().min(1).max(80) }),
  animationSpeed: z.number().finite().min(.5).max(2).default(1),
});
export type MotionSceneStyle = z.infer<typeof motionSceneStyleSchema>;

export function validateMotionSceneStyle(raw: MotionSceneStyle): MotionSceneStyle {
  const style = motionSceneStyleSchema.parse(raw);
  for (const [role, family] of Object.entries(style.typography)) {
    if (!resolveBundledFontFace(family, role === "headingFamily" ? 700 : 400)) throw new Error(`FONT_REQUIRED：字型 ${family} 尚未核對實體字型，不會靜默替換`);
  }
  return style;
}
