# 有限颜色打印 Implementation Plan

> **For agentic workers:** Implement these independent tasks in this session; root integrates and a fresh reviewer audits the final result. Write meaningful failing tests first.

**Goal:** 输出草地/山石/路线最多三色的真实地表分类模型，支持彩色 3MF、OBJ 包和 STL。

**Architecture:** 复用既有闭合几何，在独立外观层采样地表影像并赋予面分类；所有预览和导出消费同一分类和调色板。主进程管理影像、冻结保存设置与最近项目，几何与外观变化分开处理。

**Tech Stack:** TypeScript、geotiff、Node zlib/crypto、Electron、React、Three.js；无需增加生产依赖。

**Spec:** ../specs/2026-10-11-color-print-design.md

## Global Constraints

- 默认 3 色，允许 2 色；唯一 RGB 最多 3 个，底座和外沿不增加新色。
- 64 MB / 16,777,216 像素；北向 8 位 RGB/RGBA GeoTIFF，EPSG:4326 或 EPSG:3857。
- 旧项目兼容，保留 GPX/KML 和现有 STL；真实影像本地导入，无影像时明确统一配色。
- 版本 v0.4.0，保留旧发布包，原文件备份 artifacts/v0.4.0-original-source。
- 不使用额外耗材模拟预览光影，不声称 RGB 分类是精确土地覆盖。

## Review Focus

- 旋转范围影像对齐，不能将外包矩形直接拉伸。
- 调色板重复、两色切换、路线贴边均保持颜色预算与独立路线色。
- 影像无覆盖/alpha透明/nodata/错误 CRS 不应生成假地表。
- 改色后保存不能输出旧色；影像变化必须失效当前模型。
- 原子保存失败/路径替换及旧项目恢复不回归。

### Task 1: 影像与外观核心（color_core）

**Files:** src/appearance/{types,palette,geotiff,apply}.ts, tests/appearance*.test.ts

**Interfaces:** AppearanceOptions={maxColors:2|3,grassColor,rockColor,routeColor}; ModelAppearance={schemaVersion:1,faceClasses,faceMaterials,palette,options,source?,classification,hash}; loadColorGeoTiff(path) returns sample(lat,lon), metadata; buildModelAppearance(mesh,selection,options,image?) and recolorModelAppearance(appearance,options). selection={center,bearingDeg,mmPerMeter}.

- [x] RED: 无影像统一山体、绿/岩分类、投影和旋转、路线优先、两色/去重、缺覆盖、GeoTIFF RGB 与 CRS/位深/像素限制。
- [x] GREEN: 独立模块实现上述接口，不改 root/desktop 文件。
- [x] 自有临时输出编译并运行 scoped tests；最终由 root 跑完整 suite。

### Task 2: 标准彩色导出（color_exports）

**Files:** src/export/{color-3mf,color-obj,zip,palette-png}.ts, tests/color-export*.test.ts

**Interfaces:** writeColor3mf(mesh,appearance,metadata?) and writeObjBundle(mesh,appearance,metadata?) return Buffer; consume Task 1 ModelAppearance. 沿用 mesh.positions/indices 与 mm 单位。

- [x] RED: 独立 ZIP 解码核对 3MF 顶点面/颜色及 OBJ 材质/PNG 色数，错误外观拒绝。
- [x] GREEN: 标准 OPC 3MF、OBJ/MTL/PNG/manifest ZIP，无设备预设，无额外 RGB。
- [x] 自有临时输出编译并跑 scoped tests。

### Task 3: 桌面后端（color_desktop）

**Files:** desktop/main/{manager,files,session,save-model,worker}.mjs, src/export/publish.ts, desktop/tests/{manager,session,color-model}.test.mjs

**Interfaces:** manager.addImage(path,{expectedSha256?}), removeImage(id), startJob({imageId?,...}), sessionSources({imageId?,...}), exportModel(id,format,appearanceOptions). exportModel returns {bytes:Buffer,extension,downloadName,appearanceHash,format}; root handles native save dialog and atomic save helper. manager.getPreview includes optional appearance. saveSession/restoreSession include imageId/image.

- [x] RED: 本地影像导入和内容变化、旧项目、新项目恢复、当前配色导出、不允许伪造路径/格式。
- [x] GREEN: validateOptions 增加 maxColors/grassColor/rockColor；worker 调核心加载影像和分类并写预览 appearance；几何参数中剥离全部外观键。
- [x] 现有输出校验继续核对 STL；有外观时校验面数/颜色/哈希。
- [x] 生成与保存覆盖取消、SHA 和模型尺寸的一致性。

### Task 4: 桌面界面与连接（root）

**Files:** desktop/main/{main,preload}.mjs/cjs; desktop/renderer/{App,types,route-color,styles}, components/TerrainView.tsx; src/index.ts

- [x] RED: 隐藏窗口探针验证不存在地表影像入口/彩色保存，或已有交互测试覆盖颜色改变后旧保存提示。
- [x] GREEN: 影像导入/清除、2/3色与代表颜色、导出格式；预览按 faceClasses 当前配色绘制，侧壁光影只做光照。
- [x] 更新类型和 IPC，原生保存框格式与主进程冻结外观一致，原有保存原子流程复用。
- [x] 构建并用实际窗口完成彩色生成、改色和两色导出。

### Task 5: 验证与发布（root＋fresh reviewer）

- [x] 完整核心/桌面 suite；构建；独立标准格式回读；STL 闭合检查；隐藏窗口恢复和双格式路线回归。
- [x] 新鲜上下文只读审查修复重要问题。
- [x] 打包 v0.4.0，用打包 exe 生成和导出，再检查发布 ZIP，保留旧版本。
- [x] 更新说明/验收清单明确本地地表影像与 RGB 分类限制、待人工切片/实物验证。
