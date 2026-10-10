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
  reducedMotion: boolean;
  launchAtLogin: boolean;
  size: "small" | "medium" | "large";
  /** Fold to the dial until hover or click; retains the legacy setting key. */
  autoHideChrome: boolean;
  /**
   * Size the renderer should draw at right now. Sent by the main process with
   * every settings payload (never persisted): while a panel is open the window
   * is enlarged so the panel stays readable, and viewSize follows that growth.
   */
  viewSize?: "small" | "medium" | "large";
};

export type UpdateStatus = {
  state: "idle" | "checking" | "latest" | "available" | "downloading" | "installing" | "error" | "unsupported";
  /** Newer version found on the share (state === "available"). */
  version: string | null;
  /** Release notes from the share manifest. */
  notes: string | null;
  /** Human-readable error detail (state === "error"). */
  message: string | null;
};

export type AppInfo = {
  version: string;
  buildKind: "dev" | "installed" | "portable";
  updateEnabled: boolean;
};

declare global {
  interface Window {
    speedPet?: {
      getInitial(): Promise<{ usage: UsageSnapshot; settings: AppSettings; appInfo: AppInfo }>;
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
    };
  }
}
