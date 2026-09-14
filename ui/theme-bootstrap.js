try {
  const prefs = JSON.parse(localStorage.getItem('kd.prefs') || '{}');
  if (prefs?.theme === 'light' || prefs?.theme === 'dark') document.documentElement.dataset.theme = prefs.theme;
} catch {}
