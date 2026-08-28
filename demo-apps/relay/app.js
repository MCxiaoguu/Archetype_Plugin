/* ===================================================
   Relay — shared client logic (all pages)
   Account/event/rule state lives server-side (server.py);
   the client keeps only the signed-in user + session token
   in localStorage under "relay:*" keys.
   =================================================== */
(function () {
  "use strict";

  var STORE_USER = "relay:user";
  var STORE_EVENTS = "relay:events";
  var STORE_INCIDENTS = "relay:incidents";
  var STORE_RULES = "relay:alert-rules";

  function getJSON(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function setJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function getUser() {
    return getJSON(STORE_USER);
  }

  function setUser(user) {
    setJSON(STORE_USER, user);
  }

  function clearUser() {
    localStorage.removeItem(STORE_USER);
    // Legacy keys from the pre-backend demo; cleared for hygiene.
    localStorage.removeItem(STORE_EVENTS);
    localStorage.removeItem(STORE_INCIDENTS);
    localStorage.removeItem(STORE_RULES);
  }

  /* ---------- API helpers ---------- */
  function apiGet(path, session) {
    return fetch(path, { headers: { "Authorization": "Bearer " + session } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; });
  }

  function apiPost(path, body, session) {
    var headers = { "Content-Type": "application/json" };
    if (session) headers["Authorization"] = "Bearer " + session;
    return fetch(path, { method: "POST", headers: headers, body: JSON.stringify(body) })
      .then(function (res) {
        return res.json().then(
          function (data) { return { status: res.status, data: data }; },
          function () { return { status: res.status, data: {} }; }
        );
      })
      .catch(function () { return { status: 0, data: {} }; });
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

      var emailInput = document.getElementById("su-email");
      var payload = {
        name: document.getElementById("su-name").value.trim(),
        email: emailInput.value.trim(),
        password: document.getElementById("su-password").value,
        card: document.getElementById("su-card").value,
        expiry: document.getElementById("su-expiry").value.trim(),
        cvc: document.getElementById("su-cvc").value.trim()
      };

      var submitBtn = signupForm.querySelector("button[type='submit']");
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Creating your workspace…";
      }

      apiPost("/api/signup", payload).then(function (result) {
        if (result.status === 201) {
          setUser({
            name: payload.name,
            email: payload.email,
            plan: "free",
            session: result.data.session,
            createdAt: new Date().toISOString()
          });
          window.location.href = "onboarding.html";
          return;
        }
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Create account";
        }
        var message = result.status === 409
          ? "An account with this email already exists."
          : "Something went wrong — please try again.";
        markField(emailInput, false, message);
      });
    });
  }

  /* ---------- Sign-in form ---------- */
  var signinForm = document.getElementById("signin-form");
  if (signinForm) {
    signinForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var emailInput = document.getElementById("si-email");
      var passwordInput = document.getElementById("si-password");
      var formErr = document.getElementById("si-form-error");
      var email = emailInput ? emailInput.value.trim() : "";
      var password = passwordInput ? passwordInput.value : "";

      var signinBtn = signinForm.querySelector("button[type='submit']");
      if (signinBtn) {
        signinBtn.disabled = true;
        signinBtn.textContent = "Signing you in…";
      }

      apiPost("/api/session", { email: email, password: password }).then(function (result) {
        if (result.status !== 200) {
          if (signinBtn) {
            signinBtn.disabled = false;
            signinBtn.textContent = "Sign in";
          }
          if (formErr) {
            formErr.textContent = "Invalid email or password.";
            formErr.classList.add("visible");
          }
          return;
        }
        if (formErr) formErr.classList.remove("visible");
        var account = result.data.account;
        setUser({
          name: account.name,
          email: account.email,
          plan: account.plan,
          debug: account.debug,
          session: result.data.session,
          createdAt: new Date().toISOString()
        });
        window.location.href = "dashboard.html";
      });
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
    // Genuinely polls ingest: the waiting box resolves only when an event
    // actually arrives (which requires the API token no page ever shows — D2).
    var waitingBox = document.querySelector(".waiting-box");
    if (waitingBox && u.session) {
      var pollFirstEvent = function () {
        apiGet("/api/events", u.session).then(function (data) {
          if (data && data.events && data.events.length) {
            waitingBox.innerHTML =
              '<span style="color:var(--green);font-size:1.3rem;font-weight:700;" aria-hidden="true">✓</span>' +
              '<span>First event received — <a href="dashboard.html" style="color:var(--violet-bright);font-weight:600;">view it in your dashboard</a>.</span>';
            return;
          }
          setTimeout(pollFirstEvent, 3000);
        });
      };
      pollFirstEvent();
    }
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

    /* Debug (founder) account: plan tag */
    if (user.debug) {
      var planTag = document.getElementById("dash-plan-tag");
      if (planTag) {
        planTag.textContent = user.plan;
        planTag.classList.remove("hidden");
      }
      var planSide = document.getElementById("dash-user-plan");
      if (planSide) {
        planSide.textContent = user.plan;
        planSide.classList.remove("hidden");
      }
      if (settingPlan) settingPlan.textContent = user.plan;
    }

    /* Data rendering (all signed-in accounts, from the API) */
    var pad2 = function (n) { return (n < 10 ? "0" : "") + n; };
    var fmtTime = function (iso) {
      var d = new Date(iso);
      return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
    };
    var statusPill = function (code) {
      var cls = code >= 500 ? "down" : code >= 400 ? "warn" : "ok";
      return '<span class="status-pill ' + cls + '">' + code + "</span>";
    };

    var session = user.session;

    // Events table
    var eventsBody = document.querySelector("#section-events tbody");
    var renderEvents = function (events) {
      if (!eventsBody || !events.length) return;
      eventsBody.innerHTML = events.map(function (e) {
        return "<tr>" +
          '<td class="mono-cell">' + fmtTime(e.at) + "</td>" +
          "<td>" + e.name + ' <span class="cell-dim">· ' + e.latencyMs + "&nbsp;ms</span></td>" +
          "<td>" + e.service + "</td>" +
          '<td class="mono-cell">' + e.region + "</td>" +
          "<td>" + statusPill(e.status) + "</td>" +
          "</tr>";
      }).join("");
    };

    // Incidents table + timeline
    var incidentsBody = document.querySelector("#section-incidents tbody");
    var renderIncidents = function (incidents) {
      if (!incidentsBody || !incidents.length) return;
      incidentsBody.innerHTML = incidents.map(function (inc) {
        var mins = Math.max(1, Math.round((Date.now() - new Date(inc.openedAt).getTime()) / 60000));
        return "<tr>" +
          '<td class="mono-cell">' + fmtTime(inc.openedAt) + "</td>" +
          "<td>" + inc.title + "</td>" +
          "<td>" + inc.service + "</td>" +
          '<td class="mono-cell">' + mins + "m</td>" +
          '<td><span class="status-pill down">Open</span></td>' +
          "</tr>";
      }).join("");
      var detail = document.getElementById("incident-detail");
      var detailTitle = document.getElementById("incident-detail-title");
      var detailTimeline = document.getElementById("incident-timeline");
      if (detail && detailTitle && detailTimeline) {
        detailTitle.textContent = incidents[0].title;
        detailTimeline.innerHTML = incidents[0].timeline.map(function (t) {
          return '<li><span class="tl-time">' + fmtTime(t.at) + "</span>" + t.text + "</li>";
        }).join("");
        detail.classList.remove("hidden");
      }
    };

    // Alert rules list
    var rulesBody = document.querySelector("#section-alerts tbody");
    var renderRules = function (rules) {
      if (!rulesBody || !rules.length) return;
      rulesBody.innerHTML = rules.map(function (r) {
        return "<tr>" +
          "<td>" + r.endpoint + "</td>" +
          '<td class="mono-cell">' + r.condition + "</td>" +
          "<td>" + r.channel + "</td>" +
          "<td>" + r.lastFired + "</td>" +
          "</tr>";
      }).join("");
    };

    // Notification log (fired alerts; Email entries only)
    var notifPanel = document.getElementById("notification-log-panel");
    var notifList = document.getElementById("notification-log-list");
    var renderNotifications = function (items) {
      if (!notifPanel || !notifList || !items.length) return;
      notifList.innerHTML = items.map(function (n) {
        return '<li><span class="tl-time">' + fmtTime(n.at) + "</span>" +
          n.message + ' <span class="cell-dim">· ' + n.endpoint + " " + n.condition + "</span></li>";
      }).join("");
      notifPanel.classList.remove("hidden");
    };

    // The Alert Rules panel renders for every signed-in account.
    var rulesPanel = document.getElementById("alert-rules-panel");
    if (rulesPanel) rulesPanel.classList.remove("hidden");
    var endpointSel = document.getElementById("rule-endpoint");
    var populateEndpoints = function (events) {
      if (!endpointSel) return;
      var seen = {};
      events.forEach(function (e) {
        if (seen[e.service]) return;
        seen[e.service] = true;
        var opt = document.createElement("option");
        opt.value = e.service;
        opt.textContent = e.service;
        endpointSel.appendChild(opt);
      });
    };

    var refreshRules = function () {
      apiGet("/api/rules", session).then(function (data) {
        if (data) renderRules(data.rules || []);
      });
    };

    if (session) {
      apiGet("/api/events", session).then(function (data) {
        var events = data && data.events ? data.events : [];
        renderEvents(events);
        populateEndpoints(events);
      });
      apiGet("/api/incidents", session).then(function (data) {
        if (data) renderIncidents(data.incidents || []);
      });
      refreshRules();
      apiGet("/api/notifications", session).then(function (data) {
        if (data) renderNotifications(data.notifications || []);
      });
    }

    var saveBtn = document.getElementById("rule-save-btn");
    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        var thresholdInput = document.getElementById("rule-threshold");
        var channelSel = document.getElementById("rule-channel");
        var threshold = thresholdInput ? thresholdInput.value.trim() : "";
        if (!/^>\d+\/\d+m$/.test(threshold)) return;
        apiPost("/api/rules", {
          endpoint: endpointSel ? endpointSel.value : "",
          threshold: threshold,
          channel: channelSel ? channelSel.value : "Email"
        }, session).then(function (result) {
          if (result.status !== 201) return;
          refreshRules();
          if (thresholdInput) thresholdInput.value = "";
        });
      });
    }
  }
})();
