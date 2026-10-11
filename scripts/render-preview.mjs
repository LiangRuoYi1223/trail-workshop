// Diagnostic previews use the final exported triangles, including actual raised-route geometry.
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

const inputPath = process.argv[2] ?? 'outputs/stage1/Longquanshan_Terrain.preview.json';
const document = JSON.parse(await readFile(inputPath, 'utf8'));
const { mesh } = document;
if (!mesh || !Array.isArray(mesh.positions) || !Array.isArray(mesh.indices) || mesh.indices.length % 3 !== 0) {
  throw new Error('Preview input must contain a final triangle mesh.');
}
const triangleCount = mesh.indices.length / 3;
if (mesh.faceKinds !== undefined && (!Array.isArray(mesh.faceKinds) || mesh.faceKinds.length !== triangleCount)) {
  throw new Error('mesh.faceKinds must contain exactly one label for every triangle.');
}
const allowedKinds = new Set(['terrain', 'route', 'route-wall', 'frame', 'wall', 'bottom']);
if (mesh.faceKinds?.some(kind => !allowedKinds.has(kind))) throw new Error('Unknown mesh.faceKinds label.');
if (mesh.positions.length % 3 !== 0 || mesh.positions.some(value => !Number.isFinite(value))) {
  throw new Error('Preview mesh positions must be finite XYZ coordinates.');
}
const vertexCount = mesh.positions.length / 3;
if (mesh.indices.some(value => !Number.isInteger(value) || value < 0 || value >= vertexCount)) {
  throw new Error('Preview mesh contains an invalid triangle index.');
}

const stem = /\.preview\.json$/i.test(inputPath)
  ? inputPath.slice(0, -'.preview.json'.length)
  : join(dirname(inputPath), basename(inputPath, extname(inputPath)));
let report = document.report;
if (!report) {
  try { report = JSON.parse(await readFile(stem + '.report.json', 'utf8')); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
report ??= {};
const positions = mesh.positions;
const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
for (let i = 0; i < positions.length; i += 3) for (let axis = 0; axis < 3; axis++) {
  bounds.min[axis] = Math.min(bounds.min[axis], positions[i + axis]);
  bounds.max[axis] = Math.max(bounds.max[axis], positions[i + axis]);
}
if (!positions.length || !triangleCount) throw new Error('Cannot preview an empty mesh.');
const size = bounds.max.map((value, axis) => value - bounds.min[axis]);
const hasRoute = mesh.faceKinds?.some(kind => kind === 'route' || kind === 'route-wall') ?? false;
const hasFrame = mesh.faceKinds?.includes('frame') ?? false;
const stage = Number(report.stage ?? document.stage ?? (hasRoute ? 2 : 1));
const config = report.config ?? {};
const routeParameters = report.integratedModel?.route ?? report.routeRelief ?? config.route ?? {};
const routeHeight = routeParameters.heightMm ?? config.routeHeightMm;
const routeWidth = routeParameters.widthMm ?? config.routeWidthMm;
const frameParameters = report.integratedModel?.frame ?? {};
const validation = report.validation ?? {};
const checkedSolid = validation.connectedComponents === 1 && validation.boundaryEdges === 0 && validation.nonManifoldEdges === 0;
const format = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)).toString() : '?';
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
const actualDimensions = size.map(value => format(value)).join(' × ') + ' mm';
const detail = [actualDimensions, checkedSolid ? 'one closed solid' : 'final mesh', `${triangleCount.toLocaleString('en-US')} triangles`].join(' · ');
const routeDetail = hasRoute
  ? `Raised route${Number.isFinite(routeHeight) ? `: +${format(routeHeight)} mm in Z` : ''}${Number.isFinite(routeWidth) ? ` · ${format(routeWidth)} mm wide` : ''}`
  : 'Terrain only: raised route is not present in this mesh.';
const geometryDetail = routeDetail + (hasFrame && Number.isFinite(frameParameters.widthMm) ? ` · integral frame ${format(frameParameters.widthMm)} mm wide` : '');

const angle = -55 * Math.PI / 180, elevation = 36 * Math.PI / 180;
const towards = { x: Math.cos(angle), y: Math.sin(angle) }, right = { x: -Math.sin(angle), y: Math.cos(angle) };
const eye = { x: towards.x * Math.cos(elevation), y: towards.y * Math.cos(elevation), z: Math.sin(elevation) };
const orthographic = point => ({
  u: point[0] * right.x + point[1] * right.y,
  v: -(point[2] * Math.cos(elevation) - (point[0] * towards.x + point[1] * towards.y) * Math.sin(elevation)),
  depth: point[0] * eye.x + point[1] * eye.y + point[2] * eye.z,
});
const topDown = point => ({ u: point[0], v: -point[1], depth: point[2] });
const light = { x: -0.4, y: -0.5, z: 0.768 };
const palette = { terrain: [119, 145, 116], route: [231, 71, 48], 'route-wall': [185, 43, 34], frame: [182, 168, 140], wall: [64, 92, 77], bottom: [59, 72, 64] };

function coplanarPieces(vertices, maximumEdgeMm = 4) {
  const pending = [vertices], pieces = [];
  while (pending.length) {
    const triangle = pending.pop();
    const lengths = triangle.map((point, index) => Math.hypot(...point.map((value, axis) => value - triangle[(index + 1) % 3][axis])));
    const longest = Math.max(...lengths);
    if (longest <= maximumEdgeMm) { pieces.push(triangle); continue; }
    // Split only the rendering patch. Both children remain on the original exported face.
    const edge = lengths.indexOf(longest), a = triangle[edge], b = triangle[(edge + 1) % 3], c = triangle[(edge + 2) % 3];
    const midpoint = a.map((value, axis) => (value + b[axis]) / 2);
    pending.push([a, midpoint, c], [midpoint, b, c]);
    if (pending.length + pieces.length > 100000) throw new Error('A preview face is too large to subdivide reliably.');
  }
  return pieces;
}

function render(view, project, camera) {
  const triangles = [];
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const vertices = mesh.indices.slice(i, i + 3).map(index => positions.slice(index * 3, index * 3 + 3));
    const [a, b, c] = vertices;
    const normal = {
      x: (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      y: (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
      z: (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    };
    const length = Math.hypot(normal.x, normal.y, normal.z);
    if (length <= 1e-12) throw new Error(`Preview mesh contains a degenerate triangle at face ${i / 3}.`);
    if (normal.x * camera.x + normal.y * camera.y + normal.z * camera.z <= 0) continue;
    const kind = mesh.faceKinds?.[i / 3] ?? (normal.z > 0 ? 'terrain' : 'wall');
    const intensity = 0.46 + 0.54 * Math.max(0, (normal.x * light.x + normal.y * light.y + normal.z * light.z) / length);
    // Long frame and wall triangles can sort through nearby hills. Coplanar refinement improves
    // painter visibility in 3D; the top view uses the untouched face because XY regions do not overlap.
    const patches = view === 'top' ? [vertices] : coplanarPieces(vertices);
    for (const patch of patches) {
      const projected = patch.map(project);
      for (const point of projected) {
        u0 = Math.min(u0, point.u); u1 = Math.max(u1, point.u);
        v0 = Math.min(v0, point.v); v1 = Math.max(v1, point.v);
      }
      const averageZ = patch.reduce((sum, point) => sum + point[2], 0) / 3;
      const color = palette[kind].map(value => Math.min(255, Math.round(value * intensity + (kind === 'terrain' ? averageZ * 0.4 : 0))));
      triangles.push({ projected, depth: projected.reduce((sum, point) => sum + point.depth, 0) / 3, color: `rgb(${color.join(',')})`, kind });
    }
  }
  if (!triangles.length || !(u1 > u0) || !(v1 > v0)) throw new Error(`No visible surface in ${view} preview.`);
  // Orthographic painter ordering is a diagnostic view; coordinates remain the exact final mesh.
  triangles.sort((a, b) => a.depth - b.depth);
  const modelArea = { x: 65, y: 150, width: 970, height: 490 };
  const scale = Math.min(modelArea.width / (u1 - u0), modelArea.height / (v1 - v0));
  const tx = modelArea.x + (modelArea.width - (u1 - u0) * scale) / 2 - u0 * scale;
  const ty = modelArea.y + (modelArea.height - (v1 - v0) * scale) / 2 - v0 * scale;
  // Same-colour edge overdraw closes subpixel antialias seams; it is not a mesh wireframe.
  const paths = triangles.map(triangle => `<path data-kind="${triangle.kind}" d="M${triangle.projected.map(point => `${(point.u * scale + tx).toFixed(3)},${(point.v * scale + ty).toFixed(3)}`).join('L')}Z" fill="${triangle.color}" stroke="${triangle.color}" stroke-width="0.6" stroke-linejoin="round"/>`).join('');
  const title = `Stage ${format(stage, 0)} · ${hasRoute ? 'Terrain with raised route' : 'Terrain'} · ${view === 'top' ? 'Top view' : '3D view'}`;
  const legend = [
    { color: '#779174', text: 'DEM terrain' },
    ...(hasRoute ? [{ color: '#e74730', text: 'Raised route' }] : []),
    ...(hasFrame ? [{ color: '#b6a88c', text: 'Integral frame' }] : []),
  ].map((item, index) => `<rect x="${55 + index * 200}" y="115" width="13" height="13" rx="2" fill="${item.color}"/><text x="${77 + index * 200}" y="127" font-size="14" fill="#606b63">${item.text}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="740" viewBox="0 0 1100 740"><style>text{font-family:Arial,"Microsoft YaHei",sans-serif}</style><rect width="1100" height="740" fill="#f5f6f4"/><text x="55" y="45" font-size="25" fill="#202923">${escape(title)}</text><text x="55" y="75" font-size="17" fill="#606b63">${escape(detail)}</text><text x="55" y="99" font-size="15" fill="#606b63">${escape(geometryDetail)}</text>${legend}${paths}<text x="55" y="688" font-size="15" fill="#606b63">Exact exported mesh · millimetres · orthographic diagnostic preview</text><text x="55" y="714" font-size="14" fill="#606b63">${hasRoute ? 'Red identifies the raised geometry in this preview. STL does not contain colour.' : 'STL geometry is shown without a route overlay.'}</text></svg>`;
}

const perspectiveOutput = stem + '.preview.svg';
const topOutput = stem + '.top.svg';
// Validate and render both views before replacing either existing diagnostic file.
const perspectiveSvg = render('3D', orthographic, eye);
const topSvg = render('top', topDown, { x: 0, y: 0, z: 1 });
await writeFile(perspectiveOutput, perspectiveSvg);
await writeFile(topOutput, topSvg);
console.log(perspectiveOutput);
console.log(topOutput);
