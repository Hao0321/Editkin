import { describe, expect, it } from "vitest";
import type { MediaAsset } from "../domain/types";
import { sourceAlphaNormalizationFilters } from "./ffmpeg";

const asset = (alphaMode?: MediaAsset["alphaMode"]): MediaAsset => ({
  id: "alpha", name: "alpha.png", kind: "image", uri: "alpha.png", duration: 1, alphaMode,
});

describe("formal export source alpha normalization", () => {
  it("unpremultiplies before color, transforms, masks and source-over", () => {
    expect(sourceAlphaNormalizationFilters(asset("premultiplied"))).toEqual(["unpremultiply=inplace=1"]);
  });

  it("supports forced opaque and preserves compatible auto/straight defaults", () => {
    expect(sourceAlphaNormalizationFilters(asset("opaque"))).toEqual(["lut=a=255"]);
    expect(sourceAlphaNormalizationFilters(asset("opaque"), 65535)).toEqual(["lut=a=65535"]);
    expect(sourceAlphaNormalizationFilters(asset("straight"))).toEqual([]);
    expect(sourceAlphaNormalizationFilters(asset())).toEqual([]);
  });
});
