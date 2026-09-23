import type { ColorManagementSettings, MediaColorMetadata } from "../domain/types";
import type { ShotColorAnalysis } from "../color/shotColorAnalysis";

export interface MaterialColorRuntime { ffmpegPath: string; ffprobePath?: string; timeoutMs?: number; signal?: AbortSignal }
export interface MaterialColorRuntimeIdentity {
  schema: "editkin.material-color-runtime/v1";
  status: "verified" | "unmeasured";
  reason?: string;
  tools: Array<{ role: "ffmpeg" | "ffprobe"; sha256: string; version: string }>;
  implementations: Array<{ name: string; sha256: string }>;
  code?: {mode:"source"|"bundle";entry:string;sha256:string;size:number;manifestSha256?:string};
  identitySha256: string;
}
export interface MaterialColorRequest {
  sourcePath: string; sourceSha256: string; sourceStart: number; duration: number;
  kind: "video" | "audio" | "image";
  color?: MediaColorMetadata; colorManagement?: ColorManagementSettings;
  samples: Array<{ id: string; time: number; sceneIndex: number }>;
  sceneCount: number; sceneCountVerified?: boolean; sceneCuts?: number[];
}
export interface MaterialColorMapping {
  id: string; sceneIndex: number; requestedSceneIndex: number; requestedTime: number;
  decodedPts: number; timeBase: { numerator: number; denominator: number };
  decodedSourceTime: number; decodedRelativeTime: number;
  width: number; height: number; rawRgbSha256: string;
}
export interface MaterialColorRequestSnapshot {
  kind: MaterialColorRequest["kind"]; color: MediaColorMetadata|null;
  colorManagement: ColorManagementSettings; samples: MaterialColorRequest["samples"];
  sceneCount: number; sceneCountVerified: boolean; sceneCuts: number[]|null;
}
interface MaterialColorReceiptBase {
  schema: "editkin.material-color-receipt/v1"; receiptSha256: string;
  identity: MaterialColorRuntimeIdentity;
  request: MaterialColorRequestSnapshot;
  source: { sha256: string; start: number; duration: number; beforeSha256?: string; afterSha256?: string };
  coverage: { requestedCount: number; sampledCount: number; sceneCount: number; sceneCountVerified: boolean; sceneAttributionVerified: boolean; sceneCuts?: number[]; sampledSceneIndices: number[]; omittedSceneIndices: number[] };
  mapping: MaterialColorMapping[];
  probe?: { sha256: string; metadata: Record<string, unknown>; timelineOrigin: number };
  normalization?: { interpretation: "rec709" | "hlg" | "pq"; filters: string[]; format: "rgb8"; transfer: "bt709-oetf"; primaries: "bt709"; range: "full"; exposure: 0; creativeLook: false };
}
export type MaterialColorReceipt = MaterialColorReceiptBase & (
  { status: "measured"; measurements: ShotColorAnalysis }
  | { status: "unmeasured" | "not_applicable"; reason: string; measurements?: never }
);
