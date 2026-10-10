import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { GeoPoint, Inspection, RouteInfo } from '../types';
import RouteView from './RouteView';

interface Props {
  route: RouteInfo | null;
  inspection: Inspection | null;
  pending: boolean;
  locked: boolean;
  onCenter(center: GeoPoint): void;
}

const CENTER_ICON = L.divIcon({
  className: 'map-center-marker', iconSize: [26, 26], iconAnchor: [13, 13],
  html: '<svg viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="7"/><path d="M13 1v7m0 10v7M1 13h7m10 0h7"/></svg>',
});

export default function RouteMap(props: Props) {
  if (!props.route) return <div className="workspace-empty"><h2>先导入一条路线</h2><p>选择两步路导出的 GPX，在地图上调整地形范围，再生成打印模型。</p><p className="empty-contract">自动获取高程，也可选用本地高程文件。</p></div>;
  return <MapBoundary key={props.route.id} inspection={props.inspection} pending={props.pending}><MapScene {...props} route={props.route} /></MapBoundary>;
}

class MapBoundary extends Component<{ children: ReactNode; inspection: Inspection | null; pending: boolean }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('地图显示异常', error, info.componentStack); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="route-view"><RouteView inspection={this.props.inspection} pending={this.props.pending} /><div className="map-notice map-notice-warning" role="alert">地图显示暂时中断，可用左侧取景参数继续建模。</div><div className="map-actions"><button onClick={() => this.setState({ failed: false })}>重试地图</button></div></div>;
  }
}

function MapScene({ route, inspection, pending, locked, onCenter }: Props & { route: RouteInfo }) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const routesRef = useRef<L.LayerGroup | null>(null);
  const outlineRef = useRef<L.Polygon | null>(null);
  const centerRef = useRef<L.Marker | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const lastFitId = useRef<string | null>(null);
  const callbacks = useRef({ onCenter, locked, choosing: false });
  const [basemap, setBasemap] = useState(true);
  const [choosing, setChoosing] = useState(false);
  const [tileError, setTileError] = useState(false);
  const [mapError, setMapError] = useState('');
  callbacks.current = { onCenter, locked, choosing };

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
      centerRef.current = L.marker(points[0], { icon: CENTER_ICON, opacity: 0, draggable: true, keyboard: true, title: '取景中心；可拖动，也可在左侧输入经纬度' }).addTo(map);
      centerRef.current.on('dragend', () => {
        if (callbacks.current.locked) return;
        const point = centerRef.current!.getLatLng();
        callbacks.current.onCenter({ lat: point.lat, lon: point.lng });
      });
      map.on('click', event => {
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
    return () => { layer.off(); try { layer.remove(); } catch (error) { console.error('底图清理失败', error); } tileRef.current = null; };
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
  }, [route]);

  useEffect(() => {
    const map = mapRef.current;
    if (!inspection || !map) { outlineRef.current?.remove(); outlineRef.current = null; centerRef.current?.setOpacity(0); return; }
    const points = inspection.outlineGeo.map(point => L.latLng(point.lat, point.lon));
    if (points.length < 3) throw new Error('取景轮廓坐标不足');
    if (outlineRef.current) outlineRef.current.setLatLngs(points);
    else outlineRef.current = L.polygon(points, { color: '#2d624b', weight: 2, fillColor: '#608153', fillOpacity: .1, interactive: false }).addTo(map);
    centerRef.current?.setLatLng([inspection.selection.center.lat, inspection.selection.center.lon]);
    centerRef.current?.setOpacity(1);
  }, [inspection]);

  useEffect(() => {
    if (locked) { centerRef.current?.dragging?.disable(); setChoosing(false); }
    else centerRef.current?.dragging?.enable();
  }, [locked]);

  function showAll() {
    const points = [...route.segments.flat(), ...(inspection?.outlineGeo ?? [])].map(point => L.latLng(point.lat, point.lon));
    if (points.length) mapRef.current?.fitBounds(L.latLngBounds(points), { padding: [65, 65], maxZoom: 15, animate: false });
  }

  return <div className={`route-map${choosing ? ' choosing-center' : ''}`} onKeyDown={event => { if (event.key === 'Escape') setChoosing(false); }}>
    <div ref={host} className="map-canvas" aria-label="路线与地形取景地图；方向键移动地图，加减键缩放" />
    <div className="map-actions"><button onClick={() => setChoosing(value => !value)} aria-pressed={choosing} disabled={locked || !!mapError}>{choosing ? '取消点选' : '点选中心'}</button><button onClick={showAll} disabled={!!mapError}>显示全貌</button><label className="map-basemap"><input type="checkbox" checked={basemap} onChange={event => setBasemap(event.currentTarget.checked)} />底图</label></div>
    {(choosing || pending || mapError || tileError && basemap) && <div className={`map-notice${tileError || mapError ? ' map-notice-warning' : ''}`} role="status">{mapError || (choosing ? '点击地图，移动取景中心。' : pending ? '正在更新取景范围…' : '底图未完整加载。路线与取景仍可调整，不影响建模。')}</div>}
    <div className="map-caption"><span><i className="legend-line" />GPX 路线</span><span><i className="legend-outline" />山体取景</span>{inspection && <span>地面 {(inspection.selection.groundWidthM / 1000).toFixed(2)} × {(inspection.selection.groundHeightM / 1000).toFixed(2)} km</span>}<span className="map-help">拖动十字调整中心；缩放只改变地图视野</span></div>
  </div>;
}
