import { describe, expect, it } from "vitest";
import { dispatchColorLutDesktopV1 } from "./colorLutDesktopServiceV1";
import { bindAutoRotoRuntimeToServiceArtifact } from "./autoRotoServiceArtifact";
describe("desktop LUT service admission",()=>{
  it("requires a host-owned configured root",async()=>{await expect(dispatchColorLutDesktopV1({operation:"list"},{})).rejects.toThrow(/未設定/)});
  it("refuses payload-selected storage or media paths for reads",async()=>{
    await expect(dispatchColorLutDesktopV1({operation:"list",libraryRoot:"C:/"},{personalColorLutRoot:"D:/"})).rejects.toThrow();
    await expect(dispatchColorLutDesktopV1({operation:"resolve",sourcePath:"C:/private.txt"},{personalColorLutRoot:"D:/"})).rejects.toThrow();
  });
  it("admits the single host path through the product runtime whitelist and rejects forged research/extra fields",()=>{
    const runtime=bindAutoRotoRuntimeToServiceArtifact({personalColorLutRoot:"D:/owned-library"},"product");
    expect(runtime.personalColorLutRoot).toBe("D:/owned-library");expect(runtime.autoRotoExternalResearchEnabled).toBe(false);
    expect(()=>bindAutoRotoRuntimeToServiceArtifact({personalColorLutRoot:123},"product")).toThrow(/不合法/);
    expect(()=>bindAutoRotoRuntimeToServiceArtifact({personalColorLutRoot:"D:/owned",force:true},"product")).toThrow(/未允許/);
    expect(()=>bindAutoRotoRuntimeToServiceArtifact({personalColorLutRoot:"D:/owned",autoRotoExternalResearchEnabled:true},"product")).toThrow(/未允許/);
  });
});
