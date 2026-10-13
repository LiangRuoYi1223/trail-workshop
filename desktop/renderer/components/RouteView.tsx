import type { Inspection } from '../types';

export default function RouteView({ inspection, pending, routeColor='#c84832', routeWidthMm=1 }: { inspection: Inspection | null; pending: boolean; routeColor?:string; routeWidthMm?:number }) {
  if (!inspection) return <div className="workspace-empty"><h2>{pending ? '正在计算路线范围' : '先导入一条路线'}</h2><p>{pending ? '根据尺寸、外形和留白确定取景。' : '选择徒步软件导出的 GPX 或 KML，调整取景后开始制作。'}</p></div>;
  const all = [...inspection.outlineMm, ...inspection.routeSegmentsMm.flat()];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of all) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const width = Math.max(1, maxX - minX), height = Math.max(1, maxY - minY), pad = Math.max(width, height) * .14;
  const points = (arr: Array<{ x: number; y: number }>) => arr.map(p => `${p.x},${-p.y}`).join(' ');
  return <div className="route-view">
    <svg role="img" aria-label="真实路线与模型取景轮廓" viewBox={`${minX - pad} ${-maxY - pad} ${width + pad * 2} ${height + pad * 2}`}>
      <polygon points={points(inspection.outlineMm)} fill="var(--outline-fill)" stroke="var(--line-strong)" strokeWidth="1.3" vectorEffect="non-scaling-stroke" />
      {inspection.routeSegmentsMm.map((segment, index) => <polyline key={index} points={points(segment)} fill="none" stroke={routeColor} strokeWidth={Number.isFinite(routeWidthMm) ? Math.max(1.5,routeWidthMm*3) : 3} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />)}
    </svg>
    <div className="view-caption"><span><i className="legend-line" style={{borderColor:routeColor}} />徒步路线</span><span><i className="legend-outline" />山体取景</span><span>地面范围约 {(inspection.selection.groundWidthM / 1000).toFixed(2)} × {(inspection.selection.groundHeightM / 1000).toFixed(2)} km</span></div>
  </div>;
}
