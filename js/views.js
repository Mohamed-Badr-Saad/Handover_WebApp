/* ==========================================================================
   views.js - every screen in the app.
   Each render function paints into #view and then wires its own events.
   ========================================================================== */
(function (global) {
  "use strict";

  var esc = global.Util.esc;
  var t = global.t;
  var S = global.Store;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function view() { return document.getElementById("view"); }
  function go(path) { global.App.navigate(path); }

  /* ------------------------------------------------------- shared renderers */

  function statusBadge(status) {
    return '<span class="badge s-' + esc(status) + '">' + esc(t("status." + status)) + "</span>";
  }

  function personName(p) {
    if (!p) { return "—"; }
    return p.name || "—";
  }

  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/);
    var s = (parts[0] || "?").charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "");
    return s.toUpperCase();
  }

  function lookup(list, id) {
    for (var i = 0; i < (list || []).length; i++) { if (list[i].id === id) { return list[i]; } }
    return null;
  }

  function label(list, id) {
    var item = lookup(list, id);
    return item ? (item.en) : (id || "—");
  }

  function tagDesc(tag) {
    if (!tag) { return ""; }
    return (tag.descEn);
  }

  function tagChip(no, opts) {
    opts = opts || {};
    return '<span class="tag-chip' + (opts.link ? " link" : "") + '"' +
      (opts.link ? ' data-tag="' + esc(no) + '"' : "") + ">" + esc(no) +
      (opts.removable ? ' <span class="x" data-remove="' + esc(no) + '">×</span>' : "") +
      "</span>";
  }

  /* The author owns their handover. Everyone else can comment and attach,
     but not change what was written. Administration is the escape hatch for
     a record whose author has left. */
  function canEditHandover(rec) {
    if (adminUnlocked) { return true; }
    if (rec && rec.archived) { return false; }
    var me = global.App.user();
    return !!(me && rec && rec.createdBy && rec.createdBy.id === me.id);
  }

  function emptyBlock(message) {
    return '<div class="empty">' +
      '<svg viewBox="0 0 24 24" width="42" height="42"><path fill="currentColor" d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H5V5h14v14zM7 12h10v2H7zm0-4h10v2H7zm0 8h7v2H7z"/></svg>' +
      "<p>" + esc(message) + "</p></div>";
  }

  function handoverCard(h) {
    var st = S.structure();
    var tagHtml = (h.tags || []).slice(0, 4).map(function (no) { return tagChip(no); }).join(" ");
    var more = (h.tags || []).length > 4 ? ' <span class="faint small">+' + ((h.tags || []).length - 4) + "</span>" : "";
    var when = h.archived
      ? (h.createdAt ? global.Fmt.date(h.createdAt) : t("arc.dateUnknown"))
      : global.Fmt.ago(h.updatedAt);
    var place = h.area ? label(st.areas, h.area) : (h.location || "");
    return '<div class="row-card" data-id="' + esc(h.id) + '">' +
      '<div class="r1">' +
        "<h4>" + esc(h.title || "—") + "</h4>" + statusBadge(h.status) +
        (h.archived ? archiveBadge(h) : "") +
      "</div>" +
      (h.snippet ? '<div class="snippet">' + esc(h.snippet) + "</div>" : "") +
      '<div class="r2">' +
        "<span>" + esc(personName(h.createdBy)) + "</span>" +
        "<span>" + esc(when) + "</span>" +
        (place ? "<span>" + esc(place) + "</span>" : "") +
        (h.commentCount ? "<span>\u{1F4AC} " + global.Fmt.num(h.commentCount) + "</span>" : "") +
        (h.attachmentCount ? "<span>\u{1F4CE} " + global.Fmt.num(h.attachmentCount) + "</span>" : "") +
      "</div>" +
      "<div class=\"chips\" style=\"margin-top:8px\">" + tagHtml + more + "</div>" +
      "</div>";
  }

  function archiveBadge(h) {
    var text = t("arc.badge");
    return '<span class="badge" style="background:var(--bg-sunken);color:var(--text-soft)">' + esc(text) + "</span>";
  }

  function wireCards(root) {
    $$(".row-card", root).forEach(function (el) {
      el.addEventListener("click", function (e) {
        if (e.target.closest("[data-tag]")) { return; }
        go("#/handover/" + el.getAttribute("data-id"));
      });
    });
    $$("[data-tag]", root).forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        go("#/equipment/" + encodeURIComponent(el.getAttribute("data-tag")));
      });
    });
  }

  /* ============================== DASHBOARD ============================== */

  async function dashboard() {
    view().innerHTML = '<div class="empty">' + esc(t("common.loading")) + "</div>";
    var all = await S.listHandovers();
    var st = S.structure();
    var me = global.App.user();
    var today = global.Fmt.isoDay(new Date());
    var weekFrom = daysAgo(6), monthFrom = daysAgo(29);
    function within(h, from) {
      return h.status !== "draft" && h.createdAt && global.Fmt.isoDay(h.createdAt) >= from;
    }

    var submittedToday = all.filter(function (h) {
      return !h.archived && h.createdAt && global.Fmt.isoDay(h.createdAt) === today && h.status !== "draft";
    });
    var lastWeek = all.filter(function (h) { return within(h, weekFrom); });
    var lastMonth = all.filter(function (h) { return within(h, monthFrom); });
    var followUps = lastMonth.filter(function (h) { return h.status === S.FOLLOWUP; });
    function mine(h) { return me && h.createdBy && h.createdBy.id === me.id; }
    var myDrafts = all.filter(function (h) { return h.status === "draft" && mine(h); });
    var mySubmitted = all.filter(function (h) { return h.status !== "draft" && mine(h); });

    var byArea = {}, byType = {};
    lastMonth.forEach(function (h) {
      if (h.area) { byArea[h.area] = (byArea[h.area] || 0) + 1; }
      (h.tags || []).forEach(function (no) {
        var tag = S.tagByNumber(no);
        if (tag && tag.type) { byType[tag.type] = (byType[tag.type] || 0) + 1; }
      });
    });

    function countRows(map, list) {
      var keys = Object.keys(map).sort(function (a, b) { return map[b] - map[a]; });
      if (!keys.length) { return '<p class="faint small">' + esc(t("common.none")) + "</p>"; }
      var max = map[keys[0]] || 1;
      return keys.map(function (k) {
        return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:7px">' +
          '<span class="small" style="flex:0 0 150px">' + esc(label(list, k)) + "</span>" +
          '<span style="flex:1 1 auto;height:8px;border-radius:4px;background:var(--bg-sunken);overflow:hidden">' +
            '<span style="display:block;height:100%;width:' + Math.round((map[k] / max) * 100) + '%;background:var(--accent)"></span>' +
          "</span>" +
          '<b class="small" style="flex:0 0 26px;text-align:end">' + global.Fmt.num(map[k]) + "</b>" +
        "</div>";
      }).join("");
    }

    var recentTags = {};
    all.slice(0, 40).forEach(function (h) {
      (h.tags || []).forEach(function (no) { if (!recentTags[no]) { recentTags[no] = h.updatedAt; } });
    });
    var recentTagList = Object.keys(recentTags).slice(0, 12);

    view().innerHTML =
      '<div class="page-head"><div><h1>' + esc(t("dash.title")) + "</h1><p>" + esc(t("dash.sub")) + "</p></div>" +
        '<div class="spacer"></div>' +
        '<button class="btn primary" id="new-ho">' + esc(t("ho.new")) + "</button>" +
      "</div>" +

      '<div class="grid stats">' +
        stat(submittedToday.length, t("dash.submittedToday"), "#/handovers?d=today") +
        stat(lastWeek.length, t("dash.lastWeek"), "#/handovers?d=week") +
        stat(followUps.length, t("dash.followUps"), "#/handovers?s=" + S.FOLLOWUP + "&d=month") +
        stat(mySubmitted.length, t("dash.mySubmitted"), "#/handovers?s=notdraft&mine=1") +
        stat(myDrafts.length, t("dash.myDrafts"), "#/handovers?s=draft&mine=1") +
      "</div>" +

      '<div class="grid two" style="margin-top:16px">' +
        '<div class="card"><h3>' + esc(t("dash.byArea")) + "</h3>" + countRows(byArea, st.areas) + "</div>" +
        '<div class="card"><h3>' + esc(t("dash.byType")) + "</h3>" + countRows(byType, st.equipmentTypes) + "</div>" +
      "</div>" +

      '<div class="card" style="margin-top:16px"><h3>' + esc(t("dash.recentTags")) + "</h3>" +
        (recentTagList.length
          ? '<div class="chips">' + recentTagList.map(function (no) { return tagChip(no, { link: true }); }).join(" ") + "</div>"
          : '<p class="faint small">' + esc(t("common.none")) + "</p>") +
      "</div>" +

      '<h3 style="margin:22px 0 10px">' + esc(t("dash.recent")) + "</h3>" +
      (all.length
        ? '<div class="list">' + all.slice(0, 8).map(handoverCard).join("") + "</div>"
        : emptyBlock(t("dash.empty")));

    $("#new-ho").addEventListener("click", function () { go("#/handover/new"); });
    $$(".stat").forEach(function (el) {
      el.addEventListener("click", function () { go(el.getAttribute("data-go")); });
    });
    wireCards(view());
  }

  /* yyyy-mm-dd of the day n days before today (local time). */
  function daysAgo(n) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    return global.Fmt.isoDay(d);
  }

  function stat(n, labelText, href, alert) {
    return '<div class="stat' + (alert ? " alert" : "") + '" data-go="' + esc(href) + '">' +
      '<div class="n">' + global.Fmt.num(n) + "</div>" +
      '<div class="l">' + esc(labelText) + "</div></div>";
  }

  /* ============================ HANDOVER LIST ============================ */

  var listFilters = { q: "", status: "", area: "", from: "", to: "", creator: "", worked: "", tag: "", src: "", mine: false };
  var LIST_PAGE = 200;
  var lastListRows = [];

  async function handoverList(query) {
    var st = S.structure();
    var all = await S.listHandovers();

    if (query) {
      if (query.s && (S.STATUSES.indexOf(query.s) >= 0 || query.s === "notdraft")) { listFilters.status = query.s; }
      if (query.d === "today") { listFilters.from = global.Fmt.isoDay(new Date()); listFilters.to = ""; }
      if (query.tag) { listFilters.q = query.tag; }
      if (query.d === "week") { listFilters.from = daysAgo(6); listFilters.to = ""; }
      if (query.d === "month") { listFilters.from = daysAgo(29); listFilters.to = ""; }
      if (query.mine && global.App.user()) { listFilters.creator = global.App.user().id; }
    }

    var statusOptions = ['<option value="">' + esc(t("ho.status")) + " \u2013 " + esc(t("common.all")) + "</option>",
      '<option value="notdraft">' + esc(t("ho.notDraft")) + "</option>"]
      .concat(S.STATUSES.map(function (s) { return '<option value="' + s + '">' + esc(t("status." + s)) + "</option>"; }))
      .join("");

    var hasArchive = all.some(function (h) { return h.archived; });
    var shown = LIST_PAGE;

    view().innerHTML =
      '<div class="page-head"><div><h1>' + esc(t("ho.list")) + "</h1><p>" + esc(t("ho.listSub")) + "</p></div>" +
        '<div class="spacer"></div><button class="btn primary" id="new-ho">' + esc(t("ho.new")) + "</button></div>" +

      '<div class="filters">' +
        '<input type="search" id="f-q" placeholder="' + esc(t("search.placeholder")) + '" style="min-width:230px">' +
        '<select id="f-status">' + statusOptions + "</select>" +
        '<select id="f-area"><option value="">' + esc(t("ho.area")) + " – " + esc(t("common.all")) + "</option>" +
          st.areas.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc((a.en)) + "</option>"; }).join("") + "</select>" +
        '<select id="f-worked" title="' + esc(t("ho.workedBy")) + '"><option value="">' + esc(t("ho.workedBy")) + " \u2013 " + esc(t("common.anyone")) + "</option>" +
          peopleOptions(listFilters.worked) + "</select>" +
        '<input type="date" id="f-from" title="' + esc(t("ho.from")) + '">' +
        '<input type="date" id="f-to" title="' + esc(t("ho.to")) + '">' +
        '<input id="f-tag" placeholder="' + esc(t("ho.filterTag")) + '" style="min-width:140px">' +
        (hasArchive
          ? '<select id="f-src" title="' + esc(t("arc.filter")) + '">' +
              '<option value="">' + esc(t("arc.filterAll")) + "</option>" +
              '<option value="live">' + esc(t("arc.filterLive")) + "</option>" +
              '<option value="archive">' + esc(t("arc.filterArchive")) + "</option></select>"
          : "") +
        '<button class="btn sm ghost" id="f-clear">' + esc(t("common.clear")) + "</button>" +
        '<button class="btn sm" id="f-export">' + esc(t("ho.exportCsv")) + "</button>" +
      "</div>" +
      '<div id="f-chips" class="chips" style="margin:-4px 0 12px"></div>' +
      '<div id="ho-results"></div>';

    $("#f-q").value = listFilters.q;
    $("#f-status").value = listFilters.status;
    $("#f-area").value = listFilters.area;
    $("#f-worked").value = listFilters.worked;
    $("#f-from").value = listFilters.from;
    $("#f-to").value = listFilters.to;
    $("#f-tag").value = listFilters.tag;
    if ($("#f-src")) { $("#f-src").value = listFilters.src; }

    function apply() {
      listFilters.q = $("#f-q").value;
      listFilters.status = $("#f-status").value;
      listFilters.area = $("#f-area").value;
      listFilters.worked = $("#f-worked").value;
      listFilters.from = $("#f-from").value;
      listFilters.to = $("#f-to").value;
      listFilters.tag = $("#f-tag").value;
      listFilters.src = $("#f-src") ? $("#f-src").value : "";
      shown = LIST_PAGE;
      render();
    }

    function render() {
      var q = global.Util.normalize(listFilters.q);
      var now = new Date();
      var rows = all.filter(function (h) {
        if (listFilters.status === "notdraft") { if (h.status === "draft") { return false; } }
        else if (listFilters.status && h.status !== listFilters.status) { return false; }

        if (listFilters.area && h.area !== listFilters.area) { return false; }
        if (listFilters.creator && (!h.createdBy || h.createdBy.id !== listFilters.creator)) { return false; }
        if (listFilters.worked) {
          var byAuthor = h.createdBy && h.createdBy.id === listFilters.worked;
          if (!byAuthor && (h.teamIds || []).indexOf(listFilters.worked) < 0) { return false; }
        }
        if (listFilters.src === "live" && h.archived) { return false; }
        if (listFilters.src === "archive" && !h.archived) { return false; }
        if ((listFilters.from || listFilters.to) && !h.createdAt) { return false; }
        if (listFilters.from && global.Fmt.isoDay(h.createdAt) < listFilters.from) { return false; }
        if (listFilters.to && global.Fmt.isoDay(h.createdAt) > listFilters.to) { return false; }
        if (listFilters.tag) {
          var want = global.Util.normalize(listFilters.tag);
          var onTag = (h.tags || []).some(function (n) { return global.Util.normalize(n).indexOf(want) >= 0; });
          if (!onTag) { return false; }
        }
        if (q && S.searchText(h).indexOf(q) < 0) { return false; }
        return true;
      });

      lastListRows = rows;
      // "Written by" comes only from the dashboard tile, so show it as a chip
      // that can be removed rather than as another dropdown.
      var author = listFilters.creator ? S.userById(listFilters.creator) : null;
      $("#f-chips").innerHTML = listFilters.creator
        ? '<span class="tag-chip" style="font-family:inherit">' + esc(t("ho.writtenBy")) + ": " +
            esc(author ? personName(author) : listFilters.creator) + ' <span class="x" id="f-creator-x">\u00d7</span></span>'
        : "";
      if ($("#f-creator-x")) {
        $("#f-creator-x").addEventListener("click", function () { listFilters.creator = ""; shown = LIST_PAGE; render(); });
      }
      // Thousands of imported entries would make one giant page, so draw a
      // page at a time. Filters and the CSV export still cover every match.
      var visible = rows.slice(0, shown);
      $("#ho-results").innerHTML =
        '<p class="small faint" style="margin:0 0 10px">' + esc(t("ho.results", { n: global.Fmt.num(rows.length) })) +
          (rows.length > visible.length ? " \u00b7 " + esc(t("arc.showing", { shown: global.Fmt.num(visible.length), n: global.Fmt.num(rows.length) })) : "") +
        "</p>" +
        (rows.length ? '<div class="list">' + visible.map(handoverCard).join("") + "</div>"
                     : emptyBlock(all.length ? t("ho.none") : t("ho.noneYet"))) +
        (rows.length > visible.length
          ? '<div style="text-align:center;margin:14px 0"><button class="btn" id="ho-more">' +
              esc(t("arc.showMore", { n: global.Fmt.num(Math.min(LIST_PAGE, rows.length - visible.length)) })) + "</button></div>"
          : "");
      wireCards($("#ho-results"));
      if ($("#ho-more")) {
        $("#ho-more").addEventListener("click", function () { shown += LIST_PAGE; render(); });
      }
    }

    $("#f-q").addEventListener("input", global.Util.debounce(apply, 220));
    ["#f-status", "#f-area", "#f-worked", "#f-from", "#f-to", "#f-src"].forEach(function (sel) {
      if ($(sel)) { $(sel).addEventListener("change", apply); }
    });
    $("#f-tag").addEventListener("input", global.Util.debounce(apply, 220));
    $("#f-clear").addEventListener("click", function () {
      listFilters = { q: "", status: "", area: "", from: "", to: "", creator: "", worked: "", tag: "", src: "", mine: false };
      handoverList(null);
    });
    $("#f-export").addEventListener("click", function () { exportHandovers(lastListRows); });
    $("#new-ho").addEventListener("click", function () { go("#/handover/new"); });

    render();
  }

  /* ------------------------------------------------------------- CSV export */

  function csvCell(v) {
    var str = (v === null || v === undefined) ? "" : String(v);
    if (/[",;\n\r]/.test(str)) { return '"' + str.replace(/"/g, '""') + '"'; }
    return str;
  }

  function downloadCsv(filename, head, rows) {
    var lines = [head].concat(rows).map(function (r) { return r.map(csvCell).join(","); });
    // The BOM makes Excel read the file as UTF-8 (degree signs, µ, etc.).
    var blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }

  /* Exports whatever the list filters currently match - date range, creator,
     area, equipment tag, status or free text. */
  async function exportHandovers(headers) {
    if (!headers || !headers.length) { global.UI.toast(t("ho.exportNone")); return; }
    global.UI.busy(true, t("ho.exportPreparing"));
    try {
      var st = S.structure();
      var rows = [];
      for (var i = 0; i < headers.length; i++) {
        var rec = (headers[i].fromArchive ? S.archivedRecord(headers[i].id) : await S.getHandover(headers[i].id)) || headers[i];
        var upper = upperOf(rec.tags);
        rows.push([
          rec.id,
          rec.title || "",
          t("status." + rec.status) + (rec.legacyStatus && !/^(info|info \+ follow up|follow up)$/i.test(rec.legacyStatus) ? " (" + rec.legacyStatus + ")" : ""),
          rec.area ? label(st.areas, rec.area) : (rec.location || ""),
          personName(rec.createdBy),
          rec.archived ? (rec.createdAt ? global.Fmt.date(rec.createdAt) : "") : global.Fmt.dateTime(rec.createdAt),
          rec.archived && !rec.createdAt ? "" : global.Fmt.dateTime(rec.updatedAt),
          rec.dueDate ? global.Fmt.date(rec.dueDate) : "",
          (rec.tags || []).join(" | "),
          upper === "\u2014" ? "" : upper,
          (rec.team || []).map(function (m) { return personName(m); }).join(" | "),
          (rec.attachments || []).length,
          rec.description || "",
          (rec.comments || []).map(function (c) {
            return personName(c.by) + " (" + global.Fmt.date(c.at) + "): " + c.text;
          }).join(" | ")
        ]);
      }
      downloadCsv("handovers-" + global.Fmt.isoDay(new Date()) + ".csv", [
        t("csv.id"), t("ho.title"), t("ho.status"), t("ho.area"), t("ho.createdBy"),
        t("ho.createdAt"), t("ho.updatedAt"), t("ho.due"), t("ho.tags"), t("eq.upper"),
        t("ho.team"), t("ho.attachments"), t("ho.description"), t("ho.comments")
      ], rows);
      global.UI.toast(t("ho.exportDone", { n: global.Fmt.num(rows.length) }), "ok");
    } catch (e) {
      global.UI.toast(t("err.read"), "err");
    }
    global.UI.busy(false);
  }

  function kindOption(value, title, desc) {
    return '<label class="kind-opt kind-' + value + '">' +
      '<input type="radio" name="f-kind" value="' + value + '">' +
      '<span class="kind-mark" aria-hidden="true"></span>' +
      '<span class="kind-body"><span class="kind-title">' + esc(title) + "</span>" +
        '<span class="kind-desc">' + esc(desc) + "</span></span>" +
      "</label>";
  }

  /* People grouped by role, for the "Worked on by" filter. */
  function peopleOptions(selected) {
    var groups = [
      { label: t("ho.engineers"), roles: ["engineer"] },
      { label: t("ho.supervisors"), roles: ["supervisor"] },
      { label: t("ho.technicians"), roles: ["technician"] },
      { label: t("ho.others"), roles: ["administrator", "viewer", ""] }
    ];
    var list = S.users().slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    return groups.map(function (g) {
      var members = list.filter(function (u) { return g.roles.indexOf(u.role || "") >= 0; });
      if (!members.length) { return ""; }
      return '<optgroup label="' + esc(g.label) + '">' + members.map(function (u) {
        return '<option value="' + esc(u.id) + '"' + (u.id === selected ? " selected" : "") + ">" +
          esc(personName(u)) + (u.active === false ? " (" + esc(t("ho.inactive")) + ")" : "") + "</option>";
      }).join("") + "</optgroup>";
    }).join("");
  }

  function teamDropdownShell(prefix, label) {
    return '<div class="dropdown">' +
      '<button type="button" class="btn dd-btn" id="' + prefix + '-btn">' + esc(label) + "</button>" +
      '<div class="dropdown-panel hidden" id="' + prefix + '-panel"></div></div>';
  }

  /* ============================ HANDOVER FORM ============================ */

  async function handoverForm(id) {
    var st = S.structure();
    var isNew = !id || id === "new";
    var rec = null;

    if (!isNew) {
      rec = await S.getHandover(id);
      if (!rec) { view().innerHTML = emptyBlock(t("err.notFound")); return; }
      if (!canEditHandover(rec)) { view().innerHTML = emptyBlock(t(rec.archived ? "arc.cannotEdit" : "own.cannotEdit")); return; }
      var lock = await S.readLock(id);
      var me = global.App.user();
      if (lock && lock.by && me && lock.by !== me.id) {
        var proceed = await global.UI.confirm(
          t("ho.lockedBy", { name: lock.name, time: global.Fmt.time(lock.at) }),
          { okLabel: t("ho.lockedTakeOver") }
        );
        if (!proceed) { go("#/handover/" + id); return; }
      }
      await S.writeLock(id, global.App.user());
    }

    var chosenTags = rec ? (rec.tags || []).slice() : [];
    var chosenTeam = rec ? (rec.team || []).slice() : [];

    view().innerHTML =
      '<div class="page-head"><div><h1>' + esc(isNew ? t("ho.new") : t("ho.edit")) + "</h1></div></div>" +
      '<div class="card" style="max-width:840px">' +
        '<div class="field"><label>' + esc(t("ho.title")) + ' <span class="req">*</span></label>' +
          '<input class="input" id="f-title" maxlength="160" placeholder="' + esc(t("ho.titlePh")) + '">' +
          '<div class="err-msg hidden" id="e-title"></div></div>' +

        '<div class="field"><label>' + esc(t("ho.description")) + ' <span class="req">*</span></label>' +
          '<textarea class="input" id="f-desc" rows="7" placeholder="' + esc(t("ho.descriptionPh")) + '"></textarea>' +
          '<div class="err-msg hidden" id="e-desc"></div></div>' +

        '<div class="form-row">' +
          '<div class="field"><label>' + esc(t("ho.area")) + "</label>" +
            '<div style="display:flex;gap:7px">' +
              '<select class="input" id="f-area">' + areaOptions(rec ? rec.area : "") + "</select>" +
              '<button class="btn" id="f-area-add" title="' + esc(t("area.add")) + '" style="flex:none">+</button>' +
            "</div></div>" +
          '<div class="field"><label>' + esc(t("ho.due")) + ' <span class="faint">(' + esc(t("common.optional")) + ')</span></label>' +
            '<input type="date" class="input" id="f-due"></div>' +
        "</div>" +

        '<div class="field"><label>' + esc(t("ho.kind")) + ' <span class="req">*</span></label>' +
          '<div class="kind-picker" id="f-kind" role="radiogroup">' +
            kindOption("info", t("status.info"), t("ho.kindInfo")) +
            kindOption(S.FOLLOWUP, t("status." + S.FOLLOWUP), t("ho.kindFollow")) +
          "</div>" +
          '<div class="small faint" style="margin-top:7px">' + esc(t("ho.kindHint")) + "</div></div>" +

        '<div class="field"><label>' + esc(t("ho.team")) + "</label>" +
          '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-bottom:10px">' +
            teamDropdownShell("dd-eng", t("ho.engineers")) +
            teamDropdownShell("dd-tech", t("ho.technicians")) +
          "</div>" +
          '<div class="chips" id="team-chips"></div>' +
          '<div class="small faint" style="margin-top:6px">' + esc(t("ho.teamHint")) + "</div></div>" +

        '<div class="field"><label>' + esc(t("ho.tags")) + ' <span class="faint">(' + esc(t("common.optional")) + ')</span></label>' +
          '<div class="chips" id="tag-chips" style="margin-bottom:8px"></div>' +
          '<input class="input" id="tag-input" autocomplete="off" placeholder="' + esc(t("ho.tagsPh")) + '">' +
          '<div class="chips" id="tag-sugs" style="margin-top:8px"></div>' +
          '<div class="small faint" style="margin-top:6px">' + esc(t("ho.tagsHint")) + "</div>" +
          '<div class="err-msg hidden" id="e-tags"></div></div>' +


        '<div class="btn-row" style="margin-top:8px">' +
          '<button class="btn primary" id="btn-submit">' + esc(isNew ? t("ho.submit") : t("ho.saveChanges")) + "</button>" +
          (isNew || (rec && rec.status === "draft")
            ? '<button class="btn" id="btn-draft">' + esc(t("ho.saveDraft")) + "</button>" : "") +
          '<button class="btn ghost" id="btn-cancel">' + esc(t("common.cancel")) + "</button>" +
        "</div>" +
      "</div>";

    if (rec) {
      $("#f-title").value = rec.title || "";
      $("#f-desc").value = rec.description || "";
      $("#f-due").value = rec.dueDate ? global.Fmt.isoDay(rec.dueDate) : "";
    }
    // Drafts remember which kind they were going to be; default is Info.
    var kindNow = rec ? (rec.status !== "draft" ? rec.status : (rec.kind || "info")) : "info";
    $$('input[name="f-kind"]').forEach(function (r) { r.checked = r.value === kindNow; });
    function chosenKind() {
      var r = document.querySelector('input[name="f-kind"]:checked');
      return r ? r.value : "info";
    }

    function renderChips() {
      $("#tag-chips").innerHTML = chosenTags.length
        ? chosenTags.map(function (no) { return tagChip(no, { removable: true }); }).join(" ")
        : '<span class="faint small">' + esc(t("common.none")) + "</span>";
      $$("#tag-chips [data-remove]").forEach(function (x) {
        x.addEventListener("click", function () {
          chosenTags = chosenTags.filter(function (n) { return n !== x.getAttribute("data-remove"); });
          renderChips();
        });
      });
    }
    renderChips();

    function renderSugs() {
      var q = global.Util.normalize($("#tag-input").value);
      if (!q) { $("#tag-sugs").innerHTML = ""; return; }
      var matches = S.tags().filter(function (tag) {
        if (chosenTags.indexOf(tag.tagNo) >= 0) { return false; }
        var hay = global.Util.normalize(tag.tagNo + " " + tag.descEn);
        return hay.indexOf(q) >= 0;
      }).slice(0, 8);
      $("#tag-sugs").innerHTML = matches.length
        ? matches.map(function (tag) {
            return '<span class="tag-chip link" data-add="' + esc(tag.tagNo) + '">' +
              esc(tag.tagNo) + ' <span class="faint" style="font-weight:400">' + esc(tagDesc(tag)) + "</span></span>";
          }).join(" ")
        : '<button class="btn sm" data-new="1">' +
            esc(t("eq.addMissing", { tag: $("#tag-input").value.trim().toUpperCase() })) + "</button>";
      $$("#tag-sugs [data-add]").forEach(function (el) {
        el.addEventListener("click", function () {
          chosenTags.push(el.getAttribute("data-add"));
          $("#tag-input").value = "";
          $("#tag-sugs").innerHTML = "";
          renderChips();
        });
      });
      var newBtn = $("#tag-sugs [data-new]");
      if (newBtn) {
        newBtn.addEventListener("click", function () {
          tagDialog({
            prefillNo: $("#tag-input").value.trim().toUpperCase(),
            onDone: function (tag) {
              chosenTags.push(tag.tagNo);
              $("#tag-input").value = "";
              $("#tag-sugs").innerHTML = "";
              renderChips();
            }
          });
        });
      }
    }
    /* Engineers dropdown lists everyone who is not a technician, so the
       supervisor is selectable too. Technicians dropdown lists technicians. */
    function teamCandidates(kind) {
      var me = global.App.user();
      return S.users().filter(function (u) {
        if (u.active === false) { return false; }
        if (me && u.id === me.id) { return false; }
        return kind === "tech" ? u.role === "technician" : u.role !== "technician";
      }).sort(function (a, b) { return personName(a).localeCompare(personName(b)); });
    }

    function buildTeamPanel(prefix, kind) {
      var people = teamCandidates(kind);
      var panel = $("#" + prefix + "-panel");
      panel.innerHTML = people.length ? people.map(function (u) {
        var on = chosenTeam.some(function (m) { return m.id === u.id; });
        return "<label><input type=\"checkbox\" data-uid=\"" + esc(u.id) + "\"" + (on ? " checked" : "") + ">" +
          "<span>" + esc(personName(u)) + "</span>" +
          '<span class="dd-role">' + esc(u.jobTitle || t("role." + (u.role || "technician"))) + "</span></label>";
      }).join("") : '<div class="dd-empty">' + esc(t("common.none")) + "</div>";

      $$("#" + prefix + "-panel input[data-uid]").forEach(function (cb) {
        cb.addEventListener("change", function () {
          var u = S.userById(cb.getAttribute("data-uid"));
          if (!u) { return; }
          if (cb.checked) {
            if (!chosenTeam.some(function (m) { return m.id === u.id; })) {
              chosenTeam.push({
                id: u.id, name: u.name,
                role: u.role || "technician", jobTitle: u.jobTitle || ""
              });
            }
          } else {
            chosenTeam = chosenTeam.filter(function (m) { return m.id !== u.id; });
          }
          renderTeam();
        });
      });
    }

    function renderTeam() {
      var engN = chosenTeam.filter(function (m) { return m.role !== "technician"; }).length;
      var techN = chosenTeam.filter(function (m) { return m.role === "technician"; }).length;
      $("#dd-eng-btn").textContent = t("ho.engineers") + (engN ? " \u00b7 " + global.Fmt.num(engN) : "");
      $("#dd-tech-btn").textContent = t("ho.technicians") + (techN ? " \u00b7 " + global.Fmt.num(techN) : "");

      $("#team-chips").innerHTML = chosenTeam.length
        ? chosenTeam.map(function (m) {
            return '<span class="tag-chip" style="font-family:inherit">' + esc(personName(m)) +
              '<span class="faint" style="font-weight:400"> \u00b7 ' +
              esc(m.jobTitle || t("role." + (m.role || "technician"))) + "</span>" +
              ' <span class="x" data-rm-team="' + esc(m.id) + '">\u00d7</span></span>';
          }).join(" ")
        : '<span class="faint small">' + esc(t("ho.teamNone")) + "</span>";

      $$("#team-chips [data-rm-team]").forEach(function (x) {
        x.addEventListener("click", function () {
          chosenTeam = chosenTeam.filter(function (m) { return m.id !== x.getAttribute("data-rm-team"); });
          renderTeam();
        });
      });

      buildTeamPanel("dd-eng", "eng");
      buildTeamPanel("dd-tech", "tech");
    }
    renderTeam();

    [["dd-eng-btn", "dd-eng-panel"], ["dd-tech-btn", "dd-tech-panel"]].forEach(function (pair) {
      $("#" + pair[0]).addEventListener("click", function (e) {
        e.stopPropagation();
        var panel = $("#" + pair[1]);
        var wasOpen = !panel.classList.contains("hidden");
        $$(".dropdown-panel").forEach(function (p) { p.classList.add("hidden"); });
        panel.classList.toggle("hidden", wasOpen);
      });
    });

    $("#tag-input").addEventListener("input", global.Util.debounce(renderSugs, 140));
    $("#f-area-add").addEventListener("click", function () {
      newAreaDialog(function (code) { $("#f-area").innerHTML = areaOptions(code); });
    });


    async function save(status) {
      var title = $("#f-title").value.trim();
      var desc = $("#f-desc").value.trim();
      var ok = true;
      function setErr(sel, msg) {
        var el = $(sel);
        el.textContent = msg || "";
        el.classList.toggle("hidden", !msg);
        if (msg) { ok = false; }
      }
      setErr("#e-title", title ? "" : t("err.titleRequired"));
      setErr("#e-desc", desc ? "" : t("err.descRequired"));
      if (!ok) { return; }

      var me = global.App.user();
      var now = new Date().toISOString();
      global.UI.busy(true, t("common.saving"));
      try {
        if (isNew) {
          rec = {
            id: global.Util.uuid(),
            version: 0,
            title: title, description: desc,
            plant: "", area: $("#f-area").value,
            unit: "", shift: "",
            tags: chosenTags,
            team: chosenTeam,
            status: status,
            kind: chosenKind(),
            dueDate: $("#f-due").value || null,
            createdBy: { id: me.id, name: me.name },
            createdAt: now,
            updatedAt: now,
            history: [{ status: status, by: personName(me), byId: me.id, at: now }],
            comments: [],
            attachments: []
          };
          await S.saveHandover(rec);
          if (status !== "draft") {
            await S.addNotification({ type: "handover", actor: { id: me.id, name: me.name }, handoverId: rec.id, title: title });
          }
        } else {
          var expected = rec.version || 0;
          rec.title = title;
          rec.description = desc;
          rec.area = $("#f-area").value;
          rec.tags = chosenTags;
          rec.team = chosenTeam;
          rec.dueDate = $("#f-due").value || null;
          rec.kind = chosenKind();
          var wasDraft = rec.status === "draft";
          if (status !== rec.status) {
            rec.status = status;
            rec.history = (rec.history || []).concat([{ status: status, by: personName(me), byId: me.id, at: now }]);
          }
          await S.saveHandoverChecked(rec, expected);
          await S.releaseLock(rec.id);
          if (wasDraft && status !== "draft") {
            await S.addNotification({ type: "handover", actor: { id: me.id, name: me.name }, handoverId: rec.id, title: title });
          }
        }
        global.UI.busy(false);
        global.UI.toast(isNew ? t("ho.created") : t("ho.updated"), "ok");
        go("#/handover/" + rec.id);
      } catch (e) {
        global.UI.busy(false);
        if (e && e.name === "ConflictError") { global.UI.toast(t("ho.conflict"), "err"); }
        else { global.UI.toast(t("err.write"), "err"); }
      }
    }

    $("#btn-submit").addEventListener("click", function () { save(chosenKind()); });
    if ($("#btn-draft")) { $("#btn-draft").addEventListener("click", function () { save("draft"); }); }
    $("#btn-cancel").addEventListener("click", function () {
      if (rec && rec.id) { S.releaseLock(rec.id); go("#/handover/" + rec.id); }
      else { go("#/handovers"); }
    });
  }

  function selectField(id, labelText, list, selected) {
    return '<div class="field"><label>' + esc(labelText) + "</label>" +
      '<select class="input" id="' + id + '">' +
      '<option value="">' + esc(t("common.select")) + "</option>" +
      (list || []).map(function (o) {
        return '<option value="' + esc(o.id) + '"' + (o.id === selected ? " selected" : "") + ">" +
          esc((o.en)) + "</option>";
      }).join("") +
      "</select></div>";
  }

  /* =========================== HANDOVER DETAIL =========================== */

  async function handoverDetail(id) {
    var rec = await S.getHandover(id);
    if (!rec) { view().innerHTML = emptyBlock(t("err.notFound")); return; }
    var st = S.structure();
    var me = global.App.user();
    var mayEdit = canEditHandover(rec);

    var activity = (rec.history || []).map(function (h) {
      return { at: h.at, text: t("ho.statusChanged") + ": " + t("status." + h.status), who: h.by };
    });
    (rec.comments || []).forEach(function (c) { activity.push({ at: c.at, text: t("ho.commentAdded"), who: personName(c.by) }); });
    (rec.attachments || []).forEach(function (a) { activity.push({ at: a.at, text: t("ho.attachmentAdded") + ": " + a.name, who: a.by ? personName(a.by) : "" }); });
    if (rec.archived) {
      activity.push({ at: rec.createdAt, dateOnly: true, text: t("arc.imported") + (rec.legacyStatus ? " \u00b7 " + rec.legacyStatus : ""), who: personName(rec.createdBy) });
    }
    activity.sort(function (a, b) { return String(b.at || "").localeCompare(String(a.at || "")); });
    var createdText = rec.archived
      ? (rec.createdAt ? global.Fmt.date(rec.createdAt) : t("arc.dateUnknown"))
      : global.Fmt.dateTime(rec.createdAt);
    var authorText = personName(rec.createdBy) +
      (rec.archived && rec.createdBy && rec.createdBy.original && rec.createdBy.original !== rec.createdBy.name
        ? " (" + t("arc.writtenAs") + " \u201c" + rec.createdBy.original + "\u201d)" : "");
    var notice = "";
    if (rec.archived) { notice = t("arc.banner", { source: rec.source || "Excel" }); }
    else if (!mayEdit) { notice = t("own.onlyAuthor", { name: personName(rec.createdBy) }); }

    view().innerHTML =
      '<div class="page-head">' +
        "<div>" +
          '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
            "<h1>" + esc(rec.title) + "</h1>" + statusBadge(rec.status) + (rec.archived ? archiveBadge(rec) : "") +
          "</div>" +
          '<p>' + esc(t("ho.createdBy")) + " " + esc(authorText) + " · " + esc(createdText) + "</p>" +
        "</div>" +
        '<div class="spacer"></div>' +
        '<div class="btn-row">' +
          (mayEdit ? '<button class="btn" id="btn-status">' + esc(t("ho.changeStatus")) + "</button>" : "") +
          (mayEdit ? '<button class="btn" id="btn-edit">' + esc(t("common.edit")) + "</button>" : "") +
          (mayEdit ? '<button class="btn danger" id="btn-delete">' + esc(t("del.button")) + "</button>" : "") +
          '<button class="btn ghost" id="btn-back">' + esc(t("common.back")) + "</button>" +
        "</div>" +
      "</div>" +
      (notice
        ? '<div id="ho-notice" style="background:var(--bg-sunken);color:var(--text-soft);padding:10px 13px;' +
          'border-radius:var(--radius-s);margin-bottom:14px;font-size:.87rem">' + esc(notice) + "</div>"
        : "") +

      '<div class="detail-grid">' +
        "<div>" +
          '<div class="card"><h3>' + esc(t("ho.description")) + "</h3>" +
            '<div class="prose">' + esc(rec.description || "") + "</div></div>" +

          '<div class="card"><h3>' + esc(t("ho.attachments")) + " (" + global.Fmt.num((rec.attachments || []).length) + ")</h3>" +
            '<div class="attach-grid" id="attach-grid"></div>' +
            '<div class="dropzone" id="dropzone" style="margin-top:12px">' + esc(t("ho.dropFiles")) + "<br>" +
              '<span class="small faint">' + esc(t("ho.fileTypes", { mb: global.Util.MAX_MB })) + "</span></div>" +
            '<input type="file" id="file-input" multiple class="hidden">' +
          "</div>" +

          '<div class="card"><h3>' + esc(t("ho.comments")) + " (" + global.Fmt.num((rec.comments || []).length) + ")</h3>" +
            '<div id="comment-list"></div>' +
            '<div style="margin-top:12px">' +
              '<textarea class="input" id="c-text" rows="3" placeholder="' + esc(t("ho.commentPh")) + '"></textarea>' +
              '<div class="btn-row" style="margin-top:8px">' +
                '<button class="btn primary" id="c-post">' + esc(t("ho.post")) + "</button>" +
              "</div>" +
            "</div>" +
          "</div>" +
        "</div>" +

        "<div>" +
          '<div class="card"><h3>' + esc(t("eq.details")) + "</h3>" +
            '<div class="meta-list">' +
              meta(t("ho.status"), statusBadge(rec.status), true) +
              (rec.archived && rec.legacyStatus ? meta(t("arc.original"), esc(rec.legacyStatus)) : "") +
              meta(t("ho.area"), esc(rec.area ? label(st.areas, rec.area) : "\u2014")) +
              (rec.location ? meta(t("arc.location"), esc(rec.location)) : "") +
              meta(t("eq.upper"), esc(upperOf(rec.tags))) +
              meta(t("ho.team"), (rec.team && rec.team.length)
                ? rec.team.map(function (m) { return esc(personName(m)); }).join(", ")
                : "\u2014") +
              meta(t("ho.due"), rec.dueDate ? esc(global.Fmt.date(rec.dueDate)) : "—") +
              (rec.archived && rec.updatedAt === rec.createdAt ? "" : meta(t("ho.updatedAt"), esc(global.Fmt.dateTime(rec.updatedAt)))) +
              (rec.archived && rec.source ? meta(t("arc.source"), esc(rec.source)) : "") +
              meta(t("ho.tags"), '<div class="chips">' + (rec.tags || []).map(function (no) { return tagChip(no, { link: true }); }).join(" ") + "</div>", true) +
            "</div>" +
          "</div>" +
          '<div class="card"><h3>' + esc(t("ho.history")) + "</h3>" +
            '<div class="timeline">' + activity.map(function (a) {
              var when = a.dateOnly ? (a.at ? global.Fmt.date(a.at) : t("arc.dateUnknown")) : global.Fmt.dateTime(a.at);
              return '<div class="tl-item"><div class="t">' + esc(when) + "</div>" +
                '<div class="b">' + esc(a.text) + (a.who ? ' <span class="faint">· ' + esc(a.who) + "</span>" : "") + "</div></div>";
            }).join("") + "</div>" +
          "</div>" +
        "</div>" +
      "</div>";

    renderComments();
    renderAttachments();
    wireCards(view());

    $("#btn-back").addEventListener("click", function () { go("#/handovers"); });
    if (mayEdit) {
      $("#btn-edit").addEventListener("click", function () { go("#/handover/" + rec.id + "/edit"); });
      $("#btn-status").addEventListener("click", changeStatus);
      $("#btn-delete").addEventListener("click", deleteThis);
    }
    $("#c-post").addEventListener("click", postComment);

    $("#dropzone").addEventListener("click", function () { $("#file-input").click(); });
    $("#file-input").addEventListener("change", function (e) { addFiles(e.target.files); });
    ["dragenter", "dragover"].forEach(function (ev) {
      $("#dropzone").addEventListener(ev, function (e) { e.preventDefault(); $("#dropzone").classList.add("over"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      $("#dropzone").addEventListener(ev, function (e) { e.preventDefault(); $("#dropzone").classList.remove("over"); });
    });
    $("#dropzone").addEventListener("drop", function (e) { addFiles(e.dataTransfer.files); });

    async function deleteThis() {
      var lock = null;
      try { lock = await S.readLock(rec.id); } catch (e) { lock = null; }
      var msg = t("del.confirm", { title: rec.title || "\u2014" });
      if (lock && lock.by && me && lock.by !== me.id) { msg += " " + t("del.beingEdited", { name: lock.name }); }
      var ok = await global.UI.confirm(msg, { title: t("del.title"), okLabel: t("del.button"), danger: true });
      if (!ok) { return; }
      global.UI.busy(true, t("common.saving"));
      try {
        await S.deleteHandover(rec.id, me);
        try {
          await S.addNotification({ type: "deleted", actor: { id: me.id, name: me.name }, handoverId: "", title: rec.title });
        } catch (e) { /* the deletion itself succeeded */ }
        global.UI.busy(false);
        global.UI.toast(t("del.done"), "ok");
        go("#/handovers");
      } catch (e) {
        global.UI.busy(false);
        S.log("delete failed", e && (e.name + ": " + e.message));
        global.UI.toast(e && e.name === "NotFoundError" ? t("err.notFound") : t("err.write"), "err");
      }
    }

    function meta(k, v, raw) {
      return '<div class="m"><span class="k">' + esc(k) + '</span><span class="v">' + (raw ? v : v) + "</span></div>";
    }

    function renderComments() {
      var list = (rec.comments || []).slice().sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
      $("#comment-list").innerHTML = list.length ? list.map(function (c) {
        return '<div class="comment"><span class="avatar">' + esc(initials(personName(c.by))) + "</span>" +
          '<div class="c-body"><div class="c-head"><b>' + esc(personName(c.by)) + "</b>" +
            '<span class="faint small">' + esc(global.Fmt.dateTime(c.at)) + "</span></div>" +
            '<div class="c-text">' + esc(c.text) + "</div></div></div>";
      }).join("") : '<p class="faint small">' + esc(t("common.none")) + "</p>";
    }

    function renderAttachments() {
      var list = rec.attachments || [];
      $("#attach-grid").innerHTML = list.length ? list.map(function (a) {
        var icon = global.Util.ext(a.name).toUpperCase();
        return '<div class="attach" data-att="' + esc(a.stored) + '">' +
          (global.Util.isImage(a.name)
            ? '<div class="ficon" data-thumb="' + esc(a.stored) + '">' + esc(icon) + "</div>"
            : '<div class="ficon">' + esc(icon) + "</div>") +
          '<span class="fname">' + esc(a.name) + "</span>" +
          '<span class="fsize">' + esc(global.Fmt.bytes(a.size)) + "</span></div>";
      }).join("") : '<p class="faint small">' + esc(t("common.none")) + "</p>";

      $$("#attach-grid .attach").forEach(function (el) {
        el.addEventListener("click", function () { openAttachment(el.getAttribute("data-att")); });
      });
      // Load image thumbnails lazily so a long list does not stall on the share.
      $$("#attach-grid [data-thumb]").forEach(async function (el) {
        try {
          var file = await S.getAttachmentFile(rec.id, el.getAttribute("data-thumb"));
          var img = document.createElement("img");
          img.src = URL.createObjectURL(file);
          el.replaceWith(img);
        } catch (e) { /* leave the extension badge */ }
      });
    }

    async function openAttachment(stored) {
      var att = (rec.attachments || []).filter(function (a) { return a.stored === stored; })[0];
      if (!att) { return; }
      try {
        var file = await S.getAttachmentFile(rec.id, stored);
        var url = URL.createObjectURL(file);
        var body = document.createElement("div");
        if (global.Util.isImage(att.name)) {
          body.innerHTML = '<img src="' + url + '" style="max-width:100%;border-radius:8px">';
        } else if (global.Util.ext(att.name) === "pdf") {
          body.innerHTML = '<embed src="' + url + '" type="application/pdf" style="width:100%;height:68vh;border:0;border-radius:8px">';
        } else {
          body.innerHTML = '<p class="muted">' + esc(att.name) + " · " + esc(global.Fmt.bytes(att.size)) + "</p>";
        }
        global.UI.modal({
          title: att.name, body: body, wide: true,
          buttons: [
            { label: t("common.close"), value: null },
            {
              label: t("common.download"), primary: true,
              before: function () {
                var a = document.createElement("a");
                a.href = url; a.download = att.name;
                document.body.appendChild(a); a.click(); a.remove();
                return false;
              }
            }
          ]
        }).then(function () { URL.revokeObjectURL(url); });
      } catch (e) { global.UI.toast(t("err.read"), "err"); }
    }

    async function addFiles(fileList) {
      var files = Array.prototype.slice.call(fileList || []);
      if (!files.length) { return; }
      global.UI.busy(true, t("common.saving"));
      var uploaded = [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        if (!global.Util.isAllowed(f.name)) { global.UI.toast(t("err.fileType", { name: f.name }), "err"); continue; }
        if (f.size > global.Util.MAX_MB * 1024 * 1024) { global.UI.toast(t("err.fileTooLarge", { name: f.name, mb: global.Util.MAX_MB }), "err"); continue; }
        try {
          var att = await S.putAttachment(rec.id, f);
          att.by = { id: me.id, name: me.name };
          uploaded.push(att);
        } catch (e) { global.UI.toast(t("err.write"), "err"); }
      }
      try {
        if (uploaded.length) {
          rec = await S.appendAttachments(rec.id, uploaded);
          await S.addNotification({ type: "attachment", actor: { id: me.id, name: me.name }, handoverId: rec.id, title: rec.title });
        }
      } catch (e) { global.UI.toast(t("err.write"), "err"); }
      global.UI.busy(false);
      $("#file-input").value = "";
      renderAttachments();
    }

    async function postComment() {
      var text = $("#c-text").value.trim();
      if (!text) { return; }
      global.UI.busy(true, t("common.saving"));
      try {
        rec = await S.appendComment(rec.id, {
          id: global.Util.uuid(), text: text, at: new Date().toISOString(),
          by: { id: me.id, name: me.name }
        });
        await S.addNotification({ type: "comment", actor: { id: me.id, name: me.name }, handoverId: rec.id, title: rec.title });
        $("#c-text").value = "";
        renderComments();
      } catch (e) { global.UI.toast(t("err.write"), "err"); }
      global.UI.busy(false);
    }

    async function changeStatus() {
      var body = document.createElement("div");
      body.innerHTML = '<div class="field"><label>' + esc(t("ho.status")) + "</label>" +
        '<select class="input" id="st-sel">' + S.STATUSES.map(function (s) {
          return '<option value="' + s + '"' + (s === rec.status ? " selected" : "") + ">" + esc(t("status." + s)) + "</option>";
        }).join("") + "</select></div>";
      var chosen = await global.UI.modal({
        title: t("ho.changeStatus"), body: body,
        buttons: [
          { label: t("common.cancel"), value: null },
          { label: t("common.save"), primary: true, before: function (b) { return $("#st-sel", b).value; } }
        ]
      });
      if (!chosen || chosen === rec.status) { return; }
      global.UI.busy(true, t("common.saving"));
      try {
        rec = await S.setStatus(rec.id, chosen, personName(me), me.id);
        await S.addNotification({
          type: "status", actor: { id: me.id, name: me.name },
          handoverId: rec.id, title: rec.title, status: chosen
        });
        global.UI.toast(t("ho.statusChanged"), "ok");
        handoverDetail(rec.id);
      } catch (e) { global.UI.toast(t("err.write"), "err"); }
      global.UI.busy(false);
    }
  }

  /* ============================== EQUIPMENT ============================== */

  /* Options for an area <select>, including a blank "not set" entry. */
  function areaOptions(selected, extra) {
    var st = S.structure();
    var out = '<option value="">' + esc(extra || t("common.select")) + "</option>";
    (st.areas || []).forEach(function (a) {
      out += '<option value="' + esc(a.id) + '"' + (a.id === selected ? " selected" : "") + ">" +
        esc((a.en)) + "</option>";
    });
    return out;
  }

  /* Asks for a new area code and appends it to the plant structure. */
  function newAreaDialog(onDone) {
    var body = document.createElement("div");
    body.innerHTML =
      '<div class="field"><label>' + esc(t("area.new")) + ' <span class="req">*</span></label>' +
        '<input class="input" id="a-code" placeholder="WDDM" maxlength="24"></div>' +
      '<div class="err-msg hidden" id="a-err"></div>';
    global.UI.modal({
      title: t("area.add"), body: body,
      buttons: [
        { label: t("common.cancel"), value: null },
        {
          label: t("common.add"), primary: true,
          before: function (b) {
            var code = $("#a-code", b).value.trim();
            if (!code) { return false; }
            var clash = (S.structure().areas || []).some(function (a) {
              return a.id.toLowerCase() === code.toLowerCase();
            });
            if (clash) {
              $("#a-err", b).textContent = t("area.exists");
              $("#a-err", b).classList.remove("hidden");
              return false;
            }
            return code;
          }
        }
      ]
    }).then(async function (code) {
      if (!code) { return; }
      try {
        await S.addArea(code, code);
        global.UI.toast(t("area.added"), "ok");
        if (onDone) { onDone(code); }
      } catch (e) { global.UI.toast(t("err.write"), "err"); }
    });
  }

  /* The upper equipment behind a set of tag numbers, de-duplicated. */
  function upperOf(tagNos) {
    var seen = {}, out = [];
    (tagNos || []).forEach(function (no) {
      var tg = S.tagByNumber(no);
      if (tg && tg.upper && !seen[tg.upper]) { seen[tg.upper] = true; out.push(tg.upper); }
    });
    return out.length ? out.join(", ") : "—";
  }

  function upperDatalist(id) {
    return '<datalist id="' + id + '">' +
      S.upperEquipmentList().map(function (u) { return '<option value="' + esc(u) + '">'; }).join("") +
      "</datalist>";
  }

  var eqFilters = { q: "", area: "", upper: "", type: "" };
  var EQ_LIMIT = 300;

  async function equipmentList() {
    var st = S.structure();
    view().innerHTML =
      '<div class="page-head"><div><h1>' + esc(t("eq.title")) + "</h1><p>" + esc(t("eq.sub")) + "</p></div>" +
        '<div class="spacer"></div><button class="btn primary" id="add-tag">' + esc(t("eq.add")) + "</button></div>" +
      '<div class="filters">' +
        '<input type="search" id="q" placeholder="' + esc(t("eq.searchPh")) + '" style="min-width:240px">' +
        '<input id="f-upper" list="upper-list" placeholder="' + esc(t("eq.upperPh")) + '" style="min-width:190px">' +
        upperDatalist("upper-list") +
        '<select id="f-type"><option value="">' + esc(t("eq.type")) + " – " + esc(t("common.all")) + "</option>" +
          (st.equipmentTypes || []).map(function (x) {
            return '<option value="' + esc(x.id) + '">' + esc((x.en)) + "</option>";
          }).join("") + "</select>" +
        '<select id="f-area">' + areaOptions("", t("eq.area") + " – " + t("common.all")) + "</select>" +
        '<button class="btn sm ghost" id="f-clear">' + esc(t("common.clear")) + "</button>" +
      "</div>" +
      '<div id="eq-count" class="small faint" style="margin-bottom:10px"></div>' +
      '<div class="card" style="padding:0;overflow:hidden"><table class="table"><thead><tr>' +
        "<th>" + esc(t("eq.tagNumber")) + "</th><th>" + esc(t("ho.description")) + "</th>" +
        "<th>" + esc(t("eq.type")) + "</th><th>" + esc(t("eq.upper")) + "</th><th>" + esc(t("eq.area")) + "</th>" +
      '</tr></thead><tbody id="eq-body"></tbody></table></div>';

    $("#q").value = eqFilters.q;
    $("#f-upper").value = eqFilters.upper;
    $("#f-type").value = eqFilters.type;
    $("#f-area").value = eqFilters.area;

    function matches() {
      var q = global.Util.normalize(eqFilters.q);
      var up = global.Util.normalize(eqFilters.upper);
      return S.tags().filter(function (tag) {
        if (eqFilters.type && tag.type !== eqFilters.type) { return false; }
        if (eqFilters.area && (tag.area || "") !== eqFilters.area) { return false; }
        if (up && global.Util.normalize(tag.upper || "").indexOf(up) < 0) { return false; }
        if (q && global.Util.normalize(
              tag.tagNo + " " + (tag.descEn || "") + " " + (tag.upper || "")
            ).indexOf(q) < 0) { return false; }
        return true;
      });
    }

    function render() {
      var rows = matches();
      var shown = rows.slice(0, EQ_LIMIT);
      $("#eq-count").textContent = rows.length > EQ_LIMIT
        ? t("eq.showing", { n: global.Fmt.num(EQ_LIMIT), total: global.Fmt.num(rows.length) })
        : t("admin.tagCount", { n: global.Fmt.num(rows.length) });

      $("#eq-body").innerHTML = shown.length ? shown.map(function (tag) {
        return '<tr data-tag="' + esc(tag.tagNo) + '" style="cursor:pointer">' +
          '<td><b class="mono">' + esc(tag.tagNo) + "</b>" +
            (tag.active === false ? ' <span class="faint small">(' + esc(t("eq.inactive")) + ")</span>" : "") + "</td>" +
          "<td>" + esc(tagDesc(tag)) + "</td>" +
          "<td>" + esc(label(S.structure().equipmentTypes, tag.type)) + "</td>" +
          '<td class="mono small">' + esc(tag.upper || "—") + "</td>" +
          "<td>" + esc(tag.area ? label(S.structure().areas, tag.area) : "—") + "</td></tr>";
      }).join("") : '<tr><td colspan="5">' + emptyBlock(t("eq.none")) + "</td></tr>";

      $$("#eq-body tr[data-tag]").forEach(function (tr) {
        tr.addEventListener("click", function () {
          go("#/equipment/" + encodeURIComponent(tr.getAttribute("data-tag")));
        });
      });
    }

    $("#q").addEventListener("input", global.Util.debounce(function () { eqFilters.q = $("#q").value; render(); }, 200));
    $("#f-upper").addEventListener("input", global.Util.debounce(function () { eqFilters.upper = $("#f-upper").value; render(); }, 200));
    $("#f-type").addEventListener("change", function () { eqFilters.type = $("#f-type").value; render(); });
    $("#f-area").addEventListener("change", function () { eqFilters.area = $("#f-area").value; render(); });
    $("#f-clear").addEventListener("click", function () {
      eqFilters = { q: "", area: "", upper: "", type: "" };
      equipmentList();
    });
    $("#add-tag").addEventListener("click", function () { tagDialog({ onDone: render }); });
    render();
  }

  /* Add or edit an equipment tag. opts: {tag, prefillNo, onDone} */
  function tagDialog(opts) {
    opts = opts || {};
    var existing = opts.tag || null;
    var st = S.structure();
    var body = document.createElement("div");
    body.innerHTML =
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t("eq.tagNumber")) + ' <span class="req">*</span></label>' +
          '<input class="input mono" id="n-no" placeholder="PIT-C002"' + (existing ? " disabled" : "") + "></div>" +
        '<div class="field"><label>' + esc(t("eq.upper")) + "</label>" +
          '<input class="input mono" id="n-upper" list="dlg-upper" placeholder="GF-LP">' +
          upperDatalist("dlg-upper") + "</div>" +
      "</div>" +
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t("eq.descEn")) + '</label><input class="input" id="n-en"></div>' +
      "</div>" +
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t("eq.type")) + "</label>" +
          '<select class="input" id="n-type">' + (st.equipmentTypes || []).map(function (x) {
            return '<option value="' + esc(x.id) + '">' + esc((x.en)) + "</option>";
          }).join("") + "</select></div>" +
        '<div class="field"><label>' + esc(t("eq.area")) + "</label>" +
          '<select class="input" id="n-area">' + areaOptions(existing ? existing.area : "") + "</select></div>" +
        '<div class="field"><label>' + esc(t("eq.uom")) + '</label><input class="input" id="n-uom" placeholder="barg"></div>' +
      "</div>" +
      '<div class="form-row">' +
        '<div class="field"><label>LRV</label><input class="input" id="n-lrv"></div>' +
        '<div class="field"><label>URV</label><input class="input" id="n-urv"></div>' +
        '<div class="field"><label>' + esc(t("eq.valveSize")) + '</label><input class="input" id="n-size"></div>' +
      "</div>" +
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t("eq.service")) + '</label><input class="input" id="n-service"></div>' +
        '<div class="field"><label>' + esc(t("eq.serial")) + '</label><input class="input" id="n-serial"></div>' +
      "</div>" +
      '<div class="field"><label>' + esc(t("eq.comment")) + '</label><input class="input" id="n-comment"></div>' +
      '<div class="err-msg hidden" id="n-err"></div>';

    var seed = existing || { tagNo: opts.prefillNo || "" };
    body.querySelector("#n-no").value = seed.tagNo || "";
    body.querySelector("#n-upper").value = seed.upper || "";
    body.querySelector("#n-en").value = seed.descEn || "";
    body.querySelector("#n-uom").value = seed.uom || "";
    body.querySelector("#n-lrv").value = seed.lrv || "";
    body.querySelector("#n-urv").value = seed.urv || "";
    body.querySelector("#n-size").value = seed.valveSize || "";
    body.querySelector("#n-service").value = seed.service || "";
    body.querySelector("#n-serial").value = seed.serial || "";
    body.querySelector("#n-comment").value = seed.comment || "";
    if (existing && existing.type) { body.querySelector("#n-type").value = existing.type; }

    global.UI.modal({
      title: existing ? t("common.edit") + " — " + existing.tagNo : t("eq.addTitle"),
      body: body, wide: true,
      buttons: [
        { label: t("common.cancel"), value: null },
        {
          label: t("common.save"), primary: true,
          before: function (b) {
            var no = existing ? existing.tagNo : $("#n-no", b).value.trim().toUpperCase();
            var err = $("#n-err", b);
            if (!no) { err.textContent = t("err.tagNumberRequired"); err.classList.remove("hidden"); return false; }
            if (!existing && S.tagByNumber(no)) { err.textContent = t("eq.duplicate"); err.classList.remove("hidden"); return false; }
            var typeId = $("#n-type", b).value;
            var upper = $("#n-upper", b).value.trim();
            var descEn = $("#n-en", b).value.trim();
            return {
              tagNo: no,
              upper: upper,
              alt: existing ? (existing.alt || []) : [],
              descEn: descEn || ((S.TYPE_EN[typeId] || "Instrument") + (upper ? " on " + upper : "")),
              type: typeId,
              area: $("#n-area", b).value,
              uom: $("#n-uom", b).value.trim(),
              lrv: $("#n-lrv", b).value.trim(),
              urv: $("#n-urv", b).value.trim(),
              valveSize: $("#n-size", b).value.trim(),
              swHealthy: existing ? (existing.swHealthy || "") : "",
              swActive: existing ? (existing.swActive || "") : "",
              pcvSp: existing ? (existing.pcvSp || "") : "",
              service: $("#n-service", b).value.trim(),
              serial: $("#n-serial", b).value.trim(),
              system: existing ? (existing.system || "") : "",
              comment: $("#n-comment", b).value.trim(),
              active: existing ? (existing.active !== false) : true,
              createdAt: existing ? (existing.createdAt || "") : new Date().toISOString()
            };
          }
        }
      ]
    }).then(async function (tag) {
      if (!tag) { return; }
      global.UI.busy(true, t("common.saving"));
      try {
        await S.upsertTag(tag);
        global.UI.toast(t("eq.added"), "ok");
        if (opts.onDone) { opts.onDone(tag); }
      } catch (e) { global.UI.toast(t("err.write"), "err"); }
      global.UI.busy(false);
    });
  }

  async function equipmentDetail(tagNo) {
    var tag = S.tagByNumber(tagNo);
    if (!tag) { view().innerHTML = emptyBlock(t("err.notFound")); return; }
    var st = S.structure();
    var all = await S.listHandovers();
    var related = all.filter(function (h) { return (h.tags || []).indexOf(tag.tagNo) >= 0; });
    var open = related.filter(function (h) { return h.status !== "info"; });
    var past = related.filter(function (h) { return h.status === "info"; });

    // The timeline is built from the records themselves - no separate audit log.
    var events = [];
    for (var i = 0; i < related.length; i++) {
      var full = related[i].fromArchive ? S.archivedRecord(related[i].id) : await S.getHandover(related[i].id);
      if (!full) { continue; }
      if (full.archived && full.createdAt) {
        events.push({ at: full.createdAt, dateOnly: true, text: full.title + " \u2014 " + (full.legacyStatus || t("arc.badge")), who: personName(full.createdBy), id: full.id });
      }
      (full.history || []).forEach(function (x) {
        events.push({ at: x.at, text: full.title + " — " + t("status." + x.status), who: x.by, id: full.id });
      });
      (full.comments || []).forEach(function (c) {
        events.push({ at: c.at, text: full.title + " — " + c.text.slice(0, 90), who: personName(c.by), id: full.id });
      });
    }
    events.sort(function (a, b) { return String(b.at || "").localeCompare(String(a.at || "")); });

    var range = "";
    if (tag.lrv !== "" || tag.urv !== "") {
      range = (tag.lrv === "" ? "0" : tag.lrv) + " – " + (tag.urv === "" ? "?" : tag.urv) + (tag.uom ? " " + tag.uom : "");
    }

    view().innerHTML =
      '<div class="page-head"><div>' +
        "<h1>" + esc(tag.tagNo) + "</h1><p>" + esc(tagDesc(tag)) + "</p></div>" +
        '<div class="spacer"></div>' +
        '<div class="btn-row"><button class="btn primary" id="new-for-tag">' + esc(t("ho.new")) + "</button>" +
        '<button class="btn" id="edit-tag">' + esc(t("common.edit")) + "</button>" +
        '<button class="btn ghost" id="btn-back">' + esc(t("common.back")) + "</button></div>" +
      "</div>" +

      '<div class="detail-grid">' +
        "<div>" +
          '<div class="card"><h3>' + esc(t("eq.openHandovers")) + " (" + global.Fmt.num(open.length) + ")</h3>" +
            (open.length ? '<div class="list">' + open.map(handoverCard).join("") + "</div>"
                         : '<p class="faint small">' + esc(t("eq.noHandovers")) + "</p>") +
          "</div>" +
          '<div class="card"><h3>' + esc(t("eq.pastHandovers")) + " (" + global.Fmt.num(past.length) + ")</h3>" +
            (past.length ? '<div class="list">' + past.map(handoverCard).join("") + "</div>"
                         : '<p class="faint small">' + esc(t("common.none")) + "</p>") +
          "</div>" +
        "</div>" +
        "<div>" +
          '<div class="card"><h3>' + esc(t("eq.details")) + '</h3><div class="meta-list">' +
            m(t("eq.type"), label(st.equipmentTypes, tag.type)) +
            m(t("eq.upper"), tag.upper || "—") +
            (tag.alt && tag.alt.length ? m(t("eq.alsoOn"), tag.alt.join(", ")) : "") +
            m(t("eq.area"), tag.area ? label(st.areas, tag.area) : "—") +
            m(t("ho.status"), tag.active === false ? t("eq.inactive") : t("eq.active")) +
          "</div></div>" +
          '<div class="card"><h3>' + esc(t("eq.calibration")) + '</h3><div class="meta-list">' +
            m(t("eq.range"), range || "—") +
            m(t("eq.uom"), tag.uom || "—") +
            (tag.valveSize ? m(t("eq.valveSize"), tag.valveSize + '"') : "") +
            (tag.swHealthy ? m(t("eq.swHealthy"), tag.swHealthy) : "") +
            (tag.swActive ? m(t("eq.swActive"), tag.swActive) : "") +
            (tag.pcvSp ? m(t("eq.pcvSp"), tag.pcvSp) : "") +
            (tag.service ? m(t("eq.service"), tag.service) : "") +
            (tag.serial ? m(t("eq.serial"), tag.serial) : "") +
            (tag.comment ? m(t("eq.comment"), tag.comment) : "") +
          "</div></div>" +
          '<div class="card"><h3>' + esc(t("eq.timeline")) + "</h3>" +
            (events.length ? '<div class="timeline">' + events.slice(0, 40).map(function (e) {
              return '<div class="tl-item" data-goto="' + esc(e.id) + '" style="cursor:pointer">' +
                '<div class="t">' + esc(e.dateOnly ? global.Fmt.date(e.at) : global.Fmt.dateTime(e.at)) + "</div>" +
                '<div class="b">' + esc(e.text) + (e.who ? ' <span class="faint">· ' + esc(e.who) + "</span>" : "") + "</div></div>";
            }).join("") + "</div>" : '<p class="faint small">' + esc(t("eq.noHandovers")) + "</p>") +
          "</div>" +
        "</div>" +
      "</div>";

    function m(k, v) { return '<div class="m"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + "</span></div>"; }

    wireCards(view());
    $("#btn-back").addEventListener("click", function () { go("#/equipment"); });
    $("#new-for-tag").addEventListener("click", function () { go("#/handover/new"); });
    $("#edit-tag").addEventListener("click", function () {
      tagDialog({ tag: tag, onDone: function () { equipmentDetail(tagNo); } });
    });
    $$("[data-goto]").forEach(function (el) {
      el.addEventListener("click", function () { go("#/handover/" + el.getAttribute("data-goto")); });
    });
  }

  /* ============================ NOTIFICATIONS ============================ */

  function notifText(n) {
    var who = personName(n.actor);
    if (n.type === "handover") { return t("notif.newHandover", { user: who }); }
    if (n.type === "comment") { return t("notif.newComment", { user: who }); }
    if (n.type === "attachment") { return t("notif.newAttachment", { user: who }); }
    if (n.type === "deleted") { return t("notif.deleted", { user: who }); }
    if (n.type === "status") { return t("notif.statusChanged", { user: who, status: t("status." + n.status) }); }
    return n.title || "";
  }

  /* Read state is kept per PC and per person: everything up to "mark all as
     read" (readAt), plus the ids of single notifications opened since then. */
  function readKey(me, what) { return what + "." + (me ? me.id : "x"); }

  function isUnread(n, me) {
    if (!n) { return false; }
    if (me && n.actor && n.actor.id === me.id) { return false; }
    if (new Date(n.at).getTime() <= global.Prefs.get(readKey(me, "readAt"), 0)) { return false; }
    var ids = global.Prefs.get(readKey(me, "readIds"), []);
    return ids.indexOf(n.id) < 0;
  }

  function markRead(n, me) {
    if (!n || !n.id) { return; }
    var ids = global.Prefs.get(readKey(me, "readIds"), []);
    if (ids.indexOf(n.id) >= 0) { return; }
    ids.push(n.id);
    if (ids.length > 600) { ids = ids.slice(ids.length - 600); }
    global.Prefs.set(readKey(me, "readIds"), ids);
  }

  function markAllRead(me) {
    global.Prefs.set(readKey(me, "readAt"), Date.now());
    global.Prefs.set(readKey(me, "readIds"), []);
  }

  async function notifications() {
    view().innerHTML = '<div class="empty">' + esc(t("common.loading")) + "</div>";
    var list = await S.listNotifications(300);
    var me = global.App.user();

    view().innerHTML =
      '<div class="page-head"><div><h1>' + esc(t("notif.title")) + "</h1><p>" + esc(t("notif.sub")) + "</p></div>" +
        '<div class="spacer"></div><button class="btn" id="mark-all">' + esc(t("notif.markAll")) + "</button></div>" +
      (list.length ? '<div class="list">' + list.map(function (n) {
        var unread = isUnread(n, me);
        return '<div class="row-card' + (unread ? " unread" : "") + '" data-id="' + esc(n.handoverId || "") + '" data-nid="' + esc(n.id || "") + '"' +
          (unread ? ' style="border-inline-start:3px solid var(--accent)"' : "") + ">" +
          '<div class="r1"><h4>' + esc(notifText(n)) + "</h4>" +
            (unread ? '<span class="badge s-info unread-badge">' + esc(t("notif.unread")) + "</span>" : "") + "</div>" +
          (n.title ? '<div class="snippet">' + esc(n.title) + "</div>" : "") +
          '<div class="r2"><span>' + esc(global.Fmt.dateTime(n.at)) + "</span></div></div>";
      }).join("") + "</div>" : emptyBlock(t("notif.none")));

    var byId = {};
    list.forEach(function (n) { if (n.id) { byId[n.id] = n; } });

    $$(".row-card").forEach(function (el) {
      el.addEventListener("click", function () {
        var n = byId[el.getAttribute("data-nid")];
        if (n && isUnread(n, me)) {
          markRead(n, me);
          // Update the row and the counters straight away, before moving on.
          el.classList.remove("unread");
          el.style.borderInlineStart = "";
          var b = el.querySelector(".unread-badge");
          if (b) { b.remove(); }
          global.App.adjustUnread(-1);
          global.App.refreshBadges();
        }
        var id = el.getAttribute("data-id");
        if (id) { go("#/handover/" + id); }
      });
    });
    $("#mark-all").addEventListener("click", function () {
      markAllRead(me);
      global.App.refreshBadges();
      notifications();
    });
  }

  /* ================================ PROFILE ================================ */

  async function profile() {
    var me = global.App.user();
    var st = S.structure();
    var all = await S.listHandovers();
    var mine = all.filter(function (h) { return h.createdBy && me && h.createdBy.id === me.id; });

    view().innerHTML =
      '<div class="page-head"><div><h1>' + esc(t("profile.title")) + "</h1></div></div>" +
      '<div class="detail-grid"><div>' +
        '<div class="card">' +
          '<div style="display:flex;gap:14px;align-items:center;margin-bottom:16px">' +
            '<span class="avatar lg">' + esc(initials(personName(me))) + "</span>" +
            "<div><h3 style=\"margin:0\">" + esc(personName(me)) + "</h3>" +
            '<p class="faint small" style="margin:2px 0 0">' + esc(me && me.jobTitle ? me.jobTitle : "") + "</p></div>" +
          "</div>" +
          '<div class="meta-list">' +
            row(t("profile.employeeId"), me && me.employeeId) +
            row(t("profile.department"), me && me.department) +
            row(t("profile.role"), me && me.role ? t("role." + me.role) : "") +
          "</div>" +
          '<div class="btn-row" style="margin-top:16px">' +
            '<button class="btn" id="switch-user">' + esc(t("profile.switchUser")) + "</button>" +
          "</div>" +
        "</div>" +
        '<div class="card"><h3>' + esc(t("profile.myHandovers")) + " (" + global.Fmt.num(mine.length) + ")</h3>" +
          (mine.length ? '<div class="list">' + mine.slice(0, 10).map(handoverCard).join("") + "</div>"
                       : '<p class="faint small">' + esc(t("ho.noneYet")) + "</p>") +
        "</div>" +
      "</div><div>" +
        '<div class="card"><h3>' + esc(t("auth.change")) + "</h3>" +
          '<div class="field"><label>' + esc(t("auth.currentPassword")) + "</label>" +
            '<input type="password" class="input" id="cp-old"></div>' +
          '<div class="field"><label>' + esc(t("auth.newPassword")) + "</label>" +
            '<input type="password" class="input" id="cp-new"></div>' +
          '<div class="field"><label>' + esc(t("auth.confirmPassword")) + "</label>" +
            '<input type="password" class="input" id="cp-new2"></div>' +
          '<div class="err-msg hidden" id="cp-err"></div>' +
          '<button class="btn" id="cp-save">' + esc(t("common.save")) + "</button></div>" +
        '<div class="card"><h3>' + esc(t("profile.folder")) + "</h3>" +
          '<p class="small mono" style="word-break:break-all">' + esc(S.rootName()) + "</p>" +
          '<button class="btn sm" id="change-folder">' + esc(t("gate.choose.again")) + "</button></div>" +
      "</div></div>";

    function row(k, v) {
      return '<div class="m"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v || "—") + "</span></div>";
    }

    wireCards(view());
    $("#switch-user").addEventListener("click", function () { global.App.pickUser(true); });
    $("#cp-save").addEventListener("click", async function () {
      var err = $("#cp-err");
      var oldPw = $("#cp-old").value, a = $("#cp-new").value, b = $("#cp-new2").value;
      function fail(msg) { err.textContent = msg; err.classList.remove("hidden"); }
      err.classList.add("hidden");
      if (a.length < 6) { fail(t("auth.short")); return; }
      if (a !== b) { fail(t("auth.mismatch")); return; }
      global.UI.busy(true, t("common.saving"));
      try {
        if (S.hasPassword(me.id) && !(await S.verifyUserPassword(me.id, oldPw))) {
          global.UI.busy(false);
          fail(t("auth.wrong"));
          return;
        }
        await S.setUserPassword(me.id, await global.Util.makeSecret(a));
        $("#cp-old").value = ""; $("#cp-new").value = ""; $("#cp-new2").value = "";
        global.UI.toast(t("auth.changed"), "ok");
      } catch (e) { global.UI.toast(t("err.write"), "err"); }
      global.UI.busy(false);
    });
    $("#change-folder").addEventListener("click", async function () {
      await S.disconnect();
      global.App.reboot();
    });
  }

  /* ================================= ADMIN ================================= */

  var adminUnlocked = false;

  async function admin() {
    if (!adminUnlocked) { return adminGate(); }
    var st = S.structure();

    view().innerHTML =
      '<div class="page-head"><div><h1>' + esc(t("admin.title")) + "</h1><p>" + esc(t("admin.sub")) + "</p></div>" +
        '<div class="spacer"></div><button class="btn ghost" id="lock">' + esc(t("admin.lock")) + "</button></div>" +

      '<div class="card"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
        "<div><h3>" + esc(t("area.manage")) + '</h3><p class="small faint" style="margin:0">' + esc(t("area.manageSub")) + "</p></div>" +
        '<div style="flex:1"></div><button class="btn" id="add-area">' + esc(t("area.add")) + "</button></div>" +
        '<div class="chips" id="area-chips" style="margin-top:12px"></div></div>' +

      '<div class="card"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
        "<div><h3>" + esc(t("admin.staff")) + '</h3><p class="small faint" style="margin:0">' + esc(t("admin.staffSub")) + "</p></div>" +
        '<div style="flex:1"></div>' +
        '<button class="btn" id="load-staff">' + esc(t("admin.loadStaff")) + "</button>" +
        '<button class="btn primary" id="add-staff">' + esc(t("admin.addStaff")) + "</button></div>" +
        '<table class="table" style="margin-top:12px"><thead><tr>' +
          "<th>" + esc(t("profile.name")) + "</th><th>" + esc(t("profile.jobTitle")) + "</th>" +
          "<th>" + esc(t("profile.role")) + "</th><th>" + esc(t("profile.employeeId")) + "</th>" +
          "<th>" + esc(t("auth.password")) + "</th><th></th>" +
        '</tr></thead><tbody id="staff-body"></tbody></table></div>' +

      '<div class="card"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
        "<div><h3>" + esc(t("admin.tags")) + '</h3><p class="small faint" style="margin:0" id="tag-count"></p></div>' +
        '<div style="flex:1"></div>' +
        '<button class="btn" id="add-tag">' + esc(t("eq.add")) + "</button>" +
        '<button class="btn" id="imp-btn">' + esc(t("admin.import")) + "</button>" +
        '<input type="file" id="imp-file" accept=".json,application/json" class="hidden"></div>' +
        '<p class="small faint" style="margin-top:10px">' + esc(t("admin.importDesc")) + "</p>" +
        '<div style="border-top:1px solid var(--border);margin-top:12px;padding-top:12px">' +
          '<div class="filters" style="margin-bottom:8px">' +
            '<input id="bulk-q" placeholder="' + esc(t("eq.searchPh")) + '" style="min-width:230px">' +
            '<select id="bulk-area">' + areaOptions("") + "</select>" +
            '<button class="btn sm" id="bulk-go">' + esc(t("admin.bulkArea")) + "</button>" +
          "</div>" +
          '<p class="small faint" id="bulk-count"></p>' +
        "</div></div>" +

      '<div class="card"><h3>' + esc(t("admin.changePassword")) + "</h3>" +
        '<div class="form-row">' +
          '<div class="field"><label>' + esc(t("admin.newPassword")) + '</label><input type="password" class="input" id="pw1"></div>' +
          '<div class="field"><label>' + esc(t("admin.confirmPassword")) + '</label><input type="password" class="input" id="pw2"></div>' +
        "</div>" +
        '<div class="err-msg hidden" id="pw-err"></div>' +
        '<button class="btn" id="pw-save">' + esc(t("common.save")) + "</button></div>" +

      '<div class="card"><h3>' + esc(t("arc.title")) + "</h3>" +
        '<p class="small faint">' + esc(t("arc.desc")) + "</p>" +
        '<p class="small" id="arc-status"></p>' +
        '<div class="btn-row"><button class="btn" id="arc-btn">' + esc(t("arc.choose")) + "</button></div>" +
        '<input type="file" id="arc-file" accept=".json,application/json" class="hidden"></div>' +

      '<div class="card"><h3>' + esc(t("del.adminTitle")) + "</h3>" +
        '<p class="small faint">' + esc(t("del.adminDesc")) + "</p>" +
        '<div id="deleted-list"><p class="faint small">' + esc(t("common.loading")) + "</p></div></div>" +

      '<div class="card"><h3>' + esc(t("admin.backup")) + "</h3>" +
        '<p class="small faint">' + esc(t("admin.backupDesc")) + "</p>" +
        '<div class="btn-row"><button class="btn" id="backup">' + esc(t("admin.backup")) + "</button>" +
        '<button class="btn ghost" id="reindex">' + esc(t("common.refresh")) + "</button></div></div>";

    /* ---- areas ---- */
    function renderAreas() {
      var areas = S.structure().areas || [];
      $("#area-chips").innerHTML = areas.length ? areas.map(function (a) {
        return '<span class="tag-chip">' + esc((a.en)) +
          ' <span class="x" data-rm-area="' + esc(a.id) + '">×</span></span>';
      }).join(" ") : '<span class="faint small">' + esc(t("common.none")) + "</span>";
      $$("[data-rm-area]").forEach(function (x) {
        x.addEventListener("click", async function () {
          var ok = await global.UI.confirm(t("area.removeConfirm"), { danger: true, okLabel: t("common.remove") });
          if (!ok) { return; }
          await S.removeArea(x.getAttribute("data-rm-area"));
          renderAreas();
        });
      });
    }
    renderAreas();
    $("#add-area").addEventListener("click", function () { newAreaDialog(renderAreas); });

    /* ---- staff ---- */
    function renderStaff() {
      var list = S.users();
      $("#staff-body").innerHTML = list.length ? list.map(function (u) {
        return "<tr" + (u.active === false ? ' style="opacity:.55"' : "") + ">" +
          "<td><b>" + esc(personName(u)) + "</b></td>" +
          "<td>" + esc(u.jobTitle || "—") + "</td>" +
          "<td>" + esc(u.role ? t("role." + u.role) : "—") + "</td>" +
          "<td>" + esc(u.employeeId || "\u2014") + "</td>" +
          "<td>" + (!S.canSignIn(Object.assign({}, u, { active: true }))
            ? '<span class="small faint">' + esc(t("auth.noAccount")) + "</span>"
            : u.password
              ? '<span class="small">' + esc(global.Fmt.date(u.passwordSetAt)) + "</span>"
              : '<span class="small faint">' + esc(t("auth.noPassword")) + "</span>") + "</td>" +
          '<td class="actions">' +
            (u.password && S.canSignIn(Object.assign({}, u, { active: true })) ? '<button class="btn sm ghost" data-reset="' + esc(u.id) + '">' + esc(t("auth.reset")) + "</button> " : "") +
            '<button class="btn sm ghost" data-edit="' + esc(u.id) + '">' + esc(t("common.edit")) + "</button> " +
            '<button class="btn sm ghost" data-toggle="' + esc(u.id) + '">' +
              esc(u.active === false ? t("admin.activate") : t("admin.deactivate")) + "</button>" +
          "</td></tr>";
      }).join("") : '<tr><td colspan="6">' + emptyBlock(t("gate.who.empty")) + "</td></tr>";

      $$("[data-reset]").forEach(function (b) {
        b.addEventListener("click", async function () {
          var u = S.userById(b.getAttribute("data-reset"));
          if (!u) { return; }
          var ok = await global.UI.confirm(t("auth.resetConfirm", { name: personName(u) }));
          if (!ok) { return; }
          global.UI.busy(true, t("common.saving"));
          try {
            await S.clearUserPassword(u.id);
            global.UI.toast(t("auth.resetDone"), "ok");
            renderStaff();
          } catch (e) { global.UI.toast(t("err.write"), "err"); }
          global.UI.busy(false);
        });
      });

      $$("[data-edit]").forEach(function (b) {
        b.addEventListener("click", function () { staffDialog(S.userById(b.getAttribute("data-edit")), renderStaff); });
      });
      $$("[data-toggle]").forEach(function (b) {
        b.addEventListener("click", async function () {
          var id = b.getAttribute("data-toggle");
          var u = S.userById(id);
          await S.setUserActive(id, u ? (u.active === false) : true);
          renderStaff();
        });
      });
    }
    renderStaff();

    /* ---- tags ---- */
    function bulkMatches() {
      var q = global.Util.normalize($("#bulk-q").value);
      if (!q) { return []; }
      return S.tags().filter(function (tag) {
        return global.Util.normalize(
          tag.tagNo + " " + (tag.upper || "") + " " + (tag.descEn || "")
        ).indexOf(q) >= 0;
      });
    }
    function renderTagCount() {
      $("#tag-count").textContent = t("admin.tagCount", { n: global.Fmt.num(S.tags().length) });
      $("#bulk-count").textContent = t("admin.tagCount", { n: global.Fmt.num(bulkMatches().length) });
    }
    renderTagCount();

    $("#bulk-q").addEventListener("input", global.Util.debounce(renderTagCount, 220));
    $("#add-tag").addEventListener("click", function () { tagDialog({ onDone: renderTagCount }); });
    $("#bulk-go").addEventListener("click", async function () {
      var rows = bulkMatches();
      var area = $("#bulk-area").value;
      if (!rows.length) { return; }
      var ok = await global.UI.confirm(t("admin.bulkArea") + " — " + global.Fmt.num(rows.length));
      if (!ok) { return; }
      var ids = {};
      rows.forEach(function (r) { ids[r.tagNo] = true; });
      global.UI.busy(true, t("common.saving"));
      try {
        await S.bulkSetArea(Object.keys(ids), area);
        global.UI.toast(t("admin.bulkAreaDone", { n: global.Fmt.num(rows.length) }), "ok");
        renderTagCount();
      } catch (e) { global.UI.toast(t("err.write"), "err"); }
      global.UI.busy(false);
    });

    $("#imp-btn").addEventListener("click", function () { $("#imp-file").click(); });
    $("#imp-file").addEventListener("change", async function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) { return; }
      global.UI.busy(true, t("common.loading"));
      try {
        var rows = JSON.parse(await file.text());
        if (!Array.isArray(rows)) { throw new Error("not-a-list"); }
        var res = await S.importTags(rows);
        global.UI.toast(t("admin.importDone", {
          added: global.Fmt.num(res.added), updated: global.Fmt.num(res.updated)
        }), "ok");
        renderTagCount();
      } catch (err) {
        global.UI.toast(t("admin.importBad"), "err");
      }
      global.UI.busy(false);
      $("#imp-file").value = "";
    });

    /* ---- settings ---- */
    $("#lock").addEventListener("click", function () { adminUnlocked = false; admin(); });
    $("#add-staff").addEventListener("click", function () { staffDialog(null, renderStaff); });
    $("#load-staff").addEventListener("click", async function () {
      global.UI.busy(true, t("common.saving"));
      try {
        var was = S.users().length;
        await S.loadStandardStaff();
        var added = S.users().length - was;
        global.UI.toast(added ? t("admin.loadStaffDone", { n: global.Fmt.num(added) }) : t("admin.loadStaffNone"), "ok");
        renderStaff();
      } catch (e) { global.UI.toast(t("err.write"), "err"); }
      global.UI.busy(false);
    });
    $("#pw-save").addEventListener("click", async function () {
      var a = $("#pw1").value, b = $("#pw2").value, err = $("#pw-err");
      err.classList.add("hidden");
      if (a.length < 6) { err.textContent = t("admin.passwordShort"); err.classList.remove("hidden"); return; }
      if (a !== b) { err.textContent = t("admin.passwordMismatch"); err.classList.remove("hidden"); return; }
      await S.setAdminPassword(a);
      $("#pw1").value = ""; $("#pw2").value = "";
      global.UI.toast(t("admin.passwordChanged"), "ok");
    });
    $("#backup").addEventListener("click", async function () {
      global.UI.busy(true);
      try {
        var bundle = await S.exportBackup();
        var blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "handover-backup-" + global.Fmt.isoDay(new Date()) + ".json";
        document.body.appendChild(a); a.click(); a.remove();
        global.UI.toast(t("admin.backupDone"), "ok");
      } catch (e) { global.UI.toast(t("err.read"), "err"); }
      global.UI.busy(false);
    });
    /* ---- deleted handovers ---- */
    async function renderDeleted() {
      var list = [];
      try { list = await S.listDeleted(); } catch (e) { list = []; }
      $("#deleted-list").innerHTML = list.length
        ? '<table class="table"><thead><tr><th>' + esc(t("ho.title")) + "</th><th>" + esc(t("ho.createdBy")) + "</th>" +
            "<th>" + esc(t("del.deletedBy")) + "</th><th></th></tr></thead><tbody>" +
            list.map(function (d) {
              return "<tr><td><b>" + esc(d.title || "\u2014") + "</b>" +
                  (d.archived ? ' <span class="faint small">\u00b7 ' + esc(t("arc.badge")) + "</span>" : "") + "</td>" +
                "<td>" + esc(personName(d.createdBy)) + "</td>" +
                "<td>" + esc(personName(d.deletedBy)) + ' <span class="faint small">\u00b7 ' + esc(global.Fmt.dateTime(d.deletedAt)) + "</span></td>" +
                '<td class="actions"><button class="btn sm" data-restore="' + esc(d.id) + '">' + esc(t("del.restore")) + "</button></td></tr>";
            }).join("") + "</tbody></table>"
        : '<p class="faint small">' + esc(t("del.none")) + "</p>";
      $$("[data-restore]").forEach(function (b) {
        b.addEventListener("click", async function () {
          global.UI.busy(true, t("common.saving"));
          try {
            var rec = await S.restoreHandover(b.getAttribute("data-restore"), global.App.user());
            global.UI.toast(t("del.restored", { title: rec.title || "" }), "ok");
            renderDeleted();
          } catch (e) { global.UI.toast(t("err.write"), "err"); }
          global.UI.busy(false);
        });
      });
    }
    renderDeleted();

    /* ---- old handovers (Excel import) ---- */
    async function renderArchiveStatus() {
      try { await S.loadArchive(); } catch (e) { /* shown as none */ }
      var info = S.archiveInfo();
      $("#arc-status").textContent = info
        ? t("arc.current", { n: global.Fmt.num(info.count), date: global.Fmt.dateTime(info.importedAt), by: info.by || "\u2014" })
        : t("arc.none");
    }
    renderArchiveStatus();
    $("#arc-btn").addEventListener("click", function () { $("#arc-file").click(); });
    $("#arc-file").addEventListener("change", async function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) { return; }
      var bundle = null;
      try { bundle = JSON.parse(await file.text()); } catch (err) { bundle = null; }
      if (!bundle || bundle.kind !== "plant-handover-archive" || !Array.isArray(bundle.records)) {
        global.UI.toast(t("arc.badFile"), "err");
        return;
      }
      var years = {};
      bundle.records.forEach(function (r) { years[r.createdAt ? String(r.createdAt).slice(0, 4) : "undated"] = true; });
      var have = {};
      (S.structure().areas || []).forEach(function (a) { have[String(a.id).toLowerCase()] = true; });
      var newAreas = (bundle.areas || []).filter(function (a) { return !have[String(a.id).toLowerCase()]; }).length;
      var ok = await global.UI.confirm(t("arc.confirm", {
        n: global.Fmt.num(bundle.records.length), b: global.Fmt.num(Object.keys(years).length), a: global.Fmt.num(newAreas)
      }));
      if (!ok) { return; }
      global.UI.busy(true, t("common.saving"));
      try {
        var me = global.App.user();
        var res = await S.importArchive(bundle, me ? me.name : "", function (i, n, name) {
          var lab = document.getElementById("busy-label");
          if (lab) { lab.textContent = t("arc.progress", { i: global.Fmt.num(i), n: global.Fmt.num(n), name: name }); }
        });
        global.UI.busy(false);
        global.UI.toast(t("arc.done", { n: global.Fmt.num(res.count) }), "ok");
        renderAreas();
        renderArchiveStatus();
      } catch (err) {
        global.UI.busy(false);
        S.log("archive import failed", err && (err.name + ": " + err.message));
        global.UI.toast(err && err.name === "FormatError" ? t("arc.badFile") : t("err.write"), "err");
      }
    });

    $("#reindex").addEventListener("click", async function () {
      global.UI.busy(true);
      try { await S.rebuildIndex(); global.UI.toast(t("common.saved"), "ok"); }
      catch (e) { global.UI.toast(t("err.write"), "err"); }
      global.UI.busy(false);
    });
  }

  function adminGate() {
    view().innerHTML =
      '<div class="page-head"><div><h1>' + esc(t("admin.title")) + "</h1></div></div>" +
      '<div class="card" style="max-width:430px">' +
        "<h3>" + esc(t("admin.locked")) + "</h3>" +
        '<p class="small faint">' + esc(t("admin.lockedDesc")) + "</p>" +
        '<div class="field"><label>' + esc(t("admin.password")) + "</label>" +
          '<input type="password" class="input" id="pw"></div>' +
        '<div class="err-msg hidden" id="pw-err"></div>' +
        '<button class="btn primary" id="unlock">' + esc(t("admin.unlock")) + "</button>" +
      "</div>";

    async function tryUnlock() {
      var ok = false;
      try { ok = await S.verifyAdmin($("#pw").value); } catch (e) { ok = false; }
      if (ok) { adminUnlocked = true; admin(); }
      else {
        $("#pw-err").textContent = t("admin.wrong");
        $("#pw-err").classList.remove("hidden");
      }
    }
    $("#unlock").addEventListener("click", tryUnlock);
    $("#pw").addEventListener("keydown", function (e) { if (e.key === "Enter") { tryUnlock(); } });
    $("#pw").focus();
  }

  function staffDialog(existing, onDone) {
    var roles = ["administrator", "supervisor", "engineer", "technician", "viewer"];
    var body = document.createElement("div");
    body.innerHTML =
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t("admin.nameEn")) + ' <span class="req">*</span></label><input class="input" id="s-en"></div>' +
      "</div>" +
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t("profile.employeeId")) + '</label><input class="input" id="s-emp"></div>' +
        '<div class="field"><label>' + esc(t("profile.jobTitle")) + '</label><input class="input" id="s-job"></div>' +
      "</div>" +
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t("profile.department")) + '</label><input class="input" id="s-dep"></div>' +
        '<div class="field"><label>' + esc(t("profile.role")) + "</label>" +
          '<select class="input" id="s-role">' + roles.map(function (r) {
            return '<option value="' + r + '">' + esc(t("role." + r)) + "</option>";
          }).join("") + "</select></div>" +
      "</div>" +
      '<div class="err-msg hidden" id="s-err"></div>';

    if (existing) {
      body.querySelector("#s-en").value = existing.name || "";
      body.querySelector("#s-emp").value = existing.employeeId || "";
      body.querySelector("#s-job").value = existing.jobTitle || "";
      body.querySelector("#s-dep").value = existing.department || "";
      body.querySelector("#s-role").value = existing.role || "engineer";
    }

    global.UI.modal({
      title: existing ? t("admin.editStaff") : t("admin.addStaff"),
      body: body, wide: true,
      buttons: [
        { label: t("common.cancel"), value: null },
        {
          label: t("common.save"), primary: true,
          before: function (b) {
            var name = $("#s-en", b).value.trim();
            if (!name) {
              $("#s-err", b).textContent = t("err.nameRequired");
              $("#s-err", b).classList.remove("hidden");
              return false;
            }
            return {
              id: existing ? existing.id : global.Util.uuid(),
              name: name,
              employeeId: $("#s-emp", b).value.trim(),
              jobTitle: $("#s-job", b).value.trim(),
              department: $("#s-dep", b).value.trim(),
              role: $("#s-role", b).value,
              active: existing ? (existing.active !== false) : true,
              createdAt: existing ? existing.createdAt : new Date().toISOString()
            };
          }
        }
      ]
    }).then(async function (user) {
      if (!user) { return; }
      global.UI.busy(true, t("common.saving"));
      try {
        await S.upsertUser(user);
        global.UI.toast(t("admin.staffSaved"), "ok");
        if (onDone) { onDone(); }
      } catch (e) { global.UI.toast(t("err.write"), "err"); }
      global.UI.busy(false);
    });
  }

  /* ================================ SEARCH ================================ */

  async function search(q) {
    var query = global.Util.normalize(q);
    view().innerHTML = '<div class="empty">' + esc(t("common.loading")) + "</div>";
    if (!query) { view().innerHTML = emptyBlock(t("search.none")); return; }

    var all = await S.listHandovers();
    var hoHits = all.filter(function (h) { return S.searchText(h).indexOf(query) >= 0; });
    var tagHits = S.tags().filter(function (tag) {
      return global.Util.normalize(tag.tagNo + " " + tag.descEn).indexOf(query) >= 0;
    });
    var peopleHits = S.users().filter(function (u) {
      return global.Util.normalize(u.name + " " + (u.jobTitle || "")).indexOf(query) >= 0;
    });

    // Comments live inside their handover file, so only scan what matched or is recent.
    var commentHits = [];
    var scan = all.slice(0, 120);
    for (var i = 0; i < scan.length; i++) {
      if (!scan[i].commentCount) { continue; }
      var full = await S.getHandover(scan[i].id);
      if (!full) { continue; }
      (full.comments || []).forEach(function (c) {
        if (global.Util.normalize(c.text).indexOf(query) >= 0) {
          commentHits.push({ handoverId: full.id, title: full.title, text: c.text, by: c.by, at: c.at });
        }
      });
    }

    var total = hoHits.length + tagHits.length + peopleHits.length + commentHits.length;

    view().innerHTML =
      '<div class="page-head"><div><h1>' + esc(t("search.title")) + "</h1><p>" + esc(t("search.for", { q: q })) + "</p></div></div>" +
      (total === 0 ? emptyBlock(t("search.none")) :
        (hoHits.length ? "<h3>" + esc(t("search.handovers")) + " (" + global.Fmt.num(hoHits.length) + ')</h3><div class="list" style="margin-bottom:18px">' +
          hoHits.slice(0, 25).map(handoverCard).join("") + "</div>" +
          (hoHits.length > 25
            ? '<div style="margin:-6px 0 18px"><button class="btn sm" id="s-all">' + esc(t("arc.viewAll", { n: global.Fmt.num(hoHits.length) })) + "</button></div>"
            : "") : "") +
        (tagHits.length ? "<h3>" + esc(t("search.tags")) + " (" + global.Fmt.num(tagHits.length) + ')</h3><div class="chips" style="margin-bottom:18px">' +
          tagHits.slice(0, 40).map(function (tag) { return tagChip(tag.tagNo, { link: true }); }).join(" ") + "</div>" : "") +
        (commentHits.length ? "<h3>" + esc(t("search.comments")) + " (" + global.Fmt.num(commentHits.length) + ')</h3><div class="card" style="margin-bottom:18px">' +
          commentHits.slice(0, 20).map(function (c) {
            return '<div class="comment" data-id="' + esc(c.handoverId) + '" style="cursor:pointer">' +
              '<span class="avatar">' + esc(initials(personName(c.by))) + "</span>" +
              '<div class="c-body"><div class="c-head"><b>' + esc(personName(c.by)) + "</b>" +
              '<span class="faint small">' + esc(c.title) + " · " + esc(global.Fmt.dateTime(c.at)) + "</span></div>" +
              '<div class="c-text">' + esc(c.text.slice(0, 220)) + "</div></div></div>";
          }).join("") + "</div>" : "") +
        (peopleHits.length ? "<h3>" + esc(t("search.people")) + '</h3><div class="card">' +
          peopleHits.map(function (u) {
            return '<div style="display:flex;gap:10px;align-items:center;padding:7px 0">' +
              '<span class="avatar">' + esc(initials(personName(u))) + "</span><div><b>" + esc(personName(u)) + "</b>" +
              '<div class="faint small">' + esc(u.jobTitle || "") + "</div></div></div>";
          }).join("") + "</div>" : "")
      );

    wireCards(view());
    if ($("#s-all")) {
      $("#s-all").addEventListener("click", function () {
        listFilters = { q: q, status: "", area: "", from: "", to: "", creator: "", worked: "", tag: "", src: "", mine: false };
        go("#/handovers");
      });
    }
    $$(".comment[data-id]").forEach(function (el) {
      el.addEventListener("click", function () { go("#/handover/" + el.getAttribute("data-id")); });
    });
  }

  global.Views = {
    dashboard: dashboard,
    handoverList: handoverList,
    handoverForm: handoverForm,
    handoverDetail: handoverDetail,
    equipmentList: equipmentList,
    equipmentDetail: equipmentDetail,
    notifications: notifications,
    profile: profile,
    admin: admin,
    search: search,
    notifText: notifText,
    isUnread: isUnread,
    personName: personName,
    initials: initials
  };
})(window);
