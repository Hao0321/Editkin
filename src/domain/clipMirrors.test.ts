import { describe,expect,it } from "vitest";
import { createDemoProject } from "./demo";
import { animatedClipState,migrateProject } from "./editGraph";
import { parseProject } from "../application/projectCodec";
import { createHistory,dispatchCommand,undo } from "./history";
import { applyCommand } from "./commands";
import { editorCommandSchema } from "./schema";
import { TRACK_LOCKED_MESSAGE } from "./trackLock";
import { clipMirrorCss,composeClipTransforms,MIRROR_COMPLEX_REFUSAL } from "./clipMirrors";
import { DEFAULT_TRANSFORM,type Transform2D } from "./types";

describe("persistent clip mirrors",()=>{
  it("round-trips both optional flags in schema9/10 with an exact one-step Undo",()=>{
    for(const schemaVersion of [9,10] as const){const project=createDemoProject();project.schemaVersion=schemaVersion;
      const state=dispatchCommand(createHistory(project),{type:"update_clip_transform",clipId:"clip-demo",patch:{flipX:true,flipY:true}});
      expect(state.past).toHaveLength(1);expect(undo(state).present).toEqual(project);
      expect(parseProject(JSON.parse(JSON.stringify(state.present))).tracks[0].clips[0].transform).toEqual({...DEFAULT_TRANSFORM,flipX:true,flipY:true});
    }
  });
  it("leaves old migrations and old CSS free of invented flags; malformed flags are rejected",()=>{
    const project=createDemoProject();for(const schemaVersion of [1,8,9]){
      const transform=migrateProject({...structuredClone(project),schemaVersion}).tracks[0].clips[0].transform;
      expect(transform).not.toHaveProperty("flipX");expect(transform).not.toHaveProperty("flipY");expect(clipMirrorCss(transform)).toBe("");
    }
    expect(editorCommandSchema.safeParse({type:"update_clip_transform",clipId:"clip-demo",patch:{flipX:"true"}}).success).toBe(false);
  });
  it("keeps authored flags fixed while old numeric keyframes interpolate",()=>{
    const project=createDemoProject(),clip=project.tracks[0].clips[0];clip.keyframes=[{id:"pose",time:6,transform:{...clip.transform,x:60,rotation:20},color:{...clip.color},easing:"linear"}];
    const next=applyCommand(project,{type:"update_clip_transform",clipId:clip.id,patch:{flipX:true}}).tracks[0].clips[0];
    for(const time of [0,1,3,6,10,12]){const state=animatedClipState(next,time),old=animatedClipState(clip,time);
      expect(state.transform).toEqual({...old.transform,flipX:true});expect(state.color).toEqual(old.color);
    }
    expect(next.keyframes).toEqual(clip.keyframes);
  });
  it("refuses a locked track or unproved visual combination without changing bytes",()=>{
    const project=createDemoProject(),command={type:"update_clip_transform" as const,clipId:"clip-demo",patch:{flipX:true}};
    project.tracks[0].locked=true;let before=JSON.stringify(project);expect(()=>applyCommand(project,command)).toThrow(TRACK_LOCKED_MESSAGE);expect(JSON.stringify(project)).toBe(before);
    project.tracks[0].locked=false;project.assets[0].compositionId="unproved";before=JSON.stringify(project);expect(()=>applyCommand(project,command)).toThrow(MIRROR_COMPLEX_REFUSAL);expect(JSON.stringify(project)).toBe(before);
  });
  it("composes reflected parenting against an independent point-transform oracle",()=>{
    const point=(t:Transform2D,[x,y]:[number,number]):[number,number]=>{const a=t.rotation*Math.PI/180,s=Math.sin(a),c=Math.cos(a),px=x*(t.flipX?-1:1)*t.scale,py=y*(t.flipY?-1:1)*t.scale;
      return [t.x+px*c-py*s,t.y+px*s+py*c];};
    for(const flipX of [false,true])for(const flipY of [false,true])for(const childX of [false,true])for(const childY of [false,true]){
      const parent={...DEFAULT_TRANSFORM,x:14,y:-7,rotation:31,scale:.8,flipX,flipY},child={...DEFAULT_TRANSFORM,x:-9,y:5,rotation:-17,scale:.6,flipX:childX,flipY:childY};
      const composed=composeClipTransforms(parent,child);for(const xy of [[-20,12],[8,-14],[0,0]] as [number,number][]){const expected=point(parent,point(child,xy)),actual=point(composed,xy);
        expect(actual[0]).toBeCloseTo(expected[0],9);expect(actual[1]).toBeCloseTo(expected[1],9);}
    }
  });
});
