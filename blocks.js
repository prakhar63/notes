// A note's content is a list of blocks, text and checklists in any order:
//   { id, type: 'text', text }   { id, type: 'checklist', items: [{ id, text, done }] }
// Pure functions on those blocks. No DOM code here.

export const uid = () => crypto.randomUUID();
export const textBlock = (text = '') => ({ id: uid(), type: 'text', text });
export const newItem = (text = '', done = false) => ({ id: uid(), text, done });
export const checklistBlock = (items = [newItem()]) => ({ id: uid(), type: 'checklist', items });

/** Every checklist item in the note, in order. */
export const allItems = (note) => note.blocks.flatMap((b) => (b.type === 'checklist' ? b.items : []));

/** All the note's written content as plain text (for search, tags, previews). */
export const contentText = (note) =>
  note.blocks.map((b) => (b.type === 'text' ? b.text : b.items.map((it) => it.text).join('\n'))).join('\n');

export const blockIsEmpty = (b) => (b.type === 'text' ? !b.text.trim() : !b.items.some((it) => it.text.trim()));

// "- Milk", "2. Milk" and "[x] Milk" all become the checklist item "Milk" (the last one ticked).
const MARKER_RE = /^\s*(?:[-*•–]|\d{1,9}[.)])\s+/;
const BOX_RE = /^\s*\[( |x|X)\]\s*/;
function lineToItem(line) {
  const box = BOX_RE.exec(line);
  if (box) return newItem(line.slice(box[0].length), box[1] !== ' ');
  return newItem(line.replace(MARKER_RE, ''));
}

/** Joins two pieces of text with a line break, unless one of them is empty. */
const join = (a, b) => (a && b ? `${a}\n${b}` : a + b);

/**
 * The Checklist tool: turns the lines of text block `index` that the selection touches into
 * checklist items, right there, splitting the text around the new list. An empty line becomes
 * one empty item. A text block always follows the list, so you can keep writing below it.
 * Returns { blocks, focus: { blockId, item, caret } }.
 */
export function insertChecklist(blocks, index, selStart, selEnd) {
  const block = blocks[index];
  const text = block.text;
  const lineStart = selStart === 0 ? 0 : text.lastIndexOf('\n', selStart - 1) + 1;
  let lineEnd = text.indexOf('\n', selEnd);
  if (lineEnd === -1) lineEnd = text.length;

  const lines = text.slice(lineStart, lineEnd).split('\n');
  const filled = lines.filter((l) => l.trim());
  const list = checklistBlock(filled.length ? filled.map(lineToItem) : [newItem()]);
  const before = text.slice(0, lineStart).replace(/\n$/, '');
  const after = text.slice(lineEnd).replace(/^\n/, '');

  const out = blocks.slice(0, index);
  if (before.trim()) out.push({ ...block, text: before });
  out.push(list);
  const next = blocks[index + 1];
  if (next?.type === 'text') {
    out.push({ ...next, text: join(after, next.text) }, ...blocks.slice(index + 2));
  } else {
    out.push(textBlock(after), ...blocks.slice(index + 1));
  }
  const last = list.items.length - 1;
  return { blocks: out, focus: { blockId: list.id, item: last, caret: list.items[last].text.length } };
}

/** The Checklist tool with no text cursor: a new list at the end (reusing an empty last text block). */
export function appendChecklist(blocks) {
  const list = checklistBlock();
  const last = blocks[blocks.length - 1];
  const out = last?.type === 'text' && !last.text.trim() ? blocks.slice(0, -1) : [...blocks];
  out.push(list, textBlock());
  return { blocks: out, focus: { blockId: list.id, item: 0, caret: 0 } };
}

/**
 * Removes checklist block `index`. The text on either side joins back together, and the cursor
 * goes where the list was. Returns { blocks, focus: { blockId, caret } }.
 */
export function removeChecklist(blocks, index) {
  const prev = blocks[index - 1];
  const next = blocks[index + 1];
  const out = [...blocks];
  out.splice(index, 1);
  if (prev?.type === 'text' && next?.type === 'text') {
    out.splice(index - 1, 2, { ...prev, text: join(prev.text, next.text) });
    return { blocks: out, focus: { blockId: prev.id, caret: prev.text.length } };
  }
  if (prev?.type === 'text') return { blocks: out, focus: { blockId: prev.id, caret: prev.text.length } };
  if (next?.type === 'text') return { blocks: out, focus: { blockId: next.id, caret: 0 } };
  const t = textBlock();
  out.splice(index, 0, t);
  return { blocks: out, focus: { blockId: t.id, caret: 0 } };
}

/**
 * Enter on the empty last item of checklist `index`: leave the list. The empty item goes away
 * and the cursor moves to the text below (a new text block if there isn't one).
 */
export function exitChecklist(blocks, index) {
  const list = blocks[index];
  if (list.items.length <= 1) return removeChecklist(blocks, index);
  const out = [...blocks];
  out[index] = { ...list, items: list.items.slice(0, -1) };
  let next = out[index + 1];
  if (next?.type !== 'text') {
    next = textBlock();
    out.splice(index + 1, 0, next);
  }
  return { blocks: out, focus: { blockId: next.id, caret: 0 } };
}

/** Removes empty text block `index` (Backspace at its start); the cursor goes to the end of what came before. */
export function removeTextBlock(blocks, index) {
  if (blocks.length <= 1) return null;
  const out = [...blocks];
  out.splice(index, 1);
  const prev = out[index - 1];
  if (!prev) return { blocks: out, focus: { blockId: out[0].id, item: 0, caret: 0 } };
  if (prev.type === 'text') return { blocks: out, focus: { blockId: prev.id, caret: prev.text.length } };
  const lastItem = prev.items.length - 1;
  return { blocks: out, focus: { blockId: prev.id, item: lastItem, caret: prev.items[lastItem].text.length } };
}
