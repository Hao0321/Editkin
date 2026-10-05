import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { createHistory, dispatchCommand, redo, undo } from "../domain/history";
import { editorCommandSchema, projectSchema } from "../domain/schema";
import type { MotionGraphicKind } from "../domain/types";
import { assertMotionGraphicPresetBinding, findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { prepareMotionPhysicalLayouts } from "../render/motionPhysicalGlyphLayouts";
import { defaultMotionGraphicV2Seed } from "./defaultGraphicSeedsV2";
import { createMotionGraphic, legacyMotionGraphicSeed } from "./composition";
import { motionGraphicV2FrameReceipt } from "./compositionV2";

const baseline=JSON.parse(readFileSync(resolve("src/motion/fixtures/registered-presets-before-default-v2.json"),"utf8")) as {
  defaults: ReturnType<typeof createMotionGraphic>[];
  stock: {preset:{id:string;seed:Parameters<typeof createMotionGraphic>[6]};graphic:ReturnType<typeof createMotionGraphic>}[];
};
const kinds=["title","card","tag","counter"] as const;
const copy:Record<MotionGraphicKind,string>={title:"Editkin 動態\n重點 42%",card:"真實內容\n清楚說明",tag:"重點 42%",counter:"42%"};
function project(width=1080,height=1920){return createEmptyProject("Original default authoring",{width,height,fps:30});}

describe("generic new-authoring current v2 floor (source, not GUI or film art)",()=>{
  it.each(kinds)("adds/saves/undoes registered %s without reverting to v1",kind=>{
    const initial=project(),before=JSON.stringify(initial);
    const g=createMotionGraphic("new-"+kind,kind,copy[kind],1,3);
    expect(g.schema).toBe("hao.motion-composition/v2");
    expect(g.presetId).toBe("generic-"+kind+"-v2");
    assertMotionGraphicPresetBinding(g,g.presetId!);
    const parsed=editorCommandSchema.parse({type:"add_motion_graphic",graphic:g});
    const history=dispatchCommand(createHistory(initial),parsed,"default-"+kind);
    const reopened=projectSchema.parse(JSON.parse(JSON.stringify(history.present)));
    expect(reopened.motionGraphics[0]).toEqual(g);
    expect(undo(history).present.motionGraphics).toHaveLength(0);
    expect(redo(undo(history)).present.motionGraphics).toEqual([g]);
    expect(JSON.stringify(initial)).toBe(before);
    expect(reopened.assets).toEqual(initial.assets); expect(reopened.tracks).toEqual(initial.tracks);
    expect(reopened.captions).toEqual(initial.captions); expect(reopened.director).toEqual(initial.director);
  });

  it.each([[1080,1920],[1920,1080]])("prepares authentic bundled contours and samples all frames at %sx%s",async(width,height)=>{
    let p=project(width,height);
    for(const kind of kinds) p=applyCommand(p,{type:"add_motion_graphic",graphic:createMotionGraphic(kind,kind,copy[kind],1,3)});
    const layouts=await prepareMotionPhysicalLayouts(p,resolve("public/fonts"));
    expect(layouts.size).toBe(4);
    for(const g of p.motionGraphics){
      const layout=layouts.get(g.id)!;
      expect(layout.physicalFont?.fontSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(layout.physicalFont?.faceId).toMatch(/^EditkinFace-noto-sans-tc-(700|900)$/);
      expect(layout.segments.length).toBeGreaterThan(0);
      expect(layout.segments.every(s=>Boolean(s.outline?.svg)&&Boolean(s.outline?.ass))).toBe(true);
      for(let frame=29;frame<=120;frame++){
        const actual=motionGraphicV2FrameReceipt(p,g,frame,layout);
        expect(actual.visible).toBe(frame>=30&&frame<120);
        for(const segment of actual.segments){
          expect(Number.isFinite(segment.translateXPixels)&&Number.isFinite(segment.translateYPixels)).toBe(true);
          expect(segment.scale).toBe(1); expect(segment.opacity).toBeGreaterThanOrEqual(0); expect(segment.opacity).toBeLessThanOrEqual(1);
        }
      }
      const settled=motionGraphicV2FrameReceipt(p,g,37,layout);
      expect(settled.segments.every(s=>s.opacity===1&&s.translateXPixels===0&&s.translateYPixels===0)).toBe(true);
      const later=motionGraphicV2FrameReceipt(p,g,115,layout);
      motionGraphicV2FrameReceipt(p,g,32,layout);
      expect(motionGraphicV2FrameReceipt(p,g,115,layout)).toEqual(later);
    }
  },60000);

  it("retains all82 captured explicit stock seeds and their old neutral graph bytes",()=>{
    expect(baseline.stock).toHaveLength(82);
    for(const row of baseline.stock){
      const stock=findMotionGraphicPreset(row.preset.id);
      expect(stock).toEqual(row.preset);
      const g=row.graphic;
      const recreated=createMotionGraphic(g.id,g.kind,g.text,g.timelineStart,g.duration,g.trackId,stock.seed);
      expect(recreated).toEqual(g); expect(JSON.stringify(recreated)).toBe(JSON.stringify(g));
    }
    for(const old of baseline.defaults){
      const g=createMotionGraphic(old.id,old.kind,old.text,old.timelineStart,old.duration,undefined,legacyMotionGraphicSeed(old.kind));
      expect(g).toEqual(old); expect(JSON.stringify(g)).toBe(JSON.stringify(old)); expect(g.presetId).toBeUndefined();
      const p=applyCommand(project(),{type:"add_motion_graphic",graphic:g});
      expect(projectSchema.parse(JSON.parse(JSON.stringify(p))).motionGraphics[0]).toEqual(old);
    }
  });

  it("does not leak a modified creation seed into the next instance or immutable registry",()=>{
    const seed=defaultMotionGraphicV2Seed("title");seed.motionV2!.entrance.durationFrames=99;seed.layoutV2!.maxLines=9;
    const g=createMotionGraphic("second","title","Clear",0,3);
    expect(g.motionV2!.entrance.durationFrames).toBe(7); expect(g.layoutV2!.maxLines).toBe(2);
    assertMotionGraphicPresetBinding(g,g.presetId!);
  });

  it("rejects missing, mislabeled or altered registered style instead of self-labeling a default",()=>{
    const good=createMotionGraphic("title","title","Clear",0,3);
    for(const field of ["motionV2","layoutV2"] as const){const bad={...good,[field]:undefined};expect(()=>editorCommandSchema.parse({type:"add_motion_graphic",graphic:bad})).toThrow();}
    expect(()=>editorCommandSchema.parse({type:"add_motion_graphic",graphic:{...good,schema:"hao.motion-composition/v1"}})).toThrow();
    const changed=structuredClone(good);changed.motionV2!.entrance.durationFrames=3;
    expect(()=>assertMotionGraphicPresetBinding(changed,good.presetId!)).toThrow();
    const legacy=createMotionGraphic("old","title","Clear",0,3,undefined,legacyMotionGraphicSeed("title"));
    expect(()=>assertMotionGraphicPresetBinding({...legacy,presetId:good.presetId},good.presetId!)).toThrow();
  });

  it("rejects unavailable v2 tracking without implicit downgrade or source-clock changes",()=>{
    expect(()=>createMotionGraphic("tracked","tag","Target",0,3,"track")).toThrow(/尚未支援追蹤/);
    const explicit=createMotionGraphic("legacy-track","tag","Target",0,3,"track",legacyMotionGraphicSeed("tag"));
    expect(explicit).toMatchObject({schema:"hao.motion-composition/v1",trackId:"track",trackingMode:"anchor",offsetX:.015,offsetY:-.02});
    expect(explicit.motionV2).toBeUndefined();expect(explicit.presetId).toBeUndefined();
  });

  it("rejects a one-frame interval instead of extending duration or fabricating hold",()=>{
    const p=project(),before=JSON.stringify(p),g=createMotionGraphic("short","title","Short",2,1/30);
    expect(()=>applyCommand(p,{type:"add_motion_graphic",graphic:g})).toThrow();
    expect(g.duration).toBe(1/30);expect(JSON.stringify(p)).toBe(before);
  });

  it("requires verified font delivery and refuses unsupported shaping",async()=>{
    const p=applyCommand(project(),{type:"add_motion_graphic",graphic:createMotionGraphic("title","title","Clear",0,3)});
    await expect(prepareMotionPhysicalLayouts(p)).rejects.toThrow(/pack root/);
    const unsupported=structuredClone(p);unsupported.motionGraphics[0].text="😀";
    await expect(prepareMotionPhysicalLayouts(unsupported,resolve("public/fonts"))).rejects.toThrow();
  },60000);
});
