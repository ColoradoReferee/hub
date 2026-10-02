// app.js · Colorado Referees Hub
// Reads from the database as the signed-in person. Writes (check-in, Help)
// go through the current backend this week so the sheet and the database
// both get them.
(function () {
  'use strict';
  // The version. Goes up with every change to any file in this folder.
  var VERSION = '2026.10.02-j';
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
  function fieldShort(f) { return String(f || '').replace(/^Field\s*/i, ''); }
  function eventFor(g) {
    var num = String(g.game_num || '').toUpperCase(), venue = key(g.venue);
    var hit = null;
    S.events.forEach(function (e) {
      if (hit) return;
      if (e.game_prefix && num.indexOf(String(e.game_prefix).toUpperCase()) === 0) hit = e;
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
  var BUSY = 0;
  function busy(on) { BUSY += on ? 1 : -1; if (BUSY < 0) BUSY = 0; var b = $('busy'); if (b) b.style.display = BUSY === 0 ? 'none' : 'flex'; }
  async function load(p) { busy(true); try { return await p; } finally { busy(false); } }
  async function loadDay() { return load(loadDay_()); }
  async function loadOps() { return load(loadOps_()); }
  async function loadCenter() { return load(loadCenter_()); }
  async function loadSetup() { return load(loadSetup_()); }
  async function loadReview() { return load(loadReview_()); }
  async function loadCoach() { return load(loadCoach_()); }
  async function loadSchedule() { return load(loadSchedule_()); }
  function show(id) {
    document.querySelectorAll('.screen').forEach(function (s) { s.classList.toggle('on', s.id === id); });
    window.scrollTo(0, 0);
  }

  // ── Data ─────────────────────────────────────────────────────────
  // The database answers at most 1,000 rows per request. A Saturday has
  // more games than that. Page until a short page comes back.
  async function fetchAll(build) {
    var out = [], page = 0, size = 1000;
    for (;;) {
      var r = await build().range(page * size, page * size + size - 1);
      if (r.error) return { data: out, error: r.error };
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
  async function loadDay_() {
    var today = todayStr();
    var g = await fetchAll(function () { return sb.from('games').select('game_id,date,game_num,kickoff,field,age_group,gender,competition,home,away,cr,ar1,ar2,fourth,venue,status,home_club,away_club,score_url')
      .eq('date', today).not('status', 'in', '(C,X,canceled_no_pay)').order('kickoff'); });
    var keys = S.me.nameKeys || [];
    S.games = (g.data || []).filter(function (x) { return ['cr', 'ar1', 'ar2', 'fourth'].some(function (k) { return keys.indexOf(key(x[k])) >= 0; }); });
    var ev = await sb.from('events').select('id,name,game_prefix,venues,blurb,tools,rules_url');
    S.events = ev.data || [];
    var ci = await sb.from('checkins').select('game_id,created_at,ref_name').eq('date', today);
    S.checkins = {};
    (ci.data || []).forEach(function (r) { if (r.game_id && keys.indexOf(key(r.ref_name)) >= 0) S.checkins[String(r.game_id)] = r.created_at; });
    var n = await sb.from('observations').select('id,date,observer,rater_role,final_note,cleaned_note,game_id,field').order('date', { ascending: false }).limit(50);
    S.notes = n.data || [];
    var b = await sb.from('announcements').select('title,body,severity,created_at,venue,event_id,start_date,end_date').lte('start_date', today).gte('end_date', today).order('created_at', { ascending: false }).limit(5);
    S.bulletins = b.data || [];
    var sc = await sb.from('scores').select('game_id,home_score,away_score,status,entered_by,created_at').eq('date', today);
    S.scores = {}; (sc.data || []).forEach(function (r) { S.scores[String(r.game_id)] = r; });
    await loadEvalRequests();
    var cv = await sb.rpc('coached_venues', { p_date: today });
    S.coachedVenues = (cv.data || []).map(function (r) { return typeof r === 'string' ? r : r.coached_venues; });
  }

  // ── Your day ─────────────────────────────────────────────────────
  function nextGame() {
    var now = Date.now();
    var upcoming = S.games.filter(function (g) { return new Date(g.kickoff).getTime() > now - 100 * 60000; });
    return upcoming[0] || null;
  }
  function renderDay() {
    var me = S.me, h = new Date().getHours();
    var greet = t(h < 12 ? 'greeting.morning' : h < 17 ? 'greeting.afternoon' : 'greeting.evening');
    var venue = S.games.length ? S.games[0].venue : '';
    $('dayLead').textContent = greet + ', ' + me.first_name + '. ' + dayLong() + (venue ? ', ' + venue : '') + '.';
    var g = nextGame();
    var cd = $('countdown');
    if (g) {
      var mins = Math.round((new Date(g.kickoff).getTime() - Date.now()) / 60000);
      cd.style.display = 'flex';
      if (mins >= 0 && mins < 120) { $('countN').textContent = mins; $('countW').innerHTML = t('minutesToKickoff'); }
      else if (mins >= 120) { $('countN').textContent = Math.floor(mins / 60); $('countW').innerHTML = t('hoursToKickoff'); }
      else { $('countN').textContent = Math.abs(mins); $('countW').innerHTML = t('kickedOff') + '<br>' + t('minAgo'); }
      $('nextCard').innerHTML = cardHtml(g);
      wireCheckin(g, $('nextCard'));
    } else {
      cd.style.display = 'none';
      $('nextCard').innerHTML = '<div class="card"><div class="disp" style="font-size:28px">' + esc(t('noGamesToday')) + '</div><div class="hint">' + esc(t('noGamesHint')) + '</div></div>';
    }
    var later = S.games.filter(function (x) { return x !== g; });
    $('laterList').innerHTML = later.length ? '<div class="hint" style="padding-bottom:8px;font-weight:700">' + esc(t('laterToday')) + '</div>' + later.map(function (x) {
      var inAt = S.checkins[String(x.game_id)];
      return '<a class="item" href="#game/' + esc(x.game_id) + '"><div class="when"><div class="disp">' + esc(clock(x.kickoff)) + '</div><div class="sub">' + esc(x.field || '') + ', ' + esc(x.age_group || '') + '</div></div>' +
        (inAt ? '<div class="state in"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="8" fill="currentColor"></circle><path d="M5.5 9.5l2.3 2.3L12.8 6.8" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>' + esc(t('checkedIn').charAt(0) + t('checkedIn').slice(1).toLowerCase()) + '</div>' : '') + '</a>';
    }).join('') : '';
    var note = S.notes[0];
    if (note) markRead([note]);
    $('noteBox').innerHTML = note ? '<div class="note"><div class="who">' + esc(note.observer || '') + (note.rater_role ? ', ' + esc(note.rater_role) : '') + (note.date ? ', ' + esc(t('noteFrom')) + ' ' + esc(dayLong(note.date)) : '') + '</div><div class="text">' + esc(note.final_note || note.cleaned_note || '') + '</div><a href="#notes">' + esc(t('allNotes')) + '</a></div>'
      : '<div class="note"><div class="text hint">' + esc(t('noNotes')) + '</div></div>';
    var coachedHere = S.games.some(function (x) { return (S.coachedVenues || []).indexOf(x.venue) >= 0; });
    var myEval = (ER.mine || []).filter(function (r) { return r.ref_person_id === S.me.person_id && r.status === 'assigned' && r.game_date >= todayStr(); })[0];
    $('evalLine').innerHTML = myEval ? '<div class="card" style="border-color:var(--gold);gap:4px"><b>' + esc(t('evalReqTitle')) + '</b><div>' + esc(dayLong(myEval.game_date)) + ', ' + esc(myEval.venue || '') + '. ' + esc(t('evalPurpose.' + myEval.purpose)) + '. ' + esc(t('evalStatus.assigned')) + '</div></div>' : '';
    $('bulletins').innerHTML = (coachedHere ? '<div class="bulletin"><svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="9" stroke="currentColor" stroke-width="2"></circle><path d="M7 11.5l3 3 5-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg><div class="text">' + esc(t('coachHereToday')) + ' <a href="#" id="badgeLink">' + esc(t('lanyard')) + '</a><div id="badgeBox" hidden style="margin-top:8px"><img src="assets/badge.png" alt="" style="width:130px;border-radius:8px"><div class="hint">' + esc(t('badgeCaption')) + '</div></div></div></div>' : '') + S.bulletins.slice(0, 2).map(function (b) {
      return '<div class="bulletin"><svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="9" stroke="currentColor" stroke-width="2"></circle><path d="M11 6v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path><circle cx="11" cy="15.5" r="1.2" fill="currentColor"></circle></svg><div class="text">' + (b.title ? '<b>' + esc(b.title) + '</b> ' : '') + esc(b.body || '') + ' <span>' + esc(t('fromState')) + '.</span></div></div>';
    }).join('');
    $('coachEntry').innerHTML = iCan('coaching') ? '<a class="rowbtn" href="#coach" style="margin-top:14px"><span><span class="t">' + esc(t('coachingEntry')) + '</span><br><span class="s">' + esc(t('coachingEntryHint')) + '</span></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>' : '';
    $('reviewEntry').innerHTML = iCan('review') ? '<a class="rowbtn" href="#review" style="margin-top:8px"><span><span class="t">' + esc(t('reviewEntry')) + '</span><br><span class="s">' + esc(t('reviewEntryHint')) + '</span></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>' : '';
    $('centerEntry').innerHTML = iCan('review') ? '<a class="rowbtn" href="#center" style="margin-top:8px"><span><span class="t">' + esc(t('centerEntry')) + '</span><br><span class="s">' + esc(t('centerEntryHint')) + '</span></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>' : '';
    $('opsEntry').innerHTML = iCan('command_center') ? '<a class="rowbtn" href="#ops" style="margin-top:8px"><span><span class="t">' + esc(t('opsEntry')) + '</span><br><span class="s">' + esc(t('opsEntryHint')) + '</span></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>' : '';
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
  }
  function cardHtml(g) {
    var inAt = S.checkins[String(g.game_id)];
    return '<div class="card"><div class="row"><div class="disp big">' + esc(clock(g.kickoff)) + '</div><div class="disp big">' + esc(String(g.field || '').toUpperCase()) + '</div></div>' +
      '<div>' + esc(g.age_group || '') + (g.competition ? ', ' + esc(g.competition) : '') + '. ' + esc(t('youAre')) + ' ' + esc(t('role.' + myRole(g))) + '.</div>' +
      '<div class="actions">' + checkinBtn(g, inAt) + '<a class="btn outline" href="#game/' + esc(g.game_id) + '">' + esc(t('details')) + '</a></div>' +
      '<div class="hint">' + esc(t('checkinWhere')) + '</div><div class="msg bad" id="ci-msg-' + esc(g.game_id) + '" hidden></div></div>';
  }
  function checkinBtn(g, inAt) {
    if (inAt) return '<div class="btn done" style="flex-grow:1"><span class="disp">' + esc(t('checkedIn')) + '</span><small>' + esc(clock(inAt)) + '. ' + esc(t('checkedInAt')) + '</small></div>';
    return '<button class="btn primary" id="ci-' + esc(g.game_id) + '">' + esc(t('checkIn')) + '</button>';
  }
  function wireCheckin(g, root) {
    var b = root.querySelector('#ci-' + g.game_id);
    if (!b) return;
    b.onclick = async function () {
      b.disabled = true; b.textContent = t('checkingIn');
      var ev = eventFor(g);
      try {
        var r = await fetch(C.backend, { method: 'POST', body: JSON.stringify({ action: 'checkinVenue', event: ev ? ev.id : '', refName: myNameOn(g), venue: g.venue, date: g.date }) });
        var j = await r.json();
        if (!j || j.status !== 'ok') throw new Error(j && j.message || 'error');
        var now = new Date().toISOString();
        S.games.forEach(function (x) { if (key(x.venue) === key(g.venue)) S.checkins[String(x.game_id)] = now; });
        renderAll();
      } catch (e) {
        b.disabled = false; b.textContent = t('checkIn');
        var m = root.querySelector('#ci-msg-' + g.game_id); if (m) { m.hidden = false; m.textContent = t('checkinFailed'); }
      }
    };
  }

  // ── Coaching ─────────────────────────────────────────────────────
  function iCan(section) { return !!(S.me && (S.me.unlocks || []).indexOf(section) >= 0); }
  var AREAS = ['laws', 'reading', 'fitness', 'presence'];
  async function loadCoach_() {
    var today = todayStr();
    var g = await fetchAll(function () { return sb.from('games').select('game_id,date,game_num,kickoff,field,age_group,gender,competition,home,away,cr,ar1,ar2,fourth,venue,status')
      .eq('date', today).not('status', 'in', '(C,X,canceled_no_pay)').order('venue').order('kickoff'); });
    S.coach.games = g.data || [];
    var mine = await sb.from('coach_assignments').select('venue,block,fields,note').eq('date', today);
    S.coach.mine = mine.data || [];
    if (S.coach.mine.length && !S.coach.venue) S.coach.venue = S.coach.mine[0].venue;
    var ea = await sb.from('eval_requests').select('id,game_id,game_date,venue,purpose,status,ref_name').eq('coach_person_id', S.me.person_id).eq('status', 'assigned').gte('game_date', today).order('game_date');
    S.coach.evals = ea.data || [];
    // Days ahead with games, for saying when I am free.
    var ahead = await fetchAll(function () { return sb.from('games').select('date').gte('date', today).lte('date', shiftDate(today, 10)).not('status', 'in', '(C,X,canceled_no_pay)').order('date'); });
    var days = {}; (ahead.data || []).forEach(function (x) { days[x.date] = 1; }); S.coach.days = Object.keys(days).sort();
    var av = await sb.from('coach_availability').select('date,block').gte('date', today);
    S.coach.avail = {}; (av.data || []).forEach(function (x) { S.coach.avail[x.date + x.block] = 1; });
    var n = await sb.from('observations').select('id,date,ref_name,observer,rater_role,public_notes,cleaned_note,final_note,cleanup_status,area,field,game_id,created_at')
      .order('created_at', { ascending: false }).limit(100);
    S.coach.notes = (n.data || []).filter(function (x) { return (S.me.nameKeys || []).indexOf(key(x.observer)) >= 0; });
    var mine = S.coach.notes.map(function (x) { return x.id; }).filter(Boolean);
    S.coach.reads = {};
    if (mine.length) {
      var rd = await sb.from('note_reads').select('observation_id,read_at').in('observation_id', mine);
      (rd.data || []).forEach(function (r) { S.coach.reads[String(r.observation_id)] = r.read_at; });
    }
    // What has already been said about every referee working today (released notes only).
    var names = {};
    S.coach.games.forEach(function (g) { ['cr', 'ar1', 'ar2', 'fourth'].forEach(function (k) { if (g[k]) names[g[k]] = 1; }); });
    var list = Object.keys(names);
    S.coach.seen = {};
    if (list.length) {
      var seen = await sb.from('observations').select('ref_name,date,observer,rater_role,final_note,cleaned_note,area')
        .in('ref_name', list).in('cleanup_status', ['approved', 'edited']).order('date', { ascending: false }).limit(500);
      (seen.data || []).forEach(function (o) { var k = key(o.ref_name); (S.coach.seen[k] = S.coach.seen[k] || []).push(o); });
    }
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
        Object.keys(refs).forEach(function (k) { total++; if (S.coach.notes.some(function (n) { return key(n.ref_name) === k && n.date === todayStr(); })) done++; });
        return '<div>' + esc(t(m.block === 'am' ? 'blockAm' : m.block === 'pm' ? 'blockPm' : 'blockAll')) + ', ' + esc(m.venue) + ((m.fields || []).length ? ', ' + esc(m.fields.map(fieldShort).join(', ')) : '') + (m.note ? '. ' + esc(m.note) : '') + '<br><span class="hint">' + esc(t('blockJob')) + ' ' + esc(t('debriefed').replace('{d}', done).replace('{n}', total)) + '</span></div>';
      }).join('') + '</div>' : '';
    var evalsCard = (S.coach.evals || []).length ? '<div class="card" style="border-color:var(--red);gap:6px"><b>' + esc(t('evalAssignedTitle')) + '</b>' + S.coach.evals.map(function (r) { return '<div>' + refLink(r.ref_name) + ', ' + esc(dayLong(r.game_date)) + ', ' + esc(r.venue || '') + '. ' + esc(t('evalPurpose.' + r.purpose)) + ' <a class="refname" href="#coach/game/' + esc(r.game_id) + '">' + esc(t('details')) + '</a></div>'; }).join('') + '<div class="hint">' + esc(t('evalAssignedHint')) + '</div></div>' : '';
    expected = evalsCard + expected;
    var availability = (S.coach.days || []).length ? '<div class="card" style="gap:6px"><div class="hint" style="font-weight:700">' + esc(t('whenFree')) + '</div>' + S.coach.days.map(function (d) {
        return '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0"><span style="min-width:0">' + esc(dayLong(d)) + '</span><span class="chips" style="flex-shrink:0"><button class="chip-btn' + (S.coach.avail[d + 'am'] ? ' on' : '') + '" data-av="' + d + '|am">' + esc(t('blockAm')) + '</button><button class="chip-btn' + (S.coach.avail[d + 'pm'] ? ' on' : '') + '" data-av="' + d + '|pm">' + esc(t('blockPm')) + '</button></span></div>';
      }).join('') + '<div class="msg" id="avMsg" hidden></div></div>' : '';
    expected = expected + availability;
    var venuePicker = venues.length > 8
      ? '<select id="venueSel" style="font:inherit;width:100%;padding:12px;border:2px solid var(--navy);border-radius:8px;background:var(--surface);color:var(--ink)">' + venues.map(function (v) { return '<option value="' + esc(v) + '"' + (v === S.coach.venue ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') + '</select>'
      : '<div class="chips">' + venues.map(function (v) { return '<button class="chip-btn' + (v === S.coach.venue ? ' on' : '') + '" data-venue="' + esc(v) + '">' + esc(v) + '</button>'; }).join('') + '</div>';
    $('venuePick').innerHTML = expected + (venues.length ? '<div class="pad" style="padding-top:14px"><div class="hint" style="font-weight:700;padding-bottom:8px">' + esc(t('venue')) + '</div>' + venuePicker + '</div>' : '<div class="card"><div class="hint">' + esc(t('noVenuesToday')) + '</div></div>');
    var vsel = $('venueSel'); if (vsel) vsel.onchange = function () { S.coach.venue = vsel.value; renderCoach(); };
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
    var games = S.coach.games.filter(function (g) { return g.venue === S.coach.venue && !isHQ(g); });
    $('coachGames').innerHTML = (games.length ? '<div class="pad hint" style="padding-top:12px">' + esc(t('redMeans')) + ((S.coach.mine || []).length ? ' ' + esc(t('goldMeans')) : '') + '</div>' : '') + '<div class="list">' + games.map(function (g) {
      var crew = ['cr', 'ar1', 'ar2', 'fourth'].filter(function (k) { return g[k]; }).map(function (k) {
        var none = !((S.coach.seen || {})[key(g[k])] || []).length;
        return (none ? '<span style="color:var(--red);font-weight:700">' : '<span>') + refLink(g[k]) + '</span>';
      }).join(', ');
      return '<a class="item' + (isMyField(g) ? ' mine' : '') + '" href="#coach/game/' + esc(g.game_id) + '"><div><div class="when"><div class="disp">' + esc(clock(g.kickoff)) + '</div><div class="sub">' + esc(g.field || '') + ', ' + esc(g.age_group || '') + (isMyField(g) ? ', <b>' + esc(t('yours')) + '</b>' : '') + '</div></div><div class="hint">' + crew + '</div></div><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>';
    }).join('') + '</div>';
  }
  function renderCoachGame(id) {
    var g = S.coach.games.filter(function (x) { return String(x.game_id) === String(id); })[0];
    S.coach.game = g || null;
    if (!g) { location.hash = '#coach'; return; }
    var crew = ['cr', 'ar1', 'ar2', 'fourth'].filter(function (k) { return g[k]; });
    if (!S.coach.ref || crew.indexOf(S.coach.ref) < 0) S.coach.ref = null;
    var signed = S.me.coaching_title || (S.me.titles || [])[0] || '';
    $('coachGameBody').innerHTML =
      '<div class="pad" style="padding-top:16px"><div class="lead">' + esc(g.venue || '') + ', ' + esc(dayLong(g.date)) + '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline"><div class="disp" style="font-size:48px">' + esc(clock(g.kickoff)) + '</div><div class="disp" style="font-size:48px;color:var(--count)">' + esc(fieldShort(g.field)) + '</div></div>' +
      '<div>' + esc(g.age_group || '') + (g.competition ? ', ' + esc(g.competition) : '') + '. ' + esc(g.home || '') + ' v ' + esc(g.away || '') + '</div></div>' +
      ((S.coach.evals || []).some(function (r) { return String(r.game_id) === String(g.game_id); }) ? '<div class="pad" style="padding-top:12px"><a class="rowbtn" style="margin:0;width:100%;border-color:var(--red)" href="evaluator.html?gameId=' + esc(g.game_id) + '"><span><span class="t">' + esc(t('evaluatorOpen')) + '</span><br><span class="s">' + esc(t('evaluatorHint')) + '</span></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a></div>' : '') +
      '<div class="disp h2">' + esc(t('crewPick')) + '</div>' +
      crew.map(function (k) { return '<div class="crewbtn' + (S.coach.ref === k ? ' on' : '') + '" role="button" tabindex="0" data-crew="' + k + '"><span><span class="t">' + esc(g[k]) + ' <a class="refname" href="#ref/' + encodeURIComponent(g[k]) + '" style="font-size:13px;font-weight:400" onclick="event.stopPropagation()">' + esc(t('refCardTitle')) + '</a></span><br><span class="s">' + esc(t('role.' + k)) + '. ' + seenLine(g[k]) + '</span></span>' + (S.coach.ref === k ? '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="10" fill="var(--navy)"></circle><path d="M6.5 11.5l3 3 6-6.5" stroke="var(--surface)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></path></svg>' : '') + '</div>'; }).join('') +
      (S.coach.ref ? priorNotesHtml(g[S.coach.ref]) + '<div class="card" id="noteCard" style="gap:12px"><label for="noteText" style="font-weight:700">' + esc(t('noteLabel')) + '</label><textarea id="noteText" placeholder="' + esc(t('notePlaceholder')) + '"></textarea>' +
        '<div class="hint" style="font-weight:700">' + esc(t('areaLabel')) + '</div><div class="chips">' + AREAS.map(function (a) { return '<button class="chip-btn' + (S.coach.area === a ? ' on' : '') + '" data-area="' + a + '">' + esc(t('areas.' + a)) + '</button>'; }).join('') + '</div>' +
        '<div class="hint">' + esc(t('signedAs')) + ' ' + esc(S.me.first_name + ' ' + S.me.last_name) + ', ' + esc(signed) + '</div>' +
        '<button class="btn primary" id="saveNote">' + esc(t('saveNote')) + '</button><div class="msg" id="noteMsg" hidden></div></div>' : '');
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
    $('myNotesList').innerHTML = S.coach.notes.length ? S.coach.notes.map(function (n) {
      var st = n.cleanup_status || 'pending', ok = st === 'approved' || st === 'edited';
      var label = t('status.' + st); if (label === 'status.' + st) label = t('status.pending');
      var readAt = (S.coach.reads || {})[String(n.id)];
      if (ok && readAt) label = t('readBy') + ' ' + dayLong(readAt.slice(0, 10));
      return '<div class="card" style="gap:8px"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><div><b>' + refLink(n.ref_name || '') + '</b> <span class="hint">' + esc(dayLong(n.date)) + (n.field ? ', ' + esc(n.field) : '') + (n.area ? ', ' + esc(t('areas.' + n.area)) : '') + '</span></div><span class="pill' + (ok ? ' ok' : '') + '">' + esc(label) + '</span></div>' +
        '<div class="side three"><div class="col"><b>' + esc(t('rawLabel')) + '</b>' + esc(n.public_notes || '') + '</div><div class="col"><b>' + esc(t('aiLabel')) + '</b>' + (n.cleaned_note ? esc(n.cleaned_note) : '<span class="hint">' + esc(t('notCleaned')) + '</span>') + '</div><div class="col"><b>' + esc(t('releasedLabel')) + '</b>' + (ok ? esc(n.final_note || n.cleaned_note || '') : '<span class="hint">' + esc(t('notReleased')) + '</span>') + '</div></div></div>';
    }).join('') : '<div class="card"><div class="hint">' + esc(t('noMyNotes')) + '</div></div>';
  }

  // ── Review (Scheduling): clean, read both, approve ───────────────
  var REV = { filter: 'cleaned', notes: [], busy: false };
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
    if (s === 'cleaned' && n.cleanedNote) return 'cleaned';
    return 'pending';
  }
  function renderReview() {
    var counts = { pending: 0, cleaned: 0, approved: 0 };
    REV.notes.forEach(function (n) { counts[revStatus(n)]++; });
    var lbl = function (k, n) { return t('filter' + k.charAt(0).toUpperCase() + k.slice(1)) + ' ' + n; };
    var list = REV.notes.filter(function (n) { return revStatus(n) === REV.filter; });
    $('reviewTools').innerHTML = '<div class="filters">' + ['pending', 'cleaned', 'approved'].map(function (k) {
      return '<button class="chip-btn' + (REV.filter === k ? ' on' : '') + '" data-filter="' + k + '">' + esc(lbl(k, counts[k])) + '</button>';
    }).join('') + '</div>' +
      (REV.filter === 'pending' && counts.pending ? '<div class="pad" style="padding-top:10px"><button class="btn outline small" id="cleanAll">' + esc(t('cleanAll')) + '</button></div>' : '') +
      (REV.filter === 'cleaned' && counts.cleaned ? '<div class="pad" style="padding-top:10px"><button class="btn go small" id="approveAll">' + esc(t('approveAll')) + '</button></div>' : '') +
      '<div class="msg bad" id="revMsg" hidden style="margin:10px 20px 0"></div>';
    $('reviewTools').querySelectorAll('[data-filter]').forEach(function (b) { b.onclick = function () { REV.filter = b.getAttribute('data-filter'); renderReview(); }; });
    var ca = $('cleanAll'); if (ca) ca.onclick = function () { runOn(list.filter(function (n) { return !n.flagged; }), 'clean'); };
    var aa = $('approveAll'); if (aa) aa.onclick = function () { runOn(list.filter(function (n) { return !n.flagged; }), 'approve'); };
    $('reviewList').innerHTML = list.length ? list.map(function (n) {
      var st = revStatus(n);
      return '<div class="card' + (n.flagged ? ' flagged' : '') + '" style="gap:8px" id="rev-' + n.rowNum + '">' +
        '<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline"><div><b>' + refLink(n.refName) + '</b><br><span class="hint">' + esc(n.observer || '') + (n.raterRole ? ', ' + esc(n.raterRole) : '') + '. ' + esc(n.date ? dayLong(n.date) : '') + (n.field ? ', ' + esc(n.field) : '') + (n.officialRole ? ', ' + esc(n.officialRole) : '') + '</span></div>' +
        (st === 'approved' ? '<span class="pill ok">' + esc(t('approved')) + (n.reviewedBy ? ' ' + esc(t('approvedBy')) + ' ' + esc(n.reviewedBy) : '') + '</span>' : '') + '</div>' +
        (n.flagged ? '<div class="hint" style="color:var(--red);font-weight:700">' + esc(t('flaggedNote')) + '</div>' : '') +
        '<div class="side three"><div class="col"><b>' + esc(t('rawLabel')) + '</b>' + esc(n.notesPublic || '') + '</div><div class="col"><b>' + esc(t('aiLabel')) + '</b>' + (n.cleanedNote ? esc(n.cleanedNote) : '<span class="hint">' + esc(t('notCleaned')) + '</span>') + '</div><div class="col"><b>' + esc(t('releasedLabel')) + '</b>' + (st === 'approved' ? esc(n.finalNote || n.cleanedNote || '') : '<span class="hint">' + esc(t('notReleased')) + '</span>') + '</div></div>' +
        (st === 'pending' ? '<button class="btn outline small" data-clean="' + n.rowNum + '">' + esc(t('cleanBtn')) + '</button>' : '') +
        (st === 'cleaned' ? '<button class="btn go small" data-approve="' + n.rowNum + '">' + esc(t('approveBtn')) + '</button>' : '') +
        '</div>';
    }).join('') : '<div class="card"><div class="hint">' + esc(t('nothingHere')) + '</div></div>';
    $('reviewList').querySelectorAll('[data-clean]').forEach(function (b) { b.onclick = function () { runOn([byRow(b.getAttribute('data-clean'))], 'clean', b); }; });
    $('reviewList').querySelectorAll('[data-approve]').forEach(function (b) { b.onclick = function () { runOn([byRow(b.getAttribute('data-approve'))], 'approve', b); }; });
  }
  function byRow(r) { return REV.notes.filter(function (n) { return String(n.rowNum) === String(r); })[0]; }
  async function runOn(notes, what, btn) {
    notes = notes.filter(Boolean);
    if (!notes.length || REV.busy) return;
    REV.busy = true;
    if (btn) { btn.disabled = true; btn.textContent = t(what === 'clean' ? 'cleaning' : 'approving'); }
    var m = $('revMsg'); if (m) m.hidden = true;
    try {
      if (what === 'approve') {
        await post({ action: 'approveBatch', reviewedBy: S.me.first_name + ' ' + S.me.last_name, items: notes.map(function (n) { return { rowNum: n.rowNum, use: 'ai' }; }) });
      } else {
        for (var i = 0; i < notes.length; i++) await post({ action: 'cleanNote', rowNum: notes[i].rowNum });
      }
      await loadReview();
      if (what === 'approve' && REV.filter === 'cleaned') REV.filter = 'approved';
      if (what === 'clean' && REV.filter === 'pending') REV.filter = 'cleaned';
      renderReview();
    } catch (e) {
      renderReview();
      var mm = $('revMsg'); if (mm) { mm.hidden = false; mm.textContent = t('reviewFailed') + ' ' + (e && e.message ? e.message : ''); }
    }
    REV.busy = false;
  }

  // ── Command Center: referee development ──────────────────────────
  var CC = { tab: 'coverage', cov: [], obs: [], reads: {}, drafts: null, from: '', to: '', sdate: '', coaches: [], assigns: [], venues: [], pick: null };
  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  async function loadCenter_() {
    var cov = await sb.rpc('coverage_rows');
    CC.cov = (cov.data || []).sort(function (a, b) { return b.games - a.games; });
    var since = iso(new Date(Date.now() - 30 * 86400000));
    var obs = await sb.from('observations').select('id,observer,rater_role,ref_name,date,cleanup_status').gte('date', since).limit(2000);
    CC.obs = obs.data || [];
    var ids = CC.obs.map(function (o) { return o.id; });
    CC.reads = {};
    for (var i = 0; i < ids.length; i += 200) {
      var rd = await sb.from('note_reads').select('observation_id').in('observation_id', ids.slice(i, i + 200));
      (rd.data || []).forEach(function (r) { CC.reads[String(r.observation_id)] = 1; });
    }
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
  }
  async function loadEvals() { return load(loadEvals_()); }
  function renderCenter() {
    var tabs = ['coverage', 'evals', 'schedule', 'coaches', 'ai', 'queue'];
    var head = '<div class="tabs">' + tabs.map(function (k) { return '<button class="chip-btn' + (CC.tab === k ? ' on' : '') + '" data-tab="' + k + '">' + esc(t('tab' + k.charAt(0).toUpperCase() + k.slice(1))) + '</button>'; }).join('') + '</div>';
    var body = '';
    if (CC.tab === 'coverage') {
      var worked = CC.cov.length, seen = CC.cov.filter(function (r) { return r.notes > 0; }).length, never = worked - seen;
      var rel = 0, read = 0; CC.cov.forEach(function (r) { rel += r.released; read += r.read; });
      var list = CC.cov.filter(function (r) { return r.notes === 0; }).slice(0, 40);
      body = '<div class="stats"><div class="stat"><b>' + worked + '</b><i>' + esc(t('stWorked')) + '</i></div><div class="stat green"><b>' + seen + '</b><i>' + esc(t('stSeen')) + '</i></div><div class="stat red"><b>' + never + '</b><i>' + esc(t('stNever')) + '</i></div></div>' +
        '<div class="pad" style="padding-top:12px"><div class="hint">' + esc(t('stRead')) + ': ' + read + ' / ' + rel + '</div><div class="bar"><i style="width:' + (rel ? Math.round(100 * read / rel) : 0) + '%"></i></div></div>' +
        '<div class="disp h2">' + esc(t('neverSeenTitle')) + '</div><div class="pad">' + list.map(function (r) {
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
          (r.status === 'requested' ? (picking ? '<input id="evalQ" placeholder="' + esc(t('coachSearch')) + '" value="' + esc(CC.evalQ || '') + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"><div class="chips">' + eligible.filter(function (x) { return !q || (x.first_name + ' ' + x.last_name).toLowerCase().indexOf(q) >= 0; }).slice(0, 12).map(function (x) { return '<button class="chip-btn" data-evalassign="' + x.person_id + '" data-req="' + r.id + '">' + esc(x.first_name + ' ' + x.last_name) + ' <small>' + esc(x.coaching_title || '') + '</small></button>'; }).join('') + '</div>' + (r.purpose === 'upgrade_national' ? '<div class="hint">' + esc(t('evalNationalOnly')) + '</div>' : '') : '<div class="actions" style="padding:0"><button class="btn go small" data-evalpick="' + r.id + '">' + esc(t('evalAssign')) + '</button><button class="btn outline small" data-evaldecline="' + r.id + '">' + esc(t('evalDecline')) + '</button></div>') : '') +
          (r.status === 'assigned' ? '<button class="btn outline small" data-evaldone="' + r.id + '">' + esc(t('evalMarkDone')) + '</button>' : '') + '</div>';
      };
      body = '<div class="pad lead" style="padding-top:12px">' + esc(t('evalsLead')) + '</div><div class="disp h2">' + esc(t('evalsOpen')) + ' ' + open.length + '</div>' + (open.length ? open.map(card).join('') : '<div class="card"><div class="hint">' + esc(t('nothingHere')) + '</div></div>') +
        '<div class="disp h2">' + esc(t('evalsAssigned')) + ' ' + assigned.length + '</div>' + (assigned.length ? assigned.map(card).join('') : '<div class="card"><div class="hint">' + esc(t('nothingHere')) + '</div></div>');
    } else if (CC.tab === 'schedule') {
      var todayAss = CC.assigns.filter(function (a) { return a.date === CC.sdate; });
      var avCount = Object.keys(CC.avail || {}).filter(function (k) { return CC.avail[k][CC.block]; }).length;
      body = '<div class="datebar"><button class="iconbtn" data-sday="-1" aria-label="Previous day">&#8249;</button><div class="d">' + esc(dayLong(CC.sdate)) + '</div><button class="iconbtn" data-sday="1" aria-label="Next day">&#8250;</button></div>' +
        '<div class="pad lead" style="padding-top:8px">' + esc(t('scheduleLead')) + '</div>' +
        '<div class="pad" style="padding-top:10px"><div class="chips"><button class="chip-btn' + (CC.block === 'am' ? ' on' : '') + '" data-sblock="am">' + esc(t('blockAm')) + '</button><button class="chip-btn' + (CC.block === 'pm' ? ' on' : '') + '" data-sblock="pm">' + esc(t('blockPm')) + '</button></div><div class="hint" style="padding-top:6px">' + esc(t('availableCount').replace('{n}', avCount)) + '</div></div>' +
        (CC.venues.length ? '<div class="pad" style="padding-top:10px"><div class="hint" style="font-weight:700;padding-bottom:6px">' + esc(t('venue')) + '</div><div class="chips">' + CC.venues.map(function (v) { var n = todayAss.filter(function (a) { return a.venue === v && a.block === CC.block; }).length; return '<button class="chip-btn' + (CC.pick === v ? ' on' : '') + '" data-svenue="' + esc(v) + '">' + esc(v) + (n ? ' (' + n + ')' : '') + '</button>'; }).join('') + '</div></div>' : '<div class="card"><div class="hint">' + esc(t('noGamesDay')) + '</div></div>') +
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
        return '<div class="rowline"><div><b>' + esc(b.name) + '</b>' + (b.role ? ' <span class="hint">' + esc(b.role) + '</span>' : '') + '<br><span class="hint">' + Object.keys(b.refs).length + ' ' + esc(t('coachRefs')) + ', ' + b.released + ' ' + esc(t('coachReleased')) + ', ' + b.read + ' ' + esc(t('coachRead')) + '</span></div><div class="n">' + b.notes + '</div></div>';
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
    $('centerBody').querySelectorAll('[data-tab]').forEach(function (b) { b.onclick = function () { CC.tab = b.getAttribute('data-tab'); if (CC.tab === 'queue' && !REV.notes.length) loadReview().then(renderCenter); else if (CC.tab === 'schedule') loadSchedule().then(renderCenter); else if (CC.tab === 'evals') loadEvals().then(renderCenter); else renderCenter(); }; });
    $('centerBody').querySelectorAll('[data-evalpick]').forEach(function (b) { b.onclick = function () { CC.evalPick = parseInt(b.getAttribute('data-evalpick'), 10); CC.evalQ = ''; renderCenter(); }; });
    var eq = $('evalQ'); if (eq) { eq.oninput = function () { CC.evalQ = eq.value; renderCenter(); var x = $('evalQ'); if (x) { x.focus(); x.setSelectionRange(x.value.length, x.value.length); } }; }
    $('centerBody').querySelectorAll('[data-evalassign]').forEach(function (b) { b.onclick = async function () { b.disabled = true; var coach = parseInt(b.getAttribute('data-evalassign'), 10), id = parseInt(b.getAttribute('data-req'), 10); var r = CC.evalReqs.filter(function (x) { return x.id === id; })[0]; var ok = await sb.rpc('may_evaluate', { p_coach: coach, p_purpose: r.purpose }); if (!ok.data) { b.disabled = false; return; } await sb.from('eval_requests').update({ status: 'assigned', coach_person_id: coach, assigned_by: S.me.person_id, assigned_at: new Date().toISOString() }).eq('id', id); CC.evalPick = null; await loadEvals(); renderCenter(); }; });
    $('centerBody').querySelectorAll('[data-evaldecline]').forEach(function (b) { b.onclick = async function () { b.disabled = true; await sb.from('eval_requests').update({ status: 'declined' }).eq('id', parseInt(b.getAttribute('data-evaldecline'), 10)); await loadEvals(); renderCenter(); }; });
    $('centerBody').querySelectorAll('[data-evaldone]').forEach(function (b) { b.onclick = async function () { b.disabled = true; await sb.from('eval_requests').update({ status: 'done' }).eq('id', parseInt(b.getAttribute('data-evaldone'), 10)); await loadEvals(); renderCenter(); }; });
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
  var OPS = { tab: 'board', date: '', venue: null, edit: null, games: [], checkins: [], help: [], bulletins: [], alerts: [] };
  function shiftDate(iso, n) { var d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return iso.length ? iso.slice(0, 0) + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : iso; }
  async function loadOps_() {
    if (!OPS.date) OPS.date = todayStr();
    var g = await fetchAll(function () { return sb.from('games').select('game_id,kickoff,field,age_group,competition,cr,ar1,ar2,fourth,venue,status,game_num,hq_role,hq_staff,home,away').eq('date', OPS.date).not('status', 'in', '(C,X,canceled_no_pay)').order('venue').order('kickoff'); });
    OPS.games = g.data || [];
    var ci = await fetchAll(function () { return sb.from('checkins').select('ref_name,game_id,created_at').eq('date', OPS.date).order('created_at'); });
    OPS.checkins = ci.data || [];
    var h = await sb.from('emergencies').select('id,src_key,created_at,ref_name,venue,field,reason,status,ack_by').gte('created_at', OPS.date + 'T00:00:00').lte('created_at', OPS.date + 'T23:59:59').order('created_at', { ascending: false });
    OPS.help = h.data || [];
    var b = await sb.from('announcements').select('id,src_key,created_at,start_date,end_date,venue,event_id,title,body,severity,active,posted_by').order('created_at', { ascending: false }).limit(40);
    OPS.bulletins = b.data || [];
    var namesHere = {}; OPS.games.forEach(function (g) { ['cr', 'ar1', 'ar2', 'fourth'].forEach(function (k) { if (g[k]) namesHere[g[k]] = 1; }); });
    var nl = Object.keys(namesHere); OPS.seen = {};
    for (var i = 0; i < nl.length; i += 200) {
      var sn = await sb.from('observations').select('ref_name').in('ref_name', nl.slice(i, i + 200)).in('cleanup_status', ['approved', 'edited']).limit(1000);
      (sn.data || []).forEach(function (o) { OPS.seen[key(o.ref_name)] = 1; });
    }
    var al = await sb.from('alerts').select('id,kind,game_id,ref_name,position,game_date,venue,field,kickoff,age_group,detail,status,seen_by').gte('game_date', todayStr()).order('game_date').order('kickoff').limit(300);
    OPS.alerts = al.data || [];
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
    return order.map(function (k) {
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
    }).join('');
  }
  function inSet() { var s = {}; OPS.checkins.forEach(function (c) { s[key(c.ref_name)] = c.created_at; }); return s; }
  function renderOps() {
    var tabs = ['board', 'protection', 'retain', 'bulletins'];
    var openAlerts = OPS.alerts.filter(function (a) { return a.status === 'open'; }).length;
    var head = '<div class="tabs">' + tabs.map(function (k) { return '<button class="chip-btn' + (OPS.tab === k ? ' on' : '') + '" data-otab="' + k + '">' + esc(t('tab' + k.charAt(0).toUpperCase() + k.slice(1))) + (k === 'protection' && openAlerts ? ' ' + openAlerts : '') + '</button>'; }).join('') + '</div>';
    var body = '';
    if (OPS.tab === 'board') {
      var ins = inSet(), venues = {};
      OPS.games.forEach(function (g) {
        var v = venues[g.venue] = venues[g.venue] || { name: g.venue, games: 0, slots: 0, in: 0, help: 0 };
        v.games++;
        ['cr', 'ar1', 'ar2', 'fourth'].forEach(function (k) { if (g[k]) { v.slots++; if (ins[key(g[k])]) v.in++; } });
      });
      OPS.help.forEach(function (h) { if (h.status === 'open' && venues[h.venue]) venues[h.venue].help++; });
      var vlist = Object.keys(venues).sort().map(function (k) { return venues[k]; });
      var totIn = 0, totSlots = 0; vlist.forEach(function (v) { totIn += v.in; totSlots += v.slots; });
      var open = OPS.help.filter(function (h) { return h.status === 'open'; }).length;
      body = '<div class="datebar"><button class="iconbtn" data-day="-1" aria-label="Previous day">&#8249;</button><div class="d">' + esc(dayLong(OPS.date)) + '</div><button class="iconbtn" data-day="1" aria-label="Next day">&#8250;</button></div>' +
        '<div class="stats" style="grid-template-columns:repeat(4,1fr)"><div class="stat"><b>' + vlist.length + '</b><i>' + esc(t('stVenues')) + '</i></div><div class="stat"><b>' + OPS.games.length + '</b><i>' + esc(t('stGames')) + '</i></div><div class="stat green"><b>' + totIn + '</b><i>' + esc(t('stCheckedIn')) + ' / ' + totSlots + '</i></div><div class="stat' + (open ? ' red' : '') + '"><b>' + open + '</b><i>' + esc(t('stHelpOpen')) + '</i></div></div>';
      if (!vlist.length) body += '<div class="card"><div class="hint">' + esc(t('noGamesDay')) + '</div></div>';
      else if (!OPS.venue && vlist.length > 8) {
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
        body += '<div class="pad" style="padding-top:12px"><button class="btn outline small" data-venue="">' + esc(t('allVenues')) + '</button></div><div class="disp h2">' + esc(OPS.venue) + '</div>' +
          (helps.length ? helps.map(function (h) { return '<div class="card" style="border-color:' + (h.status === 'open' ? 'var(--red)' : 'var(--line)') + '"><b>' + esc(h.reason || '') + '</b><div class="hint">' + esc(h.ref_name || '') + ', ' + esc(h.field || '') + ', ' + esc(clock(h.created_at)) + (h.status !== 'open' ? ', ' + esc(h.status) + (h.ack_by ? ' ' + esc(h.ack_by) : '') : '') + '</div>' + (h.status === 'open' && iCan('scheduling') ? '<div class="actions" style="padding:0"><button class="btn outline small" data-ack="enroute" data-key="' + esc(h.src_key) + '">' + esc(t('ackEnroute')) + '</button><button class="btn go small" data-ack="handled" data-key="' + esc(h.src_key) + '">' + esc(t('ackHandled')) + '</button></div>' : (h.status === 'open' ? '<div class="hint" style="color:var(--red)">' + esc(t('ackInOld')) + '</div>' : '')) + '</div>'; }).join('') : '') +
          hqCardHtml(games) + searchHtml() + slotsHtml(games, ins) +
          '<div class="list" style="display:' + (OPS.editForm ? '' : 'none') + '">' + games.filter(function (g) { return !OPS.editForm || String(g.game_id) === String(OPS.edit); }).map(function (g) {
            var crew = ['cr', 'ar1', 'ar2', 'fourth'].filter(function (k) { return g[k]; }).map(function (k) { var at = ins[key(g[k])]; return '<span class="' + (at ? 'in' : 'out') + '">' + esc(g[k]) + (at ? ' ' + esc(clock(at)) : (iCan('scheduling') || iCan('command_center') ? ' <button class="linkbtn" style="display:inline;min-height:0;padding:0 4px;color:var(--green);text-decoration:underline" data-checkin="' + esc(g[k]) + '" data-gid="' + esc(g.game_id) + '">' + esc(t('staffCheckin')) + '</button>' : '')) + '</span>'; }).join(', ');
            var edit = OPS.edit === String(g.game_id);
            var warn = OPS.alerts.filter(function (a) { return a.status === 'open' && String(a.game_id) === String(g.game_id); });
            var form = !edit ? '' : '<div class="card" style="margin:8px 0 0;gap:8px">' +
              ['cr', 'ar1', 'ar2', 'fourth'].map(function (k) { return '<label class="hint" for="sw-' + k + '">' + esc(t('role.' + k)) + '</label><input id="sw-' + k + '" value="' + esc(g[k] || '') + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">'; }).join('') +
              '<label class="hint" for="sw-field">' + esc(t('fieldLabel')) + '</label><input id="sw-field" value="' + esc(g.field || '') + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">' +
              '<div class="actions" style="padding:0"><button class="btn primary" data-save-switch="' + esc(g.game_id) + '">' + esc(t('saveChanges')) + '</button><button class="btn outline" data-cancel-switch="1">' + esc(t('neverMind')) + '</button></div><div class="msg bad" id="sw-msg" hidden></div></div>';
            return '<div class="item" style="flex-direction:column;align-items:stretch;gap:2px"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><div class="when"><div class="disp">' + esc(clock(g.kickoff)) + '</div><div class="sub">' + esc(g.field || '') + ', ' + esc(g.age_group || '') + (g.game_num ? ', ' + esc(g.game_num) : '') + '</div></div>' + (iCan('scheduling') && !edit ? '<button class="linkbtn" data-switch="' + esc(g.game_id) + '">' + esc(t('change')) + '</button>' : '') + '</div><div class="crewline">' + crew + '</div>' + (warn.length ? '<div class="hint" style="color:#8A6A00;font-weight:700">' + esc(t('alertOnGame').replace('{n}', warn.length)) + '</div>' : '') + form + '</div>';
          }).join('') + '</div>';
      }
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
    } else {
      var today = todayStr();
      body = '<div class="pad lead" style="padding-top:12px">' + esc(t('bulletinsLead')) + '</div>' +
        '<div class="card" style="gap:10px"><b>' + esc(t('newBulletin')) + '</b><label class="hint" for="bulTitle">' + esc(t('bulTitle')) + '</label><input id="bulTitle" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"><label class="hint" for="bulBody">' + esc(t('bulBody')) + '</label><textarea id="bulBody" style="min-height:90px"></textarea>' +
        '<div class="grid2"><div><label class="hint" for="bulFrom">' + esc(t('bulFrom')) + '</label><input id="bulFrom" type="date" value="' + today + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"></div><div><label class="hint" for="bulTo">' + esc(t('bulTo')) + '</label><input id="bulTo" type="date" value="' + today + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"></div></div>' +
        '<button class="btn primary" id="bulPost">' + esc(t('bulPost')) + '</button><div class="msg" id="bulMsg" hidden></div></div>' +
        OPS.bulletins.map(function (b) {
          var state = !b.active ? 'over' : (b.end_date && b.end_date < today) ? 'over' : (b.start_date && b.start_date > today) ? 'future' : 'live';
          return '<div class="card" style="gap:6px"><div style="display:flex;justify-content:space-between;gap:8px"><b>' + esc(b.title || '') + '</b><span class="pill' + (state === 'live' ? ' ok' : '') + '">' + esc(t(state === 'live' ? 'bulletinLive' : state === 'future' ? 'bulletinFuture' : 'bulletinOver')) + '</span></div><div style="font-size:15px">' + esc(b.body || '') + '</div><div class="hint">' + esc(b.start_date || '') + (b.end_date && b.end_date !== b.start_date ? ' to ' + esc(b.end_date) : '') + (b.venue ? ', ' + esc(b.venue) : '') + (b.posted_by ? ', ' + esc(b.posted_by) : '') + '</div>' + (b.active && state !== 'over' ? '<button class="btn outline small" data-clear="' + esc(b.src_key) + '">' + esc(t('bulClear')) + '</button>' : '') + '</div>';
        }).join('');
    }
    $('opsBody').innerHTML = head + body;
    $('opsBody').querySelectorAll('[data-otab]').forEach(function (b) { b.onclick = function () { OPS.tab = b.getAttribute('data-otab'); if (OPS.tab === 'retain' && !CC.cov.length) loadCenter().then(renderOps); else renderOps(); }; });
    $('opsBody').querySelectorAll('[data-day]').forEach(function (b) { b.onclick = function () { OPS.date = shiftDate(OPS.date, parseInt(b.getAttribute('data-day'), 10)); OPS.venue = null; loadOps().then(renderOps); }; });
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
    var query = sb.from('people').select('id,first_name,last_name,city,dob').limit(20);
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
    }).join('') + '</div>' : '<div class="card"><div class="hint">' + esc(t('noMatch')) + '</div></div>');
    $('peopleResults').querySelectorAll('[data-person]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); if (LINK.pick) { linkTo(parseInt(a.getAttribute('data-person'), 10), null); PP.q = ''; $('peopleQ').value = ''; return; } openPerson(a.getAttribute('data-person')); }; });
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
      '<div class="msg" id="ppMsg" hidden></div></div>';
    $('personCard').querySelectorAll('[data-give]').forEach(function (b) { b.onclick = async function () { b.disabled = true; var r = await sb.rpc('give_title', { p_person: p.id, p_code: b.getAttribute('data-give') }); if (r.error) { say('ppMsg', r.error.message, 'bad'); b.disabled = false; return; } await openPerson(p.id); say('ppMsg', t('titleGiven') + ': ' + b.textContent, 'good'); }; });
    $('personCard').querySelectorAll('[data-take]').forEach(function (b) { b.onclick = async function () { var r = await sb.rpc('take_title', { p_person: p.id, p_code: b.getAttribute('data-take') }); if (r.error) { say('ppMsg', r.error.message, 'bad'); return; } await openPerson(p.id); say('ppMsg', t('titleTaken'), 'good'); }; });
  }

  // ── Setup: events ────────────────────────────────────────────────
  var SU = { events: [], venues: [], sites: [], leagues: [], ev: null, vq: '', check: null };
  var TOOLS = ['hub', 'coaching', 'checkin', 'scoreboard', 'scoreentry', 'rules', 'screports', 'incident'];
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24); }
  async function loadSetup_() {
    var e = await sb.from('events').select('id,name,type,year,start_date,end_date,site_id,league,venues,tools,url,accent,blurb,active,alert_emails,game_prefix,rules_url').order('start_date', { ascending: false }).limit(200);
    SU.events = e.data || [];
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
    if (!ev.venues.length) m.push(t('evVenues'));
    if (!ev.tools.length) m.push(t('evTools'));
    return m;
  }
  function renderSetup() {
    var ev = SU.ev;
    if (!ev) {
      $('setupBody').innerHTML = '<div class="pad" style="padding-top:12px"><button class="btn primary" id="evNew" style="width:100%">' + esc(t('newEvent')) + '</button></div><div class="list">' + SU.events.map(function (e) {
        return '<a class="item" href="#" data-ev="' + esc(e.id) + '"><div><b>' + esc(e.name || e.id) + '</b> <span class="pill' + (e.active ? ' ok' : '') + '">' + esc(e.active ? t('evOn') : t('evOff')) + '</span><br><span class="hint">' + esc(e.type || '') + ', ' + esc(e.start_date || '') + (e.end_date && e.end_date !== e.start_date ? ' to ' + esc(e.end_date) : '') + ', ' + esc((e.venues || []).join(', ')) + (e.game_prefix ? ', ' + esc(e.game_prefix) : '') + '</span></div><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8 4l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>';
      }).join('') + '</div>';
      $('evNew').onclick = function () { SU.ev = blankEvent(); SU.check = null; renderSetup(); };
      $('setupBody').querySelectorAll('[data-ev]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); var src = SU.events.filter(function (x) { return x.id === a.getAttribute('data-ev'); })[0]; SU.ev = JSON.parse(JSON.stringify(src)); SU.ev.venues = SU.ev.venues || []; SU.ev.tools = SU.ev.tools || []; SU.ev.alert_emails = SU.ev.alert_emails || []; SU.check = null; renderSetup(); }; });
      return;
    }
    var inp = function (id, v, type, extra) { return '<input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(v == null ? '' : v) + '" ' + (extra || '') + ' style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">'; };
    var vlist = SU.venues.filter(function (v) { return !SU.vq || v.toLowerCase().indexOf(SU.vq) >= 0 || ev.venues.indexOf(v) >= 0; }).slice(0, 40);
    var missing = evMissing(ev);
    $('setupBody').innerHTML =
      '<div class="pad" style="padding-top:12px"><button class="linkbtn" id="evBack" style="padding-left:0">&#8249; ' + esc(t('back')) + '</button></div>' +
      '<div class="card" style="gap:10px">' +
      '<label class="hint" style="font-weight:700" for="evName">' + esc(t('evName')) + '</label>' + inp('evName', ev.name) +
      '<label class="hint" style="font-weight:700" for="evId">' + esc(t('evId')) + '</label>' + inp('evId', ev.id, 'text', ev.isNew ? '' : 'disabled') +
      '<div class="hint" style="font-weight:700">' + esc(t('evType')) + '</div><div class="chips"><button class="chip-btn' + (ev.type !== 'league' ? ' on' : '') + '" data-type="tournament">' + esc(t('evTournament')) + '</button><button class="chip-btn' + (ev.type === 'league' ? ' on' : '') + '" data-type="league">' + esc(t('evLeague')) + '</button></div>' +
      '<div class="hint" style="font-weight:700">' + esc(t('evDates')) + '</div><div class="grid2">' + inp('evStart', ev.start_date, 'date') + inp('evEnd', ev.end_date, 'date') + '</div>' +
      '</div>' +
      '<div class="card" style="gap:10px"><div class="hint" style="font-weight:700">' + esc(t('evVenues')) + '</div><div class="hint">' + esc(t('evVenuesHint')) + '</div>' + inp('evVq', SU.vq, 'search', 'placeholder="' + esc(t('evVenueSearch')) + '"') +
      '<div class="chips">' + vlist.map(function (v) { return '<button class="chip-btn' + (ev.venues.indexOf(v) >= 0 ? ' on' : '') + '" data-venue="' + esc(v) + '">' + esc(v) + '</button>'; }).join('') + '</div>' +
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
    $('evVq').oninput = function () { read(); SU.vq = $('evVq').value.trim().toLowerCase(); renderSetup(); $('evVq').focus(); var v = $('evVq'); v.setSelectionRange(v.value.length, v.value.length); };
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
  var EOD = { mine: [], all: [], date: '', venues: [], role: 'sc' };
  function canEod() { return iCan('coaching') || iCan('scheduling') || iCan('command_center'); }
  async function loadEod_() {
    var today = todayStr();
    var mine = await fetchAll(function () { return sb.from('eod_reports').select('id,date,venue,staff_name,role,time_in,time_out,hours,games_covered,incidents,notes').order('date', { ascending: false }).order('staff_name'); });
    var keys = S.me.nameKeys || [];
    EOD.all = mine.data || [];
    EOD.mine = EOD.all.filter(function (r) { return keys.indexOf(key(r.staff_name)) >= 0; });
    var g = await fetchAll(function () { return sb.from('games').select('venue').eq('date', today).not('status', 'in', '(C,X,canceled_no_pay)').order('venue'); });
    var vs = {}; (g.data || []).forEach(function (x) { if (x.venue) vs[x.venue] = 1; }); EOD.venues = Object.keys(vs).sort();
    if (!EOD.role) EOD.role = iCan('command_center') || iCan('scheduling') ? 'sc' : 'coach';
  }
  async function loadEod() { return load(loadEod_()); }
  function eodArchive(row) {
    var venues = {}; EOD.all.forEach(function (r) { if (r.venue) venues[r.venue] = 1; });
    var vlist = Object.keys(venues).sort();
    var rows = EOD.all.filter(function (r) { return !EOD.vfilter || r.venue === EOD.vfilter; });
    var days = {}, order = [];
    rows.forEach(function (r) { var d = r.date || ''; if (!days[d]) { days[d] = []; order.push(d); } days[d].push(r); });
    return '<div class="pad" style="padding-top:8px"><select id="eodVenueFilter" style="font:inherit;width:100%;padding:10px;border:2px solid var(--navy);border-radius:8px;background:var(--surface);color:var(--ink)"><option value="">' + esc(t('allVenuesPick')) + '</option>' + vlist.map(function (v) { return '<option value="' + esc(v) + '"' + (EOD.vfilter === v ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') + '</select></div>' +
      (order.length ? order.map(function (d) {
        var list = days[d], hours = 0; list.forEach(function (r) { hours += Number(r.hours || 0); });
        var open = EOD.open === d;
        return '<div class="pad"><button class="rowbtn" style="margin:8px 0 0;width:100%" data-eodday="' + esc(d) + '"><span><span class="t">' + esc(dayLong(d)) + '</span><br><span class="s">' + list.length + ' ' + esc(t(list.length === 1 ? 'eodReportOne' : 'eodReportMany')) + ', ' + hours.toFixed(1) + ' ' + esc(t('eodHours')) + '</span></span><span class="disp" style="font-size:22px">' + (open ? '\u2212' : '+') + '</span></button>' + (open ? list.map(row).join('') : '') + '</div>';
      }).join('') : '<div class="pad hint">' + esc(t('eodNone')) + '</div>');
  }
  function hhmm(v) { return v ? String(v).slice(0, 5) : ''; }
  function renderEod() {
    var today = todayStr(), roles = ['sc', 'sm', 'coach', 'mentor', 'other'];
    var venueField = EOD.venues.length ? '<select id="eodVenue" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">' + EOD.venues.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('') + '<option value="">' + esc(t('other')) + '</option></select>' : '<input id="eodVenue" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">';
    var row = function (r) { return '<div class="rowline"><div><b>' + esc(r.staff_name) + '</b> <span class="hint">' + esc(t('roles.' + (r.role || 'other'))) + '</span><br><span class="hint">' + esc(dayLong(r.date)) + ', ' + esc(r.venue || '') + ', ' + esc(hhmm(r.time_in)) + ' to ' + esc(hhmm(r.time_out)) + (r.notes ? '. ' + esc(r.notes) : '') + '</span></div><div class="n">' + esc(r.hours != null ? r.hours : '') + '</div></div>'; };
    $('eodBody').innerHTML =
      '<div class="card" style="gap:10px"><div class="hint" style="font-weight:700">' + esc(t('eodRole')) + '</div><div class="chips">' + roles.map(function (k) { return '<button class="chip-btn' + (EOD.role === k ? ' on' : '') + '" data-role="' + k + '">' + esc(t('roles.' + k)) + '</button>'; }).join('') + '</div>' +
      '<label class="hint" style="font-weight:700" for="eodDate">' + esc(t('evDates')) + '</label><input id="eodDate" type="date" value="' + (EOD.date || today) + '" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)">' +
      '<label class="hint" style="font-weight:700" for="eodVenue">' + esc(t('eodVenue')) + '</label>' + venueField +
      '<div class="grid2"><div><label class="hint" style="font-weight:700" for="eodIn">' + esc(t('eodIn')) + '</label><input id="eodIn" type="time" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"></div><div><label class="hint" style="font-weight:700" for="eodOut">' + esc(t('eodOut')) + '</label><input id="eodOut" type="time" style="font:inherit;width:100%;padding:10px;border:1px solid var(--muted);border-radius:8px;background:var(--surface);color:var(--ink)"></div></div>' +
      '<div class="hint">' + esc(t('eodCounted')) + '</div>' +
      '<label class="hint" style="font-weight:700" for="eodNotes">' + esc(t('eodNotes')) + '</label><textarea id="eodNotes" placeholder="' + esc(t('eodNotesPlaceholder')) + '" style="min-height:100px"></textarea>' +
      '<button class="btn primary" id="eodFile">' + esc(t('eodFile')) + '</button><div class="msg" id="eodMsg" hidden></div></div>' +
      '<div class="disp h2">' + esc(t('eodMine')) + '</div><div class="pad">' + (EOD.mine.length ? EOD.mine.slice(0, 10).map(row).join('') : '<div class="hint">' + esc(t('eodNone')) + '</div>') + '</div>' +
      (iCan('command_center') ? '<div class="disp h2">' + esc(t('eodAll')) + '</div>' + eodArchive(row) : '');
    var vf = $('eodVenueFilter'); if (vf) vf.onchange = function () { EOD.vfilter = vf.value; EOD.date = $('eodDate').value; renderEod(); };
    $('eodBody').querySelectorAll('[data-eodday]').forEach(function (b) { b.onclick = function () { var d = b.getAttribute('data-eodday'); EOD.open = EOD.open === d ? null : d; EOD.date = $('eodDate').value; renderEod(); }; });
    $('eodBody').querySelectorAll('[data-role]').forEach(function (b) { b.onclick = function () { EOD.role = b.getAttribute('data-role'); EOD.date = $('eodDate').value; renderEod(); }; });
    $('eodFile').onclick = async function () {
      var tin = $('eodIn').value, tout = $('eodOut').value;
      if (!tin || !tout) { say('eodMsg', t('eodBothTimes'), 'bad'); return; }
      var b = $('eodFile'); b.disabled = true; b.textContent = t('eodFiling');
      var venue = $('eodVenue').value, ev = null;
      S.events.forEach(function (e) { if (!ev && (e.venues || []).some(function (v) { return key(v) === key(venue); })) ev = e; });
      try {
        var j = await post({ action: 'scReport', event: ev ? ev.id : '', date: $('eodDate').value, venue: venue, scName: S.me.first_name + ' ' + S.me.last_name, role: EOD.role, timeIn: tin, timeOut: tout, notes: $('eodNotes').value.trim() });
        await loadEod(); renderEod();
        say('eodMsg', t('eodFiled') + (j.hours != null ? ' ' + j.hours + ' ' + t('eodHours') + '.' : ''), 'good');
        $('eodMsg').scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) { b.disabled = false; b.textContent = t('eodFile'); say('eodMsg', t('reviewFailed') + ' ' + (e.message || ''), 'bad'); }
    };
  }

  // ── A referee's card: from any name, anywhere ────────────────────
  function canSeeRef() { return iCan('coaching') || iCan('review') || iCan('command_center'); }
  function refLink(name) {
    if (!name || !canSeeRef() || /^(tbd|open|none)$/i.test(name)) return esc(name || '');
    return '<a class="refname" href="#ref/' + encodeURIComponent(name) + '">' + esc(name) + '</a>';
  }
  async function renderRef(name) {
    $('refBack').href = REF.from || '#day';
    $('refBody').innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>';
    busy(true);
    var card = await sb.rpc('ref_card', { p_name: name });
    var notes = await sb.from('observations').select('date,observer,rater_role,final_note,cleaned_note,field,cleanup_status,area').eq('ref_name', name).in('cleanup_status', ['approved', 'edited']).order('date', { ascending: false }).limit(20);
    busy(false);
    var c = card.data;
    if (!c) { $('refBody').innerHTML = '<div class="pad" style="padding-top:16px"><div class="disp" style="font-size:40px">' + esc(name) + '</div></div><div class="card"><div class="hint">' + esc(t('refNoRecord')) + '</div></div>'; return; }
    var titles = (c.titles || []).map(function (x) { return '<span class="pill' + (x.source === 'manual' ? ' ok' : '') + '" style="margin:4px 4px 0 0">' + esc(x.label) + '</span>'; }).join('');
    var stat = function (n, l, cls) { return '<div class="stat' + (cls ? ' ' + cls : '') + '"><b>' + (n == null ? '0' : esc(n)) + '</b><i>' + esc(l) + '</i></div>'; };
    $('refBody').innerHTML =
      '<div class="pad" style="padding-top:16px"><div class="lead">' + esc(t('refCardTitle')) + (c.city ? ', ' + esc(c.city) : '') + (c.green_badge ? ', ' + esc(t('greenBadge')) : '') + '</div><div class="disp" style="font-size:40px">' + esc(name) + '</div><div>' + (titles || '<span class="hint">' + esc(t('noneYet')) + '</span>') + '</div></div>' +
      '<div class="disp h2">' + esc(t('refSeason')) + '</div>' +
      '<div class="stats">' + stat(c.games, t('refGames')) + stat(c.as_center, t('refCenter')) + stat(c.evaluations, t('refEvals')) + '</div>' +
      '<div class="stats">' + stat(c.notes, t('refSeen'), c.notes ? 'green' : 'red') + stat(c.released, t('refReleased')) + stat(c.coaches, t('refCoaches')) + '</div>' +
      '<div class="pad hint" style="padding-top:8px">' + (c.first_game ? esc(t('refFirst')) + ' ' + esc(dayLong(c.first_game)) + ', ' : '') + (c.last_game ? esc(t('refLast')) + ' ' + esc(dayLong(c.last_game)) : '') + (c.last_seen ? '. ' + esc(t('refLastSeen')) + ' ' + esc(dayLong(c.last_seen)) : '') + '</div>' +
      (c.next_game ? '<div class="card" style="border-color:var(--gold);gap:4px"><b>' + esc(t('refNext')) + '</b><div>' + esc(dayLong(c.next_game)) + ', ' + esc(clock(c.next_kickoff)) + ', ' + esc(c.next_venue || '') + (c.next_field ? ', ' + esc(c.next_field) : '') + '</div><div class="hint">' + esc(t('refNextHint')) + '</div></div>' : '') +
      '<div class="disp h2">' + esc(t('refNotes')) + '</div>' + ((notes.data || []).length ? (notes.data || []).map(function (n) {
        return '<div class="note"><div class="who">' + esc(n.observer || '') + (n.rater_role ? ', ' + esc(n.rater_role) : '') + ', ' + esc(dayLong(n.date)) + (n.field ? ', ' + esc(n.field) : '') + (n.area ? ', ' + esc(t('areas.' + n.area)) : '') + '</div><div class="text">' + esc(n.final_note || n.cleaned_note || '') + '</div></div>';
      }).join('') : '<div class="card"><div class="hint">' + esc(t('refNoNotes')) + '</div></div>');
  }
  var REF = { from: '' };

  // ── Staff roster ─────────────────────────────────────────────────
  var STAFF = { rows: null, filter: '' };
  async function renderStaff() {
    if (!STAFF.rows) { busy(true); var r = await sb.rpc('staff_roster'); busy(false); STAFF.rows = r.data || []; }
    var all = {}; STAFF.rows.forEach(function (p) { (p.titles || []).forEach(function (x) { all[x.label] = (all[x.label] || 0) + 1; }); });
    var labels = Object.keys(all).sort(function (a, b) { return all[b] - all[a]; });
    var rows = STAFF.rows.filter(function (p) { return !STAFF.filter || (p.titles || []).some(function (x) { return x.label === STAFF.filter; }); });
    $('personCard').innerHTML = '';
    $('peopleResults').innerHTML = '<div class="pad" style="padding-top:12px"><div class="disp" style="font-size:30px">' + esc(t('staffTitle')) + ' ' + rows.length + '</div><div class="hint">' + esc(t('staffLead')) + '</div><div class="chips" style="margin-top:8px"><button class="chip-btn' + (!STAFF.filter ? ' on' : '') + '" data-sf="">' + esc(t('allVenuesPick').replace(/venues|sedes/i, '')) + '</button>' + labels.map(function (l) { return '<button class="chip-btn' + (STAFF.filter === l ? ' on' : '') + '" data-sf="' + esc(l) + '">' + esc(l) + ' <small>' + all[l] + '</small></button>'; }).join('') + '</div></div>' +
      '<div class="pad">' + rows.map(function (p) {
        return '<div class="rowline" style="align-items:flex-start"><div><a class="refname" href="#" data-open-person="' + p.id + '"><b>' + esc(p.first_name + ' ' + p.last_name) + '</b></a>' + (p.city ? ' <span class="hint">' + esc(p.city) + '</span>' : '') + '<br>' + (p.titles || []).map(function (x) { return '<span class="pill' + (x.source === 'manual' ? ' ok' : '') + '" style="margin:4px 4px 0 0">' + esc(x.label) + '</span>'; }).join('') + '</div></div>';
      }).join('') + '</div>';
    $('peopleResults').querySelectorAll('[data-sf]').forEach(function (b) { b.onclick = function () { STAFF.filter = b.getAttribute('data-sf'); renderStaff(); }; });
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
  function renderGame(id) {
    var g = S.games.filter(function (x) { return String(x.game_id) === String(id); })[0];
    S.game = g || null;
    if (!g) { show('s-day'); return; }
    var inAt = S.checkins[String(g.game_id)], mins = Math.round((new Date(g.kickoff).getTime() - Date.now()) / 60000);
    var ev = eventFor(g), r = rulesFor(g), role = myRole(g);
    var crew = ['cr', 'ar1', 'ar2', 'fourth'].filter(function (k) { return g[k]; }).map(function (k) { return esc(g[k]) + ' (' + esc(t('role.' + k)) + ')'; });
    $('gameBody').innerHTML =
      '<div class="pad" style="padding-top:16px"><div class="lead">' + esc(ev ? ev.name : g.competition || '') + (g.game_num ? ', ' + esc(g.game_num) : '') + ', ' + esc(dayLong(g.date)) + '</div>' +
      '<div class="row" style="display:flex;justify-content:space-between;align-items:baseline"><div class="disp" style="font-size:64px;line-height:.95">' + esc(clock(g.kickoff)) + '</div><div class="disp" style="font-size:64px;line-height:.95;color:var(--count)">' + esc(fieldShort(g.field)) + '</div></div>' +
      (mins > 0 ? '<div class="lead">' + esc(t('kicksIn')) + ' ' + mins + ' min</div>' : '') + '</div>' +
      '<div style="margin:14px 20px 0" id="gameCheckin">' + (inAt ? '<div class="btn done"><span class="disp">' + esc(t('checkedIn')) + '</span><small>' + esc(clock(inAt)) + '. ' + esc(t('checkedInAt')) + '</small></div>' : '<div class="actions" style="padding:0">' + checkinBtn(g, null) + '</div><div class="msg bad" id="ci-msg-' + esc(g.game_id) + '" hidden></div>') + '</div>' +
      '<div class="card"><div class="grid2"><div class="kv"><div class="k">' + esc(t('home')) + '</div><div class="v">' + esc(g.home || '') + '</div></div><div class="kv"><div class="k">' + esc(t('away')) + '</div><div class="v">' + esc(g.away || '') + '</div></div></div>' +
      '<div>' + esc(g.age_group || '') + (g.gender ? ', ' + esc(g.gender) : '') + (g.competition ? ', ' + esc(g.competition) : '') + '</div>' +
      '<div class="sep"><span class="hint">' + esc(t('crew')) + ':</span> ' + (crew.length > 1 ? crew.join(', ') : esc(myNameOn(g)) + ', ' + esc(t('role.' + role)) + '. ' + esc(t('alone'))) + '</div>' +
      (ev && ev.blurb ? '<div class="sep">' + esc(ev.blurb) + '</div>' : '') + '</div>' +
      '<div style="margin:14px 20px 0;display:grid;grid-template-columns:1fr 1fr;gap:10px">' + (r ? '<a class="btn outline" href="' + esc(r) + '">' + esc(t('rules')) + '</a>' : '<div class="hint" style="align-self:center">' + esc(t('rulesNotPosted')) + '</div>') + '<a class="btn outline" href="' + esc(C.oldHub) + 'index.html">' + esc(t('map')) + '</a></div>' +
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
  function evalRequestHtml(g) {
    if (new Date(g.kickoff).getTime() < Date.now()) return '';
    var req = (ER.mine || []).filter(function (r) { return String(r.game_id) === String(g.game_id); })[0];
    if (req) return '<div class="card" style="border-color:var(--gold);gap:4px"><b>' + esc(t('evalReqTitle')) + '</b><div>' + esc(t('evalPurpose.' + req.purpose)) + '. ' + esc(t('evalStatus.' + req.status)) + '</div></div>';
    return '<div class="card" style="gap:8px" id="evalReqCard"><b>' + esc(t('evalReqTitle')) + '</b><div class="hint">' + esc(t('evalReqLead')) + '</div><div class="chips">' + ['maintenance', 'upgrade_regional', 'upgrade_national'].map(function (p) { return '<button class="chip-btn' + (ER.purpose === p ? ' on' : '') + '" data-purpose="' + p + '">' + esc(t('evalPurpose.' + p)) + '</button>'; }).join('') + '</div><button class="btn outline" id="evalReqSend"' + (ER.purpose ? '' : ' disabled') + '>' + esc(t('evalReqSend')) + '</button><div class="msg" id="evalReqMsg" hidden></div></div>';
  }
  function wireEvalRequest(g) {
    $('gameBody').querySelectorAll('[data-purpose]').forEach(function (b) { b.onclick = function () { ER.purpose = b.getAttribute('data-purpose'); renderGame(g.game_id); }; });
    var send = $('evalReqSend');
    if (send) send.onclick = async function () {
      send.disabled = true;
      var r = await sb.from('eval_requests').insert({ org_id: S.me.org_id, ref_person_id: S.me.person_id, ref_name: myNameOn(g), purpose: ER.purpose, game_id: g.game_id, game_date: g.date, venue: g.venue });
      if (r.error) { send.disabled = false; say('evalReqMsg', r.error.message, 'bad'); return; }
      ER.purpose = null; await loadEvalRequests(); renderGame(g.game_id);
    };
  }
  async function loadEvalRequests() {
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
      var ev = eventFor(g);
      try {
        var res = await fetch(C.backend, { method: 'POST', body: JSON.stringify({ action: 'refPostScore', event: ev ? ev.id : '', gameId: g.game_id, date: g.date, homeScore: Number(h), awayScore: Number(a), refName: myNameOn(g) }) });
        var j = await res.json();
        if (!j || j.status !== 'ok') throw new Error(j && j.message || 'error');
        S.scores[String(g.game_id)] = { game_id: g.game_id, home_score: Number(h), away_score: Number(a), status: 'Reported', entered_by: myNameOn(g) };
        renderGame(g.game_id);
      } catch (e) { b.disabled = false; b.textContent = t('scoreSend'); say('scMsg', t('scoreFailed') + ' ' + (e.message || ''), 'bad'); }
    };
  }
  function renderNotes() {
    markRead(S.notes);
    $('notesList').innerHTML = S.notes.length ? S.notes.map(function (n) {
      return '<div class="note"><div class="who">' + esc(n.observer || '') + (n.rater_role ? ', ' + esc(n.rater_role) : '') + (n.date ? ', ' + esc(dayLong(n.date)) : '') + (n.field ? ', ' + esc(n.field) : '') + '</div><div class="text">' + esc(n.final_note || n.cleaned_note || '') + '</div></div>';
    }).join('') : '<div class="note"><div class="text hint">' + esc(t('noNotes')) + '</div></div>';
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
  function liveStart() {
    if (LIVE.channel || !sb.channel) return;
    try {
      LIVE.channel = sb.channel('hub-live');
      ['checkins', 'emergencies', 'scores', 'observations', 'announcements', 'coach_assignments', 'alerts'].forEach(function (table) {
        LIVE.channel.on('postgres_changes', { event: '*', schema: 'public', table: table }, function () { liveBump(); });
      });
      LIVE.channel.subscribe();
    } catch (e) { LIVE.channel = null; }
  }
  function liveBump() {
    clearTimeout(LIVE.timer);
    LIVE.timer = setTimeout(function () {
      var h = location.hash;
      if (h === '#ops') loadOps().then(renderOps);
      else if (h === '#center') loadCenter().then(renderCenter);
      else if (h === '#coach') loadCoach().then(renderCoach);
      else if (h.indexOf('#game/') === 0) loadDay().then(function () { renderGame(h.slice(6)); });
      else if (h === '' || h === '#day') loadDay().then(renderDay);
    }, 400);
  }

  // ── Routing ──────────────────────────────────────────────────────
  function route() {
    if (!S.me) { show('s-signin'); return; }
    var h = location.hash.replace(/^#/, '') || 'day';
    if (h.indexOf('coach') === 0 && !iCan('coaching')) { location.hash = '#day'; return; }
    if (h.indexOf('ref/') === 0) { if (!canSeeRef()) { location.hash = '#day'; return; } show('s-ref'); renderRef(decodeURIComponent(h.slice(4))); return; }
    if (h === 'eod') { if (!canEod()) { location.hash = '#day'; return; } $('eodBody').innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>'; show('s-eod'); loadEod().then(renderEod).catch(function (e) { $('eodBody').innerHTML = '<div class="msg bad">' + esc(t('reviewFailed') + ' ' + (e && e.message || '')) + '</div>'; }); return; }
    if (h === 'setup') { if (!iCan('setup')) { location.hash = '#day'; return; } $('setupBody').innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>'; show('s-setup'); SU.ev = null; loadSetup().then(renderSetup).catch(function (e) { $('setupBody').innerHTML = '<div class="msg bad">' + esc(t('reviewFailed') + ' ' + (e && e.message || '')) + '</div>'; }); return; }
    if (h === 'people') { if (!iCan('people')) { location.hash = '#day'; return; } show('s-people'); PP.person = null; $('personCard').innerHTML = ''; renderPeople(); setTimeout(function () { $('peopleQ').focus(); }, 50); return; }
    if (h === 'ops') { if (!iCan('command_center')) { location.hash = '#day'; return; } $('opsBody').innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>'; show('s-ops'); loadOps().then(renderOps).catch(function (e) { $('opsBody').innerHTML = '<div class="msg bad">' + esc(t('reviewFailed') + ' ' + (e && e.message || '')) + '</div>'; }); return; }
    if (h === 'center') { if (!iCan('review')) { location.hash = '#day'; return; } $('centerBody').innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>'; show('s-center'); loadCenter().then(renderCenter).catch(function (e) { $('centerBody').innerHTML = '<div class="msg bad">' + esc(t('reviewFailed') + ' ' + (e && e.message || '')) + '</div>'; }); return; }
    if (h === 'review') { if (!iCan('review')) { location.hash = '#day'; return; } $('reviewList').innerHTML = '<div class="card"><div class="hint">' + esc(t('loadingReview')) + '</div></div>'; show('s-review'); loadReview().then(renderReview).catch(function (e) { $('reviewList').innerHTML = '<div class="msg bad">' + esc(t('reviewFailed') + ' ' + (e && e.message || '')) + '</div>'; }); return; }
    if (h === 'coach') { loadCoach().then(function () { renderCoach(); }); show('s-coach'); }
    else if (h.indexOf('coach/game/') === 0) { (S.coach.games.length ? Promise.resolve() : loadCoach()).then(function () { renderCoachGame(h.slice(11)); }); show('s-coachgame'); }
    else if (h === 'coach/notes') { loadCoach().then(function () { renderMyNotes(); }); show('s-mynotes'); }
    else if (h.indexOf('game/') === 0) { renderGame(h.slice(5)); show('s-game'); }
    else if (h === 'notes') { renderNotes(); show('s-notes'); }
    else if (h === 'help') { renderHelp(); show('s-help'); }
    else { renderDay(); show('s-day'); }
  }
  function renderAll() { if (S.me) route(); }
  window.addEventListener('hashchange', function () { if (location.hash !== '#help') S.reason = null; });
  var LAST_HASH = '';
  window.addEventListener('hashchange', function (e) { var old = (e.oldURL || '').split('#')[1]; if (old != null && old.indexOf('ref/') !== 0) REF.from = '#' + old; });
  window.addEventListener('hashchange', route);

  async function start() {
    S.me = await loadMe();
    if (!S.me) { show('s-signin'); return; }
    if (S.me.language === 'es' && S.lang !== 'es') { S.lang = 'es'; applyWords(); }
    await loadDay();
    route();
    liveStart();
    setInterval(function () { if (!S.me) return; if (location.hash === '#ops' && OPS.tab === 'board') loadOps().then(renderOps); else if (location.hash.indexOf('game') < 0 && location.hash.indexOf('#') !== 0 || location.hash === '#day' || location.hash === '') renderDay(); }, 60000);
  }

  // ── Boot ─────────────────────────────────────────────────────────
  (function boot() {
    try { S.lang = localStorage.getItem('hub-lang') || 'en'; } catch (e) {}
    try { var th = localStorage.getItem('hub-theme'); if (th) setTheme(th); } catch (e) {}
    ['themeBtn0', 'themeBtn1', 'themeBtn2'].forEach(function (id) { $(id).onclick = toggleTheme; });
    ['langBtn0', 'langBtn1'].forEach(function (id) { $(id).onclick = function () { setLang(S.lang === 'es' ? 'en' : 'es'); }; });
    $('markSignin').src = C.marks.csa; $('markDay').src = C.marks.csa;
    ['markGame', 'markNotes', 'markHelp', 'markCoach', 'markCoachGame', 'markMyNotes', 'markReview', 'markCenter', 'markOps', 'markPeople', 'markSetup', 'markEod', 'markRef'].forEach(function (id) { $(id).src = C.marks.program; });
    ['ja0', 'ja1', 'ja2', 'ja3', 'ja4', 'ja5', 'ja6', 'ja7', 'ja8', 'ja9', 'ja10', 'ja11', 'ja12', 'ja13', 'ja14'].forEach(function (id) { $(id).src = C.marks.ja; });
    $('peopleQ').oninput = function () { var q = $('peopleQ').value.trim(); clearTimeout(PP.timer); PP.timer = setTimeout(function () { searchPeople(q); }, 300); };
    $('peopleQ').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(PP.timer); searchPeople($('peopleQ').value.trim()); } };
    $('staffBtn').onclick = function () { renderStaff(); };
    $('linkBtn').onclick = function () { LINK.rows = null; LINK.pick = null; renderLinks(); };
    $('peopleGo').onclick = function () { clearTimeout(PP.timer); searchPeople($('peopleQ').value.trim()); };
    $('signOut').onclick = async function (e) { e.preventDefault(); if (LIVE.channel) { try { sb.removeChannel(LIVE.channel); } catch (er) {} LIVE.channel = null; } await sb.auth.signOut(); S.me = null; location.hash = ''; show('s-signin'); };
    applyWords();
    document.querySelectorAll('.ver').forEach(function (el) { el.textContent = 'v' + VERSION; });
    sb.auth.getSession().then(function (r) { if (r.data && r.data.session) start(); else show('s-signin'); });
  })();
})();
