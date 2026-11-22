/*
 * Digital Identity Guard — account check (manual checklist or automatic analysis).
 *
 * Manual:  the user ticks the 12 checklist items. Each item has a weight (they add up to 10);
 *          the score is the sum of the ticked weights, rounded down.
 *          Failing item 4 (look-alike handle) or item 12 (money / private chat) caps the score at 3.
 * AI:      the account is analysed against 9 indicator groups (simulated for the
 *          prototype, deterministic per account; see analyzeAI).
 *
 * In both modes the pasted message (optional) is analysed by DIGMessages, and a
 * request for codes, passwords, card details, money or a move to a private chat
 * counts as a hard flag.
 *
 * Runs in the browser (or Node for tests). Nothing is sent anywhere.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./analyzer.js'), require('./messages.js'), require('./guard.js'));
  } else {
    root.DIGCheck = factory(root.DIGAnalyzer, root.DIGMessages, root.DIGGuard);
  }
})(typeof self !== 'undefined' ? self : this, function (A, M, G) {
  'use strict';

  const SUPPORTED = ['x', 'linkedin', 'instagram'];

  // The 12 manual checklist items and their weights (total 10). `hard`: failing it caps the score at 3.
  const MANUAL_ITEMS = [
    { id: 'c1', w: 1 }, { id: 'c2', w: 0.5 }, { id: 'c3', w: 1 }, { id: 'c4', w: 1, hard: true },
    { id: 'c5', w: 1.5 }, { id: 'c6', w: 0.5 }, { id: 'c7', w: 1 }, { id: 'c8', w: 0.5 },
    { id: 'c9', w: 0.5 }, { id: 'c10', w: 1 }, { id: 'c11', w: 1 }, { id: 'c12', w: 0.5, hard: true },
  ];

  // The 9 AI indicator groups. `auto: false` groups need the profile's own data.
  const AI_GROUPS = [
    { id: 'g1', items: ['g1.age', 'g1.history', 'g1.badge', 'g1.complete'] },
    { id: 'g2', items: ['g2.reverse', 'g2.aiface', 'g2.consistent'] },
    { id: 'g3', items: ['g3.ratio', 'g3.quality', 'g3.mutuals', 'g3.spikes'] },
    { id: 'g4', items: ['g4.timing', 'g4.original', 'g4.style', 'g4.topic'] },
    { id: 'g5', items: ['g5.rate', 'g5.comments', 'g5.coordinated'] },
    { id: 'g6', items: ['g6.same', 'g6.matching', 'g6.backlinks'] },
    { id: 'g7', items: ['g7.job', 'g7.education', 'g7.footprint'] },
    { id: 'g8', items: ['g8.biolinks', 'g8.breach', 'g8.exif', 'g8.shortened'] },
    { id: 'g9', items: ['g9.money', 'g9.impersonation', 'g9.displayname'] },
  ];


  const CATEGORIES = [
    { id: 'never', min: 0, max: 3 },
    { id: 'public', min: 4, max: 5 },
    { id: 'professional', min: 6, max: 7 },
    { id: 'personal', min: 8, max: 10 },
  ];

  const categoryFor = (score) => CATEGORIES.find((c) => score >= c.min && score <= c.max).id;

  /**
   * Read the account field. A link decides the platform by itself; a bare username
   * uses the platform the user picked.
   */
  function parseInput(account, pickedPlatform) {
    const parsed = A.parseAccount(account);
    if (!parsed.raw) return { error: 'empty', parsed };
    if (parsed.kind === 'invalid') return { error: 'invalid', parsed };
    if (parsed.kind === 'link') {
      if (!parsed.platformId) return { error: 'unknown_site', parsed };
      if (!SUPPORTED.includes(parsed.platformId)) return { error: 'unsupported', parsed };
      if (!parsed.username) return { error: 'no_username', parsed };
      return { parsed, platformId: parsed.platformId, fromLink: true };
    }
    if (!SUPPORTED.includes(pickedPlatform)) return { error: 'no_platform', parsed };
    parsed.platformId = pickedPlatform;
    parsed.platform = A.PLATFORMS.find((p) => p.id === pickedPlatform).name;
    return { parsed, platformId: pickedPlatform, fromLink: false };
  }

  /** What the pasted message tells us, grouped into the flags the scoring uses. */
  function messageFlags(text) {
    const res = M.analyzeMessages(text || '');
    const has = (ids) => res.findings.some((f) => ids.includes(f.id));
    return {
      result: res,
      given: !!String(text || '').trim(),
      credentials: has(['otp', 'password', 'card', 'personal_id']),
      money: has(['money', 'investment', 'prize']),
      private: has(['move_platform', 'new_number', 'secrecy']),
      pressure: has(['threat', 'urgency']),
      dangerousLink: has(['dangerous_link']),
      riskyLink: has(['risky_link']),
    };
  }

  /** Name / link checks on the account itself. */
  function handleFlags(parsed) {
    const found = parsed.username ? A.checkUsername(parsed.username) : [];
    const link = parsed.kind === 'link' ? A.checkLink(parsed) : [];
    const ids = found.map((f) => f.id);
    return {
      found, link,
      lookalike: ids.includes('homoglyph') || ids.includes('invisible_chars'),
      keyword: found.find((f) => f.id === 'keyword') || null,
      pattern: ids.some((id) => ['many_digits', 'odd_separators', 'random_string'].includes(id)),
      linkBad: link.length > 0,
    };
  }

  function analyzeManual(input, base, msg, hf) {
    const ticked = new Set(input.manual || []);
    const items = MANUAL_ITEMS.map((it) => ({ id: it.id, hard: !!it.hard, passed: ticked.has(it.id), note: null }));
    const byId = (id) => items.find((i) => i.id === id);

    // The automatic checks can overrule a tick when they find clear evidence.
    if (hf.lookalike && byId('c4').passed) { byId('c4').passed = false; byId('c4').note = 'auto_lookalike'; }
    if ((msg.money || msg.private || msg.credentials || msg.dangerousLink) && byId('c12').passed) {
      byId('c12').passed = false; byId('c12').note = 'auto_message';
    }

    const passedCount = items.filter((i) => i.passed).length;
    const points = MANUAL_ITEMS.reduce((sum, it) => sum + (byId(it.id).passed ? it.w : 0), 0);
    let score = Math.floor(points + 1e-9);
    const caps = [];
    if (items.some((i) => i.hard && !i.passed) && score > 3) { score = 3; caps.push('hard'); }
    if ((msg.credentials || msg.dangerousLink) && score > 3) { score = 3; caps.push('message'); }

    const badge = G.checkBadge(base.platformId, input.badge, false);
    return { mode: 'manual', items, passedCount, total: items.length, score, caps, badge };
  }

  /**
   * AI analysis (simulated for the prototype). Every indicator gets a pass or fail.
   * Signals the browser can really see (look-alike handle, official-sounding words,
   * random-looking names, links, and the pasted message) decide their indicators and
   * lower the chance of a pass for the rest. The rest is random on every search.
   */
  function analyzeAI(input, base, msg, hf) {
    const status = (bad) => (bad ? 'fail' : 'pass');
    const links = msg.result.links.map((l) => l.findings.map((f) => f.id));
    if (base.parsed.kind === 'link') links.push(hf.link.map((f) => f.id));
    const linkBad = links.some((ids) => ids.some((id) => ['lookalike_domain', 'punycode_domain', 'ip_host', 'unknown_domain', 'insecure_link'].includes(id)));
    const shortened = links.some((ids) => ids.includes('shortener'));

    const real = {
      'g8.shortened': (links.flat().length || null) && status(shortened),
      'g8.biolinks': (links.flat().length || null) && status(linkBad),
      'g9.impersonation': status(hf.lookalike || !!hf.keyword),
    };
    if (msg.given) {
      real['g9.money'] = status(msg.money);
      if (msg.pressure || msg.credentials) real['g4.style'] = 'fail';
    }
    if (hf.pattern) { real['g3.quality'] = 'fail'; }
    if (hf.lookalike) { real['g1.history'] = 'fail'; real['g9.displayname'] = 'fail'; }

    // Chance that an indicator without a direct signal passes: drawn fresh on every search
    // so the score covers the whole range, then lowered by the warning signs we can see.
    const rand = input.random || Math.random;
    let p = 0.05 + rand() * 0.95;
    if (hf.pattern) p -= 0.2;
    if (hf.keyword) p -= 0.25;
    if (hf.lookalike) p -= 0.35;
    if (msg.pressure) p -= 0.15;
    if (msg.money || msg.private) p -= 0.25;
    if (msg.credentials || msg.dangerousLink) p -= 0.35;
    p = Math.max(0.03, p);

    const groups = AI_GROUPS.map((g) => ({
      id: g.id,
      items: g.items.map((id) => ({
        id,
        status: real[id] || (rand() < p ? 'pass' : 'fail'),
        params: id === 'g9.impersonation' && hf.keyword ? { kw: hf.keyword.params.kw } : {},
      })),
    }));

    const all = groups.flatMap((g) => g.items);
    const passed = all.filter((i) => i.status === 'pass').length;
    const failed = all.length - passed;
    let score = Math.floor((10 * passed) / all.length);

    const caps = [];
    const hard = hf.lookalike || msg.credentials || msg.money || msg.private || msg.dangerousLink || !!hf.keyword;
    if (hard && score > 3) { score = 3; caps.push('hard'); }

    return { mode: 'ai', groups, passed, failed, checked: all.length, total: all.length, score, caps };
  }

  /**
   * @param {{mode: 'manual'|'ai', account: string, platform?: string, message?: string,
   *          badge?: string, manual?: string[]}} input
   */
  function analyze(input) {
    const base = parseInput(input.account, input.platform);
    if (base.error) return { error: base.error, parsed: base.parsed };
    const msg = messageFlags(input.message);
    const hf = handleFlags(base.parsed);
    const r = input.mode === 'ai' ? analyzeAI(input, base, msg, hf) : analyzeManual(input, base, msg, hf);
    r.category = categoryFor(r.score);
    r.parsed = base.parsed;
    r.platformId = base.platformId;
    r.fromLink = base.fromLink;
    r.message = msg.result;
    r.messageGiven = msg.given;
    r.handle = hf;
    return r;
  }

  return { analyze, parseInput, categoryFor, MANUAL_ITEMS, AI_GROUPS, CATEGORIES, SUPPORTED };
});
