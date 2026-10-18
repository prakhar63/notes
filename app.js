import {
  loadNotes, saveNotes, STORAGE_KEY, NOTEBOOKS_KEY, loadNotebooks, saveNotebooks,
  backupJSON, parseBackup, mergeNotes,
} from './store.js';
import { listEnter, listIndent, toggleList } from './lists.js';
import {
  prepareImage, addImage, getImage, cleanUpImages, blobToDataURL, dataURLToBlob,
} from './images.js';
import {
  uid, textBlock, checklistBlock, newItem, allItems, contentText, blockIsEmpty,
  insertChecklist, appendChecklist, removeChecklist, exitChecklist, removeTextBlock,
} from './blocks.js';
import { host, join, parsePairHash, qrCode, CODE_MS } from './sync.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TRASH_DAYS = 30;

const PALETTE = [
  { id: 'paper', name: 'Paper' },
  { id: 'cornflower', name: 'Cornflower' },
  { id: 'chartreuse', name: 'Chartreuse' },
  { id: 'peach', name: 'Peach' },
  { id: 'mint', name: 'Mint' },
  { id: 'pink', name: 'Pink' },
];

// Small helpers for remembered settings (they fail quietly when storage is blocked).
const getSetting = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const setSetting = (key, value) => { try { localStorage.setItem(key, value); } catch { /* not remembered */ } };

// A quick tour, shown once on first run.
function welcomeNote() {
  const t = Date.now();
  return {
    id: uid(),
    title: 'Welcome to your notebook',
    blocks: [
      textBlock('Write anything, anywhere. Everything saves as you type, right here on this device.\n\nA few things to try:'),
      checklistBlock([
        newItem('Tap + to start a note'),
        newItem('Open Aa for color, ruled or dotted paper, and a checklist'),
        newItem('Type #ideas anywhere to tag a note'),
        newItem('Group notes into a notebook from the "All notes" menu'),
        newItem('On a phone, swipe a note left to delete or right to pin'),
      ]),
      textBlock('Back up your notes now and then from More → Back up notes.'),
    ],
    color: 'chartreuse',
    createdAt: t,
    updatedAt: t,
  };
}

const saved = loadNotes();
const firstRun = saved === null;
const notes = saved ?? [welcomeNote()];
let notebooks = loadNotebooks();
const byRecent = (a, b) => b.updatedAt - a.updatedAt;

const isDeleted = (note) => Number.isFinite(note.deletedAt);

// Notes in Trash for more than 30 days are gone for good.
for (let i = notes.length - 1; i >= 0; i--) {
  if (isDeleted(notes[i]) && Date.now() - notes[i].deletedAt > TRASH_DAYS * DAY) notes.splice(i, 1);
}

// What the list shows: 'all', 'trash', or a notebook id.
let view = getSetting('notes.view') ?? 'all';
if (view !== 'all' && view !== 'trash' && !notebooks.some((nb) => nb.id === view)) view = 'all';

let activeId = notes.filter((n) => !isDeleted(n)).sort(byRecent)[0]?.id ?? null;

const $ = (sel) => document.querySelector(sel);
const listEl = $('#note-list');
const countEl = $('#count');
const editorEl = $('#editor');
const swatchesEl = $('#swatches');
const titleEl = $('#title');
const blocksEl = $('#blocks');
const metaEl = $('#meta');
const searchEl = $('#search');
const sortEl = $('#sort');
const tagFilterEl = $('#tag-filter');
const noteTagsEl = $('#note-tags');
const noteDateEl = $('#note-date');
const pageEl = $('.page');
const trayEl = $('#tray');
const paperEl = $('#paper-styles');
const kbToolsEl = $('#kb-tools');
const noteNotebookEl = $('#note-notebook');
const pinBtn = $('#pin');
const deleteBtn = $('#delete');
const phoneLayout = matchMedia('(max-width: 719px)');

const colorVar = (color) => `var(--c-${color})`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------- What's in a note ----------

const activeNote = () => notes.find((n) => n.id === activeId);
const imagesOf = (note) => note.images ?? [];
const isPinned = (note) => Number.isFinite(note.pinnedAt) && !isDeleted(note);
const noteText = (note) => `${note.title}\n${contentText(note)}`;
const isBlank = (note) => !note.title.trim() && note.blocks.every(blockIsEmpty) && !imagesOf(note).length;
const notebookName = (id) => notebooks.find((nb) => nb.id === id)?.name ?? null;

// Pieces of a note for its list tile, in order: text lines and "☐ item" / "☑ item".
function contentPieces(note) {
  const pieces = [];
  for (const b of note.blocks) {
    if (b.type === 'text') for (const line of b.text.split('\n')) { if (line.trim()) pieces.push(line.trim()); }
    else for (const it of b.items) { if (it.text.trim()) pieces.push(`${it.done ? '☑' : '☐'} ${it.text.trim()}`); }
  }
  return pieces;
}

function displayTitle(note) {
  if (note.title.trim()) return note.title.trim();
  const first = contentPieces(note)[0];
  return first ? first.replace(/^[☐☑] /, '') : 'Untitled';
}

function preview(note) {
  const pieces = contentPieces(note);
  return (note.title.trim() ? pieces : pieces.slice(1)).join('  ');
}

// ---------- Search and sort ----------

const SORT_KEY = 'notes.sort';
const SORTS = {
  updated: (a, b) => b.updatedAt - a.updatedAt,
  created: (a, b) => b.createdAt - a.createdAt,
  title: (a, b) => displayTitle(a).localeCompare(displayTitle(b), undefined, { sensitivity: 'base', numeric: true }),
};
const SORT_LABELS = { updated: 'Last edited', created: 'Date created', title: 'Title A–Z' };

let sortBy = getSetting(SORT_KEY);
if (!(sortBy in SORTS)) sortBy = 'updated';
sortEl.value = sortBy;

const sortNotes = (list) => [...list].sort(view === 'trash' ? (a, b) => b.deletedAt - a.deletedAt : SORTS[sortBy]);
const searchWords = () => searchEl.value.toLowerCase().split(/\s+/).filter(Boolean);

// ---------- #hashtags ----------

// A tag is # followed by letters, digits, - or _, at the start of a line or after a space
// (so "page#2" or a URL's "#section" isn't a tag). It needs at least one letter: "#1" isn't one.
const TAG_RE = /(^|\s)#([\p{L}\p{N}_-]+)/gu;
let activeTag = null; // lowercase tag the list is filtered by, or null

function tagsOf(note) {
  const tags = new Set();
  for (const m of noteText(note).matchAll(TAG_RE)) {
    const tag = m[2].replace(/[-_]+$/, '').toLowerCase();
    if (/\p{L}/u.test(tag)) tags.add(tag);
  }
  return [...tags];
}

function tagCounts(list) {
  const counts = new Map();
  for (const note of list) for (const tag of tagsOf(note)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return counts;
}

// ---------- Which notes the list shows ----------

function inView(note) {
  if (view === 'trash') return isDeleted(note);
  if (isDeleted(note)) return false;
  return view === 'all' || note.notebookId === view;
}
const viewNotes = () => notes.filter(inView);

// Every word typed must appear somewhere in the note, and the note must carry the active tag.
function visibleNotes() {
  const words = searchWords();
  let matches = viewNotes();
  if (activeTag) matches = matches.filter((n) => tagsOf(n).includes(activeTag));
  if (words.length) {
    matches = matches.filter((n) => {
      const text = noteText(n).toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }
  return sortNotes(matches);
}

// ---------- Dates ----------

function shortDate(ts) {
  const diff = Date.now() - ts;
  if (diff < MIN) return 'now';
  if (diff < HOUR) return `${Math.round(diff / MIN)}m`;
  if (diff < DAY) return `${Math.round(diff / HOUR)}h`;
  if (diff < 2 * DAY) return 'Yesterday';
  const d = new Date(ts);
  if (diff < 7 * DAY) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const startOfToday = () => new Date().setHours(0, 0, 0, 0);

function dayGroup(ts) {
  const today = startOfToday();
  if (ts >= today) return 'Today';
  if (ts >= today - DAY) return 'Yesterday';
  if (ts >= today - 6 * DAY) return 'Earlier this week';
  return 'Earlier';
}

// "Edited today, 9:41" above the title
function editedLabel(ts) {
  const time = new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = startOfToday();
  if (ts >= today) return `Edited today, ${time}`;
  if (ts >= today - DAY) return `Edited yesterday, ${time}`;
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `Edited ${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) })}`;
}

// ---------- The list ----------

// Date line under search: "Sunday, 18 October · 2 notes today"
function renderToday() {
  const now = new Date();
  const day = document.createElement('span');
  day.className = 'today-day';
  day.textContent = now.toLocaleDateString(undefined, { weekday: 'long' });
  const edited = notes.filter((n) => !isDeleted(n) && n.updatedAt >= startOfToday()).length;
  const date = now.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  $('#today').replaceChildren(day, `, ${date}` + (edited ? ` · ${edited} ${edited === 1 ? 'note' : 'notes'} today` : ''));
}

// The chip row above the list: every tag in the current view, most-used first.
function renderTagFilter() {
  const counts = tagCounts(viewNotes());
  if (activeTag && !counts.has(activeTag)) activeTag = null; // its last note lost the tag

  const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  tagFilterEl.hidden = !tags.length || view === 'trash';
  tagFilterEl.replaceChildren(...tags.map(([tag, count]) => {
    const chip = el('button', 'tag-chip', `#${tag}`);
    chip.type = 'button';
    chip.dataset.tag = tag;
    chip.setAttribute('aria-pressed', String(tag === activeTag));
    chip.append(el('span', 'tag-count', ` ${count}`));
    return chip;
  }));
}

function setActiveTag(tag) {
  activeTag = tag === activeTag ? null : tag;
  renderList();
}

// Text with the searched words wrapped in <mark>.
function highlighted(node, text, words) {
  if (!words.length) { node.textContent = text; return node; }
  const lower = text.toLowerCase();
  const ranges = [];
  for (const w of words) {
    let i = lower.indexOf(w);
    while (i !== -1) { ranges.push([i, i + w.length]); i = lower.indexOf(w, i + w.length); }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let pos = 0;
  for (const [s, e] of ranges) {
    if (s < pos) continue;
    node.append(text.slice(pos, s), el('mark', '', text.slice(s, e)));
    pos = e;
  }
  node.append(text.slice(pos));
  return node;
}

// When searching, show the part of the note where the first word appears.
function previewFor(note, words) {
  const base = preview(note);
  if (!words.length || displayTitle(note).toLowerCase().includes(words[0])) return base;
  const full = contentPieces(note).join('  ');
  const i = full.toLowerCase().indexOf(words[0]);
  if (i === -1) return base;
  return (i > 24 ? '…' : '') + full.slice(Math.max(0, i - 24));
}

function renderList() {
  renderToday();
  renderNotebookButton();
  renderBackupNudge();
  renderTagFilter();
  $('#sort-label').textContent = SORT_LABELS[sortBy];
  $('.sort').hidden = view === 'trash';

  const shown = visibleNotes();
  const inThisView = viewNotes().length;
  const total = `${inThisView} ${inThisView === 1 ? 'note' : 'notes'}`;
  countEl.textContent = (shown.length === inThisView ? total : `${shown.length} of ${total}`)
    + (activeTag ? ` · #${activeTag}` : '');

  const parts = [];
  if (view === 'trash' && inThisView) {
    const info = el('li', 'trash-info');
    info.append(el('span', '', `Notes here are deleted for good after ${TRASH_DAYS} days.`));
    const empty = el('button', 'trash-empty', 'Empty Trash');
    empty.type = 'button';
    empty.id = 'empty-trash';
    info.append(empty);
    parts.push(info);
  }

  if (!shown.length) {
    let msg = 'No notes yet. Tap + to start one.';
    if (view === 'trash') msg = 'Trash is empty.';
    else if (inThisView) msg = activeTag && !searchEl.value.trim() ? `No notes tagged #${activeTag}.` : 'No notes match your search.';
    else if (view !== 'all') msg = 'No notes in this notebook yet. Tap + to add one.';
    listEl.replaceChildren(...parts, el('li', 'list-empty', msg));
    return;
  }

  const words = searchWords();
  const dateOf = (note) => (view === 'trash' ? note.deletedAt : sortBy === 'created' ? note.createdAt : note.updatedAt);

  const item = (note) => {
    // The tile wears the note's color (lightly); the open note is deep blue.
    const btn = el('button', 'note-item');
    btn.type = 'button';
    btn.dataset.id = note.id;
    btn.dataset.color = note.color;
    btn.style.setProperty('--c', colorVar(note.color));
    if (note.id === activeId) btn.setAttribute('aria-current', 'true');

    // Pinned notes show a pin where the date would be. In "All notes", the notebook's name too.
    const end = el('span', 'note-end');
    const nbName = view === 'all' ? notebookName(note.notebookId) : null;
    if (nbName) end.append(el('span', 'note-nb', nbName));
    if (isPinned(note) && view !== 'trash') {
      const pin = el('span', 'note-pin');
      pin.innerHTML = PIN_ICON;
      pin.setAttribute('role', 'img');
      pin.setAttribute('aria-label', 'Pinned');
      end.append(pin);
    } else {
      end.append(el('span', 'note-date', shortDate(dateOf(note))));
    }

    const main = el('span', 'note-main');
    const row = el('span', 'note-row');
    row.append(el('span', 'dot'), highlighted(el('span', 'note-title'), displayTitle(note), words), end);
    main.append(row, highlighted(el('span', 'note-preview'), previewFor(note, words) || ' ', words));

    // Checklists: a thin progress line ("4 of 6").
    const filled = allItems(note).filter((it) => it.text.trim());
    if (filled.length) {
      const done = filled.filter((it) => it.done).length;
      const progress = el('span', 'note-progress');
      const bar = el('span', 'note-progress-bar');
      const fill = el('span', 'note-progress-fill');
      fill.style.width = `${Math.round((done / filled.length) * 100)}%`;
      bar.append(fill);
      progress.append(bar, el('span', 'note-progress-text', `${done} of ${filled.length}`));
      main.append(progress);
    }
    btn.append(main);

    // Notes with pictures: the first one as a small thumbnail.
    const [firstImage] = imagesOf(note);
    if (firstImage) {
      const thumb = el('img', 'note-thumb');
      thumb.alt = '';
      thumb.decoding = 'async';
      btn.append(thumb);
      imageUrl(firstImage).then((url) => { if (url) thumb.src = url; else thumb.remove(); });
    }

    const li = el('li', 'note-li');
    li.append(btn);
    return li;
  };

  const section = (label, extra) => {
    const li = el('li', 'list-section', label);
    li.setAttribute('aria-hidden', 'true'); // the tiles carry the information; headings are visual
    if (extra) li.append(el('span', 'list-section-count', extra));
    return li;
  };

  // Pinned notes first; then, when sorted by last edit, a diary-like Today / Yesterday / … grouping.
  const pinned = view === 'trash' ? [] : shown.filter(isPinned);
  const others = shown.filter((n) => !pinned.includes(n));
  if (pinned.length) {
    parts.push(section('Pinned', `· ${notes.filter(isPinned).length} of ${MAX_PINS}`), ...pinned.map(item));
  }
  if (sortBy === 'updated' && view !== 'trash') {
    let lastGroup = null;
    for (const note of others) {
      const group = dayGroup(note.updatedAt);
      if (group !== lastGroup) parts.push(section(group));
      lastGroup = group;
      parts.push(item(note));
    }
  } else if (others.length) {
    if (pinned.length) parts.push(section('Notes'));
    parts.push(...others.map(item));
  }
  listEl.replaceChildren(...parts);
}

// ---------- Pins ----------

const MAX_PINS = 5;
const PIN_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 6 3 3H7l3-3-1-6zM11 15h2v6h-2z"/></svg>';

// Play a one-off CSS animation class (tick pop, pin settle); CSS turns these off for reduced motion.
function bounce(node, cls) {
  node.classList.remove(cls);
  void node.offsetWidth; // restart if it was mid-animation
  node.classList.add(cls);
  node.addEventListener('animationend', () => node.classList.remove(cls), { once: true });
}

// Pinning is not an edit, so it doesn't change "last edited" or move the note in its section.
function togglePinFor(note) {
  if (!note || isDeleted(note)) return;
  if (isPinned(note)) {
    delete note.pinnedAt;
    showToast('Unpinned', { ms: 2500 });
  } else if (notes.filter(isPinned).length >= MAX_PINS) {
    showToast(`You can pin up to ${MAX_PINS} notes. Unpin one first.`);
    return;
  } else {
    note.pinnedAt = Date.now();
    showToast('Pinned to the top of your list', { ms: 2500 });
    if (note === activeNote()) bounce(pinBtn, 'settle');
  }
  scheduleSave();
  if (note === activeNote()) renderEditorChrome(note);
  renderList();
}

// ---------- Auto-save ----------

const SAVE_DELAY = 300;
let saveTimer = null;
let saveFailed = false;

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  saveFailed = !saveNotes(notes);
  const note = activeNote();
  if (note) renderMeta(note);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DELAY);
}

// Quiet status: only speaks up while saving, on a problem, or with checklist progress.
function renderMeta(note) {
  noteDateEl.textContent = isDeleted(note) ? `Moved to Trash ${shortDate(note.deletedAt).toLowerCase()}` : editedLabel(note.updatedAt);
  if (saveFailed) { metaEl.textContent = 'Not saved — browser storage is full or blocked'; return; }
  if (saveTimer) { metaEl.textContent = 'Saving…'; return; }
  const items = allItems(note).filter((it) => it.text.trim());
  metaEl.textContent = items.length ? `${items.filter((it) => it.done).length} of ${items.length} done` : '';
}

// A text change somewhere in the note: save, and refresh what depends on the text.
function touched(note) {
  note.updatedAt = Date.now();
  scheduleSave();
  renderMeta(note);
  renderNoteTags(note);
  renderList();
}

// "Tags in this note:" under the text; each chip filters the list by that tag.
function renderNoteTags(note) {
  const tags = tagsOf(note);
  noteTagsEl.hidden = !tags.length;
  noteTagsEl.replaceChildren(el('span', 'note-tags-label', 'Tags in this note:'), ...tags.map((tag) => {
    const chip = el('button', 'note-tag', `#${tag}`);
    chip.type = 'button';
    chip.dataset.tag = tag;
    chip.title = `Show all notes tagged #${tag}`;
    return chip;
  }));
}

// ---------- The editor ----------

// Everything around the writing: pin, trash state, tray contents.
function renderEditorChrome(note) {
  const trashed = isDeleted(note);
  editorEl.toggleAttribute('data-trash', trashed);
  pinBtn.setAttribute('aria-pressed', String(isPinned(note)));
  pinBtn.querySelector('.pin-label').textContent = isPinned(note) ? 'Pinned' : 'Pin';
  pinBtn.title = isPinned(note) ? 'Unpin this note' : `Pin to the top (up to ${MAX_PINS})`;
  deleteBtn.setAttribute('aria-label', trashed ? 'Delete forever' : 'Move to Trash');
  deleteBtn.title = trashed ? 'Delete forever' : 'Move to Trash';

  pageEl.dataset.paper = note.paper ?? 'plain';
  for (const opt of paperEl.querySelectorAll('.paper-opt')) {
    opt.setAttribute('aria-checked', String(opt.dataset.paper === (note.paper ?? 'plain')));
  }
  swatchesEl.replaceChildren(...PALETTE.map((p) => {
    const sw = el('button', 'swatch');
    sw.type = 'button';
    sw.dataset.color = p.id;
    sw.setAttribute('aria-label', p.name);
    sw.setAttribute('aria-pressed', String(p.id === note.color));
    sw.style.setProperty('--c', colorVar(p.id));
    return sw;
  }));
  renderNotebookSelect(note);
}

function renderEditor() {
  const note = activeNote();
  editorEl.toggleAttribute('data-empty', !note);
  hideTagSuggest();
  if (!note) return;
  titleEl.value = note.title;
  titleEl.readOnly = isDeleted(note);
  renderBlocks(note);
  renderImages(note);
  renderMeta(note);
  renderNoteTags(note);
  hideTagHint();
  renderEditorChrome(note);
}

// ---------- Blocks: text and checklists ----------

const CLOSE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const GRIP_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
const PLUS_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

const isTextField = (node) => node?.classList?.contains('block-text');
const isWritingField = (node) => node === titleEl || isTextField(node) || node?.classList?.contains('check-text');

// Text boxes grow with their text; the page scrolls instead.
function autosize(ta) {
  if (!ta.offsetParent) return; // not on screen yet (phone list view); sized when shown
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}
const autosizeAll = () => blocksEl.querySelectorAll('.block-text').forEach(autosize);

function renderBlocks(note) {
  const readOnly = isDeleted(note);
  const onlyBlock = note.blocks.length === 1;
  blocksEl.replaceChildren(...note.blocks.map((block, bi) => {
    if (block.type === 'text') {
      const ta = el('textarea', 'body block-text');
      ta.dataset.blockId = block.id;
      ta.value = block.text;
      ta.rows = 1;
      ta.spellcheck = true;
      ta.setAttribute('autocapitalize', 'sentences');
      ta.setAttribute('aria-label', onlyBlock ? 'Note' : 'Text');
      if (onlyBlock || bi === 0) ta.placeholder = onlyBlock ? 'Start writing…' : '';
      ta.readOnly = readOnly;
      if (bi === note.blocks.length - 1) ta.classList.add('grow');
      return ta;
    }
    const ul = el('ul', 'checklist');
    ul.dataset.blockId = block.id;
    ul.setAttribute('aria-label', 'Checklist');
    block.items.forEach((item, i) => {
      const li = el('li', 'check-item');
      li.dataset.index = i;
      li.classList.toggle('done', item.done);
      const grip = el('button', 'check-drag');
      grip.type = 'button';
      grip.tabIndex = -1;
      grip.setAttribute('aria-label', 'Drag to reorder (or Alt+↑/↓)');
      grip.innerHTML = GRIP_ICON;
      const box = el('input', 'check-box');
      box.type = 'checkbox';
      box.checked = item.done;
      box.disabled = readOnly;
      box.setAttribute('aria-label', item.text.trim() ? `Done: ${item.text.trim()}` : 'Done');
      const text = el('input', 'check-text');
      text.type = 'text';
      text.value = item.text;
      text.placeholder = 'List item';
      text.readOnly = readOnly;
      text.setAttribute('aria-label', `Item ${i + 1}`);
      text.enterKeyHint = 'next';
      const remove = el('button', 'check-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove item');
      remove.innerHTML = CLOSE_ICON;
      li.append(grip, box, text, remove);
      ul.append(li);
    });
    if (!readOnly) {
      const add = el('li', 'check-item check-add');
      add.innerHTML = PLUS_ICON;
      const addInput = el('input', 'check-text check-new');
      addInput.type = 'text';
      addInput.placeholder = 'List item';
      addInput.setAttribute('aria-label', 'Add an item');
      add.append(addInput);
      ul.append(add);
    }
    return ul;
  }));
  autosizeAll();
}

const blockIndexOf = (note, node) => note.blocks.findIndex((b) => b.id === node.closest('[data-block-id]')?.dataset.blockId);

// Put the cursor somewhere: { blockId, item?, caret } (blockId 'title' for the title).
function focusField(target) {
  if (!target) return;
  let field;
  if (target.blockId === 'title') field = titleEl;
  else {
    const host = blocksEl.querySelector(`[data-block-id="${target.blockId}"]`);
    if (!host) return;
    if (host.tagName === 'TEXTAREA') field = host;
    else {
      const inputs = host.querySelectorAll('.check-text');
      field = target.item === 'add' ? host.querySelector('.check-new') : inputs[Math.max(0, Math.min(target.item ?? 0, inputs.length - 1))];
    }
  }
  if (!field) return;
  field.focus();
  const pos = Math.min(target.caret ?? field.value.length, field.value.length);
  field.setSelectionRange(pos, pos);
}

// Replace the note's blocks after a structural change, re-draw, and put the cursor back.
function setBlocks(note, result) {
  note.blocks = result.blocks;
  renderBlocks(note);
  focusField(result.focus);
  touched(note);
}

// The last place you were writing (kept when tools steal focus).
let lastCaret = null;
document.addEventListener('selectionchange', () => {
  const field = document.activeElement;
  if (!isWritingField(field)) return;
  if (field === titleEl) lastCaret = { blockId: 'title', start: field.selectionStart, end: field.selectionEnd };
  else {
    const host = field.closest('[data-block-id]');
    if (host) lastCaret = { blockId: host.dataset.blockId, start: field.selectionStart, end: field.selectionEnd, item: Number(field.closest('.check-item')?.dataset.index) };
  }
  rememberPosition();
});

// The text block the tools act on: where you were writing, or else the first one.
function targetTextBlock(note) {
  const fromCaret = lastCaret && note.blocks.find((b) => b.id === lastCaret.blockId && b.type === 'text');
  if (fromCaret) return { block: fromCaret, start: lastCaret.start, end: lastCaret.end };
  return null;
}

// The Checklist tool: the line you're on (or the selected lines) becomes a checklist.
function addChecklist() {
  const note = activeNote();
  if (!note || isDeleted(note)) return;
  const target = targetTextBlock(note);
  const result = target
    ? insertChecklist(note.blocks, note.blocks.indexOf(target.block), target.start, target.end)
    : appendChecklist(note.blocks);
  setBlocks(note, result);
}

// Text block typing
blocksEl.addEventListener('input', (e) => {
  const note = activeNote();
  if (!note) return;
  const field = e.target;
  const bi = blockIndexOf(note, field);
  const block = note.blocks[bi];
  if (!block) return;
  if (isTextField(field)) {
    block.text = field.value;
    autosize(field);
    hideTagHint();
  } else if (field.classList.contains('check-new')) {
    // Typing in the add row turns it into a real item and keeps you typing in it.
    const caret = field.selectionStart;
    block.items.push(newItem(field.value));
    renderBlocks(note);
    focusField({ blockId: block.id, item: block.items.length - 1, caret });
  } else if (field.classList.contains('check-text')) {
    block.items[Number(field.closest('.check-item').dataset.index)].text = field.value;
  }
  touched(note);
  updateTagSuggest(document.activeElement);
});

let shiftHeld = false; // Shift+Enter always inserts a plain line break

blocksEl.addEventListener('keydown', (e) => {
  const note = activeNote();
  if (!note || isDeleted(note) || e.isComposing) return;
  const field = e.target;
  if (!tagSuggestEl.hidden && (e.key === 'Tab' || e.key === 'Escape')) {
    e.preventDefault();
    if (e.key === 'Tab') acceptTagSuggestion(field, tagSuggestEl.querySelector('.tag-suggestion')?.dataset.tag);
    else hideTagSuggest();
    return;
  }
  const bi = blockIndexOf(note, field);
  const block = note.blocks[bi];
  if (!block) return;

  if (isTextField(field)) {
    shiftHeld = e.shiftKey;
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Tab / Shift+Tab indent list lines; elsewhere Tab still moves focus as usual.
      const result = listIndent(field.value, field.selectionStart, field.selectionEnd, e.shiftKey);
      if (result) { e.preventDefault(); applyEdit(field, result); }
    } else if (e.key === 'Backspace' && field.selectionStart === 0 && field.selectionEnd === 0 && !field.value) {
      // Backspace in an empty text block between other blocks removes it.
      const result = removeTextBlock(note.blocks, bi);
      if (result) { e.preventDefault(); setBlocks(note, result); }
    }
    return;
  }

  if (!field.classList.contains('check-text')) return;
  const isAdd = field.classList.contains('check-new');
  const i = isAdd ? block.items.length : Number(field.closest('.check-item').dataset.index);
  const atStart = field.selectionStart === 0 && field.selectionEnd === 0;

  if (e.key === 'Enter') {
    e.preventDefault();
    if (isAdd) return;
    if (!field.value.trim() && i === block.items.length - 1) {
      // Enter on an empty last item: leave the list and carry on writing below it.
      setBlocks(note, exitChecklist(note.blocks, bi));
      return;
    }
    // A new item below, taking any text after the cursor with it.
    const before = field.value.slice(0, field.selectionStart);
    const after = field.value.slice(field.selectionEnd);
    block.items[i].text = before;
    block.items.splice(i + 1, 0, newItem(after));
    renderBlocks(note);
    focusField({ blockId: block.id, item: i + 1, caret: 0 });
    touched(note);
  } else if (e.key === 'Backspace' && atStart && !isAdd && !field.value) {
    e.preventDefault();
    if (block.items.length === 1) { setBlocks(note, removeChecklist(note.blocks, bi)); return; }
    block.items.splice(i, 1);
    renderBlocks(note);
    focusField(i > 0 ? { blockId: block.id, item: i - 1 } : { blockId: block.id, item: 0, caret: 0 });
    touched(note);
  } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !isAdd) {
    // Alt+↑/↓ moves the item.
    e.preventDefault();
    const j = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (j < 0 || j >= block.items.length) return;
    const [moved] = block.items.splice(i, 1);
    block.items.splice(j, 0, moved);
    renderBlocks(note);
    focusField({ blockId: block.id, item: j, caret: field.selectionStart });
    touched(note);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (i > 0) focusField({ blockId: block.id, item: i - 1 });
    else focusAround(note, bi, -1);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!isAdd) focusField({ blockId: block.id, item: i + 1 === block.items.length ? 'add' : i + 1 });
    else focusAround(note, bi, 1);
  }
});

// Up from the top of a list goes to what's above it; down from the bottom to what's below.
function focusAround(note, bi, dir) {
  const other = note.blocks[bi + dir];
  if (!other) { if (dir < 0) focusField({ blockId: 'title' }); return; }
  if (other.type === 'text') focusField({ blockId: other.id, caret: dir < 0 ? other.text.length : 0 });
  else focusField({ blockId: other.id, item: dir < 0 ? other.items.length - 1 : 0 });
}

// Smart lists inside text blocks: Enter continues "1." / "-" lines (beforeinput also catches phone keyboards).
blocksEl.addEventListener('beforeinput', (e) => {
  const field = e.target;
  if (!isTextField(field)) return;
  if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return;
  if (shiftHeld || field.selectionStart !== field.selectionEnd) return;
  const result = listEnter(field.value, field.selectionStart);
  if (!result) return;
  e.preventDefault();
  applyEdit(field, result);
});

blocksEl.addEventListener('change', (e) => {
  if (!e.target.classList.contains('check-box')) return;
  const note = activeNote();
  const block = note.blocks[blockIndexOf(note, e.target)];
  const item = block.items[Number(e.target.closest('.check-item').dataset.index)];
  item.done = e.target.checked;
  e.target.closest('.check-item').classList.toggle('done', item.done);
  if (item.done) bounce(e.target, 'pop');
  touched(note);
});

blocksEl.addEventListener('click', (e) => {
  const remove = e.target.closest('.check-remove');
  if (!remove) return;
  const note = activeNote();
  if (isDeleted(note)) return;
  const bi = blockIndexOf(note, remove);
  const block = note.blocks[bi];
  const i = Number(remove.closest('.check-item').dataset.index);
  if (block.items.length === 1) { setBlocks(note, removeChecklist(note.blocks, bi)); return; }
  block.items.splice(i, 1);
  renderBlocks(note);
  focusField({ blockId: block.id, item: Math.min(i, block.items.length - 1) });
  touched(note);
});

// Clicking the empty page below the last block puts the cursor at the end (adding a text block after a list).
pageEl.addEventListener('click', (e) => {
  const note = activeNote();
  if (!note || isDeleted(note) || e.target !== pageEl) return;
  const last = note.blocks[note.blocks.length - 1];
  if (last.type === 'text') { focusField({ blockId: last.id }); return; }
  const t = textBlock();
  note.blocks.push(t);
  renderBlocks(note);
  focusField({ blockId: t.id, caret: 0 });
});

// Drag a checklist item by its grip to reorder it.
let drag = null;
blocksEl.addEventListener('pointerdown', (e) => {
  const grip = e.target.closest('.check-drag');
  const note = activeNote();
  if (!grip || !note || isDeleted(note)) return;
  e.preventDefault();
  const row = grip.closest('.check-item');
  drag = { row, list: row.parentElement, pointerId: e.pointerId };
  grip.setPointerCapture(e.pointerId);
  row.classList.add('dragging');
});
blocksEl.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const rows = [...drag.list.querySelectorAll('.check-item:not(.check-add)')];
  const after = rows.find((r) => r !== drag.row && e.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2);
  drag.list.insertBefore(drag.row, after ?? drag.list.querySelector('.check-add'));
});
function endDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const note = activeNote();
  const block = note.blocks[blockIndexOf(note, drag.list)];
  const order = [...drag.list.querySelectorAll('.check-item:not(.check-add)')].map((r) => Number(r.dataset.index));
  drag.row.classList.remove('dragging');
  drag = null;
  if (order.some((v, k) => v !== k)) {
    block.items = order.map((k) => block.items[k]);
    renderBlocks(note);
    touched(note);
  }
}
blocksEl.addEventListener('pointerup', endDrag);
blocksEl.addEventListener('pointercancel', endDrag);

// Replace only the part of the text that changed, through the browser's own editing
// command so Ctrl+Z still undoes it. Falls back to setting the value directly.
function applyEdit(field, result) {
  const old = field.value;
  const next = result.text;
  let p = 0;
  while (p < old.length && p < next.length && old[p] === next[p]) p++;
  let s = 0;
  while (s < old.length - p && s < next.length - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s++;
  field.setSelectionRange(p, old.length - s);
  const inserted = next.slice(p, next.length - s);
  let ok = false;
  try { ok = document.execCommand('insertText', false, inserted); } catch { /* unsupported */ }
  if (!ok || field.value !== next) {
    field.value = next;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  field.setSelectionRange(result.selStart, result.selEnd);
}

// The Numbered / Bulleted tools work on the current line(s) of the text you were writing in.
function applyListKind(kind) {
  const note = activeNote();
  if (!note || isDeleted(note)) return;
  let target = targetTextBlock(note);
  if (!target) {
    const first = note.blocks.find((b) => b.type === 'text');
    if (!first) return;
    target = { block: first, start: first.text.length, end: first.text.length };
  }
  const field = blocksEl.querySelector(`[data-block-id="${target.block.id}"]`);
  field.focus();
  field.setSelectionRange(target.start, target.end);
  applyEdit(field, toggleList(field.value, target.start, target.end, kind));
}

// ---------- Opening, creating, leaving notes ----------

// A note left completely empty is dropped when you move away from it.
function discardIfBlank(id) {
  const i = notes.findIndex((n) => n.id === id);
  if (i !== -1 && isBlank(notes[i])) {
    notes.splice(i, 1);
    scheduleSave();
  }
}

// On phones the editor is its own screen, so give it a history entry:
// the system back button / gesture returns to the list instead of closing the app.
function enterEditorView() {
  if (document.body.dataset.view === 'editor') return;
  document.body.dataset.view = 'editor';
  if (phoneLayout.matches) history.pushState({ editor: true }, '');
}

// Leave the editor screen, unwinding our history entry if we pushed one.
function leaveEditorView() {
  if (history.state?.editor) history.back(); // popstate then calls showList()
  else showList();
}

function openNote(id, { jumpTo = null } = {}) {
  if (id !== activeId) {
    rememberPosition();
    discardIfBlank(activeId);
  }
  activeId = id;
  lastCaret = null;
  enterEditorView();
  renderList();
  renderEditor();
  if (jumpTo) jumpToMatch(jumpTo); else restorePosition();
}

// One tap: a new text note, in the notebook you're looking at. `checklist` starts it with a list.
function newNote({ checklist = false, title = '', text = '' } = {}) {
  const t = Date.now();
  const note = {
    id: uid(),
    title,
    blocks: checklist ? [checklistBlock(), textBlock()] : [textBlock(text)],
    color: 'paper',
    createdAt: t,
    updatedAt: t,
  };
  if (view !== 'all' && view !== 'trash') note.notebookId = view;
  if (view === 'trash') setView('all');
  notes.push(note);
  searchEl.value = ''; // so the new note shows up in the list
  activeTag = null;
  rememberPosition();
  discardIfBlank(activeId);
  activeId = note.id;
  lastCaret = null;
  enterEditorView();
  renderList();
  renderEditor();
  if (title || text) touched(note);
  focusField(checklist ? { blockId: note.blocks[0].id, item: 0, caret: 0 } : { blockId: note.blocks[0].id });
}

function showList() {
  rememberPosition();
  discardIfBlank(activeId);
  if (!activeNote()) activeId = null;
  document.body.dataset.view = 'list';
  renderList();
  renderEditor();
}

// ---------- Pick up where you left off ----------

const POS_KEY = 'notes.positions';
let positions = {};
try { positions = JSON.parse(getSetting(POS_KEY) ?? '{}') ?? {}; } catch { positions = {}; }
let posTimer = null;

function rememberPosition() {
  const note = activeNote();
  if (!note || document.body.dataset.view !== 'editor' && phoneLayout.matches) return;
  positions[note.id] = { scroll: pageEl.scrollTop, caret: lastCaret };
  clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    // Only keep positions for notes that still exist.
    for (const id of Object.keys(positions)) if (!notes.some((n) => n.id === id)) delete positions[id];
    setSetting(POS_KEY, JSON.stringify(positions));
  }, 500);
}
pageEl.addEventListener('scroll', rememberPosition, { passive: true });

function restorePosition() {
  const note = activeNote();
  const pos = note && positions[note.id];
  autosizeAll();
  pageEl.scrollTop = pos?.scroll ?? 0;
  // On a phone, don't pop the keyboard up just from opening a note; on a computer, put the cursor back.
  if (pos?.caret && !phoneLayout.matches && !isDeleted(note)) {
    const c = pos.caret;
    const block = note.blocks.find((b) => b.id === c.blockId);
    if (c.blockId === 'title' || block) {
      focusField({ blockId: c.blockId, item: Number.isFinite(c.item) ? c.item : undefined, caret: c.end });
      pageEl.scrollTop = pos.scroll ?? 0;
    }
  }
}

// Opened from a search: scroll to (and on a computer, select) the first match.
function jumpToMatch(word) {
  const note = activeNote();
  autosizeAll();
  if (!note || note.title.toLowerCase().includes(word)) { pageEl.scrollTop = 0; return; }
  for (const block of note.blocks) {
    if (block.type === 'text') {
      const i = block.text.toLowerCase().indexOf(word);
      if (i === -1) continue;
      const ta = blocksEl.querySelector(`[data-block-id="${block.id}"]`);
      const line = block.text.slice(0, i).split('\n').length - 1;
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 32;
      pageEl.scrollTop = Math.max(0, ta.offsetTop + line * lh - 120);
      if (!phoneLayout.matches) { ta.focus({ preventScroll: true }); ta.setSelectionRange(i, i + word.length); }
      return;
    }
    const k = block.items.findIndex((it) => it.text.toLowerCase().includes(word));
    if (k === -1) continue;
    const input = blocksEl.querySelector(`[data-block-id="${block.id}"]`).querySelectorAll('.check-text')[k];
    input.scrollIntoView({ block: 'center' });
    if (!phoneLayout.matches) { const j = input.value.toLowerCase().indexOf(word); input.focus({ preventScroll: true }); input.setSelectionRange(j, j + word.length); }
    return;
  }
}

// ---------- Images under the text ----------

const noteImagesEl = $('#note-images');
const imageRowEl = $('#note-images-row');
const imageFileEl = $('#image-file');
const imageUrls = new Map(); // image id -> object URL (or null if the image is missing)

async function imageUrl(id) {
  if (!imageUrls.has(id)) {
    const rec = await getImage(id).catch(() => null);
    imageUrls.set(id, rec ? URL.createObjectURL(rec.blob) : null);
  }
  return imageUrls.get(id);
}

function renderImages(note) {
  const ids = imagesOf(note);
  noteImagesEl.hidden = !ids.length;
  $('#note-images-count').textContent = `${ids.length} ${ids.length === 1 ? 'image' : 'images'}`;

  const tiles = ids.map((id, i) => {
    const tile = el('div', 'image-tile');
    tile.dataset.index = i;
    const open = el('button', 'image-open');
    open.type = 'button';
    open.setAttribute('aria-label', `Open image ${i + 1} full size`);
    const img = el('img');
    img.alt = '';
    img.decoding = 'async';
    open.append(img);
    imageUrl(id).then((url) => {
      if (url) img.src = url;
      else { tile.classList.add('missing'); open.textContent = 'Image unavailable'; }
    });
    tile.append(open);
    if (!isDeleted(note)) {
      const remove = el('button', 'image-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove image ${i + 1}`);
      remove.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
      tile.append(remove);
    }
    return tile;
  });

  if (!isDeleted(note)) {
    const add = el('button', 'image-add');
    add.type = 'button';
    add.setAttribute('aria-label', 'Add image');
    add.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    tiles.push(add);
  }
  imageRowEl.replaceChildren(...tiles);
}

// Shrink, store and attach picked / pasted / dropped pictures to the open note.
async function addImages(files) {
  const note = activeNote();
  const pictures = [...files].filter((f) => f.type.startsWith('image/'));
  if (!note || isDeleted(note) || !pictures.length) return;
  showToast(pictures.length === 1 ? 'Adding image…' : `Adding ${pictures.length} images…`, { ms: 30000 });
  navigator.storage?.persist?.().catch(() => {}); // ask the browser not to clear stored pictures
  let failed = 0;
  for (const file of pictures) {
    try {
      const id = await addImage(await prepareImage(file));
      note.images = [...imagesOf(note), id];
    } catch {
      failed += 1;
    }
  }
  hideToast();
  if (failed) showToast(failed === pictures.length ? 'Couldn’t add that image.' : `${failed} images couldn’t be added.`);
  note.updatedAt = Date.now();
  scheduleSave();
  if (note === activeNote()) { renderImages(note); renderMeta(note); }
  renderList();
}

function removeImage(index) {
  const note = activeNote();
  const ids = [...imagesOf(note)];
  const [id] = ids.splice(index, 1);
  note.images = ids;
  note.updatedAt = Date.now();
  scheduleSave();
  renderImages(note);
  renderList();
  // The picture stays stored until the next start-up clean-up, so Undo can bring it back.
  showToast('Image removed', {
    onUndo: () => {
      const list = [...imagesOf(note)];
      list.splice(index, 0, id);
      note.images = list;
      scheduleSave();
      if (note === activeNote()) renderImages(note);
      renderList();
    },
  });
}

$('#add-image').addEventListener('click', () => { closeTray(); imageFileEl.click(); });
imageFileEl.addEventListener('change', () => {
  const files = [...imageFileEl.files];
  imageFileEl.value = ''; // so picking the same picture again still fires
  addImages(files);
});

imageRowEl.addEventListener('click', (e) => {
  if (e.target.closest('.image-add')) imageFileEl.click();
  else if (e.target.closest('.image-remove')) removeImage(Number(e.target.closest('.image-tile').dataset.index));
  else if (e.target.closest('.image-open') && !e.target.closest('.missing')) openViewer(Number(e.target.closest('.image-tile').dataset.index));
});

// Paste a picture into a note, or drop one onto it (desktop).
editorEl.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  addImages(files);
});
editorEl.addEventListener('dragover', (e) => {
  if ([...(e.dataTransfer?.types ?? [])].includes('Files') && activeNote()) e.preventDefault();
});
editorEl.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  addImages(files);
});

// ---------- Full-size image viewer ----------

const viewerEl = $('#viewer');
const viewerImg = $('#viewer-img');
let viewerIndex = 0;
let viewerReturnFocus = null;

async function showViewerImage() {
  const ids = imagesOf(activeNote());
  $('#viewer-count').textContent = `${viewerIndex + 1} of ${ids.length}`;
  $('#viewer-prev').hidden = viewerIndex === 0;
  $('#viewer-next').hidden = viewerIndex >= ids.length - 1;
  $('#viewer-remove').hidden = isDeleted(activeNote());
  viewerImg.alt = `Image ${viewerIndex + 1} of ${ids.length}`;
  viewerImg.src = (await imageUrl(ids[viewerIndex])) ?? '';
}

function openViewer(index) {
  viewerIndex = index;
  viewerReturnFocus = document.activeElement;
  viewerEl.hidden = false;
  showViewerImage();
  $('#viewer-close').focus();
  // Phones: the back gesture closes the picture rather than leaving the note.
  if (phoneLayout.matches) history.pushState({ editor: true, viewer: true }, '');
}

function closeViewer({ fromHistory = false } = {}) {
  if (viewerEl.hidden) return;
  if (!fromHistory && history.state?.viewer) { history.back(); return; } // popstate comes back here
  viewerEl.hidden = true;
  viewerImg.removeAttribute('src');
  viewerReturnFocus?.focus?.();
}

function stepViewer(delta) {
  const count = imagesOf(activeNote()).length;
  const next = viewerIndex + delta;
  if (next < 0 || next >= count) return;
  viewerIndex = next;
  showViewerImage();
}

$('#viewer-close').addEventListener('click', () => closeViewer());
$('#viewer-prev').addEventListener('click', () => stepViewer(-1));
$('#viewer-next').addEventListener('click', () => stepViewer(1));
$('#viewer-remove').addEventListener('click', () => {
  const index = viewerIndex;
  closeViewer();
  removeImage(index);
});
viewerEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.stopPropagation(); closeViewer(); }
  else if (e.key === 'ArrowLeft') stepViewer(-1);
  else if (e.key === 'ArrowRight') stepViewer(1);
});
// Swipe left/right between pictures on touch screens.
let viewerSwipeX = null;
viewerEl.addEventListener('pointerdown', (e) => { viewerSwipeX = e.clientX; });
viewerEl.addEventListener('pointerup', (e) => {
  if (viewerSwipeX === null) return;
  const dx = e.clientX - viewerSwipeX;
  viewerSwipeX = null;
  if (Math.abs(dx) > 50) stepViewer(dx < 0 ? 1 : -1);
});

// ---------- Toasts (with Undo) ----------

const UNDO_MS = 6000;
const toastEl = $('#toast');
const toastMsgEl = $('#toast-msg');
const undoEl = $('#undo');
let undoAction = null; // what Undo does for the toast on screen, if anything
let toastTimer = null;

function hideToast() {
  clearTimeout(toastTimer);
  toastEl.hidden = true;
  undoAction = null;
}

// One toast at a time; Undo shows only when `onUndo` is given.
function showToast(message, { onUndo = null, ms = UNDO_MS } = {}) {
  clearTimeout(toastTimer);
  undoAction = onUndo;
  toastMsgEl.textContent = message;
  undoEl.hidden = !onUndo;
  toastEl.hidden = false;
  toastTimer = setTimeout(hideToast, ms);
}

function runUndo() {
  const action = undoAction;
  hideToast();
  action?.();
}

// ---------- Trash ----------

// Delete: into Trash for 30 days (blank notes just go). In Trash: delete forever, after asking.
function moveToTrash(note) {
  if (!note) return;
  const wasActive = note === activeNote();
  if (isBlank(note)) {
    notes.splice(notes.indexOf(note), 1);
  } else {
    note.deletedAt = Date.now();
  }
  flushSave();
  if (wasActive) {
    const next = visibleNotes()[0];
    activeId = next ? next.id : null;
    leaveEditorView();
    renderEditor();
  }
  renderList();
  if (!isBlank(note)) showToast('Moved to Trash', { onUndo: () => restoreFromTrash(note, { open: wasActive }) });
}

function restoreFromTrash(note, { open = true } = {}) {
  delete note.deletedAt;
  // If the pin slots filled up meanwhile, bring the note back unpinned.
  if (Number.isFinite(note.pinnedAt) && notes.filter(isPinned).length > MAX_PINS) delete note.pinnedAt;
  if (note.notebookId && !notebookName(note.notebookId)) delete note.notebookId;
  flushSave();
  if (open) {
    if (view === 'trash') setView('all');
    openNote(note.id);
  } else renderList();
}

async function deleteForever(note) {
  const ok = await ask({ title: 'Delete forever?', message: `“${displayTitle(note)}” will be gone for good.`, okLabel: 'Delete forever', danger: true });
  if (!ok) return;
  notes.splice(notes.indexOf(note), 1);
  flushSave();
  if (note.id === activeId) {
    const next = visibleNotes()[0];
    activeId = next ? next.id : null;
    leaveEditorView();
    renderEditor();
  }
  renderList();
  showToast('Deleted forever', { ms: 2500 });
}

async function emptyTrash() {
  const trashed = notes.filter(isDeleted);
  if (!trashed.length) return;
  const ok = await ask({ title: 'Empty Trash?', message: `${trashed.length} ${trashed.length === 1 ? 'note' : 'notes'} will be gone for good.`, okLabel: 'Empty Trash', danger: true });
  if (!ok) return;
  for (const n of trashed) notes.splice(notes.indexOf(n), 1);
  flushSave();
  if (!activeNote()) { activeId = null; renderEditor(); }
  renderList();
}

deleteBtn.addEventListener('click', () => {
  const note = activeNote();
  if (!note) return;
  if (isDeleted(note)) deleteForever(note);
  else moveToTrash(note);
});
$('#restore').addEventListener('click', () => { const n = activeNote(); if (n) restoreFromTrash(n); });
listEl.addEventListener('click', (e) => { if (e.target.closest('#empty-trash')) emptyTrash(); });

// ---------- Notebooks ----------

const nbBtn = $('#notebook-btn');
const nbMenu = $('#nb-menu');

function setView(next) {
  view = next;
  activeTag = null;
  setSetting('notes.view', view);
  // Keep the open note if it belongs here; otherwise open nothing (desktop shows the empty page).
  if (activeNote() && !inView(activeNote())) {
    activeId = phoneLayout.matches ? null : visibleNotes()[0]?.id ?? null;
    renderEditor();
  }
  renderList();
}

function renderNotebookButton() {
  const name = view === 'all' ? 'All notes' : view === 'trash' ? 'Trash' : notebookName(view);
  $('#notebook-name').textContent = name;
  nbBtn.dataset.view = view === 'trash' ? 'trash' : view === 'all' ? 'all' : 'notebook';
}

function saveBooks() { saveNotebooks(notebooks); }

function openNotebookMenu() {
  const live = notes.filter((n) => !isDeleted(n));
  const count = (pred) => live.filter(pred).length;
  const item = (label, sub, action, { current = false, kind = '' } = {}) => {
    const b = el('button', `nb-item ${kind}`);
    b.type = 'button';
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(current));
    b.dataset.action = action;
    b.append(el('span', 'nb-item-name', label));
    if (sub !== null) b.append(el('span', 'nb-item-count', String(sub)));
    return b;
  };
  const parts = [item('All notes', count(() => true), 'view:all', { current: view === 'all' })];
  for (const nb of [...notebooks].sort((a, b) => a.name.localeCompare(b.name))) {
    parts.push(item(nb.name, count((n) => n.notebookId === nb.id), `view:${nb.id}`, { current: view === nb.id, kind: 'nb-book' }));
  }
  parts.push(el('hr', 'nb-sep'));
  parts.push(item('New notebook…', null, 'new', { kind: 'nb-action' }));
  if (view !== 'all' && view !== 'trash') {
    parts.push(item('Rename this notebook…', null, 'rename', { kind: 'nb-action' }));
    parts.push(item('Delete this notebook…', null, 'delete', { kind: 'nb-action' }));
  }
  parts.push(el('hr', 'nb-sep'));
  parts.push(item('Trash', notes.filter(isDeleted).length, 'view:trash', { current: view === 'trash', kind: 'nb-trash' }));
  nbMenu.replaceChildren(...parts);

  nbMenu.hidden = false;
  nbBtn.setAttribute('aria-expanded', 'true');
  const r = nbBtn.getBoundingClientRect();
  nbMenu.style.top = `${r.bottom + 6}px`;
  nbMenu.style.left = `${r.left}px`;
  nbMenu.style.width = `${Math.max(240, r.width)}px`;
  nbMenu.querySelector('[aria-checked="true"]')?.focus();
}

function closeNotebookMenu() {
  if (nbMenu.hidden) return;
  nbMenu.hidden = true;
  nbBtn.setAttribute('aria-expanded', 'false');
}

async function createNotebook({ assign = null } = {}) {
  const name = await ask({ title: 'New notebook', message: 'Group notes you want to keep together.', input: '', placeholder: 'Notebook name', okLabel: 'Create' });
  if (!name?.trim()) return null;
  const nb = { id: uid(), name: name.trim(), createdAt: Date.now() };
  notebooks.push(nb);
  saveBooks();
  if (assign) {
    assign.notebookId = nb.id;
    scheduleSave();
    renderNotebookSelect(assign);
    renderList();
    showToast(`Moved to ${nb.name}`, { ms: 2500 });
  } else {
    setView(nb.id);
  }
  return nb;
}

async function renameNotebook(id) {
  const nb = notebooks.find((b) => b.id === id);
  if (!nb) return;
  const name = await ask({ title: 'Rename notebook', input: nb.name, placeholder: 'Notebook name', okLabel: 'Rename' });
  if (!name?.trim()) return;
  nb.name = name.trim();
  saveBooks();
  renderList();
  if (activeNote()) renderNotebookSelect(activeNote());
}

async function deleteNotebook(id) {
  const nb = notebooks.find((b) => b.id === id);
  if (!nb) return;
  const inside = notes.filter((n) => n.notebookId === id);
  const ok = await ask({
    title: `Delete “${nb.name}”?`,
    message: inside.length ? `Its ${inside.length} ${inside.length === 1 ? 'note stays' : 'notes stay'} in All notes.` : 'It has no notes.',
    okLabel: 'Delete notebook',
    danger: true,
  });
  if (!ok) return;
  notebooks = notebooks.filter((b) => b.id !== id);
  for (const n of inside) delete n.notebookId;
  saveBooks();
  scheduleSave();
  setView('all');
  showToast(`Deleted “${nb.name}”`, {
    onUndo: () => {
      notebooks.push(nb);
      for (const n of inside) n.notebookId = nb.id;
      saveBooks();
      scheduleSave();
      setView(nb.id);
    },
  });
}

nbBtn.addEventListener('click', () => (nbMenu.hidden ? openNotebookMenu() : closeNotebookMenu()));
nbMenu.addEventListener('click', (e) => {
  const b = e.target.closest('.nb-item');
  if (!b) return;
  closeNotebookMenu();
  const action = b.dataset.action;
  if (action.startsWith('view:')) {
    setView(action.slice(5));
    if (phoneLayout.matches && document.body.dataset.view === 'editor') leaveEditorView();
  } else if (action === 'new') createNotebook();
  else if (action === 'rename') renameNotebook(view);
  else if (action === 'delete') deleteNotebook(view);
});
nbMenu.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...nbMenu.querySelectorAll('.nb-item')];
  const i = items.indexOf(document.activeElement);
  items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
});
document.addEventListener('pointerdown', (e) => {
  if (nbMenu.hidden || nbMenu.contains(e.target) || nbBtn.contains(e.target)) return;
  closeNotebookMenu();
});

// The tray's "Notebook" picker for the open note.
function renderNotebookSelect(note) {
  const opts = [new Option('No notebook', '')];
  for (const nb of [...notebooks].sort((a, b) => a.name.localeCompare(b.name))) opts.push(new Option(nb.name, nb.id));
  opts.push(new Option('New notebook…', '__new'));
  noteNotebookEl.replaceChildren(...opts);
  noteNotebookEl.value = note.notebookId && notebookName(note.notebookId) ? note.notebookId : '';
}

noteNotebookEl.addEventListener('change', () => {
  const note = activeNote();
  if (!note) return;
  const value = noteNotebookEl.value;
  if (value === '__new') {
    closeTray();
    createNotebook({ assign: note }).then((nb) => { if (!nb) renderNotebookSelect(note); });
    return;
  }
  if (value) note.notebookId = value; else delete note.notebookId;
  scheduleSave(); // filing a note isn't an edit
  renderList();
  showToast(value ? `Moved to ${notebookName(value)}` : 'Removed from its notebook', { ms: 2500 });
});

// ---------- Small dialogs ----------

const askEl = $('#ask');
const askInput = $('#ask-input');

/** Asks a question. With `input`, resolves to the text (or null); otherwise to true/false. */
function ask({ title, message = '', input = null, placeholder = '', okLabel = 'OK', danger = false }) {
  $('#ask-title').textContent = title;
  $('#ask-message').textContent = message;
  $('#ask-message').hidden = !message;
  askInput.hidden = input === null;
  askInput.value = input ?? '';
  askInput.placeholder = placeholder;
  askInput.required = input !== null;
  const okBtn = $('#ask-ok');
  okBtn.textContent = okLabel;
  okBtn.classList.toggle('danger', danger);
  askEl.showModal();
  if (input !== null) { askInput.focus(); askInput.select(); }
  // Answer straight from the button press (the dialog's own "close" event can arrive late).
  const form = askEl.querySelector('form');
  return new Promise((resolve) => {
    const finish = (ok) => {
      form.removeEventListener('submit', onSubmit);
      askEl.removeEventListener('cancel', onCancel);
      if (askEl.open) askEl.close();
      resolve(input === null ? ok : ok ? askInput.value : null);
    };
    const onSubmit = (e) => { e.preventDefault(); finish(e.submitter?.value === 'ok'); };
    const onCancel = () => finish(false); // Escape
    form.addEventListener('submit', onSubmit);
    askEl.addEventListener('cancel', onCancel);
  });
}

const helpEl = $('#help');
const openHelp = () => { backupEl.open = false; if (!helpEl.open) helpEl.showModal(); };
$('#show-help').addEventListener('click', openHelp);

// ---------- Backup: export and import, and a gentle reminder ----------

const backupEl = $('#backup');
const importFileEl = $('#import-file');
const LAST_BACKUP_KEY = 'notes.lastBackup';
const SNOOZE_KEY = 'notes.backupSnooze';

function localDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function exportNotes() {
  backupEl.open = false;
  if (saveTimer) flushSave();
  const keep = notes.filter((n) => !isBlank(n));
  // The backup file carries the notes' images too, so it restores completely on another device.
  const images = {};
  for (const id of new Set(keep.flatMap(imagesOf))) {
    const rec = await getImage(id).catch(() => null);
    if (rec) images[id] = await blobToDataURL(rec.blob);
  }
  const blob = new Blob([backupJSON(keep, images, notebooks)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = `notes-${localDate(Date.now())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  setSetting(LAST_BACKUP_KEY, String(Date.now()));
  renderBackupNudge();
  showToast(`Backed up ${keep.length} ${keep.length === 1 ? 'note' : 'notes'} to your downloads`);
}

async function importNotes(file) {
  let text;
  try {
    text = await file.text();
  } catch {
    showToast('Couldn’t read that file.');
    return;
  }
  const { notes: incoming, images, notebooks: incomingBooks, error } = parseBackup(text);
  if (error) {
    showToast(error);
    return;
  }
  // Store the backup's images first (skipping ones already here), so notes never point at nothing.
  let imageFailed = false;
  for (const [id, url] of Object.entries(images)) {
    try {
      if (!(await getImage(id))) {
        await addImage({ blob: await dataURLToBlob(url) }, id);
        imageUrls.delete(id); // forget an earlier "Image unavailable"
      }
    } catch {
      imageFailed = true;
    }
  }
  for (const nb of incomingBooks) if (!notebooks.some((b) => b.id === nb.id)) notebooks.push(nb);
  saveBooks();
  if (imageFailed) showToast('Some images couldn’t be saved — browser storage may be full.');
  if (saveTimer) flushSave();
  const { added, updated } = mergeNotes(notes, incoming);
  flushSave();
  if (!activeNote()) activeId = visibleNotes()[0]?.id ?? null;
  renderList();
  renderEditor();

  const parts = [];
  if (added) parts.push(`${added} added`);
  if (updated) parts.push(`${updated} updated`);
  showToast(parts.length ? `Restored: ${parts.join(', ')}` : 'Nothing new — your notes are up to date');
}

// "Last backed up 3 weeks ago" — shown when it's been a while, until you back up or say Later.
function renderBackupNudge() {
  const nudge = $('#backup-nudge');
  const live = notes.filter((n) => !isDeleted(n) && !isBlank(n));
  const last = Number(getSetting(LAST_BACKUP_KEY)) || 0;
  const snoozed = Number(getSetting(SNOOZE_KEY)) || 0;
  const oldest = Math.min(...live.map((n) => n.createdAt));
  const due = live.length >= 3 && Date.now() > snoozed
    && (last ? Date.now() - last > 14 * DAY : Date.now() - oldest > 7 * DAY);
  nudge.hidden = !due || view === 'trash';
  if (!due) return;
  const weeks = Math.floor((Date.now() - last) / (7 * DAY));
  $('#backup-nudge-text').textContent = last
    ? `Last backed up ${weeks <= 1 ? 'over a week' : `${weeks} weeks`} ago.`
    : 'Your notes live only in this browser. Keep a copy?';
}
$('#nudge-backup').addEventListener('click', exportNotes);
$('#nudge-later').addEventListener('click', () => {
  setSetting(SNOOZE_KEY, String(Date.now() + 7 * DAY));
  renderBackupNudge();
});

$('#export').addEventListener('click', exportNotes);
$('#import').addEventListener('click', () => {
  backupEl.open = false;
  importFileEl.click();
});
importFileEl.addEventListener('change', () => {
  const [file] = importFileEl.files;
  importFileEl.value = ''; // so picking the same file again still fires
  if (file) importNotes(file);
});
// Close the menu when clicking anywhere else.
document.addEventListener('click', (e) => {
  if (backupEl.open && !backupEl.contains(e.target)) backupEl.open = false;
});

// ---------- Sync with another device (sync.js does the connecting) ----------

const syncEl = $('#sync');
const deviceKind = () => (phoneLayout.matches ? 'phone' : 'computer');
const otherKind = (kind) => (kind === 'phone' ? 'computer' : 'phone');
const capital = (word) => word.charAt(0).toUpperCase() + word.slice(1);
let syncSession = null; // the sync in progress: { role, host, channel, timer }
let syncRetry = null;

const SYNC_FAILURES = {
  offline: 'Can’t reach the internet, which is needed to find the other device. Nothing was changed.',
  expired: 'That code has expired or was already used. Make a new code on your computer and scan it again.',
  timeout: 'Your network may be blocking a direct link between the two devices. Nothing was changed.',
  refused: 'The other device ended the connection. Nothing was changed.',
  unsupported: 'This browser can’t make direct connections. Try Chrome, Edge or Safari.',
  failed: 'Something went wrong while connecting. Nothing was changed.',
};

const syncInfo = () => ({ device: deviceKind(), notes: notes.filter((n) => !isDeleted(n) && !isBlank(n)).length });
const setSyncStep = (step) => { syncEl.dataset.step = step; };
const setSyncStatus = (text) => { $('#sync-status-text').textContent = text; };
const countLabel = (n) => `${n} ${n === 1 ? 'note' : 'notes'}`;

function endSyncSession() {
  const session = syncSession;
  syncSession = null;
  if (!session) return;
  clearInterval(session.timer);
  session.host?.stop();
  session.channel?.close();
}

function openSyncDialog(step) {
  backupEl.open = false;
  setSyncStep(step);
  if (!syncEl.open) syncEl.showModal();
}

function closeSync() {
  endSyncSession();
  if (syncEl.open) syncEl.close();
}

function showSyncFailure(err) {
  endSyncSession();
  $('#sync-fail-text').textContent = SYNC_FAILURES[err?.reason] ?? SYNC_FAILURES.failed;
  // An old code can't be retried from here: the computer has to make a new one.
  const retryHelps = !['expired', 'unsupported'].includes(err?.reason);
  syncEl.querySelector('.sync-tips').hidden = !retryHelps;
  $('#sync-retry').hidden = !retryHelps;
  setSyncStep('failed');
}

async function drawSyncCode(link) {
  const { size, path } = await qrCode(link);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `-2 -2 ${size + 4} ${size + 4}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  svg.append(p);
  $('#sync-qr').replaceChildren(svg);
}

// A code only works for a few minutes, so an old screenshot of it can't be used later.
function startCodeTimer(session) {
  const ends = Date.now() + CODE_MS;
  const tick = () => {
    const left = Math.max(0, ends - Date.now());
    if (!left) {
      clearInterval(session.timer);
      session.host.stop();
      $('#sync-qr').replaceChildren();
      syncEl.classList.remove('waiting');
      setSyncStatus('This code has expired');
      $('#sync-timer').textContent = '';
      $('#sync-new-code').hidden = false;
      return;
    }
    const s = Math.ceil(left / 1000);
    $('#sync-timer').textContent = `Code works for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  session.timer = setInterval(tick, 1000);
}

// The computer: show a code and wait for a phone to scan it.
function startSyncHost() {
  endSyncSession();
  if (deviceKind() === 'phone') { openSyncDialog('howto'); return; }
  syncRetry = startSyncHost;
  const session = { role: 'host' };
  syncSession = session;
  $('#sync-qr').replaceChildren();
  $('#sync-timer').textContent = '';
  $('#sync-new-code').hidden = true;
  syncEl.classList.add('waiting');
  setSyncStatus('Making a code…');
  openSyncDialog('code');
  session.host = host({
    info: syncInfo,
    onReady(link) {
      if (syncSession !== session) return;
      drawSyncCode(link)
        .then(() => {
          if (syncSession !== session) return;
          setSyncStatus(`Waiting for your ${otherKind(deviceKind())}…`);
          startCodeTimer(session);
        })
        .catch(showSyncFailure);
    },
    onPaired(channel) {
      if (syncSession !== session) { channel.close(); return; }
      session.channel = channel;
      clearInterval(session.timer);
      $('#sync-timer').textContent = '';
      setSyncStatus(`${capital(channel.info.device ?? 'phone')} connected. Tap Sync now on it.`);
      listenToChannel(session);
    },
    onError(err) { if (syncSession === session) showSyncFailure(err); },
  });
}

// The phone, opened from the code's link: connect, then ask before syncing.
async function startSyncJoin(code) {
  endSyncSession();
  syncRetry = () => startSyncJoin(code);
  const session = { role: 'join' };
  syncSession = session;
  const own = deviceKind();
  syncEl.querySelectorAll('.sync-own-name').forEach((n) => { n.textContent = own; });
  syncEl.querySelectorAll('.sync-other-name').forEach((n) => { n.textContent = otherKind(own); });
  syncEl.querySelector('.sync-other-cap').textContent = capital(otherKind(own));
  $('#sync-own-count').textContent = syncInfo().notes;
  $('#sync-other-count').textContent = '…';
  $('#sync-connecting').hidden = false;
  $('#sync-start').disabled = true;
  openSyncDialog('confirm');
  try {
    const channel = await join(code, syncInfo());
    if (syncSession !== session) { channel.close(); return; }
    session.channel = channel;
    const other = channel.info.device ?? otherKind(own);
    syncEl.querySelectorAll('.sync-other-name').forEach((n) => { n.textContent = other; });
    syncEl.querySelector('.sync-other-cap').textContent = capital(other);
    $('#sync-other-count').textContent = channel.info.notes ?? '–';
    $('#sync-connecting').hidden = true;
    $('#sync-start').disabled = false;
    $('#sync-start').focus();
    listenToChannel(session);
  } catch (err) {
    if (syncSession === session) showSyncFailure(err);
  }
}

function listenToChannel(session) {
  const { channel } = session;
  channel.onMessage((msg) => {
    if (syncSession !== session) return;
    if (msg.type === 'start' && session.role === 'host') {
      showSyncProgress('Checking notes…', 50);
      // Sprint 1: the two devices only meet. Copying notes across comes next.
      channel.send({ type: 'done' });
      showSyncDone(session);
    } else if (msg.type === 'done' && session.role === 'join') {
      showSyncDone(session);
      endSyncSession();
    }
  });
  channel.onClose(() => {
    if (syncSession === session && syncEl.dataset.step !== 'done') showSyncFailure({ reason: 'refused' });
  });
}

function showSyncProgress(text, percent) {
  $('#sync-progress').textContent = text;
  $('#sync-bar-fill').style.width = `${percent}%`;
  syncEl.querySelector('.sync-bar').setAttribute('aria-valuenow', String(percent));
  setSyncStep('syncing');
}

function showSyncDone(session) {
  const other = session.channel.info;
  const otherName = other.device ?? otherKind(deviceKind());
  const same = otherName === deviceKind(); // two computers, or two phones
  $('#sync-done-title').textContent = 'Connected';
  $('#sync-done-text').textContent = `This ${deviceKind()} and ${same ? 'the other' : 'your'} ${otherName} can reach each other directly. Copying notes between them is the next step we build.`;
  const row = (label, value) => {
    const li = el('li');
    li.append(el('span', '', label), el('strong', '', value));
    return li;
  };
  $('#sync-stats').replaceChildren(
    row(`This ${deviceKind()}`, countLabel(syncInfo().notes)),
    row(same ? `Other ${otherName}` : capital(otherName), countLabel(other.notes ?? 0)),
  );
  $('#sync-note').hidden = true;
  setSyncStep('done');
}

$('#sync-open').addEventListener('click', startSyncHost);
$('#sync-new-code').addEventListener('click', startSyncHost);
$('#sync-close').addEventListener('click', closeSync);
$('#sync-retry').addEventListener('click', () => syncRetry?.());
$('#sync-start').addEventListener('click', () => {
  const session = syncSession;
  if (!session?.channel) return;
  session.channel.send({ type: 'start' });
  showSyncProgress('Checking notes…', 50);
});
syncEl.querySelectorAll('.sync-cancel').forEach((b) => b.addEventListener('click', closeSync));
syncEl.querySelectorAll('.sync-backup').forEach((b) => b.addEventListener('click', () => { closeSync(); exportNotes(); }));
syncEl.addEventListener('close', endSyncSession);

// The menu says what this device pairs with.
const labelSyncItem = () => { $('#sync-open').textContent = `Sync with ${otherKind(deviceKind())}`; };
labelSyncItem();
phoneLayout.addEventListener('change', labelSyncItem);

// ---------- The list: open, keyboard, swipe, pull ----------

let swallowClick = false; // a swipe ends with a click; don't open the note too

listEl.addEventListener('click', (e) => {
  const item = e.target.closest('.note-item');
  if (!item) return;
  if (swallowClick) { swallowClick = false; return; }
  const words = searchWords();
  openNote(item.dataset.id, { jumpTo: words[0] ?? null });
});

// ↑/↓ move through the list; Enter opens (it's a button).
listEl.addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = [...listEl.querySelectorAll('.note-item')];
  const i = items.indexOf(document.activeElement);
  if (i === -1) return;
  e.preventDefault();
  const j = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
  items[j].focus();
});

// Phones: swipe a tile left to move it to Trash, right to pin it.
let swipe = null;
listEl.addEventListener('pointerdown', (e) => {
  const tile = e.target.closest('.note-item');
  if (!tile || !phoneLayout.matches || view === 'trash' || e.pointerType === 'mouse') return;
  swipe = { tile, li: tile.parentElement, x: e.clientX, y: e.clientY, dx: 0, active: false, id: e.pointerId };
});
listEl.addEventListener('pointermove', (e) => {
  if (!swipe || e.pointerId !== swipe.id) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  if (!swipe.active) {
    if (Math.abs(dy) > 12) { swipe = null; return; } // scrolling, not swiping
    if (Math.abs(dx) < 12) return;
    swipe.active = true;
    swipe.tile.setPointerCapture(e.pointerId);
  }
  swipe.dx = dx;
  swipe.tile.style.transform = `translateX(${dx}px)`;
  swipe.li.dataset.swipe = dx < 0 ? 'trash' : 'pin';
  swipe.li.classList.toggle('swipe-armed', Math.abs(dx) > swipe.tile.offsetWidth * 0.3);
});
function endSwipe(e) {
  if (!swipe || e.pointerId !== swipe.id) return;
  const { tile, li, dx, active } = swipe;
  swipe = null;
  if (!active) return;
  swallowClick = true;
  setTimeout(() => { swallowClick = false; }, 400);
  tile.style.transition = 'transform 0.2s';
  tile.style.transform = '';
  setTimeout(() => { tile.style.transition = ''; delete li.dataset.swipe; li.classList.remove('swipe-armed'); }, 200);
  if (Math.abs(dx) <= tile.offsetWidth * 0.3) return;
  const note = notes.find((n) => n.id === tile.dataset.id);
  if (dx < 0) moveToTrash(note);
  else togglePinFor(note);
}
listEl.addEventListener('pointerup', endSwipe);
listEl.addEventListener('pointercancel', endSwipe);

// Phones: pull the list down from the top to search.
let pull = null;
listEl.addEventListener('touchstart', (e) => {
  if (listEl.scrollTop > 0 || !phoneLayout.matches) return;
  pull = { y: e.touches[0].clientY };
}, { passive: true });
listEl.addEventListener('touchmove', (e) => {
  if (!pull) return;
  const dy = e.touches[0].clientY - pull.y;
  listEl.style.setProperty('--pull', `${Math.max(0, Math.min(dy, 90)) * 0.5}px`);
  pull.dy = dy;
}, { passive: true });
listEl.addEventListener('touchend', () => {
  if (!pull) return;
  if ((pull.dy ?? 0) > 80) { searchEl.focus(); searchEl.select(); }
  listEl.style.removeProperty('--pull');
  pull = null;
});

// ---------- Collapsible list (desktop) ----------

const LIST_KEY = 'notes.listCollapsed';
const collapseBtn = $('#collapse-list');
const expandBtn = $('#expand-list');

function setListCollapsed(collapsed, { moveFocus = false } = {}) {
  document.body.dataset.list = collapsed ? 'collapsed' : 'open';
  collapseBtn.setAttribute('aria-expanded', String(!collapsed));
  setSetting(LIST_KEY, collapsed ? '1' : '0');
  // Keep keyboard focus on the control that just took the place of the one pressed.
  if (moveFocus) (collapsed ? expandBtn : collapseBtn).focus();
}

setListCollapsed(getSetting(LIST_KEY) === '1');

collapseBtn.addEventListener('click', () => setListCollapsed(true, { moveFocus: true }));
expandBtn.addEventListener('click', () => setListCollapsed(false, { moveFocus: true }));
$('#rail-search').addEventListener('click', () => {
  setListCollapsed(false);
  searchEl.focus();
});
for (const id of ['#new-note', '#new-note-fab', '#rail-new']) $(id).addEventListener('click', () => newNote());
$('#back').addEventListener('click', leaveEditorView);
window.addEventListener('popstate', () => {
  if (!viewerEl.hidden) closeViewer({ fromHistory: true });
  else if (document.body.dataset.view === 'editor') showList();
});
pinBtn.addEventListener('click', () => togglePinFor(activeNote()));
$('#undo').addEventListener('click', runUndo);

// ---------- Search, sort, tags ----------

searchEl.addEventListener('input', renderList);
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && searchEl.value) {
    e.stopPropagation();
    searchEl.value = '';
    renderList();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    listEl.querySelector('.note-item')?.focus();
  }
});

sortEl.addEventListener('change', () => {
  sortBy = sortEl.value in SORTS ? sortEl.value : 'updated';
  setSetting(SORT_KEY, sortBy);
  renderList();
});

tagFilterEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.tag-chip');
  if (chip) setActiveTag(chip.dataset.tag);
});

// A tag inside the note: filter the list by it (and on phones, go to the list to see it).
function filterByTagFromNote(tag) {
  hideTagHint();
  activeTag = null; // always turn this tag on, never toggle it off
  setActiveTag(tag);
  setListCollapsed(false);
  if (document.body.dataset.view === 'editor' && phoneLayout.matches) leaveEditorView();
}

noteTagsEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.note-tag');
  if (chip) filterByTagFromNote(chip.dataset.tag);
});

// Tapping a #tag you typed: offer "Show #tag notes" in the top bar rather than jumping
// straight to the list, so tapping into a tag to edit it still just edits it.
const tagHintEl = $('#tag-hint');

function tagAtCaret(field) {
  const pos = field.selectionStart;
  if (pos !== field.selectionEnd) return null; // a selection, not a tap
  for (const m of field.value.matchAll(TAG_RE)) {
    const start = m.index + m[1].length; // where the # is
    const end = start + 1 + m[2].length;
    if (pos >= start && pos <= end) {
      const tag = m[2].replace(/[-_]+$/, '').toLowerCase();
      return /\p{L}/u.test(tag) ? tag : null;
    }
  }
  return null;
}

function showTagHint(tag) {
  tagHintEl.dataset.tag = tag;
  tagHintEl.querySelector('.tag-hint-label').textContent = `Show #${tag} notes`;
  tagHintEl.hidden = false;
  editorEl.toggleAttribute('data-tag-hint', true);
}

function hideTagHint() {
  tagHintEl.hidden = true;
  editorEl.toggleAttribute('data-tag-hint', false);
}

function checkTagHint(field) {
  if (!isWritingField(field)) return;
  const tag = tagAtCaret(field);
  if (tag) showTagHint(tag); else hideTagHint();
}
editorEl.addEventListener('click', (e) => checkTagHint(e.target)); // a tap or click places the caret
editorEl.addEventListener('keyup', (e) => { // moving the caret with the arrow keys
  if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') checkTagHint(e.target);
});
titleEl.addEventListener('input', hideTagHint);
tagHintEl.addEventListener('click', () => filterByTagFromNote(tagHintEl.dataset.tag));

// Typing "#rec" suggests tags you already use, so #recipe and #recipes don't split your notes.
const tagSuggestEl = $('#tag-suggest');

function partialTag(field) {
  if (field.selectionStart !== field.selectionEnd) return null;
  const m = /(^|\s)#([\p{L}\p{N}_-]*)$/u.exec(field.value.slice(0, field.selectionStart));
  return m ? m[2].toLowerCase() : null;
}

function updateTagSuggest(field) {
  if (!isWritingField(field)) { hideTagSuggest(); return; }
  const partial = partialTag(field);
  if (partial === null) { hideTagSuggest(); return; }
  const counts = tagCounts(notes.filter((n) => !isDeleted(n)));
  const matches = [...counts]
    .filter(([tag]) => tag.startsWith(partial) && tag !== partial)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5);
  if (!matches.length) { hideTagSuggest(); return; }
  tagSuggestEl.replaceChildren(...matches.map(([tag]) => {
    const b = el('button', 'tag-suggestion', `#${tag}`);
    b.type = 'button';
    b.dataset.tag = tag;
    return b;
  }));
  tagSuggestEl.hidden = false;
}

function hideTagSuggest() { tagSuggestEl.hidden = true; }

function acceptTagSuggestion(field, tag) {
  if (!tag || !isWritingField(field)) return;
  const partial = partialTag(field);
  if (partial === null) return;
  const end = field.selectionStart;
  field.setSelectionRange(end - partial.length - 1, end);
  let ok = false;
  try { ok = document.execCommand('insertText', false, `#${tag} `); } catch { /* unsupported */ }
  if (!ok) {
    field.setRangeText(`#${tag} `, end - partial.length - 1, end, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  hideTagSuggest();
}

tagSuggestEl.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the cursor where it is
tagSuggestEl.addEventListener('click', (e) => {
  const b = e.target.closest('.tag-suggestion');
  if (b) acceptTagSuggestion(document.activeElement, b.dataset.tag);
});
titleEl.addEventListener('input', () => updateTagSuggest(titleEl));
editorEl.addEventListener('focusout', () => setTimeout(() => { if (!isWritingField(document.activeElement)) hideTagSuggest(); }, 0));

// ---------- Title ----------

titleEl.addEventListener('input', () => {
  const note = activeNote();
  if (!note) return;
  note.title = titleEl.value;
  touched(note);
});

// Enter in the title moves on to the writing, like a notebook heading.
titleEl.addEventListener('keydown', (e) => {
  if (!tagSuggestEl.hidden && e.key === 'Tab') { e.preventDefault(); acceptTagSuggestion(titleEl, tagSuggestEl.querySelector('.tag-suggestion')?.dataset.tag); return; }
  if (e.key === 'Enter' && !e.isComposing) { // let IME users confirm a word with Enter
    e.preventDefault();
    const first = activeNote()?.blocks[0];
    if (!first) return;
    focusField(first.type === 'text' ? { blockId: first.id, caret: 0 } : { blockId: first.id, item: 0, caret: 0 });
  }
});

// Changing color is not a text edit, so it doesn't move the note to the top.
swatchesEl.addEventListener('click', (e) => {
  const sw = e.target.closest('.swatch');
  const note = activeNote();
  if (!sw || !note || note.color === sw.dataset.color) return;
  note.color = sw.dataset.color;
  scheduleSave();
  renderEditorChrome(note);
  renderList();
});

// ---------- Tools: Aa tray and the phone's keyboard strip ----------

// Tools that act on the text keep the text box focused (and its selection, and the phone keyboard up).
const keepFocus = (btn) => btn.addEventListener('pointerdown', (e) => e.preventDefault());

for (const [id, kind] of [['#list-numbered', 'numbered'], ['#list-bullet', 'bullet'], ['#kb-numbered', 'numbered'], ['#kb-bullet', 'bullet']]) {
  const btn = $(id);
  keepFocus(btn);
  btn.addEventListener('click', () => {
    closeTray();
    applyListKind(kind);
  });
}
for (const id of ['#add-checklist', '#kb-checklist']) {
  keepFocus($(id));
  $(id).addEventListener('click', () => { closeTray(); addChecklist(); });
}

const fmtToggleEl = $('#fmt-toggle');
let trayAnchor = null;

function openTray(anchor) {
  trayAnchor = anchor;
  trayEl.hidden = false;
  fmtToggleEl.setAttribute('aria-expanded', 'true');
  const asSheet = phoneLayout.matches;
  trayEl.classList.toggle('as-sheet', asSheet);
  if (asSheet) {
    trayEl.style.top = trayEl.style.left = '';
  } else {
    const r = anchor.getBoundingClientRect();
    trayEl.style.top = `${r.bottom + 8}px`;
    trayEl.style.left = `${Math.max(8, Math.min(r.left, innerWidth - trayEl.offsetWidth - 8))}px`;
  }
}

function closeTray() {
  if (trayEl.hidden) return;
  trayEl.hidden = true;
  fmtToggleEl.setAttribute('aria-expanded', 'false');
  trayAnchor = null;
}

for (const btn of [fmtToggleEl, $('#kb-tray')]) {
  keepFocus(btn);
  btn.addEventListener('click', () => (trayEl.hidden ? openTray(btn) : closeTray()));
}
// (Delegated, since the color swatches are re-created for each note. The notebook <select> needs focus.)
trayEl.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });

document.addEventListener('pointerdown', (e) => {
  if (trayEl.hidden || trayEl.contains(e.target) || trayAnchor?.contains(e.target)) return;
  closeTray();
});

// Page style is a property of the note, like its color; it isn't an edit either.
paperEl.addEventListener('click', (e) => {
  const opt = e.target.closest('.paper-opt');
  const note = activeNote();
  if (!opt || !note) return;
  if (opt.dataset.paper === 'plain') delete note.paper;
  else note.paper = opt.dataset.paper;
  scheduleSave();
  renderEditorChrome(note);
});

// Keep the strip just above the on-screen keyboard (iOS reports it through visualViewport).
function placeKeyboardTools() {
  const vv = window.visualViewport;
  const offset = vv ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0;
  document.documentElement.style.setProperty('--kb-offset', `${offset}px`);
}
window.visualViewport?.addEventListener('resize', placeKeyboardTools);
window.visualViewport?.addEventListener('scroll', placeKeyboardTools);

editorEl.addEventListener('focusin', (e) => {
  if (!phoneLayout.matches || !isWritingField(e.target) || isDeleted(activeNote())) return;
  kbToolsEl.hidden = false;
  document.body.dataset.kb = 'open';
  placeKeyboardTools();
});
editorEl.addEventListener('focusout', () => {
  // Wait a moment: focus may be moving to another field in the note.
  setTimeout(() => {
    if (isWritingField(document.activeElement)) return;
    kbToolsEl.hidden = true;
    delete document.body.dataset.kb;
  }, 0);
});
for (const btn of kbToolsEl.querySelectorAll('button')) keepFocus(btn);
$('#kb-image').addEventListener('click', () => imageFileEl.click());
$('#kb-hide').addEventListener('click', () => document.activeElement?.blur());
addEventListener('resize', () => { if (document.body.dataset.view === 'editor' || !phoneLayout.matches) autosizeAll(); });

// ---------- Light / dark ----------

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const themeBtn = $('#theme-toggle');

function applyTheme() {
  const chosen = document.documentElement.dataset.theme; // 'light' | 'dark' | undefined (= system)
  const effective = chosen ?? (darkQuery.matches ? 'dark' : 'light');
  document.documentElement.dataset.effective = effective;
  document.querySelector('meta[name="theme-color"]').content = effective === 'dark' ? '#141D22' : '#EEF5FB';
  themeBtn.setAttribute('aria-label', effective === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
}

themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.effective === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  setSetting('notes.theme', next);
  applyTheme();
});
darkQuery.addEventListener('change', applyTheme);
applyTheme();

// ---------- Keyboard ----------

const typingTarget = (t) => t?.matches?.('input, textarea, select, [contenteditable]');

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !trayEl.hidden) {
    closeTray();
    fmtToggleEl.focus();
    return;
  }
  if (e.key === 'Escape' && !nbMenu.hidden) {
    closeNotebookMenu();
    nbBtn.focus();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  // AltGr reports as Ctrl+Alt on Windows; AltGr+N types a letter on some layouts.
  const altGr = e.getModifierState?.('AltGraph');
  if (mod && e.altKey && !altGr && e.code === 'KeyN') {
    e.preventDefault();
    newNote();
  } else if (mod && e.key === '\\' && !phoneLayout.matches) {
    e.preventDefault();
    setListCollapsed(document.body.dataset.list !== 'collapsed', { moveFocus: true });
  } else if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (document.body.dataset.view === 'editor' && phoneLayout.matches) leaveEditorView();
    setListCollapsed(false);
    searchEl.focus();
    searchEl.select();
  } else if (e.key === '?' && !mod && !typingTarget(e.target)) {
    e.preventDefault();
    openHelp();
  } else if (e.key === 'Escape' && document.body.dataset.view === 'editor' && phoneLayout.matches) {
    leaveEditorView();
  }
});

// ---------- Saving, syncing, refreshing ----------

// Never lose the last keystrokes: when the page is hidden or closed, write any
// pending save now. Nothing pending means nothing to write (and no risk of
// overwriting a newer save from another tab).
const flushPending = () => { if (saveTimer) flushSave(); };
window.addEventListener('pagehide', () => { rememberPosition(); flushPending(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPending();
});

// Keep "edited 5 min ago" and list dates current.
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  renderList();
  const note = activeNote();
  if (note) renderMeta(note);
}, MIN);

// Another tab saved: pick up its notes. Leave the editor alone while typing here.
window.addEventListener('storage', (e) => {
  if (e.key === NOTEBOOKS_KEY) {
    notebooks = loadNotebooks();
    if (view !== 'all' && view !== 'trash' && !notebookName(view)) view = 'all';
    renderList();
    return;
  }
  if (e.key !== STORAGE_KEY) return;
  const current = activeNote();
  notes.splice(0, notes.length, ...(loadNotes() ?? []));
  if (current && isBlank(current) && !activeNote()) notes.push(current);
  if (!activeNote()) activeId = visibleNotes()[0]?.id ?? null;
  renderList();
  if (!isWritingField(document.activeElement)) renderEditor();
});

// ---------- Start ----------

flushSave(); // first run, or notes saved by an older version: store them in the current format
if (history.state?.editor) history.replaceState(null, ''); // reloaded mid-edit: we start on the list
if (activeNote() && !inView(activeNote())) activeId = visibleNotes()[0]?.id ?? null;
renderList();
renderEditor();
restorePosition();

// Opened from a home-screen shortcut (?new=note / ?new=checklist) or shared into from another app.
(function handleLaunch() {
  const params = new URLSearchParams(location.search);
  if (![...params.keys()].length) return;
  history.replaceState(history.state, '', location.pathname);
  const shared = [params.get('text'), params.get('url')].filter(Boolean).join('\n');
  if (params.has('title') || shared) newNote({ title: params.get('title') ?? '', text: shared });
  else if (params.get('new') === 'checklist') newNote({ checklist: true });
  else if (params.get('new')) newNote();
}());

// Opened from a sync code's link (#pair=…): connect to the device that showed it.
// The link may also land in a tab where the app is already open (only the #hash changes).
function handlePairLink() {
  if (!location.hash.startsWith('#pair=')) return;
  const code = parsePairHash(location.hash);
  history.replaceState(history.state, '', location.pathname + location.search);
  if (code) startSyncJoin(code);
  else showToast('That sync link is incomplete. Scan the code again.');
}
handlePairLink();
window.addEventListener('hashchange', handlePairLink);

// After an automatic update, say so (the reload could otherwise look like a glitch).
try {
  if (sessionStorage.getItem('notes.updated')) {
    sessionStorage.removeItem('notes.updated');
    showToast('Updated to the latest version', { ms: 3000 });
  }
} catch { /* fine */ }

// Shortly after start-up, delete stored pictures no saved note uses any more (removed images,
// deleted-forever notes). Reads the saved notes fresh, so another open tab's notes count too.
setTimeout(() => {
  const latest = loadNotes() ?? [];
  cleanUpImages([...latest, ...notes].flatMap(imagesOf)).catch(() => {});
}, 10000);

if ('serviceWorker' in navigator) {
  // A page that was already run by a worker gets swapped to a new version mid-session:
  // reload so every file comes from that version. Wait if you're typing.
  const hadWorker = !!navigator.serviceWorker.controller;
  let reloading = false;
  const reloadForUpdate = () => {
    if (reloading) return;
    reloading = true;
    flushPending();
    try { sessionStorage.setItem('notes.updated', '1'); } catch { /* fine */ }
    location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadWorker) return; // first install: this page is already the current version
    if (!isWritingField(document.activeElement)) reloadForUpdate();
    else document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') reloadForUpdate(); });
  });

  // Which version is running (handy when checking an update arrived): it's in the cache name.
  caches.keys()
    .then((keys) => {
      const shell = keys.find((k) => k.startsWith('notes-shell-'));
      $('#app-version').textContent = `Version ${shell ? shell.slice('notes-shell-'.length) : 'not installed yet'}`;
    })
    .catch(() => {});

  navigator.serviceWorker.register('./sw.js')
    .then((reg) => {
      // An installed app can stay open for days: look for a new version whenever it comes back.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch((err) => console.warn('Offline support unavailable:', err));
}
