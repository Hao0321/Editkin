import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import type { MediaProbe } from "./ffmpegTypes";
import {
  HIGH_BIT_DEPTH_ALPHA_ENCODER_ARGS,
  assertHighBitDepthAlphaDeliveryProject,
  assertHighBitDepthAlphaOutputProbe,
  compositePixelContract,
  highBitDepthAlphaEncoderArgs,
} from "./highBitDepthAlphaDelivery";

const validProbe = (): MediaProbe => ({
  duration: 1,
  hasVideo: true,
  hasAudio: true,
  codecName: "prores",
  codecProfile: "4444",
  pixelFormat: "yuva444p12le",
  bitsPerRawSample: 12,
  audioCodecName: "pcm_s24le",
});

describe("bounded high-bit-depth alpha delivery contract", () => {
  it("compiles the exact self-authored working and encoder contract", () => {
    expect(compositePixelContract(true)).toEqual({
      rgba: "gbrap16le",
      rgb: "gbrp16le",
      gray: "gray16le",
      grayMaximum: 65535,
      encodedPixelFormat: "yuva444p10le",
    });
    expect(highBitDepthAlphaEncoderArgs()).toEqual([...HIGH_BIT_DEPTH_ALPHA_ENCODER_ARGS]);
    expect(highBitDepthAlphaEncoderArgs()).toEqual([
      "-c:v", "prores_ks", "-profile:v", "4", "-alpha_bits", "16", "-vendor", "apl0",
    ]);
  });

  it("accepts the bounded Rec.709 foreground project and MOV boundary", () => {
    expect(() => assertHighBitDepthAlphaDeliveryProject(createDemoProject(), "D:/render/foreground.mov")).not.toThrow();
  });

  it("fails closed for every currently unmeasured precision branch", () => {
    const aces = createDemoProject();
    aces.colorManagement = { ...aces.colorManagement!, mode: "aces2" };
    expect(() => assertHighBitDepthAlphaDeliveryProject(aces, "out.mov")).toThrow(/Rec\.709/);

    const caption = createDemoProject();
    caption.captions.push({ id: "caption", text: "未量測", start: 0, duration: 1 });
    expect(() => assertHighBitDepthAlphaDeliveryProject(caption, "out.mov")).toThrow(/字幕/);

    const blend = createDemoProject();
    blend.tracks[0].clips[0].layer = { enabled: true, blendMode: "screen" };
    expect(() => assertHighBitDepthAlphaDeliveryProject(blend, "out.mov")).toThrow(/安全阻擋/);
    expect(() => assertHighBitDepthAlphaDeliveryProject(createDemoProject(), "out.mp4")).toThrow(/\.mov/);
  });

  it("requires the exact decoded ProRes 4444, alpha pixel format and 24-bit PCM receipt", () => {
    expect(() => assertHighBitDepthAlphaOutputProbe(validProbe())).not.toThrow();
    expect(() => assertHighBitDepthAlphaOutputProbe({ ...validProbe(), pixelFormat: "yuv444p12le" })).toThrow(/pix_fmt/);
    expect(() => assertHighBitDepthAlphaOutputProbe({ ...validProbe(), bitsPerRawSample: 10 })).toThrow(/bits/);
    expect(() => assertHighBitDepthAlphaOutputProbe({ ...validProbe(), audioCodecName: "aac" })).toThrow(/24-bit PCM/);
  });
});
