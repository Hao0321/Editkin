import {expect,it} from "vitest";
import {mkdir,writeFile,readFile,symlink} from "node:fs/promises";
import {join} from "node:path";
import {buildShotGradeBundleV1} from "./lib/shot-grade-bundle-identity-v1.mjs";
import {REPO_TMP,useTempRoots} from "../src/test/tempRoot.mjs";
const temp=useTempRoots();
async function fixture(){
 const root=await temp.create("shot-grade-build-control-",{parent:REPO_TMP}),source=join(root,"src/application"),candidate=join(root,"src/color/shotGradeCandidateV1.ts"),outfile=join(root,"output.mjs");await mkdir(source,{recursive:true});await mkdir(join(root,"src/color"),{recursive:true});
 await writeFile(join(source,"materialColorImplementationPaths.json"),JSON.stringify(["primary.ts"]));await writeFile(join(source,"primary.ts"),"export const primary = 1;\n");
 await writeFile(join(source,"shotGradeCodeIdentityV1.ts"),"export const ownedIdentity = 1;\n");await writeFile(candidate,"export const ownedCandidate = 1;\n");
 const registry=join(source,"shotGradeImplementationPathsV1.json"),names=["src/application/shotGradeCodeIdentityV1.ts","src/application/shotGradeImplementationPathsV1.json","src/color/shotGradeCandidateV1.ts"];
 await writeFile(registry,JSON.stringify(names));await writeFile(outfile,"owned-previous-output");return {root,source,candidate,outfile,registry,names};
}
it("embeds separate new grade inputs while preserving the old primary sidecar contract",async()=>{
 const f=await fixture(),built=await buildShotGradeBundleV1({absWorkingDir:f.root,stdin:{contents:"console.log(1)"},outfile:f.outfile});
 expect(built.shotGradeImplementations.map(row=>row.name)).toEqual(f.names);expect(built.manifest.implementations).toHaveLength(1);expect(built.sidecar).toBe(f.outfile+".material-color-identity.json");
});
it.each(["split","reserved-define","traversal","duplicate","missing-critical-owner"])("rejects %s before replacing an existing owned output",async mode=>{
 const f=await fixture();
 if(mode==="traversal")await writeFile(f.registry,JSON.stringify([...f.names,"../outside.ts"]));
 if(mode==="duplicate")await writeFile(f.registry,JSON.stringify([...f.names,f.names[0]]));
 if(mode==="missing-critical-owner")await writeFile(f.registry,JSON.stringify(f.names.slice(1)));
 await expect(buildShotGradeBundleV1({absWorkingDir:f.root,stdin:{contents:"console.log(1)"},outfile:f.outfile,...(mode==="split"?{splitting:true}:{}),...(mode==="reserved-define"?{define:{__EDITKIN_SHOT_GRADE_BUILD_V1__:"{}"}}:{})})).rejects.toThrow();
 expect(await readFile(f.outfile,"utf8")).toBe("owned-previous-output");
});
it("rejects a source ancestor alias rather than hashing its target as an authorized input",async()=>{
 const f=await fixture(),outside=join(f.root,"outside");await mkdir(outside);await writeFile(join(outside,"aliased.ts"),"outside");
 await symlink(outside,join(f.source,"alias"),process.platform==="win32"?"junction":"dir");await writeFile(f.registry,JSON.stringify([...f.names,"src/application/alias/aliased.ts"]));
 await expect(buildShotGradeBundleV1({absWorkingDir:f.root,stdin:{contents:"console.log(1)"},outfile:f.outfile})).rejects.toThrow(/alias/);expect(await readFile(f.outfile,"utf8")).toBe("owned-previous-output");
});
it("refuses actual new-input drift during bundling before refreshing output hashes",async()=>{
 const f=await fixture();await expect(buildShotGradeBundleV1({absWorkingDir:f.root,stdin:{contents:"console.log(1)"},outfile:f.outfile,plugins:[{name:"owned-grade-drift-control",setup(build){build.onEnd(async()=>{await writeFile(f.candidate,"export const ownedCandidate = 2;\n");});}}]})).rejects.toThrow(/shot-grade-build-input-drift/);
 expect(await readFile(f.outfile,"utf8")).toBe("owned-previous-output");
});
