import assert from "node:assert/strict";
import type { ResidentAudioStatus } from "../src/desktop/residentAudioTypes";
import { assessSignalOracle, goldenMeasurement, hasPrivatePathSurface, type SignalOracle } from "./nativeAudioMixProductEvaluator";

type Snapshot = { mode: string; intent: boolean; status: ResidentAudioStatus };
export interface ResidentMeasurement {
  route: "resident"; actions: string[]; snapshots: Record<string, Snapshot>;
  guards: Record<string, boolean>; projectUnchanged?: boolean; signalOracle: SignalOracle;
}
interface Client {
  command(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  evaluate(expression: string, timeoutMs?: number): Promise<any>;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const frame = (s?: Snapshot) => s?.status.playback.timelineFrame ?? -1;
export function assessResidentAudio(m: ResidentMeasurement) {
  const failures: string[] = [];
  for (const name of ["playing", "paused", "held", "resumed", "sought", "reopened"]) {
    const s = m.snapshots[name];
    if (!s || s.mode !== "native" || !s.status.ready || s.status.failed || s.status.closing || hasPrivatePathSurface(s.status)) failures.push(`RESIDENT_${name}_INVALID`);
  }
  const { playing: p, paused: a, held: b, resumed: r, sought: s, reopened: o } = m.snapshots;
  if (!(frame(p) > 0 && (p?.status.playback.sampleMasterFrame ?? 0) > 0 && (p?.status.playback.clockQpc100ns ?? 0) > 0)) failures.push("SAMPLE_CLOCK_NOT_ADVANCING");
  if (a?.intent !== false || b?.intent !== false || a?.status.playback.state !== "paused" || b?.status.playback.state !== "paused" || frame(a) !== frame(b)) failures.push("PAUSE_NOT_STABLE");
  if (r?.intent !== true || r?.status.playback.state !== "playing" || !(frame(r) > frame(b)) || r?.status.ownerId !== p?.status.ownerId || r?.status.generation !== p?.status.generation) failures.push("RESUME_CHANGED_OWNER_OR_FROZEN");
  if (s?.status.ownerId !== p?.status.ownerId || !(s?.status.generation > r?.status.generation) || Math.abs((s?.status.playback.timelineStartFrame ?? -1) / 48000 - 2) > .1) failures.push("SEEK_NOT_REPLACED");
  if (!o?.intent || o.status.ownerId === p?.status.ownerId || !(frame(o) > 0)) failures.push("REOPEN_FAILED");
  for (const guard of ["staleOwner", "staleGeneration", "legacyOverlap", "retiredOwner"]) if (m.guards[guard] !== true) failures.push(`GUARD_${guard}_FAILED`);
  for (const action of ["play", "pause", "resume", "seek", "reload", "reopen"]) if (!m.actions.includes(action)) failures.push(`UI_${action}_MISSING`);
  if (!m.projectUnchanged) failures.push("PROJECT_MUTATED");
  assessSignalOracle(m.signalOracle, failures);
  return { decision: failures.length ? "BLOCK" : "GREEN", failures };
}

// Trusted input to real controls; diagnostic status never changes transport state.
export async function runResidentAudioJourney(client: Client, m: ResidentMeasurement): Promise<void> {
  async function until(name: string, read: () => Promise<any>, accept: (value: any) => boolean, ms = 20000) {
    const deadline = Date.now() + ms; let value;
    do { value = await read(); if (accept(value)) return value; await delay(80); } while (Date.now() < deadline);
    throw new Error(`${name}: ${JSON.stringify(value)}`);
  }
  const snapshot = () => client.evaluate(`(async()=>{const p=document.querySelector('.preview-panel');const owner=Number(p?.dataset.nativeAudioOwner);if(!owner)return JSON.stringify({mode:p?.dataset.nativeAudioMode,intent:p?.dataset.playing==='true'});try{return JSON.stringify({mode:p.dataset.nativeAudioMode,intent:p.dataset.playing==='true',status:await window.haoDesktop.residentAudio.status(owner)})}catch(e){return JSON.stringify({error:String(e)})}})()`);
  async function state(name: string, accept: (value: Snapshot) => boolean) {
    const value = await until(name, snapshot, s => s.status?.ready && !s.status.failed && s.mode === "native" && accept(s));
    m.snapshots[name] = value; return value as Snapshot;
  }
  async function pointer(x: number, y: number) {
    for (const type of ["mousePressed", "mouseReleased"]) await client.command("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
  async function play(action: string) {
    const point = await client.evaluate(`(()=>{const e=document.querySelector('[data-testid="preview-play"],[data-testid="native-preview-play"]');if(!e)throw Error('Play missing');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Play obscured');return JSON.stringify({x,y})})()`);
    await pointer(point.x, point.y); m.actions.push(action);
  }
  const before = await client.evaluate("window.haoDesktop.loadRecovery().then(r=>JSON.stringify(r.snapshot.project))");
  await play("play");
  const p = await state("playing", s => s.intent && frame(s) > 2400);
  await play("pause");
  await state("paused", s => !s.intent && s.status.playback.state === "paused");
  await delay(400); await state("held", s => !s.intent && s.status.playback.state === "paused");
  await play("resume"); await state("resumed", s => s.intent && frame(s) > frame(m.snapshots.held) + 2400);
  const owner = p.status.ownerId, generation = p.status.generation;
  async function rejected(expr: string) { return client.evaluate(`(${expr}).then(()=>JSON.stringify(false)).catch(()=>JSON.stringify(true))`); }
  m.guards.staleOwner = await rejected(`window.haoDesktop.residentAudio.control(${owner + 1000000},${generation},true)`);
  m.guards.staleGeneration = await rejected(`window.haoDesktop.residentAudio.control(${owner},${generation + 1000000},true)`);
  m.guards.legacyOverlap = await rejected(`window.haoDesktop.startNativeAudioPreview(${JSON.stringify(before)},0)`);
  // Read rendered ruler spacing rather than assuming zoom, viewport, or an absent seek slider.
  const point = await client.evaluate(`(()=>{const e=document.querySelector('[data-testid="timeline-ruler"]');const ticks=[...e.querySelectorAll(':scope>span')].map(s=>({x:parseFloat(s.style.left),t:s.textContent})).filter(s=>Number.isFinite(s.x));const seconds=t=>t.trim().split(':').map(Number).reduce((a,b)=>a*60+b,0);const pps=(ticks[1].x-ticks[0].x)/(seconds(ticks[1].t)-seconds(ticks[0].t));const r=e.getBoundingClientRect(),x=r.x+2*pps,y=r.y+r.height/2;if(!Number.isFinite(x)||!e.contains(document.elementFromPoint(x,y)))throw Error('Seek obscured');return JSON.stringify({x,y})})()`);
  await pointer(point.x, point.y); m.actions.push("seek");
  await state("sought", s => s.status.generation > generation && s.status.playback.streamGeneration === s.status.generation);
  await play("pause-after-seek"); await state("paused-after-seek", s => !s.intent && s.status.playback.state === "paused");
  // Navigation retires the event channel/owner in the real desktop host; no manual close masquerades as UI cleanup.
  await client.evaluate("(()=>{window.__editkinAudioReloadProbe=true;return JSON.stringify(true)})()");
  await client.command("Page.reload", { ignoreCache: true }); m.actions.push("reload");
  await until("fresh document ready", async () => { try { return await client.evaluate("JSON.stringify(window.__editkinAudioReloadProbe!==true&&document.readyState==='complete'&&!!window.haoDesktop?.residentAudio&&!!document.querySelector('[data-testid=\"preview-play\"],[data-testid=\"native-preview-play\"]'))"); } catch { return false; } }, Boolean);
  m.guards.retiredOwner = await until("old owner retired", () => rejected(`window.haoDesktop.residentAudio.status(${owner})`), Boolean);
  await play("reopen"); await state("reopened", s => s.intent && frame(s) > 2400);
  await play("final-pause"); await state("final-paused", s => !s.intent && s.status.playback.state === "paused");
  const after = await client.evaluate("window.haoDesktop.loadRecovery().then(r=>JSON.stringify(r.snapshot.project))");
  m.projectUnchanged = JSON.stringify(before) === JSON.stringify(after);
}

export function residentEvaluatorSelfTest(): void {
  const status = (n: number, state: "playing" | "paused", owner = 1, gen = 1): Snapshot => ({ mode: "native", intent: state === "playing", status: {schema:"editkin.desktop-audio-status/v1", ownerId:owner, generation:gen, sequence:1, ready:true,failed:false,closing:false,playback:{state,timelineFrame:n,sampleMasterFrame:n,clockQpc100ns:1,timelineStartFrame:gen===2?96000:0}} });
  const good: ResidentMeasurement = { route:"resident", actions:["play","pause","resume","seek","reload","reopen"], snapshots:{playing:status(4800,"playing"),paused:status(5000,"paused"),held:status(5000,"paused"),resumed:status(10000,"playing"),sought:status(96000,"playing",1,2),reopened:status(5000,"playing",2)},guards:{staleOwner:true,staleGeneration:true,legacyOverlap:true,retiredOwner:true},projectUnchanged:true,signalOracle:goldenMeasurement().signalOracle };
  assert.equal(assessResidentAudio(good).decision,"GREEN");
  const controls: Record<string,(m:ResidentMeasurement)=>void> = {
    pauseDrift:m=>{m.snapshots.held.status.playback.timelineFrame=6000;},
    frozen:m=>{m.snapshots.playing.status.playback.sampleMasterFrame=0;},
    ownerChanged:m=>{m.snapshots.resumed.status.ownerId=2;},
    seekStale:m=>{m.snapshots.sought.status.generation=1;},
    seekWrong:m=>{m.snapshots.sought.status.playback.timelineStartFrame=0;},
    reopenStale:m=>{m.snapshots.reopened.status.ownerId=1;},
    noInput:m=>{m.actions=[];},
    missingStatus:m=>{delete m.snapshots.playing;},
    mutation:m=>{m.projectUnchanged=false;},
    overlapAccepted:m=>{m.guards.legacyOverlap=false;},
    limiter:m=>{m.signalOracle.outputPeak=1;},
  };
  for(const mutate of Object.values(controls)){const m=structuredClone(good);mutate(m);assert.equal(assessResidentAudio(m).decision,"BLOCK");}
  process.stdout.write(JSON.stringify({residentEvaluator:"PASS",negativeControls:Object.keys(controls)})+"\n");
}
