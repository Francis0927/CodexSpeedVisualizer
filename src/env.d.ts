export type QuotaWindow = {
  remainingPercent: number;
  /** Reset time in milliseconds since epoch, null when unavailable. */
  resetsAt: number | null;
};

export type RateLimits = {
  updatedAt: number;
  fiveHour: QuotaWindow | null;
  weekly: QuotaWindow | null;
};

export type UsageSnapshot = {
  day: string | null;
  input: number;
  output: number;
  total: number;
  /** Tokens across locally available sessions since the last manual reset. */
  historyTotal: number;
  /** Latest shared Codex quota reported in local session logs. */
  rateLimits: RateLimits | null;
  speed: number;
  /** Average rate of the most recent completed turn (output tokens / turn seconds), null when unknown. */
  turnSpeed: number | null;
  /** Output tokens of that turn. */
  turnTokens: number | null;
  /** Duration of that turn in seconds. */
  turnSeconds: number | null;
  active: boolean;
  running: boolean;
  lastEvent: number | null;
  eventCount: number;
  source: "ready" | "waiting" | "error";
  error: string | null;
};

export type AppSettings = {
  alwaysOnTop: boolean;
  edgeDock: boolean;
  reducedMotion: boolean;
  launchAtLogin: boolean;
  size: "small" | "medium" | "large";
  /** Fold to the dial until hover or click; retains the legacy setting key. */
  autoHideChrome: boolean;
  tiboPollMinutes: number;
  /**
   * Size the renderer should draw at right now. Sent by the main process with
   * every settings payload (never persisted): while a panel is open the window
   * is enlarged so the panel stays readable, and viewSize follows that growth.
   */
  viewSize?: "small" | "medium" | "large";
};

export type UpdateStatus = {
  state: "idle" | "checking" | "latest" | "available" | "downloading" | "installing" | "error" | "unsupported";
  /** Newer version found on GitHub Releases (state === "available"). */
  version: string | null;
  /** Release notes from GitHub. */
  notes: string | null;
  /** Human-readable error detail (state === "error"). */
  message: string | null;
};

export type AppInfo = {
  version: string;
  buildKind: "dev" | "installed" | "portable";
  updateEnabled: boolean;
};

export type TiboReset = {
  reset_type: "regular" | "banked";
  announced_at: string;
  text: string;
};
export type TiboSnapshot = {
  data: {
    latest_reset: TiboReset | null;
    scheduled_reset: (TiboReset & { scheduled_for: string | null }) | null;
    active_watch: {
      level: "elevated" | "strong";
      reset_chance_percent: number | null;
      forecast_window: string;
      observed_at: string;
      expires_at: string;
      text: string;
    } | null;
  } | null;
  fetchedAt: number | null;
  error: string | null;
};

declare global {
  interface Window {
    speedPet?: {
      getInitial(): Promise<{ usage: UsageSnapshot; settings: AppSettings; appInfo: AppInfo; updateStatus: UpdateStatus; tibo?: TiboSnapshot }>;
      onTibo?(callback: (snapshot: TiboSnapshot) => void): () => void;
      updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
      resetHistory(): Promise<UsageSnapshot>;
      setPanelOpen(open: boolean): void;
      setContentSize(size: { viewSize: AppSettings["size"]; height: number }): void;
      checkUpdate(): Promise<UpdateStatus>;
      installUpdate(): Promise<UpdateStatus>;
      hide(): void;
      quit(): void;
      onUsage(callback: (usage: UsageSnapshot) => void): () => void;
      onSettings(callback: (settings: AppSettings) => void): () => void;
      onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
      onOpenSettings(callback: () => void): () => void;
    };
  }
}
