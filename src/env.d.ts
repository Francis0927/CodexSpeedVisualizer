export type UsageSnapshot = {
  day: string | null;
  input: number;
  output: number;
  total: number;
  /** Tokens across locally available sessions since the last manual reset. */
  historyTotal: number;
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

export type PetSettings = {
  alwaysOnTop: boolean;
  reducedMotion: boolean;
  launchAtLogin: boolean;
  style: "pet" | "gauge";
  size: "small" | "medium" | "large";
  /** Custom pet image file name inside the user-data pet folder, or null for the built-in pet. */
  petImage: string | null;
  /** Auto-hide the title bar / status row until hover or click. */
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
      getInitial(): Promise<{ usage: UsageSnapshot; settings: PetSettings; appInfo: AppInfo }>;
      updateSettings(patch: Partial<PetSettings>): Promise<PetSettings>;
      resetHistory(): Promise<UsageSnapshot>;
      choosePetImage(): Promise<PetSettings>;
      clearPetImage(): Promise<PetSettings>;
      setPanelOpen(open: boolean): void;
      setChromeHidden(hidden: boolean): void;
      checkUpdate(): Promise<UpdateStatus>;
      installUpdate(): Promise<UpdateStatus>;
      hide(): void;
      quit(): void;
      onUsage(callback: (usage: UsageSnapshot) => void): () => void;
      onSettings(callback: (settings: PetSettings) => void): () => void;
      onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
    };
  }
}
