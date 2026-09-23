import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createMotionGraphic } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { writeAssContent } from "./captionAss";

describe("ASS physical face consumers", () => {
  it("uses resolved aliases and numeric weights for captions, translation, v1 and v2", () => {
    const p=createDemoProject();p.captionStyle.fontFamily="Noto Sans TC";p.captionStyle.bold=true;
    p.captionStyle.translationFontFamily="Bebas Neue";p.captionStyle.translationBold=true;
    p.captions=[{id:"c",text:"主字幕",start:0,duration:2,translation:{text:"HELLO",language:"en"}}];
    const v1=createMotionGraphic("v1","title","標題",0,2);v1.fontFamily="Noto Serif TC";v1.fontWeight=850;
    const v2=createMotionGraphic("v2","title","卡片",0,2,undefined,findMotionGraphicPreset("v2-word-cascade").seed);v2.fontFamily="Fredoka";v2.fontWeight=800;
    p.motionGraphics=[v1,v2];const ass=writeAssContent(p,p.captionStyle);
    expect(ass).toContain("\\fnEditkinFace noto-sans-tc 800\\b800");
    expect(ass).toContain("\\fnEditkinFace noto-serif-tc 850\\b850");
    expect(ass).toContain("\\fnEditkinFace fredoka 700\\b700");
    expect(ass).toContain("\\fnEditkinFace bebas-neue 400");
    expect(ass).not.toMatch(/\\b[01](?=\\|})/);
  });
  it("keeps custom families and explicit legacy roots unaliased while rejecting invalid weights", () => {
    const p=createDemoProject(),g=createMotionGraphic("v1","title","字",0,2);g.fontFamily="Private Serif Black";g.fontWeight=650;p.motionGraphics=[g];
    expect(writeAssContent(p,p.captionStyle)).toContain("\\fnPrivate Serif Black\\b650");
    const legacy=writeAssContent(p,p.captionStyle,{bundledFaces:false});expect(legacy).not.toContain("EditkinFace");
    g.fontWeight=Number.NaN;expect(()=>writeAssContent(p,p.captionStyle)).toThrow(/字重/);
  });
});
