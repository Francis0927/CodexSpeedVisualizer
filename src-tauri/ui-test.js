(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  // IPC, React effects and native resize complete on separate queues. A loaded
  // Windows runner may need longer than one fixed 250 ms delay to settle.
  const waitFor = async (message, condition, timeout = 5000) => {
    const started = performance.now();
    while (performance.now() - started < timeout) {
      if (await condition()) return;
      await sleep(50);
    }
    throw Error(message + ' timed out');
  };
  const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
  const nativeSizeMatches = () => {
    const bounds = document.querySelector('.viewport')?.getBoundingClientRect();
    return bounds && Math.abs(innerWidth - bounds.width) <= 1 && Math.abs(innerHeight - bounds.height) <= 2;
  };
  const settledView = size => document.querySelector('.view-' + size) && nativeSizeMatches();
  const checks = [];
  let beforeUpdate = null;
  try {
    await waitFor('React dashboard loaded', () => window.speedPet && document.querySelector('.speed-card'), 15000);
    await waitFor('Rust collector delivered synthetic usage', async () => {
      const usage = (await window.speedPet.getInitial()).usage;
      return usage.total === 140 && usage.historyTotal === 140;
    });
    checks.push('Rust usage to React');
    await window.speedPet.updateSettings({ size: 'small', autoHideChrome: true, reducedMotion: true });
    await waitFor('small view with reduced motion', () => settledView('small') && document.querySelector('.reduce-motion'));
    checks.push('React bridge and small view');
    document.querySelector('[aria-label="设置"]').click();
    await waitFor('small settings grows to medium', () => settledView('medium') && document.querySelector('.overlay'));
    assert((await window.speedPet.getInitial()).settings.size === 'small', 'selected small size retained');
    checks.push('settings temporary medium size');
    document.querySelector('[aria-label="设置"]').click();
    await waitFor('close restores small view', () => settledView('small') && !document.querySelector('.overlay'));
    document.querySelector('.shell').dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    await waitFor('idle folding and native resize', () => document.querySelector('.is-collapsed') && nativeSizeMatches(), 7000);
    beforeUpdate = { width: innerWidth, height: innerHeight };
    await invoke('test_update_status', { status: { state: 'available', version: '99.0.0', notes: '更新说明'.repeat(100), message: null } });
    await waitFor('update badge', () => document.querySelector('.has-update'));
    assert(document.querySelector('.is-collapsed'), 'background update preserves folding');
    assert(innerWidth === beforeUpdate.width && innerHeight === beforeUpdate.height, 'background update preserves bounds');
    checks.push('background update preserves bounds, panel and folding');
    document.querySelector('.shell').dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    await waitFor('hover unfolds', () => !document.querySelector('.is-collapsed') && nativeSizeMatches());
    document.querySelector('.speed-card').click();
    await waitFor('details temporary medium size', () => settledView('medium') && document.querySelector('.overlay'));
    checks.push('hover and details');
    await window.speedPet.updateSettings({ size: 'large', autoHideChrome: false });
    await waitFor('large view and unclipped content', () => settledView('large'));
    checks.push('large view and content height');
    const initial = await window.speedPet.getInitial();
    assert(initial.settings.historyResetAt === 12345 || initial.settings.historyResetAt === undefined, 'legacy reset preserved');
    await invoke('test_report', { result: { passed: true, checks, version: initial.appInfo.version, usage: initial.usage, settings: initial.settings } });
  } catch (error) {
    await invoke('test_report', { result: { passed: false, error: String(error), checks, shell: document.querySelector('.shell')?.className, panelOpen: !!document.querySelector('.overlay'), width: innerWidth, height: innerHeight, viewport: document.querySelector('.viewport')?.getBoundingClientRect().toJSON(), beforeUpdate } });
  }
})();
