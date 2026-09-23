import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const coreRoot=join(root,"native","hao-core");
const cargo=process.env.CARGO||join(homedir(),".cargo","bin",process.platform==="win32"?"cargo.exe":"cargo");
const core=join(coreRoot,"target","release",`hao-core${process.platform==="win32"?".exe":""}`);
const evidence=resolve(root,"..","..",".rd","benchmarks","editkin-native-p1-p2");
function run(executable,args,cwd){const result=spawnSync(executable,args,{cwd,encoding:"utf8",windowsHide:true,maxBuffer:8*1024*1024});if(result.status!==0)throw new Error(`${executable} ${args.join(" ")} failed\n${result.stderr||result.stdout}`);return result.stdout.trim();}
run(cargo,["build","--release"],coreRoot);
const first=JSON.parse(run(core,["engine-pipeline-selftest",evidence],coreRoot));
const pngPath=first.scene?.pngPath; const wavPath=first.audio?.wavPath;
const [png,wav]=await Promise.all([readFile(pngPath),readFile(wavPath)]);
if(png.subarray(0,8).toString("hex")!=="89504e470d0a1a0a")throw new Error("native scene evidence is not PNG");
if(wav.subarray(0,4).toString("ascii")!=="RIFF"||wav.subarray(8,12).toString("ascii")!=="WAVE")throw new Error("native audio evidence is not WAV");
const hashes={png:createHash("sha256").update(png).digest("hex"),wav:createHash("sha256").update(wav).digest("hex")};
const second=JSON.parse(run(core,["engine-pipeline-selftest",evidence],coreRoot));
const [pngAgain,wavAgain]=await Promise.all([readFile(second.scene.pngPath),readFile(second.audio.wavPath)]);
const repeat={png:createHash("sha256").update(pngAgain).digest("hex"),wav:createHash("sha256").update(wavAgain).digest("hex")};
if(hashes.png!==repeat.png||hashes.wav!==repeat.wav)throw new Error("native scene/audio pipeline is not deterministic");
if(first.status!=="GREEN"||first.scene.parentedLayers<1||first.scene.trackMatteLayers<1||first.scene.adjustmentPasses<1||first.scene.visibleParticles<1||first.scene.motionBlurSamples<2||first.audio.frames!==48000||first.audio.channels!==2)throw new Error("native P1/P2 receipt is incomplete");
const report={...first,artifactSha256:hashes,deterministicRepeat:true,gate:"editkin-native-pipeline-gate/v1"};
await writeFile(join(evidence,"gate-report.json"),`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify(report,null,2));
