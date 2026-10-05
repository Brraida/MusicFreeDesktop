# 文档网页使用的 Mermaid

- 包：`mermaid@10.9.5`，经典浏览器 bundle `dist/mermaid.min.js`。
- 来源：[官方 npm 包](https://registry.npmjs.org/mermaid/-/mermaid-10.9.5.tgz)。
- 许可证：[MIT LICENSE](LICENSE)；文件保持上游原样。
- npm 包完整性与脚本 SHA-256：[provenance.json](provenance.json)。提取前已对照 npm 元数据校验包的 SHA-512。

此库仅用于知识库网页，不是播放器的运行时依赖，不加入项目根目录的 `package.json` 或锁文件。浏览器通过普通本地 script 标签加载，直接打开 `index.html` 时无需 CDN、网络或 ESM 服务器。固定该版本的经典 bundle，便于使用仓库现有 Electron/Chromium 环境自测。

页面按 [Mermaid 官方 API](https://mermaid.js.org/config/usage.html#api-usage)调用 `initialize` 与 `render`，关闭自动扫描，使用 strict 模式，并对每个图单独处理错误。字体就绪后，在屏幕外可测量的容器中布局，再将 SVG 放回对应章节，以避免隐藏章节的尺寸为零。

## 升级方式

1. 下载选定版本的官方 npm 包，校验其 `dist.integrity`。
2. 替换浏览器 bundle 与许可证，更新 `provenance.json`。
3. 如新版本不提供单文件经典 bundle，需同时调整网页加载方式和离线分发。
4. 运行 `python docs/knowledge-base/evidence/build-docs.py`。
5. 运行 `docs/knowledge-base/evidence/browser-render-test.cjs` 的 Windows Electron 回归，确认全部图、隐藏章节、打印和错误反馈仍正常。

## Git 空白检查

上游 bundle 含有行尾空白，原始字节与校验值保持一致。父目录 `.gitattributes` 仅对 `mermaid.min.js` 关闭 Git 空白检查；播放器源码和知识库自有代码仍按仓库规则检查。
