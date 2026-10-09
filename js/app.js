/* ==========================================================================
   app.js - startup, the folder/identity gate, and routing.

   The app works whether index.html is opened from the PC or straight from
   the file share (\\server\share\...). Routing never touches
   location/history: for a page opened from a share the URL is
   file://server/share/... and Chrome treats any write to location there as
   a cross-origin load, which would silently stop the navigation. So the
   current screen is plain state in memory and views are swapped in place.
   No anchors with href, no reload, no iframes.
   ========================================================================== */
(function (global) {
  "use strict";

  var esc = global.Util.esc;
  var t = global.t;
  var S = global.Store;

  var state = {
    user: null,
    activeLockId: null,
    parts: ["dashboard"],
    query: {},
    wired: false,
    ticker: null
  };

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  /* ---------------------------------------------------- error presentation */

  /* Turns a DOMException into something a plant engineer can act on. */
  function describeError(e) {
    if (!e) { return t("err.read"); }
    var name = e.name || "";
    if (name === "AbortError") { return ""; }
    if (name === "NotAllowedError" || name === "SecurityError") { return t("err.folderDenied"); }
    if (name === "NoModificationAllowedError") { return t("err.folderReadOnly"); }
    if (name === "NotFoundError") { return t("err.folderGone"); }
    if (name === "QuotaExceededError" || name === "InvalidStateError") { return t("err.write"); }
    if (name === "TimeoutError") { return t("gate.stalled") + "\n\n" + (e.message || ""); }
    return (name ? name + ": " : "") + (e.message || String(e));
  }

  /* Always-visible readout, so a failure on a locked-down PC explains itself
     on screen instead of only in the console. */
  function diagnosticsHtml() {
    function row(label, ok, detail) {
      return '<div style="display:flex;gap:8px;justify-content:space-between">' +
        "<span>" + esc(label) + "</span>" +
        '<b style="color:' + (ok ? "var(--success)" : "var(--danger)") + '">' + esc(detail) + "</b></div>";
    }
    var idbOk = true;
    try { idbOk = !!global.indexedDB; } catch (e) { idbOk = false; }
    var proto = global.location.protocol + (global.location.host ? "//" + global.location.host : "");
    return '<details style="margin-top:14px"><summary class="small faint" style="cursor:pointer">' +
      esc(t("gate.diagnostics")) + "</summary>" +
      '<div class="small faint" style="margin-top:8px;display:flex;flex-direction:column;gap:4px">' +
        row(t("gate.diagOpenedFrom"), true, proto) +
        row(t("gate.diagSecure"), !!global.isSecureContext, global.isSecureContext ? t("common.yes") : t("common.no")) +
        row(t("gate.diagApi"), S.supported(), S.supported() ? t("common.yes") : t("common.no")) +
        row(t("gate.diagRemember"), idbOk, idbOk ? t("common.yes") : t("common.no")) +
        row(t("gate.diagPrefs"), global.Prefs.available, global.Prefs.available ? t("common.yes") : t("common.no")) +
      "</div>" +
      '<div class="small faint" style="margin-top:10px"><b>' + esc(t("gate.log")) + "</b></div>" +
      '<pre style="margin:4px 0 0;padding:8px;background:var(--bg-sunken);border-radius:6px;' +
        'font-size:.72rem;line-height:1.5;max-height:220px;overflow:auto;white-space:pre-wrap;' +
        'user-select:text">' + esc(S.logText() || "\u2014") + "</pre>" +
      "</details>";
  }

  /* ================================= GATE ================================= */

  function showGate(title, bodyHtml, withDiagnostics) {
    $("#app").classList.add("hidden");
    $("#gate").classList.remove("hidden");
    $("#gate-title").textContent = t("app.name");
    $("#gate-sub").textContent = title || t("app.tagline");
    $("#gate-body").innerHTML = bodyHtml;
    $("#gate-foot").innerHTML = withDiagnostics ? diagnosticsHtml() : "";
  }

  function hideGate() {
    $("#gate").classList.add("hidden");
    $("#app").classList.remove("hidden");
  }

  function errorBox(text) {
    if (!text) { return ""; }
    return '<div style="background:var(--danger-soft);color:var(--danger);padding:10px 12px;' +
      'border-radius:var(--radius-s);margin-bottom:14px;font-size:.87rem;white-space:pre-wrap">' +
      esc(text) + "</div>";
  }

  function infoBox(text) {
    if (!text) { return ""; }
    return '<div style="background:var(--accent-soft);color:var(--accent);padding:10px 12px;' +
      'border-radius:var(--radius-s);margin-bottom:14px;font-size:.87rem;white-space:pre-wrap">' +
      esc(text) + "</div>";
  }

  function gateUnsupported() {
    showGate(t("gate.unsupported.title"),
      '<div class="gate-step"><p>' + esc(t("gate.unsupported.desc")) + "</p></div>", true);
  }

  function stepsHtml(steps) {
    return '<div class="small" style="display:flex;flex-direction:column;gap:7px;margin-bottom:16px">' +
      steps.map(function (s) {
        var icon = s.ok === true ? "\u2713" : (s.ok === false ? "\u2717" : "\u00b7\u00b7\u00b7");
        var color = s.ok === true ? "var(--success)"
                  : (s.ok === false ? "var(--danger)" : "var(--text-faint)");
        return '<div style="display:flex;gap:9px;align-items:baseline">' +
          '<b style="color:' + color + ';flex:none;width:14px">' + icon + "</b>" +
          "<span>" + esc(s.label) +
          (s.detail ? ' <span class="faint">\u2014 ' + esc(s.detail) + "</span>" : "") +
          "</span></div>";
      }).join("") + "</div>";
  }

  function gateChooseFolder(errorText, extraHtml, noteText) {
    showGate(t("gate.choose.title"),
      '<div class="gate-step">' + errorBox(errorText) + infoBox(noteText) + (extraHtml || "") +
      "<p>" + esc(t("gate.choose.desc")) + "</p>" +
      '<button class="btn primary" id="g-choose">' + esc(t("gate.choose.button")) + "</button></div>", true);

    $("#g-choose").addEventListener("click", async function () {
      $("#g-choose").disabled = true;
      var steps = [];
      var LABELS = {
        picker: t("gate.step.picker"),
        permission: t("gate.step.permission"),
        permissionPrompt: t("gate.step.permissionPrompt"),
        remember: t("gate.step.remember")
      };
      function paint(pending) {
        var shown = steps.concat(pending ? [{ label: pending, ok: null }] : []);
        showGate(t("gate.preparing"), '<div class="gate-step">' + stepsHtml(shown) + "</div>", true);
      }

      try {
        await S.choose(function (key, ok, detail) {
          var label = LABELS[key] || key;
          if (ok === "opening") { paint(label); return; }
          var entry = null;
          steps.forEach(function (row) { if (row.key === key) { entry = row; } });
          var isBool = (ok === true || ok === false);
          var next = {
            key: key, label: label,
            ok: isBool ? ok : null,
            detail: isBool ? (detail || "") : String(ok || "")
          };
          if (entry) { entry.ok = next.ok; entry.detail = next.detail; }
          else { steps.push(next); }
          paint();
        });
      } catch (e) {
        var msg = describeError(e);
        S.log("choose", "failed " + ((e && e.name) || "") + " " + ((e && e.message) || ""));
        if (msg) {
          gateChooseFolder(msg, stepsHtml(steps));
        } else {
          // AbortError. Either the user cancelled, or Chrome refused the folder
          // for being a drive/share root - it reports both the same way, so say so.
          gateChooseFolder("", "", t("gate.cancelled") + "\n\n" + t("gate.cancelledHelp"));
        }
        return;
      }

      try {
        await afterConnect(steps);
      } catch (e) {
        S.log("afterConnect", "unhandled " + ((e && e.name) || "") + " " + ((e && e.message) || ""));
        gateChooseFolder(describeError(e), stepsHtml(steps));
      }
    });
  }

  function gateReconnect() {
    showGate(t("gate.reconnect.title"),
      '<div class="gate-step"><p>' + esc(t("gate.reconnect.desc")) + "</p>" +
      '<button class="btn primary" id="g-reconnect">' + esc(t("gate.reconnect.button")) + "</button> " +
      '<button class="btn ghost" id="g-other">' + esc(t("gate.choose.again")) + "</button></div>", true);

    $("#g-reconnect").addEventListener("click", async function () {
      try {
        var r = await S.restore(true);
        if (r === "ok") { await afterConnect(); return; }
      } catch (e) { gateChooseFolder(describeError(e)); return; }
      gateChooseFolder(t("gate.denied"));
    });
    $("#g-other").addEventListener("click", function () { gateChooseFolder(""); });
  }

  function gatePickUser(forced) {
    var list = S.users().filter(S.canSignIn);
    if (!list.length) {
      showGate(t("gate.who.title"),
        '<div class="gate-step"><p>' + esc(t("gate.who.empty")) + "</p>" +
        '<button class="btn primary" id="g-admin">' + esc(t("gate.who.admin")) + "</button></div>");
      $("#g-admin").addEventListener("click", function () {
        state.user = { id: "setup", name: "Administrator", role: "administrator" };
        enterApp("admin");
      });
      return;
    }

    showGate(t("gate.who.title"),
      '<div class="gate-step"><p>' + esc(t("gate.who.desc")) + "</p>" +
      infoBox(t("auth.engineersOnly")) +
      '<div class="field"><select class="input" id="g-user">' +
        list.map(function (u) {
          return '<option value="' + esc(u.id) + '">' + esc(global.Views.personName(u)) +
            (u.jobTitle ? " — " + esc(u.jobTitle) : "") + "</option>";
        }).join("") +
      "</select></div>" +
      '<button class="btn primary" id="g-ok">' + esc(t("common.confirm")) + "</button>" +
      (forced ? ' <button class="btn ghost" id="g-cancel">' + esc(t("common.cancel")) + "</button>" : "") +
      "</div>");

    $("#g-ok").addEventListener("click", function () {
      var user = S.userById($("#g-user").value);
      if (user && S.canSignIn(user)) { gateSignIn(user); }
    });
    if (forced) { $("#g-cancel").addEventListener("click", function () { enterApp(); }); }
  }

  /* Each person sets their own password the first time they sign in; after
     that it is asked once per browser session. */
  function gateSignIn(user, errorText) {
    var fresh = !user.password;
    var name = global.Views.personName(user);

    showGate(fresh ? t("auth.setTitle") : t("auth.enterTitle"),
      '<div class="gate-step">' + errorBox(errorText) +
        "<p>" + esc(t(fresh ? "auth.setDesc" : "auth.enterDesc", { name: name })) + "</p>" +
        '<div class="field"><label>' + esc(t(fresh ? "auth.newPassword" : "auth.password")) + "</label>" +
          '<input type="password" class="input" id="a-pw" autocomplete="' +
          (fresh ? "new-password" : "current-password") + '"></div>' +
        (fresh
          ? '<div class="field"><label>' + esc(t("auth.confirmPassword")) + "</label>" +
            '<input type="password" class="input" id="a-pw2" autocomplete="new-password"></div>'
          : "") +
        '<button class="btn primary" id="a-go">' + esc(t(fresh ? "auth.create" : "auth.signIn")) + "</button> " +
        '<button class="btn ghost" id="a-other">' + esc(t("auth.notYou")) + "</button>" +
      "</div>");

    async function submit() {
      var pw = $("#a-pw").value;
      if (fresh) {
        if (pw.length < 6) { gateSignIn(user, t("auth.short")); return; }
        if (pw !== $("#a-pw2").value) { gateSignIn(user, t("auth.mismatch")); return; }
        $("#a-go").disabled = true;
        try {
          var secret = await global.Util.makeSecret(pw);
          await S.setUserPassword(user.id, secret);
          S.log("signin", "password created for " + user.name);
        } catch (e) {
          gateSignIn(user, describeError(e));
          return;
        }
        signedIn(user);
        return;
      }

      $("#a-go").disabled = true;
      var ok = false;
      try { ok = await S.verifyUserPassword(user.id, pw); } catch (e) { ok = false; }
      if (!ok) { S.log("signin", "wrong password for " + user.name); gateSignIn(user, t("auth.wrong")); return; }
      signedIn(user);
    }

    $("#a-go").addEventListener("click", submit);
    $("#a-pw").addEventListener("keydown", function (e) { if (e.key === "Enter") { submit(); } });
    if ($("#a-pw2")) {
      $("#a-pw2").addEventListener("keydown", function (e) { if (e.key === "Enter") { submit(); } });
    }
    $("#a-other").addEventListener("click", function () {
      global.Prefs.remove("userId");
      gatePickUser(false);
    });
    $("#a-pw").focus();
  }

  function signedIn(user) {
    state.user = S.userById(user.id) || user;
    global.Prefs.set("userId", user.id);
    global.Session.set("auth." + user.id, true);
    S.log("signin", "signed in as " + user.name);
    enterApp();
  }

  /* ================================ STARTUP ================================ */

  async function afterConnect(priorSteps) {
    var steps = priorSteps || [];
    function paint(pending) {
      var shown = steps.concat(pending ? [{ label: pending, ok: null }] : []);
      showGate(t("gate.preparing"), '<div class="gate-step">' + stepsHtml(shown) + "</div>", true);
    }
    function fail(message) { gateChooseFolder(message, stepsHtml(steps)); }

    // 1. Is the folder genuinely writable? A Windows share handed out as
    //    read-only lets us open it and then refuses every write.
    paint(t("gate.step.createFolder"));
    var probe;
    try {
      probe = await S.probe();
    } catch (e) {
      steps.push({ label: t("gate.step.createFolder"), ok: false, detail: describeError(e) });
      fail(t("gate.shareReadOnly"));
      return;
    }

    steps.push({ label: t("gate.step.createFolder"), ok: probe.createFolder === true });
    if (probe.writeFile !== null) { steps.push({ label: t("gate.step.writeFile"), ok: probe.writeFile === true }); }
    if (probe.readBack !== null) { steps.push({ label: t("gate.step.readBack"), ok: probe.readBack === true }); }
    if (probe.deleteFile !== null) {
      steps.push({
        label: t("gate.step.deleteFile"),
        ok: probe.deleteFile === true,
        detail: probe.deleteFile === true ? "" : t("gate.step.optional")
      });
    }
    if (probe.createFolder !== true || probe.writeFile !== true || probe.readBack !== true) {
      // A stall and a refusal need different advice.
      var stalled = /^TimeoutError/.test(probe.error || "");
      fail((stalled ? t("gate.stalled") : t("gate.shareReadOnly")) +
        (probe.error ? "\n\n" + probe.error : ""));
      return;
    }

    // 2. Folder skeleton and seed data.
    paint(t("gate.step.prepare"));
    var fresh;
    try {
      fresh = await S.withTimeout(S.ensureScaffold(), 90000, t("gate.step.prepare"));
      steps.push({ label: t("gate.step.prepare"), ok: true });
    } catch (e) {
      steps.push({ label: t("gate.step.prepare"), ok: false, detail: describeError(e) });
      fail(t("gate.setupFailed"));
      return;
    }

    // 3. Staff list and equipment register.
    paint(t("gate.step.load"));
    try {
      await S.withTimeout(S.loadMaster(), 90000, t("gate.step.load"));
      steps.push({ label: t("gate.step.load"), ok: true });
    } catch (e) {
      steps.push({ label: t("gate.step.load"), ok: false, detail: describeError(e) });
      fail(t("gate.setupFailed"));
      return;
    }

    var savedId = global.Prefs.get("userId", null);
    var user = savedId ? S.userById(savedId) : null;
    if (user && !S.canSignIn(user)) { user = null; }

    if (!user) {
      gatePickUser(false);
      if (fresh) { setTimeout(function () { global.UI.toast(t("gate.firstRun")); }, 500); }
      return;
    }

    if (!global.Session.get("auth." + user.id, false)) {
      gateSignIn(user);
      if (fresh) { setTimeout(function () { global.UI.toast(t("gate.firstRun")); }, 500); }
      return;
    }

    state.user = user;
    enterApp();
    if (fresh) { global.UI.toast(t("gate.firstRun")); }
  }

  function enterApp(initialPath) {
    hideGate();
    paintUserChip();
    refreshBadges();
    if (!state.ticker) { state.ticker = setInterval(refreshBadges, 60000); }
    navigate(initialPath || "dashboard");
  }

  function paintUserChip() {
    var name = state.user ? global.Views.personName(state.user) : "";
    $("#user-name-label").textContent = name;
    $("#user-avatar").textContent = state.user ? global.Views.initials(name) : "?";
    var fs = $("#folder-status");
    if (fs) { fs.innerHTML = "<b>" + esc(t("profile.folder")) + "</b><br>" + esc(S.rootName()); }
  }

  /* Instant counter change (e.g. one notification opened) while the full
     recount from the share catches up. */
  function paintUnread(unread) {
    var badge = $("#nav-unread");
    var dot = $("#bell-dot");
    if (badge) {
      badge.textContent = global.Fmt.num(unread);
      badge.classList.toggle("hidden", unread === 0);
    }
    if (dot) { dot.classList.toggle("hidden", unread === 0); }
    state.unread = unread;
  }

  function adjustUnread(delta) { paintUnread(Math.max(0, (state.unread || 0) + delta)); }

  async function refreshBadges() {
    if (!S.connected()) { return; }
    try {
      var list = await S.listNotifications(60);
      var me = state.user;
      var unread = list.filter(function (n) { return global.Views.isUnread(n, me); }).length;
      paintUnread(unread);
    } catch (e) { /* the share may be briefly unreachable */ }
  }

  /* ================================= ROUTING =================================
     Screens are state, not URLs. Accepts "handover/new", "#/handover/new" or
     "handovers?s=open" so existing call sites keep working unchanged. */

  function parsePath(str) {
    var raw = String(str || "dashboard").replace(/^#\/?/, "").replace(/^\//, "");
    var query = {};
    var qPos = raw.indexOf("?");
    if (qPos >= 0) {
      raw.slice(qPos + 1).split("&").forEach(function (pair) {
        var kv = pair.split("=");
        query[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || "");
      });
      raw = raw.slice(0, qPos);
    }
    var parts = raw.split("/").filter(Boolean);
    return { parts: parts.length ? parts : ["dashboard"], query: query };
  }

  function navigate(str) {
    var r = parsePath(str);
    state.parts = r.parts;
    state.query = r.query;
    render();
  }

  async function render() {
    if (!S.connected()) { return; }
    var parts = state.parts;
    var query = state.query;
    var head = parts[0] || "dashboard";

    // Drop an edit lock when leaving a form.
    if (state.activeLockId && !(head === "handover" && parts[2] === "edit")) {
      S.releaseLock(state.activeLockId);
      state.activeLockId = null;
    }

    $$(".nav-item").forEach(function (el) {
      var key = el.getAttribute("data-route");
      el.classList.toggle("active", key === head ||
        (key === "handovers" && head === "handover") ||
        (key === "equipment" && head === "equipment"));
    });
    $("#sidenav").classList.remove("open");
    global.scrollTo(0, 0);

    try {
      if (head === "dashboard") { await global.Views.dashboard(); }
      else if (head === "handovers") { await global.Views.handoverList(query); }
      else if (head === "handover") {
        if (parts[1] === "new") { requireUser(function () { global.Views.handoverForm("new"); }); }
        else if (parts[2] === "edit") {
          state.activeLockId = parts[1];
          requireUser(function () { global.Views.handoverForm(parts[1]); });
        } else { await global.Views.handoverDetail(parts[1]); }
      }
      else if (head === "equipment") {
        if (parts[1]) { await global.Views.equipmentDetail(decodeURIComponent(parts[1])); }
        else { await global.Views.equipmentList(); }
      }
      else if (head === "notifications") { await global.Views.notifications(); }
      else if (head === "profile") { await global.Views.profile(); }
      else if (head === "admin") { await global.Views.admin(); }
      else if (head === "search") { await global.Views.search(query.q || ""); }
      else { navigate("dashboard"); }
    } catch (e) {
      document.getElementById("view").innerHTML =
        '<div class="empty"><p>' + esc(t("err.read")) + "</p>" +
        '<p class="small faint">' + esc(describeError(e)) + "</p>" +
        '<button class="btn" id="err-retry">' + esc(t("common.retry")) + "</button></div>";
      var retry = $("#err-retry");
      if (retry) { retry.addEventListener("click", function () { render(); }); }
    }
  }

  function requireUser(fn) {
    if (state.user && state.user.id !== "setup") { fn(); return; }
    if (!S.users().filter(function (u) { return u.active !== false; }).length) {
      document.getElementById("view").innerHTML =
        '<div class="empty"><p>' + esc(t("gate.who.empty")) + "</p>" +
        '<button class="btn" id="go-admin">' + esc(t("nav.admin")) + "</button></div>";
      $("#go-admin").addEventListener("click", function () { navigate("admin"); });
      return;
    }
    gatePickUser(true);
  }

  /* ============================== CHROME WIRING ============================== */

  function wireChrome() {
    if (state.wired) { return; }
    state.wired = true;

    $$(".nav-item").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.preventDefault();
        navigate(el.getAttribute("data-route"));
      });
    });

    $("#nav-toggle").addEventListener("click", function () { $("#sidenav").classList.toggle("open"); });
    $("#bell-btn").addEventListener("click", function () { navigate("notifications"); });
    $("#user-chip").addEventListener("click", function () { navigate("profile"); });
    $("#fab-new").addEventListener("click", function () { navigate("handover/new"); });

    var searchBox = $("#global-search");
    searchBox.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && searchBox.value.trim()) {
        navigate("search?q=" + encodeURIComponent(searchBox.value.trim()));
      }
    });

    // Any click outside a dropdown closes the open one.
    document.addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest(".dropdown")) { return; }
      $$(".dropdown-panel").forEach(function (panel) { panel.classList.add("hidden"); });
    });

    global.addEventListener("beforeunload", function () {
      if (state.activeLockId) { S.releaseLock(state.activeLockId); }
    });
  }

  /* ================================== BOOT ================================== */

  async function boot() {
    S.log("boot", global.location.href);
    S.log("boot", "secureContext=" + !!global.isSecureContext +
      " folderApi=" + S.supported() + " prefs=" + global.Prefs.available);
    global.I18N.setLang("en");
    wireChrome();

    if (!S.supported()) { gateUnsupported(); return; }

    if (global.location.host) { S.log("boot", "opened from the file share (host=" + global.location.host + ")"); }

    var restored;
    try {
      restored = await S.restore(false);
    } catch (e) {
      gateChooseFolder(describeError(e));
      return;
    }
    if (restored === "ok") { await afterConnect([]); }
    else if (restored === "needs-permission") { gateReconnect(); }
    else { gateChooseFolder(""); }
  }

  /* Starts over without reloading the page - a reload on a file-share URL
     is itself a navigation Chrome may refuse. */
  function reboot() {
    state.user = null;
    state.activeLockId = null;
    boot();
  }

  global.App = {
    user: function () { return state.user; },
    refreshBadges: refreshBadges,
    adjustUnread: adjustUnread,
    pickUser: function (forced) {
      if (state.user) { global.Session.remove("auth." + state.user.id); }
      gatePickUser(forced);
    },
    signIn: function (user) { gateSignIn(user); },
    navigate: navigate,
    route: render,
    reboot: reboot
  };

  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", boot); }
  else { boot(); }
})(window);
