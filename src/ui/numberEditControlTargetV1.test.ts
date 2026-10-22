import assert from "node:assert/strict";
import {describe,it} from "vitest";
import {createNumberEditDraftV1} from "./NumberEditFieldV1";
const target=(value="12")=>({value,get valueAsNumber(){return this.value.trim()?Number(this.value):Number.NaN;}});
describe("numeric confirmation forwards its real native control",()=>{
 it("passes the actual control at confirmation, never while typing",()=>{const d=createNumberEditDraftV1(),t=target(),calls:unknown[][]=[],b=d.bind(12,{},(value,control)=>{calls.push([value,control]);});t.value="24";b.onChange();assert.equal(calls.length,0);b.onBlur({currentTarget:t});assert.deepEqual(calls,[[24,t]]);});
 it("keeps one-argument canonical callbacks compatible",()=>{const d=createNumberEditDraftV1(),t=target(),calls:number[]=[],b=d.bind(12,{},v=>{calls.push(v);});t.value="24";b.onChange();b.onKeyDown({key:"Enter",currentTarget:t,preventDefault(){}});b.onBlur({currentTarget:t});assert.deepEqual(calls,[24]);});
 it("false refusal restores the DOM field after the callback observes it",()=>{const d=createNumberEditDraftV1(),t=target(),b=d.bind(12,{},(v,c)=>{assert.equal(v,24);assert.equal(c,t);return false;});t.value="24";b.onChange();b.onBlur({currentTarget:t});assert.equal(t.value,"12");});
 it("a callback exception also restores the native field",()=>{const d=createNumberEditDraftV1(),t=target(),b=d.bind(12,{},()=>{throw Error("refused");});t.value="24";b.onChange();b.onBlur({currentTarget:t});assert.equal(t.value,"12");});
 it("a domain normalizer can preserve its old clamp display policy",()=>{const d=createNumberEditDraftV1(),t=target(),b=d.bind(12,{},(_v,c)=>{c!.value="20";return true;});t.value="24";b.onChange();b.onBlur({currentTarget:t});assert.equal(t.value,"20");});
 it("unchanged, empty and nonfinite drafts never invoke the native callback",()=>{for(const value of ["12",""," ","NaN","Infinity"]){const d=createNumberEditDraftV1(),t=target(),b=d.bind(12,{},()=>{throw Error("unexpected write");});t.value=value;b.onChange();b.onBlur({currentTarget:t});assert.equal(t.value,"12");}});
});

