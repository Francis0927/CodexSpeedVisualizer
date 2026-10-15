# Electron 行为参考

这里保存迁移前的 Electron 后台实现，用于统计逐快照对照和旧行为测试。当前应用启动、Rust 构建及发布包均不使用这些模块，也不依赖 Electron 运行时。

原窗口测试保留为历史资料，当前对应验证为 `tests/tauri-window.test.cjs` 与 `tests/tauri-ui.test.cjs`。旧安装包的 asar 解析工具仅用于参考测试和本地旧包版本识别。
