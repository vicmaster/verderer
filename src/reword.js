// A rule's id is a hash of its text, so rewording a rule looks like one rule
// leaving and another arriving. Pair them back up so the rule keeps its
// provenance and verdict.
//
// Two checks, both calibrated on real harness files:
// - same slot: a rewording is an edit in place, so both sit right after the
//   same unchanged rule. This keeps rolling lists (add at top, drop at the
//   bottom) and templated sibling bullets from pairing up.
// - similar words: Dice over word sets >= 0.4, or a trim that keeps every
//   word of the shorter wording ("ESM only; imports use .js" → "ESM only").
const MIN_SIMILARITY = 0.4;
const MIN_SHARED_WORDS = 2;

// prior: every rule in the ledger; scanned: the rules in the files now.
// Returns Map(new id → the prior rule it rewords).
export function pairRewordings(prior, scanned) {
  const known = new Set(prior.map((r) => r.id));
  const current = new Set(scanned.map((r) => r.id));
  const active = prior.filter((r) => r.status === 'active');
  const unchanged = new Set(active.filter((r) => current.has(r.id)).map((r) => r.id));

  const departed = slotted(active, unchanged).filter(({ rule }) => !current.has(rule.id));
  const arrived = slotted(scanned, unchanged).filter(({ rule }) => !known.has(rule.id));

  const candidates = [];
  for (const before of departed) {
    for (const after of arrived) {
      if (before.slot !== after.slot) continue;
      const score = similarity(before.rule.text, after.rule.text);
      if (score !== null) candidates.push({ before: before.rule, after: after.rule, score });
    }
  }

  const pairs = new Map();
  const taken = new Set();
  for (const { before, after } of candidates.sort((a, b) => b.score - a.score)) {
    if (pairs.has(after.id) || taken.has(before.id)) continue;
    pairs.set(after.id, before);
    taken.add(before.id);
  }

  return pairs;
}

// Dice coefficient over word sets, or null when the texts don't look like
// the same rule.
export function similarity(a, b) {
  const wordsA = words(a);
  const wordsB = words(b);
  const shared = [...wordsA].filter((w) => wordsB.has(w)).length;
  const dice = (2 * shared) / (wordsA.size + wordsB.size || 1);
  const trimmed = shared >= MIN_SHARED_WORDS && shared === Math.min(wordsA.size, wordsB.size);

  return dice >= MIN_SIMILARITY || trimmed ? dice : null;
}

// Where a rule sits: its file and the nearest unchanged rule above it.
// Rules are in file order (the ledger keeps scan order).
function slotted(rules, unchanged) {
  const anchors = new Map();

  return rules.map((rule) => {
    const slot = `${rule.source}:${anchors.get(rule.source) ?? ''}`;
    if (unchanged.has(rule.id)) anchors.set(rule.source, rule.id);
    return { rule, slot };
  });
}

function words(text) {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}
