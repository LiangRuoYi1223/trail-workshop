import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsPromises, { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { writeArrayBuffer, type GeotiffWriterMetadata } from "geotiff";
import { DemGeotiffError } from "../src/dem/geotiff.js";
import { loadLocalDem, loadOpenTopographyDem } from "../src/dem/provider.js";
import { TerrainError } from "../src/errors.js";
import type { Bounds, DemSampler } from "../src/types.js";

const bounds: Bounds = { west: 100.1, south: 28.1, east: 101.9, north: 29.9 };
const mockKey = "provider-test-mockkey-never-persist";

function fixture(): ArrayBuffer {
  const metadata: GeotiffWriterMetadata & { VerticalUnitsGeoKey: number } = {
    width: 2,
    height: 2,
    GeographicTypeGeoKey: 4326,
    GTModelTypeGeoKey: 2,
    GTRasterTypeGeoKey: 1,
    ModelPixelScale: [1, 1, 0],
    ModelTiepoint: [0, 0, 0, 100, 30, 0],
    VerticalUnitsGeoKey: 9001,
  };
  return writeArrayBuffer(new Float64Array([10, 20, 30, 40]), metadata);
}

function metadata(sampler: DemSampler): Record<string, unknown> {
  return sampler.metadata as Record<string, unknown>;
}

async function sandbox(t: TestContext): Promise<{ dir: string; cacheDir: string }> {
  // Use the writable test workspace: Windows sandbox temp paths may deny renames.
  const temporaryRoot = resolve(process.cwd());
  const dir = await mkdtemp(join(temporaryRoot, "terrain-provider-test-"));
  // Keep the object reference, without reading any existing environment key.
  const originalEnvironment = process.env;
  process.env = {};
  t.after(async () => {
    process.env = originalEnvironment;
    const target = resolve(dir);
    assert.equal(dirname(target), temporaryRoot);
    assert.ok(basename(target).startsWith("terrain-provider-test-"));
    await rm(target, { recursive: true, force: true });
  });
  return { dir, cacheDir: join(dir, "cache") };
}

function mockFetch(
  t: TestContext,
  respond: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): URL[] {
  const requests: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    return respond(url, init);
  });
  return requests;
}

function assertNoKey(value: unknown, key = mockKey): void {
  assert.ok(!JSON.stringify(value).includes(key), "provider report must not contain the API key");
}

test("local DEM reports the hash of the exact source file and remains sampleable", async (t) => {
  const { dir } = await sandbox(t);
  const requests = mockFetch(t, () => { throw new Error("local DEM must not fetch"); });
  const bytes = Buffer.from(fixture());
  const path = join(dir, "local-dem.tif");
  await writeFile(path, bytes);

  const sampler = await loadLocalDem(path);
  assert.equal(metadata(sampler).provider, "local-geotiff");
  assert.equal(metadata(sampler).sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(metadata(sampler).crs, "EPSG:4326");
  assert.equal(sampler.sample(29.5, 100.5), 10);
  assert.equal(sampler.sample(29, 101), 25);
  assert.equal(requests.length, 0);
});

test("OpenTopography validates GeoTIFF before caching and reuses it across different or absent keys", async (t) => {
  const { cacheDir } = await sandbox(t);
  const bytes = fixture();
  const requests = mockFetch(t, (_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(bytes, { headers: { "content-type": "image/tiff" } });
  });

  const first = await loadOpenTopographyDem(bounds, { cacheDir, apiKey: mockKey });
  assert.equal(metadata(first).provider, "opentopography");
  assert.equal(metadata(first).dataset, "COP30");
  assert.equal(metadata(first).cacheHit, false);
  assert.equal(metadata(first).sha256, createHash("sha256").update(Buffer.from(bytes)).digest("hex"));
  assert.equal(first.sample(29, 101), 25);
  const filenames = await readdir(cacheDir);
  assert.equal(filenames.length, 1);
  assert.match(filenames[0]!, /^COP30_[a-f0-9]{64}\.tif$/);
  assertNoKey(filenames);
  assert.deepEqual(await readFile(join(cacheDir, filenames[0]!)), Buffer.from(bytes));

  const replacementKey = "provider-test-a-different-mockkey";
  const second = await loadOpenTopographyDem(bounds, { cacheDir, apiKey: replacementKey });
  const third = await loadOpenTopographyDem(bounds, { cacheDir });
  assert.equal(requests.length, 1);
  for (const sampler of [second, third]) {
    assert.equal(metadata(sampler).cacheHit, true);
    assert.equal(metadata(sampler).provider, "opentopography");
    assert.equal(metadata(sampler).sha256, metadata(first).sha256);
    assert.equal(sampler.sample(28.5, 101.5), 40);
  }
  assert.deepEqual(await readdir(cacheDir), filenames);
  assertNoKey([first.metadata, second.metadata, third.metadata]);
  assertNoKey([second.metadata, third.metadata, filenames], replacementKey);
});

test("OpenTopography sends padded bbox and requested dataset to the expected endpoint", async (t) => {
  const { cacheDir } = await sandbox(t);
  const requests = mockFetch(t, () => new Response(fixture()));
  const sampler = await loadOpenTopographyDem(bounds, {
    cacheDir, dataset: "SRTMGL1", apiKey: `  ${mockKey}  `,
  });
  assert.equal(requests.length, 1);
  const url = requests[0]!;
  assert.equal(url.origin, "https://portal.opentopography.org");
  assert.equal(url.pathname, "/API/globaldem");
  assert.equal(url.searchParams.get("demtype"), "SRTMGL1");
  assert.equal(url.searchParams.get("outputFormat"), "GTiff");
  assert.equal(url.searchParams.get("API_Key"), mockKey);
  for (const [name, expected] of Object.entries({
    west: bounds.west - 0.001,
    south: bounds.south - 0.001,
    east: bounds.east + 0.001,
    north: bounds.north + 0.001,
  })) {
    assert.equal(Number(url.searchParams.get(name)), expected);
  }
  assert.equal(metadata(sampler).dataset, "SRTMGL1");
  assert.match((await readdir(cacheDir))[0]!, /^SRTMGL1_[a-f0-9]{64}\.tif$/);
  assertNoKey(sampler.metadata);
});

test("OpenTopography uses an isolated environment key when no explicit key is provided", async (t) => {
  const { cacheDir } = await sandbox(t);
  process.env.OPENTOPOGRAPHY_API_KEY = ` ${mockKey} `;
  const requests = mockFetch(t, () => new Response(fixture()));
  const sampler = await loadOpenTopographyDem(bounds, { cacheDir });
  assert.equal(requests[0]!.searchParams.get("API_Key"), mockKey);
  assertNoKey(sampler.metadata);
  assertNoKey(await readdir(cacheDir));
});

test("an uncached request without a key fails with DEM_API_KEY_REQUIRED before fetching", async (t) => {
  const { cacheDir } = await sandbox(t);
  const requests = mockFetch(t, () => { throw new Error("missing key must not fetch"); });
  await assert.rejects(loadOpenTopographyDem(bounds, { cacheDir, apiKey: "  " }), (error: unknown) =>
    error instanceof TerrainError && error.code === "DEM_API_KEY_REQUIRED");
  assert.equal(requests.length, 0);
  assert.deepEqual(await readdir(cacheDir), []);
});

test("a successful HTTP response containing an error page is rejected and never cached", async (t) => {
  const { cacheDir } = await sandbox(t);
  const requests = mockFetch(t, () => new Response(`<html>Error ${mockKey}</html>`, {
    headers: { "content-type": "text/html" },
  }));
  await assert.rejects(loadOpenTopographyDem(bounds, { cacheDir, apiKey: mockKey }), (error: unknown) => {
    assert.ok(error instanceof DemGeotiffError);
    assert.equal(error.code, "DEM_INVALID_FILE");
    assertNoKey({ code: error.code, message: error.message });
    return true;
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(await readdir(cacheDir), []);
});

test("HTTP failures cannot persist a response body or expose the key in the reported error", async (t) => {
  const { cacheDir } = await sandbox(t);
  mockFetch(t, () => new Response(`API_Key=${mockKey}`, { status: 403 }));
  await assert.rejects(loadOpenTopographyDem(bounds, { cacheDir, apiKey: mockKey }), (error: unknown) => {
    assert.ok(error instanceof TerrainError);
    assert.equal(error.code, "DEM_FETCH_FAILED");
    assert.match(error.message, /HTTP 403/);
    assertNoKey({ code: error.code, message: error.message });
    return true;
  });
  assert.deepEqual(await readdir(cacheDir), []);
});

test("fetch exceptions are converted to a safe typed error and leave the cache empty", async (t) => {
  const { cacheDir } = await sandbox(t);
  mockFetch(t, (url) => { throw new Error(`mock connection failure: ${url}`); });
  await assert.rejects(loadOpenTopographyDem(bounds, { cacheDir, apiKey: mockKey }), (error: unknown) => {
    assert.ok(error instanceof TerrainError);
    assert.equal(error.code, "DEM_FETCH_FAILED");
    assertNoKey({ code: error.code, message: error.message });
    return true;
  });
  assert.deepEqual(await readdir(cacheDir), []);
});

test("five concurrent identical requests cannot collide on their cache temporary files", async (t) => {
  const { cacheDir } = await sandbox(t);
  const bytes = fixture();
  // Hold every response until all five cache lookups have missed.
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let arrivals = 0;
  const requests = mockFetch(t, async () => {
    if (++arrivals === 5) release!();
    await gate;
    return new Response(bytes);
  });
  const samplers = await Promise.all(Array.from({ length: 5 }, () =>
    loadOpenTopographyDem(bounds, { cacheDir, apiKey: mockKey })));
  assert.equal(requests.length, 5);
  for (const sampler of samplers) {
    assert.equal(metadata(sampler).cacheHit, false);
    assert.equal(sampler.sample(29, 101), 25);
  }
  const files = await readdir(cacheDir);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^COP30_[a-f0-9]{64}\.tif$/);
  assert.deepEqual(await readFile(join(cacheDir, files[0]!)), Buffer.from(bytes));
});

test("a parse-corrupt cache is replaced only after a valid keyed redownload", async (t) => {
  const { cacheDir } = await sandbox(t);
  const bytes = fixture();
  const requests = mockFetch(t, () => new Response(bytes));
  await loadOpenTopographyDem(bounds, { cacheDir, apiKey: mockKey });
  const path = join(cacheDir, (await readdir(cacheDir))[0]!);
  const corrupt = Buffer.from("interrupted or corrupt cache");
  await writeFile(path, corrupt);
  await assert.rejects(loadOpenTopographyDem(bounds, { cacheDir }), (error: unknown) =>
    error instanceof DemGeotiffError && error.code === "DEM_INVALID_FILE");
  assert.equal(requests.length, 1);
  assert.deepEqual(await readFile(path), corrupt);

  const repaired = await loadOpenTopographyDem(bounds, { cacheDir, apiKey: mockKey });
  assert.equal(requests.length, 2);
  assert.equal(metadata(repaired).cacheHit, false);
  assert.equal(metadata(repaired).cacheRecovered, true);
  assert.equal(repaired.sample(29, 101), 25);
  assert.deepEqual(await readFile(path), Buffer.from(bytes));
  assert.equal((await readdir(cacheDir)).length, 1);
});

test("cache read permission errors remain visible and do not cause a redownload", async (t) => {
  const { cacheDir } = await sandbox(t);
  const requests = mockFetch(t, () => new Response(fixture()));
  await loadOpenTopographyDem(bounds, { cacheDir, apiKey: mockKey });
  const denied = Object.assign(new Error("controlled cache read denied"), { code: "EACCES" });
  const mock = t.mock.method(fsPromises, "readFile", async () => { throw denied; });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(loadOpenTopographyDem(bounds, { cacheDir, apiKey: mockKey }), (error: unknown) =>
    error === denied);
  assert.equal(requests.length, 1);
});

test("pre-aborted requests preserve cancellation for both a hit and a missing cache", async (t) => {
  const { cacheDir, dir } = await sandbox(t);
  const requests = mockFetch(t, () => new Response(fixture()));
  await loadOpenTopographyDem(bounds, { cacheDir, apiKey: mockKey });
  const controller = new AbortController();
  controller.abort();
  for (const target of [cacheDir, join(dir, "never-created-cache")]) {
    await assert.rejects(loadOpenTopographyDem(bounds, {
      cacheDir: target, apiKey: mockKey, signal: controller.signal,
    }), (error: unknown) => error === controller.signal.reason);
  }
  assert.equal(requests.length, 1);
  assert.ok(!(await readdir(dir)).includes("never-created-cache"));
});

test("cancellation during cache reading cannot return a successful sampler", async (t) => {
  const { cacheDir } = await sandbox(t);
  const requests = mockFetch(t, () => new Response(fixture()));
  await loadOpenTopographyDem(bounds, { cacheDir, apiKey: mockKey });
  const path = join(cacheDir, (await readdir(cacheDir))[0]!);
  const originalRead = readFile;
  const controller = new AbortController();
  const reason = new DOMException("controlled cancellation after cache read", "AbortError");
  const mock = t.mock.method(fsPromises, "readFile", async () => {
    const bytes = await originalRead(path);
    controller.abort(reason);
    return bytes;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(loadOpenTopographyDem(bounds, {
    cacheDir, apiKey: mockKey, signal: controller.signal,
  }), (error: unknown) => error === reason);
  assert.equal(requests.length, 1);
});

test("response body failures return safe DEM_FETCH_FAILED even when reader cancel fails", async (t) => {
  const { cacheDir } = await sandbox(t);
  mockFetch(t, (url) => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error(`controlled body failure: ${url}`)); },
  })));
  await assert.rejects(loadOpenTopographyDem(bounds, { cacheDir, apiKey: mockKey }), (error: unknown) => {
    assert.ok(error instanceof TerrainError);
    assert.equal(error.code, "DEM_FETCH_FAILED");
    assertNoKey({ code: error.code, message: error.message, cause: error.cause });
    return true;
  });
  assert.deepEqual(await readdir(cacheDir), []);
});

test("cancellation interrupts a pending body read and keeps the caller's reason", async (t) => {
  const { cacheDir } = await sandbox(t);
  const controller = new AbortController();
  const reason = new DOMException("controlled body cancellation", "AbortError");
  let cancelled = false;
  mockFetch(t, () => new Response(new ReadableStream<Uint8Array>({
    pull() { controller.abort(reason); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 })));
  await assert.rejects(loadOpenTopographyDem(bounds, {
    cacheDir, apiKey: mockKey, signal: controller.signal,
  }), (error: unknown) => error === reason);
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(cacheDir), []);
});

test("fetch timeout is distinct from network failure", async (t) => {
  const { cacheDir } = await sandbox(t);
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => timeout.signal);
  mockFetch(t, (url) => {
    timeout.abort(new DOMException("controlled timeout", "TimeoutError"));
    throw new Error(`controlled fetch timeout: ${url}`);
  });
  await assert.rejects(loadOpenTopographyDem(bounds, { cacheDir, apiKey: mockKey }), (error: unknown) => {
    assert.ok(error instanceof TerrainError);
    assert.equal(error.code, "DEM_FETCH_TIMEOUT");
    assertNoKey({ code: error.code, message: error.message, cause: error.cause });
    return true;
  });
  assert.deepEqual(await readdir(cacheDir), []);
});

test("timeout interrupts the response body and cannot be mistaken for user cancellation", async (t) => {
  const { cacheDir } = await sandbox(t);
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => timeout.signal);
  let cancelled = false;
  mockFetch(t, () => new Response(new ReadableStream<Uint8Array>({
    pull() { timeout.abort(new DOMException("controlled body timeout", "TimeoutError")); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 })));
  await assert.rejects(loadOpenTopographyDem(bounds, { cacheDir, apiKey: mockKey }), (error: unknown) =>
    error instanceof TerrainError && error.code === "DEM_FETCH_TIMEOUT");
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(cacheDir), []);
});

test("partial temporary files are removed when writing the cache fails", async (t) => {
  const { cacheDir } = await sandbox(t);
  mockFetch(t, () => new Response(fixture()));
  const originalWrite = writeFile;
  const denied = Object.assign(new Error("controlled partial write failure"), { code: "EACCES" });
  const mock = t.mock.method(fsPromises, "writeFile", async (path: Parameters<typeof writeFile>[0]) => {
    await originalWrite(path, Buffer.from("partial temporary cache"));
    throw denied;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(loadOpenTopographyDem(bounds, { cacheDir, apiKey: mockKey }), (error: unknown) =>
    error === denied);
  assert.deepEqual(await readdir(cacheDir), []);
});

test("temporary files are removed if atomic replacement fails", async (t) => {
  const { cacheDir } = await sandbox(t);
  mockFetch(t, () => new Response(fixture()));
  const denied = Object.assign(new Error("controlled rename failure"), { code: "EACCES" });
  const mock = t.mock.method(fsPromises, "rename", async () => { throw denied; });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(loadOpenTopographyDem(bounds, { cacheDir, apiKey: mockKey }), (error: unknown) =>
    error === denied);
  assert.deepEqual(await readdir(cacheDir), []);
});
