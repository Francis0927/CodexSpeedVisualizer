import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AppInfo, AppSettings, QuotaWindow, UpdateStatus, UsageSnapshot } from "./env";

const EMPTY: UsageSnapshot = {
  day: null, input: 0, output: 0, total: 0, historyTotal: 0, rateLimits: null, speed: 0, turnSpeed: null, turnTokens: null, turnSeconds: null,
  active: false, running: false, lastEvent: null, eventCount: 0, source: "waiting", error: null
};
const DEFAULT_SETTINGS: AppSettings = { alwaysOnTop: true, reducedMotion: false, launchAtLogin: false, size: "medium", autoHideChrome: true };
const SIZE_SCALE = { small: 0.55, medium: 0.82, large: 1.05 };

function shortCount(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString("zh-CN");
}

function fullCount(value: number) { return value.toLocaleString("zh-CN"); }

function lastSeen(value: number | null) {
  if (!value) return "暂无用量事件";
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function resetTime(value: number) {
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function QuotaRow({ label, quota, now }: { label: string; quota: QuotaWindow | null; now: number }) {
  const expired = quota?.resetsAt != null && quota.resetsAt <= now;
  const remaining = quota && !expired ? quota.remainingPercent : null;
  const percent = remaining === null ? null : `${Number(remaining.toFixed(1))}%`;
  return <div className={`quota-row ${remaining !== null && remaining <= 20 ? "quota-low" : ""}`}>
    <div className="quota-heading"><span>{label}</span><strong aria-label={percent === null ? undefined : `剩余 ${percent}`}>{percent === null ? expired ? "待刷新" : "暂无数据" : percent}</strong></div>
    <div className="quota-track" role={remaining === null ? undefined : "progressbar"} aria-label={`${label}剩余额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining ?? undefined}>
      <div className="quota-fill" style={{ width: `${remaining ?? 0}%` }} />
    </div>
    <div className="quota-reset">{quota?.resetsAt != null ? `重置 ${resetTime(quota.resetsAt)}` : "重置时间暂无"}</div>
  </div>;
}

// Browser preview helper: ?size=small|medium|large
function devSettingsOverride(): Partial<AppSettings> {
  if (window.speedPet) return {};
  const params = new URLSearchParams(window.location.search);
  const patch: Partial<AppSettings> = {};
  const size = params.get("size");
  if (size === "small" || size === "medium" || size === "large") patch.viewSize = size;
  return patch;
}

function dialPoint(angle: number, radius: number): [number, number] {
  const radians = angle * Math.PI / 180;
  return [110 + radius * Math.cos(radians), 105 + radius * Math.sin(radians)];
}

function dialArc(start: number, end: number, radius: number) {
  const [x1, y1] = dialPoint(start, radius);
  const [x2, y2] = dialPoint(end, radius);
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

function Gauge({ speed }: { speed: number }) {
  const maximum = [200, 400, 800, 1600, 3200].find((value) => speed <= value) || 6400;
  const ratio = Math.min(speed / maximum, 1);
  const angle = 150 + ratio * 240;
  const ticks = Array.from({ length: 13 }, (_, index) => {
    const tickAngle = 150 + index * 20;
    const major = index % 3 === 0;
    const [x1, y1] = dialPoint(tickAngle, major ? 84 : 88);
    const [x2, y2] = dialPoint(tickAngle, 95);
    return <line key={index} x1={x1} y1={y1} x2={x2} y2={y2} className={major ? "gauge-tick major" : "gauge-tick"} />;
  });
  return <div className="gauge-wrap" role="img" aria-label={`汽车仪表盘，输出速度 ${speed.toFixed(1)} token 每秒，刻度上限 ${maximum}`}>
    <svg className="gauge-art" viewBox="0 0 220 175" aria-hidden="true">
      <defs>
        <radialGradient id="dial-face"><stop stopColor="#174858"/><stop offset=".76" stopColor="#112f3c"/><stop offset="1" stopColor="#0a2432"/></radialGradient>
        <linearGradient id="dial-progress" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#54e9c5"/><stop offset="1" stopColor="#bcff93"/></linearGradient>
        <filter id="needle-glow"><feGaussianBlur stdDeviation="2.5"/></filter>
      </defs>
      <circle cx="110" cy="105" r="101" fill="#061e2b" stroke="#467577" strokeWidth="2" />
      <circle cx="110" cy="105" r="99" fill="none" stroke="#0d4248" strokeWidth="5" />
      <circle cx="110" cy="105" r="82" fill="url(#dial-face)" stroke="#2b6870" strokeWidth="1.5" />
      <path d={dialArc(150, 390, 76)} className="gauge-track" />
      {ratio > 0 && <path d={dialArc(150, angle, 76)} className="gauge-progress" />}
      <path d={dialArc(350, 390, 76)} className="gauge-redline" />
      {ticks}
      <text x="41" y="148" className="gauge-scale">0</text>
      <text x="179" y="148" textAnchor="end" className="gauge-scale">{maximum}</text>
      <text x="110" y="62" textAnchor="middle" className="gauge-title">TOKEN SPEED</text>
      <g className="gauge-needle" style={{ transform: `rotate(${-120 + ratio * 240}deg)` }}>
        <path d="M106 109 L110 36 L114 109Z" fill="#ff805d" opacity=".5" filter="url(#needle-glow)" />
        <path d="M107.5 110 L110 39 L112.5 110Z" fill="#ff9b67" />
      </g>
      <circle cx="110" cy="105" r="10" fill="#092a36" stroke="#ffa573" strokeWidth="3" />
      <circle cx="110" cy="105" r="3" fill="#fff2d3" />
      <rect x="73" y="126" width="74" height="26" rx="7" fill="#09212d" stroke="#2d6267" />
      <text x="110" y="143" textAnchor="middle" className="gauge-digital">{speed >= 10 ? speed.toFixed(0) : speed.toFixed(1)}<tspan className="gauge-unit"> /s</tspan></text>
    </svg>
  </div>;
}

function Toggle({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className={`toggle-row ${disabled ? "disabled" : ""}`}>
    <span>{label}</span>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
    <span className="switch" />
  </label>;
}

const IDLE_UPDATE: UpdateStatus = { state: "idle", version: null, notes: null, message: null };
const DEFAULT_APP_INFO: AppInfo = { version: "", buildKind: "dev", updateEnabled: false };

export default function App() {
  const [usage, setUsage] = useState<UsageSnapshot>(EMPTY);
  const [settings, setSettings] = useState<AppSettings>(() => ({ ...DEFAULT_SETTINGS, ...devSettingsOverride() }));
  const [panel, setPanel] = useState<"none" | "details" | "settings">("none");
  const [clock, setClock] = useState(Date.now());
  const [appInfo, setAppInfo] = useState<AppInfo>(DEFAULT_APP_INFO);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(IDLE_UPDATE);
  const [confirmHistoryReset, setConfirmHistoryReset] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [hovered, setHovered] = useState(false);
  const hasHovered = useRef(false);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;
    window.speedPet?.getInitial().then((initial) => {
      if (mounted) { setUsage(initial.usage); setSettings(initial.settings); setAppInfo(initial.appInfo); }
    });
    const offUsage = window.speedPet?.onUsage(setUsage);
    const offSettings = window.speedPet?.onSettings(setSettings);
    const offUpdate = window.speedPet?.onUpdateStatus((status) => {
      setUpdateStatus(status);
      if (status.state === "available") setPanel("settings");
    });
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => { mounted = false; offUsage?.(); offSettings?.(); offUpdate?.(); clearInterval(timer); };
  }, []);

  // While a panel is open the main process enlarges the window (small -> medium)
  // so the panel stays readable, and restores the configured size on close.
  useEffect(() => { window.speedPet?.setPanelOpen(panel !== "none"); }, [panel]);
  useEffect(() => { setConfirmHistoryReset(false); }, [panel]);

  // Keep the dial and speed/totals card visible; fold the header and quotas.
  // Hover and open panels keep the window expanded for as long as needed.
  useEffect(() => {
    if (!settings.autoHideChrome || hovered || panel !== "none") {
      setExpanded(true);
      return;
    }
    const timer = setTimeout(() => setExpanded(false), hasHovered.current ? 1600 : 4000);
    return () => clearTimeout(timer);
  }, [settings.autoHideChrome, hovered, panel]);
  const collapsed = settings.autoHideChrome && !expanded && panel === "none";

  const active = usage.source !== "error" && usage.active && usage.lastEvent !== null && clock - usage.lastEvent <= 12000;
  // The main process already smooths (EMA) and zeroes the speed; no extra cutoff here.
  const speed = usage.source !== "error" ? usage.speed : 0;
  const running = usage.source !== "error" && usage.running;
  const status = usage.source === "error" ? "读取失败" : usage.source === "waiting" ? "等待 Codex" : running ? "正在工作" : active ? "正在更新" : "待机中";
  const speedLabel = speed >= 10 ? speed.toFixed(0) : speed.toFixed(1);
  const update = (patch: Partial<AppSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
    window.speedPet?.updateSettings(patch).then(setSettings);
  };
  const checkUpdate = () => { setUpdateStatus((s) => ({ ...s, state: "checking" })); window.speedPet?.checkUpdate().then(setUpdateStatus); };
  const installUpdate = () => { window.speedPet?.installUpdate().then(setUpdateStatus); };
  const resetHistory = () => {
    if (!confirmHistoryReset) { setConfirmHistoryReset(true); return; }
    window.speedPet?.resetHistory().then(setUsage).finally(() => setConfirmHistoryReset(false));
  };
  const updateBusy = updateStatus.state === "checking" || updateStatus.state === "downloading" || updateStatus.state === "installing";
  const updateLabel = updateStatus.state === "checking" ? "正在检查更新…"
    : updateStatus.state === "latest" ? `已是最新（v${appInfo.version}）`
    : updateStatus.state === "available" ? `发现新版本 v${updateStatus.version}${updateStatus.notes ? `：${updateStatus.notes}` : ""}`
    : updateStatus.state === "downloading" ? "正在下载更新文件…"
    : updateStatus.state === "installing" ? "正在安装，应用将自动重启…"
    : updateStatus.state === "error" ? updateStatus.message || "检查更新失败"
    : updateStatus.state === "unsupported" ? "当前环境不支持更新"
    : `当前版本 v${appInfo.version || "-"}`;
  const viewSize = settings.viewSize ?? settings.size;
  const scale = SIZE_SCALE[viewSize] || 1;

  // Measure layout pixels before CSS zoom so Electron gets the physical size,
  // including wrapped text, panels, and both folded and expanded states.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const reportSize = () => window.speedPet?.setContentSize({
      viewSize, height: Math.ceil(viewport.offsetHeight * scale)
    });
    const observer = new ResizeObserver(reportSize);
    observer.observe(viewport);
    reportSize();
    return () => observer.disconnect();
  }, [viewSize, scale, collapsed, panel]);

  // Layout zoom keeps text crisp when live usage updates repaint the window.
  return <div ref={viewportRef} className="viewport" style={{ zoom: scale, "--text-scale": Math.max(1, 1 / scale) } as CSSProperties}><main
    className={`shell view-${viewSize} ${settings.reducedMotion ? "reduce-motion" : ""} ${collapsed ? "is-collapsed" : ""}`}
    onMouseEnter={() => { hasHovered.current = true; setHovered(true); setExpanded(true); }}
    onMouseLeave={() => setHovered(false)}
    onClick={() => setExpanded(true)}>
    <div className="window-header">
    <div className="topbar">
      <div className="brand"><span className="brand-icon">✦</span><span>CODEX <strong>DRIVE</strong></span></div>
      <div className="window-actions">
        <button type="button" className="icon-button" title="设置" aria-label="设置" onClick={() => setPanel(panel === "settings" ? "none" : "settings")}>⚙</button>
        <button type="button" className="icon-button" title="隐藏到托盘" aria-label="隐藏到托盘" onClick={() => window.speedPet?.hide()}>−</button>
      </div>
    </div>

    <div className="status"><span className={`status-light ${active || running ? "lit" : ""}`} /><span>{status}</span><span className="status-right">LOCAL</span></div>
    </div>
    <Gauge speed={speed} />

    <div className="statistics">
    <button type="button" className="speed-card" onClick={() => setPanel(panel === "details" ? "none" : "details")} title="查看统计详情">
      <div className="speed-top"><span>输出速度</span><span className="live-tag">平滑</span></div>
      <div className="speed-number"><strong>{speedLabel}</strong><span>token/s</span></div>
      <div className="today-line"><span>今日累计</span><strong>{shortCount(usage.total)} <small>token</small></strong></div>
      <div className="history-line"><span>历史累计</span><strong>{shortCount(usage.historyTotal)} <small>token</small></strong></div>
    </button>

    <section className="quota-card" aria-label="Codex 剩余额度">
      <div className="quota-title"><span>剩余额度</span><span title={usage.rateLimits ? `额度数据更新于 ${new Date(usage.rateLimits.updatedAt).toLocaleString("zh-CN")}` : "开始使用 Codex 后自动读取额度"}>
        {usage.source === "error" ? "读取失败" : usage.rateLimits ? lastSeen(usage.rateLimits.updatedAt).slice(0, 5) : "等待同步"}
      </span></div>
      <QuotaRow label="5 小时" quota={usage.rateLimits?.fiveHour ?? null} now={clock} />
      <QuotaRow label="一周" quota={usage.rateLimits?.weekly ?? null} now={clock} />
    </section>
    </div>

    {panel !== "none" && <div className="overlay">
      <div className="panel-head"><strong>{panel === "details" ? "用量详情" : "偏好设置"}</strong><button type="button" className="panel-close" aria-label="关闭" onClick={() => setPanel("none")}>×</button></div>
      <div className="panel-body">
      {panel === "details" ? <>
        <div className="detail-total">{fullCount(usage.total)} <span>token</span></div>
        <div className="detail-row"><span>历史累计</span><strong>{fullCount(usage.historyTotal)} token</strong></div>
        <div className="detail-row"><span>输入</span><strong>{fullCount(usage.input)}</strong></div>
        <div className="detail-row"><span>输出</span><strong>{fullCount(usage.output)}</strong></div>
        <div className="detail-row"><span>最后更新</span><strong>{lastSeen(usage.lastEvent)}</strong></div>
        <div className="detail-row"><span>上轮平均速度</span><strong>{usage.turnSpeed === null ? "暂无" : `${usage.turnSpeed >= 10 ? usage.turnSpeed.toFixed(0) : usage.turnSpeed.toFixed(1)} token/s`}</strong></div>
        {usage.turnTokens !== null && usage.turnSeconds !== null && <div className="detail-row"><span>上轮规模</span><strong>{fullCount(usage.turnTokens)} token / {usage.turnSeconds} 秒</strong></div>}
        <div className="detail-row"><span>额度更新</span><strong>{usage.rateLimits ? resetTime(usage.rateLimits.updatedAt) : "暂无数据"}</strong></div>
        <p className="panel-note">额度为本机日志中最新的 Codex 账户快照，随 Codex 用量事件更新。到达重置时间后等待新数据确认；重置历史累计不影响账户额度。</p>
        <p className="panel-note">统计本机 Codex 会话。速度为近期输出 token 的指数加权均值（τ≈15 秒）；上轮平均速度 = 最近一轮的输出 token ÷ 轮耗时。输入已包含缓存 token。</p>
        {usage.error && <p className="error-note">{usage.error}</p>}
      </> : <>
        <div className="settings-section">窗口</div>
        <div className="preference-choice"><span>窗口大小</span><div className="segmented" role="group" aria-label="窗口大小">
          <button type="button" aria-pressed={settings.size === "small"} onClick={() => update({ size: "small" })}>小</button>
          <button type="button" aria-pressed={settings.size === "medium"} onClick={() => update({ size: "medium" })}>中</button>
          <button type="button" aria-pressed={settings.size === "large"} onClick={() => update({ size: "large" })}>大</button>
        </div></div>
        <Toggle label="始终置顶" checked={settings.alwaysOnTop} onChange={(alwaysOnTop) => update({ alwaysOnTop })} />
        <Toggle label="减少动画" checked={settings.reducedMotion} onChange={(reducedMotion) => update({ reducedMotion })} />
        <Toggle label="自动折叠窗口" checked={settings.autoHideChrome} onChange={(autoHideChrome) => update({ autoHideChrome })} />
        <div className="settings-section">系统</div>
        {appInfo.updateEnabled && <div className="update-row">
          <div className="update-info"><span>版本更新</span><small className={updateStatus.state === "error" ? "update-error" : updateStatus.state === "available" ? "update-highlight" : ""}>{updateLabel}</small></div>
          {updateStatus.state === "available"
            ? <button type="button" className="mini-button update-now" onClick={installUpdate} disabled={updateBusy}>立即更新</button>
            : <button type="button" className="mini-button" onClick={checkUpdate} disabled={updateBusy}>{updateStatus.state === "checking" ? "检查中" : "检查更新"}</button>}
        </div>}
        <Toggle label="开机启动" checked={settings.launchAtLogin} onChange={(launchAtLogin) => update({ launchAtLogin })} disabled={!window.speedPet} />
        <div className="settings-section">统计</div>
        <div className="history-reset-row">
          <div className="update-info"><span>历史累计</span><small>当前 {fullCount(usage.historyTotal)} token；重置后从此刻重新累计</small></div>
          {confirmHistoryReset && <button type="button" className="mini-button" onClick={() => setConfirmHistoryReset(false)}>取消</button>}
          <button type="button" className="mini-button" onClick={resetHistory} disabled={!window.speedPet}>{confirmHistoryReset ? "确认重置" : "重置"}</button>
        </div>
        <p className="panel-note settings-note">拖动顶部移动。平时保留仪表盘、速度与累计，鼠标移入展开标题和额度。设置和详情打开时保持展开。</p>
        <button type="button" className="quit-button" onClick={() => window.speedPet?.quit()}>退出应用</button>
      </>}
      </div>
    </div>}
  </main></div>;
}
