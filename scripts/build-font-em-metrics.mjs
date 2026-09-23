import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {deriveFontEmMetrics,verifyFontEmMetrics} from './lib/font-em-metrics-manifest.mjs';
const document=await deriveFontEmMetrics(resolve('public/fonts')),result=JSON.stringify(document)+'\n';
const output=resolve('src/generated/fontEmMetrics.json');
if(process.argv.includes('--write'))await writeFile(output,result,{flag:'wx'});
verifyFontEmMetrics(await readFile(output,'utf8'),document);
console.log(JSON.stringify({status:'VERIFIED_FONT_EM_METRICS',faces:document.faces.length,bytes:Buffer.byteLength(result),output}));
