import type { ModelAppearance } from '../appearance/types.js';
import { validateModelAppearance } from '../appearance/palette.js';
import { assertPrintableMesh, type PrintableMesh } from '../mesh/validate.js';
import { writeZip } from './zip.js';
import { writePalettePng } from './palette-png.js';

/** An OBJ and MTL bundle whose face colors come only from fixed palette materials. */
export function writeObjBundle(mesh: PrintableMesh, appearance: ModelAppearance, metadata: Record<string, unknown> = {}): Buffer {
  const geometry = assertPrintableMesh(mesh);
  validateModelAppearance(appearance, geometry.triangleCount);
  const obj = ['# TerrainWorkshop; all coordinates are in millimeters', 'mtllib model.mtl', 'o terrain', 's off'];
  for (let offset = 0; offset < mesh.positions.length; offset += 3) {
    obj.push(`v ${mesh.positions[offset]} ${mesh.positions[offset + 1]} ${mesh.positions[offset + 2]}`);
  }
  let currentMaterial = -1;
  for (let face = 0; face < geometry.triangleCount; face++) {
    const material = appearance.faceMaterials[face]!;
    if (material !== currentMaterial) {
      obj.push(`usemtl palette_${material}`);
      currentMaterial = material;
    }
    const offset = face * 3;
    obj.push(`f ${mesh.indices[offset]! + 1} ${mesh.indices[offset + 1]! + 1} ${mesh.indices[offset + 2]! + 1}`);
  }
  const mtl = ['# Fixed RGB palette; palette.png is a reference swatch image'];
  for (let material = 0; material < appearance.palette.length; material++) {
    const rgb = Buffer.from(appearance.palette[material]!.color.slice(1), 'hex');
    // Kd is the diffuse surface color. Applying a color texture as well would multiply it in some importers.
    mtl.push(`newmtl palette_${material}`, `Kd ${rgb[0]! / 255} ${rgb[1]! / 255} ${rgb[2]! / 255}`, 'd 1', 'illum 1', '');
  }
  const manifest = {
    schemaVersion: 1, format: 'obj', unit: 'mm',
    vertexCount: geometry.vertexCount, triangleCount: geometry.triangleCount, boundsMm: geometry.bounds,
    appearance: {
      hash: appearance.hash, classification: appearance.classification,
      palette: appearance.palette, options: appearance.options,
      ...(appearance.source ? {source: appearance.source} : {}),
    },
    paletteImage: 'palette.png', metadata,
  };
  const instructions = [
    '路线地形有限颜色 OBJ 交付包',
    '',
    '模型坐标单位为毫米。OBJ 本身不记录单位，导入时请选择毫米；不要自动缩放模型。',
    `模型尺寸：${geometry.bounds.size.x} × ${geometry.bounds.size.y} × ${geometry.bounds.size.z} 毫米。`,
    '请将 model.obj 与 model.mtl 放在同一目录后一起导入。每个三角面引用一种固定材质。',
    'palette.png 仅为精确 RGB 调色板色卡；模型颜色由 model.mtl 的 Kd 定义，没有照片纹理或颜色渐变。',
    `实际打印颜色数：${appearance.palette.length}；上限：${appearance.options.maxColors}。`,
    ...appearance.palette.map((entry, index) => `palette_${index}：${entry.name} ${entry.color}`),
    '',
    appearance.classification === 'rgb-greenness'
      ? '地表分组根据 RGB 绿色优势进行外观分类，不能视为精确土地覆盖识别。'
      : '本模型没有地表影像，山体采用统一代表配色。',
    '请在目标切片软件中检查材质、毫米尺寸和路线位置，并将调色板映射到实际耗材。',
    '这是标准模型交付包，不包含打印机参数；目标切片软件的颜色导入、切片与实物打印需单独验收。',
    'manifest.json 保存配色、影像来源信息与外观校验值。',
  ];
  return writeZip([
    {name: 'model.obj', data: obj.join('\n') + '\n'},
    {name: 'model.mtl', data: mtl.join('\n') + '\n'},
    {name: 'palette.png', data: writePalettePng(appearance.palette.map(entry => entry.color))},
    {name: 'manifest.json', data: JSON.stringify(manifest, null, 2) + '\n'},
    {name: '说明.txt', data: instructions.join('\n') + '\n'},
  ]);
}
