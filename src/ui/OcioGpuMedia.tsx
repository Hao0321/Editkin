import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ColorAdjustments, ColorManagementSettings, MediaAsset } from "../domain/types";
import { buildOcioFragmentShader, OCIO_VERTEX_SHADER, ocioGradeUniformValues, resolveOcioGpuPipeline, type OcioGpuStage, type OcioGpuTexture } from "../color/ocioGpu";

interface OcioGpuMediaProps {
  asset: MediaAsset;
  color: ColorAdjustments;
  management: ColorManagementSettings;
  source: string;
  className?: string;
  style?: CSSProperties;
  muted?: boolean;
  videoRef?: (node: HTMLVideoElement | null) => void;
  testId: "preview-image" | "preview-video";
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL 無法建立 OCIO shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const detail = gl.getShaderInfoLog(shader) ?? "unknown shader error";
    gl.deleteShader(shader);
    throw new Error(`OCIO GPU shader 編譯失敗：${detail}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, fragmentSource: string): WebGLProgram {
  const vertex = compile(gl, gl.VERTEX_SHADER, OCIO_VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error("WebGL 無法建立 OCIO program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const detail = gl.getProgramInfoLog(program) ?? "unknown link error";
    gl.deleteProgram(program);
    throw new Error(`OCIO GPU program link 失敗：${detail}`);
  }
  return program;
}

function uploadLutTexture(gl: WebGL2RenderingContext, program: WebGLProgram, definition: OcioGpuTexture, unit: number): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error(`WebGL 無法建立 OCIO texture：${definition.name}`);
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const internalFormat = definition.channels === 1 ? gl.R32F : gl.RGB32F;
  const format = definition.channels === 1 ? gl.RED : gl.RGB;
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, definition.width, definition.height, 0, format, gl.FLOAT, new Float32Array(definition.values));
  const filter = definition.interpolation === "nearest" ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const uniform = gl.getUniformLocation(program, definition.sampler);
  if (!uniform) throw new Error(`OCIO shader 缺少 sampler：${definition.sampler}`);
  gl.uniform1i(uniform, unit);
  return texture;
}

function stageTextures(stages: OcioGpuStage[]): OcioGpuTexture[] {
  return stages.flatMap((stage) => stage.textures);
}

function uploadGradeUniforms(gl: WebGL2RenderingContext, program: WebGLProgram, stages: OcioGpuStage[], color: ColorAdjustments) {
  const values = ocioGradeUniformValues(color);
  for (const definition of stages.flatMap((stage) => stage.uniforms ?? [])) {
    const location = gl.getUniformLocation(program, definition.name);
    if (location === null) throw new Error(`OCIO shader 缺少 uniform：${definition.name}`);
    const value = values[definition.name] ?? definition.default;
    if (definition.type === "bool") gl.uniform1i(location, value ? 1 : 0);
    else if (definition.type === "float") gl.uniform1f(location, Number(value));
    else {
      if (!Array.isArray(value) || value.length !== 3) throw new Error(`OCIO vec3 uniform 不合法：${definition.name}`);
      gl.uniform3fv(location, value);
    }
  }
  const hue = gl.getUniformLocation(program, "editkin_grade_hue_radians");
  if (hue === null) throw new Error("OCIO shader 缺少 hue uniform");
  gl.uniform1f(hue, Number(values.editkin_grade_hue_radians));
}

export default function OcioGpuMedia({ asset, color, management, source, className, style, muted = true, videoRef, testId }: OcioGpuMediaProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const mediaRef = useRef<HTMLVideoElement>(null);
  const colorRef = useRef(color);
  const drawRef = useRef<() => void>(() => undefined);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const isVideo = asset.kind === "video";
  colorRef.current = color;

  useEffect(() => drawRef.current(), [color]);

  useEffect(() => {
    let cancelled = false;
    let frameCallback = 0;
    let animationFrame = 0;
    let cleanup = () => undefined;
    setStatus("loading");
    setError(undefined);

    void resolveOcioGpuPipeline(asset, management).then(({ input, grade, output }) => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      const element = isVideo ? mediaRef.current : imageRef.current;
      if (!canvas || !element) throw new Error("OCIO GPU 預覽媒體尚未掛載");
      const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: false });
      if (!gl) throw new Error("此裝置沒有 WebGL2，無法執行 OCIO GPU 預覽");
      const stages = [input, grade, output];
      const program = createProgram(gl, buildOcioFragmentShader(input, grade, output));
      gl.useProgram(program);

      const vertices = gl.createBuffer();
      if (!vertices) throw new Error("WebGL 無法建立 OCIO vertex buffer");
      gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "editkin_position");
      if (position < 0) throw new Error("OCIO shader 缺少 editkin_position");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

      const sourceTexture = gl.createTexture();
      if (!sourceTexture) throw new Error("WebGL 無法建立來源 texture");
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const sourceUniform = gl.getUniformLocation(program, "editkin_source");
      if (!sourceUniform) throw new Error("OCIO shader 缺少 editkin_source");
      gl.uniform1i(sourceUniform, 0);
      const lutTextures = stageTextures(stages).map((definition, index) => uploadLutTexture(gl, program, definition, index + 1));

      const draw = () => {
        if (cancelled) return;
        const width = isVideo ? (element as HTMLVideoElement).videoWidth : (element as HTMLImageElement).naturalWidth;
        const height = isVideo ? (element as HTMLVideoElement).videoHeight : (element as HTMLImageElement).naturalHeight;
        if (!width || !height || (isVideo && (element as HTMLVideoElement).readyState < HTMLMediaElement.HAVE_CURRENT_DATA)) return;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        gl.viewport(0, 0, width, height);
        gl.useProgram(program);
        uploadGradeUniforms(gl, program, stages, colorRef.current);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, element);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        setStatus("ready");
      };
      drawRef.current = draw;
      const events = isVideo ? ["loadeddata", "seeked", "timeupdate", "play"] : ["load"];
      events.forEach((name) => element.addEventListener(name, draw));
      draw();
      if (isVideo) {
        const video = element as HTMLVideoElement;
        if ("requestVideoFrameCallback" in video) {
          const loop = () => {
            frameCallback = video.requestVideoFrameCallback(() => { draw(); loop(); });
          };
          loop();
        } else {
          const loop = () => { draw(); animationFrame = requestAnimationFrame(loop); };
          animationFrame = requestAnimationFrame(loop);
        }
      }
      cleanup = () => {
        drawRef.current = () => undefined;
        events.forEach((name) => element.removeEventListener(name, draw));
        if (frameCallback && "cancelVideoFrameCallback" in (element as HTMLVideoElement)) (element as HTMLVideoElement).cancelVideoFrameCallback(frameCallback);
        if (animationFrame) cancelAnimationFrame(animationFrame);
        lutTextures.forEach((texture) => gl.deleteTexture(texture));
        gl.deleteTexture(sourceTexture);
        gl.deleteBuffer(vertices);
        gl.deleteProgram(program);
      };
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setStatus("error");
      setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [asset, isVideo, management, source]);

  return <>
    <canvas ref={canvasRef} className={className} style={style} role="img" aria-label={`${asset.name} · ACES 2.0 OCIO GPU 預覽`} data-testid={testId} data-ocio-status={status} title={error} />
    {isVideo
      ? <video ref={(node) => { mediaRef.current = node; videoRef?.(node); }} src={source} playsInline muted={muted} preload="auto" aria-hidden style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />
      : <img ref={imageRef} src={source} alt="" aria-hidden draggable={false} style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />}
  </>;
}
