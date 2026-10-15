import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// Keep the React view independent of the desktop runtime. The event API is
// asynchronous, but callers still receive a synchronous disposer.
const subscriptions = new Set<Promise<unknown>>();
function subscribe<T>(event: string, callback: (value: T) => void): () => void {
  let disposed = false;
  let remove: (() => void) | undefined;
  const ready = listen<T>(event, ({ payload }) => { if (!disposed) callback(payload); })
    .then((unlisten) => { if (disposed) unlisten(); else remove = unlisten; });
  subscriptions.add(ready);
  void ready.finally(() => subscriptions.delete(ready)).catch(console.error);
  return () => { disposed = true; remove?.(); };
}

if (isTauri()) {
  const send = (command: string, args?: Record<string, unknown>) => { void invoke(command, args).catch(console.error); };
  window.speedPet = {
    getInitial: async () => { await Promise.all([...subscriptions]); return invoke('get_initial'); },
    updateSettings: (patch) => invoke('update_settings', { patch }),
    resetHistory: () => invoke('reset_history'),
    setPanelOpen: (open) => send('set_panel_open', { open }),
    setContentSize: (size) => send('set_content_size', { size }),
    checkUpdate: () => invoke('check_update'),
    installUpdate: () => invoke('install_update'),
    onTibo: (callback) => subscribe('tibo:update', callback),
    hide: () => send('hide'),
    quit: () => send('quit'),
    onUsage: (callback) => subscribe('usage:update', callback),
    onSettings: (callback) => subscribe('settings:update', callback),
    onUpdateStatus: (callback) => subscribe('update:status', callback),
    onOpenSettings: (callback) => subscribe('app:openSettings', callback)
  };
}
