import { useEffect, useRef, useState } from "react";
import type { AppInfo, PetSettings, UpdateStatus, UsageSnapshot } from "./env";

const EMPTY: UsageSnapshot = {
  day: null, input: 0, output: 0, total: 0, historyTotal: 0, speed: 0, turnSpeed: null, turnTokens: null, turnSeconds: null,
  active: false, running: false, lastEvent: null, eventCount: 0, source: "waiting", error: null
};
const DEFAULT_SETTINGS: PetSettings = { alwaysOnTop: true, reducedMotion: false, launchAtLogin: false, style: "pet", size: "medium", petImage: null, autoHideChrome: true };
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

// Settings store only the file name; the main process serves the bytes through
// the speedpet:// scheme. Full URLs are passed through so the browser preview
// (?pet=https://...) can use any reachable image.
function petImageUrl(image: string) {
  if (/^(https?|data|file|speedpet):/i.test(image)) return image;
  return `speedpet://pet/${encodeURIComponent(image)}`;
}

// Browser preview helper: ?size=small|medium|large&style=pet|gauge&pet=<url>
function devSettingsOverride(): Partial<PetSettings> {
  if (window.speedPet) return {};
  const params = new URLSearchParams(window.location.search);
  const patch: Partial<PetSettings> = {};
  const size = params.get("size");
  if (size === "small" || size === "medium" || size === "large") patch.viewSize = size;
  const style = params.get("style");
  if (style === "pet" || style === "gauge") patch.style = style;
  const pet = params.get("pet");
  if (pet) patch.petImage = pet;
  return patch;
}

function DefaultPetArt() {
  return <svg className="pet-art" viewBox="0 0 220 190" role="img" aria-hidden="true">
    <defs>
      <linearGradient id="body" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#adffbb"/><stop offset=".52" stopColor="#63e5be"/><stop offset="1" stopColor="#22baa9"/></linearGradient>
      <linearGradient id="ear" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#8cffe0"/><stop offset="1" stopColor="#31bdba"/></linearGradient>
      <linearGradient id="belly" x1="0" y1="0" x2=".5" y2="1"><stop stopColor="#ecfff4" stopOpacity=".75"/><stop offset="1" stopColor="#b7f7e4" stopOpacity=".25"/></linearGradient>
      <filter id="shadow"><feGaussianBlur stdDeviation="5"/></filter>
    </defs>
    <ellipse cx="110" cy="176" rx="62" ry="9" fill="#0a856f" opacity=".22" filter="url(#shadow)"/>
    <path d="M49 76 Q22 52 34 29 Q62 33 80 54" fill="url(#ear)" stroke="#106c70" strokeWidth="4" strokeLinejoin="round"/>
    <path d="M171 76 Q198 52 186 29 Q158 33 140 54" fill="url(#ear)" stroke="#106c70" strokeWidth="4" strokeLinejoin="round"/>
    <path d="M48 73 C54 39 82 35 110 38 C138 35 166 39 172 73 C188 87 184 143 159 159 C138 177 82 177 61 159 C36 143 32 87 48 73Z" fill="url(#body)" stroke="#106c70" strokeWidth="4"/>
    <ellipse cx="110" cy="130" rx="49" ry="31" fill="url(#belly)"/>
    <path d="M74 159 Q69 175 82 177 Q96 181 101 165" fill="#35bdaa" stroke="#106c70" strokeWidth="4"/>
    <path d="M146 159 Q151 175 138 177 Q124 181 119 165" fill="#35bdaa" stroke="#106c70" strokeWidth="4"/>
    <circle cx="45" cy="116" r="10" fill="#48d6b4" stroke="#106c70" strokeWidth="3"/>
    <circle cx="175" cy="116" r="10" fill="#48d6b4" stroke="#106c70" strokeWidth="3"/>
    <ellipse cx="82" cy="94" rx="7" ry="10" fill="#163e4e" className="pet-eye"/>
    <ellipse cx="138" cy="94" rx="7" ry="10" fill="#163e4e" className="pet-eye"/>
    <circle cx="80" cy="90" r="2.5" fill="#fff"/><circle cx="136" cy="90" r="2.5" fill="#fff"/>
    <ellipse cx="65" cy="112" rx="11" ry="6" fill="#ff93a3" opacity=".65"/>
    <ellipse cx="155" cy="112" rx="11" ry="6" fill="#ff93a3" opacity=".65"/>
    <path d="M99 111 Q110 124 121 111" fill="none" stroke="#17515a" strokeWidth="4" strokeLinecap="round"/>
    <path d="M102 54 Q110 50 118 54" fill="none" stroke="#dcfff2" strokeOpacity=".65" strokeWidth="4" strokeLinecap="round"/>
    <circle className="pet-spark spark-a" cx="29" cy="84" r="4" fill="#d2ff82"/>
    <circle className="pet-spark spark-b" cx="194" cy="98" r="5" fill="#d2ff82"/>
  </svg>;
}

function Pet({ mood, image }: { mood: "idle" | "working" | "fast"; image: string | null }) {
  return <div className={`pet-wrap pet-${mood}`} aria-label={`宠物状态：${mood === "idle" ? "待机" : mood === "fast" ? "加速" : "工作"}`}>
    <div className="pet-glow" />
    {image
      ? <img className="pet-art pet-custom" src={petImageUrl(image)} alt="" draggable={false} />
      : <DefaultPetArt />}
  </div>;
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
  const [settings, setSettings] = useState<PetSettings>(() => ({ ...DEFAULT_SETTINGS, ...devSettingsOverride() }));
  const [panel, setPanel] = useState<"none" | "details" | "settings">("none");
  const [clock, setClock] = useState(Date.now());
  const [appInfo, setAppInfo] = useState<AppInfo>(DEFAULT_APP_INFO);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(IDLE_UPDATE);
  const [confirmHistoryReset, setConfirmHistoryReset] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const chromeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverRef = useRef(false);

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

  // Auto-hide the window chrome (title bar + status row): it fades out after a
  // few seconds and reappears on hover/click. Panels force it visible.
  const clearChromeTimer = () => { if (chromeTimer.current) { clearTimeout(chromeTimer.current); chromeTimer.current = null; } };
  const showChrome = () => { clearChromeTimer(); setChromeVisible(true); };
  const scheduleChromeHide = (delay = 1600) => {
    if (!settings.autoHideChrome) return;
    clearChromeTimer();
    chromeTimer.current = setTimeout(() => setChromeVisible(false), delay);
  };
  useEffect(() => {
    if (settings.autoHideChrome) scheduleChromeHide(4000);
    else { clearChromeTimer(); setChromeVisible(true); }
    return clearChromeTimer;
  }, [settings.autoHideChrome]);
  useEffect(() => {
    if (panel !== "none") showChrome();
    else if (!hoverRef.current) scheduleChromeHide();
  }, [panel]);
  const chromeHidden = settings.autoHideChrome && !chromeVisible && panel === "none";
  // Let the main process shrink the window to fit once the chrome is gone.
  useEffect(() => { window.speedPet?.setChromeHidden(chromeHidden); }, [chromeHidden]);

  const active = usage.source !== "error" && usage.active && usage.lastEvent !== null && clock - usage.lastEvent <= 12000;
  // The main process already smooths (EMA) and zeroes the speed; no extra cutoff here.
  const speed = usage.source !== "error" ? usage.speed : 0;
  const running = usage.source !== "error" && usage.running;
  const mood = speed >= 80 ? "fast" : active || running ? "working" : "idle";
  const status = usage.source === "error" ? "读取失败" : usage.source === "waiting" ? "等待 Codex" : running ? "正在工作" : active ? "正在更新" : "待机中";
  const speedLabel = speed >= 10 ? speed.toFixed(0) : speed.toFixed(1);
  const update = (patch: Partial<PetSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
    window.speedPet?.updateSettings(patch).then(setSettings);
  };
  const choosePet = () => { window.speedPet?.choosePetImage().then(setSettings); };
  const clearPet = () => { window.speedPet?.clearPetImage().then(setSettings); };
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
  const scale = SIZE_SCALE[settings.viewSize ?? settings.size] || 1;
  const customPetKind = settings.petImage && settings.petImage.toLowerCase().split("?")[0].endsWith(".gif") ? "自定义 GIF" : "自定义图片";

  // Layout zoom keeps text crisp when live usage updates repaint the window.
  return <div className="viewport" style={{ zoom: scale }}><main
    className={`shell view-${settings.viewSize ?? settings.size} ${settings.reducedMotion ? "reduce-motion" : ""} ${chromeHidden ? "chrome-hidden" : ""}`}
    onMouseEnter={() => { hoverRef.current = true; showChrome(); }}
    onMouseLeave={() => { hoverRef.current = false; scheduleChromeHide(); }}
    onClick={showChrome}>
    <div className="topbar">
      <div className="brand"><span className="brand-icon">✦</span><span>CODEX <strong>{settings.style === "gauge" ? "DRIVE" : "PET"}</strong></span></div>
      <div className="window-actions">
        <button type="button" className="icon-button" title="设置" aria-label="设置" onClick={() => setPanel(panel === "settings" ? "none" : "settings")}>⚙</button>
        <button type="button" className="icon-button" title="隐藏到托盘" aria-label="隐藏到托盘" onClick={() => window.speedPet?.hide()}>−</button>
      </div>
    </div>

    <div className="status"><span className={`status-light ${active || running ? "lit" : ""}`} /><span>{status}</span><span className="status-right">LOCAL</span></div>
    {settings.style === "gauge" ? <Gauge speed={speed} /> : <Pet mood={mood} image={settings.petImage} />}

    <button type="button" className="speed-card" onClick={() => setPanel(panel === "details" ? "none" : "details")} title="查看统计详情">
      <div className="speed-top"><span>输出速度</span><span className="live-tag">平滑</span></div>
      <div className="speed-number"><strong>{speedLabel}</strong><span>token/s</span></div>
      <div className="today-line"><span>今日累计</span><strong>{shortCount(usage.total)} <small>token</small></strong></div>
      <div className="history-line"><span>历史累计</span><strong>{shortCount(usage.historyTotal)} <small>token</small></strong></div>
    </button>

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
        <p className="panel-note">统计本机 Codex 会话。速度为近期输出 token 的指数加权均值（τ≈15 秒）；上轮平均速度 = 最近一轮的输出 token ÷ 轮耗时。输入已包含缓存 token。</p>
        {usage.error && <p className="error-note">{usage.error}</p>}
      </> : <>
        <div className="settings-section">外观</div>
        <div className="preference-choice"><span>显示款式</span><div className="segmented" role="group" aria-label="显示款式">
          <button type="button" aria-pressed={settings.style === "pet"} onClick={() => update({ style: "pet" })}>宠物</button>
          <button type="button" aria-pressed={settings.style === "gauge"} onClick={() => update({ style: "gauge" })}>汽车仪表盘</button>
        </div></div>
        <div className="pet-image-row">
          {settings.petImage
            ? <img className="pet-image-preview" src={petImageUrl(settings.petImage)} alt="自定义宠物预览" />
            : <span className="pet-image-preview pet-image-empty">内置</span>}
          <div className="pet-image-info"><span>宠物图片</span><small>{settings.petImage ? customPetKind : "内置小绿宠"}</small></div>
          <button type="button" className="mini-button" title="选择 GIF 或图片" onClick={choosePet} disabled={!window.speedPet}>更换</button>
          {settings.petImage && <button type="button" className="mini-button" title="恢复内置宠物" onClick={clearPet} disabled={!window.speedPet}>恢复</button>}
        </div>
        <div className="settings-section">窗口</div>
        <div className="preference-choice"><span>窗口大小</span><div className="segmented" role="group" aria-label="窗口大小">
          <button type="button" aria-pressed={settings.size === "small"} onClick={() => update({ size: "small" })}>小</button>
          <button type="button" aria-pressed={settings.size === "medium"} onClick={() => update({ size: "medium" })}>中</button>
          <button type="button" aria-pressed={settings.size === "large"} onClick={() => update({ size: "large" })}>大</button>
        </div></div>
        <Toggle label="始终置顶" checked={settings.alwaysOnTop} onChange={(alwaysOnTop) => update({ alwaysOnTop })} />
        <Toggle label="减少动画" checked={settings.reducedMotion} onChange={(reducedMotion) => update({ reducedMotion })} />
        <Toggle label="自动隐藏标题栏" checked={settings.autoHideChrome} onChange={(autoHideChrome) => update({ autoHideChrome })} />
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
        <p className="panel-note settings-note">拖动顶部移动。隐藏后可从托盘打开。打开面板时窗口会临时放大，关闭后恢复所选大小。</p>
        <button type="button" className="quit-button" onClick={() => window.speedPet?.quit()}>退出应用</button>
      </>}
      </div>
    </div>}
  </main></div>;
}
