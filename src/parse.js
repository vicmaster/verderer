import { createHash } from 'node:crypto';

// A "rule" is a top-level bullet in a harness file. Continuation lines
// (indented 2+ spaces) belong to the bullet above; nested bullets too —
// they qualify the rule, they are not rules of their own.
export function parseRules(markdown, source) {
  const rules = [];
  let section = '';
  let current = null;

  const flush = () => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    rules.push({
      id: ruleId(text),
      text,
      source,
      section,
      line: current.line,
    });
    current = null;
  };

  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^#{1,6}\s+(.*)/);

    if (heading) {
      flush();
      section = heading[1].trim();
      continue;
    }

    if (/^- /.test(line)) {
      flush();
      current = { lines: [line.slice(2)], line: i + 1 };
      continue;
    }

    if (current && /^\s{2,}\S/.test(line)) {
      current.lines.push(line.trim());
      continue;
    }

    flush();
  }
  flush();

  return rules;
}

// Stable across reformatting: whitespace collapses before hashing.
export function ruleId(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}
