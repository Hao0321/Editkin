import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { createRenderWorkDirectory, withRenderWorkRoot } from "./renderWorkspace";
import { assertOwnedStreamWorkspaceV1, createBoundedPngFrameSinkV1 } from "./boundedPngFrameSinkV1";

const temp = useTempRoots();
// This fixture calibrates PNG header/ownership/transport, not native pixels or encoder quality.
function header(width = 1) {
  const bytes = Buffer.alloc(40); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  bytes.writeUInt32BE(13,8); bytes.write("IHDR",12,"ascii"); bytes.writeUInt32BE(width,16); bytes.writeUInt32BE(1,20);
  bytes[24]=8; bytes[25]=6; return bytes;
}
async function fixture(operation: (workspace: string, directory: string) => Promise<void>) {
  const scratch = await temp.create("editkin-stream-sink-test-");
  await withRenderWorkRoot(join(scratch,"out.mp4"),undefined,async () => {
    const workspace = await createRenderWorkDirectory("editkin-resident-aces2-video-");
    const directory = join(workspace,"display-sequence"); await mkdir(directory); await operation(workspace,directory);
  });
}
describe("bounded owned frame consumption", () => {
  it("passes each compressed byte unchanged, waits for the writer and removes only the consumed frame", async () => fixture(async (workspace,directory) => {
    let finish!: () => void, seen: Uint8Array | undefined;
    const sink = createBoundedPngFrameSinkV1({ workspace,directory,width:1,height:1,startFrame:0,frameCount:1,maximumFrameBytes:100,
      signal:new AbortController().signal,write:async bytes => {seen=bytes;await new Promise<void>(resolve=>{finish=resolve;});} });
    const path=join(directory,"frame-00000000.png"), bytes=header();await writeFile(path,bytes);
    const consumed=sink.consume(path,0);
    while (!finish) await new Promise(resolve=>setTimeout(resolve,1));
    expect(await readFile(path)).toEqual(bytes); expect(Buffer.from(seen!)).toEqual(bytes);
    finish();await consumed;sink.assertComplete();expect(sink.receipt.consumedFrames).toBe(1);
    await expect(readFile(path)).rejects.toMatchObject({code:"ENOENT"});
  }));
  it("refuses wrong order, wrong dimensions and oversize data without deleting the source", async () => fixture(async (workspace,directory) => {
    const path=join(directory,"frame-00000000.png");let writes=0;
    const sink=createBoundedPngFrameSinkV1({workspace,directory,width:1,height:1,startFrame:0,frameCount:1,maximumFrameBytes:100,
      signal:new AbortController().signal,write:async()=>{writes++;}});
    await writeFile(path,header(2));await expect(sink.consume(path,1)).rejects.toThrow("ORDER_REFUSED");
    await expect(sink.consume(path,0)).rejects.toThrow("PNG_CONTRACT");expect((await readFile(path)).length).toBe(40);
    await writeFile(path,Buffer.alloc(101));await expect(sink.consume(path,0)).rejects.toThrow("SIZE_REFUSED");expect(writes).toBe(0);
  }));
  it("keeps a frame when the encoder rejects it and rejects foreign ownership", async () => fixture(async (workspace,directory) => {
    const path=join(directory,"frame-00000000.png");await writeFile(path,header());
    const sink=createBoundedPngFrameSinkV1({workspace,directory,width:1,height:1,startFrame:0,frameCount:1,maximumFrameBytes:100,
      signal:new AbortController().signal,write:async()=>{throw Error("encoder failed");}});
    await expect(sink.consume(path,0)).rejects.toThrow("encoder failed");expect((await readFile(path)).length).toBe(40);
    const owner=join(workspace,".editkin-render-work-owner.json"), original=await readFile(owner);
    await writeFile(owner,JSON.stringify({schema:"editkin.render-work-owner/v1",pid:process.pid+1,host:"foreign"}));
    await expect(assertOwnedStreamWorkspaceV1(workspace)).rejects.toThrow("OWNER_INVALID");await writeFile(owner,original);
  }));
});
