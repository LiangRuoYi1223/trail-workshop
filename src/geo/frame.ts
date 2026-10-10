import { TerrainError } from '../errors.js';
import type { Bounds, GeoPoint, TerrainOptions } from '../types.js';
import type { TerrainCropRegion } from '../vendor/trailprint/types.js';
import { buildFootprintPolygonMm } from '../vendor/trailprint/footprint.js';
const R = 6378137;
const rad = Math.PI / 180;
function mercator(p: GeoPoint) {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 80 || Math.abs(p.lon) > 180)
    throw new TerrainError('GEO_UNSUPPORTED', '阶段 1 仅支持纬度 ±80° 内、不跨日期变更线的 WGS84 局部选区');
  return {x: R*p.lon*rad, y: R*Math.log(Math.tan(Math.PI/4 + p.lat*rad/2))};
}
export interface TerrainFrame {
  crop: TerrainCropRegion; bounds: Bounds; mmPerMeter: number;
  groundWidthM: number; groundHeightM: number;
  geoToMm(p: GeoPoint): {x:number;y:number};
  mmToGeo(x:number,y:number): GeoPoint;
}
export function createTerrainFrame(points: GeoPoint[], options: TerrainOptions = {}): TerrainFrame {
  if (points.length < 2) throw new TerrainError('GPX_TOO_SHORT','至少需要两个有效轨迹点');
  let west=Infinity,east=-Infinity,south=Infinity,north=-Infinity;
  for(const p of points){mercator(p);west=Math.min(west,p.lon);east=Math.max(east,p.lon);south=Math.min(south,p.lat);north=Math.max(north,p.lat);}
  if(east-west>180) throw new TerrainError('GEO_UNSUPPORTED','暂不支持跨日期变更线的路线');
  const center = options.center ?? {lat:(south+north)/2,lon:(west+east)/2};
  const origin=mercator(center), cosLat=Math.cos(center.lat*rad);
  const bearingDeg=options.bearingDeg ?? 0;
  if(!Number.isFinite(bearingDeg)) throw new TerrainError('CONFIG_INVALID','旋转角必须是有限数字');
  const a=bearingDeg*rad, c=Math.cos(a), s=Math.sin(a);
  const ground=(p:GeoPoint)=> {const m=mercator(p), x=(m.x-origin.x)*cosLat, y=(m.y-origin.y)*cosLat;return {x:c*x-s*y,y:s*x+c*y};};
  const shape=options.shape ?? 'rectangle';
  if(!['rectangle','circle','polygon'].includes(shape)) throw new TerrainError('CONFIG_INVALID','不支持的模型形状');
  const requestedWidth=options.widthMm ?? 120;
  const requestedHeight=options.heightMm ?? 80;
  if(!Number.isFinite(requestedWidth)||requestedWidth<10||requestedWidth>500||!Number.isFinite(requestedHeight)||requestedHeight<10||requestedHeight>500)
    throw new TerrainError('CONFIG_INVALID','模型长宽必须在 10–500 mm 之间');
  const n=options.polygonSides ?? 6;
  if(!Number.isInteger(n)||n<3||n>8) throw new TerrainError('CONFIG_INVALID','多边形边数必须为 3–8 的整数');
  const radius=requestedWidth/2;
  // The square sampling frame contains the entire circumcircle, including odd-sided polygons.
  const width=requestedWidth,height=shape==='rectangle'?requestedHeight:requestedWidth;
  const requestedCorner=options.cornerRadiusMm ?? 0;
  const maxCorner=shape==='polygon'?radius*Math.cos(Math.PI/n):shape==='rectangle'?Math.min(width,height)/2:0;
  if(!Number.isFinite(requestedCorner)||requestedCorner<0||requestedCorner>maxCorner+1e-10)
    throw new TerrainError('CONFIG_INVALID',`该形状圆角半径须在 0–${maxCorner.toFixed(3)} mm 之间`);
  // Sub-printable fillets are smaller than the export tolerance; use sharp corners explicitly.
  const corner=requestedCorner<0.01?0:Math.min(requestedCorner,maxCorner);
  const crop:TerrainCropRegion={shape,centerLat:center.lat,centerLon:center.lon,bearingDeg,minLat:south,maxLat:north,minLon:west,maxLon:east,widthMm:width,heightMm:height,radiusMm:shape==='rectangle'?undefined:radius,polygonSides:shape==='polygon'?n:undefined,cornerRadiusMm:corner};
  const poly=buildFootprintPolygonMm(crop);
  const padding=options.paddingFraction ?? 0.1;
  if(!Number.isFinite(padding)||padding<0||padding>0.4) throw new TerrainError('CONFIG_INVALID','取景留白比例必须在 0–0.4 之间');
  let fit=Infinity;
  for(const p of points) {
    const q=ground(p);
    if(shape==='circle') {const length=Math.hypot(q.x,q.y);if(length>1e-9)fit=Math.min(fit,radius/length);}
    else if(poly) for(let i=0;i<poly.length;i++) {
      const u=poly[i],v=poly[(i+1)%poly.length],ex=v.x-u.x,ey=v.y-u.y;
      const limit=ex*u.y-ey*u.x, demand=ex*q.y-ey*q.x;
      // CCW interior lies left of each edge: cross(edge, point) >= cross(edge, start).
      if(demand<0)fit=Math.min(fit,limit/demand);
    }
  }
  if(!Number.isFinite(fit)) throw new TerrainError('GPX_TOO_SHORT','轨迹没有可用于取景的空间跨度');
  const mmPerMeter=options.groundWidthM===undefined?fit*(1-padding):width/options.groundWidthM;
  const groundWidthM=width/mmPerMeter,groundHeightM=height/mmPerMeter;
  if(!Number.isFinite(mmPerMeter)||mmPerMeter<=0||Math.max(groundWidthM,groundHeightM)>100000||Math.min(groundWidthM,groundHeightM)<1)
    throw new TerrainError('GEO_SCALE_INVALID','局部选区尺寸须在 1 m–100 km 内');
  const geoToMm=(p:GeoPoint)=>{const q=ground(p);return {x:q.x*mmPerMeter,y:q.y*mmPerMeter};};
  const mmToGeo=(x:number,y:number):GeoPoint=>{
    const gx=x/mmPerMeter,gy=y/mmPerMeter;
    const mx=origin.x+(c*gx+s*gy)/cosLat,my=origin.y+(-s*gx+c*gy)/cosLat;
    const p={lon:mx/R/rad,lat:(2*Math.atan(Math.exp(my/R))-Math.PI/2)/rad};mercator(p);return p;
  };
  const corners=[mmToGeo(-width/2,-height/2),mmToGeo(width/2,-height/2),mmToGeo(width/2,height/2),mmToGeo(-width/2,height/2)];
  const bounds={west:Math.min(...corners.map(p=>p.lon)),east:Math.max(...corners.map(p=>p.lon)),south:Math.min(...corners.map(p=>p.lat)),north:Math.max(...corners.map(p=>p.lat))};
  if(bounds.east-bounds.west>180||bounds.west< -180||bounds.east>180)throw new TerrainError('GEO_UNSUPPORTED','选区跨越日期变更线');
  Object.assign(crop,{minLat:bounds.south,maxLat:bounds.north,minLon:bounds.west,maxLon:bounds.east});
  return {crop,bounds,mmPerMeter,groundWidthM,groundHeightM,geoToMm,mmToGeo};
}
