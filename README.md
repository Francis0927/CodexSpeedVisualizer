# Codex Drive

Windows 桌面汽车指针仪表盘，显示本机 Codex 的输出速度、今日与历史累计 token，以及 5 小时和一周的剩余额度。窗口有小、中、大三档。

三档窗口宽度约为：小 150、中 223、大 286 像素。展开时高度随实际内容变化；平时保留仪表盘与速度/累计卡片，高度随字号和内容调整。

底部累计与额度文字保持最低字号：标签至少 12–14 px，额度数字至少 18 px，重置时间至少 12 px；不会跟随小档窗口缩成难以阅读的小字。

## 运行

应用采用 Tauri 2 + Rust + React，支持 Windows 10/11 x64。运行安装版或便携版需要 Microsoft Edge WebView2；缺少时按提示安装。发布包不包含 Node.js 或 Electron。

安装版仅为当前用户安装，无需管理员权限，支持自定义安装目录。

开发需要 Node.js 18+、Rust 1.99.0 MSVC 工具链、Visual Studio C++ Build Tools 和 Windows SDK。Rust 版本由 `src-tauri/rust-toolchain.toml` 锁定；若项目内有 `.tools/cargo`，开发脚本会使用该隔离工具链，否则使用系统 Cargo。

```powershell
npm install
npm run build
npm start
```

制作 Windows 安装包：

```powershell
npm run dist
```

设置面板和托盘菜单都可以调整窗口大小、置顶、减少动画、自动折叠和开机启动。开启自动折叠后，离开窗口约 1.6 秒收起标题与额度，保留汽车仪表盘、输出速度、今日累计和历史累计；鼠标移入立即展开标题与额度，鼠标停留或面板打开时保持展开。窗口高度依据实际排版同步调整。在小窗口下打开设置或详情面板时，窗口会临时放大到中档以保证可读，关闭面板后自动恢复所选大小。

Windows 开启「始终置顶」后，仪表盘保持在普通窗口上方，显示、恢复或重新开启置顶时会回到前方。失去焦点或定时检查时不会争抢最前层，让截图选区等后来出现的置顶窗口正常覆盖仪表盘；每秒只检查并修复意外丢失的置顶标志，不抢走其他应用的输入焦点。关闭置顶、隐藏、最小化或退出后停止维护。

Windows 使用原生置顶标志和不激活窗口的层级修复，避免维护时抢焦点或覆盖截图选区。发布流程运行真实 Tauri 窗口回归，核对置顶标志、工具窗口属性、移动缩放、隐藏恢复和截图覆盖层的顺序。

仪表盘使用 Windows 工具窗口属性，并在显示、恢复和聚焦时重新隐藏任务栏项，避免任务栏重建后出现应用按钮。托盘、窗口、安装版与便携版 EXE 共用同一仪表盘图标。

制作无需安装的便携版：

```powershell
npm run dist:portable
```

从 `release/github-版本号/app/Codex Speed Pet.exe` 启动，或解压生成的便携 ZIP。保留同目录的 `build-kind.json`。便携包使用系统 WebView2，未安装时引导到微软下载页；缺少运行时的离线机器需要先安装 WebView2 Evergreen Standalone Installer x64。

## GitHub 更新与发布

安装版和便携版统一从 [GitHub Releases](https://github.com/Francis0927/CodexSpeedVisualizer/releases) 更新。正式打包的程序默认启用更新，开发环境不下载或安装更新。

- 启动后 5 秒、之后每 4 小时检查一次，也可在设置或托盘菜单手动检查。只检查正式版本。后台发现新版本时显示「有更新」标记并高亮设置按钮，保持当前窗口大小、折叠状态和正在使用的面板；打开设置后由用户点击「立即更新」。托盘手动检查发现新版时打开设置。
- 程序只运行一个实例，重复启动会显示已有窗口，避免多个透明窗口重叠闪烁。
- 安装版下载并校验安装包，然后启动安装程序并退出当前程序；由安装器写入的包类型标记识别安装版，支持自定义安装目录。
- 便携版下载并校验 ZIP，退出后在后台备份、替换程序文件并重新启动；替换失败尝试恢复备份，失败日志及保留的备份位置可用于排查。
- 更新从固定仓库读取，不需要用户配置共享目录或 GitHub 凭据。GitHub 无法连接或请求受限时显示错误，用户可稍后重试，也可从 Releases 手动下载。
- 下载后核对文件大小与 SHA-256；校验失败不安装。更新日志在用户数据目录的 `update.log` 和 `updater-script-last.log`。
- 所有 Electron 旧版（含内网版和无更新地址版）首次切换 Tauri 时手动升级一次：退出旧程序，安装版卸载旧程序后安装新版并保留用户数据；便携版解压到新目录运行。旧便携更新器只识别 Electron 载荷，不能直接自动切换纯 Tauri ZIP。之后统一使用 GitHub 更新。
- 设置与历史重置记录沿用 `%APPDATA%/Codex Speed Pet`，存在旧 npm 名称目录设置时兼容 `%APPDATA%/codex-speed-pet`。不会修改 Codex 会话或遗留 `update-share.json`。

### 版本与构建

版本以 `package.json` 的 `version` 为准，每次发布递增，不以同一版本发布不同内容。修改版本时同步 `src-tauri/Cargo.toml` 的 package version；Rust 构建会校验两者一致，Tauri 配置直接读取 package.json。

本地生成全部发布文件（保留用于离线构建和验证）：

```powershell
npm run dist:release
```

构建在隔离目录完成，不复制 Electron 目录或本机工具缓存。禁止把废弃配置、更新地址示例或本机内网地址带入包中。校验真实 EXE 的版本资源和只读诊断、GitHub 更新默认启用的行为，以及 NSIS 安装器实际载荷和便携 ZIP 的字节一致性。

NSIS 校验仅允许 Tauri 打包器将 EXE 中唯一的包类型标记 `UNK` 改为 `NSS`，其他字节必须完全一致；便携 ZIP 中的 EXE 必须与原始程序完全一致。Actions 另在隔离目录执行真实安装和自定义目录重装检查。

输出目录为 `release/github-x.y.z`；供上传的目录为 `release/GitHub-Release-vx.y.z`，仅包含以下四个附件：

- `Codex-Speed-Pet-Setup-x.y.z.exe`
- `Codex-Speed-Pet-portable-x.y.z.zip`
- `SHA256SUMS.txt`
- `README.txt`

### 一键发布

迁移分支 `codex/tauri-migration` 推送后会触发 **Windows branch build**，在 GitHub Windows runner 上执行测试、隔离构建、包校验及真实安装检查。四个标准文件保存在该次 Actions 的 `tauri-branch-v版本号-提交-次数` 产物中，保留 30 天；分支构建不创建标签或 Release，不进入客户端更新渠道。

```powershell
npm run publish:github -- -Notes "更新说明"
```

首次使用前，将 `.github/workflows/release.yml` 提交并推送到 GitHub 的默认分支，并启用仓库的 Actions。之后每次发布前将全部代码修改提交并推送到 GitHub；工作区必须干净。脚本检查或创建指向本次提交的 `vx.y.z` 标签，不覆盖已有标签。

本地脚本只从 `GH_TOKEN`、`GITHUB_TOKEN` 或 Git 凭据管理器读取凭据，需要仓库 **Contents 和 Actions 写权限**，不写入仓库、发布包或日志。Actions 使用内置 `GITHUB_TOKEN`，无需额外配置发布密钥。

流程：本地检查已推送提交和版本标签 → 触发 GitHub Actions → Windows runner 使用 npm/Cargo 锁文件运行统计对照、真实 WebView2/窗口测试、隔离构建和校验 → 保存已验证产物 → 创建或复用 GitHub 草稿 → 上传四个附件 → 核对服务器 SHA-256 与大小 → 正式发布。本地命令显示 Actions 链接并等待结果，失败或超时会返回错误；超时后先检查工作流状态。正式发布不读取或上传本机 `release/` 下的包。

也可在 GitHub 的 **Actions → Windows release → Run workflow** 中选择已推送的 `vx.y.z` 标签，填写 `notes` 发布说明；标签必须与包内版本一致，不能选择普通分支。`request_id` 可留空。工作流仅手动触发，普通代码推送不会发布。

上传前保存的 Actions 产物保留 90 天（受仓库保留策略限制）。上传失败保留草稿，重新执行发布命令或在 Actions 重新运行时，复用同版本、同提交的已验证产物并补齐附件；不会重新生成安装包。已有附件但保存产物过期或丢失时要求递增版本号。同名但大小或 SHA-256 不同的附件不覆盖，既有正式 Release 不改写。构建失败时另外保留可用的诊断产物 14 天，可从对应 Actions 运行页面下载。

已存在的同版本构建仅在输入和校验完全一致时复用。内容变化必须增加版本号。历史 Release 附件保持原样，新版使用上述名称。

### 本地产物清理

本地打包校验成功后使用 `scripts/prune-local-releases.ps1` 清理 `release/` 下可识别的旧版本包、历史无更新地址目录、上传目录和构建缓存；当前版本已完成的临时源码及便携目录也清理。Actions 构建在 runner 上执行相同的清理，不影响本机文件；发布命令本身不清理本机旧包。

打包失败保留旧包。保留当前和更高版本、未知文件、本机便携程序运行目录；不跟随符号链接或目录联接。文件占用导致清理失败时明确报告，释放占用后可重试。

```powershell
npm run prune:local -- -WhatIf
npm run prune:local
```

项目发布规则同时记录在 `AGENTS.md`。

## 统计口径

- 本机日历日 00:00 起，读取 `%CODEX_HOME%\sessions` 和 `%CODEX_HOME%\archived_sessions`。未设置 `CODEX_HOME` 时使用 `%USERPROFILE%\.codex`。
- 首选会话 JSONL 的 `token_usage_record`，按响应 ID 去重；旧格式可回退到 `token_count` 累计值差分。
- 今日累计 = 输入 token + 输出 token。缓存输入已计入输入 token，不再次相加。
- 历史累计统计本机当前可读取的所有 Codex 会话记录，安装前的记录也会计入。设置里的「统计 → 历史累计 → 重置」会保存重置时间，此后只累计该时间之后的记录；今日累计不受影响。若旧会话日志被删除，历史累计会相应减少。
- 历史累计下方显示 5 小时和一周的剩余额度百分比、进度条、重置时间（本机时区）。读取本机会话 `token_count.rate_limits` 中最新的共享 `codex` 额度快照，以窗口长度识别 300 分钟和 10080 分钟；额度事件即使没有 token 增量也会更新。剩余百分比 = 100 − 已用百分比；字段含义参见 [OpenAI 官方 App Server 文档](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)。额度是账户快照，不是从本机 token 总量推算；没有数据时显示「暂无数据」，到达重置时间后显示「待刷新」，等待 Codex 新事件确认。重置历史累计不影响额度。
- 输出速度 = 近期输出 token 的指数加权均值（τ≈15 秒）：每条用量事件按 `token × e^(-距今/τ) ÷ τ秒` 计入，低于 0.5 token/s 归零。用量通常在每轮完成后写入，所以曲线是**平滑后的估算**，不是逐 token 生成速度；12 秒无新事件后状态显示待机。详情面板另有「上轮平均速度」= 最近一轮的输出 token ÷ 轮耗时，更贴近该轮的真实生成速率。
- 只统计本机可访问的 Codex 会话。其他设备和云端任务不包含在内。本地记录格式可能随 Codex 版本变化。

应用只读取用量及轮次字段，统计数据不上传。窗口位置和偏好保存在兼容旧版的本机用户数据目录，原始会话文件不会被修改。

## 采集性能

- 运行时通过目录变动通知记录待检查文件，每 2 秒增量读取并更新速度；没有变动时复用统计汇总，不重复查询全部文件或遍历历史事件。每 30 秒全量发现并校验一次，补偿丢失的通知；通知不可用时回退到每 2 秒扫描。
- 轮次匹配和每日统计在读取时缓存。旧日期仅保留每日汇总、最新状态和精确去重所需的响应 ID；当天及未来日期的必要明细使用紧凑数值缓存，跨日释放。响应 ID 索引仍随独立响应数量增长。
- 半行日志按片段缓存，仅在完整行到达时合并一次，处理后释放缓冲区。文件删除、截断、替换、去重优先级改变或历史重置时重新读取校准；启动和这些校准操作仍需读取历史日志。
- 普通变动通常在下一次 2 秒刷新时处理；遗漏通知最迟等待下一次 30 秒兜底校验。

可复现构造样本的性能测试（旧 Node 参考实现；结果不是整机或桌面应用进程树的 CPU / 内存占用）：

```powershell
node --expose-gc scripts/benchmark-usage.cjs
# 对比同一批输入；旧实现文件需要单独保存
node --expose-gc scripts/benchmark-usage.cjs --baseline C:\path\usage-before.cjs
```

迁移后的相同输入对比：先构建 Rust release，再运行 `node scripts/benchmark-tauri.cjs`。它使用 10 万条构造记录，比较扫描耗时、快照耗时和采集器 CLI 进程内存；不包含 WebView2 子进程，不能作为整个桌面应用的内存结论。

## 开发验证

```powershell
npm test
npm run test:window
npm run test:topmost
npm run build
```

`npm test` 包含旧行为参考、Rust 单元测试、Node/Rust 逐快照对照和便携更新助手测试。`test:window` 使用真实 WebView2 检查界面与设置兼容，`test:topmost` 检查 Windows 原生标志与层级。测试使用临时目录，不修改实际用户设置或 Codex 会话。

若要单独预览界面，可运行 `npm run dev` 并打开 `http://127.0.0.1:5173`；浏览器预览没有本地采集和托盘功能。`npm start` 启动完整 Tauri 开发应用，开发构建不安装更新。
