# 正确性回归测试

测试在仓库根目录运行，使用现有 npm 依赖。Node 测试加载实际 TypeScript 源码；音频与部分系统边界使用可控替身。Electron 测试使用真实 Chromium、IndexedDB、React、HTTP 和音频元素；各平台运行入口由 CI 提供。

## Node 回归

```powershell
node scripts/tests/player-regression.cjs
node scripts/tests/service-regression.cjs
node scripts/tests/scanner-regression.cjs
node scripts/tests/audio-regression.cjs
node scripts/tests/store-regression.cjs
node scripts/tests/startup-regression.cjs
node scripts/tests/ci-regression.cjs
node scripts/tests/download-resource-regression.cjs
node scripts/tests/duration-regression.cjs
node scripts/tests/lyric-regression.cjs
node scripts/tests/package-slimming-regression.cjs
node scripts/tests/config-regression.cjs
node scripts/tests/system-regression.cjs
node scripts/tests/device-regression.cjs
```

| 测试 | 覆盖与边界 |
| --- | --- |
| player | 音源和歌词的成功/失败竞态、A → B → A、音质切换与撤回、过时的延迟跳歌、reset；本地优先、单次网络回退、seek、恢复期间暂停、切歌后丢弃旧回退；音频与插件用替身 |
| service | 重启/停止/backoff；真实转发子进程和 HTTP 请求，loopback、令牌、非法输入、Range/认证和断流 |
| scanner | 1/100/10000/50000 合成事件、64 并发和 200 首批次、旧事件/删除/取消目录/失败重试；真实 Windows Chokidar 与 100 个独立文件增删改及 unwatch/re-add，实际短文件解析与文件夹导入 |
| audio | HLS 与 Blob 生命周期、最终 headers、播放/暂停意图、seek、A → B → A、取消与 URL 释放；1000 次 HLS/Blob/直接音源循环后 HLS 全销毁、URL 全释放；Audio/HLS/fetch 用替身 |
| store | 提交后通知、订阅错误隔离、其他订阅继续执行、更新函数失败保留旧状态 |
| ci | 四平台产物路径、版本标签、完整便携 ZIP（包含空 portable 和隐藏资源）、SHA-256、重复产物保护、Release 草稿创建/更新与正式发布保护；独立临时文件和 GitHub CLI 替身 |
| duration | 本地时长恢复、已有时长归一化、播放事件持久化与未知时长占位；真实 WAV 的 UTF-8/UTF-16、有效 Latin-1、旧 GBK 单字节声明标签及无作者专辑回归 |
| lyric | 真实歌词解析与双句推导：乱序、重复文字、同时间戳、前奏/间奏/末句、纯文本与零时间单句、过时快照、翻译、正负 offset；16～80 字号与窗口高度换算 |
| startup | 配置/插件/歌单/播放状态/语言/下载记录的阶段错误信息；各初始化服务用替身 |
| download-resource | 真实文件读取与 SHA-256、同名同大小内容冒充、删除/恢复、父目录删除/重建、监听重挂后原生事件、无关目录边界、换目录代次和 stop 释放；权限/离线/I/O 分类用故障注入 |
| package-slimming | 打包 Sharp 去重仅删内容相同的 vendor DLL，保留运行副本、不同内容、缺失对应项、元信息和其他平台；benchmark 门槛接受无退步，拒绝“包更小但启动更慢” |
| config | 真实 Windows 配置原子替换、有效备份/损坏主文件恢复、旧配置迁移；ENOSPC/EIO/EACCES 故障注入，失败不提交缓存/通知、不残留临时文件；非全机断电验证 |
| system | 任务栏封面 A/B 竞态、关闭窗口、损坏图片回退；网络/Sharp/任务栏边界用替身 |
| device | 等数量设备更换、默认输出 group、非选中设备/麦克风移除、策略、乱序枚举/权限失败；设备事件和枚举用替身 |

## Windows Electron 回归

在 Windows 的项目根目录运行：

```powershell
.\node_modules\.bin\electron.cmd scripts/tests/downloader-main.cjs
.\node_modules\.bin\electron.cmd scripts/tests/electron-regression-main.cjs audio
.\node_modules\.bin\electron.cmd scripts/tests/electron-regression-main.cjs playlist
.\node_modules\.bin\electron.cmd scripts/tests/electron-regression-main.cjs startup
.\node_modules\.bin\electron.cmd scripts/tests/electron-regression-main.cjs relocation
.\node_modules\.bin\electron.cmd scripts/tests/electron-regression-main.cjs download-resource
.\node_modules\.bin\electron.cmd scripts/tests/electron-regression-main.cjs vinyl
.\node_modules\.bin\electron.cmd scripts/tests/electron-regression-main.cjs lyric
.\node_modules\.bin\electron.cmd scripts/tests/electron-regression-main.cjs quality
```

测试数据保存在 `out/.download-regression-data-*`、`out/.correctness-regression-*` 独立目录，不使用正常应用的音乐库或设置。scanner 测试会清理其独立目录，其余结果/profile 保留在 out 便于诊断。

- 下载：并发保存、下载列表恢复、提交失败、网络/断流、同名文件、暂停/继续、记录补存、通知异常和真实 React 状态同步。HLS MIME、伪装后缀/分块清单拒绝；真正音频即使 URL 后缀是 m3u8 也可成功。外部恢复旧文件不结束活动下载，真实新下载完成后提交新路径并保留引用计数。
- 下载目录：真实文件移动、修改配置后已挂载收藏图标和已下载列表刷新、启动时恢复、旧路径仍有效时保留、缺失文件清除标志、重复文件名拒绝关联、事务失败回滚、音质/歌单字段/引用计数保留。依据既有身份，在新目录中查找唯一同名候选，再验证 SHA-256；不导入未知文件，不递归查找或推断改名。没有指纹且已丢失原文件的旧记录不能仅凭名称安全恢复。
- 下载资源：启动索引准备不读取文件，后台分批核对时目标歌曲优先；未核对的已有歌曲不重复下载。真实 Windows Chokidar、IndexedDB、收藏图标和手动刷新按钮；外部文件/目录删除恢复、内容变化与冒充、配置变化时丢弃旧结果、事务失败回滚、重下载并发；注入权限/离线/I/O 故障以验证关联和收藏保留。下载 ID 列表未变化时跳过写入、失败后重试、外部删除/重下载正确更新索引；使用真实 HTMLAudio：在检查后删除有效本地 WAV，确认网络 WAV 回退后实际解码播放，且不重复恢复。
- 音频：实际 HTMLAudio 解码并播放认证 Blob WAV（静音），恢复播放与 seek、暂停、释放 URL；取消真实 HLS 片段请求后播放普通 WAV。验证 HLS 请求清理，未把未完成的 HLS 分片解码视为已测试能力。
- 歌单：真实 IndexedDB，20 个并发重复添加、添加/删除竞态、引用计数、收藏索引、清空/删歌单、写入失败回滚。
- 启动：真实 React 加载/失败/成功界面；日志服务失败时仍显示诊断；成功前不挂载播放器。重试按钮通过整页重载重新初始化，不删除配置或音乐库。
- 唱片：真实 React 组件、SCSS 和 Chromium 动画；旋转周期、暂停保持角度和继续、透明素材解码、唱臂实际 alpha 边界、针尖落在黑胶外圈与暂停离盘、固定反光、44px/56px 适配、主窗口 Store 与迷你订阅、隐藏停转、切歌、坏封面回退、键盘/双击/悬停、减少动态效果与卸载清理。独立 profile 输出播放/暂停/底部栏与迷你窗口截图；部分外围控件使用替身。

- 双行歌词：真实 React、SCSS、共享歌词函数、消息状态订阅与 ResizeObserver；重复文字切句、两窗一致、快退、前奏/间奏/末句/切歌清空、长句暂停/恢复/回退、16/54/80 排版、340×72 迷你窗、封面控件不遮挡歌词、减少动态效果与卸载清理。

- 健壮性：真实 IndexedDB 事务失败回滚、导入格式/版本校验、下载关联与引用保留、重复备份/身份、前端错误传播；真实 React 订阅竞态、搜索配置更新、虚拟行高度/取消、100 次订阅挂载/卸载、配置失败回退、输出 sink 回退和 localStorage quota 注入。输出设备采用替身，避免自动修改宿主硬件。

默认入口共 14 项 Node 和 9 项 Electron；失败结果逐项保留。

动画回归先通过 Chromium CDP 明确设置 `prefers-reduced-motion: no-preference` 验证旋转与滚动，再切换 `reduce` 验证动画停止；结果同时记录系统原设置。避免 CI 宿主默认减少动态效果时读取不存在的动画对象。已在 Windows 强制减少动态效果的条件下验证两个阶段。

这些测试不等于所有在线插件、真实音乐格式和设备的全量兼容性测试。CI 在 Windows、Linux（Xvfb）和 macOS 两种架构执行回归；这些隔离测试不等于全部设备和安装体验已验收。

## 编译版验收与启动测量

以下脚本使用完整编译目录，并以独立 profile 运行包内真实 main、preload 和 renderer。它们由与包内相同版本的已安装 Electron 承载；原生模块另用 `verify-build.cjs` 检查。

```powershell
.\node_modules\.bin\electron.cmd scripts/tests/packaged-ktv-check.cjs out/MusicFree-win32-x64
.\node_modules\.bin\electron.cmd scripts/tests/packaged-startup-theme-check.cjs out/MusicFree-win32-x64
.\node_modules\.bin\electron.cmd scripts/tests/packaged-startup-benchmark.cjs dev-ktv
```

前两个脚本接受完整编译目录参数。示例使用标准输出目录；其他输出位置直接传入对应目录。启动测量的参数是 `out` 下的目录名称，例如 `dev-ktv` 对应 `out/dev-ktv/MusicFree-win32-x64`。

- 双行歌词验收检查真实附属窗口、当前句/下一句、重复文字、暂停、seek、间奏、末句、切歌和字号高度。
- 启动与主题验收检查首帧、加载失败重试、旧歌曲时长恢复、下载缓存图标、多选、主题切换和迷你窗口同步。
- 启动测量比较空歌库、1000 条旧下载记录和完成指纹后的记录，输出前端初始化、首屏与迁移耗时。单次缓存磁盘及同进程重载结果不代表 EXE 冷启动 P95。

测试封面使用仓库内原创的 `fixtures/cover.svg`，不依赖辅助知识库或参考截图。结果、日志和截图仅写入忽略提交的 `out` 子目录。编译版验收是可选补充，未加入默认回归清单。

## Windows 完整进程 benchmark

使用 Windows Node，传入包含 MusicFree.exe 的完整目录；基线包和候选包应保留为不同目录。不要同时运行编译/回归与 benchmark。

```powershell
node scripts/tests/windows-benchmark.cjs out/dev-ktv/MusicFree-win32-x64 baseline 20
node scripts/tests/windows-benchmark.cjs out/dev-ktv/MusicFree-win32-x64 calibration 20 out/dev-ktv/MusicFree-win32-x64
node scripts/tests/windows-benchmark.cjs out/dev-ktv/MusicFree-win32-x64 candidate 20 out/windows-slimming-stage1/MusicFree-win32-x64
node scripts/tests/benchmark-gate.cjs <calibration-benchmark.json> <candidate-benchmark.json> <gate.json>
```

协议 v5（原 v2 增加进程身份校验）：每版每场景保留一次种子初始化和两次未计分预热，再运行 20 次；双目录模式交替 A/B 并交换先后顺序。共 80 次计分、12 次初始化/预热进程，预热原始结果也保留。门槛拒绝混用不同协议。脚本复制完整包，入口进入测试探针再加载未修改的包内 main/preload/renderer；拦截协议注册，使用独立 profile 和 1000 个独立静音 WAV、10000 条合成元数据。测外部启动至可操作、CIM 的 PID＋创建时间校验进程树工作集/私有字节/句柄/CPU，以及搜索/全选等真实 React 操作。CPU 在启动后固定观察窗口采样，可能仍有后台核对；不是长期稳定空闲值。

结果写入 `out/windows-validation/<label>-<time>/benchmark.json`，附方法、环境、原始样本和局限。磁盘缓存已热，不称为重启系统后的冷磁盘启动；没有真实封面/在线插件，不替代设备验收。工作集求和含共享页重复计数。

门槛独立比较各项中位数/P95和体积；自然波动来自同包 A/A，5000 次配对簇重采样及随机标签交换，固定种子、上侧 97.5% 分位。必须先冻结校准，再评估候选；修正 PID 复用统计后，可给门槛脚本追加第五个参数 `<原冻结gate.json>`，逐项采用新校准与原预算的较小值，禁止提高原门槛；不允许以体积收益抵消体验退步。门槛失败仍需保留报告并分析/复测，禁止挑选最好的样本。复制的 EXE 会出现在桌面，但不会使用正式数据。

原生任务栏补充验证及任意编译目录的运行校验：

```powershell
node scripts/ci/verify-build.cjs out/windows-slimming-stage1/MusicFree-win32-x64
.\node_modules\.bin\electron.cmd scripts/tests/packaged-taskbar-check.cjs out/windows-slimming-stage1/MusicFree-win32-x64
```

前者在 Windows 使用最小系统 PATH，避免开发机 DLL 路径掩盖缺失资源；后者使用真实 HWND、包内 Sharp 和任务栏 addon 检查裁剪/像素及原生调用，仍需要人工查看实际任务栏预览。

## 完整下载文件核对耗时

```powershell
node scripts/tests/windows-benchmark.cjs <原始完整包> verify-aa-cached 20 <原始完整包> --verification-only
node scripts/tests/windows-benchmark.cjs <原始完整包> verify-cached 20 <候选完整包> --verification-only
node scripts/tests/windows-benchmark.cjs <原始完整包> verify-aa-legacy 20 <原始完整包> --verification-only --legacy
node scripts/tests/windows-benchmark.cjs <原始完整包> verify-legacy 20 <候选完整包> --verification-only --legacy
node scripts/tests/benchmark-gate.cjs <对应A-A报告> <对应A-B报告> <gate.json>
```

额外检查后台批次让出事件循环后，完整核对 1000 文件没有变慢。使用实际复制的 EXE、main/preload/renderer，读取程序首次完整核对的完成日志 `durationMs`，含目录监听设置和全部批次。每场景有 20 对、两次固定预热；完整耗时单独校准，不放宽原来的 28 项门槛。缓存指纹为协议 v3；旧记录 SHA 迁移为 v4，每次计时后在真实 IDB 恢复无指纹输入，供下一独立进程使用；拒绝混用协议。只计首次完整核对，不计后续 watcher-ready 补偿轮次；缓存磁盘、1000 个独立 WAV、无封面和插件，仍需其他 EXE 指标及音频回归。

## 扫描吞吐与持续运行

```powershell
node scripts/tests/scanning-benchmark.cjs stage2-scan 20
.\node_modules\.bin\electron.cmd scripts/tests/packaged-soak-check.cjs <完整编译目录> 0.1 --quick
.\node_modules\.bin\electron.cmd scripts/tests/packaged-soak-check.cjs <完整编译目录> 120
```

扫描脚本从 Git HEAD 和当前源码冻结两份导入实现，真实解析 1000 个独立静音 WAV；20 对 A/A 冻结波动，再 20 对 A/B，独立检查耗时与 5ms 定时器最大延迟的中位数/P95。无封面、缓存磁盘、同一 Node 进程；不等于 EXE 首屏或 50000 首真文件吞吐。

持续运行使用匹配版本的 Electron 承载未修改的编译包，独立设置/IDB/文件、实际静音 WAV 解码（本地与真实测试插件解析的回环 HTTP 交替）；100 次原生迷你窗和歌词窗开关及 MessagePort 清理、1000 次真实切歌后触发 12 首真实并发下载与 1000 个真实 WAV 扫描，并持续播放 120 分钟，每分钟采样窗口/端口/进度/资源并外部删除恢复文件，检查提交后的 MISSING/AVAILABLE 状态和原下载引用。快速模式只有 3 次开关、4 次切歌、4 个下载和 20 个扫描文件，不能写成长时验收。测试期间临时阻止应用自动休眠，结束即释放；若采样间隔超过 90 秒则不能判为持续运行通过。资源采样来自 Electron app metrics，以及 Windows 对这些相同 PID 的句柄计数（排除采样 PowerShell），未包含独立转发服务，不能与 CIM 全进程树 benchmark 混比；隐藏窗取消后台节流，未覆盖真实驱动、睡眠唤醒、在线插件和全部编码格式。

## CI/CD

GitHub Actions 会通过 `scripts/ci/run-tests.cjs` 分别执行 Node 和 Electron 回归，记录每项结果及日志。构建、下载测试包与版本标签发布见 [发布说明](../../release/README.md)。
