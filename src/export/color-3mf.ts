import type { ModelAppearance } from '../appearance/types.js';
import { validateModelAppearance } from '../appearance/palette.js';
import { assertPrintableMesh } from '../mesh/validate.js';
import { writeZip } from './zip.js';
import { prepareMaterialParts, type MaterialPartsMesh } from './material-parts.js';

const coreNamespace = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const materialNamespace = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';
function xmlAttribute(value: string): string {
  return value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/** Standard 3MF Materials colors, with one opaque palette color for each complete triangle. */
export function writeColor3mf(mesh: MaterialPartsMesh, appearance: ModelAppearance, metadata: Record<string, unknown> = {}): Buffer {
  if (mesh.materialParts !== undefined) return writeMaterialParts3mf(mesh,appearance,metadata);
  const geometry = assertPrintableMesh(mesh);
  validateModelAppearance(appearance, geometry.triangleCount);
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="millimeter" xml:lang="zh-CN" xmlns="${coreNamespace}" xmlns:m="${materialNamespace}" requiredextensions="m">`,
    '<metadata name="Application">TerrainWorkshop</metadata>',
    '<resources><m:colorgroup id="1">',
  ];
  for (const entry of appearance.palette) xml.push(`<m:color color="${entry.color}ff"/>`);
  xml.push('</m:colorgroup><object id="2" type="model"><mesh><vertices>');
  for (let offset = 0; offset < mesh.positions.length; offset += 3) {
    xml.push(`<vertex x="${mesh.positions[offset]}" y="${mesh.positions[offset + 1]}" z="${mesh.positions[offset + 2]}"/>`);
  }
  xml.push('</vertices><triangles>');
  for (let face = 0; face < geometry.triangleCount; face++) {
    const offset = face * 3, material = appearance.faceMaterials[face]!;
    xml.push(`<triangle v1="${mesh.indices[offset]}" v2="${mesh.indices[offset + 1]}" v3="${mesh.indices[offset + 2]}" pid="1" p1="${material}" p2="${material}" p3="${material}"/>`);
  }
  xml.push('</triangles></mesh></object></resources><build><item objectid="2"/></build></model>');
  const manifest = {
    schemaVersion: 1, format: '3mf', unit: 'mm',
    vertexCount: geometry.vertexCount, triangleCount: geometry.triangleCount, boundsMm: geometry.bounds,
    appearance: {
      hash: appearance.hash, classification: appearance.classification,
      palette: appearance.palette, options: appearance.options,
      ...(appearance.source ? {source: appearance.source} : {}),
    },
    metadata,
  };
  return writeZip([
    {name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="json" ContentType="application/json"/><Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'},
    {name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/><Relationship Id="rel1" Type="urn:terrain-workshop:appearance-manifest" Target="/Metadata/manifest.json"/></Relationships>'},
    {name: '3D/3dmodel.model', data: xml.join('\n')},
    {name: 'Metadata/manifest.json', data: JSON.stringify(manifest, null, 2) + '\n'},
  ]);
}

function writeMaterialParts3mf(mesh: MaterialPartsMesh, appearance: ModelAppearance, metadata: Record<string, unknown>): Buffer {
  const {report,palette,parts} = prepareMaterialParts(mesh,appearance);
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="millimeter" xml:lang="zh-CN" xmlns="${coreNamespace}" xmlns:m="${materialNamespace}" requiredextensions="m">`,
    '<metadata name="Application">TerrainWorkshop</metadata>',
    '<resources><m:colorgroup id="1">',
    ...palette.map(entry => `<m:color color="${entry.color}ff"/>`),
    '</m:colorgroup><basematerials id="2">',
    ...palette.map(entry => `<base name="${xmlAttribute(entry.name)}" displaycolor="${entry.color}ff"/>`),
    '</basematerials>',
  ];
  for (let index=0;index<parts.length;index++) {
    const {mesh:part,materials,defaultMaterial}=parts[index]!;
    xml.push(`<object id="${index+3}" type="model" name="${part.id}" pid="2" pindex="${defaultMaterial}"><mesh><vertices>`);
    for (let offset=0;offset<part.positions.length;offset+=3)
      xml.push(`<vertex x="${part.positions[offset]}" y="${part.positions[offset+1]}" z="${part.positions[offset+2]}"/>`);
    xml.push('</vertices><triangles>');
    const pid=part.id === 'terrain' ? 1 : 2;
    for (let face=0;face<materials.length;face++) {
      const offset=face*3,material=materials[face]!;
      xml.push(`<triangle v1="${part.indices[offset]}" v2="${part.indices[offset+1]}" v3="${part.indices[offset+2]}" pid="${pid}" p1="${material}" p2="${material}" p3="${material}"/>`);
    }
    xml.push('</triangles></mesh></object>');
  }
  const assemblyId=parts.length+3;
  xml.push(`<object id="${assemblyId}" type="model" name="terrain-assembly"><components>`);
  // Omitted transforms are identity. A single build item preserves every
  // material solid in the same millimetre coordinate system.
  for (let index=0;index<parts.length;index++) xml.push(`<component objectid="${index+3}"/>`);
  xml.push(`</components></object></resources><build><item objectid="${assemblyId}"/></build></model>`);
  const geometry=report.outer;
  const manifest={
    schemaVersion:1,format:'3mf',unit:'mm',vertexCount:geometry.vertexCount,triangleCount:geometry.triangleCount,boundsMm:geometry.bounds,
    materialParts:report.parts.map((part,index)=>({...part,defaultMaterial:parts[index]!.defaultMaterial})),
    materialVolumeMm3:report.volumeMm3,materialVolumeToleranceMm3:report.volumeToleranceMm3,
    appearance:{hash:appearance.hash,classification:appearance.classification,palette,options:appearance.options,
      ...(appearance.source?{source:appearance.source}:{})},metadata,
  };
  return writeZip([
    {name:'[Content_Types].xml',data:'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="json" ContentType="application/json"/><Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'},
    {name:'_rels/.rels',data:'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/><Relationship Id="rel1" Type="urn:terrain-workshop:appearance-manifest" Target="/Metadata/manifest.json"/></Relationships>'},
    {name:'3D/3dmodel.model',data:xml.join('\n')},
    {name:'Metadata/manifest.json',data:JSON.stringify(manifest,null,2)+'\n'},
  ]);
}
