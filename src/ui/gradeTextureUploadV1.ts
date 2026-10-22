/** Media draws set DOM upload flags on this reused context. WebGL forbids them for texImage3D. */
export function uploadRgbFloatCubeV1(gl: WebGL2RenderingContext, size: number, values: Float32Array): void {
  if (!Number.isSafeInteger(size) || size < 2 || values.length !== size * size * size * 3) throw new Error("Invalid RGB float cube");
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, size, size, size, 0, gl.RGB, gl.FLOAT, values);
}
