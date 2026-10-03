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
```

| 测试 | 覆盖与边界 |
| --- | --- |
| player | 音源和歌词的成功/失败竞态、A → B → A、音质切换与撤回、过时的延迟跳歌、reset；音频与插件用替身 |
| service | 重启/停止/backoff；真实转发子进程和 HTTP 请求，loopback、令牌、非法输入、Range/认证和断流 |
| scanner | 初始 1/100/10000 条缓冲的隔离测试；真实 Chokidar 与 100 个独立测试文件的增删改、可选 stats、大写扩展名、短损坏文件解析与文件夹导入 |
| audio | HLS 与 Blob 生命周期、最终 headers、播放/暂停意图、seek、A → B → A、取消与 URL 释放；Audio/HLS/fetch 用替身 |
| store | 提交后通知、订阅错误隔离、其他订阅继续执行、更新函数失败保留旧状态 |
| ci | 四平台产物路径、版本标签、完整便携 ZIP（包含空 portable 和隐藏资源）、SHA-256、重复产物保护、Release 草稿创建/更新与正式发布保护；独立临时文件和 GitHub CLI 替身 |
| startup | 配置/插件/歌单/播放状态/语言/下载记录的阶段错误信息；各初始化服务用替身 |

## Windows Electron 回归

在 Windows 的项目根目录运行：

```powershell
.\node_modules\.bin\electron.cmd scripts/tests/downloader-main.cjs
.\node_modules\.bin\electron.cmd scripts/tests/electron-regression-main.cjs audio
.\node_modules\.bin\electron.cmd scripts/tests/electron-regression-main.cjs playlist
.\node_modules\.bin\electron.cmd scripts/tests/electron-regression-main.cjs startup
.\node_modules\.bin\electron.cmd scripts/tests/electron-regression-main.cjs relocation
```

测试数据保存在 `out/.download-regression-data-*`、`out/.correctness-regression-*` 独立目录，不使用正常应用的音乐库或设置。scanner 测试会清理其独立目录，其余结果/profile 保留在 out 便于诊断。

- 下载：并发保存、下载列表恢复、提交失败、网络/断流、同名文件、暂停/继续、记录补存、通知异常和真实 React 状态同步。新增 HLS MIME、伪装后缀/分块清单拒绝；真正音频即使 URL 后缀是 m3u8 也可成功。
- 下载目录：真实文件移动、修改配置后已挂载收藏图标和已下载列表刷新、启动时恢复、旧路径仍有效时保留、缺失文件清除标志、重复文件名拒绝关联、事务失败回滚、音质/歌单字段/引用计数保留；播放器使用更新后的路径另由 player 回归验证。依据已有下载记录与新目录中的原文件名关联，不导入未知文件，不递归查找子目录或推断改名后的歌曲。
- 音频：实际 HTMLAudio 解码并播放认证 Blob WAV（静音），恢复播放与 seek、暂停、释放 URL；取消真实 HLS 片段请求后播放普通 WAV。验证 HLS 请求清理，未把未完成的 HLS 分片解码视为已测试能力。
- 歌单：真实 IndexedDB，20 个并发重复添加、添加/删除竞态、引用计数、收藏索引、清空/删歌单、写入失败回滚。
- 启动：真实 React 加载/失败/成功界面；日志服务失败时仍显示诊断；成功前不挂载播放器。重试按钮通过整页重载重新初始化，不删除配置或音乐库。

这些测试不等于所有在线插件、真实音乐格式和设备的全量兼容性测试；Linux/macOS 本轮未执行运行验收。

## CI/CD

GitHub Actions 会通过 `scripts/ci/run-tests.cjs` 分别执行 Node 和 Electron 回归，记录每项结果及日志。构建、下载测试包与版本标签发布见 [发布说明](../../release/README.md)。
