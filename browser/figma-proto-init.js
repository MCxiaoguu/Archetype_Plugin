// Archetype: make Figma prototypes readable and clickable for the actor.
//
// Every archetype browser server loads this file with --init-script; it does
// nothing outside figma.com/proto and figma.com/deck. On a prototype it turns
// on the viewer's own screen reader mode (Options, Advanced settings,
// Accessibility settings, "Adapt content for screen readers"), which puts
// each screen's text and every hotspot into the page as real elements, so
// the actor reads the screen from its snapshot. The viewer draws the
// prototype on a canvas that sits above those elements and swallows clicks,
// so the hotspots are lifted above it. A click on a hotspot element then
// runs the prototype interaction, exactly as a screen reader user's would.
(() => {
  if (!/(^|\.)figma\.com$/.test(location.hostname)) return;
  if (!/^\/(proto|deck)\//.test(location.pathname)) return;
  try {
    localStorage.setItem('enable.screenreader', '1');
  } catch (_) {
    // Storage blocked: the actor still sees the canvas through screenshots.
  }
  const css = [
    '[data-prototype-a11y-clickable] { pointer-events: auto !important; }',
    'main:has([data-prototype-a11y-clickable]) { position: relative; z-index: 2147483000 !important; pointer-events: none; }',
  ].join('\n');
  const add = () => {
    const style = document.createElement('style');
    style.dataset.archetype = 'figma-prototype';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);
  else add();
})();
