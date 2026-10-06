# 开发与提交指南

本项目使用 TypeScript、React 和 Electron，支持 Windows、Linux 和 macOS。构建与发布流程见 [release/README.md](release/README.md)，回归入口见 [scripts/tests/README.md](scripts/tests/README.md)。

## 提交边界

日常功能和修复以最新 `dev` 为基线，PR 提交到 `dev`。每个提交解决一个明确问题，并包含必要回归测试；同一行为所需的主进程、preload、renderer 和类型修改一起提交。

提交标题采用：

```text
<type>(<scope>): <具体变化>
```

常用类型为 `feat`、`fix`、`perf`、`refactor`、`test`、`docs`、`build`、`ci`、`chore`。正文说明原因、实际执行的检查和兼容性边界。无关格式整理、依赖变更和功能修改分别提交。

## 文件归属

| 内容 | 维护位置 |
| --- | --- |
| 播放器实现和运行必需素材 | `src/`、`res/` |
| 构建、检查和发布脚本 | `config/`、`scripts/ci/`、`.github/` |
| 可复用回归与测试夹具 | `scripts/tests/` |
| 项目说明、开发和发布文档 | README、本指南、测试说明、发布说明 |
| 辅助知识库、设计草稿、参考图、个人审查与本机验收记录 | 本地忽略目录，不纳入提交 |
| 自动生成的日志、截图、测试 profile 和构建产物 | `out/`；需要共享时使用 CI Artifacts |

`.gitignore` 已明确列出本地辅助资料的目录。不要使用 `git add -f` 将这些资料加入提交。可复用测试脚本应依赖仓库内的测试夹具，不能依赖本地知识库文件。

## 验证

安装对应平台依赖后，从仓库根目录执行：

```sh
npm ci
npm run format:check
npx --no-install tsc --noEmit
npx --no-install eslint src
node scripts/ci/run-tests.cjs node
node scripts/ci/run-tests.cjs electron
```

Linux 的 Electron 回归使用 `xvfb-run -a node scripts/ci/run-tests.cjs electron`。本地应使用本平台的 Node、Electron 和原生模块；跨平台 CI 各自安装与编译。

`npm run lint` 和 `npm run format:fix` 会修改文件。提交前的只读检查使用上述 `format:check`、`tsc` 和 `eslint` 命令。UI 修改检查空态、尺寸、键盘操作及减少动态效果；播放、下载和歌单修改须验证竞态与数据完整性。

## 暂存检查

当前旧 hook 会运行全目录 `lint --fix`，随后执行 `git add .`。在该 hook 修改前，混合工作区整理提交应先独立完成检查，再使用仅作用于单次提交的 `HUSKY=0` 或禁用 hook 的命令，避免无关文件被暂存。

```sh
git status --short
git diff --stat
git add -- path/to/changed-file path/to/related-test
git diff --cached --stat
git diff --cached --check
git diff --cached
```

提交后检查 `git show --stat HEAD` 和工作区状态。未明确要求时，不改写已经共享的历史；需要整理历史时先建立备份，并用 `--force-with-lease` 检查远端是否被其他提交更新。

## 构建与发布

本地生成完整运行目录，不默认生成 ZIP：

```sh
npm run package
node scripts/ci/verify-build.cjs
```

安装包、便携包、DMG 和校验和由 GitHub Actions 生成。标签必须匹配 package 与 lockfile 的版本；正式发布和手动测试包的步骤见发布说明。
