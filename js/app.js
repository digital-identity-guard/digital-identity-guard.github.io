/* Digital Identity Guard — page behaviour (navigation, language, check form, report). */
(function () {
  'use strict';

  const A = window.DIGAnalyzer;
  const C = window.DIGCheck;
  const CONFIG = window.DIGConfig || {};
  const STRINGS = window.DIGStrings;
  const $ = (id) => document.getElementById(id);
  const PAGES = ['home', 'scan', 'about', 'tips'];

  let lang = 'ar';
  let lastResult = null;
  let lastInput = null;
  let busy = false;

  try {
    const saved = localStorage.getItem('dig-lang');
    if (saved === 'ar' || saved === 'en') lang = saved;
  } catch (e) { /* storage unavailable: keep default */ }

  function t(key, params) {
    let s = STRINGS[lang][key];
    if (s == null) s = STRINGS.ar[key] != null ? STRINGS.ar[key] : key;
    // Values are wrapped in Unicode isolates so "@name" or a link keeps its direction inside Arabic text.
    if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? '⁨' + params[k] + '⁩' : m));
    return s;
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    });
    (children || []).forEach((c) => c != null && node.append(c));
    return node;
  }

  const bdi = (text) => el('bdi', { class: 'code', text });
  const platformName = (id) => (A.PLATFORMS.find((p) => p.id === id) || { name: id || '' }).name;
  const handleText = (h) => '@' + String(h || '').replace(/^@+/, '');
  const radio = (name) => (document.querySelector(`input[name=${name}]:checked`) || {}).value;

  // ------------------------------------------------------- language ---

  function applyLanguage() {
    const html = document.documentElement;
    html.lang = lang;
    html.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.title = t('meta.title');
    document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
    document.querySelectorAll('[data-i18n-ph]').forEach((n) => { n.placeholder = t(n.dataset.i18nPh); });
    $('lang').setAttribute('lang', lang === 'ar' ? 'en' : 'ar');
    updateAccountHint();
    ['mode-error', 'account-error'].forEach((id) => {
      const n = $(id);
      if (n.dataset.key) n.textContent = t(n.dataset.key, JSON.parse(n.dataset.params || 'null'));
    });
    if (lastResult) renderReport(lastResult);
  }

  $('lang').addEventListener('click', () => {
    lang = lang === 'ar' ? 'en' : 'ar';
    try { localStorage.setItem('dig-lang', lang); } catch (e) { /* ignore */ }
    applyLanguage();
  });

  // ----------------------------------------------------- navigation ---

  function show(page) {
    if (!PAGES.includes(page)) page = 'home';
    PAGES.forEach((p) => $(p).classList.toggle('hidden', p !== page));
    document.querySelectorAll('[data-page]').forEach((b) => {
      const on = b.dataset.page === page;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }

  document.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => show(b.dataset.page)));
  $('start').addEventListener('click', () => {
    show('scan');
    const first = document.querySelector('input[name=mode]');
    if (first) first.focus();
  });

  // ----------------------------------------------------------- form ---

  function buildChecklist() {
    const box = $('checks');
    C.MANUAL_ITEMS.forEach((it) => {
      const text = el('span', { 'data-i18n': it.id });
      const label = el('label', { class: 'check' }, [
        el('input', { type: 'checkbox', value: it.id }),
        el('span', {}, [text]),
      ]);
      box.append(label);
    });
  }

  function setError(id, key, params) {
    const n = $(id);
    n.dataset.key = key || '';
    n.dataset.params = params ? JSON.stringify(params) : '';
    n.textContent = key ? t(key, params) : '';
  }

  function updateMode() {
    const mode = radio('mode');
    $('steps').classList.toggle('hidden', !mode);
    $('manual-only').classList.toggle('hidden', mode !== 'manual');
    if (mode) setError('mode-error', null);
    updateAccountHint();
  }

  // A link names its platform; only a bare username needs the platform picker.
  function updateAccountHint() {
    const raw = $('account').value.trim();
    const parsed = A.parseAccount(raw);
    const isLink = parsed.kind === 'link' || parsed.kind === 'invalid';
    $('platform-pick').classList.toggle('hidden', !raw || isLink);
    $('platform-detected').textContent = parsed.kind === 'link' && parsed.platform
      ? t('scan.platformDetected', { platform: parsed.platform }) : '';
  }

  document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', updateMode));
  $('account').addEventListener('input', () => {
    updateAccountHint();
    setError('account-error', null);
    $('account').removeAttribute('aria-invalid');
  });
  document.querySelectorAll('input[name=platform]').forEach((r) => r.addEventListener('change', () => {
    setError('account-error', null);
    $('account').removeAttribute('aria-invalid');
  }));

  async function callAI(input, parsed) {
    if (!CONFIG.aiEndpoint) return { local: true };
    try {
      const res = await fetch(CONFIG.aiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: parsed.platformId,
          username: parsed.username,
          url: parsed.kind === 'link' && parsed.url ? parsed.url.href : '',
          message: input.message,
          lang,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) return { error: 'ai.rate_limited', params: { min: Math.max(1, Math.ceil((data.retryAfter || 3600) / 60)) } };
      if (data.error === 'message_too_long') return { error: 'ai.message_too_long', params: { max: data.max } };
      if (!res.ok || !data.indicators) return { local: true, remaining: data.remaining };
      return { remote: data };
    } catch (e) {
      return { local: true };
    }
  }

  $('scan-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const mode = radio('mode');
    if (!mode) { setError('mode-error', 'err.no_mode'); return; }

    const input = {
      mode,
      account: $('account').value.trim(),
      platform: radio('platform'),
      message: $('message').value.trim(),
      badge: radio('badge'),
      manual: [...document.querySelectorAll('#checks input:checked')].map((c) => c.value),
    };

    const check = C.parseInput(input.account, input.platform);
    if (check.error) {
      setError('account-error', 'err.' + check.error);
      $('account').setAttribute('aria-invalid', 'true');
      $('account').focus();
      return;
    }

    setError('account-error', null);
    $('account').removeAttribute('aria-invalid');
    let remote = null;
    let aiState = null;
    if (mode === 'ai') {
      busy = true;
      $('analyze').disabled = true;
      $('loading').classList.remove('hidden');
      const out = await callAI(input, check.parsed);
      busy = false;
      $('analyze').disabled = false;
      $('loading').classList.add('hidden');
      if (out.error) { setError('account-error', out.error, out.params); return; }
      remote = out.remote || null;
      aiState = out.local ? { local: true, remaining: out.remaining } : null;
    }

    lastInput = input;
    lastResult = C.analyze(input, remote);
    lastResult.aiState = aiState;
    $('report').classList.remove('hidden');
    renderReport(lastResult);
    $('report').focus({ preventScroll: true });
    $('report').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('reset').addEventListener('click', () => {
    $('scan-form').reset();
    lastResult = null;
    lastInput = null;
    $('report').classList.add('hidden');
    updateMode();
    window.scrollTo({ top: $('scan').offsetTop, behavior: 'smooth' });
  });

  // --------------------------------------------------------- report ---

  function renderCategories(r) {
    const box = $('cats');
    box.replaceChildren();
    C.CATEGORIES.forEach((c) => {
      const on = c.id === r.category;
      box.append(el('div', { class: 'cat cat-' + c.id + (on ? ' on' : ''), 'aria-current': on ? 'true' : 'false' }, [
        on ? el('span', { class: 'tag', text: t('res.thisOne') }) : null,
        el('div', { class: 'cat-range', text: t('cat.' + c.id + '.range') }),
        el('b', { text: t('cat.' + c.id) }),
        el('p', { class: 'muted', text: t('cat.' + c.id + '.d') }),
      ]));
    });
  }

  function renderScore(r) {
    $('score').replaceChildren(String(r.score), el('span', { class: 'of', text: ' / 10' }));
    $('score').className = 'result score-' + r.category;
    $('meter').style.width = r.score * 10 + '%';
    $('meter').className = 'm-' + r.category;
    $('score-mode').textContent = t('res.mode.' + r.mode);

    const dl = $('detected');
    dl.replaceChildren();
    const row = (k, v) => dl.append(el('dt', { text: k }), el('dd', {}, [v]));
    row(t('res.account'), bdi(handleText(r.parsed.username)));
    row(t('res.platform'), platformName(r.platformId));

    $('score-count').textContent = r.mode === 'manual'
      ? t('res.manualCount', { passed: r.passedCount, total: r.total })
      : t('res.aiCount', { passed: r.passed, failed: r.failed, checked: r.checked, total: r.total });

    const caps = $('caps');
    caps.replaceChildren();
    r.caps.forEach((c) => caps.append(el('p', { class: 'note', text: t('cap.' + c) })));
  }

  function statusRow(status, title, extra, desc) {
    return el('li', { class: 'st st-' + status }, [
      el('span', { class: 'st-icon', 'aria-hidden': 'true', text: { pass: '✅', fail: '❌', unknown: '⚪' }[status] }),
      el('span', { class: 'st-body' }, [
        el('span', { class: 'st-title' }, [title, extra || null]),
        desc ? el('span', { class: 'muted st-desc', text: desc }) : null,
      ]),
      el('span', { class: 'st-label', text: t('st.' + status) }),
    ]);
  }

  function renderItems(r) {
    const box = $('items');
    box.replaceChildren();
    if (r.mode === 'manual') {
      const ul = el('ul', { class: 'status-list' });
      r.items.forEach((it) => ul.append(statusRow(it.passed ? 'pass' : 'fail', t(it.id), null,
        it.note ? t('note.' + it.note) : '')));
      box.append(ul);
      return;
    }
    r.groups.forEach((g) => {
      const ul = el('ul', { class: 'status-list' });
      g.items.forEach((it) => {
        let desc = it.note || '';
        if (!desc && it.id === 'g9.impersonation' && it.params.kw && it.status === 'fail') desc = t('f.keyword.d', it.params);
        ul.append(statusRow(it.status, t(it.id),
          it.source ? el('span', { class: 'f-src', text: t('src.' + it.source) }) : null, desc));
      });
      box.append(el('div', { class: 'group' }, [el('h4', { text: t(g.id) }), ul]));
    });
    if (r.groups.some((g) => g.items.some((i) => i.status === 'unknown'))) {
      box.append(el('p', { class: 'muted', text: t('res.unknownNote') }));
    }
  }

  function renderAISummary(r) {
    const sec = $('ai-summary-sec');
    const box = $('ai-summary');
    box.replaceChildren();
    if (r.mode !== 'ai') { sec.classList.add('hidden'); return; }
    sec.classList.remove('hidden');
    if (r.remote) {
      if (r.remote.summary) box.append(el('p', { dir: 'auto', text: r.remote.summary }));
      if (!r.remote.profileFound) box.append(el('p', { class: 'note', text: t('res.aiNoProfile') }));
      if (r.remote.remaining != null) box.append(el('p', { class: 'muted', text: t('res.aiRemaining', { n: r.remote.remaining }) }));
    } else {
      box.append(el('p', { class: 'note', text: t('res.aiLocal') }));
      if (r.aiState && r.aiState.remaining != null) box.append(el('p', { class: 'muted', text: t('res.aiRemaining', { n: r.aiState.remaining }) }));
    }
  }

  function renderBadge(r) {
    const sec = $('r-badge-sec');
    const box = $('r-badge');
    box.replaceChildren();
    if (r.mode !== 'manual' || !r.badge) { sec.classList.add('hidden'); return; }
    sec.classList.remove('hidden');
    const b = r.badge;
    const desc = b.id === 'badge_none' ? t('b.badge_none.person') : t('b.' + b.id + '.d');
    box.append(el('div', { class: 'status status-' + (b.warn ? 'warn' : 'info') }, [
      el('b', { text: t('b.' + b.id) }), el('p', { text: desc }),
    ]));
    if (b.id !== 'badge_none') box.append(el('p', { class: 'muted', text: t('b.tip') }));
  }

  function renderMessages(r) {
    const list = $('r-messages');
    list.replaceChildren();
    if (!r.messageGiven) {
      list.append(el('li', { class: 'sev-none' }, [el('span', { class: 'f-desc', text: t('m.empty') })]));
      return;
    }
    const order = { decisive: 0, strong: 1, weak: 2 };
    const local = r.message.findings.map((f) => ({
      severity: f.severity, title: t('m.' + f.id, f.params), note: t('m.' + f.id + '.d', f.params), quote: f.quote,
    }));
    // Claude's findings are added when they are not already covered by the browser's own checks.
    const remote = (r.remote && r.remote.findings) || [];
    const all = local.concat(remote.filter((f) => !local.some((l) => l.quote && f.quote && l.quote.includes(f.quote))))
      .sort((a, b) => order[a.severity] - order[b.severity]);
    if (!all.length) {
      list.append(el('li', { class: 'sev-none' }, [el('span', { class: 'f-desc', text: t('m.none') })]));
      return;
    }
    all.forEach((f) => {
      const li = el('li', { class: 'sev-' + f.severity }, [
        el('span', { class: 'f-title' }, [f.title, el('span', { class: 'f-src', text: t('sev.' + f.severity) })]),
        el('span', { class: 'f-desc', text: f.note }),
      ]);
      if (f.quote) li.append(el('blockquote', { dir: 'auto', text: '«' + f.quote + '»' }));
      list.append(li);
    });
  }

  function renderReport(r) {
    renderCategories(r);
    renderScore(r);
    renderAISummary(r);
    renderItems(r);
    renderBadge(r);
    renderMessages(r);
  }

  buildChecklist();
  applyLanguage();
  updateMode();
  show('home');
})();
