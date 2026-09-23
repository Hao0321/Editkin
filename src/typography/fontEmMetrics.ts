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
