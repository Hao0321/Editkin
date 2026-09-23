import type {BuildOptions,BuildResult} from "esbuild";
export function buildMaterialColorBundle(options:BuildOptions):Promise<{result:BuildResult;manifest:{schema:string;bundle:{file:string;size:number;sha256:string};implementations:Array<{name:string;sha256:string}>};outfile:string;sidecar:string}>;
