// Approximations of the CSS variables Figma injects with themeColors: true.
// Figma adds a figma-light or figma-dark class on <html> and a
// <style id="figma-style"> element; the harness does the same.
export const THEMES = {
  light: {
    'bg': '#ffffff',
    'bg-secondary': '#f5f5f5',
    'bg-hover': '#f5f5f5',
    'text': 'rgba(0, 0, 0, 0.9)',
    'text-secondary': 'rgba(0, 0, 0, 0.5)',
    'text-tertiary': 'rgba(0, 0, 0, 0.3)',
    'border': '#e6e6e6',
    'border-strong': '#2c2c2c',
    'text-danger': '#dc3412',
    'text-warning': '#b86200',
    'text-success': '#14ae5c',
    'bg-danger-tertiary': '#ffe2e0',
    'bg-warning-tertiary': '#fff1db',
    'bg-success-tertiary': '#dcf6e5',
  },
  dark: {
    'bg': '#2c2c2c',
    'bg-secondary': '#383838',
    'bg-hover': '#383838',
    'text': '#ffffff',
    'text-secondary': 'rgba(255, 255, 255, 0.7)',
    'text-tertiary': 'rgba(255, 255, 255, 0.4)',
    'border': '#444444',
    'border-strong': '#9a9a9a',
    'text-danger': '#fca397',
    'text-warning': '#f7d15f',
    'text-success': '#79d297',
    'bg-danger-tertiary': '#4f2420',
    'bg-warning-tertiary': '#47391a',
    'bg-success-tertiary': '#1d3d29',
  },
};

export function themeUi(html, theme) {
  const vars = THEMES[theme] ?? THEMES.light;
  const css = `:root{${Object.entries(vars).map(([k, v]) => `--figma-color-${k}:${v}`).join(';')}}`;
  return html
    .replace('<html lang="en">', `<html lang="en" class="figma-${theme === 'dark' ? 'dark' : 'light'}">`)
    .replace('<head>', `<head><style id="figma-style">${css}</style>`);
}
