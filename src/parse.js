import { createHash } from 'node:crypto';

// spec-kit rewrites these sections from feature plans on every run (its
// update-agent-context script finds them by heading): tool output, not rules.
const GENERATED_SECTIONS = new Set(['Active Technologies', 'Recent Changes']);

const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+/;
const BOLD_LEAD = /^\*\*[^*]+\*\*/;
const BOLD_LABEL = /^\*\*[^*]+\*\*:?$/; // "**Why this matters:**" heads what follows
const FENCE = /^\s*(?:```|~~~)/;
const THEMATIC_BREAK = /^([-*_])(?:\s*\1){2,}\s*$/;
const CONTINUATION = /^\s{2,}\S/;

// A "rule" is a top-level list item (-, *, +, 1., 1)) or a paragraph that
// opens with a bold lead ("**Never trust a merged schema.** Every module…");
// a bold label alone ("**Quick Tips:**") is a heading in disguise, not a rule.
// Indented lines belong to the item above, nested lists too: they qualify the
// rule, they are not rules of their own. Plain prose and code are not rules.
export function parseRules(markdown, source) {
  const rules = [];
  let section = '';
  let current = null;
  let fence = null;
  let afterBlank = true;

  const flush = () => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    if (!(current.paragraph && BOLD_LABEL.test(text))) {
      rules.push({ id: ruleId(text), text, source, section, line: current.line });
    }
    current = null;
  };

  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const blank = line.trim() === '';

    // Code: skipped, unless it is indented under a rule (an example inside it).
    if (fence) {
      if (fence.owner && !blank) fence.owner.lines.push(line.trim());
      if (FENCE.test(line)) {
        fence = null;
        afterBlank = true;
      }
      continue;
    }

    if (FENCE.test(line)) {
      const owner = current && CONTINUATION.test(line) ? current : null;
      if (owner) owner.lines.push(line.trim());
      else flush();
      fence = { owner };
      continue;
    }

    const heading = line.match(/^#{1,6}\s+(.*)/);
    if (heading) {
      flush();
      section = heading[1].trim();
      afterBlank = true;
      continue;
    }

    if (GENERATED_SECTIONS.has(section)) continue;

    const item = line.match(LIST_ITEM);
    if (item && !THEMATIC_BREAK.test(line)) {
      flush();
      current = { lines: [line.slice(item[0].length)], line: i + 1, paragraph: false };
      afterBlank = false;
      continue;
    }

    if (current && (CONTINUATION.test(line) || (current.paragraph && !blank))) {
      current.lines.push(line.trim());
      continue;
    }

    flush();

    if (afterBlank && BOLD_LEAD.test(line)) {
      current = { lines: [line], line: i + 1, paragraph: true };
    }
    afterBlank = blank;
  }
  flush();

  return rules;
}

// Stable across reformatting: whitespace collapses before hashing.
export function ruleId(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}
