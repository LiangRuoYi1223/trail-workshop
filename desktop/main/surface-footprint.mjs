const MAX_FOOTPRINT_POINTS = 4096, MAX_SUBDIVISION_DEPTH = 22;
const MAX_OUTPUT_AXIS = 1024, MAX_EDGE_ERROR_PIXELS = .1;
const invalidFootprint = () => { throw Object.assign(new Error('模型地表轮廓无法在允许的精度和点数内转换，请缩小取景范围'), { code: 'IMAGE_REQUEST_INVALID' }); };

/** Keep the generated model outline while resolving curvature introduced by its geographic projection. */
export function terrainImageFootprint(core, frame, gridColumns = 129) {
  const longest = Math.max(frame.crop.widthMm, frame.crop.heightMm);
  const cols = Math.max(3, Math.round((gridColumns - 1) * frame.crop.widthMm / longest) + 1);
  const rows = Math.max(3, Math.round((gridColumns - 1) * frame.crop.heightMm / longest) + 1);
  const outline = core.buildTerrainFootprintPolygonMm(frame.crop, cols, rows), footprint = [];
  if (!Array.isArray(outline) || outline.length < 3 || outline.length > MAX_FOOTPRINT_POINTS) invalidFootprint();
  // Each actual output axis is <= 1024 pixels. Using 1024 on both axes also covers skinny rasters.
  const lonScale = MAX_OUTPUT_AXIS / (frame.bounds.east - frame.bounds.west);
  const latScale = MAX_OUTPUT_AXIS / (frame.bounds.north - frame.bounds.south);
  const appendEdge = (a, b, aGeo, bGeo, depth) => {
    let midpoint, midpointGeo, error = 0;
    // A midpoint alone can lie on the chord when an edge crosses opposite projection bends.
    for (const fraction of [.25, .5, .75]) {
      const point = { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
      const projected = frame.mmToGeo(point.x, point.y);
      error = Math.max(error, Math.abs(projected.lon - (aGeo.lon + (bGeo.lon - aGeo.lon) * fraction)) * lonScale,
        Math.abs(projected.lat - (aGeo.lat + (bGeo.lat - aGeo.lat) * fraction)) * latScale);
      if (fraction === .5) { midpoint = point; midpointGeo = projected; }
    }
    if (!Number.isFinite(error)) invalidFootprint();
    if (error > MAX_EDGE_ERROR_PIXELS) {
      if (depth >= MAX_SUBDIVISION_DEPTH) invalidFootprint();
      appendEdge(a, midpoint, aGeo, midpointGeo, depth + 1);
      appendEdge(midpoint, b, midpointGeo, bGeo, depth + 1);
    } else {
      if (footprint.length >= MAX_FOOTPRINT_POINTS) invalidFootprint();
      footprint.push(aGeo);
    }
  };
  const projected = outline.map(({ x, y }) => frame.mmToGeo(x, y));
  for (let index = 0; index < outline.length; index++) {
    const next = (index + 1) % outline.length;
    appendEdge(outline[index], outline[next], projected[index], projected[next], 0);
  }
  return footprint;
}
