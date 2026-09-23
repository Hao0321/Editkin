import type { AcesOutputTransform } from "../domain/types";
import type { VideoEncoder } from "./ffmpegTypes";

/** Metadata only: this neither converts pixels nor creates HDR mastering data. */
export function outputColorMetadataArgs(encoder: VideoEncoder, outputTransform: AcesOutputTransform): string[] {
  let primaries = "bt709";
  let transfer = "bt709";
  let matrix = "bt709";
  let description = "colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1";
  switch (outputTransform) {
    case "rec709_sdr": break;
    case "rec2100_hlg_1000":
    case "rec2100_pq_1000":
      primaries = "bt2020";
      transfer = outputTransform === "rec2100_hlg_1000" ? "arib-std-b67" : "smpte2084";
      matrix = "bt2020nc";
      description = `colour_primaries=9:transfer_characteristics=${outputTransform === "rec2100_hlg_1000" ? 18 : 16}:matrix_coefficients=9`;
      break;
    case "p3d65_sdr":
      // Preserve the existing composite options only. Its P3 transfer/matrix
      // contract needs a separate measured repair; do not stamp Rec.709 VUI.
      return ["-color_primaries", "bt709", "-colorspace", "bt709", "-color_trc", "bt709"];
    default: throw new Error(`Unsupported output colour metadata transform: ${String(outputTransform)}`);
  }
  const args = ["-color_primaries", primaries, "-colorspace", matrix, "-color_trc", transfer];
  // The bundled encoder may omit primaries/transfer from VUI despite the output
  // flags. Stamp the encoded colour description, never the wrong codec family.
  switch (encoder) {
    case "libx264":
    case "h264_nvenc":
    case "h264_videotoolbox": return [...args, "-bsf:v", `h264_metadata=${description}`];
    case "libx265":
    case "hevc_nvenc":
    case "hevc_videotoolbox": return [...args, "-bsf:v", `hevc_metadata=${description}`];
    case "prores_ks": return args;
    default: throw new Error(`Unsupported output colour metadata encoder: ${String(encoder)}`);
  }
}
