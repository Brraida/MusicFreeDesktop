下载回归测试使用真实 Windows Electron、IndexedDB、Comlink 和本地 HTTP 服务。

在 Windows 的项目根目录运行：

```powershell
.\node_modules\.bin\electron.cmd scripts/tests/downloader-main.cjs
```

测试数据保存在 `out/.download-regression-data-*` 的独立目录，不使用正常应用的音乐库或设置。
覆盖并发保存、下载列表恢复、数据库提交失败、网络失败、同名文件、暂停/继续、保存记录重试、提交后的通知异常，以及真实 React 下载状态组件与待下载列表同步。
