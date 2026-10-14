import type { FaceClass, ModelAppearance, PaletteEntry } from '../appearance/types.js';
import {AppearanceError, classColor, validateModelAppearance } from '../appearance/palette.js';
import { assertPrintableMesh, type PrintableMesh, type PrintableMeshReport } from '../mesh/validate.js';
import type { MaterialPart } from '../vendor/trailprint/types.js';

export interface MaterialPartsMesh extends PrintableMesh { materialParts?: MaterialPart[] }
export interface MaterialPartReport extends PrintableMeshReport { id: MaterialPart['id'] }
export interface MaterialPartsReport {
  parts: MaterialPartReport[];
  volumeMm3: number;
  outerVolumeMm3: number;
  volumeToleranceMm3: number;
  outer: PrintableMeshReport;
}

const roles = new Set(['terrain','snow','route','base','text']);
const faceKinds = new Set(['terrain','route','route-wall','snow','snow-wall','frame','wall','bottom','base','text','text-wall']);
const faceClasses = new Set(['grass','rock','snow','route','base','text']);
const BOUNDS_TOLERANCE_MM = 1e-6;
function invalid(message: string): never { throw new Error(`Material parts: ${message}`); }

/**
 * Verify closed material solids against the single preview/STL exterior. The sum
 * tolerance is max(1e-6 mm³, 1e-6 × exterior volume), to cover integration roundoff.
 * This is an integrity check, not a general triangle intersection/CSG solver.
 */
export function validateMaterialParts(mesh: MaterialPartsMesh): MaterialPartsReport | undefined {
  if (mesh.materialParts === undefined) return undefined;
  const input = mesh.materialParts;
  if (!Array.isArray(input) || input.length < 1 || input.length > 5) invalid('expected one to five material parts');
  const outer = assertPrintableMesh(mesh);
  const ids = new Set<MaterialPart['id']>();
  const parts: MaterialPartReport[] = [];
  for (const part of input) {
    if (!part || typeof part !== 'object' || !roles.has(part.id) || ids.has(part.id)) invalid('invalid or duplicate part role');
    ids.add(part.id);
    if (!Array.isArray(part.positions) || !Array.isArray(part.indices)) invalid(`${part.id} coordinates and indices must be arrays`);
    let report: PrintableMeshReport;
    try { report = assertPrintableMesh(part,{allowDisconnected:true}); }
    catch (error) { invalid(`${part.id} ${error instanceof Error ? error.message : String(error)}`); }
    for (const axis of ['x','y','z'] as const) {
      if (report.bounds.min[axis] < outer.bounds.min[axis]-BOUNDS_TOLERANCE_MM
        || report.bounds.max[axis] > outer.bounds.max[axis]+BOUNDS_TOLERANCE_MM) invalid(`${part.id} bounds exceed outer mesh`);
    }
    if (part.faceKinds !== undefined && (!Array.isArray(part.faceKinds) || part.faceKinds.length !== report.triangleCount
      || part.faceKinds.some(kind => !faceKinds.has(kind)))) invalid(`${part.id} face labels do not match triangles`);
    if (part.faceClasses !== undefined) {
      if (!Array.isArray(part.faceClasses) || part.faceClasses.length !== report.triangleCount
        || part.faceClasses.some(kind => !faceClasses.has(kind))) invalid(`${part.id} face classes do not match triangles`);
      if (part.faceClasses.some(kind => part.id === 'terrain' ? kind !== 'grass' && kind !== 'rock' : kind !== part.id))
        invalid(`${part.id} face classes do not match part role`);
    }
    parts.push({id:part.id,...report});
  }
  if (!ids.has('terrain')&&!ids.has('base')) invalid('base or legacy terrain part is required');
  const volumeMm3 = parts.reduce((sum,part) => sum+part.volumeMm3,0);
  const volumeToleranceMm3 = Math.max(1e-6,outer.volumeMm3*1e-6);
  if (!Number.isFinite(volumeMm3) || Math.abs(volumeMm3-outer.volumeMm3) > volumeToleranceMm3)
    invalid(`material volume ${volumeMm3} mm3 does not match outer volume ${outer.volumeMm3} mm3 (tolerance ${volumeToleranceMm3} mm3)`);
  return {parts,volumeMm3,outerVolumeMm3:outer.volumeMm3,volumeToleranceMm3,outer};
}

export interface PreparedMaterialParts {
  report: MaterialPartsReport;
  palette: PaletteEntry[];
  parts: Array<{mesh:MaterialPart;materials:number[];defaultMaterial:number}>;
}

/** Remap semantics using current options, including covered terrain absent from the outer palette. */
export function prepareMaterialParts(mesh: MaterialPartsMesh, appearance: ModelAppearance): PreparedMaterialParts {
  const report = validateMaterialParts(mesh);
  if (!report) invalid('material parts are required');
  validateModelAppearance(appearance,report.outer.triangleCount);
  const palette = appearance.palette.map(entry => ({...entry}));
  const materialByColor = new Map(palette.map((entry,index) => [entry.color,index]));
  const names: Record<FaceClass,string> = {grass:'草地',rock:'山石',snow:'白雪',route:'路线',base:'底座',text:'文字'};
  const materialFor = (kind: FaceClass): number => {
    const color = classColor(kind,appearance.options);
    let index = materialByColor.get(color);
    if (index === undefined) {
      index = palette.length;palette.push({id:kind,name:names[kind],color});materialByColor.set(color,index);
    }
    return index;
  };
  const parts = mesh.materialParts!.map(part => {
    if (part.id === 'terrain' && !part.faceClasses) invalid('terrain face classification is required for color export');
    const classes = part.faceClasses ?? Array<FaceClass>(part.indices.length/3).fill(part.id === 'terrain'?'rock':part.id);
    const materials = classes.map(materialFor);
    // Terrain preserves grass/rock surface classes; homogeneous snow and route
    // solids also carry an object-level base material for manufacturing intent.
    return {mesh:part,materials,defaultMaterial:part.id === 'terrain' ? materials[0]! : materialFor(part.id)};
  });
  if (palette.length > appearance.options.maxColors)throw new AppearanceError('APPEARANCE_OPTIONS_INVALID','实际材料颜色超出所选预算，请提高颜色预算或使用底座／文字颜色联动');
  return {report,palette,parts};
}
