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
    const tiboData = { latest_reset: { reset_type: 'regular', announced_at: new Date(Date.now() - 86400000).toISOString(), text: 'Reset completed' }, scheduled_reset: null, active_watch: null };
    const sendTibo = async (data, error = null) => invoke('test_tibo_status', { snapshot: { data, fetchedAt: Date.now(), error } });
    await sendTibo({ ...tiboData, scheduled_reset: { reset_type: 'banked', announced_at: new Date().toISOString(), scheduled_for: new Date(Date.now() - 60000).toISOString(), text: 'Landing within the next 2 hours. '.repeat(12) } });
    await waitFor('scheduled reset reaches React', () => document.querySelector('.tibo-status')?.textContent === '等待执行确认' && nativeSizeMatches());
    assert(!document.querySelector('.tibo-prediction').textContent.includes('概率'), 'announcements have no invented probability');
    assert(document.querySelector('.quota-row:last-of-type')?.compareDocumentPosition(document.querySelector('.tibo-prediction')) & Node.DOCUMENT_POSITION_FOLLOWING, 'prediction follows weekly quota');
    assert(!document.querySelector('.tibo-credit, .tibo-meta, .tibo-text'), 'no source, query metadata or English tweet text');
    const watch = { level: 'strong', reset_chance_percent: 75, forecast_window: 'Within the next 24 hours', observed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), text: '<script>external text stays plain</script>' };
    await sendTibo({ ...tiboData, active_watch: watch });
    await waitFor('watch probability reaches React', () => document.querySelector('.tibo-status')?.textContent === '重置概率 75%');
    assert(!/Within|external text|script/.test(document.querySelector('.tibo-prediction').textContent), 'English forecast and tweet text are omitted');
    await sendTibo({ ...tiboData, active_watch: { ...watch, expires_at: new Date(Date.now() - 60000).toISOString() } });
    await waitFor('expired prediction is labelled', () => document.querySelector('.tibo-status')?.textContent === '预测已过期');
    await sendTibo({ ...tiboData, active_watch: watch }, 'offline');
    await waitFor('failed refresh retains previous prediction', () => document.querySelector('.tibo-error')?.textContent.includes('显示上次结果') && document.querySelector('.tibo-status')?.textContent === '重置概率 75%');
    await sendTibo(tiboData);
    await waitFor('no current reset signal', () => document.querySelector('.tibo-status')?.textContent === '暂无重置信号' && !document.querySelector('.tibo-error'));
    checks.push('Tibo scheduled, probability, expiry, failed refresh and Chinese summary');
    await window.speedPet.updateSettings({ size: 'small', autoHideChrome: true, reducedMotion: true });
    await waitFor('small view with reduced motion', () => settledView('small') && document.querySelector('.reduce-motion'));
    assert(document.querySelector('.tibo-prediction').scrollWidth <= document.querySelector('.tibo-prediction').clientWidth + 1, 'small prediction does not overflow horizontally');
    const history = document.querySelector('.history-line');
    const historyValue = history.querySelector('strong');
    const savedHistoryValue = historyValue.innerHTML;
    historyValue.textContent = '999.99M';
    const historyLabelBounds = history.querySelector('span').getBoundingClientRect();
    const historyValueBounds = historyValue.getBoundingClientRect();
    assert(historyLabelBounds.right <= historyValueBounds.left, 'small history label and large total do not overlap');
    assert(history.scrollWidth <= history.clientWidth + 1, 'small history stays on one line without overflow');
    const lineCount = element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getClientRects().length;
    };
    assert(lineCount(history.querySelector('span')) === 1 && lineCount(historyValue) === 1, 'small history label and value each occupy one line');
    historyValue.innerHTML = savedHistoryValue;
    checks.push('small history total stays on one line');
    checks.push('React bridge and small view');
    document.querySelector('[aria-label="设置"]').click();
    await waitFor('small settings grows to medium', () => settledView('medium') && document.querySelector('.overlay'));
    assert((await window.speedPet.getInitial()).settings.size === 'small', 'selected small size retained');
    checks.push('settings temporary medium size');
    const interval = document.querySelector('[aria-label="Reset 检测间隔"]');
    assert(interval?.value === '10', 'legacy settings default to ten minutes');
    interval.value = '5';
    interval.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor('reset polling interval saved through React and Rust', async () =>
      (await window.speedPet.getInitial()).settings.tiboPollMinutes === 5 && interval.value === '5');
    checks.push('Reset interval default and settings persistence');
    document.querySelector('[aria-label="设置"]').click();
    await waitFor('close restores small view', () => settledView('small') && !document.querySelector('.overlay'));
    document.querySelector('.shell').dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    await waitFor('idle folding and native resize', () => document.querySelector('.is-collapsed') && nativeSizeMatches(), 7000);
    assert(document.querySelector('.tibo-prediction').getClientRects().length === 0, 'Tibo folds with quotas');
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
    document.querySelector('[aria-label="关闭"]').click();
    document.querySelector('[aria-label="设置"]').click();
    await waitFor('settings for edge dock', () => document.querySelector('.overlay')?.textContent.includes('贴边吸附隐藏'));
    const dockToggle = [...document.querySelectorAll('.toggle-row')].find(row => row.textContent.includes('贴边吸附隐藏')).querySelector('input');
    dockToggle.click();
    await waitFor('dock disables topmost natively', async () => {
      const settings = (await window.speedPet.getInitial()).settings;
      return settings.edgeDock && !settings.alwaysOnTop && !(await invoke('test_window_state')).topmost;
    });
    const foldToggle = [...document.querySelectorAll('.toggle-row')].find(row => row.textContent.includes('自动折叠窗口')).querySelector('input');
    assert(foldToggle.disabled && !foldToggle.checked, 'folding unavailable in dock mode');
    await window.speedPet.updateSettings({ autoHideChrome: true });
    document.querySelector('[aria-label="关闭"]').click();
    document.querySelector('.shell').dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    await sleep(4300);
    assert(!document.querySelector('.is-collapsed') && document.querySelector('.quota-card').getClientRects().length > 0, 'dock mode always renders full content');
    await window.speedPet.updateSettings({ alwaysOnTop: true });
    await waitFor('topmost disables dock natively', async () => {
      const settings = (await window.speedPet.getInitial()).settings;
      return settings.alwaysOnTop && !settings.edgeDock && (await invoke('test_window_state')).topmost;
    });
    checks.push('edge dock switch, native topmost exclusion and full content');
    const initial = await window.speedPet.getInitial();
    const runtime = await invoke('test_window_state');
    assert(initial.settings.historyResetAt === 12345 || initial.settings.historyResetAt === undefined, 'legacy reset preserved');
    await invoke('test_report', { result: { passed: true, checks, version: initial.appInfo.version, usage: initial.usage, settings: initial.settings, runtime } });
  } catch (error) {
    await invoke('test_report', { result: { passed: false, error: String(error), checks, shell: document.querySelector('.shell')?.className, panelOpen: !!document.querySelector('.overlay'), width: innerWidth, height: innerHeight, viewport: document.querySelector('.viewport')?.getBoundingClientRect().toJSON(), beforeUpdate } });
  }
})();
