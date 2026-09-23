import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {verifyNativeMusicMaster} from '../../scripts/music-only-audio-qa';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function signal(extra=0,gain=1){const b=Buffer.alloc(48000*2*4);for(let n=0;n<48000;n++)for(let c=0;c<2;c++)b.writeFloatLE(gain*.1*Math.sin(2*Math.PI*1000*n/48000)+extra*Math.sin(2*Math.PI*600*n/48000),(n*2+c)*4);return b;}
describe('render-bound native music master proof',()=>{
 it('accepts an independent equivalent PCM with floating-point roundoff',()=>{const reference=signal(),master=Buffer.from(reference);master.writeFloatLE(master.readFloatLE(100)+1e-8,100);expect(hash(master)).not.toBe(hash(reference));expect(verifyNativeMusicMaster(reference,master,hash(master)).metrics.pass).toBe(true)});
 it('rejects a valid waveform with the wrong master identity',()=>{const reference=signal();expect(()=>verifyNativeMusicMaster(reference,reference,'0'.repeat(64))).toThrow(/hash mismatch/)});
 it('rejects voice leakage even when its master SHA is correctly declared',()=>{const reference=signal(),master=signal(.06);expect(()=>verifyNativeMusicMaster(reference,master,hash(master))).toThrow(/independent music-only/)});
 it('rejects silence, changed gain and truncated bytes',()=>{const reference=signal();for(const master of [Buffer.alloc(reference.length),signal(0,.5),reference.subarray(0,reference.length-8)])expect(()=>verifyNativeMusicMaster(reference,master,hash(master))).toThrow()});
 it('rejects nonfinite PCM samples and malformed digests',()=>{const reference=signal(),master=Buffer.from(reference);master.writeFloatLE(NaN,0);expect(()=>verifyNativeMusicMaster(reference,master,hash(master))).toThrow(/Nonfinite/);expect(()=>verifyNativeMusicMaster(reference,reference,'invalid')).toThrow(/Invalid/)});
});
