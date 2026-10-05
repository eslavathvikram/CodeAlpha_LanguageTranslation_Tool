(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    from: $('from'),
    to: $('to'),
    input: $('input'),
    output: $('output'),
    count: $('count'),
    detected: $('detected'),
    translate: $('translate'),
    swap: $('swap'),
    clear: $('clear'),
    listenIn: $('listen-in'),
    listenOut: $('listen-out'),
    copy: $('copy'),
    error: $('error'),
    provider: $('provider'),
    history: $('history'),
    historyEmpty: $('history-empty'),
    clearHistory: $('clear-history'),
  };

  const PLACEHOLDER = 'Your translation will appear here.';
  const STORE_KEY = 'glossa:v1';
  const HISTORY_MAX = 12;

  let languages = [];
  let byCode = new Map();
  let maxLength = 5000;
  let last = null; // { text, translation, source, target, detected }
  let history = [];

  /* ---------- storage ---------- */

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
  }
  function writeStore(patch) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...readStore(), ...patch })); } catch { /* storage unavailable */ }
  }

  /* ---------- helpers ---------- */

  function label(lang) {
    return lang.native && lang.native !== lang.name ? `${lang.name} (${lang.native})` : lang.name;
  }

  function nameOf(code) {
    if (code === 'auto') return 'Detected language';
    const l = byCode.get(code);
    return l ? l.name : code;
  }

  // Providers report detected languages in different shapes ("fr", "fr-FR", "French").
  function resolveCode(raw) {
    if (!raw) return null;
    const v = String(raw).trim();
    if (byCode.has(v)) return v;
    const lower = v.toLowerCase();
    const prefix = lower.split(/[-_]/)[0];
    const hit = languages.find(
      (l) => l.code.toLowerCase() === lower || l.code.toLowerCase().split('-')[0] === prefix || l.name.toLowerCase() === lower
    );
    return hit ? hit.code : null;
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
  }
  function clearError() {
    el.error.hidden = true;
    el.error.textContent = '';
  }

  function setOutput(state, text) {
    el.output.dataset.state = state;
    el.output.textContent = text;
  }

  function updateCount() {
    const n = el.input.value.length;
    el.count.textContent = `${n} / ${maxLength}`;
    el.count.classList.toggle('near', n > maxLength * 0.9);
  }

  function setResultControls(enabled) {
    el.copy.disabled = !enabled;
    el.listenOut.disabled = !enabled;
  }

  /* ---------- translate ---------- */

  async function translate() {
    clearError();
    stopSpeaking();

    const text = el.input.value;
    if (!text.trim()) {
      showError('Type or paste some text to translate.');
      el.input.focus();
      return;
    }
    if (el.from.value === el.to.value) {
      showError('Pick two different languages.');
      return;
    }

    el.translate.disabled = true;
    el.translate.textContent = 'Translating';
    setResultControls(false);
    setOutput('loading', 'Translating');
    el.detected.textContent = '';

    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source: el.from.value, target: el.to.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Translation failed. Try again.');

      last = {
        text,
        translation: data.translation,
        source: el.from.value,
        target: el.to.value,
        detected: el.from.value === 'auto' ? resolveCode(data.detected) : null,
      };

      setOutput('ready', data.translation);
      el.output.lang = last.target;
      setResultControls(true);

      if (el.from.value === 'auto' && data.detected) {
        el.detected.textContent = `Detected ${last.detected ? nameOf(last.detected) : data.detected}`;
      }
      addHistory(last);
    } catch (err) {
      last = null;
      setOutput('empty', PLACEHOLDER);
      showError(err instanceof TypeError ? 'Could not reach the server. Check that it is running.' : err.message);
    } finally {
      el.translate.disabled = false;
      el.translate.textContent = 'Translate';
    }
  }

  /* ---------- swap, clear, copy ---------- */

  function swap() {
    clearError();
    let newFrom = el.to.value;
    let newTo = el.from.value;

    if (newTo === 'auto') {
      const detected = last && last.detected;
      if (!detected) {
        showError('Choose a source language before swapping.');
        return;
      }
      newTo = detected;
    }

    el.from.value = newFrom;
    el.to.value = newTo;
    writeStore({ from: newFrom, to: newTo });

    if (last) {
      el.input.value = last.translation;
      updateCount();
      translate();
    }
  }

  function clearAll() {
    stopSpeaking();
    clearError();
    el.input.value = '';
    el.detected.textContent = '';
    last = null;
    setOutput('empty', PLACEHOLDER);
    setResultControls(false);
    updateCount();
    el.input.focus();
  }

  async function copy() {
    if (!last) return;
    const text = last.translation;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      if (!ok) {
        showError('Copy is blocked in this browser. Select the text and copy it manually.');
        return;
      }
    }
    const span = el.copy.querySelector('.label');
    span.textContent = 'Copied';
    setTimeout(() => { span.textContent = 'Copy'; }, 1600);
  }

  /* ---------- text to speech ---------- */

  const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
  let speakingBtn = null;

  function stopSpeaking() {
    if (!synth) return;
    synth.cancel();
    resetSpeakButtons();
  }

  function resetSpeakButtons() {
    [el.listenIn, el.listenOut].forEach((b) => { b.querySelector('.label').textContent = 'Listen'; });
    speakingBtn = null;
  }

  function speak(btn, text, code) {
    if (!synth || !text.trim()) return;
    if (speakingBtn === btn) { stopSpeaking(); return; }
    stopSpeaking();
    clearError();

    if (code) {
      const prefix = code.split('-')[0].toLowerCase();
      const voices = synth.getVoices();
      if (voices.length && !voices.some((v) => v.lang.toLowerCase().startsWith(prefix))) {
        showError(`No ${nameOf(code)} voice is installed on this device. Add one in your system's speech settings.`);
        return;
      }
    }

    const utter = new SpeechSynthesisUtterance(text);
    if (code) utter.lang = code;
    utter.onend = utter.onerror = resetSpeakButtons;
    speakingBtn = btn;
    btn.querySelector('.label').textContent = 'Stop';
    synth.speak(utter);
  }

  /* ---------- history ---------- */

  function addHistory(item) {
    const entry = { ...item, t: Date.now() };
    history = [entry, ...history.filter((h) => !(h.text === item.text && h.source === item.source && h.target === item.target))].slice(0, HISTORY_MAX);
    writeStore({ history });
    renderHistory();
  }

  function renderHistory() {
    el.history.textContent = '';
    el.historyEmpty.hidden = history.length > 0;
    el.clearHistory.hidden = history.length === 0;

    history.forEach((h, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hist-item';
      btn.dataset.index = String(i);

      const langs = document.createElement('span');
      langs.className = 'hist-langs';
      const from = h.source === 'auto' ? (h.detected ? nameOf(h.detected) : 'Detected') : nameOf(h.source);
      langs.textContent = `${from} to ${nameOf(h.target)}`;

      const src = document.createElement('span');
      src.className = 'hist-src';
      src.textContent = h.text;
      src.dir = 'auto';

      const out = document.createElement('span');
      out.className = 'hist-out';
      out.textContent = h.translation;
      out.dir = 'auto';

      btn.append(langs, src, out);
      li.appendChild(btn);
      el.history.appendChild(li);
    });
  }

  function restore(index) {
    const h = history[index];
    if (!h) return;
    stopSpeaking();
    clearError();
    el.from.value = h.source;
    el.to.value = h.target;
    writeStore({ from: h.source, to: h.target });
    el.input.value = h.text;
    updateCount();
    last = { text: h.text, translation: h.translation, source: h.source, target: h.target, detected: h.detected };
    setOutput('ready', h.translation);
    el.output.lang = h.target;
    el.detected.textContent = h.source === 'auto' && h.detected ? `Detected ${nameOf(h.detected)}` : '';
    setResultControls(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------- startup ---------- */

  function fillSelects(prefs) {
    const sorted = [...languages].sort((a, b) => a.name.localeCompare(b.name));

    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = 'Detect language';
    el.from.appendChild(auto);

    sorted.forEach((l) => {
      el.from.appendChild(new Option(label(l), l.code));
      el.to.appendChild(new Option(label(l), l.code));
    });

    const validFrom = prefs.from === 'auto' || byCode.has(prefs.from);
    el.from.value = validFrom ? prefs.from : 'auto';
    el.to.value = byCode.has(prefs.to) ? prefs.to : 'es';
  }

  async function init() {
    const prefs = readStore();
    try {
      const res = await fetch('/api/languages');
      if (!res.ok) throw new Error();
      const data = await res.json();
      languages = data.languages;
      maxLength = data.maxLength || maxLength;
      byCode = new Map(languages.map((l) => [l.code, l]));
      el.provider.textContent = `Translations by ${data.provider.name}`;
    } catch {
      showError('Could not load languages. Check that the server is running, then reload.');
      el.translate.disabled = true;
      return;
    }

    fillSelects(prefs);
    el.input.maxLength = maxLength;
    updateCount();

    history = Array.isArray(prefs.history) ? prefs.history : [];
    renderHistory();

    if (synth) {
      el.listenIn.hidden = false;
      el.listenOut.hidden = false;
      // Some browsers load voices asynchronously
      synth.getVoices();
    }

    el.translate.addEventListener('click', translate);
    el.swap.addEventListener('click', swap);
    el.clear.addEventListener('click', clearAll);
    el.copy.addEventListener('click', copy);
    el.input.addEventListener('input', updateCount);
    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        translate();
      }
    });
    el.from.addEventListener('change', () => writeStore({ from: el.from.value }));
    el.to.addEventListener('change', () => writeStore({ to: el.to.value }));

    el.listenIn.addEventListener('click', () => {
      const code = el.from.value !== 'auto' ? el.from.value : last && last.detected;
      speak(el.listenIn, el.input.value, code);
    });
    el.listenOut.addEventListener('click', () => {
      if (last) speak(el.listenOut, last.translation, last.target);
    });

    el.history.addEventListener('click', (e) => {
      const btn = e.target.closest('.hist-item');
      if (btn) restore(Number(btn.dataset.index));
    });
    el.clearHistory.addEventListener('click', () => {
      history = [];
      writeStore({ history });
      renderHistory();
    });

    window.addEventListener('pagehide', stopSpeaking);
  }

  init();
})();
