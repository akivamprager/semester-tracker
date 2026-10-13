// Light / dark / system theme. Loaded (non-module, in <head>) before the CSS paints, so a
// forced theme never flashes. Per device (localStorage), not synced: e.g. Mac dark, phone light.
(() => {
  const KEY = 'tracker.theme'; // 'light' | 'dark' | absent = follow the device
  const COLORS = { light: '#f3f5f9', dark: '#111520' }; // = --bg, for the window/title bar
  const dark = matchMedia('(prefers-color-scheme: dark)');

  function apply() {
    const pref = localStorage.getItem(KEY);
    const root = document.documentElement;
    if (pref === 'light' || pref === 'dark') root.dataset.theme = pref;
    else delete root.dataset.theme;
    // theme-color metas (one per device scheme): with a forced theme both get its color.
    const forced = pref === 'light' || pref === 'dark' ? COLORS[pref] : null;
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
      const scheme = (m.media || '').includes('dark') ? 'dark' : 'light';
      m.content = forced || COLORS[scheme];
    });
  }

  window.trackerTheme = {
    get: () => localStorage.getItem(KEY) || 'system',
    set(pref) {
      if (pref === 'light' || pref === 'dark') localStorage.setItem(KEY, pref);
      else localStorage.removeItem(KEY);
      apply();
    },
    isDark: () => {
      const pref = localStorage.getItem(KEY);
      return pref ? pref === 'dark' : dark.matches;
    },
  };
  dark.addEventListener('change', apply);
  apply();
})();
