import{describe,expect,it}from"vitest";
import{avcGopConfigurationV2}from"./avcGopConfigurationV2";
const data=Buffer.from("0164000affe1001b6764000aacd10426c05a808080a0000003002000000781e244a24001000668ebe0acb22cfdf8f800","hex");
const dump=(b:Buffer)=>"\n"+Array.from({length:Math.ceil(b.length/16)},(_,i)=>`${(i*16).toString(16).padStart(8,"0")}: ${b.subarray(i*16,i*16+16).toString("hex")}  text`).join("\n")+"\n";
describe("versioned AVC GOP config shape",()=>{
 it("parses actual High SPS/PPS geometry/depth andkeeps full decoder admission separate",()=>{expect(avcGopConfigurationV2(dump(data),data.length)).toMatchObject({profileIdc:100,width:64,height:64,bitDepth:8,chromaFormat:1,nalLengthBytes:4,fullCodecAdmission:false});});
 it("rejects header/profile, length/reserved, parameter binding, extension and malformed dump",()=>{for(const [index,value]of [[1,77],[4,253],[5,226],[data.length-4,254],[data.length-1,1]]){const bad=Buffer.from(data);bad[index]=value;expect(()=>avcGopConfigurationV2(dump(bad),bad.length)).toThrow();}expect(()=>avcGopConfigurationV2(dump(data).replace("00000010","00000011"),data.length)).toThrow();expect(()=>avcGopConfigurationV2(dump(data.subarray(0,12)),12)).toThrow();});
});
