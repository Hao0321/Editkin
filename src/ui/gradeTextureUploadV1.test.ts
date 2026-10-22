import { describe, expect, it, vi } from "vitest";
import { uploadRgbFloatCubeV1 } from "./gradeTextureUploadV1";
describe("RGB32F LUT upload on a reused media context", () => {
  it("clears retained DOM flags before the exact original table is uploaded", () => {
    const state = new Map([[1, 1], [2, 1], [3, 4]]), order: string[] = [];
    const gl = { UNPACK_FLIP_Y_WEBGL: 1, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 2, UNPACK_ALIGNMENT: 3,
      TEXTURE_3D: 4, RGB32F: 5, RGB: 6, FLOAT: 7,
      pixelStorei: (key: number, value: number) => { state.set(key, value); order.push(`state-${key}`); },
      texImage3D: vi.fn(() => { expect(state.get(1)).toBe(0); expect(state.get(2)).toBe(0); expect(state.get(3)).toBe(1); order.push("upload"); }),
    } as unknown as WebGL2RenderingContext;
    const data = Float32Array.from({ length: 24 }, (_, i) => i / 24);
    uploadRgbFloatCubeV1(gl, 2, data);
    expect(order).toEqual(["state-1", "state-2", "state-3", "upload"]);
    expect(gl.texImage3D).toHaveBeenCalledWith(4, 0, 5, 2, 2, 2, 0, 6, 7, data);
    expect(data[23]).toBeCloseTo(23 / 24);
  });
  it("refuses malformed cube data before altering GL state", () => {
    const gl = { pixelStorei: vi.fn(), texImage3D: vi.fn() } as unknown as WebGL2RenderingContext;
    expect(() => uploadRgbFloatCubeV1(gl, 2, new Float32Array(23))).toThrow();
    expect(gl.pixelStorei).not.toHaveBeenCalled(); expect(gl.texImage3D).not.toHaveBeenCalled();
  });
});
