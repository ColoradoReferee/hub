// pacer.js · the interval test signal, shared by fitness.html and the Hub's results sheet.
// Long tone starts each run, short tone ends it (start of the walk), short tone ends the walk.
// Timing comes from the wall clock so re-rendering the page never drifts the beeps.
(function () {
  var ctx = null, timer = null, wake = null;
  var P = { on: false, run: 0, phase: 'rest', left: 0, runS: 15, walkS: 18, total: 40, onTick: null, onDone: null };

  function tone(freq, ms) {
    if (!ctx) return;
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = freq; g.gain.value = 0.7;
    o.connect(g); g.connect(ctx.destination);
    var t0 = ctx.currentTime;
    o.start(t0); g.gain.setValueAtTime(0.7, t0 + ms / 1000 - 0.03); g.gain.linearRampToValueAtTime(0, t0 + ms / 1000); o.stop(t0 + ms / 1000);
  }
  function tick() { if (P.onTick) P.onTick(P); }
  async function keepAwake() { try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) {} }
  function stop(done) {
    clearTimeout(timer); timer = null; P.on = false; P.phase = done ? 'done' : 'rest'; P.left = 0;
    if (wake) { try { wake.release(); } catch (e) {} wake = null; }
    tick(); if (done && P.onDone) P.onDone(P);
  }
  function start(runS, walkS, total) {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume();
    P.runS = runS; P.walkS = walkS; P.total = total || 40; P.run = 0; P.on = true; P.phase = 'ready'; keepAwake();
    var t0 = Date.now() + 10000, lastRun = 0, beepedWalk = -1;
    for (var i = 3; i >= 1; i--) setTimeout(tone.bind(null, 660, 150), 10000 - i * 1000);
    var step = function () {
      var elapsed = Date.now() - t0;
      if (elapsed < 0) { P.left = Math.ceil(-elapsed / 1000); tick(); timer = setTimeout(step, 100); return; }
      var cycle = (P.runS + P.walkS) * 1000, n = Math.floor(elapsed / cycle), inCycle = elapsed - n * cycle;
      if (n >= P.total) { tone(880, 900); P.run = P.total; stop(true); return; }
      if (n + 1 !== lastRun) { lastRun = n + 1; P.run = lastRun; tone(880, 600); }
      if (inCycle < P.runS * 1000) { P.phase = 'run'; P.left = Math.ceil((P.runS * 1000 - inCycle) / 1000); }
      else { if (beepedWalk !== n) { beepedWalk = n; tone(523, 250); } P.phase = 'walk'; P.left = Math.ceil((cycle - inCycle) / 1000); }
      tick(); timer = setTimeout(step, 100);
    };
    step();
  }
  // A WAV of the whole signal, built here so nothing big lives on the server. 8 kHz, 8-bit, mono.
  function wav(runS, walkS, total) {
    total = total || 40;
    var sr = 8000, secs = 10 + (runS + walkS) * total + 2, N = sr * secs, pcm = new Uint8Array(N).fill(128);
    var put = function (atS, freq, ms) { var s0 = Math.floor(atS * sr), len = Math.floor(ms / 1000 * sr); for (var i = 0; i < len && s0 + i < N; i++) { var env = i > len - 240 ? (len - i) / 240 : 1; pcm[s0 + i] = 128 + Math.round(100 * env * Math.sin(2 * Math.PI * freq * i / sr)); } };
    for (var c = 3; c >= 1; c--) put(10 - c, 660, 150);
    for (var n = 0; n < total; n++) { var at = 10 + n * (runS + walkS); put(at, 880, 600); put(at + runS, 523, 250); }
    put(10 + total * (runS + walkS), 880, 900);
    var head = new ArrayBuffer(44), v = new DataView(head), str = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + N, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, 'data'); v.setUint32(40, N, true);
    return new Blob([head, pcm], { type: 'audio/wav' });
  }
  function download(runS, walkS, total) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(wav(runS, walkS, total)); a.download = 'fitness-interval-' + runS + '-' + walkS + '.wav'; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  window.Pacer = { state: P, start: start, stop: function () { stop(false); }, download: download };
})();
