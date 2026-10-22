import type {BuildOptions,BuildResult} from "esbuild";
export function buildShotGradeBundleV1(options:BuildOptions):Promise<{result:BuildResult;manifest:{schema:string;bundle:{file:string;size:number;sha256:string};implementations:Array<{name:string;sha256:string}>};outfile:string;sidecar:string;shotGradeImplementations:Array<{name:string;sha256:string}>}>;
