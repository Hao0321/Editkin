import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MediaAsset } from "../domain/types";
import { sourceAlphaNormalizationFilters } from "./ffmpeg";

const asset = (alphaMode?: MediaAsset["alphaMode"]): MediaAsset => ({
  id: "alpha", name: "alpha.png", kind: "image", uri: "alpha.png", duration: 1, alphaMode,
});

describe("formal export source alpha normalization", () => {
  it("unpremultiplies before color, transforms, masks and source-over", () => {
    expect(sourceAlphaNormalizationFilters(asset("premultiplied"))).toEqual(["setparams=alpha_mode=premultiplied", "unpremultiply=inplace=1"]);
  });

  it("supports forced opaque and preserves compatible auto/straight defaults", () => {
    expect(sourceAlphaNormalizationFilters(asset("opaque"))).toEqual(["lut=a=255"]);
    expect(sourceAlphaNormalizationFilters(asset("opaque"), 65535)).toEqual(["lut=a=65535"]);
    expect(sourceAlphaNormalizationFilters(asset("straight"))).toEqual([]);
    expect(sourceAlphaNormalizationFilters(asset())).toEqual([]);
  });

  it("restores straight colour from a declared premultiplied 8-bit source in the pinned FFmpeg", () => {
    // FFmpeg 8.1 leaves untagged frames untouched in `unpremultiply`; this pixel check fails if the tag is lost.
    const ffmpeg = process.platform === "win32" ? resolve(fileURLToPath(new URL("../../", import.meta.url)), "vendor/ffmpeg/win32-x64/ffmpeg.exe") : "ffmpeg";
    const straight = [[10, 31, 76, 64], [204, 178, 153, 191], [255, 255, 255, 255], [0, 0, 0, 0]];
    const input = Buffer.from(straight.flatMap(([r, g, b, a]) => [r, g, b].map((value) => Math.round(value * a / 255)).concat(a)));
    const result = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "2x2", "-i", "pipe:0",
      "-vf", ["format=rgba", ...sourceAlphaNormalizationFilters(asset("premultiplied"))].join(","), "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"],
    { input, windowsHide: true, timeout: 15_000 });
    expect(result.status, result.stderr?.toString()).toBe(0);
    straight.forEach((pixel, index) => pixel.forEach((value, channel) => expect(Math.abs(result.stdout[index * 4 + channel] - value)).toBeLessThanOrEqual(3)));
  });
});
