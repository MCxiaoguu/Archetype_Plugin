/* ===================================================
   Relay — shared client logic (all pages)
   State lives in localStorage under "relay:*" keys.
   =================================================== */
(function () {
  "use strict";

  var STORE_USER = "relay:user";

  function getUser() {
    try {
      var raw = localStorage.getItem(STORE_USER);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function setUser(user) {
    localStorage.setItem(STORE_USER, JSON.stringify(user));
  }

  function clearUser() {
    localStorage.removeItem(STORE_USER);
  }

  /* ---------- Footer year ---------- */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  /* ---------- Nav auth swap ----------
     If a user exists, the "Sign in" link becomes "Dashboard". */
  var signinLink = document.getElementById("nav-signin");
  if (signinLink && getUser()) {
    signinLink.textContent = "Dashboard";
    signinLink.setAttribute("href", "dashboard.html");
  }

  /* ---------- Docs search ---------- */
  var searchInput = document.getElementById("docs-search-input");
  var searchResults = document.getElementById("docs-search-results");
  if (searchInput && searchResults) {
    searchInput.addEventListener("input", function () {
      var q = searchInput.value.trim();
      if (!q) {
        searchResults.classList.add("hidden");
        return;
      }
      searchResults.textContent = "No results found.";
      searchResults.classList.remove("hidden");
    });
    document.addEventListener("click", function (ev) {
      if (!searchInput.contains(ev.target) && !searchResults.contains(ev.target)) {
        searchResults.classList.add("hidden");
      }
    });
  }

  /* ---------- Docs sidebar active-section highlight ---------- */
  var docLinks = Array.prototype.slice.call(document.querySelectorAll(".docs-nav a[href^='#']"));
  if (docLinks.length) {
    var sections = docLinks
      .map(function (a) { return document.getElementById(a.getAttribute("href").slice(1)); })
      .filter(Boolean);
    var highlight = function () {
      var pos = window.scrollY + 120;
      var current = sections[0];
      sections.forEach(function (s) { if (s.offsetTop <= pos) current = s; });
      docLinks.forEach(function (a) {
        a.classList.toggle("active", current && a.getAttribute("href") === "#" + current.id);
      });
    };
    window.addEventListener("scroll", highlight, { passive: true });
    highlight();
  }

  /* ---------- Copy buttons on code blocks ---------- */
  Array.prototype.forEach.call(document.querySelectorAll(".code-copy"), function (btn) {
    btn.addEventListener("click", function () {
      var block = btn.closest(".code-block");
      var pre = block ? block.querySelector("pre") : null;
      if (!pre) return;
      var text = pre.textContent;
      var done = function () {
        var old = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = old; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        done();
      }
    });
  });

  /* ---------- Book a demo modal (pricing) ---------- */
  var demoBtn = document.getElementById("book-demo-btn");
  var demoOverlay = document.getElementById("demo-modal");
  if (demoBtn && demoOverlay) {
    var demoForm = document.getElementById("demo-form");
    var demoSuccess = document.getElementById("demo-success");
    var openModal = function () {
      demoOverlay.classList.remove("hidden");
      if (demoForm) demoForm.classList.remove("hidden");
      if (demoSuccess) demoSuccess.classList.add("hidden");
    };
    var closeModal = function () { demoOverlay.classList.add("hidden"); };
    demoBtn.addEventListener("click", openModal);
    demoOverlay.addEventListener("click", function (ev) {
      if (ev.target === demoOverlay) closeModal();
    });
    var closeBtn = demoOverlay.querySelector(".modal-close");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    if (demoForm) {
      demoForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        demoForm.classList.add("hidden");
        if (demoSuccess) demoSuccess.classList.remove("hidden");
      });
    }
  }

  /* ---------- Signup form ---------- */
  var signupForm = document.getElementById("signup-form");
  if (signupForm) {
    var fieldRules = [
      {
        id: "su-name",
        validate: function (v) { return v.trim().length >= 2; },
        message: "Please enter your full name."
      },
      {
        id: "su-email",
        validate: function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()); },
        message: "Enter a valid work email address."
      },
      {
        id: "su-password",
        validate: function (v) { return v.length >= 8; },
        message: "Password must be at least 8 characters."
      },
      {
        id: "su-card",
        validate: function (v) {
          var digits = v.replace(/[\s-]/g, "");
          return /^\d{12,19}$/.test(digits);
        },
        message: "Enter a valid card number."
      },
      {
        id: "su-expiry",
        validate: function (v) { return /^(0[1-9]|1[0-2])\s*\/\s*\d{2}$/.test(v.trim()); },
        message: "Use MM/YY format."
      },
      {
        id: "su-cvc",
        validate: function (v) { return /^\d{3,4}$/.test(v.trim()); },
        message: "3 or 4 digits."
      }
    ];

    var markField = function (input, ok, message) {
      var err = document.getElementById(input.id + "-error");
      input.classList.toggle("invalid", !ok);
      if (err) {
        err.textContent = message || "";
        err.classList.toggle("visible", !ok);
      }
    };

    fieldRules.forEach(function (rule) {
      var input = document.getElementById(rule.id);
      if (!input) return;
      input.addEventListener("input", function () {
        if (input.classList.contains("invalid") && rule.validate(input.value)) {
          markField(input, true);
        }
      });
    });

    // Light formatting for the card number field.
    var cardInput = document.getElementById("su-card");
    if (cardInput) {
      cardInput.addEventListener("input", function () {
        var digits = cardInput.value.replace(/\D/g, "").slice(0, 19);
        cardInput.value = digits.replace(/(\d{4})(?=\d)/g, "$1 ");
      });
    }

    signupForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var ok = true;
      var firstBad = null;
      fieldRules.forEach(function (rule) {
        var input = document.getElementById(rule.id);
        if (!input) return;
        var valid = rule.validate(input.value);
        markField(input, valid, rule.message);
        if (!valid) {
          ok = false;
          if (!firstBad) firstBad = input;
        }
      });

      var tos = document.getElementById("su-tos");
      var tosErr = document.getElementById("su-tos-error");
      if (tos && !tos.checked) {
        ok = false;
        if (tosErr) tosErr.classList.add("visible");
      } else if (tosErr) {
        tosErr.classList.remove("visible");
      }

      if (!ok) {
        if (firstBad) firstBad.focus();
        return;
      }

      var name = document.getElementById("su-name").value.trim();
      var email = document.getElementById("su-email").value.trim();
      setUser({
        name: name,
        email: email,
        plan: "free",
        createdAt: new Date().toISOString()
      });

      var submitBtn = signupForm.querySelector("button[type='submit']");
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Creating your workspace…";
      }
      setTimeout(function () {
        window.location.href = "onboarding.html";
      }, 700);
    });
  }

  /* ---------- Onboarding ---------- */
  var onboardName = document.getElementById("onboard-name");
  if (onboardName) {
    var u = getUser();
    if (!u) {
      window.location.href = "signup.html";
      return;
    }
    onboardName.textContent = u.name.split(" ")[0];
    // The "Waiting for your first event…" spinner intentionally never resolves:
    // this demo backend receives no events.
  }

  /* ---------- Dashboard ---------- */
  var appShell = document.getElementById("app-shell");
  if (appShell) {
    var user = getUser();
    if (!user) {
      window.location.href = "signup.html";
      return;
    }

    var nameEl = document.getElementById("dash-user-name");
    var emailEl = document.getElementById("dash-user-email");
    var avatarEl = document.getElementById("dash-avatar");
    if (nameEl) nameEl.textContent = user.name;
    if (emailEl) emailEl.textContent = user.email;
    if (avatarEl) {
      var initials = user.name
        .split(/\s+/)
        .map(function (p) { return p.charAt(0); })
        .join("")
        .slice(0, 2)
        .toUpperCase();
      avatarEl.textContent = initials || "U";
    }

    var settingName = document.getElementById("setting-name");
    var settingEmail = document.getElementById("setting-email");
    var settingPlan = document.getElementById("setting-plan");
    if (settingName) settingName.textContent = user.name;
    if (settingEmail) settingEmail.textContent = user.email;
    if (settingPlan) settingPlan.textContent = "Free";

    var tabs = Array.prototype.slice.call(appShell.querySelectorAll(".side-link[data-section]"));
    var sections = Array.prototype.slice.call(appShell.querySelectorAll(".app-section"));
    var title = document.getElementById("app-title");
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var target = tab.getAttribute("data-section");
        tabs.forEach(function (t) { t.classList.toggle("active", t === tab); });
        sections.forEach(function (s) {
          s.classList.toggle("hidden", s.id !== "section-" + target);
        });
        if (title) title.textContent = tab.textContent.trim();
      });
    });

    var signoutBtn = document.getElementById("signout-btn");
    if (signoutBtn) {
      signoutBtn.addEventListener("click", function () {
        clearUser();
        window.location.href = "index.html";
      });
    }
  }
})();
