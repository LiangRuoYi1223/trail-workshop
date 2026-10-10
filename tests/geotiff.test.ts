import assert from "node:assert/strict";
import test from "node:test";
import { writeArrayBuffer, type GeotiffWriterMetadata } from "geotiff";
import { createGeotiffSampler, DemGeotiffError } from "../src/dem/geotiff.js";

type FixtureMetadata = GeotiffWriterMetadata & {
  VerticalUnitsGeoKey?: number;
  GeogAngularUnitsGeoKey?: number;
  GDAL_METADATA?: string;
};

function fixture(values = [10, 20, 30, 40], overrides: FixtureMetadata = {}): ArrayBuffer {
  const { GDAL_METADATA, ...otherOverrides } = overrides;
  const metadata: FixtureMetadata & { ImageDescription?: string } = {
    width: 2, height: 2,
    GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1,
    ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, 100, 30, 0],
    VerticalUnitsGeoKey: 9001,
    ...otherOverrides,
    // geotiff.js 3.0.5 reads GDAL_METADATA but its writer's tag-type table
    // omits it. Write another ASCII tag, then change only its TIFF tag ID.
    ...(GDAL_METADATA === undefined ? {} : { ImageDescription: GDAL_METADATA }),
  };
  for (const key of Object.keys(metadata) as Array<keyof typeof metadata>) {
    if (metadata[key] === undefined) delete metadata[key];
  }
  const buffer = writeArrayBuffer(new Float64Array(values), metadata);
  if (GDAL_METADATA !== undefined) {
    const view = new DataView(buffer);
    const littleEndian = view.getUint16(0, false) === 0x4949;
    assert.equal(view.getUint16(2, littleEndian), 42);
    const ifd = view.getUint32(4, littleEndian);
    const count = view.getUint16(ifd, littleEndian);
    let replaced = false;
    for (let index = 0; index < count; index++) {
      const entry = ifd + 2 + index * 12;
      if (view.getUint16(entry, littleEndian) === 270) {
        view.setUint16(entry, 42112, littleEndian);
        replaced = true;
      }
    }
    assert.equal(replaced, true, "ASCII placeholder tag must exist");
  }
  return buffer;
}

function near(actual: number | null, expected: number): void {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) < 1e-8, `${actual} != ${expected}`);
}

async function rejectsCode(buffer: ArrayBuffer, code: string): Promise<void> {
  await assert.rejects(createGeotiffSampler(buffer), (error: unknown) =>
    error instanceof DemGeotiffError && error.code === code);
}

test("PixelIsArea samples pixel centres and covers/clamps its half-pixel edges", async () => {
  const sampler = await createGeotiffSampler(fixture());
  assert.deepEqual(sampler.metadata.bounds, { west: 100, south: 28, east: 102, north: 30 });
  assert.equal(sampler.metadata.pixelIsArea, true);
  assert.equal(sampler.metadata.crs, "EPSG:4326");
  assert.equal(sampler.metadata.unitSource, "GeoKey");
  near(sampler.sample(29.5, 100.5), 10);
  near(sampler.sample(28.5, 101.5), 40);
  near(sampler.sample(29, 101), 25);
  near(sampler.sample(29.25, 100.75), 17.5);
  near(sampler.sample(30, 100), 10);
  near(sampler.sample(28, 102), 40);
  assert.equal(sampler.sample(30.001, 100), null);
  assert.equal(sampler.sample(29, 102.001), null);
  assert.equal(sampler.sample(NaN, 100), null);
  assert.equal(sampler.sample(29, Infinity), null);
});

test("PixelIsPoint ties to sample locations rather than area corners", async () => {
  const sampler = await createGeotiffSampler(fixture(undefined, { GTRasterTypeGeoKey: 2 }));
  assert.deepEqual(sampler.metadata.bounds, { west: 100, south: 29, east: 101, north: 30 });
  assert.equal(sampler.metadata.pixelIsArea, false);
  near(sampler.sample(30, 100), 10);
  near(sampler.sample(29, 101), 40);
  near(sampler.sample(29.5, 100.5), 25);
  assert.equal(sampler.sample(28.999, 100), null);
});

test("tiepoints at nonzero raster indices and anisotropic scale map correctly", async () => {
  const sampler = await createGeotiffSampler(fixture(undefined, {
    ModelPixelScale: [2, 0.5, 0],
    ModelTiepoint: [7, 9, 0, 114, 25.5, 0, 8, 10, 0, 116, 25, 0],
  }));
  assert.deepEqual(sampler.metadata.bounds, { west: 100, south: 29, east: 104, north: 30 });
  near(sampler.sample(29.75, 101), 10);
  near(sampler.sample(29.25, 103), 40);
  near(sampler.sample(29.5, 102), 25);
});

test("NoData neighbours keep bilinear weights, not an unweighted mean", async () => {
  const sampler = await createGeotiffSampler(fixture([10, -9999, 30, 40], { GDAL_NODATA: "-9999" }));
  // x=.75, y=.25: valid weights .1875, .0625, .1875 => 25.714...
  near(sampler.sample(29.25, 101.25), 11.25 / 0.4375);
  assert.equal(sampler.sample(29.5, 101.5), null);
  assert.equal(sampler.metadata.nodata, -9999);
  assert.equal(sampler.metadata.validPixels, 3);
  assert.equal(sampler.metadata.missingPixels, 1);
});

test("missing-data sentinels are read from metadata without rounding or guessing", async () => {
  const ordinary = await createGeotiffSampler(fixture([-9999, -9999.2, -32768, 0]));
  near(ordinary.sample(29.5, 100.5), -9999);
  near(ordinary.sample(28.5, 100.5), -32768);
  const nodata = await createGeotiffSampler(fixture([-9999, -9999.2, 30, 40], { GDAL_NODATA: "-9999" }));
  near(nodata.sample(29.5, 101.5), -9999.2);
});

test("NaN/Infinity and all-missing weighted pixels produce null", async () => {
  const sampler = await createGeotiffSampler(fixture([NaN, Infinity, -Infinity, 40], { GDAL_NODATA: "nan" }));
  assert.equal(sampler.metadata.nodata, "NaN");
  assert.equal(sampler.metadata.missingPixels, 3);
  assert.equal(sampler.sample(29.5, 100.5), null);
  near(sampler.sample(29, 101), 40);
  const allMissing = await createGeotiffSampler(fixture([-9999, -9999, -9999, -9999], { GDAL_NODATA: "-9999" }));
  assert.equal(allMissing.sample(29, 101), null);
});

test("an already-sliced ArrayBuffer is sufficient, with no outside bytes", async () => {
  const source = new Uint8Array(fixture());
  const envelope = new Uint8Array(source.length + 20);
  envelope.set(source, 7);
  const sampler = await createGeotiffSampler(envelope.buffer.slice(7, 7 + source.length));
  near(sampler.sample(29, 101), 25);
});

test("unlabelled raw heights expose the metre-only input contract warning", async () => {
  const sampler = await createGeotiffSampler(fixture(undefined, { VerticalUnitsGeoKey: undefined }));
  assert.equal(sampler.metadata.unitSource, "input-contract");
  assert.equal(sampler.metadata.warnings.length, 1);
  const declared = await createGeotiffSampler(fixture(undefined, {
    VerticalUnitsGeoKey: undefined,
    GDAL_METADATA: '<GDALMetadata><Item name="UNITTYPE" sample="0" role="unittype">metre</Item></GDALMetadata>',
  }));
  assert.equal(declared.metadata.unitSource, "GDAL");
  assert.deepEqual(declared.metadata.warnings, []);
});

test("rejects unsupported CRS, bands and raster type rather than mis-sampling", async () => {
  await rejectsCode(fixture(undefined, { GeographicTypeGeoKey: 4269 }), "DEM_CRS_UNSUPPORTED");
  await rejectsCode(fixture(undefined, { ProjectedCSTypeGeoKey: 3857, GTModelTypeGeoKey: 1 }), "DEM_CRS_UNSUPPORTED");
  // Explicit empty directory prevents writeArrayBuffer's WGS84 defaults.
  await rejectsCode(fixture(undefined, { GeoKeyDirectory: [1, 1, 0, 0] }), "DEM_CRS_UNSUPPORTED");
  await rejectsCode(fixture([1, 2, 3, 4, 5, 6, 7, 8]), "DEM_BANDS_UNSUPPORTED");
  await rejectsCode(fixture(undefined, { GTRasterTypeGeoKey: 32767 }), "DEM_RASTER_TYPE_UNSUPPORTED");
  await rejectsCode(fixture(undefined, { GeogAngularUnitsGeoKey: 9101 }), "DEM_CRS_UNSUPPORTED");
});

test("rejects rotations, flipped scales, absent mapping and inconsistent tiepoints", async () => {
  await rejectsCode(fixture(undefined, { ModelTransformation: [1, 0.1, 0, 100, 0, -1, 0, 30, 0, 0, 1, 0, 0, 0, 0, 1] }), "DEM_TRANSFORM_UNSUPPORTED");
  await rejectsCode(fixture(undefined, { ModelPixelScale: [-1, 1, 0] }), "DEM_TRANSFORM_UNSUPPORTED");
  await rejectsCode(fixture(undefined, { ModelTiepoint: undefined }), "DEM_TRANSFORM_UNSUPPORTED");
  await rejectsCode(fixture(undefined, { ModelTiepoint: [0, 0, 0, 100, 30, 0, 1, 1, 0, 102, 29, 0] }), "DEM_TRANSFORM_UNSUPPORTED");
  await rejectsCode(fixture(undefined, { Orientation: 4 }), "DEM_TRANSFORM_UNSUPPORTED");
});

test("rejects non-metre heights and non-identity height scale/offset", async () => {
  await rejectsCode(fixture(undefined, { VerticalUnitsGeoKey: 9002 }), "DEM_UNITS_UNSUPPORTED");
  await rejectsCode(fixture(undefined, { GDAL_METADATA: '<GDALMetadata><Item name="UNITTYPE" role="unittype">ft</Item></GDALMetadata>' }), "DEM_UNITS_UNSUPPORTED");
  await rejectsCode(fixture(undefined, { GDAL_METADATA: '<GDALMetadata><Item name="scale" sample="0" role="scale">0.1</Item></GDALMetadata>' }), "DEM_HEIGHT_ENCODING_UNSUPPORTED");
  await rejectsCode(fixture(undefined, { GDAL_METADATA: '<GDALMetadata><Item name="offset" role="offset">100</Item></GDALMetadata>' }), "DEM_HEIGHT_ENCODING_UNSUPPORTED");
  await rejectsCode(fixture(undefined, { ModelPixelScale: [1, 1, 2] }), "DEM_TRANSFORM_UNSUPPORTED");
  await rejectsCode(fixture(undefined, { ModelTiepoint: [0, 0, 0, 100, 30, 50] }), "DEM_HEIGHT_ENCODING_UNSUPPORTED");
});

test("invalid data or metadata fails clearly", async () => {
  await rejectsCode(new ArrayBuffer(20), "DEM_INVALID_FILE");
  await rejectsCode(fixture(undefined, { GDAL_NODATA: "unavailable" }), "DEM_METADATA_INVALID");
  await rejectsCode(fixture(undefined, { GDAL_METADATA: '<GDALMetadata><Item role="unittype">m' }), "DEM_METADATA_INVALID");
});

test("numeric GDAL sample zero spellings cannot bypass height encoding checks", async () => {
  for (const sample of ["00", "0.0", " 0 "]) {
    await rejectsCode(fixture(undefined, {
      GDAL_METADATA: `<GDALMetadata><Item name="UNITTYPE" sample="${sample}" role="unittype">ft</Item></GDALMetadata>`,
    }), "DEM_UNITS_UNSUPPORTED");
    await rejectsCode(fixture(undefined, {
      GDAL_METADATA: `<GDALMetadata><Item name="scale" sample="${sample}" role="scale">0.1</Item></GDALMetadata>`,
    }), "DEM_HEIGHT_ENCODING_UNSUPPORTED");
    await rejectsCode(fixture(undefined, {
      GDAL_METADATA: `<GDALMetadata><Item name="offset" sample="${sample}" role="offset">100</Item></GDALMetadata>`,
    }), "DEM_HEIGHT_ENCODING_UNSUPPORTED");
    const sampler = await createGeotiffSampler(fixture(undefined, {
      VerticalUnitsGeoKey: undefined,
      GDAL_METADATA: `<GDALMetadata><Item name="UNITTYPE" sample="${sample}" role="unittype">m</Item></GDALMetadata>`,
    }));
    assert.equal(sampler.metadata.unitSource, "GDAL");
    near(sampler.sample(29, 101), 25);
  }
});

test("unrecognizable GDAL sample indices are rejected instead of ignoring metadata", async () => {
  for (const sample of ["", "first", "NaN", "Infinity", "-1", "0.5", "9007199254740992"]) {
    await rejectsCode(fixture(undefined, {
      GDAL_METADATA: `<GDALMetadata><Item name="scale" sample="${sample}" role="scale">0.1</Item></GDALMetadata>`,
    }), "DEM_METADATA_INVALID");
  }
});
