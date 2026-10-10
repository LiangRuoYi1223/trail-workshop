import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Preview } from '../types';

export default function TerrainView({ preview, routeColor }: { preview: Preview | null; routeColor: string }) {
  const container = useRef<HTMLDivElement>(null);
  const actions = useRef<{ reset(): void; top(): void } | null>(null);
  const recolor = useRef<((value:string)=>void) | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const host = container.current;
    if (!host || !preview) return;
    setError('');
    let renderer: THREE.WebGLRenderer | undefined;
    let geometry: THREE.BufferGeometry | undefined;
    let material: THREE.MeshStandardMaterial | undefined;
    let controls: OrbitControls | undefined;
    let observer: ResizeObserver | undefined;
    let frame: number | undefined;
    let disposed = false;
    let lostHandler: ((event: Event) => void) | undefined;
    let resizeHandler: (() => void) | undefined;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor('#f4f5f0');
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      host.appendChild(renderer.domElement);
      renderer.domElement.setAttribute('aria-label', '三维地形：鼠标拖动旋转，滚轮缩放，右键拖动平移');
      renderer.domElement.setAttribute('role', 'img');
      renderer.domElement.tabIndex = 0;
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(35, 1, .05, 10000);
      camera.up.set(0, 0, 1);
      const { positions, indices, faceKinds } = preview.mesh;
      const expanded = new Float32Array(indices.length * 3), colors = new Float32Array(indices.length * 3);
      const palette: Record<string, THREE.Color> = {
        terrain: new THREE.Color('#799278'), route: new THREE.Color(routeColor), 'route-wall': new THREE.Color(routeColor).multiplyScalar(.78),
        frame: new THREE.Color('#c7c2ab'), wall: new THREE.Color('#a9aa92'), bottom: new THREE.Color('#a9aa92'),
      };
      for (let i = 0; i < indices.length; i++) {
        const source = indices[i] * 3, destination = i * 3;
        expanded[destination] = positions[source]; expanded[destination + 1] = positions[source + 1]; expanded[destination + 2] = positions[source + 2];
        const color = palette[faceKinds?.[Math.floor(i / 3)] ?? 'terrain'] ?? palette.terrain;
        color.toArray(colors, destination);
      }
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(expanded, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.computeVertexNormals(); geometry.computeBoundingBox();
      material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .9, metalness: 0 });
      scene.add(new THREE.Mesh(geometry, material));
      scene.add(new THREE.HemisphereLight('#fffdf0', '#858b7e', 2.1));
      const key = new THREE.DirectionalLight('#fff7e4', 3); key.position.set(-100, -70, 180); scene.add(key);
      const fill = new THREE.DirectionalLight('#d7e0e4', .8); fill.position.set(100, 100, 60); scene.add(fill);
      const box = geometry.boundingBox!, size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
      const span = Math.max(size.x, size.y, size.z, 1);
      camera.near = Math.max(.01, span / 1000); camera.far = span * 100; camera.updateProjectionMatrix();
      controls = new OrbitControls(camera, renderer.domElement);
      controls.listenToKeyEvents(renderer.domElement);
      controls.target.copy(center);
      controls.minDistance = span * .2; controls.maxDistance = span * 12;
      controls.maxPolarAngle = Math.PI * .499; controls.enableDamping = false;
      const draw = () => {
        if (disposed || frame !== undefined) return;
        frame = requestAnimationFrame(() => { frame = undefined; if (!disposed && renderer) renderer.render(scene, camera); });
      };
      controls.addEventListener('change', draw);
      recolor.current = value => {
        const top = new THREE.Color(value), wall = top.clone().multiplyScalar(.78);
        for (let i=0;i<indices.length;i++) {
          const kind=faceKinds?.[Math.floor(i/3)];
          if (kind==='route' || kind==='route-wall') (kind==='route' ? top : wall).toArray(colors,i*3);
        }
        geometry!.getAttribute('color').needsUpdate=true; draw();
      };
      const corners: THREE.Vector3[] = [];
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z).sub(center));
      const fit = (direction: THREE.Vector3) => {
        direction.normalize();
        camera.position.copy(center).add(direction);
        camera.lookAt(center);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
        const vertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), horizontal = vertical * camera.aspect;
        let distance = span;
        for (const corner of corners) distance = Math.max(distance, corner.dot(direction) + Math.abs(corner.dot(right)) / horizontal, corner.dot(direction) + Math.abs(corner.dot(up)) / vertical);
        camera.position.copy(center).addScaledVector(direction, distance * 1.12);
        controls!.target.copy(center); controls!.update(); draw();
      };
      const reset = () => fit(new THREE.Vector3(.66, -.9, .76));
      actions.current = {
        reset,
        top: () => fit(new THREE.Vector3(0, -.00001, 1)),
      };
      let lastWidth = 0, lastHeight = 0, lastRatio = 0;
      resizeHandler = () => {
        if (!renderer || !host.clientWidth || !host.clientHeight) return;
        const width = host.clientWidth, height = host.clientHeight, ratio = Math.min(window.devicePixelRatio || 1, 2);
        if (width === lastWidth && height === lastHeight && ratio === lastRatio) return;
        const direction = lastWidth ? camera.position.clone().sub(controls!.target) : new THREE.Vector3(.66, -.9, .76);
        lastWidth = width; lastHeight = height; lastRatio = ratio;
        renderer.setPixelRatio(ratio); renderer.setSize(width, height, false);
        camera.aspect = width / height; camera.updateProjectionMatrix(); fit(direction);
      };
      observer = new ResizeObserver(resizeHandler);
      observer.observe(host);
      window.addEventListener('resize', resizeHandler);
      resizeHandler();
      lostHandler = (event: Event) => { event.preventDefault(); setError('三维显示已中断。切换到地图取景后再打开模型可重新加载；已生成的 STL 仍可保存。'); };
      renderer.domElement.addEventListener('webglcontextlost', lostHandler);
    } catch {
      setError('这台电脑暂时无法显示三维模型。可继续保存已生成的 STL，并在切片软件中查看。');
    }
    return () => {
      disposed = true; if (frame !== undefined) cancelAnimationFrame(frame);
      if (resizeHandler) window.removeEventListener('resize', resizeHandler);
      observer?.disconnect(); controls?.dispose(); geometry?.dispose(); material?.dispose();
      if (renderer) {
        if (lostHandler) renderer.domElement.removeEventListener('webglcontextlost', lostHandler);
        renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
      }
      actions.current = null;
      recolor.current = null;
    };
  }, [preview]);
  useEffect(() => { recolor.current?.(routeColor); }, [routeColor]);
  if (!preview) return <div className="workspace-empty"><h2>等待生成三维地形</h2><p>导入路线，检查地图取景和尺寸，再点击“生成模型”。</p><p className="empty-contract">山体、浮雕路线和底座将生成一个完整实体。</p></div>;
  return <div className="terrain-view">
    <div ref={container} className="terrain-canvas" />
    {error ? <div role="alert" className="render-error">{error}</div> : <>
      <div className="view-actions"><button onClick={() => actions.current?.top()}>俯视</button><button onClick={() => actions.current?.reset()}>恢复视角</button></div>
      <div className="view-caption"><span><i className="legend-dot terrain-dot" />山体</span><span><i className="legend-dot route-dot" style={{background:routeColor}} />路线</span><span>拖动旋转 · 滚轮缩放 · 右键平移</span></div>
    </>}
  </div>;
}
