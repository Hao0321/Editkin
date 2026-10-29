import { createGradeVideoSourceUploadV2, gradeVideoSourceSizeV2 } from "./gradeVideoSourceUploadV2";
import { secondaryHslSourceNodesV1 } from "../domain/secondaryHslV1Nodes";
import { uploadRgbFloatCubeV1 } from "./gradeTextureUploadV1";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ColorAdjustments, ColorGradeLutRefV2, ColorGradeV2, ColorManagementSettings, MediaAsset } from "../domain/types";
import { OCIO_VERTEX_SHADER, loadOcioGpuStage, ocioGradeUniformValues, resolveOcioGpuPipeline, type OcioGpuStage, type OcioGpuTexture } from "../color/ocioGpu";
import { gradeWorkingSpace, resolveColorGradeV2, type ResolvedColorGradeV2 } from "../color/gradeV2";
import { bakeResolvedGradeLut, type BakedGradeLut } from "../color/gradeLutBake";
import { loadCubeLut, parseCubeFile, type CubeLut, type ParsedCube } from "../color/cubeLut";
import { FINISH_GLSL, GRADE_V2_LUT_GLSL, HUE_ROTATE_GLSL, lut3dSamplerGlsl, previewFinishing, REC709_PRIMARY_GLSL, rec709PrimaryUniforms, type PreviewFinishing } from "../color/gradeV2Preview";
import { acesSdrOutputLutPathV1, usesAcesPhoneSdrV1, usesAcesClipDisplayInverseV1 } from "../color/acesPhoneInputV1";
import { resolveAcesInput } from "../color/primaryGrade";
import { ACES_SDR_OUTPUT_LUT, acesDisplayInverseFor, usesAcesDisplayReconstruction } from "../color/acesDisplayInverse";
import {previewFramePipelineKeyV1,type PreviewFrameIdentityV1} from "../color/previewPixelPickerV1";

/**
 * GradedMedia — one preview surface for Rec.709 and ACES 2.0 that applies Color Grade v2
 * from the *same* baked 65³ table the export writes (texelFetch + vf_lut3d tetrahedral
 * rule), then the spatial finishing (halation/bloom blur passes, vf_vignette factor,
 * Gaussian luma grain) and, for ACES, the shipped OCIO output stage.
 *
 * ACES 2.0 SDR with a display-referred source (phone Rec.709 / sRGB / HDR video): like the
 * export, the clip enters ACEScct through the display inverse of the shipped SDR output LUT and
 * leaves through that same 65³ output LUT, so the preview samples the export's three tables.
 * HDR video is previewed from the browser's own SDR decode (approximate; export uses the Rec.709
 * path's BT.2100 display decode + Hable shoulder before the inverse).
 *
 * Exactness: the grade table is shared bit-for-bit with export. The Rec.709 primary
 * grade is still the `gradeRgb` approximation (FFmpeg curves/eq are not modelled here)
 * and grain is statistically matched, not sample-identical.
 */
export interface GradedMediaProps {
  asset: MediaAsset;
  /** Primary grade, already combined with any legacy look (combineLookColor). */
  color: ColorAdjustments;
  grade?: ColorGradeV2;
  rec709Input?: "display" | "camera";
  management: ColorManagementSettings;
  source: string;
  className?: string;
  style?: CSSProperties;
  muted?: boolean;
  videoRef?: (node: HTMLVideoElement | null) => void;
  testId: "preview-image" | "preview-video";
  /** Creative-library .cube text for LUT nodes; the full SHA-256 is verified before use. */
  readLut?: (ref: ColorGradeLutRefV2) => Promise<string>;
  /** Same loaded source element, synchronously after each GPU frame; one-argument callbacks remain compatible. */
  onFrame?: (canvas: HTMLCanvasElement, source: HTMLImageElement | HTMLVideoElement, identity:PreviewFrameIdentityV1) => void;
  frameOwnerKey?:string;
  /** Observational lifecycle hook; only after async preparation AND cancelled effect cleanup settle. */
  onPipelineClosed?:()=>void;
}

type Status = "loading" | "grading" | "ready" | "error";

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL 無法建立 Color Grade v2 shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const detail = gl.getShaderInfoLog(shader) ?? "unknown shader error";
    gl.deleteShader(shader);
    throw new Error(`Color Grade v2 shader 編譯失敗：${detail}`);
  }
  return shader;
}

function program(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const vertexShader = compile(gl, gl.VERTEX_SHADER, OCIO_VERTEX_SHADER);
  const fragmentShader = compile(gl, gl.FRAGMENT_SHADER, fragment);
  const value = gl.createProgram();
  if (!value) throw new Error("WebGL 無法建立 Color Grade v2 program");
  gl.attachShader(value, vertexShader); gl.attachShader(value, fragmentShader);
  gl.bindAttribLocation(value, 0, "editkin_position");
  gl.linkProgram(value);
  gl.deleteShader(vertexShader); gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(value, gl.LINK_STATUS)) {
    const detail = gl.getProgramInfoLog(value) ?? "unknown link error";
    gl.deleteProgram(value);
    throw new Error(`Color Grade v2 program link 失敗：${detail}`);
  }
  return value;
}

const HEADER = "#version 300 es\nprecision highp float;\nprecision highp sampler2D;\nprecision highp sampler3D;\nin vec2 editkin_uv;\nout vec4 editkin_fragment;\n";

/** ACES 2.0 preview stages: the OCIO GPU stages, or the export's display inverse + SDR output tables. */
interface AcesPreviewPipeline {
  input?: OcioGpuStage;
  grade: OcioGpuStage;
  output?: OcioGpuStage;
  displayInverse?: CubeLut;
  sdrOutput?: CubeLut;
}

async function resolveAcesPreview(asset: MediaAsset, management: ColorManagementSettings, reconstruct: boolean): Promise<AcesPreviewPipeline> {
  if (!reconstruct && !usesAcesPhoneSdrV1(management)) return resolveOcioGpuPipeline(asset, management);
  const [grade, sdrOutput, input] = await Promise.all([loadOcioGpuStage("grade", "primary-tone"), loadCubeLut(`/color/aces2/${acesSdrOutputLutPathV1(management)}`), reconstruct ? Promise.resolve(undefined) : loadOcioGpuStage("input", resolveAcesInput(asset))]);
  await new Promise(resolve => setTimeout(resolve, 0));
  return { grade, sdrOutput, ...(reconstruct ? { displayInverse: acesDisplayInverseFor(sdrOutput) } : { input }) };
}

const ocioStages = (aces: AcesPreviewPipeline, which: Array<"input" | "grade" | "output">) => which.flatMap(key => aces[key] ? [aces[key]!] : []);

function gradeFragment(aces: AcesPreviewPipeline | undefined): string {
  const inverse = Boolean(aces?.displayInverse);
  return `${HEADER}uniform sampler2D editkin_source;
${aces ? `${inverse ? lut3dSamplerGlsl("editkin_display_inverse") : aces.input!.shaderText}\n${aces.grade.shaderText}` : REC709_PRIMARY_GLSL}
${HUE_ROTATE_GLSL}
${GRADE_V2_LUT_GLSL}
void main() {
  vec4 source = texture(editkin_source, editkin_uv);
  ${aces
    ? `vec4 working = ${inverse ? "vec4(editkin_display_inverse(source.rgb), source.a)" : `${aces.input!.functionName}(source)`};\n  working = ${aces.grade.functionName}(working);\n  working.rgb = editkin_hue_rotate(working.rgb);`
    : "vec4 working = vec4(editkin_hue_rotate(editkin_rec709_primary(source.rgb)), source.a);"}
  working.rgb = editkin_grade_v2_lut(working.rgb);
  editkin_fragment = working;
}`;
}

const BRIGHT_FRAGMENT = `${HEADER}uniform sampler2D editkin_working;
uniform float editkin_threshold;
uniform vec3 editkin_tint;
void main() {
  vec3 c = texture(editkin_working, editkin_uv).rgb;
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float ramp = clamp((y - editkin_threshold) / (1.0 - editkin_threshold), 0.0, 1.0);
  editkin_fragment = vec4(ramp * editkin_tint, 1.0);
}`;

const BLUR_FRAGMENT = `${HEADER}uniform sampler2D editkin_input;
uniform vec2 editkin_step;
uniform float editkin_sigma;
uniform int editkin_radius;
void main() {
  vec3 sum = vec3(0.0); float weights = 0.0;
  for (int i = -64; i <= 64; i++) {
    if (i < -editkin_radius || i > editkin_radius) continue;
    float w = exp(-0.5 * float(i * i) / (editkin_sigma * editkin_sigma));
    sum += texture(editkin_input, editkin_uv + editkin_step * float(i)).rgb * w;
    weights += w;
  }
  editkin_fragment = vec4(sum / weights, 1.0);
}`;

function finishFragment(aces: AcesPreviewPipeline | undefined): string {
  const output = aces?.output;
  return `${HEADER}uniform sampler2D editkin_working;
${FINISH_GLSL}
${aces?.sdrOutput ? lut3dSamplerGlsl("editkin_aces_sdr_output") : output ? output.shaderText : ""}
void main() {
  vec4 working = texture(editkin_working, editkin_uv);
  working.rgb = editkin_finish(working.rgb, editkin_uv);
  editkin_fragment = ${aces?.sdrOutput ? "vec4(editkin_aces_sdr_output(working.rgb), working.a)" : output ? `${output.functionName}(working)` : "vec4(clamp(working.rgb, 0.0, 1.0), working.a)"};
}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Resolves (and bakes) the grade off the first paint; LUT nodes are verified by full SHA-256. */
async function prepareGrade(grade: ColorGradeV2 | undefined, management: ColorManagementSettings, readLut?: GradedMediaProps["readLut"]): Promise<{ resolved?: ResolvedColorGradeV2; baked?: BakedGradeLut }> {
  if (!grade) return {};
  const cubes = new Map<string, ParsedCube>();
  for (const node of secondaryHslSourceNodesV1(grade.nodes ?? [])) {
    if (!node.lut || cubes.has(node.lut.sha256) || node.enabled === false || node.lut.strength <= 0) continue;
    if (!readLut) throw new Error(uiText("此調色引用 LUT，預覽尚未接上 LUT 素材庫"));
    const text = await readLut(node.lut);
    if (await sha256Hex(text) !== node.lut.sha256) throw new Error(uiText("LUT 內容與調色引用的 SHA-256 不一致"));
    cubes.set(node.lut.sha256, parseCubeFile(text));
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  const resolved = resolveColorGradeV2(grade, gradeWorkingSpace(management), ref => cubes.get(ref.sha256)!);
  return { resolved, baked: resolved.identity ? undefined : bakeResolvedGradeLut(resolved) };
}

export default function GradedMedia({ asset, color, grade, rec709Input, management, source, className, style, muted = true, videoRef, testId, readLut, onFrame,frameOwnerKey,onPipelineClosed }: GradedMediaProps) {
  useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const mediaRef = useRef<HTMLVideoElement>(null);
  const colorRef = useRef(color);
  const onFrameRef = useRef(onFrame);
  const drawRef = useRef<() => void>(() => undefined);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string>();
  const isVideo = asset.kind === "video";
  const aces = management.mode === "aces2";
  // Same rule as the export (prepareCompositeGrades): graded display-referred clips of ACES 2.0 SDR projects.
  const reconstruct = aces && usesAcesClipDisplayInverseV1(resolveAcesInput(asset), management, { gradeV2: grade, rec709Input });
  colorRef.current = color;
  onFrameRef.current = onFrame;
  const gradeKey = grade ? JSON.stringify(grade) : "";

  useEffect(() => drawRef.current(), [color]);

  useEffect(() => {
    const framePipelineKey=previewFramePipelineKeyV1({asset,source,grade,management,rec709Input,ownerKey:frameOwnerKey});
    let cancelled = false;
    let preparedClosed=false,pipelineReported=false;const reportClosed=()=>{if(cancelled&&preparedClosed&&!pipelineReported){pipelineReported=true;onPipelineClosed?.();}};
    let frameCallback = 0, animationFrame = 0, frameNumber = 0;
    let cleanup = () => undefined;
    setStatus(grade ? "grading" : "loading");
    setError(undefined);
    void Promise.all([aces ? resolveAcesPreview(asset, management, reconstruct) : Promise.resolve(undefined), prepareGrade(grade, management, readLut)])
      .then(([ocio, prepared]) => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        const element = isVideo ? mediaRef.current : imageRef.current;
        if (!canvas || !element) throw new Error("Color Grade v2 預覽媒體尚未掛載");
        const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
        if (!gl) throw new Error(uiText("此裝置沒有 WebGL2，無法執行 Color Grade v2 預覽"));
        const videoSourceUpload = isVideo ? createGradeVideoSourceUploadV2(gl) : undefined;
        const floatTargets = Boolean(gl.getExtension("EXT_color_buffer_float"));
        const gradeProgram = program(gl, gradeFragment(ocio));
        const brightProgram = program(gl, BRIGHT_FRAGMENT);
        const blurProgram = program(gl, BLUR_FRAGMENT);
        const finishProgram = program(gl, finishFragment(ocio));
        const quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        const textures: WebGLTexture[] = [];
        const texture2d = () => { const value = gl.createTexture()!; textures.push(value); return value; };
        const sourceTexture = texture2d();
        gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
        for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, value);
        // The shared grade table: RGB32F 3D texture, nearest only (tetrahedral weights come from the shader).
        const lutTexture = gl.createTexture()!;
        textures.push(lutTexture);
        gl.bindTexture(gl.TEXTURE_3D, lutTexture);
        const baked = prepared.baked;
        uploadRgbFloatCubeV1(gl, baked?.size ?? 2, baked?.values ?? new Float32Array(24));
        for (const key of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, key, gl.NEAREST);
        // OCIO stage tables, bound to fixed units per program.
        const ocioUnits = new Map<OcioGpuTexture, { texture: WebGLTexture; unit: number }>();
        let nextUnit = 4;
        for (const definition of ocio ? ocioStages(ocio, ["input", "grade", "output"]).flatMap(stage => stage.textures) : []) {
          const value = texture2d();
          gl.bindTexture(gl.TEXTURE_2D, value);
          gl.texImage2D(gl.TEXTURE_2D, 0, definition.channels === 1 ? gl.R32F : gl.RGB32F, definition.width, definition.height, 0,
            definition.channels === 1 ? gl.RED : gl.RGB, gl.FLOAT, new Float32Array(definition.values));
          const filter = definition.interpolation === "nearest" ? gl.NEAREST : gl.LINEAR;
          for (const [key, setting] of [[gl.TEXTURE_MIN_FILTER, filter], [gl.TEXTURE_MAG_FILTER, filter], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, setting);
          ocioUnits.set(definition, { texture: value, unit: nextUnit++ });
        }
        const bindOcio = (target: WebGLProgram, stages: OcioGpuStage[]) => {
          for (const definition of stages.flatMap(stage => stage.textures)) {
            const bound = ocioUnits.get(definition)!;
            gl.activeTexture(gl.TEXTURE0 + bound.unit);
            gl.bindTexture(gl.TEXTURE_2D, bound.texture);
            gl.uniform1i(gl.getUniformLocation(target, definition.sampler), bound.unit);
          }
        };
        // ACES 2.0 SDR display-referred clips: the export's display inverse and SDR output tables (RGB32F, nearest).
        const exportTables = new Map<string, { texture: WebGLTexture; unit: number; size: number }>();
        for (const [name, table] of [["editkin_display_inverse", ocio?.displayInverse], ["editkin_aces_sdr_output", ocio?.sdrOutput]] as const) {
          if (!table) continue;
          const value = gl.createTexture()!;
          textures.push(value);
          gl.bindTexture(gl.TEXTURE_3D, value);
          uploadRgbFloatCubeV1(gl, table.size, table.values);
          for (const key of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, key, gl.NEAREST);
          exportTables.set(name, { texture: value, unit: nextUnit++, size: table.size });
        }
        const bindTable = (target: WebGLProgram, name: string) => {
          const bound = exportTables.get(name);
          if (!bound) return;
          gl.activeTexture(gl.TEXTURE0 + bound.unit);
          gl.bindTexture(gl.TEXTURE_3D, bound.texture);
          gl.uniform1i(gl.getUniformLocation(target, `${name}_lut`), bound.unit);
          gl.uniform1f(gl.getUniformLocation(target, `${name}_size`), bound.size);
        };
        // Working-space targets: float where renderable, otherwise 8-bit (status explains the precision limit).
        const target = (width: number, height: number) => {
          const value = texture2d();
          gl.bindTexture(gl.TEXTURE_2D, value);
          gl.texImage2D(gl.TEXTURE_2D, 0, floatTargets ? gl.RGBA16F : gl.RGBA8, width, height, 0, gl.RGBA, floatTargets ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
          for (const [key, setting] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, setting);
          const framebuffer = gl.createFramebuffer()!;
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, value, 0);
          return { texture: value, framebuffer, width, height };
        };
        let size = { width: 0, height: 0 };
        let working: ReturnType<typeof target> | undefined;
        let glowTargets: Array<[ReturnType<typeof target>, ReturnType<typeof target>]> = [];
        let finishing: PreviewFinishing = previewFinishing(prepared.resolved?.finishing, gradeWorkingSpace(management), 1);
        const framebuffers = () => [working, ...glowTargets.flat()].filter(Boolean) as Array<ReturnType<typeof target>>;
        const resize = (width: number, height: number) => {
          for (const item of framebuffers()) { gl.deleteFramebuffer(item.framebuffer); gl.deleteTexture(item.texture); }
          working = target(width, height);
          finishing = previewFinishing(prepared.resolved?.finishing, gradeWorkingSpace(management), height);
          glowTargets = finishing.glows.map(glow => {
            const scale = glow.sigmaPixels > 24 ? 4 : 2;
            const w = Math.max(1, Math.round(width / scale)), h = Math.max(1, Math.round(height / scale));
            return [target(w, h), target(w, h)];
          });
          size = { width, height };
        };
        const uniform = (target: WebGLProgram, name: string) => gl.getUniformLocation(target, name);
        const draw = () => {
          if (cancelled) return;
          const width = isVideo ? (element as HTMLVideoElement).videoWidth : (element as HTMLImageElement).naturalWidth;
          const height = isVideo ? (element as HTMLVideoElement).videoHeight : (element as HTMLImageElement).naturalHeight;
          if (!width || !height || (isVideo && (element as HTMLVideoElement).readyState < HTMLMediaElement.HAVE_CURRENT_DATA)) return;
          if (isVideo && !gradeVideoSourceSizeV2(width, height)) { setError(uiText("這個影片尺寸超過預覽上限，請使用較小的預覽代理。")); setStatus("error"); return; }
          if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
          if (size.width !== width || size.height !== height) resize(width, height);
          frameNumber += 1;
          // 1. Grade pass → working-space target.
          gl.useProgram(gradeProgram);
          gl.bindFramebuffer(gl.FRAMEBUFFER, working!.framebuffer);
          gl.viewport(0, 0, width, height);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
          if (videoSourceUpload) {
            try { videoSourceUpload.upload(element as HTMLVideoElement); }
            catch { setError(uiText("無法讀取這個預覽影格，請重新建立素材預覽。")); setStatus("error"); return; }
          } else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, element);
          gl.uniform1i(uniform(gradeProgram, "editkin_source"), 0);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_3D, lutTexture);
          gl.uniform1i(uniform(gradeProgram, "editkin_grade_lut"), 1);
          gl.uniform1f(uniform(gradeProgram, "editkin_grade_lut_size"), baked?.size ?? 2);
          gl.uniform1i(uniform(gradeProgram, "editkin_grade_lut_enabled"), baked ? 1 : 0);
          gl.uniform1f(uniform(gradeProgram, "editkin_grade_hue_radians"), colorRef.current.hue * Math.PI / 180);
          if (ocio) {
            bindOcio(gradeProgram, ocioStages(ocio, ["input", "grade"]));
            bindTable(gradeProgram, "editkin_display_inverse");
            const values = ocioGradeUniformValues(colorRef.current);
            for (const definition of ocioStages(ocio, ["input", "grade"]).flatMap(stage => stage.uniforms ?? [])) {
              const location = uniform(gradeProgram, definition.name);
              const value = values[definition.name] ?? definition.default;
              if (definition.type === "bool") gl.uniform1i(location, value ? 1 : 0);
              else if (definition.type === "float") gl.uniform1f(location, Number(value));
              else gl.uniform3fv(location, value as number[]);
            }
          } else {
            for (const [name, value] of Object.entries(rec709PrimaryUniforms(colorRef.current))) {
              if (Array.isArray(value)) gl.uniform2fv(uniform(gradeProgram, `${name}[0]`), value);
              else gl.uniform1f(uniform(gradeProgram, name), value);
            }
          }
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          // 2. Glow passes (threshold + tint, then separable Gaussian) for halation / bloom.
          finishing.glows.forEach((glow, index) => {
            const [first, second] = glowTargets[index];
            gl.useProgram(brightProgram);
            gl.bindFramebuffer(gl.FRAMEBUFFER, first.framebuffer);
            gl.viewport(0, 0, first.width, first.height);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, working!.texture);
            gl.uniform1i(uniform(brightProgram, "editkin_working"), 0);
            gl.uniform1f(uniform(brightProgram, "editkin_threshold"), glow.threshold);
            gl.uniform3fv(uniform(brightProgram, "editkin_tint"), glow.tint);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            const sigma = glow.sigmaPixels * first.width / width;
            for (const [from, to, step] of [[first, second, [1 / first.width, 0]], [second, first, [0, 1 / first.height]]] as const) {
              gl.useProgram(blurProgram);
              gl.bindFramebuffer(gl.FRAMEBUFFER, to.framebuffer);
              gl.viewport(0, 0, to.width, to.height);
              gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, from.texture);
              gl.uniform1i(uniform(blurProgram, "editkin_input"), 0);
              gl.uniform2fv(uniform(blurProgram, "editkin_step"), step);
              gl.uniform1f(uniform(blurProgram, "editkin_sigma"), Math.max(0.5, sigma));
              gl.uniform1i(uniform(blurProgram, "editkin_radius"), Math.min(64, Math.ceil(3 * sigma)));
              gl.drawArrays(gl.TRIANGLES, 0, 6);
            }
          });
          // 3. Finish pass: glows (screen), vignette, grain, then the display transform.
          gl.useProgram(finishProgram);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, working!.texture);
          gl.uniform1i(uniform(finishProgram, "editkin_working"), 0);
          glowTargets.forEach(([first], index) => {
            gl.activeTexture(gl.TEXTURE2 + index); gl.bindTexture(gl.TEXTURE_2D, first.texture);
            gl.uniform1i(uniform(finishProgram, `editkin_glow${index}`), 2 + index);
          });
          gl.uniform1i(uniform(finishProgram, "editkin_glow_count"), glowTargets.length);
          gl.uniform1f(uniform(finishProgram, "editkin_vignette_angle"), finishing.vignetteAngle);
          gl.uniform1f(uniform(finishProgram, "editkin_vignette_log_depth"), finishing.vignetteLogDepth);
          gl.uniform1f(uniform(finishProgram, "editkin_grain_sigma"), finishing.grainSigma);
          gl.uniform1f(uniform(finishProgram, "editkin_grain_seed"), (frameNumber % 997) * 1.618);
          gl.uniform2f(uniform(finishProgram, "editkin_canvas_size"), width, height);
          if (ocio) {
            bindOcio(finishProgram, ocioStages(ocio, ["output"]));
            bindTable(finishProgram, "editkin_aces_sdr_output");
            const values = ocioGradeUniformValues(colorRef.current);
            for (const definition of ocioStages(ocio, ["output"]).flatMap(stage => stage.uniforms ?? [])) {
              const location = uniform(finishProgram, definition.name);
              const value = values[definition.name] ?? definition.default;
              if (definition.type === "bool") gl.uniform1i(location, value ? 1 : 0);
              else if (definition.type === "float") gl.uniform1f(location, Number(value));
              else gl.uniform3fv(location, value as number[]);
            }
          }
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          setStatus("ready");
          onFrameRef.current?.(canvas, element,{pipelineKey:framePipelineKey,primaryKey:JSON.stringify(colorRef.current),...(isVideo?{sourceTime:(element as HTMLVideoElement).currentTime}:{})});
        };
        drawRef.current = draw;
        const events = isVideo ? ["loadeddata", "seeked", "timeupdate", "play"] : ["load"];
        events.forEach(name => element.addEventListener(name, draw));
        draw();
        if (isVideo) {
          const video = element as HTMLVideoElement;
          if ("requestVideoFrameCallback" in video) {
            const loop = () => { frameCallback = video.requestVideoFrameCallback(() => { draw(); loop(); }); };
            loop();
          } else {
            const loop = () => { draw(); animationFrame = requestAnimationFrame(loop); };
            animationFrame = requestAnimationFrame(loop);
          }
        }
        cleanup = () => {
          drawRef.current = () => undefined;
          events.forEach(name => element.removeEventListener(name, draw));
          videoSourceUpload?.dispose();
          if (frameCallback && "cancelVideoFrameCallback" in (element as HTMLVideoElement)) (element as HTMLVideoElement).cancelVideoFrameCallback(frameCallback);
          if (animationFrame) cancelAnimationFrame(animationFrame);
          for (const item of framebuffers()) gl.deleteFramebuffer(item.framebuffer);
          textures.forEach(value => gl.deleteTexture(value));
          gl.deleteBuffer(quad);
          [gradeProgram, brightProgram, blurProgram, finishProgram].forEach(value => gl.deleteProgram(value));
        };
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setStatus("error");
        setError(reason instanceof Error ? reason.message : String(reason));
      }).finally(()=>{preparedClosed=true;reportClosed();});
    return () => { cancelled = true; cleanup(); reportClosed(); };
    // gradeKey stands in for the grade object; management/asset identity changes rebuild the pipeline.
  }, [asset, isVideo, management, source, gradeKey, aces, reconstruct, readLut, rec709Input,frameOwnerKey]);

  return <>
    <canvas ref={canvasRef} className={className} style={style} role="img" aria-label={uiText("{value0} · Color Grade v2 預覽", { value0: asset.name })}
      data-testid={testId} data-grade-status={status} data-grade-v2={grade ? "on" : "off"} title={error} />
    {isVideo ? <video ref={(node) => { mediaRef.current = node; videoRef?.(node); }} src={source} playsInline muted={muted} preload="auto" aria-hidden style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />
      : <img ref={imageRef} src={source} alt="" aria-hidden draggable={false} style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />}
  </>;
}
