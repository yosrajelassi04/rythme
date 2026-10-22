(() => {
  "use strict";
  const SR = 16000, HOP = 160, WIN = 512;
  // Les langues, les phrases et les enregistrements sont lus dans data/clips.json.
  let LANGS = [], LANG = {};
  let CLIPS = [], SENT = {}, SENT_ORDER = [];
  // enregistrements d'une langue, dans l'ordre : phrases FLEURS communes d'abord, puis les phrases propres à la langue
  const clipsOf = lang => CLIPS.filter(c => c.lang === lang).sort((a, b) => {
    const ia = SENT_ORDER.indexOf(a.sent), ib = SENT_ORDER.indexOf(b.sent);
    return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib) || a.id.localeCompare(b.id);
  });
  const shorten = t => t.length > 48 ? t.slice(0, 46) + "…" : t;
  let builtFor = null;
  function buildSentenceMenu() {
    if (builtFor === state.lang) return;
    builtFor = state.lang;
    const sel = $("sentSel"); sel.innerHTML = "";
    const hide = LANG[state.lang] && LANG[state.lang].hideText;
    clipsOf(state.lang).forEach((c, k) => sel.add(new Option(hide ? `Enregistrement ${k + 1}` : `${k + 1}. ${shorten(SENT[c.sent] || c.text)}`, String(k))));
  }

  const MEASURES = [
    { key: "pV", label: "%V", unit: "%", hint: "part vocalique", dec: 1 },
    { key: "dC", label: "ΔC", unit: "ms", hint: "écart-type C", dec: 0 },
    { key: "dV", label: "ΔV", unit: "ms", hint: "écart-type V", dec: 0 },
    { key: "varcoC", label: "VarcoC", unit: "", hint: "ΔC / moyenne", dec: 1 },
    { key: "varcoV", label: "VarcoV", unit: "", hint: "ΔV / moyenne", dec: 1 },
    { key: "nPVIv", label: "nPVI-V", unit: "", hint: "voisins vocaliques", dec: 1 },
    { key: "rPVIc", label: "rPVI-C", unit: "ms", hint: "voisins consonantiques", dec: 0 }
  ];

  // ---------- Analyse du signal ----------
  const hann = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WIN - 1));

  // filtre passe-haut d'ordre 4 (deux biquads de Butterworth en cascade)
  function highpass(x, fc) {
    const w0 = 2 * Math.PI * fc / SR, al = Math.sin(w0) / (2 * Math.SQRT1_2), c = Math.cos(w0), a0 = 1 + al;
    const b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, b2 = (1 + c) / 2 / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
    let y = x;
    for (let pass = 0; pass < 2; pass++) {
      const out = new Float32Array(y.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let n = 0; n < y.length; n++) { const v = y[n], o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = o; out[n] = o; }
      y = out;
    }
    return y;
  }

  async function computeFrames(x) {
    let mean = 0; for (let i = 0; i < x.length; i++) mean += x[i]; mean /= x.length || 1;
    const n = 1 + Math.max(0, Math.floor((x.length - WIN) / HOP));
    const E = new Float32Array(n), R = new Float32Array(n), Z = new Float32Array(n);
    const lo = Math.floor(SR / 400), hi = Math.floor(SR / 70), L = WIN - hi;
    const f = new Float32Array(WIN);
    for (let i = 0; i < n; i++) {
      const off = i * HOP;
      for (let k = 0; k < WIN; k++) { const j = off + k; f[k] = j < x.length ? x[j] - mean : 0; }
      let e = 0; for (let k = 0; k < WIN; k++) { const v = f[k] * hann[k]; e += v * v; }
      E[i] = 10 * Math.log10(e / WIN + 1e-12);
      // taux de passage par zéro : élevé pour les fricatives (s, f, ch), faible pour un silence ou une occlusion
      let zc = 0; for (let k = 1; k < WIN; k++) if ((f[k] >= 0) !== (f[k - 1] >= 0)) zc++;
      Z[i] = zc / (WIN - 1);
      let ea = 0; for (let k = 0; k < L; k++) ea += f[k] * f[k];
      let best = 0;
      if (ea > 0) {
        for (let t = lo; t < hi; t++) {
          let d = 0, eb = 0;
          for (let k = 0; k < L; k++) { const b = f[k + t]; d += f[k] * b; eb += b * b; }
          const r = d / Math.sqrt(ea * eb + 1e-12);
          if (r > best) best = r;
        }
      }
      R[i] = best;
      if (i % 150 === 149) await new Promise(r => setTimeout(r, 0));
    }
    return { E, R, Z };
  }

  function percentile(arr, p) {
    const s = Array.from(arr).sort((a, b) => a - b);
    const idx = (s.length - 1) * p / 100, lo = Math.floor(idx), hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  }

  function segment(E, R, Z, opt) {
    const n = E.length;
    // le bruit de fond est estimé sans les trames de silence numérique (signal exactement nul, souvent ajouté en début ou fin de fichier)
    const live = Array.from(E).filter(v => v > -100);
    const floor = percentile(live.length ? live : E, 10), ref = percentile(E, 97);
    // silence si l'énergie est proche du bruit de fond, ou plus de 35 dB sous le niveau de la parole
    const thr = Math.max(floor + Math.max(6, opt.silf * (ref - floor)), ref - 35);
    let lab = new Array(n);
    // silence : énergie très faible, ou trame faible, non périodique et sans bruit de friction (creux entre deux mots, occlusion)
    const quietThr = floor + 0.45 * (ref - floor);
    for (let i = 0; i < n; i++) {
      const quiet = E[i] < thr || (R[i] <= opt.vthr && Z[i] < 0.2 && E[i] < quietThr);
      lab[i] = quiet ? "P" : (R[i] > opt.vthr ? "V" : "C");
    }
    // lissage par vote majoritaire sur 5 trames
    const sm = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = { P: 0, V: 0, C: 0 }; const order = [];
      for (let j = Math.max(0, i - 2); j < Math.min(n, i + 3); j++) { if (!c[lab[j]]) order.push(lab[j]); c[lab[j]]++; }
      let mx = 0; for (const k of order) if (c[k] > mx) mx = c[k];
      // en cas d'égalité, on garde l'étiquette de la trame centrale
      sm[i] = c[lab[i]] === mx ? lab[i] : order.find(k => c[k] === mx);
    }
    lab = sm;
    if (opt.mode === "vocalic") {
      const Es = new Float32Array(n);
      for (let i = 0; i < n; i++) { let s = 0; for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < n) s += E[j]; Es[i] = s / 5; }
      const newV = new Uint8Array(n);
      let i = 0;
      while (i < n) {
        if (lab[i] !== "V") { i++; continue; }
        let j = i; while (j < n && lab[j] === "V") j++;
        const seg = Es.subarray(i, j), m = seg.length;
        const peaks = [];
        for (let k = 0; k < m; k++) {
          let mx = -Infinity; for (let q = Math.max(0, k - 3); q < Math.min(m, k + 4); q++) if (seg[q] > mx) mx = seg[q];
          if (seg[k] === mx) {
            if (peaks.length && k - peaks[peaks.length - 1] < 5) { if (seg[k] > seg[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = k; continue; }
            peaks.push(k);
          }
        }
        const kept = [];
        for (const p of peaks) {
          if (kept.length) {
            const last = kept[kept.length - 1];
            let mn = Infinity; for (let q = Math.min(last, p); q <= Math.max(last, p); q++) if (seg[q] < mn) mn = seg[q];
            if (mn > Math.min(seg[last], seg[p]) - 2) { if (seg[p] > seg[last]) kept[kept.length - 1] = p; continue; }
          }
          kept.push(p);
        }
        for (const p of kept) {
          // une voyelle est forte : un pic plus de 25 dB sous le niveau de la parole est du bruit ou une consonne voisée
          if (seg[p] < ref - 25) continue;
          const lim = seg[p] - 6;
          let a = p; while (a > 0 && seg[a - 1] > lim) a--;
          let b = p; while (b < m - 1 && seg[b + 1] > lim) b++;
          for (let q = a; q <= b; q++) newV[i + q] = 1;
        }
        i = j;
      }
      lab = lab.map((l, k) => l === "P" ? "P" : (newV[k] ? "V" : "C"));
    }
    // intervalles
    let runs = [];
    for (let k = 0; k < n; k++) {
      if (runs.length && runs[runs.length - 1].t === lab[k]) runs[runs.length - 1].b = k + 1;
      else runs.push({ t: lab[k], a: k, b: k + 1 });
    }
    // un silence plus court que la durée minimale d'une pause est marqué « S » (silence court) :
    // occlusion d'une consonne (p, t, k) ou micro-pause entre deux mots
    for (const r of runs) if (r.t === "P" && (r.b - r.a) * HOP / SR < opt.minPause) r.t = "S";
    const out = [];
    for (const r of runs) {
      if (out.length && (r.b - r.a) * HOP / SR < 0.02) out[out.length - 1].b = r.b;
      else if (out.length && out[out.length - 1].t === r.t) out[out.length - 1].b = r.b;
      else out.push({ ...r });
    }
    const m = [];
    for (const r of out) { if (m.length && m[m.length - 1].t === r.t) m[m.length - 1].b = r.b; else m.push(r); }
    const vIdx = m.map((r, k) => r.t === "V" ? k : -1).filter(k => k >= 0);
    if (vIdx.length) m.forEach((r, k) => { if (k < vIdx[0] || k > vIdx[vIdx.length - 1]) r.t = "P"; });
    const fin = [];
    for (const r of m) { if (fin.length && fin[fin.length - 1].t === r.t) fin[fin.length - 1].b = r.b; else fin.push(r); }
    // un fragment de parole isolé entre deux pauses et plus court que 80 ms est du bruit : on le traite comme une pause
    for (let k = 0; k < fin.length; k++) {
      if (fin[k].t === "P") continue;
      let j = k; while (j < fin.length && fin[j].t !== "P") j++;
      if ((fin[j - 1].b - fin[k].a) * HOP / SR < 0.08) for (let q = k; q < j; q++) fin[q].t = "P";
      k = j;
    }
    const clean = [];
    for (const r of fin) { if (clean.length && clean[clean.length - 1].t === r.t) clean[clean.length - 1].b = r.b; else clean.push({ ...r }); }
    return clean.map(r => ({ t: r.t, s: r.a * HOP / SR, e: r.b * HOP / SR }));
  }

  // intervalles utilisés pour les mesures : les silences courts comptent comme consonantiques ou comme pauses, selon le réglage
  function intervals(segs) {
    const out = [];
    for (const g of segs) {
      const t = g.t === "S" ? (opt.shortSil ? "C" : "P") : g.t;
      if (out.length && out[out.length - 1].t === t) out[out.length - 1].e = g.e;
      else out.push({ t, s: g.s, e: g.e });
    }
    return out;
  }

  function std(a) { if (a.length < 2) return NaN; const mu = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - mu) ** 2, 0) / (a.length - 1)); }
  function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN; }

  function measures(raw) {
    const segs = intervals(raw);
    const chunks = [[]];
    for (const g of segs) { if (g.t === "P") { chunks.push([]); continue; } chunks[chunks.length - 1].push({ t: g.t, d: (g.e - g.s) * 1000 }); }
    const V = [], C = [], pv = [], pc = [];
    for (const ch of chunks) {
      const v = ch.filter(x => x.t === "V").map(x => x.d), c = ch.filter(x => x.t === "C").map(x => x.d);
      V.push(...v); C.push(...c);
      for (let k = 0; k + 1 < v.length; k++) pv.push(Math.abs(v[k] - v[k + 1]) / ((v[k] + v[k + 1]) / 2));
      for (let k = 0; k + 1 < c.length; k++) pc.push(Math.abs(c[k] - c[k + 1]));
    }
    const sV = V.reduce((s, v) => s + v, 0), sC = C.reduce((s, v) => s + v, 0);
    return {
      pV: 100 * sV / (sV + sC), dV: std(V), dC: std(C),
      varcoV: 100 * std(V) / mean(V), varcoC: 100 * std(C) / mean(C),
      nPVIv: 100 * mean(pv), rPVIc: mean(pc), nV: V.length, nC: C.length
    };
  }

  // ---------- Chargement audio ----------
  async function decode(arrayBuf) {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx(1, SR, SR);
    const buf = await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(arrayBuf, res, rej);
      if (p && p.then) p.then(res, rej);
    });
    const n = buf.length, ch = buf.numberOfChannels, x = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) x[i] += d[i] / ch; }
    return x;
  }
  const cache = new Map();
  async function loadClip(clip) {
    if (cache.has(clip.id)) return cache.get(clip.id);
    const p = (async () => {
      const buf = clip.blob ? await clip.blob.arrayBuffer() : await (await fetch(clip.file)).arrayBuffer();
      const raw = await decode(buf);
      // l'analyse se fait sur le signal filtré (coupe les graves sous 80 Hz : dérive lente, ronflement du secteur)
      const x = highpass(raw, 80);
      const fr = await computeFrames(x);
      // gain de lecture : amène le pic du signal (99,9e centile) à -1 dB, pour que tous les extraits aient un volume comparable
      const abs = Float32Array.from(raw, Math.abs).sort();
      const pk = abs[Math.floor(0.999 * (abs.length - 1))] || 1e-6;
      return { x, raw, gain: Math.min(200, 0.89 / pk), ...fr, dur: x.length / SR };
    })();
    cache.set(clip.id, p);
    return p;
  }

  // ---------- État ----------
  const opt = { mode: "vocalic", vthr: 0.5, silf: 0.25, minPause: 0.15, shortSil: true };
  const state = { lang: "fr_fr", idx: 0, clip: null, data: null, segs: [], userClip: null };
  const $ = id => document.getElementById(id);

  // ---------- Démo PVI ----------
  (function pviDemo() {
    const rows = [
      { lbl: "Régulier", d: [100, 100, 100, 100, 100] },
      { lbl: "Alterné", d: [60, 160, 60, 160, 60] },
      { lbl: "Groupé", d: [60, 60, 60, 160, 160] }
    ];
    const box = $("pviDemo");
    for (const r of rows) {
      let s = 0; for (let k = 0; k + 1 < r.d.length; k++) s += Math.abs(r.d[k] - r.d[k + 1]) / ((r.d[k] + r.d[k + 1]) / 2);
      const npvi = 100 * s / (r.d.length - 1);
      const row = document.createElement("div"); row.className = "pvi-row";
      row.innerHTML = `<span>${r.lbl}</span><span class="bars">${r.d.map(v => `<span style="height:${v / 160 * 100}%"></span>`).join("")}</span><span class="val">${npvi.toFixed(0)}</span>`;
      box.appendChild(row);
    }
  })();

  // ---------- Boutons ----------
  function buildLangButtons() {
  const langBox = $("langBtns");
  langBox.innerHTML = "";
  for (const l of LANGS) {
    const b = document.createElement("button");
    b.type = "button"; b.id = "lang_" + l.code; b.dataset.lang = l.code;
    b.innerHTML = `<span class="dot ${l.cls}"></span>${l.name}`;
    b.setAttribute("aria-pressed", String(l.code === state.lang));
    b.addEventListener("click", () => { state.lang = l.code; state.userClip = null; selectClip(); });
    langBox.appendChild(b);
  }
  }
  $("sentSel").addEventListener("change", e => { state.idx = +e.target.value; state.userClip = null; selectClip(); });
  $("modeVoiced").addEventListener("click", () => { opt.mode = "voiced"; refreshMode(); });
  $("modeVocalic").addEventListener("click", () => { opt.mode = "vocalic"; refreshMode(); });
  $("vthr").addEventListener("input", e => { opt.vthr = +e.target.value; refreshMode(); });
  $("silf").addEventListener("input", e => { opt.silf = +e.target.value; refreshMode(); });
  $("minPause").addEventListener("input", e => { opt.minPause = +e.target.value / 1000; refreshMode(); });
  $("shortSil").addEventListener("change", e => { opt.shortSil = e.target.checked; refreshMode(); });
  $("fileIn").addEventListener("change", e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    state.userClip = { id: "user_" + Date.now(), name: f.name, cls: "user", blob: f, text: null };
    selectClip();
  });

  function syncButtons() {
    for (const l of LANGS) $("lang_" + l.code).setAttribute("aria-pressed", String(!state.userClip && l.code === state.lang));
    if (CLIPS.length) { buildSentenceMenu(); $("sentSel").value = String(state.idx); }
    $("modeVoiced").setAttribute("aria-pressed", String(opt.mode === "voiced"));
    $("modeVocalic").setAttribute("aria-pressed", String(opt.mode === "vocalic"));
    $("vthrVal").textContent = opt.vthr.toFixed(2);
    $("silfVal").textContent = opt.silf.toFixed(2);
    $("minPauseVal").textContent = Math.round(opt.minPause * 1000) + " ms";
  }

  function refreshMode() {
    syncButtons();
    if (state.data) { state.segs = segment(state.data.E, state.data.R, state.data.Z, opt); renderLab(); updateStatus(); }
    renderScatter();
  }

  async function selectClip() {
    stopPlayback();
    syncButtons();
    const list = clipsOf(state.lang);
    state.idx = Math.min(state.idx, list.length - 1);
    const clip = state.userClip || list[state.idx];
    state.clip = clip;
    const sent = $("sentence");
    if (clip.cls === "user") sent.innerHTML = `<span>${escapeHtml(clip.name)}</span><span class="src">Votre fichier, analysé localement dans le navigateur. Il n'est envoyé nulle part.</span>`;
    else sent.innerHTML = `${LANG[clip.lang].hideText ? `<span>${escapeHtml(LANG[clip.lang].textNote || "Transcription non affichée.")}</span>` : `<span dir="auto">« ${escapeHtml(clip.text)} »</span>`}<span class="src">${clip.name} · <span class="${clip.cls === "syl" ? "tag-syl" : "tag-str"}">${clip.cls === "syl" ? "iso-syllabique" : "iso-accentuelle"}</span> ${clip.gender ? " · " + (clip.gender === "FEMALE" ? "locutrice" : "locuteur") + (clip.gender_source === "F0" ? " (estimé d'après la hauteur de la voix)" : "") : ""}${SENT[clip.sent] ? ` · <span dir="ltr">${escapeHtml(SENT[clip.sent])}</span>` : ""}${LANG[clip.lang].source === "dvoice" ? " · corpus DVoice" : ""}</span>`;
    $("labStatus").textContent = "Analyse du signal…";
    try {
      const data = await loadClip(clip);
      if (state.clip !== clip) return;
      state.data = data;
      state.segs = segment(data.E, data.R, data.Z, opt);
      updateStatus();
      renderLab();
      if (clip.cls === "user") renderScatter();
    } catch (err) {
      state.data = null; state.segs = [];
      $("labStatus").textContent = "Impossible de lire ce fichier audio. Essayez un fichier WAV, MP3 ou OGG.";
      renderLab();
    }
  }
  function updateStatus() {
    if (!state.data) return;
    const iv = intervals(state.segs), nS = state.segs.filter(s => s.t === "S").length;
    $("labStatus").textContent = `Durée ${state.data.dur.toFixed(2)} s · ${iv.filter(s => s.t === "V").length} intervalles vocaliques · ${iv.filter(s => s.t === "C").length} consonantiques · ${nS} silence${nS > 1 ? "s" : ""} court${nS > 1 ? "s" : ""} ${opt.shortSil ? "comptés avec les consonnes" : "traités comme des pauses"}.`;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  // ---------- Rendu du laboratoire ----------
  const cv = $("wave"), tip = $("tip");
  let playT = null;
  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

  function drawWave() {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const d = state.data; if (!d) return;
    const [v0, v1] = view(), X = t => (t - v0) / (v1 - v0) * w;
    const bandTop = h - 18;
    for (const s of state.segs) {
      const x0 = X(s.s), x1 = X(s.e);
      if (s.t === "V") { g.fillStyle = css("--v-soft"); g.fillRect(x0, 0, x1 - x0, bandTop); g.fillStyle = css("--v"); g.fillRect(x0, bandTop + 4, Math.max(1, x1 - x0 - 1), 12); }
      else if (s.t === "C") { g.fillStyle = css("--c-soft"); g.fillRect(x0, 0, x1 - x0, bandTop); g.fillStyle = css("--c"); g.fillRect(x0, bandTop + 4, Math.max(1, x1 - x0 - 1), 12); }
      else if (s.t === "S") {
        // silence court : bande hachurée
        g.save(); g.beginPath(); g.rect(x0, bandTop + 4, Math.max(1, x1 - x0 - 1), 12); g.clip();
        g.strokeStyle = opt.shortSil ? css("--c") : css("--p"); g.lineWidth = 1.5;
        for (let k = x0 - 14; k < x1; k += 4) { g.moveTo(k, bandTop + 16); g.lineTo(k + 12, bandTop + 4); }
        g.stroke(); g.restore();
      }
      else { g.fillStyle = css("--p"); g.globalAlpha = .35; g.fillRect(x0, bandTop + 9, x1 - x0, 2); g.globalAlpha = 1; }
    }
    // forme d'onde
    const x = d.x, mid = bandTop / 2, amp = bandTop / 2 - 6;
    let peak = 1e-6; for (let i = 0; i < x.length; i += 7) peak = Math.max(peak, Math.abs(x[i]));
    g.strokeStyle = css("--wave"); g.lineWidth = 1; g.beginPath();
    const i0 = Math.floor(v0 * SR), spp = (v1 - v0) * SR / w;
    for (let px = 0; px < w; px++) {
      let mn = 0, mx = 0; const a = i0 + Math.floor(px * spp), b = Math.min(x.length, i0 + Math.floor((px + 1) * spp));
      for (let i = a; i < b; i++) { if (x[i] < mn) mn = x[i]; if (x[i] > mx) mx = x[i]; }
      g.moveTo(px + .5, mid - mx / peak * amp); g.lineTo(px + .5, mid - mn / peak * amp + .5);
    }
    g.stroke();
    // échelle de temps
    g.fillStyle = css("--muted"); g.font = "11px " + css("--font-mono");
    const step = v1 - v0 > 8 ? 2 : (v1 - v0 > 3 ? 1 : 0.5);
    for (let t = Math.ceil(v0 / step) * step; t < v1; t += step) { g.fillText((+t.toFixed(1)) + " s", X(t) + 3, 12); g.fillRect(X(t), 0, 1, 5); }
    // curseur de lecture
    if (playT != null) { g.fillStyle = css("--accent"); g.fillRect(X(playT) - 1, 0, 2, h); }
  }

  function renderBars() {
    const iv = intervals(state.segs);
    const V = iv.filter(s => s.t === "V"), C = iv.filter(s => s.t === "C");
    const mx = Math.max(1e-3, ...iv.filter(s => s.t !== "P").map(s => s.e - s.s));
    const fill = (box, arr) => {
      box.innerHTML = "";
      arr.forEach(s => {
        const sp = document.createElement("span");
        sp.style.height = Math.max(4, (s.e - s.s) / mx * 100) + "%";
        sp.title = `${Math.round((s.e - s.s) * 1000)} ms`;
        sp.dataset.s = s.s; box.appendChild(sp);
      });
    };
    fill($("barsV"), V); fill($("barsC"), C);
    $("barsMax").textContent = Math.round(mx * 1000) + " ms";
  }

  function renderResults() {
    const box = $("results"); box.innerHTML = "";
    if (!state.segs.length) return;
    const m = measures(state.segs);
    for (const k of MEASURES) {
      const v = m[k.key];
      const el = document.createElement("div"); el.className = "res";
      el.innerHTML = `<span class="k">${k.label}</span><span class="val">${isFinite(v) ? v.toFixed(k.dec) : "–"}${isFinite(v) && k.unit ? `<small style="font-size:.6em;margin-left:3px">${k.unit}</small>` : ""}</span><span class="h">${k.hint}</span>`;
      box.appendChild(el);
    }
  }

  function renderLab() { drawWave(); renderBars(); renderResults(); highlight(null); }

  function view() {
    const d = state.data; if (!d) return [0, 1];
    const sp = state.segs.filter(s => s.t !== "P");
    if (!sp.length) return [0, d.dur];
    return [Math.max(0, sp[0].s - 0.25), Math.min(d.dur, sp[sp.length - 1].e + 0.25)];
  }
  function segAt(t) { return state.segs.find(s => t >= s.s && t < s.e) || null; }
  function highlight(seg) {
    const iv = seg ? intervals(state.segs).find(r => seg.s >= r.s && seg.s < r.e) : null;
    for (const sp of document.querySelectorAll(".dur-bars span")) sp.classList.toggle("on", !!iv && +sp.dataset.s === iv.s);
    const now = $("now");
    if (!seg) { now.textContent = ""; return; }
    const lbl = seg.t === "V" ? "vocalique" : seg.t === "C" ? "consonantique" : seg.t === "S" ? (opt.shortSil ? "silence court (compté consonantique)" : "silence court (traité comme pause)") : "pause";
    now.innerHTML = `Intervalle <span class="${seg.t === "V" ? "tag-v" : seg.t === "C" ? "tag-c" : ""}">${lbl}</span> · ${Math.round((seg.e - seg.s) * 1000)} ms · de ${seg.s.toFixed(2)} à ${seg.e.toFixed(2)} s`;
  }

  // ---------- Lecture ----------
  let actx = null, src = null, startAt = 0, offset0 = 0, endAt = 0, raf = 0;
  function ensureCtx() { if (!actx) { const C = window.AudioContext || window.webkitAudioContext; actx = new C(); } if (actx.state === "suspended") actx.resume(); return actx; }
  function stopPlayback() {
    if (src) { try { src.onended = null; src.stop(); } catch (e) {} src = null; }
    cancelAnimationFrame(raf); playT = null; $("playBtn").textContent = "▶ Lire la phrase";
    if (state.data) { drawWave(); highlight(null); }
  }
  function play(from, to) {
    if (!state.data) return;
    stopPlayback();
    const ctx = ensureCtx();
    const d = state.data, sig = Float32Array.from(d.raw, v => Math.max(-1, Math.min(1, v * d.gain)));
    const buf = ctx.createBuffer(1, sig.length, SR);
    buf.copyToChannel ? buf.copyToChannel(sig, 0) : buf.getChannelData(0).set(sig);
    src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
    offset0 = from; endAt = to; startAt = ctx.currentTime;
    src.start(0, from, to - from);
    src.onended = () => stopPlayback();
    $("playBtn").textContent = "■ Arrêter";
    const tick = () => {
      playT = offset0 + (actx.currentTime - startAt);
      if (playT > endAt) playT = endAt;
      drawWave(); highlight(segAt(playT));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  $("playBtn").addEventListener("click", () => { if (src) stopPlayback(); else if (state.data) { const [a, b] = view(); play(a, b); } });
  function timeAt(e) { const r = cv.getBoundingClientRect(); const [a, b] = view(); return a + (e.clientX - r.left) / r.width * (b - a); }
  cv.addEventListener("click", e => {
    if (!state.data) return;
    const s = segAt(timeAt(e)); if (s) play(s.s, s.e);
  });
  cv.addEventListener("mousemove", e => {
    if (!state.data) return;
    const r = cv.getBoundingClientRect();
    const s = segAt(timeAt(e));
    if (!s) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.textContent = `${s.t === "V" ? "Vocalique" : s.t === "C" ? "Consonantique" : s.t === "S" ? "Silence court" : "Pause"} · ${Math.round((s.e - s.s) * 1000)} ms`;
    const x = Math.min(Math.max(0, e.clientX - r.left + 10), r.width - tip.offsetWidth - 4);
    tip.style.left = x + "px";
    if (!src) highlight(s);
  });
  cv.addEventListener("mouseleave", () => { tip.hidden = true; if (!src) highlight(null); });
  if (window.ResizeObserver) new ResizeObserver(() => drawWave()).observe(cv);
  window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { drawWave(); });

  // ---------- Nuage de points ----------
  const axX = $("axX"), axY = $("axY");
  for (const m of MEASURES) { axX.add(new Option(m.label, m.key)); axY.add(new Option(m.label, m.key)); }
  axX.value = "pV"; axY.value = "dC";
  axX.addEventListener("change", renderScatter); axY.addEventListener("change", renderScatter);
  const ready = new Map();

  $("showAll").addEventListener("change", renderScatter);
  function renderScatter() {
    const svg = $("scatter"); const W = 640, H = 400, ml = 56, mr = 18, mt = 16, mb = 44;
    const kx = axX.value, ky = axY.value, mX = MEASURES.find(m => m.key === kx), mY = MEASURES.find(m => m.key === ky);
    const pts = [];
    for (const c of CLIPS) { const d = ready.get(c.id); if (!d) continue; const m = measures(segment(d.E, d.R, d.Z, opt)); if (isFinite(m[kx]) && isFinite(m[ky])) pts.push({ c, x: m[kx], y: m[ky] }); }
    const means = [];
    for (const l of LANGS) {
      const ps = pts.filter(p => p.c.lang === l.code); if (!ps.length) continue;
      means.push({ l, n: ps.length, x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length });
    }
    let user = null;
    if (state.userClip && state.data && state.clip === state.userClip) { const m = measures(state.segs); if (isFinite(m[kx]) && isFinite(m[ky])) user = { x: m[kx], y: m[ky] }; }
    const showAll = $("showAll").checked;
    // échelle robuste : on ignore les 3 % de valeurs les plus extrêmes de chaque côté ; les points hors cadre sont posés au bord
    const robust = (arr, key) => { const v = arr.map(p => p[key]).sort((a, b) => a - b); if (!v.length) return []; const q = f => v[Math.min(v.length - 1, Math.max(0, Math.round(f * (v.length - 1))))]; return [q(0.03), q(0.97)]; };
    const base = showAll ? pts : [];
    const extent = [...means, ...(user ? [user] : [])];
    if (base.length) { const [ax, bx] = robust(base, "x"), [ay, by] = robust(base, "y"); extent.push({ x: ax, y: ay }, { x: bx, y: by }); }
    let clipped = 0;
    let out = "";
    if (extent.length) {
      const nice = (a, b) => { const pad = (b - a) * 0.1 || 1; return [a - pad, b + pad]; };
      const [x0, x1] = nice(Math.min(...extent.map(p => p.x)), Math.max(...extent.map(p => p.x)));
      const [y0, y1] = nice(Math.min(...extent.map(p => p.y)), Math.max(...extent.map(p => p.y)));
      const cl = (v, a, b) => Math.min(b, Math.max(a, v));
      const sx = v => ml + (cl(v, x0, x1) - x0) / (x1 - x0) * (W - ml - mr), sy = v => H - mb - (cl(v, y0, y1) - y0) / (y1 - y0) * (H - mt - mb);
      const ticks = (a, b) => { const span = b - a, raw = span / 5, p = Math.pow(10, Math.floor(Math.log10(raw))), st = [1, 2, 5, 10].map(k => k * p).find(k => span / k <= 6); const r = []; for (let v = Math.ceil(a / st) * st; v <= b; v += st) r.push(+v.toFixed(6)); return r; };
      const line = css("--line");
      for (const v of ticks(x0, x1)) out += `<line x1="${sx(v)}" x2="${sx(v)}" y1="${mt}" y2="${H - mb}" stroke="${line}"/><text x="${sx(v)}" y="${H - mb + 16}" text-anchor="middle">${v}</text>`;
      for (const v of ticks(y0, y1)) out += `<line x1="${ml}" x2="${W - mr}" y1="${sy(v)}" y2="${sy(v)}" stroke="${line}"/><text x="${ml - 8}" y="${sy(v) + 4}" text-anchor="end">${v}</text>`;
      out += `<text x="${(ml + W - mr) / 2}" y="${H - 8}" text-anchor="middle">${mX.label}${mX.unit ? " (" + mX.unit + ")" : ""}</text>`;
      out += `<text transform="translate(14 ${(mt + H - mb) / 2}) rotate(-90)" text-anchor="middle">${mY.label}${mY.unit ? " (" + mY.unit + ")" : ""}</text>`;
      const colOf = cls => cls === "syl" ? css("--syl") : css("--str");
      const mark = (cls, X, Y, r, extra) => cls === "str"
        ? `<rect x="${X - r}" y="${Y - r}" width="${2 * r}" height="${2 * r}" rx="2" fill="${colOf(cls)}" ${extra}/>`
        : `<circle cx="${X}" cy="${Y}" r="${r}" fill="${colOf(cls)}" ${extra}/>`;
      if (showAll) for (const p of pts) {
        const X = sx(p.x), Y = sy(p.y);
        if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) clipped++;
        out += `<g class="pt" data-id="${p.c.id}" tabindex="0" role="button" aria-label="${p.c.name}, phrase ${clipsOf(p.c.lang).indexOf(p.c) + 1}, ${mX.label} ${p.x.toFixed(1)}, ${mY.label} ${p.y.toFixed(1)}"><title>${p.c.name} · phrase ${clipsOf(p.c.lang).indexOf(p.c) + 1}</title>${mark(p.c.cls, X, Y, 3.5, 'fill-opacity="0.45"')}</g>`;
      }
      // étiquettes des moyennes : on les écarte verticalement pour qu'elles ne se chevauchent pas
      const labs = means.map(m => ({ m, X: sx(m.x), Y: sy(m.y), ly: sy(m.y) + 4 })).sort((a, b) => a.ly - b.ly);
      for (let k = 1; k < labs.length; k++) {
        const prev = labs[k - 1], cur = labs[k];
        if (Math.abs(cur.X - prev.X) < 70 && cur.ly - prev.ly < 13) cur.ly = prev.ly + 13;
      }
      for (const L of labs) {
        const m = L.m, stroke = css("--surface");
        out += `<g class="pt" data-lang="${m.l.code}" tabindex="0" role="button" aria-label="Moyenne ${m.l.name}, ${mX.label} ${m.x.toFixed(1)}, ${mY.label} ${m.y.toFixed(1)}"><title>Moyenne ${m.l.name} (${m.n} phrases)</title>${mark(m.l.cls, L.X, L.Y, 7, `stroke="${stroke}" stroke-width="2"`)}<text x="${L.X + 11}" y="${L.ly}" style="fill:var(--fg);font-weight:600">${m.l.short}</text></g>`;
      }
      if (user) { const X = sx(user.x), Y = sy(user.y); out += `<g><circle cx="${X}" cy="${Y}" r="7" fill="none" stroke="${css("--fg")}" stroke-width="2"/><text x="${X + 11}" y="${Y + 4}">votre fichier</text></g>`; }
    }
    svg.innerHTML = out;
    for (const g of svg.querySelectorAll(".pt")) {
      const go = () => {
        if (g.dataset.lang) { state.lang = g.dataset.lang; }
        else { const c = CLIPS.find(c => c.id === g.dataset.id); if (!c) return; state.lang = c.lang; state.idx = clipsOf(c.lang).indexOf(c); }
        state.userClip = null; selectClip();
        $("lab").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      };
      g.addEventListener("click", go);
      g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    }
    const n = CLIPS.filter(c => ready.has(c.id)).length;
    $("scatterStatus").textContent = n < CLIPS.length ? `Analyse des extraits : ${n} / ${CLIPS.length}…` : `${CLIPS.length} enregistrements analysés (${LANGS.length} langues). Mode : ${opt.mode === "vocalic" ? "vocalique" : "voisé / non voisé"}.${clipped ? ` ${clipped} point${clipped > 1 ? "s" : ""} hors échelle, posé${clipped > 1 ? "s" : ""} au bord.` : ""} Moyennes : ${LANGS.filter(l => l.cls === "syl").map(l => l.short).join(", ")} = iso-syllabiques ; ${LANGS.filter(l => l.cls === "str").map(l => l.short).join(", ")} = iso-accentuelles.`;
  }

  // ---------- Démarrage ----------
  (async () => {
    try {
      const cat = await (await fetch("data/clips.json")).json();
      LANGS = cat.languages;
      LANG = Object.fromEntries(LANGS.map(l => [l.code, l]));
      if (!LANG[state.lang]) state.lang = LANGS[0].code;
      buildLangButtons();
      cat.sentences.forEach((x, k) => { SENT[x.id] = x.en; SENT_ORDER.push(x.id); });
      CLIPS = cat.clips.filter(c => LANG[c.lang]).map(c => ({ ...c, name: LANG[c.lang].name, cls: LANG[c.lang].cls }));
    } catch (e) {
      $("labStatus").textContent = location.protocol === "file:"
        ? "Le navigateur bloque la lecture des fichiers quand la page est ouverte directement. Lancez un petit serveur local (voir README.md) puis ouvrez http://localhost:8000."
        : "Impossible de charger data/clips.json. Vérifiez que le fichier existe et que son contenu est un JSON valide.";
      return;
    }
    state.idx = 0;
    syncButtons();
    await selectClip();
    // analyse les phrases dans un ordre qui fait apparaître vite toutes les langues
    const order = [];
    const maxN = Math.max(...LANGS.map(l => clipsOf(l.code).length));
    for (let k = 0; k < maxN; k++) LANGS.forEach(l => { const c = clipsOf(l.code)[k]; if (c) order.push(c); });
    let k = 0;
    for (const c of order) {
      try { ready.set(c.id, await loadClip(c)); } catch (e) {}
      if (++k % 7 === 0 || k === order.length) renderScatter();
    }
  })();
})();
