# 正确性回归测试

测试在仓库根目录运行，使用现有 npm 依赖。Node 测试加载实际 TypeScript 源码；音频与部分系统边界使用可控替身。Electron 测试使用真实 Windows Chromium、IndexedDB、React、HTTP 和音频元素。

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
```

| 测试 | 覆盖与边界 |
| --- | --- |
| player | 音源和歌词的成功/失败竞态、A → B → A、音质切换与撤回、过时的延迟跳歌、reset；本地优先、单次网络回退、seek、恢复期间暂停、切歌后丢弃旧回退；音频与插件用替身 |
| service | 重启/停止/backoff；真实转发子进程和 HTTP 请求，loopback、令牌、非法输入、Range/认证和断流 |
| scanner | 初始 1/100/10000 条缓冲的隔离测试；真实 Chokidar 与 100 个独立测试文件的增删改、可选 stats、大写扩展名、短损坏文件解析与文件夹导入 |
| audio | HLS 与 Blob 生命周期、最终 headers、播放/暂停意图、seek、A → B → A、取消与 URL 释放；Audio/HLS/fetch 用替身 |
| store | 提交后通知、订阅错误隔离、其他订阅继续执行、更新函数失败保留旧状态 |
| ci | 四平台产物路径、版本标签、完整便携 ZIP（包含空 portable 和隐藏资源）、SHA-256、重复产物保护、Release 草稿创建/更新与正式发布保护；独立临时文件和 GitHub CLI 替身 |
| duration | 本地时长恢复、已有时长归一化、播放事件持久化与未知时长占位；保留 dev 的新增时长回归 |
| lyric | 真实歌词解析与双句推导：乱序、重复文字、同时间戳、前奏/间奏/末句、纯文本与零时间单句、过时快照、翻译、正负 offset；16～80 字号与窗口高度换算 |
| startup | 配置/插件/歌单/播放状态/语言/下载记录的阶段错误信息；各初始化服务用替身 |
| download-resource | 真实文件读取与 SHA-256、同名同大小内容冒充、删除/恢复、父目录删除/重建、监听重挂后原生事件、无关目录边界、换目录代次和 stop 释放；权限/离线/I/O 分类用故障注入 |

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
```

测试数据保存在 `out/.download-regression-data-*`、`out/.correctness-regression-*` 独立目录，不使用正常应用的音乐库或设置。scanner 测试会清理其独立目录，其余结果/profile 保留在 out 便于诊断。

- 下载：并发保存、下载列表恢复、提交失败、网络/断流、同名文件、暂停/继续、记录补存、通知异常和真实 React 状态同步。HLS MIME、伪装后缀/分块清单拒绝；真正音频即使 URL 后缀是 m3u8 也可成功。外部恢复旧文件不结束活动下载，真实新下载完成后提交新路径并保留引用计数。
- 下载目录：真实文件移动、修改配置后已挂载收藏图标和已下载列表刷新、启动时恢复、旧路径仍有效时保留、缺失文件清除标志、重复文件名拒绝关联、事务失败回滚、音质/歌单字段/引用计数保留。依据既有身份，在新目录中查找唯一同名候选，再验证 SHA-256；不导入未知文件，不递归查找或推断改名。没有指纹且已丢失原文件的旧记录不能仅凭名称安全恢复。
- 下载资源：启动索引准备不读取文件，后台分批核对时目标歌曲优先；未核对的已有歌曲不重复下载。真实 Windows Chokidar、IndexedDB、收藏图标和手动刷新按钮；外部文件/目录删除恢复、内容变化与冒充、配置变化时丢弃旧结果、事务失败回滚、重下载并发；注入权限/离线/I/O 故障以验证关联和收藏保留。使用真实 HTMLAudio：在检查后删除有效本地 WAV，确认网络 WAV 回退后实际解码播放，且不重复恢复。
- 音频：实际 HTMLAudio 解码并播放认证 Blob WAV（静音），恢复播放与 seek、暂停、释放 URL；取消真实 HLS 片段请求后播放普通 WAV。验证 HLS 请求清理，未把未完成的 HLS 分片解码视为已测试能力。
- 歌单：真实 IndexedDB，20 个并发重复添加、添加/删除竞态、引用计数、收藏索引、清空/删歌单、写入失败回滚。
- 启动：真实 React 加载/失败/成功界面；日志服务失败时仍显示诊断；成功前不挂载播放器。重试按钮通过整页重载重新初始化，不删除配置或音乐库。
- 唱片：真实 React 组件、SCSS 和 Chromium 动画；旋转周期、暂停保持角度和继续、透明素材解码、唱臂实际 alpha 边界、针尖落在黑胶外圈与暂停离盘、固定反光、44px/56px 适配、主窗口 Store 与迷你订阅、隐藏停转、切歌、坏封面回退、键盘/双击/悬停、减少动态效果与卸载清理。独立 profile 输出播放/暂停/底部栏与迷你窗口截图；部分外围控件使用替身。编译版主进程/页面与真实窗口间同步另有 [写实素材验收记录](../../docs/knowledge-base/evidence/vinyl-real-results.json)。

- 双行歌词：真实 React、SCSS、共享歌词函数、消息状态订阅与 ResizeObserver；重复文字切句、两窗一致、快退、前奏/间奏/末句/切歌清空、长句暂停/恢复/回退、16/54/80 排版、340×72 迷你窗、封面控件不遮挡歌词、减少动态效果与卸载清理。编译后的真实主进程/preload/renderer 验收另见 [双行歌词记录](../../docs/knowledge-base/evidence/ktv-two-line-results.json)。

动画回归先通过 Chromium CDP 明确设置 `prefers-reduced-motion: no-preference` 验证旋转与滚动，再切换 `reduce` 验证动画停止；结果同时记录系统原设置。避免 CI 宿主默认减少动态效果时读取不存在的动画对象。已在 Windows 强制减少动态效果的条件下验证两个阶段。

这些测试不等于所有在线插件、真实音乐格式和设备的全量兼容性测试。download-resource Node 测试也已在 WSL Linux 执行；Linux GUI 与 macOS 本轮未执行运行验收。

## 编译版启动性能

使用隔离 profile，比较 1000 条旧下载记录、完成指纹后的记录和空歌库；记录前端初始化、首屏和全部迁移的耗时。测试条件、复现脚本及实测结果见 [启动验证](../../docs/knowledge-base/evidence/startup-performance.md)。这是单次缓存磁盘测试，不代表 exe 冷启动 P95。

## CI/CD

GitHub Actions 会通过 `scripts/ci/run-tests.cjs` 分别执行 Node 和 Electron 回归，记录每项结果及日志。构建、下载测试包与版本标签发布见 [发布说明](../../release/README.md)。
