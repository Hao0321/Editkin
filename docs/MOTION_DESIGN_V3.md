# Motion Design v3

Motion Design v3 (`hao.motion-composition/v3`) is a template-driven motion graphics system. A graphic names one of 16 templates, carries its copy as one field per line, and lets the template decide layout, typography and choreography. Preview and export draw the same per-frame draw ops, so what the editor shows is what the render contains.

## Templates and copy fields

Copy lives in `text`, one field per line. Fields marked `?` may be omitted. The authoritative list is `MOTION_DESIGN_V3_FIELDS` in `src/domain/motionCompositionV3Contract.ts`.

| Template | Fields |
| --- | --- |
| `title_reveal` | title, kicker? |
| `title_impact` | line, line? |
| `title_editorial` | title, label? |
| `lower_third_bar`, `lower_third_glass` | name, role? |
| `chapter_number` | number, title, subtitle? |
| `stat_counter` | value, label? |
| `progress_bar` | label, percent |
| `compare_split` | leftLabel, leftValue, rightLabel, rightValue |
| `tag_pill` | label |
| `location_pin` | place, detail? |
| `callout_line` | label, detail? |
| `highlight_sweep` | line, line? |
| `quote_card` | quote, attribution? |
| `steps_list` | step, step, step?, step?, step? |
| `cta_subscribe` | button, detail? |

The registry in `src/creative/motionDesignV3Presets.ts` ships 28 presets across these templates in a few restrained colour systems. MCP preset listings include each v3 preset's `template` and `textFields`.

## Contract

- `designV3` is required on v3 graphics and allowed only there. `motionV2`, `layoutV2`, `visualStyle` and tracking anchors are rejected.
- Line count must match the template's fields. Each line is at most 64 characters, and a graphic lasts at least 1 second.
- `fontSize` and `letterSpacing` are design pixels at a 1080-pixel short side. Templates scale them with the canvas, so a preset reads the same at 720p and 4K.
- Copy that cannot fit the template's line budget fails closed: the preview shows a blocked marker and export throws. Text is never shrunk or clipped silently.
- `\`, `{` and `}` in copy are drawn as full-width stand-ins by both renderers, because ASS reads them as markup.

## Rendering

- `src/motion/compositionV3.ts` evaluates a graphic into rounded draw ops: filled vector paths and text runs, each with opacity and an optional Gaussian blur and rectangular clip.
- Export (`src/render/motionV3Ass.ts`) writes one ASS event per op per run of identical frames. Drawings are emitted relative to their bounding box because libass aligns drawings that way. Blur σ maps to `\blur σ·√(2 ln 2)`. Each graphic owns a band of 16 layers from layer 10.
- Preview (`src/ui/MotionV3Graphic.tsx`) draws the same ops as one canvas-sized SVG. It turns kerning off because libass sets the copy unkerned.
- Layout measures glyphs with advance widths derived from the bundled font sources (`scripts/build-font-advance-metrics.py`, output `src/generated/fontAdvanceMetrics.json`). Faces without a glyph hand those characters to a fallback face (for example, CJK units after Bebas Neue figures), and runs share one CSS baseline.
- Export verifies every face a template may use against the measured physical font pack, like v2. v3 is limited to Rec.709 SDR output: pre-composited alpha, ACES 2 and HDR are refused rather than downgraded.

## Design rules the templates follow

- Title-safe areas depend on the format. Portrait keeps clear of the platform UI at the top and bottom.
- Entrances decelerate (expo or quint out) and exits accelerate (cubic in). Every element finishes its exit by the graphic's last frame, so the first and last frames are empty.
- Headlines wrap balanced, break between phrases when that keeps the same line count, keep Latin words and numbers whole, and follow kinsoku for CJK punctuation.
- Panels use soft diffuse shadows and a hairline edge instead of hard offsets. Copy without a panel gets a soft scrim that is nearly invisible on dark footage and keeps light ink readable on bright footage.
- Ink on the accent colour is chosen by WCAG contrast.

## Verifying a change

- `npx vitest run src/motion/compositionV3.test.ts src/render/motionV3Ass.test.ts src/domain/motionCompositionV3Contract.test.ts src/ui/MotionV3Graphic.test.tsx`
- Inspect decoded frames from a real render: build a project with v3 graphics, write ASS with `writeAssContent`, and burn it with FFmpeg's `subtitles` filter using the bundled `render/` faces as `fontsdir`. Unit tests alone do not prove the rendered look.
