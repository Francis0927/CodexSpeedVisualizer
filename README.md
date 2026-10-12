# Codex Drive

Windows 桌面汽车指针仪表盘，显示本机 Codex 的输出速度、今日与历史累计 token，以及 5 小时和一周的剩余额度。窗口有小、中、大三档。

三档窗口宽度约为：小 150、中 223、大 286 像素。展开时高度随实际内容变化；平时保留仪表盘与速度/累计卡片，高度随字号和内容调整。

底部累计与额度文字保持最低字号：标签至少 12–14 px，额度数字至少 18 px，重置时间至少 12 px；不会跟随小档窗口缩成难以阅读的小字。

## 运行

需要 Node.js 18+。

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

Windows 开启「始终置顶」后，窗口显示、恢复或失去焦点时会恢复到前方，并每秒维护一次置顶顺序，处理后来出现的其他置顶窗口。恢复层级不会抢走其他应用的输入焦点；关闭置顶、隐藏、最小化或退出后停止维护。

制作无需安装的便携版：

```powershell
npm run dist:portable
```

从 `release/Codex-Speed-Pet-portable/Codex Speed Pet.exe` 启动。请保留该文件夹的其他运行时文件。

## 局域网更新

应用内置基于局域网共享目录的自动更新。更新地址从本机配置文件 `electron/update-share.json` 读取，发布脚本也使用同一配置；该文件已加入忽略规则，后续提交不会包含它。

共享目录里由发布脚本维护三个文件：

- `version.json`：版本号、更新说明、安装包与便携版文件名
- `Codex Speed Pet Setup x.x.x.exe`：NSIS 安装包（安装版客户端使用）
- `Codex-Speed-Pet-portable-x.x.x.zip`：便携版压缩包（便携版客户端使用）

客户端启动后和每 4 小时自动检查一次，也可在「设置 → 系统 → 版本更新」手动检查；发现新版本后点「立即更新」。安装版会下载安装包并启动安装程序覆盖安装；便携版会下载压缩包、在后台替换自身文件并自动重启。更新过程日志保存在用户数据目录的 `update.log`。

发布流程见下文「发包规则」。

## 发包规则

### 版本号

- 版本号以 `package.json` 的 `version` 字段为准，它是客户端判断「有没有新版本」的唯一依据，**每次发版必须单调递增**：修复问题 +0.0.1，新增功能 +0.1.0。
- 修改方式：`npm version x.y.z --no-git-tag-version`（或手工改 `package.json`）。
- 禁止用相同版本号重复发布不同内容的包——客户端版本相等就永远不会更新。

### 发布目录配置

- 复制示例配置：`Copy-Item electron/update-share.example.json electron/update-share.json`。
- 在 `electron/update-share.json` 的 `share` 字段填入共享目录的 UNC 路径。JSON 中每个反斜杠要写成两个，例如 `\\\\server\\share\\CodexSpeedVisualizer`。此文件只保存在本机，已加入 `.gitignore`。 若该地址此前已提交，忽略规则不会清除 Git 历史中的内容。
- 客户端与发布脚本都读取该配置。改路径后必须重新打包，新包才会指向新目录；已有客户端仍指向原目录。未配置时应用仍可运行，但更新功能不可用，发布脚本会提示缺少配置。
- **编码规则**：带中文的 `.ps1` 文件保存为 UTF-8 带 BOM；JSON 配置保存为 UTF-8，发布脚本会明确按 UTF-8 读取。

### 一键发布

```powershell
npm run publish:share -- -Notes "更新说明"
```

- 前置条件：关闭所有正在运行的 Codex Speed Pet；共享目录可访问且有写权限；该版本代码已提交并推送到 GitHub，并配置具有仓库 Contents 写权限的 GitHub 凭据。发布用便携包在 `release/.publish-portable-版本号-随机ID` 独立目录构建，不清空本机便携版目录，避免运行库文件占用导致目录被部分删除。
- 脚本要求新版本号高于共享目录当前版本。流程：检查版本、运行实例和 GitHub 权限/源提交 → 构建局域网 NSIS 安装包和便携版 → 在隔离目录构建并校验无更新地址版 → 上传 GitHub 草稿并校验附件后公开 Release → 上传并校验局域网包 → 更新 `version.json` → 删除共享目录内该应用的旧版本 exe/zip。任一渠道失败都不算发布全部成功；GitHub 阶段失败不会更新局域网版本清单。
- 上传或构建失败时可排障后重跑；若 `version.json` 已更新而清理旧文件失败，可单独运行 `scripts/prune-share-releases.ps1` 补做清理。

### 共享目录规则

- 权限：客户端账号**只读**，发布账号**读写**。能写共享目录的人就能向所有客户端推送可执行文件，写权限务必只放给发布账号。
- 目录内容只由发布脚本维护，不要手工增删文件；手工改动可能在下次发布时被覆盖。
- 发布成功后只保留 `version.json` 引用的当前版本安装包和便携版压缩包。清理脚本只匹配本应用的旧版本文件，不会删除当前版本或其他文件。

### GitHub 无更新地址版（每次发布必需）

- 每次新版本必须另外发布无更新地址版到 [当前仓库的 GitHub Releases](https://github.com/Francis0927/CodexSpeedVisualizer/releases)，标签为 `v版本号`，指向对应源代码提交。
- 安装包与便携 ZIP 都在隔离目录构建，排除 `electron/update-share.json` 和更新地址示例文件；打包后检查实际 `app.asar`、版本、默认禁用更新的行为及便携 ZIP 内的同一运行载荷。原有本机配置保留，不移动或删除。
- GitHub 只上传 `Codex-Speed-Pet-Setup-x.y.z-no-update.exe`、`Codex-Speed-Pet-portable-x.y.z-no-update.zip`、`SHA256SUMS.txt`、`README-no-update.txt`，禁止上传包含局域网更新地址的包。
- 构建输出保存在 `release/no-update-x.y.z`。相同版本重试时复用已验证产物；上传失败保留草稿，重试补齐缺失附件。相同名称但 SHA-256 不同的已有附件不会覆盖。两份包校验值见随包的 `SHA256SUMS.txt`。
- 手动上传时使用 `release/GitHub-Release-vx.y.z`，该目录仅包含要上传的四个附件。在 GitHub 的 Releases → Draft a new release 中选择 `vx.y.z` 标签和对应提交，将目录中的四个文件拖入附件框，等待上传完成后点击 Publish release。构建目录中的子目录、调试文件、`.blockmap` 和验证索引不需要上传。
- 上传通过 GitHub API，优先读取 `GH_TOKEN` / `GITHUB_TOKEN`，否则尝试已配置的 Git 凭据管理器；凭据不会写入仓库、发布包或日志。无认证或源提交尚未推送时，前置检查直接失败。

单独生成无更新地址版，或补做 GitHub 发布：

```powershell
npm run dist:no-update
npm run publish:github -- -Notes "更新说明"
```

`npm run publish:share` 已包含无更新地址版构建与 GitHub 上传步骤；只有共享目录与 GitHub 两个渠道均完成，才报告发布成功。项目规则同时记录在 `AGENTS.md`。

### 客户端更新行为（发版后的预期）

- 客户端启动后 5 秒、之后每 4 小时自动检查一次；也可在「设置 → 系统 → 版本更新 → 检查更新」手动触发。
- 安装版：下载安装包 → 退出并启动安装程序覆盖安装。
- 便携版：下载压缩包 → 后台整体替换自身文件 → 自动重启。
- 更新日志写在客户端用户数据目录的 `update.log`，排查更新问题时先看它。
- 内置旧共享目录路径的客户端需要先手工覆盖一次新版本，之后才能自动更新。

## 统计口径

- 本机日历日 00:00 起，读取 `%CODEX_HOME%\sessions` 和 `%CODEX_HOME%\archived_sessions`。未设置 `CODEX_HOME` 时使用 `%USERPROFILE%\.codex`。
- 首选会话 JSONL 的 `token_usage_record`，按响应 ID 去重；旧格式可回退到 `token_count` 累计值差分。
- 今日累计 = 输入 token + 输出 token。缓存输入已计入输入 token，不再次相加。
- 历史累计统计本机当前可读取的所有 Codex 会话记录，安装前的记录也会计入。设置里的「统计 → 历史累计 → 重置」会保存重置时间，此后只累计该时间之后的记录；今日累计不受影响。若旧会话日志被删除，历史累计会相应减少。
- 历史累计下方显示 5 小时和一周的剩余额度百分比、进度条、重置时间（本机时区）。读取本机会话 `token_count.rate_limits` 中最新的共享 `codex` 额度快照，以窗口长度识别 300 分钟和 10080 分钟；额度事件即使没有 token 增量也会更新。剩余百分比 = 100 − 已用百分比；字段含义参见 [OpenAI 官方 App Server 文档](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)。额度是账户快照，不是从本机 token 总量推算；没有数据时显示「暂无数据」，到达重置时间后显示「待刷新」，等待 Codex 新事件确认。重置历史累计不影响额度。
- 输出速度 = 近期输出 token 的指数加权均值（τ≈15 秒）：每条用量事件按 `token × e^(-距今/τ) ÷ τ秒` 计入，低于 0.5 token/s 归零。用量通常在每轮完成后写入，所以曲线是**平滑后的估算**，不是逐 token 生成速度；12 秒无新事件后状态显示待机。详情面板另有「上轮平均速度」= 最近一轮的输出 token ÷ 轮耗时，更贴近该轮的真实生成速率。
- 只统计本机可访问的 Codex 会话。其他设备和云端任务不包含在内。本地记录格式可能随 Codex 版本变化。

应用只读取用量字段，统计数据不上传。窗口位置和偏好保存在 Electron 的本机用户数据目录。原始会话文件不会被修改。

## 采集性能

- 运行时通过目录变动通知记录待检查文件，每 2 秒增量读取并更新速度；没有变动时复用统计汇总，不重复查询全部文件或遍历历史事件。每 30 秒全量发现并校验一次，补偿丢失的通知；通知不可用时回退到每 2 秒扫描。
- 轮次匹配和每日统计在读取时缓存。旧日期仅保留每日汇总、最新状态和精确去重所需的响应 ID；当天及未来日期的必要明细使用紧凑数值缓存，跨日释放。响应 ID 索引仍随独立响应数量增长。
- 半行日志按片段缓存，仅在完整行到达时合并一次，处理后释放缓冲区。文件删除、截断、替换、去重优先级改变或历史重置时重新读取校准；启动和这些校准操作仍需读取历史日志。
- 普通变动通常在下一次 2 秒刷新时处理；遗漏通知最迟等待下一次 30 秒兜底校验。

可复现构造样本的性能测试（使用 Node.js 运行，结果不是整机或整个 Electron 应用的 CPU / 内存占用）：

```powershell
node --expose-gc scripts/benchmark-usage.cjs
# 对比同一批输入；旧实现文件需要单独保存
node --expose-gc scripts/benchmark-usage.cjs --baseline C:\path\usage-before.cjs
```

## 开发验证

```powershell
npm test
npm run test:window
npm run test:topmost
npm run build
```

若要单独预览界面，可运行 `npm run dev` 并打开 `http://127.0.0.1:5173`；浏览器预览没有本地采集和托盘功能。
