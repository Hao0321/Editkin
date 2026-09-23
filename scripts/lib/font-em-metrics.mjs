import assert from 'node:assert/strict';

/** Read only the signed/unsigned OpenType metric fields required by our ASS
 * adapter. This is not a font shaper or rasterizer; those remain in libass/CSS. */
export function readFontEmMetrics(bytes) {
  assert(bytes.length >= 12 && ['00010000','4f54544f'].includes(bytes.subarray(0,4).toString('hex')), 'Invalid SFNT metrics source');
  const count=bytes.readUInt16BE(4), tables=new Map();
  assert(12+count*16<=bytes.length,'Truncated metric directory');
  for(let i=0;i<count;i++){
    const at=12+i*16,tag=bytes.toString('ascii',at,at+4),offset=bytes.readUInt32BE(at+8),length=bytes.readUInt32BE(at+12);
    assert(!tables.has(tag)&&offset+length<=bytes.length,'Invalid metric table');tables.set(tag,{offset,length});
  }
  function table(tag,min){const t=tables.get(tag);assert(t&&t.length>=min,`Missing ${tag} metrics`);return t.offset;}
  const head=table('head',20),os2=table('OS/2',78),hhea=table('hhea',10);
  const unitsPerEm=bytes.readUInt16BE(head+18),assAscender=bytes.readUInt16BE(os2+74),assDescender=bytes.readUInt16BE(os2+76);
  const useTypo=(bytes.readUInt16BE(os2+62)&128)!==0;
  const cssAscender=bytes.readInt16BE(useTypo?os2+68:hhea+4),cssDescender=-bytes.readInt16BE(useTypo?os2+70:hhea+6);
  assert(unitsPerEm>=16&&unitsPerEm<=16384&&assAscender>0&&assAscender<32768&&assDescender<32768&&cssAscender>0&&cssDescender>=0,'Unsupported font metric range');
  return {unitsPerEm,assAscender,assDescender,cssAscender,cssDescender};
}
