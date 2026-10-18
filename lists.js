// Smart lists for plain text: numbered ("1. " or "1) ") and bulleted ("- ", "* ", "• ", "– ") lines.
// Pure functions on (text, selection) -> new text and selection. No DOM code here.

const ITEM_RE = /^( *)(?:(\d{1,9})([.)])|([-*•–])) (.*)$/;
const INDENT = '  ';

function parseItem(line) {
  const m = ITEM_RE.exec(line);
  if (!m) return null;
  return {
    indent: m[1],
    num: m[2] === undefined ? null : Number(m[2]),
    delim: m[3] ?? '',
    bullet: m[4] ?? '',
    content: m[5],
    markerLength: line.length - m[5].length, // indent + marker + one space
  };
}

const formatItem = (it) =>
  `${it.indent}${it.num === null ? it.bullet : `${it.num}${it.delim}`} ${it.content}`;

// Where line i starts in the joined text.
const lineOffset = (lines, i) => lines.slice(0, i).reduce((sum, l) => sum + l.length + 1, 0);

function lineIndexAt(lines, pos) {
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    if (pos <= offset + lines[i].length) return i;
    offset += lines[i].length + 1;
  }
  return lines.length - 1;
}

// Renumber the run of list lines around line i so each numbered level counts up
// from wherever it starts (a list you begin at 5 keeps starting at 5).
function renumberBlock(lines, i) {
  let start = i;
  let end = i;
  while (start > 0 && parseItem(lines[start - 1])) start--;
  while (end < lines.length - 1 && parseItem(lines[end + 1])) end++;

  const counters = new Map(); // indent width -> next number at that level
  for (let k = start; k <= end; k++) {
    const it = parseItem(lines[k]);
    if (!it) continue;
    const depth = it.indent.length;
    for (const d of counters.keys()) if (d > depth) counters.delete(d); // left a deeper level
    if (it.num === null) {
      counters.delete(depth); // a bullet breaks the numbering at its level
      continue;
    }
    const n = counters.has(depth) ? counters.get(depth) : it.num;
    if (n !== it.num) lines[k] = formatItem({ ...it, num: n });
    counters.set(depth, n + 1);
  }
}

/**
 * Enter pressed with the caret at `pos`. Returns null to let the browser insert a plain
 * newline, or { text, selStart, selEnd } with the list continued, ended or outdented.
 */
export function listEnter(text, pos) {
  const lines = text.split('\n');
  const i = lineIndexAt(lines, pos);
  const it = parseItem(lines[i]);
  if (!it) return null;
  const col = pos - lineOffset(lines, i);
  if (col < it.markerLength) return null; // caret is inside the marker itself

  if (!it.content.trim()) {
    // Enter on an empty item: step out one level, or end the list at the top level.
    if (it.indent) {
      lines[i] = formatItem({ ...it, indent: it.indent.slice(INDENT.length), content: '' });
      renumberBlock(lines, i);
    } else {
      lines[i] = '';
    }
    const caret = lineOffset(lines, i) + lines[i].length;
    return { text: lines.join('\n'), selStart: caret, selEnd: caret };
  }

  // Split the line at the caret; the rest moves to a new item just below.
  const before = lines[i].slice(0, col);
  const after = lines[i].slice(col).replace(/^ +/, '');
  const next = { ...it, num: it.num === null ? null : it.num + 1, content: after };
  lines.splice(i, 1, before, formatItem(next));
  renumberBlock(lines, i + 1);
  const caret = lineOffset(lines, i + 1) + parseItem(lines[i + 1]).markerLength;
  return { text: lines.join('\n'), selStart: caret, selEnd: caret };
}

/**
 * The Numbered / Bulleted list buttons. Turns the selected lines (or the caret's line) into
 * that kind of list, or, if they all already are, back into plain lines.
 * `kind` is 'numbered' or 'bullet'.
 */
export function toggleList(text, selStart, selEnd, kind) {
  const lines = text.split('\n');
  const first = lineIndexAt(lines, selStart);
  const last = lineIndexAt(lines, selEnd);
  const caretFromEnd = lineOffset(lines, last) + lines[last].length - selEnd;
  const numbered = kind === 'numbered';
  const isKind = (it) => it && (numbered ? it.num !== null : it.num === null);

  // Blank lines inside a multi-line selection stay blank.
  const targets = [];
  for (let k = first; k <= last; k++) if (first === last || lines[k].trim()) targets.push(k);
  const removing = targets.every((k) => isKind(parseItem(lines[k])));

  // Continue the numbering of a numbered item right above, if there is one.
  const above = first > 0 ? parseItem(lines[first - 1]) : null;
  let n = above && above.num !== null ? above.num + 1 : 1;

  for (const k of targets) {
    const it = parseItem(lines[k]);
    if (removing) {
      lines[k] = it.indent + it.content;
      continue;
    }
    const indent = it ? it.indent : lines[k].match(/^ */)[0];
    const content = it ? it.content : lines[k].slice(indent.length);
    lines[k] = formatItem({
      indent,
      num: numbered ? n++ : null,
      delim: it?.delim || '.',
      bullet: it?.bullet || '-',
      content,
    });
  }
  renumberBlock(lines, first);

  if (selStart === selEnd) {
    const caret = lineOffset(lines, first) + lines[first].length - caretFromEnd;
    return { text: lines.join('\n'), selStart: caret, selEnd: caret };
  }
  return {
    text: lines.join('\n'),
    selStart: lineOffset(lines, first),
    selEnd: lineOffset(lines, last) + lines[last].length,
  };
}

/**
 * Tab (or Shift+Tab when `outdent`) over the selection. Returns null when no selected
 * line is a list item, so Tab keeps moving focus as usual.
 */
export function listIndent(text, selStart, selEnd, outdent) {
  const lines = text.split('\n');
  const first = lineIndexAt(lines, selStart);
  const last = lineIndexAt(lines, selEnd);
  const caretFromEnd = lineOffset(lines, last) + lines[last].length - selEnd;
  let changed = false;

  for (let k = first; k <= last; k++) {
    const it = parseItem(lines[k]);
    if (!it) continue;
    if (outdent && !it.indent) continue;
    const indent = outdent ? it.indent.slice(INDENT.length) : it.indent + INDENT;
    // A newly nested numbered item starts its own count at 1.
    const num = it.num === null ? null : (outdent ? it.num : 1);
    lines[k] = formatItem({ ...it, indent, num });
    changed = true;
  }
  if (!changed) return parseItem(lines[first]) ? { text, selStart, selEnd } : null; // Shift+Tab at top level: stay put
  renumberBlock(lines, first);

  if (selStart === selEnd) {
    const caret = lineOffset(lines, first) + lines[first].length - caretFromEnd;
    return { text: lines.join('\n'), selStart: caret, selEnd: caret };
  }
  return {
    text: lines.join('\n'),
    selStart: lineOffset(lines, first),
    selEnd: lineOffset(lines, last) + lines[last].length,
  };
}
