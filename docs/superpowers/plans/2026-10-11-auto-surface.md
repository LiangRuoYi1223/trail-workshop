# Automatic Surface Imagery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Ship default online imagery with cloud screening, verified caching, local fallback, and unchanged finite printing colors.

**Architecture:** A core imagery provider queries public Earth Search STAC and reads cropped Sentinel-2 COGs with scene classification. The desktop worker fetches using main-process computed bounds, and publishes source metadata separately from immutable appearance. The renderer chooses auto/local and exposes dates, retry and local fallback.

**Tech Stack:** TypeScript, geotiff, Node, Electron, React; no new production dependencies.

**Spec:** docs/superpowers/specs/2026-10-11-auto-surface.md

## Global Constraints

- Default renderer imageMode is auto; legacy manager calls without imageMode retain local/uniform behavior.
- Only fixed public HTTPS catalog/asset hosts; no renderer URLs; bounded remote ranges and runtime.
- Reject missing/cloud-obscured output rather than classifying it as rock; use SCL 0,1,3,8,9,10 as invalid.
- Preserve at most 3 colors, existing GPX/KML, DEM, model generation/export and local-image behavior.
- Preserve v0.4.0 and older releases; next release v0.4.1; actual project is not a Git checkout, retain source snapshots.

## Review Focus

- Multi-tile or partially cloudy footprints must be fully covered with valid samples or fail explicitly.
- Interrupted, corrupt or out-of-bounds cache must never silently return wrong imagery.
- Unsafe asset URLs, ignored Range responses and excessive TIFF allocations must fail before full download/allocation.
- Old saved projects and mode switching must not accidentally use the wrong image.
- Network failure/cancel must preserve retry/local fallback and never publish a partial model.

---

### Task 1: Core Provider

**Files:** create src/appearance/online.ts, online-types.ts, any focused UTM/remote/cache helpers; tests tests/online-surface.test.ts. Root integrates src/index.ts exports.

**Interfaces:** `loadSentinelColorImage(bounds, {cacheDir, signal?, offlineOnly?, onProgress?, ...test seams}) -> Promise<{image: ColorImage, source: SurfaceImageSource}>`. `SurfaceImageSource = {provider:'Sentinel-2', collection:'sentinel-2-c1-l2a', scenes:{id:string,datetime:string,cloudCover:number}[], cacheHit:boolean, retrievedAt:string, bounds:{west,south,east,north}}`. Export these from respective modules; no changes to existing ColorImageMetadata.

- [x] Write and run failing tests for valid crop, projected UTM alignment, cloud/missing coverage, mosaic, cache integrity/offline reuse, bounded ranges, unsafe URL rejection and abort.
- [x] Implement catalog selection (up to 24 months; bounded candidates), projected true-color/SCL crop, validated finite RGB raster, source metadata and atomic cache.
- [x] Run provider tests, typecheck in isolated output; report exact tests and live public-source probe.

### Task 2: Desktop Worker and Session

**Files:** desktop/main/manager.mjs, worker.mjs, session.mjs, main.mjs, runtime-check.mjs; desktop main tests.

**Interfaces:** request `imageMode?:'auto'|'local'`; undefined legacy means local. createDesktopManager accepts `imageCacheDir`; worker request carries trusted bounds, imageMode and main-controlled cache path. Result and preview.report carry `imageSource?: SurfaceImageSource`. Preferences/recent project save imageMode with backward-compatible local-image inference. Renderer cache info adds `imageBytes`.

- [x] Write and observe failing tests for auto request isolation, local ignored in auto, missing cache error, result provenance, session restore and failed/cancelled worker.
- [x] Wire provider before terrain generation; preserve uniform local no-image mode and local SHA checks; source information goes to result/report.
- [x] Include image cache in cache size/clear, update app version 0.4.1, runtime verification supports auto imagery without disrupting old local checks.
- [x] Run desktop test suite and report results. Do not modify renderer/types or package script.

### Task 3: Renderer and UI Probes

**Files:** desktop/renderer/App.tsx, types.ts, styles.css; desktop/scripts/verify-auto-surface.mjs plus affected existing UI probes.

**Interfaces:** same imageMode/source/cache fields in Task 2; default auto, saved/restored preference; only local mode passes local imageId; signature includes mode plus local image ID only when relevant.

- [x] Add real Electron probe for default auto, requested auto mode, source dates/cache, failed acquisition then retry and local fallback; watch missing-feature failure first.
- [x] Implement selector “自动获取（默认）／本地导入”, truthful acquisition text, cloud/date/network explanation, source dates and cache status; explicit retry and local-import buttons on automatic imagery failure.
- [x] Update old probes to choose local image mode where they verify local/uniform behavior, keep three-color outputs/session restoration checks.
- [x] Run UI probes after root shared build; no external network needed for controlled UI failure/success cases.

### Task 4: Integration, Review and Release

**Files:** src/index.ts, desktop/scripts/package.mjs, product/release docs, artifacts/auto-surface-progress.md; v0.4.1 release.

- [x] Snapshot changed original sources before edits; integrate exports and compile.
- [x] Review all new code and fix important findings; run full core/desktop suites and real local+auto UI probes.
- [x] Verify actual public data when network available, record real date/source and whether cache/offline repeat agrees.
- [x] Package v0.4.1, verify source copies and packaged runtime, create ZIP and report the new version and behavior.
