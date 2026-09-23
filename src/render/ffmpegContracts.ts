import type { OpenExrImageSequence } from "../domain/types";

/** Shared data contracts for FFmpeg adapters and delivery implementations. */
export interface MediaProbe {
  duration: number;
  width?: number;
  height?: number;
  /** Original stream raster, excluding codec padding; not display-rotated. */
  encodedWidth?: number;
  encodedHeight?: number;
  /** Raw ffprobe display-matrix angle (legacy rotate tag if no matrix). */
  displayRotationDegrees?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorMatrix?: string;
  colorRange?: string;
  pixelFormat?: string;
  bitsPerRawSample?: number;
  codecName?: string;
  codecProfile?: string;
  audioCodecName?: string;
  imageSequence?: OpenExrImageSequence;
  previewPath?: string;
}

export const HIGH_BIT_DEPTH_ALPHA_PROFILE = "prores4444_alpha_10bit" as const;
export type RenderDeliveryProfile = "standard_mp4" | typeof HIGH_BIT_DEPTH_ALPHA_PROFILE;

export interface HighBitDepthAlphaCapabilityReceipt {
  schema: "editkin.high-bit-depth-alpha-capability/v1";
  status: "GREEN";
  encoder: "prores_ks";
  profile: "4444";
  requestedPixelFormat: "yuva444p10le";
  probedPixelFormat: "yuva444p12le";
  probedBitsPerRawSample: 12;
  configuredAlphaBits: 16;
  decodedAlphaLevels: number;
  effectiveMinimumAlphaBits: 10;
  probeArtifactSha256: string;
  ffmpegVersion: string;
}

export interface HighBitDepthAlphaDeliveryReceipt {
  schema: "editkin.high-bit-depth-alpha-delivery/v1";
  status: "GREEN";
  profile: typeof HIGH_BIT_DEPTH_ALPHA_PROFILE;
  container: "mov";
  codec: "prores";
  codecProfile: "4444";
  workingPixelFormat: "gbrap16le";
  requestedEncoderPixelFormat: "yuva444p10le";
  probedOutputPixelFormat: "yuva444p12le";
  probedBitsPerRawSample: 12;
  configuredAlphaBits: 16;
  verifiedDecodedAlphaLevels: number;
  effectiveMinimumAlphaBits: 10;
  outputSha256: string;
  outputBytes: number;
  capability: HighBitDepthAlphaCapabilityReceipt;
  claimBoundary: string;
}
