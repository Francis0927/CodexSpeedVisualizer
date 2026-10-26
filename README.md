# Codex Drive

Windows 桌面 Codex 用量仪表盘，基于 Tauri 2 + Rust + React，支持 Windows 10/11 x64。

## 显示内容

| 区域 | 内容 |
| --- | --- |
| 工作状态 | 等待 Codex、正在工作、正在更新、待机或读取失败。 |
| 输出速度 | 汽车指针与数字显示近期输出速度（token/s），经过平滑处理。 |
| 今日累计 | 本机当天的输入与输出 token 总和，包含缓存输入。 |
| 历史累计 | 本机可读取会话的累计 token，可在设置中重置统计起点。 |
| 5 小时 / 一周额度 | 账户剩余百分比、进度条和本机时区的重置时间。暂无数据或到期待刷新时会标明。 |
| Tibo Reset 预测 | 一周额度下方显示重置状态、概率、预计时间及最近一次重置。默认每 10 分钟查询一次，设置中可选 1、5、10、15、30、60 分钟，保存后生效。查询失败保留上次结果，过期预测会标明。 |
| 用量详情 | 点击速度卡片，查看完整 token 数、输入 / 输出、上轮平均速度和轮次规模。 |

## 使用

从 [GitHub Releases](https://github.com/Francis0927/CodexSpeedVisualizer/releases) 下载安装版或便携 ZIP。安装版仅为当前用户安装；便携版解压后运行 `Codex Speed Pet.exe`，保留同目录的 `build-kind.json`。需要 Microsoft Edge WebView2，缺少时按程序提示安装。

安装器默认不勾选创建桌面快捷方式，可手动选择。静默安装和应用内更新不新增桌面快捷方式，已有的会保留。

手动运行安装包时，检测到原目录中已有本应用的 Tauri 安装版，会自动进入覆盖更新，保留原目录、设置和快捷方式，不再显示卸载/重装选择页。更新前请先退出旧版。

启动入口仍为 `Codex Speed Pet.exe`，启动后在同目录生成并运行 `SpeedPet.exe`，入口进程随即退出，以避开第三方工具按 `codex ` 前缀关闭进程的规则。应用目录需要可写；请继续使用原入口或快捷方式启动，让更新后的运行文件自动刷新。安装包、便携 ZIP 和 GitHub 更新保留原文件名，兼容旧版更新器；设置及开机启动入口沿用原路径。

拖动顶部移动窗口，设置和托盘菜单可调整窗口大小、置顶、吸附、动画及开机启动。点击「−」隐藏到托盘，双击托盘图标恢复窗口。

- **自动折叠**：离开窗口后收起标题与额度，鼠标移入完整展开；打开设置或详情时保持展开。
- **贴边吸附隐藏**：默认关闭。开启后拖到屏幕四边附近，松开自动吸附；移开鼠标后只留窄边，移到窄边完整展开，拖离边缘取消吸附。被普通应用遮挡时也能唤起，不抢键盘焦点。
- **置顶与吸附互斥**：开启任意一项会关闭另一项。吸附模式始终显示完整内容，不再折叠；截图等置顶覆盖层仍保持在前方。

## 数据与统计

- 只读取本机 `%CODEX_HOME%\sessions` 和 `archived_sessions`；未设置时使用 `%USERPROFILE%\.codex`。按响应去重，统计数据不上传，不修改原始会话。
- 额度来自会话日志中的最新账户快照，不从 token 总量推算；到达重置时间后等待 Codex 新事件确认。Tibo 的预计时间超过后仍等待执行确认。
- 设置中的「历史累计 → 重置」仅重置历史统计起点，不影响今日累计或账户额度。设置保存在 `%APPDATA%/Codex Speed Pet`，兼容旧目录 `%APPDATA%/codex-speed-pet`。

## 开发与本地打包

需要 Node.js 18+、Rust MSVC 工具链（版本见 `src-tauri/rust-toolchain.toml`）、Visual Studio C++ Build Tools 和 Windows SDK。

```powershell
npm ci
npm start
```

`npm run dev` 可单独预览界面，浏览器预览不包含本地采集和托盘功能。

```powershell
npm test                 # 统计、Rust、更新及发布脚本回归
npm run test:window      # 真实 WebView2 界面回归
npm run test:topmost     # 置顶、吸附与外部窗口遮挡回归
npm run build            # 前端类型检查与构建
npm run dist:release     # 本地隔离打包并校验
```

本地发布文件位于 `release/github-版本号`，包含标准名称的安装包、便携 ZIP、`SHA256SUMS.txt` 和 `README.txt`。打包成功后自动清理可识别的旧版本产物；失败时保留旧包和可复用产物。完整规则见 [AGENTS.md](AGENTS.md)。

## GitHub 更新与发布

安装版和便携版统一通过 [GitHub Releases](https://github.com/Francis0927/CodexSpeedVisualizer/releases) 更新。启动后 5 秒、之后每 4 小时检查一次，也可在设置或托盘菜单手动检查；下载后校验大小和 SHA-256。Electron 旧版、内网版及无更新地址版需手动升级一次。

安装版的应用内更新会等待旧进程退出，在原安装目录静默覆盖文件，保留设置和统计记录，完成后自动重启，不再弹出卸载选择页。失败保留下载的安装包及 `updater-script-last.log` 供重试和排查。

发布前递增 `package.json` 和 `src-tauri/Cargo.toml` 的版本，提交并推送代码，保持工作区干净；发布工作流须已推送到默认分支。

```powershell
npm run publish:github -- -Notes "更新说明"
```

该命令触发并等待 GitHub Actions，在 Windows runner 上构建、校验并保存产物，再上传草稿，全部附件核对成功后正式发布。正式发布不使用本机包；标签为 `v版本号`，仅发布正式版本，不覆盖历史 Release 或同版本附件。重试只复用同版本、同提交的已验证产物；产物过期且已有附件时需递增版本。

GitHub Actions 仅保留 Release 工作流。推送 main 不再自动测试或打包；完整测试、安装包与便携 ZIP 构建、校验和上传统一在发布时执行。

发布凭据通过 `GH_TOKEN`、`GITHUB_TOKEN` 或 Git 凭据管理器读取，需要 Contents 与 Actions 写权限；runner 使用内置 `GITHUB_TOKEN`。详细发布与清理约束见 [AGENTS.md](AGENTS.md)。

以下命令仅检查参数或读取运行耗时，不会触发发布，也无需修改系统 PowerShell 执行策略：

```powershell
npm run check:release-notes -- -Notes "新增 Tibo Reset 预测"
npm run diagnose:release -- 38693309455 38694892389
```

打包日志会输出前端构建、隔离 Rust/NSIS 构建、ZIP 创建和产物校验的阶段耗时，并实时显示编译进度。

## 致谢

感谢 [Codex Resets](https://codex-resets.com) 提供免费的[公开 API](https://codex-resets.com/api/docs)，整理并分析 [Tibo（@thsottiaux）](https://x.com/thsottiaux) 的重置相关推文，为「Tibo Reset 预测」提供数据。预测来自第三方 AI 分析，不代表 OpenAI 的官方承诺。
