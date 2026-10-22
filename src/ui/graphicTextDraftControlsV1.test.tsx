import assert from "node:assert/strict";
import {isValidElement,type ReactNode,type ReactElement} from "react";
import {describe,it} from "vitest";
import type {MotionGraphic} from "../domain/types";
import {createMotionGraphic} from "../motion/composition";
import {defaultMotionGraphicV2Seed} from "../motion/defaultGraphicSeedsV2";
import {motionDesignV3Seed} from "../creative/motionDesignV3Presets";
import {renderMotionGraphicPropertiesV1} from "./MotionGraphicPropertiesV1";
import {TextEditFieldV1,renderTextEditFieldV1,createTextEditDraftV1} from "./TextEditFieldV1";
type ViewProps=Parameters<typeof renderTextEditFieldV1>[0] & {children?:ReactNode};
type Element=ReactElement<ViewProps>;
function walk(node:ReactNode,predicate:(node:Element)=>boolean):Element|undefined{if(Array.isArray(node))return node.map(x=>walk(x,predicate)).find(Boolean);if(!isValidElement<ViewProps>(node))return;if(predicate(node))return node;return walk(node.props.children,predicate);}
function fixture(options:{v3?:boolean;managed?:boolean;refused?:boolean;fallback?:boolean}={}){
 const graphic=options.v3?{...motionDesignV3Seed("v3_title_reveal"),id:"g",timelineStart:0,duration:3} as MotionGraphic:createMotionGraphic("g","title","TITLE",0,3,undefined,defaultMotionGraphicV2Seed("title")),scope={},calls={updates:[] as string[],commit:0,cancel:0,fallback:0,reject:0,begin:0};
 const begin=()=>{calls.begin++;return options.refused?undefined:{update:(value:string)=>{calls.updates.push(value);return true;},commit:()=>{calls.commit++;return true;},cancel:()=>{calls.cancel++;}};};
 const node=renderMotionGraphicPropertiesV1({graphic,editScope:scope,managedMotionGraphicIds:options.managed?["g"]:[],onTextGestureStart:options.fallback?undefined:begin,onTextDraftRejected:()=>{calls.reject++;},onUpdateMotionGraphic:()=>{calls.fallback++;return false;},onDeleteMotionGraphic:()=>{}});
 const component=walk(node,n=>n.type===TextEditFieldV1)!;assert(component);const field=renderTextEditFieldV1({...component.props as Parameters<typeof renderTextEditFieldV1>[0],draft:createTextEditDraftV1()}),target={value:"DRAFT"},change=()=>field.props.onChange({currentTarget:target}),key=(key:string,mods:Record<string,unknown>={})=>{let prevented=false;field.props.onKeyDown({key,...mods,currentTarget:target,preventDefault(){prevented=true;},stopPropagation(){}});return prevented;};
 return{graphic,scope,node,component,field,target,calls,change,key};
}
describe("actual shared graphic text view",()=>{
 it("ordinary text uses the passed scope/lease and confirms once",()=>{const f=fixture();assert.equal(f.component.props.scope,f.scope);f.change();f.target.value="LATEST";f.change();assert.equal(f.calls.commit,0);f.field.props.onBlur({currentTarget:f.target});f.field.props.onBlur({currentTarget:f.target});assert.equal(f.calls.commit,1);assert.equal(f.calls.fallback,0);assert.deepEqual(f.calls.updates,["DRAFT","LATEST","LATEST"]);});
 it("V3 retains multiline rows and author field hints",()=>{const f=fixture({v3:true});assert.equal(f.field.type,"textarea");assert.equal(f.field.props.rows,2);assert.equal(typeof f.field.props.placeholder,"string");assert(f.field.props.placeholder);f.change();assert.equal(f.key("Enter"),false);assert.equal(f.calls.commit,0);assert(f.key("Enter",{ctrlKey:true}));assert.equal(f.calls.commit,1);});
 it("Escape cancels preview without a fallback writer",()=>{const f=fixture();f.change();assert(f.key("Escape"));f.field.props.onBlur({currentTarget:f.target});assert.equal(f.target.value,f.graphic.text);assert.equal(f.calls.cancel,1);assert.equal(f.calls.commit,0);assert.equal(f.calls.fallback,0);});
 it("a refused gesture never falls back to the unscoped callback",()=>{const f=fixture({refused:true});f.change();f.field.props.onBlur({currentTarget:f.target});assert.equal(f.calls.fallback,0);assert.equal(f.target.value,f.graphic.text);assert.equal(f.calls.reject,1);});
 it("a standalone callback false return is propagated to the text draft",()=>{const f=fixture({fallback:true});f.change();f.field.props.onBlur({currentTarget:f.target});assert.equal(f.calls.fallback,1);assert.equal(f.target.value,f.graphic.text);assert.equal(f.calls.reject,1);});
 it("managed text stays disabled and cannot invoke a raw lease or writer",()=>{const f=fixture({managed:true});assert.equal(f.field.props.disabled,true);f.change();f.field.props.onBlur({currentTarget:f.target});assert.equal(f.calls.begin,0);assert.equal(f.calls.commit,0);assert.equal(f.calls.fallback,0);});
 it("an authored vector remains a vector, not a phantom text input",()=>{const graphic=createMotionGraphic("v","card","",0,3);graphic.vectorV2={schema:"editkin.motion-vector-stage/v1",kind:"panel",heightPixels:100,revealFrames:10};const node=renderMotionGraphicPropertiesV1({graphic,onUpdateMotionGraphic:()=>false,onDeleteMotionGraphic:()=>{}});assert.equal(walk(node,n=>n.type===TextEditFieldV1),undefined);});
 it("font and width-mode controls remain reachable with original labels",()=>{const f=fixture();assert(walk(f.node,n=>n.type==="select"&&n.props["aria-label"]===f.graphic.name+"字型"));assert(walk(f.node,n=>n.type==="select"&&n.props["aria-label"]===f.graphic.name+"底框寬度"));});
});

