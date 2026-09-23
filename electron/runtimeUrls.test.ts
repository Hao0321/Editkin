import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Execute the actual bounded main.ts functions without loading Electron or starting its lifecycle.
function fixture() {
  const original = resolve('fixture/original.mov');
  const source=readFileSync(new URL('./main.ts',import.meta.url),'utf8');
  const start=source.indexOf('function runtimeUrls('),end=source.indexOf('\nfunction runtimePaths()',start);
  const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  return runInNewContext(`${code}\n({runtimeUrls,runtimeUrlsWithCreative})`,{
    isAbsolute,mediaUrl:(path:string)=>`test-media:${path}`,
    runtimePaths:()=>({creativePackRoot:'fixture'}),
    creativeAssetIdFromUri:(uri:string)=>uri.startsWith('creative://')?'id':undefined,
    resolveCreativeLibraryAsset:async()=>({absolutePath:original}),
  }) as {runtimeUrls:(assets:unknown[])=>Record<string,string>;runtimeUrlsWithCreative:(assets:unknown[])=>Promise<Record<string,string>>};
}
describe('actual Electron runtime URL projection',()=>{
  const original = resolve('fixture/original.mov');
  const proxy = resolve('fixture/proxy.mp4');
  const overlay = resolve('fixture/overlay.mp4');
  it('keeps creative proxy as main and original as source, with explicit proxy identity',async()=>{
    const asset={id:'a',uri:'creative://id',derivatives:{proxyUri:proxy,overlayProxyUri:overlay}};
    const urls=await fixture().runtimeUrlsWithCreative([asset]);
    expect(urls.a).toBe(`test-media:${proxy}`);
    expect(urls['a:source']).toBe(`test-media:${original}`);
    expect(urls['a:proxy']).toBe(urls.a);
    expect(urls['a:overlay-proxy']).toBe(`test-media:${overlay}`);
    expect(asset.uri).toBe('creative://id');
  });
  it('uses original only if no valid absolute derived preview exists',async()=>{
    for(const derivatives of [undefined,{proxyUri:'relative.mp4'}]){
      const urls=await fixture().runtimeUrlsWithCreative([{id:'a',uri:'creative://id',derivatives}]);
      expect(urls.a).toBe(`test-media:${original}`);expect(urls['a:proxy']).toBeUndefined();
    }
  });
  it('ordinary imported original and proxy stay separate',()=>{
    const source = resolve('fixture/source.mov');
    const urls=fixture().runtimeUrls([{id:'a',uri:source,derivatives:{proxyUri:proxy}}]);
    expect(urls.a).toBe(`test-media:${proxy}`);expect(urls['a:source']).toBe(`test-media:${source}`);expect(urls['a:proxy']).toBe(urls.a);
  });
  it('prepare media passes bundled ffprobe and display height',()=>{
    const source=readFileSync(new URL('./main.ts',import.meta.url),'utf8');
    const start=source.indexOf('const result = await generateMediaDerivatives({');
    const call=source.slice(start,source.indexOf('\n    });',start));
    expect(call).toContain('ffprobePath: paths.ffprobe');expect(call).toContain('sourceHeight: probe.height');
  });
});
