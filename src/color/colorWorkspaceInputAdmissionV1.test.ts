import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import {it,expect} from 'vitest';
import {createDemoProject} from '../domain/demo';
import {colorWorkspaceInputAdmissionV1} from './colorWorkspaceInputAdmissionV1';
const management={...DEFAULT_COLOR_MANAGEMENT,mode:'rec709' as const,outputTransform:'rec709_sdr' as const};
it('preserves valid Rec709 and fully declared HDR interpretation',()=>{
  const a=createDemoProject().assets[0];a.color={interpretation:'rec709'};expect(colorWorkspaceInputAdmissionV1(a,management)).toMatchObject({legacyInput:'rec709',metadataInvalid:false});
  a.color={interpretation:'hlg',primaries:'bt2020',transfer:'arib-std-b67',matrix:'bt2020nc',range:'tv'};expect(colorWorkspaceInputAdmissionV1(a,management)).toMatchObject({legacyInput:'hlg',metadataInvalid:false});
});
it('keeps malformed HDR blocked without throwing or altering metadata',()=>{
  const a=createDemoProject().assets[0];a.color={interpretation:'hlg'};const before=JSON.stringify(a),result=colorWorkspaceInputAdmissionV1(a,management);expect(result).toMatchObject({legacyInput:'blocked_log',acesInput:'blocked_log',metadataInvalid:true});expect(result.precisionBlock).toContain('Input Transform');expect(JSON.stringify(a)).toBe(before);
});
