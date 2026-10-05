# 04 · Bug、风险与代码优化清单

[返回目录](README.md)

最近 28 个 Brraida 提交的独立审查见 [08 · 提交审查（2026-10-04）](08-code-review-2026-10-04.md)；以下保留较早基线的问题编号和修复历史。

## 1. 范围与结论等级

审阅基线 `6bb1e21`；历史整理后的等价基线为 `5c2d332`。第一阶段修复已落在本地 `dev`，代码及测试说明提交为 `5806cdf`。审阅不是覆盖所有输入的完整审计，也没有测试每个插件。

**原审阅：10 项隔离复现、3 项静态确认、3 项边界风险、3 项安全/支持风险。** 隔离复现执行真实源码，但音频、子进程与数据库采用模拟；不把模拟结果写成实机播放故障率。当前回归测试已按正确行为验收。下面的历史复现脚本通过 `git show` 加载原基线源码，不在当前修复版本上断言 Bug 仍然存在。

```powershell
node docs/knowledge-base/evidence/audit-repro.cjs
```

[脚本](evidence/audit-repro.cjs) · [结果与环境](evidence/audit-results.json)。脚本不操作应用 profile、不启动网络监听器、不修改音乐文件。

## 第一阶段修复状态（2026-10-03）

**BUG-01～13 已修复并验证，保留原有架构。** 本轮还复现并修复了短损坏文件导致元数据库遗留文件句柄的问题，记为 BUG-14。“已验证”包含可控时序与指定 Windows 运行测试，不代表所有音源、音乐格式和设备均已验收。

| 编号 | 修复提交 | 验证证据 |
| --- | --- | --- |
| BUG-01/02 | 7490d9d、5ad9caa | 播放/歌词请求序号，成功/失败、A → B → A、音质竞态和撤回、reset、过时的延迟跳歌 |
| BUG-03/04 | d4b110f | 重启/停止/backoff；真实 Windows 子进程和 HTTP，loopback、会话令牌、非法输入、Range/认证、断流与存活 |
| BUG-05/06/12、RISK-01 | 380e08a | 注册后扫描并缓冲；1/100/10000 条隔离测试，真实 Chokidar + 100 文件增删改，大写后缀、无 stats、文件夹导入 |
| BUG-07/08 | 9ddf16e | HLS/fetch/URL 生命周期；真实 HTMLAudio 认证 Blob WAV、播放/暂停/seek、URL 撤销、HLS 片段取消后播放普通 WAV |
| BUG-09 | 1170510 | Store 提交后通知；故障订阅不阻止状态更新和其他订阅 |
| BUG-10、CODE-09 部分 | bdc5e2b | 真实 IndexedDB：20 个并发重复添加、增删竞态、引用计数、收藏索引、清空/删除、失败回滚 |
| BUG-11 | b4754cd | 六阶段错误信息、真实 React 首屏加载/失败/成功；日志错误不抑制诊断；整页重载重试 |
| BUG-13 | 1429598 | 真实 HTTP：HLS MIME、伪装后缀、分块清单拒绝；真实媒体不因 m3u8 后缀误拒绝；原完整下载回归通过 |
| BUG-14（新增） | 380e08a | music-metadata 8 对不足 128 字节文件的标签探测可能在关闭 tokenizer 前抛错；小文件改用 Buffer 解析，真实 Windows 损坏文件可删除，正常文件沿用原路径 |

运行方法：[scripts/tests/README](../../scripts/tests/README.md)。汇总证据：[bugfix-results.json](evidence/bugfix-results.json)。Windows TypeScript 检查通过；Linux/macOS 本轮未运行验收，完整 HLS 离线下载仍未实现。

以下问题表保留原基线的触发条件与修复建议，作为历史对照。RISK-02 已在本轮工作区实现并验证，详见第 10 章；RISK-03、SEC-01/02/03 和未覆盖的维护/性能优化仍保留为后续任务。第 08 章的 R1～R5 是另一审查范围，不能据此视为全部已解决。

## 2. 已隔离复现的问题

| 编号 | 优先级 | 问题与触发条件 | 源码位置 | 建议修复/验收 |
| --- | --- | --- | --- | --- |
| BUG-01 | P1 | A 获取音源未完成时播放 B；A 随后失败，catch 无条件 reset 音频控制器，影响 B | [track-player:366](../../src/renderer/core/track-player/index.ts#L366) | 请求序号覆盖成功与失败；A 晚失败不能重置 B |
| BUG-02 | P1 | A 歌词请求晚失败，catch 无条件设空歌词，清掉已加载的 B 歌词 | [track-player:660](../../src/renderer/core/track-player/index.ts#L660) | 歌词请求序号；错误仅作用于所属请求 |
| BUG-03 | P1 | 转发子进程退出后定时调用 start，但 started 保持 true，start 提前返回 | [service-manager:29](../../src/shared/service-manager/main.ts#L29) | 明确 starting/running/backoff/stopped；清句柄、去重定时器、恢复 host |
| BUG-04 | P0 | 转发服务没有显式 loopback bind；无效目标 URL 在回调内抛出未捕获异常 | [request-forwarder:10](../../res/.service/request-forwarder.js#L10)、[listen:95](../../res/.service/request-forwarder.js#L95) | 仅监听 loopback；URL/协议/目标权限校验；非法请求返回 400，服务存活 |
| BUG-05 | P1 | watcher 已开始扫描，回调尚未注册；防抖 flush 清队列后 `_onAdd?.` 没有接收者，丢掉批次 | [local-music:45](../../src/renderer/core/local-music/index.ts#L45)、[watcher:52](../../src/webworkers/local-file-watcher.ts#L52) | 先注册接收者或握手缓冲；初始 1/100/10000 文件都不漏 |
| BUG-06 | P2 | `song.MP3` 等大写后缀无法通过 `endsWith` | [watcher:27](../../src/webworkers/local-file-watcher.ts#L27)、[file-util:111](../../src/common/file-util.ts#L111) | 扩展名规范化；拖入和扫描使用同一规则 |
| BUG-07 | P1 | HLS → 普通 MP3 时旧 Hls 仍 attach；销毁只出现在 destroy 路径 | [audio-controller:97](../../src/renderer/core/track-player/controller/audio-controller.ts#L97)、[切源:248](../../src/renderer/core/track-player/controller/audio-controller.ts#L248) | 切源/重置清 HLS；实际分片网络、旧错误与新轨道互不干扰 |
| BUG-08 | P1 | 转发不可用且 URL 含认证时，Blob fallback 用原 headers，丢生成的 Authorization；异步设 src 后没有恢复此前 play 意图，也未释放 Object URL | [audio-controller:215](../../src/renderer/core/track-player/controller/audio-controller.ts#L215)、[fallback:257](../../src/renderer/core/track-player/controller/audio-controller.ts#L257) | 使用最终 headers；检查响应、取消/异常、保持播放意图并释放 URL |
| BUG-09 | P1 | Store 的 onValueChange 订阅者抛错，在 value 更新前中断 setValue | [store:54](../../src/common/store.ts#L54) | 明确提交与通知阶段；隔离订阅异常，其他订阅和数据更新仍成功 |
| BUG-10 | P1 | 向原来不含 A 的歌单传 `[A,A]`，过滤只比对旧歌单，产生两个相同引用 | [backend:276](../../src/renderer/core/music-sheet/backend/index.ts#L276) | 按歌曲键去重，在事务内以最新状态判重；验证引用计数和删除 |

### BUG-01 / BUG-02：修复应涵盖 A → B → A

当前成功分支已比较歌曲是否仍为当前歌曲，但失败分支没有同等保护。即便补上歌曲键判断，相同歌曲的两次请求仍可能乱序。建议分别给播放与歌词请求分配递增序号/取消控制器，只有匹配当前序号才能提交任何状态。

实验已验证旧 A 失败会调用 reset、旧 A 歌词失败会把新歌词 parser 清掉。真实网络慢响应、音质切换和 Windows 输出表现仍需端到端验收。

### BUG-04：监听范围与实际暴露要分开判断

实验验证 `server.listen` 只传端口与回调；按 Node API 语义，省略 host 不限制为 127.0.0.1。当前服务也没有会话认证，允许跨源响应和可配置目标。是否能从局域网访问，还取决于 Windows 防火墙、地址和网络环境，本轮没有探测真实可达性。[Node listen 说明](https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback)

loopback 限制也不能单独完成授权，应使用会话令牌或仅接受已登记的短期音源票据；对必要的本地/NAS 音源使用明确授权，避免粗暴封禁全部内网地址而破坏合法使用。

### BUG-07 / BUG-08：音源生命周期要完整

隔离实验确认 HLS 实例未销毁和 Blob 分支的三个行为缺口；未测量真实 HLS 是否在某个版本必然覆盖新 src、长期内存具体增加多少。建议用本地 HLS 服务、连续切歌、转发服务故障和内存快照验证实际后果。

Blob 分支只在对应 fallback 条件成立时触发；转发服务正常时不能推定每首带 headers 的歌都有此问题。

## 3. 静态确认的问题

| 编号 | 优先级 | 证据与问题 | 改进和验收 |
| --- | --- | --- | --- |
| BUG-11 | P1 | [React 入口:25](../../src/renderer/document/index.tsx#L25)仅 `bootstrap().then(...)`；ErrorBoundary 在成功后才挂载，初始化拒绝无法进入该 UI 边界 | 首屏先挂载；各初始化阶段显示失败/重试；注入数据库或路径错误仍可诊断 |
| BUG-12 | P2 | [watcher](../../src/webworkers/local-file-watcher.ts)只监听 add/unlink，没有 change，标签或封面修改不会触发更新 | change 合并成受限批次；删除/修改/重命名相互不冲突 |
| BUG-13 | P1 | [下载 Worker](../../src/webworkers/downloader.ts)按普通 HTTP 响应保存，不解析 m3u8 分片；非空清单也可能返回 DONE | 识别 HLS 清单，未支持时明确拒绝歌曲下载；实现后必须能断网离线播放 |

BUG-13 是“完整歌曲下载”的语义缺口；某些 URL 仍可能返回真正媒体，应以响应内容和源能力判断，不仅看扩展名。没有做完整 Windows HLS 下载实测。

## 4. 需要实测的边界风险

| 编号 | 优先级 | 风险、证据与适用边界 | 应补验证 |
| --- | --- | --- | --- |
| RISK-01 | P2 · 已处理 | 原 watcher 未处理 stats 缺失 | 已设置 alwaysStat，缺失时安全 stat，Windows 回归通过；网络盘兼容性仍待额外实测 |
| RISK-02 | P2 · 本轮已验证 | 历史基线：外部删除/移动后当前会话图标可能仍为完成 | 已实现监听、补偿核对、身份匹配恢复和播放回退；见 [10 当前实现](10-download-file-state.md)与 [回归结果](evidence/download-file-sync-results.json)；未覆盖设备边界保留 |
| RISK-03 | P1 | [备份恢复](../../src/renderer/core/backup-resume/index.ts)依赖多次业务调用，而部分 backend 错误会被吞掉；覆盖模式可能在未完整导入时删除旧歌单 | 用独立库注入导入失败；先校验备份 schema、试运行和可回滚，再提交覆盖 |

## 5. 安全与运行时支持风险

此处只报告可见边界和支持状态；没有完成漏洞利用测试或依赖 CVE 扫描。

| 编号 | 优先级 | 当前证据 | 建议 |
| --- | --- | --- | --- |
| SEC-01 | P0 | [主窗口配置:101](../../src/main/window-manager/index.ts#L101)开启 Node/Worker Node、关闭 webSecurity/sandbox，主题 [preload](../../src/shared/themepack/preload.ts)创建无显式 sandbox 的 iframe | 先迁移文件/网络能力到受控桥接，再开启安全默认；限制导航、新窗口、主题权限和 IPC sender/schema |
| SEC-02 | P0 | [插件执行:113](../../src/shared/plugin-manager/main/plugin.ts#L113)使用 Function，代码在主进程执行；require 白名单不隔离 globalThis 等全局能力 | 明确插件信任模型、安装来源和权限；移到可终止宿主，限制桥接。普通子进程也不是 OS 沙箱 |
| SEC-03 | P0 | [依赖](../../package.json)仍在 Electron 25 系列；官方时间表显示该系列已于 2023-12-05 结束支持 | 升级到发布时仍受支持的稳定系列；重建原生模块并回归插件、HLS、设备、主题和窗口 |

**准确性说明：** window 配置没有显式设置 `contextIsolation: false`，不能把它描述成已关闭。风险来自上述明确配置和代码执行/桥接范围。安全模式调整需要迁移依赖，直接删配置可能使 Worker、插件和文件功能失效。

官方依据：[Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)、[版本时间表](https://releases.electronjs.org/schedule)。

## 6. 可维护性与性能优化清单

| 编号 | 优先级 | 观察 | 建议与验收 |
| --- | --- | --- | --- |
| CODE-01 | P1 | [AppConfig:217](../../src/shared/app-config/main.ts#L217)同步整文件写入，没有临时文件替换；写失败时内存状态已改 | 串行异步保存、原子替换、错误结果回传；模拟写失败/退出不生成坏 JSON |
| CODE-02 | P2 | [本地库](../../src/renderer/core/local-music/index.ts)每批重读 toArray；封面 [base64](../../src/common/file-util.ts#L77)随歌曲对象复制 | 增量索引、分页/过滤、缩略图缓存、受限扫描并发；衡量 1万/5万首的耗时与内存 |
| CODE-03 | P2 | [进度:743](../../src/renderer/core/track-player/index.ts#L743)每次写 localStorage；多窗口进度另以 800ms 节流 | 分离音频时钟、视觉插值和持久化；暂停/退出时补存；实际响应收益待测 |
| CODE-04 | P2 | [Store](../../src/common/store.ts)使用 useState/useEffect 订阅，没有 useSyncExternalStore 快照协议 | 增量迁移并增加 selector；验证订阅间隙更新和 React 并发下的一致性 |
| CODE-05 | P2 | 活跃 frontend 名为 index.old，旁边又有多份 SQLite/下载备用实现 | 标明 active/legacy/experimental；查依赖后归档，统一 Repository 接口 |
| CODE-06 | P1 | [提交配置](../../package.json)的 lint-staged 运行全 src `--fix` 和 `git add .` | 限定暂存文件，lint 检查和格式化分开；提交不改/带入无关文件 |
| CODE-07 | P2 | [CI](../../.github/workflows/build.yml)用 npm install、旧 Node，缺显式下载回归 gate | 锁定可复现安装与版本矩阵；Windows smoke、核心回归和构建产物检查 |
| CODE-08 | P2 | [虚拟列表](../../src/hooks/useVirtualList.ts)闭包初始化一次、没有 ResizeObserver，固定渲染数和高度 | 用稳定参数引用、布局变化通知和 overscan；DPI/工具栏/容器变化验证 |
| CODE-09 | P1 · 部分处理 | 添加/删除/清空已改为事务内读取与更新、提交后同步缓存，错误向调用方传播；其他后台方法和 frontend 仍有吞错路径 | 增删与回滚已验证；其余错误契约和备份恢复仍属后续任务 |

这些条目中，同步写入、全量读和备用代码属于可确认实现事实；卡顿幅度、崩溃概率及迁移收益尚未测量。

## 7. 本轮不再作为未修复问题的内容

- 批量下载、复选框选择、选中歌曲添加歌单：已实现。
- 缺少全局暂停/继续：已补齐。
- 文件成功但下载记录函数返回值不正确、并发索引遗漏、成功记录仍保留失败状态：已在基线中修复。
- 部分文件/HTTP 错误、同名覆盖、暂停和记录补存：已有 [下载回归](../../scripts/tests/README.md)。

本轮清单以当前基线为准，不重复把已修问题算入未完成数量。建议的修复顺序见 [06](06-roadmap.md)。
