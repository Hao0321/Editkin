import index from '../generated/fontEmMetrics.json';
import {resolveBundledFontFace} from './fontFaces';

export function bundledFontMetricDigest(family: string, weight: number): string | undefined {
  const face=resolveBundledFontFace(family,weight);
  return face&&index.faces.find(item=>item.id===face.faceId)?.sha256;
}

/** Convert CSS em pixels to libass Windows-height pixels and preserve the CSS
 * baseline within an explicit line box. Never guess metrics for a custom font. */
export function bundledFontAssMetrics(family: string, weight: number, emSize: number, lineHeight: number) {
  const face=resolveBundledFontFace(family,weight);
  const metrics=face&&index.faces.find(item=>item.id===face.faceId);
  if(!metrics)throw new Error(`v2 輸出缺少已驗證的字型尺寸資料：${family}`);
  const scale=emSize/metrics.unitsPerEm;
  const cssBaseline=(lineHeight-(metrics.cssAscender+metrics.cssDescender)*scale)/2+metrics.cssAscender*scale;
  return {fontSize:(metrics.assAscender+metrics.assDescender)*scale,topOffset:cssBaseline-metrics.assAscender*scale};
}

/** The other direction, for subtitle text authored as an ASS Fontsize: the CSS em libass draws at that size
 * (the inverse of bundledFontAssMetrics, so OS/2 win ascent + descent equals the size) and libass's line box at
 * that scale. libass stacks lines by the face's hhea ascent + descent, which is what these faces expose to CSS
 * (cssAscender/cssDescender), so a CSS line-height of lineHeight puts the baseline ascent below the line top
 * exactly where libass puts it. Undefined for a family without verified metrics: never guess. */
export function bundledFontAssLineMetrics(family: string, weight: number, assFontSize: number) {
  const face=resolveBundledFontFace(family,weight);
  const metrics=face&&index.faces.find(item=>item.id===face.faceId);
  if(!metrics||!Number.isFinite(assFontSize)||assFontSize<=0)return undefined;
  const emSize=assFontSize/bundledFontAssMetrics(family,weight,1,0).fontSize;
  const scale=emSize/metrics.unitsPerEm;
  return {emSize,ascent:metrics.cssAscender*scale,descent:metrics.cssDescender*scale,lineHeight:(metrics.cssAscender+metrics.cssDescender)*scale};
}

/** Distance from the top of a CSS line box to the baseline, for aligning mixed faces. */
export function bundledFontCssBaseline(family: string, weight: number, emSize: number, lineHeight: number): number {
  const face=resolveBundledFontFace(family,weight);
  const metrics=face&&index.faces.find(item=>item.id===face.faceId);
  if(!metrics)throw new Error(`缺少已驗證的字型尺寸資料：${family}`);
  const scale=emSize/metrics.unitsPerEm;
  return (lineHeight-(metrics.cssAscender+metrics.cssDescender)*scale)/2+metrics.cssAscender*scale;
}
