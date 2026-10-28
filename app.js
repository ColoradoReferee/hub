// app.js · Colorado Referees Hub
// Reads from the database as the signed-in person. Writes (check-in, Help)
// go through the current backend this week so the sheet and the database
// both get them.
(function () {
  'use strict';
  // The version. Goes up with every change to any file in this folder.
  var VERSION = '2026.10.28-j';
  var C = window.HUB, L = window.LANG;
  var sb = window.supabase.createClient(C.supabaseUrl, C.publishableKey);
  var $ = function (id) { return document.getElementById(id); };
  var S = { lang: 'en', me: null, games: [], checkins: {}, notes: [], bulletins: [], events: [], game: null, reason: null,
            coach: { games: [], venue: null, game: null, ref: null, area: null, notes: [] } };

  // ── Words ────────────────────────────────────────────────────────
  function t(key) {
    var o = L[S.lang], parts = key.split('.');
    for (var i = 0; i < parts.length; i++) { if (o == null) return key; o = o[parts[i]]; }
    return o == null ? key : o;
  }
  function applyWords() {
    document.documentElement.lang = S.lang;
    document.querySelectorAll('[data-t]').forEach(function (el) { el.innerHTML = t(el.getAttribute('data-t')); });
    document.querySelectorAll('[data-title]').forEach(function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-title'))); });
  }
  function setLang(l) { S.lang = l; try { localStorage.setItem('hub-lang', l); } catch (e) {} applyWords(); renderAll(); }

  // ── Theme ────────────────────────────────────────────────────────
  function setTheme(th) {
    if (th) document.documentElement.setAttribute('data-theme', th); else document.documentElement.removeAttribute('data-theme');
    try { th ? localStorage.setItem('hub-theme', th) : localStorage.removeItem('hub-theme'); } catch (e) {}
  }
  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme');
    var dark = cur ? cur === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(dark ? 'light' : 'dark');
  }

  // ── Small helpers ────────────────────────────────────────────────
  // Look, don't touch: while viewing as someone else, no write reaches the backend.
  var _fetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    if (S.me && S.me.previewing && String(url).indexOf(C.backend) === 0 && opts && opts.method === 'POST') {
      return Promise.resolve({ json: function () { return Promise.resolve({ status: 'error', message: t('previewNoWrite') }); } });
    }
    return _fetch(url, opts);
  };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function key(n) { return String(n || '').trim().toLowerCase().replace(/\s+/g, ' '); }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function clock(iso) { var d = new Date(iso); if (isNaN(d)) return ''; return d.toLocaleTimeString(S.lang === 'es' ? 'es-US' : 'en-US', { hour: 'numeric', minute: '2-digit' }); }
  function dayShort(iso) { var d = new Date(iso + 'T12:00:00'); return d.toLocaleDateString(S.lang === 'es' ? 'es-US' : 'en-US', { weekday: 'short', day: 'numeric', month: 'short' }); }
  function dayLong(iso) { var d = iso ? new Date(iso + 'T12:00:00') : new Date(); return d.toLocaleDateString(S.lang === 'es' ? 'es-US' : 'en-US', { weekday: 'long', day: 'numeric', month: 'long' }); }
  function myRole(g) {
    var keys = S.me.nameKeys || [];
    if (keys.indexOf(key(g.cr)) >= 0) return 'cr';
    if (keys.indexOf(key(g.ar1)) >= 0) return 'ar1';
    if (keys.indexOf(key(g.ar2)) >= 0) return 'ar2';
    if (keys.indexOf(key(g.fourth)) >= 0) return 'fourth';
    return 'cr';
  }
  function myNameOn(g) { return g[myRole(g)] || (S.me.first_name + ' ' + S.me.last_name); }
  function isCoachSlot(g) { return /coach|mentor/i.test(String(g.age_group || '')) || String(g.hq_role || '').toUpperCase() === 'CM'; }
  function fieldShort(f) { return String(f || '').replace(/^Field\s*/i, ''); }
  function eventFor(g) {
    var num = String(g.game_num || '').toUpperCase(), venue = key(g.venue);
    var hit = null;
    // Hub-created games (id range 900M, game_num H...) never match an event by prefix;
    // their rules come from the competition name alone.
    var isHub = Number(g.game_id) >= 900000000;
    if (!isHub) S.events.forEach(function (e) {
      if (hit) return;
      if (e.game_prefix && num.indexOf(String(e.game_prefix).toUpperCase()) === 0) hit = e;
    });
    // League games: match the competition against the event's league or name.
    var comp = key(g.competition || '');
    if (!hit && comp) S.events.forEach(function (e) {
      if (hit) return;
      var lg = key(e.league || ''), nm = key(e.name || '');
      if ((lg && lg.length > 3 && (comp === lg || comp.indexOf(lg) >= 0 || lg.indexOf(comp) >= 0)) ||
          (nm && nm.length > 3 && comp === nm)) hit = e;
    });
    if (!hit) S.events.forEach(function (e) {
      if (hit) return;
      if ((e.venues || []).some(function (v) { return key(v) === venue; })) hit = e;
    });
    return hit || S.events[0] || null;
  }
  // The event says where its rules are. No event, or no rules on it: nothing.
  function rulesFor(g) {
    if (!g) return null;
    var ev = eventFor(g);
    return ev && ev.rules_url ? ev.rules_url : null;
  }
  var BUSY = 0, LAST_ERROR = '';
  function busy(on) { BUSY += on ? 1 : -1; if (BUSY < 0) BUSY = 0; var b = $('busy'); if (b) b.style.display = BUSY === 0 ? 'none' : 'flex'; }
  async function load(p) { busy(true); LOADING = true; try { return await p; } finally { busy(false); LOADING = false; LAST_ACTIVE = Date.now(); } }
  async function loadDay() { return load(loadDay_()); }
  async function loadOps() { return load(loadOps_()); }
  async function loadCenter() { return load(loadCenter_()); }
  async function loadSetup() { return load(loadSetup_()); }
  async function loadReview() { return load(loadReview_()); }
  async function loadCoach() { return load(loadCoach_()); }
  async function loadSchedule() { return load(loadSchedule_()); }
  function show(id) {
    document.querySelectorAll('.screen').forEach(function (s) { s.classList.toggle('on', s.id === id); });
    // State, Setup and the board are read on desktops too; they get the width.
    document.body.classList.toggle('wide', id === 's-state' || id === 's-setup' || id === 's-ops');
    window.scrollTo(0, 0);
  }

  // ── Data ─────────────────────────────────────────────────────────
  // The database answers at most 1,000 rows per request. A Saturday has
  // more games than that. Page until a short page comes back.
  async function fetchAll(build) {
    var out = [], page = 0, size = 1000;
    for (;;) {
      var r = await build().range(page * size, page * size + size - 1);
      if (r.error) { LAST_ERROR = r.error.message || String(r.error); return { data: out, error: r.error }; }
      out = out.concat(r.data || []);
      if (!r.data || r.data.length < size || page > 20) return { data: out, error: null };
      page++;
    }
  }
  async function loadMe() {
    var who = await sb.rpc('whoami');
    if (who.error || !who.data) return null;
    var names = await sb.rpc('my_name_keys');
    who.data.nameKeys = (names.data || []).map(function (r) { return typeof r === 'string' ? r : r.my_name_keys; });
    return who.data;
  }
  // The crew columns hold Assignr's spelling; my name keys are lower-cased
  // and space-collapsed, and ilike is case-insensitive, so this asks the
  // server for my rows only instead of every game in the state that day.
  function mineOr() {
    var ks = (S.me.nameKeys || []).map(function (k) { return k.replace(/[,()]/g, ' ').trim(); }).filter(Boolean);
    if (!ks.length) ks = [((S.me.first_name || '') + ' ' + (S.me.last_name || '')).trim()];
    var parts = [];
    ks.forEach(function (k) { ['cr', 'ar1', 'ar2', 'fourth'].forEach(function (c) { parts.push(c + '.ilike.' + k); }); });
    return parts.join(',');
  }
  async function loadDay_() {
    var today = todayStr(), keys = S.me.nameKeys || [];
    var wide = iCan('command_center') || iCan('scheduling');
    var r = await Promise.all([
      fetchAll(function () { return sb.from('games').select('game_id,date,game_num,kickoff,field,age_group,gender,competition,home,away,cr,ar1,ar2,fourth,venue,status,home_club,away_club,score_url')
        .eq('date', today).not('status', 'in', '(C,X,canceled_no_pay)').or(mineOr()).order('kickoff'); }),
      sb.from('events').select('id,name,game_prefix,venues,blurb,tools,rules_url'),
      sb.from('checkins').select('game_id,created_at,ref_name').eq('date', today),
      sb.from('observations').select('id,date,observer,rater_role,final_note,cleaned_note,game_id,field').order('date', { ascending: false }).limit(50),
      sb.from('announcements').select('title,body,severity,created_at,venue,event_id,start_date,end_date').lte('start_date', today).gte('end_date', today).order('created_at', { ascending: false }).limit(5),
      sb.from('scores').select('game_id,home_score,away_score,status,entered_by,created_at').eq('date', today),
      loadEvalRequests(),
      wide ? sb.from('staff_messages').select('id,from_name,to_venue,body,created_at').eq('date', today).order('created_at', { ascending: false }).limit(20) : Promise.resolve({ data: [] }),
      sb.rpc('coached_venues', { p_date: today }),
      sb.from('late_notices').select('id,game_id,ref_name,venue,field,eta_min,created_at,ack_by,ack_at').eq('date', today),
      loadSessions_(),
      sb.rpc('co90_card'),
      sb.rpc('asg_my'),
      sb.rpc('premium_mine')
    ]);
    S.co90 = r[11] && r[11].data || null;
    S.asg = r[12] && r[12].data || null;
    S.prem = r[13] && r[13].data || null;
    S.games = (r[0].data || []).filter(function (x) { return ['cr', 'ar1', 'ar2', 'fourth'].some(function (k) { return keys.indexOf(key(x[k])) >= 0; }); });
    S.events = r[1].data || [];
    S.checkins = {};
    (r[2].data || []).forEach(function (c) { if (c.game_id && keys.indexOf(key(c.ref_name)) >= 0) S.checkins[String(c.game_id)] = c.created_at; });
    S.notes = r[3].data || [];
    S.bulletins = r[4].data || [];
    S.scores = {}; (r[5].data || []).forEach(function (x) { S.scores[String(x.game_id)] = x; });
    S.staffMsgs = r[7].data || [];
    S.coachedVenues = (r[8].data || []).map(function (x) { return typeof x === 'string' ? x : x.coached_venues; });
    S.late = (r[9].data || []).filter(function (l) { return keys.indexOf(key(l.ref_name)) >= 0; });
    // For whoever answers Help: late notices nobody has acknowledged yet, so Your day says so.
    S.lateOpen = iCan('command_center') ? (r[9].data || []).filter(function (l) { return !l.ack_at; }) : [];
    // For the Director of Referee Development: requests nobody has assigned a coach to yet.
    S.evalWaiting = iCan('review') ? (ER.mine || []).filter(function (q) { return q.status === 'requested'; }) : [];
  }
  function myLate(g) { return (S.late || []).filter(function (l) { return String(l.game_id) === String(g.game_id) || (l.venue === g.venue && !l.game_id); })[0]; }

  // A folded section: one row with a count, tap to open. Native <details>,
  // so it works the same on iOS and Android with no script, and the open
  // state is remembered per screen for the session.
  var FOLD = {};
  function fold(k, title, count, inner, openDefault) {
    var open = FOLD[k] != null ? FOLD[k] : !!openDefault;
    return '<details class="fold" data-fold="' + esc(k) + '"' + (open ? ' open' : '') + '><summary><span class="t">' + esc(title) + '</span><span class="n">' + count + '</span></summary><div class="fold-body">' + inner + '</div></details>';
  }
  document.addEventListener('toggle', function (e) { var d = e.target; if (d && d.matches && d.matches('details.fold')) FOLD[d.getAttribute('data-fold')] = d.open; }, true);

  // ── Talk instead of type. The browser's own speech recognition (Chrome on
  // Android, Safari on iPhone), continuous, in the Hub's language, appended to
  // the box as it hears it. Noise on a field is the enemy: hold the phone close.
  var Mic = (function () {
    var R = window.SpeechRecognition || window.webkitSpeechRecognition, rec = null, live = false, base = '';
    function ok() { return !!R; }
    function stop() { if (rec) { try { rec.stop(); } catch (e) {} } }
    function toggle(ta, btn, hint) {
      if (live) { stop(); return; }
      rec = new R(); rec.lang = S.lang === 'es' ? 'es-US' : 'en-US'; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
      base = ta.value ? ta.value.replace(/\s+$/, '') + ' ' : '';
      var finalText = '';
      rec.onstart = function () { live = true; btn.textContent = t('micStop'); btn.setAttribute('aria-pressed', 'true'); btn.style.background = 'var(--red)'; btn.style.color = '#fff'; hint.textContent = t('micListening'); };
      rec.onresult = function (e) {
        var interim = '';
        for (var i = e.resultIndex; i < e.results.length; i++) { var tr = e.results[i][0].transcript; if (e.results[i].isFinal) finalText += tr + ' '; else interim += tr; }
        ta.value = base + finalText + interim; ta.scrollTop = ta.scrollHeight;
      };
      rec.onerror = function (e) { hint.textContent = e.error === 'not-allowed' ? t('micDenied') : e.error === 'no-speech' ? t('micNoSpeech') : t('micError'); };
      rec.onend = function () { live = false; btn.textContent = t('micTalk'); btn.setAttribute('aria-pressed', 'false'); btn.style.background = ''; btn.style.color = ''; if (hint.textContent === t('micListening')) hint.textContent = t('micHint'); ta.value = (base + finalText).replace(/\s+$/, ''); };
      try { rec.start(); } catch (e) { hint.textContent = t('micError'); }
    }
    window.addEventListener('hashchange', stop);
    return { ok: ok, toggle: toggle, stop: stop };
  })();

  // ── An evaluation: the session summary, the debrief list, and the report ──
  // The coach writes the formal evaluation from the PDF and their notes and
  // saves it here. The Writer (a draft from the log) is reviewer-only for now:
  // a coach first shows they can write a formal evaluation themselves.
  var EV = { row: null, busy: false };
  async function renderEval(id) {
    var body = $('evalBody'); body.innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>';
    var r = await sb.from('evaluations').select('id,coach_person_id,coach_name,ref_name,ref_person_id,game_id,game_date,venue,competition,purpose,license,status,session,final_scores,report,report_at,report_status,review_note,reviewed_at,score,level').eq('id', id).limit(1);
    var e = (r.data || [])[0]; EV.row = e;
    if (!e) { body.innerHTML = '<div class="card"><div class="hint">' + esc(t('nothingHere')) + '</div></div>'; return; }
    var S_ = e.session || {}, md = S_.MD || {}, ratings = S_.ratings || e.final_scores || {}, sessions = S_.sessions || [];
    var areas = { MC: t('evMC'), IP: t('evIP'), GM: t('evGM'), TW: t('evTW'), POS: t('evPOS'), MOV: t('evMOV'), OS: t('evOS'), IA: t('evIA') };
    var rated = Object.keys(ratings).map(function (k) { var p = k.replace(/^sg-/, '').split('-'); return '<div class="rowline"><div>' + esc((p[0] || '').toUpperCase() === 'REF' ? t('role.cr') : (p[0] || '').toUpperCase()) + ', ' + esc(areas[p[1]] || p[1]) + '</div><b>' + esc(ratings[k]) + '</b></div>'; }).join('');
    var nEv = sessions.reduce(function (a, ss) { return a + (ss.events || []).length; }, 0);
    var inc = S_.incidents || {}, nInc = 0; Object.keys(inc).forEach(function (w) { ['cmi', 'cre'].forEach(function (k) { nInc += ((inc[w] || {})[k] || []).length; }); });
    var mine = e.coach_person_id === S.me.person_id;
    var offs = { ref: t('role.cr'), ar1: 'AR1', ar2: 'AR2', fourth: '4th' }, deb = '';
    var debItems = []; Object.keys(inc).forEach(function (w) { ['cmi', 'cre'].forEach(function (k) { ((inc[w] || {})[k] || []).forEach(function (x) { debItems.push({ w: w, k: k, x: x }); }); }); });
    debItems.sort(function (a, b) { return (b.x.discuss ? 1 : 0) - (a.x.discuss ? 1 : 0); });
    var nDisc = debItems.filter(function (d) { return d.x.discuss; }).length;
    debItems.forEach(function (d) { var x = d.x; deb += '<div class="rowline"' + (x.discuss ? ' style="background:var(--surface-2,rgba(127,127,127,.08));border-radius:8px"' : '') + '><div>' + (x.discuss ? '<span class="pill ok">' + esc(t('evalDiscussed')) + '</span> ' : '') + esc((x.time ? x.time + ' ' : '') + (offs[d.w] || d.w) + ', ' + d.k.toUpperCase() + (x.type ? ', ' + x.type : '')) + (x.brief ? '<div class="hint">' + esc(x.brief) + '</div>' : '') + '</div><b>' + esc(x.involvement || '') + (x.difficulty ? ' / ' + x.difficulty : '') + '</b></div>'; });
    var rs = e.report_status || 'draft', isRev = iCan('review');
    var canEdit = isRev || (mine && (rs === 'draft' || rs === 'returned'));
    var canSubmit = mine && e.status === 'complete' && (rs === 'draft' || rs === 'returned');
    var canDraft = isRev && e.status === 'complete';
    var rsPill = e.report ? ' <span class="pill' + (rs === 'approved' ? ' ok' : rs === 'returned' ? ' bad' : '') + '">' + esc(t('evalRs.' + rs)) + '</span>' : '';
    body.innerHTML = '<div class="pad" style="padding-top:12px"><div class="lead">' + esc(t('evalTitle')) + '</div><div class="disp" style="font-size:34px">' + esc(e.ref_name || '') + '</div><div class="hint">' + esc(e.game_date ? dayLong(e.game_date) : '') + (e.venue ? ', ' + esc(e.venue) : '') + (e.competition ? ', ' + esc(e.competition) : '') + '</div><div class="hint">' + esc(t('evalCoach')) + ' ' + esc(e.coach_name || '') + '. ' + esc(e.purpose || '') + (e.license ? ', ' + esc(e.license) : '') + ' <span class="pill' + (e.status === 'complete' ? ' ok' : '') + '">' + esc(e.status === 'complete' ? t('evalComplete') : t('evalInProgress')) + '</span></div></div>' +
      '<div class="stats">' + '<div class="stat"><b>' + nEv + '</b><i>' + esc(t('evalEvents')) + '</i></div><div class="stat"><b>' + nInc + '</b><i>' + esc(t('evalIncidents')) + '</i></div><div class="stat"><b>' + Object.keys(ratings).length + '</b><i>' + esc(t('evalRatings')) + '</i></div></div>' +
      (deb ? fold('evdebrief', t('evalDebrief'), nDisc || nInc, '<div class="pad hint" style="padding-top:0">' + esc(t('evalDebriefHint')) + '</div><div class="pad">' + deb + '</div>', false) : '') +
      (rated ? fold('evratings', t('evalRatingsTitle'), Object.keys(ratings).length, '<div class="pad">' + rated + '</div>', false) : '') +
      (e.game_id ? '<div class="pad" style="padding-top:8px"><a class="btn outline small" href="evaluator.html?game=' + esc(e.game_id) + '">' + esc(t('evalOpenEvaluator')) + '</a></div>' : '') +
      '<div class="disp h2">' + esc(t('evalReport')) + rsPill + '</div><div class="pad hint" style="padding-top:0">' + esc(rs === 'approved' ? t('evalApprovedHint') : rs === 'submitted' && !isRev ? t('evalLocked') : t('evalReportHint')) + '</div>' +
      (rs === 'returned' && e.review_note ? '<div class="pad"><div class="card" style="border-color:var(--bad,#c0392b)"><b>' + esc(t('evalReviewNote')) + '</b><div style="white-space:pre-wrap">' + esc(e.review_note) + '</div></div></div>' : '') +
      '<div class="pad no-print" style="padding-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">' + (e.status !== 'complete' ? '<span class="hint">' + esc(t('evalFinishFirst')) + '</span>' : '') + (canDraft ? '<button class="btn outline small" id="evDraft">' + esc(e.report ? t('evalRedraft') : t('evalDraft')) + '</button><span class="hint">' + esc(t('evalReviewerDraft')) + '</span>' : '') + (e.report ? '<button class="btn outline small" id="evCopy">' + esc(t('evalCopy')) + '</button><button class="btn outline small" id="evPrint">' + esc(t('print')) + '</button>' : '') + '</div>' +
      '<div class="pad" style="padding-top:8px"><textarea id="evText" style="min-height:360px;font:inherit;width:100%;padding:12px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)" placeholder="' + esc(t('evalEmpty')) + '"' + (canEdit ? '' : ' readonly') + '>' + esc(e.report || '') + '</textarea></div>' +
      (canEdit ? '<div class="pad no-print" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding-top:0"><div><label class="hint" for="evScore">' + esc(t('evalScore')) + '</label><input id="evScore" type="number" step="0.1" min="1" max="10" inputmode="decimal" value="' + esc(e.score == null ? '' : e.score) + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"></div><div><label class="hint" for="evLevel">' + esc(t('evalLevel')) + '</label><select id="evLevel" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">' + ['adult', 'youth', 'other'].map(function (l) { return '<option value="' + l + '"' + ((e.level || 'other') === l ? ' selected' : '') + '>' + esc(t('upLevel.' + l)) + '</option>'; }).join('') + '</select></div></div>' : (e.score != null ? '<div class="pad hint">' + esc(t('evalScore')) + ': ' + esc(e.score) + ', ' + esc(t('upLevel.' + (e.level || 'other'))) + '</div>' : '')) +
      '<div class="pad no-print" style="display:flex;flex-wrap:wrap;gap:8px;padding-top:0">' + (canEdit ? '<button class="btn primary small" id="evSave">' + esc(t('save')) + '</button>' : '') +
      (canSubmit ? '<button class="btn outline small" id="evSubmit">' + esc(t('evalSubmit')) + '</button>' : '') +
      (isRev && rs === 'submitted' ? '<button class="btn primary small" id="evApprove">' + esc(t('evalApprove')) + '</button><button class="btn outline small" id="evReturn">' + esc(t('evalReturn')) + '</button>' : '') +
      (isRev && rs === 'approved' ? '<button class="btn outline small" id="evRecall">' + esc(t('evalRecall')) + '</button>' : '') +
      '</div><div class="msg" id="evMsg" hidden></div>' +
      (e.report_at ? '<div class="pad hint">' + esc(t('evalDraftedAt')) + ' ' + esc(dayLong(e.report_at.slice(0, 10))) + '</div>' : '');
    var dr = $('evDraft'); if (dr) dr.onclick = async function () {
      if (e.report && !window.confirm(t('evalRedraftConfirm'))) return;
      dr.disabled = true; dr.textContent = t('evalDrafting'); busy(true);
      try { var j = await post({ action: 'evalWrite', evalId: e.id }); e.report = j.report; e.report_at = j.reportAt; busy(false); renderEval(id); }
      catch (err) { busy(false); dr.disabled = false; dr.textContent = t('evalDraft'); say('evMsg', err.message || String(err), 'bad'); }
    };
    async function evUpdate(patch, okMsg) { var u = await sb.from('evaluations').update(patch).eq('id', e.id); if (u.error) { say('evMsg', u.error.message, 'bad'); return false; } Object.keys(patch).forEach(function (k) { e[k] = patch[k]; }); if (okMsg) say('evMsg', okMsg, 'good'); return true; }
    function evExtra() { var sc = $('evScore'), lv = $('evLevel'); var o = {}; if (sc) o.score = sc.value === '' ? null : Number(sc.value); if (lv) o.level = lv.value; return o; }
    var sv = $('evSave'); if (sv) sv.onclick = function () { var patch = evExtra(); patch.report = $('evText').value; patch.report_at = new Date().toISOString(); evUpdate(patch, t('evalSaved')); };
    var sub = $('evSubmit'); if (sub) sub.onclick = async function () { var txt = $('evText').value; if (!txt.trim()) { say('evMsg', t('evalEmpty'), 'bad'); return; } if (!window.confirm(t('evalSubmitConfirm'))) return; if (await evUpdate({ report: txt, report_at: new Date().toISOString(), report_status: 'submitted', review_note: null })) renderEval(id); };
    var ap = $('evApprove'); if (ap) ap.onclick = async function () { if (await evUpdate({ report: $('evText').value, report_status: 'approved', reviewed_by: S.me.person_id, reviewed_at: new Date().toISOString(), review_note: null })) renderEval(id); };
    var rt = $('evReturn'); if (rt) rt.onclick = async function () { var note = window.prompt(t('evalReturnPrompt'), ''); if (note === null) return; if (await evUpdate({ report_status: 'returned', reviewed_by: S.me.person_id, reviewed_at: new Date().toISOString(), review_note: note.trim() || null })) renderEval(id); };
    var rc = $('evRecall'); if (rc) rc.onclick = async function () { var note = window.prompt(t('evalRecallPrompt'), ''); if (note === null) return; if (!note.trim()) { say('evMsg', t('evalRecallNeedsReason'), 'bad'); return; } if (await evUpdate({ report_status: 'returned', reviewed_by: S.me.person_id, reviewed_at: new Date().toISOString(), review_note: note })) renderEval(id); };
    var cp = $('evCopy'); if (cp) cp.onclick = async function () { try { await navigator.clipboard.writeText($('evText').value); say('evMsg', t('evalCopied'), 'good'); } catch (err) { $('evText').select(); } };
    var pr = $('evPrint'); if (pr) pr.onclick = function () { window.print(); };
  }
  // Progress toward an upgrade or maintenance: one line, with the count that matters.
  function progressHtml(p, pid) {
    if (!p) return '';
    var up = Number(p.upgrade_done || 0), mt = Number(p.maintenance_done || 0);
    if (!up && !mt && !(p.items || []).length) return '';
    var line = up ? t('evalProgressUp').replace('{n}', up).replace('{need}', p.upgrade_need).replace('{y}', p.year) : t('evalProgressMaint').replace('{n}', mt).replace('{need}', p.maintenance_need).replace('{y}', p.year);
    var done = up ? up >= Number(p.upgrade_need) : mt >= Number(p.maintenance_need);
    return '<a class="card" href="#upgrade' + (pid ? '/' + pid : '') + '" style="gap:6px;text-decoration:none;color:inherit;border-color:' + (done ? 'var(--green)' : 'var(--gold)') + '"><b>' + esc(line) + '</b><div class="bar"><i style="width:' + Math.min(100, Math.round(100 * (up || mt) / (up ? Number(p.upgrade_need) : Number(p.maintenance_need)))) + '%"></i></div>' + (p.items || []).map(function (it) { return '<div class="hint">' + esc(dayLong(it.date)) + ', ' + esc(it.coach || '') + (it.competition ? ', ' + esc(it.competition) : '') + '</div>'; }).join('') + '<div class="hint" style="font-weight:700">' + esc(t('upOpen')) + ' &rsaquo;</div></a>';
  }

  // ── The upgrade tracker: every Regional requirement, with the game log the sync cannot see ──
  var UP = { pid: null, data: null, add: false, role: '' };
  function renderUpgradeFromData(pid) { renderUpgrade(pid); }
  async function renderUpgrade(pid) {
    UP.pid = pid || null;
    var body = $('upgradeBody'); body.innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>';
    $('upBack').href = pid ? (REF.from || '#center') : '#day';
    busy(true); var r = await sb.rpc('upgrade_tracker', { p_person: pid, p_season: null }); busy(false);
    var d = r.data; UP.data = d;
    if (!d) { body.innerHTML = '<div class="card"><div class="hint">' + esc(t('nothingHere')) + '</div></div>'; return; }
    var mine = !pid || pid === S.me.person_id, canEdit = mine || iCan('review');
    var ok = function (b) { return '<span class="pill' + (b ? ' ok' : '') + '" style="white-space:nowrap;flex-shrink:0">' + esc(b ? t('upDone') : t('upNot')) + '</span>'; };
    var row = function (label, state, detail) { return '<div class="rowline"><div><b>' + esc(label) + '</b>' + (detail ? '<div class="hint">' + detail + '</div>' : '') + '</div>' + ok(state) + '</div>'; };
    var centers = Number(d.centers_synced) + Number(d.centers_logged), ars = Number(d.ars_synced) + Number(d.ars_logged);
    var evs = d.evals || [], upEvs = evs.filter(function (e) { return (e.purpose || '').indexOf('upgrade') === 0; });
    var coachesOk = Number(d.eval_coaches) >= 3, avgOk = d.eval_avg != null && Number(d.eval_avg) >= 8, mixOk = Number(d.eval_adult) >= 2 && Number(d.eval_youth) >= 1;
    var nextOk = d.last_fail ? shiftDate(d.last_fail, 30) : null, waitOn = nextOk && nextOk > todayStr();
    var evalDetail = esc(t('upEvalDetail').replace('{c}', d.eval_coaches).replace('{a}', d.eval_adult).replace('{y}', d.eval_youth).replace('{avg}', d.eval_avg == null ? '–' : d.eval_avg)) + (waitOn ? '<br><span style="color:var(--red);font-weight:700">' + esc(t('upWait').replace('{d}', dayLong(nextOk))) + '</span>' : '');
    var evList = evs.length ? '<div class="list">' + evs.map(function (e) { return '<a class="item" href="' + (iCan('evaluations') || iCan('review') ? '#eval/' + e.id : '#upgrade') + '"><div><b>' + esc(dayLong(e.date)) + '</b> ' + (e.score != null ? '<span class="pill' + (Number(e.score) >= 8 ? ' ok' : ' bad') + '">' + esc(e.score) + '</span>' : '<span class="pill">' + esc(t('upNoScore')) + '</span>') + '<br><span class="hint">' + esc(e.coach || '') + ', ' + esc(t('upLevel.' + (e.level || 'other'))) + (e.competition ? ', ' + esc(e.competition) : '') + ', ' + esc(t('evalPurpose.' + e.purpose) || e.purpose) + '</span></div></a>'; }).join('') + '</div>' : '<div class="pad hint">' + esc(t('upNoEvals')) + '</div>';
    var logAll = d.log || [];
    var logShown = UP.role ? logAll.filter(function (g) { return g.role === UP.role; }) : logAll;
    var roleChips = '<div class="chips" style="padding:4px 0">' + [['', t('upRoleAll')], ['cr', t('upRoleCr')], ['ar', t('upRoleAr')]].map(function (x) { return '<button class="chip-btn small' + (UP.role === x[0] ? ' on' : '') + '" data-uprole="' + x[0] + '">' + esc(x[1]) + '</button>'; }).join('') + '</div>' + (UP.role ? '<div class="hint">' + esc(t('upFiltered').replace('{n}', logShown.length).replace('{all}', logAll.length)) + '</div>' : '');
    var logRows = logShown.map(function (g) { return '<div class="rowline"><div><b>' + esc(dayLong(g.date)) + '</b>, ' + esc(g.role === 'ar' ? t('upRoleAr') : t('upRoleCr')) + ', ' + esc(t('upLevel.' + g.level)) + (g.verified ? ' <span class="pill ok">' + esc(t('upVerified')) + '</span>' : '') + '<div class="hint">' + esc([g.league, g.home && g.away ? g.home + ' v ' + g.away : '', g.venue, g.crew].filter(Boolean).join('. ')) + '</div></div>' + (iCan('review') && !g.verified ? '<button class="linkbtn" data-up-verify="' + g.id + '">' + esc(t('upVerify')) + '</button>' : '') + (canEdit && !g.verified ? '<button class="linkbtn" style="color:var(--red)" data-up-del="' + g.id + '">' + esc(t('remove')) + '</button>' : '') + '</div>'; }).join('');
    var LEAGUES = ['Colorado Premier League', 'Mountain Premier League', 'Boulder Soccer League', 'Arsenal Colorado adult', 'Colorado Adult Soccer League', 'USL-2', 'USL W', 'WPSL', 'League of Clubs', 'USCCS'];
    var inp = 'style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"';
    var addForm = !canEdit ? '' : (UP.add ? '<div class="card" style="gap:8px">' +
        '<label class="hint" for="upDate">' + esc(t('upDate')) + '</label><input id="upDate" type="date" ' + inp + ' value="' + todayStr() + '">' +
        '<label class="hint" for="upLeague">' + esc(t('upLeague')) + '</label><input id="upLeague" list="upLeagues" autocomplete="off" ' + inp + '><datalist id="upLeagues">' + LEAGUES.map(function (l) { return '<option value="' + esc(l) + '">'; }).join('') + '</datalist>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div><label class="hint" for="upRole">' + esc(t('upRole')) + '</label><select id="upRole" ' + inp + '><option value="cr">' + esc(t('upRoleCr')) + '</option><option value="ar">' + esc(t('upRoleAr')) + '</option></select></div>' +
        '<div><label class="hint" for="upLevelSel">' + esc(t('upLevelLabel')) + '</label><select id="upLevelSel" ' + inp + '><option value="adult">' + esc(t('upLevel.adult')) + '</option><option value="youth">' + esc(t('upLevel.youth')) + '</option><option value="other">' + esc(t('upLevel.other')) + '</option></select></div></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><input id="upHome" placeholder="' + esc(t('upHome')) + '" ' + inp + '><input id="upAway" placeholder="' + esc(t('upAway')) + '" ' + inp + '></div>' +
        '<input id="upVenue" placeholder="' + esc(t('upVenue')) + '" ' + inp + '><input id="upCrew" placeholder="' + esc(t('upCrew')) + '" ' + inp + '>' +
        '<div class="actions" style="padding:0"><button class="btn primary" id="upSave">' + esc(t('upAddSave')) + '</button><button class="btn outline" id="upCancel">' + esc(t('neverMind')) + '</button></div><div class="msg bad" id="upMsg" hidden></div></div>'
      : '<div class="pad"><button class="btn outline" id="upAddBtn" style="width:100%">' + esc(t('upAdd')) + '</button></div>');
    body.innerHTML =
      '<div class="pad" style="padding-top:16px"><div class="lead">' + esc(t('upTrackerTitle')) + '</div><div class="disp" style="font-size:36px">' + esc(d.name || '') + '</div><div class="hint">' + esc(t('upSeason').replace('{y}', d.season)) + '</div></div>' +
      '<div class="pad hint" style="padding-top:8px">' + esc(t('upLead')) + '</div>' +
      '<div class="disp h2">' + esc(t('upChecklist')) + '</div><div class="pad">' +
        row(t('upAge'), d.age_ok) +
        row(t('upLicensed'), Number(d.licensed_prior_years) >= 2, esc(t('upLicensedDetail').replace('{n}', d.licensed_prior_years))) +
        row(t('upClearances'), d.clearances_ok, esc(t('upClearancesDetail'))) +
        row(t('upCenters'), centers >= Number(d.centers_need), esc(t('upGamesDetail').replace('{n}', centers).replace('{need}', d.centers_need).replace('{s}', d.centers_synced).replace('{l}', d.centers_logged))) +
        row(t('upArs'), ars >= Number(d.ars_need), esc(t('upGamesDetail').replace('{n}', ars).replace('{need}', d.ars_need).replace('{s}', d.ars_synced).replace('{l}', d.ars_logged))) +
        row(t('upFitness'), !!d.fitness, d.fitness ? esc(dayLong(d.fitness.date) + (d.fitness.standard ? ', ' + d.fitness.standard : '')) : esc(t('upFitnessDetail'))) +
        row(t('upEvals'), coachesOk && avgOk && mixOk && !waitOn, evalDetail) +
      '</div>' +
      (Number(d.maint_coaches) ? '<div class="pad hint">' + esc(t('upMaint').replace('{c}', d.maint_coaches).replace('{avg}', d.maint_avg == null ? '–' : d.maint_avg)) + '</div>' : '') +
      '<div class="disp h2">' + esc(t('upEvalsTitle')) + '</div>' + evList +
      '<div class="disp h2">' + esc(t('upLogTitle')) + '</div><div class="pad hint" style="padding-top:0">' + esc(t('upLogHint')) + '</div>' + addForm + (logAll.length ? '<div class="pad">' + roleChips + logRows + '</div>' : '');
    body.querySelectorAll('[data-uprole]').forEach(function (c) { c.onclick = function () { UP.role = c.getAttribute('data-uprole'); renderUpgradeFromData(pid); }; });
    var ab = $('upAddBtn'); if (ab) ab.onclick = function () { UP.add = true; renderUpgrade(pid); };
    var cb = $('upCancel'); if (cb) cb.onclick = function () { UP.add = false; renderUpgrade(pid); };
    var sv = $('upSave'); if (sv) sv.onclick = async function () {
      var rowIn = { org_id: S.me.org_id, person_id: pid || S.me.person_id, date: $('upDate').value, league: $('upLeague').value.trim() || null, role: $('upRole').value, level: $('upLevelSel').value, home: $('upHome').value.trim() || null, away: $('upAway').value.trim() || null, venue: $('upVenue').value.trim() || null, crew: $('upCrew').value.trim() || null };
      if (!rowIn.date) { say('upMsg', t('upNeedDate'), 'bad'); return; }
      sv.disabled = true; var ins = await sb.from('upgrade_log').insert(rowIn); if (ins.error) { sv.disabled = false; say('upMsg', ins.error.message, 'bad'); return; }
      UP.add = false; renderUpgrade(pid);
    };
    body.querySelectorAll('[data-up-verify]').forEach(function (b) { b.onclick = async function () { b.disabled = true; await sb.from('upgrade_log').update({ verified_by: S.me.first_name + ' ' + S.me.last_name, verified_at: new Date().toISOString() }).eq('id', parseInt(b.getAttribute('data-up-verify'), 10)); renderUpgrade(pid); }; });
    body.querySelectorAll('[data-up-del]').forEach(function (b) { b.onclick = async function () { if (!window.confirm(t('upRemoveConfirm'))) return; await sb.from('upgrade_log').delete().eq('id', b.getAttribute('data-up-del')); renderUpgrade(pid); }; });
  }
  // ── Venues: one table for coordinates (State map) and layouts (venue maps) ──
  var VEN = { rows: null };
  async function loadVenues_() {
    if (VEN.rows) return VEN.rows;
    var r = await sb.from('venues').select('id,name,slug,lat,lon,address,layout').order('name');
    VEN.rows = r.data || [];
    return VEN.rows;
  }
  // ── Venue map: the field layout with today's games on it ──────────
  // Staff see every field's state (the same rules as Needs attention); a
  // referee sees their own field lit and their kickoff. Layouts live in
  // fieldmaps.json; a venue without one gets a plain link to directions.
  var MAPS = { all: null, fm: null, venue: '', field: '', q: '', slug: '' };
  function mapLayoutFor(venue) {
    if (!MAPS.all) return null;
    var slug = FieldMap.slug(venue); if (MAPS.all[slug]) return { slug: slug, layout: MAPS.all[slug] };
    var hit = Object.keys(MAPS.all).filter(function (k) { return slug.indexOf(k) >= 0 || k.indexOf(slug) >= 0 || FieldMap.slug(MAPS.all[k].name) === slug; })[0];
    return hit ? { slug: hit, layout: MAPS.all[hit] } : null;
  }
  function mapGames(venue) {
    var staff = iCan('command_center') || iCan('scheduling');
    var list = staff && OPS.games ? OPS.games : S.games || [];
    return list.filter(function (g) { return key(g.venue) === key(venue) && !isHQ(g) && !isCoachSlot(g); });
  }
  // One state per field from its next game, in the order the board would rank them.
  function mapStatus(fm, games) {
    var staff = (iCan('command_center') || iCan('scheduling')) && OPS.games, ins = staff ? inSet() : {}, now = Date.now(), by = {};
    games.forEach(function (g) { var id = fm.match(g.field); if (!id) return; (by[id] = by[id] || []).push(g); });
    var out = {};
    Object.keys(by).forEach(function (id) {
      var gs = by[id].sort(function (a, b) { return new Date(a.kickoff) - new Date(b.kickoff); });
      var next = gs.filter(function (g) { return gameState(g) !== 'done'; })[0];
      if (!next) { out[id] = { state: 'done' }; return; }
      var st = gameState(next), mins = Math.round((new Date(next.kickoff).getTime() - now) / 60000), state = st === 'live' ? 'live' : 'ok';
      var chip = st === 'live' ? t('mapLive') : (mins <= 90 ? t('mapIn').replace('{n}', mins) : clock(next.kickoff));
      if (staff) {
        var missing = 0, open = 0, late = 0;
        ['cr', 'ar1', 'ar2', 'fourth'].forEach(function (x) { var n = next[x]; if (!n) return; if (/^(tbd|open|none)$/i.test(n)) open++; else if (!ins[key(n)]) { if (lateFor(n, next)) late++; else missing++; } });
        if (open) state = 'open'; else if (late) state = 'late'; else if (missing && (st === 'live' || mins <= ATTN_ALERT)) state = 'alert'; else if (missing && mins <= ATTN_WARN) state = 'warn';
      }
      out[id] = { state: state, chip: chip };
    });
    return out;
  }
  async function renderMap(venue, field) {
    MAPS.venue = venue; MAPS.field = field || '';
    var body = $('mapBody'), sheet = $('mapSheet');
    $('mapTitle').textContent = venue || t('map');
    if (!MAPS.all) { MAPS.all = {}; try { (await loadVenues_()).forEach(function (v) { if (v.layout) MAPS.all[v.slug] = v.layout; }); } catch (e) {} if (!Object.keys(MAPS.all).length) { try { MAPS.all = await fetch('fieldmaps.json?v=' + VERSION).then(function (r) { return r.json(); }); } catch (e) { MAPS.all = {}; } } }
    if ((iCan('command_center') || iCan('scheduling')) && !OPS.games) { busy(true); try { await loadOps_(); } catch (e) {} busy(false); }
    var hit = mapLayoutFor(venue);
    var dirs = '<a class="btn outline small" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(venue) + '">' + esc(t('directions')) + '</a>';
    if (!hit) { body.innerHTML = '<div class="card"><div class="hint">' + esc(t('mapNone')) + '</div><div class="actions" style="padding:8px 0 0">' + dirs + '</div></div>'; sheet.innerHTML = ''; return; }
    MAPS.slug = hit.slug;
    body.innerHTML = '<div class="fm-tools"><div class="go" style="flex:1;min-width:200px"><input id="mapQ" type="search" autocomplete="off" placeholder="' + esc(t('mapFind')) + '" value="' + esc(MAPS.q) + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"><button class="btn outline small" id="mapGo">' + esc(t('go')) + '</button></div><button class="chip-btn" id="mapZin" aria-label="+">+</button><button class="chip-btn" id="mapZout" aria-label="-">&minus;</button>' + dirs + '</div>' +
      '<div id="mapCanvas"></div>' +
      '<div class="fm-tools"><div class="legend"><span><i style="border-color:var(--gold)"></i>' + esc(t('mapLegWarn')) + '</span><span><i style="border-color:var(--red)"></i>' + esc(t('mapLegAlert')) + '</span><span><i style="border-color:var(--red);border-style:dashed"></i>' + esc(t('mapLegOpen')) + '</span><span><i style="border-color:#fff;background:#2E7A40"></i>' + esc(t('mapLegLive')) + '</span><span><i style="border-color:#9DB89F;background:#9DB89F"></i>' + esc(t('mapLegDone')) + '</span></div></div>';
    var games = mapGames(venue);
    var fm = FieldMap.render($('mapCanvas'), hit.layout, { onSelect: function (id) { MAPS.field = id; mapSheet(fm, id, games); }, onHQ: function (h) { sheet.innerHTML = '<div class="card"><b>' + esc(h.label.replace(/\bREF HQ\b/i, 'Referee HQ').replace(/\bREFEREE HQ\b/, 'Referee HQ')) + '</b><div class="hint">' + esc(t('mapHqHint')) + '</div></div>'; } });
    MAPS.fm = fm;
    fm.setStatus(mapStatus(fm, games));
    var sel = MAPS.field ? fm.match(MAPS.field) : null;
    if (sel) { fm.select(sel); mapSheet(fm, sel, games); } else sheet.innerHTML = '<div class="pad hint">' + esc(t('mapTap')) + '</div>';
    var find = function () { MAPS.q = $('mapQ').value.trim(); var q = MAPS.q.toLowerCase(); if (!q) { fm.highlight([]); return; } var ids = fm.ids.filter(function (id) { return id.toLowerCase() === q || id.toLowerCase() === FieldMap.fieldKey(q).toLowerCase(); }); if (!ids.length) ids = fm.ids.filter(function (id) { return games.some(function (g) { return fm.match(g.field) === id && [g.home, g.away, g.cr, g.ar1, g.ar2, g.fourth, g.age_group, g.game_num].some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; }); }); }); fm.highlight(ids); if (ids.length === 1) { fm.select(ids[0]); mapSheet(fm, ids[0], games); } };
    $('mapGo').onclick = find; $('mapQ').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); find(); } }; $('mapQ').oninput = function () { if (!$('mapQ').value) { MAPS.q = ''; fm.highlight([]); } };
    $('mapZin').onclick = function () { fm.zoom(1.3); }; $('mapZout').onclick = function () { fm.zoom(1 / 1.3); };
  }
  function mapSheet(fm, id, games) {
    var staff = (iCan('command_center') || iCan('scheduling')) && OPS.games, ins = staff ? inSet() : {};
    var gs = games.filter(function (g) { return fm.match(g.field) === id; }).sort(function (a, b) { return new Date(a.kickoff) - new Date(b.kickoff); });
    var sizeWord = { '11v11': '11v11', '9v9': '9v9', '7v7': '7v7', '4v4': '4v4', turf: t('mapTurf'), lax: 'Lacrosse' }[fm.size(id)] || '';
    var html = '<div class="pad" style="padding-top:12px"><div class="disp" style="font-size:30px">' + esc(t('mapField').replace('{f}', id)) + '</div><div class="hint">' + esc(sizeWord) + (gs.length ? ', ' + gs.length + ' ' + esc(t('stGames')) : ', ' + esc(t('mapNoGames'))) + '</div></div>';
    html += gs.map(function (g) {
      var st = gameState(g), crew = ['cr', 'ar1', 'ar2', 'fourth'].map(function (x) { var n = g[x]; if (!n) return ''; var open = /^(tbd|open|none)$/i.test(n); return '<div style="display:flex;justify-content:space-between;gap:8px"><span>' + esc(t('role.' + x)) + ': ' + (open ? '<span class="pill">' + esc(t('attnOpen')) + '</span>' : (staff && canSeeRef() ? '<a class="refname" href="#ref/' + encodeURIComponent(n) + '">' + esc(n) + '</a>' : esc(n))) + '</span>' + (staff && !open ? '<span class="pill' + (ins[key(n)] ? ' ok' : '') + '">' + esc(ins[key(n)] ? t('checkedIn') : (lateFor(n, g) ? t('late') : t('notIn'))) + '</span>' : '') + '</div>'; }).join('');
      return '<a class="item" href="#game/' + esc(g.game_id) + '" style="display:block"><div><b>' + esc(clock(g.kickoff)) + (g.game_num ? ' · ' + esc(g.game_num) : '') + '</b> <span class="pill' + (st === 'live' ? ' ok' : '') + '">' + esc(st === 'live' ? t('mapLive') : st === 'done' ? t('finished') : t('upcoming')) + '</span><br>' + esc(g.home || '') + ' v ' + esc(g.away || '') + '<br><span class="hint">' + esc(g.age_group || '') + (g.competition ? ', ' + esc(g.competition) : '') + '</span>' + (crew ? '<div style="margin-top:6px;font-size:14px">' + crew + '</div>' : '') + '</div></a>';
    }).join('');
    $('mapSheet').innerHTML = gs.length ? '<div class="list">' + html + '</div>' : html;
  }
  // ── Your year: the wrap-up and the games leaderboard ─────────────
  // Shown from WRAP_FROM (month, day) through January of the next year. Everyone sees the
  // leaderboard; a club name filters it to games that club played, for club bonuses.
  var WRAP_FROM = [11, 15], WRAP = { me: null, board: null, club: '', year: null, open: false };
  function wrapYear() { var d = new Date(), m = d.getMonth() + 1, day = d.getDate(); if (m === 1) return d.getFullYear() - 1; if (m > WRAP_FROM[0] || (m === WRAP_FROM[0] && day >= WRAP_FROM[1])) return d.getFullYear(); return null; }
  async function renderWrap() {
    var el = $('wrapLine'); if (!el) return;
    var y = wrapYear(); if (!y) { el.innerHTML = ''; return; }
    if (WRAP.year !== y || !WRAP.me) {
      WRAP.year = y;
      var r = await Promise.all([sb.rpc('my_season', { p_year: y }), sb.rpc('leaderboard', { p_year: y, p_club: WRAP.club || null, p_limit: 25 })]);
      WRAP.me = r[0].data || {}; WRAP.board = r[1].data || [];
    }
    var m = WRAP.me, stat = function (n, l) { return '<div class="stat"><b>' + esc(n == null ? '0' : String(n)) + '</b><i>' + esc(l) + '</i></div>'; };
    var mine = '<div class="stats">' + stat(m.games, t('wrapGames')) + stat(m.as_center, t('refCenter')) + stat(m.venues, t('wrapVenues')) + '</div>' +
      '<div class="stats">' + stat(m.notes, t('wrapNotes')) + stat(m.place ? '#' + m.place : '', t('wrapPlace')) + stat(m.busiest_month || '', t('wrapBusiest')) + '</div>' +
      (m.fitness_date ? '<div class="pad" style="padding-top:6px">' + fitBadgeHtml({ date: m.fitness_date, standard: m.fitness_standard }) + '</div>' : '') +
      (m.first_game ? '<div class="pad hint" style="padding-top:6px">' + esc(t('refFirst')) + ' ' + esc(dayLong(m.first_game)) + ', ' + esc(t('refLast')) + ' ' + esc(dayLong(m.last_game)) + '.</div>' : '<div class="pad hint">' + esc(t('wrapNoGames')) + '</div>');
    var board = '<div class="pad" style="padding-top:10px"><div class="go"><input id="wrapClub" type="search" value="' + esc(WRAP.club) + '" placeholder="' + esc(t('wrapClubPh')) + '" autocomplete="off" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"><button class="btn outline small" id="wrapGo">' + esc(t('go')) + '</button></div></div>' +
      (WRAP.board.length ? '<table class="dt" style="margin:8px 20px 0;width:calc(100% - 40px)"><thead><tr><th class="n">#</th><th>' + esc(t('fitName')) + '</th><th class="n">' + esc(t('wrapGames')) + '</th><th class="n">' + esc(t('refCenter')) + '</th></tr></thead><tbody>' + WRAP.board.map(function (r, i) { return '<tr' + (r.is_me ? ' class="mine"' : '') + '><td class="n">' + (i + 1) + '</td><td>' + esc(r.name) + '</td><td class="n">' + esc(String(r.games)) + '</td><td class="n">' + esc(String(r.as_center)) + '</td></tr>'; }).join('') + '</tbody></table>' : '<div class="pad hint">' + esc(t('wrapNobody')) + '</div>') +
      '<div class="pad hint" style="padding-top:8px">' + esc(t('wrapBoardHint')) + '</div>';
    el.innerHTML = fold('wrap', t('wrapTitle').replace('{y}', y), m.games || '', mine + '<div class="disp h2 print-keep" style="padding-top:10px">' + esc(t('wrapBoard').replace('{y}', y)) + '</div>' + board, true);
    var go = async function () { WRAP.club = $('wrapClub').value.trim(); WRAP.open = true; busy(true); var r = await sb.rpc('leaderboard', { p_year: y, p_club: WRAP.club || null, p_limit: 25 }); busy(false); WRAP.board = r.data || []; renderWrap(); };
    $('wrapGo').onclick = go; $('wrapClub').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } };
  }
  function ago(ts) { var m = Math.round((Date.now() - Date.parse(ts)) / 60000); if (m < 2) return t('agoNow'); if (m < 60) return t('agoMin').replace('{n}', m); var h = Math.round(m / 60); if (h < 36) return t('agoHour').replace('{n}', h); return t('agoDay').replace('{n}', Math.round(h / 24)); }
  // ── Setup: the Assignr sync, read-only. One row per group-week; red when a unit failed. ──
  function syncSetupHtml() {
    var rows = SU.sync || [], sites = {}; (SU.sites2 || []).forEach(function (x) { sites[String(x.site_id)] = x.name; });
    if (!rows.length) return '';
    var last = rows.slice().sort(function (a, b) { return String(b.synced_at || '') < String(a.synced_at || '') ? -1 : 1; })[0];
    var bad = rows.filter(function (r) { return r.error; }).length, stale = rows.filter(function (r) { return !r.synced_at || Date.now() - Date.parse(r.synced_at) > 14 * 3600000; }).length;
    var inner = '<div class="hint">' + esc(t('syncHint')) + '</div><table class="dt" style="margin-top:8px;width:100%"><thead><tr><th>' + esc(t('syncGroup')) + '</th><th>' + esc(t('syncWeek')) + '</th><th class="n">' + esc(t('stGames')) + '</th><th>' + esc(t('syncWhen')) + '</th></tr></thead><tbody>' +
      rows.map(function (r) { return '<tr' + (r.error ? ' class="failed"' : '') + '><td>' + esc(sites[String(r.site_id)] || r.site_id) + '</td><td>' + esc(String(r.from_date).slice(5)) + ' to ' + esc(String(r.to_date).slice(5)) + '</td><td class="n">' + esc(r.games == null ? '' : String(r.games)) + '</td><td>' + (r.error ? '<span style="color:var(--red)">' + esc(r.error.slice(0, 80)) + '</span>' : (r.synced_at ? esc(ago(r.synced_at)) : '')) + '</td></tr>'; }).join('') + '</tbody></table>';
    return fold('sync', t('syncTitle') + (last && last.synced_at ? ', ' + ago(last.synced_at) : ''), bad ? bad + ' ' + t('syncFailed') : (stale ? stale + ' ' + t('syncStale') : t('syncOk')), inner, !!bad);
  }
  // ── Setup: venues. Coordinates for the State map, a layout for the venue map. ──
  // The layout editor is a table of rectangles with a live drawing: enough to add a
  // venue from a sketch on the day, without a file or a deploy.
  var VE = { open: null, draft: null, sel: null, msg: '' };
  function venuesSetupHtml() {
    var rows = VEN.rows || [];
    return '<div class="disp h2">' + esc(t('venTitle')) + '</div><div class="pad hint" style="padding-top:0">' + esc(t('venLead')) + '</div><div class="pad" style="padding-top:12px"><button class="btn outline" id="venNew" style="width:100%">' + esc(t('venNew')) + '</button></div>' +
      (rows.length ? '<div class="pad" style="padding-top:8px"><select id="venPick" style="font:inherit;width:100%;padding:12px;border:2px solid var(--navy);border-radius:8px;background:var(--surface);color:var(--ink)"><option value="">' + esc(t('venOpen')) + '</option>' + rows.map(function (v) { return '<option value="' + v.id + '">' + esc(v.name) + ' (' + (v.layout ? (v.layout.fields || []).length + ' ' + esc(t('venFields')) : esc(t('venNoLayout'))) + (v.lat == null ? ', ' + esc(t('venNoCoords')) : '') + ')</option>'; }).join('') + '</select></div>' : '');
  }
  function wireVenuesSetup(root) {
    var nb = $('venNew'); if (nb) nb.onclick = function () { VE.open = 0; VE.draft = { name: '', slug: '', lat: '', lon: '', address: '', layout: null }; VE.sel = null; renderSetup(); };
    var vp = $('venPick'); if (vp) vp.onchange = function () { var v = VEN.rows.filter(function (x) { return String(x.id) === vp.value; })[0]; if (!v) return; VE.open = v.id; VE.draft = JSON.parse(JSON.stringify(v)); VE.draft.lat = v.lat == null ? '' : v.lat; VE.draft.lon = v.lon == null ? '' : v.lon; VE.sel = null; renderSetup(); };
    root.querySelectorAll('[data-ven]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); var v = VEN.rows.filter(function (x) { return String(x.id) === a.getAttribute('data-ven'); })[0]; if (!v) return; VE.open = v.id; VE.draft = JSON.parse(JSON.stringify(v)); VE.draft.lat = v.lat == null ? '' : v.lat; VE.draft.lon = v.lon == null ? '' : v.lon; VE.sel = null; renderSetup(); }; });
  }
  function blankLayout(name) { return { name: name, viewBox: [0, 0, 1200, 800], fields: [], hq: [], roads: [], water: [], labels: [], zones: [] }; }
  function venueEditorHtml() {
    var d = VE.draft, inp = function (id, v, type, extra) { return '<input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(v == null ? '' : v) + '" ' + (extra || '') + ' style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">'; };
    var L = d.layout, fields = L ? L.fields || [] : [];
    var sizes = ['11v11', '9v9', '7v7', '4v4', 'turf', 'lax'];
    var row = function (f, i) { var n = function (k, w) { return '<input type="number" step="1" data-fx="' + i + '" data-k="' + k + '" value="' + esc(f[k]) + '" class="fit-t" style="width:' + (w || 64) + 'px">'; };
      return '<tr' + (VE.sel === i ? ' class="mine"' : '') + '><td><input type="text" data-fx="' + i + '" data-k="id" value="' + esc(f.id) + '" class="fit-t" style="width:58px;text-align:left"></td><td class="n">' + n('x') + '</td><td class="n">' + n('y') + '</td><td class="n">' + n('w') + '</td><td class="n">' + n('h') + '</td><td><select data-fx="' + i + '" data-k="size" class="fit-t" style="width:84px;text-align:left">' + sizes.map(function (sz) { return '<option' + (f.size === sz ? ' selected' : '') + '>' + sz + '</option>'; }).join('') + '</select></td><td class="no-print"><div class="chips" style="flex-wrap:nowrap"><button class="chip-btn small" data-fdup="' + i + '">' + esc(t('venDup')) + '</button><button class="chip-btn small" data-fdel="' + i + '">' + esc(t('remove')) + '</button></div></td></tr>'; };
    return '<div class="pad no-print" style="padding-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn outline small" id="venBack">' + esc(t('back')) + '</button>' + (VE.open ? '<button class="btn outline small" id="venDelete" style="margin-left:auto">' + esc(t('venDelete')) + '</button>' : '') + '</div>' +
      '<div class="card" style="gap:8px"><b>' + esc(VE.open ? t('venEdit') : t('venNew')) + '</b>' +
      '<label class="hint" for="venName">' + esc(t('venName')) + '</label>' + inp('venName', d.name) +
      '<label class="hint" for="venAddr">' + esc(t('sesAddress')) + '</label><div class="go">' + inp('venAddr', d.address) + '<button class="btn outline small" id="venGeo">' + esc(t('venLookup')) + '</button></div>' +
      '<div class="grid2"><div><label class="hint" for="venLat">' + esc(t('venLat')) + '</label>' + inp('venLat', d.lat, 'number', 'step="0.0001"') + '</div><div><label class="hint" for="venLon">' + esc(t('venLon')) + '</label>' + inp('venLon', d.lon, 'number', 'step="0.0001"') + '</div></div><div class="hint">' + esc(t('venCoordsHint')) + '</div>' +
      '<div class="actions" style="padding:0"><button class="btn primary" id="venSave">' + esc(t('save')) + '</button></div><div class="msg" id="venMsg" ' + (VE.msg ? '' : 'hidden') + '>' + esc(VE.msg) + '</div></div>' +
      '<div class="disp h2">' + esc(t('venLayout')) + '</div><div class="pad hint" style="padding-top:0">' + esc(t('venLayoutHint')) + '</div>' +
      (!L ? '<div class="pad" style="padding-top:12px"><button class="btn outline" id="venStartLayout" style="width:100%">' + esc(t('venStartLayout')) + '</button></div>' :
        '<div class="pad" style="padding-top:8px" id="venPreview"></div>' +
        '<div class="pad" style="padding-top:6px;overflow-x:auto"><table class="dt fit"><thead><tr><th>' + esc(t('venField')) + '</th><th class="n">x</th><th class="n">y</th><th class="n">' + esc(t('venW')) + '</th><th class="n">' + esc(t('venH')) + '</th><th>' + esc(t('fitStandard')) + '</th><th></th></tr></thead><tbody>' + fields.map(row).join('') + '</tbody></table></div>' +
        '<div class="actions no-print"><button class="btn outline small" id="venAddField">' + esc(t('venAddField')) + '</button><button class="btn outline small" id="venAddHq">' + esc(t('venAddHq')) + '</button><button class="btn outline small" id="venAddRoad">' + esc(t('venAddRoad')) + '</button></div>' +
        ((L.hq || []).length ? '<div class="pad hint">' + esc(t('venHqs')) + ' ' + L.hq.map(function (h, i) { return esc(h.label || 'Referee HQ') + ' (' + h.x + ', ' + h.y + ')'; }).join('; ') + '</div>' : '') +
        '<div class="pad hint">' + esc(t('venSaveHint')) + '</div>');
  }
  function wireVenueEditor(root) {
    var d = VE.draft;
    var read = function () { d.name = $('venName').value.trim(); d.address = $('venAddr').value.trim(); d.lat = $('venLat').value; d.lon = $('venLon').value; };
    $('venBack').onclick = function () { VE.open = null; VE.draft = null; VE.msg = ''; renderSetup(); };
    var del = $('venDelete'); if (del) del.onclick = async function () { if (!window.confirm(t('venDeleteConfirm').replace('{name}', d.name))) return; var r = await sb.from('venues').delete().eq('id', VE.open); if (r.error) { VE.msg = r.error.message; renderSetup(); return; } VE.open = null; VE.draft = null; VEN.rows = null; MAPS.all = null; await loadVenues_(); renderSetup(); };
    $('venGeo').onclick = async function () { read(); if (!d.address) return; busy(true); try { var r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(d.address + ', Colorado')).then(function (x) { return x.json(); }); if (r && r[0]) { $('venLat').value = Number(r[0].lat).toFixed(5); $('venLon').value = Number(r[0].lon).toFixed(5); } else { VE.msg = t('venNotFound'); } } catch (e) { VE.msg = t('venNotFound'); } busy(false); if (VE.msg) { say('venMsg', VE.msg, 'bad'); VE.msg = ''; } };
    $('venSave').onclick = async function () {
      read(); if (!d.name) { say('venMsg', t('venNeedName'), 'bad'); return; }
      var row = { org_id: S.me.org_id, name: d.name, slug: FieldMap.slug(d.name), address: d.address || null, lat: d.lat === '' ? null : Number(d.lat), lon: d.lon === '' ? null : Number(d.lon), layout: d.layout ? Object.assign({}, d.layout, { name: d.name }) : null, updated_at: new Date().toISOString() };
      var r = VE.open ? await sb.from('venues').update(row).eq('id', VE.open) : await sb.from('venues').insert(row).select('id').single();
      if (r.error) { say('venMsg', r.error.message, 'bad'); return; }
      if (!VE.open && r.data) VE.open = r.data.id;
      VEN.rows = null; MAPS.all = null; await loadVenues_(); say('venMsg', t('evSaved'), 'good');
    };
    var st = $('venStartLayout'); if (st) st.onclick = function () { read(); d.layout = blankLayout(d.name); d.layout.fields.push({ id: '1', x: 100, y: 100, w: 110, h: 160, size: '11v11' }); renderSetup(); };
    var L = d.layout; if (!L) return;
    var preview = function () { var pv = $('venPreview'); if (!pv) return; var fm = FieldMap.render(pv, L, { onSelect: function (id) { VE.sel = L.fields.map(function (f) { return f.id; }).indexOf(id); renderSetup(); } }); if (VE.sel != null && L.fields[VE.sel]) fm.select(L.fields[VE.sel].id); };
    preview();
    root.querySelectorAll('[data-fx]').forEach(function (i) { i.onchange = function () { read(); var f = L.fields[Number(i.getAttribute('data-fx'))], k = i.getAttribute('data-k'); if (!f) return; f[k] = (k === 'id' || k === 'size') ? i.value.trim() : Number(i.value); preview(); }; });
    root.querySelectorAll('[data-fdup]').forEach(function (b) { b.onclick = function () { read(); var f = L.fields[Number(b.getAttribute('data-fdup'))]; var c = JSON.parse(JSON.stringify(f)); c.x = f.x + f.w + 12; c.id = String(f.id).replace(/(\d+)/, function (m) { return String(Number(m) + 1); }); L.fields.splice(Number(b.getAttribute('data-fdup')) + 1, 0, c); renderSetup(); }; });
    root.querySelectorAll('[data-fdel]').forEach(function (b) { b.onclick = function () { read(); L.fields.splice(Number(b.getAttribute('data-fdel')), 1); VE.sel = null; renderSetup(); }; });
    $('venAddField').onclick = function () { read(); var last = L.fields[L.fields.length - 1]; L.fields.push(last ? { id: String(L.fields.length + 1), x: last.x, y: last.y + last.h + 12, w: last.w, h: last.h, size: last.size } : { id: '1', x: 100, y: 100, w: 110, h: 160, size: '11v11' }); renderSetup(); };
    $('venAddHq').onclick = function () { read(); var lbl = window.prompt(t('venHqLabel'), 'Referee HQ'); if (lbl == null) return; L.hq = L.hq || []; L.hq.push({ x: 520, y: 40, w: 120, h: 42, label: lbl }); renderSetup(); };
    $('venAddRoad').onclick = function () { read(); var lbl = window.prompt(t('venRoadLabel'), ''); if (lbl == null) return; L.roads = L.roads || []; L.roads.push({ x: 60, y: 12, w: 1080, h: 22 }); if (lbl) { L.labels = L.labels || []; L.labels.push({ x: 600, y: 28, t: lbl, k: 'parking' }); } renderSetup(); };
  }
  // ── Sessions: fitness tests, classes, clinics ────────────────────
  var SES = { list: [], past: [], mine: [], counts: {}, open: null, roster: [], form: null, badge: null, pacerRun: 0 };
  function runsSessions() { return iCan('setup') || iCan('review'); }
  // FIFA standards Colorado runs to. National = men's international, Regional = women's international,
  // Regional category 3 = women's category 3 for referees the Referee Department sets there.
  // CODA is the assistant referee change-of-direction test. Premium pay: sprints within PREMIUM_PLUS
  // of the standard and more than half the interval (PREMIUM_RUNS of 40). The Regional
  // rows are Colorado's results sheets of 20 October 2026: men 6.4 / 17 / 20, women 6.6 / 17 / 24.
  var FIT = { national: { rsa: 6.0, run: 15, walk: 18, coda: 10.0 }, regional: { rsa: 6.4, run: 17, walk: 20, coda: 11.0 }, regional3: { rsa: 6.6, run: 17, walk: 24, coda: 11.0 } };
  var PREMIUM_PLUS = 0.4, PREMIUM_RUNS = 21, INTERVAL_RUNS = 40;
  var FIT_WAIVER_URL = 'https://www.emailmeform.com/builder/form/93yTc7L8112iaafnM6';
  function stdKey(x) { return FIT[x && x.standard] ? x.standard : 'national'; }
  function fitStd(x) { return FIT[stdKey(x)]; }
  function stdLine(x) { var f = fitStd(x); return t('fitStd.' + stdKey(x)) + ': ' + t('fitStdLine').replace('{rsa}', f.rsa.toFixed(1)).replace('{run}', f.run).replace('{walk}', f.walk); }
  var SES_SEL = 'id,kind,title,date,start_time,end_time,venue,address,capacity,open_to,notes,active,standard,fee_cents';
  // ── Payments (Stripe collections; free stays free) ───────────────
  var FEES = { loaded: false, eval: {} };
  async function loadFees_() {
    if (FEES.loaded) return;
    try {
      var r = await sb.from('fees').select('kind,purpose,amount_cents,active').eq('active', true);
      FEES.eval = {};
      (r.data || []).forEach(function (f) { if (f.kind === 'evaluation' && f.amount_cents > 0) FEES.eval[f.purpose] = f.amount_cents; });
      FEES.loaded = true;
    } catch (e) {}
  }
  function money(c) { return '$' + (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2)); }
  async function payStart(body, msgId) {
    try {
      var r = await sb.functions.invoke('stripe-checkout', { body: body });
      if (r.data && r.data.url) { location.href = r.data.url; return true; }
      var m = r.data && r.data.error;
      if (!m && r.error && r.error.context && r.error.context.json) { try { m = (await r.error.context.json()).error; } catch (e) {} }
      say(msgId, m || t('payFailed'), 'bad');
    } catch (e) { say(msgId, t('payFailed'), 'bad'); }
    return false;
  }
  async function loadSessions_() {
    var today = todayStr(), back = new Date(Date.now() - 120 * 86400000);
    var r = await Promise.all([
      sb.from('sessions').select(SES_SEL).gte('date', today).eq('active', true).order('date').order('start_time'),
      sb.from('session_signups').select('id,session_id,status,result').eq('person_id', S.me.person_id),
      sb.rpc('session_counts'),
      sb.from('session_signups').select('status,sessions!inner(kind,date,standard)').eq('person_id', S.me.person_id).eq('status', 'passed').eq('sessions.kind', 'fitness').gte('sessions.date', today.slice(0, 4) + '-01-01'),
      sb.from('licenses').select('season').eq('person_id', S.me.person_id).order('season', { ascending: false }).limit(1),
      runsSessions() ? sb.from('sessions').select(SES_SEL).lt('date', today).gte('date', todayStr(back)).order('date', { ascending: false }) : Promise.resolve({ data: [] })
    ]);
    SES.list = r[0].data || []; SES.mine = r[1].data || []; SES.past = r[5].data || [];
    SES.season = ((r[4] && r[4].data) || [])[0] ? Number(r[4].data[0].season) : null;
    SES.counts = {}; (r[2].data || []).forEach(function (c) { SES.counts[String(c.session_id)] = Number(c.signed); });
    SES.badge = ((r[3] && r[3].data) || []).map(function (x) { return x.sessions; }).filter(Boolean).sort(function (a, b) { return a.date < b.date ? 1 : -1; })[0] || null;
  }
  function fitBadgeHtml(f) { return f ? '<span class="pill ok fitbadge">' + esc(t('fitBadge').replace('{std}', t('fitStd.' + stdKey(f))).replace('{date}', dayLong(f.date))) + '</span>' : ''; }
  function mySignup(sid) { return SES.mine.filter(function (x) { return String(x.session_id) === String(sid); })[0]; }
  function sessionLine(x) { return esc(dayLong(x.date)) + (x.start_time ? ', ' + esc(hhmm(x.start_time)) + (x.end_time ? ' to ' + esc(hhmm(x.end_time)) : '') : '') + (x.venue ? ', ' + esc(x.venue) : ''); }
  function sessionById(id) { return SES.list.concat(SES.past).filter(function (y) { return y.id === id; })[0]; }

  // ── Verdicts. The test is two parts (three for assistant referees); every part must pass.
  // Sprints: 'pass', 'fail', 'seventh' (one miss, 7th still to run) or '' (not finished).
  function rsaVerdict(times, std) {
    var six = (times || []).slice(0, 6), miss = 0, done = 0;
    six.forEach(function (v) { if (v != null && v !== '') { done++; if (Number(v) > std) miss++; } });
    if (miss >= 2) return 'fail';
    if (done < 6) return '';
    if (miss === 0) return 'pass';
    var s7 = (times || [])[6];
    if (s7 == null || s7 === '') return 'seventh';
    return Number(s7) > std ? 'fail' : 'pass';
  }
  // Interval: 'fail' once a run put them out, 'pass' once all runs are done, '' while running or not run.
  function intervalVerdict(r) { if (r.interval_fail_run) return 'fail'; if ((r.interval_runs || 0) >= INTERVAL_RUNS) return 'pass'; return ''; }
  // CODA: only counts when a time is entered. Two failed trials is a fail; one good trial passes.
  function codaVerdict(times, std) {
    var tr = (times || []).filter(function (v) { return v != null && v !== ''; });
    if (!tr.length) return 'none';
    if (tr.some(function (v) { return Number(v) <= std; })) return 'pass';
    return tr.length >= 2 ? 'fail' : '';
  }
  // Premium pay: every sprint within the extra margin and enough interval laps, when the full test was not passed.
  function premiumOk(r, std) {
    var six = (r.rsa || []).slice(0, 6); if (six.length < 6 || six.some(function (v) { return v == null || v === ''; })) return false;
    if (six.some(function (v) { return Number(v) > std.rsa + PREMIUM_PLUS; })) return false;
    var runs = r.interval_fail_run ? r.interval_fail_run - 1 : (r.interval_runs || 0);
    return runs >= PREMIUM_RUNS;
  }
  // Overall: passed | failed | premium | signed (incomplete) | no_show | waitlist | withdrawn
  function fitOverall(r, std) {
    if (r.status === 'no_show' || r.status === 'withdrawn' || r.status === 'waitlist') return r.status;
    var a = rsaVerdict(r.rsa, std.rsa), b = intervalVerdict(r), c = codaVerdict(r.coda, std.coda);
    if (a === 'fail' || b === 'fail' || c === 'fail') return premiumOk(r, std) ? 'premium' : 'failed';
    if (a === 'pass' && b === 'pass' && c !== '') return 'passed';
    return 'signed';
  }
  function fitWord(k) { return k === 'passed' ? t('sesPassed') : k === 'failed' ? t('sesFailed') : k === 'premium' ? t('fitPremium') : k === 'no_show' ? t('sesNoShow') : k === 'waitlist' ? t('sesWaitlisted') : k === 'signed' ? t('fitIncomplete') : ''; }

  // ── The sign-up card on Your day: upcoming sessions a referee may join. Fitness needs the waiver first.
  // Re-register: from September the coming year is the one that matters. Shown until a licence for it is on file.
  var LC_URL = 'https://learning.ussoccer.com/';
  function reregisterHtml() {
    var d = new Date(), target = d.getMonth() >= 8 ? d.getFullYear() + 1 : d.getFullYear();
    if (SES.season == null) return '';
    if (SES.season >= target) return '<div class="card" style="gap:4px"><span class="pill ok" style="align-self:flex-start">' + esc(t('regDone').replace('{y}', target)) + '</span></div>';
    return '<div class="card" style="gap:8px;border-color:var(--red)"><b>' + esc(t('regTitle').replace('{y}', target)) + '</b><div class="hint">' + esc(t('regBody').replace('{y}', target).replace('{prev}', target - 1)) + '</div><a class="btn primary" href="' + LC_URL + '" target="_blank" rel="noopener">' + esc(t('regGo')) + '</a></div>';
  }
  function signupCardHtml() {
    var list = SES.list.filter(function (x) { return x.open_to !== 'invite' || mySignup(x.id); });
    if (!list.length) return reregisterHtml() + (SES.badge ? '<div class="card" style="gap:8px;border-color:var(--gold)">' + fitBadgeHtml(SES.badge) + '</div>' : '');
    // Compact like the premium fold: one line, closed until the referee taps it,
    // the whole sign-up flow inside. The passed badge rides along in the body.
    var inner = '<div class="pad" style="display:flex;flex-direction:column;gap:14px;padding-top:4px;padding-bottom:12px">' + fitBadgeHtml(SES.badge) + list.map(function (x) {
      var me = mySignup(x.id), n = SES.counts[String(x.id)] || 0, full = x.capacity && n >= x.capacity && !me, fit = x.kind === 'fitness';
      var payLbl = x.fee_cents > 0 ? t('sesPayJoin').replace('{amt}', money(x.fee_cents)) : t('sesSignUp');
      var state = me ? (me.status === 'passed' ? t('sesPassed') : me.status === 'failed' ? t('sesFailed') : me.status === 'premium' ? t('fitPremium') : me.status === 'no_show' ? t('sesNoShow') : me.status === 'waitlist' ? t('sesWaitlisted') : t('sesIn')) : (full ? t('sesFull') : (x.capacity ? t('sesSpots').replace('{n}', x.capacity - n) : ''));
      var join = !me && !full ? (fit ? '<div class="no-print" style="margin-top:8px"><a class="chip-btn small" style="display:inline-block;text-decoration:none" href="' + FIT_WAIVER_URL + '" target="_blank" rel="noopener">' + esc(t('fitWaiverOpen')) + '</a><label style="display:flex;gap:10px;align-items:flex-start;min-height:44px;margin-top:6px"><input type="checkbox" data-waiver="' + x.id + '" style="width:22px;height:22px;flex:none;margin-top:2px"> <span class="hint">' + esc(t('fitWaiverConfirm')) + '</span></label><button class="btn primary small" data-ses-in="' + x.id + '" disabled>' + esc(payLbl) + '</button></div>' : '<div style="margin-top:8px"><button class="btn primary small" data-ses-in="' + x.id + '">' + esc(payLbl) + '</button></div>') : '';
      return '<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div style="flex:1"><b>' + esc(t('sesKind.' + x.kind)) + ': ' + esc(x.title) + '</b><br><span class="hint">' + sessionLine(x) + (state ? '. ' + esc(state) : '') + '</span>' + (x.notes ? '<br><span class="hint">' + esc(x.notes) + '</span>' : '') +
        (fit ? '<br><span class="hint">' + esc(stdLine(x)) + '</span><br><a href="fitness.html" class="chip-btn small" style="display:inline-block;margin-top:6px;text-decoration:none">' + esc(t('fitOpen')) + '</a>' : '') + join + '</div>' +
        (me && ['signed', 'waitlist'].indexOf(me.status) >= 0 ? '<button class="btn outline small" data-ses-out="' + me.id + '">' + esc(t('sesWithdraw')) + '</button>' : '') + '</div>';
    }).join('') + '<div class="msg" id="sesMsg" hidden></div></div>';
    return reregisterHtml() + fold('signup', t('sesTitle'), list.length, inner, false);
  }
  function wireSignup(root) {
    root.querySelectorAll('[data-waiver]').forEach(function (c) { c.onchange = function () { var b = root.querySelector('[data-ses-in="' + c.getAttribute('data-waiver') + '"]'); if (b) b.disabled = !c.checked; }; });
    root.querySelectorAll('[data-ses-in]').forEach(function (b) { b.onclick = async function () {
      b.disabled = true; var sid = parseInt(b.getAttribute('data-ses-in'), 10), x = SES.list.filter(function (y) { return y.id === sid; })[0];
      if (x && x.fee_cents > 0) { var paid = await payStart({ kind: 'session', id: sid, waiver: x.kind === 'fitness' }, 'sesMsg'); if (!paid) b.disabled = false; return; }
      var n = SES.counts[String(sid)] || 0, status = x && x.capacity && n >= x.capacity ? 'waitlist' : 'signed';
      var row = { org_id: S.me.org_id, session_id: sid, person_id: S.me.person_id, name: S.me.first_name + ' ' + S.me.last_name, status: status };
      if (x && x.kind === 'fitness') row.waiver_at = new Date().toISOString();
      var r = await sb.from('session_signups').insert(row);
      if (r.error) { b.disabled = false; say('sesMsg', r.error.message, 'bad'); return; }
      await loadSessions_(); renderDay();
    }; });
    root.querySelectorAll('[data-ses-out]').forEach(function (b) { b.onclick = async function () {
      if (!window.confirm(t('sesWithdrawConfirm'))) return;
      b.disabled = true;
      var r = await sb.from('session_signups').delete().eq('id', parseInt(b.getAttribute('data-ses-out'), 10));
      if (r.error) { b.disabled = false; say('sesMsg', r.error.message, 'bad'); return; }
      await loadSessions_(); renderDay();
    }; });
  }

  // ── The results sheet for a fitness test: three parts on one page, one verdict per referee.
  function fitSheetHtml(x, roster) {
    var std = fitStd(x), live = roster.filter(function (r) { return r.status !== 'withdrawn'; });
    if (!live.length) return '<div class="card"><div class="hint">' + esc(t('sesNobody')) + '</div></div>';
    var num = function (cls, attrs, val, extra) { return '<input type="number" inputmode="decimal" class="fit-t' + (cls ? ' ' + cls : '') + '" ' + attrs + ' value="' + (val == null ? '' : esc(val)) + '"' + (extra || '') + '>'; };
    var th = function (l, n) { return '<th' + (n ? ' class="n"' : '') + '>' + esc(l) + '</th>'; };
    var rowHead = function (r) { return '<td class="n">' + num('', 'min="1" max="999" step="1" data-fit-bib="' + r.id + '" aria-label="' + esc(t('fitBib')) + '"', r.bib) + '</td><td><b>' + refLink(r.name) + '</b>' + (r.waiver_at ? '' : '<div class="hint" style="color:var(--red)">' + esc(t('fitNoWaiver')) + '</div>') + '</td>'; };
    // Part 1: sprints
    var rows1 = live.map(function (r) {
      var times = r.rsa || [], v = rsaVerdict(times, std.rsa), off = r.status === 'no_show';
      var cell = function (i) { var val = times[i], bad = val != null && val !== '' && Number(val) > std.rsa; return '<td class="n">' + num(bad ? 'bad' : '', 'step="0.01" min="3" max="20" data-fit-rsa="' + r.id + '" data-i="' + i + '" aria-label="' + esc(t('fitSprint')) + ' ' + (i + 1) + '"', val, off ? ' disabled' : '') + '</td>'; };
      var seventh = v === 'seventh' || (times[6] != null && times[6] !== '') ? cell(6) : '<td class="n hint">' + (v === 'fail' ? esc(t('fitTwoMisses')) : '') + '</td>';
      return '<tr>' + rowHead(r) + [0, 1, 2, 3, 4, 5].map(cell).join('') + seventh + '<td class="n ' + (v === 'pass' ? 'good' : v === 'fail' ? 'bad' : '') + '"><b>' + esc(v === 'pass' ? t('fitPass') : v === 'fail' ? t('fitFail') : v === 'seventh' ? t('fitSeventh') : '') + '</b></td></tr>';
    }).join('');
    var part1 = '<div class="disp h2 print-keep">' + esc(t('fitPart1')) + '</div><div class="pad hint" style="padding-top:0">' + esc(t('fitPart1Hint').replace('{rsa}', std.rsa.toFixed(1))) + '</div>' +
      '<div class="pad" style="padding-top:6px;overflow-x:auto"><table class="dt fit"><thead><tr>' + th(t('fitBib'), 1) + th(t('fitName')) + [1, 2, 3, 4, 5, 6].map(function (i) { return th(t('fitSprint') + ' ' + i, 1); }).join('') + th(t('fitSeventhCol'), 1) + th(t('fitRsa'), 1) + '</tr></thead><tbody>' + rows1 + '</tbody></table></div>';
    // Part 2: interval, run by run, with the pacer on this phone
    var P = window.Pacer ? Pacer.state : { on: false, run: 0, phase: 'rest', left: 0 };
    var cur = P.on ? P.run : SES.pacerRun;
    var pacer = '<div class="card no-print pacer" style="gap:8px"><div style="display:flex;justify-content:space-between;align-items:flex-end;gap:8px"><div><b>' + esc(t('fitPacer')) + '</b><div class="hint">' + esc(t('fitPacerHint').replace('{run}', std.run).replace('{walk}', std.walk)) + '</div><div class="phase ' + (P.phase === 'run' ? 'run' : P.phase === 'walk' ? 'walk' : 'rest') + '" id="pcPhase">' + esc(P.on ? (P.phase === 'ready' ? t('fitReady') + ' ' + P.left : P.phase === 'run' ? t('fitRun') + ' ' + P.left : t('fitWalk') + ' ' + P.left) : t('fitRunNow')) + '</div></div><div style="text-align:right"><div class="big" id="pcCount">' + cur + '</div><div class="hint">' + esc(t('fitOfRuns').replace('{n}', INTERVAL_RUNS)) + '</div></div></div>' +
      '<div class="actions" style="padding:0">' + (P.on ? '<button class="btn outline" id="pcStop">' + esc(t('fitStop')) + '</button>' : '<button class="btn primary" id="pcStart">' + esc(t('fitStart')) + '</button><button class="chip-btn" id="pcMinus" aria-label="-">&minus;</button><button class="chip-btn" id="pcPlus" aria-label="+">+</button>') + '</div>' +
      '<div class="hint">' + esc(t('fitPacerHow')) + '</div></div>';
    var rows2 = live.map(function (r) {
      var off = r.status === 'no_show', v = intervalVerdict(r), out = !!r.interval_fail_run;
      return '<tr>' + rowHead(r) +
        '<td class="n">' + num(r.interval_warn_run ? 'warnd' : '', 'step="1" min="1" max="' + INTERVAL_RUNS + '" data-fit-warn-run="' + r.id + '" aria-label="' + esc(t('fitWarnRun')) + '"', r.interval_warn_run, off ? ' disabled' : '') + '</td>' +
        '<td class="n">' + num(out ? 'bad' : '', 'step="1" min="1" max="' + INTERVAL_RUNS + '" data-fit-fail-run="' + r.id + '" aria-label="' + esc(t('fitOutRun')) + '"', r.interval_fail_run, off ? ' disabled' : '') + '</td>' +
        '<td class="n">' + num('', 'step="1" min="0" max="' + INTERVAL_RUNS + '" data-fit-runs="' + r.id + '" aria-label="' + esc(t('fitRunsDone')) + '"', r.interval_runs, off || out ? ' disabled' : '') + '</td>' +
        '<td class="no-print"><div class="chips" style="flex-wrap:nowrap">' + (off || out ? '' : '<button class="chip-btn small warn" data-fit-warn="' + r.id + '">' + esc(t('fitWarn')) + '</button><button class="chip-btn small" data-fit-out="' + r.id + '">' + esc(t('fitOut')) + '</button>' + (v === 'pass' ? '' : '<button class="chip-btn small" data-fit-done="' + r.id + '">' + esc(t('fitFinished')) + '</button>')) + '</div></td>' +
        '<td class="n ' + (v === 'pass' ? 'good' : v === 'fail' ? 'bad' : '') + '"><b>' + esc(v === 'pass' ? t('fitPass') : v === 'fail' ? t('fitFail') : '') + '</b></td></tr>';
    }).join('');
    var part2 = '<div class="disp h2 print-keep">' + esc(t('fitPart2')) + '</div><div class="pad hint" style="padding-top:0">' + esc(t('fitPart2Hint')) + '</div>' + pacer +
      '<div class="pad" style="padding-top:6px;overflow-x:auto"><table class="dt fit"><thead><tr>' + th(t('fitBib'), 1) + th(t('fitName')) + th(t('fitWarnRun'), 1) + th(t('fitOutRun'), 1) + th(t('fitRunsDone'), 1) + '<th class="no-print"></th>' + th(t('fitInterval'), 1) + '</tr></thead><tbody>' + rows2 + '</tbody></table></div>' +
      '<div class="actions no-print"><button class="btn outline small" id="fitAllDone">' + esc(t('fitAllDone')) + '</button></div>';
    // Part 3: CODA for assistant referees, only when used
    var anyCoda = live.some(function (r) { return (r.coda || []).some(function (v) { return v != null && v !== ''; }); });
    var rows3 = live.map(function (r) {
      var times = r.coda || [], v = codaVerdict(times, std.coda), off = r.status === 'no_show';
      var cell = function (i) { var val = times[i], bad = val != null && val !== '' && Number(val) > std.coda; return '<td class="n">' + num(bad ? 'bad' : '', 'step="0.01" min="5" max="30" data-fit-coda="' + r.id + '" data-i="' + i + '" aria-label="' + esc(t('fitTrial')) + ' ' + (i + 1) + '"', val, off ? ' disabled' : '') + '</td>'; };
      return '<tr>' + rowHead(r) + cell(0) + cell(1) + '<td class="n ' + (v === 'pass' ? 'good' : v === 'fail' ? 'bad' : '') + '"><b>' + esc(v === 'pass' ? t('fitPass') : v === 'fail' ? t('fitFail') : '') + '</b></td></tr>';
    }).join('');
    var part3 = fold('fitcoda', t('fitPart3'), anyCoda ? live.filter(function (r) { return codaVerdict(r.coda, std.coda) !== 'none'; }).length : '', '<div class="pad hint" style="padding-top:0">' + esc(t('fitPart3Hint').replace('{coda}', std.coda.toFixed(1))) + '</div><div class="pad" style="padding-top:6px;overflow-x:auto"><table class="dt fit"><thead><tr>' + th(t('fitBib'), 1) + th(t('fitName')) + th(t('fitTrial') + ' 1', 1) + th(t('fitTrial') + ' 2', 1) + th(t('fitCoda'), 1) + '</tr></thead><tbody>' + rows3 + '</tbody></table></div>', anyCoda);
    // Results
    var rows4 = live.map(function (r) {
      var ov = fitOverall(r, std), off = r.status === 'no_show', a = rsaVerdict(r.rsa, std.rsa), b = intervalVerdict(r), c = codaVerdict(r.coda, std.coda);
      var pf = function (v) { return v === 'pass' ? t('fitPass') : v === 'fail' ? t('fitFail') : v === 'none' ? '' : t('fitIncomplete'); };
      return '<tr class="' + esc(ov) + '"><td class="n">' + (r.bib == null ? '' : r.bib) + '</td><td><b>' + esc(r.name) + '</b></td><td class="n">' + esc(pf(a)) + '</td><td class="n">' + esc(pf(b)) + '</td><td class="n">' + esc(pf(c)) + '</td><td class="n"><b>' + esc(fitWord(ov)) + '</b></td>' +
        '<td class="no-print"><div class="chips" style="flex-wrap:nowrap"><button class="chip-btn small' + (off ? ' on' : '') + '" data-fit-ns="' + r.id + '">' + esc(t('sesMarkNoShow')) + '</button><button class="chip-btn small" data-fit-drop="' + r.id + '">' + esc(t('fitRemove')) + '</button></div></td></tr>';
    }).join('');
    var counts = {}; live.forEach(function (r) { var k = fitOverall(r, std); counts[k] = (counts[k] || 0) + 1; });
    var part4 = '<div class="disp h2 print-keep">' + esc(t('fitResults')) + '</div><div class="pad" style="padding-top:6px;overflow-x:auto"><table class="dt fit"><thead><tr>' + th(t('fitBib'), 1) + th(t('fitName')) + th(t('fitRsa'), 1) + th(t('fitInterval'), 1) + th(t('fitCoda'), 1) + th(t('fitResult'), 1) + '<th class="no-print"></th></tr></thead><tbody>' + rows4 + '</tbody></table></div>' +
      '<div class="pad hint" style="padding-top:6px">' + ['passed', 'premium', 'failed', 'signed', 'no_show'].filter(function (k) { return counts[k]; }).map(function (k) { return counts[k] + ' ' + fitWord(k).toLowerCase(); }).join(', ') + '</div>';
    return '<div class="pad hint" style="padding-top:0">' + esc(stdLine(x)) + '. ' + esc(t('fitSheetHint')) + '</div>' + part1 + part2 + part3 + part4 +
      '<div class="actions no-print"><button class="btn primary small" id="fitPrint">' + esc(t('fitPrint')) + '</button><a class="btn outline small" href="fitness.html">' + esc(t('fitOpen')) + '</a></div><div class="msg" id="fitMsg" hidden></div>';
  }

  // ── Setup side: list, create, roster and results.
  // Fees: evaluation purposes org-wide; session fees sit on each session.
  function feesSetupHtml() {
    var evp = ['maintenance', 'upgrade_regional', 'upgrade_national'];
    var val = function (p) { var r = (SU.fees || []).filter(function (x) { return x.kind === 'evaluation' && x.purpose === p; })[0]; return r && r.active && r.amount_cents > 0 ? String(r.amount_cents % 100 === 0 ? r.amount_cents / 100 : (r.amount_cents / 100).toFixed(2)) : ''; };
    var inp = function (id, v) { return '<input id="' + id + '" type="number" min="0" step="1" inputmode="decimal" value="' + esc(v) + '" placeholder="0" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">'; };
    var rows = evp.map(function (p) { return '<div class="grid2" style="align-items:center"><label class="hint" for="fee_' + p + '">' + esc(t('evalPurpose.' + p)) + '</label>' + inp('fee_' + p, val(p)) + '</div>'; }).join('');
    var payRow = function (p) { return '<div class="rowline"><div><b>' + esc(p.name || '') + '</b><br><span class="hint">' + esc(p.kind === 'evaluation' ? t('evalPurpose.' + p.purpose) : t('paySession')) + ', ' + esc(dayShort(String(p.created_at).slice(0, 10))) + '</span></div><span class="pill' + (p.status === 'paid' ? ' ok' : p.status === 'refunded' || p.status === 'expired' ? ' bad' : '') + '">' + money(p.amount_cents) + ' · ' + esc(t('payStatus.' + p.status)) + '</span></div>'; };
    var nSet = (SU.fees || []).filter(function (f) { return f.active && f.amount_cents > 0; }).length;
    return fold('fees', t('feesTitle'), nSet || '', '<div class="hint">' + esc(t('feesHint')) + '</div>' + rows +
      '<div class="actions" style="padding:8px 0 0"><button class="btn primary small" id="feesSave">' + esc(t('feesSave')) + '</button></div><div class="msg" id="feesMsg" hidden></div>' +
      ((SU.pays || []).length ? '<b style="display:block;padding-top:10px">' + esc(t('paysTitle')) + '</b>' + SU.pays.map(payRow).join('') : ''), false);
  }
  function wireFees(root) {
    var b = $('feesSave'); if (!b) return;
    b.onclick = async function () {
      b.disabled = true;
      var rows = ['maintenance', 'upgrade_regional', 'upgrade_national'].map(function (p) { var v = parseFloat($('fee_' + p).value || '0'), c = isNaN(v) ? 0 : Math.round(v * 100); return { org_id: S.me.org_id, kind: 'evaluation', purpose: p, amount_cents: c, active: c > 0, updated_at: new Date().toISOString() }; });
      var r = await sb.from('fees').upsert(rows, { onConflict: 'org_id,kind,purpose' });
      b.disabled = false;
      if (r.error) { say('feesMsg', r.error.message, 'bad'); return; }
      SU.fees = rows; FEES.loaded = false; FEES.eval = {}; say('feesMsg', t('feesSaved'), 'ok');
    };
  }
  function sessionsSetupHtml() {
    if (SES.open) {
      var x = sessionById(SES.open);
      if (!x) { SES.open = null; return sessionsSetupHtml(); }
      var roster = SES.roster || [], n = roster.filter(function (r) { return r.status !== 'withdrawn' && r.status !== 'waitlist'; }).length;
      var res = function (r, k, label) { return '<button class="chip-btn small' + (r.status === k ? ' on' : '') + '" data-ses-res="' + r.id + '" data-res="' + k + '">' + esc(label) + '</button>'; };
      return '<div class="pad no-print" style="padding-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn outline small" id="sesBack">' + esc(t('back')) + '</button><button class="btn outline small" id="sesPrint">' + esc(t('print')) + '</button><button class="btn outline small" id="sesClose" style="margin-left:auto">' + esc(x.active ? t('sesCancel') : t('sesReopen')) + '</button><button class="btn outline small" id="sesDelete">' + esc(t('sesDelete')) + '</button></div>' +
        '<div class="pad" style="padding-top:12px"><div class="disp" style="font-size:30px">' + esc(x.title) + '</div><div class="hint">' + esc(t('sesKind.' + x.kind)) + '. ' + sessionLine(x) + (x.address ? '. ' + esc(x.address) : '') + '</div><div class="hint">' + n + (x.capacity ? ' / ' + x.capacity : '') + ' ' + esc(t('sesSignedUp')) + '</div></div>' +
        (x.kind === 'fitness' ? fitSheetHtml(x, roster) :
        (roster.length ? roster.map(function (r) { return '<div class="card" style="gap:6px"><div style="display:flex;justify-content:space-between;gap:8px"><b>' + refLink(r.name) + '</b><span class="hint">' + esc(r.status === 'waitlist' ? t('sesWaitlisted') : '') + '</span></div><div class="chips no-print">' + res(r, 'passed', t('sesMarkPassed')) + res(r, 'failed', t('sesMarkFailed')) + res(r, 'no_show', t('sesMarkNoShow')) + res(r, 'signed', t('sesMarkClear')) + '</div></div>'; }).join('') : '<div class="card"><div class="hint">' + esc(t('sesNobody')) + '</div></div>'));
    }
    var f = SES.form;
    var inp = function (id, v, type, extra) { return '<input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(v == null ? '' : v) + '" ' + (extra || '') + ' style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">'; };
    var form = !f ? '<div class="pad" style="padding-top:12px"><button class="btn outline" id="sesNew" style="width:100%">' + esc(t('sesNew')) + '</button></div>' :
      '<div class="card" style="gap:8px"><b>' + esc(t('sesNew')) + '</b><div class="chips">' + ['fitness', 'class', 'clinic'].map(function (k) { return '<button class="chip-btn small' + (f.kind === k ? ' on' : '') + '" data-ses-kind="' + k + '">' + esc(t('sesKind.' + k)) + '</button>'; }).join('') + '</div>' +
      (f.kind === 'fitness' ? '<label class="hint">' + esc(t('fitStandard')) + '</label><div class="chips">' + Object.keys(FIT).map(function (k) { return '<button class="chip-btn small' + (f.standard === k ? ' on' : '') + '" data-ses-std="' + k + '">' + esc(t('fitStd.' + k)) + '</button>'; }).join('') + '</div><div class="hint">' + esc(stdLine({ standard: f.standard })) + '</div>' : '') +
      '<label class="hint" for="sesTitle">' + esc(t('sesFieldTitle')) + '</label>' + inp('sesTitle', f.title) +
      '<div class="grid2"><div><label class="hint" for="sesDate">' + esc(t('eodDate')) + '</label>' + inp('sesDate', f.date, 'date') + '</div><div><label class="hint" for="sesCap">' + esc(t('sesCapacity')) + '</label>' + inp('sesCap', f.capacity, 'number', 'min="1"') + '</div></div>' +
      '<div class="grid2"><div><label class="hint" for="sesStart">' + esc(t('sesStart')) + '</label>' + inp('sesStart', f.start_time, 'time') + '</div><div><label class="hint" for="sesEnd">' + esc(t('sesEnd')) + '</label>' + inp('sesEnd', f.end_time, 'time') + '</div></div>' +
      '<label class="hint" for="sesVenue">' + esc(t('eodVenue')) + '</label>' + inp('sesVenue', f.venue) +
      '<label class="hint" for="sesAddr">' + esc(t('sesAddress')) + '</label>' + inp('sesAddr', f.address) +
      '<label class="hint" for="sesFee">' + esc(t('sesFee')) + '</label>' + inp('sesFee', f.fee, 'number', 'min="0" step="1" inputmode="decimal"') +
      '<label class="hint" for="sesOpen">' + esc(t('sesOpenTo')) + '</label><select id="sesOpen" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">' + ['all', 'regional', 'invite'].map(function (k) { return '<option value="' + k + '"' + (f.open_to === k ? ' selected' : '') + '>' + esc(t('sesOpen.' + k)) + '</option>'; }).join('') + '</select>' +
      '<label class="hint" for="sesNotes">' + esc(t('sesNotes')) + '</label><textarea id="sesNotes" style="min-height:70px">' + esc(f.notes || '') + '</textarea>' +
      '<label style="display:flex;gap:10px;align-items:center;min-height:44px"><input type="checkbox" id="sesBul"' + (f.bulletin ? ' checked' : '') + ' style="width:22px;height:22px"> ' + esc(t('sesBulletin')) + '</label>' +
      '<div class="actions" style="padding:0"><button class="btn primary" id="sesSave">' + esc(t('sesSave')) + '</button><button class="btn outline" id="sesCancelForm">' + esc(t('neverMind')) + '</button></div><div class="msg" id="sesFormMsg" hidden></div></div>';
    var item = function (x) { var n = SES.counts[String(x.id)] || 0; return '<a class="item" href="#" data-ses-open="' + x.id + '"><div><b>' + esc(t('sesKind.' + x.kind)) + ': ' + esc(x.title) + '</b>' + (x.active ? '' : ' <span class="pill">' + esc(t('evOff')) + '</span>') + '<br><span class="hint">' + sessionLine(x) + '. ' + n + (x.capacity ? ' / ' + x.capacity : '') + ' ' + esc(t('sesSignedUp')) + '</span></div><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>'; };
    return '<div class="disp h2">' + esc(t('sesSetupTitle')) + '</div>' + form + (SES.list.length ? '<div class="list">' + SES.list.map(item).join('') + '</div>' : '<div class="pad hint">' + esc(t('sesNone')) + '</div>') +
      (SES.past.length ? fold('sespast', t('sesPast'), SES.past.length, '<div class="list">' + SES.past.map(item).join('') + '</div>', false) : '');
  }
  async function openSession(id) {
    SES.open = id; busy(true);
    var r = await sb.from('session_signups').select('id,person_id,name,status,result,bib,rsa,interval_warn_run,interval_fail_run,interval_runs,coda,waiver_at,created_at').eq('session_id', id).order('bib', { nullsFirst: false }).order('created_at');
    busy(false); SES.roster = r.data || []; renderSetup();
  }
  function wireSessionsSetup(root) {
    var nb = $('sesNew'); if (nb) nb.onclick = function () { SES.form = { kind: 'fitness', standard: 'national', bulletin: true, title: '', date: todayStr(), capacity: '', start_time: '', end_time: '', venue: '', address: '', open_to: 'all', notes: '', fee: '' }; renderSetup(); };
    var cf = $('sesCancelForm'); if (cf) cf.onclick = function () { SES.form = null; renderSetup(); };
    root.querySelectorAll('[data-ses-kind]').forEach(function (b) { b.onclick = function () { SES.form.kind = b.getAttribute('data-ses-kind'); SES.form.title = $('sesTitle').value; renderSetup(); }; });
    root.querySelectorAll('[data-ses-std]').forEach(function (b) { b.onclick = function () { SES.form.standard = b.getAttribute('data-ses-std'); SES.form.title = $('sesTitle').value; renderSetup(); }; });
    var sv = $('sesSave'); if (sv) sv.onclick = async function () {
      var f = SES.form; f.title = $('sesTitle').value.trim(); f.date = $('sesDate').value; f.capacity = $('sesCap').value ? parseInt($('sesCap').value, 10) : null; f.start_time = $('sesStart').value || null; f.end_time = $('sesEnd').value || null; f.venue = $('sesVenue').value.trim(); f.address = $('sesAddr').value.trim(); f.open_to = $('sesOpen').value; f.notes = $('sesNotes').value.trim(); f.bulletin = $('sesBul').checked; f.fee = $('sesFee').value;
      if (!f.title || !f.date) { say('sesFormMsg', t('sesNeedTitleDate'), 'bad'); return; }
      sv.disabled = true;
      var r = await sb.from('sessions').insert({ org_id: S.me.org_id, kind: f.kind, title: f.title, date: f.date, start_time: f.start_time, end_time: f.end_time, venue: f.venue, address: f.address, capacity: f.capacity, open_to: f.open_to, notes: f.notes, standard: f.kind === 'fitness' ? f.standard : null, fee_cents: f.fee && parseFloat(f.fee) > 0 ? Math.round(parseFloat(f.fee) * 100) : null, created_by: S.me.first_name + ' ' + S.me.last_name });
      if (r.error) { sv.disabled = false; say('sesFormMsg', r.error.message, 'bad'); return; }
      // A bulletin so referees hear about it on Your day without anyone sending an email.
      if (f.bulletin) { try { await post({ action: 'postAnnouncement', title: t('sesKind.' + f.kind) + ': ' + f.title, bodyText: t('sesBulletinBody').replace('{when}', sessionLine(f).replace(/&#39;/g, "'").replace(/&amp;/g, '&')) + (f.kind === 'fitness' ? ' ' + stdLine(f) + '. ' + t('fitWaiverBulletin') : ''), startDate: todayStr(), endDate: f.date, severity: 'info', postedBy: S.me.first_name + ' ' + S.me.last_name }); } catch (e) {} }
      SES.form = null; await loadSessions_(); renderSetup();
    };
    root.querySelectorAll('[data-ses-open]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); openSession(parseInt(a.getAttribute('data-ses-open'), 10)); }; });
    var bk = $('sesBack'); if (bk) bk.onclick = function () { SES.open = null; renderSetup(); };
    var pr = $('sesPrint'); if (pr) pr.onclick = function () { window.print(); };
    var cl = $('sesClose'); if (cl) cl.onclick = async function () { var x = sessionById(SES.open); if (!x || !window.confirm(t('sesCancelConfirm'))) return; await sb.from('sessions').update({ active: !x.active }).eq('id', x.id); SES.open = null; await loadSessions_(); renderSetup(); };
    var dl = $('sesDelete'); if (dl) dl.onclick = async function () { var x = sessionById(SES.open); if (!x || !window.confirm(t('sesDeleteConfirm').replace('{title}', x.title))) return; var r = await sb.from('sessions').delete().eq('id', x.id); if (r.error) { say('fitMsg', r.error.message, 'bad'); return; } SES.open = null; await loadSessions_(); renderSetup(); };
    root.querySelectorAll('[data-ses-res]').forEach(function (b) { b.onclick = async function () {
      var id = parseInt(b.getAttribute('data-ses-res'), 10), st = b.getAttribute('data-res');
      var r = await sb.from('session_signups').update({ status: st, updated_at: new Date().toISOString() }).eq('id', id);
      if (r.error) return;
      SES.roster.forEach(function (x) { if (x.id === id) x.status = st; }); renderSetup();
    }; });
    // ── Fitness sheet. Each cell saves on its own; the verdict is recomputed and written to status.
    var ses = sessionById(SES.open), std = ses ? fitStd(ses) : FIT.national;
    var rowOf = function (id) { return SES.roster.filter(function (y) { return y.id === id; })[0]; };
    var saveRow = async function (r, patch) {
      Object.keys(patch).forEach(function (k) { r[k] = patch[k]; });
      var ov = fitOverall(r, std), stored = ['passed', 'failed', 'premium'];
      if (ov !== r.status && (stored.indexOf(ov) >= 0 || (ov === 'signed' && stored.indexOf(r.status) >= 0))) { patch.status = ov; r.status = ov; }
      patch.updated_at = new Date().toISOString();
      var res = await sb.from('session_signups').update(patch).eq('id', r.id);
      if (res.error) { say('fitMsg', res.error.message, 'bad'); return false; }
      return true;
    };
    var numOrNull = function (v) { return v === '' ? null : Math.round(Number(v) * 100) / 100; };
    var onNum = function (sel, fn) { root.querySelectorAll(sel).forEach(function (i) { i.onchange = async function () { var r = rowOf(parseInt(i.getAttribute(sel.slice(1, -1)), 10)); if (!r) return; if (await saveRow(r, fn(r, i))) renderSetup(); }; }); };
    root.querySelectorAll('[data-fit-bib]').forEach(function (i) { i.onchange = function () { var r = rowOf(parseInt(i.getAttribute('data-fit-bib'), 10)); if (r) saveRow(r, { bib: i.value ? parseInt(i.value, 10) : null }); }; });
    onNum('[data-fit-rsa]', function (r, i) { var k = parseInt(i.getAttribute('data-i'), 10), times = (r.rsa || []).slice(); while (times.length < 7) times.push(null); times[k] = numOrNull(i.value); return { rsa: times }; });
    onNum('[data-fit-coda]', function (r, i) { var k = parseInt(i.getAttribute('data-i'), 10), times = (r.coda || []).slice(); while (times.length < 2) times.push(null); times[k] = numOrNull(i.value); return { coda: times }; });
    onNum('[data-fit-warn-run]', function (r, i) { return { interval_warn_run: i.value ? parseInt(i.value, 10) : null }; });
    onNum('[data-fit-fail-run]', function (r, i) { var n = i.value ? parseInt(i.value, 10) : null; return { interval_fail_run: n, interval_runs: n ? n - 1 : r.interval_runs }; });
    onNum('[data-fit-runs]', function (r, i) { return { interval_runs: i.value ? parseInt(i.value, 10) : null }; });
    var curRun = function () { return window.Pacer && Pacer.state.on ? Pacer.state.run : SES.pacerRun; };
    // Warning at the current run. A second late foot is Out at the current run.
    root.querySelectorAll('[data-fit-warn]').forEach(function (b) { b.onclick = async function () { var r = rowOf(parseInt(b.getAttribute('data-fit-warn'), 10)); if (!r) return; var n = curRun() || 1; var patch = r.interval_warn_run ? { interval_fail_run: n, interval_runs: n - 1 } : { interval_warn_run: n }; if (await saveRow(r, patch)) renderSetup(); }; });
    root.querySelectorAll('[data-fit-out]').forEach(function (b) { b.onclick = async function () { var r = rowOf(parseInt(b.getAttribute('data-fit-out'), 10)); if (!r) return; var n = curRun() || 1; if (await saveRow(r, { interval_fail_run: n, interval_runs: n - 1 })) renderSetup(); }; });
    root.querySelectorAll('[data-fit-done]').forEach(function (b) { b.onclick = async function () { var r = rowOf(parseInt(b.getAttribute('data-fit-done'), 10)); if (!r) return; if (await saveRow(r, { interval_runs: INTERVAL_RUNS })) renderSetup(); }; });
    var ad = $('fitAllDone'); if (ad) ad.onclick = async function () { if (!window.confirm(t('fitAllDoneConfirm'))) return; for (var i = 0; i < SES.roster.length; i++) { var r = SES.roster[i]; if (r.status === 'no_show' || r.status === 'withdrawn' || r.interval_fail_run || (r.interval_runs || 0) >= INTERVAL_RUNS) continue; await saveRow(r, { interval_runs: INTERVAL_RUNS }); } renderSetup(); };
    root.querySelectorAll('[data-fit-ns]').forEach(function (b) { b.onclick = async function () { var r = rowOf(parseInt(b.getAttribute('data-fit-ns'), 10)); if (!r) return; var st = r.status === 'no_show' ? 'signed' : 'no_show'; r.status = st; var res = await sb.from('session_signups').update({ status: st, updated_at: new Date().toISOString() }).eq('id', r.id); if (res.error) { say('fitMsg', res.error.message, 'bad'); return; } renderSetup(); }; });
    root.querySelectorAll('[data-fit-drop]').forEach(function (b) { b.onclick = async function () { var r = rowOf(parseInt(b.getAttribute('data-fit-drop'), 10)); if (!r || !window.confirm(t('fitRemoveConfirm').replace('{name}', r.name))) return; var res = await sb.from('session_signups').delete().eq('id', r.id); if (res.error) { say('fitMsg', res.error.message, 'bad'); return; } SES.roster = SES.roster.filter(function (y) { return y.id !== r.id; }); renderSetup(); }; });
    // The pacer: audio from this phone, run counter drives Warning and Out. Re-rendering never restarts it.
    if (window.Pacer) {
      Pacer.state.onTick = function (P) { var c = $('pcCount'), ph = $('pcPhase'); if (c) c.textContent = String(P.run); if (ph) { ph.className = 'phase ' + (P.phase === 'run' ? 'run' : P.phase === 'walk' ? 'walk' : 'rest'); ph.textContent = P.phase === 'ready' ? t('fitReady') + ' ' + P.left : P.phase === 'run' ? t('fitRun') + ' ' + P.left : P.phase === 'walk' ? t('fitWalk') + ' ' + P.left : t('fitRunNow'); } if (!P.on) { SES.pacerRun = P.run; if (SES.open) renderSetup(); } };
      var ps = $('pcStart'); if (ps) ps.onclick = function () { Pacer.start(std.run, std.walk, INTERVAL_RUNS); renderSetup(); };
      var pq = $('pcStop'); if (pq) pq.onclick = function () { Pacer.stop(); };
    }
    var pm = $('pcMinus'); if (pm) pm.onclick = function () { SES.pacerRun = Math.max(0, SES.pacerRun - 1); $('pcCount').textContent = String(SES.pacerRun); };
    var pp = $('pcPlus'); if (pp) pp.onclick = function () { SES.pacerRun = Math.min(INTERVAL_RUNS, SES.pacerRun + 1); $('pcCount').textContent = String(SES.pacerRun); };
    var fp = $('fitPrint'); if (fp) fp.onclick = function () { window.print(); };
  }

  // ── Your day ─────────────────────────────────────────────────────
  function nextGame() {
    var now = Date.now();
    var upcoming = S.games.filter(function (g) { return new Date(g.kickoff).getTime() > now - 100 * 60000; });
    return upcoming[0] || null;
  }
  // The big number only. Runs once a minute without touching the rest of
  // the screen or the network, so a phone on a field all day does no work.
  function tickCountdown() {
    var g = nextGame(); if (!g) return;
    var mins = Math.round((new Date(g.kickoff).getTime() - Date.now()) / 60000);
    if (isHQ(g)) { $('countN').textContent = clock(g.kickoff).replace(/\s?[AP]M/i, ''); $('countW').innerHTML = t('siteOpens'); }
    else if (mins >= 0 && mins < 120) { $('countN').textContent = mins; $('countW').innerHTML = t('minutesToKickoff'); }
    else if (mins >= 120) { $('countN').textContent = Math.floor(mins / 60); $('countW').innerHTML = t('hoursToKickoff'); }
    else { $('countN').textContent = Math.abs(mins); $('countW').innerHTML = t('kickedOff') + '<br>' + t('minAgo'); }
  }
  // ── Assigning: the quiet build. Referee side renders only for the demo
  //    roster; the assignor board only behind the assigning unlock. ─────
  var ASG = { board: null, from: null, to: null, form: null, pick: null, q: '', cand: null, sel: null, warns: null, roster: null, rq: '', rcand: null, edit: null, filt: {}, draftMode: false, brQ: '', brCand: null, brSel: null, br: null, brPick: null };
  function asgSlotWord(s) { return s === 'cr' ? 'CR' : s === 'ar1' ? 'AR1' : s === 'ar2' ? 'AR2' : s === 'coach' ? t('asgCoachWord') : '4TH'; }
  function asgGameLine(o) { return dayShort(o.date) + ', ' + clock(o.kickoff) + ', ' + (o.venue || '') + (o.field ? ', ' + fieldShort(o.field) : ''); }
  var AV = { day: null, from: '', to: '' };
  // Grade shorthand beside a picker name. The codes read the same in both languages.
  function licTag(x) {
    var L = String(x.license || '');
    var s = L === 'International' ? 'INT' : L === 'Pro' ? 'PRO' : L === 'National' ? 'NAT'
          : L === 'Regional' ? 'REG' : L === 'Digital' ? 'DRL' : L === 'Grassroots' ? 'GR' : '';
    return (s ? ' · ' + s : '') + (x.drl && s !== 'DRL' ? ' · DRL' : '');
  }
  function minClock(m) { if (m === 1440) return t('avMidnight'); var h = Math.floor(m / 60), mm = m % 60, h12 = h % 12 === 0 ? 12 : h % 12; return h12 + (mm ? ':' + (mm < 10 ? '0' : '') + mm : '') + ' ' + (h < 12 ? 'AM' : 'PM'); }
  function dayWins(ds) { return ((S.asg && S.asg.availability) || []).filter(function (x) { return x.date === ds; }).sort(function (a, b) { return a.from_min - b.from_min; }); }
  function asgAvailHtml() {
    var a = S.asg, today = todayStr();
    var start = new Date(today + 'T12:00:00'); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    var weeks = [], d = new Date(start), end = shiftDate(today, 27);
    for (var w = 0; w < 5; w++) { var row = []; for (var i = 0; i < 7; i++) { row.push(iso(d)); d.setDate(d.getDate() + 1); } weeks.push(row); if (row[6] >= end) break; }
    var dows = S.lang === 'es' ? ['L', 'M', 'X', 'J', 'V', 'S', 'D'] : ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    var monthOf = function (ds) { return new Date(ds + 'T12:00:00').toLocaleDateString(S.lang === 'es' ? 'es-US' : 'en-US', { month: 'short' }); };
    var short = function (m) { var h = Math.floor(m / 60), mm = m % 60, h12 = h % 12 === 0 ? 12 : h % 12; return h12 + (mm ? ':' + (mm < 10 ? '0' : '') + mm : '') + (h < 12 ? 'a' : 'p'); };
    var cells = weeks.map(function (row) {
      return '<div class="avweek">' + row.map(function (ds) {
        var past = ds < today, dt = new Date(ds + 'T12:00:00');
        if (past) return '<div class="avday past"><span class="n">' + dt.getDate() + '</span></div>';
        var ws = dayWins(ds);
        var lbl = !ws.length ? '+' : (ws.length === 1 && ws[0].from_min === 0 && ws[0].to_min === 1440) ? esc(t('avAllShort')) : ws.slice(0, 2).map(function (x) { return short(x.from_min) + '-' + (x.to_min === 1440 ? '12a' : short(x.to_min)); }).join('<br>') + (ws.length > 2 ? '…' : '');
        return '<div class="avday' + (ds === AV.day ? ' games' : '') + (ds === today ? ' today' : '') + '"><span class="n">' + (dt.getDate() === 1 || ds === today ? monthOf(ds) + ' ' : '') + dt.getDate() + '</span><button class="avh' + (ws.length ? ' on' : '') + '" data-avday="' + ds + '" aria-label="' + esc(dayLong(ds)) + '" style="font-size:10px;line-height:1.25;min-height:34px;padding:2px 1px">' + lbl + '</button></div>';
      }).join('') + '</div>';
    }).join('');
    var ed = '';
    if (AV.day && AV.day >= today) {
      var ws2 = dayWins(AV.day);
      var dowName = new Date(AV.day + 'T12:00:00').toLocaleDateString(S.lang === 'es' ? 'es-US' : 'en-US', { weekday: 'long' });
      ed = '<div class="card" style="gap:8px;margin-top:10px"><b>' + esc(dayLong(AV.day)) + '</b>' +
        (ws2.length ? ws2.map(function (x) { return '<div class="rowline"><div>' + esc(minClock(x.from_min) + ' ' + t('avToWord') + ' ' + minClock(x.to_min)) + '</div><button class="chip-btn small" data-avdel="' + x.id + '" aria-label="' + esc(t('avRemove')) + '">✕</button></div>'; }).join('') : '<div class="hint">' + esc(t('avNoneDay')) + '</div>') +
        '<div class="chips"><button class="chip-btn small" data-avpre="0|1440">' + esc(t('avAllDay')) + '</button><button class="chip-btn small" data-avpre="0|720">' + esc(t('avMorning')) + '</button><button class="chip-btn small" data-avpre="720|1440">' + esc(t('avAfternoon')) + '</button></div>' +
        '<div class="grid2"><div><label class="hint" for="avFrom">' + esc(t('avFrom')) + '</label><input id="avFrom" type="time" value="' + esc(AV.from) + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"></div><div><label class="hint" for="avTo">' + esc(t('avTo')) + '</label><input id="avTo" type="time" value="' + esc(AV.to) + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"></div></div>' +
        '<div class="actions" style="padding:0"><button class="btn primary small" id="avAddW">' + esc(t('avAdd')) + '</button>' + (ws2.length ? '<button class="btn outline small" id="avCopyW">' + esc(t('avCopyDow').replace('{dow}', dowName)) + '</button>' : '') + '</div>' +
        '<div class="msg" id="avWMsg" hidden></div></div>';
    }
    var n = ((a && a.availability) || []).length;
    return fold('asgavail', t('asgAvailTitle'), n, '<div class="avcal"><div class="avweek head">' + dows.map(function (x) { return '<div class="avdow">' + x + '</div>'; }).join('') + '</div>' + cells + '</div><div class="hint">' + esc(t('avPick')) + '</div>' + ed + '<div class="hint">' + esc(t('asgAvailHint')) + '</div>', n === 0);
  }
  function asgDayHtml() {
    var a = S.asg;
    if (!a || !a.demo) return '';
    var offered = (a.offers || []).filter(function (o) { return o.status === 'offered'; });
    var accepted = (a.offers || []).filter(function (o) { return o.status === 'accepted'; });
    var expWhen = function (o) {
      var off = new Date(o.offered_at).getTime(), ko = new Date(o.kickoff).getTime();
      var e = Math.min(isNaN(off) ? Infinity : off + 48 * 3600000, isNaN(ko) ? Infinity : ko);
      if (!isFinite(e)) return '';
      return new Date(e).toLocaleString(S.lang === 'es' ? 'es-US' : 'en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    };
    var offCards = offered.map(function (o) {
      var ew = expWhen(o);
      return '<div class="card" style="border-color:var(--gold);gap:6px"><b>' + esc(t('asgOfferTitle')) + '</b><div>' + esc(asgGameLine(o)) + '. ' + esc(o.competition || '') + (o.age_group ? ', ' + esc(o.age_group) : '') + '. <b>' + asgSlotWord(o.slot) + '</b></div>' + (o.note ? '<div class="hint">' + esc(o.note) + '</div>' : '') + (ew ? '<div class="hint">' + esc(t('asgExpires').replace('{t}', ew)) + '</div>' : '') +
        '<div class="actions" style="padding:0"><button class="btn primary" data-asg-resp="accept" data-oid="' + o.id + '">' + esc(t('asgAccept')) + '</button><button class="btn outline" data-asg-resp="decline" data-oid="' + o.id + '">' + esc(t('asgDecline')) + '</button></div></div>';
    }).join('');
    var accList = accepted.length ? fold('asgacc', t('asgAccepted'), accepted.length, accepted.map(function (o) {
      return '<div class="rowline"><div><b>' + esc(asgGameLine(o)) + '</b><br><span class="hint">' + esc(o.competition || '') + ', ' + asgSlotWord(o.slot) + '</span></div><button class="chip-btn small" data-asg-resp="turn_back" data-oid="' + o.id + '">' + esc(t('asgTurnBack')) + '</button></div>';
    }).join(''), false) : '';
    return offCards + accList + asgAvailHtml() + '<div class="msg" id="asgMsg" hidden></div>';
  }
  function wireAsgDay(root) {
    root.querySelectorAll('[data-asg-resp]').forEach(function (b) { b.onclick = async function () {
      var act = b.getAttribute('data-asg-resp'), reason = null;
      if (act === 'turn_back') {
        reason = window.prompt(t('asgTurnWhy'));
        if (reason === null) return;
        if (!reason.trim()) { say('asgMsg', t('asgTurnNeedsWhy'), 'bad'); return; }
      }
      b.disabled = true;
      var r = await sb.rpc('asg_respond', { p_offer: parseInt(b.getAttribute('data-oid'), 10), p_action: act, p_reason: reason });
      if (r.error || !r.data) { b.disabled = false; say('asgMsg', r.error ? r.error.message : t('reviewFailed'), 'bad'); return; }
      var my = await sb.rpc('asg_my'); S.asg = my.data || S.asg;
      await loadDay(); renderAll();
    }; });
    var redraw = async function (refetch) {
      if (refetch) { var m = await sb.rpc('asg_my'); if (m.data) S.asg = m.data; }
      $('asgLine').innerHTML = asgDayHtml(); wireAsgDay($('asgLine'));
    };
    var addWins = async function (dates, from, to) {
      var have = {};
      (S.asg.availability || []).forEach(function (x) { have[x.date + '|' + x.from_min + '|' + x.to_min] = 1; });
      var rows = dates.filter(function (ds) { return !have[ds + '|' + from + '|' + to]; })
        .map(function (ds) { return { org_id: S.me.org_id, person_id: S.me.person_id, date: ds, from_min: from, to_min: to }; });
      if (!rows.length) return null;
      return await sb.from('ref_availability').insert(rows);
    };
    root.querySelectorAll('[data-avday]').forEach(function (c) { c.onclick = function () { var iv = $('avFrom'); if (iv) AV.from = iv.value; var it = $('avTo'); if (it) AV.to = it.value; AV.day = c.getAttribute('data-avday'); redraw(false); }; });
    root.querySelectorAll('[data-avpre]').forEach(function (b) { b.onclick = async function () {
      b.disabled = true;
      var p = b.getAttribute('data-avpre').split('|');
      var r = await addWins([AV.day], parseInt(p[0], 10), parseInt(p[1], 10));
      if (r && r.error) { b.disabled = false; say('avWMsg', r.error.message, 'bad'); return; }
      redraw(true);
    }; });
    var aw = $('avAddW'); if (aw) aw.onclick = async function () {
      var f = $('avFrom').value, to = $('avTo').value;
      if (!f || !to) { say('avWMsg', t('avNeedTimes'), 'bad'); return; }
      var fm = parseInt(f.slice(0, 2), 10) * 60 + parseInt(f.slice(3, 5), 10);
      var tm = parseInt(to.slice(0, 2), 10) * 60 + parseInt(to.slice(3, 5), 10);
      if (tm === 0) tm = 1440;
      if (tm <= fm) { say('avWMsg', t('avBadOrder'), 'bad'); return; }
      aw.disabled = true;
      var r = await addWins([AV.day], fm, tm);
      if (r && r.error) { aw.disabled = false; say('avWMsg', r.error.message, 'bad'); return; }
      AV.from = ''; AV.to = '';
      redraw(true);
    };
    root.querySelectorAll('[data-avdel]').forEach(function (b) { b.onclick = async function () {
      b.disabled = true;
      var r = await sb.from('ref_availability').delete().eq('person_id', S.me.person_id).eq('id', parseInt(b.getAttribute('data-avdel'), 10));
      if (r.error) { b.disabled = false; say('avWMsg', r.error.message, 'bad'); return; }
      redraw(true);
    }; });
    var cp = $('avCopyW'); if (cp) cp.onclick = async function () {
      cp.disabled = true;
      var today = todayStr(), targets = [];
      for (var k = 1; k <= 4; k++) { var dsk = shiftDate(AV.day, k * 7); if (dsk <= shiftDate(today, 27) && dsk >= today) targets.push(dsk); }
      var wins = dayWins(AV.day), err = null;
      for (var w = 0; w < wins.length; w++) { var r = await addWins(targets, wins[w].from_min, wins[w].to_min); if (r && r.error) err = r.error; }
      if (err) { cp.disabled = false; say('avWMsg', err.message, 'bad'); return; }
      redraw(true);
    };
  }
  async function loadAssign() {
    ASG.from = todayStr(); ASG.to = shiftDate(ASG.from, 20);
    var r = await Promise.all([
      sb.rpc('asg_board', { p_from: ASG.from, p_to: ASG.to }),
      sb.from('asg_demo').select('person_id')
    ]);
    ASG.board = r[0].data || [];
    var ids = (r[1].data || []).map(function (x) { return x.person_id; });
    ASG.roster = [];
    if (ids.length) { var p = await sb.from('people').select('id,first_name,last_name').in('id', ids).order('last_name'); ASG.roster = p.data || []; }
  }
  function asgSlotChip(g, slot) {
    var off = (g.offers || []).filter(function (o) { return o.slot === slot && (o.status === 'draft' || o.status === 'offered' || o.status === 'accepted'); })[0];
    var filled = slot === 'coach' ? (off && off.status === 'accepted' ? off.name : '') : g[slot];
    if (filled) return '<span class="chip-btn small on" style="pointer-events:none">' + asgSlotWord(slot) + ' ' + esc(filled) + '</span>';
    if (off && off.status === 'draft') return '<button class="chip-btn small" style="border-style:dashed;color:var(--muted)" data-asg-wd="' + off.id + '">' + asgSlotWord(slot) + ' ' + esc(off.name || '') + ' · ' + esc(t('asgDraftWord')) + ' ✕</button>';
    if (off && off.status === 'offered') return '<button class="chip-btn small" style="border-color:var(--gold)" data-asg-wd="' + off.id + '">' + asgSlotWord(slot) + ' ' + esc(off.name || '') + ' · ' + esc(t('asgOfferedChip')) + ' ✕</button>';
    var picking = ASG.pick && ASG.pick.game_id === g.game_id && ASG.pick.slot === slot;
    return '<button class="chip-btn small' + (picking ? ' on' : '') + '" data-asg-slot="' + g.game_id + '|' + slot + '">' + asgSlotWord(slot) + ' · ' + esc(t('asgOpen')) + '</button>';
  }
  function assignHtml() {
    var inp = function (id, v, type, ph) { return '<input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(v == null ? '' : v) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + ' style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">'; };
    var f = ASG.form;
    var form = !f ? '<div class="pad" style="padding-top:12px"><button class="btn outline" id="asgNew" style="width:100%">' + esc(t('asgNewGame')) + '</button></div>' :
      '<div class="card" style="gap:8px"><b>' + esc(t('asgNewGame')) + '</b>' +
      '<div class="grid2"><div><label class="hint">' + esc(t('eodDate')) + '</label>' + inp('agDate', f.date, 'date') + '</div><div><label class="hint">' + esc(t('asgKick')) + '</label>' + inp('agTime', f.time, 'time') + '</div></div>' +
      '<label class="hint">' + esc(t('eodVenue')) + '</label>' + inp('agVenue', f.venue) +
      '<div class="grid2"><div><label class="hint">' + esc(t('asgFieldL')) + '</label>' + inp('agField', f.field) + '</div><div><label class="hint">' + esc(t('asgAge')) + '</label>' + inp('agAge', f.age, 'text', 'U12') + '</div></div>' +
      '<label class="hint">' + esc(t('asgComp')) + '</label>' + inp('agComp', f.comp) +
      '<div class="grid2"><div><label class="hint">' + esc(t('asgHome')) + '</label>' + inp('agHome', f.home) + '</div><div><label class="hint">' + esc(t('asgAway')) + '</label>' + inp('agAway', f.away) + '</div></div>' +
      '<div class="actions" style="padding:0"><button class="btn primary" id="asgCreate">' + esc(t('asgCreate')) + '</button><button class="btn outline" id="asgCancel">' + esc(t('neverMind')) + '</button></div><div class="msg" id="agMsg" hidden></div></div>';
    var pickBox = function (g) {
      if (!ASG.pick || ASG.pick.game_id !== g.game_id) return '';
      var warns = ASG.warns ? (ASG.warns.warnings || []) : null;
      // The demo group first: most offers go to them, one tap, no typing.
      var quick = (ASG.roster || []).map(function (p) { return '<button class="chip-btn small' + (ASG.sel && ASG.sel.person_id === p.id ? ' on' : '') + '" data-asg-cand="' + p.id + '" data-asg-nm="' + esc(p.first_name + ' ' + p.last_name) + '">' + esc(p.first_name + ' ' + p.last_name) + '</button>'; }).join('');
      return '<div style="padding-top:8px"><div class="hint">' + esc(t('asgPickWho').replace('{slot}', asgSlotWord(ASG.pick.slot))) + '</div>' +
        (quick ? '<div class="chips" style="padding-top:8px">' + quick + '</div>' : '') +
        '<input id="asgQ" value="' + esc(ASG.q) + '" placeholder="' + esc(t('asgPickOther')) + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink);margin-top:6px">' +
        '<div class="chips" style="padding-top:8px">' + (ASG.cand || []).map(function (x) { return '<button class="chip-btn small' + (ASG.sel && ASG.sel.person_id === x.person_id ? ' on' : '') + '" data-asg-cand="' + x.person_id + '" data-asg-nm="' + esc(x.name) + '">' + esc(x.name) + (x.minor ? ' ●' : '') + esc(licTag(x)) + '</button>'; }).join('') + '</div>' +
        (ASG.sel ? '<div style="padding-top:6px">' + (warns && warns.length ? warns.map(function (w) { return '<div class="hint" style="color:var(--gold)">⚠ ' + esc(t('asgWarn.' + w)) + '</div>'; }).join('') : '<div class="hint" style="color:var(--green, #3DBA63)">' + esc(t('asgNoWarn')) + '</div>') +
          '<div class="actions" style="padding:8px 0 0;flex-wrap:wrap"><button class="btn primary small" id="asgSend">' + esc(t(ASG.draftMode ? 'asgHold' : 'asgSend').replace('{name}', ASG.sel.name)) + '</button><button class="chip-btn small' + (ASG.draftMode ? ' on' : '') + '" id="asgDraftTog">' + esc(t('asgDraftMode')) + '</button></div></div>' : '') +
        '<div class="msg" id="asgPickMsg" hidden></div></div>';
    };
    var crewOf = function (g) {
      var out = [];
      ['cr', 'ar1', 'ar2', 'fourth', 'coach'].forEach(function (s) {
        var o = (g.offers || []).filter(function (x) { return x.slot === s && (x.status === 'offered' || x.status === 'accepted'); })[0];
        if (o) out.push({ slot: s, person_id: o.person_id, name: o.name });
      });
      return out;
    };
    var slotOpen = function (g, s) {
      var active = (g.offers || []).some(function (o) { return o.slot === s && (o.status === 'offered' || o.status === 'accepted'); });
      return !active && (s === 'coach' || !g[s]);
    };
    var nextGameFor = function (g) {
      return (ASG.board || []).filter(function (x) {
        return x.game_id !== g.game_id && x.status !== 'C' && x.venue === g.venue && new Date(x.kickoff) > new Date(g.kickoff);
      }).sort(function (x, y) { return new Date(x.kickoff) - new Date(y.kickoff); })[0] || null;
    };
    var brFold = function () {
      var inner = '<div class="hint">' + esc(t('asgByRefHint')) + '</div>' +
        '<input id="asgBrQ" value="' + esc(ASG.brQ) + '" placeholder="' + esc(t('coachSearch')) + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink);margin-top:8px">' +
        '<div class="chips" style="padding-top:8px">' + (ASG.brCand || []).map(function (x) { return '<button class="chip-btn small' + (ASG.brSel && ASG.brSel.person_id === x.person_id ? ' on' : '') + '" data-asg-brsel="' + x.person_id + '" data-asg-nm="' + esc(x.name) + '">' + esc(x.name) + (x.minor ? ' ●' : '') + esc(licTag(x)) + '</button>'; }).join('') + '</div>';
      if (ASG.brSel && ASG.br) {
        var br = ASG.br;
        var byDay = {};
        (br.availability || []).forEach(function (w) { (byDay[w.date] = byDay[w.date] || { w: [], g: [], o: [] }).w.push(w); });
        (br.games || []).forEach(function (g) { (byDay[g.date] = byDay[g.date] || { w: [], g: [], o: [] }).g.push(g); });
        (br.offers || []).forEach(function (o) { (byDay[o.date] = byDay[o.date] || { w: [], g: [], o: [] }).o.push(o); });
        // Open hub slots by day, from the board already in hand.
        var openBy = {};
        (ASG.board || []).forEach(function (g) {
          if (g.status === 'C') return;
          ['cr', 'ar1', 'ar2', 'fourth'].forEach(function (s) {
            if (!slotOpen(g, s)) return;
            (openBy[g.date] = openBy[g.date] || []).push({ g: g, s: s });
          });
        });
        Object.keys(openBy).forEach(function (d) { byDay[d] = byDay[d] || { w: [], g: [], o: [] }; });
        var days = Object.keys(byDay).sort();
        inner += days.map(function (d) {
          var x = byDay[d];
          var h = '<div style="padding-top:10px"><b>' + esc(dayLong(d)) + '</b>';
          h += '<div class="hint">' + (x.w.length ? x.w.map(function (w) { return esc(minClock(w.from_min) + ' - ' + minClock(w.to_min)); }).join(', ') : esc(t('asgNoAvail'))) + '</div>';
          x.g.forEach(function (g) { h += '<div class="hint">' + esc(clock(g.kickoff)) + ' <b>' + esc(g.role) + '</b> · ' + esc(g.competition || '') + ' · ' + esc(g.venue || '') + (g.hub ? ' · Hub' : '') + '</div>'; });
          x.o.forEach(function (o) { h += '<div class="hint">' + esc(clock(o.kickoff)) + ' ' + asgSlotWord(o.slot) + ' · ' + esc(t('brSt.' + o.status)) + ' · ' + esc(o.venue || '') + '</div>'; });
          var opens = openBy[d] || [];
          if (opens.length) {
            h += '<div class="chips" style="padding-top:6px">' + opens.map(function (p) {
              var on = ASG.brPick && ASG.brPick.game_id === p.g.game_id && ASG.brPick.slot === p.s;
              return '<button class="chip-btn small' + (on ? ' on' : '') + '" data-asg-bro="' + p.g.game_id + '|' + p.s + '">' + esc(clock(p.g.kickoff)) + ' ' + asgSlotWord(p.s) + ' · ' + esc(p.g.venue || '') + '</button>';
            }).join('') + '</div>';
            if (ASG.brPick && opens.some(function (p) { return p.g.game_id === ASG.brPick.game_id && p.s === ASG.brPick.slot; })) {
              var warns = (ASG.brPick.warns && ASG.brPick.warns.warnings) || [];
              h += '<div style="padding-top:6px">' + (warns.length ? warns.map(function (w) { return '<div class="hint" style="color:var(--gold)">⚠ ' + esc(t('asgWarn.' + w)) + '</div>'; }).join('') : '<div class="hint" style="color:var(--green, #3DBA63)">' + esc(t('asgNoWarn')) + '</div>') +
                '<div class="actions" style="padding:6px 0 0"><button class="btn primary small" id="asgBrOffer">' + esc(t('asgBrOffer')) + '</button><button class="btn outline small" id="asgBrDraft">' + esc(t('asgBrDraft')) + '</button></div></div>';
            }
          }
          return h + '</div>';
        }).join('');
        inner += '<div class="msg" id="asgBrMsg" hidden></div>';
      }
      return fold('asgbyref', t('asgByRef'), ASG.brSel ? '' : '', inner, false);
    };
    var bcFold = function () {
      var dates = [], seenD = {};
      (ASG.board || []).forEach(function (g) { if (g.status !== 'C' && !seenD[g.date]) { seenD[g.date] = 1; dates.push(g.date); } });
      if (!dates.length) return '';
      var bc = ASG.bc || (ASG.bc = { date: dates[0], venue: '', why: '' });
      if (dates.indexOf(bc.date) < 0) bc.date = dates[0];
      var vens = [], seenV = {};
      (ASG.board || []).forEach(function (g) { if (g.status !== 'C' && g.date === bc.date && g.venue && !seenV[g.venue]) { seenV[g.venue] = 1; vens.push(g.venue); } });
      var n = (ASG.board || []).filter(function (g) { return g.status !== 'C' && g.date === bc.date && (!bc.venue || g.venue === bc.venue); }).length;
      var sel = function (id, opts, cur, allWord) {
        return '<select id="' + id + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">' +
          (allWord != null ? '<option value=""' + (cur ? '' : ' selected') + '>' + esc(allWord) + '</option>' : '') +
          opts.map(function (o) { return '<option value="' + esc(o) + '"' + (o === cur ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';
      };
      var inner = '<div class="hint">' + esc(t('asgBatchHint')) + '</div>' +
        '<div class="grid2" style="padding-top:8px"><div><label class="hint">' + esc(t('eodDate')) + '</label>' + sel('bcDate', dates, bc.date, null) + '</div>' +
        '<div><label class="hint">' + esc(t('eodVenue')) + '</label>' + sel('bcVenue', vens, bc.venue, t('asgFiltAll')) + '</div></div>' +
        '<label class="hint" for="bcWhy" style="display:block;padding-top:8px">' + esc(t('asgBatchWhy')) + '</label>' +
        '<input id="bcWhy" value="' + esc(bc.why) + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">' +
        '<div class="actions" style="padding:8px 0 0"><button class="btn outline small" id="bcGo" style="border-color:var(--red);color:var(--red)"' + (n ? '' : ' disabled') + '>' + esc(t('asgBatchBtn').replace('{n}', n)) + '</button></div>' +
        '<div class="msg" id="bcMsg" hidden></div>';
      return fold('asgbatch', t('asgBatchTitle'), '', inner, false);
    };
    var editBox = function (g) {
      var e = ASG.edit;
      if (!e || e.game_id !== g.game_id) {
        var nx = nextGameFor(g), copy = '', pub = '';
        if (nx && crewOf(g).some(function (c) { return slotOpen(nx, c.slot); })) copy = '<button class="chip-btn small" data-asg-copy="' + g.game_id + '">' + esc(t('asgCopyCrew')) + '</button>';
        var nd = (g.offers || []).filter(function (o) { return o.status === 'draft'; }).length;
        if (nd) pub = '<button class="chip-btn small" style="border-color:var(--gold);font-weight:700" data-asg-pub="' + g.game_id + '">' + esc(t('asgPublishGame').replace('{n}', nd)) + '</button>';
        return '<div class="chips" style="padding-top:4px">' + pub + '<button class="chip-btn small" data-asg-edit="' + g.game_id + '">' + esc(t('asgChangeBtn')) + '</button>' + copy + '<button class="chip-btn small" data-asg-cxl="' + g.game_id + '" style="border-color:var(--red)">' + esc(t('asgCxlBtn')) + '</button></div>';
      }
      return '<div style="padding-top:8px">' +
        '<div class="grid2"><div><label class="hint">' + esc(t('eodDate')) + '</label>' + inp('aeDate', e.date, 'date') + '</div><div><label class="hint">' + esc(t('asgKick')) + '</label>' + inp('aeTime', e.time, 'time') + '</div></div>' +
        '<label class="hint">' + esc(t('eodVenue')) + '</label>' + inp('aeVenue', e.venue) +
        '<label class="hint">' + esc(t('asgFieldL')) + '</label>' + inp('aeField', e.field) +
        '<div class="actions" style="padding:8px 0 0"><button class="btn primary small" id="asgESave">' + esc(t('asgSaveChange')) + '</button><button class="btn outline small" id="asgECancel">' + esc(t('neverMind')) + '</button></div><div class="msg" id="aeMsg" hidden></div></div>';
    };
    var gameCard = function (g) {
      var head = '<b>' + esc(dayLong(g.date)) + ', ' + esc(clock(g.kickoff)) + '</b><div class="hint">' + esc(g.venue || '') + (g.field ? ', ' + esc(g.field) : '') + '. ' + esc(g.competition || '') + (g.age_group ? ', ' + esc(g.age_group) : '') + (g.home ? '. ' + esc(g.home) + ' v ' + esc(g.away || '') : '') + '</div>';
      if (g.status === 'C') return '<div class="card" style="gap:6px;opacity:.65">' + head + '<div><span class="pill bad">' + esc(t('asgCanceledBadge')) + '</span></div></div>';
      return '<div class="card" style="gap:6px">' + head +
        '<div class="chips">' + ['cr', 'ar1', 'ar2', 'fourth', 'coach'].map(function (s) { return asgSlotChip(g, s); }).join('') + '</div>' + pickBox(g) + editBox(g) + '</div>';
    };
    var roster = fold('asgroster', t('asgRoster'), (ASG.roster || []).length,
      '<div class="hint">' + esc(t('asgRosterHint')) + '</div><div class="chips" style="padding-top:6px">' + (ASG.roster || []).map(function (p) { return '<button class="chip-btn small" data-asg-drop="' + p.id + '" data-asg-nm="' + esc(p.first_name + ' ' + p.last_name) + '">' + esc(p.first_name + ' ' + p.last_name) + ' ✕</button>'; }).join('') + '</div>' +
      '<input id="asgRq" value="' + esc(ASG.rq) + '" placeholder="' + esc(t('coachSearch')) + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink);margin-top:8px">' +
      '<div class="chips" style="padding-top:8px">' + (ASG.rcand || []).map(function (x) { return '<button class="chip-btn small" data-asg-addp="' + x.person_id + '">+ ' + esc(x.name) + (x.minor ? ' ●' : '') + esc(licTag(x)) + '</button>'; }).join('') + '</div><div class="msg" id="asgRMsg" hidden></div>', false);
    // Slots that opened back up after a decline or turnback, reasons attached.
    var attn = [];
    (ASG.board || []).forEach(function (g) {
      var open = {};
      ['cr', 'ar1', 'ar2', 'fourth', 'coach'].forEach(function (s) {
        var active = (g.offers || []).some(function (o) { return o.slot === s && (o.status === 'offered' || o.status === 'accepted'); });
        open[s] = !active && (s === 'coach' || !g[s]);
      });
      if (g.status === 'C') return;
      (g.offers || []).forEach(function (o) { if ((o.status === 'declined' || o.status === 'turned_back' || o.status === 'expired') && open[o.slot]) attn.push({ g: g, o: o }); });
    });
    var attnFold = attn.length ? fold('asgattn', t('asgAttnTitle'), attn.length, attn.map(function (x) {
      return '<div class="rowline"><div><b>' + esc(asgGameLine(x.g)) + ' · ' + asgSlotWord(x.o.slot) + '</b><br><span class="hint">' + esc(x.o.name || '') + ', ' + esc(t(x.o.status === 'declined' ? 'asgDeclinedWord' : x.o.status === 'expired' ? 'asgExpiredWord' : 'asgTurnedWord')) + (x.o.reason ? ': ' + esc(x.o.reason) : '') + '</span></div></div>';
    }).join(''), true) : '';
    var fvals = function (key) { var m = {}; (ASG.board || []).forEach(function (g) { if (g.status === 'C') return; var v = (g[key] || '').trim(); if (v) m[v] = 1; }); return Object.keys(m).sort(); };
    var frow = function (key) {
      var vs = fvals(key); if (vs.length < 2) { if (ASG.filt[key]) ASG.filt[key] = null; return ''; }
      return '<div class="chips" style="padding:2px 0">' +
        '<button class="chip-btn small' + (!ASG.filt[key] ? ' on' : '') + '" data-asg-filt="' + key + '|">' + esc(t('asgFiltAll')) + '</button>' +
        vs.map(function (v) { return '<button class="chip-btn small' + (ASG.filt[key] === v ? ' on' : '') + '" data-asg-filt="' + key + '|' + esc(v) + '">' + esc(v) + '</button>'; }).join('') + '</div>';
    };
    var filters = frow('venue') + frow('competition') + frow('age_group');
    var shown = (ASG.board || []).filter(function (g) {
      return ['venue', 'competition', 'age_group'].every(function (k) { return !ASG.filt[k] || (g[k] || '').trim() === ASG.filt[k]; });
    });
    var totalDrafts = 0;
    (ASG.board || []).forEach(function (g) { (g.offers || []).forEach(function (o) { if (o.status === 'draft') totalDrafts++; }); });
    var pubAll = totalDrafts ? '<div class="pad" style="padding-top:8px"><button class="btn primary" id="asgPubAll" style="width:100%">' + esc(t('asgPublishAll').replace('{n}', totalDrafts)) + '</button></div>' : '';
    return form + pubAll + attnFold + brFold() + bcFold() + '<div class="disp h2">' + esc(t('asgGamesTitle')) + '</div>' + filters +
      (shown.length ? shown.map(gameCard).join('') : '<div class="pad hint">' + esc(t('asgNone')) + '</div>') + roster;
  }
  function wireAssign(root) {
    var nb = $('asgNew'); if (nb) nb.onclick = function () { ASG.form = { date: todayStr(), time: '', venue: '', field: '', age: '', comp: '', home: '', away: '' }; renderAssign(); };
    var cb = $('asgCancel'); if (cb) cb.onclick = function () { ASG.form = null; renderAssign(); };
    var cr = $('asgCreate'); if (cr) cr.onclick = async function () {
      var f = ASG.form; f.date = $('agDate').value; f.time = $('agTime').value; f.venue = $('agVenue').value.trim(); f.field = $('agField').value.trim(); f.age = $('agAge').value.trim(); f.comp = $('agComp').value.trim(); f.home = $('agHome').value.trim(); f.away = $('agAway').value.trim();
      if (!f.date || !f.time || !f.venue) { say('agMsg', t('asgNeedFields'), 'bad'); return; }
      cr.disabled = true;
      var kick = new Date(f.date + 'T' + f.time + ':00');
      var r = await sb.rpc('asg_add_game', { p: { date: f.date, kickoff: kick.toISOString(), venue: f.venue, field: f.field, age_group: f.age, competition: f.comp, home: f.home, away: f.away } });
      if (r.error || !r.data) { cr.disabled = false; say('agMsg', r.error ? r.error.message : t('reviewFailed'), 'bad'); return; }
      ASG.form = null; await loadAssign(); renderAssign();
    };
    root.querySelectorAll('[data-asg-slot]').forEach(function (b) { b.onclick = function () { var p = b.getAttribute('data-asg-slot').split('|'); ASG.pick = { game_id: parseInt(p[0], 10), slot: p[1] }; ASG.q = ''; ASG.cand = null; ASG.sel = null; ASG.warns = null; renderAssign(); var q = $('asgQ'); if (q) q.focus(); }; });
    root.querySelectorAll('[data-asg-wd]').forEach(function (b) { b.onclick = async function () { if (!window.confirm(t('asgWithdrawConfirm'))) return; b.disabled = true; await sb.rpc('asg_withdraw', { p_offer: parseInt(b.getAttribute('data-asg-wd'), 10) }); await loadAssign(); renderAssign(); }; });
    root.querySelectorAll('[data-asg-edit]').forEach(function (b) { b.onclick = function () {
      var gid = parseInt(b.getAttribute('data-asg-edit'), 10);
      var g = (ASG.board || []).filter(function (x) { return x.game_id === gid; })[0]; if (!g) return;
      var k = new Date(g.kickoff);
      ASG.edit = { game_id: gid, date: g.date, time: String(k.getHours()).padStart(2, '0') + ':' + String(k.getMinutes()).padStart(2, '0'), venue: g.venue || '', field: g.field || '' };
      renderAssign();
    }; });
    var ec = $('asgECancel'); if (ec) ec.onclick = function () { ASG.edit = null; renderAssign(); };
    var es_ = $('asgESave'); if (es_) es_.onclick = async function () {
      var e = ASG.edit, d = $('aeDate').value, tm = $('aeTime').value, v = $('aeVenue').value.trim(), fl = $('aeField').value.trim();
      if (!d || !tm || !v) { say('aeMsg', t('asgNeedFields'), 'bad'); return; }
      es_.disabled = true;
      var kick = new Date(d + 'T' + tm + ':00');
      var r = await sb.rpc('asg_change_game', { p_game: e.game_id, p_kickoff: kick.toISOString(), p_venue: v, p_field: fl });
      if (r.error) { es_.disabled = false; say('aeMsg', r.error.message, 'bad'); return; }
      ASG.edit = null; await loadAssign(); renderAssign();
    };
    root.querySelectorAll('[data-asg-cxl]').forEach(function (b) { b.onclick = async function () {
      var gid = parseInt(b.getAttribute('data-asg-cxl'), 10);
      var why = window.prompt(t('asgCxlWhy')); if (!why || !why.trim()) return;
      if (!window.confirm(t('asgCxlConfirm'))) return;
      b.disabled = true;
      await sb.rpc('asg_cancel_game', { p_game: gid, p_reason: why.trim() });
      await loadAssign(); renderAssign();
    }; });
    root.querySelectorAll('[data-asg-filt]').forEach(function (b) { b.onclick = function () {
      var raw = b.getAttribute('data-asg-filt'), i = raw.indexOf('|');
      ASG.filt[raw.slice(0, i)] = raw.slice(i + 1) || null; renderAssign();
    }; });
    root.querySelectorAll('[data-asg-copy]').forEach(function (b) { b.onclick = async function () {
      var gid = parseInt(b.getAttribute('data-asg-copy'), 10);
      var g = (ASG.board || []).filter(function (x) { return x.game_id === gid; })[0]; if (!g) return;
      var crew = [], o = (g.offers || []);
      ['cr', 'ar1', 'ar2', 'fourth', 'coach'].forEach(function (s) {
        var x = o.filter(function (y) { return y.slot === s && (y.status === 'offered' || y.status === 'accepted'); })[0];
        if (x) crew.push({ slot: s, person_id: x.person_id, name: x.name });
      });
      var nx = (ASG.board || []).filter(function (x) {
        return x.game_id !== gid && x.status !== 'C' && x.venue === g.venue && new Date(x.kickoff) > new Date(g.kickoff);
      }).sort(function (x, y) { return new Date(x.kickoff) - new Date(y.kickoff); })[0];
      if (!nx) return;
      var open = function (s) { var act = (nx.offers || []).some(function (y) { return y.slot === s && (y.status === 'offered' || y.status === 'accepted'); }); return !act && (s === 'coach' || !nx[s]); };
      var todo = crew.filter(function (c) { return open(c.slot); });
      if (!todo.length) return;
      if (!window.confirm(t('asgCopyConfirm').replace('{venue}', g.venue || '').replace('{names}', todo.map(function (c) { return c.name || ''; }).join(', ')))) return;
      b.disabled = true;
      for (var i = 0; i < todo.length; i++) {
        await sb.rpc('asg_offer', { p_game: nx.game_id, p_slot: todo[i].slot, p_person: todo[i].person_id, p_note: null });
      }
      await loadAssign(); renderAssign();
    }; });
    var q = $('asgQ');
    if (q) {
      var qt = null;
      q.oninput = function () { clearTimeout(qt); qt = setTimeout(async function () { ASG.q = q.value.trim(); if (ASG.q.length < 2) { ASG.cand = null; return; } var r = await sb.rpc('co90_find_person', { p_q: ASG.q }); ASG.cand = r.data || []; ASG.sel = null; ASG.warns = null; renderAssign(); var nq = $('asgQ'); if (nq) { nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); } }, 350); };
    }
    root.querySelectorAll('[data-asg-cand]').forEach(function (b) { b.onclick = async function () {
      var pid = parseInt(b.getAttribute('data-asg-cand'), 10);
      ASG.sel = { person_id: pid, name: b.getAttribute('data-asg-nm') || '' };
      var r = await sb.rpc('asg_check', { p_person: pid, p_game: ASG.pick.game_id });
      ASG.warns = r.data || { warnings: [] };
      renderAssign();
    }; });
    var sd = $('asgSend'); if (sd) sd.onclick = async function () {
      sd.disabled = true;
      var r = await sb.rpc('asg_offer', { p_game: ASG.pick.game_id, p_slot: ASG.pick.slot, p_person: ASG.sel.person_id, p_note: null, p_draft: ASG.draftMode });
      if (r.error) { sd.disabled = false; say('asgPickMsg', r.error.message, 'bad'); return; }
      ASG.pick = null; ASG.sel = null; ASG.cand = null; await loadAssign(); renderAssign();
    };
    var dtg = $('asgDraftTog'); if (dtg) dtg.onclick = function () { ASG.draftMode = !ASG.draftMode; renderAssign(); };
    var pa = $('asgPubAll'); if (pa) pa.onclick = async function () {
      if (!window.confirm(t('asgPublishConfirm'))) return;
      pa.disabled = true;
      await sb.rpc('asg_publish', {});
      await loadAssign(); renderAssign();
    };
    root.querySelectorAll('[data-asg-pub]').forEach(function (b) { b.onclick = async function () {
      if (!window.confirm(t('asgPublishConfirm'))) return;
      b.disabled = true;
      await sb.rpc('asg_publish', { p_game: parseInt(b.getAttribute('data-asg-pub'), 10) });
      await loadAssign(); renderAssign();
    }; });
    var brq = $('asgBrQ');
    if (brq) {
      var brt;
      brq.oninput = function () { clearTimeout(brt); brt = setTimeout(async function () { ASG.brQ = brq.value.trim(); if (ASG.brQ.length < 2) { ASG.brCand = null; return; } var r = await sb.rpc('co90_find_person', { p_q: ASG.brQ }); ASG.brCand = r.data || []; renderAssign(); var n = $('asgBrQ'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 350); };
    }
    root.querySelectorAll('[data-asg-brsel]').forEach(function (b) { b.onclick = async function () {
      var pid = parseInt(b.getAttribute('data-asg-brsel'), 10);
      ASG.brSel = { person_id: pid, name: b.getAttribute('data-asg-nm') || '' };
      ASG.brPick = null;
      var r = await sb.rpc('asg_person_week', { p_person: pid });
      ASG.br = r.data || null;
      renderAssign();
    }; });
    root.querySelectorAll('[data-asg-bro]').forEach(function (b) { b.onclick = async function () {
      var p = b.getAttribute('data-asg-bro').split('|');
      ASG.brPick = { game_id: parseInt(p[0], 10), slot: p[1], warns: null };
      var r = await sb.rpc('asg_check', { p_person: ASG.brSel.person_id, p_game: ASG.brPick.game_id });
      ASG.brPick.warns = r.data || { warnings: [] };
      renderAssign();
    }; });
    var brGo = async function (draft) {
      var r = await sb.rpc('asg_offer', { p_game: ASG.brPick.game_id, p_slot: ASG.brPick.slot, p_person: ASG.brSel.person_id, p_note: null, p_draft: draft });
      if (r.error) { say('asgBrMsg', r.error.message, 'bad'); return; }
      ASG.brPick = null;
      await loadAssign();
      var rw = await sb.rpc('asg_person_week', { p_person: ASG.brSel.person_id });
      ASG.br = rw.data || null;
      renderAssign();
    };
    var bo = $('asgBrOffer'); if (bo) bo.onclick = function () { bo.disabled = true; brGo(false); };
    var bd = $('asgBrDraft'); if (bd) bd.onclick = function () { bd.disabled = true; brGo(true); };
    var bcd = $('bcDate'); if (bcd) bcd.onchange = function () { ASG.bc.date = bcd.value; ASG.bc.venue = ''; renderAssign(); };
    var bcv = $('bcVenue'); if (bcv) bcv.onchange = function () { ASG.bc.venue = bcv.value; var w = $('bcWhy'); if (w) ASG.bc.why = w.value; renderAssign(); };
    var bcw = $('bcWhy'); if (bcw) bcw.oninput = function () { ASG.bc.why = bcw.value; };
    var bcg = $('bcGo'); if (bcg) bcg.onclick = async function () {
      var why = (ASG.bc.why || '').trim();
      if (!why) { say('bcMsg', t('asgTurnNeedsWhy'), 'bad'); return; }
      if (!window.confirm(t('asgBatchConfirm'))) return;
      bcg.disabled = true;
      var r = await sb.rpc('asg_cancel_batch', { p_date: ASG.bc.date, p_venue: ASG.bc.venue || null, p_reason: why });
      if (r.error) { bcg.disabled = false; say('bcMsg', r.error.message, 'bad'); return; }
      ASG.bc = null; await loadAssign(); renderAssign();
    };
    var rq = $('asgRq');
    if (rq) {
      var rt = null;
      rq.oninput = function () { clearTimeout(rt); rt = setTimeout(async function () { ASG.rq = rq.value.trim(); if (ASG.rq.length < 2) { ASG.rcand = null; return; } var r = await sb.rpc('co90_find_person', { p_q: ASG.rq }); ASG.rcand = r.data || []; renderAssign(); var n = $('asgRq'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 350); };
    }
    root.querySelectorAll('[data-asg-addp]').forEach(function (b) { b.onclick = async function () {
      b.disabled = true;
      var r = await sb.from('asg_demo').insert({ org_id: S.me.org_id, person_id: parseInt(b.getAttribute('data-asg-addp'), 10), added_by: S.me.person_id });
      if (r.error) { say('asgRMsg', r.error.message, 'bad'); b.disabled = false; return; }
      ASG.rq = ''; ASG.rcand = null; await loadAssign(); renderAssign();
    }; });
    root.querySelectorAll('[data-asg-drop]').forEach(function (b) { b.onclick = async function () {
      if (!window.confirm(t('asgDropConfirm').replace('{name}', b.getAttribute('data-asg-nm') || ''))) return;
      b.disabled = true;
      var r = await sb.from('asg_demo').delete().eq('person_id', parseInt(b.getAttribute('data-asg-drop'), 10));
      if (r.error) { say('asgRMsg', r.error.message, 'bad'); b.disabled = false; return; }
      await loadAssign(); renderAssign();
    }; });
  }
  function renderAssign() { $('assignBody').innerHTML = assignHtml(); wireAssign($('assignBody')); }

  // ── Premium pay (Tiers 1 to 3; grassroots only; Director of Referee
  //    Operations FAQ, October 2026 R2) ─────────────────────────────
  var PREM = { tier: 0, edu: '', dg: '' };
  function premiumHtml() {
    var p = S.prem;
    if (!p || !p.check || p.check.advanced) return '';
    var c = p.check, a = p.app && p.app.status !== 'withdrawn' ? p.app : null;
    var inner;
    if (a) {
      inner = '<div><span class="pill' + (a.status === 'approved' ? ' ok' : a.status === 'denied' ? ' bad' : '') + '">' + esc(t('premTier').replace('{n}', a.status === 'approved' && a.tier_approved ? a.tier_approved : a.tier)) + ' · ' + esc(t('premSt.' + a.status)) + '</span></div>' +
        (a.note ? '<div class="hint" style="padding-top:6px">' + esc(a.note) + '</div>' : '') +
        ((a.education || []).length ? '<div class="hint" style="padding-top:6px">' + a.education.map(function (e) { return '• ' + esc(e.text || ''); }).join('<br>') + '</div>' : '') +
        (a.status === 'submitted' ? '<div class="actions" style="padding:8px 0 0"><button class="btn outline small" id="premWd">' + esc(t('premWithdraw')) + '</button></div>' : '');
    } else if (c.drl) {
      inner = '<div class="hint">' + esc(t('premDrlNo')) + '</div>';
    } else {
      var okRow = function (b, txt) { return '<div class="hint">' + (b ? '✓ ' : '✗ ') + esc(txt) + '</div>'; };
      var eligible = (c.seasons || 0) >= 2 && (c.centers || 0) >= 10;
      inner = okRow((c.seasons || 0) >= 2, t('premReqCert')) + okRow((c.centers || 0) >= 10, t('premReqCenters').replace('{n}', c.centers || 0)) + okRow(!!c.fitness_date, t('premReqFit')) +
        '<div class="hint" style="padding-top:6px">' + esc(t('premPick')) + '</div><div class="chips">' + [1, 2, 3].map(function (n) { return '<button class="chip-btn small' + (PREM.tier === n ? ' on' : '') + '" data-prem-tier="' + n + '">' + esc(t('premTier').replace('{n}', n)) + ' · $' + (n === 1 ? '5' : n === 2 ? '7.50' : '10') + '</button>'; }).join('') + '</div>' +
        (PREM.tier ? '<label class="hint" for="premEdu" style="display:block;padding-top:8px">' + esc(t('premEduLabel')) + '</label><textarea id="premEdu" style="min-height:80px">' + esc(PREM.edu || '') + '</textarea>' +
          (PREM.tier >= 2 ? '<label class="hint" for="premDgIn" style="display:block;padding-top:8px">' + esc(t('premDgLabel')) + '</label><input id="premDgIn" value="' + esc(PREM.dg || '') + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">' : '') +
          '<div class="actions" style="padding:8px 0 0"><button class="btn primary small"' + (eligible ? '' : ' disabled') + ' id="premGo">' + esc(t('premSubmit')) + '</button></div>' : '') +
        '<div class="msg" id="premMsg" hidden></div>';
    }
    return fold('premium', t('premTitle').replace('{y}', p.season || ''), a ? 1 : '', '<div class="hint">' + esc(t('premLead')) + ' <a href="' + (C.library || 'library.html') + '#career-premium" target="_blank" rel="noopener">' + esc(t('premFaq')) + '</a></div>' + inner, false);
  }
  function wirePremium(root) {
    root.querySelectorAll('[data-prem-tier]').forEach(function (b) { b.onclick = function () { var ed = $('premEdu'); if (ed) PREM.edu = ed.value; var dg = $('premDgIn'); if (dg) PREM.dg = dg.value; PREM.tier = parseInt(b.getAttribute('data-prem-tier'), 10); $('premiumLine').innerHTML = premiumHtml(); wirePremium($('premiumLine')); }; });
    var go = $('premGo'); if (go) go.onclick = async function () {
      PREM.edu = $('premEdu') ? $('premEdu').value.trim() : '';
      PREM.dg = $('premDgIn') ? $('premDgIn').value.trim() : '';
      if (!PREM.edu) { say('premMsg', t('premNeedEdu'), 'bad'); return; }
      go.disabled = true;
      var rows = PREM.edu.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) { return { text: l }; });
      var r = await sb.from('premium_apps').insert({ org_id: S.me.org_id, person_id: S.me.person_id, season: S.prem.season, tier: PREM.tier, education: rows, dg_note: PREM.tier >= 2 && PREM.dg ? PREM.dg : null });
      if (r.error) { go.disabled = false; say('premMsg', r.error.message, 'bad'); return; }
      var m = await sb.rpc('premium_mine'); S.prem = m.data || S.prem; PREM.tier = 0; PREM.edu = ''; PREM.dg = '';
      $('premiumLine').innerHTML = premiumHtml(); wirePremium($('premiumLine'));
    };
    var wd = $('premWd'); if (wd) wd.onclick = async function () {
      if (!window.confirm(t('premWdConfirm'))) return;
      wd.disabled = true;
      var r = await sb.from('premium_apps').update({ status: 'withdrawn' }).eq('id', S.prem.app.id);
      if (r.error) { wd.disabled = false; return; }
      var m = await sb.rpc('premium_mine'); S.prem = m.data || S.prem;
      $('premiumLine').innerHTML = premiumHtml(); wirePremium($('premiumLine'));
    };
  }

  function renderDay() {
    var me = S.me, h = new Date().getHours();
    var greet = t(h < 12 ? 'greeting.morning' : h < 17 ? 'greeting.afternoon' : 'greeting.evening');
    var venue = S.games.length ? S.games[0].venue : '';
    $('dayLead').textContent = greet + ', ' + me.first_name + '. ' + dayLong() + (venue ? ', ' + venue : '') + '.';
    var g = nextGame();
    var cd = $('countdown');
    if (g) {
      cd.style.display = 'flex';
      tickCountdown();
      $('nextCard').innerHTML = cardHtml(g);
      wireCheckin(g, $('nextCard')); wireLate($('nextCard'));
    } else {
      cd.style.display = 'none';
      $('nextCard').innerHTML = '<div class="card"><div class="disp" style="font-size:28px">' + esc(t('noGamesToday')) + '</div><div class="hint">' + esc(t('noGamesHint')) + '</div></div>';
    }
    var laterAll = S.games.filter(function (x) { return x !== g; });
    var done = laterAll.filter(function (x) { return gameState(x) === 'done'; }), later = laterAll.filter(function (x) { return gameState(x) !== 'done'; });
    var rowOf = function (x) {
      var inAt = S.checkins[String(x.game_id)];
      return '<a class="item" href="#game/' + esc(x.game_id) + '"><div class="when"><div class="disp">' + esc(clock(x.kickoff)) + '</div><div class="sub">' + (isHQ(x) ? esc(t('refereeHQ')) + ', ' + esc(x.venue || '') : esc(x.field || '') + ', ' + esc(x.age_group || '')) + '</div></div>' +
        (inAt ? '<div class="state in"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="8" fill="currentColor"></circle><path d="M5.5 9.5l2.3 2.3L12.8 6.8" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>' + esc(t('checkedIn').charAt(0) + t('checkedIn').slice(1).toLowerCase()) + '</div>' : '') + '</a>';
    };
    $('laterList').innerHTML = (later.length ? '<div class="hint" style="padding-bottom:8px;font-weight:700">' + esc(t('laterToday')) + '</div>' + later.map(rowOf).join('') : '') +
      (done.length ? fold('day-done', t('doneToday'), done.length, done.map(rowOf).join(''), false) : '');
    var up = $('dayUpcoming');
    if (S.me.previewing) { up.innerHTML = '<div class="hint" style="padding:12px 0 6px;font-weight:700">' + esc(t('upTitleAdmin')) + '</div><div class="hint">' + esc(t('loadingReview')) + '</div>'; upcomingFor(S.me.first_name + ' ' + S.me.last_name, 90).then(function (list) { up.innerHTML = '<div class="hint" style="padding:12px 0 6px;font-weight:700">' + esc(t('upTitleAdmin')) + '</div>' + upcomingHtml(list.filter(function (g) { return g.date !== todayStr(); }), S.me.first_name + ' ' + S.me.last_name); }).catch(function () { up.innerHTML = ''; }); }
    else up.innerHTML = '';
    var note = S.notes[0];
    if (note) markRead([note]);
    $('noteBox').innerHTML = note ? '<div class="note"><div class="who">' + esc(note.observer || '') + (note.rater_role ? ', ' + esc(note.rater_role) : '') + (note.date ? ', ' + esc(t('noteFrom')) + ' ' + esc(dayLong(note.date)) : '') + '</div><div class="text">' + esc(note.final_note || note.cleaned_note || '') + '</div><a href="#notes">' + esc(t('allNotes')) + '</a></div>'
      : '<div class="note"><div class="text hint">' + esc(t('noNotes')) + '</div></div>';
    var lateLine = (S.lateOpen || []).length ? '<a class="rowbtn" href="#ops" style="margin-top:10px;border-color:var(--red)"><span><span class="t">' + esc(t('lateOpenTitle').replace('{n}', S.lateOpen.length)) + '</span><br><span class="s">' + esc(S.lateOpen.map(function (l) { return l.ref_name + ', ' + (l.venue || '') + (l.field ? ' ' + fieldShort(l.field) : '') + ', ' + (l.eta_min || '') + ' min'; }).slice(0, 3).join('. ')) + '</span></span></a>' : '';
    var evalLine = (S.evalWaiting || []).length ? '<a class="rowbtn" href="#center/evals" style="margin-top:10px;border-color:var(--red)"><span><span class="t">' + esc(t('evalWaitingTitle').replace('{n}', S.evalWaiting.length)) + '</span><br><span class="s">' + esc(S.evalWaiting.slice(0, 3).map(function (q) { return q.ref_name + ', ' + dayShort(q.game_date); }).join('. ')) + '</span></span></a>' : '';
    $('staffLine').innerHTML = lateLine + evalLine + ((S.staffMsgs || []).length ? '<a class="rowbtn" href="#ops" data-tab="staff" style="margin-top:10px;border-color:var(--gold)"><span><span class="t">' + esc(t('smTodayTitle').replace('{n}', S.staffMsgs.length)) + '</span><br><span class="s">' + esc((S.staffMsgs[0].from_name || '') + ': ' + S.staffMsgs[0].body.slice(0, 90)) + '</span></span></a>' : '');
    var coachedHere = S.games.some(function (x) { return (S.coachedVenues || []).indexOf(x.venue) >= 0; });
    var myEval = (ER.mine || []).filter(function (r) { return r.ref_person_id === S.me.person_id && (r.status === 'assigned' || r.status === 'requested') && r.game_date >= todayStr(); })[0];
    var coachEvals = iCan('evaluations') ? (ER.mine || []).filter(function (r) { return r.coach_person_id === S.me.person_id && r.status === 'assigned' && r.game_date >= todayStr(); }) : [];
    var coachEvalHtml = coachEvals.map(function (r) { return '<div class="card" style="border-color:var(--red);gap:6px"><b>' + esc(t('evalYouAssigned')) + '</b><div>' + refLink(r.ref_name) + ', ' + esc(dayLong(r.game_date)) + ', ' + esc(r.venue || '') + '. ' + esc(t('evalPurpose.' + r.purpose)) + '</div><div class="actions" style="padding:0"><a class="btn primary" href="evaluator.html?gameId=' + esc(r.game_id) + '">' + esc(t('evalOpenEvaluator')) + '</a><a class="btn outline" href="#coach/game/' + esc(r.game_id) + '">' + esc(t('details')) + '</a></div></div>'; }).join('');
    $('co90Line').innerHTML = co90DayHtml();
    $('asgLine').innerHTML = asgDayHtml(); wireAsgDay($('asgLine'));
    $('sessionsLine').innerHTML = signupCardHtml(); wireSignup($('sessionsLine'));
    $('premiumLine').innerHTML = premiumHtml(); wirePremium($('premiumLine'));
    renderWrap();
    if (ER.prog === undefined) { ER.prog = null; sb.rpc('eval_progress').then(function (pr) { ER.prog = pr.data || null; var el = $('evalProg'); if (el) el.innerHTML = progressHtml(ER.prog); }); }
    $('evalLine').innerHTML = coachEvalHtml + '<div id="evalProg">' + progressHtml(ER.prog) + '</div>' + (myEval ? '<div class="card" style="border-color:var(--gold);gap:4px"><b>' + esc(t('evalReqTitle')) + '</b><div>' + esc(dayLong(myEval.game_date)) + ', ' + esc(myEval.venue || '') + '. ' + esc(t('evalPurpose.' + myEval.purpose)) + '. ' + esc(t('evalStatus.' + myEval.status)) + '</div></div>' : '');
    $('bulletins').innerHTML = (coachedHere ? '<div class="bulletin"><svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="9" stroke="currentColor" stroke-width="2"></circle><path d="M7 11.5l3 3 5-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg><div class="text">' + esc(t('coachHereToday')) + ' <a href="#" id="badgeLink">' + esc(t('lanyard')) + '</a><div id="badgeBox" hidden style="margin-top:8px"><img src="assets/badge.png" alt="" style="width:130px;border-radius:8px"><div class="hint">' + esc(t('badgeCaption')) + '</div></div></div></div>' : '') + S.bulletins.slice(0, 2).map(function (b) {
      return '<div class="bulletin"><svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="9" stroke="currentColor" stroke-width="2"></circle><path d="M11 6v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path><circle cx="11" cy="15.5" r="1.2" fill="currentColor"></circle></svg><div class="text">' + (b.title ? '<b>' + esc(b.title) + '</b> ' : '') + esc(b.body || '') + ' <span>' + esc(t('fromState')) + '.</span></div></div>';
    }).join('');
    $('coachEntry').innerHTML = iCan('coaching') ? '<a class="rowbtn" href="#coach" style="margin-top:14px"><span><span class="t">' + esc(t('coachingEntry')) + '</span><br><span class="s">' + esc(t('coachingEntryHint')) + '</span></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>' : '';
    $('reviewEntry').innerHTML = iCan('review') ? '<a class="rowbtn" href="#review" style="margin-top:8px"><span><span class="t">' + esc(t('reviewEntry')) + '</span><br><span class="s">' + esc(t('reviewEntryHint')) + '</span></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>' : '';
    $('centerEntry').innerHTML = iCan('review') ? '<a class="rowbtn" href="#center" style="margin-top:8px"><span><span class="t">' + esc(t('centerEntry')) + '</span><br><span class="s">' + esc(t('centerEntryHint')) + '</span></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>' : '';
    $('stateEntry').innerHTML = iCan('state_view') ? '<a class="rowbtn" href="#state" style="margin-top:8px"><span><span class="t">' + esc(t('stateEntry')) + '</span><br><span class="s">' + esc(t('stateEntryHint')) + '</span></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>' : '';
    $('opsEntry').innerHTML = iCan('command_center') ? '<a class="rowbtn" href="#ops" style="margin-top:8px"><span><span class="t">' + esc(t('opsEntry')) + '</span><br><span class="s">' + esc(t('opsEntryHint')) + '</span></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>' : '';
    $('asgEntry').innerHTML = iCan('assigning') ? '<a class="rowbtn" href="#assign" style="margin-top:8px"><span><span class="t">' + esc(t('asgEntryT')) + '</span><br><span class="s">' + esc(t('asgEntryHint')) + '</span></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>' : '';
    var pb = $('previewBar');
    if (S.me.previewing) { pb.style.display = 'flex'; $('previewText').textContent = t('previewing').replace('{name}', S.me.first_name + ' ' + S.me.last_name) + ' ' + t('previewNoWrite'); $('previewStop').textContent = t('previewStop'); $('previewStop').onclick = async function () { await sb.rpc('clear_preview'); location.hash = ''; start(); }; }
    else pb.style.display = 'none';
    $('viewAsEntry').innerHTML = S.me.real_admin && !S.me.previewing ? '<div class="card" style="gap:8px;margin-top:8px"><div class="hint" style="font-weight:700">' + esc(t('viewAs')) + '</div><div class="hint">' + esc(t('viewAsHint')) + '</div><div class="go"><input id="viewAsQ" placeholder="' + esc(t('coachSearch')) + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"><button class="btn outline" id="viewAsGo">' + esc(t('go')) + '</button></div><div class="chips" id="viewAsPicks"></div><div class="msg" id="viewAsMsg" hidden></div></div>' : '';
    var vq = $('viewAsQ');
    if (vq) {
      var vt = null;
      var runViewAs = async function () {
          var q = vq.value.trim(); if (q.length < 2) { $('viewAsPicks').innerHTML = ''; return; }
          busy(true);
          var parts = q.split(/\s+/);
          var qr = sb.from('people').select('id,first_name,last_name,city').limit(10);
          qr = parts.length >= 2 ? qr.ilike('first_name', parts[0] + '%').ilike('last_name', parts.slice(1).join(' ') + '%') : qr.or('last_name.ilike.' + parts[0] + '*,first_name.ilike.' + parts[0] + '*');
          var r = await qr.order('last_name');
          busy(false);
          var m = $('viewAsMsg');
          if (r.error) { m.hidden = false; m.className = 'msg bad'; m.textContent = r.error.message; return; }
          m.hidden = (r.data || []).length > 0; m.className = 'msg'; m.textContent = t('noMatchShort');
          $('viewAsPicks').innerHTML = (r.data || []).map(function (p) { return '<button class="chip-btn" data-viewas="' + p.id + '">' + esc(p.first_name + ' ' + p.last_name) + (p.city ? ' <small>' + esc(p.city) + '</small>' : '') + '</button>'; }).join('');
          $('viewAsPicks').querySelectorAll('[data-viewas]').forEach(function (b) { b.onclick = async function () { b.disabled = true; busy(true); var rr = await sb.rpc('set_preview', { p_target: parseInt(b.getAttribute('data-viewas'), 10) }); busy(false); if (rr.error) { b.disabled = false; m.hidden = false; m.className = 'msg bad'; m.textContent = rr.error.message; return; } location.hash = ''; start(); }; });
      };
      vq.oninput = function () { clearTimeout(vt); vt = setTimeout(runViewAs, 300); };
      vq.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(vt); runViewAs(); } };
      $('viewAsGo').onclick = runViewAs;
    }
    $('eodEntry').innerHTML = canEod() ? '<a class="rowbtn" href="#eod" style="margin-top:8px"><span><span class="t">' + esc(t('eodEntry')) + '</span><br><span class="s">' + esc(t('eodEntryHint')) + '</span></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>' : '';
    $('setupEntry').innerHTML = iCan('setup') ? '<a class="rowbtn" href="#setup" style="margin-top:8px"><span><span class="t">' + esc(t('setupEntry')) + '</span><br><span class="s">' + esc(t('setupEntryHint')) + '</span></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>' : '';
    $('peopleEntry').innerHTML = iCan('people') ? '<a class="rowbtn" href="#people" style="margin-top:8px"><span><span class="t">' + esc(t('peopleEntry')) + '</span><br><span class="s">' + esc(t('peopleEntryHint')) + '</span></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>' : '';
    var bl = $('badgeLink'); if (bl) bl.onclick = function (e) { e.preventDefault(); var bx = $('badgeBox'); bx.hidden = !bx.hidden; };
    var r = rulesFor(g || S.games[0]);
    $('rulesLink').style.display = r ? '' : 'none'; if (r) $('rulesLink').href = r;
    $('rulesNote').style.display = (g && !r) ? '' : 'none';
    $('libraryLink').href = C.library || '#';
    $('guideLink').href = (C.library || 'library.html') + '#hub-start';
  }
  function cardHtml(g) {
    var inAt = S.checkins[String(g.game_id)];
    if (isHQ(g)) {
      var role = String(g.hq_role || '').toUpperCase() === 'SC' ? t('roleSC') : /standby/i.test(g.field + ' ' + g.age_group) ? t('roleStandby') : (g.age_group || '');
      return '<div class="card" style="border-color:var(--gold)"><div class="row"><div class="disp big">' + esc(t('refereeHQ')) + '</div><div class="disp" style="font-size:28px">' + esc(clock(g.kickoff)) + '</div></div>' +
        '<div>' + esc(g.venue || '') + '. ' + esc(t('youAreToday')) + ' ' + esc(role) + '.</div>' +
        '<div class="actions">' + checkinBtn(g, inAt) + '</div><div class="hint">' + esc(t('hqHint')) + '</div><div class="msg bad" id="ci-msg-' + esc(g.game_id) + '" hidden></div></div>';
    }
    return '<div class="card"><div class="row"><div class="disp big">' + esc(clock(g.kickoff)) + '</div><div class="disp big">' + esc(String(g.field || '').toUpperCase()) + '</div></div>' +
      '<div>' + (isCoachSlot(g) ? esc(t('coachSlot')) + (g.field ? ', ' + esc(g.field) : '') : esc(g.age_group || '') + (g.competition ? ', ' + esc(g.competition) : '') + '. ' + esc(t('youAre')) + ' ' + esc(t('role.' + myRole(g)))) + '.</div>' +
      (inAt
        ? '<div class="actions">' + checkinBtn(g, inAt) + '</div>' +
          '<div class="actions" style="padding-top:0">' + (mapLayoutFor(g.venue) ? '<a class="btn primary" style="flex-grow:1" href="#map/' + encodeURIComponent(g.venue || '') + '/' + encodeURIComponent(g.field || '') + '">' + esc(t('mapToField').replace('{f}', fieldShort(g.field || ''))) + '</a>' : '') + '<a class="btn outline" href="#game/' + esc(g.game_id) + '">' + esc(t('details')) + '</a></div>'
        : '<div class="actions">' + checkinBtn(g, inAt) + '<a class="btn outline" href="#game/' + esc(g.game_id) + '">' + esc(t('details')) + '</a></div>' +
          '<div class="hint">' + esc(t('checkinWhere')) + '</div>' + lateHtml(g, inAt)) +
      '<div class="msg bad" id="ci-msg-' + esc(g.game_id) + '" hidden></div></div>';
  }
  // Running late: one tap tells the Site Coordinator; the card then shows
  // whether the SC has seen it. Only before check-in, only before kickoff.
  function lateHtml(g, inAt) {
    if (inAt || gameState(g) === 'done') return '';
    var l = myLate(g);
    if (l) return '<div class="late' + (l.ack_at ? ' ok' : '') + '">' + esc(l.ack_at ? t('lateAcked').replace('{t}', clock(l.ack_at)) : t('lateSent').replace('{n}', l.eta_min || '')) + '</div>';
    if (LATE.open === String(g.game_id)) return '<div class="chips" style="margin-top:8px">' + [10, 20, 30, 45].map(function (m) { return '<button class="chip-btn small" data-late="' + m + '" data-late-game="' + esc(g.game_id) + '">' + m + ' min</button>'; }).join('') + '<button class="chip-btn small" data-late-cancel="1">' + esc(t('neverMind')) + '</button></div>';
    return '<div class="actions" style="padding-top:8px"><button class="btn outline" style="flex-grow:1;border-color:var(--gold)" data-late-open="' + esc(g.game_id) + '">' + esc(t('runningLate')) + '</button></div>';
  }
  var LATE = { open: null };
  function wireLate(root) {
    root.querySelectorAll('[data-late-open]').forEach(function (b) { b.onclick = function () { LATE.open = b.getAttribute('data-late-open'); renderAll(); }; });
    root.querySelectorAll('[data-late-cancel]').forEach(function (b) { b.onclick = function () { LATE.open = null; renderAll(); }; });
    root.querySelectorAll('[data-late]').forEach(function (b) { b.onclick = async function () {
      var g = S.games.filter(function (x) { return String(x.game_id) === b.getAttribute('data-late-game'); })[0]; if (!g) return;
      b.disabled = true;
      var r = await sb.from('late_notices').insert({ org_id: S.me.org_id, date: g.date, game_id: g.game_id, ref_name: myNameOn(g), venue: g.venue, field: g.field, eta_min: parseInt(b.getAttribute('data-late'), 10) }).select('id,game_id,ref_name,venue,field,eta_min,created_at,ack_by,ack_at');
      if (r.error) { b.disabled = false; var m = root.querySelector('#ci-msg-' + g.game_id); if (m) { m.hidden = false; m.textContent = r.error.message; } return; }
      LATE.open = null; S.late = (S.late || []).concat(r.data || []); renderAll();
    }; });
  }
  function checkinBtn(g, inAt) {
    if (inAt) return '<div class="btn done" style="flex-grow:1"><span class="disp">' + esc(t('youreIn')) + '</span><small>' + esc(clock(inAt)) + '. ' + esc(t('checkedInAt')) + '</small></div>';
    return '<button class="btn primary" id="ci-' + esc(g.game_id) + '">' + esc(t('checkIn')) + '</button>';
  }
  function wireCheckin(g, root) {
    var b = root.querySelector('#ci-' + g.game_id);
    if (!b) return;
    b.onclick = async function () {
      b.disabled = true; b.textContent = t('checkingIn');
      // Straight to the database, every game. DbPull keeps the sheet in step.
      var hr = await sb.rpc('hub_checkin', { p_game: g.game_id });
      if (hr.error || !hr.data) {
        b.disabled = false; b.textContent = t('checkIn');
        var hm = root.querySelector('#ci-msg-' + g.game_id); if (hm) { hm.hidden = false; hm.textContent = hr.error ? hr.error.message : t('checkinFailed'); }
        return;
      }
      var hnow = new Date().toISOString();
      S.games.forEach(function (x) { if (key(x.venue) === key(g.venue)) S.checkins[String(x.game_id)] = hnow; });
      renderAll();
    };
  }

  // ── Coaching ─────────────────────────────────────────────────────
  function iCan(section) { return !!(S.me && (S.me.unlocks || []).indexOf(section) >= 0); }
  var AREAS = ['laws', 'reading', 'fitness', 'presence'];
  // The day the Coaching screen shows. Today unless the coach picked another
  // game day (a tournament on Saturday, looked at on Monday).
  function regSeason() { var d = new Date(); return d.getFullYear() + (d.getMonth() >= 6 ? 1 : 0); }
  function areaWord(a) { return t('co90Area.' + a) || a; }
  function areaR90(a) { return t('co90AreaR90.' + a) || ''; }
  function co90DayHtml() {
    var c = S.co90;
    if (!c || !c.group_name) return '';
    var pts = (c.points || []).map(function (p) { return '<div><span class="pill" style="margin-right:6px">' + esc(areaWord(p.area)) + '</span>' + esc(p.point) + '</div>'; }).join('');
    var note = (c.notes || [])[0];
    return '<div class="card" style="border-color:var(--gold);gap:6px"><b>' + esc(t('co90YourGroup').replace('{g}', c.group_name)) + '</b>' +
      '<div class="hint">' + esc(t('co90Mentor')) + ': ' + esc(c.mentor || t('co90None')) + '. ' + esc(t('co90National')) + ': ' + esc(c.national || t('co90None')) + '.</div>' +
      (pts ? '<div style="display:flex;flex-direction:column;gap:4px">' + pts + '</div>' : '<div class="hint">' + esc(t('scEmpty')) + '</div>') +
      (note ? '<div class="hint" style="border-top:1px solid var(--line);padding-top:6px">\u201c' + esc(note.body) + '\u201d \u00b7 ' + esc(note.author || '') + '</div>' : '') + '</div>';
  }
  function coachDay() { return S.coach.date || todayStr(); }
  // Four weeks of days, Monday first. Each day has an AM and a PM half to tap. Days with games are marked.
  function availCalHtml() {
    var today = todayStr(), gameDays = {}; (S.coach.days || []).forEach(function (d) { gameDays[d] = 1; });
    var start = new Date(today + 'T12:00:00'); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    var weeks = [], d = new Date(start), end = shiftDate(today, 27);
    for (var w = 0; w < 5; w++) { var row = []; for (var i = 0; i < 7; i++) { row.push(iso(d)); d.setDate(d.getDate() + 1); } weeks.push(row); if (row[6] >= end) break; }
    var dows = S.lang === 'es' ? ['L', 'M', 'X', 'J', 'V', 'S', 'D'] : ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    var monthOf = function (ds) { return new Date(ds + 'T12:00:00').toLocaleDateString(S.lang === 'es' ? 'es-US' : 'en-US', { month: 'short' }); };
    weeks = weeks.filter(function (row, i) { return i === 0 || row.some(function (ds) { return gameDays[ds]; }); });
    var cells = weeks.map(function (row) {
      return '<div class="avweek">' + row.map(function (ds) {
        var past = ds < today, dt = new Date(ds + 'T12:00:00');
        if (past) return '<div class="avday past"><span class="n">' + dt.getDate() + '</span></div>';
        var hv = (S.coach.halves || {})[ds];
        if (!hv) return '<div class="avday none"><span class="n">' + dt.getDate() + '</span></div>';
        var half = function (b) { if (!hv[b]) return '<span class="avh off" aria-hidden="true"></span>'; return '<button class="avh' + (S.coach.avail[ds + b] ? ' on' : '') + '" data-av="' + ds + '|' + b + '" aria-label="' + esc(dayLong(ds) + ' ' + t(b === 'am' ? 'blockAm' : 'blockPm')) + '">' + (b === 'am' ? 'AM' : 'PM') + '</button>'; };
        return '<div class="avday' + (gameDays[ds] ? ' games' : '') + (ds === today ? ' today' : '') + '"><span class="n">' + (dt.getDate() === 1 || ds === today ? monthOf(ds) + ' ' : '') + dt.getDate() + '</span>' + half('am') + half('pm') + '</div>';
      }).join('') + '</div>';
    }).join('');
    var n = Object.keys(S.coach.avail || {}).length;
    return fold('avail', t('whenFree'), n, '<div class="avcal"><div class="avweek head">' + dows.map(function (x) { return '<div class="avdow">' + x + '</div>'; }).join('') + '</div>' + cells + '</div><div class="hint">' + esc(t('availCalHint').replace('{n}', n)) + '</div><div class="msg" id="avMsg" hidden></div>', n === 0);
  }
  async function loadCoach_() {
    var today = todayStr(), day = coachDay(), keys = S.me.nameKeys || [], until = shiftDate(today, 10), until4 = shiftDate(today, 27);
    var r = await Promise.all([
      fetchAll(function () { return sb.from('games').select('game_id,date,game_num,kickoff,field,age_group,gender,competition,home,away,cr,ar1,ar2,fourth,venue,status')
        .eq('date', day).not('status', 'in', '(C,X,canceled_no_pay)').order('venue').order('kickoff'); }),
      sb.from('coach_assignments').select('venue,block,fields,note').eq('date', day),
      sb.from('eval_requests').select('id,game_id,game_date,venue,purpose,status,ref_name').eq('coach_person_id', S.me.person_id).eq('status', 'assigned').gte('game_date', today).order('game_date'),
      // Coaching slots Assignr gave me, today and the next ten days: my rows only.
      fetchAll(function () { return sb.from('games').select('game_id,date,kickoff,venue,field,age_group,hq_role,cr,ar1,ar2,fourth').gte('date', today).lte('date', until).not('status', 'in', '(C,X,canceled_no_pay)').or(mineOr()).order('date').order('kickoff'); }),
      // Days ahead with games, for saying when I am free. One row per day is enough.
      sb.rpc('game_halves', { p_from: today, p_to: until4 }),
      sb.from('coach_availability').select('date,block').gte('date', today),
      sb.from('observations').select('id,date,ref_name,observer,rater_role,public_notes,cleaned_note,final_note,cleanup_status,area,field,game_id,created_at').order('created_at', { ascending: false }).limit(100)
    ]);
    S.coach.games = r[0].data || [];
    S.coach.mine = r[1].data || [];
    S.coach.evals = r[2].data || [];
    try { var mv = await sb.from('evaluations').select('id,game_date,venue,competition,ref_name,purpose,status,report,report_status,updated_at').eq('coach_person_id', S.me.person_id).order('game_date', { ascending: false }).limit(30); S.coach.myEvals = mv.data || []; } catch (e) { S.coach.myEvals = []; }
    S.coach.assignr = (r[3].data || []).filter(function (g) { return isCoachSlot(g) && ['cr', 'ar1', 'ar2', 'fourth'].some(function (k) { return keys.indexOf(key(g[k])) >= 0; }); });
    S.coach.assignr.filter(function (g) { return g.date === day; }).forEach(function (g) {
      if (!S.coach.mine.some(function (m) { return m.venue === g.venue; })) S.coach.mine.push({ venue: g.venue, block: 'all', fields: g.field ? [g.field] : [], note: t('fromAssignr') + (g.kickoff ? ', ' + clock(g.kickoff) : '') });
    });
    if (S.coach.mine.length && !S.coach.venue) S.coach.venue = S.coach.mine[0].venue;
    var days = {}; (r[4].data || []).forEach(function (x) { days[x.date] = { am: x.am == null ? 1 : x.am, pm: x.pm == null ? 1 : x.pm }; }); S.coach.halves = days; S.coach.days = Object.keys(days).sort();
    S.coach.avail = {}; (r[5].data || []).forEach(function (x) { S.coach.avail[x.date + x.block] = 1; });
    S.coach.notes = (r[6].data || []).filter(function (x) { return keys.indexOf(key(x.observer)) >= 0; });
    var mine = S.coach.notes.map(function (x) { return x.id; }).filter(Boolean);
    var names = {};
    S.coach.games.forEach(function (g) { ['cr', 'ar1', 'ar2', 'fourth'].forEach(function (k) { if (g[k]) names[g[k]] = 1; }); });
    var list = Object.keys(names);
    var r2 = await Promise.all([
      mine.length ? sb.from('note_reads').select('observation_id,read_at').in('observation_id', mine) : Promise.resolve({ data: [] }),
      list.length ? sb.from('observations').select('ref_name,date,observer,rater_role,final_note,cleaned_note,area').in('ref_name', list).in('cleanup_status', ['approved', 'edited']).order('date', { ascending: false }).limit(500) : Promise.resolve({ data: [] })
    ]);
    S.coach.reads = {}; (r2[0].data || []).forEach(function (x) { S.coach.reads[String(x.observation_id)] = x.read_at; });
    S.coach.seen = {}; (r2[1].data || []).forEach(function (o) { var k = key(o.ref_name); (S.coach.seen[k] = S.coach.seen[k] || []).push(o); });
  }
  function inBlock(g, block) {
    if (!block || block === 'all') return true;
    var h = new Date(g.kickoff).getHours();
    return block === 'am' ? h < 12 : h >= 12;
  }
  function isMyField(g) {
    return (S.coach.mine || []).some(function (m) { return m.venue === g.venue && inBlock(g, m.block) && (!(m.fields || []).length || m.fields.indexOf(g.field) >= 0); });
  }
  function seenLine(name) {
    var arr = (S.coach.seen || {})[key(name)] || [];
    if (!arr.length) return '<span style="color:var(--red);font-weight:700">' + esc(t('notSeen')) + '</span>';
    return esc(t('seenTimes').replace('{n}', arr.length)) + ', ' + esc(dayLong(arr[0].date));
  }
  function renderCoach() {
    var venues = [];
    S.coach.games.forEach(function (g) { if (g.venue && venues.indexOf(g.venue) < 0) venues.push(g.venue); });
    if (!S.coach.venue || venues.indexOf(S.coach.venue) < 0) S.coach.venue = venues[0] || null;
    var expected = (S.coach.mine || []).length ? '<div class="card" style="border-color:var(--gold);gap:6px"><b>' + esc(t('yourBlock')) + '</b>' + S.coach.mine.map(function (m) {
        var done = 0, total = 0, refs = {};
        S.coach.games.filter(function (g) { return g.venue === m.venue && inBlock(g, m.block) && (!(m.fields || []).length || m.fields.indexOf(g.field) >= 0); }).forEach(function (g) { ['cr', 'ar1', 'ar2', 'fourth'].forEach(function (k) { if (g[k]) refs[key(g[k])] = 1; }); });
        Object.keys(refs).forEach(function (k) { total++; if (S.coach.notes.some(function (n) { return key(n.ref_name) === k && n.date === coachDay(); })) done++; });
        return '<div>' + esc(t(m.block === 'am' ? 'blockAm' : m.block === 'pm' ? 'blockPm' : 'blockAll')) + ', ' + esc(m.venue) + ((m.fields || []).length ? ', ' + esc(m.fields.map(fieldShort).join(', ')) : '') + (m.note ? '. ' + esc(m.note) : '') + '<br><span class="hint">' + esc(t('blockJob')) + ' ' + esc(t('debriefed').replace('{d}', done).replace('{n}', total)) + '</span></div>';
      }).join('') + '</div>' : '';
    var evalsCard = (S.coach.evals || []).length ? '<div class="card" style="border-color:var(--red);gap:6px"><b>' + esc(t('evalAssignedTitle')) + '</b>' + S.coach.evals.map(function (r) { return '<div>' + refLink(r.ref_name) + ', ' + esc(dayLong(r.game_date)) + ', ' + esc(r.venue || '') + '. ' + esc(t('evalPurpose.' + r.purpose)) + ' <a class="refname" href="#coach/game/' + esc(r.game_id) + '">' + esc(t('details')) + '</a></div>'; }).join('') + '<div class="hint">' + esc(t('evalAssignedHint')) + '</div></div>' : '';
    var upcoming = (S.coach.assignr || []).filter(function (g) { return g.date > coachDay(); });
    var upcomingCard = upcoming.length ? '<div class="card" style="gap:4px"><b>' + esc(t('comingUp')) + '</b>' + upcoming.map(function (g) { return '<div>' + esc(dayLong(g.date)) + ', ' + esc(clock(g.kickoff)) + ', ' + esc(g.venue || '') + (g.field ? ', ' + esc(g.field) : '') + ' <span class="hint">' + esc(t('fromAssignr')) + '</span></div>'; }).join('') + '</div>' : '';
    var myEvalsFold = (S.coach.myEvals || []).length ? fold('myevals', t('myEvalsTitle'), S.coach.myEvals.length, '<div class="list">' + S.coach.myEvals.map(function (e) { return '<a class="item" href="#eval/' + e.id + '"><div><b>' + esc(e.ref_name || '') + '</b> <span class="pill' + (e.status === 'complete' && (!e.report || e.report_status === 'approved') ? ' ok' : e.report_status === 'returned' ? ' bad' : '') + '">' + esc(e.status === 'complete' ? (e.report ? t('evalRs.' + (e.report_status || 'draft')) : t('evalComplete')) : t('evalInProgress')) + '</span><br><span class="hint">' + esc(e.game_date ? dayLong(e.game_date) : '') + (e.venue ? ', ' + esc(e.venue) : '') + (e.competition ? ', ' + esc(e.competition) : '') + '</span></div><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>'; }).join('') + '</div>', false) : '';
    expected = evalsCard + expected + upcomingCard + myEvalsFold;
    var availability = availCalHtml();
    expected = expected + availability;
    var vCount = {}; S.coach.games.forEach(function (g) { if (g.venue) vCount[g.venue] = (vCount[g.venue] || 0) + 1; });
    var venuePicker = venues.length > 4
      ? '<select id="venueSel" style="font:inherit;width:100%;padding:12px;border:2px solid var(--navy);border-radius:8px;background:var(--surface);color:var(--ink)">' + venues.map(function (v) { return '<option value="' + esc(v) + '"' + (v === S.coach.venue ? ' selected' : '') + '>' + esc(v) + ' (' + (vCount[v] || 0) + ' ' + esc(t('stGames')) + ')</option>'; }).join('') + '</select>'
      : '<div class="chips">' + venues.map(function (v) { return '<button class="chip-btn' + (v === S.coach.venue ? ' on' : '') + '" data-venue="' + esc(v) + '">' + esc(v) + '</button>'; }).join('') + '</div>';
    var dayList = [todayStr()].concat((S.coach.days || []).filter(function (d) { return d > todayStr(); }).slice(0, 6));
    if (dayList.indexOf(coachDay()) < 0) dayList.push(coachDay());
    var dayPicker = dayList.length > 1 ? '<div class="pad" style="padding-top:14px"><div class="hint" style="font-weight:700;padding-bottom:8px">' + esc(t('coachDay')) + '</div><div class="chips">' + dayList.map(function (d) { return '<button class="chip-btn' + (d === coachDay() ? ' on' : '') + '" data-cday="' + d + '">' + esc(d === todayStr() ? t('todayWord') : dayShort(d)) + '</button>'; }).join('') + '</div></div>' : '';
    $('venuePick').innerHTML = expected + dayPicker + (venues.length ? '<div class="pad" style="padding-top:14px"><div class="hint" style="font-weight:700;padding-bottom:8px">' + esc(t('venue')) + '</div>' + venuePicker + '</div>' : '<div class="card"><div class="hint">' + esc(t('noVenuesToday')) + '</div></div>');
    var vsel = $('venueSel'); if (vsel) vsel.onchange = function () { S.coach.venue = vsel.value; renderCoach(); };
    $('venuePick').querySelectorAll('[data-cday]').forEach(function (b) { b.onclick = function () { S.coach.date = b.getAttribute('data-cday'); S.coach.venue = null; loadCoach().then(renderCoach); }; });
    $('venuePick').querySelectorAll('[data-venue]').forEach(function (b) { b.onclick = function () { S.coach.venue = b.getAttribute('data-venue'); renderCoach(); }; });
    $('venuePick').querySelectorAll('[data-av]').forEach(function (b) {
      b.onclick = async function () {
        var p = b.getAttribute('data-av').split('|'), on = !!S.coach.avail[p[0] + p[1]];
        if (on) delete S.coach.avail[p[0] + p[1]]; else S.coach.avail[p[0] + p[1]] = 1;
        b.classList.toggle('on', !on);
        var r = on ? await sb.from('coach_availability').delete().eq('date', p[0]).eq('block', p[1]).eq('person_id', S.me.person_id)
                   : await sb.from('coach_availability').insert({ org_id: S.me.org_id, date: p[0], person_id: S.me.person_id, block: p[1] });
        if (r.error) {
          if (on) S.coach.avail[p[0] + p[1]] = 1; else delete S.coach.avail[p[0] + p[1]];
          b.classList.toggle('on', on);
          var m = $('avMsg'); if (m) { m.hidden = false; m.className = 'msg bad'; m.textContent = t('reviewFailed') + ' ' + (r.error.message || ''); }
        }
      };
    });
    var games = S.coach.games.filter(function (g) { return g.venue === S.coach.venue && !isHQ(g) && !isCoachSlot(g); });
    var rowOfGame = function (g) {
      var crew = ['cr', 'ar1', 'ar2', 'fourth'].filter(function (k) { return g[k]; }).map(function (k) {
        var none = !((S.coach.seen || {})[key(g[k])] || []).length;
        // Plain names here: the whole row opens the game, and a link inside a
        // link breaks the row into pieces. Names are tappable on the next screen.
        return (none ? '<span style="color:var(--red);font-weight:700">' : '<span>') + esc(g[k]) + '</span>';
      }).join(', ');
      return '<a class="item' + (isMyField(g) ? ' mine' : '') + '" href="#coach/game/' + esc(g.game_id) + '"><div><div class="when"><div class="disp">' + esc(clock(g.kickoff)) + '</div><div class="sub">' + esc(g.field || '') + ', ' + esc(g.age_group || '') + (isMyField(g) ? ', <b>' + esc(t('yours')) + '</b>' : '') + '</div></div><div class="hint">' + crew + '</div></div><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>';
    };
    var played = games.filter(function (g) { return gameState(g) === 'done'; }), ahead = games.filter(function (g) { return gameState(g) !== 'done'; });
    $('coachGames').innerHTML = (games.length ? '<div class="pad hint" style="padding-top:12px">' + esc(t('redMeans')) + ((S.coach.mine || []).length ? ' ' + esc(t('goldMeans')) : '') + '</div>' : '') +
      '<div class="list">' + ahead.map(rowOfGame).join('') + '</div>' +
      (played.length ? fold('coach-played', t('playedGames'), played.length, '<div class="list" style="padding-top:0">' + played.map(rowOfGame).join('') + '</div>', !ahead.length) : '');
  }
  async function renderCoachGame(id, crewKey) {
    var g = S.coach.games.filter(function (x) { return String(x.game_id) === String(id); })[0];
    if (!g) {
      // Opened from a referee card or a link: fetch the one game and show its day.
      var one = await sb.from('games').select('game_id,date,game_num,kickoff,field,age_group,gender,competition,home,away,cr,ar1,ar2,fourth,venue,status').eq('game_id', id).limit(1);
      g = (one.data || [])[0];
      if (g) { S.coach.date = g.date; S.coach.venue = g.venue; await loadCoach(); if (!S.coach.games.some(function (x) { return String(x.game_id) === String(id); })) S.coach.games.push(g); }
    }
    S.coach.game = g || null;
    if (!g) { location.hash = '#coach'; return; }
    if (crewKey && g[crewKey]) S.coach.ref = crewKey;
    var crew = ['cr', 'ar1', 'ar2', 'fourth'].filter(function (k) { return g[k]; });
    if (!S.coach.ref || crew.indexOf(S.coach.ref) < 0) S.coach.ref = null;
    var signed = S.me.coaching_title || (S.me.titles || [])[0] || '';
    $('coachGameBody').innerHTML =
      '<div class="pad" style="padding-top:16px"><div class="lead">' + esc(g.venue || '') + ', ' + esc(dayLong(g.date)) + '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline"><div class="disp" style="font-size:48px">' + esc(clock(g.kickoff)) + '</div><div class="disp" style="font-size:48px;color:var(--count)">' + esc(fieldShort(g.field)) + '</div></div>' +
      '<div>' + esc(g.age_group || '') + (g.competition ? ', ' + esc(g.competition) : '') + '. ' + esc(g.home || '') + ' v ' + esc(g.away || '') + '</div></div>' +
      ((S.coach.evals || []).some(function (r) { return String(r.game_id) === String(g.game_id); }) ? '<div class="pad" style="padding-top:12px"><a class="rowbtn" style="margin:0;width:100%;border-color:var(--red)" href="evaluator.html?gameId=' + esc(g.game_id) + '"><span><span class="t">' + esc(t('evaluatorOpen')) + '</span><br><span class="s">' + esc(t('evaluatorHint')) + '</span></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a></div>' : '') +
      '<div class="disp h2">' + esc(t('crewPick')) + '</div><div class="pad hint" style="padding-bottom:6px">' + esc(t('crewPickHint')) + '</div>' +
      crew.map(function (k) { return '<div class="crewbtn' + (S.coach.ref === k ? ' on' : '') + '" role="button" tabindex="0" data-crew="' + k + '"><span><span class="t">' + esc(g[k]) + '</span><br><span class="s">' + esc(t('role.' + k)) + '. ' + seenLine(g[k]) + '</span></span><span style="display:flex;align-items:center;gap:8px;flex-shrink:0"><span class="pill" style="background:var(--navy);color:var(--surface)">' + esc(S.coach.ref === k ? t('writingFor') : t('tapToNote')) + '</span><a class="btn outline small" href="#ref/' + encodeURIComponent(g[k]) + '" style="min-height:36px;padding:0 10px;font-size:13px" onclick="event.stopPropagation()">' + esc(t('refCardTitle')) + '</a></span></div>'; }).join('') +
      (S.coach.ref ? priorNotesHtml(g[S.coach.ref]) + '<div class="card" id="noteCard" style="gap:12px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><label for="noteText" style="font-weight:700">' + esc(t('noteLabel')) + '</label>' + (Mic.ok() ? '<button class="btn outline small" id="micBtn" type="button" aria-pressed="false">' + esc(t('micTalk')) + '</button>' : '') + '</div>' +
        '<textarea id="noteText" placeholder="' + esc(t('notePlaceholder')) + '"></textarea><div class="hint" id="micHint">' + esc(Mic.ok() ? t('micHint') : t('micKeyboard')) + '</div>' +
        '<button class="btn primary" id="saveNote">' + esc(t('saveNote')) + '</button><div class="msg" id="noteMsg" hidden></div>' +
        '<div class="hint" style="font-weight:700">' + esc(t('areaLabel')) + '</div><div class="chips">' + AREAS.map(function (a) { return '<button class="chip-btn' + (S.coach.area === a ? ' on' : '') + '" data-area="' + a + '">' + esc(t('areas.' + a)) + '</button>'; }).join('') + '</div>' +
        '<div class="hint">' + esc(t('signedAs')) + ' ' + esc(S.me.first_name + ' ' + S.me.last_name) + ', ' + esc(signed) + '</div></div>' : '');
    var mb = $('micBtn'); if (mb) mb.onclick = function () { Mic.toggle($('noteText'), mb, $('micHint')); };
    $('coachGameBody').querySelectorAll('[data-crew]').forEach(function (b) { var pick = function () { S.coach.ref = b.getAttribute('data-crew'); S.coach.area = null; renderCoachGame(id); var ta = $('noteText'); if (ta) ta.focus(); }; b.onclick = pick; b.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }; });
    $('coachGameBody').querySelectorAll('[data-area]').forEach(function (b) { b.onclick = function () { var a = b.getAttribute('data-area'); S.coach.area = S.coach.area === a ? null : a; $('coachGameBody').querySelectorAll('[data-area]').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-area') === S.coach.area); }); }; });
    var save = $('saveNote');
    if (save) save.onclick = async function () {
      var text = ($('noteText').value || '').trim();
      if (!text) { $('noteText').focus(); return; }
      save.disabled = true; save.textContent = t('savingNote');
      var ev = eventFor(g);
      try {
        var res = await fetch(C.backend, { method: 'POST', body: JSON.stringify({ action: 'observation', event: ev ? ev.id : '', refName: g[S.coach.ref], raterName: S.me.first_name + ' ' + S.me.last_name, raterRole: signed, gameId: g.game_id, date: g.date, field: g.field || '', ageGroup: g.age_group || '', kickoffTime: clock(g.kickoff), officialRole: S.coach.ref, notesPublic: text, area: S.coach.area || '' }) });
        var j = await res.json();
        if (!j || j.status !== 'ok') throw new Error(j && j.message || 'error');
        var refName = g[S.coach.ref];
        S.coach.notes.unshift({ date: g.date, ref_name: refName, observer: S.me.first_name + ' ' + S.me.last_name, rater_role: signed, public_notes: text, cleanup_status: 'pending', area: S.coach.area, field: g.field, created_at: new Date().toISOString() });
        $('noteCard').innerHTML = '<div class="btn done"><span class="disp">' + esc(t('noteSaved')) + '</span><small>' + esc(refName) + ', ' + esc(clock(new Date().toISOString())) + '</small></div><div class="hint">' + esc(t('noteSavedHint')) + '</div><button class="btn outline" id="anotherRef">' + esc(t('another')) + '</button>';
        $('anotherRef').onclick = function () { S.coach.ref = null; S.coach.area = null; renderCoachGame(id); };
      } catch (e) {
        save.disabled = false; save.textContent = t('saveNote');
        var m = $('noteMsg'); m.hidden = false; m.className = 'msg bad'; m.textContent = t('noteFailed');
      }
    };
  }
  function priorNotesHtml(name) {
    var arr = ((S.coach.seen || {})[key(name)] || []).slice(0, 3);
    if (!arr.length) return '<div class="note"><div class="text hint" style="color:var(--red)">' + esc(t('notSeenLong')) + '</div></div>';
    return '<div class="note"><div class="who">' + esc(t('alreadySaid').replace('{n}', ((S.coach.seen || {})[key(name)] || []).length)) + '</div>' + arr.map(function (o) {
      return '<div class="text" style="font-size:15px"><span class="hint">' + esc(dayLong(o.date)) + ', ' + esc(o.observer || '') + (o.rater_role ? ', ' + esc(o.rater_role) : '') + ':</span> ' + esc(o.final_note || o.cleaned_note || '') + '</div>';
    }).join('') + '</div>';
  }
  function renderMyNotes() {
    var cut = shiftDate(todayStr(), -14);
    var myCard = function (n) {
      var st = n.cleanup_status || 'pending', ok = st === 'approved' || st === 'edited';
      var label = t('status.' + st); if (label === 'status.' + st) label = t('status.pending');
      var readAt = (S.coach.reads || {})[String(n.id)];
      if (ok && readAt) label = t('readBy') + ' ' + dayLong(readAt.slice(0, 10));
      return '<div class="card" style="gap:8px"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><div><b>' + refLink(n.ref_name || '') + '</b> <span class="hint">' + esc(dayLong(n.date)) + (n.field ? ', ' + esc(n.field) : '') + (n.area ? ', ' + esc(t('areas.' + n.area)) : '') + '</span></div><span class="pill' + (ok ? ' ok' : '') + '">' + esc(label) + '</span></div>' +
        '<div class="side three"><div class="col"><b>' + esc(t('rawLabel')) + '</b>' + esc(n.public_notes || '') + '</div><div class="col"><b>' + esc(t('aiLabel')) + '</b>' + (n.cleaned_note ? esc(n.cleaned_note) : '<span class="hint">' + esc(t('notCleaned')) + '</span>') + '</div><div class="col"><b>' + esc(t('releasedLabel')) + '</b>' + (ok ? esc(n.final_note || n.cleaned_note || '') : '<span class="hint">' + esc(t('notReleased')) + '</span>') + '</div></div></div>';
    };
    var recent = S.coach.notes.filter(function (n) { return !n.date || n.date >= cut; }), older = S.coach.notes.filter(function (n) { return n.date && n.date < cut; });
    $('myNotesList').innerHTML = S.coach.notes.length ? recent.map(myCard).join('') + (older.length ? fold('mynotes-older', t('olderNotes'), older.length, older.map(myCard).join(''), !recent.length) : '') : '<div class="card"><div class="hint">' + esc(t('noMyNotes')) + '</div></div>';
  }

  // ── Review (Scheduling): clean, read both, approve ───────────────
  var REV = { filter: 'cleaned', notes: [], busy: false, editing: null };
  async function token() { var r = await sb.auth.getSession(); return r.data && r.data.session ? r.data.session.access_token : ''; }
  async function post(body) {
    body.token = await token();
    var res = await fetch(C.backend, { method: 'POST', body: JSON.stringify(body) });
    var j = await res.json();
    if (!j || j.status !== 'ok') throw new Error(j && j.message || 'error');
    return j;
  }
  async function loadReview_() {
    var from = new Date(Date.now() - 45 * 86400000);
    var j = await post({ action: 'pendingNotes', dateFrom: from.toISOString().slice(0, 10) });
    REV.notes = (j.data || []).filter(function (n) { return n.notesPublic || n.cleanedNote; });
  }
  function revStatus(n) {
    var s = String(n.cleanupStatus || 'pending').toLowerCase();
    if (s === 'approved' || s === 'edited') return 'approved';
    if (s === 'rejected') return 'rejected';
    if (s === 'cleaned' && n.cleanedNote) return 'cleaned';
    return 'pending';
  }
  function renderReview() {
    var counts = { pending: 0, cleaned: 0, approved: 0, rejected: 0 };
    REV.notes.forEach(function (n) { counts[revStatus(n)]++; });
    var lbl = function (k, n) { return t('filter' + k.charAt(0).toUpperCase() + k.slice(1)) + ' ' + n; };
    var coaches = {}; REV.notes.forEach(function (n) { if (n.observer) coaches[n.observer] = (coaches[n.observer] || 0) + 1; });
    var coachList = Object.keys(coaches).sort();
    var listAll = REV.notes.filter(function (n) { return revStatus(n) === REV.filter && (!REV.coach || n.observer === REV.coach); });
    var pageN = REV.page || 20, list = listAll.slice(0, pageN);
    $('reviewTools').innerHTML = '<div class="filters">' + ['pending', 'cleaned', 'approved', 'rejected'].map(function (k) {
      return '<button class="chip-btn' + (REV.filter === k ? ' on' : '') + '" data-filter="' + k + '">' + esc(lbl(k, counts[k])) + '</button>';
    }).join('') + '</div>' +
      (REV.filter === 'pending' && counts.pending ? '<div class="pad" style="padding-top:10px"><button class="btn outline small" id="cleanAll">' + esc(t('cleanAll')) + '</button></div>' : '') +
      (REV.filter === 'cleaned' && counts.cleaned ? '<div class="pad" style="padding-top:10px"><button class="btn go small" id="approveAll">' + esc(t('approveAll')) + '</button></div>' : '') +
      (REV.filter === 'approved' && counts.approved ? '<div class="pad" style="padding-top:10px"><button class="btn outline small" id="emailAll">' + esc(t('emailApproved')) + '</button><div class="hint" style="padding-top:6px">' + esc(t('emailApprovedHint')) + '</div><div class="hint" id="emailProg"></div></div>' : '') +
      (coachList.length > 1 ? '<div class="pad" style="padding-top:10px"><select id="revCoach" style="font:inherit;width:100%;padding:10px;border:2px solid var(--navy);border-radius:8px;background:var(--surface);color:var(--ink)"><option value="">' + esc(t('allCoaches')) + '</option>' + coachList.map(function (c) { return '<option value="' + esc(c) + '"' + (REV.coach === c ? ' selected' : '') + '>' + esc(c) + ' (' + coaches[c] + ')</option>'; }).join('') + '</select></div>' : '') +
      '<div class="msg bad" id="revMsg" hidden style="margin:10px 20px 0"></div>';
    $('reviewTools').querySelectorAll('[data-filter]').forEach(function (b) { b.onclick = function () { REV.filter = b.getAttribute('data-filter'); REV.page = 20; renderReview(); }; });
    var rc = $('revCoach'); if (rc) rc.onchange = function () { REV.coach = rc.value; REV.page = 20; renderReview(); };
    var ca = $('cleanAll'); if (ca) ca.onclick = function () { runOn(listAll.filter(function (n) { return !n.flagged; }), 'clean'); };
    var aa = $('approveAll'); if (aa) aa.onclick = function () { runOn(listAll.filter(function (n) { return !n.flagged; }), 'approve'); };
    var ea = $('emailAll'); if (ea) ea.onclick = function () { emailApproved(listAll, ea); };
    $('reviewList').innerHTML = list.length ? list.map(function (n) {
      var st = revStatus(n);
      return '<div class="card' + (n.flagged ? ' flagged' : '') + '" style="gap:8px" id="rev-' + n.rowNum + '">' +
        '<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline"><div><b>' + refLink(n.refName) + '</b><br><span class="hint">' + esc(n.observer || '') + (n.raterRole ? ', ' + esc(n.raterRole) : '') + '. ' + esc(n.date ? dayLong(n.date) : '') + (n.field ? ', ' + esc(n.field) : '') + (n.officialRole ? ', ' + esc(n.officialRole) : '') + '</span></div>' +
        (st === 'approved' ? '<span class="pill ok">' + esc(t('approved')) + (n.reviewedBy ? ' ' + esc(t('approvedBy')) + ' ' + esc(n.reviewedBy) : '') + '</span>' : '') + '</div>' +
        (n.flagged ? '<div class="hint" style="color:var(--red);font-weight:700">' + esc(t('flaggedNote')) + '</div>' : '') +
        '<div class="side three"><div class="col"><b>' + esc(t('rawLabel')) + '</b>' + esc(n.notesPublic || '') + '</div><div class="col"><b>' + esc(t('aiLabel')) + '</b>' + (n.cleanedNote ? esc(n.cleanedNote) : '<span class="hint">' + esc(t('notCleaned')) + '</span>') + '</div><div class="col"><b>' + esc(t('releasedLabel')) + '</b>' + (st === 'approved' ? esc(n.finalNote || n.cleanedNote || '') : '<span class="hint">' + esc(t('notReleased')) + '</span>') + '</div></div>' +
        (REV.editing === n.rowNum ? '<label class="hint" style="font-weight:700" for="revEdit">' + esc(t('editLabel')) + '</label><textarea id="revEdit" style="min-height:140px">' + esc(REV.draft || n.finalNote || (n.flagged ? n.notesPublic : n.cleanedNote) || n.notesPublic || '') + '</textarea><div class="actions" style="padding:0"><button class="btn go small" data-release-edit="' + n.rowNum + '">' + esc(t('releaseEdited')) + '</button><button class="btn outline small" data-cancel-edit="1">' + esc(t('neverMind')) + '</button></div>' :
          (st !== 'approved' ? '<div class="actions" style="padding:0;flex-wrap:wrap">' +
            (st === 'pending' ? '<button class="btn outline small" data-clean="' + n.rowNum + '">' + esc(t('cleanBtn')) + '</button>' : '') +
            (st === 'cleaned' && !n.flagged ? '<button class="btn go small" data-approve="' + n.rowNum + '">' + esc(t('releaseCleaned')) + '</button>' : '') +
            '<button class="btn outline small" data-approve-raw="' + n.rowNum + '">' + esc(t('releaseRaw')) + '</button>' +
            '<button class="btn outline small" data-edit="' + n.rowNum + '">' + esc(t('editRelease')) + '</button>' +
            '<button class="linkbtn" style="color:var(--red)" data-reject="' + n.rowNum + '">' + esc(t('rejectNote')) + '</button>' +
          '</div>' : '')) +
        '<div class="msg bad" id="revmsg-' + n.rowNum + '" hidden></div>' +
        (st === 'rejected' ? '<div class="actions" style="padding:0"><button class="btn outline small" data-restore="' + n.rowNum + '">' + esc(t('restoreNote')) + '</button></div>' : '') +
        '</div>';
    }).join('') + (listAll.length > list.length ? '<div class="pad"><button class="btn outline" id="revMore" style="width:100%">' + esc(t('showMore').replace('{n}', Math.min(20, listAll.length - list.length)).replace('{left}', listAll.length - list.length)) + '</button></div>' : '') : '<div class="card"><div class="hint">' + esc(t('nothingHere')) + '</div></div>';
    var rm = $('revMore'); if (rm) rm.onclick = function () { REV.page = pageN + 20; renderReview(); };
    $('reviewList').querySelectorAll('[data-restore]').forEach(function (b) { b.onclick = function () { runOn([byRow(b.getAttribute('data-restore'))], 'restore', b); }; });
    $('reviewList').querySelectorAll('[data-clean]').forEach(function (b) { b.onclick = function () { runOn([byRow(b.getAttribute('data-clean'))], 'clean', b); }; });
    $('reviewList').querySelectorAll('[data-approve]').forEach(function (b) { b.onclick = function () { runOn([byRow(b.getAttribute('data-approve'))], 'approve', b); }; });
    $('reviewList').querySelectorAll('[data-approve-raw]').forEach(function (b) { b.onclick = function () { runOn([byRow(b.getAttribute('data-approve-raw'))], 'approve_raw', b); }; });
    $('reviewList').querySelectorAll('[data-edit]').forEach(function (b) { b.onclick = function () { REV.editing = parseInt(b.getAttribute('data-edit'), 10); renderReview(); var ta = $('revEdit'); if (ta) ta.focus(); }; });
    $('reviewList').querySelectorAll('[data-cancel-edit]').forEach(function (b) { b.onclick = function () { REV.editing = null; REV.draft = ''; renderReview(); }; });
    $('reviewList').querySelectorAll('[data-release-edit]').forEach(function (b) { b.onclick = function () { var n = byRow(b.getAttribute('data-release-edit')); n._text = $('revEdit').value.trim(); if (!n._text) return; runOn([n], 'edit', b); }; });
    $('reviewList').querySelectorAll('[data-reject]').forEach(function (b) { b.onclick = function () { runOn([byRow(b.getAttribute('data-reject'))], 'reject', b); }; });
  }
  function byRow(r) { return REV.notes.filter(function (n) { return String(n.rowNum) === String(r); })[0]; }
  // Email each referee their approved notes (one email per referee per day; the
  // backend refuses a second send). For sites where referees are not on the Hub yet.
  async function emailApproved(notes, btn) {
    if (REV.busy) return;
    var byRef = {}; notes.forEach(function (n) { if (!n.refName) return; var r = byRef[n.refName] = byRef[n.refName] || { from: n.date, to: n.date }; if (n.date && n.date < r.from) r.from = n.date; if (n.date && n.date > r.to) r.to = n.date; });
    var names = Object.keys(byRef);
    if (!names.length || !window.confirm(t('emailApprovedConfirm').replace('{n}', names.length))) return;
    REV.busy = true; btn.disabled = true; var sent = 0, held = 0, already = 0, failed = [], prog = $('emailProg');
    for (var i = 0; i < names.length; i++) {
      var nm = names[i]; if (prog) prog.textContent = t('emailProgress').replace('{i}', i + 1).replace('{n}', names.length).replace('{name}', nm);
      try { var jr = await post({ action: 'sendReport', refName: nm, dateFrom: byRef[nm].from || '', dateTo: byRef[nm].to || '', approver: S.me.first_name + ' ' + S.me.last_name }); if (jr && jr.held) held++; else sent++; }
      catch (e) { if (/already/i.test(e.message || '')) already++; else failed.push(nm + ': ' + (e.message || '')); }
    }
    REV.busy = false; btn.disabled = false;
    if (prog) prog.innerHTML = esc(t('emailDone').replace('{sent}', sent).replace('{already}', already)) + (held ? ' ' + esc(t('emailHeld').replace('{n}', held)) : '') + (failed.length ? '<br><span style="color:var(--red)">' + esc(failed.join('; ')) + '</span>' : '');
  }
  async function runOn(notes, what, btn) {
    notes = notes.filter(Boolean);
    if (!notes.length || REV.busy) return;
    REV.busy = true;
    if (btn) { btn.disabled = true; btn.textContent = t(what === 'clean' ? 'cleaning' : 'approving'); }
    if (what === 'reject' && !window.confirm(t('rejectConfirm'))) { REV.busy = false; renderReview(); return; }
    var m = $('revMsg'); if (m) m.hidden = true;
    try {
      var by = S.me.first_name + ' ' + S.me.last_name;
      if (what === 'approve') {
        var ab = await post({ action: 'approveBatch', reviewedBy: by, items: notes.map(function (n) { return { rowNum: n.rowNum, use: 'ai' }; }) });
        if (ab && ab.skipped && ab.skipped.length && notes.length === 1) throw new Error(t('flaggedSkip'));
      } else if (what === 'approve_raw') {
        await post({ action: 'approveBatch', reviewedBy: by, items: notes.map(function (n) { return { rowNum: n.rowNum, use: 'original' }; }) });
      } else if (what === 'edit') {
        // A reviewer who rewrote a flagged note has cleared the flag by hand;
        // the backend records who and why on the row.
        for (var e2 = 0; e2 < notes.length; e2++) await post({ action: 'updateNoteStatus', rowNum: notes[e2].rowNum, status: 'edited', finalNote: notes[e2]._text, reviewedBy: by, overrideReason: notes[e2].flagged ? 'Rewritten by ' + by + ' before release; the released text is theirs, not the flagged cleanup.' : '' });
        REV.editing = null; REV.draft = '';
      } else if (what === 'reject') {
        for (var r2 = 0; r2 < notes.length; r2++) await post({ action: 'updateNoteStatus', rowNum: notes[r2].rowNum, status: 'rejected', reviewedBy: by });
      } else if (what === 'restore') {
        for (var r3 = 0; r3 < notes.length; r3++) await post({ action: 'updateNoteStatus', rowNum: notes[r3].rowNum, status: 'pending', reviewedBy: by });
      } else {
        for (var i = 0; i < notes.length; i++) await post({ action: 'cleanNote', rowNum: notes[i].rowNum });
      }
      await loadReview();
      if ((what === 'approve' || what === 'approve_raw' || what === 'edit') && REV.filter !== 'approved') REV.filter = 'approved';
      if (what === 'clean' && REV.filter === 'pending') REV.filter = 'cleaned';
      if (what === 'restore') REV.filter = 'pending';
      renderReview();
      if (notes.length === 1) { var done = $('rev-' + notes[0].rowNum); if (done) done.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    } catch (e) {
      // Keep the editor and its text; say what went wrong on the card itself.
      if (what === 'edit' && notes.length === 1) REV.draft = notes[0]._text;
      renderReview();
      var msg = t('reviewFailed') + ' ' + (e && e.message ? e.message : '');
      var cm = notes.length === 1 ? $('revmsg-' + notes[0].rowNum) : null;
      if (cm) { cm.hidden = false; cm.textContent = msg; cm.scrollIntoView({ block: 'center' }); }
      else { var mm = $('revMsg'); if (mm) { mm.hidden = false; mm.textContent = msg; } }
    }
    REV.busy = false;
  }

  // ── Command Center: referee development ──────────────────────────
  var CC = { tab: 'coverage', cov: [], obs: [], reads: {}, drafts: null, from: '', to: '', sdate: '', coaches: [], assigns: [], venues: [], pick: null };
  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  async function loadCenter_() {
    var since = iso(new Date(Date.now() - 30 * 86400000));
    var r = await Promise.all([
      sb.rpc('coverage_rows'),
      sb.from('observations').select('id,observer,rater_role,ref_name,date,cleanup_status').gte('date', since).limit(2000)
    ]);
    CC.cov = (r[0].data || []).sort(function (a, b) { return b.games - a.games; });
    if (CC.tab === 'evals') await loadEvals_();
    CC.obs = r[1].data || [];
    var ids = CC.obs.map(function (o) { return o.id; }), qs = [];
    for (var i = 0; i < ids.length; i += 200) qs.push(sb.from('note_reads').select('observation_id').in('observation_id', ids.slice(i, i + 200)));
    CC.reads = {};
    (await Promise.all(qs)).forEach(function (rd) { (rd.data || []).forEach(function (x) { CC.reads[String(x.observation_id)] = 1; }); });
    if (!CC.from) { var d = new Date(); var dow = d.getDay(); var sat = new Date(d.getTime() - ((dow + 1) % 7) * 86400000); CC.from = iso(sat); CC.to = iso(new Date(sat.getTime() + 86400000)); }
  }
  async function loadSchedule_() {
    if (!CC.sdate) CC.sdate = todayStr();
    if (!CC.block) CC.block = 'am';
    if (!CC.coaches.length) { var c = await sb.from('coaches').select('person_id,first_name,last_name,coaching_title').order('last_name'); CC.coaches = c.data || []; }
    var g = await fetchAll(function () { return sb.from('games').select('venue,field,kickoff').eq('date', CC.sdate).not('status', 'in', '(C,X,canceled_no_pay)').order('venue'); });
    var vs = {}, fs = {};
    (g.data || []).forEach(function (x) { if (!x.venue) return; vs[x.venue] = 1; (fs[x.venue] = fs[x.venue] || {})[x.field || ''] = 1; });
    CC.venues = Object.keys(vs).sort();
    CC.fieldsAt = {}; Object.keys(fs).forEach(function (v) { CC.fieldsAt[v] = Object.keys(fs[v]).filter(Boolean).sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); }); });
    var a = await sb.from('coach_assignments').select('id,date,person_id,venue,block,fields,note').eq('date', CC.sdate);
    var byId = {}; CC.coaches.forEach(function (c) { byId[String(c.person_id)] = c; });
    CC.assigns = (a.data || []).map(function (x) { var c = byId[String(x.person_id)] || {}; x.name = (c.first_name || '') + ' ' + (c.last_name || ''); x.title = c.coaching_title || ''; return x; });
    var av = await sb.from('coach_availability').select('person_id,block').eq('date', CC.sdate);
    CC.avail = {}; (av.data || []).forEach(function (x) { (CC.avail[String(x.person_id)] = CC.avail[String(x.person_id)] || {})[x.block] = 1; });
    CC.pickFields = CC.pickFields || [];
  }
  async function loadEvals_() {
    if (!CC.coaches.length) { var c = await sb.from('coaches').select('person_id,first_name,last_name,coaching_title').order('last_name'); CC.coaches = c.data || []; }
    var r = await sb.from('eval_requests').select('id,game_id,game_date,venue,purpose,status,coach_person_id,ref_name,ref_person_id,note').in('status', ['requested', 'assigned']).order('game_date');
    CC.evalReqs = r.data || [];
    try { var cand = await sb.rpc('eval_candidates'); CC.cands = cand.data || []; } catch (e) { CC.cands = []; }
    // Who said they are free on the days with open requests, so the picker can put them first.
    var days = CC.evalReqs.filter(function (q) { return q.status === 'requested' && q.game_date; }).map(function (q) { return q.game_date; });
    CC.evalAvail = {};
    if (days.length) { var av2 = await sb.from('coach_availability').select('person_id,date,block').in('date', days); (av2.data || []).forEach(function (x) { (CC.evalAvail[x.date] = CC.evalAvail[x.date] || {})[String(x.person_id)] = ((CC.evalAvail[x.date] || {})[String(x.person_id)] || '') + x.block; }); }
    try { var tr = await sb.from('evaluations').select('id,ref_name,coach_name,game_date,report_at').eq('report_status', 'submitted').order('report_at'); CC.toReview = tr.data || []; } catch (e) { CC.toReview = []; }
  }
  async function loadEvals() { return load(loadEvals_()); }
  async function loadCo90_() { var r = await sb.rpc('co90_overview'); CC.co90 = r.data || []; }
  async function loadCo90() { return load(loadCo90_()); }
  function co90GroupCard(g) {
    var days21 = 21 * 86400000, now = Date.now();
    var lastAct = g.last_note_at ? new Date(g.last_note_at).getTime() : 0;
    (g.members || []).forEach(function (m) { if (m.last_seen) lastAct = Math.max(lastAct, new Date(m.last_seen + 'T12:00:00').getTime()); });
    var amber = g.status === 'active' && (!lastAct || now - lastAct > days21);
    var pickRow = function (kind, label, val) {
      var picking = CC.coPick && CC.coPick.g === g.id && CC.coPick.kind === kind;
      return '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><span><b>' + esc(label) + ':</b> ' + (val ? esc(val) : '<span class="hint">' + esc(t('co90None')) + '</span>') + '</span>' +
        '<button class="linkbtn" data-copick="' + g.id + '|' + kind + '">' + esc(t('co90Set')) + '</button></div>' +
        (picking ? coSearchHtml() : '');
    };
    var members = (g.members || []).map(function (m) {
      return '<div class="rowline"><div>' + refLink(m.name || '') + '<br><span class="hint' + (m.notes ? '' : '" style="color:var(--red)') + '">' + m.notes + ' ' + esc(t('co90Notes')) + (m.last_seen ? ', ' + esc(dayShort(m.last_seen)) : '') + '</span></div>' +
        '<button class="linkbtn" data-codel="' + g.id + '|' + m.person_id + '">' + esc(t('remove')) + '</button></div>';
    }).join('');
    var addPicking = CC.coPick && CC.coPick.g === g.id && CC.coPick.kind === 'member';
    var note = g.last_note;
    return '<div class="card" style="gap:8px;border-color:' + (amber ? 'var(--gold)' : 'var(--line)') + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline"><b style="font-size:17px">' + esc(g.name) + '</b><span class="hint">' + esc(String(g.season)) + (g.region ? ' \u00b7 ' + esc(g.region) : '') + (g.status !== 'active' ? ' \u00b7 ' + esc(t('co90Retired')) : '') + '</span></div>' +
      (amber ? '<div class="hint" style="color:var(--gold);font-weight:700">' + esc(t('co90Amber')) + '</div>' : '') +
      pickRow('mentor', t('co90Mentor'), g.mentor) +
      pickRow('national', t('co90National'), g.national) +
      '<div class="hint" style="font-weight:700;padding-top:4px">' + esc(t('co90MembersTitle').replace('{n}', (g.members || []).length)) + '</div>' + members +
      ((g.members || []).length < 8 ? '<button class="chip-btn small" data-copick="' + g.id + '|member">' + esc(t('co90AddRef')) + '</button>' + (addPicking ? coSearchHtml() : '') : '') +
      (note ? '<div class="hint" style="border-top:1px solid var(--line);padding-top:6px">\u201c' + esc(note.body) + '\u201d \u00b7 ' + esc(note.author || '') + ', ' + esc(dayShort(String(note.at).slice(0, 10))) + '</div>' : '') +
      '<textarea id="conote-' + g.id + '" placeholder="' + esc(t('co90NoteHint')) + '" style="font:inherit;width:100%;min-height:56px;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"></textarea>' +
      '<div class="actions" style="padding:0"><button class="btn outline small" data-conote="' + g.id + '">' + esc(t('co90Post')) + '</button>' +
      (g.status === 'active' ? '<button class="linkbtn" data-coretire="' + g.id + '">' + esc(t('co90Retire')) + '</button>' : '') + '</div></div>';
  }
  function coSearchHtml() {
    var hits = (CC.coHits || []).map(function (h) {
      return '<button class="chip-btn" data-cohit="' + h.person_id + '">' + esc(h.name) + (h.first_season ? ' <small>' + esc(t('co90FirstSeason').replace('{y}', h.first_season)) + '</small>' : '') + '</button>';
    }).join('');
    return '<input id="coQ" placeholder="' + esc(t('coachSearch')) + '" value="' + esc(CC.coQ || '') + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"><div class="chips">' + hits + '</div>';
  }
  function renderCenter() {
    var tabs = ['coverage', 'evals', 'schedule', 'coaches', 'co90', 'ai', 'queue'];
    var openN = (CC.evalReqs || []).filter(function (q) { return q.status === 'requested'; }).length || (S.evalWaiting || []).length;
    var head = '<div class="tabs">' + tabs.map(function (k) { return '<button class="chip-btn' + (CC.tab === k ? ' on' : '') + (k === 'evals' && openN && CC.tab !== k ? ' warn' : '') + '" data-tab="' + k + '">' + esc(t('tab' + k.charAt(0).toUpperCase() + k.slice(1))) + (k === 'evals' && openN ? ' (' + openN + ')' : '') + '</button>'; }).join('') + '</div>';
    var body = '';
    if (CC.tab === 'coverage') {
      var worked = CC.cov.length, seen = CC.cov.filter(function (r) { return r.notes > 0; }).length, never = worked - seen;
      var rel = 0, read = 0; CC.cov.forEach(function (r) { rel += r.released; read += r.read; });
      var never0 = CC.cov.filter(function (r) { return r.notes === 0; });
      var nextVenues = {}; never0.forEach(function (r) { if (r.next_venue) nextVenues[r.next_venue] = (nextVenues[r.next_venue] || 0) + 1; });
      var list = (CC.covVenue ? never0.filter(function (r) { return r.next_venue === CC.covVenue; }) : never0).slice(0, 60);
      var covPick = Object.keys(nextVenues).length > 1 ? '<div class="pad" style="padding-top:8px"><select id="covVenue" style="font:inherit;width:100%;padding:12px;border:2px solid var(--navy);border-radius:8px;background:var(--surface);color:var(--ink)"><option value="">' + esc(t('covAnyVenue')) + ' (' + never0.length + ')</option>' + Object.keys(nextVenues).sort().map(function (v) { return '<option value="' + esc(v) + '"' + (CC.covVenue === v ? ' selected' : '') + '>' + esc(v) + ' (' + nextVenues[v] + ')</option>'; }).join('') + '</select></div>' : '';
      body = '<div class="stats"><div class="stat"><b>' + worked + '</b><i>' + esc(t('stWorked')) + '</i></div><div class="stat green"><b>' + seen + '</b><i>' + esc(t('stSeen')) + '</i></div><div class="stat red"><b>' + never + '</b><i>' + esc(t('stNever')) + '</i></div></div>' +
        '<div class="pad" style="padding-top:12px"><div class="hint">' + esc(t('stRead')) + ': ' + read + ' / ' + rel + '</div><div class="bar"><i style="width:' + (rel ? Math.round(100 * read / rel) : 0) + '%"></i></div></div>' +
        '<div class="disp h2">' + esc(t('neverSeenTitle')) + '</div>' + covPick + '<div class="pad">' + list.map(function (r) {
          return '<div class="rowline"><div><b>' + refLink(r.name) + '</b><br><span class="hint">' + esc(t('lastGame')) + ' ' + esc(r.last_game ? dayLong(r.last_game) : '') + (r.next_game ? '. <b>' + esc(t('refNext')) + '</b> ' + esc(dayLong(r.next_game)) + ', ' + esc(r.next_venue || '') : '') + '</span></div><div class="n">' + r.games + '</div></div>';
        }).join('') + '</div>';
    } else if (CC.tab === 'evals') {
      var reqs = CC.evalReqs || [];
      var byId = {}; CC.coaches.forEach(function (c) { byId[String(c.person_id)] = c; });
      var open = reqs.filter(function (r) { return r.status === 'requested'; }), assigned = reqs.filter(function (r) { return r.status === 'assigned'; });
      var card = function (r) {
        var c = byId[String(r.coach_person_id)];
        var picking = CC.evalPick === r.id;
        var eligible = CC.coaches.filter(function (x) { return r.purpose !== 'upgrade_national' || /national|fifa/i.test(x.coaching_title || ''); });
        var q = (CC.evalQ || '').toLowerCase();
        return '<div class="card" style="gap:8px;border-color:' + (r.status === 'requested' ? 'var(--gold)' : 'var(--line)') + '"><div><b>' + refLink(r.ref_name) + '</b> <span class="hint">' + esc(t('evalPurpose.' + r.purpose)) + '</span><br><span class="hint">' + esc(dayLong(r.game_date)) + ', ' + esc(r.venue || '') + (r.note ? '. ' + esc(r.note) : '') + '</span></div>' +
          (c ? '<div>' + esc(t('evalCoach')) + ' <b>' + esc(c.first_name + ' ' + c.last_name) + '</b> <span class="hint">' + esc(c.coaching_title || '') + '</span></div>' : '') +
          (r.status === 'requested' ? (picking ? '<input id="evalQ" placeholder="' + esc(t('coachSearch')) + '" value="' + esc(CC.evalQ || '') + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"><div class="chips">' + eligible.filter(function (x) { return !q || (x.first_name + ' ' + x.last_name).toLowerCase().indexOf(q) >= 0; }).sort(function (a, b) { var fa = (CC.evalAvail[r.game_date] || {})[String(a.person_id)] ? 0 : 1, fb = (CC.evalAvail[r.game_date] || {})[String(b.person_id)] ? 0 : 1; return fa - fb || (a.last_name || '').localeCompare(b.last_name || ''); }).slice(0, 12).map(function (x) { var fr = (CC.evalAvail[r.game_date] || {})[String(x.person_id)]; return '<button class="chip-btn' + (fr ? ' avail' : '') + '" data-evalassign="' + x.person_id + '" data-req="' + r.id + '">' + (fr ? '\u2713 ' : '') + esc(x.first_name + ' ' + x.last_name) + ' <small>' + esc(x.coaching_title || '') + '</small></button>'; }).join('') + '</div>' + (r.purpose === 'upgrade_national' ? '<div class="hint">' + esc(t('evalNationalOnly')) + '</div>' : '') : '<div class="actions" style="padding:0"><button class="btn go small" data-evalpick="' + r.id + '">' + esc(t('evalAssign')) + '</button><button class="btn outline small" data-evaldecline="' + r.id + '">' + esc(t('evalDecline')) + '</button></div>') : '') +
          (r.status === 'assigned' ? '<button class="btn outline small" data-evaldone="' + r.id + '">' + esc(t('evalMarkDone')) + '</button>' : '') + '</div>';
      };
      body = '<div class="pad lead" style="padding-top:12px">' + esc(t('evalsLead')) + '</div><div class="disp h2">' + esc(t('evalsOpen')) + ' ' + open.length + '</div>' + (open.length ? open.map(card).join('') : '<div class="card"><div class="hint">' + esc(t('nothingHere')) + '</div></div>') +
        '<div class="disp h2">' + esc(t('evalsAssigned')) + ' ' + assigned.length + '</div>' + (assigned.length ? assigned.map(card).join('') : '<div class="card"><div class="hint">' + esc(t('nothingHere')) + '</div></div>') +
        ((CC.toReview || []).length ? '<div class="disp h2">' + esc(t('evalsToReview')) + ' ' + CC.toReview.length + '</div><div class="list">' + CC.toReview.map(function (e) { return '<a class="item" href="#eval/' + e.id + '"><div><b>' + esc(e.ref_name || '') + '</b><br><span class="hint">' + esc(t('evalCoach')) + ' ' + esc(e.coach_name || '') + (e.game_date ? ', ' + esc(dayLong(e.game_date)) : '') + '</span></div><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>'; }).join('') + '</div>' : '') +
        ((CC.cands || []).length ? '<div class="disp h2">' + esc(t('evalCandidates').replace('{y}', new Date().getFullYear())) + '</div><div class="pad hint" style="padding-top:0">' + esc(t('evalCandidatesHint')) + '</div><div class="pad" style="padding-top:6px"><table class="dt" style="width:100%"><thead><tr><th>' + esc(t('fitName')) + '</th><th>' + esc(t('evalPurposeCol')) + '</th><th class="n">' + esc(t('evalDoneCol')) + '</th><th class="n">' + esc(t('evalOpenCol')) + '</th></tr></thead><tbody>' + CC.cands.map(function (c) { var full = Number(c.done) >= Number(c.need); return '<tr class="' + (full ? 'passed' : '') + '"><td>' + refLink(c.name || '') + '</td><td>' + (c.person_id ? '<a class="refname" href="#upgrade/' + esc(c.person_id) + '">' + esc(t('evalPurpose.' + c.purpose) || c.purpose) + '</a>' : esc(t('evalPurpose.' + c.purpose) || c.purpose)) + '</td><td class="n"><b>' + esc(String(c.done)) + ' / ' + esc(String(c.need)) + '</b></td><td class="n">' + esc(String(c.requested)) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '');
    } else if (CC.tab === 'co90') {
      body = '<div class="pad lead" style="padding-top:12px">' + esc(t('co90Lead')) + '</div>' +
        '<div class="card" style="gap:8px"><div class="hint" style="font-weight:700">' + esc(t('co90New')) + '</div><input id="cgName" placeholder="' + esc(t('co90Name')) + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"><div class="actions" style="padding:0"><button class="btn outline small" id="cgCreate">' + esc(t('co90Create')) + '</button></div></div>' +
        ((CC.co90 || []).length ? (CC.co90 || []).map(co90GroupCard).join('') : '<div class="card"><div class="hint">' + esc(t('nothingHere')) + '</div></div>');
    } else if (CC.tab === 'schedule') {
      var todayAss = CC.assigns.filter(function (a) { return a.date === CC.sdate; });
      var avCount = Object.keys(CC.avail || {}).filter(function (k) { return CC.avail[k][CC.block]; }).length;
      body = '<div class="datebar"><button class="iconbtn" data-sday="-1" aria-label="Previous day">&#8249;</button><div class="d">' + esc(dayLong(CC.sdate)) + '</div><button class="iconbtn" data-sday="1" aria-label="Next day">&#8250;</button></div>' +
        '<div class="pad lead" style="padding-top:8px">' + esc(t('scheduleLead')) + '</div>' +
        '<div class="pad" style="padding-top:10px"><div class="chips"><button class="chip-btn' + (CC.block === 'am' ? ' on' : '') + '" data-sblock="am">' + esc(t('blockAm')) + '</button><button class="chip-btn' + (CC.block === 'pm' ? ' on' : '') + '" data-sblock="pm">' + esc(t('blockPm')) + '</button></div><div class="hint" style="padding-top:6px">' + esc(t('availableCount').replace('{n}', avCount)) + '</div></div>' +
        (CC.venues.length ? '<div class="pad" style="padding-top:10px"><label for="schedVenue" class="hint" style="font-weight:700;padding-bottom:6px;display:block">' + esc(t('venue')) + '</label><select id="schedVenue" style="font:inherit;width:100%;padding:12px;border:2px solid var(--navy);border-radius:8px;background:var(--surface);color:var(--ink)"><option value="">' + esc(t('schedVenuePick')) + '</option>' + CC.venues.map(function (v) { var n = todayAss.filter(function (a) { return a.venue === v && a.block === CC.block; }).length; return '<option value="' + esc(v) + '"' + (CC.pick === v ? ' selected' : '') + '>' + esc(v) + (n ? ' (' + n + ')' : '') + '</option>'; }).join('') + '</select></div>' : '<div class="card"><div class="hint">' + esc(t('noGamesDay')) + '</div></div>') +
        (CC.pick ? '<div class="disp h2">' + esc(CC.pick) + ', ' + esc(t(CC.block === 'am' ? 'blockAm' : 'blockPm')) + '</div><div class="pad">' + todayAss.filter(function (a) { return a.venue === CC.pick && a.block === CC.block; }).map(function (a) {
            return '<div class="rowline"><div><b>' + esc(a.name) + '</b> <span class="hint">' + esc(a.title || '') + '</span><br><span class="hint">' + esc((a.fields || []).join(', ') || t('wholeVenue')) + '</span></div><button class="linkbtn" data-unassign="' + a.id + '">' + esc(t('remove')) + '</button></div>';
          }).join('') + '</div><div class="card" style="gap:8px"><div class="hint" style="font-weight:700">' + esc(t('pickFields')) + '</div><div class="chips">' + (CC.fieldsAt[CC.pick] || []).map(function (f) { return '<button class="chip-btn' + (CC.pickFields.indexOf(f) >= 0 ? ' on' : '') + '" data-sfield="' + esc(f) + '">' + esc(fieldShort(f)) + '</button>'; }).join('') + '</div>' +
          '<div class="hint" style="font-weight:700;padding-top:6px">' + esc(t('addCoach')) + '</div><input id="coachQ" placeholder="' + esc(t('coachSearch')) + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"><div class="chips" id="coachPicks"></div><div class="hint">' + esc(t('availableMeans')) + '</div></div>' : '');
    } else if (CC.tab === 'coaches') {
      var by = {};
      CC.obs.forEach(function (o) {
        var k = key(o.observer) || '(unknown)'; var b = by[k] = by[k] || { name: o.observer, role: o.rater_role, notes: 0, refs: {}, released: 0, read: 0 };
        b.notes++; b.refs[key(o.ref_name)] = 1;
        if (o.cleanup_status === 'approved' || o.cleanup_status === 'edited') { b.released++; if (CC.reads[String(o.id)]) b.read++; }
      });
      var rows = Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.notes - a.notes; });
      body = '<div class="disp h2">' + esc(t('coachesTitle')) + '</div><div class="pad">' + (rows.length ? rows.map(function (b) {
        return '<div class="rowline"><div><a class="refname" href="#coachcard/' + encodeURIComponent(b.name) + '"><b>' + esc(b.name) + '</b></a>' + (b.role ? ' <span class="hint">' + esc(b.role) + '</span>' : '') + '<br><span class="hint">' + Object.keys(b.refs).length + ' ' + esc(t('coachRefs')) + ', ' + b.released + ' ' + esc(t('coachReleased')) + ', ' + b.read + ' ' + esc(t('coachRead')) + '</span></div><div class="n">' + b.notes + '</div></div>';
      }).join('') : '<div class="hint">' + esc(t('noCoachActivity')) + '</div>') + '</div>';
    } else if (CC.tab === 'ai') {
      body = '<div class="card" style="gap:10px"><div style="font-size:15px;line-height:1.45">' + esc(t('aiLead')) + '</div>' +
        '<div class="grid2"><div><label for="aiFrom" class="hint" style="font-weight:700">' + esc(t('aiFrom')) + '</label><input id="aiFrom" type="date" value="' + esc(CC.from) + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"></div><div><label for="aiTo" class="hint" style="font-weight:700">' + esc(t('aiTo')) + '</label><input id="aiTo" type="date" value="' + esc(CC.to) + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"></div></div>' +
        '<button class="btn primary" id="aiRun">' + esc(t('aiRun')) + '</button><div class="msg" id="aiMsg" hidden></div></div><div id="aiDrafts">' + draftsHtml() + '</div>';
    } else {
      var w = REV.notes.filter(function (n) { return revStatus(n) === 'pending'; }).length, cl = REV.notes.filter(function (n) { return revStatus(n) === 'cleaned'; }).length;
      body = '<div class="stats" style="grid-template-columns:1fr 1fr"><div class="stat' + (w ? ' red' : '') + '"><b>' + w + '</b><i>' + esc(t('queueWaiting')) + '</i></div><div class="stat' + (cl ? ' green' : '') + '"><b>' + cl + '</b><i>' + esc(t('queueCleaned')) + '</i></div></div><div class="pad" style="padding-top:12px"><a class="btn go" href="#review">' + esc(t('openReview')) + '</a></div>';
    }
    $('centerBody').innerHTML = head + body;
    $('centerBody').querySelectorAll('[data-tab]').forEach(function (b) { b.onclick = function () { CC.tab = b.getAttribute('data-tab'); if (CC.tab === 'queue' && !REV.notes.length) loadReview().then(renderCenter); else if (CC.tab === 'schedule') loadSchedule().then(renderCenter); else if (CC.tab === 'co90') loadCo90().then(renderCenter); else if (CC.tab === 'evals') loadEvals().then(renderCenter); else renderCenter(); }; });
    $('centerBody').querySelectorAll('[data-evalpick]').forEach(function (b) { b.onclick = function () { CC.evalPick = parseInt(b.getAttribute('data-evalpick'), 10); CC.evalQ = ''; renderCenter(); }; });
    var cv = $('covVenue'); if (cv) cv.onchange = function () { CC.covVenue = cv.value; renderCenter(); };
    var sv = $('schedVenue'); if (sv) sv.onchange = function () { CC.pick = sv.value || null; CC.pickFields = []; renderCenter(); };
    var eq = $('evalQ'); if (eq) { eq.oninput = function () { CC.evalQ = eq.value; renderCenter(); var x = $('evalQ'); if (x) { x.focus(); x.setSelectionRange(x.value.length, x.value.length); } }; }
    $('centerBody').querySelectorAll('[data-evalassign]').forEach(function (b) { b.onclick = async function () { b.disabled = true; var coach = parseInt(b.getAttribute('data-evalassign'), 10), id = parseInt(b.getAttribute('data-req'), 10); var r = CC.evalReqs.filter(function (x) { return x.id === id; })[0]; var ok = await sb.rpc('may_evaluate', { p_coach: coach, p_purpose: r.purpose }); if (!ok.data) { b.disabled = false; return; } await sb.from('eval_requests').update({ status: 'assigned', coach_person_id: coach, assigned_by: S.me.person_id, assigned_at: new Date().toISOString() }).eq('id', id); CC.evalPick = null; await loadEvals(); renderCenter(); }; });
    $('centerBody').querySelectorAll('[data-evaldecline]').forEach(function (b) { b.onclick = async function () { b.disabled = true; await sb.from('eval_requests').update({ status: 'declined' }).eq('id', parseInt(b.getAttribute('data-evaldecline'), 10)); await loadEvals(); renderCenter(); }; });
    $('centerBody').querySelectorAll('[data-evaldone]').forEach(function (b) { b.onclick = async function () { b.disabled = true; await sb.from('eval_requests').update({ status: 'done' }).eq('id', parseInt(b.getAttribute('data-evaldone'), 10)); await loadEvals(); renderCenter(); }; });
    var cg = $('cgCreate');
    if (cg) cg.onclick = async function () { var nm = ($('cgName').value || '').trim(); if (!nm) return; cg.disabled = true; await sb.from('co90_groups').insert({ org_id: S.me.org_id, season: regSeason(), name: nm }); await loadCo90(); renderCenter(); };
    $('centerBody').querySelectorAll('[data-copick]').forEach(function (b) { b.onclick = function () { var p = b.getAttribute('data-copick').split('|'); CC.coPick = { g: parseInt(p[0], 10), kind: p[1] }; CC.coQ = ''; CC.coHits = []; renderCenter(); var q = $('coQ'); if (q) q.focus(); }; });
    $('centerBody').querySelectorAll('[data-codel]').forEach(function (b) { b.onclick = async function () { var p = b.getAttribute('data-codel').split('|'); b.disabled = true; await sb.from('co90_members').delete().eq('group_id', parseInt(p[0], 10)).eq('person_id', parseInt(p[1], 10)); await loadCo90(); renderCenter(); }; });
    $('centerBody').querySelectorAll('[data-coretire]').forEach(function (b) { b.onclick = async function () { b.disabled = true; await sb.from('co90_groups').update({ status: 'retired' }).eq('id', parseInt(b.getAttribute('data-coretire'), 10)); await loadCo90(); renderCenter(); }; });
    $('centerBody').querySelectorAll('[data-conote]').forEach(function (b) { b.onclick = async function () { var gid = parseInt(b.getAttribute('data-conote'), 10); var ta = $('conote-' + gid); var body = (ta && ta.value || '').trim(); if (!body) return; b.disabled = true; await sb.from('co90_notes').insert({ group_id: gid, org_id: S.me.org_id, author_person_id: S.me.person_id, author_name: S.me.first_name + ' ' + S.me.last_name, body: body }); await loadCo90(); renderCenter(); }; });
    var coQ = $('coQ');
    if (coQ) { coQ.oninput = async function () { CC.coQ = coQ.value; if (CC.coQ.trim().length < 2) return; var r = await sb.rpc('co90_find_person', { p_q: CC.coQ.trim() }); CC.coHits = r.data || []; renderCenter(); var q2 = $('coQ'); if (q2) { q2.focus(); q2.setSelectionRange(q2.value.length, q2.value.length); } }; }
    $('centerBody').querySelectorAll('[data-cohit]').forEach(function (b) { b.onclick = async function () { var pid = parseInt(b.getAttribute('data-cohit'), 10), pk = CC.coPick; if (!pk) return; b.disabled = true;
      if (pk.kind === 'member') await sb.from('co90_members').insert({ group_id: pk.g, person_id: pid, org_id: S.me.org_id });
      else await sb.from('co90_groups').update(pk.kind === 'mentor' ? { mentor_person_id: pid } : { national_person_id: pid }).eq('id', pk.g);
      CC.coPick = null; CC.coHits = []; CC.coQ = ''; await loadCo90(); renderCenter(); }; });
    $('centerBody').querySelectorAll('[data-sday]').forEach(function (b) { b.onclick = function () { CC.sdate = shiftDate(CC.sdate, parseInt(b.getAttribute('data-sday'), 10)); CC.pick = null; loadSchedule().then(renderCenter); }; });
    $('centerBody').querySelectorAll('[data-svenue]').forEach(function (b) { b.onclick = function () { CC.pick = b.getAttribute('data-svenue'); CC.pickFields = []; renderCenter(); }; });
    $('centerBody').querySelectorAll('[data-sblock]').forEach(function (b) { b.onclick = function () { CC.block = b.getAttribute('data-sblock'); renderCenter(); }; });
    $('centerBody').querySelectorAll('[data-sfield]').forEach(function (b) { b.onclick = function () { var f = b.getAttribute('data-sfield'); var i = CC.pickFields.indexOf(f); if (i >= 0) CC.pickFields.splice(i, 1); else CC.pickFields.push(f); renderCenter(); }; });
    $('centerBody').querySelectorAll('[data-unassign]').forEach(function (b) { b.onclick = async function () { b.disabled = true; await sb.from('coach_assignments').delete().eq('id', parseInt(b.getAttribute('data-unassign'), 10)); await loadSchedule(); renderCenter(); }; });
    var cq = $('coachQ');
    if (cq) {
      var drawPicks = function () {
        var q = cq.value.trim().toLowerCase();
        var list = CC.coaches.filter(function (c) { return !q || (c.first_name + ' ' + c.last_name).toLowerCase().indexOf(q) >= 0; });
        list.sort(function (a, b) { var aa = (CC.avail[String(a.person_id)] || {})[CC.block] ? 0 : 1, bb = (CC.avail[String(b.person_id)] || {})[CC.block] ? 0 : 1; return aa - bb || a.last_name.localeCompare(b.last_name); });
        list = list.slice(0, 14);
        $('coachPicks').innerHTML = list.map(function (c) { var av = (CC.avail[String(c.person_id)] || {})[CC.block]; return '<button class="chip-btn' + (av ? ' avail' : '') + '" data-assign="' + c.person_id + '">' + (av ? '\u2713 ' : '') + esc(c.first_name + ' ' + c.last_name) + (c.coaching_title ? ' <small>' + esc(c.coaching_title) + '</small>' : '') + '</button>'; }).join('');
        $('coachPicks').querySelectorAll('[data-assign]').forEach(function (b) {
          b.onclick = async function () {
            b.disabled = true;
            var r = await sb.from('coach_assignments').insert({ org_id: S.me.org_id, date: CC.sdate, person_id: parseInt(b.getAttribute('data-assign'), 10), venue: CC.pick, block: CC.block, fields: CC.pickFields.slice(), created_by: S.me.person_id });
            if (r.error) { b.disabled = false; return; }
            await loadSchedule(); renderCenter();
          };
        });
      };
      cq.oninput = drawPicks; drawPicks();
    }
    var run = $('aiRun');
    if (run) run.onclick = async function () {
      CC.from = $('aiFrom').value; CC.to = $('aiTo').value;
      run.disabled = true; run.textContent = t('aiRunning');
      try { var j = await post({ action: 'coachDrafts', from: CC.from, to: CC.to }); CC.drafts = j.drafts || []; }
      catch (e) { var m = $('aiMsg'); m.hidden = false; m.className = 'msg bad'; m.textContent = t('aiFailed') + ' ' + (e.message || ''); }
      renderCenter();
    };
    $('centerBody').querySelectorAll('[data-send]').forEach(function (b) {
      b.onclick = async function () {
        var d = CC.drafts[parseInt(b.getAttribute('data-send'), 10)];
        b.disabled = true; b.textContent = t('aiSending');
        try { await post({ action: 'sendCoachEmail', rowNum: d.rowNum, coach: d.coach, email: d.email, text: d.draft }); b.textContent = t('aiSent'); }
        catch (e) { b.disabled = false; b.textContent = t('aiSend') + ' ' + d.coach; }
      };
    });
  }
  function draftsHtml() {
    if (CC.drafts === null) return '';
    if (!CC.drafts.length) return '<div class="card"><div class="hint">' + esc(t('aiNone')) + '</div></div>';
    return CC.drafts.map(function (d, i) {
      return '<div class="card" style="gap:8px"><div><b>' + esc(d.coach) + '</b>' + (d.grade ? ' <span class="pill">' + esc(d.grade) + '</span>' : '') + (d.email ? '<br><span class="hint">' + esc(d.email) + '</span>' : '<br><span class="hint" style="color:var(--red)">' + esc(t('aiNoEmail')) + '</span>') + '</div><div class="draft">' + esc(d.draft || '') + '</div>' + (d.email ? '<button class="btn outline small" data-send="' + i + '">' + esc(t('aiSend')) + ' ' + esc(d.coach) + '</button>' : '') + '</div>';
    }).join('');
  }

  // ── Command Center: operations (the board) ───────────────────────
  var OPS = { tab: 'board', date: '', venue: null, edit: null, games: [], checkins: [], help: [], bulletins: [], alerts: [], sound: false, _lastAttn: null };
  try { OPS.sound = localStorage.getItem('hub-ops-sound') === '1'; } catch (e) {}
  // Two short tones. Needs a tap first (the toggle) so the browser allows audio.
  function opsBeep() {
    try {
      var ac = opsBeep._ac || (opsBeep._ac = new (window.AudioContext || window.webkitAudioContext)());
      [0, 0.22].forEach(function (at, i) {
        var o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = i ? 660 : 880; o.connect(g); g.connect(ac.destination);
        g.gain.setValueAtTime(0.0001, ac.currentTime + at);
        g.gain.exponentialRampToValueAtTime(0.3, ac.currentTime + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + at + 0.18);
        o.start(ac.currentTime + at); o.stop(ac.currentTime + at + 0.2);
      });
    } catch (e) {}
  }
  function shiftDate(iso, n) { var d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return iso.length ? iso.slice(0, 0) + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : iso; }
  async function loadOps_() {
    if (!OPS.date) OPS.date = todayStr();
    if (OPS.focus == null) { try { OPS.focus = localStorage.getItem('hub-focus') === '1'; } catch (e) { OPS.focus = false; } }
    var r = await Promise.all([
      fetchAll(function () { return sb.from('games').select('game_id,kickoff,field,age_group,competition,cr,ar1,ar2,fourth,venue,status,game_num,hq_role,hq_staff,home,away').eq('date', OPS.date).not('status', 'in', '(C,X,canceled_no_pay)').order('venue').order('kickoff'); }),
      fetchAll(function () { return sb.from('checkins').select('ref_name,game_id,created_at').eq('date', OPS.date).order('created_at'); }),
      sb.from('emergencies').select('id,src_key,created_at,ref_name,venue,field,reason,status,ack_by').gte('created_at', OPS.date + 'T00:00:00').lte('created_at', OPS.date + 'T23:59:59').order('created_at', { ascending: false }),
      sb.from('announcements').select('id,src_key,created_at,start_date,end_date,venue,event_id,title,body,severity,active,posted_by').order('created_at', { ascending: false }).limit(40),
      sb.from('staff_messages').select('id,from_name,to_venue,date,body,created_at').eq('date', OPS.date).order('created_at', { ascending: false }).limit(100),
      sb.from('alerts').select('id,kind,game_id,ref_name,position,game_date,venue,field,kickoff,age_group,detail,status,seen_by').gte('game_date', todayStr()).order('game_date').order('kickoff').limit(300),
      sb.from('late_notices').select('id,game_id,ref_name,venue,field,eta_min,created_at,ack_by,ack_at').eq('date', OPS.date),
      iCan('command_center') ? sb.rpc('unreported_games', { p_days: 7 }) : Promise.resolve({ data: null }),
      (iCan('command_center') || iCan('scheduling')) ? sb.rpc('assignr_pending') : Promise.resolve({ data: null })
    ]);
    OPS.unreported = r[7] && r[7].data || null;
    OPS.e5 = r[8] && r[8].data || null;
    if (r[0].error) { OPS.error = r[0].error.message || String(r[0].error); return; }   // keep what we have, say why
    OPS.late = r[6].data || [];
    OPS.error = '';
    OPS.games = r[0].data || [];
    OPS.checkins = r[1].data || [];
    OPS.help = r[2].data || [];
    OPS.bulletins = r[3].data || [];
    OPS.msgs = r[4].data || [];
    OPS.alerts = r[5].data || [];
    var namesHere = {}; OPS.games.forEach(function (g) { ['cr', 'ar1', 'ar2', 'fourth'].forEach(function (k) { if (g[k]) namesHere[g[k]] = 1; }); });
    var nl = Object.keys(namesHere), qs = [];
    for (var i = 0; i < nl.length; i += 200) qs.push(sb.from('observations').select('ref_name').in('ref_name', nl.slice(i, i + 200)).in('cleanup_status', ['approved', 'edited']).limit(1000));
    OPS.seen = {};
    (await Promise.all(qs)).forEach(function (sn) { (sn.data || []).forEach(function (o) { OPS.seen[key(o.ref_name)] = 1; }); });
  }
  function isHQ(g) { return /ref(eree)?\s*hq|site coordinator|standby/i.test(String(g.field || '') + ' ' + String(g.age_group || '')) || (g.hq_role && g.hq_role !== ''); }
  function hqCardHtml(games) {
    var staff = [], seen = {};
    games.filter(isHQ).forEach(function (g) {
      var arr = []; try { arr = JSON.parse(g.hq_staff || '[]'); } catch (e) {}
      if (!arr.length) ['cr', 'ar1', 'ar2', 'fourth'].forEach(function (k) { if (g[k]) arr.push({ name: g[k], posAb: g.hq_role || (/standby/i.test(g.field + ' ' + g.age_group) ? 'Standby' : 'SC') }); });
      arr.forEach(function (p) { if (p.name && !seen[p.name]) { seen[p.name] = 1; staff.push(p); } });
    });
    if (!staff.length) return '';
    return '<div class="hqcard"><div class="disp" style="font-size:22px">' + esc(t('refereeHQ')) + '</div><div class="hint" style="margin-top:4px">' + esc(t('siteStaff')) + '</div><div class="chips" style="margin-top:6px">' + staff.map(function (p) { return '<span class="pill ok">' + esc(p.name) + ' <small>' + esc(p.posAb || '') + '</small></span>'; }).join('') + '</div></div>';
  }
  function searchHtml() {
    return '<div class="pad" style="padding-top:12px"><input id="opsFind" type="search" placeholder="' + esc(t('findRefHere')) + '" value="' + esc(OPS.find || '') + '" style="font:inherit;width:100%;padding:12px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"></div>';
  }
  function gameState(g) {
    var k = new Date(g.kickoff).getTime(), now = Date.now();
    if (now < k) return 'upcoming';
    if (now < k + 100 * 60000) return 'live';
    return 'done';
  }
  function slotsHtml(games, ins) {
    var find = (OPS.find || '').toLowerCase();
    var slots = {}, order = [];
    games.filter(function (g) { return !isHQ(g); }).forEach(function (g) {
      if (find && !['cr', 'ar1', 'ar2', 'fourth'].some(function (k) { return g[k] && g[k].toLowerCase().indexOf(find) >= 0; })) return;
      var k = clock(g.kickoff); if (!slots[k]) { slots[k] = []; order.push(k); }
      slots[k].push(g);
    });
    if (!order.length) return '<div class="card"><div class="hint">' + esc(t('nothingHere')) + '</div></div>';
    var slotHtml = function (k) {
      var list = slots[k].sort(function (a, b) { return String(a.field).localeCompare(String(b.field), undefined, { numeric: true }); });
      return '<div class="slot"><div class="disp">' + esc(k) + '</div><div class="hint">' + list.length + ' ' + esc(t(list.length === 1 ? 'fieldOne' : 'fieldMany')) + '</div></div><div class="fields">' + list.map(function (g) {
        var open = OPS.edit === String(g.game_id) && !OPS.editForm, st = gameState(g);
        var crew = ['cr', 'ar1', 'ar2', 'fourth'].filter(function (x) { return g[x]; });
        var dots = crew.map(function (x) { var n = g[x]; var tbd = /^(tbd|open|none)$/i.test(n); return '<span class="dot' + (tbd ? ' none' : ins[key(n)] ? ' in' : '') + '"></span>'; }).join('');
        var body = !open ? '' : '<div style="border-top:1px solid var(--line);margin-top:6px;padding-top:8px;display:flex;flex-direction:column;gap:6px">' +
          '<div class="hint">' + esc(g.age_group || '') + (g.game_num ? ', ' + esc(g.game_num) : '') + (g.home ? '. ' + esc(g.home) + ' v ' + esc(g.away || '') : '') + '</div>' +
          crew.map(function (x) { var n = g[x], at = ins[key(n)]; return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span><b' + (OPS.seen && !OPS.seen[key(n)] && !/^(tbd|open|none)$/i.test(n) ? ' style="color:var(--red)"' : '') + '>' + refLink(n) + '</b> <span class="hint">' + esc(t('role.' + x)) + '</span></span>' + (at ? '<span class="state in">' + esc(clock(at)) + '</span>' : (iCan('scheduling') || iCan('command_center') ? '<button class="btn outline small" data-checkin="' + esc(n) + '" data-gid="' + esc(g.game_id) + '">' + esc(t('staffCheckin')) + '</button>' : '<span class="state out">' + esc(t('notIn')) + '</span>')) + '</div>'; }).join('') +
          (iCan('scheduling') ? '<button class="btn outline small" data-switch="' + esc(g.game_id) + '">' + esc(t('change')) + '</button>' : '') + '</div>';
        return '<div class="fcard' + (st === 'live' ? ' live' : '') + (open ? ' open' : '') + '" data-fcard="' + esc(g.game_id) + '"><div class="fname">' + esc(g.field || '') + '</div><div class="dots">' + dots + '</div><div class="fstate' + (st === 'live' ? ' live' : '') + '">' + esc(t('state_' + st)) + '</div>' + body + '</div>';
      }).join('') + '</div>';
    };
    // Finished time slots fold away so the live and next ones are at the top.
    var finished = order.filter(function (k) { return slots[k].every(function (g) { return gameState(g) === 'done'; }); });
    var active = order.filter(function (k) { return finished.indexOf(k) < 0; });
    return active.map(slotHtml).join('') + (finished.length ? fold('ops-finished-' + OPS.date, t('finishedSlots'), finished.length, finished.map(slotHtml).join(''), !active.length) : '');
  }
  function inSet() { var s = {}; OPS.checkins.forEach(function (c) { s[key(c.ref_name)] = c.created_at; }); return s; }
  // Needs attention: only the games where something is wrong right now.
  // A crew member not checked in with kickoff inside 45 minutes or the
  // game under way, an open slot, an open Help call, or an open
  // protection alert. Finished games never. Everything green is hidden,
  // so a Site Coordinator at twenty fields sees only the fields to walk to.
  var ATTN_WARN = 30, ATTN_ALERT = 15, ATTN_MINS = 30;
  function lateFor(name, g) { return (OPS.late || []).filter(function (l) { return key(l.ref_name) === key(name) && (String(l.game_id) === String(g.game_id) || l.venue === g.venue); })[0]; }
  function attentionItems(games, ins) {
    var now = Date.now(), out = [];
    var helpByVenue = {}; OPS.help.forEach(function (h) { if (h.status === 'open') (helpByVenue[h.venue] = helpByVenue[h.venue] || []).push(h); });
    games.forEach(function (g) {
      if (isHQ(g) || isCoachSlot(g)) return;
      var st = gameState(g); if (st === 'done') return;
      var k = new Date(g.kickoff).getTime(), minsTo = (k - now) / 60000, soon = st === 'live' || minsTo <= ATTN_WARN, urgent = st === 'live' || minsTo <= ATTN_ALERT;
      var missing = [], open = [], late = [];
      ['cr', 'ar1', 'ar2', 'fourth'].forEach(function (x) { var n = g[x]; if (!n) return; if (/^(tbd|open|none)$/i.test(n)) open.push(t('role.' + x)); else if (!ins[key(n)]) { var l = lateFor(n, g); if (l) late.push({ name: n, role: t('role.' + x), l: l }); else missing.push({ name: n, role: t('role.' + x) }); } });
      var alerts = OPS.alerts.filter(function (a) { return a.status === 'open' && String(a.game_id) === String(g.game_id); });
      var help = (helpByVenue[g.venue] || []).filter(function (h) { return !h.field || key(h.field) === key(g.field); });
      var why = [];
      var nameLink = function (n) { return '<a class="refname" href="#ref/' + encodeURIComponent(n) + '">' + esc(n) + '</a>'; };
      if (soon && missing.length) why.push({ kind: urgent ? 'missing' : 'warn', html: esc(t(urgent ? 'attnMissing' : 'attnWarn').replace('{n}', missing.length)) + ' ' + missing.map(function (m) { return nameLink(m.name) + ' (' + esc(m.role) + ')'; }).join(', ') });
      late.forEach(function (x) { why.push({ kind: x.l.ack_at ? 'late-ok' : 'late', html: esc((x.l.ack_at ? t('attnLateAcked') : t('attnLate')).replace('{n}', x.l.eta_min || '').replace('{t}', clock(x.l.created_at))).replace('{name}', nameLink(x.name)), late: x.l }); });
      if (open.length) why.push({ kind: 'open', text: t('attnOpen') + ' ' + open.join(', ') });
      if (help.length) why.push({ kind: 'help', text: t('attnHelp') + ' ' + help.map(function (h) { return h.reason || ''; }).join(', ') });
      if (alerts.length) why.push({ kind: 'alert', text: t('attnAlert') + ' ' + alerts.map(function (a) { return a.detail || a.kind || ''; }).join('; ') });
      if (why.length) out.push({ g: g, st: st, mins: Math.round(minsTo), why: why, severe: !!(help.length || (urgent && missing.length)) });
    });
    out.sort(function (a, b) { return (b.severe - a.severe) || (new Date(a.g.kickoff) - new Date(b.g.kickoff)); });
    return out;
  }
  function attentionHtml(games, ins, showVenue) {
    var items = attentionItems(games, ins);
    if (!items.length) return '<div class="card" style="border-color:var(--green);text-align:center;gap:4px"><div class="disp" style="font-size:30px;color:var(--green)">' + esc(t('attnClear')) + '</div><div class="hint">' + esc(t('attnClearHint').replace('{m}', ATTN_MINS)) + '</div></div>';
    return '<div class="pad hint" style="padding-top:10px">' + esc(t('attnLead').replace('{n}', items.length).replace('{m}', ATTN_MINS)) + '</div>' + items.map(function (it) {
      var g = it.g;
      return '<div class="card attn' + (it.severe ? ' severe' : '') + '" data-attn="' + esc(g.game_id) + '" data-attn-venue="' + esc(g.venue || '') + '"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><span class="disp" style="font-size:26px">' + esc(clock(g.kickoff)) + '</span><span class="hint">' + (it.st === 'live' ? esc(t('state_live')) : it.mins <= 0 ? '' : esc(t('inMins').replace('{n}', it.mins))) + '</span></div>' +
        '<div><b>' + esc(g.field || '') + '</b>' + (showVenue ? ' <span class="hint">' + esc(g.venue || '') + '</span>' : '') + ' <span class="hint">' + esc(g.age_group || '') + '</span> <a class="chip-btn small" style="text-decoration:none;margin-left:6px" href="#map/' + encodeURIComponent(g.venue || '') + '/' + encodeURIComponent(g.field || '') + '">' + esc(t('map')) + '</a></div>' +
        it.why.map(function (w) { return '<div class="why ' + w.kind + '">' + (w.html || esc(w.text)) + (w.kind === 'late' ? ' <button class="btn outline small" data-late-ack="' + w.late.id + '">' + esc(t('lateAck')) + '</button>' : '') + '</div>'; }).join('') + '</div>';
    }).join('');
  }
  // Every name on a crew today, this venue first, for the switch form's typeahead.
  function swNames(venue) {
    var here = {}, all = {};
    OPS.games.forEach(function (g) { ['cr', 'ar1', 'ar2', 'fourth'].forEach(function (k) { var n = g[k]; if (!n || /^(tbd|open|none)$/i.test(n)) return; (g.venue === venue ? here : all)[n] = 1; }); });
    (OPS.checkins || []).forEach(function (c) { if (c.ref_name && !here[c.ref_name]) all[c.ref_name] = 1; });
    return Object.keys(here).sort().concat(Object.keys(all).filter(function (n) { return !here[n]; }).sort());
  }
  function renderOps() {
    var tabs = iCan('people') ? ['board', 'staff', 'protection', 'retain', 'premium', 'bulletins'] : ['board', 'staff', 'protection', 'retain', 'bulletins'];
    var openAlerts = OPS.alerts.filter(function (a) { return a.status === 'open'; }).length, msgCount = (OPS.msgs || []).length;
    var head = '<div class="tabs">' + tabs.map(function (k) { return '<button class="chip-btn' + (OPS.tab === k ? ' on' : '') + '" data-otab="' + k + '">' + esc(t('tab' + k.charAt(0).toUpperCase() + k.slice(1))) + (k === 'protection' && openAlerts ? ' ' + openAlerts : '') + (k === 'staff' && msgCount ? ' ' + msgCount : '') + '</button>'; }).join('') + '</div>';
    var body = '';
    if (OPS.tab === 'board') {
      var ins = inSet(), venues = {};
      // Referee HQ and coach slots are staff, not games: they count on the
      // Staff tab, never in a venue's game or crew numbers.
      var realGames = 0;
      OPS.games.forEach(function (g) {
        var v = venues[g.venue] = venues[g.venue] || { name: g.venue, games: 0, slots: 0, in: 0, help: 0 };
        if (isHQ(g) || isCoachSlot(g)) return;
        v.games++; realGames++;
        ['cr', 'ar1', 'ar2', 'fourth'].forEach(function (k) { if (g[k]) { v.slots++; if (ins[key(g[k])]) v.in++; } });
      });
      OPS.help.forEach(function (h) { if (h.status === 'open' && venues[h.venue]) venues[h.venue].help++; });
      var vlist = Object.keys(venues).sort().map(function (k) { return venues[k]; });
      var totIn = 0, totSlots = 0; vlist.forEach(function (v) { totIn += v.in; totSlots += v.slots; });
      var open = OPS.help.filter(function (h) { return h.status === 'open'; }).length;
      var un = OPS.unreported;
      var unCard = (un && un.total) ? fold('unrep', t('unrepTitle'), un.total, '<div class="hint">' + esc(t('unrepHint')) + '</div>' + (un.rows || []).map(function (u) { return '<div class="rowline"><div><b>' + esc(dayShort(u.date)) + ', ' + esc(u.venue || '') + '</b><br><span class="hint">' + esc(u.competition || '') + '</span></div><span class="pill bad">' + u.missing + '</span></div>'; }).join('')) : '';
      // E5: Hub edits to Assignr games wait here until someone confirms they
      // were typed into Assignr too. The API is read-only; hands are the sync.
      var e5Card = (OPS.e5 && OPS.e5.length) ? fold('e5', t('e5Title'), OPS.e5.length, '<div class="hint">' + esc(t('e5Hint')) + '</div>' + OPS.e5.map(function (g) {
        var crew = ['cr', 'ar1', 'ar2', 'fourth'].map(function (k) { return g[k]; }).filter(Boolean).join(', ');
        return '<div class="rowline"><div><b>' + esc(dayShort(g.date)) + ', ' + clock(g.kickoff) + ', ' + esc(g.venue || '') + (g.field ? ' ' + esc(g.field) : '') + '</b>' + (String(g.status || '') === 'C' ? ' <span class="pill bad">' + esc(t('asgCanceledBadge')) + '</span>' : '') + '<br><span class="hint">' + esc(g.game_num || '') + (g.competition ? ', ' + esc(g.competition) : '') + (crew ? '. ' + esc(crew) : '') + (g.edited_at ? '. ' + esc(t('e5Edited')) + ' ' + esc(ago(g.edited_at)) : '') + '</span></div><button class="btn outline small" data-e5="' + g.game_id + '">' + esc(t('e5Mark')) + '</button></div>';
      }).join('')) : '';
      body = (OPS.error ? '<div class="msg bad" style="margin:10px 20px 0">' + esc(t('loadFailed')) + ' ' + esc(OPS.error) + '</div>' : '') + '<div class="datebar"><button class="iconbtn" data-day="-1" aria-label="Previous day">&#8249;</button><div class="d">' + esc(dayLong(OPS.date)) + '</div><button class="iconbtn" data-day="1" aria-label="Next day">&#8250;</button></div>' +
        '<div class="stats" style="grid-template-columns:repeat(4,1fr)"><div class="stat"><b>' + vlist.length + '</b><i>' + esc(t('stVenues')) + '</i></div><div class="stat"><b>' + realGames + '</b><i>' + esc(t('stGames')) + '</i></div><div class="stat green"><b>' + totIn + '</b><i>' + esc(t('stCheckedIn')) + ' / ' + totSlots + '</i></div><div class="stat' + (open ? ' red' : '') + '"><b>' + open + '</b><i>' + esc(t('stHelpOpen')) + '</i></div></div>';
      var attnCount = vlist.length ? attentionItems(OPS.games, ins).length : 0;
      if (vlist.length) {
        // A new item needing attention can ring the tablet at Referee HQ.
        if (OPS.sound && OPS._lastAttn != null && attnCount > OPS._lastAttn) opsBeep();
        OPS._lastAttn = attnCount;
        body += '<div class="pad" style="padding-top:12px"><div class="chips"><button class="chip-btn' + (OPS.focus ? ' on' : '') + '" data-focus="1">' + esc(t('attnTab')) + (attnCount ? ' ' + attnCount : '') + '</button><button class="chip-btn' + (!OPS.focus ? ' on' : '') + '" data-focus="0">' + esc(t('attnAll')) + '</button><button class="chip-btn' + (OPS.sound ? ' on' : '') + '" id="opsSnd">\uD83D\uDD14 ' + esc(t(OPS.sound ? 'opsSndOn' : 'opsSndOff')) + '</button></div></div>';
      }
      if (!vlist.length) body += '<div class="card"><div class="hint">' + esc(t('noGamesDay')) + '</div></div>';
      else if (OPS.focus) body += attentionHtml(OPS.venue ? OPS.games.filter(function (g) { return g.venue === OPS.venue; }) : OPS.games, ins, !OPS.venue) + (OPS.venue ? '<div class="pad" style="padding-top:12px"><button class="btn outline small" data-venue="">' + esc(t('allVenues')) + '</button></div>' : '');
      else if (!OPS.venue && vlist.length > 4) {
        body += '<div class="pad" style="padding-top:12px"><select id="opsVenueSel" style="font:inherit;width:100%;padding:12px;border:2px solid var(--navy);border-radius:8px;background:var(--surface);color:var(--ink)"><option value="">' + esc(t('allVenuesPick')) + '</option>' + vlist.map(function (v) { return '<option value="' + esc(v.name) + '">' + esc(v.name) + ' (' + v.in + '/' + v.slots + (v.help ? ', ' + v.help + ' ' + esc(t('helpOpenAt')) : '') + ')</option>'; }).join('') + '</select></div>' +
          vlist.map(function (v) {
            return '<a class="venue" href="#" data-venue="' + esc(v.name) + '"><div class="t">' + esc(v.name) + '</div><div class="m"><span>' + v.games + ' ' + esc(t('stGames')) + '</span><span class="in">' + v.in + ' / ' + v.slots + ' ' + esc(t('stCheckedIn')) + '</span>' + (v.help ? '<span class="help">' + v.help + ' ' + esc(t('helpOpenAt')) + '</span>' : '') + '</div></a>';
          }).join('');
      }
      else if (!OPS.venue) {
        body += vlist.map(function (v) {
          return '<a class="venue" href="#" data-venue="' + esc(v.name) + '"><div class="t">' + esc(v.name) + '</div><div class="m"><span>' + v.games + ' ' + esc(t('stGames')) + '</span><span class="in">' + v.in + ' / ' + v.slots + ' ' + esc(t('stCheckedIn')) + '</span>' + (v.help ? '<span class="help">' + v.help + ' ' + esc(t('helpOpenAt')) + '</span>' : '') + '</div></a>';
        }).join('');
      } else {
        var games = OPS.games.filter(function (g) { return g.venue === OPS.venue; });
        var helps = OPS.help.filter(function (h) { return h.venue === OPS.venue; });
        body += '<div class="pad" style="padding-top:12px;display:flex;gap:8px"><button class="btn outline small" data-venue="">' + esc(t('allVenues')) + '</button><a class="btn outline small" href="#map/' + encodeURIComponent(OPS.venue) + '/">' + esc(t('map')) + '</a></div><div class="disp h2">' + esc(OPS.venue) + '</div>' +
          (helps.length ? helps.map(function (h) { return '<div class="card" style="border-color:' + (h.status === 'open' ? 'var(--red)' : 'var(--line)') + '"><b>' + esc(h.reason || '') + '</b><div class="hint">' + esc(h.ref_name || '') + ', ' + esc(h.field || '') + ', ' + esc(clock(h.created_at)) + (h.status !== 'open' ? ', ' + esc(h.status) + (h.ack_by ? ' ' + esc(h.ack_by) : '') : '') + '</div>' + (h.status === 'open' && iCan('scheduling') ? '<div class="actions" style="padding:0"><button class="btn outline small" data-ack="enroute" data-key="' + esc(h.src_key) + '">' + esc(t('ackEnroute')) + '</button><button class="btn go small" data-ack="handled" data-key="' + esc(h.src_key) + '">' + esc(t('ackHandled')) + '</button></div>' : (h.status === 'open' ? '<div class="hint" style="color:var(--red)">' + esc(t('ackInOld')) + '</div>' : '')) + '</div>'; }).join('') : '') +
          hqCardHtml(games) + searchHtml() + slotsHtml(games, ins) +
          '<div class="list" style="display:' + (OPS.editForm ? '' : 'none') + '">' + games.filter(function (g) { return !OPS.editForm || String(g.game_id) === String(OPS.edit); }).map(function (g) {
            var crew = ['cr', 'ar1', 'ar2', 'fourth'].filter(function (k) { return g[k]; }).map(function (k) { var at = ins[key(g[k])]; return '<span class="' + (at ? 'in' : 'out') + '">' + esc(g[k]) + (at ? ' ' + esc(clock(at)) : (iCan('scheduling') || iCan('command_center') ? ' <button class="linkbtn" style="display:inline;min-height:0;padding:0 4px;color:var(--green);text-decoration:underline" data-checkin="' + esc(g[k]) + '" data-gid="' + esc(g.game_id) + '">' + esc(t('staffCheckin')) + '</button>' : '')) + '</span>'; }).join(', ');
            var edit = OPS.edit === String(g.game_id);
            var warn = OPS.alerts.filter(function (a) { return a.status === 'open' && String(a.game_id) === String(g.game_id); });
            var form = !edit ? '' : '<div class="card" style="margin:8px 0 0;gap:8px">' +
              '<datalist id="swNames">' + swNames(g.venue).map(function (n) { return '<option value="' + esc(n) + '">'; }).join('') + '</datalist>' +
              ['cr', 'ar1', 'ar2', 'fourth'].map(function (k) { return '<label class="hint" for="sw-' + k + '">' + esc(t('role.' + k)) + '</label><input id="sw-' + k + '" list="swNames" autocomplete="off" value="' + esc(g[k] || '') + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">'; }).join('') +
              '<label class="hint" for="sw-field">' + esc(t('fieldLabel')) + '</label><input id="sw-field" value="' + esc(g.field || '') + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">' +
              '<div class="actions" style="padding:0"><button class="btn primary" data-save-switch="' + esc(g.game_id) + '">' + esc(t('saveChanges')) + '</button><button class="btn outline" data-cancel-switch="1">' + esc(t('neverMind')) + '</button></div><div class="msg bad" id="sw-msg" hidden></div></div>';
            return '<div class="item" style="flex-direction:column;align-items:stretch;gap:2px"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><div class="when"><div class="disp">' + esc(clock(g.kickoff)) + '</div><div class="sub">' + esc(g.field || '') + ', ' + esc(g.age_group || '') + (g.game_num ? ', ' + esc(g.game_num) : '') + '</div></div>' + (iCan('scheduling') && !edit ? '<button class="linkbtn" data-switch="' + esc(g.game_id) + '">' + esc(t('change')) + '</button>' : '') + '</div><div class="crewline">' + crew + '</div>' + (warn.length ? '<div class="hint" style="color:#8A6A00;font-weight:700">' + esc(t('alertOnGame').replace('{n}', warn.length)) + '</div>' : '') + form + '</div>';
          }).join('') + '</div>';
      }
          body += unCard + e5Card;
    } else if (OPS.tab === 'staff') {
      var venuesToday = {}; OPS.games.forEach(function (g) { if (g.venue) venuesToday[g.venue] = 1; });
      body = '<div class="pad lead" style="padding-top:12px">' + esc(t('staffLead2')) + '</div>' +
        '<div class="card" style="gap:8px"><select id="smTo" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"><option value="">' + esc(t('smAll')) + '</option>' + Object.keys(venuesToday).sort().map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('') + '</select>' +
        '<textarea id="smBody" placeholder="' + esc(t('smPlaceholder')) + '" style="min-height:90px"></textarea><button class="btn primary" id="smSend">' + esc(t('smSend')) + '</button><div class="msg" id="smMsg" hidden></div></div>' +
        ((OPS.msgs || []).length ? (OPS.msgs || []).map(function (m) { return '<div class="card" style="gap:4px"><div style="display:flex;justify-content:space-between;gap:8px"><b>' + esc(m.from_name || '') + '</b><span class="hint">' + esc(clock(m.created_at)) + '</span></div><div class="hint">' + esc(m.to_venue ? t('smToVenue') + ' ' + m.to_venue : t('smAll')) + '</div><div style="font-size:16px;line-height:1.45">' + esc(m.body) + '</div></div>'; }).join('') : '<div class="card"><div class="hint">' + esc(t('smNone')) + '</div></div>');
    } else if (OPS.tab === 'protection') {
      var open = OPS.alerts.filter(function (a) { return a.status === 'open'; }), seen = OPS.alerts.filter(function (a) { return a.status !== 'open'; });
      var row = function (a) {
        var d = a.detail || {};
        return '<div class="card" style="gap:6px;border-color:' + (a.status === 'open' ? 'var(--gold)' : 'var(--line)') + '"><div style="display:flex;justify-content:space-between;gap:8px"><div><b>' + refLink(a.ref_name) + '</b> <span class="hint">' + esc(t('role.' + (a.position || 'cr'))) + '</span><br><span class="hint">' + esc(a.age_group) + ', ' + esc(dayLong(a.game_date)) + ', ' + esc(clock(a.kickoff)) + ', ' + esc(a.venue || '') + (a.field ? ', ' + esc(a.field) : '') + '</span></div>' + (a.status !== 'open' ? '<span class="pill">' + esc(t('alert' + a.status.charAt(0).toUpperCase() + a.status.slice(1))) + (a.seen_by ? ' ' + esc(a.seen_by) : '') + '</span>' : '') + '</div>' +
          '<div style="font-size:15px">' + esc(t('alertAgeMsg').replace('{group}', d.group_age >= 99 ? t('adult') : 'U' + d.group_age).replace('{age}', d.referee_age)) + '</div>' +
          (a.status === 'open' ? '<div class="actions" style="padding:0"><button class="btn outline small" data-alert="seen" data-id="' + a.id + '">' + esc(t('alertSeenBtn')) + '</button><button class="btn outline small" data-alert="dismissed" data-id="' + a.id + '">' + esc(t('alertDismissBtn')) + '</button></div>' : '') + '</div>';
      };
      body = '<div class="pad lead" style="padding-top:12px">' + esc(t('protectionLead')) + '</div><div class="pad" style="padding-top:10px"><button class="btn outline small" id="alertRefresh">' + esc(t('alertRefresh')) + '</button></div>' +
        '<div class="disp h2">' + esc(t('alertsOpen')) + ' ' + open.length + '</div>' + (open.length ? open.map(row).join('') : '<div class="card"><div class="hint">' + esc(t('noneHere')) + '</div></div>') +
        (seen.length ? '<div class="disp h2">' + esc(t('alertsHandled')) + '</div>' + seen.slice(0, 20).map(row).join('') : '');
    } else if (OPS.tab === 'retain') {
      var never = CC.cov.filter(function (r) { return r.notes === 0 && r.games >= 3; }).slice(0, 40);
      var cut = iso(new Date(Date.now() - 30 * 86400000));
      var quiet = CC.cov.filter(function (r) { return r.last_game && r.last_game < cut && !r.next_game; }).sort(function (a, b) { return b.games - a.games; }).slice(0, 40);
      var rows = function (list) { return list.length ? list.map(function (r) { return '<div class="rowline"><div><b>' + refLink(r.name) + '</b><br><span class="hint">' + esc(t('lastGame')) + ' ' + esc(r.last_game ? dayLong(r.last_game) : '') + (r.next_game ? '. <b>' + esc(t('refNext')) + '</b> ' + esc(dayLong(r.next_game)) + ', ' + esc(r.next_venue || '') : '') + '</span></div><div class="n">' + r.games + '</div></div>'; }).join('') : '<div class="hint">' + esc(t('noneHere')) + '</div>'; };
      body = '<div class="pad lead" style="padding-top:12px">' + esc(t('retainLead')) + '</div><div class="disp h2">' + esc(t('retainNever')) + '</div><div class="pad">' + rows(never) + '</div><div class="disp h2">' + esc(t('retainQuiet')) + '</div><div class="pad">' + rows(quiet) + '</div>';
    } else if (OPS.tab === 'premium') {
      var pq = OPS.prem;
      var chk = function (c) { if (!c) return ''; return esc(t('premCenters').replace('{n}', c.centers || 0)) + (c.drl ? ' · DRL' : '') + (c.advanced ? ' · ' + esc(t('premAdvanced')) : '') + (c.fitness_date ? ' · ' + esc(t('premFitPass')) + ' ' + esc(dayShort(c.fitness_date)) : '') + ' · ' + esc(t('premEvals').replace('{n}', c.evals || 0)); };
      body = '<div class="pad lead" style="padding-top:12px">' + esc(t('premQueueLead')) + '</div><div class="pad">' +
        (pq == null ? '<div class="hint">' + esc(t('loadingReview')) + '</div>' :
         !pq.length ? '<div class="hint">' + esc(t('noneHere')) + '</div>' :
         pq.map(function (a) {
           var edu = (a.education || []).map(function (e) { return '<div class="hint">• ' + esc(e.text || '') + '</div>'; }).join('');
           return '<div class="card" style="gap:6px"><div style="display:flex;justify-content:space-between;gap:8px"><b>' + refLink(a.name || '') + '</b><span class="pill' + (a.status === 'approved' ? ' ok' : a.status === 'denied' ? ' bad' : '') + '">' + esc(t('premTier').replace('{n}', a.status === 'approved' && a.tier_approved ? a.tier_approved : a.tier)) + ' · ' + esc(t('premSt.' + a.status)) + '</span></div>' +
             '<div class="hint">' + chk(a.check) + '</div>' + edu +
             (a.dg_note ? '<div class="hint"><b>' + esc(t('premDg')) + ':</b> ' + esc(a.dg_note) + '</div>' : '') +
             (a.note ? '<div class="hint"><b>' + esc(t('premOpsNote')) + ':</b> ' + esc(a.note) + '</div>' : '') +
             (a.status === 'submitted' ? '<div class="chips no-print"><button class="chip-btn small" data-prem-ok="' + a.id + '" data-tier="' + a.tier + '">' + esc(t('premApprove')) + '</button><button class="chip-btn small" data-prem-no="' + a.id + '">' + esc(t('premDeny')) + '</button></div>' : '') + '</div>';
         }).join('')) + '</div>';
    } else {
      var today = todayStr();
      body = '<div class="pad lead" style="padding-top:12px">' + esc(t('bulletinsLead')) + '</div>' +
        '<div class="card" style="gap:10px"><b>' + esc(t('newBulletin')) + '</b><label class="hint" for="bulTitle">' + esc(t('bulTitle')) + '</label><input id="bulTitle" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"><label class="hint" for="bulBody">' + esc(t('bulBody')) + '</label><textarea id="bulBody" style="min-height:90px"></textarea>' +
        '<div class="grid2"><div><label class="hint" for="bulFrom">' + esc(t('bulFrom')) + '</label><input id="bulFrom" type="date" value="' + today + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"></div><div><label class="hint" for="bulTo">' + esc(t('bulTo')) + '</label><input id="bulTo" type="date" value="' + today + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"></div></div>' +
        '<button class="btn primary" id="bulPost">' + esc(t('bulPost')) + '</button><div class="msg" id="bulMsg" hidden></div></div>' +
        (function () { var past = [], now = []; OPS.bulletins.forEach(function (b) { var over = !b.active || (b.end_date && b.end_date < today); (over ? past : now).push(b); }); return now.map(bulCard).join('') + (past.length ? fold('bul-past', t('pastBulletins'), past.length, past.map(bulCard).join(''), false) : ''); })();
    }
    function bulCard(b) {
          var today = todayStr();
          var state = !b.active ? 'over' : (b.end_date && b.end_date < today) ? 'over' : (b.start_date && b.start_date > today) ? 'future' : 'live';
          return '<div class="card" style="gap:6px"><div style="display:flex;justify-content:space-between;gap:8px"><b>' + esc(b.title || '') + '</b><span class="pill' + (state === 'live' ? ' ok' : '') + '">' + esc(t(state === 'live' ? 'bulletinLive' : state === 'future' ? 'bulletinFuture' : 'bulletinOver')) + '</span></div><div style="font-size:15px">' + esc(b.body || '') + '</div><div class="hint">' + esc(b.start_date || '') + (b.end_date && b.end_date !== b.start_date ? ' to ' + esc(b.end_date) : '') + (b.venue ? ', ' + esc(b.venue) : '') + (b.posted_by ? ', ' + esc(b.posted_by) : '') + '</div>' + (b.active && state !== 'over' ? '<button class="btn outline small" data-clear="' + esc(b.src_key) + '">' + esc(t('bulClear')) + '</button>' : '') + '</div>';
    }
    $('opsBody').innerHTML = head + body;
    $('opsBody').querySelectorAll('[data-otab]').forEach(function (b) { b.onclick = function () { OPS.tab = b.getAttribute('data-otab'); if (OPS.tab === 'retain' && !CC.cov.length) { loadCenter().then(renderOps); return; } if (OPS.tab === 'premium' && OPS.prem == null) { renderOps(); sb.rpc('premium_queue').then(function (r) { OPS.prem = r.data || []; renderOps(); }); return; } renderOps(); }; });
    $('opsBody').querySelectorAll('[data-prem-ok]').forEach(function (b) { b.onclick = async function () {
      b.disabled = true;
      var r = await sb.from('premium_apps').update({ status: 'approved', tier_approved: parseInt(b.getAttribute('data-tier'), 10), reviewed_by: S.me.person_id, reviewed_at: new Date().toISOString() }).eq('id', parseInt(b.getAttribute('data-prem-ok'), 10));
      if (r.error) { b.disabled = false; window.alert(r.error.message); return; }
      var q = await sb.rpc('premium_queue'); OPS.prem = q.data || []; renderOps();
    }; });
    $('opsBody').querySelectorAll('[data-prem-no]').forEach(function (b) { b.onclick = async function () {
      var why = window.prompt(t('premDenyWhy')); if (why === null) return;
      b.disabled = true;
      var r = await sb.from('premium_apps').update({ status: 'denied', note: why.trim() || null, reviewed_by: S.me.person_id, reviewed_at: new Date().toISOString() }).eq('id', parseInt(b.getAttribute('data-prem-no'), 10));
      if (r.error) { b.disabled = false; window.alert(r.error.message); return; }
      var q = await sb.rpc('premium_queue'); OPS.prem = q.data || []; renderOps();
    }; });
    $('opsBody').querySelectorAll('[data-day]').forEach(function (b) { b.onclick = function () { OPS.date = shiftDate(OPS.date, parseInt(b.getAttribute('data-day'), 10)); OPS.venue = null; loadOps().then(renderOps); }; });
    $('opsBody').querySelectorAll('[data-focus]').forEach(function (b) { b.onclick = function () { OPS.focus = b.getAttribute('data-focus') === '1'; try { localStorage.setItem('hub-focus', OPS.focus ? '1' : '0'); } catch (e) {} renderOps(); }; });
    $('opsBody').querySelectorAll('[data-e5]').forEach(function (b) { b.onclick = async function () {
      b.disabled = true;
      var r = await sb.rpc('assignr_mark', { p_game: parseInt(b.getAttribute('data-e5'), 10) });
      if (r.error || r.data !== true) { b.disabled = false; return; }
      OPS.e5 = (OPS.e5 || []).filter(function (g) { return String(g.game_id) !== b.getAttribute('data-e5'); });
      renderOps();
    }; });
    var osd = $('opsSnd'); if (osd) osd.onclick = function () {
      OPS.sound = !OPS.sound;
      try { localStorage.setItem('hub-ops-sound', OPS.sound ? '1' : '0'); } catch (e) {}
      if (OPS.sound) opsBeep();
      renderOps();
    };
    $('opsBody').querySelectorAll('[data-late-ack]').forEach(function (b) { b.onclick = async function (e) { e.stopPropagation(); b.disabled = true; var r = await sb.from('late_notices').update({ ack_by: S.me.first_name + ' ' + S.me.last_name, ack_at: new Date().toISOString() }).eq('id', parseInt(b.getAttribute('data-late-ack'), 10)); if (r.error) { b.disabled = false; return; } loadOps().then(renderOps); }; });
    $('opsBody').querySelectorAll('[data-attn] a.refname').forEach(function (a) { a.onclick = function () { REF.venue = a.closest('[data-attn]').getAttribute('data-attn-venue'); REF.from = '#ops'; }; });
    $('opsBody').querySelectorAll('[data-attn]').forEach(function (b) { b.onclick = function (e) { if (e.target.closest && e.target.closest('a,button')) return; OPS.focus = false; OPS.venue = b.getAttribute('data-attn-venue') || null; OPS.edit = b.getAttribute('data-attn'); OPS.editForm = false; renderOps(); var el = $('opsBody').querySelector('[data-fcard="' + OPS.edit + '"]'); if (el) el.scrollIntoView({ block: 'center' }); }; });
    $('opsBody').querySelectorAll('[data-venue]').forEach(function (b) { b.onclick = function (e) { e.preventDefault(); OPS.venue = b.getAttribute('data-venue') || null; OPS.edit = null; renderOps(); window.scrollTo(0, 0); }; });
    var ovs = $('opsVenueSel'); if (ovs) ovs.onchange = function () { OPS.venue = ovs.value || null; OPS.edit = null; renderOps(); window.scrollTo(0, 0); };
    $('opsBody').querySelectorAll('[data-fcard]').forEach(function (c) { c.onclick = function (e) { if (e.target.closest && e.target.closest('button')) return; var id = c.getAttribute('data-fcard'); OPS.edit = OPS.edit === id ? null : id; OPS.editForm = false; renderOps(); }; });
    var of = $('opsFind'); if (of) { of.oninput = function () { OPS.find = of.value; clearTimeout(OPS.findT); OPS.findT = setTimeout(function () { renderOps(); var x = $('opsFind'); if (x) { x.focus(); x.setSelectionRange(x.value.length, x.value.length); } }, 250); }; }
    $('opsBody').querySelectorAll('[data-switch]').forEach(function (b) { b.onclick = function () { OPS.edit = b.getAttribute('data-switch'); OPS.editForm = true; renderOps(); }; });
    $('opsBody').querySelectorAll('[data-cancel-switch]').forEach(function (b) { b.onclick = function () { OPS.edit = null; OPS.editForm = false; renderOps(); }; });
    $('opsBody').querySelectorAll('[data-save-switch]').forEach(function (b) {
      b.onclick = async function () {
        var id = b.getAttribute('data-save-switch'), g = OPS.games.filter(function (x) { return String(x.game_id) === id; })[0];
        if (!g) return;
        b.disabled = true; b.textContent = t('saving');
        var crew = { CR: $('sw-cr') ? $('sw-cr').value.trim() : '', AR1: $('sw-ar1') ? $('sw-ar1').value.trim() : '', AR2: $('sw-ar2') ? $('sw-ar2').value.trim() : '', FOURTH: $('sw-fourth') ? $('sw-fourth').value.trim() : '' };
        var field = $('sw-field').value.trim();
        var ev = eventFor(g);
        try {
          var changed = ['cr', 'ar1', 'ar2', 'fourth'].some(function (k) { return (g[k] || '') !== crew[k.toUpperCase()]; });
          if (changed) await post({ action: 'crewSwitch', event: ev ? ev.id : '', gameId: g.game_id, date: OPS.date, crew: crew, handledBy: S.me.first_name + ' ' + S.me.last_name });
          if (field && field !== (g.field || '')) await post({ action: 'moveField', event: ev ? ev.id : '', gameId: g.game_id, date: OPS.date, newField: field, handledBy: S.me.first_name + ' ' + S.me.last_name });
          OPS.edit = null; OPS.editForm = false; await loadOps(); renderOps();
        } catch (e) { b.disabled = false; b.textContent = t('saveChanges'); var m = $('sw-msg'); if (m) { m.hidden = false; m.textContent = t('reviewFailed') + ' ' + (e.message || ''); } }
      };
    });
    var sms = $('smSend');
    if (sms) sms.onclick = async function () {
      var text = $('smBody').value.trim(); if (!text) return;
      sms.disabled = true;
      var r = await sb.from('staff_messages').insert({ org_id: S.me.org_id, from_person: S.me.person_id, from_name: S.me.first_name + ' ' + S.me.last_name, to_venue: $('smTo').value || null, date: OPS.date, body: text });
      if (r.error) { sms.disabled = false; say('smMsg', r.error.message, 'bad'); return; }
      await loadOps(); renderOps();
    };
    var ar = $('alertRefresh');
    if (ar) ar.onclick = async function () { ar.disabled = true; await sb.rpc('refresh_protection_alerts', { days_ahead: 14 }); await loadOps(); renderOps(); };
    $('opsBody').querySelectorAll('[data-alert]').forEach(function (b) {
      b.onclick = async function () { b.disabled = true; var r = await sb.rpc('mark_alert', { p_id: parseInt(b.getAttribute('data-id'), 10), p_status: b.getAttribute('data-alert') }); if (r.error) { b.disabled = false; return; } await loadOps(); renderOps(); };
    });
    $('opsBody').querySelectorAll('[data-checkin]').forEach(function (b) {
      b.onclick = async function () {
        var name = b.getAttribute('data-checkin'), g = OPS.games.filter(function (x) { return String(x.game_id) === b.getAttribute('data-gid'); })[0];
        if (!g) return;
        b.disabled = true; b.textContent = t('checkingIn');
        var ev = eventFor(g);
        try { await post({ action: 'checkinVenue', event: ev ? ev.id : '', refName: name, venue: g.venue, date: OPS.date, by: S.me.first_name + ' ' + S.me.last_name }); await loadOps(); renderOps(); }
        catch (e) { b.disabled = false; b.textContent = t('staffCheckin'); }
      };
    });
    $('opsBody').querySelectorAll('[data-ack]').forEach(function (b) {
      b.onclick = async function () {
        var k = b.getAttribute('data-key'), ts = (k || '').split('|')[0];
        b.disabled = true;
        try { await post({ action: 'ackEmergency', timestamp: ts, ackStatus: b.getAttribute('data-ack'), ackBy: S.me.first_name + ' ' + S.me.last_name, date: OPS.date }); await loadOps(); renderOps(); }
        catch (e) { b.disabled = false; }
      };
    });
    var postBtn = $('bulPost');
    if (postBtn) postBtn.onclick = async function () {
      var title = $('bulTitle').value.trim(), text = $('bulBody').value.trim();
      if (!title && !text) return;
      postBtn.disabled = true; postBtn.textContent = t('bulPosting');
      try {
        await post({ action: 'postAnnouncement', title: title, bodyText: text, startDate: $('bulFrom').value, endDate: $('bulTo').value, severity: 'info', postedBy: S.me.first_name + ' ' + S.me.last_name });
        await loadOps(); renderOps();
        var m = $('bulMsg'); if (m) { m.hidden = false; m.className = 'msg good'; m.textContent = t('bulPosted'); }
      } catch (e) { postBtn.disabled = false; postBtn.textContent = t('bulPost'); var mm = $('bulMsg'); mm.hidden = false; mm.className = 'msg bad'; mm.textContent = t('reviewFailed') + ' ' + (e.message || ''); }
    };
    $('opsBody').querySelectorAll('[data-clear]').forEach(function (b) {
      b.onclick = async function () {
        var k = b.getAttribute('data-clear'); var ts = k.split('|')[0];
        b.disabled = true;
        try { await post({ action: 'clearAnnouncement', timestamp: ts, clearedBy: S.me.first_name + ' ' + S.me.last_name }); await loadOps(); renderOps(); }
        catch (e) { b.disabled = false; }
      };
    });
  }

  // ── People: titles on a person's card ────────────────────────────
  var PP = { q: '', results: [], person: null, held: [], catalog: [], timer: null };
  async function loadCatalog() {
    if (PP.catalog.length) return;
    var r = await sb.from('titles').select('code,label,family,rank,from_license').order('family').order('rank', { ascending: false });
    PP.catalog = r.data || [];
  }
  async function searchPeople(q) {
    PP.q = q;
    if (q.length < 2) { PP.results = []; renderPeople(); return; }
    var parts = q.split(/\s+/).filter(Boolean);
    var query = sb.from('people').select('id,first_name,last_name,city,dob,email').limit(20);
    if (parts.length >= 2) query = query.ilike('first_name', parts[0] + '%').ilike('last_name', parts.slice(1).join(' ') + '%');
    else query = query.or('last_name.ilike.' + parts[0] + '*,first_name.ilike.' + parts[0] + '*');
    busy(true); var r = await query.order('last_name').order('first_name'); busy(false);
    if (PP.q !== q) return;
    PP.results = r.data || [];
    renderPeople();
  }
  async function openPerson(id) {
    var p = PP.results.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!p) return;
    PP.person = p;
    var r = await sb.from('person_titles').select('title_code,source').eq('person_id', p.id);
    PP.held = r.data || [];
    await loadCatalog();
    renderPerson();
  }
  function renderPeople() {
    $('peopleResults').innerHTML = PP.q.length < 2 ? '' : (PP.results.length ? '<div class="list">' + PP.results.map(function (p) {
      return '<a class="item" href="#" data-person="' + p.id + '"><div><b>' + esc(p.first_name + ' ' + p.last_name) + '</b><br><span class="hint">' + esc(p.city || '') + '</span></div><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>';
    }).join('') + '</div>' : '<div class="card"><div class="hint">' + esc(t('noMatch')) + '</div></div>' + addPersonHtml(PP.q));
    var ap = $('addPersonBtn');
    if (ap) ap.onclick = async function () {
      var f = $('apFirst').value.trim(), l = $('apLast').value.trim(), e = $('apEmail').value.trim(), c = $('apCity').value.trim();
      if (!f || !l) { say('apMsg', t('addPersonNeed'), 'bad'); return; }
      ap.disabled = true; busy(true);
      var r = await sb.rpc('add_person', { p_first: f, p_last: l, p_email: e, p_city: c });
      busy(false);
      if (r.error) { ap.disabled = false; say('apMsg', r.error.message, 'bad'); return; }
      PP.results = [{ id: r.data, first_name: f, last_name: l, city: c }];
      PP.q = f + ' ' + l; $('peopleQ').value = PP.q;
      renderPeople(); openPerson(r.data);
    };
    $('peopleResults').querySelectorAll('[data-person]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); if (LINK.pick) { linkTo(parseInt(a.getAttribute('data-person'), 10), null); PP.q = ''; $('peopleQ').value = ''; return; } openPerson(a.getAttribute('data-person')); }; });
  }
  function addPersonHtml(q) {
    if (!iCan('people')) return '';
    var parts = (q || '').split(/\s+/).filter(Boolean), first = parts.length > 1 ? parts[0] : '', last = parts.length > 1 ? parts.slice(1).join(' ') : (parts[0] || '');
    var inp = function (id, v, ph, type) { return '<input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(v) + '" placeholder="' + esc(ph) + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">'; };
    return '<div class="card" style="gap:8px"><b>' + esc(t('addPerson')) + '</b><div class="hint">' + esc(t('addPersonHint')) + '</div><div class="grid2">' + inp('apFirst', first, t('firstName')) + inp('apLast', last, t('lastName')) + '</div>' + inp('apEmail', '', t('emailLabel'), 'email') + inp('apCity', '', t('cityLabel')) + '<button class="btn outline" id="addPersonBtn">' + esc(t('addPersonGo')) + '</button><div class="msg" id="apMsg" hidden></div></div>';
  }
  function renderPerson() {
    var p = PP.person; if (!p) { $('personCard').innerHTML = ''; return; }
    var byCode = {}; PP.catalog.forEach(function (c) { byCode[c.code] = c; });
    var lc = PP.held.filter(function (h) { return h.source !== 'manual'; }), co = PP.held.filter(function (h) { return h.source === 'manual'; });
    var givable = PP.catalog.filter(function (c) { return !c.from_license.length && !co.some(function (h) { return h.title_code === c.code; }); });
    var minor = p.dob && new Date(p.dob) > new Date(Date.now() - 18 * 365.25 * 86400000);
    $('personCard').innerHTML = '<div class="card" style="gap:10px"><div><div class="disp" style="font-size:32px">' + esc(p.first_name + ' ' + p.last_name) + '</div><div class="hint">' + esc(p.city || '') + (minor ? ', ' + esc(t('greenBadge')) : '') + '</div></div>' +
      '<div><div class="hint" style="font-weight:700">' + esc(t('lcTitles')) + '</div><div>' + (lc.length ? lc.map(function (h) { return '<span class="pill" style="margin:4px 4px 0 0">' + esc(byCode[h.title_code] ? byCode[h.title_code].label : h.title_code) + '</span>'; }).join('') : '<span class="hint">' + esc(t('noneYet')) + '</span>') + '</div></div>' +
      '<div><div class="hint" style="font-weight:700">' + esc(t('coTitles')) + '</div><div>' + (co.length ? co.map(function (h) { return '<span class="pill ok" style="margin:4px 4px 0 0">' + esc(byCode[h.title_code] ? byCode[h.title_code].label : h.title_code) + ' <button class="linkbtn" style="display:inline;min-height:0;padding:0 0 0 6px;color:inherit" data-take="' + esc(h.title_code) + '">' + esc(t('remove')) + '</button></span>'; }).join('') : '<span class="hint">' + esc(t('noneYet')) + '</span>') + '</div></div>' +
      '<div><div class="hint" style="font-weight:700">' + esc(t('addTitle')) + '</div><div class="chips" style="margin-top:6px">' + givable.map(function (c) { return '<button class="chip-btn" data-give="' + esc(c.code) + '">' + esc(c.label) + '</button>'; }).join('') + '</div></div>' +
      '<div><div class="hint" style="font-weight:700">' + esc(t('signinHelp')) + '</div><div class="go" style="margin-top:6px"><input id="ppEmail" type="email" value="' + esc(p.email || '') + '" placeholder="' + esc(t('emailLabel')) + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"><button class="btn outline" id="ppEmailSave">' + esc(t('save')) + '</button></div>' +
        (iCan('setup') ? '<button class="btn outline small" id="ppCode" style="margin-top:8px">' + esc(t('signinCodeBtn')) + '</button><div id="ppCodeBox"></div>' : '') + '</div>' +
      '<div class="msg" id="ppMsg" hidden></div></div>';
    $('personCard').querySelectorAll('[data-give]').forEach(function (b) { b.onclick = async function () { b.disabled = true; var r = await sb.rpc('give_title', { p_person: p.id, p_code: b.getAttribute('data-give') }); if (r.error) { say('ppMsg', r.error.message, 'bad'); b.disabled = false; return; } await openPerson(p.id); say('ppMsg', t('titleGiven') + ': ' + b.textContent, 'good'); }; });
    var es = $('ppEmailSave');
    if (es) es.onclick = async function () { es.disabled = true; var r = await sb.rpc('set_person_email', { p_person: p.id, p_email: $('ppEmail').value.trim() }); es.disabled = false; if (r.error) { say('ppMsg', r.error.message, 'bad'); return; } p.email = $('ppEmail').value.trim().toLowerCase(); say('ppMsg', t('emailSaved'), 'good'); };
    var pc = $('ppCode');
    if (pc) pc.onclick = async function () {
      var em = ($('ppEmail').value || p.email || '').trim(); if (!em) { say('ppMsg', t('emailFirst'), 'bad'); return; }
      pc.disabled = true; pc.textContent = t('signinCodeMaking');
      try { var j = await post({ action: 'signinCode', email: em }); $('ppCodeBox').innerHTML = '<div class="card" style="border-color:var(--gold);gap:4px;margin:8px 0 0"><div class="hint">' + esc(t('signinCodeRead')) + '</div><div class="disp" style="font-size:48px;letter-spacing:.12em">' + esc(j.code) + '</div><div class="hint">' + esc(t('signinCodeHow').replace('{email}', em)) + '</div></div>'; }
      catch (e) { say('ppMsg', t('reviewFailed') + ' ' + (e.message || ''), 'bad'); }
      pc.disabled = false; pc.textContent = t('signinCodeBtn');
    };
    $('personCard').querySelectorAll('[data-take]').forEach(function (b) { b.onclick = async function () { var r = await sb.rpc('take_title', { p_person: p.id, p_code: b.getAttribute('data-take') }); if (r.error) { say('ppMsg', r.error.message, 'bad'); return; } await openPerson(p.id); say('ppMsg', t('titleTaken'), 'good'); }; });
  }

  // ── Setup: events ────────────────────────────────────────────────
  var SU = { events: [], venues: [], sites: [], leagues: [], ev: null, vq: '', check: null };
  var TOOLS = ['hub', 'coaching', 'checkin', 'scoreboard', 'scoreentry', 'rules', 'screports', 'incident'];
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24); }
  async function loadSetup_() {
    await loadSessions_();
    var e = await sb.from('events').select('id,name,type,year,start_date,end_date,site_id,league,venues,tools,url,accent,blurb,active,alert_emails,game_prefix,rules_url').order('start_date', { ascending: false }).limit(200);
    SU.events = e.data || [];
    VEN.rows = null; await loadVenues_();
    try { var su = await Promise.all([sb.from('sync_units').select('key,site_id,from_date,to_date,synced_at,games,pruned,ms,error').order('from_date'), sb.from('assignr_sites').select('site_id,name,active')]); SU.sync = su[0].data || []; SU.sites2 = su[1].data || []; } catch (e) { SU.sync = []; SU.sites2 = []; }
    try { var fz = await Promise.all([sb.from('fees').select('id,kind,purpose,amount_cents,active'), sb.from('payments').select('id,name,kind,purpose,amount_cents,status,created_at').order('created_at', { ascending: false }).limit(30)]); SU.fees = fz[0].data || []; SU.pays = fz[1].data || []; } catch (e) { SU.fees = []; SU.pays = []; }
    var from = shiftDate(todayStr(), -60), to = shiftDate(todayStr(), 60);
    var g = await fetchAll(function () { return sb.from('games').select('venue,site_id,competition').gte('date', from).lte('date', to).order('venue'); });
    var vs = {}, ss = {}, ls = {};
    (g.data || []).forEach(function (x) { if (x.venue) vs[x.venue] = (vs[x.venue] || 0) + 1; if (x.site_id) ss[x.site_id] = 1; if (x.competition) ls[x.competition] = (ls[x.competition] || 0) + 1; });
    SU.venues = Object.keys(vs).sort(); SU.sites = Object.keys(ss).sort(); SU.leagues = Object.keys(ls).sort(function (a, b) { return ls[b] - ls[a]; });
  }
  function blankEvent() { return { id: '', name: '', type: 'tournament', start_date: todayStr(), end_date: todayStr(), site_id: SU.sites[0] ? Number(SU.sites[0]) : 20901, league: '', venues: [], tools: ['hub', 'coaching', 'checkin', 'rules'], blurb: '', active: true, alert_emails: [], game_prefix: '', isNew: true }; }
  function evMissing(ev) {
    var m = [];
    if (!ev.name) m.push(t('evName')); if (!ev.id) m.push(t('evId'));
    if (!ev.start_date || !ev.end_date) m.push(t('evDates'));
    if (ev.active) {
      if (!ev.venues.length && ev.type !== 'league') m.push(t('evVenues'));
      if (!ev.venues.length && ev.type === 'league' && !ev.game_prefix && !ev.league) m.push(t('evLeagueMatch'));
      if (!ev.tools.length) m.push(t('evTools'));
    }
    return m;
  }
  function renderSetup() {
    var ev = SU.ev;
    if (!ev) {
      // Events and competitions with no rules yet: the list to chase.
      var noRules = SU.events.filter(function (e) { return e.active !== false && !e.rules_url; }).map(function (e) { return e.name || e.id; });
      var covered = {}; SU.events.forEach(function (e) { if (e.rules_url && e.league) covered[key(e.league)] = 1; if (e.rules_url && e.name) covered[key(e.name)] = 1; });
      var compNoRules = (SU.leagues || []).filter(function (c) { return !covered[key(c)] && !SU.events.some(function (e) { return e.rules_url && (key(e.name) === key(c) || (e.league && key(e.league) === key(c))); }); });
      // The competitions that matter (Director of Referee Operations, 20 Oct 2026); the rest sit in a fold and do not count.
      var KEY_COMPS = /advanced league|\bcal\b|\bmrl\b|mountain region|\bfrl\b|front range|south metro|\bsml\b|storm interbranch|\bsil\b|\becnl\b|\bdpl\b|girls academy|\bga\b/i;
      var compKey = compNoRules.filter(function (c) { return KEY_COMPS.test(c); }), compOther = compNoRules.filter(function (c) { return !KEY_COMPS.test(c); });
      var rulesCard = (noRules.length || compNoRules.length) ? fold('rules', t('rulesMissingTitle'), noRules.length + compKey.length, '<div class="hint">' + esc(t('rulesMissingHint')) + '</div>' +
        (noRules.length ? '<div><b>' + esc(t('rulesMissingEvents')) + '</b> ' + noRules.map(esc).join(', ') + '</div>' : '') +
        (compKey.length ? '<div><b>' + esc(t('rulesMissingComps')) + '</b> ' + compKey.map(esc).join(', ') + '</div>' : '') +
        (compOther.length ? fold('rulesOther', t('rulesMissingOther'), compOther.length, '<div class="hint">' + compOther.map(esc).join(', ') + '</div>', false) : ''), false) : '';
      var evItem = function (e) {
        return '<a class="item" href="#" data-ev="' + esc(e.id) + '"><div><b>' + esc(e.name || e.id) + '</b> <span class="pill' + (e.active ? ' ok' : '') + '">' + esc(e.active ? t('evOn') : t('evOff')) + '</span><br><span class="hint">' + esc(e.type || '') + ', ' + esc(e.start_date || '') + (e.end_date && e.end_date !== e.start_date ? ' to ' + esc(e.end_date) : '') + ', ' + esc((e.venues || []).join(', ')) + (e.game_prefix ? ', ' + esc(e.game_prefix) : '') + '</span></div><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>';
      };
      if (SES.open) { $('setupBody').innerHTML = sessionsSetupHtml(); wireSessionsSetup($('setupBody')); return; }
      if (VE.open != null) { $('setupBody').innerHTML = venueEditorHtml(); wireVenueEditor($('setupBody')); return; }
      var tdy = todayStr(), evDone = SU.events.filter(function (e) { return (e.end_date || e.start_date || '') < tdy; }), evOff = SU.events.filter(function (e) { return evDone.indexOf(e) < 0 && !e.active; }), evLive = SU.events.filter(function (e) { return evDone.indexOf(e) < 0 && e.active; }).sort(function (a, b) { return String(a.start_date || '').localeCompare(String(b.start_date || '')); });
      var evPick = '<div class="pad" style="padding-top:10px"><select id="evJump" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"><option value="">' + esc(t('evJump')) + '</option>' + [[t('evCurrent'), evLive], [t('evOffTitle'), evOff], [t('evCompleted'), evDone]].map(function (grp) { return grp[1].length ? '<optgroup label="' + esc(grp[0]) + '">' + grp[1].map(function (e) { return '<option value="' + esc(e.id) + '">' + esc(e.name || e.id) + '</option>'; }).join('') + '</optgroup>' : ''; }).join('') + '</select></div>';
      $('setupBody').innerHTML = rulesCard + feesSetupHtml() + sessionsSetupHtml() + '<div class="disp h2">' + esc(t('setupEventsTitle')) + '</div><div class="pad" style="padding-top:12px"><button class="btn primary" id="evNew" style="width:100%">' + esc(t('newEvent')) + '</button></div>' + evPick + '<div class="list">' + evLive.map(evItem).join('') + '</div>' +
        (evOff.length ? fold('evoff', t('evOffTitle'), evOff.length, '<div class="list">' + evOff.map(evItem).join('') + '</div>', false) : '') +
        (evDone.length ? fold('evdone', t('evCompleted'), evDone.length, '<div class="list">' + evDone.map(evItem).join('') + '</div>', false) : '') + venuesSetupHtml() + syncSetupHtml();
      wireSessionsSetup($('setupBody')); wireVenuesSetup($('setupBody')); wireFees($('setupBody'));
      $('evNew').onclick = function () { SU.ev = blankEvent(); SU.check = null; renderSetup(); };
      $('evJump').onchange = function () { var src = SU.events.filter(function (x) { return x.id === $('evJump').value; })[0]; if (!src) return; SU.ev = JSON.parse(JSON.stringify(src)); SU.ev.venues = SU.ev.venues || []; SU.ev.tools = SU.ev.tools || []; SU.ev.alert_emails = SU.ev.alert_emails || []; SU.check = null; renderSetup(); };
      $('setupBody').querySelectorAll('[data-ev]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); var src = SU.events.filter(function (x) { return x.id === a.getAttribute('data-ev'); })[0]; SU.ev = JSON.parse(JSON.stringify(src)); SU.ev.venues = SU.ev.venues || []; SU.ev.tools = SU.ev.tools || []; SU.ev.alert_emails = SU.ev.alert_emails || []; SU.check = null; renderSetup(); }; });
      return;
    }
    var inp = function (id, v, type, extra) { return '<input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(v == null ? '' : v) + '" ' + (extra || '') + ' style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">'; };
    var missing = evMissing(ev);
    $('setupBody').innerHTML =
      '<div class="pad" style="padding-top:12px"><button class="linkbtn" id="evBack" style="padding-left:0">&#8249; ' + esc(t('back')) + '</button></div>' +
      '<div class="card" style="gap:10px">' +
      '<label class="hint" style="font-weight:700" for="evName">' + esc(t('evName')) + '</label>' + inp('evName', ev.name) +
      '<label class="hint" style="font-weight:700" for="evId">' + esc(t('evId')) + '</label>' + inp('evId', ev.id, 'text', ev.isNew ? '' : 'disabled') +
      '<div class="hint" style="font-weight:700">' + esc(t('evType')) + '</div><div class="chips"><button class="chip-btn' + (ev.type !== 'league' ? ' on' : '') + '" data-type="tournament">' + esc(t('evTournament')) + '</button><button class="chip-btn' + (ev.type === 'league' ? ' on' : '') + '" data-type="league">' + esc(t('evLeague')) + '</button></div>' +
      '<div class="hint" style="font-weight:700">' + esc(t('evDates')) + '</div><div class="grid2">' + inp('evStart', ev.start_date, 'date') + inp('evEnd', ev.end_date, 'date') + '</div>' +
      '</div>' +
      '<div class="card" style="gap:10px"><div class="hint" style="font-weight:700">' + esc(t('evVenues')) + '</div><div class="hint">' + esc(t('evVenuesHint')) + '</div>' +
      (ev.venues.length ? '<div class="chips">' + ev.venues.map(function (v) { return '<button class="chip-btn on" data-venue="' + esc(v) + '" title="' + esc(t('remove')) + '">' + esc(v) + ' &times;</button>'; }).join('') + '</div>' : '<div class="hint">' + esc(t('evNoVenues')) + '</div>') +
      '<select id="evVenueAdd" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"><option value="">' + esc(t('evVenueAdd')) + '</option>' + SU.venues.filter(function (v) { return ev.venues.indexOf(v) < 0; }).map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('') + '</select>' +
      '<div class="hint" style="font-weight:700">' + esc(t('evPrefix')) + '</div><div class="hint">' + esc(t('evPrefixHint')) + '</div>' + inp('evPrefix', ev.game_prefix, 'text', 'placeholder="UCH"') + '<div class="chips" id="prefixPicks"></div>' +
      '<label class="hint" style="font-weight:700" for="evLeagueName">' + esc(t('evLeagueName')) + '</label><input id="evLeagueName" list="leagueList" value="' + esc(ev.league || '') + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"><datalist id="leagueList">' + SU.leagues.slice(0, 60).map(function (l) { return '<option value="' + esc(l) + '">'; }).join('') + '</datalist>' +
      '<label class="hint" style="font-weight:700" for="evSite">' + esc(t('evSite')) + '</label><select id="evSite" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">' + (SU.sites.indexOf(String(ev.site_id)) < 0 && ev.site_id ? '<option value="' + esc(ev.site_id) + '" selected>' + esc(ev.site_id) + '</option>' : '') + SU.sites.map(function (s) { return '<option value="' + esc(s) + '"' + (String(ev.site_id) === s ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select>' +
      '<button class="btn outline small" id="evCheck">' + esc(t('evCheck')) + '</button><div class="msg" id="evCheckMsg" ' + (SU.check == null ? 'hidden' : '') + '>' + (SU.check ? esc(SU.check) : '') + '</div></div>' +
      '<div class="card" style="gap:10px"><div class="hint" style="font-weight:700">' + esc(t('evTools')) + '</div><div class="chips">' + TOOLS.map(function (k) { return '<button class="chip-btn' + (ev.tools.indexOf(k) >= 0 ? ' on' : '') + '" data-tool="' + k + '">' + esc(t('tools.' + k)) + '</button>'; }).join('') + '</div>' +
      '<label class="hint" style="font-weight:700" for="evAlerts">' + esc(t('evAlerts')) + '</label>' + inp('evAlerts', (ev.alert_emails || []).join(', ')) +
      '<label class="hint" style="font-weight:700" for="evBlurb">' + esc(t('evBlurb')) + '</label>' + inp('evBlurb', ev.blurb) +
      '<label class="hint" style="font-weight:700" for="evRules">' + esc(t('evRules')) + '</label>' + inp('evRules', ev.rules_url, 'text', 'placeholder="rules-uchealth.html or https://..."') + '<div class="hint">' + esc(t('evRulesHint')) + '</div>' +
      '<div class="chips"><button class="chip-btn' + (ev.active ? ' on' : '') + '" data-active="1">' + esc(t('evActive')) + '</button></div></div>' +
      '<div class="pad" style="padding-top:12px">' + (missing.length ? '<div class="hint" style="color:var(--red);font-weight:700;padding-bottom:8px">' + esc(t('evMissing')) + ' ' + esc(missing.join(', ')) + '</div>' : '') + '<button class="btn primary" id="evSave" style="width:100%"' + (missing.length ? ' disabled' : '') + '>' + esc(t('evSave')) + '</button><div class="msg" id="evMsg" hidden></div></div>';
    var read = function () {
      ev.name = $('evName').value.trim(); if (ev.isNew) ev.id = slug($('evId').value || ev.name);
      ev.start_date = $('evStart').value; ev.end_date = $('evEnd').value || ev.start_date;
      ev.game_prefix = $('evPrefix').value.trim().toUpperCase(); ev.league = $('evLeagueName').value.trim();
      ev.rules_url = $('evRules').value.trim(); ev.site_id = Number($('evSite').value) || ev.site_id; ev.alert_emails = $('evAlerts').value.split(',').map(function (x) { return x.trim(); }).filter(Boolean); ev.blurb = $('evBlurb').value.trim();
    };
    $('evBack').onclick = function () { SU.ev = null; renderSetup(); };
    $('evName').oninput = function () { if (ev.isNew && !$('evId').dataset.touched) $('evId').value = slug($('evName').value); read(); };
    $('evId').oninput = function () { $('evId').dataset.touched = '1'; read(); };
    ['evStart', 'evEnd', 'evPrefix', 'evLeagueName', 'evSite', 'evAlerts', 'evBlurb', 'evRules'].forEach(function (id) { $(id).oninput = read; $(id).onchange = read; });
    $('evVenueAdd').onchange = function () { read(); var v = $('evVenueAdd').value; if (v && ev.venues.indexOf(v) < 0) ev.venues.push(v); SU.check = null; renderSetup(); };
    $('setupBody').querySelectorAll('[data-venue]').forEach(function (b) { b.onclick = function () { read(); var v = b.getAttribute('data-venue'), i = ev.venues.indexOf(v); if (i >= 0) ev.venues.splice(i, 1); else ev.venues.push(v); SU.check = null; renderSetup(); }; });
    $('setupBody').querySelectorAll('[data-tool]').forEach(function (b) { b.onclick = function () { read(); var k = b.getAttribute('data-tool'), i = ev.tools.indexOf(k); if (i >= 0) ev.tools.splice(i, 1); else ev.tools.push(k); renderSetup(); }; });
    $('setupBody').querySelectorAll('[data-type]').forEach(function (b) { b.onclick = function () { read(); ev.type = b.getAttribute('data-type'); renderSetup(); }; });
    $('setupBody').querySelectorAll('[data-active]').forEach(function (b) { b.onclick = function () { read(); ev.active = !ev.active; renderSetup(); }; });
    $('evCheck').onclick = async function () {
      read();
      if (!ev.venues.length || !ev.start_date) return;
      var r = await sb.from('games').select('game_num,venue').eq('date', ev.start_date).in('venue', ev.venues).limit(2000);
      var rows = r.data || [], pre = {};
      rows.forEach(function (g) { var m = /^([A-Za-z]{2,5})/.exec(String(g.game_num || '')); if (m) pre[m[1].toUpperCase()] = (pre[m[1].toUpperCase()] || 0) + 1; });
      var withP = ev.game_prefix ? rows.filter(function (g) { return String(g.game_num || '').toUpperCase().indexOf(ev.game_prefix) === 0; }).length : 0;
      SU.check = rows.length ? t('evCheckResult').replace('{g}', rows.length).replace('{p}', withP) : t('evCheckNone');
      renderSetup();
      $('prefixPicks').innerHTML = Object.keys(pre).sort(function (a, b) { return pre[b] - pre[a]; }).slice(0, 6).map(function (p) { return '<button class="chip-btn" data-prefix="' + esc(p) + '">' + esc(p) + ' <small>' + pre[p] + '</small></button>'; }).join('');
      $('prefixPicks').querySelectorAll('[data-prefix]').forEach(function (b) { b.onclick = function () { $('evPrefix').value = b.getAttribute('data-prefix'); read(); renderSetup(); }; });
    };
    $('evSave').onclick = async function () {
      read();
      if (evMissing(ev).length) { renderSetup(); return; }
      var b = $('evSave'); b.disabled = true; b.textContent = t('evSaving');
      try {
        await post({ action: 'saveTournament', id: ev.id, name: ev.name, type: ev.type, year: String(ev.start_date).slice(0, 4), startDate: ev.start_date, endDate: ev.end_date, siteId: ev.site_id, league: ev.league, venues: ev.venues, tools: ev.tools, url: ev.url || '', accent: ev.accent || '', blurb: ev.blurb, active: ev.active, alertEmails: ev.alert_emails, gamePrefix: ev.game_prefix });
        // The rules address lives only in the database.
        await sb.from('events').update({ rules_url: ev.rules_url || null }).eq('id', ev.id);
        await loadSetup(); SU.ev = null; renderSetup();
        $('setupBody').insertAdjacentHTML('afterbegin', '<div class="msg good" style="margin:12px 20px 0">' + esc(t('evSaved')) + '</div>');
      } catch (e) { b.disabled = false; b.textContent = t('evSave'); var m = $('evMsg'); m.hidden = false; m.className = 'msg bad'; m.textContent = t('reviewFailed') + ' ' + (e.message || ''); }
    };
  }

  // ── End of day ───────────────────────────────────────────────────
  // EOD.edit holds the report being corrected (tap a report to load it);
  // the backend keys on date + event + name, so filing again updates it.
  // EOD.pay is a day to print as a payroll sheet (everyone who filed).
  var EOD = { mine: [], all: [], date: '', venues: [], role: 'sc', edit: null, pay: null };
  function canEod() { return iCan('coaching') || iCan('scheduling') || iCan('command_center'); }
  function roleLabel(r) { var k = String(r || 'other').toLowerCase(), v = t('roles.' + k); return v === 'roles.' + k ? k.toUpperCase() : v; }
  async function eodVenuesFor(date) {
    var g = await fetchAll(function () { return sb.from('games').select('venue').eq('date', date).not('status', 'in', '(C,X,canceled_no_pay)').order('venue'); });
    var vs = {}; (g.data || []).forEach(function (x) { if (x.venue) vs[x.venue] = 1; });
    return Object.keys(vs).sort();
  }
  async function loadEod_() {
    var mine = await fetchAll(function () { return sb.from('eod_reports').select('id,date,venue,staff_name,role,time_in,time_out,hours,games_covered,incidents,notes').order('date', { ascending: false }).order('staff_name'); });
    var keys = S.me.nameKeys || [];
    EOD.error = mine.error ? (mine.error.message || String(mine.error)) : '';
    EOD.all = mine.data || [];
    EOD.mine = EOD.all.filter(function (r) { return keys.indexOf(key(r.staff_name)) >= 0; });
    EOD.venues = await eodVenuesFor(EOD.date || todayStr());
    if (!EOD.role) EOD.role = iCan('command_center') || iCan('scheduling') ? 'sc' : 'coach';
  }
  async function loadEod() { return load(loadEod_()); }
  function eodArchive(row) {
    var venues = {}; EOD.all.forEach(function (r) { if (r.venue) venues[r.venue] = 1; });
    var vlist = Object.keys(venues).sort();
    var rows = EOD.all.filter(function (r) { return !EOD.vfilter || r.venue === EOD.vfilter; });
    var days = {}, order = [];
    rows.forEach(function (r) { var d = r.date || ''; if (!days[d]) { days[d] = []; order.push(d); } days[d].push(r); });
    return '<div class="pad no-print" style="padding-top:8px;display:flex;gap:8px"><select id="eodVenueFilter" style="font:inherit;width:100%;padding:10px;border:2px solid var(--navy);border-radius:8px;background:var(--surface);color:var(--ink)"><option value="">' + esc(t('allVenuesPick')) + '</option>' + vlist.map(function (v) { return '<option value="' + esc(v) + '"' + (EOD.vfilter === v ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') + '</select><button class="btn outline small" id="eodPrint">' + esc(t('print')) + '</button></div><div class="pad no-print" style="padding-top:8px"><button class="btn primary small" id="eodPayAll" style="width:100%">' + esc(t('eodPayroll')) + '</button></div>' +
      (order.length ? order.map(function (d) {
        var list = days[d], hours = 0; list.forEach(function (r) { hours += Number(r.hours || 0); });
        var open = EOD.open === d;
        return '<div class="pad eod-day' + (open ? ' open' : '') + '"><button class="rowbtn" style="margin:8px 0 0;width:100%" data-eodday="' + esc(d) + '"><span><span class="t">' + esc(dayLong(d)) + (EOD.vfilter ? ', ' + esc(EOD.vfilter) : '') + '</span><br><span class="s">' + list.length + ' ' + esc(t(list.length === 1 ? 'eodReportOne' : 'eodReportMany')) + ', ' + hours.toFixed(1) + ' ' + esc(t('eodHours')) + '</span></span><span class="disp no-print" style="font-size:22px">' + (open ? '−' : '+') + '</span></button><div class="eod-rows">' + (open ? '<button class="btn outline small no-print" data-eodpay="' + esc(d) + '" style="margin:8px 0">' + esc(t('eodPayroll')) + '</button>' : '') + list.map(row).join('') + '</div></div>';
      }).join('') : '<div class="pad hint">' + esc(t('eodNone')) + '</div>');
  }
  function hhmm(v) { return v ? String(v).slice(0, 5) : ''; }
  // Payroll sheet: a date range and one venue or all, every report in it,
  // grouped by day with a total per day, then a total per person.
  function renderEodPay() {
    var P = EOD.pay, from = P.from, to = P.to, v = P.venue || '';
    var list = EOD.all.filter(function (r) { return r.date && r.date >= from && r.date <= to && (!v || r.venue === v); });
    list.sort(function (a, b) { return (a.date || '').localeCompare(b.date || '') || (a.venue || '').localeCompare(b.venue || '') || (a.staff_name || '').localeCompare(b.staff_name || ''); });
    var venues = {}; EOD.all.forEach(function (r) { if (r.venue) venues[r.venue] = 1; });
    var vlist = Object.keys(venues).sort();
    var inp = 'font:inherit;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)';
    var cell = 'padding:7px 6px;border-bottom:1px solid var(--muted);text-align:left;vertical-align:top';
    var th = function (txt, right) { return '<th style="' + cell + (right ? ';text-align:right' : '') + '">' + esc(txt) + '</th>'; };
    var days = {}, order = [], total = 0, people = {};
    list.forEach(function (r) {
      var d = r.date; if (!days[d]) { days[d] = []; order.push(d); } days[d].push(r);
      var h = Number(r.hours || 0); total += h;
      var k = key(r.staff_name); if (!people[k]) people[k] = { name: r.staff_name, roles: {}, days: {}, hours: 0 };
      people[k].roles[roleLabel(r.role)] = 1; people[k].days[d] = 1; people[k].hours += h;
    });
    var plist = Object.keys(people).map(function (k) { return people[k]; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    var range = from === to ? dayLong(from) : dayLong(from) + ' ' + t('to') + ' ' + dayLong(to);
    var body = order.map(function (d) {
      var sub = 0; days[d].forEach(function (r) { sub += Number(r.hours || 0); });
      return '<tr><td colspan="6" style="' + cell + ';padding-top:14px;font-weight:800;border-bottom:2px solid var(--navy)">' + esc(dayLong(d)) + '</td></tr>' +
        days[d].map(function (r) { return '<tr><td style="' + cell + '"><b>' + esc(r.staff_name) + '</b></td><td style="' + cell + '">' + esc(roleLabel(r.role)) + '</td><td style="' + cell + '">' + esc(r.venue || '') + '</td><td style="' + cell + '">' + esc(hhmm(r.time_in)) + '</td><td style="' + cell + '">' + esc(hhmm(r.time_out)) + '</td><td style="' + cell + ';text-align:right">' + esc(r.hours != null ? Number(r.hours).toFixed(1) : '') + '</td></tr>'; }).join('') +
        (order.length > 1 ? '<tr><td colspan="5" style="' + cell + ';font-weight:700">' + esc(t('eodDayTotal')) + '</td><td style="' + cell + ';text-align:right;font-weight:700">' + sub.toFixed(1) + '</td></tr>' : '');
    }).join('');
    $('eodBody').innerHTML = '<div class="card no-print" style="gap:10px"><div class="hint" style="font-weight:700">' + esc(t('eodPayroll')) + '</div>' +
      '<div class="grid2"><div><label class="hint" style="font-weight:700" for="payFrom">' + esc(t('eodFrom')) + '</label><input id="payFrom" type="date" value="' + esc(from) + '" style="' + inp + ';width:100%"></div><div><label class="hint" style="font-weight:700" for="payTo">' + esc(t('eodTo')) + '</label><input id="payTo" type="date" value="' + esc(to) + '" style="' + inp + ';width:100%"></div></div>' +
      '<label class="hint" style="font-weight:700" for="payVenue">' + esc(t('eodVenue')) + '</label><select id="payVenue" style="' + inp + ';width:100%"><option value="">' + esc(t('allVenuesPick')) + '</option>' + vlist.map(function (x) { return '<option value="' + esc(x) + '"' + (x === v ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select>' +
      '<div style="display:flex;gap:8px"><button class="btn outline" id="eodPayBack">' + esc(t('back')) + '</button><button class="btn outline" id="eodPayGo">' + esc(t('go')) + '</button><button class="btn primary" id="eodPayPrint" style="flex:1">' + esc(t('print')) + '</button></div></div>' +
      '<div class="pad eod-pay"><div class="disp h2 print-keep" style="padding:0">' + esc(t('eodPayroll')) + '</div><div class="hint" style="margin-bottom:6px">' + esc(range) + (v ? ', ' + esc(v) : ', ' + esc(t('allVenuesPick'))) + '. ' + list.length + ' ' + esc(t(list.length === 1 ? 'eodReportOne' : 'eodReportMany')) + ', ' + total.toFixed(1) + ' ' + esc(t('eodHours')) + '.</div>' +
      (list.length ? '<table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr>' + th(t('eodName')) + th(t('eodRole')) + th(t('eodVenue')) + th(t('eodIn')) + th(t('eodOut')) + th(t('eodHours'), 1) + '</tr></thead><tbody>' + body +
        '<tr><td colspan="5" style="' + cell + ';border-bottom:0;font-weight:800;padding-top:14px">' + esc(t('eodTotal')) + '</td><td style="' + cell + ';border-bottom:0;text-align:right;font-weight:800;padding-top:14px">' + total.toFixed(1) + '</td></tr></tbody></table>' +
        '<div class="disp h2 print-keep" style="padding:18px 0 6px">' + esc(t('eodByPerson')) + '</div><table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr>' + th(t('eodName')) + th(t('eodRole')) + th(t('eodDays'), 1) + th(t('eodHours'), 1) + '</tr></thead><tbody>' +
        plist.map(function (p) { return '<tr><td style="' + cell + '"><b>' + esc(p.name) + '</b></td><td style="' + cell + '">' + esc(Object.keys(p.roles).join(', ')) + '</td><td style="' + cell + ';text-align:right">' + Object.keys(p.days).length + '</td><td style="' + cell + ';text-align:right;font-weight:700">' + p.hours.toFixed(1) + '</td></tr>'; }).join('') + '</tbody></table>' : '<div class="hint">' + esc(t('eodNone')) + '</div>') +
      '<div class="hint" style="margin-top:14px">' + esc(t('eodPayNote')) + '</div></div>';
    $('eodPayBack').onclick = function () { EOD.pay = null; renderEod(); };
    $('eodPayPrint').onclick = function () { window.print(); };
    var go = function () { var f = $('payFrom').value, tt = $('payTo').value; if (!f || !tt) return; if (tt < f) { var x = f; f = tt; tt = x; } EOD.pay = { from: f, to: tt, venue: $('payVenue').value }; renderEodPay(); };
    $('eodPayGo').onclick = go; $('payVenue').onchange = go;
    $('payFrom').onchange = go; $('payTo').onchange = go;
  }
  function renderEod() {
    if (EOD.pay) { renderEodPay(); return; }
    var today = todayStr(), roles = ['sc', 'sm', 'coach', 'mentor', 'admin'];
    var e = EOD.edit, venue = e ? (e.venue || '') : '';
    var vlist = EOD.venues.slice(); if (venue && vlist.indexOf(venue) < 0) vlist.unshift(venue);
    var inp = 'font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)';
    var venueOpts = function (list, sel) { return list.map(function (v) { return '<option value="' + esc(v) + '"' + (v === sel ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') + '<option value="">' + esc(t('other')) + '</option>'; };
    var venueField = '<select id="eodVenue" style="' + inp + '">' + venueOpts(vlist, venue) + '</select>';
    var canEditAny = !!S.me.real_admin && !S.me.previewing;
    var row = function (r) {
      var mine = (S.me.nameKeys || []).indexOf(key(r.staff_name)) >= 0, editable = mine || canEditAny;
      var body = '<div><b>' + esc(r.staff_name) + '</b> <span class="hint">' + esc(roleLabel(r.role)) + '</span><br><span class="hint">' + esc(dayLong(r.date)) + ', ' + esc(r.venue || '') + ', ' + esc(hhmm(r.time_in)) + ' to ' + esc(hhmm(r.time_out)) + (r.notes ? '. ' + esc(r.notes) : '') + '</span>' + (editable ? '<br><span class="hint no-print" style="color:var(--navy);font-weight:700">' + esc(t('eodTapEdit')) + '</span>' : '') + '</div><div class="n">' + esc(r.hours != null ? r.hours : '') + '</div>';
      return editable ? '<button class="rowline rowbtn" style="width:100%;text-align:left" data-eodedit="' + r.id + '">' + body + '</button>' : '<div class="rowline">' + body + '</div>';
    };
    $('eodBody').innerHTML = (EOD.error ? '<div class="msg bad" style="margin:10px 20px 0">' + esc(t('loadFailed')) + ' ' + esc(EOD.error) + '</div>' : '') +
      '<div class="card no-print" style="gap:10px">' +
      (e ? '<div class="msg good" style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span>' + esc(t('eodEditing')) + ' <b>' + esc(e.staff_name) + '</b>, ' + esc(dayLong(e.date)) + '</span><button class="btn outline small" id="eodEditCancel">' + esc(t('cancel')) + '</button></div>' : '') +
      '<div class="hint" style="font-weight:700">' + esc(t('eodRole')) + '</div><div class="chips">' + roles.map(function (k) { return '<button class="chip-btn' + (EOD.role === k ? ' on' : '') + '" data-role="' + k + '">' + esc(t('roles.' + k)) + '</button>'; }).join('') + '</div>' +
      '<label class="hint" style="font-weight:700" for="eodDate">' + esc(t('eodDate')) + '</label><input id="eodDate" type="date" value="' + esc(e ? e.date : (EOD.date || today)) + '" style="' + inp + '">' +
      '<label class="hint" style="font-weight:700" for="eodVenue">' + esc(t('eodVenue')) + '</label>' + venueField + '<div class="hint" id="eodVenueHint">' + esc(t('eodVenueHint')) + '</div>' +
      '<div class="grid2"><div><label class="hint" style="font-weight:700" for="eodIn">' + esc(t('eodIn')) + '</label><input id="eodIn" type="time" value="' + esc(e ? hhmm(e.time_in) : '') + '" style="' + inp + '"></div><div><label class="hint" style="font-weight:700" for="eodOut">' + esc(t('eodOut')) + '</label><input id="eodOut" type="time" value="' + esc(e ? hhmm(e.time_out) : '') + '" style="' + inp + '"></div></div>' +
      '<div class="hint">' + esc(t('eodCounted')) + '</div>' +
      '<label class="hint" style="font-weight:700" for="eodNotes">' + esc(t('eodNotes')) + '</label><textarea id="eodNotes" placeholder="' + esc(t('eodNotesPlaceholder')) + '" style="min-height:100px">' + esc(e ? (e.notes || '') : '') + '</textarea>' +
      '<button class="btn primary" id="eodFile">' + esc(t(e ? 'eodUpdate' : 'eodFile')) + '</button><div class="msg" id="eodMsg" hidden></div></div>' +
      '<div class="pad no-print"><button class="rowbtn" style="margin:8px 0 0;width:100%" id="eodMineToggle"><span><span class="t">' + esc(t('eodMine')) + '</span><br><span class="s">' + EOD.mine.length + ' ' + esc(t(EOD.mine.length === 1 ? 'eodReportOne' : 'eodReportMany')) + '</span></span><span class="disp" style="font-size:22px">' + (EOD.mineOpen ? '\u2212' : '+') + '</span></button></div>' + (EOD.mineOpen ? '<div class="pad">' + (EOD.mine.length ? EOD.mine.slice(0, 10).map(row).join('') : '<div class="hint">' + esc(t('eodNone')) + '</div>') + '</div>' : '') +
      (iCan('command_center') ? '<div class="disp h2">' + esc(t('eodAll')) + '</div>' + eodArchive(row) : '');
    var pb = $('eodPrint'); if (pb) pb.onclick = function () { window.print(); };
    var vf = $('eodVenueFilter'); if (vf) vf.onchange = function () { EOD.vfilter = vf.value; EOD.date = $('eodDate').value; renderEod(); };
    $('eodMineToggle').onclick = function () { EOD.mineOpen = !EOD.mineOpen; EOD.date = $('eodDate').value; renderEod(); };
    var ec = $('eodEditCancel'); if (ec) ec.onclick = function () { EOD.edit = null; EOD.date = ''; renderEod(); };
    $('eodBody').querySelectorAll('[data-eodday]').forEach(function (b) { b.onclick = function () { var d = b.getAttribute('data-eodday'); EOD.open = EOD.open === d ? null : d; EOD.date = $('eodDate').value; renderEod(); }; });
    $('eodBody').querySelectorAll('[data-eodpay]').forEach(function (b) { b.onclick = function () { var d = b.getAttribute('data-eodpay'); EOD.pay = { from: d, to: d, venue: EOD.vfilter || '' }; renderEod(); }; });
    var pa = $('eodPayAll'); if (pa) pa.onclick = function () { var d = new Date(), t0 = new Date(d.getTime() - 6 * 864e5), f = t0.getFullYear() + '-' + String(t0.getMonth() + 1).padStart(2, '0') + '-' + String(t0.getDate()).padStart(2, '0'); EOD.pay = { from: f, to: todayStr(), venue: EOD.vfilter || '' }; renderEod(); };
    $('eodBody').querySelectorAll('[data-eodedit]').forEach(function (b) { b.onclick = function () {
      var id = b.getAttribute('data-eodedit'), r = null; EOD.all.forEach(function (x) { if (String(x.id) === id) r = x; });
      if (!r) return; EOD.edit = r; EOD.role = String(r.role || 'sc').toLowerCase(); if (roles.indexOf(EOD.role) < 0) EOD.role = EOD.role === 'other' ? 'admin' : 'sc'; EOD.date = r.date;
      eodVenuesFor(r.date).then(function (v) { EOD.venues = v; renderEod(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    }; });
    $('eodBody').querySelectorAll('[data-role]').forEach(function (b) { b.onclick = function () { EOD.role = b.getAttribute('data-role'); EOD.date = $('eodDate').value; b.parentNode.querySelectorAll('.chip-btn').forEach(function (c) { c.classList.toggle('on', c === b); }); }; });
    // Venue list follows the date picked, not today: a report filed the
    // morning after still offers the venues that were running that day.
    $('eodDate').onchange = async function () {
      var d = $('eodDate').value; if (!d) return; EOD.date = d;
      var sel = $('eodVenue'), cur = sel.value;
      $('eodVenueHint').textContent = t('eodVenueLoading');
      try { EOD.venues = await eodVenuesFor(d); } catch (err) { EOD.venues = []; }
      var list = EOD.venues.slice(); if (cur && list.indexOf(cur) < 0) list.unshift(cur);
      sel.innerHTML = venueOpts(list, cur);
      $('eodVenueHint').textContent = EOD.venues.length ? t('eodVenueHint') : t('eodVenueNone');
    };
    $('eodFile').onclick = async function () {
      var tin = $('eodIn').value, tout = $('eodOut').value;
      if (!tin || !tout) { say('eodMsg', t('eodBothTimes'), 'bad'); return; }
      var b = $('eodFile'); b.disabled = true; b.textContent = t('eodFiling');
      var venue = $('eodVenue').value, ev = null;
      S.events.forEach(function (x) { if (!ev && (x.venues || []).some(function (v) { return key(v) === key(venue); })) ev = x; });
      var who = EOD.edit && canEditAny ? EOD.edit.staff_name : (S.me.first_name + ' ' + S.me.last_name);
      try {
        var jr = await sb.rpc('hub_eod', { p: { event: ev ? ev.id : '', date: $('eodDate').value, venue: venue, staff_name: who, role: EOD.role, time_in: tin, time_out: tout, notes: $('eodNotes').value.trim() } });
        if (jr.error) throw new Error(jr.error.message);
        var j = jr.data || {};
        if (!j.ok) throw new Error('error');
        var wasEdit = !!EOD.edit; EOD.edit = null; EOD.date = '';
        await loadEod(); renderEod();
        say('eodMsg', t(wasEdit || j.updated ? 'eodUpdated' : 'eodFiled') + (j.hours != null ? ' ' + j.hours + ' ' + t('eodHours') + '.' : ''), 'good');
        $('eodMsg').scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (err) { b.disabled = false; b.textContent = t(EOD.edit ? 'eodUpdate' : 'eodFile'); say('eodMsg', t('reviewFailed') + ' ' + (err.message || ''), 'bad'); }
    };
  }

  // ── State view: the program by year (SRA / SYRA / SDRO / ADMIN) ───
  var ST = { rows: [], year: null, table: false };
  async function loadState_() {
    // 1,600+ rows now that ZIPs are in; the database hands back 1,000 per
    // request, so page through, or the far ZIPs silently vanish.
    var r = await fetchAll(function () { return sb.from('program_years').select('year,metric,segment,value,note').order('year').order('metric').order('segment'); });
    if (r.error) throw r.error;
    ST.rows = r.data || [];
    // Live season numbers from the same view the Coverage tab uses.
    try { var cov = await sb.rpc('coverage_rows'); ST.cov = cov.data || []; } catch (e) { ST.cov = []; }
    try { var fs = await sb.rpc('fitness_summary'); ST.fit = fs.data || []; } catch (e) { ST.fit = []; }
    try { var sn = await sb.from('registration_snapshots').select('season,taken_on,licensed,first_year,continuing,gap_return').order('taken_on'); ST.snaps = sn.data || []; } catch (e) { ST.snaps = []; }
    // ZIP centroids and the fields we use, static files in this folder.
    if (!ST.zips) { try { ST.zips = await fetch('zips.json?v=' + VERSION).then(function (x) { return x.json(); }); } catch (e) { ST.zips = {}; } }
    ST.venues = {}; try { (await loadVenues_()).forEach(function (v) { if (v.lat != null && v.lon != null) ST.venues[v.name] = [Number(v.lat), Number(v.lon)]; }); } catch (e) {}
  }
  // Colorado is a rectangle: lon -109.05 to -102.04, lat 37.0 to 41.0. Plain scaling is a map.
  function stMap(Y) {
    var W = 360, H = 206, L = -109.06, R = -102.04, T = 41.0, B = 36.99;
    var px = function (lon) { return (lon - L) / (R - L) * W; }, py = function (lat) { return (T - lat) / (T - B) * H; };
    var miles = function (a, b) { var dLat = (a[0] - b[0]) * 69, dLon = (a[1] - b[1]) * 69 * Math.cos(a[0] * Math.PI / 180); return Math.sqrt(dLat * dLat + dLon * dLon); };
    var radius = ST.radius || 25, pts = [], total = 0, near = 0, unknown = 0, byVenue = {};
    var vnames = Object.keys(ST.venues || {});
    vnames.forEach(function (v) { byVenue[v] = 0; });
    ST.rows.forEach(function (r) {
      if (r.year !== Y || r.metric !== 'zip') return;
      total += r.value; var z = ST.zips[r.segment]; if (!z) { unknown += r.value; return; }
      var isNear = false;
      vnames.forEach(function (v) { if (miles(z, ST.venues[v]) <= radius) { byVenue[v] += r.value; isNear = true; } });
      if (isNear) near += r.value;
      pts.push({ zip: r.segment, city: z[2], n: r.value, x: px(z[1]), y: py(z[0]), near: isNear });
    });
    if (!pts.length) return '';
    pts.sort(function (a, b) { return b.n - a.n; });
    // Search: a ZIP or a venue name. The match becomes the focus point.
    var q = (ST.q || '').trim(), focus = null, focusLabel = '', focusHtml = '';
    if (/^\d{5}$/.test(q)) { var fz = ST.zips[q]; if (fz) { focus = fz; focusLabel = q + ' ' + fz[2]; } }
    else if (q) { var qk = q.toLowerCase(); var hit = vnames.filter(function (v) { return v.toLowerCase().indexOf(qk) >= 0; })[0]; if (hit) { focus = ST.venues[hit]; focusLabel = hit; } }
    if (q && !focus) focusHtml = '<div class="msg bad">' + esc(t('stNoMatch')) + '</div>';
    if (focus) {
      var around = pts.filter(function (p) { var z = ST.zips[p.zip]; return miles(z, focus) <= radius; }).sort(function (a, b) { return b.n - a.n; });
      var sum = 0; around.forEach(function (p) { sum += p.n; });
      var here = /^\d{5}$/.test(q) ? pts.filter(function (p) { return p.zip === q; })[0] : null;
      focusHtml = '<div class="card" style="border-color:var(--gold);gap:4px;margin:8px 0 0"><b>' + esc(focusLabel) + '</b>' + (here ? '<div>' + esc(t('stZipHere').replace('{n}', fmtN(here.n)).replace('{y}', Y)) + '</div>' : (/^\d{5}$/.test(q) ? '<div>' + esc(t('stZipHere').replace('{n}', '0').replace('{y}', Y)) + '</div>' : '')) +
        '<div><b>' + fmtN(sum) + '</b> ' + esc(t('stWithin').replace('{r}', radius)) + '</div>' + hbars(around.slice(0, 10).map(function (p) { return { l: p.city + ' ' + p.zip, v: p.n }; }), sum) + '</div>';
    }
    var max = pts[0].n, rad = function (n) { return 2 + 14 * Math.sqrt(n / max); };
    var cities = [['Denver', 39.7392, -104.9903], ['Boulder', 40.015, -105.2705], ['Fort Collins', 40.5853, -105.0844], ['Colorado Springs', 38.8339, -104.8214], ['Pueblo', 38.2544, -104.6091], ['Grand Junction', 39.0639, -108.5506], ['Durango', 37.2753, -107.8801], ['Greeley', 40.4233, -104.7091], ['Alamosa', 37.4695, -105.87]];
    var cityLabels = cities.map(function (c) { return '<circle cx="' + px(c[2]) + '" cy="' + py(c[1]) + '" r="1.5" class="citydot"/><text x="' + (px(c[2]) + 4) + '" y="' + (py(c[1]) + 3) + '" class="city">' + esc(c[0]) + '</text>'; }).join('');
    var svg = '<svg class="chart map" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(t('stMapTitle')) + '"><rect x="0.5" y="0.5" width="' + (W - 1) + '" height="' + (H - 1) + '" class="state"/>' +
      pts.slice().reverse().map(function (p) { return '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + rad(p.n).toFixed(1) + '" class="ref' + (p.near ? ' near' : '') + '"><title>' + esc(p.zip + ' ' + p.city + ': ' + p.n) + '</title></circle>'; }).join('') +
      vnames.map(function (v) { var c = ST.venues[v]; return '<g class="venue-pin"><circle cx="' + px(c[1]) + '" cy="' + py(c[0]) + '" r="' + (radius / 69 / (R - L) * W).toFixed(1) + '" class="ring"/><path d="M' + px(c[1]) + ' ' + py(c[0]) + ' l-4 -9 a4 4 0 1 1 8 0 z" class="pin"><title>' + esc(v) + '</title></path></g>'; }).join('') + (focus ? '<circle cx="' + px(focus[1]) + '" cy="' + py(focus[0]) + '" r="' + (radius / 69 / (R - L) * W).toFixed(1) + '" class="focusring"/><circle cx="' + px(focus[1]) + '" cy="' + py(focus[0]) + '" r="3" class="focusdot"/>' : '') + cityLabels + '</svg>';
    var top = pts.slice(0, 8);
    var vlist = vnames.map(function (v) { return { v: v, n: byVenue[v] }; }).sort(function (a, b) { return b.n - a.n; });
    return '<div class="card chartcard wide"><b>' + esc(t('stMapTitle')) + '</b><div class="hint">' + esc(t('stMapHint').replace('{y}', Y)) + '</div>' +
      '<div class="go"><input id="stQ" placeholder="' + esc(t('stSearchPh')) + '" value="' + esc(q) + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"><button class="btn outline" id="stQGo">' + esc(t('go')) + '</button></div>' + svg +
      '<div class="legend"><span><i class="sw" style="background:var(--c1)"></i>' + esc(t('stMapRefs')) + '</span><span><i class="sw" style="background:var(--c2)"></i>' + esc(t('stMapNear')) + '</span><span><i class="sw" style="background:var(--c3)"></i>' + esc(t('stMapField')) + '</span></div>' +
      '<div class="chips" style="margin-top:6px">' + [10, 25, 50].map(function (m) { return '<button class="chip-btn' + (radius === m ? ' on' : '') + '" data-radius="' + m + '">' + m + ' ' + esc(t('stMiles')) + '</button>'; }).join('') + '</div>' +
      focusHtml +
      '<div style="margin-top:6px"><b>' + fmtN(near) + '</b> ' + esc(t('stNearBody').replace('{p}', pct(near, total - unknown) || 0).replace('{r}', radius)) + '</div>' +
      hbars(vlist.map(function (x) { return { l: x.v, v: x.n }; }), 0) +
      '<div class="hint" style="margin-top:8px"><b>' + esc(t('stTopZips')) + '</b> ' + top.map(function (p) { return esc(p.city) + ' ' + p.zip + ' (' + fmtN(p.n) + ')'; }).join(', ') + '.' + (unknown ? ' ' + esc(t('stZipUnknown').replace('{n}', fmtN(unknown))) : '') + '</div>' +
      '<div class="hint">' + esc(t('stVenuesHint')) + '</div></div>';
  }
  async function loadState() { return load(loadState_()); }
  function stVal(y, m, s) { var v = null; ST.rows.forEach(function (r) { if (r.year === y && r.metric === m && r.segment === (s || 'all')) v = r.value; }); return v; }
  function stNote(y) { var n = ''; ST.rows.forEach(function (r) { if (r.year === y && r.metric === 'referees' && r.note) n = r.note; }); return n; }
  function stYears(m) { var ys = {}; ST.rows.forEach(function (r) { if (r.metric === m) ys[r.year] = 1; }); return Object.keys(ys).map(Number).sort(); }
  function pct(a, b) { return b ? Math.round(100 * a / b) : null; }
  function fmtN(n) { return n == null ? '' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  // Small SVG charts. One axis each, thin marks, labels in ink, series in --c1/--c2/--c3.
  function svgBars(labels, values, opt) {
    opt = opt || {}; var W = 360, H = 190, L = 34, R = 8, T = 18, B = 26, n = values.length;
    var max = Math.max.apply(null, values.filter(function (v) { return v != null; }).concat([1]));
    var pw = (W - L - R) / n, bw = Math.max(4, pw - 3), ch = H - T - B;
    var ticks = [0, 0.5, 1].map(function (f) { return Math.round(max * f); });
    var out = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opt.label || '') + '">';
    ticks.forEach(function (tv) { var y = T + ch - ch * tv / max; out += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" class="grid"/><text x="' + (L - 4) + '" y="' + (y + 4) + '" class="tick" text-anchor="end">' + fmtN(tv) + '</text>'; });
    values.forEach(function (v, i) {
      if (v == null) return;
      var x = L + i * pw + (pw - bw) / 2, h = ch * v / max, y = T + ch - h;
      var cls = opt.dim && opt.dim(i) ? ' dim' : '';
      out += '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + h + '" rx="3" class="bb c1' + cls + '"><title>' + esc(labels[i] + ': ' + fmtN(v)) + '</title></rect>';
      if (!opt.labelsOn || opt.labelsOn(i, v)) out += '<text x="' + (x + bw / 2) + '" y="' + (y - 4) + '" class="val" text-anchor="middle">' + fmtN(v) + '</text>';
    });
    labels.forEach(function (l, i) { if (n > 8 && !opt.allLabels && i % 2 === 1 && i !== n - 1) return; out += '<text x="' + (L + i * pw + pw / 2) + '" y="' + (H - 8) + '" class="tick" text-anchor="middle">' + esc(String(l).replace(/^20(\d\d)$/, "'$1")) + '</text>'; });
    return out + '</svg>';
  }
  function svgStack(labels, series, opt) {
    opt = opt || {}; var W = 360, H = 190, L = 34, R = 8, T = 18, B = 26, n = labels.length;
    var totals = labels.map(function (_, i) { return series.reduce(function (a, s) { return a + (s.values[i] || 0); }, 0); });
    var max = Math.max.apply(null, totals.concat([1])), pw = (W - L - R) / n, bw = Math.max(4, Math.min(44, pw - 6)), ch = H - T - B;
    var out = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opt.label || '') + '">';
    [0, 0.5, 1].forEach(function (f) { var tv = Math.round(max * f), y = T + ch - ch * tv / max; out += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" class="grid"/><text x="' + (L - 4) + '" y="' + (y + 4) + '" class="tick" text-anchor="end">' + fmtN(tv) + '</text>'; });
    labels.forEach(function (l, i) {
      var x = L + i * pw + (pw - bw) / 2, yTop = T + ch;
      series.forEach(function (s, k) {
        var v = s.values[i] || 0, h = ch * v / max; yTop -= h;
        out += '<rect x="' + x + '" y="' + (yTop + (k ? 2 : 0)) + '" width="' + bw + '" height="' + Math.max(0, h - (k ? 2 : 0)) + '" rx="2" class="bb c' + (k + 1) + '"><title>' + esc(l + ', ' + s.name + ': ' + fmtN(v)) + '</title></rect>';
        if (h > 16) out += '<text x="' + (x + bw / 2) + '" y="' + (yTop + h / 2 + 4) + '" class="inval" text-anchor="middle">' + fmtN(v) + '</text>';
      });
      out += '<text x="' + (x + bw / 2) + '" y="' + (yTop - 4) + '" class="val" text-anchor="middle">' + fmtN(totals[i]) + '</text>';
      out += '<text x="' + (x + bw / 2) + '" y="' + (H - 8) + '" class="tick" text-anchor="middle">' + esc(String(l)) + '</text>';
    });
    out += '</svg><div class="legend">' + series.map(function (s, k) { return '<span><i class="sw c' + (k + 1) + '"></i>' + esc(s.name) + '</span>'; }).join('') + '</div>';
    return out;
  }
  function svgLines(labels, series, opt) {
    opt = opt || {}; var W = 360, H = 190, L = 34, R = 44, T = 14, B = 26, n = labels.length, max = opt.max || 100, ch = H - T - B, pw = (W - L - R) / Math.max(1, n - 1);
    var out = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opt.label || '') + '">';
    [0, 50, 100].forEach(function (tv) { var y = T + ch - ch * tv / max; out += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" class="grid"/><text x="' + (L - 4) + '" y="' + (y + 4) + '" class="tick" text-anchor="end">' + tv + '%</text>'; });
    labels.forEach(function (l, i) { out += '<text x="' + (L + i * pw) + '" y="' + (H - 8) + '" class="tick" text-anchor="middle">' + esc(String(l)) + '</text>'; });
    var ends = [];
    series.forEach(function (s, k) {
      var pts = [], last = null;
      s.values.forEach(function (v, i) { if (v == null) return; var x = L + i * pw, y = T + ch - ch * v / max; pts.push(x + ',' + y); last = { x: x, y: y, v: v }; });
      if (!pts.length) return;
      out += '<polyline points="' + pts.join(' ') + '" class="line c' + (k + 1) + '"/>';
      s.values.forEach(function (v, i) { if (v == null) return; var x = L + i * pw, y = T + ch - ch * v / max; out += '<circle cx="' + x + '" cy="' + y + '" r="4" class="dot c' + (k + 1) + '"><title>' + esc(labels[i] + ', ' + s.name + ': ' + v + '%') + '</title></circle>'; });
      ends.push({ x: last.x, y: last.y, v: last.v, k: k });
    });
    // End labels: value only (the legend names the series), pushed apart so they never overlap.
    ends.sort(function (a, b) { return a.y - b.y; });
    for (var e = 1; e < ends.length; e++) if (ends[e].y - ends[e - 1].y < 13) ends[e].y = ends[e - 1].y + 13;
    ends.forEach(function (e) { out += '<text x="' + (e.x + 8) + '" y="' + (e.y + 4) + '" class="val"><tspan class="sw' + (e.k + 1) + '">\u25CF</tspan> ' + e.v + '%</text>'; });
    out += '</svg><div class="legend">' + series.map(function (s, k) { return '<span><i class="sw c' + (k + 1) + '"></i>' + esc(s.name) + '</span>'; }).join('') + '</div>';
    return out;
  }
  function hbars(items, total, suffix) {
    var max = Math.max.apply(null, items.map(function (i) { return i.v || 0; }).concat([1]));
    return '<div class="hbars">' + items.map(function (i) {
      return '<div class="hb"><div class="hl">' + esc(i.l) + (i.d != null ? ' <span class="delta ' + (i.d > 0 ? 'up' : i.d < 0 ? 'down' : '') + '">' + (i.d > 0 ? '+' : '') + fmtN(i.d) + '</span>' : '') + '</div><div class="ht"><i style="width:' + Math.round(100 * (i.v || 0) / max) + '%"></i></div><div class="hv">' + fmtN(i.v || 0) + (suffix || '') + (total ? ' <span class="hint">' + pct(i.v || 0, total) + '%</span>' : '') + '</div></div>';
    }).join('') + '</div>';
  }
  function renderState() {
    var fileYears = stYears('level'), allYears = stYears('referees');
    var open = fileYears.length && stVal(fileYears[fileYears.length - 1], 'referees') < 1500 ? fileYears[fileYears.length - 1] : null;
    var full = fileYears.filter(function (y) { return y !== open; });
    var latest = full[full.length - 1], prev = full[full.length - 2];
    if (!ST.year || fileYears.indexOf(ST.year) < 0) ST.year = latest;
    var Y = ST.year, P = full[full.indexOf(Y) - 1] || null;
    var arrow = function (now, before) { if (now == null || before == null) return ''; var d = now - before; return '<span class="delta ' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '">' + (d > 0 ? '+' : '') + fmtN(d) + ' ' + esc(t('stVs')) + ' ' + before + '</span>'; };
    var pctArrow = function (now, before) { if (now == null || before == null) return ''; var d = now - before; return '<span class="delta ' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '">' + (d > 0 ? '+' : '') + d + ' pts</span>'; };
    var tot = stVal(latest, 'referees'), totP = stVal(prev, 'referees');
    var ret = pct(stVal(latest, 'retained_from_prev'), stVal(latest, 'prev_total')), retP = pct(stVal(prev, 'retained_from_prev'), stVal(prev, 'prev_total'));
    var u18 = pct(stVal(latest, 'age', 'u18'), tot), u18P = pct(stVal(prev, 'age', 'u18'), totP);
    var nw = stVal(latest, 'new'), nwP = stVal(prev, 'new');
    var tile = function (big, label, sub) { return '<div class="stat"><b>' + big + '</b><i>' + esc(label) + '</i>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>'; };
    var html = '<div class="stats two">' + tile(fmtN(tot), t('stReferees').replace('{y}', latest), arrow(tot, totP)) + tile(ret == null ? '' : ret + '%', t('stRetention'), pctArrow(ret, retP)) + tile(u18 == null ? '' : u18 + '%', t('stUnder18'), pctArrow(u18, u18P)) + tile(fmtN(nw), t('stNew'), arrow(nw, nwP)) + '</div>' +
      '<div class="pad hint" style="padding-top:8px">' + esc(stNote(latest)) + '</div>';
    // Official US Soccer State Referee Report, RY 25-26 Colorado page, received
    // 28 Oct 2026. Static by design; replace when the next annual report lands.
    html += '<div class="card" style="border-color:var(--gold);gap:6px"><b>' + esc(t('ussfTitle').replace('{y}', '25-26')) + '</b>' +
      '<div class="stats" style="margin:0">' +
      '<div class="stat"><b>54%</b><i>' + esc(t('ussfRet')) + '</i><div class="sub"><span class="delta down">' + esc(t('ussfNat').replace('{n}', '60')) + '</span></div></div>' +
      '<div class="stat"><b>3,066</b><i>' + esc(t('ussfLic')) + '</i><div class="sub"><span class="delta up">+0.2%</span></div></div>' +
      '<div class="stat"><b>1,559</b><i>' + esc(t('ussfYouth')) + '</i><div class="sub"><span class="delta down">-2.5%</span></div></div>' +
      '</div><div class="hint">' + esc(t('ussfSrc')) + '</div></div>';
    if (open) html += '<div class="card" style="border-color:var(--gold);gap:4px"><b>' + esc(t('stOpenTitle').replace('{y}', open)) + '</b><div>' + esc(t('stOpenBody').replace('{n}', fmtN(stVal(open, 'referees'))).replace('{r}', fmtN(stVal(open, 'retained_from_prev'))).replace('{f}', fmtN(stVal(open, 'new')))) + '</div><div class="hint">' + esc(stNote(open)) + '</div></div>';
    // 1. Referees by year
    var trendYears = allYears.filter(function (y) { return y !== open; });
    var tv = trendYears.map(function (y) { return stVal(y, 'referees'); });
    var peak = Math.max.apply(null, tv);
    html += '<div class="disp h2">' + esc(t('stByYear')) + '</div><div class="card chartcard">' + svgBars(trendYears, tv, { label: t('stByYear'), labelsOn: function (i, v) { return i === 0 || i === tv.length - 1 || (v === peak && i < tv.length - 2); }, dim: function (i) { return stVal(trendYears[i], 'source', 'file') == null; } }) + '<div class="hint">' + esc(t('stByYearHint')) + '</div></div>';
    // 2. New vs returning
    var nrYears = full.filter(function (y) { return stVal(y, 'new') != null && stVal(y, 'returning') != null; });
    var split = nrYears.length && nrYears.every(function (y) { return stVal(y, 'continuing') != null; });
    if (nrYears.length) html += '<div class="disp h2">' + esc(t('stNewReturning')) + '</div><div class="card chartcard">' + svgStack(nrYears, split ?
      [{ name: t('stContinuing'), values: nrYears.map(function (y) { return stVal(y, 'continuing'); }) }, { name: t('stGapReturn'), values: nrYears.map(function (y) { return stVal(y, 'gap_return'); }) }, { name: t('stFirstTime'), values: nrYears.map(function (y) { return stVal(y, 'new'); }) }] :
      [{ name: t('stReturning'), values: nrYears.map(function (y) { return stVal(y, 'returning'); }) }, { name: t('stFirstTime'), values: nrYears.map(function (y) { return stVal(y, 'new'); }) }], { label: t('stNewReturning') }) + (split ? '<div class="hint">' + esc(t('stGapHint')) + '</div>' : '') + '</div>';
    // The coming season, week by week: every Learning Center load adds a point.
    var openY = open || Number(latest) + 1, snaps = (ST.snaps || []).filter(function (r) { return Number(r.season) === Number(openY); });
    if (snaps.length) {
      var last = snaps[snaps.length - 1], prevWeek = snaps.filter(function (r) { return r.taken_on <= new Date(Date.parse(last.taken_on) - 6 * 86400000).toISOString().slice(0, 10); }).pop();
      var labels = snaps.map(function (r) { var d = new Date(r.taken_on + 'T12:00:00'); return (d.getMonth() + 1) + '/' + d.getDate(); });
      html += '<div class="card chartcard" style="gap:6px"><b>' + esc(t('stPace').replace('{y}', openY)) + '</b><div class="hint">' + esc(t('stPaceLine').replace('{n}', fmtN(last.licensed)).replace('{d}', dayLong(last.taken_on)) + (prevWeek && prevWeek !== last ? ' ' + esc(t('stPaceWeek').replace('{n}', fmtN(last.licensed - prevWeek.licensed))) : '')) + '</div>' +
        (snaps.length > 1 ? svgLines(labels, [{ name: t('stReferees').replace('{y}', openY), short: '', values: snaps.map(function (r) { return r.licensed; }) }, { name: t('stContinuing'), short: '', values: snaps.map(function (r) { return r.continuing; }) }, { name: t('stFirstTime'), short: '', values: snaps.map(function (r) { return r.first_year; }) }], { label: t('stPace').replace('{y}', openY) }) : '') + '</div>';
    }
    // Who comes back: of the referees who left after a year, the share that ever registered again.
    var lvYears = full.filter(function (y) { return stVal(y, 'leavers') != null && Number(y) <= Number(latest) - 2; });
    if (lvYears.length) html += '<div class="card" style="gap:6px"><b>' + esc(t('stLeavers')) + '</b>' + hbars(lvYears.map(function (y) { return { l: String(y) + ', ' + fmtN(stVal(y, 'leavers')) + ' ' + t('stLeft') + ', ' + fmtN(stVal(y, 'leavers_back')) + ' ' + t('stCameBack'), v: pct(stVal(y, 'leavers_back'), stVal(y, 'leavers')) }; }), 0, '%') + '<div class="hint">' + esc(t('stLeaversHint')) + '</div></div>';
    // 3. Retention
    var rYears = full.filter(function (y) { return stVal(y, 'prev_total') != null; });
    if (rYears.length) html += '<div class="disp h2">' + esc(t('stRetentionTitle')) + '</div><div class="card chartcard">' + svgLines(rYears, [
      { name: t('stRetAll'), short: t('stRetAllShort'), values: rYears.map(function (y) { return pct(stVal(y, 'retained_from_prev'), stVal(y, 'prev_total')); }) },
      { name: t('stRetFirst'), short: t('stRetFirstShort'), values: rYears.map(function (y) { return pct(stVal(y, 'first_year_retained'), stVal(y, 'first_year_pool')); }) },
      { name: t('stRetU18'), short: t('stRetU18Short'), values: rYears.map(function (y) { return pct(stVal(y, 'u18_retained'), stVal(y, 'u18_pool')); }) }
    ], { label: t('stRetentionTitle') }) + '<div class="hint">' + esc(t('stRetentionHint')) + '</div></div>';
    // Notes on the data: any year that carries one, in order
    var noted = allYears.filter(function (y) { return stNote(y); });
    if (noted.length) html += '<div class="card" style="gap:4px"><b>' + esc(t('stDataNotes')) + '</b>' + noted.map(function (y) { return '<div class="hint"><b>' + y + '</b> ' + esc(stNote(y)) + '</div>'; }).join('') + '</div>';
    // 4. One year in detail
    var yt = stVal(Y, 'referees');
    var d = function (m, s) { var a = stVal(Y, m, s), b = P ? stVal(P, m, s) : null; return a != null && b != null ? a - b : null; };
    html += '<div class="disp h2">' + esc(t('stDetail')) + '</div><div class="pad"><div class="chips">' + fileYears.map(function (y) { return '<button class="chip-btn' + (Y === y ? ' on' : '') + '" data-styear="' + y + '">' + y + '</button>'; }).join('') + '</div><div class="hint" style="padding-top:6px">' + esc(fmtN(yt)) + ' ' + esc(t('stRefereesIn')) + ' ' + Y + (P ? '. ' + esc(t('stDeltaHint')).replace('{y}', P) : '') + '</div></div>' +
      '<div class="card" style="gap:6px"><b>' + esc(t('stAge')) + '</b>' + hbars([['u18', t('ageU18')], ['18_24', '18 to 24'], ['25_39', '25 to 39'], ['40_54', '40 to 54'], ['55plus', '55+']].map(function (b) { return { l: b[1], v: stVal(Y, 'age', b[0]), d: d('age', b[0]) }; }), yt) + '</div>' +
      '<div class="card" style="gap:6px"><b>' + esc(t('stGender')) + '</b>' + hbars([['m', t('genderM')], ['f', t('genderF')], ['other', t('genderOther')]].map(function (b) { return { l: b[1], v: stVal(Y, 'gender', b[0]), d: d('gender', b[0]) }; }), yt) + '</div>' +
      '<div class="card" style="gap:6px"><b>' + esc(t('stLevel')) + '</b>' + hbars([['grassroots', t('lvlGrassroots')], ['regional', t('lvlRegional')], ['national', t('lvlNational')]].map(function (b) { return { l: b[1], v: stVal(Y, 'level', b[0]), d: d('level', b[0]) }; }), yt) + '</div>' +
      '<div class="card" style="gap:6px"><b>' + esc(t('stStaff')) + '</b>' + hbars([['assignor', t('stAssignors')], ['mentor', t('stMentors')], ['coach', t('stCoaches')], ['instructor', t('stInstructors')]].map(function (b) { return { l: b[1], v: stVal(Y, 'staff', b[0]) || 0, d: d('staff', b[0]) }; }), 0) + '<div class="hint">' + esc(t('stStaffHint')) + '</div></div>';
    // This season, live: licensed vs working, and the feedback reach
    if (ST.cov && ST.cov.length) {
      var worked = ST.cov.length, seen = ST.cov.filter(function (r) { return r.notes > 0; }).length, rel = 0, rd = 0;
      ST.cov.forEach(function (r) { rel += r.released || 0; rd += r.read || 0; });
      html += '<div class="disp h2">' + esc(t('stSeason')) + '</div><div class="stats two">' + tile(fmtN(worked), t('stWorked'), tot ? '<span class="hint">' + pct(worked, tot) + '% ' + esc(t('stOfLicensed')) + '</span>' : '') + tile(fmtN(seen), t('stSeen'), '<span class="hint">' + pct(seen, worked) + '% ' + esc(t('stOfWorking')) + '</span>') + tile(fmtN(rel), t('stReleased'), '') + tile(rel ? pct(rd, rel) + '%' : '0%', t('stReadShare'), '') + '</div><div class="pad hint" style="padding-top:8px">' + esc(t('stSeasonHint')) + '</div>';
    }
    // Fitness tests, by standard, for the year in view
    var fitRows = (ST.fit || []).filter(function (r) { return Number(r.year) === Number(Y); });
    if (fitRows.length) html += '<div class="card" style="gap:6px"><b>' + esc(t('stFitness')) + '</b>' + hbars(fitRows.map(function (r) { return { l: t('fitStd.' + stdKey(r)) + ', ' + t('sesPassed').toLowerCase() + (Number(r.tested) ? ' (' + pct(Number(r.passed), Number(r.tested)) + '% ' + t('stOfTested').replace('{n}', r.tested) + ')' : ''), v: Number(r.passed) }; }), Number(Y)) + '</div>';
    // Where they are, experience, ethnicity, compliance, registration month
    var regions = [['denver', t('regDenver')], ['north', t('regNorth')], ['springs', t('regSprings')], ['foothills', t('regFoothills')], ['west', t('regWest')], ['mountains', t('regMountains')], ['boulder', t('regBoulder')], ['pueblo', t('regPueblo')], ['south', t('regSouth')], ['southwest', t('regSouthwest')], ['plains', t('regPlains')], ['outside', t('regOutside')]];
    var regItems = regions.map(function (b) { return { l: b[1], v: stVal(Y, 'region', b[0]) || 0, d: d('region', b[0]) }; }).filter(function (i) { return i.v; }).sort(function (a, b) { return b.v - a.v; });
    if (regItems.length) html += '<div class="card" style="gap:6px"><b>' + esc(t('stWhere')) + '</b>' + hbars(regItems, yt) + '<div class="hint">' + esc(t('stWhereHint')) + '</div></div>';
    html += stMap(Y);
    if (stVal(Y, 'experience', 'first') != null) html += '<div class="card" style="gap:6px"><b>' + esc(t('stExperience')) + '</b>' + hbars([['first', t('expFirst')], ['1_3', t('exp13')], ['4_9', t('exp49')], ['10plus', t('exp10')]].map(function (b) { return { l: b[1], v: stVal(Y, 'experience', b[0]) || 0, d: d('experience', b[0]) }; }), yt) + '</div>';
    if (stVal(Y, 'ethnicity', 'white') != null) {
      var ethItems = [['white', t('ethWhite')], ['hispanic', t('ethHispanic')], ['two_or_more', t('ethTwo')], ['black', t('ethBlack')], ['asian', t('ethAsian')], ['native', t('ethNative')], ['hawaiian', t('ethHawaiian')], ['no_answer', t('ethNoAnswer')]].map(function (b) { return { l: b[1], v: stVal(Y, 'ethnicity', b[0]) || 0, d: d('ethnicity', b[0]) }; }).filter(function (i) { return i.v; });
      html += '<div class="card" style="gap:6px"><b>' + esc(t('stEthnicity')) + '</b>' + hbars(ethItems, yt) + '<div class="hint">' + esc(t('stEthnicityHint')) + '</div></div>';
    }
    var adults = stVal(Y, 'adults');
    if (adults) {
      var bg = stVal(Y, 'adults_bgc_clear'), ssv = stVal(Y, 'adults_safesport_valid'), ipsv = stVal(Y, 'ips_valid');
      html += '<div class="card" style="gap:6px"><b>' + esc(t('stCompliance')) + '</b><div class="hint">' + esc(t('stAdultsCount').replace('{n}', fmtN(adults)).replace('{m}', fmtN(stVal(Y, 'minor', 'yes') || 0))) + '</div>' +
        hbars([{ l: t('cmpBgc'), v: bg }, { l: t('cmpSafeSport'), v: ssv }], adults) +
        '<div class="hint" style="margin-top:6px">' + esc(t('stEveryone')) + '</div>' + hbars([{ l: t('cmpIps'), v: ipsv }, { l: t('cmpSafeCleared'), v: stVal(Y, 'safe_soccer', 'cleared') || 0 }, { l: t('cmpSafePhase'), v: (stVal(Y, 'safe_soccer', 'phase_1') || 0) + (stVal(Y, 'safe_soccer', 'phase_2') || 0) }], yt) + '</div>';
    }
    var months = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'], mv = months.map(function (m) { return stVal(Y, 'issue_month', m) || 0; });
    if (mv.some(function (v) { return v; })) html += '<div class="card chartcard"><b>' + esc(t('stWhen')) + '</b>' + svgBars(months.map(function (m) { return t('mon.' + m); }), mv, { label: t('stWhen'), allLabels: true, labelsOn: function (i, v) { return v === Math.max.apply(null, mv); } }) + '<div class="hint">' + esc(t('stWhenHint')) + '</div></div>';
    // Table view
    html += '<div class="pad"><button class="btn outline small" id="stTable">' + esc(t(ST.table ? 'stHideTable' : 'stShowTable')) + '</button></div>' +
      (ST.table ? '<div class="pad"><table class="dt"><thead><tr><th>' + esc(t('stYear')) + '</th><th>' + esc(t('stRefereesCol')) + '</th><th>' + esc(t('stFirstTime')) + '</th><th>' + esc(t('stRetAllShort')) + '</th><th>' + esc(t('ageU18')) + '</th></tr></thead><tbody>' + allYears.map(function (y) { var r = pct(stVal(y, 'retained_from_prev'), stVal(y, 'prev_total')); return '<tr><td>' + y + (y === open ? '*' : '') + '</td><td>' + fmtN(stVal(y, 'referees')) + '</td><td>' + fmtN(stVal(y, 'new')) + '</td><td>' + (r == null ? '' : r + '%') + '</td><td>' + fmtN(stVal(y, 'age', 'u18')) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '') +
      '<div class="pad hint" style="padding-top:12px">' + esc(t('stSources')) + '</div>';
    $('stateBody').innerHTML = html;
    $('stateBody').querySelectorAll('[data-styear]').forEach(function (b) { b.onclick = function () { ST.year = parseInt(b.getAttribute('data-styear'), 10); renderState(); }; });
    $('stTable').onclick = function () { ST.table = !ST.table; renderState(); };
    $('stateBody').querySelectorAll('[data-radius]').forEach(function (b) { b.onclick = function () { ST.radius = parseInt(b.getAttribute('data-radius'), 10); renderState(); }; });
    var sq = $('stQ'); if (sq) { var goQ = function () { ST.q = sq.value; renderState(); var el = $('stQ'); if (el) el.scrollIntoView({ block: 'center' }); }; $('stQGo').onclick = goQ; sq.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); goQ(); } }; }
  }

  // ── A referee's card: from any name, anywhere ────────────────────
  function canSeeRef() { return iCan('coaching') || iCan('review') || iCan('command_center'); }
  function refLink(name) {
    if (!name || !canSeeRef() || /^(tbd|open|none)$/i.test(name)) return esc(name || '');
    return '<a class="refname" href="#ref/' + encodeURIComponent(name) + '">' + esc(name) + '</a>';
  }
  // Every future game a name is on, across every assigning group.
  async function upcomingFor(name, days) {
    var today = todayStr(), until = iso(new Date(Date.now() + (days || 60) * 86400000));
    var q = name.replace(/[,()]/g, ' ').trim();
    var r = await fetchAll(function () { return sb.from('games').select('game_id,date,kickoff,field,age_group,venue,competition,cr,ar1,ar2,fourth,status,site_id').gte('date', today).lte('date', until).not('status', 'in', '(C,X,canceled_no_pay)').or('cr.ilike.' + q + ',ar1.ilike.' + q + ',ar2.ilike.' + q + ',fourth.ilike.' + q).order('date').order('kickoff'); });
    return r.data || [];
  }
  var COACH_NAMES = null;
  function coachNameOf(pid) { if (!pid) return ''; var c = (COACH_NAMES || []).filter(function (x) { return String(x.person_id) === String(pid); })[0]; return c ? c.first_name + ' ' + c.last_name : t('evalCoachWord'); }
  async function loadCoachNames() { if (COACH_NAMES) return; try { var c = await sb.from('coaches').select('person_id,first_name,last_name'); COACH_NAMES = c.data || []; } catch (e) { COACH_NAMES = []; } }
  function upcomingHtml(list, name) {
    var k = key(name);
    if (!list.length) return '<div class="card"><div class="hint">' + esc(t('upNone')) + '</div></div>';
    var days = {}, order = [];
    list.forEach(function (g) { if (!days[g.date]) { days[g.date] = []; order.push(g.date); } days[g.date].push(g); });
    return order.map(function (d) {
      return '<div class="pad" style="padding-top:12px"><div class="hint" style="font-weight:700">' + esc(dayLong(d)) + '</div></div><div class="list" style="padding-top:8px">' + days[d].map(function (g) {
        var role = key(g.cr) === k ? 'CR' : key(g.ar1) === k ? 'AR1' : key(g.ar2) === k ? 'AR2' : '4th';
        var ck = { CR: 'cr', AR1: 'ar1', AR2: 'ar2', '4th': 'fourth' }[role];
        var noteBtn = iCan('coaching') && g.date <= todayStr() ? '<a class="btn outline small" style="margin:6px 0 0" href="#coach/game/' + esc(g.game_id) + '/' + ck + '">' + esc(t('leaveNote')) + '</a>' : '';
        var rq = (ER.mine || []).filter(function (q) { return String(q.game_id) === String(g.game_id) && (q.status === 'requested' || q.status === 'assigned'); })[0];
        var rqLine = rq ? '<div class="pill' + (rq.status === 'assigned' ? ' ok' : '') + '" style="margin-top:6px">' + esc(t('evalPurpose.' + rq.purpose)) + ': ' + esc(rq.status === 'assigned' ? t('evalCoachAssigned').replace('{c}', coachNameOf(rq.coach_person_id)) : t('evalWaitingShort')) + '</div>' : '';
        return '<a class="item" href="#game/' + esc(g.game_id) + '"><div><div class="when"><div class="disp">' + esc(clock(g.kickoff)) + '</div><div class="sub">' + esc(role) + ', ' + esc(g.age_group || '') + '</div></div><div class="hint">' + esc(g.venue || '') + (g.field ? ', ' + esc(g.field) : '') + (g.competition ? '. ' + esc(g.competition) : '') + '</div>' + rqLine + noteBtn + '</div><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>';
      }).join('') + '</div>';
    }).join('');
  }
  function co90RefHtml(c, pid) {
    if (!c || !c.group_name) return '';
    var canSet = iCan('coaching') || iCan('review');
    var bySlot = {}; (c.points || []).forEach(function (p) { bySlot[p.slot] = p; });
    var rows = [1, 2, 3].map(function (sl) {
      var p = bySlot[sl];
      var editing = REF.scSlot === sl;
      return '<div style="padding:4px 0;border-top:1px solid var(--line)">' +
        (p ? '<span class="pill" style="margin-right:6px">' + esc(areaWord(p.area)) + '</span>' + esc(p.point) + ' <span class="hint">' + esc(p.set_by || '') + '</span>' : '<span class="hint">' + esc(t('scEmpty')) + '</span>') +
        (canSet ? ' <button class="linkbtn" data-scslot="' + sl + '">' + esc(t('co90Set')) + '</button>' : '') +
        (editing ? '<div class="chips" style="padding-top:6px">' + ['laws', 'reading', 'fitness', 'presence'].map(function (a) { return '<button class="chip-btn small' + (REF.scArea === a ? ' on' : '') + '" data-scarea="' + a + '" title="' + esc(areaR90(a)) + '">' + esc(areaWord(a)) + '</button>'; }).join('') + '</div>' +
          '<input id="scText" placeholder="' + esc(t('scPointHint')) + '" value="' + esc(REF.scText || '') + '" style="font:inherit;width:100%;margin-top:6px;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">' +
          '<div class="actions" style="padding:6px 0 0"><button class="btn outline small" data-scsave="' + sl + '">' + esc(t('save')) + '</button></div>' : '') + '</div>';
    }).join('');
    return '<div class="card" style="gap:6px;border-color:var(--gold)"><b>' + esc(/^co90/i.test(c.group_name) ? c.group_name : 'CO90 \u00b7 ' + c.group_name) + '</b>' +
      '<div class="hint">' + esc(t('co90Mentor')) + ': ' + esc(c.mentor || t('co90None')) + '. ' + esc(t('co90National')) + ': ' + esc(c.national || t('co90None')) + '.</div>' +
      '<div class="hint" style="font-weight:700">' + esc(t('scTitle')) + '</div><div class="hint">' + esc(t('scHint')) + ' ' + esc(t('scR90Hint')) + '</div>' + rows + '</div>';
  }
  function wireSeasonCard(name, pid) {
    $('refBody').querySelectorAll('[data-scslot]').forEach(function (b) { b.onclick = function () { REF.scSlot = parseInt(b.getAttribute('data-scslot'), 10); REF.scArea = null; REF.scText = ''; renderRef(name); }; });
    $('refBody').querySelectorAll('[data-scarea]').forEach(function (b) { b.onclick = function () { REF.scArea = b.getAttribute('data-scarea'); var x = $('scText'); REF.scText = x ? x.value : REF.scText; renderRef(name); }; });
    $('refBody').querySelectorAll('[data-scsave]').forEach(function (b) { b.onclick = async function () { var x = $('scText'); var txt = (x && x.value || '').trim(); if (!txt || !REF.scArea) return; b.disabled = true; await sb.rpc('co90_set_point', { p_person: pid, p_slot: parseInt(b.getAttribute('data-scsave'), 10), p_area: REF.scArea, p_point: txt }); REF.scSlot = null; renderRef(name); }; });
  }
  // ── One-to-one text from the program number (A7). The database enforces the
  // guardian rule for minors; this only decides what the card shows.
  function opsTextHtml(ct) {
    if (!iCan('command_center') && !iCan('people')) return '';
    var ok = !ct.minor || ct.guardian_ok;
    var h = '<div class="no-print" style="display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--line);padding-top:8px">';
    if (ct.minor) {
      h += ct.guardian_ok
        ? '<span class="pill ok" style="align-self:flex-start">' + esc(t('opsGuardianOk')) + (ct.guardian_at ? ', ' + esc(dayLong(ct.guardian_at)) : '') + '</span>'
        : '<div class="hint" style="color:var(--red);font-weight:700">' + esc(t('opsNeedGuardian')) + '</div>' +
          (iCan('people') ? '<button class="btn outline small" id="opsConsent">' + esc(t('opsConsentBtn')) + '</button>' : '');
    }
    if (ok && iCan('command_center')) {
      h += '<textarea id="opsTxt" maxlength="320" placeholder="' + esc(t('opsTextPh')) + '" style="min-height:56px"></textarea>' +
        '<button class="btn primary small" id="opsSend">' + esc(t('opsTextBtn')) + '</button>';
    }
    return h + '<div class="msg" id="opsMsg" hidden></div></div>';
  }
  async function renderRef(name) {
    $('refBack').href = REF.from || '#day';
    $('refBody').innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>';
    busy(true);
    var staff = iCan('command_center') || iCan('scheduling') || iCan('people');
    var rr = await Promise.all([
      sb.rpc('ref_card', { p_name: name }),
      sb.from('observations').select('date,observer,rater_role,final_note,cleaned_note,field,cleanup_status,area').eq('ref_name', name).in('cleanup_status', ['approved', 'edited']).order('date', { ascending: false }).limit(20),
      staff ? sb.rpc('ref_contact', { p_name: name }) : Promise.resolve({ data: null })
    ]);
    var card = rr[0], notes = rr[1], ct = rr[2].data;
    var prog = null; try { if (card.data && card.data.person_id) { var pr = await sb.rpc('eval_progress', { p_person: card.data.person_id }); prog = pr.data; } } catch (e) {}
    var co90 = null; try { if (card.data && card.data.person_id) { var cr = await sb.rpc('co90_card', { p_person: card.data.person_id }); co90 = cr.data; } } catch (e) {}
    busy(false);
    var c = card.data;
    var contact = !ct ? '' : '<div class="card" style="gap:6px;border-color:var(--gold)"><b>' + esc(t('contactTitle')) + (ct.minor ? ' <span class="pill">' + esc(t('contactMinor')) + '</span>' : '') + '</b>' +
      (ct.phone ? '<div class="actions" style="padding:0"><a class="btn primary" href="sms:' + esc(String(ct.phone).replace(/[^\d+]/g, '')) + '?&body=' + encodeURIComponent(t('smsBody').replace('{venue}', REF.venue || '').replace('{who}', S.me.first_name)) + '">' + esc(t('contactText')) + '</a><a class="btn outline" href="tel:' + esc(String(ct.phone).replace(/[^\d+]/g, '')) + '">' + esc(t('contactCall')) + '</a></div><div class="hint">' + esc(ct.phone) + '</div>' : '<div class="hint">' + esc(t('contactNoPhone')) + '</div>') +
      (ct.email ? '<div class="hint"><a href="mailto:' + esc(ct.email) + '">' + esc(ct.email) + '</a></div>' : '') +
      (ct.guardian_email ? '<div class="hint">' + esc(t('contactGuardian')) + ' <a href="mailto:' + esc(ct.guardian_email) + '">' + esc(ct.guardian_email) + '</a></div>' : '') +
      (ct.minor ? '<div class="hint" style="color:var(--red);font-weight:700">' + esc(t('contactMinorRule')) + '</div>' : '') + opsTextHtml(ct) + '</div>';
    if (!c) { $('refBody').innerHTML = '<div class="pad" style="padding-top:16px"><div class="disp" style="font-size:40px">' + esc(name) + '</div></div><div class="card"><div class="hint">' + esc(t('refNoRecord')) + '</div></div>'; return; }
    var titles = (c.titles || []).map(function (x) { return '<span class="pill' + (x.source === 'manual' ? ' ok' : '') + '" style="margin:4px 4px 0 0">' + esc(x.label) + '</span>'; }).join('');
    var stat = function (n, l, cls) { return '<div class="stat' + (cls ? ' ' + cls : '') + '"><b>' + (n == null ? '0' : esc(n)) + '</b><i>' + esc(l) + '</i></div>'; };
    $('refBody').innerHTML =
      '<div class="pad" style="padding-top:16px"><div class="lead">' + esc(t('refCardTitle')) + (c.city ? ', ' + esc(c.city) : '') + (c.green_badge ? ', ' + esc(t('greenBadge')) : '') + '</div><div class="disp" style="font-size:40px">' + esc(name) + '</div><div>' + fitBadgeHtml(c.fitness) + (titles || '<span class="hint">' + esc(t('noneYet')) + '</span>') + '</div></div>' +
      contact + co90RefHtml(co90, c.person_id) + progressHtml(prog, c.person_id) +
      '<div class="disp h2">' + esc(t('refSeason')) + '</div>' +
      '<div class="stats">' + stat(c.games, t('refGames')) + stat(c.as_center, t('refCenter')) + stat(c.evaluations, t('refEvals')) + '</div>' +
      '<div class="stats">' + stat(c.notes, t('refSeen'), c.notes ? 'green' : 'red') + stat(c.released, t('refReleased')) + stat(c.coaches, t('refCoaches')) + '</div>' +
      '<div class="pad hint" style="padding-top:8px">' + (c.first_game ? esc(t('refFirst')) + ' ' + esc(dayLong(c.first_game)) + ', ' : '') + (c.last_game ? esc(t('refLast')) + ' ' + esc(dayLong(c.last_game)) : '') + (c.last_seen ? '. ' + esc(t('refLastSeen')) + ' ' + esc(dayLong(c.last_seen)) : '') + '</div>' +
      (c.next_game ? '<div class="card" style="border-color:var(--gold);gap:4px"><b>' + esc(t('refNext')) + '</b><div>' + esc(dayLong(c.next_game)) + ', ' + esc(clock(c.next_kickoff)) + ', ' + esc(c.next_venue || '') + (c.next_field ? ', ' + esc(c.next_field) : '') + '</div><div class="hint">' + esc(t('refNextHint')) + '</div></div>' : '') +
      '<div class="disp h2">' + esc(t('upTitle')) + '</div><div id="refUpcoming"><div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div></div>' +
      '<div class="disp h2">' + esc(t('refNotes')) + '</div>' + ((notes.data || []).length ? (notes.data || []).map(function (n) {
        return '<div class="note"><div class="who">' + esc(n.observer || '') + (n.rater_role ? ', ' + esc(n.rater_role) : '') + ', ' + esc(dayLong(n.date)) + (n.field ? ', ' + esc(n.field) : '') + (n.area ? ', ' + esc(t('areas.' + n.area)) : '') + '</div><div class="text">' + esc(n.final_note || n.cleaned_note || '') + '</div></div>';
      }).join('') : '<div class="card"><div class="hint">' + esc(t('refNoNotes')) + '</div></div>');
    var osb = $('opsSend'); if (osb) osb.onclick = async function () {
      var ta = $('opsTxt'), v = (ta.value || '').trim();
      if (v.length < 2) { say('opsMsg', t('opsTextEmpty'), 'bad'); return; }
      if (!c.person_id) { say('opsMsg', t('opsTextFail'), 'bad'); return; }
      osb.disabled = true;
      var r = await sb.rpc('ops_text', { p_person: c.person_id, p_body: v });
      osb.disabled = false;
      var d = r.data || {};
      if (r.error || !d.ok) { say('opsMsg', d.err === 'minor' ? t('opsNeedGuardian') : d.err === 'hours' ? t('opsMinorHours') : d.err === 'no_phone' ? t('contactNoPhone') : (r.error && r.error.message) || t('opsTextFail'), 'bad'); return; }
      ta.value = ''; say('opsMsg', t('opsTextSent'), 'ok');
    };
    var ocb = $('opsConsent'); if (ocb) ocb.onclick = async function () {
      var note = window.prompt(t('opsConsentPrompt')); if (note == null) return;
      if (!note.trim() || !c.person_id) return;
      ocb.disabled = true;
      var r = await sb.rpc('ops_consent', { p_person: c.person_id, p_note: note.trim() });
      if (r.error || r.data !== true) { ocb.disabled = false; say('opsMsg', (r.error && r.error.message) || t('opsTextFail'), 'bad'); return; }
      renderRef(name);
    };
    wireSeasonCard(name, c.person_id);
    Promise.all([upcomingFor(name, 90), loadCoachNames()]).then(function (x) { var list = x[0]; var el = $('refUpcoming'); if (el) el.innerHTML = upcomingHtml(list, name); }).catch(function (e) { var el = $('refUpcoming'); if (el) el.innerHTML = '<div class="msg bad">' + esc(e.message || '') + '</div>'; });
  }
  var REF = { from: '' };

  // ── A coach's card: who they are, what they wrote ────────────────
  async function renderCoachCard(name) {
    $('refBack').href = REF.from || '#center';
    $('refBody').innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>';
    busy(true);
    var card = await sb.rpc('ref_card', { p_name: name });
    var notes = await fetchAll(function () { return sb.from('observations').select('id,date,ref_name,public_notes,cleaned_note,final_note,cleanup_status,field,area,reviewed_by').eq('observer', name).order('date', { ascending: false }); });
    var ids = (notes.data || []).map(function (n) { return n.id; }), reads = {};
    for (var i = 0; i < ids.length; i += 200) { var rd = await sb.from('note_reads').select('observation_id').in('observation_id', ids.slice(i, i + 200)); (rd.data || []).forEach(function (r) { reads[String(r.observation_id)] = 1; }); }
    busy(false);
    var c = card.data || {}, list = notes.data || [];
    var released = list.filter(function (n) { return n.cleanup_status === 'approved' || n.cleanup_status === 'edited'; }).length;
    var read = list.filter(function (n) { return reads[String(n.id)]; }).length;
    var refs = {}; list.forEach(function (n) { refs[key(n.ref_name)] = 1; });
    var titles = (c.titles || []).map(function (x) { return '<span class="pill' + (x.source === 'manual' ? ' ok' : '') + '" style="margin:4px 4px 0 0">' + esc(x.label) + '</span>'; }).join('');
    var stat = function (n, l, cls) { return '<div class="stat' + (cls ? ' ' + cls : '') + '"><b>' + esc(n) + '</b><i>' + esc(l) + '</i></div>'; };
    $('refBody').innerHTML =
      '<div class="pad" style="padding-top:16px"><div class="lead">' + esc(t('coachCardTitle')) + (c.city ? ', ' + esc(c.city) : '') + '</div><div class="disp" style="font-size:40px">' + esc(name) + '</div><div>' + (titles || '') + '</div></div>' +
      '<div class="disp h2">' + esc(t('refSeason')) + '</div>' +
      '<div class="stats">' + stat(list.length, t('coachNotes')) + stat(Object.keys(refs).length, t('coachRefs')) + stat(released, t('coachReleased')) + '</div>' +
      '<div class="pad" style="padding-top:8px"><div class="hint">' + esc(t('coachReadRate')) + ': ' + read + ' / ' + released + '</div><div class="bar"><i style="width:' + (released ? Math.round(100 * read / released) : 0) + '%"></i></div></div>' +
      '<div class="disp h2">' + esc(t('coachNotesTitle')) + '</div>' + (list.length ? list.slice(0, 60).map(function (n) {
        var st = n.cleanup_status || 'pending', ok = st === 'approved' || st === 'edited';
        var label = t('status.' + st); if (label === 'status.' + st) label = t('status.pending'); if (ok && reads[String(n.id)]) label = t('readBy').replace(/ on$| el$/, '');
        return '<div class="card" style="gap:8px"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><div><b>' + refLink(n.ref_name || '') + '</b> <span class="hint">' + esc(dayLong(n.date)) + (n.field ? ', ' + esc(n.field) : '') + (n.area ? ', ' + esc(t('areas.' + n.area)) : '') + '</span></div><span class="pill' + (ok ? ' ok' : '') + '">' + esc(label) + '</span></div>' +
          '<div class="side three"><div class="col"><b>' + esc(t('rawLabel')) + '</b>' + esc(n.public_notes || '') + '</div><div class="col"><b>' + esc(t('aiLabel')) + '</b>' + (n.cleaned_note ? esc(n.cleaned_note) : '<span class="hint">' + esc(t('notCleaned')) + '</span>') + '</div><div class="col"><b>' + esc(t('releasedLabel')) + '</b>' + (ok ? esc(n.final_note || n.cleaned_note || n.public_notes || '') : '<span class="hint">' + esc(t('notReleased')) + '</span>') + '</div></div></div>';
      }).join('') : '<div class="card"><div class="hint">' + esc(t('noMyNotes')) + '</div></div>');
  }

  // ── Staff roster ─────────────────────────────────────────────────
  var STAFF = { rows: null, filter: '' };
  // ── Not yet registered: the renewal campaign list ─────────────────
  var REG = { rows: null, season: null, filter: 'all', batch: 0, lapsed: false };
  function regSeason() { var d = new Date(); return d.getMonth() >= 8 ? d.getFullYear() + 1 : d.getFullYear(); }
  function regFiltered() {
    var f = REG.filter;
    return (REG.rows || []).filter(function (p) { return f === 'all' || (f === 'first' && p.first_year) || (f === '20_24' && p.age_band === '20_24') || (f === 'u18' && p.age_band === 'u18') || (f === 'upgrade' && p.level !== 'grassroots'); });
  }
  async function renderUnregistered() {
    REG.season = regSeason() - (REG.lapsed ? 1 : 0);
    if (!REG.rows) { busy(true); var r = await sb.rpc('unregistered', { p_season: REG.season }); busy(false); REG.rows = r.data || []; REG.batch = 0; }
    var rows = regFiltered(), emails = rows.map(function (p) { return p.email; }).filter(Boolean), BATCH = 200, nb = Math.max(1, Math.ceil(emails.length / BATCH));
    if (REG.batch >= nb) REG.batch = 0;
    var chip = function (k, label, n) { return '<button class="chip-btn small' + (REG.filter === k ? ' on' : '') + '" data-reg-f="' + k + '">' + esc(label) + ' ' + n + '</button>'; };
    var all = REG.rows, cnt = function (fn) { return all.filter(fn).length; };
    $('personCard').innerHTML = '';
    $('peopleResults').innerHTML = '<div class="pad" style="padding-top:12px"><div class="chips"><button class="chip-btn small' + (!REG.lapsed ? ' on' : '') + '" data-reg-mode="next">' + esc(t('regModeNext').replace('{y}', regSeason())) + '</button><button class="chip-btn small' + (REG.lapsed ? ' on' : '') + '" data-reg-mode="lapsed">' + esc(t('regModeLapsed').replace('{y}', regSeason() - 1)) + '</button></div>' +
      '<div class="disp" style="font-size:30px;margin-top:10px">' + esc((REG.lapsed ? t('regLapsedTitle') : t('regListTitle')).replace('{y}', REG.season)) + '</div><div class="disp" style="font-size:44px;color:var(--red)">' + fmtN(all.length) + '</div><div class="hint">' + esc((REG.lapsed ? t('regLapsedLead') : t('regListLead')).replace('{prev}', REG.season - 1).replace('{y}', REG.season)) + '</div>' +
      '<div class="chips" style="margin-top:8px">' + chip('all', t('regAll'), all.length) + chip('first', t('regFirstYear'), cnt(function (p) { return p.first_year; })) + chip('u18', t('regU18'), cnt(function (p) { return p.age_band === 'u18'; })) + chip('20_24', t('reg2024'), cnt(function (p) { return p.age_band === '20_24'; })) + chip('upgrade', t('regUpgrade'), cnt(function (p) { return p.level !== 'grassroots'; })) + '</div></div>' +
      '<div class="card" style="gap:8px"><b>' + esc(t('regEmailTitle').replace('{n}', fmtN(emails.length))) + '</b><div class="hint">' + esc(t('regEmailHint')) + '</div>' +
      '<div class="actions" style="padding:0;flex-wrap:wrap"><button class="btn primary small" id="regCopy">' + esc(nb > 1 ? t('regCopyBatch').replace('{i}', REG.batch + 1).replace('{n}', nb) : t('regCopy')) + '</button>' + (nb > 1 ? '<button class="btn outline small" id="regNext">' + esc(t('regNextBatch')) + '</button>' : '') + '<button class="btn outline small" id="regCsv">' + esc(t('regCsv')) + '</button></div><div class="msg" id="regMsg" hidden></div></div>' +
      (rows.length ? '<div class="list">' + rows.slice(0, 200).map(function (p) { return '<a class="item" href="#" data-person="' + p.id + '"><div><b>' + esc(p.first_name + ' ' + p.last_name) + '</b><br><span class="hint">' + esc([p.city, p.first_year ? t('regFirstYear') : (p.seasons + ' ' + t('regSeasons')), p.level !== 'grassroots' ? t('fitStd.' + p.level) : ''].filter(Boolean).join(', ')) + '</span></div><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>'; }).join('') + (rows.length > 200 ? '<div class="pad hint">' + esc(t('showingFirst').replace('{n}', 200)) + '</div>' : '') + '</div>' : '<div class="card"><div class="hint">' + esc(t('regNobody')) + '</div></div>');
    $('peopleResults').querySelectorAll('[data-reg-mode]').forEach(function (b) { b.onclick = function () { REG.lapsed = b.getAttribute('data-reg-mode') === 'lapsed'; REG.rows = null; REG.batch = 0; renderUnregistered(); }; });
    $('peopleResults').querySelectorAll('[data-reg-f]').forEach(function (b) { b.onclick = function () { REG.filter = b.getAttribute('data-reg-f'); REG.batch = 0; renderUnregistered(); }; });
    $('regCopy').onclick = async function () { var slice = emails.slice(REG.batch * BATCH, (REG.batch + 1) * BATCH).join(', '); try { await navigator.clipboard.writeText(slice); say('regMsg', t('regCopied').replace('{n}', slice ? slice.split(', ').length : 0), 'good'); } catch (e) { window.prompt(t('regCopyManual'), slice); } };
    var nx = $('regNext'); if (nx) nx.onclick = function () { REG.batch = (REG.batch + 1) % nb; renderUnregistered(); };
    $('regCsv').onclick = function () {
      var head = ['first_name', 'last_name', 'email', 'phone', 'city', 'age_band', 'first_year', 'seasons', 'level'];
      var csv = head.join(',') + '\n' + rows.map(function (p) { return head.map(function (k) { var v = p[k] == null ? '' : String(p[k]); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\n');
      var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = (REG.lapsed ? 'lapsed-' : 'not-registered-') + REG.season + '-' + REG.filter + '.csv'; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    };
    $('peopleResults').querySelectorAll('[data-person]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); openPerson(a.getAttribute('data-person')); }; });
  }
  async function renderStaff() {
    if (!STAFF.rows) { busy(true); var r = await sb.rpc('staff_roster'); busy(false); STAFF.rows = r.data || []; }
    var all = {}; STAFF.rows.forEach(function (p) { (p.titles || []).forEach(function (x) { all[x.label] = (all[x.label] || 0) + 1; }); });
    var labels = Object.keys(all).sort(function (a, b) { return all[b] - all[a]; });
    var rows = STAFF.rows.filter(function (p) { return !STAFF.filter || (p.titles || []).some(function (x) { return x.label === STAFF.filter; }); });
    $('personCard').innerHTML = '';
    $('peopleResults').innerHTML = '<div class="pad" style="padding-top:12px"><div class="disp" style="font-size:30px">' + esc(t('staffTitle')) + ' ' + rows.length + '</div><div class="hint">' + esc(t('staffLead')) + '</div><div style="margin-top:10px"><select id="staffSel" style="font:inherit;width:100%;padding:12px;border:2px solid var(--navy);border-radius:8px;background:var(--surface);color:var(--ink)"><option value="">' + esc(t('staffAllTitles')) + ' (' + STAFF.rows.length + ')</option>' + labels.map(function (l) { return '<option value="' + esc(l) + '"' + (STAFF.filter === l ? ' selected' : '') + '>' + esc(l) + ' (' + all[l] + ')</option>'; }).join('') + '</select></div></div>' +
      '<div class="pad">' + rows.map(function (p) {
        return '<div class="rowline" style="align-items:flex-start"><div><a class="refname" href="#" data-open-person="' + p.id + '"><b>' + esc(p.first_name + ' ' + p.last_name) + '</b></a>' + (p.city ? ' <span class="hint">' + esc(p.city) + '</span>' : '') + '<br>' + (p.titles || []).map(function (x) { return '<span class="pill' + (x.source === 'manual' ? ' ok' : '') + '" style="margin:4px 4px 0 0">' + esc(x.label) + '</span>'; }).join('') + '</div></div>';
      }).join('') + '</div>';
    var ss = $('staffSel'); if (ss) ss.onchange = function () { STAFF.filter = ss.value; renderStaff(); };
    $('peopleResults').querySelectorAll('[data-open-person]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); var id = a.getAttribute('data-open-person'); var p = STAFF.rows.filter(function (x) { return String(x.id) === id; })[0]; if (p) { PP.results = [p]; openPerson(id); } }; });
  }

  // ── Names to link ────────────────────────────────────────────────
  var LINK = { rows: null, pick: null, suggest: [] };
  async function renderLinks() {
    if (!LINK.rows) { busy(true); var r = await sb.rpc('unlinked_names'); busy(false); LINK.rows = r.data || []; }
    $('personCard').innerHTML = '';
    var rows = LINK.rows.slice(0, 60);
    $('peopleResults').innerHTML = '<div class="pad" style="padding-top:12px"><div class="disp" style="font-size:30px">' + esc(t('linkTitle')) + ' ' + LINK.rows.length + '</div><div class="hint">' + esc(t('linkLead')) + '</div></div>' +
      (rows.length ? '<div class="pad">' + rows.map(function (n) {
        var open = LINK.pick && LINK.pick.name_key === n.name_key;
        return '<div class="rowline" style="flex-direction:column;align-items:stretch;gap:6px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><a class="refname" href="#" data-link="' + esc(n.name_key) + '"><b>' + esc(n.name) + '</b></a><span class="hint">' + n.games + ' ' + esc(t('linkGames')) + ', ' + esc(n.last_game ? dayLong(n.last_game) : '') + '</span></div><div class="hint">' + esc(n.venues || '') + '</div>' +
          (open ? '<div class="hint" style="font-weight:700">' + esc(t('linkPick')) + '</div><div class="chips">' + (LINK.suggest.length ? LINK.suggest.map(function (p) { return '<button class="chip-btn" data-linkto="' + p.id + '">' + esc(p.first_name + ' ' + p.last_name) + (p.city ? ' <small>' + esc(p.city) + '</small>' : '') + '</button>'; }).join('') : '<span class="hint">' + esc(t('linkNoSuggest')) + '</span>') + '</div><div class="hint">' + esc(t('linkOther')) + '</div><div class="msg" id="linkMsg" hidden></div>' : '') + '</div>';
      }).join('') + '</div>' : '<div class="card"><div class="hint">' + esc(t('linkNone')) + '</div></div>');
    $('peopleResults').querySelectorAll('[data-link]').forEach(function (a) { a.onclick = async function (e) { e.preventDefault(); var k = a.getAttribute('data-link'); var n = LINK.rows.filter(function (x) { return x.name_key === k; })[0]; LINK.pick = n; busy(true); var s = await sb.rpc('suggest_people', { p_name: n.name }); busy(false); LINK.suggest = s.data || []; renderLinks(); }; });
    $('peopleResults').querySelectorAll('[data-linkto]').forEach(function (b) { b.onclick = function () { linkTo(parseInt(b.getAttribute('data-linkto'), 10), b); }; });
  }
  async function linkTo(personId, b) {
    if (!LINK.pick) return;
    if (b) b.disabled = true;
    var r = await sb.rpc('link_name', { p_name: LINK.pick.name, p_person: personId });
    if (r.error) { var m = $('linkMsg'); if (m) { m.hidden = false; m.className = 'msg bad'; m.textContent = r.error.message; } if (b) b.disabled = false; return; }
    LINK.rows = LINK.rows.filter(function (x) { return x.name_key !== LINK.pick.name_key; });
    LINK.pick = null; LINK.suggest = [];
    renderLinks();
  }

  // ── Game card ────────────────────────────────────────────────────
  // A game on a later day is not in today's list, so it is fetched on its
  // own. This is how a referee opens Saturday's game on Tuesday to ask for
  // an evaluation, and how View as reaches any game on the upcoming list.
  var OTHER = {};
  function renderGame(id) {
    var g = S.games.filter(function (x) { return String(x.game_id) === String(id); })[0] || OTHER[String(id)];
    S.game = g || null;
    if (!g) {
      $('gameBody').innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>';
      busy(true);
      sb.from('games').select('game_id,date,game_num,kickoff,field,age_group,gender,competition,home,away,cr,ar1,ar2,fourth,venue,status,home_club,away_club,score_url').eq('game_id', id).limit(1).then(function (r) {
        busy(false);
        var x = (r.data || [])[0];
        if (!x) { $('gameBody').innerHTML = '<div class="card"><div class="hint">' + esc(t('gameNotFound')) + '</div></div>'; return; }
        OTHER[String(id)] = x; renderGame(id);
      }, function () { busy(false); $('gameBody').innerHTML = '<div class="msg bad">' + esc(t('loadFailed')) + '</div>'; });
      return;
    }
    var inAt = S.checkins[String(g.game_id)], mins = Math.round((new Date(g.kickoff).getTime() - Date.now()) / 60000);
    var ev = eventFor(g), r = rulesFor(g), role = myRole(g);
    if (isHQ(g)) {
      $('gameBody').innerHTML = '<div class="pad" style="padding-top:16px"><div class="lead">' + esc(ev ? ev.name : '') + ', ' + esc(dayLong(g.date)) + '</div><div class="disp" style="font-size:48px">' + esc(t('refereeHQ')) + '</div><div class="lead">' + esc(g.venue || '') + ', ' + esc(clock(g.kickoff)) + '</div></div>' +
        '<div style="margin:14px 20px 0">' + (inAt ? '<div class="btn done"><span class="disp">' + esc(t('checkedIn')) + '</span><small>' + esc(clock(inAt)) + '</small></div>' : '<div class="actions" style="padding:0">' + checkinBtn(g, null) + '</div><div class="msg bad" id="ci-msg-' + esc(g.game_id) + '" hidden></div>') + '</div>' +
        (ev && ev.blurb ? '<div class="card"><div class="sep" style="border:0;padding:0">' + esc(ev.blurb) + '</div></div>' : '') +
        '<div style="margin:14px 20px 0"><a class="btn outline" href="#ops">' + esc(t('opsEntry')) + '</a></div>';
      wireCheckin(g, $('gameBody'));
      return;
    }
    // A coach block is not a match: no teams, no score, role is Referee Coach.
    if (isCoachSlot(g)) {
      $('gameBody').innerHTML = '<div class="pad" style="padding-top:16px"><div class="lead">' + esc(ev ? ev.name : g.competition || '') + ', ' + esc(dayLong(g.date)) + '</div><div class="disp" style="font-size:44px">' + esc(t('coachSlot')) + '</div><div class="lead">' + esc(g.venue || '') + (g.field ? ', ' + esc(fieldShort(g.field)) : '') + ', ' + esc(clock(g.kickoff)) + '</div></div>' +
        '<div style="margin:14px 20px 0">' + (inAt ? '<div class="btn done"><span class="disp">' + esc(t('checkedIn')) + '</span><small>' + esc(clock(inAt)) + '</small></div>' : '<div class="actions" style="padding:0">' + checkinBtn(g, null) + '</div><div class="msg bad" id="ci-msg-' + esc(g.game_id) + '" hidden></div>') + '</div>' +
        '<div style="margin:14px 20px 0"><a class="btn outline" href="#coach" style="width:100%">' + esc(t('coachingEntry')) + '</a></div>';
      wireCheckin(g, $('gameBody'));
      return;
    }
    var crew = ['cr', 'ar1', 'ar2', 'fourth'].filter(function (k) { return g[k]; }).map(function (k) { return esc(g[k]) + ' (' + esc(t('role.' + k)) + ')'; });
    $('gameBody').innerHTML =
      '<div class="pad" style="padding-top:16px"><div class="lead">' + esc(ev ? ev.name : g.competition || '') + (g.game_num ? ', ' + esc(g.game_num) : '') + ', ' + esc(dayLong(g.date)) + '</div>' +
      '<div class="row" style="display:flex;justify-content:space-between;align-items:baseline"><div class="disp" style="font-size:64px;line-height:.95">' + esc(clock(g.kickoff)) + '</div><div class="disp" style="font-size:64px;line-height:.95;color:var(--count)">' + esc(fieldShort(g.field)) + '</div></div>' +
      (mins > 0 ? '<div class="lead">' + esc(t('kicksIn')) + ' ' + (mins < 120 ? mins + ' min' : mins < 48 * 60 ? Math.round(mins / 60) + ' ' + esc(t('hoursWord')) : Math.round(mins / 1440) + ' ' + esc(t('daysWord'))) + '</div>' : '') + '</div>' +
      '<div style="margin:14px 20px 0" id="gameCheckin">' + (inAt ? '<div class="btn done"><span class="disp">' + esc(t('checkedIn')) + '</span><small>' + esc(clock(inAt)) + '. ' + esc(t('checkedInAt')) + '</small></div>' : '<div class="actions" style="padding:0">' + checkinBtn(g, null) + '</div><div class="msg bad" id="ci-msg-' + esc(g.game_id) + '" hidden></div>') + '</div>' +
      '<div class="card"><div class="grid2"><div class="kv"><div class="k">' + esc(t('home')) + '</div><div class="v">' + esc(g.home || '') + '</div></div><div class="kv"><div class="k">' + esc(t('away')) + '</div><div class="v">' + esc(g.away || '') + '</div></div></div>' +
      '<div>' + esc(g.age_group || '') + (g.gender ? ', ' + esc(g.gender) : '') + (g.competition ? ', ' + esc(g.competition) : '') + '</div>' +
      '<div class="sep"><span class="hint">' + esc(t('crew')) + ':</span> ' + (crew.length > 1 ? crew.join(', ') : esc(myNameOn(g)) + ', ' + esc(t('role.' + role)) + (role === 'cr' ? '. ' + esc(t('alone')) : '')) + '</div>' +
      (ev && ev.blurb ? '<div class="sep">' + esc(ev.blurb) + '</div>' : '') + '</div>' +
      '<div style="margin:14px 20px 0;display:grid;grid-template-columns:1fr 1fr;gap:10px">' + (r ? '<a class="btn outline" href="' + esc(r) + '">' + esc(t('rules')) + '</a>' : '<div class="hint" style="align-self:center">' + esc(t('rulesNotPosted')) + '</div>') + '<a class="btn outline" href="#map/' + encodeURIComponent(g.venue || '') + '/' + encodeURIComponent(g.field || '') + '">' + esc(t('map')) + '</a></div>' +
      evalRequestHtml(g) +
      '<div class="disp h2">' + esc(t('afterGame')) + '</div>' +
      (g.score_url ? '<a class="rowbtn" href="' + esc(g.score_url) + '" target="_blank" rel="noopener"><span><span class="t">' + esc(t('gsaOpen')) + '</span><br><span class="s">' + esc(t('gsaHint')) + '</span></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>' : '') +
      scoreHtml(g) +
      '<a class="rowbtn" href="incident.html?gameId=' + esc(g.game_id) + '&date=' + esc(g.date) + '&event=' + esc(ev ? ev.id : '') + '&by=' + encodeURIComponent(myNameOn(g)) + '"><span><span class="t">' + esc(t('incident')) + '</span><br><span class="s">' + esc(t('incidentHint')) + '</span></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>' +
      '<div class="hint" style="margin:8px 24px 0">' + esc(t('incidentNote')) + '</div>';
    wireCheckin(g, $('gameBody'));
    wireScore(g);
    wireEvalRequest(g);
  }
  // ── Formal evaluation: the referee asks, the SDRD assigns a coach ──
  var ER = { mine: [], purpose: null };
  // One small pill. Tapping it asks what the evaluation is for (the SDRD
  // needs that to pick the coach), and that tap sends the request.
  function evalRequestHtml(g) {
    if (new Date(g.kickoff).getTime() < Date.now()) return '';
    var keys = S.me.nameKeys || [];
    if (!['cr', 'ar1', 'ar2', 'fourth'].some(function (k) { return keys.indexOf(key(g[k])) >= 0; })) return '';
    var req = (ER.mine || []).filter(function (r) { return String(r.game_id) === String(g.game_id); })[0];
    if (req) return '<div class="pad" style="padding-top:10px"><span class="pill ok">' + esc(t('evalReqShort')) + ': ' + esc(t('evalPurpose.' + req.purpose)) + ', ' + esc(t('evalStatus.' + req.status)) + '</span></div>';
    if (!ER.open) return '<div class="pad" style="padding-top:10px"><button class="chip-btn small" id="evalReqOpen">' + esc(t('evalReqShort')) + '</button></div>';
    return '<div class="pad" style="padding-top:10px"><div class="hint" style="padding-bottom:6px">' + esc(t('evalReqWhy')) + '</div><div class="chips">' + ['maintenance', 'upgrade_regional', 'upgrade_national'].map(function (p) { return '<button class="chip-btn small" data-purpose="' + p + '">' + esc(t('evalPurpose.' + p) + (FEES.eval[p] ? ' · ' + money(FEES.eval[p]) : '')) + '</button>'; }).join('') + '<button class="chip-btn small" id="evalReqCancel">' + esc(t('neverMind')) + '</button></div><div class="msg" id="evalReqMsg" hidden></div></div>';
  }
  function wireEvalRequest(g) {
    var o = $('evalReqOpen'); if (o) o.onclick = function () { ER.open = true; renderGame(g.game_id); };
    var c = $('evalReqCancel'); if (c) c.onclick = function () { ER.open = false; renderGame(g.game_id); };
    $('gameBody').querySelectorAll('[data-purpose]').forEach(function (b) { b.onclick = async function () {
      b.disabled = true; var pp = b.getAttribute('data-purpose'); b.textContent = t('sending');
      if (FEES.eval[pp]) { var paid = await payStart({ kind: 'evaluation', purpose: pp, game_id: g.game_id, ref_name: myNameOn(g) }, 'evalReqMsg'); if (!paid) { b.disabled = false; b.textContent = t('evalPurpose.' + pp); } return; }
      var r = await sb.from('eval_requests').insert({ org_id: S.me.org_id, ref_person_id: S.me.person_id, ref_name: myNameOn(g), purpose: pp, game_id: g.game_id, game_date: g.date, venue: g.venue });
      if (r.error) { b.disabled = false; b.textContent = t('evalPurpose.' + pp); say('evalReqMsg', r.error.message, 'bad'); return; }
      ER.open = false; await loadEvalRequests(); renderGame(g.game_id);
    }; });
  }
  async function loadEvalRequests() {
    await loadFees_();
    var r = await sb.from('eval_requests').select('id,game_id,game_date,venue,purpose,status,coach_person_id,ref_name,ref_person_id,note,created_at').order('game_date');
    ER.mine = r.data || [];
  }

  // ── Notes ────────────────────────────────────────────────────────
  function markRead(notes) {
    var ids = (notes || []).map(function (n) { return n.id; }).filter(Boolean);
    if (!ids.length) return;
    sb.rpc('mark_read', { ids: ids }).then(function () {}, function () {});
  }
  function scoreHtml(g) {
    var sc = (S.scores || {})[String(g.game_id)], started = new Date(g.kickoff).getTime() < Date.now();
    if (sc && sc.home_score != null) {
      return '<div class="card" style="gap:6px;border-color:var(--green)"><div class="hint" style="font-weight:700">' + esc(t('scoreSent')) + '</div><div style="display:flex;justify-content:space-between;align-items:baseline"><div><b>' + esc(g.home || t('home')) + '</b></div><div class="disp" style="font-size:40px">' + esc(sc.home_score) + ' <span style="color:var(--muted)">:</span> ' + esc(sc.away_score) + '</div><div style="text-align:right"><b>' + esc(g.away || t('away')) + '</b></div></div><div class="hint">' + esc(sc.status || '') + (sc.entered_by ? ', ' + esc(sc.entered_by) : '') + '. ' + esc(t('scoreFix')) + '</div><button class="btn outline small" id="scoreEdit">' + esc(t('scoreChange')) + '</button></div>';
    }
    if (!started) return '<div class="card"><div class="hint">' + esc(t('scoreLater')) + '</div></div>';
    return scoreForm(g, null);
  }
  function scoreForm(g, sc) {
    var num = function (id, v) { return '<input id="' + id + '" type="number" inputmode="numeric" min="0" max="99" value="' + (v == null ? '' : esc(v)) + '" style="font:inherit;font-family:var(--disp);font-style:italic;font-weight:800;font-size:40px;width:100%;text-align:center;padding:6px;border:2px solid var(--navy);border-radius:10px;background:var(--surface);color:var(--ink)">'; };
    return '<div class="card" style="gap:10px"><div class="hint" style="font-weight:700">' + esc(t('reportScore')) + '</div>' +
      '<div class="grid2"><div><div class="hint" style="text-align:center">' + esc(g.home || t('home')) + '</div>' + num('scHome', sc && sc.home_score) + '</div><div><div class="hint" style="text-align:center">' + esc(g.away || t('away')) + '</div>' + num('scAway', sc && sc.away_score) + '</div></div>' +
      '<button class="btn primary" id="scoreSend">' + esc(t('scoreSend')) + '</button><div class="hint">' + esc(t('reportScoreHint')) + '</div><div class="msg" id="scMsg" hidden></div></div>';
  }
  function wireScore(g) {
    var ed = $('scoreEdit');
    if (ed) ed.onclick = function () { ed.closest('.card').outerHTML = scoreForm(g, (S.scores || {})[String(g.game_id)]); wireScore(g); };
    var b = $('scoreSend');
    if (!b) return;
    b.onclick = async function () {
      var h = $('scHome').value.trim(), a = $('scAway').value.trim();
      if (h === '' || a === '') { say('scMsg', t('scoreBoth'), 'bad'); return; }
      b.disabled = true; b.textContent = t('sending');
      try {
        var res = await sb.rpc('hub_post_score', { p_game: g.game_id, p_home: Number(h), p_away: Number(a) });
        if (res.error) throw new Error(res.error.message);
        var j = res.data || {};
        if (!j.ok) throw new Error(j.err === 'final' ? t('scoreFinalLocked') : j.err === 'crew_only' ? t('scoreCrewOnly') : t('scoreFailed'));
        S.scores[String(g.game_id)] = { game_id: g.game_id, home_score: Number(h), away_score: Number(a), status: 'Reported', entered_by: myNameOn(g) };
        renderGame(g.game_id);
      } catch (e) { b.disabled = false; b.textContent = t('scoreSend'); say('scMsg', (e.message || t('scoreFailed')), 'bad'); }
    };
  }
  function renderNotes() {
    markRead(S.notes);
    var cut = shiftDate(todayStr(), -30);
    var noteCard = function (n) { return '<div class="note"><div class="who">' + esc(n.observer || '') + (n.rater_role ? ', ' + esc(n.rater_role) : '') + (n.date ? ', ' + esc(dayLong(n.date)) : '') + (n.field ? ', ' + esc(n.field) : '') + '</div><div class="text">' + esc(n.final_note || n.cleaned_note || '') + '</div></div>'; };
    var recent = S.notes.filter(function (n) { return !n.date || n.date >= cut; }), older = S.notes.filter(function (n) { return n.date && n.date < cut; });
    $('notesList').innerHTML = S.notes.length ? recent.map(noteCard).join('') + (older.length ? fold('notes-older', t('olderNotes'), older.length, older.map(noteCard).join(''), !recent.length) : '') : '<div class="note"><div class="text hint">' + esc(t('noNotes')) + '</div></div>';
  }

  // ── Help ─────────────────────────────────────────────────────────
  var REASONS = [
    { id: 'roster', urgent: false, backend: 'Roster or game card problem' },
    { id: 'spectator', urgent: true, backend: 'Coach or spectator problem' },
    { id: 'redcard', urgent: false, backend: 'Red card or send-off' },
    { id: 'fight', urgent: true, backend: 'Fight or threat' },
    { id: 'injury', urgent: true, backend: 'Injury, trainer needed' }
  ];
  var IS_PHONE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  function reasonBtn(r) {
    var sel = S.reason === r.id;
    return '<button class="reason' + (r.urgent ? ' urgent' : '') + (sel ? ' selected' : '') + '" data-reason="' + r.id + '" aria-pressed="' + (sel ? 'true' : 'false') + '">' + esc(t('reasons.' + r.id)) +
      (sel ? '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="10" fill="currentColor"></circle><path d="M6.5 11.5l3 3 6-6.5" stroke="var(--surface)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></path></svg>' : '') + '</button>';
  }
  function renderHelp() {
    var body = (S.me ? S.me.first_name + ' ' + S.me.last_name : '') + (S.game ? ', ' + S.game.venue + ' ' + S.game.field : '') + ': ';
    var sms = 'sms:' + C.hotline + '?&body=' + encodeURIComponent(body);
    var urgent = REASONS.filter(function (r) { return r.urgent; }), queue = REASONS.filter(function (r) { return !r.urgent; });
    $('reasons').innerHTML =
      '<div class="grouplbl urgent">' + esc(t('groupUrgent')) + '</div>' + urgent.map(reasonBtn).join('') +
      '<div class="grouplbl">' + esc(t('groupQueue')) + '</div>' + queue.map(reasonBtn).join('') +
      '<div class="grouplbl">' + esc(t('groupHotline')) + '</div>' +
      (IS_PHONE ? '<a class="reason" href="' + sms + '">' + esc(t('hotline')) + ' <small>' + esc(C.hotlineShown) + '</small></a>'
                : '<div class="reason" style="cursor:default">' + esc(t('hotlineDesktop')) + ' <small><b>' + esc(C.hotlineShown) + '</b></small></div>') +
      '<div class="hint" style="color:var(--ink);padding:0 4px">' + esc(t('hotlineNote')) + '</div>';
    $('reasons').querySelectorAll('[data-reason]').forEach(function (b) { b.onclick = function () { S.reason = b.getAttribute('data-reason'); renderHelp(); renderConfirm(); }; });
    if (!S.reason) $('helpConfirm').innerHTML = '';
  }
  function renderConfirm() {
    var r = REASONS.filter(function (x) { return x.id === S.reason; })[0];
    if (!r) return;
    var g = S.game || nextGame();
    var where = g ? (g.venue + ', ' + g.field + (g.game_num ? ', ' + g.game_num : '')) : '';
    $('helpConfirm').innerHTML = '<div class="confirm"><div class="k">' + esc(t('youPicked')) + '</div><div class="v">' + esc(t('reasons.' + r.id)) + '</div>' +
      '<div style="font-size:15px;line-height:1.4">' + esc(S.me.first_name + ' ' + S.me.last_name) + (where ? ', ' + esc(where) : '') + '. ' + esc(t(r.urgent ? 'goesTo' : 'goesToQueue')) + '</div>' +
      '<button class="send" id="sendHelp">' + esc(t('sendIt')) + '</button><button class="cancel" id="cancelHelp">' + esc(t('neverMind')) + '</button><div class="msg" id="helpMsg" hidden></div></div>';
    $('helpConfirm').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('cancelHelp').onclick = function () { S.reason = null; renderHelp(); $('helpConfirm').innerHTML = ''; };
    $('sendHelp').onclick = async function () {
      var b = $('sendHelp'); b.disabled = true; b.textContent = t('sendingHelp');
      var ev = g ? eventFor(g) : S.events[0];
      try {
        var res = await fetch(C.backend, { method: 'POST', body: JSON.stringify({ action: 'emergency', event: ev ? ev.id : '', refName: myNameOn(g || {}), venue: g ? g.venue : '', field: g ? g.field : '', gameId: g ? g.game_id : '', reason: r.backend, details: '' }) });
        var j = await res.json();
        if (!j || j.status !== 'ok') throw new Error(j && j.message || 'error');
        $('helpConfirm').innerHTML = '<div class="confirm" style="border-color:var(--green)"><div class="v">' + esc(t('helpSent')) + '</div><div class="hint" style="color:var(--ink)">' + esc(t('helpSentAt')) + ' ' + esc(clock(new Date().toISOString())) + '.</div></div>';
      } catch (e) {
        b.disabled = false; b.textContent = t('sendIt');
        var m = $('helpMsg'); m.hidden = false; m.className = 'msg bad'; m.innerHTML = esc(t('helpFailed')) + ' <a href="sms:' + C.hotline + '">' + esc(C.hotlineShown) + '</a>';
      }
    };
  }

  // ── Sign in ──────────────────────────────────────────────────────
  var email = '';
  function say(id, text, kind) { var el = $(id); el.hidden = false; el.textContent = text; el.className = 'msg ' + (kind || ''); }
  $('sendBtn').onclick = async function () {
    email = $('email').value.trim().toLowerCase();
    if (!email) return;
    $('sendBtn').disabled = true; say('msgEmail', t('sending'));
    var r = await sb.auth.signInWithOtp({ email: email });
    $('sendBtn').disabled = false;
    if (r.error) {
      var m = r.error.message || '';
      say('msgEmail', /No referee record|Database error/i.test(m) ? t('noRecord') : /rate limit|too many/i.test(m) ? t('tooMany') : t('couldNotSend') + m, 'bad');
      return;
    }
    $('stepEmail').hidden = true; $('stepCode').hidden = false; say('msgCode', t('codeSent'), 'good'); $('code').focus();
  };
  $('haveCode').onclick = function () { email = $('email').value.trim().toLowerCase(); if (!email) { say('msgEmail', t('emailFirst'), 'bad'); return; } $('stepEmail').hidden = true; $('stepCode').hidden = false; say('msgCode', t('codeFromHQ'), 'good'); $('code').focus(); };
  $('verifyBtn').onclick = async function () {
    var code = $('code').value.replace(/\D/g, '');
    if (code.length < 6) { say('msgCode', t('wholeCode'), 'bad'); return; }
    $('verifyBtn').disabled = true;
    var r = await sb.auth.verifyOtp({ email: email, token: code, type: 'email' });
    $('verifyBtn').disabled = false;
    if (r.error) { say('msgCode', t('badCode'), 'bad'); return; }
    await start();
  };

  // ── Live updates ─────────────────────────────────────────────────
  // One subscription while signed in. A change to anything the person can
  // see refreshes the screen they are on, a few hundred milliseconds later
  // so a burst of writes becomes one redraw. The 60-second timer stays as
  // the fallback for a phone that lost its connection.
  var LIVE = { channel: null, timer: null };
  // Live updates cost battery: a socket held open and a reload on every
  // change. So they run only for people running a venue, only while the
  // Command Center board is on screen, only for today's rows, and never
  // while the phone is in a pocket. A referee's screen is still right: a
  // check-in is their own tap, and anything else refreshes when they come
  // back to the app.
  function liveWanted() {
    return !!(S.me && (iCan('command_center') || iCan('scheduling')) && location.hash === '#ops' && !document.hidden);
  }
  function liveStart() {
    if (LIVE.channel || !sb.channel || !liveWanted()) return;
    try {
      var today = todayStr();
      LIVE.channel = sb.channel('hub-live');
      LIVE.channel.on('postgres_changes', { event: '*', schema: 'public', table: 'checkins', filter: 'date=eq.' + today }, function () { liveBump(); });
      LIVE.channel.on('postgres_changes', { event: '*', schema: 'public', table: 'staff_messages', filter: 'date=eq.' + today }, function () { liveBump(); });
      LIVE.channel.on('postgres_changes', { event: '*', schema: 'public', table: 'emergencies' }, function () { liveBump(); });
      LIVE.channel.on('postgres_changes', { event: '*', schema: 'public', table: 'late_notices', filter: 'date=eq.' + today }, function () { liveBump(); });
      LIVE.channel.subscribe();
    } catch (e) { LIVE.channel = null; }
  }
  function liveStop() {
    if (!LIVE.channel) return;
    try { sb.removeChannel(LIVE.channel); } catch (e) {}
    LIVE.channel = null;
  }
  function liveSync() { if (liveWanted()) liveStart(); else liveStop(); }
  var LOADING = false;
  // Never redraw under someone's fingers: if a box on this screen has focus, wait.
  function typing() { var a = document.activeElement; return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'button'); }
  // Many changes in a burst (a whole crew checking in) become one reload.
  function liveBump() {
    clearTimeout(LIVE.timer);
    LIVE.timer = setTimeout(function () {
      if (LOADING || typing()) { liveBump(); return; }
      if (location.hash === '#ops' && !document.hidden) loadOps().then(renderOps);
    }, 3000);
  }
  // Coming back to the app after a while: one fresh read of the screen you are on.
  var LAST_ACTIVE = Date.now();
  function refreshIfStale() {
    if (!S.me || LOADING || typing() || document.hidden) return;
    if (Date.now() - LAST_ACTIVE < 5 * 60000) return;
    LAST_ACTIVE = Date.now();
    var h = location.hash;
    if (h === '#ops') loadOps().then(renderOps);
    else if (h === '#center') loadCenter().then(renderCenter);
    else if (h === '#coach') loadCoach().then(renderCoach);
    else if (h === '' || h === '#day') loadDay().then(renderDay);
  }

  // ── Routing ──────────────────────────────────────────────────────
  // ── The Guardian Hub: a minor's guardian signs in with the email on the
  // minor's record, sees every program text, and holds the texting switch.
  function famLinkCard() {
    return '<a class="item" href="#family"><div><b>' + esc(t('famTitle')) + '</b><br><span class="hint">' + esc(t('famLink')) + '</span></div><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>';
  }
  function renderFamily() {
    var d = S.fam || { wards: [] };
    // sms timestamps are full timestamptz, which dayLong cannot take.
    var tsDay = function (ts) { return new Date(ts).toLocaleDateString(S.lang === 'es' ? 'es-US' : 'en-US', { month: 'short', day: 'numeric' }); };
    var fb = $('famBack'); if (fb) fb.style.display = S.me ? '' : 'none';
    // The preview banner defaults visible until staff code hides it; guardians never run that code.
    if (!S.me) { var pb = $('previewBar'); if (pb) pb.style.display = 'none'; }
    var so = $('famSignOut'); if (so) so.onclick = async function (e) {
      e.preventDefault(); await sb.auth.signOut(); S.fam = null; S.me = null; location.hash = ''; show('s-signin');
    };
    $('famBody').innerHTML = ((d.wards || []).map(function (w) {
      var ok = w.consent && w.consent.ok;
      var msgs = w.messages || [];
      var pLabel = function (p) { var k = 'famP.' + p, v = t(k); return v === k ? p : v; };
      return '<div class="card" style="gap:8px">' +
        '<div class="disp" style="font-size:28px">' + esc(w.name) + '</div>' +
        (ok ? '<span class="pill ok" style="align-self:flex-start">' + esc(t('famOk')) + (w.consent.at ? ', ' + esc(tsDay(w.consent.at)) : '') + '</span>'
            : '<span class="pill" style="align-self:flex-start">' + esc(t('famNo')) + '</span>') +
        '<div class="hint">' + esc(t('famWhat')) + '</div>' +
        '<div class="actions no-print" style="padding:0">' + (ok
          ? '<button class="btn outline" data-fam-rev="' + w.person_id + '">' + esc(t('famRevoke')) + '</button>'
          : '<button class="btn primary" data-fam-ok="' + w.person_id + '">' + esc(t('famApprove')) + '</button>') + '</div>' +
        fold('fam-' + w.person_id, t('famMsgs'), msgs.length, msgs.length ? msgs.map(function (m) {
          return '<div class="note"><div class="who">' + esc(tsDay(m.at)) + ', ' + esc(clock(m.at)) + ', ' + esc(pLabel(m.purpose)) + (m.by ? ', ' + esc(m.by) : '') + '</div><div class="text">' + esc(m.body || '') + '</div></div>';
        }).join('') : '<div class="pad hint">' + esc(t('famNone')) + '</div>', false) +
        '<div class="msg" id="famMsg' + w.person_id + '" hidden></div></div>';
    }).join('')) || '<div class="card"><div class="hint">' + esc(t('famEmpty')) + '</div></div>';
    $('famBody').querySelectorAll('[data-fam-ok],[data-fam-rev]').forEach(function (b) {
      b.onclick = async function () {
        var grant = b.hasAttribute('data-fam-ok');
        var pid = parseInt(b.getAttribute(grant ? 'data-fam-ok' : 'data-fam-rev'), 10);
        if (!grant && !window.confirm(t('famRevokeConfirm'))) return;
        b.disabled = true;
        var r = await sb.rpc('guardian_consent', { p_person: pid, p_grant: grant });
        if (r.error || r.data !== true) { b.disabled = false; say('famMsg' + pid, (r.error && r.error.message) || t('opsTextFail'), 'bad'); return; }
        var g = await sb.rpc('guardian_overview');
        if (g.data) S.fam = g.data;
        renderFamily();
      };
    });
  }
  function route() {
    if (!S.me) {
      // A guardian has no referee record: their whole Hub is the family screen.
      if (S.fam && (S.fam.wards || []).length) { show('s-family'); renderFamily(); } else show('s-signin');
      return;
    }
    var h = location.hash.replace(/^#/, '') || 'day';
    if (h.indexOf('coach') === 0 && !iCan('coaching')) { location.hash = '#day'; return; }
    if (h.indexOf('coachcard/') === 0) { if (!iCan('review')) { location.hash = '#day'; return; } show('s-ref'); renderCoachCard(decodeURIComponent(h.slice(10))); return; }
    if (h.indexOf('ref/') === 0) { if (!canSeeRef()) { location.hash = '#day'; return; } show('s-ref'); renderRef(decodeURIComponent(h.slice(4))); return; }
    if (h.indexOf('eval/') === 0) { if (!(iCan('evaluations') || iCan('review'))) { location.hash = '#day'; return; } show('s-eval'); renderEval(parseInt(h.slice(5), 10)); return; }
    if (h === 'upgrade' || h.indexOf('upgrade/') === 0) { show('s-upgrade'); renderUpgrade(h === 'upgrade' ? null : parseInt(h.slice(8), 10)); return; }
    if (h.indexOf('map/') === 0) { var mp = h.slice(4).split('/'); show('s-map'); renderMap(decodeURIComponent(mp[0] || ''), decodeURIComponent(mp[1] || '')); return; }
    if (h === 'family') { if (S.fam && (S.fam.wards || []).length) { show('s-family'); renderFamily(); } else location.hash = '#day'; return; }
    if (h === 'eod') { if (!canEod()) { location.hash = '#day'; return; } $('eodBody').innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>'; show('s-eod'); loadEod().then(renderEod).catch(function (e) { $('eodBody').innerHTML = '<div class="msg bad">' + esc(t('reviewFailed') + ' ' + (e && e.message || '')) + '</div>'; }); return; }
    if (h === 'assign') { if (!iCan('assigning')) { location.hash = '#day'; return; } $('assignBody').innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>'; show('s-assign'); loadAssign().then(renderAssign).catch(function (e) { $('assignBody').innerHTML = '<div class="msg bad">' + esc(t('reviewFailed') + ' ' + (e && e.message || '')) + '</div>'; }); return; }
    if (h === 'setup') { if (!iCan('setup')) { location.hash = '#day'; return; } $('setupBody').innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>'; show('s-setup'); SU.ev = null; loadSetup().then(renderSetup).catch(function (e) { $('setupBody').innerHTML = '<div class="msg bad">' + esc(t('reviewFailed') + ' ' + (e && e.message || '')) + '</div>'; }); return; }
    if (h === 'people') { if (!iCan('people')) { location.hash = '#day'; return; } show('s-people'); PP.person = null; $('personCard').innerHTML = ''; renderPeople(); setTimeout(function () { $('peopleQ').focus(); }, 50); return; }
    if (h === 'ops') { if (!iCan('command_center')) { location.hash = '#day'; return; } if (OPS.openStaff) { OPS.tab = 'staff'; OPS.openStaff = false; } $('opsBody').innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>'; show('s-ops'); loadOps().then(renderOps).catch(function (e) { $('opsBody').innerHTML = '<div class="msg bad">' + esc(t('reviewFailed') + ' ' + (e && e.message || '')) + '</div>'; }); return; }
    if (h === 'state') { if (!iCan('state_view')) { location.hash = '#day'; return; } $('stateBody').innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>'; show('s-state'); loadState().then(renderState).catch(function (e) { $('stateBody').innerHTML = '<div class="msg bad">' + esc(t('reviewFailed') + ' ' + (e && e.message || '')) + '</div>'; }); return; }
    if (h === 'center/evals') { CC.tab = 'evals'; h = 'center'; }
    if (h === 'center') { if (!iCan('review')) { location.hash = '#day'; return; } $('centerBody').innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>'; show('s-center'); loadCenter().then(renderCenter).catch(function (e) { $('centerBody').innerHTML = '<div class="msg bad">' + esc(t('reviewFailed') + ' ' + (e && e.message || '')) + '</div>'; }); return; }
    if (h === 'review') { if (!iCan('review')) { location.hash = '#day'; return; } $('reviewList').innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>'; show('s-review'); loadReview().then(renderReview).catch(function (e) { $('reviewList').innerHTML = '<div class="msg bad">' + esc(t('reviewFailed') + ' ' + (e && e.message || '')) + '</div>'; }); return; }
    if (h === 'coach') { loadCoach().then(function () { renderCoach(); }); show('s-coach'); }
    else if (h.indexOf('coach/game/') === 0) { var cg = h.slice(11).split('/'); (S.coach.games.length ? Promise.resolve() : loadCoach()).then(function () { renderCoachGame(cg[0], cg[1]); }); show('s-coachgame'); }
    else if (h === 'coach/notes') { loadCoach().then(function () { renderMyNotes(); }); show('s-mynotes'); }
    else if (h.indexOf('game/') === 0) { renderGame(h.slice(5)); show('s-game'); }
    else if (h === 'notes') { renderNotes(); show('s-notes'); }
    else if (h === 'help') { renderHelp(); show('s-help'); }
    else { renderDay(); show('s-day'); }
  }
  function renderAll() { if (S.me) route(); else if (S.fam && (S.fam.wards || []).length) renderFamily(); }
  window.addEventListener('hashchange', function () { if (location.hash !== '#help') S.reason = null; });
  var LAST_HASH = '';
  window.addEventListener('hashchange', function (e) { var old = (e.oldURL || '').split('#')[1]; if (old != null && old.indexOf('ref/') !== 0 && old.indexOf('coachcard/') !== 0) REF.from = '#' + old; });
  window.addEventListener('hashchange', route);

  async function start() {
    S.me = await loadMe();
    if (!S.me) {
      // No referee record: a guardian email lands on the family screen.
      var g0 = await sb.rpc('guardian_overview');
      if (g0.data && (g0.data.wards || []).length) { S.fam = g0.data; show('s-family'); renderFamily(); return; }
      show('s-signin'); return;
    }
    if (S.me.language === 'es' && S.lang !== 'es') { S.lang = 'es'; applyWords(); }
    await loadDay();
    route();
    // A referee or staff member who is also a guardian gets the family card on Your day.
    sb.rpc('guardian_overview').then(function (g) {
      if (g.data && (g.data.wards || []).length) { S.fam = g.data; var el = $('familyLine'); if (el) el.innerHTML = '<div class="list">' + famLinkCard() + '</div>'; }
    });
    liveSync();
    var ticks = 0;
    setInterval(function () {
      if (!S.me || document.hidden) return;
      ticks++;
      if (location.hash === '' || location.hash === '#day') tickCountdown();
      // The board without a live socket (a referee-only tester, or the socket dropped) refreshes every two minutes.
      else if (location.hash === '#ops' && OPS.tab === 'board' && !LIVE.channel && ticks % 2 === 0 && !LOADING && !typing()) loadOps().then(renderOps);
    }, 60000);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { liveStop(); return; }
      liveSync(); refreshIfStale();
    });
    window.addEventListener('hashchange', liveSync);
    window.addEventListener('focus', refreshIfStale);
  }

  // ── Boot ─────────────────────────────────────────────────────────
  (function boot() {
    try { S.lang = localStorage.getItem('hub-lang') || 'en'; } catch (e) {}
    try { var th = localStorage.getItem('hub-theme'); if (th) setTheme(th); } catch (e) {}
    // Back from Stripe Checkout: say so once, then clean the address bar.
    try {
      var sp = new URLSearchParams(location.search), pv = sp.get('pay');
      if (pv) {
        history.replaceState(null, '', location.pathname + location.hash);
        var pt = document.createElement('div'); pt.className = 'paytoast'; pt.textContent = t(pv === 'ok' ? 'payOkMsg' : 'payCancelMsg');
        document.body.appendChild(pt); setTimeout(function () { pt.classList.add('gone'); }, 8000);
      }
    } catch (e) {}
    ['themeBtn0', 'themeBtn1', 'themeBtn2'].forEach(function (id) { $(id).onclick = toggleTheme; });
    ['langBtn0', 'langBtn1', 'langBtn2'].forEach(function (id) { $(id).onclick = function () { setLang(S.lang === 'es' ? 'en' : 'es'); }; });
    $('markSignin').src = C.marks.csa; $('markDay').src = C.marks.csa;
    ['markGame', 'markNotes', 'markHelp', 'markCoach', 'markCoachGame', 'markMyNotes', 'markReview', 'markCenter', 'markOps', 'markPeople', 'markSetup', 'markEod', 'markRef', 'markState', 'markMap', 'markEval', 'markUpgrade', 'markAssign', 'markFamily'].forEach(function (id) { $(id).src = C.marks.program; });
    ['ja0', 'ja1', 'ja2', 'ja3', 'ja4', 'ja5', 'ja6', 'ja7', 'ja8', 'ja9', 'ja10', 'ja11', 'ja12', 'ja13', 'ja14', 'ja15', 'ja16', 'ja17', 'ja18', 'ja19', 'ja20'].forEach(function (id) { $(id).src = C.marks.ja; });
    $('peopleQ').oninput = function () { var q = $('peopleQ').value.trim(); clearTimeout(PP.timer); PP.timer = setTimeout(function () { searchPeople(q); }, 300); };
    $('peopleQ').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(PP.timer); searchPeople($('peopleQ').value.trim()); } };
    $('staffBtn').onclick = function () { renderStaff(); };
    $('linkBtn').onclick = function () { LINK.rows = null; LINK.pick = null; renderLinks(); };
    $('regBtn').onclick = function () { REG.rows = null; REG.lapsed = false; renderUnregistered(); };
    $('peopleGo').onclick = function () { clearTimeout(PP.timer); searchPeople($('peopleQ').value.trim()); };
    document.addEventListener('click', function (e) { var a = e.target.closest && e.target.closest('[data-tab="staff"]'); if (a && a.getAttribute('href') === '#ops') OPS.openStaff = true; });
    $('signOut').onclick = async function (e) { e.preventDefault(); liveStop(); await sb.auth.signOut(); S.me = null; location.hash = ''; show('s-signin'); };
    applyWords();
    document.querySelectorAll('.ver').forEach(function (el) { el.textContent = 'v' + VERSION; });
    sb.auth.getSession().then(function (r) { if (r.data && r.data.session) start(); else show('s-signin'); });
  })();
})();
