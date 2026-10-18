import { loadNotes, saveNotes, STORAGE_KEY, backupJSON, parseBackup, mergeNotes } from './store.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const PALETTE = [
  { id: 'paper', name: 'Paper' },
  { id: 'cornflower', name: 'Cornflower' },
  { id: 'chartreuse', name: 'Chartreuse' },
  { id: 'peach', name: 'Peach' },
  { id: 'mint', name: 'Mint' },
  { id: 'pink', name: 'Pink' },
];

function welcomeNote() {
  const t = Date.now();
  return {
    id: crypto.randomUUID(),
    title: 'Welcome to Notes',
    body: 'This is your notebook. Write anything, anywhere.\n\n– New note starts a fresh page\n– Everything saves as you type, right here in this browser\n– Delete this note whenever you like',
    color: 'chartreuse',
    createdAt: t,
    updatedAt: t,
  };
}

const saved = loadNotes();
const firstRun = saved === null;
const notes = saved ?? [welcomeNote()];
const byRecent = (a, b) => b.updatedAt - a.updatedAt;
let activeId = [...notes].sort(byRecent)[0]?.id ?? null;

const $ = (sel) => document.querySelector(sel);
const listEl = $('#note-list');
const countEl = $('#count');
const editorEl = $('#editor');
const swatchesEl = $('#swatches');
const titleEl = $('#title');
const bodyEl = $('#body');
const metaEl = $('#meta');
const searchEl = $('#search');
const sortEl = $('#sort');

const colorVar = (color) => `var(--c-${color})`;

// ---------- Search and sort ----------

const SORT_KEY = 'notes.sort';
const SORTS = {
  updated: (a, b) => b.updatedAt - a.updatedAt,
  created: (a, b) => b.createdAt - a.createdAt,
  title: (a, b) => displayTitle(a).localeCompare(displayTitle(b), undefined, { sensitivity: 'base', numeric: true }),
};

let sortBy = 'updated';
try {
  const savedSort = localStorage.getItem(SORT_KEY);
  if (savedSort in SORTS) sortBy = savedSort;
} catch { /* storage blocked: use the default */ }
sortEl.value = sortBy;

const sortNotes = (list) => [...list].sort(SORTS[sortBy]);

// Every word typed must appear somewhere in the title or body.
function visibleNotes() {
  const words = searchEl.value.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = words.length
    ? notes.filter((n) => {
      const text = `${n.title}\n${n.body}`.toLowerCase();
      return words.every((w) => text.includes(w));
    })
    : notes;
  return sortNotes(matches);
}

function displayTitle(note) {
  return note.title.trim() || note.body.trim().split('\n')[0] || 'Untitled';
}

function preview(note) {
  const text = note.title.trim() ? note.body : note.body.trim().split('\n').slice(1).join(' ');
  return text.replace(/\s+/g, ' ').trim();
}

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

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < MIN) return 'just now';
  if (diff < HOUR) return `${Math.round(diff / MIN)} min ago`;
  if (diff < DAY) return `${Math.round(diff / HOUR)} h ago`;
  if (diff < 2 * DAY) return 'yesterday';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderList() {
  const shown = visibleNotes();
  const total = `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`;
  countEl.textContent = shown.length === notes.length ? total : `${shown.length} of ${total}`;

  if (!shown.length) {
    const msg = notes.length ? 'No notes match your search.' : 'No notes yet. Start one with New note.';
    listEl.replaceChildren(el('li', 'list-empty', msg));
    return;
  }

  const dateOf = (note) => (sortBy === 'created' ? note.createdAt : note.updatedAt);

  listEl.replaceChildren(...shown.map((note) => {
    const btn = el('button', 'note-item');
    btn.type = 'button';
    btn.dataset.id = note.id;
    if (note.id === activeId) btn.setAttribute('aria-current', 'true');

    const dot = el('span', 'dot');
    dot.dataset.color = note.color;
    dot.style.setProperty('--c', colorVar(note.color));

    const row = el('span', 'note-row');
    row.append(dot, el('span', 'note-title', displayTitle(note)), el('span', 'note-date', shortDate(dateOf(note))));
    btn.append(row, el('span', 'note-preview', preview(note) || ' '));

    const li = el('li');
    li.append(btn);
    return li;
  }));
}

const activeNote = () => notes.find((n) => n.id === activeId);
const isBlank = (note) => !note.title.trim() && !note.body.trim();

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

function renderMeta(note) {
  if (saveFailed) metaEl.textContent = 'Not saved — browser storage is full or blocked';
  else if (saveTimer) metaEl.textContent = 'Saving…';
  else metaEl.textContent = `Saved · edited ${relativeTime(note.updatedAt)}`;
}

function renderEditor() {
  const note = activeNote();
  editorEl.toggleAttribute('data-empty', !note);
  if (!note) return;
  editorEl.style.setProperty('--c', colorVar(note.color));
  editorEl.style.setProperty('--note-c', colorVar(note.color));
  titleEl.value = note.title;
  bodyEl.value = note.body;
  renderMeta(note);

  swatchesEl.replaceChildren(...PALETTE.map((p) => {
    const sw = el('button', 'swatch');
    sw.type = 'button';
    sw.dataset.color = p.id;
    sw.setAttribute('aria-label', p.name);
    sw.setAttribute('aria-pressed', String(p.id === note.color));
    sw.style.setProperty('--c', colorVar(p.id));
    return sw;
  }));
}

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
const phoneLayout = matchMedia('(max-width: 719px)');

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

function openNote(id) {
  if (id !== activeId) discardIfBlank(activeId);
  activeId = id;
  enterEditorView();
  renderList();
  renderEditor();
}

function newNote() {
  const t = Date.now();
  const note = { id: crypto.randomUUID(), title: '', body: '', color: 'paper', createdAt: t, updatedAt: t };
  notes.push(note);
  searchEl.value = ''; // so the new note shows up in the list
  openNote(note.id);
  bodyEl.focus();
}

function showList() {
  discardIfBlank(activeId);
  if (!activeNote()) activeId = null;
  document.body.dataset.view = 'list';
  renderList();
  renderEditor();
}

function updateActive(field, value) {
  const note = activeNote();
  if (!note) return;
  note[field] = value;
  note.updatedAt = Date.now();
  scheduleSave();
  renderMeta(note);
  renderList();
}

// ---------- Delete with undo ----------

const UNDO_MS = 6000;
const toastEl = $('#toast');
const toastMsgEl = $('#toast-msg');
const undoEl = $('#undo');
let lastDeleted = null;
let toastTimer = null;

function hideToast() {
  clearTimeout(toastTimer);
  toastEl.hidden = true;
  lastDeleted = null;
}

// One toast at a time; Undo shows only for a delete.
function showToast(message, { undo = false } = {}) {
  clearTimeout(toastTimer);
  lastDeleted = undo ? lastDeleted : null;
  toastMsgEl.textContent = message;
  undoEl.hidden = !undo;
  toastEl.hidden = false;
  toastTimer = setTimeout(hideToast, UNDO_MS);
}

function deleteActive() {
  const i = notes.findIndex((n) => n.id === activeId);
  if (i === -1) return;
  const [note] = notes.splice(i, 1);
  flushSave();

  // Keep the editor useful on desktop: open the next note in the list.
  const next = visibleNotes()[0] ?? sortNotes(notes)[0];
  activeId = next ? next.id : null;
  leaveEditorView();
  renderList();
  renderEditor();

  if (isBlank(note)) return; // nothing worth undoing
  lastDeleted = note;
  showToast('Note deleted', { undo: true });
}

function undoDelete() {
  if (!lastDeleted) return;
  notes.push(lastDeleted);
  const id = lastDeleted.id;
  hideToast();
  flushSave();
  openNote(id);
}

// ---------- Backup: export and import ----------

const backupEl = $('#backup');
const importFileEl = $('#import-file');

function localDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function exportNotes() {
  backupEl.open = false;
  if (saveTimer) flushSave();
  const keep = notes.filter((n) => !isBlank(n));
  const blob = new Blob([backupJSON(keep)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = `notes-${localDate(Date.now())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  showToast(`Exported ${keep.length} ${keep.length === 1 ? 'note' : 'notes'}`);
}

async function importNotes(file) {
  let text;
  try {
    text = await file.text();
  } catch {
    showToast('Couldn’t read that file.');
    return;
  }
  const { notes: incoming, error } = parseBackup(text);
  if (error) {
    showToast(error);
    return;
  }
  if (saveTimer) flushSave();
  const { added, updated } = mergeNotes(notes, incoming);
  flushSave();
  if (!activeNote()) activeId = [...notes].sort(byRecent)[0]?.id ?? null;
  renderList();
  renderEditor();

  const parts = [];
  if (added) parts.push(`${added} added`);
  if (updated) parts.push(`${updated} updated`);
  showToast(parts.length ? `Imported: ${parts.join(', ')}` : 'Nothing new — your notes are up to date');
}

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

// ---------- Events ----------

listEl.addEventListener('click', (e) => {
  const item = e.target.closest('.note-item');
  if (item) openNote(item.dataset.id);
});

$('#new-note').addEventListener('click', newNote);
$('#new-note-fab').addEventListener('click', newNote);
$('#back').addEventListener('click', leaveEditorView);
window.addEventListener('popstate', () => {
  if (document.body.dataset.view === 'editor') showList();
});
$('#delete').addEventListener('click', deleteActive);
$('#undo').addEventListener('click', undoDelete);

searchEl.addEventListener('input', renderList);
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && searchEl.value) {
    e.stopPropagation();
    searchEl.value = '';
    renderList();
  }
});

sortEl.addEventListener('change', () => {
  sortBy = sortEl.value in SORTS ? sortEl.value : 'updated';
  try { localStorage.setItem(SORT_KEY, sortBy); } catch { /* not remembered; still works */ }
  renderList();
});

// Changing color is not a text edit, so it doesn't move the note to the top.
swatchesEl.addEventListener('click', (e) => {
  const sw = e.target.closest('.swatch');
  const note = activeNote();
  if (!sw || !note || note.color === sw.dataset.color) return;
  note.color = sw.dataset.color;
  scheduleSave();
  renderEditor();
  renderList();
});

titleEl.addEventListener('input', () => updateActive('title', titleEl.value));
bodyEl.addEventListener('input', () => updateActive('body', bodyEl.value));

// Enter in the title moves on to the body, like a notebook heading.
titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { // let IME users confirm a word with Enter
    e.preventDefault();
    bodyEl.focus();
  }
});

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  // AltGr reports as Ctrl+Alt on Windows; AltGr+N types a letter on some layouts.
  const altGr = e.getModifierState?.('AltGraph');
  if (mod && e.altKey && !altGr && e.code === 'KeyN') {
    e.preventDefault();
    newNote();
  } else if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (document.body.dataset.view === 'editor') leaveEditorView();
    searchEl.focus();
    searchEl.select();
  } else if (e.key === 'Escape' && document.body.dataset.view === 'editor' && phoneLayout.matches) {
    leaveEditorView();
  }
});

// Never lose the last keystrokes: when the page is hidden or closed, write any
// pending save now. Nothing pending means nothing to write (and no risk of
// overwriting a newer save from another tab).
const flushPending = () => { if (saveTimer) flushSave(); };
window.addEventListener('pagehide', flushPending);
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
  if (e.key !== STORAGE_KEY) return;
  const current = activeNote();
  notes.splice(0, notes.length, ...(loadNotes() ?? []));
  if (current && isBlank(current) && !activeNote()) notes.push(current);
  if (!activeNote()) activeId = [...notes].sort(byRecent)[0]?.id ?? null;
  renderList();
  if (document.activeElement !== titleEl && document.activeElement !== bodyEl) renderEditor();
});

if (firstRun) flushSave();
if (history.state?.editor) history.replaceState(null, ''); // reloaded mid-edit: we start on the list
renderList();
renderEditor();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Offline support unavailable:', err));
}
