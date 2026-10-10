# Copernicus GLO-30 龙泉山裁剪样例

软件附带 `fixtures/copernicus-longquanshan.tif`，用于“示例路线”建模体验与生成核心验证。此文件来自 Copernicus GLO-30 Public／2021 release 的公开镜像；它是包含植被、建筑等地表对象的数字表面模型（DSM），不等同于裸地 DTM。

## 来源与处理

- 数据登记：[Registry of Open Data on AWS — Copernicus DEM](https://registry.opendata.aws/copernicus-dem/)。
- 原始瓦片：[Copernicus_DSM_COG_10_N30_00_E104_00_DEM.tif](https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N30_00_E104_00_DEM/Copernicus_DSM_COG_10_N30_00_E104_00_DEM.tif)。
- 获取时间：2026-10-08T10:22:02.831Z，来自原始 `.source.json`。
- 本项目处理：裁剪原始瓦片像素窗口 `[915, 1456, 1174, 1677]`，另存为 259 × 221 像素本地 GeoTIFF；保留高程数值，不进行补测或修订。
- 样例水平坐标：EPSG:4326；高程单位：米；覆盖约东经 104.25417–104.32583、北纬 30.53444–30.59556。
- 样例 GeoTIFF SHA-256：`a555cd197cadb05d3ae5cfba91fe516b84170cb7e516d844e0316a0727e52489`。
- 详细原始记录：与 GeoTIFF 同目录的 `copernicus-longquanshan.source.json`，保持原内容。

按 AWS 来源推荐格式记录访问来源：Copernicus Digital Elevation Model (DEM) was accessed on 2026-10-08 from https://registry.opendata.aws/copernicus-dem.

## 许可与必须保留的说明

本样例依 Copernicus WorldDEM-30 免费公开许可分发。完整官方许可随包保存在 `licenses/Copernicus-GLO30-LICENSE.pdf`；正式来源为[官方许可 PDF](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf)。

裁剪／改编数据的署名依 Article 6(b) 保留如下：

produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.

按 Article 6(c) 的分发责任说明：

The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30.

中文说明：依法或受委托负责 Copernicus 计划的机构，不对 Copernicus WorldDEM-30 的任何使用承担责任。

本软件及其生成模型为独立项目，不表示得到数据提供方、许可方、欧盟、ESA 或 Copernicus 计划的官方认可。后续接收者使用／再分发该样例或其改编内容时，应继续遵守上述来源、责任说明和完整许可的相关义务。

公开分享基于该高程的派生三维模型时，可将这里的署名、责任说明、许可链接放入发布说明；STL 自身不包含完整文本或颜色，软件仍只保存一个 STL 打印文件。随包 GPX 是 TrailPrint-3D 上游 MIT 示例，使用其数据许可，不表示实际用户个人行程。
