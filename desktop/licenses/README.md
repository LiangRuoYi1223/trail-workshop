# 徒步地形工坊：第三方许可与示例数据

本目录随阶段 3.1 Windows 桌面包一起提供。软件目录根部的 `LICENSE`、`LICENSES.chromium.html` 为 Electron／Chromium 原始分发文件，也需一同保留。

| 文件 | 组件／版本 |
| --- | --- |
| `React-19.2.0-LICENSE.txt` | React 19.2.0，MIT |
| `ReactDOM-19.2.0-LICENSE.txt` | React DOM 19.2.0，MIT |
| `Scheduler-0.27.0-LICENSE.txt` | React Scheduler 0.27.0，MIT |
| `Three-0.180.0-LICENSE.txt` | Three.js 0.180.0，MIT |
| `LucideReact-0.468.0-LICENSE.txt` | Lucide React 0.468.0，ISC；文本含 Feather 部分的版权说明 |
| `Electron-44.7.0-LICENSE.txt` | Electron 44.7.0，MIT |
| `Copernicus-GLO30-SAMPLE.md` | 随包真实高程裁剪样例的来源、署名及使用说明 |
| `Copernicus-GLO30-LICENSE.pdf` | 从官方站点下载的完整 GLO-30 免费公开许可证 |

上述软件许可文本来自本项目锁定版本的 npm 依赖原文件，未修改其版权／授权内容。生产依赖的完整许可继续保留在 `resources/app/node_modules/` 各包中。

已提取／修改的 TrailPrint-3D 生成核心和示例 GPX，其 MIT 许可在 `resources/app/core/vendor/trailprint/LICENSE`。组件用途、固定版本和来源总表在 `resources/app/THIRD_PARTY_NOTICES.md`。

Copernicus 许可证核查／下载日期：2026-10-10。PDF 来源：

https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf

PDF SHA-256：`9cd37d37ea654bbcaf0a2e059e6a3a5b5f76072824d8dd860ccf274ada8951bd`。

构建时将 `desktop/licenses/` 整目录复制为 `resources/app/licenses/`。示例 GeoTIFF 及 `.source.json` 保持已有内容与 SHA，配套署名从本目录提供。
