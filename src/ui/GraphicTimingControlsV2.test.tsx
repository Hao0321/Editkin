import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GRAPHIC_TIMING_V2 } from "../domain/graphicTimingV2";
import { GraphicTimingControlsV2 } from "./GraphicTimingControlsV2";
import { referenceMotionInstanceDraft, referenceMotionInstanceDraftPatch } from "./SavedReferenceMotionInstances";
import { referenceMotionInstanceSchema, referenceMotionTemplateRevisionPatchSchema } from "../domain/referenceMotionInstance";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { createInterfacePreferencesStore } from "./i18n/interfacePreferences";
import en from "./i18n/locales/en"; import es from "./i18n/locales/es"; import ja from "./i18n/locales/ja"; import ko from "./i18n/locales/ko";
type Element = ReactElement<Record<string,unknown>>;
function elements(n: ReactNode): Element[] {
  if (Array.isArray(n)) return n.flatMap(elements);
  if (!isValidElement<Record<string,unknown>>(n)) return [];
  return [n,...elements(n.props.children as ReactNode)];
}
const saved = () => referenceMotionInstanceSchema.parse({ schema: "editkin.reference-motion-instance/v1", id: "timing-ui", authoringGeneration: 2, instanceRevision: 1,
  input: { templateId: "level_bridge", clipId: "main", startFrame: 0, durationFrames: 360, title: "測試", sources: [], intent: "standalone_showcase",
    purpose: "UI control test", evidenceRefs: ["fixture:timing-ui"], style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) },
  frameFormat: {width:1080,height:1920,fps:30}, roles:[{key:"title",kind:"graphic",id:"title"}], primaryBefore:{layout:null},
  appliedScopeSha256:"1".repeat(64), dependencies:{recipeVersion:"synthetic",fonts:[],presetHashes:[]} });
describe("three saved graphic timing sliders", () => {
  it("submits distinct values through the supported revision, retains old omission and can restore it explicitly", () => {
    const instance = saved(), draft = referenceMotionInstanceDraft(instance), onChange = vi.fn();
    expect(referenceMotionInstanceDraftPatch(instance,draft)).not.toHaveProperty("graphicTimingV2");
    const controls = elements(GraphicTimingControlsV2({ value:undefined,disabled:false,onChange }));
    const inputs = controls.filter(e => e.type === "input"); expect(inputs).toHaveLength(3);
    for (const [index,key] of (["entranceSpeed","holdSeconds","exitSpeed"] as const).entries()) {
      (inputs[index].props.onChange as (event: {target:{value:string}})=>void)({target:{value:index===1?"3.5":"1.5"}});
      const timing = onChange.mock.calls.at(-1)![0];
      expect(timing).toEqual({...DEFAULT_GRAPHIC_TIMING_V2,[key]:index===1?3.5:1.5});
      draft.graphicTimingV2 = timing;
      expect(referenceMotionTemplateRevisionPatchSchema.parse(referenceMotionInstanceDraftPatch(instance,draft)).graphicTimingV2).toEqual(timing);
    }
    instance.input.graphicTimingV2 = {...DEFAULT_GRAPHIC_TIMING_V2}; draft.graphicTimingV2 = undefined;
    expect(referenceMotionInstanceDraftPatch(instance,draft).graphicTimingV2).toBeNull();
    expect(instance.input.style.animationSpeed).toBe(1);
  });
  it("prevents disabled controls and reset from editing even if callbacks are invoked", () => {
    const onChange=vi.fn(), nodes=elements(GraphicTimingControlsV2({value:{...DEFAULT_GRAPHIC_TIMING_V2},disabled:true,onChange}));
    for(const e of nodes.filter(e=>e.type==='input')) {
      expect(e.props.disabled).toBe(true);
      (e.props.onChange as (event:{target:{value:string}})=>void)({target:{value:'2'}});
    }
    (nodes.find(e=>e.type==='button')!.props.onClick as ()=>void)(); expect(onChange).not.toHaveBeenCalled();
  });
  it("has the same three distinct accessible labels and hold explanation in all five languages", () => {
    const labels=['已儲存模板進場速度','已儲存模板停留時間','已儲存模板退場速度'];
    for (const locale of [undefined,en,es,ja,ko]) {
      const translated=labels.map(label=>locale?.[label]??label);
      expect(new Set(translated).size).toBe(3);
      if(locale) for(const label of labels) expect(locale[label]).toBeTruthy();
    }
  });
  it("shows plain translated timing refusals while technical codes stay outside the user message", async () => {
    const message="片段放不下進場、閱讀停留與退場；請延長片段或調快速度。";
    const dictionaries={en,es,ja,ko};
    for(const locale of ["en","es","ja","ko"] as const){
      const store=createInterfacePreferencesStore({storage:{getItem:()=>null,setItem:()=>{}},loadMessages:async()=>dictionaries[locale]});
      await store.setLocale(locale);
      const translated=store.translateStatus(message);
      expect(translated).toBe(dictionaries[locale][message]);expect(translated).not.toBe(message);expect(translated).not.toContain("GRAPHIC_");
    }
  });
});
