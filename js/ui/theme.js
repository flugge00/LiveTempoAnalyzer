// Dark/light toggle. Follows the OS setting until the button is pressed once;
// after that the choice is remembered on this device (js/main.js's inline
// <head> script applies it before the stylesheet loads, so there's no flash).

import { prefs, $ } from './dom.js';

const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M4.22 4.22l1.77 1.77M18 18l1.78 1.78M2 12h2.5M19.5 12H22M4.22 19.78L6 18M18 6l1.78-1.78"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.4 15.3A9 9 0 118.7 3.6a7 7 0 0011.7 11.7z"/></svg>';

const DARK_BG = '#0d0d0d', LIGHT_BG = '#f9f9f7';
const media = window.matchMedia('(prefers-color-scheme: light)');

function effectiveTheme() {
  const chosen = prefs.get('theme', null);
  return chosen === 'light' || chosen === 'dark' ? chosen : (media.matches ? 'light' : 'dark');
}

export function initTheme() {
  const btn = $('themeToggle');
  const metaColor = $('metaThemeColor');

  function apply() {
    const mode = effectiveTheme();
    document.documentElement.dataset.theme = mode;
    btn.innerHTML = mode === 'dark' ? MOON : SUN;
    const label = mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    if (metaColor) metaColor.setAttribute('content', mode === 'dark' ? DARK_BG : LIGHT_BG);
  }

  btn.addEventListener('click', () => {
    prefs.set('theme', effectiveTheme() === 'dark' ? 'light' : 'dark');
    apply();
  });
  // still following the OS: keep it live if the OS setting changes underneath us
  media.addEventListener('change', () => { if (prefs.get('theme', null) == null) apply(); });

  apply();
}
