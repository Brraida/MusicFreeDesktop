# 2026-10-04 审查证据

对应 [审查报告](../../../CODE_REVIEW_2026-10-04.md)，基线 `d39e8f4`，终点 `4e7b711`。机器可读结果见 [results.json](results.json)。

## 已执行检查

HEAD 通过 `git archive HEAD` 提取为独立临时快照，复用现有 npm 依赖；未重新安装依赖。下列检查在快照中执行：

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js --config eslint.format.config.mjs src scripts config res/.service forge.config.ts 'eslint*.mjs' --max-warnings=0
node node_modules/eslint/bin/eslint.js src --format json
node scripts/ci/run-tests.cjs node
```

类型、格式检查退出码均为 0。完整 ESLint 为 0 error / 138 warning：未使用 `--fix`。

Node 首次执行受沙箱对子进程/localhost 的限制，允许执行后六组通过；`ci` 组另因本机缺少名为 `python` 的命令失败，临时在 PATH 前加入指向 `/usr/bin/python3` 的同名链接后重跑 `node scripts/tests/ci-regression.cjs` 通过。`results.json` 记录了该次重跑，未把环境失败当成业务缺陷。

Windows Electron 使用工作区安装的 `electron.exe`，源码与 HEAD 的相关差异仅为行尾，五组均退出 0：

```powershell
.\node_modules\.bin\electron.cmd scripts/tests/downloader-main.cjs
.\node_modules\.bin\electron.cmd scripts/tests/electron-regression-main.cjs audio
.\node_modules\.bin\electron.cmd scripts/tests/electron-regression-main.cjs playlist
.\node_modules\.bin\electron.cmd scripts/tests/electron-regression-main.cjs startup
.\node_modules\.bin\electron.cmd scripts/tests/electron-regression-main.cjs relocation
```

本轮实际从 WSL 调用 `./node_modules/electron/dist/electron.exe` 执行上述入口，使用独立 profile。没有运行普通播放器，没有使用正常音乐库数据。

## 定向复现

**这些是诊断脚本，断言“缺陷存在”。退出 0 表示成功复现，不表示代码正确。** 修复后应反转相应断言并补充边界，再迁入 `scripts/tests`，不要原样加入 CI。

以下从仓库根目录运行，使用当前 checkout 的源码和已有测试工具；证据对应 `4e7b711`，后续源码变化可能使脚本不再适用。

### R1 / R2：文件所有权与数据库并发

```powershell
.\node_modules\.bin\electron.cmd docs/reviews/2026-10-04/database-main.cjs
```

[database-main.cjs](database-main.cjs) 创建隐藏 Electron 窗口和 `out/.review-evidence-时间戳` 独立 profile，运行 [renderer.cjs](renderer.cjs)。后者沿用现有 relocation 测试的加载方式，调用真实下载模块、歌单 backend 与 Dexie/IndexedDB，文件由脚本在测试目录中创建。

- R1 构造与 watcher 写入字段一致的本地歌曲，添加进真实歌单后初始化下载索引，再按实际菜单参数 `removeFile=true` 删除。
- R2 下载记录初始只有一份引用，暂停其文件删除操作，在此间隙用真实 backend 加入歌单，然后继续删除。
- `fsUtil` 等进程边界使用适配器；文件读写和 IndexedDB 是实际操作。没有通过真实鼠标完成扫描或菜单操作。

本次输出关键字段：

```json
{
  "local": {
    "originalLocalFileExists": false,
    "recognized": true,
    "refsBefore": 1,
    "remove": [true],
    "recordExistsAfter": false,
    "playlistStillReferences": true
  },
  "concurrentRemove": {
    "refsAfterConcurrentAdd": 2,
    "recordExistsAfterRemove": false,
    "playlistStillReferences": true
  }
}
```

脚本将本次结果写入自己的测试目录，保留 profile 供诊断；只删除它创建的假音频，不访问用户音乐目录。

### R3：大小写文件名碰撞

```sh
node docs/reviews/2026-10-04/collision.cjs
```

[collision.cjs](collision.cjs) 加载实际 worker，fetch 用两个不同内容的 Response 替代，以控制并发时序；pipeline、临时文件和 rename 使用真实文件系统。需要支持 Response 的 Node（本轮为 Node 24，CI 的 Node 22 也具备此 API）。

脚本先检测测试目录是否不区分大小写；区分大小写时输出 `SKIP`，不能据此证明 Windows/macOS 常用卷安全。复现时两个 `DONE` 结果对应 `Song.mp3` / `song.mp3`，目录最终只有一个文件。所有本脚本临时文件在 finally 中清理。

### R5：初次取源期间切换音质

```sh
node docs/reviews/2026-10-04/quality.cjs
```

[quality.cjs](quality.cjs) 复用现有 `player-regression.cjs` 的 fixture，挂起初次取源，在高音质先完成后释放旧请求，记录实际 TrackPlayer 对替身音频控制器的调用。

本次结果：`quality="high"`、高音质源已设置、`playCalls=0`。这验证控制逻辑丢失播放意图；不用于证明浏览器的具体状态文字或实际扬声器输出。

R4 仅做源码和官方资料交叉核查，没有执行应用安装/卸载。完整打包、Linux/macOS 图形运行及真实设备兼容性也不在本轮执行结果中。
