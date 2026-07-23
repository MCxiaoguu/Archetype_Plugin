/* =============================================================
   Lumina Notes — app.js
   Handles interactivity. Contains three planted UX flaws for
   persona-actor E2E testing (do NOT add hints or fix markers).
   ============================================================= */

'use strict';

// ---- Banner utility ----
function showBanner(text) {
  const banner = document.getElementById('banner');
  if (!banner) return;
  banner.textContent = text;
  banner.classList.remove('hidden');
  clearTimeout(banner._hideTimer);
  banner._hideTimer = setTimeout(() => {
    banner.classList.add('hidden');
  }, 4000);
}

// ---- History helper ----
function pushPageview(p) {
  history.pushState({}, '', p);
}

// ---- Nav: Plans & More ----
// Wire up analytics pageview on click (anchor still scrolls via href).
document.getElementById('nav-plans').addEventListener('click', () => {
  pushPageview('/#plans');
});

// ---- Flaw 1: Sluggish CTA ----
// 900 ms dead delay with no visual feedback whatsoever before navigation.
document.getElementById('cta-trial').addEventListener('click', () => {
  setTimeout(() => {
    location.hash = '#signup';
    pushPageview('/#signup');
  }, 900);
});

// ---- Flaw 3: Form validation wipes all fields ----
// Also shows an unhelpful generic error message; password minimum length is
// intentionally undisclosed in the UI.
document.getElementById('signup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = document.getElementById('signup-email').value;
  if (!email.includes('@') || document.getElementById('signup-password').value.length < 8) {
    console.error('Form validation failed: fields cleared');
    e.target.reset();                        // the flaw
    showBanner('Something went wrong. Please try again.');   // unhelpful copy
  } else {
    showBanner('Account created! (demo)');
  }
});
