import type { LongformUiFocusGeometryWitnessV1, LongformUiFocusRasterSizeV1 } from "../domain/longformUiFocusProjectGeometryV1";
type Stage="clock"|"layout"|"input"|"scaled"|"output"|"position";
type Image={frame:number;pts:number;size:LongformUiFocusRasterSizeV1};
const integer=(value:string)=>{const n=Number(value);if(!Number.isSafeInteger(n))throw Error("UI_FOCUS_GEOMETRY_TRACE_INTEGER");return n;};
/** Bounded actual named-filter observation. This records raster geometry only;
 * it cannot prove OCR targets or substitute for the owned source/PTS clock. */
export class LongformUiFocusProjectGeometryTraceV1 {
  private fit?:LongformUiFocusRasterSizeV1;
  private readonly bases=new Set<string>();
  private readonly rows=new Map<number,Partial<Record<Stage,Image>>>();
  private readonly placements=new Map<number,{x:number;y:number}>();
  private readonly counts=new Map<Stage,number>();
  private next=0;
  constructor(private readonly startFrame:number,private readonly timeBase:{numerator:number;denominator:number},
    private readonly mode:LongformUiFocusGeometryWitnessV1["affine"]["mode"],private readonly emit:(value:LongformUiFocusGeometryWitnessV1)=>void,private readonly placementOriginFrame=0) {
    if(!Number.isSafeInteger(startFrame)||startFrame<0||![timeBase.numerator,timeBase.denominator].every(n=>Number.isSafeInteger(n)&&n>0)
      ||!Number.isSafeInteger(placementOriginFrame)||placementOriginFrame<0||placementOriginFrame>startFrame
      ||!["scale-rotate","fixed-perspective"].includes(mode))throw Error("UI_FOCUS_GEOMETRY_TRACE_CONFIG");
  }
  line(line:string){
    if(line.length>65536)throw Error("UI_FOCUS_GEOMETRY_TRACE_LINE_BUDGET");
    const tag=/^\[(showinfo@uif_(fit|clock|layout|input|scaled|output|position)|overlay@uif_place) @ [^\]]+\]\s+(.*)$/.exec(line);
    if(!tag)return;
    const name=tag[2],text=tag[3];
    if(tag[1]==="overlay@uif_place"){
      const match=/\bn:\s*(\S+)\s+t:\s*(\S+).*?\bxi:\s*(-?\d+)\s+y:\s*\S+\s+yi:\s*(-?\d+)/.exec(text);
      if(!match){if(/^n:/.test(text))throw Error("UI_FOCUS_GEOMETRY_TRACE_PLACEMENT");return;}
      const time=Number(match[2]),frame=Math.round(time*this.timeBase.denominator/this.timeBase.numerator);
      if(!Number.isFinite(time)||!Number.isSafeInteger(frame)||Math.abs(time-frame*this.timeBase.numerator/this.timeBase.denominator)>1e-5
        ||Math.abs(Number(match[1])-(frame-this.placementOriginFrame+1))>1e-5)throw Error("UI_FOCUS_GEOMETRY_TRACE_PLACEMENT_CLOCK");
      if(frame<this.startFrame)return;
      if(frame<this.startFrame+this.next||this.placements.has(frame))throw Error("UI_FOCUS_GEOMETRY_TRACE_PLACEMENT_ORDER");
      this.placements.set(frame,{x:integer(match[3]),y:integer(match[4])});this.flush();return;
    }
    const base=/^config in time_base:\s*(\d+)\/(\d+)/.exec(text);
    if(base){
      if(this.bases.has(name)||name!=="fit"&&(integer(base[1])!==this.timeBase.numerator||integer(base[2])!==this.timeBase.denominator))
        throw Error("UI_FOCUS_GEOMETRY_TRACE_TIME_BASE");
      this.bases.add(name);return;
    }
    const image=/^n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\S+.*?\bfmt:\w+\b.*?\bs:(\d+)x(\d+)\b.*?\bchecksum:[A-F0-9]{8}\b/.exec(text);
    if(!image){if(/^n:/.test(text))throw Error("UI_FOCUS_GEOMETRY_TRACE_IMAGE");return;}
    if(!this.bases.has(name))throw Error("UI_FOCUS_GEOMETRY_TRACE_TIME_BASE");
    const value={frame:integer(image[1]),pts:integer(image[2]),size:{width:integer(image[3]),height:integer(image[4])}};
    if(value.frame>=65536||value.size.width<1||value.size.height<1||value.size.width>16384||value.size.height>16384
      ||value.size.width*value.size.height>64_000_000)throw Error("UI_FOCUS_GEOMETRY_TRACE_RASTER_BUDGET");
    if(name==="fit"){
      if(this.fit&&(this.fit.width!==value.size.width||this.fit.height!==value.size.height))throw Error("UI_FOCUS_GEOMETRY_TRACE_FIT_CHANGED");
      this.fit=value.size;return;
    }
    const stage=name as Stage,count=this.counts.get(stage)??0;
    if(value.frame!==count)throw Error("UI_FOCUS_GEOMETRY_TRACE_IMAGE_ORDER");this.counts.set(stage,count+1);
    const row=this.rows.get(value.frame)??{};if(row[stage])throw Error("UI_FOCUS_GEOMETRY_TRACE_IMAGE_ORDER");row[stage]=value;this.rows.set(value.frame,row);
    this.flush();
  }
  private flush(){
    while(this.fit){
      const row=this.rows.get(this.next),placement=this.placements.get(this.startFrame+this.next);
      if(!row?.clock||!row.layout||!row.input||!row.scaled||!row.output||!row.position||!placement)break;
      if(row.position.pts!==this.startFrame+this.next||[row.layout,row.input,row.scaled,row.output].some(value=>value.pts!==row.clock!.pts))
        throw Error("UI_FOCUS_GEOMETRY_TRACE_FRAME_BINDING");
      const value:LongformUiFocusGeometryWitnessV1={schema:"editkin.longform-ui-focus-geometry-witness/v1",projectFrame:row.position.pts,
        geometryPts:row.clock.pts,timeBase:{...this.timeBase},fit:{...this.fit},layout:{...row.layout.size},
        affine:{mode:this.mode,input:{...row.input.size},scaled:{...row.scaled.size},output:{...row.output.size}},placement:{...placement}};
      this.rows.delete(this.next);this.placements.delete(value.projectFrame);this.next++;this.emit(value);
    }
    if(this.rows.size>128||this.placements.size>128)throw Error("UI_FOCUS_GEOMETRY_TRACE_PENDING_BUDGET");
  }
  finish(){
    if(!this.next||this.rows.size||this.placements.size||["clock","layout","input","scaled","output","position"].some(stage=>this.counts.get(stage as Stage)!==this.next))
      throw Error("UI_FOCUS_GEOMETRY_TRACE_INCOMPLETE");
    return{framesObserved:this.next,fit:{...this.fit!},sourceTargetVerified:false as const};
  }
}
