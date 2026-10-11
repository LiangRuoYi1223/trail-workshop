import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { GeoPoint, Inspection, ModelOptions, RouteInfo, XY } from '../types';
import { geoToSelectionMm, optionsFromVertex, rotationBearing, selectionMmToGeo } from '../framing';
import RouteView from './RouteView';

interface Props {
  route: RouteInfo | null;
  inspection: Inspection | null;
  pending: boolean;
  locked: boolean;
  options: ModelOptions;
  onCenter(center: GeoPoint): void;
  onChange(options: ModelOptions): void;
}

const CENTER_ICON = L.divIcon({
  className: 'map-center-marker', iconSize: [26, 26], iconAnchor: [13, 13],
  html: '<svg viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="7"/><path d="M13 1v7m0 10v7M1 13h7m10 0h7"/></svg>',
});
const VERTEX_ICON = L.divIcon({ className: 'map-vertex-marker', iconSize: [26, 26], iconAnchor: [13, 13],
  html: '<svg viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="6"/></svg>' });
const ROTATION_ICON = L.divIcon({ className: 'map-rotation-marker', iconSize: [30, 30], iconAnchor: [15, 15],
  html: '<svg viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="12"/><path d="M9 16a6 6 0 1 1 3 4M8 11l1 5 5-1"/></svg>' });

export default function RouteMap(props: Props) {
  if (!props.route) return <div className="workspace-empty"><h2>先导入一条路线</h2><p>选择徒步软件导出的 GPX 或 KML，在地图上调整地形范围，再生成打印模型。</p><p className="empty-contract">自动获取高程，也可选用本地高程文件。</p></div>;
  return <MapBoundary key={props.route.id} inspection={props.inspection} pending={props.pending} routeColor={props.options.routeColor} routeWidthMm={props.options.routeWidthMm}><MapScene {...props} route={props.route} /></MapBoundary>;
}

class MapBoundary extends Component<{ children: ReactNode; inspection: Inspection | null; pending: boolean; routeColor:string; routeWidthMm:number }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('地图显示异常', error, info.componentStack); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="route-view"><RouteView inspection={this.props.inspection} pending={this.props.pending} routeColor={this.props.routeColor} routeWidthMm={this.props.routeWidthMm} /><div className="map-notice map-notice-warning" role="alert">地图显示暂时中断，可用左侧取景参数继续建模。</div><div className="map-actions"><button onClick={() => this.setState({ failed: false })}>重试地图</button></div></div>;
  }
}

function MapScene({ route, inspection, options, pending, locked, onCenter, onChange }: Props & { route: RouteInfo }) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const routesRef = useRef<L.LayerGroup | null>(null);
  const outlineRef = useRef<L.Polygon | null>(null);
  const centerRef = useRef<L.Marker | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const verticesRef = useRef<L.Marker[]>([]);
  const rotationRef = useRef<L.Marker | null>(null);
  const rotationLineRef = useRef<L.Polyline | null>(null);
  const dragSnapshot = useRef<{ inspection: Inspection; options: ModelOptions; vertices: XY[]; valid: ModelOptions | null } | null>(null);
  const rotationSnapshot = useRef<{ inspection: Inspection; options: ModelOptions; angle: number; bearing: number } | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const focusRotation = useRef(false);
  const lastFitId = useRef<string | null>(null);
  const lastShapeFit = useRef('');
  const callbacks = useRef({ onCenter, onChange, locked, pending, choosing: false, inspection, options });
  const [basemap, setBasemap] = useState(true);
  const [choosing, setChoosing] = useState(false);
  const [tileError, setTileError] = useState(false);
  const [mapError, setMapError] = useState('');
  const [editError, setEditError] = useState('');
  const [menu, setMenu] = useState<{x: number; y: number} | null>(null);
  const [rotating, setRotating] = useState(false);
  const [rotationAngle, setRotationAngle] = useState(options.bearingDeg);
  callbacks.current = { onCenter, onChange, locked, pending, choosing, inspection, options };

  function openCenterMenu() {
    const current = callbacks.current, map = mapRef.current;
    if (!map || !current.inspection || current.locked || current.pending) return;
    const point = map.latLngToContainerPoint([current.inspection.selection.center.lat, current.inspection.selection.center.lon]);
    const size = map.getSize();
    setMenu({ x: Math.max(8, Math.min(size.x-158,point.x+16)), y: Math.max(8,Math.min(size.y-100,point.y+16)) });
  }
  useEffect(() => { if (menu) menuButton.current?.focus(); }, [menu]);

  useEffect(() => {
    if (!host.current) return;
    let map: L.Map | undefined;
    let observer: ResizeObserver | undefined;
    try {
      const points = route.segments.flat().map(point => L.latLng(point.lat, point.lon));
      if (!points.length) throw new Error('路线没有可显示的坐标');
      map = L.map(host.current, { zoomControl: false, attributionControl: true, minZoom: 3, maxZoom: 17, worldCopyJump: false, trackResize: false });
      // Leaflet vector layers need an established pixel origin and renderer
      // bounds. Fit the real route before adding any paths or clearing them.
      map.fitBounds(L.latLngBounds(points), { padding: [65, 65], maxZoom: 15, animate: false });
      lastFitId.current = route.id;
      mapRef.current = map;
      L.control.zoom({ position: 'bottomright', zoomInTitle: '放大地图', zoomOutTitle: '缩小地图' }).addTo(map);
      map.attributionControl.setPrefix(false);
      routesRef.current = L.layerGroup().addTo(map);
      centerRef.current = L.marker(points[0], { icon: CENTER_ICON, opacity: 0, draggable: true, keyboard: true, title: '取景中心；拖动移动，右键旋转', bubblingMouseEvents: false }).addTo(map);
      centerRef.current.on('dragend', () => {
        if (callbacks.current.locked) return;
        const point = centerRef.current!.getLatLng();
        callbacks.current.onCenter({ lat: point.lat, lon: point.lng });
      });
      centerRef.current.on('contextmenu', event => { L.DomEvent.stop(event.originalEvent); openCenterMenu(); });
      map.on('click', event => {
        setMenu(null);
        if (callbacks.current.locked || !callbacks.current.choosing) return;
        callbacks.current.onCenter({ lat: event.latlng.lat, lon: event.latlng.lng });
        setChoosing(false);
      });
      // Only refresh a visible container. Leaflet's window resize listener would
      // cache a zero size while this tab is hidden. Its pan compensation must
      // remain enabled to preserve the geographic view center after resizing.
      observer = new ResizeObserver(() => { if (host.current?.clientWidth && host.current?.clientHeight) map?.invalidateSize({ animate: false, pan: true, debounceMoveend: true }); });
      observer.observe(host.current);
    } catch (error) {
      console.error('地图初始化失败', error);
      setMapError('地图暂时无法显示，请使用左侧的取景参数继续设置。');
    }
    return () => {
      observer?.disconnect();
      try { map?.remove(); } catch (error) { console.error('地图清理失败', error); }
      mapRef.current = null; routesRef.current = null; outlineRef.current = null; centerRef.current = null; tileRef.current = null;
      verticesRef.current = []; rotationRef.current = null; rotationLineRef.current = null;
      lastFitId.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const layer = L.tileLayer('terrain-map://tiles/{z}/{x}/{y}.png', {
      minZoom: 3, maxZoom: 17, noWrap: true, keepBuffer: 0, updateWhenIdle: true,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
    });
    tileRef.current = layer;
    layer.on('tileerror', () => setTileError(true));
    if (basemap) layer.addTo(map);
    setTileError(false);
    // Remove first: Leaflet's remove listener unregisters its map events.
    // Clearing listeners before removal leaves stale zoom handlers on the map.
    return () => { try { layer.remove(); } catch (error) { console.error('底图清理失败', error); } layer.off(); tileRef.current = null; };
  }, [basemap]);

  useEffect(() => {
    const group = routesRef.current, map = mapRef.current;
    if (!map || !group) return;
    group.clearLayers();
    for (const segment of route.segments) {
      const points = segment.map(point => L.latLng(point.lat, point.lon));
      if (points.length > 1) L.polyline(points, { color: '#bf4834', weight: 3, opacity: .95, interactive: false }).addTo(group);
      else if (points.length === 1) L.circleMarker(points[0], { color: '#bf4834', radius: 3, interactive: false }).addTo(group);
    }
    if (lastFitId.current !== route.id) {
      lastFitId.current = route.id;
      outlineRef.current?.remove(); outlineRef.current = null;
      centerRef.current?.setOpacity(0);
      const points = route.segments.flat().map(point => L.latLng(point.lat, point.lon));
      if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [65, 65], maxZoom: 15, animate: false });
    }
    setChoosing(false);
    setMenu(null); setRotating(false); setEditError('');
  }, [route]);

  useEffect(() => {
    routesRef.current?.eachLayer(layer=>{if(layer instanceof L.Path)layer.setStyle({ color:options.routeColor, weight:Number.isFinite(options.routeWidthMm) ? Math.max(1.5,options.routeWidthMm*3) : 3 });});
  }, [route,options.routeColor,options.routeWidthMm]);

  useEffect(() => {
    const map = mapRef.current;
    const focusedVertex = verticesRef.current.findIndex(marker=>marker.getElement()===document.activeElement);
    verticesRef.current.forEach(marker => marker.remove()); verticesRef.current = [];
    if (!inspection || !map) { outlineRef.current?.remove(); outlineRef.current = null; centerRef.current?.setOpacity(0); return; }
    const points = inspection.outlineGeo.map(point => L.latLng(point.lat, point.lon));
    if (points.length < 3) throw new Error('取景轮廓坐标不足');
    if (outlineRef.current) outlineRef.current.setLatLngs(points);
    else outlineRef.current = L.polygon(points, { color: '#2d624b', weight: 2, fillColor: '#608153', fillOpacity: .1, interactive: false }).addTo(map);
    centerRef.current?.setLatLng([inspection.selection.center.lat, inspection.selection.center.lon]);
    centerRef.current?.setOpacity(1);
    const shapeKey=`${route.id}/${options.shape}/${options.polygonSides}`;
    if(lastShapeFit.current!==shapeKey) {
      lastShapeFit.current=shapeKey;
      map.fitBounds(L.latLngBounds([...points,...route.segments.flat().map(p=>L.latLng(p.lat,p.lon))]),{padding:[65,65],maxZoom:15,animate:false});
    }
    if (!rotating) for (const [index, point] of inspection.controlVerticesGeo.entries()) {
      const marker = L.marker([point.lat,point.lon], { icon: VERTEX_ICON, draggable: !locked && !pending, keyboard: true,
        title: options.shape === 'circle' ? '拖动调整圆形取景大小' : `取景顶点 ${index+1}；拖动调整范围`, bubblingMouseEvents: false }).addTo(map);
      verticesRef.current.push(marker);
      marker.on('dragstart', () => {
        const state = callbacks.current;
        if (state.locked || state.pending || !state.inspection) return;
        setEditError(''); setMenu(null);
        dragSnapshot.current = { inspection: state.inspection, options: state.options, vertices: state.inspection.controlVerticesMm.map(p=>({...p})), valid:null };
      });
      const previewVertex = () => {
        const snapshot = dragSnapshot.current;
        if (!snapshot) return;
        const p = marker.getLatLng(), local = geoToSelectionMm({lat:p.lat,lon:p.lng}, snapshot.inspection.selection, snapshot.options.widthMm);
        try {
          let next: ModelOptions;
          next = optionsFromVertex(local,snapshot.vertices[index],snapshot.inspection.selection,snapshot.options);
          const ratio = next.groundWidthM! / snapshot.inspection.selection.groundWidthM;
          outlineRef.current?.setLatLngs(snapshot.inspection.outlineMm.map(p=>{const g=selectionMmToGeo({x:p.x*ratio,y:p.y*ratio},snapshot.inspection.selection,snapshot.options.widthMm);return L.latLng(g.lat,g.lon);}));
          snapshot.vertices.forEach((p,i)=>{const g=selectionMmToGeo({x:p.x*ratio,y:p.y*ratio},snapshot.inspection.selection,snapshot.options.widthMm);verticesRef.current[i]?.setLatLng([g.lat,g.lon]);});
          snapshot.valid=next; setEditError('');
        } catch (error) { snapshot.valid=null; setEditError(error instanceof Error?error.message:'取景顶点无法调整。'); }
      };
      marker.on('drag',previewVertex);
      marker.on('dragend', () => {
        const snapshot=dragSnapshot.current; dragSnapshot.current=null;
        if (snapshot?.valid && !callbacks.current.locked) callbacks.current.onChange(snapshot.valid);
        else if (snapshot) { verticesRef.current.forEach((m,i)=>{const p=snapshot.inspection.controlVerticesGeo[i];m.setLatLng([p.lat,p.lon]);}); outlineRef.current?.setLatLngs(snapshot.inspection.outlineGeo.map(p=>L.latLng(p.lat,p.lon))); }
      });
      marker.getElement()?.addEventListener('keydown', event => {
        if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key) || callbacks.current.locked || callbacks.current.pending) return;
        event.preventDefault(); event.stopPropagation();
        const step=event.shiftKey?10:2, screen=map.latLngToContainerPoint(marker.getLatLng());
        const geo=map.containerPointToLatLng(screen.add([event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0]));
        marker.fire('dragstart');marker.setLatLng(geo);marker.fire('drag');marker.fire('dragend');
      });
    }
    if(focusedVertex>=0) verticesRef.current[focusedVertex]?.getElement()?.focus();
  }, [inspection, rotating]);

  useEffect(() => {
    if (locked || pending || rotating) { centerRef.current?.dragging?.disable(); setChoosing(false); }
    else centerRef.current?.dragging?.enable();
    for (const marker of verticesRef.current) { if (locked || pending) marker.dragging?.disable(); else marker.dragging?.enable(); }
    if (locked) { setMenu(null);setRotating(false); }
    if (pending || locked) rotationRef.current?.dragging?.disable(); else rotationRef.current?.dragging?.enable();
  }, [locked, pending, rotating]);

  useEffect(() => {
    const map=mapRef.current;
    rotationRef.current?.remove();rotationRef.current=null;rotationLineRef.current?.remove();rotationLineRef.current=null;
    if (!rotating || !inspection || !map || locked) return;
    setRotationAngle(inspection.selection.bearingDeg);
    const center=L.latLng(inspection.selection.center.lat,inspection.selection.center.lon);
    const point=map.latLngToContainerPoint(center);
    const radius=Math.max(60,...inspection.outlineGeo.map(p=>map.latLngToContainerPoint([p.lat,p.lon]).distanceTo(point)))+30;
    const handle=map.containerPointToLatLng([point.x,Math.max(24,point.y-radius)]);
    rotationLineRef.current=L.polyline([center,handle],{color:'#2d624b',weight:1.5,dashArray:'5 5',interactive:false}).addTo(map);
    const marker=L.marker(handle,{icon:ROTATION_ICON,draggable:!pending,keyboard:true,title:'旋转手柄；拖动旋转取景，方向键微调',bubblingMouseEvents:false}).addTo(map);
    rotationRef.current=marker;
    if(focusRotation.current) {marker.getElement()?.focus();focusRotation.current=false;}
    const applyAngle = (bearing: number, snapshot: {inspection: Inspection; options: ModelOptions}) => {
      const selection={...snapshot.inspection.selection,bearingDeg:bearing};
      outlineRef.current?.setLatLngs(snapshot.inspection.outlineMm.map(p=>{const g=selectionMmToGeo(p,selection,snapshot.options.widthMm);return L.latLng(g.lat,g.lon);}));
      setRotationAngle(bearing);
    };
    marker.on('dragstart',()=>{
      const current=callbacks.current;if (!current.inspection || current.locked || current.pending) return;
      const c=map.latLngToContainerPoint(center),p=map.latLngToContainerPoint(marker.getLatLng());
      rotationSnapshot.current={inspection:current.inspection,options:current.options,angle:Math.atan2(p.y-c.y,p.x-c.x),bearing:current.inspection.selection.bearingDeg};
    });
    marker.on('drag',()=>{
      const snapshot=rotationSnapshot.current;if (!snapshot) return;
      const c=map.latLngToContainerPoint(center),p=map.latLngToContainerPoint(marker.getLatLng());
      if(p.distanceTo(c)<12) return;
      snapshot.bearing=rotationBearing(snapshot.inspection.selection.bearingDeg,snapshot.angle,Math.atan2(p.y-c.y,p.x-c.x));
      applyAngle(snapshot.bearing,snapshot);rotationLineRef.current?.setLatLngs([center,marker.getLatLng()]);
    });
    marker.on('dragend',()=>{
      const snapshot=rotationSnapshot.current;rotationSnapshot.current=null;
      if (snapshot && !callbacks.current.locked) callbacks.current.onChange({...snapshot.options,center:snapshot.inspection.selection.center,groundWidthM:snapshot.inspection.selection.groundWidthM,bearingDeg:snapshot.bearing});
    });
    marker.getElement()?.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key) || callbacks.current.locked || callbacks.current.pending) return;
      event.preventDefault();event.stopPropagation();
      const current=callbacks.current;if (!current.inspection) return;
      callbacks.current.onChange({...current.options,center:current.inspection.selection.center,groundWidthM:current.inspection.selection.groundWidthM,
        bearingDeg:rotationBearing(current.inspection.selection.bearingDeg,0,(event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1)*(event.shiftKey?10:1)*Math.PI/180)});
    });
    return ()=>{focusRotation.current=marker.getElement()===document.activeElement;marker.remove();rotationLineRef.current?.remove();rotationLineRef.current=null;rotationRef.current=null;};
  }, [rotating,inspection,locked]);

  function showAll() {
    const points = [...route.segments.flat(), ...(inspection?.outlineGeo ?? [])].map(point => L.latLng(point.lat, point.lon));
    if (points.length) mapRef.current?.fitBounds(L.latLngBounds(points), { padding: [65, 65], maxZoom: 15, animate: false });
  }

  return <div className={`route-map${choosing ? ' choosing-center' : ''}`} onKeyDown={event => {
    if (event.key === 'Escape') {setChoosing(false);setMenu(null);setRotating(false);centerRef.current?.getElement()?.focus();}
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {event.preventDefault();openCenterMenu();}
  }}>
    <div ref={host} className="map-canvas" aria-label="路线与地形取景地图；方向键移动地图，加减键缩放" />
    <div className="map-actions"><button onClick={() => {setChoosing(value => !value);setRotating(false);setMenu(null);}} aria-pressed={choosing} disabled={locked || pending || !!mapError}>{choosing ? '取消点选' : '点选中心'}</button><button onClick={()=>{focusRotation.current=!rotating;setRotating(value=>!value);setChoosing(false);setMenu(null);}} aria-pressed={rotating} disabled={locked || pending || !inspection || !!mapError}>{rotating?'完成旋转':'旋转取景'}</button><button onClick={showAll} disabled={!!mapError}>显示全貌</button><label className="map-basemap"><input type="checkbox" checked={basemap} onChange={event => setBasemap(event.currentTarget.checked)} />底图</label></div>
    {menu && <div className="map-center-menu" role="menu" aria-label="取景中心操作" style={{left:menu.x,top:menu.y}} onKeyDown={event=>{if(event.key==='Tab'){setMenu(null);}}}><button role="menuitem" ref={menuButton} onClick={()=>{focusRotation.current=true;setMenu(null);setChoosing(false);setRotating(true);}}>旋转取景</button><button role="menuitem" onClick={()=>{setMenu(null);if(inspection)onChange({...options,center:inspection.selection.center,groundWidthM:inspection.selection.groundWidthM,bearingDeg:0});}}>恢复朝向</button></div>}
    {rotating && <div className="map-rotation-status" role="status">拖动圆形手柄旋转 · {rotationAngle.toFixed(1)}°<button onClick={()=>setRotating(false)}>完成</button></div>}
    {(choosing || pending || mapError || editError || tileError && basemap) && <div className={`map-notice${tileError || mapError || editError ? ' map-notice-warning' : ''}`} role="status">{mapError || editError || (choosing ? '点击地图，移动取景中心。' : pending ? '正在更新取景范围…' : '底图未完整加载。路线与取景仍可调整，不影响建模。')}</div>}
    <div className="map-caption"><span><i className="legend-line" style={{borderColor:options.routeColor}} />徒步路线</span><span><i className="legend-outline" />山体取景</span>{inspection && <span>地面 {(inspection.selection.groundWidthM / 1000).toFixed(2)} × {(inspection.selection.groundHeightM / 1000).toFixed(2)} km</span>}<span className="map-help">拖动顶点调整范围 · 拖动十字移动 · 右键中心旋转</span></div>
  </div>;
}
