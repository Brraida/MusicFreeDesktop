# 第一阶段 Bug 修复与验证记录

修复分支：本地 `dev`。起点：`5c2d332`；当前提交：`5806cdf`。共 9 个修复提交和 1 个测试说明提交，没有推送远端。现有 `package.json` 版本修改与知识库文档继续保留在工作区。

## 完成范围

BUG-01～13 已按 [问题状态表](../04-code-audit.md)修复，另补修真实 Windows 扫描中发现的短损坏文件句柄问题 BUG-14。保留 TypeScript、React、Electron、进程布局和数据库，没有进行架构迁移。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| Windows Node 六项回归 | player、service、scanner、audio、store、startup 全部通过 |
| Windows Electron 歌单 | 真实 IndexedDB 并发添加/删除、去重、引用计数、清空/删除和失败回滚通过 |
| Windows Electron 音频 | 真实认证静音 WAV 解码、播放/暂停/seek、Blob 撤销、取消 HLS 片段后普通 WAV 播放通过 |
| Windows Electron 启动 | 真实 React 加载、失败与重启入口、成功前不挂载播放器通过 |
| 完整下载回归 | 原下载状态/记录/暂停/重试回归全部通过；HLS 清单识别拒绝与后缀误判回归通过 |
| Windows TypeScript | `tsc --noEmit` 通过 |
| Windows x64 构建 | Electron Forge 编译成功，输出到新的测试目录 |
| 新 exe 运行时/原生库 | Electron 25.3.0、x64、各入口、SQLite 加载及 Sharp 实际图片处理通过 |
| 知识库网页 | 离线 8/8 Mermaid 图渲染通过，窄屏/打印/错误回退通过，远程请求为 0 |

汇总数据：[bugfix-results.json](bugfix-results.json)。构建与 ZIP 检查：[build-result.json](../../../out/.bugfix-20261003/build-result.json)。

历史 [audit-repro.cjs](audit-repro.cjs)改为通过 `git show` 加载旧基线 `6bb1e21`；验证了旧基线的 10 项错误仍可隔离复现。其结果是历史对照，当前修复验收使用 scripts/tests，不混用两种断言。

## Windows 手动测试版本

版本 `0.0.80`，沿用已有但未提交的版本号修改；提交内版本仍为 `0.0.8`。

- [直接运行 MusicFree.exe](../../../out/bugfix-test-20261003/MusicFree-win32-x64/MusicFree.exe)
- [完整 ZIP 包](../../../out/MusicFree-0.0.80-bugfix-5806cdf-win32-x64-test.zip)
- [构建日志](../../../out/bugfix-build-20261003.log)

先从托盘完整退出旧版播放器，再运行新版本。使用 ZIP 时完整解压并保留所有文件。本轮自动验证没有操作真实音乐库或正常播放器 profile。

建议手测：连续切歌与音质切换、歌词加载、批量加入歌单、监视目录导入与修改、批量下载暂停/继续，以及带认证音源播放。

## 保留的边界

- 本轮没有执行 Linux/macOS 构建或运行验收。
- 未测试所有在线插件、音乐格式、音频设备和 Windows 系统组合；静音 WAV 回归不等于完整音质或设备验收。
- HLS 播放的资源清理已有验证，完整分片离线下载仍未实现，下载清单会明确报不支持。
- Electron 升级、插件隔离、其余数据恢复风险和性能优化仍是后续工作，见原清单的 RISK、SEC、CODE 条目。
