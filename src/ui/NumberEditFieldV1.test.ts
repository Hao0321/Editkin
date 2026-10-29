import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createNumberEditDraftV1 } from "./NumberEditFieldV1";

describe("number field edit transaction", () => {
  function fixture() {
    const draft = createNumberEditDraftV1(), scope = {}, calls: number[] = [], target = { value: "12", valueAsNumber: 12 };
    const bind = (value = 12, currentScope = scope, accept = true) => draft.bind(value, currentScope, next => { calls.push(next); return accept; });
    const change = (value: string) => { target.value = value; target.valueAsNumber = value.trim() ? Number(value) : NaN; };
    return { draft, scope, calls, target, bind, change };
  }
  it("keeps typing local and one Enter/blur commit", () => { const f=fixture(),b=f.bind();f.change("2");b.onChange();f.change("24");b.onChange();assert.equal(f.calls.length,0);b.onKeyDown({key:"Enter",currentTarget:f.target,preventDefault(){}});b.onBlur({currentTarget:f.target});assert.deepEqual(f.calls,[24]); });
  for (const value of ["", " ", "-", ".", "NaN", "Infinity"]) it("rejects incomplete/nonfinite "+JSON.stringify(value),()=>{const f=fixture(),b=f.bind();f.change(value);b.onChange();b.onBlur({currentTarget:f.target});assert.deepEqual(f.calls,[]);assert.equal(f.target.value,"12");});
  it("Escape restores current value and does not submit on blur",()=>{const f=fixture(),b=f.bind();f.change("24");b.onChange();b.onKeyDown({key:"Escape",currentTarget:f.target,preventDefault(){}});b.onBlur({currentTarget:f.target});assert.deepEqual(f.calls,[]);assert.equal(f.target.value,"12");});
  it("IME keeps Enter and Escape",()=>{const f=fixture(),b=f.bind();f.change("24");b.onChange();b.onKeyDown({key:"Enter",nativeEvent:{isComposing:true},currentTarget:f.target,preventDefault(){throw Error("IME");}});b.onKeyDown({key:"Escape",nativeEvent:{keyCode:229},currentTarget:f.target,preventDefault(){throw Error("IME");}});assert.equal(f.calls.length,0);b.onBlur({currentTarget:f.target});assert.deepEqual(f.calls,[24]);});
  it("retains original callback through unrelated rerender",()=>{const f=fixture(),a=f.bind();f.change("24");a.onChange();const b=f.draft.bind(12,f.scope,()=>{throw Error("replacement callback must not own old edit");});b.onBlur({currentTarget:f.target});assert.deepEqual(f.calls,[24]);});
  it("changed field value invalidates old draft",()=>{const f=fixture(),a=f.bind();f.change("24");a.onChange();f.bind(30).onBlur({currentTarget:f.target});assert.deepEqual(f.calls,[]);assert.equal(f.target.value,"30");});
  it("changed selection/session scope invalidates old draft",()=>{const f=fixture(),a=f.bind();f.change("24");a.onChange();f.bind(12,{}).onBlur({currentTarget:f.target});assert.deepEqual(f.calls,[]);assert.equal(f.target.value,"12");});
  it("false acknowledgement restores input",()=>{const f=fixture(),a=f.bind(12,f.scope,false);f.change("24");a.onChange();a.onBlur({currentTarget:f.target});assert.deepEqual(f.calls,[24]);assert.equal(f.target.value,"12");});
  it("no-op adds no command",()=>{const f=fixture(),a=f.bind();a.onChange();a.onBlur({currentTarget:f.target});assert.deepEqual(f.calls,[]);});
  it("unmount cancellation is idempotent",()=>{const f=fixture(),a=f.bind();f.change("24");a.onChange();f.draft.cancel();f.draft.cancel();a.onBlur({currentTarget:f.target});assert.deepEqual(f.calls,[]);});
});
