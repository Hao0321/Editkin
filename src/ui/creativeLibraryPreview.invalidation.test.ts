import { describe, expect, it, vi } from "vitest";
import { createLibraryPreviewCache } from "./creativeLibraryPreview";
const flush = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };

describe("preview decode-error lease invalidation", () => {
  it("invalidates a settled URL and assigns a new generation even when URL text is unchanged", async () => {
    const cache = createLibraryPreviewCache(), resolver = vi.fn(async () => "same-url");
    const a = cache.acquire(resolver,"a","r","poster"); await a.promise;
    expect(a.invalidate()).toBe(true); a.release();
    const b = cache.acquire(resolver,"a","r","poster"); expect(await b.promise).toBe("same-url");
    expect(resolver).toHaveBeenCalledTimes(2); expect(b.generation).not.toBe(a.generation); b.release();
  });
  it("an old lease cannot evict a newer in-flight request or duplicate its resolver", async () => {
    const cache = createLibraryPreviewCache(); let finish!: (value:string) => void;
    const resolver = vi.fn().mockResolvedValueOnce("broken").mockImplementation(() => new Promise<string>(yes => finish=yes));
    const old = cache.acquire(resolver,"a","r","media"); await old.promise; old.invalidate(); old.release();
    const current = cache.acquire(resolver,"a","r","media"); await flush();
    expect(old.invalidate()).toBe(false);
    const shared = cache.acquire(resolver,"a","r","media"); expect(shared.promise).toBe(current.promise); expect(resolver).toHaveBeenCalledTimes(2);
    finish("fixed"); await current.promise; current.release(); shared.release();
  });
  it("poster/media and resolver/id/revision siblings stay independently cached", async () => {
    const cache = createLibraryPreviewCache(), a = vi.fn(async(id:string,mode?:string)=>`${id}:${mode}`), b = vi.fn(async()=>"other");
    const media = cache.acquire(a,"id","r","media"); await media.promise;
    const poster = cache.acquire(a,"id","r","poster"), revision = cache.acquire(a,"id","r2","media"), id = cache.acquire(a,"other","r","media"), resolver = cache.acquire(b,"id","r","media");
    await Promise.all([poster.promise,revision.promise,id.promise,resolver.promise]);
    media.invalidate(); media.release();
    for (const [resolve,key,rev,mode,lease] of [[a,"id","r","poster",poster],[a,"id","r2","media",revision],[a,"other","r","media",id],[b,"id","r","media",resolver]] as const) {
      const hit=cache.acquire(resolve,key,rev,mode); expect(hit.promise).toBe(lease.promise); hit.release(); lease.release();
    }
    expect(a).toHaveBeenCalledTimes(4); expect(b).toHaveBeenCalledTimes(1);
  });
  it("invalidating old queued work does not cancel a newer lease during old release", async () => {
    const cache=createLibraryPreviewCache(64,1); let finish!: (value:string)=>void;
    const block=cache.acquire(()=>new Promise<string>(yes=>finish=yes),"block","r","media");
    const resolver=vi.fn(async()=>"new"),old=cache.acquire(resolver,"id","r","poster");
    void old.promise.catch(()=>{}); old.invalidate();
    const current=cache.acquire(resolver,"id","r","poster"); old.release(); await flush();
    expect(cache.stats()).toMatchObject({running:1,queued:1}); finish("done"); await block.promise;
    expect(await current.promise).toBe("new"); expect(resolver).toHaveBeenCalledTimes(1); current.release(); block.release();
  });
});
