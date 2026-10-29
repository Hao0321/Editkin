import { describe,expect,it,vi } from "vitest";
import { createTimelineThumbnailQueue } from "./timelineThumbnailQueue";

describe("background filmstrip decoder ownership",()=>{
  it("generates serially, publishes each current source, and revokes owned results once",async()=>{
    let active=0,maximum=0;
    const publish=vi.fn(),revoke=vi.fn(),queue=createTimelineThumbnailQueue([{id:"A",uri:"owned:a"},{id:"B",uri:"owned:b"}],{
      generate:async uri=>{active++;maximum=Math.max(maximum,active);await Promise.resolve();active--;return `blob:${uri}`;},publish,revoke,
    });
    await queue.done;expect(maximum).toBe(1);expect(publish.mock.calls.map(call=>call[0].id)).toEqual(["A","B"]);
    queue.cancel();queue.cancel();expect(revoke.mock.calls.map(call=>call[0])).toEqual(["blob:owned:a","blob:owned:b"]);
  });
  it("never publishes a late old-source result after cancellation and frees it immediately",async()=>{
    let finish!:(uri:string)=>void,start!:()=>void;
    const started=new Promise<void>(resolve=>{start=resolve;}),publish=vi.fn(),revoke=vi.fn();
    const queue=createTimelineThumbnailQueue([{id:"A",uri:"old-source"},{id:"B",uri:"never-decoded"}],{
      generate:async()=>{start();return new Promise<string>(resolve=>{finish=resolve;});},publish,revoke,
    });
    await started;queue.cancel();finish("blob:old-frame");await queue.done;
    expect(publish).not.toHaveBeenCalled();expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:old-frame");
  });
  it("keeps interaction independent of an unavailable derivative and continues with the next source",async()=>{
    const publish=vi.fn(),queue=createTimelineThumbnailQueue([{id:"bad",uri:"bad"},{id:"good",uri:"good"}],{
      generate:async uri=>{if(uri==="bad")throw Error("not ready");return "blob:good";},publish,revoke:vi.fn(),
    });
    await queue.done;expect(publish).toHaveBeenCalledExactlyOnceWith({id:"good",uri:"good"},"blob:good");queue.cancel();
  });
});
