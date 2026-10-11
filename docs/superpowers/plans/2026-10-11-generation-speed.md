# 生成提速 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** 在不降低地形、路线和影像精度的前提下减少自动配色的等待，并准确显示阶段和超时原因。

**Architecture:** 核心层合并 TIFF 小读取并持久缓存验证过的固定字节块。桌面 worker 并行获取影像和高程，manager 按获取、建模、核验阶段计时；界面显示两类获取状态和实际数据量。三组文件分别负责实现，最后统一构建、审查、测速和打包。

**Tech Stack:** TypeScript、Node 24、geotiff 3.0.5、Electron 44.7、React 19、现有 Node 测试。

**Spec:** docs/superpowers/specs/2026-10-11-generation-speed.md

## Global Constraints

- 保持 Sentinel-2 影像细节、山体和路线几何精度，以及三色／两色输出。
- 只接受现有公共 HTTPS 影像来源；单请求不超过 4 MB，每任务网络读取预算 64 MB。
- 缓存仅复用通过来源、范围和完整性检查的数据；不以缺失数据生成成功模型。
- 取消或超时后无部分可保存模型；验证成功才允许保存。
- 使用实际项目目录；该目录无 Git，因此不初始化仓库或创建工作树，不覆盖旧发行版。

## Review Focus

- 同时读取同一数据块时只下载一次，不越过共享预算。
- 文件末尾、不完整范围响应和损坏缓存不能改变原有影像。
- 超时或取消后已验证块可复用，临时块及未完成模型不能冒充成功结果。
- 一种获取失败时另一种及时取消，不产生未处理异常。
- 自动模式下建模或核验超时不被展示为影像失败。

## Shared Interfaces

核心 SentinelImageOptions.onProgress 的事件保持 progress/message，新增可选 stage、downloadedBytes、cacheBytes、requestCount、coverage；stage 为 query/download/cloud/complete，coverage 为 0..1。

公开 Job 新增可选 phase: prepare/acquire/model/verify，以及 acquisition: { image?: PhaseProgress, dem?: PhaseProgress }。PhaseProgress 为 {state:'running'|'complete', progress:number, message:string, downloadedBytes?:number, cacheBytes?:number, requestCount?:number, coverage?:number}。worker 进度消息传递这两个字段，manager 校验和透传，renderer types 与界面按此消费。

### Task 1: 影像请求合并和缓存

**Files:** src/appearance/online.ts、online-remote.ts、online-types.ts、新增必要的缓存模块、tests/online-surface.test.ts／必要的新缓存测试。

**Interfaces:** 产生核心可选进度字段；SentinelRangeClient 构造保持旧参数兼容，增加可选受信缓存目录。缓存放在现有 surface-cache 下，现有统计和清理应继续涵盖它。

- [ ] 添加真实有限 Range transport 测试，证明相邻小读取复用、同时读取去重、再次获取／重叠范围不重复读取已缓存块。
- [ ] 运行测试并确认旧实现按预期失败。
- [ ] 实施受控字节块合并、内存和持久缓存、完整性验证及下载／缓存进度；保持原始读取像元和最终颜色不变。
- [ ] 验证文件末尾、损坏缓存、取消、预算和最终覆盖检查，以及现有核心测试。

### Task 2: 并行获取和阶段超时

**Files:** desktop/main/worker.mjs、manager.mjs、必要的新阶段 helper、desktop/tests/auto-surface.test.mjs／新任务测试。

**Interfaces:** 消费核心进度字段；产生 Shared Interfaces 中的 phase/acquisition。renderer 文件由 Task 3 修改。

- [ ] 添加获取启动屏障测试：影像尚未完成时高程已启动；添加取消、单分支失败和获取时间不消耗建模阶段时限的测试。
- [ ] 运行测试并确认旧实现按预期失败。
- [ ] 并行获取并在结束后复用已获取高程生成模型，避免重复下载。保留本地文件校验和相同取景验证。
- [ ] manager 按当前阶段设置有限时限并明确区分 IMAGE_TIMEOUT、DEM_TIMEOUT、ACQUISITION_TIMEOUT、MODEL_TIMEOUT、OUTPUT_TIMEOUT；保留测试注入旧 jobTimeoutMs 的兼容性。
- [ ] 验证超时／取消、失败清理、输出验证和原有桌面任务测试。

### Task 3: 进度和错误说明

**Files:** desktop/renderer/App.tsx、types.ts、styles.css、必要的新进度 helper、desktop/tests 中对应界面测试、desktop/scripts/verify-auto-surface.mjs。

**Interfaces:** 消费 phase/acquisition；用已有 createdAt 显示运行时间，不要求 manager 每秒推送。

- [ ] 添加错误分类回归：MODEL_TIMEOUT/OUTPUT_TIMEOUT/JOB_TIMEOUT 不归为影像失败；IMAGE_TIMEOUT 提供重试／本地导入；并行获取两种状态可见。
- [ ] 运行测试并确认旧实现按预期失败。
- [ ] 展示明确阶段、影像和高程状态、已下载／复用的数据量、覆盖比例与已用时间，避免以候选数量冒充实际完成度。
- [ ] 验证 960×720 下错误与恢复按钮可见，保持中文非技术界面及保存禁用条件。

### Task 4: 整体验证与发行

**Files:** desktop/scripts/package.mjs、desktop/main/main.mjs 的版本、更新说明-v0.4.2.txt、最终验证清单-v0.4.2.txt、验证脚本和 artifacts 下测量报告。

- [ ] 审查三组实现及边界；实际首次获取与原始 105 秒／53 请求记录对比，验证缓存和相邻取景复用。
- [ ] 运行完整核心和桌面测试、桌面构建及真实界面检查。
- [ ] 打包 v0.4.2，验证可运行、包含当前源文件、无示例路线及影像、彩色导出和取消／超时处理。
- [ ] 发布本地 ZIP 链接与经过测量的改进，说明实际首次联网耗时受网络影响。
