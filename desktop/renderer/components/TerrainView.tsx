import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Preview, AppearanceOptions } from '../types';
import { appearanceColor, previewPrintClasses } from '../route-color';

export default function TerrainView({ preview, options }: { preview: Preview | null; options: AppearanceOptions }) {
  const container = useRef<HTMLDivElement>(null);
  const actions = useRef<{ reset(): void; top(): void } | null>(null);
  const recolor = useRef<((value:AppearanceOptions)=>void) | null>(null);
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
      const classes=preview.appearance?.faceClasses??preview.mesh.faceClasses??Array.from({length:indices.length/3},(_,i)=>faceKinds?.[i]==='route'||faceKinds?.[i]==='route-wall'?'route':faceKinds?.[i]==='snow'||faceKinds?.[i]==='snow-wall'?'snow':faceKinds?.[i]==='terrain'?'grass':'rock');
      const colorPalette=(value:AppearanceOptions)=>Object.fromEntries(['grass','rock','snow','route','base','text'].map(role=>[role,new THREE.Color(appearanceColor(role,value))]));
      const palette=colorPalette(options);
      for (let i = 0; i < indices.length; i++) {
        const source = indices[i] * 3, destination = i * 3;
        expanded[destination] = positions[source]; expanded[destination + 1] = positions[source + 1]; expanded[destination + 2] = positions[source + 2];
        const color = palette[classes[Math.floor(i/3)]]??palette.rock;
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
        const currentPalette=colorPalette(value);
        for (let i=0;i<indices.length;i++) {
          (currentPalette[classes[Math.floor(i/3)]]??currentPalette.rock).toArray(colors,i*3);
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
      lostHandler = (event: Event) => { event.preventDefault(); setError('三维显示已中断。切换到地图取景后再打开模型可重新加载；已生成的模型仍可保存。'); };
      renderer.domElement.addEventListener('webglcontextlost', lostHandler);
    } catch {
      setError('这台电脑暂时无法显示三维模型。可继续保存已生成的打印文件，并在切片软件中查看。');
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
  useEffect(() => { recolor.current?.(options); }, [options.maxColors,options.grassEnabled,options.rockEnabled,options.grassColor,options.rockColor,options.routeColor,options.baseColorSource,options.baseColor,options.textColorSource,options.textColor]);
  if (!preview) return <div className="workspace-empty"><h2>等待生成三维地形</h2><p>导入路线，检查地图取景和尺寸，再点击“生成模型”。</p><p className="empty-contract">按选中的部分生成闭合模型；开启积雪和路线后，路线位于当地雪面上。</p></div>;
  const actualClasses = new Set(previewPrintClasses(preview));
  const hasSnow = actualClasses.has('snow') || preview.mesh.faceKinds?.some(kind=>kind==='snow'||kind==='snow-wall');
  const hasRoute = actualClasses.has('route') || preview.mesh.faceKinds?.some(kind=>kind==='route'||kind==='route-wall');
  const hasText = actualClasses.has('text') || preview.mesh.faceKinds?.some(kind=>kind==='text'||kind==='text-wall');
  const singleTerrain=options.grassEnabled===false||options.rockEnabled===false||options.grassEnabled===undefined&&options.rockEnabled===undefined&&options.maxColors===2;
  return <div className="terrain-view">
    <div ref={container} className="terrain-canvas" />
    {error ? <div role="alert" className="render-error">{error}</div> : <>
      <div className="view-actions"><button onClick={() => actions.current?.top()}>俯视</button><button onClick={() => actions.current?.reset()}>恢复视角</button></div>
      <div className="view-caption"><span><i className="legend-dot" style={{background:appearanceColor('grass',options)}} />{singleTerrain?'山体':'草地'}</span>{!singleTerrain&&<span><i className="legend-dot" style={{background:appearanceColor('rock',options)}} />山石</span>}{hasSnow&&<span><i className="legend-dot snow-dot" style={{background:'#ffffff'}} />白雪</span>}{hasRoute&&<span><i className="legend-dot route-dot" style={{background:options.routeColor}} />路线</span>}<span><i className="legend-dot" style={{background:appearanceColor('base',options)}} />底座</span>{hasText&&<span><i className="legend-dot" style={{background:appearanceColor('text',options)}} />文字</span>}<span>拖动旋转 · 滚轮缩放 · 右键平移</span></div>
    </>}
  </div>;
}
