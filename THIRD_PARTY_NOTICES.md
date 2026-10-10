# 上游来源与许可

`src/vendor/trailprint/` 中的高度场网格、凸裁剪、圆角、平滑和 STL 写入代码，及 `fixtures/sample-trail.gpx`，来源于 [baozjj/TrailPrint-3D](https://github.com/baozjj/TrailPrint-3D/tree/f8909baed1152d01b20eb76bc666ff20f457b38d)。

固定提交：`f8909baed1152d01b20eb76bc666ff20f457b38d`；MIT；Copyright (c) 2026 baozj。完整许可保存在 `src/vendor/trailprint/LICENSE`。

改动包括：Node ESM 导入路径、本地最小类型、轮廓工具子集；提取的生成核心不依赖 Electron、IPC、Vue、槽、嵌件、托盘或 ZIP。阶段 3.1 新增的独立桌面界面使用 Electron＋React，未使用上游 Vue 界面。后续几何修复在源码与阶段记录中标明。

阶段 1 自查后，普通矩形保留原规则网格，圆形／圆角／多边形改为原 XY 三角网格裁剪及闭合侧壁，不再使用同心环重采样；圆角工具补齐切点并去除重复连接点。新增的 `clipped-heightfield.ts`、采样依赖域、DEM provider 与输出发布逻辑为本项目实现；仍保留所使用上游轮廓、裁剪基础工具的 MIT 许可。

真实 DEM 验收夹具来自 [Copernicus GLO-30 公共数据](https://registry.opendata.aws/copernicus-dem/)，为 DSM（包含植被和建筑等地表对象），并非裸地 DTM。下载脚本记录来源、裁剪位置和 SHA-256。该数据并非本项目原创；阶段 3.1 桌面包附带这一小范围裁剪样例，来源和分发说明见下文。

阶段 2 新增的固定依赖：

| 库 | 用途 | 许可／来源 |
| --- | --- | --- |
| `clipper-lib` 6.4.2 | 整数坐标路线缓冲、并集、裁剪、外框偏移 | [junmer/clipper-lib](https://github.com/junmer/clipper-lib)，Boost Software License 1.0；Angus Johnson 2010–2017／Timo 的 JavaScript 移植；随库保留原版权头及内含 JSBN 说明 |
| `earcut` 3.0.2 | 带孔平面区域三角化 | [mapbox/earcut v3.0.2](https://github.com/mapbox/earcut/tree/v3.0.2)，ISC，Copyright (c) 2024 Mapbox；完整 LICENSE 随依赖保留 |
| `polygon-clipping` 0.15.7 | 保留浮点共享交点的路线／地形分区与边框差集 | [mfogel/polygon-clipping v0.15.7](https://github.com/mfogel/polygon-clipping/tree/v0.15.7)，MIT，Mike Fogel 2018／Alexander Milevski 2016；完整 LICENSE.md 随依赖保留 |

这些库通过 npm 依赖使用，版本与完整性固定在 `package-lock.json`。统一网格、源地表残差核查和导出编排由本项目实现；平面三角化输出经过本项目的边界分割和闭合检查，不能只靠库结果证明可打印。

## 阶段 3.1 桌面运行时与界面

以下固定版本用于独立桌面软件。完整版权与许可文本复制到 `desktop/licenses/`，打包后对应 `resources/app/licenses/`；生产 `node_modules/` 继续保留各依赖自带许可。

| 库／运行时 | 用途 | 许可／版权／官方来源 | 随包文本 |
| --- | --- | --- | --- |
| React 19.2.0 | React 界面组件 | MIT；Meta Platforms, Inc. and affiliates；[官方 LICENSE](https://github.com/facebook/react/blob/v19.2.0/LICENSE) | `React-19.2.0-LICENSE.txt` |
| React DOM 19.2.0 | 桌面渲染窗口中的 DOM 渲染 | MIT；Meta Platforms, Inc. and affiliates；[官方仓库](https://github.com/facebook/react/tree/v19.2.0/packages/react-dom) | `ReactDOM-19.2.0-LICENSE.txt` |
| Scheduler 0.27.0 | React DOM 的调度依赖 | MIT；Meta Platforms, Inc. and affiliates；[官方仓库](https://github.com/facebook/react/tree/v19.2.0/packages/scheduler) | `Scheduler-0.27.0-LICENSE.txt` |
| Three.js 0.180.0 | 最终三角网格的三维预览与视角操作 | MIT；2010–2025 three.js authors；[官方 LICENSE](https://github.com/mrdoob/three.js/blob/r180/LICENSE) | `Three-0.180.0-LICENSE.txt` |
| Lucide React 0.468.0 | 界面操作图标 | ISC；Lucide Contributors 2022，部分版权归 Cole Bemis 2013–2022／Feather (MIT)；[官方 LICENSE](https://github.com/lucide-icons/lucide/blob/0.468.0/LICENSE) | `LucideReact-0.468.0-LICENSE.txt` |
| Electron 44.7.0 | Windows 窗口、文件对话框、受控通信与独立计算进程 | MIT；Electron contributors／GitHub Inc. 2013–2020；[官方 LICENSE](https://github.com/electron/electron/blob/v44.7.0/LICENSE) | `Electron-44.7.0-LICENSE.txt` |
| Leaflet 1.9.4 | GPX 分段轨迹、取景边界和地图操作 | BSD 2-Clause；Volodymyr Agafonkin 2010–2023／CloudMade 2010–2011；[官方 LICENSE](https://github.com/Leaflet/Leaflet/blob/v1.9.4/LICENSE) | `Leaflet-1.9.4-LICENSE.txt` |

Electron 分发目录根部原有 `LICENSE`、`LICENSES.chromium.html` 也必须随完整软件文件夹保留；后者包含 Chromium 及其所用第三方组件的许可，不能用一份 Electron MIT 文本代替。这些记录描述第三方组件，未为本项目新增整体开源许可。

阶段 3.2 在线底图使用 OpenStreetMap 标准瓦片，仅加载当前地图视口。窗口显示可点击的 © OpenStreetMap 署名；本机缓存遵守响应有效期，无期限时保留至少七天，过期请求支持条件验证，不预下载离线瓦片包。[版权说明](https://www.openstreetmap.org/copyright)、[瓦片使用政策](https://operations.osmfoundation.org/policies/tiles/)。高程缓存独立于底图，离线高程不等于离线底图。

## 随包 Copernicus GLO-30 裁剪样例

数据：`data/copernicus-longquanshan.tif`，桌面包中为 `resources/app/fixtures/copernicus-longquanshan.tif`；其原始来源记录 `.source.json` 同时保留。源数据是 AWS 公共镜像中的 Copernicus GLO-30 Public／2021 release；本项目仅提取龙泉山附近窗口并重编码为本地 GeoTIFF，保留高程值，不作为全球完整数据或裸地 DTM 发布。[AWS 数据登记](https://registry.opendata.aws/copernicus-dem/)、[镜像数据处理说明](https://copernicus-dem-30m.s3.amazonaws.com/readme.html)。

GLO-30 的免费公开许可允许复制、分发、修改和与其他数据组合，分发／公开传播时须履行来源说明等条款。本项目依正式许可 Article 6，为裁剪样例附带衍生数据署名及指定责任说明；全文位于 `desktop/licenses/Copernicus-GLO30-SAMPLE.md`，完整官方许可证位于 `desktop/licenses/Copernicus-GLO30-LICENSE.pdf`。这两份文件必须与样例一起打包。[官方许可与署名说明](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM)、[正式 GLO-30 许可 PDF](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf)。

样例 GPX 仍受上文 TrailPrint-3D 的 MIT 许可覆盖，名称与路线为上游示例，不表示软件用户本人走过该路线。公开分享由该示例高程生成的模型时，应在发布说明中继续提供上述来源和许可说明；默认“保存 STL”仍只写一个打印文件。
