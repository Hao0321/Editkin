/** Reuse one normalized video surface. Direct video-to-WebGL upload on the
 * measured Chrome/ANGLE path corrupts the last row; the same video's Canvas2D
 * readback is intact. No per-frame ImageData, retained frame queue or disk cache.
 * The caller still owns GL binding, flip and premultiplication state. */
export const GRADE_VIDEO_SOURCE_MAX_BYTES_V2=128*1024**2;
export function gradeVideoSourceSizeV2(width:number,height:number) {
  return [width,height].every(v=>Number.isSafeInteger(v)&&v>0&&v<=8192)&&width*height*4<=GRADE_VIDEO_SOURCE_MAX_BYTES_V2;
}
export class GradeVideoSourceUploadErrorV2 extends Error {
  constructor(readonly code:"FRAME_BUDGET"|"CONTEXT"|"CLOSED"){super("GRADE_VIDEO_SOURCE_"+code);this.name="GradeVideoSourceUploadErrorV2";}
}
export function createGradeVideoSourceUploadV2(gl:WebGL2RenderingContext) {
  let canvas:HTMLCanvasElement|undefined,context:CanvasRenderingContext2D|undefined,closed=false,unavailable=false;
  return {
    upload(source:HTMLVideoElement) {
      if(closed)throw new GradeVideoSourceUploadErrorV2("CLOSED");
      const width=source.videoWidth,height=source.videoHeight;
      if(!gradeVideoSourceSizeV2(width,height))throw new GradeVideoSourceUploadErrorV2("FRAME_BUDGET");
      if(unavailable)throw new GradeVideoSourceUploadErrorV2("CONTEXT");
      if(!canvas) {
        const candidate=document.createElement("canvas"),ctx=candidate.getContext("2d",{alpha:true,colorSpace:"srgb"});
        if(!ctx){candidate.width=candidate.height=1;unavailable=true;throw new GradeVideoSourceUploadErrorV2("CONTEXT");}
        canvas=candidate;context=ctx;
      }
      if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
      // A new transparent video frame must not blend over the previous one.
      context!.clearRect(0,0,width,height);context!.drawImage(source,0,0,width,height);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,canvas);
    },
    dispose() {
      if(canvas)canvas.width=canvas.height=1;
      canvas=undefined;context=undefined;closed=true;
    },
  };
}
