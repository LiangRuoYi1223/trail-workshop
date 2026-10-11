import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { SaxesParser } from 'saxes';

// A hand-authored 20 × 30 × 10 mm tetrahedron, outward wound and closed.
const mesh = {
  positions: [0, 0, 0, 20, 0, 0, 0, 30, 0, 0, 0, 10],
  indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
};
interface AppearanceFixture {
  schemaVersion: 1;
  faceClasses: Array<'grass'|'rock'|'route'>;
  faceMaterials: number[];
  palette: Array<{id: 'grass'|'rock'|'route';name: string;color: string}>;
  options: {maxColors: 2|3;grassColor: string;rockColor: string;routeColor: string};
  source?: {sha256: string;byteLength: number;width: number;height: number;bounds: {west: number;south: number;east: number;north: number};crs: 'EPSG:4326';pixelIsArea: boolean};
  classification: 'uniform'|'rgb-greenness';
  hash: string;
}
function appearance(): AppearanceFixture {
  const contents = {
    schemaVersion: 1 as const,
    faceClasses: ['rock', 'grass', 'route', 'rock'] as AppearanceFixture['faceClasses'],
    faceMaterials: [1, 0, 2, 1],
    palette: [
      {id: 'grass' as const, name: '草地', color: '#228844'},
      {id: 'rock' as const, name: '山石', color: '#998877'},
      {id: 'route' as const, name: '路线', color: '#ee3311'},
    ],
    options: {maxColors: 3 as const, grassColor: '#228844', rockColor: '#998877', routeColor: '#ee3311'},
    classification: 'uniform' as const,
  };
  return {...contents, hash: createHash('sha256').update(JSON.stringify(contents)).digest('hex')};
}
function rehash(value: AppearanceFixture): AppearanceFixture {
  const contents = {
    schemaVersion: value.schemaVersion, faceClasses: value.faceClasses,
    faceMaterials: value.faceMaterials, palette: value.palette, options: value.options,
    ...(value.source ? {source: value.source} : {}), classification: value.classification,
  };
  return {...contents, hash: createHash('sha256').update(JSON.stringify(contents)).digest('hex')};
}
type Exporter = (geometry: typeof mesh, colors: AppearanceFixture, metadata?: Record<string, unknown>) => Buffer;
async function exporters(): Promise<{writeColor3mf: Exporter;writeObjBundle: Exporter}> {
  // URL imports permit a real RED run before the new implementation modules exist.
  return {
    writeColor3mf: (await import(new URL('../src/export/color-3mf.js', import.meta.url).href)).writeColor3mf,
    writeObjBundle: (await import(new URL('../src/export/color-obj.js', import.meta.url).href)).writeObjBundle,
  };
}

// Decode by the ZIP central directory, then independently compare local headers and CRC.
function crc(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function readZip(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 4), 0);
  assert.equal(bytes.readUInt16LE(end + 6), 0);
  const count = bytes.readUInt16LE(end + 10);
  assert.equal(bytes.readUInt16LE(end + 8), count);
  let offset = bytes.readUInt32LE(end + 16);
  assert.equal(offset + bytes.readUInt32LE(end + 12), end);
  const parts = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const flags = bytes.readUInt16LE(offset + 8);
    assert.equal(flags & 0x800, 0x800, 'UTF-8 names are flagged');
    assert.equal(flags & 1, 0, 'no encryption');
    const method = bytes.readUInt16LE(offset + 10);
    const expectedCrc = bytes.readUInt32LE(offset + 16);
    const compressedLength = bytes.readUInt32LE(offset + 20);
    const length = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assert.equal(parts.has(name), false);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt16LE(local + 6), flags);
    assert.equal(bytes.readUInt16LE(local + 8), method);
    assert.equal(bytes.readUInt32LE(local + 14), expectedCrc);
    assert.equal(bytes.readUInt32LE(local + 18), compressedLength);
    assert.equal(bytes.readUInt32LE(local + 22), length);
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    assert.equal(bytes.subarray(local + 30, local + 30 + localNameLength).toString('utf8'), name);
    const start = local + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(start, start + compressedLength);
    assert.ok(method === 0 || method === 8, 'a standard ZIP compression method');
    const body = method === 8 ? inflateRawSync(compressed) : compressed;
    assert.equal(body.length, length);
    assert.equal(crc(body), expectedCrc);
    parts.set(name, body);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(offset, end);
  return parts;
}
function xmlNodes(bytes: Buffer) {
  const nodes: Array<{name: string;uri: string;attrs: Record<string, string>}> = [];
  const parser = new SaxesParser({xmlns: true});
  parser.on('opentag', tag => nodes.push({name: tag.local, uri: tag.uri, attrs: Object.fromEntries(Object.entries(tag.attributes).map(([name, attr]) => [name, attr.value]))}));
  parser.write(bytes.toString('utf8')).close();
  return nodes;
}
function pngColors(bytes: Buffer): string[] {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let offset = 8, width = 0, height = 0;
  const compressed: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(crc(bytes.subarray(offset + 4, offset + 8 + length)), bytes.readUInt32BE(offset + 8 + length));
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.equal(data[8], 8); assert.equal(data[9], 2, 'plain RGB, no alpha or palette approximation');
      assert.deepEqual([...data.subarray(10)], [0, 0, 0]);
    }
    if (type === 'IDAT') compressed.push(data);
    offset += length + 12;
  }
  assert.equal(offset, bytes.length);
  const pixels = inflateSync(Buffer.concat(compressed));
  assert.equal(pixels.length, (width * 3 + 1) * height);
  const colors = new Set<string>();
  for (let row = 0; row < height; row++) {
    const start = row * (width * 3 + 1);
    assert.equal(pixels[start], 0, 'no antialias or PNG filter reconstruction needed');
    for (let column = 0; column < width; column++) colors.add('#' + pixels.subarray(start + 1 + column * 3, start + 4 + column * 3).toString('hex'));
  }
  return [...colors].sort();
}

// Catches missing OPC links, transformed geometry, unconstrained per-vertex colors, and lost appearance metadata.
test('3MF carries exact closed geometry and three fixed per-face colors in standard OPC parts', async () => {
  const {writeColor3mf} = await exporters();
  const colors = appearance();
  const metadata = {title: '路线 <样例> & "尺寸"', input: {format: 'gpx'}};
  const parts = readZip(writeColor3mf(mesh, colors, metadata));
  assert.deepEqual([...parts.keys()].sort(), ['3D/3dmodel.model', 'Metadata/manifest.json', '[Content_Types].xml', '_rels/.rels']);
  const types = xmlNodes(parts.get('[Content_Types].xml')!);
  assert.ok(types.some(node => node.name === 'Override' && node.attrs.PartName === '/3D/3dmodel.model' && node.attrs.ContentType === 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'));
  assert.ok(types.some(node => node.attrs.Extension === 'rels' && node.attrs.ContentType === 'application/vnd.openxmlformats-package.relationships+xml'));
  const relationships = xmlNodes(parts.get('_rels/.rels')!);
  assert.ok(relationships.some(node => node.name === 'Relationship' && node.attrs.Target === '/3D/3dmodel.model' && node.attrs.Type === 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel'));
  const nodes = xmlNodes(parts.get('3D/3dmodel.model')!);
  const model = nodes.find(node => node.name === 'model')!;
  assert.equal(model.uri, 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02');
  assert.equal(model.attrs.unit, 'millimeter');
  assert.equal(model.attrs.requiredextensions, 'm');
  const group = nodes.find(node => node.name === 'colorgroup')!;
  assert.equal(group.uri, 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02');
  assert.deepEqual(nodes.filter(node => node.name === 'color').map(node => node.attrs.color.toLowerCase()), ['#228844ff', '#998877ff', '#ee3311ff']);
  assert.deepEqual(nodes.filter(node => node.name === 'vertex').flatMap(node => ['x','y','z'].map(key => Number(node.attrs[key]))), mesh.positions);
  const triangles = nodes.filter(node => node.name === 'triangle');
  assert.deepEqual(triangles.flatMap(node => ['v1','v2','v3'].map(key => Number(node.attrs[key]))), mesh.indices);
  assert.deepEqual(triangles.map(node => Number(node.attrs.p1)), [1, 0, 2, 1]);
  for (const triangle of triangles) {
    assert.equal(triangle.attrs.pid, group.attrs.id);
    assert.equal(triangle.attrs.p2, triangle.attrs.p1);
    assert.equal(triangle.attrs.p3, triangle.attrs.p1);
  }
  const object = nodes.find(node => node.name === 'object')!;
  assert.ok(nodes.some(node => node.name === 'item' && node.attrs.objectid === object.attrs.id));
  const manifest = JSON.parse(parts.get('Metadata/manifest.json')!.toString('utf8'));
  assert.equal(manifest.unit, 'mm'); assert.equal(manifest.triangleCount, 4); assert.equal(manifest.vertexCount, 4);
  assert.deepEqual(manifest.boundsMm.size, {x: 20, y: 30, z: 10});
  assert.deepEqual(manifest.appearance.palette, colors.palette);
  assert.equal(manifest.appearance.hash, colors.hash);
  assert.deepEqual(manifest.metadata, metadata);
  assert.equal([...parts.keys()].some(name => /(?:project_settings|model_settings|Bambu)/i.test(name)), false);
});

// Catches face/material drift, rounded RGBs, surplus texture colors, and lost millimetre dimensions.
test('OBJ ZIP retains geometry and one fixed palette material per face with exact RGB swatches', async () => {
  const {writeObjBundle} = await exporters();
  const colors = appearance();
  const parts = readZip(writeObjBundle(mesh, colors, {route: 'GPX'}));
  assert.deepEqual([...parts.keys()].sort(), ['manifest.json', 'model.mtl', 'model.obj', 'palette.png', '说明.txt']);
  const lines = parts.get('model.obj')!.toString('utf8').split(/\r?\n/);
  assert.ok(lines.includes('mtllib model.mtl'));
  assert.deepEqual(lines.filter(line => line.startsWith('v ')).flatMap(line => line.split(' ').slice(1).map(Number)), mesh.positions);
  const faces: Array<{material: string;indices: number[]}> = [];
  let material = '';
  for (const line of lines) {
    if (line.startsWith('usemtl ')) material = line.slice(7);
    if (line.startsWith('f ')) faces.push({material, indices: line.split(' ').slice(1).map(token => Number(token.split('/')[0]) - 1)});
  }
  assert.deepEqual(faces.map(face => face.indices), [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]);
  const materialRgb = new Map<string, number[]>();
  for (const line of parts.get('model.mtl')!.toString('utf8').split(/\r?\n/)) {
    if (line.startsWith('newmtl ')) material = line.slice(7);
    if (line.startsWith('Kd ')) materialRgb.set(material, line.split(' ').slice(1).map(Number).map(value => Math.round(value * 255)));
  }
  assert.deepEqual(faces.map(face => materialRgb.get(face.material)), [[153,136,119], [34,136,68], [238,51,17], [153,136,119]]);
  assert.equal(materialRgb.size, 3);
  assert.deepEqual(pngColors(parts.get('palette.png')!), ['#228844', '#998877', '#ee3311']);
  const manifest = JSON.parse(parts.get('manifest.json')!.toString('utf8'));
  assert.equal(manifest.format, 'obj'); assert.equal(manifest.unit, 'mm');
  assert.deepEqual(manifest.boundsMm.size, {x: 20, y: 30, z: 10});
  assert.deepEqual(manifest.appearance.palette, colors.palette);
  assert.deepEqual(manifest.metadata, {route: 'GPX'});
  assert.match(parts.get('说明.txt')!.toString('utf8'), /毫米/);
});

// Catches refusal to honor the two-color setting and unwanted added colors in either format.
test('two-color output only contains terrain and route RGB values after semantic deduplication', async () => {
  const {writeColor3mf, writeObjBundle} = await exporters();
  const colors = appearance();
  colors.options = {maxColors: 2, grassColor: '#228844', rockColor: '#998877', routeColor: '#ee3311'};
  colors.palette = [{id: 'rock', name: '山体', color: '#228844'}, {id: 'route', name: '路线', color: '#ee3311'}];
  colors.faceMaterials = [0, 0, 1, 0];
  const reduced = rehash(colors);
  const three = readZip(writeColor3mf(mesh, reduced));
  assert.deepEqual(xmlNodes(three.get('3D/3dmodel.model')!).filter(node => node.name === 'color').map(node => node.attrs.color.toLowerCase()), ['#228844ff', '#ee3311ff']);
  const obj = readZip(writeObjBundle(mesh, reduced));
  assert.deepEqual(pngColors(obj.get('palette.png')!), ['#228844', '#ee3311']);
});

// Catches omitting raster provenance from a deliverable even though the appearance was image-classified.
test('both archives retain the exact image provenance used by RGB surface classification', async () => {
  const {writeColor3mf, writeObjBundle} = await exporters();
  const colors = appearance();
  colors.classification = 'rgb-greenness';
  colors.source = {
    sha256: 'f'.repeat(64), byteLength: 512, width: 2, height: 2,
    bounds: {west: 104, south: 30, east: 105, north: 31}, crs: 'EPSG:4326', pixelIsArea: true,
  };
  const expectedSource = {
    sha256: 'f'.repeat(64), byteLength: 512, width: 2, height: 2,
    bounds: {west: 104, south: 30, east: 105, north: 31}, crs: 'EPSG:4326', pixelIsArea: true,
  };
  const current = rehash(colors);
  for (const [writer, name] of [[writeColor3mf, 'Metadata/manifest.json'], [writeObjBundle, 'manifest.json']] as const) {
    const parts = readZip(writer(mesh, current));
    const manifest = JSON.parse(parts.get(name)!.toString('utf8'));
    assert.deepEqual(manifest.appearance.source, expectedSource);
    assert.equal(manifest.appearance.classification, 'rgb-greenness');
    assert.equal(manifest.appearance.hash, current.hash);
  }
});

// A boundary of the same palette contract: matching RGB choices may require only one material.
test('RGB deduplication produces one color in both archives when all semantic choices match', async () => {
  const {writeColor3mf, writeObjBundle} = await exporters();
  const colors = appearance();
  colors.options = {maxColors: 3, grassColor: '#228844', rockColor: '#228844', routeColor: '#228844'};
  colors.palette = [{id: 'rock', name: '共享颜色', color: '#228844'}];
  colors.faceMaterials = [0, 0, 0, 0];
  const current = rehash(colors);
  const three = readZip(writeColor3mf(mesh, current));
  assert.deepEqual(xmlNodes(three.get('3D/3dmodel.model')!).filter(node => node.name === 'color').map(node => node.attrs.color.toLowerCase()), ['#228844ff']);
  const obj = readZip(writeObjBundle(mesh, current));
  assert.deepEqual(pngColors(obj.get('palette.png')!), ['#228844']);
  assert.equal(obj.get('model.mtl')!.toString('utf8').split(/\r?\n/).filter(line => line.startsWith('newmtl ')).length, 1);
});

// Catches bypasses of the shared appearance and mesh validation at both serializer boundaries.
test('color exporters reject malformed geometry and untrusted appearance palettes before producing an archive', async () => {
  const exports = await exporters();
  for (const writer of Object.values(exports)) {
    const count = appearance(); count.faceMaterials.pop();
    assert.throws(() => writer(mesh, rehash(count)));
    const index = appearance(); index.faceMaterials[0] = 3;
    assert.throws(() => writer(mesh, rehash(index)));
    const duplicate = appearance(); duplicate.palette[2]!.color = '#998877'; duplicate.options.routeColor = '#998877';
    assert.throws(() => writer(mesh, rehash(duplicate)));
    const budget = appearance(); budget.options.maxColors = 2;
    assert.throws(() => writer(mesh, rehash(budget)));
    const injection = appearance(); injection.palette[0]!.color = '#228844"/><evil/>';
    assert.throws(() => writer(mesh, rehash(injection)));
    const wrongHash = appearance(); wrongHash.hash = '0'.repeat(64);
    assert.throws(() => writer(mesh, wrongHash));
    assert.throws(() => writer({...mesh, indices: [0, 1, 99]}, appearance()));
    assert.throws(() => writer({...mesh, positions: [NaN, ...mesh.positions.slice(1)]}, appearance()));
    assert.throws(() => writer({...mesh, indices: mesh.indices.slice(1)}, appearance()));
    const open = appearance(); open.faceClasses.pop(); open.faceMaterials.pop();
    assert.throws(() => writer({...mesh, indices: mesh.indices.slice(0, 9)}, rehash(open)), /boundary|closed/);
    assert.throws(() => writer({...mesh, indices: [0,2,1,0,1,3,0,3,2,0,2,1]}, appearance()), /duplicate/);
  }
});
