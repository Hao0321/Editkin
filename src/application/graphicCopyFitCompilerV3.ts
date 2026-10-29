import { graphicCopyFitV3Schema, type GraphicCopyFitV3 } from "../domain/graphicCopyFitV3";
import type { ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { MeasuredTextLayoutError } from "../typography/measuredTextLayoutV2";
import type { ReferenceMotionTemplateCompileOptions } from "./referenceMotionTemplateCommands";
import type { DesignContext, DesignType } from "./referenceMotionDesignThemes";

const activeScales = new WeakMap<object, number>();

/** Text geometry seams share one physical scale. Vector paint, sources and motion are untouched. */
export function graphicCopyFitContextV3(context: DesignContext, options: ReferenceMotionTemplateCompileOptions): DesignContext {
  const scale = activeScales.get(options);
  if (scale === undefined || scale === 1) return context;
  const type = (spec: DesignType): DesignType => ({ ...spec, size: Math.max(8 / context.unit, spec.size * scale),
    ...(spec.tracking === undefined ? {} : { tracking: spec.tracking * scale }) });
  return { ...context,
    add: (role, preset, text, overrides, start, end) => {
      if (!text || overrides.vectorV2 || overrides.fontSize === undefined) return context.add(role, preset, text, overrides, start, end);
      const size = Math.max(8, overrides.fontSize * scale);
      return context.add(role, preset, text, { ...overrides, fontSize: size,
        ...(overrides.letterSpacing === undefined ? {} : { letterSpacing: overrides.letterSpacing * scale }),
        ...(overrides.layoutV2 ? { layoutV2: { ...overrides.layoutV2, minFontSize: Math.min(size, Math.max(8, overrides.layoutV2.minFontSize * scale)) } } : {}) }, start, end);
    },
    line: (role, text, spec, ...args) => context.line(role, text, type(spec), ...args),
    count: (role, text, spec, ...args) => context.count(role, text, type(spec), ...args),
    inline: (role, runs, spec, ...args) => context.inline(role, runs, type(spec), ...args),
    measure: (text, spec, ...args) => context.measure(text, type(spec), ...args),
    measureLines: (text, spec, ...args) => context.measureLines(text, type(spec), ...args),
  };
}

function copyFailure(error: unknown): boolean {
  if (error instanceof MeasuredTextLayoutError) return /^(文字超過 \d+ 行|文字在最小字級仍放不下|文字超出安全區高度)/.test(error.message);
  if (!(error instanceof Error)) return false;
  if (/^動態文字 .+ 的實體 glyph 無法在 safe-area 與 \d+ 行內 auto-fit$/.test(error.message)) return true;
  return /^(主標太長，(影像區塊|比較素材|影像窗|證據畫面)沒有足夠空間|說明在手機閱讀字級下超過 \d+ 行|資訊列太高，影像區塊沒有足夠空間|回顧清單太高，影像區塊沒有足夠空間|節點區塊空間不足；縮短短語或說明)/.test(error.message)
    || /^(說明|副句|眉題)缺少完整閱讀停留；/.test(error.message)
    || /^(資訊列|回顧清單)缺少逐項閱讀時間；/.test(error.message);
}

export interface GraphicCopyFitReceiptV3 {
  schema: "editkin.graphic-copy-fit-receipt/v3";
  fontScale: number;
  omittedFields: GraphicCopyFitV3["secondaryFields"];
  primaryCopyPreserved: true;
  attempts: Array<{ fontScale: number; omittedFields: GraphicCopyFitV3["secondaryFields"]; result: "fit" | "copy_overflow" }>;
  certification: "ART_PENDING_CLAUDE";
}

/** A private NeedGlyph suspension is never caught: the original physical preparation/deadline owns every retry. */
export function compileGraphicCopyFitPacketV3<T extends object>(input: ReferenceMotionTemplateInput, rawChoice: GraphicCopyFitV3,
  options: ReferenceMotionTemplateCompileOptions, compile: (effective: ReferenceMotionTemplateInput, options: ReferenceMotionTemplateCompileOptions) => T): T & { copyFitV3Receipt?: GraphicCopyFitReceiptV3 } {
  const choice = graphicCopyFitV3Schema.parse(rawChoice), effective = structuredClone(input);
  const omittedFields: GraphicCopyFitV3["secondaryFields"] = [], attempts: GraphicCopyFitReceiptV3["attempts"] = [];
  let firstFailure: unknown;
  for (let stage = 0; stage <= choice.secondaryFields.length; stage += 1) {
    if (stage > 0) {
      const field = choice.secondaryFields[stage - 1];
      if (field === "item_details") {
        if (!effective.items?.some(item => item.detail)) continue;
        effective.items = effective.items.map(({ detail: _detail, ...item }) => item);
      } else {
        if (!effective[field]) continue;
        // In a word build the subtitle may be part of its primary phrase.
        if (field === "subtitle" && effective.templateId === "word_build" && effective.title.trim().split(/\s+/).length < 2) continue;
        delete effective[field];
      }
      omittedFields.push(field);
    }
    for (const fontScale of choice.fontScales) {
      const scaledOptions = { ...options }; activeScales.set(scaledOptions, fontScale);
      try {
        const packet = compile(structuredClone(effective), scaledOptions);
        attempts.push({ fontScale, omittedFields: [...omittedFields], result: "fit" });
        return { ...packet, copyFitV3Receipt: { schema: "editkin.graphic-copy-fit-receipt/v3", fontScale,
          omittedFields: [...omittedFields], primaryCopyPreserved: true, attempts, certification: "ART_PENDING_CLAUDE" } };
      } catch (error) {
        if (!copyFailure(error)) throw error;
        firstFailure ??= error;
        attempts.push({ fontScale, omittedFields: [...omittedFields], result: "copy_overflow" });
      }
    }
  }
  throw firstFailure;
}
