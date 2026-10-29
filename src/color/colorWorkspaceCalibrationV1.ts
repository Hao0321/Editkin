import { cieDeltaE2000V1, linearRec709ToCieLabD65V1 } from "./cieDeltaE2000V1";
import { displayToLinear, type Vec3 } from "./gradeV2Color";

export interface ColorWorkspaceCalibrationFrameV1 {
  width:number;
  height:number;
  data:Uint8Array|Uint8ClampedArray;
  /** Both buffers must first be normalized to these primaries and full-range codes.
   * This is not a tag override or a transform for raw HDR, P3, Log or ACEScct samples. */
  primaries:"rec709-d65";
  transfer:"srgb"|"bt1886";
}
export const COLOR_WORKSPACE_CALIBRATION_LIMITS_V1=Object.freeze({p99DeltaE00:2,maximumDeltaE00:5,maxPixels:230400,maxDimension:4096});

function check(frame:ColorWorkspaceCalibrationFrameV1) {
  if(!frame||frame.primaries!=="rec709-d65"||!["srgb","bt1886"].includes(frame.transfer))throw Error("COLOR_CALIBRATION_ENCODING");
  const {width,height,data}=frame,pixels=width*height;
  if(![width,height].every(v=>Number.isSafeInteger(v)&&v>0&&v<=COLOR_WORKSPACE_CALIBRATION_LIMITS_V1.maxDimension)
    ||!Number.isSafeInteger(pixels)||pixels>COLOR_WORKSPACE_CALIBRATION_LIMITS_V1.maxPixels
    ||!(data instanceof Uint8Array||data instanceof Uint8ClampedArray)||!(data.buffer instanceof ArrayBuffer)
    ||(data.buffer as ArrayBuffer&{resizable?:boolean}).resizable||data.byteLength!==pixels*4)
    throw Error("COLOR_CALIBRATION_FRAME_BUDGET");
  for(let i=3;i<data.length;i+=4)if(data[i]!==255)throw Error("COLOR_CALIBRATION_OPAQUE_REQUIRED");
  return pixels;
}
function decode(value:number,transfer:ColorWorkspaceCalibrationFrameV1["transfer"]) {
  const v=value/255;
  return transfer==="bt1886"?displayToLinear(v):v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
}
function lab(frame:ColorWorkspaceCalibrationFrameV1,index:number) {
  const rgb:Vec3=[decode(frame.data[index],frame.transfer),decode(frame.data[index+1],frame.transfer),decode(frame.data[index+2],frame.transfer)];
  return linearRec709ToCieLabD65V1(rgb);
}

/** W1-5's fixed CIEDE2000 frame-pair gate. Explicit display decodes avoid comparing
 * browser sRGB codes directly to the formal renderer's BT.1886 display codes.
 * No sampling, ignored alpha pixels, metric retuning or caller-supplied limits.
 * A passing pair is a numerical control, never sufficient evidence to enable a
 * workspace route or claim GradedMedia/WebView2/footage parity. */
export function measureColorWorkspaceCalibrationV1(preview:ColorWorkspaceCalibrationFrameV1,reference:ColorWorkspaceCalibrationFrameV1) {
  const pixels=check(preview);check(reference);
  if(preview.width!==reference.width||preview.height!==reference.height)throw Error("COLOR_CALIBRATION_GEOMETRY");
  const errors=new Float64Array(pixels);let maximum=0,total=0,worst=0;
  for(let i=0;i<pixels;i++) {
    const error=cieDeltaE2000V1(lab(preview,i*4),lab(reference,i*4));
    if(!Number.isFinite(error))throw Error("COLOR_CALIBRATION_NONFINITE_METRIC");
    errors[i]=error;total+=error;if(error>maximum){maximum=error;worst=i;}
  }
  errors.sort();const p99=errors[Math.ceil(pixels*.99)-1];
  return {schema:"editkin.color-workspace-frame-calibration/v1" as const,
    comparisonSpace:"CIELAB-D65-relative" as const,metric:"CIEDE2000-kL-kC-kH-1" as const,
    scope:"provided-normalized-opaque-frame-pair-only" as const,
    width:preview.width,height:preview.height,comparedPixels:pixels,
    transfer:{preview:preview.transfer,reference:reference.transfer},
    deltaE00:{p99,maximum,mean:total/pixels,worstPixel:{x:worst%preview.width,y:Math.floor(worst/preview.width)}},
    limits:{p99:COLOR_WORKSPACE_CALIBRATION_LIMITS_V1.p99DeltaE00,maximum:COLOR_WORKSPACE_CALIBRATION_LIMITS_V1.maximumDeltaE00},
    passesFixedFrameGate:p99<=2&&maximum<=5,
    routeCalibrationComplete:false as const,browserNativeParityMeasured:false as const,sourceMediaMeasured:false as const};
}
