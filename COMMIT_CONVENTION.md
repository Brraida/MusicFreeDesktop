# MusicFreeDesktop 代码提交规范（建议稿）

适用仓库：当前 Electron + React + TypeScript 项目。依据：`dev@4e7b711` 的目录结构、ESLint、测试入口、CI 和 PR 模板。编写日期：2026-10-04。

本文供维护者审阅；尚未安装 commitlint、修改 Git hooks 或更改 CI 门禁。已有 28 个 Brraida 提交基本采用下述标题格式，无需仅为了统一标题重写已共享的历史。

## 1. 分支与改动边界

- 日常功能、修复从最新 `dev` 创建短期分支，例如 `fix/download-file-collision`、`feat/playlist-batch-actions`。
- PR 提交到 `dev`，遵循现有 [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md)。`master` 是本次历史审查的基线，不代表日常 PR 应提交到 master。
- `master` 的发布合并由维护者安排；不要在已经共享的 dev/master 上为整理历史执行强制推送。
- 一个提交解决一个可描述、可验证、可回滚的问题。修复及其必要回归测试应在同一提交；无关格式化、依赖更新和功能改动拆开。
- 不要求机械地按文件拆提交：主进程、preload、renderer、worker 和类型声明的配套修改属于同一行为变更时，应一起提交，避免中间提交无法运行。

## 2. 提交信息

```text
<type>(<scope>): <具体行为变化>

<为什么需要修改；原来的触发条件和结果>
<修改后的行为；必要时说明兼容性、数据处理和限制>

Test: <实际执行的检查及结果>
Refs: #<issue>                       # 有关联时填写
BREAKING CHANGE: <不兼容影响与迁移>   # 有不兼容变更时填写
```

`scope` 可省略，但业务修复建议保留。标题建议不超过 72 个字符，不加句号；中文或英文均可，同一 PR 保持一致。使用明确的动作与对象，避免 `update`、`fix bug`、`优化代码` 等无法判断内容的标题。`Test`、`Refs` 是本文建议的正文约定，目前没有自动校验器。

| type | 使用场景 | 本仓库示例 |
| --- | --- | --- |
| `feat` | 用户可见的新能力 | `feat(playlist): add checkbox selection and batch actions` |
| `fix` | 纠正已存在的错误行为 | `fix(download): preserve playlist references when removing downloads` |
| `perf` | 行为不变、可说明收益的性能改动 | `perf(window): reduce rendering work while hidden` |
| `refactor` | 行为不变的内部结构调整 | `refactor(service): centralize forwarder lifecycle state` |
| `style` | 仅格式变化 | `style: align build scripts with shared formatting rules` |
| `test` | 独立补充或调整测试 | `test(download): cover case-insensitive filename collisions` |
| `docs` | 文档变更 | `docs: document commit rules and review findings` |
| `build` | 编译、原生模块和安装包配置 | `build(windows): configure the Squirrel installer` |
| `ci` | Actions、检查与产物流水线 | `ci: verify packages on all supported platforms` |
| `chore` | 不改变产品行为的维护 | `chore(deps): normalize lockfile registry URLs` |
| `revert` | 撤销已提交变更 | 正文注明被撤销的 SHA 和原因 |

建议 scope：`player`、`audio`、`lyrics`、`playlist`、`download`、`local-music`、`plugin`、`service`、`startup`、`window`、`i18n`、`deps`、`windows`、`linux`、`macos`、`git`。沿用现有命名，不为每个组件发明一个 scope。

修复提交示例：

```text
fix(download): distinguish local files from owned downloads

Local watcher items also contain downloadData.path. Rebuilding the
download index from this field alone exposes original local files to
the downloaded-file deletion action.

Only records owned by the downloader participate in index recovery.
Keep playlist references intact when removing a download record.

Test: Node regressions passed; Electron playlist and relocation passed
Test: local-file ownership regression passed
```

上例展示信息结构，不表示示例中的修复已经实现。

## 3. 按仓库架构审查代码

| 改动位置 | 提交前重点核查 |
| --- | --- |
| `src/main`、`src/shared/*/main*` | 窗口/子进程生命周期；退出清理；平台分支；IPC 参数；安装器事件是否提前处理 |
| `src/preload`、`src/shared/*/{preload,renderer}*` | 暴露接口与类型同步；事件取消订阅；调用方错误传播；保持现有进程职责 |
| `src/renderer/core/track-player` | 过期请求不得覆盖当前歌曲；切歌/切音质保留播放与暂停意图；Blob/HLS/请求及时释放 |
| `src/renderer/core/music-sheet`、`downloader` | 读、改、引用计数在同一写事务内；事务提交后更新缓存；下载与歌单跨模块并发 |
| `src/webworkers` | 明确开始/进度/完成/取消协议；异常反馈；监听器与临时文件清理；大小写与路径边界 |
| `src/renderer/components`、`pages` | 状态依赖、主键稳定性、排序/筛选/分页、多选、空态、错误提示与键盘操作 |
| `res/lang` | 普通界面文案同步 `zh-CN`、`zh-TW`、`en-US`；启动前诊断若不能依赖 i18n，说明原因 |
| `config`、`forge.config.ts`、`scripts/ci`、workflows | 操作系统与 CPU 架构；原生库；隐藏资源；真实安装/启动；版本与产物来源一致 |

数据与异步代码必须说明的不变量：

- “存在本地路径”与“由下载器创建并持有一份引用”分别建模；本地扫描、下载缓存、歌单引用不能只凭同一字段混用。
- IndexedDB 事务外可以执行文件 I/O；进入写事务后须重新读取最新记录，校验身份、下载路径及所有权，再决定减引用或删除。
- 一条下载只有在文件写入完成且记录提交成功后才向 UI 宣布完成。重试必须区分网络失败和记录保存失败。
- 防覆盖必须考虑目标文件系统是否区分大小写，并处理检查后出现文件的情况；临时文件的 `wx` 不等于最终文件不会被覆盖。
- 请求版本号负责判断结果是否过期，播放意图负责判断应播放还是暂停，不能只凭瞬时 `Playing` 状态推断用户意图。

## 4. 格式与依赖

- TypeScript/JavaScript 遵循现有 ESLint：四空格、双引号、分号、多行尾逗号等。SCSS、JSON、YAML、Markdown 沿用各文件已有格式。
- `format:check` 目前检查 JS/TS 等源码与脚本，不覆盖全部 JSON/YAML/SCSS/Markdown；它也不代替完整代码质量检查。
- 不在业务修复里全仓库格式化或统一行尾。建议后续独立提交 `.gitattributes` 确定 LF/CRLF 策略，并单独评审首次归一化差异。
- 修改依赖时同步提交 `package.json` 和 `package-lock.json`；只替换 registry 时核对包版本和 integrity 未发生意外变化。
- 改版本时同步 package 与 lockfile 根版本。发布标签严格匹配已提交的 `package.json`：例如 `v0.0.80` 对应 `0.0.80`。
- CI 使用 Node 22、Python 3.11。涉及原生库时在对应平台安装和构建，不跨 Windows/WSL 共用原生二进制来判断打包是否成功。
- 不提交 `node_modules`、`.webpack`、`out`、测试 profile、构建日志、个人配置和令牌。可长期保留的审查证据应筛选到文档目录。

## 5. 验证要求与准确命令

以下命令从仓库根目录执行；检查命令不自动修改源码：

```sh
npm run format:check
npx --no-install tsc --noEmit
npx --no-install eslint src
node scripts/ci/run-tests.cjs node
node scripts/ci/run-tests.cjs electron
git diff --check
git diff --cached --check
```

Linux Electron 回归使用：

```sh
xvfb-run -a node scripts/ci/run-tests.cjs electron
```

需要先具备本平台 Electron、显示/沙箱环境及 Python。CI 环境准备以 [.github/workflows/build.yml](.github/workflows/build.yml) 为准；环境失败应记录，不能记作测试通过，也不能直接归因于业务代码。

**注意现有命令副作用：** `npm run lint` 实际执行 `eslint ./src --fix`，会修改文件；只检查请使用上面的 `npx --no-install eslint src`。`npm run format:fix` 也是修改操作，执行后重新检查差异。

2026-10-04 的 HEAD 基线：完整 ESLint 为 **0 error / 138 warning**，格式检查与类型检查通过。建议先要求不增加所改代码中的告警，再单独治理存量；目前不宜把全仓库 `eslint src --max-warnings=0` 描述成已经可通过的检查。

| 改动类型 | 本地最低验证 | PR/发布要求 |
| --- | --- | --- |
| 纯文档 | 核实命令、路径、链接、版本与 diff | 不声称执行未运行的测试 |
| 普通 UI/样式/文案 | 格式、类型、相关页面手动验证 | 说明空态、窄窗口、多语言；行为变化提供截图或录像 |
| 播放/下载/歌单/Store/服务 | 格式、类型、相关 Node/Electron 回归；为实际缺陷增加有效复现 | 合并前现有全部回归通过；注明替身与真实运行边界 |
| 主进程/worker/原生库/打包 | 上述检查 + 对应平台编译和产物验证 | 四个现有平台作业通过；安装器变化另做安装/升级/卸载验收 |

编译和包内运行检查：

```sh
npm run package
node scripts/ci/verify-build.cjs
```

这两个命令会生成 `out` 产物，且可能重建原生模块。`verify-build` 检查入口和原生模块等，不等于打开完整播放器，也不等于安装器验收。正式产物流程见 [release/README.md](release/README.md)。

回归测试应验证用户可观察的行为或数据不变量：真实 IndexedDB 回滚、交错调用后的引用完整性、文件是否被覆盖、过期请求是否影响播放。不要只断言某个内部函数被调用。

## 6. 暂存与 Git hook 的现状

当前 `.husky/pre-commit` 调用 lint-staged；`package.json` 内的规则对源码执行全目录 `npm run lint`，随后执行 **`git add .`**。这属于已有流程风险：在混合改动工作区提交一个源码文件时，可能把无关文件一起暂存，破坏提交边界。

建议另建 `chore(git)` 提交：仅格式化传入的暂存文件，移除 `git add .`，交给 lint-staged 管理其处理文件。本文没有修改 hook。在该问题解决前，不应依赖当前 hook 保证“部分暂存”的准确性；不要为了整理本轮改动直接进行提交。

正常提交前检查：

```sh
git status --short
git diff --stat
git diff -- path/to/changed-file
git add -- path/to/changed-file path/to/related-test
git diff --cached --stat
git diff --cached
git diff --cached --check
```

提交完成后再核对 `git show --stat HEAD` 和 `git status --short`。若发现意外文件，先判断提交是否已共享，再选择修正方式，不默认重写公共历史。

本次工作区有大量 CRLF/LF 差异，以及未提交的版本变化。审查时可用 `git diff --ignore-space-at-eol` 辅助辨别；提交前仍须查看普通 diff，不能把忽略空白后的结果当作完整审核。

## 7. PR 信息与合并标准

沿用现有模板，补充以下信息即可：

```text
问题：具体操作、原行为和影响
修改：现在的行为；涉及的数据/进程/平台
验证：实际命令、结果、手动验证平台；未覆盖内容
兼容与回滚：旧记录、旧配置、安装升级是否受影响
关联：issue / review 条目编号
```

- 运行代码变更不使用 `[skip ci]`；纯文档是否跳过取决于仓库 required checks，不把跳过 CI 当作默认流程。
- 修复已确认的 P0/P1 后再合并或发布相关功能。P2 明确本次解决还是登记后续；P3 可独立维护。
- 成功打包不代表已测试安装，单个平台通过不代表四个平台通过，替身测试不代表真实设备兼容。
- 对已有数据可能造成误删、覆盖或引用丢失的修复，PR 明确恢复策略与回归场景；不要只写“测试通过”。

建议优先落地顺序：处理 [本轮审查](CODE_REVIEW_2026-10-04.md) 的 P1 → 修正暂存 hook → 在日常提交中采用本文 → 视需要增加 commitlint/行尾策略。工具化各自独立提交。

## 8. 2026-10-05 本轮执行记录

本轮按维护者要求直接在 `dev` 整理提交。下载文件同步、播放恢复、启动优化、唱片效果及版本元数据分别提交，修复所需的回归用例随对应代码一起提交。共享文件的中间状态经过独立验证，再恢复到已验收的最终实现。

现有 lint-staged 配置会执行 `git add .`。本轮提交前明确列出暂存文件、检查暂存 diff，并单独执行回归、类型和格式检查；提交命令使用一次性的 `HUSKY=0`，保证提交边界。该环境变量仅作用于本轮提交命令。配置本身的后续修改继续作为独立维护事项管理。

详细拆分记录见 [本轮提交整理](docs/history/2026-10-05-functional-commits.md)。
