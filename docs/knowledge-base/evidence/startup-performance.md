# 启动性能验证（2026-10-04）

[回到启动流程](../02-flows-and-development.md) · [机器可读结果与源码校验](startup-performance-results.json) · [复现脚本](packaged-startup-benchmark.cjs)

## 原因与处理

原实现让首屏等待所有下载文件的检查，旧记录缺少指纹时需要读取整首文件计算 SHA-256。用户约有 1000 首下载歌曲，真实日志中一次初始化耗时 17358ms，后两次为 445ms、491ms。旧日志只有总时长，不能据此精确分配各阶段耗时；以下隔离测试验证了下载核对对首屏的影响。

现实现先读取记录，再在后台每批检查 8 首、批内最多并发 4 个文件检查。用户播放、下载与元数据写操作可在批次之间优先执行。未知文件保持 CHECKING；确认有效才标为已下载。唱片组件在初始化结束后挂载，加载阶段没有动画运行，本轮保留效果。

## 同一工作负载对比

Windows Electron 25.3.0，两个真实编译目录的 main、preload、renderer；各使用独立空 profile。1000 条旧下载记录，每个测试文件逻辑大小 1MiB，使用 NTFS 硬链接节省空间；每个路径仍会分别打开、读取与计算指纹。

| 工作负载 | 优化前初始化 | 优化后初始化 | 优化前首屏 | 优化后首屏 |
| --- | --- | --- | --- | --- |
| 空歌库首次加载 | 133ms | 131ms | 205ms | 229ms |
| 1000 条旧记录，无指纹 | 2237ms | 39ms | 2260ms | 58ms |
| 1000 条记录，已补建指纹 | 326ms | 41ms | 349ms | 55ms |

初始化统计从 `Create Bundle` 到 `Bundle Bootstrap Ready`；首屏到 `Bundle First Screen`。**不包括启动 exe、加载 Electron 和解析前端静态模块的时间**，不能解读为“打开程序只需 39ms”。每个场景一个样本，文件系统有缓存、歌库场景通过同进程重载测试；不是冷启动或 P95 基准。

优化后的主界面就绪时，指纹完成数为 0；随后全部 1000 条指纹均写入 IndexedDB。旧版必须先完成 1000 条才显示界面。旧记录迁移的总完成时间约从 2.50 秒增加到 8.63 秒（含重载），后台核对日志为 8.30 秒。这是分批事务、状态发布和让出执行时间的代价；本轮优先改善首屏和操作响应，不宣称文件核对吞吐量也提高。

## 正确性验证

- 8 组 Node 回归、7 组真实 Windows Electron 回归通过；TypeScript 与全库格式检测通过。
- 新编译版的真实本地 WAV 播放、详情唱片、迷你窗口 MessagePort 同步与暂停通过。离线知识库 13 张图在桌面、窄屏及打印模式渲染通过。
- 阻塞首批文件读取，下载索引仍立即就绪，未检查记录保持 CHECKING。
- 在后台检查未结束时点播第 24 首：优先核对目标，在全库完成前返回。
- 同时请求下载尚未检查的第 23 首：先检查原文件，返回 `added: 0, skipped: 1`，没有再次传输。
- 最后全部记录核对完成；原有外部删歌/恢复、路径变更、身份校验、配置竞态、事务回滚及本地播放失败回退测试继续通过。

## 复现与用户验收

```powershell
# 在 Windows 终端、仓库根目录执行；脚本启动 Electron，使用 out 下隔离 profile。
# 等待进程结束后查看控制台输出的 RESULT_FILE。
node_modules\.bin\electron.cmd docs/knowledge-base/evidence/packaged-startup-benchmark.cjs vinyl-player-20261004
node_modules\.bin\electron.cmd docs/knowledge-base/evidence/packaged-startup-benchmark.cjs startup-fast-20261004
```

新运行目录：`out/startup-fast-20261004/MusicFree-win32-x64/MusicFree.exe`。先退出已有实例，再从新目录启动；首次核对期间图标显示“正在核对本地文件”，已下载列表逐批补齐。验证首次打开、再次打开、立即播放已下载歌曲、点击下载已存在歌曲，以及目录删除和恢复。

每阶段日志新增 `Startup stage` 的 `stage` / `durationMs`，后台核对新增 `Startup download verification` 的 `records` / `durationMs`，不记录歌曲名称或路径。若真实机型仍慢，可区分主进程启动、模块加载、插件、数据库和后台文件核对，继续针对实际慢点优化。Linux/macOS、真实冷磁盘与长期运行未在本次 Windows 性能测试范围内。
