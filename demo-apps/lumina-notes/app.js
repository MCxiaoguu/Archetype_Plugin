/* =============================================================
   Lumina Notes — app.js
   Page interactivity: navigation, CTA, and signup handling.
   ============================================================= */

'use strict';

// Show a transient notification banner at the top of the page.
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

// Record an SPA-style pageview in the browser history.
function pushPageview(p) {
  history.pushState({}, '', p);
}

// Track a pageview when the plans nav link is used (anchor scroll via href).
document.getElementById('nav-plans').addEventListener('click', () => {
  pushPageview('/#plans');
});

// Primary CTA: defer navigation until content settles.
document.getElementById('cta-trial').addEventListener('click', () => {
  setTimeout(() => {
    location.hash = '#signup';
    pushPageview('/#signup');
  }, 900);
});

// Signup form submission with client-side validation.
document.getElementById('signup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = document.getElementById('signup-email').value;
  if (!email.includes('@') || document.getElementById('signup-password').value.length < 8) {
    console.error('Form validation failed: fields cleared');
    e.target.reset();                        // reset form state on validation error
    showBanner('Something went wrong. Please try again.');
  } else {
    showBanner('Account created! (demo)');
  }
});
