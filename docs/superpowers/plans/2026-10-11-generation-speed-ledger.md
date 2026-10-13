# 执行记录

用户已在讨论后明确要求“按照你的顺序提速”，因此计划与实现一并执行，无须再次确认。

Ruling: 当前真实项目无 Git，直接在用户工作区实现并保留旧版发行文件；不初始化仓库。

Ruling: 三组实现并行且限定不重叠的文件所有权，Shared Interfaces 先固定，以遵循当前并行委派要求并减少等待。没有并行的同文件改动。

| 检查 | 输入／输出关系 | 结论 |
|---|---|---|
| Task 1 → Task 2 | 核心新增进度字段均可选，旧事件兼容 | 一致 |
| Task 2 → Task 3 | phase/acquisition 的枚举和字段在 Shared Interfaces 固定 | 一致 |
| Task 1 → Task 4 | 缓存在 surface-cache 内，统计清理和验证须覆盖块文件 | 一致 |
| Task 2 内部 | 并行下载与阶段时限需取消共享 peer，测试覆盖 | 一致 |
| Task 3 内部 | 不再用自动影像模式推断任何总超时属于影像 | 一致 |

实施完成：Task 1、2 由独立整体审查分别判定 spec/quality 通过；Task 3 独立静态审查通过。未发现 must-fix。

Ruling: 旧 manager footprint fixture 的 provider 禁止预取与新并行读取契约冲突，改为返回本地真实 DEM，继续保留错 bounds 拒绝断言。

Ruling: 显式 jobTimeoutMs 继续兼容旧测试整体时限；生产未注入时使用分阶段有限时限。同阶段进度不会重置截止时间。

Ruling: 初次真实 UI probe 新增自动高程场景但忘记配置 demCacheDir，修正验证环境配置；没有放宽生产验证。模拟超时使用真实 DesktopError，不修改公开错误白名单。

实际验证：核心 276 项，275 passed/0 failed/1 Windows 文件链接权限 skip；桌面 141 passed/0 failed/0 skipped。目录链接检查通过。桌面 build、真实 Electron 自动影像与有限配色、GPX/KML 探针通过。

真实网络：两次首次尝试遭到公共服务 UND_ERR_CONNECT_TIMEOUT；随后重试复用已完成块获取成功（57.1 秒、8 请求）。独立全新缓存再测成功：103.1 秒、15 请求、12,544,721 B；原记录 105.0 秒、53 请求、11,834,251 B。请求减少 71.7%，首次时间只改善 1.7%，不能宣称大幅首取提速。

同区域实际来源和 RGB SHA 与原版本完全相同。精确离线获取 37 ms、零请求；相邻平移 3.8 秒、只有一次目录请求、零 TIFF 下载、复用 10,561,722 B。

v0.4.2 原生发行软件真实本地与自动影像检查通过，三色 3MF、两色 OBJ、STL、取消和离线相同模型通过。旧 v0.4.1 发行文件保留。
