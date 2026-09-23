import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { assessUiMeasurement } from "./lib/ui-usability.mjs";
import { buildManifestIdentityMatches } from "./lib/build-input-identity.mjs";
import { createTauriCdpHarness, delay } from "./lib/tauri-cdp-harness.mjs";
import { runTauriGpuBridge } from "./lib/tauri-cdp-gpu-bridges.mjs";

const executable = resolve(process.argv[2] ?? "src-tauri/target/release/editkin.exe");
const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const expectedReleaseInputManifest = JSON.parse(await readFile(resolve(".release-input-manifest.json"), "utf8"));
const creativeLibraryManifest = JSON.parse(await readFile(resolve(".creative-packs/hao-creator-library/editkin-pack.json"), "utf8"));
const personalMusicManifest = JSON.parse(await readFile(resolve(".personal-packs/hao-music-library/editkin-personal-music.json"), "utf8"));
const ocioCpuReference = JSON.parse(await readFile(resolve("public/color/aces2/gpu/cpu-reference.json"), "utf8"));
const ocioGradeCpuReference = JSON.parse(await readFile(resolve("public/color/aces2/gpu/grade-cpu-reference.json"), "utf8"));
const expectedLibraryAssetCount = creativeLibraryManifest.assetCount + personalMusicManifest.assetCount;
const expectedProjectSchemaVersion = 8;
const expectedTrackingFallbackEngine = "hao-core-rust-motion-track-0.4-region-fallback";
const expectedPlanarTrackingEngine = "hao-core-rust-motion-track-0.4-planar";
const startupPollMs = 200;
const startupInteractiveTimeoutMs = 60_000;
const startupInteractiveAttempts = Math.ceil(startupInteractiveTimeoutMs / startupPollMs);
const planarTrackingFixture = resolve("../../.rd/benchmarks/editkin-planar-tracking/dataset-v1/planar-occlusion.mp4");
const planarTrackingManifest = JSON.parse(await readFile(resolve("../../.rd/benchmarks/editkin-planar-tracking/dataset-v1/ground-truth.json"), "utf8"));
const gpuProductFallbackFixture = resolve("../../.rd/benchmarks/editkin-gpu-product-fallback/source-1920x1080.mp4");
if (!Number.isInteger(expectedLibraryAssetCount) || expectedLibraryAssetCount <= 0) {
  throw new Error("Pack manifests do not declare a valid combined asset count");
}
const currentVersion = packageJson.version;
const versionParts = currentVersion.split(".").map(Number);
if (versionParts.length !== 3 || versionParts.some((part) => !Number.isInteger(part) || part < 0)) throw new Error(`Invalid package version: ${currentVersion}`);
const testUpdateVersion = `${versionParts[0]}.${versionParts[1]}.${versionParts[2] + 1}`;
const port = await new Promise((resolvePromise, reject) => {
  const server = createNetServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const selected = typeof address === "object" && address ? address.port : undefined;
    server.close(() => selected ? resolvePromise(selected) : reject(new Error("Could not allocate CDP port")));
  });
});
const updateArtifact = resolve(`src-tauri/target/release/bundle/nsis/Editkin_${currentVersion}_x64-setup.exe`);
const updateCertificate = resolve("tests/fixtures/update-localhost-cert.pem");
const updateKey = resolve("tests/fixtures/update-localhost-key.pem");
const updateArtifactInfo = await stat(updateArtifact);
const updateHash = createHash("sha256");
for await (const chunk of createReadStream(updateArtifact)) updateHash.update(chunk);
const updateSha256 = updateHash.digest("hex");
let updateOrigin = "";
const updateServer = createHttpsServer({ cert: await readFile(updateCertificate), key: await readFile(updateKey) }, (request, response) => {
  process.stderr.write(`[tauri-smoke] update-server ${request.method} ${request.url}\n`);
  if (request.url === "/stable.json") {
    const manifest = {
      schemaVersion: 1, version: testUpdateVersion, publishedAt: "2026-08-21T13:00:00.000Z", minimumProjectSchema: 3,
      windowsX64: { url: `${updateOrigin}/Editkin_${testUpdateVersion}_x64-setup.exe`, size: updateArtifactInfo.size, sha256: updateSha256 },
    };
    response.writeHead(200, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify(manifest));
    return;
  }
  if (request.url === `/Editkin_${testUpdateVersion}_x64-setup.exe`) {
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": updateArtifactInfo.size, connection: "close" });
    createReadStream(updateArtifact).pipe(response);
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolvePromise, reject) => {
  updateServer.once("error", reject);
  updateServer.listen(0, "127.0.0.1", () => resolvePromise());
});
const updateAddress = updateServer.address();
updateOrigin = `https://localhost:${typeof updateAddress === "object" && updateAddress ? updateAddress.port : 0}`;
const integrationStateParent = resolve("../../.rd/tmp");
await mkdir(integrationStateParent, { recursive: true });
const integrationStateRoot = await mkdtemp(resolve(integrationStateParent, "editkin-cdp-state-"));
const userPluginRoot = resolve(integrationStateRoot, "data/plugins");
const integrationUserPlugin = {
  schema: "editkin.plugin/v1",
  id: "integration.user.creator-tool",
  name: "Integration User Creator Tool",
  version: "1.0.0",
  minimumHostVersion: currentVersion,
  publisher: { name: "Editkin Integration" },
  license: { spdx: "MIT", commercialUse: true },
  permissions: ["project.write"],
  capabilities: [{
    id: "creator-punch",
    name: "Creator Punch",
    description: "A user-installed, schema-bounded creator tool used by the delivered-product gate.",
    kind: "workflow_tool",
    automation: "full",
    semanticRoles: ["hook", "payoff"],
    formats: ["shorts", "longform"],
    requires: [],
    avoidWhen: [],
    parameters: [{ id: "scale", name: "Scale", type: "number", default: 1.08, min: 1, max: 1.2 }],
    runtime: { type: "editgraph_commands", operations: [{ command: "update_clip_transform", template: { patch: { scale: "$parameter.scale" } } }] },
  }],
};
const duplicateBundledPlugin = structuredClone(integrationUserPlugin);
duplicateBundledPlugin.id = "studio.hao.creator-accelerators";
duplicateBundledPlugin.name = "Duplicate Must Not Replace Bundled Plugin";
await mkdir(resolve(userPluginRoot, "integration-user-tool"), { recursive: true });
await mkdir(resolve(userPluginRoot, "duplicate-bundled-id"), { recursive: true });
await writeFile(resolve(userPluginRoot, "integration-user-tool/editkin-plugin.json"), JSON.stringify(integrationUserPlugin), "utf8");
await writeFile(resolve(userPluginRoot, "duplicate-bundled-id/editkin-plugin.json"), JSON.stringify(duplicateBundledPlugin), "utf8");
const child = spawn(executable, [], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    EDITKIN_INTEGRATION_SMOKE: "1",
    EDITKIN_INTEGRATION_STATE_ROOT: integrationStateRoot,
    EDITKIN_UPDATE_MANIFEST_URL: `${updateOrigin}/stable.json`,
    NODE_EXTRA_CA_CERTS: updateCertificate,
    WEBVIEW2_USER_DATA_FOLDER: resolve(integrationStateRoot, "webview2"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
});
child.stdout?.on("data", (chunk) => process.stderr.write(`[editkin-stdout] ${chunk}`));
child.stderr?.on("data", (chunk) => process.stderr.write(`[editkin-stderr] ${chunk}`));

const journeyStartedAt = performance.now();
const journeySteps = [];
function markStep(name) {
  const elapsedMs = Number((performance.now() - journeyStartedAt).toFixed(1));
  journeySteps.push({ name, elapsedMs });
  process.stderr.write(`[tauri-smoke] ${name} ${elapsedMs}ms\n`);
}

const { target, evaluate, cdpCommand, stopOwnedApplication, closeCdp } = createTauriCdpHarness({
  child,
  port,
  startupPollMs,
  startupInteractiveTimeoutMs,
  startupInteractiveAttempts,
});

let page;
try {
  let state = {};
  let startupControllerMisses = 0;
  for (let attempt = 0; attempt < startupInteractiveAttempts; attempt += 1) {
    try {
      page = await target();
      state = await evaluate(page.webSocketDebuggerUrl, "JSON.stringify({tauri:typeof window.__TAURI_INTERNALS__,desktop:typeof window.haoDesktop,isDesktop:window.haoDesktop?.isDesktop,heading:document.querySelector('.brand-copy strong')?.textContent,body:document.body?.innerText?.slice(0,160)??''})", 10_000);
      if (state.tauri === "object" && state.desktop === "object" && state.isDesktop === true && state.heading === "Editkin" && state.body && !state.body.includes("正在載入")) break;
    } catch (error) {
      if (!(error instanceof Error) || (!error.message.includes("timed out") && !error.message.includes("connection closed"))) throw error;
      startupControllerMisses += 1;
    }
    await delay(startupPollMs);
  }
  if (state.tauri !== "object" || state.desktop !== "object" || state.isDesktop !== true || state.heading !== "Editkin" || !state.body || state.body.includes("正在載入")) {
    throw new Error(`Tauri app did not become interactive within ${startupInteractiveTimeoutMs}ms; controller misses=${startupControllerMisses}; state=${JSON.stringify(state)}`);
  }
  markStep("app-ready");
  await evaluate(page.webSocketDebuggerUrl, `(()=>{window.__editkinSmokeTrace=[];const note=(type,value='')=>window.__editkinSmokeTrace.push({type,value:String(value),at:performance.now(),stack:new Error().stack?.slice(0,800)||''});window.addEventListener('error',event=>note('error',event.error?.stack||event.message));window.addEventListener('unhandledrejection',event=>note('unhandledrejection',event.reason?.stack||event.reason));for(const type of ['beforeunload','pagehide','unload'])window.addEventListener(type,event=>note(type,event.type));const root=document.querySelector('#root');if(root)new MutationObserver(()=>{if(!root.childNodes.length)note('root-empty')}).observe(root,{childList:true});return JSON.stringify(true)})()`);
  const embeddedBuildManifest = await evaluate(
    page.webSocketDebuggerUrl,
    "window.__TAURI_INTERNALS__.invoke('release_input_manifest').then(value=>JSON.stringify(value))",
    10_000,
  );
  const buildManifestGreen = buildManifestIdentityMatches(embeddedBuildManifest, expectedReleaseInputManifest);
  markStep("build-manifest");
  const colorResourceBridge = await evaluate(page.webSocketDebuggerUrl, `(()=>{if(typeof window.haoDesktop?.readColorAsset!=='function')return JSON.stringify({status:'BLOCK',reason:'missing-readColorAsset'});const original=window.fetch.bind(window);window.fetch=(input,init)=>{const raw=typeof input==='string'?input:input instanceof URL?input.href:input.url;const url=new URL(raw,document.baseURI);const marker='/color/aces2/';const at=url.pathname.indexOf(marker);if(at<0)return original(input,init);const relative=decodeURIComponent(url.pathname.slice(at+marker.length));return window.haoDesktop.readColorAsset(relative).then(text=>new Response(text,{status:200,headers:{'content-type':relative.endsWith('.json')?'application/json':'text/plain'}}))};return JSON.stringify({status:'GREEN',transport:'bounded-desktop-resource'})})()`);
  if (colorResourceBridge.status !== "GREEN") throw new Error(`Packaged color resource bridge is unavailable: ${JSON.stringify(colorResourceBridge)}`);
  const ocioGpu = await evaluate(page.webSocketDebuggerUrl, `(async()=>{const reference=${JSON.stringify(ocioCpuReference)};const [input,output]=await Promise.all([fetch('color/aces2/gpu/input-rec709.json').then(r=>{if(!r.ok)throw new Error('input shader '+r.status);return r.json()}),fetch('color/aces2/gpu/output-rec709_sdr.json').then(r=>{if(!r.ok)throw new Error('output shader '+r.status);return r.json()})]);const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;const gl=canvas.getContext('webgl2',{alpha:true,antialias:false,premultipliedAlpha:false});if(!gl)return JSON.stringify({status:'BLOCK',reason:'webgl2-unavailable'});const compile=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));return shader};const vertex=compile(gl.VERTEX_SHADER,'#version 300 es\\nin vec2 editkin_position;out vec2 editkin_uv;void main(){editkin_uv=editkin_position*.5+.5;gl_Position=vec4(editkin_position,0.,1.);}');const fragmentSource='#version 300 es\\nprecision highp float;precision highp sampler2D;in vec2 editkin_uv;uniform sampler2D editkin_source;out vec4 editkin_fragment;\\n'+input.shaderText+'\\n'+output.shaderText+'\\nvoid main(){vec4 working='+input.functionName+'(texture(editkin_source,editkin_uv));editkin_fragment='+output.functionName+'(working);}';const fragment=compile(gl.FRAGMENT_SHADER,fragmentSource);const program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));gl.useProgram(program);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);const position=gl.getAttribLocation(program,'editkin_position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);const source=gl.createTexture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,source);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(reference.sourceRgba8));gl.uniform1i(gl.getUniformLocation(program,'editkin_source'),0);let unit=1;for(const definition of [...input.textures,...output.textures]){const texture=gl.createTexture();gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,texture);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);const format=definition.channels===1?gl.RED:gl.RGB;const internal=definition.channels===1?gl.R32F:gl.RGB32F;gl.texImage2D(gl.TEXTURE_2D,0,internal,definition.width,definition.height,0,format,gl.FLOAT,new Float32Array(definition.values));const filter=definition.interpolation==='nearest'?gl.NEAREST:gl.LINEAR;gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.uniform1i(gl.getUniformLocation(program,definition.sampler),unit++)}gl.viewport(0,0,1,1);gl.drawArrays(gl.TRIANGLES,0,6);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);const expected=reference.expectedRgba8;const maxChannelError=Math.max(...expected.map((value,index)=>Math.abs(value-pixel[index])));const debug=gl.getExtension('WEBGL_debug_renderer_info');return JSON.stringify({status:maxChannelError<=2?'GREEN':'BLOCK',ocioVersion:input.ocioVersion,cpuProcessorCacheId:reference.processorCacheId,inputCacheId:input.cacheId,outputCacheId:output.cacheId,inputShaderBytes:input.shaderText.length,outputShaderBytes:output.shaderText.length,textures:input.textures.length+output.textures.length,pixel:[...pixel],expected,maxChannelError,renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)})})()`, 20_000);
  markStep("ocio-gpu-browser-parity");
  const ocioGradeGpu = await evaluate(page.webSocketDebuggerUrl, `(async()=>{
    const reference=${JSON.stringify(ocioGradeCpuReference)};
    const load=async path=>{const response=await fetch(path);if(!response.ok)throw new Error(path+' '+response.status);return response.json()};
    const [input,grade,output]=await Promise.all([load('color/aces2/gpu/input-rec709.json'),load('color/aces2/gpu/grade-primary-tone.json'),load('color/aces2/gpu/output-rec709_sdr.json')]);
    const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;
    const gl=canvas.getContext('webgl2',{alpha:true,antialias:false,premultipliedAlpha:false});if(!gl)return JSON.stringify({status:'BLOCK',reason:'webgl2-unavailable'});
    const compile=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));return shader};
    const vertex=compile(gl.VERTEX_SHADER,'#version 300 es\\nin vec2 editkin_position;out vec2 editkin_uv;void main(){editkin_uv=editkin_position*.5+.5;gl_Position=vec4(editkin_position,0.,1.);}');
    const hue='vec3 editkin_hue_rotate(vec3 rgb){float y=dot(rgb,vec3(.299,.587,.114));float i=dot(rgb,vec3(.595716,-.274453,-.321263));float q=dot(rgb,vec3(.211456,-.522591,.311135));float c=cos(editkin_grade_hue_radians);float s=sin(editkin_grade_hue_radians);float ri=i*c-q*s;float rq=i*s+q*c;return vec3(y+.9563*ri+.621*rq,y-.2721*ri-.6474*rq,y-1.107*ri+1.7046*rq);}';
    const fragment=compile(gl.FRAGMENT_SHADER,'#version 300 es\\nprecision highp float;precision highp sampler2D;in vec2 editkin_uv;uniform sampler2D editkin_source;uniform float editkin_grade_hue_radians;out vec4 editkin_fragment;\\n'+input.shaderText+'\\n'+grade.shaderText+'\\n'+output.shaderText+'\\n'+hue+'\\nvoid main(){vec4 working='+input.functionName+'(texture(editkin_source,editkin_uv));working='+grade.functionName+'(working);working.rgb=editkin_hue_rotate(working.rgb);editkin_fragment='+output.functionName+'(working);}');
    const program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));gl.useProgram(program);
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);const position=gl.getAttribLocation(program,'editkin_position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
    const source=gl.createTexture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,source);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(reference.sourceRgba8));gl.uniform1i(gl.getUniformLocation(program,'editkin_source'),0);
    let unit=1;for(const definition of [...input.textures,...grade.textures,...output.textures]){const texture=gl.createTexture();gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,texture);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);const format=definition.channels===1?gl.RED:gl.RGB;const internal=definition.channels===1?gl.R32F:gl.RGB32F;gl.texImage2D(gl.TEXTURE_2D,0,internal,definition.width,definition.height,0,format,gl.FLOAT,new Float32Array(definition.values));const filter=definition.interpolation==='nearest'?gl.NEAREST:gl.LINEAR;gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.uniform1i(gl.getUniformLocation(program,definition.sampler),unit++)}
    const color=reference.grade;const master=color.brightness*.1+color.exposure/17.52;const clamp=value=>Math.max(.01,Math.min(1.99,value));
    const fauxCubic=(t,x0,x2,y0,y2,m0,m2,reverse)=>{const x1=x0+(x2-x0)*.5;const y1=(.5/(x2-x0))*((2*y0+m0*(x1-x0))*(x2-x1)+(2*y2-m2*(x2-x1))*(x1-x0));if(!reverse){const tl=(t-x0)/(x1-x0),tr=(t-x1)/(x2-x1);const left=y0*(1-tl*tl)+y1*tl*tl+m0*(1-tl)*tl*(x1-x0);const right=y1*(1-tr)**2+y2*(2-tr)*tr+m2*(tr-1)*tr*(x2-x1);return t<x0?y0+(t-x0)*m0:t>x2?y2+(t-x2)*m2:t<x1?left:right}const c0=y0-t,b0=m0*(x1-x0),a0=y1-y0-m0*(x1-x0);const c1=y1-t,b1=2*y2-2*y1-m2*(x2-x1),a1=y1-y2+m2*(x2-x1);const left=(-2*c0)/(Math.sqrt(b0*b0-4*a0*c0)+b0)*(x1-x0)+x0;const right=(-2*c1)/(Math.sqrt(b1*b1-4*a1*c1)+b1)*(x2-x1)+x1;return t<y0?x0+(t-y0)/m0:t>y2?x2+(t-y2)/m2:t<y1?left:right};
    const highlightForward=(t,start,pivot,value)=>{const slope=2-value;return slope<=1?fauxCubic(t,start,pivot,start,pivot,1,Math.max(.01,slope),false):fauxCubic(t,start,pivot,start,pivot,1,Math.max(.01,2-slope),true)};
    const shadowForward=(t,start,pivot,value)=>value<=1?fauxCubic(t,start,pivot,start,pivot,Math.max(.01,value),1,false):fauxCubic(t,start,pivot,start,pivot,Math.max(.01,2-value),1,true);
    const highlights=clamp(1+color.highlights*.5),shadows=clamp(1+color.shadows*.5);const highlightStart=.3,highlightPivot=1,shadowStart=.5,shadowPivot=0;const whiteStart=highlightForward(.4,highlightStart,highlightPivot,highlights),whiteEnd=highlightForward(.9,highlightStart,highlightPivot,highlights),blackStart=shadowForward(.4,shadowPivot,shadowStart,shadows),blackEnd=shadowForward(0,shadowPivot,shadowStart,shadows);
    const values={editkin_grade_grading_primary_brightness:[master+color.temperature*.025,master+color.tint*.02,master-color.temperature*.025].map(value=>value*6.25/1023),editkin_grade_grading_primary_contrast:[color.contrast,color.contrast,color.contrast],editkin_grade_grading_primary_pivot:.5+(.4+(color.pivot-.5)*.4)*.5,editkin_grade_grading_primary_clampBlack:-65504,editkin_grade_grading_primary_clampWhite:65504,editkin_grade_grading_primary_saturation:color.saturation,editkin_grade_grading_primary_localBypass:false,editkin_grade_grading_tone_blacksM:clamp(1+color.blacks*.5),editkin_grade_grading_tone_blacksStart:blackStart,editkin_grade_grading_tone_blacksWidth:blackStart-blackEnd,editkin_grade_grading_tone_shadowsM:shadows,editkin_grade_grading_tone_shadowsStart:shadowStart,editkin_grade_grading_tone_shadowsWidth:shadowPivot,editkin_grade_grading_tone_highlightsM:highlights,editkin_grade_grading_tone_highlightsStart:highlightStart,editkin_grade_grading_tone_highlightsWidth:highlightPivot,editkin_grade_grading_tone_whitesM:clamp(1+color.whites*.5),editkin_grade_grading_tone_whitesStart:whiteStart,editkin_grade_grading_tone_whitesWidth:whiteEnd-whiteStart,editkin_grade_grading_tone_localBypass:false};
    for(const definition of grade.uniforms){const location=gl.getUniformLocation(program,definition.name);const value=Object.hasOwn(values,definition.name)?values[definition.name]:definition.default;if(definition.type==='bool')gl.uniform1i(location,value?1:0);else if(definition.type==='float')gl.uniform1f(location,Number(value));else gl.uniform3fv(location,value)}gl.uniform1f(gl.getUniformLocation(program,'editkin_grade_hue_radians'),color.hue*Math.PI/180);
    gl.viewport(0,0,1,1);gl.drawArrays(gl.TRIANGLES,0,6);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);const expected=reference.expectedRgba8;const maxChannelError=Math.max(...expected.map((value,index)=>Math.abs(value-pixel[index])));return JSON.stringify({status:maxChannelError<=2?'GREEN':'BLOCK',pixel:[...pixel],expected,maxChannelError,gradeCacheId:grade.cacheId,gradeShaderBytes:grade.shaderText.length,dynamicUniforms:grade.uniforms.length});
  })()`, 20_000);
  markStep("ocio-dynamic-grade-gpu-parity");
  const beginnerGuide = await evaluate(page.webSocketDebuggerUrl, `(async()=>{const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));const waitFor=async(predicate,attempts=40)=>{for(let attempt=0;attempt<attempts;attempt+=1){if(predicate())return true;await wait(50)}return false};await waitFor(()=>Boolean(document.querySelector('[data-testid="first-project-start"]')));const shown=Boolean(document.querySelector('[data-testid="beginner-guide"]'));if(shown){document.querySelector('[data-testid="guide-skip"]')?.click()}const dismissed=!shown||await waitFor(()=>!document.querySelector('[data-testid="beginner-guide"]'));const welcomeVisible=Boolean(document.querySelector('[data-testid="first-project-start"]'));const singlePrimaryAction=document.querySelectorAll('[data-beginner-action]').length===1;const firstStepCurrent=document.querySelector('.quick-flow .current')?.dataset.flowStep==='1';const help=document.querySelector('[data-testid="beginner-guide-button"]');help?.click();const reopened=await waitFor(()=>Boolean(document.querySelector('[data-testid="beginner-guide"]')));document.querySelector('[data-testid="guide-skip"]')?.click();await waitFor(()=>!document.querySelector('[data-testid="beginner-guide"]'));document.querySelector('[data-testid="explore-editor-button"]')?.click();for(let attempt=0;attempt<50;attempt+=1){if(document.querySelector('[data-testid="semantic-edit-button"]')&&document.querySelector('[data-testid="asset-preview-entry"]')&&document.querySelector('[data-testid="asset-library-tab"]'))break;await wait(100)}const exploredDemo=Boolean(document.querySelector('[data-testid="demo-workspace-banner"]'));return JSON.stringify({shown,dismissed,reopened,helpAvailable:Boolean(help),welcomeVisible,singlePrimaryAction,firstStepCurrent,exploredDemo,instructionsAvailable:Boolean(document.querySelector('[data-testid="semantic-edit-button"]')||document.querySelector('[data-testid="auto-edit-how"]')),assetPreviewEntryAvailable:Boolean(document.querySelector('[data-testid="asset-preview-entry"]')),assetLibraryTabAvailable:Boolean(document.querySelector('[data-testid="asset-library-tab"]'))})})()`, 12_000);
  await evaluate(page.webSocketDebuggerUrl, `(()=>{const more=document.querySelector('.project-menu');if(more)more.open=true;const group=document.querySelector('.project-menu-group');if(group)group.open=true;const controls=document.querySelector('.workspace-controls');if(controls)controls.open=true;const edit=[...document.querySelectorAll('.workspace-preset-grid button')].find(node=>node.textContent?.includes('剪輯'));edit?.click();if(controls)controls.open=false;if(group)group.open=false;if(more)more.open=false;return JSON.stringify({selected:Boolean(edit)})})()`);
  markStep("beginner-onboarding-to-demo-workspace");
  const creativeLibraryOpened = await evaluate(page.webSocketDebuggerUrl, `(()=>{const tab=document.querySelector('[data-testid="asset-library-tab"]');if(!tab)return JSON.stringify(false);tab.click();return JSON.stringify(true)})()`);
  if (!creativeLibraryOpened) throw new Error("Cold extracted runtime did not expose the creative library entry");
  const coldRuntimeStartedAt = performance.now();
  const coldRuntimeDeadline = coldRuntimeStartedAt + 120_000;
  let coldRuntimeSnapshot = {};
  let coldRuntimeHeartbeats = 0;
  let coldRuntimeControllerMisses = 0;
  while (performance.now() < coldRuntimeDeadline) {
    try {
      page = await target();
      coldRuntimeSnapshot = await evaluate(page.webSocketDebuggerUrl, `(()=>{const tab=document.querySelector('[data-testid="asset-library-tab"]');const library=document.querySelector('[data-testid="creative-library"]');const summary=document.querySelector('.library-heading small')?.textContent||'';const libraryCount=Number(library?.getAttribute('data-library-count')||0);const libraryTotal=Number(library?.getAttribute('data-library-total')||0);const libraryLoading=library?.getAttribute('data-library-loading')==='true';const cards=document.querySelectorAll('.creative-asset-card').length;const media=[...document.querySelectorAll('.creative-preview.ready img,.creative-preview.ready video')];const decodedPreviews=media.filter(node=>node.tagName==='IMG'?node.complete&&node.naturalWidth>0:node.readyState>=2&&node.videoWidth>0).length;const tabSelected=tab?.getAttribute('aria-selected')==='true';return JSON.stringify({rootMounted:Boolean(document.querySelector('#root')?.childNodes.length),timelineInteractive:Boolean(document.querySelector('[data-testid="timeline-ruler"]')),renderInteractive:Boolean(document.querySelector('[data-testid="render-button"]')),librarySummary:summary,libraryCount,libraryTotal,libraryLoading,expectedLibraryCount:${expectedLibraryAssetCount},libraryCards:cards,decodedPreviews,failedPreviews:document.querySelectorAll('.preview-loading.failed').length,tabSelected,libraryReady:tabSelected&&!libraryLoading&&libraryCount===${expectedLibraryAssetCount}&&libraryTotal===${expectedLibraryAssetCount}&&cards>0&&decodedPreviews>0,trace:window.__editkinSmokeTrace||[]})})()`, 5_000);
      coldRuntimeHeartbeats += 1;
      if (coldRuntimeSnapshot.libraryReady && coldRuntimeSnapshot.rootMounted
        && coldRuntimeSnapshot.timelineInteractive && coldRuntimeSnapshot.renderInteractive) break;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Runtime.evaluate timed out")) throw error;
      coldRuntimeControllerMisses += 1;
    }
    await delay(250);
  }
  const coldRuntime = {
    ...coldRuntimeSnapshot,
    elapsedMs: Number((performance.now() - coldRuntimeStartedAt).toFixed(1)),
    uiHeartbeats: coldRuntimeHeartbeats,
    controllerMisses: coldRuntimeControllerMisses,
  };
  if (!coldRuntime.libraryReady || !coldRuntime.rootMounted || !coldRuntime.timelineInteractive || !coldRuntime.renderInteractive) {
    throw new Error(`Cold extracted runtime did not load the creative library while preserving the editor UI: ${JSON.stringify(coldRuntime)}`);
  }
  await evaluate(page.webSocketDebuggerUrl, `(()=>{document.querySelector('[role="tab"][data-user-asset-count]')?.click();return JSON.stringify(true)})()`);
  await delay(100);
  markStep("cold-runtime-library-ready-and-ui-responsive");
  let automaticUpdate = {};
  const automaticUpdateDeadline = performance.now() + 60_000;
  while (performance.now() < automaticUpdateDeadline) {
    try {
      page = await target();
      automaticUpdate = await evaluate(page.webSocketDebuggerUrl, "JSON.stringify({status:document.documentElement.dataset.updateCheck||null,message:document.querySelector('[data-testid=\"agent-status\"]')?.textContent||'',probe:window.__editkinUpdateProbe||null})", 5_000);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Runtime.evaluate timed out")) throw error;
      await delay(250);
      continue;
    }
    if (automaticUpdate.status === "available" || automaticUpdate.status === "ready" || automaticUpdate.status === "error") break;
    await delay(2_000);
  }
  markStep(`automatic-update-${automaticUpdate.status ?? "unknown"}`);
  const fixture = resolve("public/benchmarks/layer-base.mp4");
  const overlay = resolve("public/benchmarks/layer-overlay.mp4");
  const outputPath = resolve("../../.rd/artifacts/editkin-tauri-smoke.mp4");
  await mkdir(resolve("../../.rd/artifacts"), { recursive: true });
  await rm(outputPath, { force: true });
  await evaluate(page.webSocketDebuggerUrl, `(()=>{window.__editkinSmokeAsset={id:'tauri-smoke-asset',name:'layer-base.mp4',kind:'video',uri:${JSON.stringify(fixture)},duration:4,width:640,height:360};return JSON.stringify(true)})()`);
  const preview = await evaluate(page.webSocketDebuggerUrl, "window.haoDesktop.previewUrls([window.__editkinSmokeAsset]).then(value=>JSON.stringify(Object.keys(value)))", 15_000);
  markStep("preview-urls");
  const prepared = await evaluate(page.webSocketDebuggerUrl, "window.haoDesktop.prepareMedia(window.__editkinSmokeAsset).then(value=>JSON.stringify(value))", 120_000);
  markStep("prepare-media");
  const smartCut = await evaluate(page.webSocketDebuggerUrl, `window.haoDesktop.smartCutMedia({sourcePath:${JSON.stringify(fixture)},sourceStart:0,duration:4,fps:30}).then(value=>JSON.stringify(value))`, 120_000);
  markStep("smart-cut");
  const scenes = await evaluate(page.webSocketDebuggerUrl, `window.haoDesktop.detectScenes({sourcePath:${JSON.stringify(fixture)},sourceStart:0,duration:4,fps:30}).then(value=>JSON.stringify(value))`, 120_000);
  markStep("scene-detection");
  const tracking = await evaluate(page.webSocketDebuggerUrl, `window.haoDesktop.analyzeMotionTrack({sourcePath:${JSON.stringify(fixture)},sourceStart:0,duration:1,fps:30,sourceWidth:640,sourceHeight:360,initialTime:0,initialRect:{x:.2,y:.2,width:.3,height:.3}}).then(value=>JSON.stringify(value))`, 120_000);
  markStep("motion-tracking");
  const planarTracking = await evaluate(page.webSocketDebuggerUrl, `window.haoDesktop.analyzeMotionTrack({sourcePath:${JSON.stringify(planarTrackingFixture)},sourceStart:0,duration:${planarTrackingManifest.frameCount / planarTrackingManifest.fps},fps:${planarTrackingManifest.fps},sourceWidth:${planarTrackingManifest.width},sourceHeight:${planarTrackingManifest.height},initialTime:0,initialRect:${JSON.stringify(planarTrackingManifest.initialRect)},sourceSha256:${JSON.stringify(planarTrackingManifest.videoSha256)}}).then(value=>JSON.stringify(value))`, 120_000);
  markStep("planar-motion-tracking");
  const library = await evaluate(page.webSocketDebuggerUrl, "window.haoDesktop.listCreativeLibrary().then(library=>{const publicAsset=library.assets.find(item=>item.redistributable!==false&&item.mediaKind!=='audio');const communityMusic=library.assets.find(item=>item.license==='HAO-COMMUNITY-ASSET-GRANT-1.0');return JSON.stringify({assetCount:library.assetCount,communityMusicCount:library.assets.filter(item=>item.license==='HAO-COMMUNITY-ASSET-GRANT-1.0').length,restrictedAssetCount:library.restrictedAssetCount,creativePathHidden:!('path' in library.assets[0]),publicAssetId:publicAsset.id,communityMusicId:communityMusic.id})})", 120_000);
  markStep("creative-library-read");
  const imported = await evaluate(page.webSocketDebuggerUrl, `(async()=>{const creative=await window.haoDesktop.importCreativeAsset(${JSON.stringify(library.publicAssetId)});const music=await window.haoDesktop.importCreativeAsset(${JSON.stringify(library.communityMusicId)});const creativePreview=await window.haoDesktop.previewUrls([creative.asset]);const musicPreview=await window.haoDesktop.previewCreativeAsset(${JSON.stringify(library.communityMusicId)});return JSON.stringify({creativePortable:creative.asset.uri.startsWith('creative://'),musicPortable:music.asset.uri.startsWith('creative://'),musicRole:music.asset.role,musicRedistributable:music.asset.redistributable===true,musicPreview:typeof musicPreview==='string'&&musicPreview.length>0,creativePreview:Object.keys(creativePreview)})})()`, 120_000);
  markStep("creative-library-import");
  const gpuBridgeContext = { evaluate, webSocketDebuggerUrl: page.webSocketDebuggerUrl, fixture, overlay, userPluginRoot };
  const gpuStagingBridge = await runTauriGpuBridge("gpuStagingBridge", gpuBridgeContext);
  markStep("gpu-resident-staging-bridge");
  const gpuCommonEngineBridge = await runTauriGpuBridge("gpuCommonEngineBridge", gpuBridgeContext);
  markStep("gpu-common-engine-bridge");
  const gpuNative25dBridge = await runTauriGpuBridge("gpuNative25dBridge", gpuBridgeContext);
  markStep("gpu-native-25d-bridge");
  const gpuNativeParticleVfxBridge = await runTauriGpuBridge("gpuNativeParticleVfxBridge", gpuBridgeContext);
  markStep("gpu-native-particle-vfx-bridge");
  const gpuCommonVideoEngineBridge = await runTauriGpuBridge("gpuCommonVideoEngineBridge", gpuBridgeContext);
  markStep("gpu-common-video-engine-bridge");
  const gpuCommonVideoPqPreviewBridge = await runTauriGpuBridge("gpuCommonVideoPqPreviewBridge", gpuBridgeContext);
  markStep("gpu-common-video-pq-preview-bridge");
  const gpuCommonVideoParticleBridge = await runTauriGpuBridge("gpuCommonVideoParticleBridge", gpuBridgeContext);
  markStep("gpu-common-video-particle-bridge");
  const gpuCommonVideoAdjustmentBridge = await runTauriGpuBridge("gpuCommonVideoAdjustmentBridge", gpuBridgeContext);
  markStep("gpu-common-video-adjustment-bridge");
  const gpuCommonVideoTopologyBridge = await runTauriGpuBridge("gpuCommonVideoTopologyBridge", gpuBridgeContext);
  markStep("gpu-common-video-topology-bridge");
  const gpuCommonVideoCompositeBridge = await runTauriGpuBridge("gpuCommonVideoCompositeBridge", gpuBridgeContext);
  markStep("gpu-common-video-composite-bridge");
  const gpuCommonVideoMultitrackBridge = await runTauriGpuBridge("gpuCommonVideoMultitrackBridge", gpuBridgeContext);
  markStep("gpu-common-video-multitrack-bridge");
  const gpuCommonVideoGradeBridge = await runTauriGpuBridge("gpuCommonVideoGradeBridge", gpuBridgeContext);
  markStep("gpu-common-video-grade-bridge");
  const gpuCommonVideoAnimationBridge = await runTauriGpuBridge("gpuCommonVideoAnimationBridge", gpuBridgeContext);
  markStep("gpu-common-video-animation-bridge");
  const gpuCommonVideoCaptionBridge = await runTauriGpuBridge("gpuCommonVideoCaptionBridge", gpuBridgeContext);
  markStep("gpu-common-video-caption-bridge");
  const gpuCommonVideoMotionGraphicBridge = await runTauriGpuBridge("gpuCommonVideoMotionGraphicBridge", gpuBridgeContext);
  markStep("gpu-common-video-motion-graphic-bridge");
  const gpuCommonVideoTemporalTypographyBridge = await runTauriGpuBridge("gpuCommonVideoTemporalTypographyBridge", gpuBridgeContext);
  markStep("gpu-common-video-temporal-typography-bridge");
  const gpuCommonVideoTemporalAdjustmentBridge = await runTauriGpuBridge("gpuCommonVideoTemporalAdjustmentBridge", gpuBridgeContext);
  markStep("gpu-common-video-temporal-adjustment-bridge");
  const gpuCommonVideoTemporalPartialOverlayLookBridge = await runTauriGpuBridge("gpuCommonVideoTemporalPartialOverlayLookBridge", gpuBridgeContext);
  markStep("gpu-common-video-temporal-partial-overlay-look-bridge");
  const gpuCommonVideoTemporalMultiOverlayLookBridge = await runTauriGpuBridge("gpuCommonVideoTemporalMultiOverlayLookBridge", gpuBridgeContext);
  markStep("gpu-common-video-temporal-multi-overlay-look-bridge");
  const gpuCommonVideoTemporalMultiAdjustmentLookBridge = await runTauriGpuBridge("gpuCommonVideoTemporalMultiAdjustmentLookBridge", gpuBridgeContext);
  markStep("gpu-common-video-temporal-multi-adjustment-look-bridge");
  const gpuCommonVideoTemporalParticleLookBridge = await runTauriGpuBridge("gpuCommonVideoTemporalParticleLookBridge", gpuBridgeContext);
  markStep("gpu-common-video-temporal-particle-multi-adjustment-look-bridge");
  const gpuCommonVideoTemporalParticleAnimatedOverlayMultiAdjustmentLookBridge = await runTauriGpuBridge("gpuCommonVideoTemporalParticleAnimatedOverlayMultiAdjustmentLookBridge", gpuBridgeContext);
  markStep("gpu-common-video-temporal-particle-animated-overlay-multi-adjustment-look-bridge");
  const gpuCommonVideoTemporalParticleOverlayMultiAdjustmentLookBridge = await runTauriGpuBridge("gpuCommonVideoTemporalParticleOverlayMultiAdjustmentLookBridge", gpuBridgeContext);
  markStep("gpu-common-video-temporal-particle-overlay-multi-adjustment-look-bridge");
  const gpuCommonVideoTemporalParticlePartialOverlayMultiAdjustmentLookBridge = await runTauriGpuBridge("gpuCommonVideoTemporalParticlePartialOverlayMultiAdjustmentLookBridge", gpuBridgeContext);
  markStep("gpu-common-video-temporal-particle-partial-overlay-multi-adjustment-look-bridge");
  const gpuCommonVideoTemporalMatteBridge = await runTauriGpuBridge("gpuCommonVideoTemporalMatteBridge", gpuBridgeContext);
  markStep("gpu-common-video-temporal-matte-bridge");
  const gpuNativeSurfaceBridge = await runTauriGpuBridge("gpuNativeSurfaceBridge", gpuBridgeContext);
  markStep("gpu-native-surface-bridge");
  const gpuFaultRecoveryBridge = await runTauriGpuBridge("gpuFaultRecoveryBridge", gpuBridgeContext);
  markStep("gpu-device-loss-recovery-bridge");
  const userPluginBridge = await runTauriGpuBridge("userPluginBridge", gpuBridgeContext);
  markStep("user-plugin-install-bridge");
  const gpuBundledPluginBridge = await runTauriGpuBridge("gpuBundledPluginBridge", gpuBridgeContext);
  markStep("bundled-gpu-plugin-bridge");
  const bridge = {
    preview,
    assetId: prepared.assetId,
    cacheHit: prepared.cacheHit,
    derivatives: Object.keys(prepared.derivatives),
    runtime: Object.keys(prepared.runtimeUrls),
    smartCutEngine: smartCut.engine,
    smartCutRangeCount: smartCut.ranges.length,
    automaticCaption: await evaluate(page.webSocketDebuggerUrl, "JSON.stringify(typeof window.haoDesktop.automaticCaptionMedia)"),
    batch: await evaluate(page.webSocketDebuggerUrl, "JSON.stringify([typeof window.haoDesktop.pickBatchMedia,typeof window.haoDesktop.getBatchSession,typeof window.haoDesktop.runBatchAutoEditItem,typeof window.haoDesktop.openBatchProject])"),
    sceneEngine: scenes.engine,
    trackingEngine: tracking.engine,
    trackingPoints: tracking.points.length,
    planarTrackingEngine: planarTracking.engine,
    planarTrackingPoints: planarTracking.points.length,
    planarTrackingDiagnostics: planarTracking.points.filter((point) => point.planarDiagnostics && point.planarDiagnostics.inliers >= 8).length,
    planarTrackingSceneCutFalseLocks: planarTracking.points.slice(79, 85).filter((point) => point.status === "tracked").length,
    mobile: await evaluate(page.webSocketDebuggerUrl, "JSON.stringify(typeof window.haoDesktop.startMobileRemote)"),
    recovery: await evaluate(page.webSocketDebuggerUrl, "JSON.stringify([typeof window.haoDesktop.loadRecovery,typeof window.haoDesktop.saveRecovery,typeof window.haoDesktop.clearRecovery])"),
    gpuStaging: gpuStagingBridge,
    gpuCommonEngine: gpuCommonEngineBridge,
    gpuNative25d: gpuNative25dBridge,
    gpuNativeParticleVfx: gpuNativeParticleVfxBridge,
    gpuCommonVideoEngine: gpuCommonVideoEngineBridge,
    gpuCommonVideoPqPreview: gpuCommonVideoPqPreviewBridge,
    gpuCommonVideoParticle: gpuCommonVideoParticleBridge,
    gpuCommonVideoAdjustment: gpuCommonVideoAdjustmentBridge,
    gpuCommonVideoTopology: gpuCommonVideoTopologyBridge,
    gpuCommonVideoComposite: gpuCommonVideoCompositeBridge,
    gpuCommonVideoMultitrack: gpuCommonVideoMultitrackBridge,
    gpuCommonVideoGrade: gpuCommonVideoGradeBridge,
    gpuCommonVideoAnimation: gpuCommonVideoAnimationBridge,
    gpuCommonVideoCaption: gpuCommonVideoCaptionBridge,
    gpuCommonVideoMotionGraphic: gpuCommonVideoMotionGraphicBridge,
    gpuCommonVideoTemporalTypography: gpuCommonVideoTemporalTypographyBridge,
    gpuCommonVideoTemporalAdjustment: gpuCommonVideoTemporalAdjustmentBridge,
    gpuCommonVideoTemporalPartialOverlayLook: gpuCommonVideoTemporalPartialOverlayLookBridge,
    gpuCommonVideoTemporalMultiOverlayLook: gpuCommonVideoTemporalMultiOverlayLookBridge,
    gpuCommonVideoTemporalMultiAdjustmentLook: gpuCommonVideoTemporalMultiAdjustmentLookBridge,
    gpuCommonVideoTemporalParticleLook: gpuCommonVideoTemporalParticleLookBridge,
    gpuCommonVideoTemporalParticleAnimatedOverlayMultiAdjustmentLook: gpuCommonVideoTemporalParticleAnimatedOverlayMultiAdjustmentLookBridge,
    gpuCommonVideoTemporalParticleOverlayMultiAdjustmentLook: gpuCommonVideoTemporalParticleOverlayMultiAdjustmentLookBridge,
    gpuCommonVideoTemporalParticlePartialOverlayMultiAdjustmentLook: gpuCommonVideoTemporalParticlePartialOverlayMultiAdjustmentLookBridge,
    gpuCommonVideoTemporalMatte: gpuCommonVideoTemporalMatteBridge,
    gpuNativeSurface: gpuNativeSurfaceBridge,
    gpuFaultRecovery: gpuFaultRecoveryBridge,
    userPlugin: userPluginBridge,
    gpuBundledPlugin: gpuBundledPluginBridge,
    creativeCount: library.assetCount,
    communityMusicCount: library.communityMusicCount,
    restrictedAssetCount: library.restrictedAssetCount,
    creativePathHidden: library.creativePathHidden,
    ...imported,
  };
  markStep("media-and-library-bridge");
  await evaluate(page.webSocketDebuggerUrl, `(()=>{const api=window.haoDesktop;const original=api.saveRecovery.bind(api);window.__editkinRecoveryTrace={calls:0,completes:0,errors:[]};api.saveRecovery=async(...args)=>{window.__editkinRecoveryTrace.calls+=1;try{const value=await original(...args);window.__editkinRecoveryTrace.completes+=1;return value}catch(error){window.__editkinRecoveryTrace.errors.push(String(error));throw error}};return JSON.stringify({installed:true})})()`);
  const editorUi = await evaluate(page.webSocketDebuggerUrl, `(async()=>{const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));const playhead=()=>document.querySelector('[data-testid="timeline-playhead"]');const play=()=>document.querySelector('.preview-play');const selectedClip=()=>document.querySelector('.timeline-clip[data-duration]');const ruler=document.querySelector('[data-testid="timeline-ruler"]');const durationBeforeInvalid=Number(selectedClip()?.dataset.duration);const startRect=ruler.getBoundingClientRect();ruler.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:startRect.left,clientY:startRect.top+4}));await wait(80);document.querySelector('[data-testid="trim-end-button"]')?.click();await wait(80);const durationAfterInvalid=Number(selectedClip()?.dataset.duration);const invalidStatus=Number.isFinite(durationBeforeInvalid)&&durationBeforeInvalid===durationAfterInvalid;const survivedInvalidCommand=Boolean(document.querySelector('[data-testid="timeline-ruler"]'));const before=playhead()?.getBoundingClientRect().left||0;const playbackStartedAt=performance.now();play()?.click();let after=before;while(after<=before&&performance.now()-playbackStartedAt<3000){await wait(50);after=playhead()?.getBoundingClientRect().left||0}const playbackStartLatencyMs=performance.now()-playbackStartedAt;play()?.click();const volume=document.querySelector('[data-testid="clip-volume-input"]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(volume,'65');volume.dispatchEvent(new Event('input',{bubbles:true}));await wait(80);const volumeStatus=volume.value==='65';const rect=ruler.getBoundingClientRect();ruler.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:rect.left+rect.width*.10,clientY:rect.top+4}));await wait(80);document.querySelector('[data-testid="trim-end-button"]')?.click();await wait(80);const trimmedDuration=Number(selectedClip()?.dataset.duration);const trimStatus=Math.abs(trimmedDuration-1.2)<1e-6;const keyBefore=playhead()?.getBoundingClientRect().left||0;window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));await wait(50);const keyAfter=playhead()?.getBoundingClientRect().left||0;let autosave={found:false};const recoveryDeadline=performance.now()+5000;do{autosave=await window.haoDesktop.loadRecovery();const recoveryClip=autosave.found?autosave.snapshot.project.tracks[0]?.clips[0]:null;if(autosave.found&&recoveryClip?.volume===0.65&&recoveryClip?.duration===1.2)break;await wait(100)}while(performance.now()<recoveryDeadline);const saveState=document.querySelector('[data-testid="save-state"]')?.textContent||'';await window.haoDesktop.clearRecovery();const cleared=await window.haoDesktop.loadRecovery();const metrics=[...document.querySelectorAll('.metric-grid strong')].map(node=>node.textContent);return JSON.stringify({before,after,playbackStartLatencyMs,invalidStatus,durationBeforeInvalid,durationAfterInvalid,survivedInvalidCommand,volume:volume.value,volumeStatus,trimStatus,trimmedDuration,shortcutMoved:keyAfter<keyBefore,autosaveFound:autosave.found===true,autosaveVolume:autosave.found?autosave.snapshot.project.tracks[0].clips[0].volume:null,autosaveDuration:autosave.found?autosave.snapshot.project.tracks[0].clips[0].duration:null,clearVerified:cleared.found===false,saveState,metrics,recoveryTrace:window.__editkinRecoveryTrace})})()`, 15_000);
  const runGpuProductFallback = () => evaluate(page.webSocketDebuggerUrl, `(async()=>{
    const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
    const waitFor=async(predicate,timeout=12000)=>{const deadline=performance.now()+timeout;while(performance.now()<deadline){const value=predicate();if(value)return value;await wait(50)}return undefined};
    const waitForRecoveryIdle=async(timeout=10000,quietMilliseconds=900)=>{const deadline=performance.now()+timeout;let observedCalls=-1;let quietSince=performance.now();while(performance.now()<deadline){const settled=trace.calls===trace.completes+trace.errors.length;if(trace.calls!==observedCalls||!settled){observedCalls=trace.calls;quietSince=performance.now()}else if(performance.now()-quietSince>=quietMilliseconds)return true;await wait(50)}return false};
    const api=window.haoDesktop;const trace=window.__editkinRecoveryTrace;
    if(!api||!trace||typeof api.presentGpuVideoPreviewAtTime!=='function'||typeof api.presentGpuEngineVideoPreviewFrame!=='function')return JSON.stringify({status:'BLOCK',reason:'fallback-prerequisites-missing'});
    const faultEntries=['loadGpuPreviewSession','updateGpuPreviewProperties','renderGpuPreviewFrame','loadGpuEnginePreviewSession','updateGpuEnginePreviewFrame','loadGpuEngineVideoPreviewSession','presentGpuEngineVideoPreviewFrame','openGpuVideoPreviewSession','decodeGpuVideoPreviewAtTime','presentGpuVideoPreviewAtTime'];
    const gpuCallTrace=[];const observedOriginals=Object.fromEntries(faultEntries.map(key=>[key,api[key]]));
    for(const [key,original] of Object.entries(observedOriginals))if(typeof original==='function')api[key]=async(...args)=>{gpuCallTrace.push({key,phase:'call'});try{const value=await original(...args);gpuCallTrace.push({key,phase:'complete'});return value}catch(error){gpuCallTrace.push({key,phase:'error',error:String(error)});throw error}};
    window.confirm=()=>true;document.querySelector('[data-testid="new-project-button"]')?.click();await wait(150);
    // Exercise the delivered desktop drag/drop import boundary. A browser File input intentionally
    // creates a local:// blob-only asset, which the native decoder must reject because it has no
    // durable OS path. The Tauri drop event enters importMediaPaths -> onPicked -> React project state.
    await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tauri://drag-drop',payload:{paths:[${JSON.stringify(gpuProductFallbackFixture)}],position:{x:320,y:240}}});
    const imported=Boolean(await waitFor(()=>document.querySelector('.asset-row')?.textContent?.includes('source-1920x1080.mp4')&&document.querySelector('.timeline-clip'),30000));
    const ruler=document.querySelector('[data-testid="timeline-ruler"]');if(!imported||!ruler)return JSON.stringify({status:'BLOCK',reason:'video-import-failed'});
    const engineBefore=await api.gpuEngineStatus();
    const warmRect=ruler.getBoundingClientRect();
    ruler.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:warmRect.left+warmRect.width*.16,clientY:warmRect.top+4}));
    const acceleratedBefore=Boolean(await waitFor(()=>document.querySelector('[data-testid="native-gpu-surface"]')||[...document.querySelectorAll('.preview-badges span')].find(node=>node.textContent?.includes('原生 GPU'))));
    const mediaPrepared=Boolean(await waitFor(()=>{const thumbnail=document.querySelector('.asset-row .asset-thumb img');return thumbnail instanceof HTMLImageElement&&thumbnail.complete&&thumbnail.naturalWidth>0},30000));
    const recoveryIdleBefore=await waitForRecoveryIdle();
    const previewStage=document.querySelector('.preview-stage');const previewStateBefore={badge:[...document.querySelectorAll('.preview-badges span')].map(node=>node.textContent),stageClass:previewStage?.className??null,admission:previewStage?.dataset.gpuPreviewAdmission??null,fallbackReason:previewStage?.dataset.gpuPreviewFallbackReason??null,admissionDiagnostic:JSON.parse(previewStage?.dataset.gpuPreviewAdmissionDiagnostic||'null'),nativeBounds:previewStage?.getBoundingClientRect().toJSON?.()??null,status:document.querySelector('[data-testid="agent-status"]')?.textContent??null};
    const clipBefore=document.querySelector('.timeline-clip');
    const projectInvariantBefore={timelineStart:clipBefore?.dataset.timelineStart??null,duration:clipBefore?.dataset.duration??null,volume:document.querySelector('[data-testid="clip-volume-input"]')?.value??null,saveCalls:trace.calls};
    const originals=Object.fromEntries(faultEntries.map(key=>[key,api[key]]));
    let forcedCalls=0;
    const forceUnsupported=async()=>{forcedCalls+=1;throw new Error('GPU_UNSUPPORTED: forced product fallback')};
    for(const key of faultEntries)if(typeof api[key]==='function')api[key]=forceUnsupported;
    const firstRect=ruler.getBoundingClientRect();
    ruler.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:firstRect.left+firstRect.width*.20,clientY:firstRect.top+4}));
    const fallbackBadge=await waitFor(()=>[...document.querySelectorAll('.preview-badges span')].find(node=>node.textContent?.includes('相容預覽')));
    const compatiblePreview=Boolean(fallbackBadge&&document.querySelector('.preview-layer')&&!document.querySelector('[data-testid="native-gpu-surface"]'));
    for(const [key,value] of Object.entries(originals))api[key]=value;
    const secondRect=ruler.getBoundingClientRect();
    ruler.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:secondRect.left+secondRect.width*.24,clientY:secondRect.top+4}));
    const acceleratedRestored=Boolean(await waitFor(()=>document.querySelector('[data-testid="native-gpu-surface"]')||[...document.querySelectorAll('.preview-badges span')].find(node=>node.textContent?.includes('原生 GPU'))));
    const recoveryIdleAfter=await waitForRecoveryIdle();
    const engineAfter=await api.gpuEngineStatus();
    const clipAfter=document.querySelector('.timeline-clip');
    const projectInvariantAfter={timelineStart:clipAfter?.dataset.timelineStart??null,duration:clipAfter?.dataset.duration??null,volume:document.querySelector('[data-testid="clip-volume-input"]')?.value??null,saveCalls:trace.calls};
    const projectTruthStable=JSON.stringify(projectInvariantBefore)===JSON.stringify(projectInvariantAfter);
    const traceEvents=window.__editkinSmokeTrace||[];
    const runtimeStable=Boolean(document.querySelector('#root')?.childNodes.length)&&!traceEvents.some(event=>['error','unhandledrejection','root-empty'].includes(event.type));
    const green=acceleratedBefore&&mediaPrepared&&recoveryIdleBefore&&forcedCalls>=1&&compatiblePreview&&acceleratedRestored&&recoveryIdleAfter&&projectTruthStable&&runtimeStable
      &&engineBefore.available===true&&engineAfter.available===true&&engineAfter.status.generation>engineBefore.status.generation
      &&engineAfter.ready.engine==='editkin-wgpu-resident-engine/v1'&&engineAfter.status.videoBackend==='Dx12';
    return JSON.stringify({status:green?'GREEN':'BLOCK',acceleratedBefore,mediaPrepared,recoveryIdleBefore,forcedCalls,compatiblePreview,acceleratedRestored,recoveryIdleAfter,projectTruthStable,projectWriteDelta:projectInvariantAfter.saveCalls-projectInvariantBefore.saveCalls,runtimeStable,projectInvariantBefore,projectInvariantAfter,recoveryErrors:[...trace.errors],previewStateBefore,gpuCallTrace,engineBefore:{generation:engineBefore.status.generation,adapter:engineBefore.status.adapter,backend:engineBefore.status.backend,videoBackend:engineBefore.status.videoBackend},engineAfter:{generation:engineAfter.status.generation,adapter:engineAfter.status.adapter,backend:engineAfter.status.backend,videoBackend:engineAfter.status.videoBackend}});
  })()`, 60_000);
  const dragGeometry = await evaluate(page.webSocketDebuggerUrl, `(()=>{const node=document.querySelector('[data-testid="timeline-clip-clip-demo"]');const box=node?.getBoundingClientRect();window.__editkinTimelineLongTasks=0;window.__editkinTimelineLongTaskObserver?.disconnect?.();window.__editkinTimelineLongTaskObserver=typeof PerformanceObserver==='function'?new PerformanceObserver(list=>{window.__editkinTimelineLongTasks+=list.getEntries().length}):null;try{window.__editkinTimelineLongTaskObserver?.observe({type:'longtask',buffered:false})}catch{}return JSON.stringify({found:Boolean(node),x:(box?.left||0)+Math.min(40,(box?.width||0)/2),y:(box?.top||0)+(box?.height||0)/2,start:Number(node?.dataset.timelineStart),clipDomCount:document.querySelectorAll('.timeline-clip').length})})()`);
  const timelineLatencies = [];
  if (dragGeometry.found) {
    await cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchMouseEvent", { type: "mousePressed", x: dragGeometry.x, y: dragGeometry.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
    for (const offset of Array.from({ length: 24 }, (_, index) => (index + 1) * 4)) {
      const visible = evaluate(page.webSocketDebuggerUrl, `(async()=>{const node=document.querySelector('[data-testid="timeline-clip-clip-demo"]');const before=node?.dataset.timelineStart;const started=performance.now();for(let frame=0;frame<8;frame+=1){await new Promise(resolve=>requestAnimationFrame(resolve));if(node?.dataset.timelineStart!==before)return JSON.stringify({changed:true,latencyMs:performance.now()-started,start:Number(node?.dataset.timelineStart)})}return JSON.stringify({changed:false,latencyMs:performance.now()-started,start:Number(node?.dataset.timelineStart)})})()`, 5_000);
      await cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchMouseEvent", { type: "mouseMoved", x: dragGeometry.x + offset, y: dragGeometry.y, button: "left", buttons: 1, modifiers: 1, pointerType: "mouse" });
      timelineLatencies.push({ ...(await visible), offset });
    }
    await cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchMouseEvent", { type: "mouseReleased", x: dragGeometry.x + 96, y: dragGeometry.y, button: "left", buttons: 0, modifiers: 1, clickCount: 1, pointerType: "mouse" });
  }
  await delay(120);
  const afterDragStart = await evaluate(page.webSocketDebuggerUrl, "JSON.stringify(Number(document.querySelector('[data-testid=\"timeline-clip-clip-demo\"]')?.dataset.timelineStart))");
  await cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
  await cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
  await delay(100);
  const afterSingleUndoStart = await evaluate(page.webSocketDebuggerUrl, "JSON.stringify(Number(document.querySelector('[data-testid=\"timeline-clip-clip-demo\"]')?.dataset.timelineStart))");
  await cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchKeyEvent", { type: "keyDown", key: "y", code: "KeyY", windowsVirtualKeyCode: 89, nativeVirtualKeyCode: 89, modifiers: 2 });
  await cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchKeyEvent", { type: "keyUp", key: "y", code: "KeyY", windowsVirtualKeyCode: 89, nativeVirtualKeyCode: 89, modifiers: 2 });
  const timelineDurable = await evaluate(page.webSocketDebuggerUrl, `(async()=>{const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));window.__editkinTimelineLongTaskObserver?.disconnect?.();let recovery={found:false};let clip=null;let start=Number(document.querySelector('[data-testid="timeline-clip-clip-demo"]')?.dataset.timelineStart);const recoveryDeadline=performance.now()+5000;do{recovery=await window.haoDesktop.loadRecovery();clip=recovery.found?recovery.snapshot.project.tracks.flatMap(track=>track.clips).find(item=>item.id==='clip-demo'):null;start=Number(document.querySelector('[data-testid="timeline-clip-clip-demo"]')?.dataset.timelineStart);if(recovery.found&&clip&&Math.abs(clip.timelineStart-start)<1e-6)break;await wait(100)}while(performance.now()<recoveryDeadline);return JSON.stringify({start,autosaveFound:recovery.found===true,autosaveStart:clip?.timelineStart??null,longTasks:window.__editkinTimelineLongTasks||0,rootMounted:Boolean(document.querySelector('#root')?.childNodes.length)})})()`, 10_000);
  const sortedTimelineLatencies = timelineLatencies.map((sample) => sample.latencyMs).sort((left, right) => left - right);
  const timelineDirectManipulation = {
    realPointerInput: dragGeometry.found,
    samples: timelineLatencies.length,
    allVisibleUpdates: timelineLatencies.every((sample) => sample.changed),
    visibleUpdateCount: timelineLatencies.filter((sample) => sample.changed).length,
    missedVisibleUpdateOffsets: timelineLatencies.filter((sample) => !sample.changed).map((sample) => sample.offset),
    inputToVisibleP50Ms: sortedTimelineLatencies[Math.max(0, Math.ceil(sortedTimelineLatencies.length * 0.5) - 1)] ?? null,
    inputToVisibleP95Ms: sortedTimelineLatencies[Math.max(0, Math.ceil(sortedTimelineLatencies.length * 0.95) - 1)] ?? null,
    startBefore: dragGeometry.start,
    startAfterDrag: afterDragStart,
    startAfterSingleUndo: afterSingleUndoStart,
    startAfterRedo: timelineDurable.start,
    singleUndoRestoredOrigin: Math.abs(afterSingleUndoStart - dragGeometry.start) < 1e-6,
    durableAutosave: timelineDurable.autosaveFound && Math.abs(timelineDurable.autosaveStart - afterDragStart) < 1e-6,
    longTasks: timelineDurable.longTasks,
    rootMounted: timelineDurable.rootMounted,
    materializedClipCount: dragGeometry.clipDomCount,
  };
  timelineDirectManipulation.status = timelineDirectManipulation.realPointerInput && timelineDirectManipulation.samples === 24
    && timelineDirectManipulation.allVisibleUpdates && timelineDirectManipulation.inputToVisibleP95Ms <= 50
    && timelineDirectManipulation.startAfterDrag > timelineDirectManipulation.startBefore
    && timelineDirectManipulation.singleUndoRestoredOrigin && timelineDirectManipulation.startAfterRedo === timelineDirectManipulation.startAfterDrag
    && timelineDirectManipulation.durableAutosave && timelineDirectManipulation.longTasks === 0 && timelineDirectManipulation.rootMounted ? "GREEN" : "BLOCK";
  markStep("timeline-direct-manipulation");
  const invalidDropGeometry = await evaluate(page.webSocketDebuggerUrl, `(()=>{const clip=document.querySelector('[data-testid="timeline-clip-clip-demo"]');const row=clip?.closest('.timeline-row');const label=row?.querySelector('.track-label');const lane=row?.querySelector('.track-lane');const clipBox=clip?.getBoundingClientRect();const labelBox=label?.getBoundingClientRect();const laneBox=lane?.getBoundingClientRect();return JSON.stringify({found:Boolean(clip&&label&&lane),start:Number(clip?.dataset.timelineStart),fromX:(clipBox?.left||0)+Math.min(32,(clipBox?.width||0)/2),fromY:(clipBox?.top||0)+(clipBox?.height||0)/2,toX:(labelBox?.left||0)+(labelBox?.width||0)/2,toY:(labelBox?.top||0)+(labelBox?.height||0)/2,laneLeft:laneBox?.left||0})})()`);
  let invalidDropDuring = { state: null, clipLeft: 0 };
  if (invalidDropGeometry.found) {
    await cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchMouseEvent", { type: "mousePressed", x: invalidDropGeometry.fromX, y: invalidDropGeometry.fromY, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
    await cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchMouseEvent", { type: "mouseMoved", x: invalidDropGeometry.toX, y: invalidDropGeometry.toY, button: "left", buttons: 1, pointerType: "mouse" });
    await delay(80);
    invalidDropDuring = await evaluate(page.webSocketDebuggerUrl, `(()=>{const clip=document.querySelector('[data-testid="timeline-clip-clip-demo"]');return JSON.stringify({state:document.querySelector('[data-testid="timeline-scroll"]')?.dataset.dropState||null,clipLeft:clip?.getBoundingClientRect().left||0})})()`);
    await cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchMouseEvent", { type: "mouseReleased", x: invalidDropGeometry.toX, y: invalidDropGeometry.toY, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
    await delay(120);
  }
  const invalidDropAfter = await evaluate(page.webSocketDebuggerUrl, `(()=>{const clip=document.querySelector('[data-testid="timeline-clip-clip-demo"]');return JSON.stringify({start:Number(clip?.dataset.timelineStart),dropState:document.querySelector('[data-testid="timeline-scroll"]')?.dataset.dropState||null})})()`);
  const timelineDropBoundary = {
    realPointerInput: invalidDropGeometry.found,
    startBefore: invalidDropGeometry.start,
    startAfter: invalidDropAfter.start,
    invalidStateVisible: invalidDropDuring.state === "invalid",
    stayedOutOfTrackHeader: invalidDropDuring.clipLeft >= invalidDropGeometry.laneLeft,
    transientStateCleared: invalidDropAfter.dropState === null,
  };
  timelineDropBoundary.status = timelineDropBoundary.realPointerInput
    && Math.abs(timelineDropBoundary.startAfter - timelineDropBoundary.startBefore) < 1e-6
    && timelineDropBoundary.invalidStateVisible && timelineDropBoundary.stayedOutOfTrackHeader
    && timelineDropBoundary.transientStateCleared ? "GREEN" : "BLOCK";
  markStep("timeline-drop-boundary");
  let uiPrerequisites = {};
  for (let attempt = 0; attempt < 20; attempt += 1) {
    uiPrerequisites = await evaluate(page.webSocketDebuggerUrl, "JSON.stringify({theme:Boolean(document.querySelector('[data-testid=\"theme-select\"]')),inspector:Boolean(document.querySelector('.field-label')),timeline:Boolean(document.querySelector('.timeline-toolbar button')),status:Boolean(document.querySelector('.status-bar'))})");
    if (Object.values(uiPrerequisites).every(Boolean)) break;
    await delay(100);
  }
  if (!Object.values(uiPrerequisites).every(Boolean)) {
    const uiDiagnostic = await evaluate(page.webSocketDebuggerUrl, "JSON.stringify({url:location.href,readyState:document.readyState,title:document.title,body:document.body?.innerText?.slice(0,500)||'',html:document.documentElement?.outerHTML?.slice(0,500)||'',trace:window.__editkinSmokeTrace||[]})");
    throw new Error(`UI measurement prerequisites missing: ${JSON.stringify(uiPrerequisites)}; diagnostic=${JSON.stringify(uiDiagnostic)}`);
  }
  const uiMeasurement = await evaluate(page.webSocketDebuggerUrl, `(async()=>{const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));const rect=(selector,name)=>{const node=document.querySelector(selector);const box=node?.getBoundingClientRect();return{name,width:box?.width||0,height:box?.height||0}};const items=[...document.querySelectorAll('.quick-flow li')].map(node=>node.textContent||'');const themeSelect=document.querySelector('[data-testid="theme-select"]');const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;const themeSamples={};const themeTokens={};for(const theme of ['sky','candy','volt']){setter.call(themeSelect,theme);themeSelect.dispatchEvent(new Event('change',{bubbles:true}));await wait(50);const styles=getComputedStyle(document.documentElement);themeSamples[theme]=styles.getPropertyValue('--accent').trim();themeTokens[theme]={ink:styles.getPropertyValue('--ink').trim(),soft:styles.getPropertyValue('--soft').trim(),muted:styles.getPropertyValue('--muted').trim(),surface:styles.getPropertyValue('--surface').trim(),accent:styles.getPropertyValue('--accent').trim(),accentInk:styles.getPropertyValue('--accent-ink').trim()}}setter.call(themeSelect,'sky');themeSelect.dispatchEvent(new Event('change',{bubbles:true}));await wait(50);const beginnerActions=[...document.querySelectorAll('[data-beginner-action]')].filter(node=>node.getClientRects().length).map(node=>node.getAttribute('data-beginner-action')||node.textContent?.trim()||'');const isVisibleDecision=(node)=>{for(let parent=node.parentElement;parent;parent=parent.parentElement){if(parent.tagName==='DETAILS'&&!parent.open&&node!==parent.querySelector(':scope > summary'))return false}const box=node.getBoundingClientRect();return box.width>0&&box.height>0};const visibleDecisions=[...document.querySelectorAll('.toolbar-actions button,.toolbar-actions summary,.toolbar-actions select,.agent-panel button,.agent-panel summary,.agent-panel input,.inspector button,.inspector summary,.inspector select,.inspector input,.inspector textarea,.timeline-toolbar button,.timeline-toolbar summary')].filter(isVisibleDecision).map(node=>({label:node.getAttribute('aria-label')||node.textContent?.trim()||node.getAttribute('placeholder')||node.tagName,disabled:Boolean(node.disabled),testId:node.dataset.testid||null}));const visibleDecisionCount=visibleDecisions.filter(item=>!item.disabled).length;const disabledDecisionCount=visibleDecisions.filter(item=>item.disabled).length;const fixture=document.createElement('details');fixture.innerHTML='<summary>fixture</summary><button>fixture</button>';document.body.append(fixture);const collapsed=[...fixture.querySelectorAll('summary,button')].filter(isVisibleDecision).length;fixture.open=true;const opened=[...fixture.querySelectorAll('summary,button')].filter(isVisibleDecision).length;fixture.remove();const visibilityFixture={collapsed,opened};return JSON.stringify({workspaceMode:document.querySelector('.app-shell')?.dataset.workspaceMode||'',viewport:{width:innerWidth,height:innerHeight},document:{clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,clientHeight:document.documentElement.clientHeight,scrollHeight:document.documentElement.scrollHeight},primaryFlow:{import:items.some(text=>text.includes('加入素材')),agent:items.some(text=>text.includes('自動剪輯')),fineTune:items.some(text=>text.includes('拖曳微調')),export:items.some(text=>text.includes('輸出影片'))},beginnerActions,visibleDecisionCount,disabledDecisionCount,visibleDecisions,visibilityFixture,smartCutVisible:Boolean(document.querySelector('[data-testid="smart-cut-button"]')),automaticCaptionVisible:Boolean(document.querySelector('[data-testid="automatic-caption-button"]')),sceneSplitVisible:Boolean(document.querySelector('[data-testid="scene-split-button"]')),semanticAutoEditVisible:Boolean(document.querySelector('[data-testid="semantic-edit-button"]')),batchAutoEditVisible:Boolean(document.querySelector('[data-testid="batch-auto-edit-button"]')),primaryControls:[rect('[data-testid="import-media-button"]','import'),rect('[data-testid="semantic-edit-button"]','auto-complete'),rect('[data-testid="agent-input"]','agent-input'),rect('[data-testid="agent-submit"]','agent-submit'),rect('[data-testid="render-button"]','render')],layoutGeometry:{previewStage:rect('.preview-stage','preview-stage'),agentPanel:rect('.agent-panel','agent-panel'),semanticButton:rect('[data-testid="semantic-edit-button"]','semantic-button')},fontSamples:{toolbar:parseFloat(getComputedStyle(document.querySelector('.theme-control select')).fontSize),inspector:parseFloat(getComputedStyle(document.querySelector('.field-label')).fontSize),timeline:parseFloat(getComputedStyle(document.querySelector('.timeline-toolbar button')).fontSize),status:parseFloat(getComputedStyle(document.querySelector('.status-bar')).fontSize)},themeSamples,themeTokens,persistedTheme:localStorage.getItem('editkin.editor-theme'),advancedOpen:document.querySelectorAll('.inspector-section[open],.agent-tools[open],.media-more[open],.timeline-more[open]').length})})()`, 10_000);
  uiMeasurement.primaryControls = uiMeasurement.primaryControls.filter((control) => control.width > 0 && control.height > 0);
  const uiGate = assessUiMeasurement(uiMeasurement);
  const layoutGeometryGreen = uiMeasurement.layoutGeometry.previewStage.width >= 480
    && uiMeasurement.layoutGeometry.previewStage.height >= 160
    && uiMeasurement.layoutGeometry.agentPanel.height <= 180
    && uiMeasurement.layoutGeometry.semanticButton.height >= 40
    && uiMeasurement.layoutGeometry.semanticButton.height <= 100;
  const motionUi = await evaluate(page.webSocketDebuggerUrl, `(async()=>{const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));const outer=document.querySelector('[data-testid="inspector-advanced"]');const detail=document.querySelector('[data-testid="motion-section"]');outer?.querySelector(':scope > summary')?.click();detail?.querySelector(':scope > summary')?.click();for(let attempt=0;attempt<20&&!document.querySelector('[data-testid="motion-track-button"]');attempt+=1)await wait(100);const button=document.querySelector('[data-testid="motion-track-button"]');const box=button?.getBoundingClientRect();const loaded=Boolean(button)&&box.width>0&&box.height>0&&getComputedStyle(button).visibility!=='hidden';detail?.querySelector(':scope > summary')?.click();outer?.querySelector(':scope > summary')?.click();return JSON.stringify({loaded,button:{width:box?.width||0,height:box?.height||0},label:button?.textContent||'',openedByUserClick:Boolean(outer&&detail)})})()`, 10_000);
  const previewCenterUi = await evaluate(page.webSocketDebuggerUrl, `(async()=>{const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));const quick=document.querySelector('[data-testid="clip-quick-tools"]');quick?.querySelector(':scope > summary')?.click();await wait(80);const selectTool=async(label)=>{[...document.querySelectorAll('.creator-tool-tabs button')].find(node=>node.textContent?.includes(label))?.click();await wait(100)};await selectTool('濾鏡');const lookCards=document.querySelectorAll('[data-testid="look-preview-list"] button').length;await selectTool('特效');const effectCards=document.querySelectorAll('[data-testid="effect-preset-list"] button').length;await selectTool('轉場');const transitionCards=document.querySelectorAll('[data-testid="transition-preview-list"] article').length;quick?.querySelector(':scope > summary')?.click();const outer=document.querySelector('[data-testid="inspector-advanced"]');outer?.querySelector(':scope > summary')?.click();await wait(120);const motion=document.querySelector('[data-testid="motion-section"]');motion?.querySelector(':scope > summary')?.click();for(let i=0;i<20&&!document.querySelector('[data-testid="motion-template-previews"]');i+=1)await wait(80);const motionCards=document.querySelectorAll('[data-testid="motion-template-previews"] button').length;motion?.querySelector(':scope > summary')?.click();outer?.querySelector(':scope > summary')?.click();document.querySelector('[data-testid="asset-library-tab"]')?.click();for(let i=0;i<30&&!document.querySelector('.creative-asset-card');i+=1)await wait(100);for(let i=0;i<80&&!document.querySelector('.creative-preview.ready img,.creative-preview.ready video');i+=1)await wait(100);const assetCards=document.querySelectorAll('.creative-asset-card').length;const media=[...document.querySelectorAll('.creative-preview.ready img,.creative-preview.ready video')];const loadedMediaPreviews=media.filter(node=>node.tagName==='IMG'?node.complete&&node.naturalWidth>0:node.readyState>=2&&node.videoWidth>0).length;const scroll=document.querySelector('[data-testid="creative-library-scroll"]');const scrollBefore=scroll?.scrollTop??0;scroll?.dispatchEvent(new WheelEvent('wheel',{deltaY:280,bubbles:true,cancelable:true}));const visibleReady=()=>{const viewport=scroll?.getBoundingClientRect();if(!viewport)return false;return [...document.querySelectorAll('.creative-preview.ready img,.creative-preview.ready video')].some(node=>{const box=node.getBoundingClientRect();const decoded=node.tagName==='IMG'?node.complete&&node.naturalWidth>0:node.readyState>=2&&node.videoWidth>0;return decoded&&box.bottom>viewport.top&&box.top<viewport.bottom})};for(let i=0;i<100&&!visibleReady();i+=1)await wait(100);const scrollAfter=scroll?.scrollTop??0;const wheelScrollable=Boolean(scroll&&scroll.scrollHeight>scroll.clientHeight*4);const wheelScrolled=wheelScrollable&&scrollAfter>scrollBefore;const visibleLoadedAfterScroll=visibleReady();document.querySelector('[role="tab"][data-user-asset-count]')?.click();const timelineMore=document.querySelector('.timeline-more');timelineMore?.querySelector(':scope > summary')?.click();document.querySelector('[data-testid="add-caption-button"]')?.click();for(let i=0;i<20&&!document.querySelector('[data-testid="caption-inspector"]');i+=1)await wait(80);const captionAdvanced=document.querySelector('[data-testid="caption-advanced"]');captionAdvanced?.querySelector(':scope > summary')?.click();await wait(80);const captionStyleCards=document.querySelectorAll('.caption-preset-gallery button').length;const captionColorInputs=document.querySelectorAll('[data-testid="caption-inspector"] input[type="color"]').length;const captionOpacity=Boolean(document.querySelector('[data-testid="caption-inspector"] input[type="range"]'));document.querySelector('[data-testid="timeline-clip-clip-demo"]')?.click();timelineMore?.querySelector(':scope > summary')?.click();return JSON.stringify({lookCards,effectCards,transitionCards,motionCards,assetCards,loadedMediaPreviews,wheelScrollable,wheelScrolled,visibleLoadedAfterScroll,scrollBefore,scrollAfter,captionStyleCards,captionColorInputs,captionOpacity})})()`, 35_000);
  const workstationUi = await evaluate(page.webSocketDebuggerUrl, `(async()=>{const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));document.querySelector('[data-testid="director-console-button"]')?.click();for(let attempt=0;attempt<30&&!document.querySelector('[data-testid="director-console"]');attempt+=1)await wait(100);const director=document.querySelector('[data-testid="director-console"]');const title=document.querySelector('[data-testid="director-title-input"]');const inputSetter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;if(title){inputSetter.call(title,'CDP 導演筆記');title.dispatchEvent(new Event('input',{bubbles:true}))}await wait(50);document.querySelector('[data-testid="director-add-marker"]')?.click();await wait(80);const markerAdded=director?.textContent?.includes('CDP 導演筆記')===true;director?.querySelector('.modal-close')?.click();await wait(80);const outer=document.querySelector('[data-testid="inspector-advanced"]');const detail=document.querySelector('[data-testid="color-section"]');outer?.querySelector(':scope > summary')?.click();detail?.querySelector(':scope > summary')?.click();await wait(50);document.querySelector('[data-testid="color-workspace-button"]')?.click();for(let attempt=0;attempt<30&&!document.querySelector('[data-testid="color-workspace"]');attempt+=1)await wait(100);const color=document.querySelector('[data-testid="color-workspace"]');const exposure=document.querySelector('[data-testid="grade-exposure"]');const rangeSetter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;if(exposure){rangeSetter.call(exposure,'0.75');exposure.dispatchEvent(new Event('input',{bubbles:true}))}await wait(80);const scopeCanvases=[...color?.querySelectorAll('.scope-grid canvas')||[]].map(node=>({width:node.width,height:node.height}));const exposureApplied=exposure?.value==='0.75';color?.querySelector('.modal-close')?.click();detail?.querySelector(':scope > summary')?.click();outer?.querySelector(':scope > summary')?.click();return JSON.stringify({directorLoaded:Boolean(director),markerAdded,colorLoaded:Boolean(color),exposureApplied,scopeCanvases,lazyWorkspacesClosed:!document.querySelector('[data-testid="director-console"]')&&!document.querySelector('[data-testid="color-workspace"]')})})()`, 15_000);
  if (!workstationUi.lazyWorkspacesClosed) {
    await delay(100);
    workstationUi.lazyWorkspacesClosed = await evaluate(page.webSocketDebuggerUrl, "JSON.stringify(!document.querySelector('[data-testid=\"director-console\"]')&&!document.querySelector('[data-testid=\"color-workspace\"]'))");
  }
  markStep("editor-workspaces");
  const rippleDelete = await evaluate(page.webSocketDebuggerUrl, `(async()=>{const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));const ruler=document.querySelector('[data-testid="timeline-ruler"]');const split=document.querySelector('[data-testid="split-button"]');const remove=document.querySelector('[data-testid="delete-button"]');const undo=document.querySelector('[data-testid="undo-button"]');const clickRuler=(x)=>{const box=ruler.getBoundingClientRect();ruler.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:x,clientY:box.top+Math.min(12,box.height/2)}))};let first=document.querySelector('[data-testid="timeline-clip-clip-demo"]');if(!first||!ruler||!split||!remove)return JSON.stringify({status:'BLOCK',reason:'missing-controls'});first.click();let box=first.getBoundingClientRect();clickRuler(box.left+box.width/3);await wait(80);split.click();await wait(100);let clips=[...document.querySelectorAll('.track-lane.video[data-track-id="video-main"] .timeline-clip')].sort((a,b)=>Number(a.dataset.timelineStart)-Number(b.dataset.timelineStart));let middle=clips.find(node=>node.dataset.testid!=='timeline-clip-clip-demo');if(!middle||clips.length<2)return JSON.stringify({status:'BLOCK',reason:'first-split',clipCount:clips.length});middle.click();box=middle.getBoundingClientRect();clickRuler(box.left+box.width/2);await wait(80);split.click();await wait(100);clips=[...document.querySelectorAll('.track-lane.video[data-track-id="video-main"] .timeline-clip')].sort((a,b)=>Number(a.dataset.timelineStart)-Number(b.dataset.timelineStart));middle=clips[1];const following=clips[2];if(!middle||!following)return JSON.stringify({status:'BLOCK',reason:'second-split',clipCount:clips.length});middle.click();await wait(40);const deletedStart=Number(middle.dataset.timelineStart);const deletedDuration=Number(middle.dataset.duration);const followingBefore=Number(following.dataset.timelineStart);remove.click();await wait(120);const after=[...document.querySelectorAll('.track-lane.video[data-track-id="video-main"] .timeline-clip')].sort((a,b)=>Number(a.dataset.timelineStart)-Number(b.dataset.timelineStart));const followingAfter=Number(after[1]?.dataset.timelineStart);undo.click();await wait(120);const restoredCount=document.querySelectorAll('.track-lane.video[data-track-id="video-main"] .timeline-clip').length;const closedGap=Math.abs(followingAfter-deletedStart)<1e-6&&Math.abs((followingBefore-deletedDuration)-followingAfter)<1e-6;return JSON.stringify({status:after.length===2&&restoredCount===3&&closedGap?'GREEN':'BLOCK',beforeCount:clips.length,afterCount:after.length,restoredCount,deletedStart,deletedDuration,followingBefore,followingAfter,closedGap})})()`, 10_000);
  markStep("ripple-delete-close-gap");
  await cdpCommand(page.webSocketDebuggerUrl, "Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await delay(100);
  const compactUi = await evaluate(page.webSocketDebuggerUrl, `(()=>{const rect=(selector)=>{const box=document.querySelector(selector)?.getBoundingClientRect();return{width:box?.width||0,height:box?.height||0}};const controls=['[data-testid="import-media-button"]','[data-testid="agent-input"]','[data-testid="agent-submit"]','[data-testid="render-button"]'].map(rect);return JSON.stringify({viewport:{width:innerWidth,height:innerHeight},document:{clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,clientHeight:document.documentElement.clientHeight,scrollHeight:document.documentElement.scrollHeight},controls,layoutGeometry:{previewStage:rect('.preview-stage'),agentPanel:rect('.agent-panel'),semanticButton:rect('[data-testid="semantic-edit-button"]')},semanticReachable:Boolean(document.querySelector('[data-testid="semantic-edit-button"]')),batchReachable:Boolean(document.querySelector('[data-testid="batch-auto-edit-button"]')),advancedGroupsClosed:document.querySelectorAll('.agent-tools[open],.media-more[open],.inspector-section[open],.timeline-more[open]').length===0})})()`);
  compactUi.controls = compactUi.controls.filter((control) => control.width > 0 && control.height > 0);
  await cdpCommand(page.webSocketDebuggerUrl, "Emulation.clearDeviceMetricsOverride");
  const compactUiGreen = compactUi.viewport.width === 1280 && compactUi.viewport.height === 720
    && compactUi.document.scrollWidth === compactUi.document.clientWidth && compactUi.document.scrollHeight === compactUi.document.clientHeight
    && compactUi.semanticReachable && compactUi.batchReachable && compactUi.advancedGroupsClosed
    && compactUi.layoutGeometry.previewStage.width >= 360 && compactUi.layoutGeometry.previewStage.height >= 120
    && compactUi.controls.every((control) => control.width >= 40 && control.height >= 40);
  const updater = await evaluate(page.webSocketDebuggerUrl, "(async()=>{const staged=await window.haoDesktop.checkForUpdates({download:true});const checked=await window.haoDesktop.checkForUpdates({download:true});const install=await window.haoDesktop.installUpdate();return JSON.stringify({staged,checked,install})})()", 180_000);
  markStep("explicit-update-stage");
  const grade = { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0, pivot: 0.5, shadows: 0, highlights: 0, blacks: 0, whites: 0 };
  const project = {
    schemaVersion: 6, revision: 0, id: "tauri-smoke", name: "Editkin Tauri Smoke", width: 640, height: 360, fps: 30, editorialProfile: "auto",
    assets: [
      { id: "base", name: "bundled demo", kind: "video", uri: "demo-source.mp4", duration: 4, width: 960, height: 540 },
      { id: "overlay", name: "overlay", kind: "video", uri: overlay, duration: 2, width: 160, height: 120 },
    ],
    tracks: [
      { id: "video-main", name: "主畫面", kind: "video", locked: false, muted: false, clips: [{ id: "base-clip", assetId: "base", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 4, volume: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { ...grade }, keyframes: [] }] },
      { id: "video-overlay", name: "疊加", kind: "video", locked: false, muted: false, clips: [{ id: "overlay-clip", assetId: "overlay", trackId: "video-overlay", timelineStart: 1, sourceStart: 0, duration: 2, volume: 0, transform: { x: 120, y: -60, scale: 0.7, rotation: 0, opacity: 0.8 }, color: { ...grade }, keyframes: [{ id: "kf", time: 2, transform: { x: -120, y: 60, scale: 1, rotation: 8, opacity: 0.5 }, color: { ...grade, brightness: 0.1, contrast: 1.1, saturation: 1.2, hue: 15 }, easing: "linear" }] }] },
      { id: "audio-main", name: "聲音", kind: "audio", locked: false, muted: false, clips: [] },
      { id: "caption-main", name: "字幕", kind: "caption", locked: false, muted: false, clips: [] },
    ],
    captions: [{ id: "caption", text: "Editkin", start: 0.5, duration: 2 }],
    captionStyle: { presetId: "hao-bold", fontFamily: "Noto Sans TC", fontSize: 36, color: "#FFFFFF", outlineColor: "#000000", outlineWidth: 3, alignment: 2, marginV: 36, bold: true, italic: false, shadow: 1, backgroundColor: "#00000000", letterSpacing: 0 },
    motionTracks: [],
    motionGraphics: [],
    director: { schema: "editkin.director-console/v1", reviewState: "reviewing", markers: [], updatedAt: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  };
  const projectPath = resolve("../../.rd/artifacts/editkin-tauri-smoke.editkin.json");
  await rm(projectPath, { force: true });
  const saved = await evaluate(page.webSocketDebuggerUrl, `window.haoDesktop.saveProject(${JSON.stringify(project)},${JSON.stringify(projectPath)},false).then(value=>JSON.stringify(value))`, 30_000);
  const remoteSnapshot = { projectName: "Editkin Tauri Smoke", resolution: "640×360", fps: 30, trackCount: 4, playhead: 1.25, playheadLabel: "00:01.25", status: "integration", previewPath: fixture };
  const remote = await evaluate(page.webSocketDebuggerUrl, `window.haoDesktop.startMobileRemote(${JSON.stringify(remoteSnapshot)}).then(value=>JSON.stringify(value))`, 30_000);
  const remoteEndpoint = new URL(remote.url);
  const remoteTokenHiddenFromQuery = !remoteEndpoint.searchParams.has("token") && remoteEndpoint.hash.includes("token=");
  const tunnelConfigured = Boolean(process.env.EDITKIN_CLOUDFLARED_PATH);
  const requireHttpsTunnel = process.env.EDITKIN_REQUIRE_HTTPS_TUNNEL === "1";
  const expectedRemoteTransport = requireHttpsTunnel ? "https-tunnel" : remote.transport;
  const gracefulTunnelFallback = !tunnelConfigured || remote.transport === "https-tunnel" || (remote.transport === "lan" && Boolean(remote.warning));
  if (remote.transport === "lan") remoteEndpoint.hostname = "127.0.0.1";
  let remotePage;
  let remotePageError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { remotePage = await fetch(remoteEndpoint); if (remotePage.ok) break; }
    catch (error) { remotePageError = error; }
    await delay(250);
  }
  if (!remotePage) throw new Error(`Remote page did not become reachable: ${remote.url} · ${remotePageError instanceof Error ? remotePageError.message : remotePageError}`);
  const remotePageText = await remotePage.text();
  const remoteStatusEndpoint = new URL("/api/status", remoteEndpoint);
  const remoteUnauthorized = await fetch(remoteStatusEndpoint);
  const remotePairEndpoint = new URL("/api/pair", remoteEndpoint);
  const remotePairResponse = await fetch(remotePairEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", origin: remoteEndpoint.origin },
    body: JSON.stringify({ token: remote.token, deviceId: "tauri-smoke-phone", name: "Tauri Smoke iPhone" }),
  });
  const remoteCookie = remotePairResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const remoteStatusResponse = await fetch(remoteStatusEndpoint, { headers: { cookie: remoteCookie } });
  const remoteStatus = await remoteStatusResponse.json();
  const remoteCommandEndpoint = new URL("/api/command", remoteEndpoint);
  const remoteCommandResponse = await fetch(remoteCommandEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: remoteCookie, origin: remoteEndpoint.origin },
    body: JSON.stringify({ instruction: "復原" }),
  });
  const remoteCommands = await evaluate(page.webSocketDebuggerUrl, "window.haoDesktop.pollMobileCommands().then(value=>JSON.stringify(value))", 10_000);
  const remoteDesktopStatus = await evaluate(page.webSocketDebuggerUrl, "window.haoDesktop.getMobileRemoteStatus().then(value=>JSON.stringify(value))", 10_000);
  const remoteStopped = await evaluate(page.webSocketDebuggerUrl, "window.haoDesktop.stopMobileRemote().then(value=>JSON.stringify(value))", 10_000);
  await delay(250);
  const remoteRestarted = await evaluate(page.webSocketDebuggerUrl, `window.haoDesktop.startMobileRemote(${JSON.stringify(remoteSnapshot)}).then(value=>JSON.stringify(value))`, 30_000);
  const reconnectStatusEndpoint = new URL("/api/status", remoteRestarted.url);
  if (remoteRestarted.transport === "lan") reconnectStatusEndpoint.hostname = "127.0.0.1";
  const reconnectStatusResponse = await fetch(reconnectStatusEndpoint, { headers: { cookie: remoteCookie } });
  const remoteRevoked = await evaluate(page.webSocketDebuggerUrl, "window.haoDesktop.revokeMobileDevice('tauri-smoke-phone').then(value=>JSON.stringify(value))", 10_000);
  const rejectedAfterRevoke = await fetch(reconnectStatusEndpoint, { headers: { cookie: remoteCookie } });
  const remoteStoppedAgain = await evaluate(page.webSocketDebuggerUrl, "window.haoDesktop.stopMobileRemote().then(value=>JSON.stringify(value))", 10_000);
  markStep("permanent-mobile-binding");
  const rendered = await evaluate(page.webSocketDebuggerUrl, `window.__TAURI_INTERNALS__.invoke('render_project_smoke',{project:${JSON.stringify(project)},outputPath:${JSON.stringify(outputPath)}}).then(value=>JSON.stringify(value))`, 120_000);
  markStep("render");
  const batchRoot = resolve("../../.rd/artifacts/editkin-tauri-batch-smoke");
  await rm(batchRoot, { recursive: true, force: true });
  const batch = await evaluate(page.webSocketDebuggerUrl, `window.__TAURI_INTERNALS__.invoke('batch_auto_edit_smoke',{sourcePath:${JSON.stringify(fixture)},outputRoot:${JSON.stringify(batchRoot)}}).then(value=>JSON.stringify(value))`, 180_000);
  markStep("batch-auto-edit");
  const output = await stat(outputPath);
  const batchOutput = await stat(batch.outputPath);
  const batchProject = JSON.parse(await readFile(batch.projectPath, "utf8"));
  const batchReceipt = JSON.parse(await readFile(batch.receiptPath, "utf8"));
  const reopened = JSON.parse(await readFile(projectPath, "utf8"));
  const gpuProductFallback = await runGpuProductFallback();
  markStep("gpu-product-fallback-project-truth");
  const sourceOrientationAutoCanvas = await evaluate(page.webSocketDebuggerUrl, `(async()=>{const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));window.confirm=()=>true;document.querySelector('[data-testid="new-project-button"]')?.click();await wait(120);const response=await fetch('benchmarks/portrait-fixture.svg');const blob=await response.blob();const file=new File([blob],'portrait-fixture.svg',{type:'image/svg+xml'});const transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('[data-testid="media-input"]');if(!input)return JSON.stringify({status:'BLOCK',reason:'missing-media-input'});input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));for(let attempt=0;attempt<50;attempt+=1){await wait(100);if(document.querySelector('[data-testid="canvas-orientation"]')?.textContent?.includes('直式 9:16')&&document.querySelector('.asset-row')?.textContent?.includes('portrait-fixture.svg'))break}const canvas=document.querySelector('[data-testid="canvas-orientation"]')?.textContent||'';const format=document.querySelector('[data-testid="project-format-control"]');const resolution=document.querySelector('[data-testid="project-resolution"]')?.textContent||'';const projectWidth=Number(format?.dataset.projectWidth);const projectHeight=Number(format?.dataset.projectHeight);const assetText=document.querySelector('.asset-row')?.textContent||'';const clip=document.querySelector('.track-lane.video[data-track-id="video-main"] .timeline-clip');const status=document.querySelector('[data-testid="agent-status"]')?.textContent||'';const imported=assetText.includes('portrait-fixture.svg');const startsAtZero=Math.abs(Number(clip?.dataset.timelineStart))<1e-6;const portrait=canvas.includes('直式 9:16')&&projectWidth===1080&&projectHeight===1920;return JSON.stringify({status:imported&&startsAtZero&&portrait?'GREEN':'BLOCK',imported,startsAtZero,canvas,resolution,projectWidth,projectHeight,statusMessage:status,assetText})})()`, 15_000);
  markStep("source-orientation-auto-canvas");
  const green = state.tauri === "object" && state.desktop === "object" && state.isDesktop === true && state.body.includes("Editkin")
    && buildManifestGreen && embeddedBuildManifest.product === "Editkin" && embeddedBuildManifest.productVersion === currentVersion
    && ocioGpu.status === "GREEN" && ocioGpu.ocioVersion === "2.5.2" && ocioGpu.maxChannelError <= 2
    && ocioGradeGpu.status === "GREEN" && ocioGradeGpu.maxChannelError <= 2 && ocioGradeGpu.dynamicUniforms === 42
    && coldRuntime.libraryReady && coldRuntime.rootMounted && coldRuntime.timelineInteractive && coldRuntime.renderInteractive && coldRuntime.uiHeartbeats > 0
    && beginnerGuide.dismissed && beginnerGuide.reopened && beginnerGuide.helpAvailable && beginnerGuide.welcomeVisible && beginnerGuide.singlePrimaryAction && beginnerGuide.firstStepCurrent && beginnerGuide.exploredDemo && beginnerGuide.instructionsAvailable && beginnerGuide.assetPreviewEntryAvailable && beginnerGuide.assetLibraryTabAvailable
    && editorUi.invalidStatus && editorUi.survivedInvalidCommand && editorUi.after > editorUi.before && editorUi.playbackStartLatencyMs <= 3_000 && editorUi.volume === "65"
    && editorUi.shortcutMoved && editorUi.autosaveFound && editorUi.autosaveVolume === 0.65 && editorUi.autosaveDuration === 1.2 && editorUi.clearVerified && editorUi.saveState.includes("Autosave")
    && timelineDirectManipulation.realPointerInput && timelineDirectManipulation.samples === 24 && timelineDirectManipulation.allVisibleUpdates && timelineDirectManipulation.inputToVisibleP95Ms <= 50
    && timelineDirectManipulation.startAfterDrag > timelineDirectManipulation.startBefore && timelineDirectManipulation.singleUndoRestoredOrigin && timelineDirectManipulation.startAfterRedo === timelineDirectManipulation.startAfterDrag && timelineDirectManipulation.durableAutosave && timelineDirectManipulation.longTasks === 0 && timelineDirectManipulation.rootMounted
    && timelineDropBoundary.status === "GREEN"
    && rippleDelete.status === "GREEN"
    && sourceOrientationAutoCanvas.status === "GREEN"
    && bridge.assetId === "tauri-smoke-asset" && bridge.preview.includes("tauri-smoke-asset")
    && bridge.derivatives.includes("proxyUri") && bridge.runtime.includes("tauri-smoke-asset:thumbnail") && bridge.smartCutEngine === "hao-core-rust-0.4" && bridge.smartCutRangeCount > 0 && bridge.automaticCaption === "function" && bridge.batch.every((item) => item === "function") && bridge.sceneEngine === "ffmpeg-scdet-8" && bridge.mobile === "function" && bridge.recovery.every((item) => item === "function")
    && bridge.gpuStaging.status === "GREEN"
    && bridge.gpuCommonEngine.status === "GREEN"
    && bridge.gpuNative25d.status === "GREEN"
    && bridge.gpuNativeParticleVfx.status === "GREEN"
    && bridge.gpuCommonVideoEngine.status === "GREEN"
    && bridge.gpuCommonVideoPqPreview.status === "GREEN"
    && bridge.gpuCommonVideoParticle.status === "GREEN"
    && bridge.gpuCommonVideoAdjustment.status === "GREEN"
    && bridge.gpuCommonVideoTopology.status === "GREEN"
    && bridge.gpuCommonVideoComposite.status === "GREEN"
    && bridge.gpuCommonVideoMultitrack.status === "GREEN"
    && bridge.gpuCommonVideoGrade.status === "GREEN"
    && bridge.gpuCommonVideoAnimation.status === "GREEN"
    && bridge.gpuCommonVideoCaption.status === "GREEN"
    && bridge.gpuCommonVideoMotionGraphic.status === "GREEN"
    && bridge.gpuCommonVideoTemporalTypography.status === "GREEN"
    && bridge.gpuCommonVideoTemporalAdjustment.status === "GREEN"
    && bridge.gpuCommonVideoTemporalPartialOverlayLook.status === "GREEN"
    && bridge.gpuCommonVideoTemporalMultiOverlayLook.status === "GREEN"
    && bridge.gpuCommonVideoTemporalMultiAdjustmentLook.status === "GREEN"
    && bridge.gpuCommonVideoTemporalParticleLook.status === "GREEN"
    && bridge.gpuCommonVideoTemporalParticleAnimatedOverlayMultiAdjustmentLook.status === "GREEN"
    && bridge.gpuCommonVideoTemporalParticleOverlayMultiAdjustmentLook.status === "GREEN"
    && bridge.gpuCommonVideoTemporalParticlePartialOverlayMultiAdjustmentLook.status === "GREEN"
    && bridge.gpuCommonVideoTemporalMatte.status === "GREEN"
    && bridge.gpuNativeSurface.status === "GREEN"
    && bridge.gpuFaultRecovery.status === "GREEN"
    && gpuProductFallback.status === "GREEN"
    && bridge.userPlugin.status === "GREEN"
    && bridge.gpuBundledPlugin.status === "GREEN"
    && bridge.creativeCount === expectedLibraryAssetCount && bridge.communityMusicCount === personalMusicManifest.assetCount && bridge.restrictedAssetCount === 0 && bridge.musicRedistributable && bridge.creativePathHidden && bridge.creativePortable && bridge.musicPortable && bridge.musicRole === "background-music" && bridge.musicPreview && bridge.creativePreview.some((key) => key.startsWith("asset-creator-"))
    && bridge.trackingEngine === expectedTrackingFallbackEngine && bridge.trackingPoints > 0
    && bridge.planarTrackingEngine === expectedPlanarTrackingEngine && bridge.planarTrackingPoints === planarTrackingManifest.frameCount && bridge.planarTrackingDiagnostics > 0 && bridge.planarTrackingSceneCutFalseLocks === 0
    && uiGate.status === "GREEN" && layoutGeometryGreen && motionUi.loaded && motionUi.button.width >= 40 && motionUi.button.height >= 34 && previewCenterUi.lookCards >= 11 && previewCenterUi.effectCards >= 6 && previewCenterUi.transitionCards >= 4 && previewCenterUi.motionCards >= 3 && previewCenterUi.assetCards > 0 && previewCenterUi.loadedMediaPreviews > 0 && previewCenterUi.wheelScrollable && previewCenterUi.wheelScrolled && previewCenterUi.visibleLoadedAfterScroll && previewCenterUi.captionStyleCards >= 6 && previewCenterUi.captionColorInputs >= 3 && previewCenterUi.captionOpacity && workstationUi.directorLoaded && workstationUi.markerAdded && workstationUi.colorLoaded && workstationUi.exposureApplied && workstationUi.scopeCanvases.length === 2 && workstationUi.scopeCanvases.every((canvas) => canvas.width > 0 && canvas.height > 0) && workstationUi.lazyWorkspacesClosed && compactUiGreen && uiMeasurement.semanticAutoEditVisible && uiMeasurement.batchAutoEditVisible
    && automaticUpdate.status === "available"
    && updater.staged.status === "ready" && updater.staged.version === testUpdateVersion
    && updater.checked.status === "ready" && updater.checked.version === testUpdateVersion && updater.checked.cacheHit === true
    && updater.install.started === false && updater.install.message.includes("Authenticode")
    && saved.canceled === false && saved.project?.revision === 1 && reopened.schemaVersion === expectedProjectSchemaVersion && reopened.revision === 1
    && remote.active === true && remote.transport === expectedRemoteTransport && gracefulTunnelFallback && remoteTokenHiddenFromQuery && remotePage.ok && remotePageText.includes("Editkin Remote") && remotePageText.includes("history.replaceState") && remoteUnauthorized.status === 401
    && remotePairResponse.status === 201 && remoteCookie.startsWith("editkin_remote_device=")
    && remoteStatusResponse.ok && remoteStatus.projectName === "Editkin Tauri Smoke" && remoteStatus.previewPath === undefined && remoteStatus.deviceName === "Tauri Smoke iPhone"
    && remoteDesktopStatus.connectedCount === 1 && remoteDesktopStatus.devices.some((device) => device.name === "Tauri Smoke iPhone" && device.connected === true)
    && remoteCommandResponse.status === 202 && remoteCommands.some((command) => command.instruction === "復原") && remoteStopped.stopped === true
    && remoteRestarted.active === true && reconnectStatusResponse.status === 200 && remoteRevoked.revoked === true && rejectedAfterRevoke.status === 401 && remoteStoppedAgain.stopped === true
    && rendered.duration >= 3.9 && output.size > 10_000 && rendered.planner.includes("hao-core-native-audio-dag/v1")
    && rendered.nativeAudio?.schema === "editkin.native-final-audio/v1" && rendered.nativeAudio.status === "GREEN"
    && rendered.nativeAudio.mixExecutor === "hao-core-native-dag/v1" && rendered.nativeAudio.nativeGraphExecution === true
    && rendered.nativeAudio.sourceCount >= 1 && /^[a-f0-9]{64}$/.test(rendered.nativeAudio.bindingSha256)
    && batch.status === "completed" && batchOutput.size > 10_000 && batchProject.schemaVersion === expectedProjectSchemaVersion && batchProject.revision === 1 && batchReceipt.status === "COMPLETED" && batchReceipt.reviewState === "REVIEW_REQUIRED" && batchReceipt.sourcePreserved === true;
  const report = { status: green ? "GREEN" : "BLOCK", executable, url: page?.url, ...state, journeySteps, buildManifest: { status: buildManifestGreen ? "GREEN" : "BLOCK", ...embeddedBuildManifest }, ocioGpu, ocioGradeGpu, coldRuntime, beginnerGuide, bridge, gpuProductFallback, editorUi, timelineDirectManipulation, timelineDropBoundary, rippleDelete, sourceOrientationAutoCanvas, ui: { measurement: uiMeasurement, layoutGeometryStatus: layoutGeometryGreen ? "GREEN" : "BLOCK", gate: uiGate, motionStudio: motionUi, previewCenter: previewCenterUi, professionalWorkspaces: workstationUi, compact1280x720: { measurement: compactUi, status: compactUiGreen ? "GREEN" : "BLOCK" } }, automaticUpdate, updater, saved, remote: { active: remote.active, transport: remote.transport, warning: remote.warning, tokenHiddenFromQuery: remoteTokenHiddenFromQuery, gracefulTunnelFallback, page: remotePage.status, unauthorized: remoteUnauthorized.status, pair: remotePairResponse.status, permanentDeviceCookie: remoteCookie.startsWith("editkin_remote_device="), status: remoteStatusResponse.status, connected: remoteDesktopStatus.connectedCount, trusted: remoteDesktopStatus.trustedCount, privatePathHidden: remoteStatus.previewPath === undefined, command: remoteCommandResponse.status, polled: remoteCommands.length, stopped: remoteStopped.stopped, autoReconnectAfterRestart: reconnectStatusResponse.status, revoked: remoteRevoked.revoked, rejectedAfterRevoke: rejectedAfterRevoke.status }, rendered, outputBytes: output.size, batch: { status: batch.status, outputBytes: batchOutput.size, projectRevision: batchProject.revision, receiptStatus: batchReceipt.status,reviewState: batchReceipt.reviewState, sourcePreserved: batchReceipt.sourcePreserved } };
  const serializedReport = `${JSON.stringify(report)}\n`;
  const reportRoot = resolve("../../.rd/benchmarks");
  await mkdir(reportRoot, { recursive: true });
  await writeFile(resolve(reportRoot, "editkin-tauri-cdp-smoke.json"), serializedReport, "utf8");
  process.stdout.write(serializedReport);
  if (!green) process.exitCode = 1;
} finally {
  if (page) {
    try { await evaluate(page.webSocketDebuggerUrl, "window.haoDesktop?.stopMobileRemote?.().then(value=>JSON.stringify(value))", 5_000); }
    catch { /* App may already be gone; parent watchdog owns the fallback. */ }
    await delay(250);
  }
  closeCdp();
  await stopOwnedApplication();
  updateServer.closeAllConnections?.();
  await new Promise((resolvePromise) => updateServer.close(resolvePromise));
  await rm(integrationStateRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
