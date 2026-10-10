# baozjj/TrailPrint-3D：源码流程研究

研究日期：2026-10-08。固定版本：[f8909baed1152d01b20eb76bc666ff20f457b38d](https://github.com/baozjj/TrailPrint-3D/tree/f8909baed1152d01b20eb76bc666ff20f457b38d)，提交时间 2026-07-26。

方案更新：用户现已确定 React 原生网页、山体／路线／底座一体 STL，以及地表上方 1 mm 的浮雕路线。本报告保留上游分件及 Vue 的源码事实；本项目实施以 [开发流程-v0.1.md](./开发流程-v0.1.md) 为准。

本次读取了 README、需求文档、任务索引、任务 00–08、UI 文档、现有组件与参数类型、GPX/DEM/地形/路线/托盘/导出代码，以及相关校验脚本。源码快照保存在本项目 research 目录，未安装依赖、运行上游程序或打印样品。以下“已有”表示找到实际实现，不等于已通过我们的运行验收。

## 1. 原项目已经完成的产品链路

原项目的中心是托盘式分件地形模型。地图、参数、三维预览、STL 和 ZIP 都已有实现，改造应以这些模块为基础。

实际操作顺序：

1. 配置个人 OpenTopography Key。
2. 选择或拖入 GPX，展示文件名、点数、里程并定位地图。
3. 在 2D 地图设置圆形、矩形或正多边形，调整取景、缩放、朝向、圆角和山体尺寸。
4. 调整地形底厚、垂直放大、DEM 数据集、采样精度及平滑。
5. 调整路线简化、宽度、槽深和突出高度。
6. 设置托盘总厚、下陷深度、边框、路线槽/托盘槽公差；磁铁等为高级选项。
7. 点“预览并下载 STL”，打开三维模态窗口，显示地形与托盘预览。
8. 点“下载”，按配置快照生成打印网格，写出二进制 STL 并打包 ZIP，再选择本地保存位置。
9. 在切片软件中检查部件、分配颜色或分别打印，最后装配。

源码：[ControlSidebar.vue](https://github.com/baozjj/TrailPrint-3D/blob/f8909baed1152d01b20eb76bc666ff20f457b38d/src/components/layout/ControlSidebar.vue)、[PreviewPanel.vue](https://github.com/baozjj/TrailPrint-3D/blob/f8909baed1152d01b20eb76bc666ff20f457b38d/src/components/layout/PreviewPanel.vue)、[useStlExport.ts](https://github.com/baozjj/TrailPrint-3D/blob/f8909baed1152d01b20eb76bc666ff20f457b38d/src/composables/useStlExport.ts)。

## 2. 原项目的三件套

| 文件 | 当前几何与作用 |
| --- | --- |
| `Terrain_Main.stl` | 平底山体，表面形成路线槽 |
| `Trail_Line.stl` | 独立路线嵌件，顶面与挖槽前地形贴合并增加突出高度，底面统一到槽底 |
| `Tray_Base.stl` | 山体外侧的带框托盘，含放置山体的凹槽和装配间隙 |

路线件从统一槽底延伸到原地表，而非简单的浅槽加圆管。在高海拔位置，其实体高度随山体变化。这样保留了路线平底单独打印的结构。

当前路线公差是扩大槽宽，路线宽度不缩小：

`槽宽 = 路线宽度 + 2 × 路线公差`

托盘凹槽由山体轮廓外扩托盘公差，外缘再外扩边框。矩形最终外尺寸为：

`托盘长/宽 = 山体长/宽 + 2 × (托盘公差 + 边框宽度)`

因此网页必须区分山体尺寸和含框成品尺寸。源码：[trail-line-mesh.ts](https://github.com/baozjj/TrailPrint-3D/blob/f8909baed1152d01b20eb76bc666ff20f457b38d/shared/utils/trail-line-mesh.ts)、[tray-footprint.ts](https://github.com/baozjj/TrailPrint-3D/blob/f8909baed1152d01b20eb76bc666ff20f457b38d/shared/utils/tray-footprint.ts)。

### 装配坐标与打印坐标

原地形底面为 `-baseSolidThicknessMm`，路线底面为 `-trailDepthMm`，托盘底面为 0。预览通过 `computeTerrainAssemblyOffsetZMm` 放置山体；STL 导出没有自动给三件套写入完整装配关系。

三件分别打印后装配，和把部件作为一个多材料模型切片，是两种不同使用方式。导出说明必须标明：各件如何放到打印平台，山体与路线应如何保持原相对关系，以及托盘装配平移。后续 3MF 应明确提供“装配展示”或“打印排布”模式，不能把原 ZIP 视为已有这些关系的装配文件。

源码：[assembly-layout.ts](https://github.com/baozjj/TrailPrint-3D/blob/f8909baed1152d01b20eb76bc666ff20f457b38d/shared/utils/assembly-layout.ts)、[export-service.ts](https://github.com/baozjj/TrailPrint-3D/blob/f8909baed1152d01b20eb76bc666ff20f457b38d/electron/main/export/export-service.ts)。

## 3. 实际模型生成链

```text
GPX 文件内容 → 点列/范围/中心
           → AppConfig + 地图视口快照
           → 自动适配取景 + 参数校验
           → DEM GeoTIFF 下载/缓存/采样
           → 缺值处理/平滑/相对高度与毫米缩放
           → 原地表高度场
           ├─ 路线投影/简化/重采样 → 槽走廊 → 地形实体
           └─ 同一地表双线性采样 → 独立路线实体
           → 托盘轮廓/凹槽/可选底面磁铁孔
           → 网格检查 → STL → ZIP
```

重点可复用模块：

| 模块 | 已有实现 | 改造边界 |
| --- | --- | --- |
| 类型/参数 | `shared/types/config.ts` 等定义全部参数和请求响应 | 加协议版本和任务资源引用，保留原字段语义 |
| 取景与坐标 | `crop-region`、`map-mm-projection`、旋转与轮廓工具 | 保持原算法，用旋转/边界样例验证；记录计算选区 |
| 高程 | `opentopography-provider`、`geotiff-sampler`、平滑 | 缓存路径与密钥注入可配置；新数据源另行接入 |
| 地形/路线 | `terrain-main-service`、`heightfield-mesh`、`trail-pipeline`、路线槽/路线件工具 | 保留几何，修复确切边界情况与增加质量门槛 |
| 托盘/装配 | `tray-service`、`tray-footprint`、公差/底孔工具 | 保留已有能力，明确最终尺寸和坐标 |
| 导出 | `stl-writer`、`zip-packager`、`export-service` | 将生成文件与 Electron 保存对话框分开 |
| UI | Vue、Pinia、Leaflet、Three 已有完整交互 | 优先替换通信层，保留界面；外观接入川衡后适配 |

## 4. 文档与当前代码的差异

| 文档中的表述 | 本次源码结论 | 修订规划时的处理 |
| --- | --- | --- |
| 轨迹件缩小公差 | 实体宽度不变，槽宽增加两侧公差 | 以代码为准，测量公差 |
| 输入尺寸是底座最外围尺寸 | 当前尺寸决定山体，托盘还会向外扩 | 分别展示山体和成品外尺寸 |
| 底座边缘纪念文字 | 当前配置没有文字字段，组件无文字入口 | 列为新增功能 |
| 两类磁铁孔和配对免胶水拼接 | 主流程实际生成托盘底面六边形磁铁孔 | 只保留已实现底孔，不承诺山体配对孔 |
| 顶端 2D/3D 切换 | 实际是 2D 主图加 3D 模态预览 | 继承实际交互 |
| 所有耗时工作经任务队列 | 实际主流程直接调用生成服务，队列有占位 handler | 网页版补真正的独立执行任务 |
| 保存参数方案 | 不包含 GPX、Key 和地图取景 | 作为预设；完整复现另存任务快照 |
| 喷漆仍为 TODO | 当前已有相关源码和导出分支，尚未实测 | 保留扩展，另设验收 |

任务编号或“已完成”复选框只能说明作者文档状态，运行验收仍要针对固定版本执行。

## 5. 网页迁移需要补的工作

1. `src/ipc/client.ts` 集中封装 Electron 调用。保留函数契约，替换为 HTTP、任务 ID、状态查询和进度事件。
2. DEM provider 的 `app.getPath('userData')` 换成配置缓存目录。
3. `export-service` 中的保存对话框、`shell` 和 `BrowserWindow` 换成任务输出目录与下载资源；传 `null` 不能消除其 Electron 依赖。
4. 当前 `gpx-session-cache` 是单一全局缓存。网页任务显式携带完整点列/轨迹资源，不使用“最近一次导入”补另一请求。
5. 原队列没有持久化、用户隔离或独立计算线程。个人版增加一个串行子进程任务执行器，复用现有 progress callback。
6. 原预览的 requestId 只丢弃旧响应，450 ms 防抖并不会取消服务端计算。需要合并预览请求，限制并发，并冻结参数和取景快照。
7. 原预览是高度场及路线显示，导出会执行挖槽/完整实体构造。沿用交互预览，同时提供最终导出网格的检查，避免以渲染圆管认定路线实体有效。

来源：[IPC client](https://github.com/baozjj/TrailPrint-3D/blob/f8909baed1152d01b20eb76bc666ff20f457b38d/src/ipc/client.ts)、[provider](https://github.com/baozjj/TrailPrint-3D/blob/f8909baed1152d01b20eb76bc666ff20f457b38d/electron/main/terrain/opentopography-provider.ts)、[全局 GPX 缓存](https://github.com/baozjj/TrailPrint-3D/blob/f8909baed1152d01b20eb76bc666ff20f457b38d/electron/main/gpx/gpx-session-cache.ts)、[实际 handlers](https://github.com/baozjj/TrailPrint-3D/blob/f8909baed1152d01b20eb76bc666ff20f457b38d/electron/main/ipc/handlers.ts)、[队列](https://github.com/baozjj/TrailPrint-3D/blob/f8909baed1152d01b20eb76bc666ff20f457b38d/electron/main/task-queue.ts)。

原 Vue 工具提供交互参考。本项目按用户最新要求在川衡中原生实现 React 页面，复用 Leaflet、Three 和纯 TypeScript 工具；不采用独立 Vue 页面或 iframe。

## 6. 确切需要修复/加强的打印检查

- GPX 正则解析会扁平合并多个轨迹段，需保留原分段。
- 取景裁剪把离开后再次进入轮廓的线段并到一个点数组，可能生成额外跨区连线；需要多段折线结构。
- 统一槽底为 `-trailDepthMm`，山体底面为 `-baseSolidThicknessMm`；必须校验槽底还保有最小底厚。
- `assertWatertightMesh` 检查开放/非流形边；`assertTrailLineMesh` 仅判断三角面不少于 4。需强化路线闭合、退化面、法线、体积和自交检查。
- 对 DEM 下载失败、缺失高程和少量插补分别记录，确保验证时能识别模型地形的来源与修改。
- 对旋转选区、路线出界重入、往返重叠、急转弯及自交，补实际导出样例与切片验证。
- 地形高度还有质量档上限，超限时整体压缩 Z；生成报告需给出实际高度和缩放，而不仅记录输入的名义放大倍数。

依据：[GPX parser](https://github.com/baozjj/TrailPrint-3D/blob/f8909baed1152d01b20eb76bc666ff20f457b38d/electron/main/gpx/parse-gpx.ts)、[footprint clipping](https://github.com/baozjj/TrailPrint-3D/blob/f8909baed1152d01b20eb76bc666ff20f457b38d/shared/utils/footprint.ts)、[model validation](https://github.com/baozjj/TrailPrint-3D/blob/f8909baed1152d01b20eb76bc666ff20f457b38d/shared/utils/model-validation.ts)、[mesh validation](https://github.com/baozjj/TrailPrint-3D/blob/f8909baed1152d01b20eb76bc666ff20f457b38d/shared/utils/mesh-manifold.ts)。

## 7. 修订开发流程的结论

上游作为 DEM、投影、地形及 STL 工具的复用基线。当前流程先提取无 Electron 核心，替换路线槽及独立嵌件构造，将路线直接在最终毫米地表上提高 1 mm，与山体和一体底座生成一个闭合实体，导出一个 STL；网页统一在川衡 React 工程实现。单 STL 是首版要求，3MF、STEP、本地 GeoTIFF、纪念文字及复杂扩展另立增强任务。

后续进展：阶段 1 已完成提取后的 Node 核心，并使用上游示例 GPX 和真实 Copernicus DEM 生成闭合无槽山体 STL，见 [阶段1-实现与验收.md](./阶段1-实现与验收.md)。原桌面完整三件套程序未运行；1 mm 浮雕路线、切片及实物验收仍待后续阶段。
