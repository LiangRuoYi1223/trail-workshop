import type { Inspection, ModelOptions } from '../types';
import { appearanceColor } from '../route-color';
import { contourSvgPath, hasTextPreviewGeometry } from '../text-placement';

export default function RouteView({ inspection, pending, routeColor='#c84832', routeWidthMm=1, options }: { inspection: Inspection | null; pending: boolean; routeColor?:string; routeWidthMm?:number; options?:ModelOptions }) {
  if (!inspection) return <div className="workspace-empty"><h2>{pending ? '正在计算路线范围' : '先导入一条路线'}</h2><p>{pending ? '根据尺寸、外形和留白确定取景。' : '选择徒步软件导出的 GPX 或 KML，调整取景后开始制作。'}</p></div>;
  const textPreview = (!options || options.textEnabled && !!options.baseText?.trim()) && hasTextPreviewGeometry(inspection.baseTextPreview) ? inspection.baseTextPreview : undefined;
  const textColor = options ? appearanceColor('text',options) : routeColor;
  const all = [...inspection.outlineMm, ...inspection.routeSegmentsMm.flat(), ...(textPreview?.outlineMm??[]), ...(textPreview?.contoursMm.flatMap(contour=>contour.outer)??[])];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of all) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const width = Math.max(1, maxX - minX), height = Math.max(1, maxY - minY), pad = Math.max(width, height) * .14;
  const points = (arr: Array<{ x: number; y: number }>) => arr.map(p => `${p.x},${-p.y}`).join(' ');
  return <div className="route-view">
    <svg role="img" aria-label="真实路线与模型取景轮廓" viewBox={`${minX - pad} ${-maxY - pad} ${width + pad * 2} ${height + pad * 2}`}>
      <polygon points={points(inspection.outlineMm)} fill="var(--outline-fill)" stroke="var(--line-strong)" strokeWidth="1.3" vectorEffect="non-scaling-stroke" />
      {textPreview && <polygon className="map-base-text-outline" points={points(textPreview.outlineMm)} fill="none" stroke="var(--line-strong)" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
      {inspection.routeSegmentsMm.map((segment, index) => <polyline key={index} points={points(segment)} fill="none" stroke={routeColor} strokeWidth={Number.isFinite(routeWidthMm) ? Math.max(1.5,routeWidthMm*3) : 3} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />)}
      {textPreview?.contoursMm.map((contour,index)=><path key={index} className="map-base-text-glyph" d={contourSvgPath(contour)} fill={textColor} fillRule="evenodd" />)}
    </svg>
    {options?.textEnabled && options.baseText?.trim() && !pending && inspection.baseTextPreview?.error && <p className="map-notice map-notice-warning" role="status">文字预览：{inspection.baseTextPreview.error}</p>}
    <div className="view-caption"><span><i className="legend-line" style={{borderColor:routeColor}} />徒步路线</span><span><i className="legend-outline" />山体取景</span>{textPreview && <span><i className="legend-text" style={{backgroundColor:textColor}} />凸字与最终外沿</span>}<span>地面范围约 {(inspection.selection.groundWidthM / 1000).toFixed(2)} × {(inspection.selection.groundHeightM / 1000).toFixed(2)} km</span></div>
  </div>;
}
