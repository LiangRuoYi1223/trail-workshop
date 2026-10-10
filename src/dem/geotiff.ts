/**
 * GeoTIFF DEM sampling, based on the sampler in baozjj/TrailPrint-3D
 * (MIT, commit f8909baed1152d01b20eb76bc666ff20f457b38d).
 *
 * Supported input: single-band, north-up EPSG:4326 with PixelScale/Tiepoint.
 * Raster values must already be elevations in metres. No vertical-datum
 * conversion, raster scale/offset conversion or CRS reprojection is performed.
 */
import { fromArrayBuffer } from "geotiff";
import { SaxesParser } from "saxes";

export interface GeotiffMetadata {
  width: number;
  height: number;
  bounds: { west: number; south: number; east: number; north: number };
  crs: "EPSG:4326";
  pixelIsArea: boolean;
  nodata?: number | "NaN";
  elevationUnit: "m";
  unitSource: "GeoKey" | "GDAL" | "input-contract";
  validPixels: number;
  missingPixels: number;
  warnings: string[];
}

export interface GeotiffSampler {
  /** Returns a height in metres; outside coverage or no weighted data => null. */
  sample(lat: number, lon: number): number | null;
  metadata: GeotiffMetadata;
}

export class DemGeotiffError extends Error {
  constructor(public readonly code: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "DemGeotiffError";
  }
}

function fail(code: string, message: string): never {
  throw new DemGeotiffError(code, message);
}

function numbers(value: unknown, name: string): number[] {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) {
    return fail("DEM_TRANSFORM_UNSUPPORTED", `GeoTIFF 缺少有效的 ${name}`);
  }
  const out = Array.from(value as ArrayLike<number>);
  if (!out.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return fail("DEM_TRANSFORM_UNSUPPORTED", `GeoTIFF ${name} 含无效数值`);
  }
  return out;
}

function parseNoData(value: unknown): number | "NaN" | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return fail("DEM_METADATA_INVALID", "GeoTIFF GDAL_NODATA 不是有效字符串");
  }
  const text = value.replace(/\0+$/u, "").trim();
  if (/^nan$/iu.test(text)) return "NaN";
  const number = text === "" ? NaN : Number(text);
  if (!Number.isFinite(number)) {
    return fail("DEM_METADATA_INVALID", "GeoTIFF GDAL_NODATA 值无法识别");
  }
  return number;
}

/** Reject non-identity height encoding instead of guessing its interpretation. */
function checkGdalHeightMetadata(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "string") {
    return fail("DEM_METADATA_INVALID", "GeoTIFF GDAL_METADATA 不是有效XML");
  }
  const parser = new SaxesParser({ xmlns: false });
  let item: { name: string; role: string; sample?: string; text: string } | null = null;
  let metresDeclared = false;
  parser.on("opentag", (tag) => {
    if (tag.name !== "Item") return;
    const attributes = tag.attributes as Record<string, string>;
    item = {
      name: (attributes.name ?? "").toUpperCase(),
      role: (attributes.role ?? "").toLowerCase(),
      sample: attributes.sample,
      text: "",
    };
  });
  parser.on("text", (text) => { if (item) item.text += text; });
  parser.on("cdata", (text) => { if (item) item.text += text; });
  parser.on("closetag", (tag) => {
    if (tag.name !== "Item" || !item) return;
    const current = item;
    item = null;
    if (current.sample !== undefined) {
      const sampleText = current.sample.trim();
      const sample = sampleText === "" ? NaN : Number(sampleText);
      if (!Number.isSafeInteger(sample) || sample < 0) {
        fail("DEM_METADATA_INVALID", "GeoTIFF GDAL_METADATA sample 波段索引无法识别");
      }
      // GDAL uses zero-based indices; "00" and "0.0" still describe our elevation band.
      if (sample !== 0) return;
    }
    const content = current.text.trim();
    const role = current.role;
    const name = current.name;
    if (role === "scale" || role === "offset" || name === "SCALE" || name === "OFFSET") {
      const expected = role === "offset" || name === "OFFSET" ? 0 : 1;
      if (content === "" || !Number.isFinite(Number(content)) || Number(content) !== expected) {
        fail("DEM_HEIGHT_ENCODING_UNSUPPORTED", "GeoTIFF 含非单位高程 Scale/Offset，请先转换为实际米制高程");
      }
    }
    if (role === "unittype" || ["UNITTYPE", "UNITS", "UNIT", "VERTICAL_UNITS", "ELEVATION_UNITS"].includes(name)) {
      if (!["m", "meter", "meters", "metre", "metres"].includes(content.toLowerCase())) {
        fail("DEM_UNITS_UNSUPPORTED", "GeoTIFF 高程单位不是米，请先转换为米制高程");
      }
      metresDeclared = true;
    }
  });
  try {
    parser.write(value.replace(/\0+$/u, "")).close();
  } catch (error) {
    if (error instanceof DemGeotiffError) throw error;
    throw new DemGeotiffError("DEM_METADATA_INVALID", "GeoTIFF GDAL_METADATA XML 无法解析", error);
  }
  return metresDeclared;
}

export async function createGeotiffSampler(buffer: ArrayBuffer): Promise<GeotiffSampler> {
  try {
    const tiff = await fromArrayBuffer(buffer);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2) {
      fail("DEM_DIMENSIONS_INVALID", "GeoTIFF 每边至少需要2个像元");
    }
    if (image.getSamplesPerPixel() !== 1) {
      fail("DEM_BANDS_UNSUPPORTED", "GeoTIFF 只支持单波段高程栅格");
    }
    const directory = image.getFileDirectory();
    const keys = image.getGeoKeys();
    if (!keys || keys.GeographicTypeGeoKey !== 4326 || keys.ProjectedCSTypeGeoKey !== undefined
      || (keys.GTModelTypeGeoKey !== undefined && keys.GTModelTypeGeoKey !== 2)) {
      fail("DEM_CRS_UNSUPPORTED", "GeoTIFF 只支持明确声明的 EPSG:4326 经纬度坐标");
    }
    if (keys.GeogAngularUnitsGeoKey !== undefined && keys.GeogAngularUnitsGeoKey !== 9102) {
      fail("DEM_CRS_UNSUPPORTED", "GeoTIFF 经纬度角度单位必须为度");
    }
    const rasterType = keys.GTRasterTypeGeoKey ?? 1; // GeoTIFF default: PixelIsArea.
    if (rasterType !== 1 && rasterType !== 2) {
      fail("DEM_RASTER_TYPE_UNSUPPORTED", "GeoTIFF 仅支持 RasterPixelIsArea 或 RasterPixelIsPoint");
    }
    const pixelIsArea = rasterType === 1;
    const orientation = await directory.loadValue("Orientation");
    if (orientation !== undefined && orientation !== 1) {
      fail("DEM_TRANSFORM_UNSUPPORTED", "GeoTIFF 仅支持左上起点的北向栅格");
    }
    if (directory.hasTag("ModelTransformation")) {
      fail("DEM_TRANSFORM_UNSUPPORTED", "GeoTIFF 暂不支持 ModelTransformation 矩阵，请转换为北向 PixelScale/Tiepoint 栅格");
    }
    const scale = numbers(await directory.loadValue("ModelPixelScale"), "ModelPixelScale");
    const ties = numbers(await directory.loadValue("ModelTiepoint"), "ModelTiepoint");
    if (scale.length !== 3 || scale[0] <= 0 || scale[1] <= 0 || ![0, 1].includes(scale[2])
      || ties.length < 6 || ties.length % 6 !== 0) {
      fail("DEM_TRANSFORM_UNSUPPORTED", "GeoTIFF 缩放或控制点不是受支持的北向仿射映射");
    }
    const [dx, dy] = scale;
    // A tiepoint need not be at raster index (0,0).
    const originX = ties[3] - ties[0] * dx;
    const originY = ties[4] + ties[1] * dy;
    for (let i = 0; i < ties.length; i += 6) {
      if (ties[i + 2] !== 0 || ties[i + 5] !== 0) {
        fail("DEM_HEIGHT_ENCODING_UNSUPPORTED", "GeoTIFF 含垂直控制点偏移，请先转换为原始米制高程栅格");
      }
      if (Math.abs(ties[i + 3] - ties[i] * dx - originX) > 1e-9
        || Math.abs(ties[i + 4] + ties[i + 1] * dy - originY) > 1e-9) {
        fail("DEM_TRANSFORM_UNSUPPORTED", "GeoTIFF 多个控制点与北向 PixelScale 映射不一致");
      }
    }
    const bounds = {
      west: originX,
      north: originY,
      east: originX + (pixelIsArea ? width : width - 1) * dx,
      south: originY - (pixelIsArea ? height : height - 1) * dy,
    };
    if (!Object.values(bounds).every(Number.isFinite) || bounds.east <= bounds.west
      || bounds.north <= bounds.south || bounds.west < -180 || bounds.east > 180
      || bounds.south < -90 || bounds.north > 90) {
      fail("DEM_BOUNDS_INVALID", "GeoTIFF 地理范围无效或跨越不支持的经纬度边界");
    }
    if (keys.VerticalUnitsGeoKey !== undefined && keys.VerticalUnitsGeoKey !== 9001) {
      fail("DEM_UNITS_UNSUPPORTED", "GeoTIFF 垂直单位不是米，请先转换为米制高程");
    }
    const gdalMetres = checkGdalHeightMetadata(await directory.loadValue("GDAL_METADATA"));
    const unitSource = keys.VerticalUnitsGeoKey === 9001 ? "GeoKey" : gdalMetres ? "GDAL" : "input-contract";
    const nodata = parseNoData(await directory.loadValue("GDAL_NODATA"));
    const raster = await image.readRasters({ samples: [0], interleave: true });
    if (!ArrayBuffer.isView(raster) || raster.length !== width * height) {
      fail("DEM_RASTER_INVALID", "GeoTIFF 高程数组尺寸不匹配");
    }
    const values = Float64Array.from(raster as ArrayLike<number>);
    const isMissing = (value: number): boolean => !Number.isFinite(value)
      || (typeof nodata === "number" && value === nodata);
    let missingPixels = 0;
    for (const value of values) if (isMissing(value)) missingPixels++;
    const metadata: GeotiffMetadata = {
      width, height, bounds, crs: "EPSG:4326", pixelIsArea,
      ...(nodata === undefined ? {} : { nodata }),
      elevationUnit: "m", unitSource,
      validPixels: values.length - missingPixels, missingPixels,
      warnings: unitSource === "input-contract"
        ? ["GeoTIFF 未声明高程单位：按输入契约要求栅格数值已经是米；未推断垂直基准，也未执行 Scale/Offset 转换。"] : [],
    };

    function sample(lat: number, lon: number): number | null {
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lon < bounds.west
        || lon > bounds.east || lat < bounds.south || lat > bounds.north) return null;
      const centreOffset = pixelIsArea ? 0.5 : 0;
      // Area rasters cover the outer half-pixel edges; clamp there, never extrapolate.
      const x = Math.max(0, Math.min(width - 1, (lon - originX) / dx - centreOffset));
      const y = Math.max(0, Math.min(height - 1, (originY - lat) / dy - centreOffset));
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      const tx = x - x0;
      const ty = y - y0;
      const corners: Array<[number, number]> = [
        [values[y0 * width + x0], (1 - tx) * (1 - ty)],
        [values[y0 * width + x1], tx * (1 - ty)],
        [values[y1 * width + x0], (1 - tx) * ty],
        [values[y1 * width + x1], tx * ty],
      ];
      let sum = 0;
      let weight = 0;
      for (const [value, contribution] of corners) {
        if (contribution > 0 && !isMissing(value)) {
          sum += value * contribution;
          weight += contribution;
        }
      }
      return weight > 0 ? sum / weight : null;
    }
    return { metadata, sample };
  } catch (error) {
    if (error instanceof DemGeotiffError) throw error;
    throw new DemGeotiffError("DEM_INVALID_FILE", "高程 GeoTIFF 无法解析或读取", error);
  }
}
