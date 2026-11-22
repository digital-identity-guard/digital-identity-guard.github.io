/*
 * Digital Identity Guard — account check (manual checklist or automatic analysis).
 *
 * Manual:  the user ticks the 12 checklist items. Each item has a weight (they add up to 10);
 *          the score is the sum of the ticked weights, rounded down.
 *          Failing item 4 (look-alike handle) or item 12 (money / private chat) caps the score at 3.
 * AI:      the account is analysed against 9 indicator groups. Groups that need the
 *          profile's own data (age, followers, posts...) cannot be read by a browser-only
 *          site, so they are shown as "not checked" and the score is capped at 5
 *          ("Public info") until the identity itself can be confirmed.
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

  const SUPPORTED = ['x', 'linkedin'];

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
    { id: 'g4', items: ['g4.timing', 'g4.original', 'g4.style', 'g4.topic', 'g4.automation'] },
    { id: 'g5', items: ['g5.rate', 'g5.comments', 'g5.coordinated'] },
    { id: 'g6', items: ['g6.same', 'g6.matching', 'g6.backlinks'] },
    { id: 'g7', items: ['g7.job', 'g7.education', 'g7.footprint'] },
    { id: 'g8', items: ['g8.biolinks', 'g8.breach', 'g8.exif', 'g8.shortened'] },
    { id: 'g9', items: ['g9.money', 'g9.private', 'g9.impersonation', 'g9.displayname'] },
  ];

  // Indicators a browser-only site can decide; everything else needs the profile's own data.
  const IDENTITY_GROUPS = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'];

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

  function analyzeAI(input, base, msg, hf, remote) {
    const status = (bad) => (bad ? 'fail' : 'pass');
    const ai = (remote && remote.indicators) || {};

    // Every link we can see: the account link (if it is not the platform itself) and links in the message.
    const links = msg.result.links.map((l) => l.findings.map((f) => f.id));
    if (base.parsed.kind === 'link') links.push(hf.link.map((f) => f.id));
    const anyLinks = msg.result.links.length > 0;
    const linkBad = links.some((ids) => ids.some((id) => ['lookalike_domain', 'punycode_domain', 'ip_host', 'unknown_domain', 'insecure_link'].includes(id)));
    const shortened = links.some((ids) => ids.includes('shortener'));

    const auto = {
      'g8.biolinks': anyLinks || hf.linkBad ? status(linkBad) : 'unknown',
      'g8.shortened': anyLinks || hf.linkBad ? status(shortened) : 'unknown',
      'g9.money': msg.given ? status(msg.money) : 'unknown',
      'g9.private': msg.given ? status(msg.private) : 'unknown',
      'g9.impersonation': status(hf.lookalike || !!hf.keyword),
    };
    const params = { 'g9.impersonation': hf.keyword ? { kw: hf.keyword.params.kw } : {} };

    // Combine Claude's verdict with the browser's own checks. A failure found by either side wins.
    const combine = (id) => {
      const a = auto[id] || 'unknown';
      const r = ai[id] ? ai[id].status : 'unknown';
      if (a === 'fail' || r === 'fail') return 'fail';
      if (a === 'pass' || r === 'pass') return 'pass';
      return 'unknown';
    };
    const groups = AI_GROUPS.map((g) => ({
      id: g.id,
      items: g.items.map((id) => ({
        id, status: combine(id), params: params[id] || {},
        note: ai[id] && ai[id].note ? ai[id].note : '',
        source: ai[id] && ai[id].status !== 'unknown' ? 'ai' : (auto[id] && auto[id] !== 'unknown' ? 'local' : null),
      })),
    }));

    const all = groups.flatMap((g) => g.items);
    const passed = all.filter((i) => i.status === 'pass').length;
    const failed = all.filter((i) => i.status === 'fail').length;
    const checked = passed + failed;
    let score = checked ? Math.round((10 * passed) / checked) : 0;

    const caps = [];
    const st = (id) => (groups.flatMap((g) => g.items).find((i) => i.id === id) || {}).status;
    const aiHard = (remote && remote.message_findings || []).some((f) => f.severity === 'decisive');
    const hard = hf.lookalike || msg.credentials || msg.money || msg.private || msg.dangerousLink || aiHard ||
      st('g9.money') === 'fail' || st('g9.private') === 'fail' || st('g9.impersonation') === 'fail';
    if (hard && score > 3) { score = 3; caps.push('hard'); }
    const identityChecked = groups.some((g) => IDENTITY_GROUPS.includes(g.id) && g.items.some((i) => i.status !== 'unknown'));
    if (!identityChecked && score > 5) { score = 5; caps.push('identity'); }
    // Few confirmed indicators means weak evidence: "Personal info" needs at least half of them checked.
    const coverage = checked / all.length;
    if (coverage < 0.25 && score > 5) { score = 5; caps.push('coverage_low'); }
    else if (coverage < 0.5 && score > 7) { score = 7; caps.push('coverage_half'); }

    return { mode: 'ai', groups, passed, failed, checked, total: all.length, score, caps,
      remote: remote ? { summary: remote.summary || '', profileFound: !!remote.profile_found,
        findings: remote.message_findings || [], remaining: remote.remaining } : null };
  }

  /**
   * @param {{mode: 'manual'|'ai', account: string, platform?: string, message?: string,
   *          badge?: string, manual?: string[]}} input
   * @param {object} [remote] the AI backend's answer, when it was reached
   */
  function analyze(input, remote) {
    const base = parseInput(input.account, input.platform);
    if (base.error) return { error: base.error, parsed: base.parsed };
    const msg = messageFlags(input.message);
    const hf = handleFlags(base.parsed);
    const r = input.mode === 'ai' ? analyzeAI(input, base, msg, hf, remote) : analyzeManual(input, base, msg, hf);
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
