import{describe,expect,it}from"vitest";import{createHash}from"node:crypto";
import{gopPacketWindowV2,verifyGopPacketCopyV2,parseGopSourcePacketV2,type GopSourcePacketV2}from"./gopPacketWitnessV2";
const limits={maxPrerollTicks:100,maxReorderTicks:100,maxPendingPackets:64,maxGopPackets:8192},tb={numerator:1,denominator:10};
const packet=(pts:number,dts:number,key=false):GopSourcePacketV2=>({pts,dts,duration:10,pos:2**32,size:7,key,discard:pts<0});
const witness=(p:GopSourcePacketV2,sourcePts=p.pts)=>({payloadSha256:createHash("sha256").update(String(sourcePts)).digest("hex"),idr:p.key,nalCount:1,bytes:7});
const pts=[0,30,10,20,50,40];
describe("bounded GOP source/raw prefix proof",()=>{
 it("preserves closest preceding IDR andnegative presentation preroll with original decode-order clock",()=>{
  const source=gopPacketWindowV2(70,120,tb,"source",limits),output=gopPacketWindowV2(0,50,tb,"output",limits);
  for(let group=0;group<3;group++)for(let i=0;i<pts.length;i++){const p=packet(group*60+pts[i],group*60+(i-1)*10,i===0);source.accept(p,witness(p));if(group===1){const o={...p,pts:p.pts-70,dts:p.dts-70,discard:p.pts<70};output.accept(o,witness(o,p.pts));}}
  const sourceProof=source.finish(180),outputProof=output.finish(50);expect(verifyGopPacketCopyV2(sourceProof,outputProof)).toMatchObject({copiedPackets:6,prerollTicks:10,rawGopPrefixAndPayloadExact:true});
  const scaled=gopPacketWindowV2(0,100,{numerator:1,denominator:20},"output",limits);for(let i=0;i<pts.length;i++){const p=packet(60+pts[i],60+(i-1)*10,i===0),o={...p,pts:(p.pts-70)*2,dts:(p.dts-70)*2,duration:20,discard:p.pts<70};scaled.accept(o,witness(o,p.pts));}expect(verifyGopPacketCopyV2(sourceProof,scaled.finish(100)).copiedPackets).toBe(6);
  expect(()=>verifyGopPacketCopyV2({...sourceProof,payloadAndDecodeTimelineSha256:"unknown"},{...outputProof,payloadAndDecodeTimelineSha256:"unknown"})).toThrow("SHAPE_INVALID");
 });
 it("accepts a proved whole dependency prefix andrefuses anendpoint requiring a future presentation reference",()=>{
  const good=gopPacketWindowV2(0,40,tb,"source",limits);for(let i=0;i<pts.length;i++){const p=packet(pts[i],(i-1)*10,i===0);good.accept(p,witness(p));}expect(good.finish(60).retainedPackets).toBe(4);
  const bad=gopPacketWindowV2(0,30,tb,"source",limits);bad.accept(packet(0,-10,true),witness(packet(0,-10,true)));expect(()=>bad.accept(packet(30,0),witness(packet(30,0)))).toThrow("POSTROLL");expect(()=>bad.finish(60)).toThrow("POSTROLL");
 });
 it("requires true IDR, complete reorder coverage, exactstart, boundedpreroll andunchanged payload/clock",()=>{
  const fake=packet(0,-10,true);expect(()=>gopPacketWindowV2(0,60,tb,"source",limits).accept(fake,{...witness(fake),idr:false})).toThrow("IDR");
  const gap=gopPacketWindowV2(0,60,tb,"source",limits);gap.accept(fake,witness(fake));gap.accept(packet(30,0),witness(packet(30,0)));expect(()=>gap.finish(60)).toThrow("INCOMPLETE");
  const duplicate=gopPacketWindowV2(0,60,tb,"source",limits);duplicate.accept(fake,witness(fake));expect(()=>duplicate.accept(packet(0,0),witness(packet(0,0)))).toThrow("DUPLICATE");
  const small=gopPacketWindowV2(0,60,tb,"output",{...limits,maxPrerollTicks:0}),negative=packet(-10,-20,true);expect(()=>small.accept(negative,witness(negative))).toThrow("PREROLL");
 });
 it("parses actualdiscard flags andlarge offsets withoutchanging old parser",()=>{
  expect(parseGopSourcePacketV2("pts=-1536|dts=-2048|duration=512|size=2077|pos=4294967297|flags=KD_")).toMatchObject({discard:true,key:true,pos:4294967297,pts:-1536});
  expect(()=>parseGopSourcePacketV2("pts=0|dts=0|duration=512|size=1|pos=1|flags=XC_")).toThrow();
 });
});
