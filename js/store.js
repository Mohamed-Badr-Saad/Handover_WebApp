/* ==========================================================================
   store.js - the file share IS the database.

   Everything lives under the folder the user picks:

     data/master/      settings.json, users.json, equipment_tags.json, structure.json
     data/handovers/   <handoverId>.json          one file per handover
     data/attachments/ <handoverId>/<attId>__name
     data/notifications/<sortableTs>__<id>.json
     data/locks/       <handoverId>.lock
     data/index/       <yyyy-mm>.json             listing cache, rebuildable

   Design notes:
   - One file per record, so two people editing different handovers never
     touch the same file.
   - Writes go to <name>.tmp then rename over the target, so nobody ever
     reads a half-written record.
   - The index shards are only a cache. If they are wrong or missing the app
     heals them from the record files themselves.
   ========================================================================== */
(function (global) {
  "use strict";

  var DB_NAME = "plant_handover";
  var DB_STORE = "handles";
  var HANDLE_KEY = "root";
  var LOCK_STALE_MIN = 15;

  var root = null;          // FileSystemDirectoryHandle for the chosen folder
  var master = {            // cached master data, loaded once per session
    settings: null, users: null, tags: null, structure: null
  };

  /* ----------------------------------------------------------------- Log
     Everything on the connect path writes here and to the console, so a
     machine that misbehaves can be diagnosed from the log alone. */

  var logLines = [];

  function log(message, detail) {
    var line = new Date().toISOString().slice(11, 23) + "  " + message +
      (detail === undefined || detail === "" ? "" : "  \u2192 " + detail);
    logLines.push(line);
    if (logLines.length > 400) { logLines.shift(); }
    try { console.log("[handover] " + line); } catch (e) {}
  }

  function logText() { return logLines.join("\n"); }

  /* Nothing on the connect path is allowed to hang forever. A promise that
     never settles is the one failure mode that shows no error at all. */
  function withTimeout(promise, ms, label) {
    var timer;
    return Promise.race([
      Promise.resolve(promise).then(function (v) { clearTimeout(timer); return v; },
                                    function (e) { clearTimeout(timer); throw e; }),
      new Promise(function (_, reject) {
        timer = setTimeout(function () {
          var err = new Error(label + " did not respond within " + (ms / 1000) + "s");
          err.name = "TimeoutError";
          reject(err);
        }, ms);
      })
    ]);
  }

  /* ------------------------------------------------------------ IndexedDB */

  function idb() {
    return new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () { req.result.createObjectStore(DB_STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(key) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, "readonly");
        var r = tx.objectStore(DB_STORE).get(key);
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
      });
    }).catch(function () { return null; });
  }

  function idbPut(key, value) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).put(value, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    }).catch(function () { return false; });
  }

  /* --------------------------------------------------------- Path plumbing */

  async function dirFor(parts, create) {
    if (!root) { throw new Error("no-folder"); }
    var d = root;
    for (var i = 0; i < parts.length; i++) {
      d = await d.getDirectoryHandle(parts[i], { create: !!create });
    }
    return d;
  }

  async function readJson(parts, fallback) {
    try {
      var dir = await dirFor(parts.slice(0, -1), false);
      var fh = await dir.getFileHandle(parts[parts.length - 1], { create: false });
      var file = await fh.getFile();
      var text = await file.text();
      return text ? JSON.parse(text) : fallback;
    } catch (e) {
      if (e && (e.name === "NotFoundError" || e.name === "TypeMismatchError")) { return fallback; }
      if (e instanceof SyntaxError) { return fallback; }
      throw e;
    }
  }

  async function writeJson(parts, obj, compact) {
    var name = parts[parts.length - 1];
    var dir = await dirFor(parts.slice(0, -1), true);
    var text = compact ? JSON.stringify(obj) : JSON.stringify(obj, null, 2);
    var tmpName = name + ".tmp";
    try {
      var tmp = await dir.getFileHandle(tmpName, { create: true });
      var w = await tmp.createWritable();
      await w.write(text);
      await w.close();
      if (typeof tmp.move === "function") {
        await tmp.move(name);
        return true;
      }
      // move() unavailable - write straight to the target instead.
      var fh = await dir.getFileHandle(name, { create: true });
      var w2 = await fh.createWritable();
      await w2.write(text);
      await w2.close();
      try { await dir.removeEntry(tmpName); } catch (e2) { /* delete may be blocked */ }
      return true;
    } catch (e) {
      // Last resort: plain write, so a failed rename never loses the record.
      var fh3 = await dir.getFileHandle(name, { create: true });
      var w3 = await fh3.createWritable();
      await w3.write(text);
      await w3.close();
      return true;
    }
  }

  async function listNames(parts) {
    var out = [];
    try {
      var dir = await dirFor(parts, false);
      for await (var name of dir.keys()) { out.push(name); }
    } catch (e) { /* folder not there yet */ }
    return out;
  }

  async function removeFile(parts) {
    try {
      var dir = await dirFor(parts.slice(0, -1), false);
      await dir.removeEntry(parts[parts.length - 1]);
      return true;
    } catch (e) { return false; }
  }

  /* -------------------------------------------------------- Connect / setup */

  function supported() { return typeof global.showDirectoryPicker === "function"; }

  function hasSaved() { return idbGet(HANDLE_KEY).then(function (h) { return !!h; }); }

  async function restore(promptIfNeeded) {
    var handle;
    try {
      handle = await withTimeout(idbGet(HANDLE_KEY), 5000, "indexedDB");
    } catch (e) {
      log("restore", "indexedDB timed out, starting fresh");
      return "none";
    }
    if (!handle) { log("restore", "no saved folder"); return "none"; }
    var perm;
    try {
      perm = await handle.queryPermission({ mode: "readwrite" });
      if (perm !== "granted" && promptIfNeeded) {
        perm = await handle.requestPermission({ mode: "readwrite" });
      }
    } catch (e) { log("restore", "stale handle"); return "none"; }
    if (perm !== "granted") { log("restore", "needs permission"); return "needs-permission"; }
    root = handle;
    log("restore", "reconnected to " + handle.name);
    return "ok";
  }

  async function choose(onStep) {
    function step(key, ok, detail) {
      log("choose/" + key, (ok === true ? "ok" : ok === false ? "FAILED" : ok) + (detail ? " " + detail : ""));
      if (onStep) { onStep(key, ok, detail); }
    }

    step("picker", "opening");
    var handle = await global.showDirectoryPicker({ mode: "readwrite", id: "plant-handover" });
    step("picker", true, handle && handle.name);

    // The picker already grants readwrite. Asking again after an await can be
    // refused for lack of user activation, so only ask if it is not granted,
    // and treat a failed or slow query as "carry on" - the write probe decides.
    var perm = "granted";
    try {
      perm = await withTimeout(handle.queryPermission({ mode: "readwrite" }), 8000, "queryPermission");
      step("permission", perm === "granted", perm);
      if (perm !== "granted") {
        perm = await withTimeout(handle.requestPermission({ mode: "readwrite" }), 120000, "requestPermission");
        step("permissionPrompt", perm === "granted", perm);
      }
    } catch (e) {
      step("permission", "skipped", (e && e.name) || "error");
      perm = "granted";
    }
    if (perm !== "granted") {
      var err = new Error("permission not granted");
      err.name = "NotAllowedError";
      throw err;
    }

    root = handle;

    // Remembering the folder is a convenience. On some origins IndexedDB never
    // answers at all, so it gets a short leash and is never allowed to block.
    try {
      var saved = await withTimeout(idbPut(HANDLE_KEY, handle), 5000, "indexedDB");
      step("remember", saved === true, saved === true ? "" : "not stored");
    } catch (e) {
      step("remember", "skipped", (e && e.name) || "error");
    }
    return true;
  }

  /* Proves the chosen folder is actually writable, one operation at a time, so
     a failure names the exact step instead of "something went wrong". */
  async function probe() {
    var out = { createFolder: null, writeFile: null, readBack: null, deleteFile: null, error: "" };
    function note(e) {
      out.error = (e && e.name ? e.name + ": " : "") + ((e && e.message) || String(e));
    }
    var dir;
    try {
      dir = await withTimeout(dirFor(["data"], true), 20000, "creating the data folder");
      out.createFolder = true;
      log("probe/createFolder", "ok");
    } catch (e) { out.createFolder = false; note(e); log("probe/createFolder", "FAILED " + out.error); return out; }

    var fh;
    try {
      fh = await withTimeout(dir.getFileHandle("_write_test.tmp", { create: true }), 20000, "creating a test file");
      var w = await withTimeout(fh.createWritable(), 20000, "opening the test file for writing");
      await withTimeout(w.write("ok"), 20000, "writing the test file");
      await withTimeout(w.close(), 20000, "closing the test file");
      out.writeFile = true;
      log("probe/writeFile", "ok");
    } catch (e) { out.writeFile = false; note(e); log("probe/writeFile", "FAILED " + out.error); return out; }

    try {
      var file = await withTimeout(fh.getFile(), 20000, "reading the test file");
      var text = await withTimeout(file.text(), 20000, "reading the test file");
      out.readBack = (text === "ok");
      if (!out.readBack) { out.error = "read-back mismatch"; }
      log("probe/readBack", out.readBack ? "ok" : "mismatch");
    } catch (e) { out.readBack = false; note(e); log("probe/readBack", "FAILED " + out.error); }

    try {
      await withTimeout(dir.removeEntry("_write_test.tmp"), 20000, "deleting the test file");
      out.deleteFile = true;
      log("probe/deleteFile", "ok");
    } catch (e) { out.deleteFile = false; log("probe/deleteFile", "not permitted"); }   // not fatal

    return out;
  }

  function rootName() { return root ? root.name : ""; }
  function connected() { return !!root; }

  function disconnect() {
    root = null;
    master = { settings: null, users: null, tags: null, structure: null };
    return idbPut(HANDLE_KEY, null);
  }

  /* Creates the folder skeleton and seeds sample data the first time. */
  async function ensureScaffold() {
    var fresh = false;
    log("scaffold", "creating folders");
    await dirFor(["data", "master"], true);
    await dirFor(["data", "handovers"], true);
    await dirFor(["data", "attachments"], true);
    await dirFor(["data", "notifications"], true);
    await dirFor(["data", "locks"], true);
    await dirFor(["data", "index"], true);

    var settings = await readJson(["data", "master", "settings.json"], null);
    if (!settings) {
      fresh = true;
      settings = {
        plantName: "Plant Handover",
        adminPasswordHash: await global.Util.sha256("Handover2026"),
        maxAttachmentMb: global.Util.MAX_MB,
        createdAt: new Date().toISOString(),
        schema: 1
      };
      await writeJson(["data", "master", "settings.json"], settings);
    }

    var structure = await readJson(["data", "master", "structure.json"], null);
    if (!structure) { structure = SEED.structure; await writeJson(["data", "master", "structure.json"], structure); }

    var users = await readJson(["data", "master", "users.json"], null);
    if (!users || !(users.users || []).length) {
      users = { users: seedStaff() };
      await writeJson(["data", "master", "users.json"], users);
    }

    var tags = await readJson(["data", "master", "equipment_tags.json"], null);
    var register = seedTags();
    if (!tags) {
      tags = { tags: register };
      await writeJson(["data", "master", "equipment_tags.json"], tags);
    } else if ((tags.tags || []).length < 20 && register.length > 20) {
      // Folder set up by an earlier build that only had sample tags - load the
      // real register, keeping anything that was added by hand in the meantime.
      var kept = (tags.tags || []).filter(function (tg) {
        return !register.some(function (r) {
          return String(r.tagNo).toUpperCase() === String(tg.tagNo).toUpperCase();
        });
      });
      tags = { tags: register.concat(kept) };
      await writeJson(["data", "master", "equipment_tags.json"], tags);
    }

    master.settings = settings;
    master.structure = structure;
    master.users = users;
    master.tags = tags;
    log("scaffold", "done, " + (tags.tags || []).length + " tags, " + (users.users || []).length + " staff");
    return fresh;
  }

  async function loadMaster() {
    master.settings  = await readJson(["data", "master", "settings.json"], null);
    master.structure = await readJson(["data", "master", "structure.json"], SEED.structure);
    master.users     = await readJson(["data", "master", "users.json"], { users: [] });
    master.tags      = await readJson(["data", "master", "equipment_tags.json"], { tags: [] });
    log("loadMaster", (master.tags.tags || []).length + " tags, " + (master.users.users || []).length + " staff");
    return master;
  }

  /* ------------------------------------------------------------- Master data */

  function settings() { return master.settings || {}; }
  function users() { return (master.users && master.users.users) || []; }
  function tags() { return (master.tags && master.tags.tags) || []; }
  function structure() { return master.structure || SEED.structure; }

  /* Master files are shared by everyone, so a write re-reads the file first and
     applies just its own change. Without this, two people adding a tag at the
     same moment would each save their whole in-memory copy and the second
     would silently wipe the first one's addition. */
  /* A best-effort mutex for the shared master files. There is no atomic
     create-if-absent on a file share, so this uses the classic write-wait-read
     trick: claim the lock with a random token, pause, then read it back. If the
     token is still ours nobody else claimed it in the meantime. It is not a
     hard guarantee, but it serialises the realistic case and costs ~150ms on
     an operation people perform a few times a day. */
  async function claimLock(name) {
    var token = global.Util.uuid();
    var path = ["data", "locks", name + ".wlock"];
    for (var i = 0; i < 10; i++) {
      var held = await readJson(path, null);
      var fresh = held && !held.released &&
                  (Date.now() - new Date(held.at).getTime() < 8000);
      if (!fresh) {
        await writeJson(path, { token: token, at: new Date().toISOString(), released: false });
        await new Promise(function (r) { setTimeout(r, 70 + Math.random() * 110); });
        var check = await readJson(path, null);
        if (check && check.token === token) { return { name: name, token: token }; }
      }
      await backoff(i);
    }
    return null;   // busy for too long - go ahead anyway rather than block the user
  }

  async function freeLock(lock) {
    if (!lock) { return; }
    var path = ["data", "locks", lock.name + ".wlock"];
    var held = await readJson(path, null);
    if (held && held.token === lock.token) {
      await writeJson(path, { released: true, at: new Date().toISOString() });
    }
  }

  async function mutate(pathParts, key, fn, verify) {
    var lock = await claimLock(key);
    try {
      return await mutateLocked(pathParts, key, fn, verify);
    } finally {
      await freeLock(lock);
    }
  }

  async function mutateLocked(pathParts, key, fn, verify) {
    var tries = 6;
    var wrapper = {};
    for (var i = 0; i < tries; i++) {
      var disk = await readJson(pathParts, null);
      var list = (disk && disk[key]) ? disk[key].slice() : [];
      var next = fn(list) || list;
      wrapper = {};
      wrapper[key] = next;
      await writeJson(pathParts, wrapper);

      if (verify) {
        var after = await readJson(pathParts, null);
        var afterList = (after && after[key]) ? after[key] : [];
        if (!verify(afterList)) {
          // Another PC overwrote us between our read and our write - re-apply.
          if (i < tries - 1) { await backoff(i); continue; }
        }
        wrapper[key] = afterList;
        next = afterList;
      }

      if (key === "users") { master.users = wrapper; } else { master.tags = wrapper; }
      return next;
    }
  }

  var USERS_PATH = ["data", "master", "users.json"];
  var TAGS_PATH = ["data", "master", "equipment_tags.json"];

  function mutateUsers(fn) { return mutate(USERS_PATH, "users", fn); }
  function mutateTags(fn) { return mutate(TAGS_PATH, "tags", fn); }

  function saveUsers(list) { return mutateUsers(function () { return list; }); }
  function saveTags(list) { return mutateTags(function () { return list; }); }

  function indexOfBy(list, field, value) {
    for (var i = 0; i < list.length; i++) {
      if (String(list[i][field]).toUpperCase() === String(value).toUpperCase()) { return i; }
    }
    return -1;
  }

  /* Adds or replaces one person, leaving everyone else on disk untouched. */
  function upsertUser(user) {
    return mutate(USERS_PATH, "users", function (list) {
      var i = indexOfBy(list, "id", user.id);
      if (i >= 0) {
        // An edit form does not carry the password, so never let a profile
        // edit silently delete someone's sign-in.
        if (user.password === undefined && list[i].password) {
          user.password = list[i].password;
          user.passwordSetAt = list[i].passwordSetAt;
        }
        list[i] = user;
      } else { list.push(user); }
      return list;
    }, function (list) { return indexOfBy(list, "id", user.id) >= 0; });
  }

  /* --------------------------------------------------------- Sign-in secrets */

  function setUserPassword(userId, secret) {
    return mutate(USERS_PATH, "users", function (list) {
      var i = indexOfBy(list, "id", userId);
      if (i >= 0) {
        list[i].password = secret;
        list[i].passwordSetAt = new Date().toISOString();
      }
      return list;
    }, function (list) {
      var i = indexOfBy(list, "id", userId);
      return i >= 0 && !!list[i].password;
    });
  }

  function clearUserPassword(userId) {
    return mutate(USERS_PATH, "users", function (list) {
      var i = indexOfBy(list, "id", userId);
      if (i >= 0) { delete list[i].password; delete list[i].passwordSetAt; }
      return list;
    }, function (list) {
      var i = indexOfBy(list, "id", userId);
      return i >= 0 && !list[i].password;
    });
  }

  function hasPassword(userId) {
    var u = userById(userId);
    return !!(u && u.password);
  }

  function verifyUserPassword(userId, password) {
    var u = userById(userId);
    if (!u || !u.password) { return Promise.resolve(false); }
    return global.Util.verifySecret(password, u.password);
  }

  /* Accepts the original bare-sha256 administrator hash as well as the new
     salted record, so an existing folder keeps working untouched. */
  function verifyAdmin(password) {
    var st = settings();
    return global.Util.verifySecret(password, st.adminSecret || st.adminPasswordHash);
  }

  async function setAdminPassword(password) {
    var secret = await global.Util.makeSecret(password);
    var st = settings();
    st.adminSecret = secret;
    delete st.adminPasswordHash;
    await saveSettings(st);
    return true;
  }

  function setUserActive(id, active) {
    return mutateUsers(function (list) {
      var i = indexOfBy(list, "id", id);
      if (i >= 0) { list[i].active = active; }
      return list;
    });
  }

  /* Adds or replaces one tag, leaving every other tag on disk untouched. */
  function upsertTag(tag) {
    return mutate(TAGS_PATH, "tags", function (list) {
      var i = indexOfBy(list, "tagNo", tag.tagNo);
      if (i >= 0) { list[i] = tag; } else { list.push(tag); }
      return list;
    }, function (list) { return indexOfBy(list, "tagNo", tag.tagNo) >= 0; });
  }

  function bulkSetArea(tagNos, area) {
    var wanted = {};
    tagNos.forEach(function (n) { wanted[String(n).toUpperCase()] = true; });
    return mutateTags(function (list) {
      list.forEach(function (tg) {
        if (wanted[String(tg.tagNo).toUpperCase()]) { tg.area = area; }
      });
      return list;
    });
  }

  /* Merges the built-in roster in, matching on employee ID so re-loading it
     updates people rather than duplicating them, and keeps anyone added by hand. */
  function loadStandardStaff() {
    return mutateUsers(function (list) {
      seedStaff().forEach(function (p) {
        var i = indexOfBy(list, "employeeId", p.employeeId);
        if (i >= 0) {
          list[i].name = p.name;
          list[i].jobTitle = p.jobTitle;
          list[i].department = p.department;
          list[i].role = p.role;
        } else { list.push(p); }
      });
      return list;
    });
  }
  async function saveSettings(obj) {
    master.settings = obj;
    await writeJson(["data", "master", "settings.json"], obj);
  }
  async function saveStructure(obj) {
    master.structure = obj;
    await writeJson(["data", "master", "structure.json"], obj);
  }

  /* Only engineers (and anyone given the administrator role) sign in.
     Supervisors and technicians stay on the roster so engineers can list
     them under "Worked with", but they have no account and no password. */
  var ACCOUNT_ROLES = ["engineer", "manager", "administrator"];

  /* Handovers written by a manager carry restricted:"managers". Only people
     signed in with the manager role see them - in lists, search, counts,
     tag history, notifications and exports. Hidden by the app only: the
     files sit in the same shared folder as everything else. */
  function viewerIsManager() {
    var me = global.App && global.App.user ? global.App.user() : null;
    return !!(me && me.role === "manager");
  }
  function canView(h) { return !h || !h.restricted || viewerIsManager(); }
  function visibleOnly(list) { return viewerIsManager() ? list : list.filter(canView); }
  function canSignIn(u) { return !!u && u.active !== false && ACCOUNT_ROLES.indexOf(u.role || "") >= 0; }

  function userById(id) {
    var list = users();
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } }
    return null;
  }
  function tagByNumber(no) {
    var list = tags(), n = String(no || "").toUpperCase();
    for (var i = 0; i < list.length; i++) { if (String(list[i].tagNo).toUpperCase() === n) { return list[i]; } }
    return null;
  }

  /* ---------------------------------------------------------- Handover index
     Index shards live at data/index/<yyyy-mm>.json and hold the light header
     of every handover created that month. They are a cache: the record files
     are the truth, and anything missing is read back and folded in. */

  var cache = { headers: null };

  function headerOf(h) {
    return {
      id: h.id, title: h.title, status: h.status,
      plant: h.plant, area: h.area, unit: h.unit, shift: h.shift,
      tags: h.tags || [],
      teamIds: (h.team || []).map(function (m) { return m && m.id; }).filter(Boolean),
      restricted: h.restricted || undefined,
      importedFrom: h.importedFrom || undefined,
      hv: 2,
      createdBy: h.createdBy, createdAt: h.createdAt, updatedAt: h.updatedAt,
      dueDate: h.dueDate || null,
      commentCount: (h.comments || []).length,
      attachmentCount: (h.attachments || []).length,
      snippet: String(h.description || "").slice(0, 220),
      archived: h.archived ? true : undefined,
      legacyStatus: h.legacyStatus || undefined,
      location: h.location || undefined,
      dateUnknown: h.dateUnknown ? true : undefined
    };
  }

  /* Saves many new handovers at once (Excel import). Each record is still its
     own file; the month index files are written once per month at the end
     instead of once per record. Dates come from the sheet, so updatedAt is
     left equal to createdAt and old entries slot in where they belong. */
  async function addHandovers(list, onProgress) {
    var byMonth = {};
    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      rec.version = 1;
      await writeJson(["data", "handovers", rec.id + ".json"], rec);
      var key = shardKey(rec.createdAt);
      (byMonth[key] = byMonth[key] || []).push(headerOf(rec));
      if (onProgress) { onProgress(i + 1, list.length); }
    }
    var months = Object.keys(byMonth);
    for (var m = 0; m < months.length; m++) {
      var path = ["data", "index", months[m] + ".json"];
      try {
        var shard = await readJson(path, null) || { month: months[m], items: {} };
        byMonth[months[m]].forEach(function (h) { shard.items[h.id] = h; });
        shard.updatedAt = new Date().toISOString();
        await writeJson(path, shard);
      } catch (e) { /* the index heals itself from the record files */ }
    }
    invalidate();
    return list.length;
  }

  /* Every header, including managers-only ones the viewer cannot see. Used
     only to recognise duplicates during a bulk import; never displayed. */
  async function allHeaders() {
    await listHandovers();
    return (cache.headers || []).slice();
  }

  /* Newest first; records with no date at all go to the bottom. */
  function byNewest(a, b) {
    return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
  }

  function shardKey(iso) { return String(iso || new Date().toISOString()).slice(0, 7); }

  async function readShards() {
    var names = await listNames(["data", "index"]);
    var map = {};
    for (var i = 0; i < names.length; i++) {
      if (!/\.json$/.test(names[i])) { continue; }
      var shard = await readJson(["data", "index", names[i]], null);
      if (shard && shard.items) {
        Object.keys(shard.items).forEach(function (id) { map[id] = shard.items[id]; });
      }
    }
    return map;
  }

  async function writeShardEntry(header) {
    var key = shardKey(header.createdAt);
    var path = ["data", "index", key + ".json"];
    var shard = await readJson(path, null) || { month: key, items: {} };
    shard.items[header.id] = header;
    shard.updatedAt = new Date().toISOString();
    await writeJson(path, shard);
  }

  async function removeShardEntry(id, createdAt) {
    var key = shardKey(createdAt);
    var path = ["data", "index", key + ".json"];
    var shard = await readJson(path, null);
    if (shard && shard.items && shard.items[id]) {
      delete shard.items[id];
      await writeJson(path, shard);
    }
  }

  /* Returns every handover header, healing the index from record files. */
  async function listHandovers(force) {
    if (cache.headers && !force) { return visibleOnly(cache.headers); }
    var gone = await readDeleted();
    var indexed = await readShards();
    var files = await listNames(["data", "handovers"]);
    var seen = {};
    var result = [];
    var missing = [];

    files.forEach(function (name) {
      var m = /^(.+)\.json$/.exec(name);
      if (!m || /\.tmp$/.test(name)) { return; }
      var id = m[1];
      seen[id] = true;
      if (gone[id]) { return; }
      // Older index entries lack the team list - re-read those once.
      if (indexed[id] && indexed[id].hv === 2) { result.push(indexed[id]); } else { missing.push(id); }
    });

    for (var i = 0; i < missing.length; i++) {
      var rec = await readJson(["data", "handovers", missing[i] + ".json"], null);
      if (rec && rec.id) {
        var hdr = headerOf(rec);
        result.push(hdr);
        try { await writeShardEntry(hdr); } catch (e) { /* cache only */ }
      }
    }

    // Fold in the imported archive. A live file with the same id is an
    // archived handover someone has since commented on - the live one wins.
    var arc = await loadArchive();
    for (var k = 0; k < arc.headers.length; k++) {
      if (!seen[arc.headers[k].id] && !gone[arc.headers[k].id]) { result.push(arc.headers[k]); }
    }

    result.forEach(fixStatus);
    result.sort(byNewest);
    cache.headers = result;
    return visibleOnly(result);
  }

  function invalidate() { cache.headers = null; }

  async function rebuildIndex() {
    var files = await listNames(["data", "handovers"]);
    var shards = {};
    for (var i = 0; i < files.length; i++) {
      if (!/\.json$/.test(files[i]) || /\.tmp$/.test(files[i])) { continue; }
      var rec = await readJson(["data", "handovers", files[i]], null);
      if (!rec || !rec.id) { continue; }
      var key = shardKey(rec.createdAt);
      if (!shards[key]) { shards[key] = { month: key, items: {} }; }
      shards[key].items[rec.id] = headerOf(rec);
    }
    var keys = Object.keys(shards);
    for (var j = 0; j < keys.length; j++) {
      shards[keys[j]].updatedAt = new Date().toISOString();
      await writeJson(["data", "index", keys[j] + ".json"], shards[keys[j]]);
    }
    invalidate();
    return keys.length;
  }

  /* --------------------------------------------------------------- Handovers */

  /* Live file first; an archived handover nobody has touched yet only exists
     inside its year bucket, so fall back to that. The first comment or
     attachment then writes a live copy through the normal save path. */
  async function getHandover(id) {
    if (deletedIds[id]) { return null; }
    var rec = await readJson(["data", "handovers", id + ".json"], null);
    if (rec && !canView(rec)) { return null; }
    if (rec || !isArchiveId(id)) { return fixStatus(rec); }
    var arc = await loadArchive();
    var hit = arc.records[id];
    return hit ? JSON.parse(JSON.stringify(hit)) : null;
  }

  /* ---------------------------------------------------------------- Archive
     Old handovers imported from the Excel sheets. Sixteen thousand separate
     files would make every start-up list a huge folder over the network, so
     they are stored one file per year (data/archive/<year>.json) plus a
     manifest written last. The whole archive is read once per session. */

  var ARCHIVE_DIR = ["data", "archive"];
  var archive = null;

  function isArchiveId(id) { return /^arc-/.test(String(id || "")); }

  function inflate(r) {
    r.version = r.version || 1;
    r.archived = true;
    ["title", "description", "plant", "unit", "shift", "area", "location", "legacyStatus"].forEach(function (k) {
      if (r[k] === undefined || r[k] === null) { r[k] = ""; }
    });
    ["tags", "team", "history", "comments", "attachments"].forEach(function (k) {
      if (!Array.isArray(r[k])) { r[k] = []; }
    });
    r.status = normalizeStatus(r);
    r.createdBy = r.createdBy || { id: null, name: "" };
    r.createdAt = r.createdAt || null;
    r.updatedAt = r.updatedAt || r.createdAt || null;
    r.dueDate = r.dueDate || null;
    return r;
  }

  /* Drops empty fields before writing - roughly halves the archive size. */
  function deflate(r) {
    var out = {};
    Object.keys(r).forEach(function (k) {
      var v = r[k];
      if (v === "" || v === null || v === undefined || v === false) { return; }
      if (Array.isArray(v) && !v.length) { return; }
      if (k === "updatedAt" && v === r.createdAt) { return; }
      if (k === "status" && v === "closed") { return; }
      if (k === "archived" || k === "version") { return; }
      out[k] = v;
    });
    return out;
  }

  function bucketOf(r) { return r.createdAt ? String(r.createdAt).slice(0, 4) : "undated"; }

  async function loadArchive(force) {
    if (archive && !force) { return archive; }
    var fresh = { manifest: null, records: {}, headers: [] };
    var manifest = await readJson(ARCHIVE_DIR.concat(["manifest.json"]), null);
    if (manifest && Array.isArray(manifest.buckets)) {
      fresh.manifest = manifest;
      for (var i = 0; i < manifest.buckets.length; i++) {
        var b = manifest.buckets[i];
        var file = await readJson(ARCHIVE_DIR.concat([b + ".json"]), null);
        if (!file || !Array.isArray(file.records)) { log("archive: bucket missing or unreadable", b); continue; }
        file.records.forEach(function (raw) {
          var rec = inflate(raw);
          fresh.records[rec.id] = rec;
          var hdr = headerOf(rec);
          hdr.fromArchive = true;
          fresh.headers.push(hdr);
        });
      }
    }
    archive = fresh;
    return archive;
  }

  /* Synchronous lookup for code that only reads (export, equipment
     timeline). Only valid after listHandovers()/loadArchive(). */
  function archivedRecord(id) {
    return archive && archive.records[id] ? archive.records[id] : null;
  }

  function archiveInfo() {
    if (!archive || !archive.manifest) { return null; }
    return { count: archive.headers.length, importedAt: archive.manifest.importedAt, by: archive.manifest.by };
  }

  /* Full text used by search: for archive records the whole description, so
     a word deep inside an old entry is still found. Cached on the header. */
  function searchText(h) {
    if (h._hay) { return h._hay; }
    var desc = h.snippet;
    if (h.fromArchive && archive && archive.records[h.id]) { desc = archive.records[h.id].description; }
    var who = h.createdBy ? [h.createdBy.name, h.createdBy.original].join(" ") : "";
    var text = [h.title, desc, (h.tags || []).join(" "), who, h.location, h.legacyStatus].join(" ");
    h._hay = global.Util.normalize(text);
    return h._hay;
  }

  /* Writes the bundle produced from the old Excel sheets. Year files first,
     manifest last, so a half-finished import is never picked up. Running it
     again simply overwrites with the same ids. */
  async function importArchive(bundle, byName, onProgress) {
    if (!bundle || bundle.kind !== "plant-handover-archive" || !Array.isArray(bundle.records)) {
      var bad = new Error("not-archive");
      bad.name = "FormatError";
      throw bad;
    }
    var groups = {};
    bundle.records.forEach(function (r) {
      if (!r || !isArchiveId(r.id)) { return; }
      var key = bucketOf(r);
      (groups[key] = groups[key] || []).push(deflate(r));
    });
    var keys = Object.keys(groups).sort();
    for (var i = 0; i < keys.length; i++) {
      if (onProgress) { onProgress(i + 1, keys.length + 1, keys[i]); }
      await writeJson(ARCHIVE_DIR.concat([keys[i] + ".json"]), { bucket: keys[i], records: groups[keys[i]] }, true);
    }
    var addedAreas = await addAreas(bundle.areas || []);
    if (onProgress) { onProgress(keys.length + 1, keys.length + 1, "manifest"); }
    var count = keys.reduce(function (n, k) { return n + groups[k].length; }, 0);
    await writeJson(ARCHIVE_DIR.concat(["manifest.json"]), {
      kind: "plant-handover-archive-manifest",
      importedAt: new Date().toISOString(),
      by: byName || "",
      sources: bundle.sources || [],
      count: count,
      buckets: keys
    });
    archive = null;
    invalidate();
    await loadArchive(true);
    return { count: count, buckets: keys.length, areas: addedAreas };
  }

  async function saveHandover(rec) {
    rec.updatedAt = new Date().toISOString();
    rec.version = (rec.version || 0) + 1;
    await writeJson(["data", "handovers", rec.id + ".json"], rec);
    var hdr = headerOf(rec);
    try { await writeShardEntry(hdr); } catch (e) { /* cache only */ }
    if (cache.headers) {
      var replaced = false;
      cache.headers = cache.headers.map(function (h) {
        if (h.id === hdr.id) { replaced = true; return hdr; }
        return h;
      });
      if (!replaced) { cache.headers.unshift(hdr); }
      cache.headers.sort(byNewest);
    }
    return rec;
  }

  /* Re-reads the record, applies one change and saves. Used for comments,
     attachments and status changes so that two people acting on the same
     handover at the same time do not overwrite each other's addition. */
  /* Read, change, write - with a version check AND a read-back afterwards.
     The version check catches the common case. The read-back catches the rare
     one where two PCs both pass the check before either has finished writing:
     whichever write lost simply notices its change is missing and re-applies
     it on top of the other. `verify` says how to recognise our own change. */
  async function updateHandover(id, fn, verify, attempts) {
    var tries = attempts || 6;
    for (var i = 0; i < tries; i++) {
      var rec = await getHandover(id);
      if (!rec) {
        var err = new Error("not-found");
        err.name = "NotFoundError";
        throw err;
      }
      var expected = rec.version || 0;
      fn(rec);
      var saved = null;
      try {
        saved = await saveHandoverChecked(rec, expected);
      } catch (e) {
        if (e && e.name === "ConflictError" && i < tries - 1) { await backoff(i); continue; }
        throw e;
      }
      if (!verify) { return saved; }
      var after = await getHandover(id);
      if (after && verify(after)) { return after; }
      if (i < tries - 1) { await backoff(i); continue; }
      return after || saved;
    }
  }

  function backoff(attempt) {
    var ms = 30 + (attempt * 40) + Math.random() * 90;
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function appendComment(id, comment) {
    return updateHandover(id,
      function (rec) { rec.comments = (rec.comments || []).concat([comment]); },
      function (rec) {
        return (rec.comments || []).some(function (c) { return c.id === comment.id; });
      });
  }

  function appendAttachments(id, list) {
    return updateHandover(id,
      function (rec) { rec.attachments = (rec.attachments || []).concat(list); },
      function (rec) {
        var have = rec.attachments || [];
        return list.every(function (a) {
          return have.some(function (x) { return x.id === a.id; });
        });
      });
  }

  function setStatus(id, status, byName, byId) {
    return updateHandover(id, function (rec) {
      rec.status = status;
      rec.history = (rec.history || []).concat([
        { status: status, by: byName, byId: byId, at: new Date().toISOString() }
      ]);
    }, function (rec) { return rec.status === status; });
  }

  /* Rejects the save if someone else wrote the record in the meantime. */
  async function saveHandoverChecked(rec, expectedVersion) {
    var current = await getHandover(rec.id);
    if (current && expectedVersion !== undefined && (current.version || 0) !== expectedVersion) {
      var err = new Error("conflict");
      err.name = "ConflictError";
      err.current = current;
      throw err;
    }
    return saveHandover(rec);
  }

  /* ---------------------------------------------------------------- Delete
     A deletion writes a small "tombstone" file to data/deleted/<id>.json that
     keeps a full copy of the handover. Every PC skips tombstoned ids, so the
     handover disappears for everyone even where the share does not allow
     files to be removed, and works the same for imported (archive) entries
     that live inside a year file. Attachments are left in place so that
     Administration can restore the handover exactly as it was. */

  var deletedIds = {};

  async function readDeleted() {
    var names = await listNames(["data", "deleted"]);
    var map = {};
    for (var i = 0; i < names.length; i++) {
      if (!/\.json$/.test(names[i]) || /\.tmp$/.test(names[i])) { continue; }
      var d = await readJson(["data", "deleted", names[i]], null);
      if (d && d.id && !d.restored) { map[d.id] = d; }
    }
    deletedIds = map;
    return map;
  }

  async function deleteHandover(id, by) {
    var rec = await getHandover(id);
    if (!rec) {
      var err = new Error("not-found");
      err.name = "NotFoundError";
      throw err;
    }
    var tomb = {
      id: id,
      title: rec.title || "",
      createdBy: rec.createdBy || null,
      createdAt: rec.createdAt || null,
      archived: !!rec.archived,
      deletedAt: new Date().toISOString(),
      deletedBy: by ? { id: by.id, name: by.name } : null,
      record: rec
    };
    await writeJson(["data", "deleted", id + ".json"], tomb);
    deletedIds[id] = tomb;
    await removeFile(["data", "handovers", id + ".json"]);
    try { await removeShardEntry(id, rec.createdAt); } catch (e) { /* cache only */ }
    if (cache.headers) { cache.headers = cache.headers.filter(function (h) { return h.id !== id; }); }
    return tomb;
  }

  /* Newest deletion first, without the stored record bodies. */
  async function listDeleted() {
    var map = await readDeleted();
    return Object.keys(map).filter(function (id) {
      return canView(map[id].record);
    }).map(function (id) {
      var d = map[id];
      return { id: id, title: d.title, createdBy: d.createdBy, createdAt: d.createdAt,
               archived: d.archived, deletedAt: d.deletedAt, deletedBy: d.deletedBy };
    }).sort(function (a, b) { return String(b.deletedAt || "").localeCompare(String(a.deletedAt || "")); });
  }

  async function restoreHandover(id, by) {
    var tomb = await readJson(["data", "deleted", id + ".json"], null);
    if (!tomb || tomb.restored || !tomb.record) {
      var err = new Error("not-found");
      err.name = "NotFoundError";
      throw err;
    }
    var rec = tomb.record;
    await writeJson(["data", "handovers", id + ".json"], rec);
    try { await writeShardEntry(headerOf(rec)); } catch (e) { /* cache only */ }
    // Overwrite rather than rely on delete, which the share may refuse.
    await writeJson(["data", "deleted", id + ".json"], {
      id: id, title: tomb.title, restored: true,
      restoredAt: new Date().toISOString(),
      restoredBy: by ? { id: by.id, name: by.name } : null
    });
    removeFile(["data", "deleted", id + ".json"]);
    delete deletedIds[id];
    invalidate();
    return rec;
  }

  /* ------------------------------------------------------------------ Locks */

  async function readLock(id) {
    var lock = await readJson(["data", "locks", id + ".lock"], null);
    if (!lock || lock.released) { return null; }
    var ageMin = (Date.now() - new Date(lock.at).getTime()) / 60000;
    if (ageMin > LOCK_STALE_MIN) { return null; }
    return lock;
  }

  function writeLock(id, user) {
    return writeJson(["data", "locks", id + ".lock"], {
      handoverId: id,
      by: user ? user.id : null,
      name: user ? user.name : "",
      at: new Date().toISOString(),
      released: false
    });
  }

  async function releaseLock(id) {
    // Deleting may be blocked by folder permissions, so mark it released too.
    try { await writeJson(["data", "locks", id + ".lock"], { handoverId: id, released: true, at: new Date().toISOString() }); }
    catch (e) { /* ignore */ }
    removeFile(["data", "locks", id + ".lock"]);
  }

  /* ------------------------------------------------------------ Attachments */

  async function putAttachment(handoverId, file) {
    var id = global.Util.uuid();
    var safe = global.Util.safeName(file.name);
    var stored = id.slice(0, 8) + "_" + safe;
    var dir = await dirFor(["data", "attachments", handoverId], true);
    var fh = await dir.getFileHandle(stored, { create: true });
    var w = await fh.createWritable();
    await w.write(file);
    await w.close();
    return {
      id: id, name: safe, stored: stored,
      type: file.type || "", size: file.size,
      at: new Date().toISOString()
    };
  }

  async function getAttachmentFile(handoverId, stored) {
    var dir = await dirFor(["data", "attachments", handoverId], false);
    var fh = await dir.getFileHandle(stored, { create: false });
    return fh.getFile();
  }

  /* --------------------------------------------------------- Notifications
     One file per event, named so a plain filename sort is chronological.
     No per-recipient fan-out: everyone reads the same feed, and each PC
     remembers what its user has already seen. */

  function tsName() {
    return new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  }

  async function addNotification(n) {
    n.id = n.id || global.Util.uuid();
    if (n.restricted === undefined && n.handoverId && cache.headers) {
      var hdr = null;
      for (var k = 0; k < cache.headers.length; k++) { if (cache.headers[k].id === n.handoverId) { hdr = cache.headers[k]; break; } }
      if (hdr && hdr.restricted) { n.restricted = hdr.restricted; }
    }
    if (!n.restricted) { delete n.restricted; }
    n.at = n.at || new Date().toISOString();
    // Short suffix keeps the full Windows path clear of the 260-character limit.
    await writeJson(["data", "notifications", tsName() + "_" + n.id.slice(0, 8) + ".json"], n);
    return n;
  }

  async function listNotifications(limit) {
    var names = await listNames(["data", "notifications"]);
    names = names.filter(function (n) { return /\.json$/.test(n) && !/\.tmp$/.test(n); }).sort();
    if (limit && names.length > limit) { names = names.slice(names.length - limit); }
    var out = [];
    for (var i = names.length - 1; i >= 0; i--) {
      var n = await readJson(["data", "notifications", names[i]], null);
      if (n && canView(n)) { out.push(n); }
    }
    return out;
  }

  /* ---------------------------------------------------------------- Backup */

  async function exportBackup() {
    var bundle = {
      exportedAt: new Date().toISOString(),
      settings: settings(),
      structure: structure(),
      users: users(),
      tags: tags(),
      handovers: [],
      notifications: await listNotifications(500)
    };
    var files = await listNames(["data", "handovers"]);
    for (var i = 0; i < files.length; i++) {
      if (!/\.json$/.test(files[i]) || /\.tmp$/.test(files[i])) { continue; }
      var rec = await readJson(["data", "handovers", files[i]], null);
      if (rec) { bundle.handovers.push(rec); }
    }
    return bundle;
  }

  /* ------------------------------------------------------------- Seed data */

  var TYPE_EN = {
    TX: "Transmitter", GA: "Gauge", XV: "On-Off Valve",
    SW: "Switch", CV: "Control Valve", PCV: "PCV", OT: "Other"
  };
  var SEED = {
    structure: {
      plants: [],
      areas: [
        { id: "WDDM",  en: "WDDM" },
        { id: "SCA",   en: "SCA" },
        { id: "SSS",   en: "SSS" },
        { id: "PHV",   en: "PHV" },
        { id: "PHVII", en: "PHVII" }
      ],
      units: [],
      shifts: [
        { id: "day",   en: "Day shift" },
        { id: "night", en: "Night shift" }
      ],
      equipmentTypes: Object.keys(TYPE_EN).map(function (k) {
        return { id: k, en: TYPE_EN[k] };
      })
    }
  };

  /* Turns a row of the instrument register into the tag shape the app stores. */
  function normalizeSeedTag(r) {
    return {
      tagNo: String(r.tagNo || "").toUpperCase(),
      descEn: r.descEn || "",
      type: r.type || "OT",
      upper: r.upper || "",
      alt: r.alt || [],
      area: r.area || "",
      lrv: r.lrv === undefined ? "" : r.lrv,
      urv: r.urv === undefined ? "" : r.urv,
      uom: r.unit_ || r.uom || "",
      valveSize: r.valveSize === undefined ? "" : r.valveSize,
      swHealthy: r.swHealthy || "",
      swActive: r.swActive || "",
      pcvSp: r.pcvSp || "",
      service: r.service || "",
      serial: r.serial || "",
      system: r.system || "",
      comment: r.comment || "",
      active: r.active !== false
    };
  }

  function seedTags() {
    return (global.SEED_TAGS || []).map(normalizeSeedTag);
  }

  /* Stable id from the employee number, so reloading the roster matches people
     instead of creating duplicates. */
  function staffId(employeeId) {
    return "u-" + String(employeeId || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function seedStaff() {
    var now = new Date().toISOString();
    return (global.SEED_STAFF || []).map(function (p) {
      return {
        id: staffId(p.employeeId),
        name: p.name,
        employeeId: p.employeeId,
        jobTitle: p.jobTitle,
        department: p.department || "",
        role: p.role || "technician",
        active: p.active !== false,
        createdAt: now
      };
    });
  }

  /* Every distinct upper equipment in the tag list, for filters and pickers. */
  function upperEquipmentList() {
    var seen = {}, out = [];
    tags().forEach(function (tg) {
      if (tg.upper && !seen[tg.upper]) { seen[tg.upper] = true; out.push(tg.upper); }
    });
    return out.sort();
  }

  /* Adds or updates tags from an imported register, matching on tag number. */
  async function importTags(rows) {
    var disk = await readJson(TAGS_PATH, null);
    var current = (disk && disk.tags) ? disk.tags.slice() : tags().slice();
    var byNo = {};
    current.forEach(function (tg, i) { byNo[String(tg.tagNo).toUpperCase()] = i; });
    var added = 0, updated = 0;
    rows.forEach(function (raw) {
      var r = raw["Upper Equipment"] !== undefined ? {
        tagNo: raw.Tag, upper: raw["Upper Equipment"],
        type: ({ "Transmitter": "TX", "Gauge": "GA", "On-Off Valve": "XV",
                 "Switch": "SW", "Control Valve": "CV", "PCV": "PCV" })[raw["Calibration sheet Form"]] || "OT",
        lrv: raw.LRV, urv: raw.URV, uom: raw.Unit, valveSize: raw["Valve Size"],
        swHealthy: raw["Switch Healthy SP"], swActive: raw["Switch Active SP"],
        pcvSp: raw["PCV SP"], comment: raw.Comment
      } : raw;
      if (!r.tagNo) { return; }
      var tg = normalizeSeedTag(r);
      if (!tg.descEn) {
        tg.descEn = (TYPE_EN[tg.type] || "Instrument") + (tg.upper ? " on " + tg.upper : "");
      }
      var key = tg.tagNo;
      if (byNo[key] !== undefined) {
        var existing = current[byNo[key]];
        tg.area = tg.area || existing.area;      // never lose an area someone set by hand
        current[byNo[key]] = tg;
        updated++;
      } else {
        byNo[key] = current.length;
        current.push(tg);
        added++;
      }
    });
    await saveTags(current);
    return { added: added, updated: updated, total: current.length };
  }

  /* ------------------------------------------------------------------ Areas */

  async function addArea(id, en) {
    var st = structure();
    var code = String(id || "").trim();
    if (!code) { return null; }
    var exists = (st.areas || []).some(function (a) { return a.id.toLowerCase() === code.toLowerCase(); });
    if (exists) { return null; }
    st.areas = (st.areas || []).concat([{ id: code, en: en || code }]);
    await saveStructure(st);
    return code;
  }

  /* Adds several areas in one write; returns the codes actually added. */
  async function addAreas(list) {
    var fromDisk = await readJson(["data", "master", "structure.json"], null);
    var st = fromDisk || structure();
    var have = {};
    (st.areas || []).forEach(function (a) { have[String(a.id).toLowerCase()] = true; });
    var added = [];
    (list || []).forEach(function (a) {
      var code = String(a && a.id || "").trim();
      if (!code || have[code.toLowerCase()]) { return; }
      have[code.toLowerCase()] = true;
      st.areas = (st.areas || []).concat([{ id: code, en: a.en || code }]);
      added.push(code);
    });
    if (added.length) { await saveStructure(st); }
    return added;
  }

  async function removeArea(id) {
    var st = structure();
    st.areas = (st.areas || []).filter(function (a) { return a.id !== id; });
    await saveStructure(st);
  }

  /* A handover is either information only, information that needs a
     follow-up, or a draft not yet submitted. */
  var STATUSES = ["draft", "info", "info_followup"];
  var FOLLOWUP = "info_followup";

  /* Maps anything older onto the three statuses, so records written before
     this change and the imported Excel entries need no migration:
       imported: "Info" -> info; "Follow up" / "Info + Follow up" -> follow-up
       app:      resolved / closed -> info; submitted, in progress, waiting -> follow-up */
  function normalizeStatus(o) {
    if (!o) { return "info"; }
    if (STATUSES.indexOf(o.status) >= 0) { return o.status; }
    if (o.archived || o.legacyStatus) {
      return /fol+o?w?\s*-?\s*up|folloup|follwup|long-term/i.test(String(o.legacyStatus || "")) ? FOLLOWUP : "info";
    }
    if (o.status === "resolved" || o.status === "closed") { return "info"; }
    return FOLLOWUP;
  }
  function fixStatus(o) { if (o) { o.status = normalizeStatus(o); } return o; }

  global.Store = {
    STATUSES: STATUSES,
    FOLLOWUP: FOLLOWUP,
    normalizeStatus: normalizeStatus,
    SEED: SEED,

    supported: supported, hasSaved: hasSaved, restore: restore, choose: choose,
    connected: connected, rootName: rootName, disconnect: disconnect,
    ensureScaffold: ensureScaffold, loadMaster: loadMaster, probe: probe,
    log: log, logText: logText, withTimeout: withTimeout,

    settings: settings, users: users, tags: tags, structure: structure,
    saveUsers: saveUsers, saveTags: saveTags, saveSettings: saveSettings, saveStructure: saveStructure,
    userById: userById, tagByNumber: tagByNumber, canSignIn: canSignIn,
    upperEquipmentList: upperEquipmentList, importTags: importTags,
    addArea: addArea, addAreas: addAreas, removeArea: removeArea,
    upsertUser: upsertUser, setUserActive: setUserActive, loadStandardStaff: loadStandardStaff,
    setUserPassword: setUserPassword, clearUserPassword: clearUserPassword,
    hasPassword: hasPassword, verifyUserPassword: verifyUserPassword,
    verifyAdmin: verifyAdmin, setAdminPassword: setAdminPassword,
    upsertTag: upsertTag, bulkSetArea: bulkSetArea, seedStaff: seedStaff,
    TYPE_EN: TYPE_EN,

    listHandovers: listHandovers, invalidate: invalidate, rebuildIndex: rebuildIndex,
    getHandover: getHandover, saveHandover: saveHandover,
    updateHandover: updateHandover, appendComment: appendComment,
    appendAttachments: appendAttachments, setStatus: setStatus,
    saveHandoverChecked: saveHandoverChecked, deleteHandover: deleteHandover,
    listDeleted: listDeleted, restoreHandover: restoreHandover,
    addHandovers: addHandovers, allHeaders: allHeaders, canView: canView, viewerIsManager: viewerIsManager,
    importArchive: importArchive, loadArchive: loadArchive, archiveInfo: archiveInfo,
    isArchiveId: isArchiveId, searchText: searchText, archivedRecord: archivedRecord,

    readLock: readLock, writeLock: writeLock, releaseLock: releaseLock,

    putAttachment: putAttachment, getAttachmentFile: getAttachmentFile,

    addNotification: addNotification, listNotifications: listNotifications,

    exportBackup: exportBackup,

    // low-level, used by the admin screen
    _readJson: readJson, _writeJson: writeJson, _listNames: listNames
  };
})(window);
