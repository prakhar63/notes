// Notes and notebooks persistence in localStorage. No DOM code here.

import { textBlock, checklistBlock, newItem } from './blocks.js';

export const STORAGE_KEY = 'notes.v1';
export const NOTEBOOKS_KEY = 'notes.notebooks';
const COLORS = ['paper', 'cornflower', 'chartreuse', 'peach', 'mint', 'pink'];
const PAPERS = ['ruled', 'dotted', 'grid'];

const str = (v) => (typeof v === 'string' ? v : '');

function normalizeItem(it, fallbackId) {
  if (!it || typeof it !== 'object') return null;
  return { id: typeof it.id === 'string' ? it.id : fallbackId, text: str(it.text), done: it.done === true };
}

function normalizeBlock(b, i, noteId) {
  if (!b || typeof b !== 'object') return null;
  const id = typeof b.id === 'string' ? b.id : `${noteId}-b${i}`;
  if (b.type === 'checklist') {
    const items = (Array.isArray(b.items) ? b.items : []).map((it, k) => normalizeItem(it, `${id}-${k}`)).filter(Boolean);
    return { id, type: 'checklist', items: items.length ? items : [newItem()] };
  }
  return { id, type: 'text', text: str(b.text) };
}

// Validates the core fields; any other fields pass through untouched, so a reload never drops them.
// Notes from before blocks (a `body`, or a checklist `kind` with `items`) are converted to blocks.
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const now = Date.now();
  const note = {
    ...raw,
    id: raw.id,
    title: str(raw.title),
    color: COLORS.includes(raw.color) ? raw.color : 'paper',
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
  };

  let blocks = Array.isArray(raw.blocks) ? raw.blocks.map((b, i) => normalizeBlock(b, i, raw.id)).filter(Boolean) : [];
  if (!blocks.length) {
    if (raw.kind === 'checklist') {
      const items = (Array.isArray(raw.items) ? raw.items : []).map((it, k) => normalizeItem(it, `${raw.id}-${k}`)).filter(Boolean);
      blocks = [checklistBlock(items.length ? items : [newItem()])];
    } else {
      blocks = [textBlock(str(raw.body))];
    }
  }
  note.blocks = blocks;
  delete note.body;
  delete note.kind;
  delete note.items;

  // Images: a list of ids; the pictures themselves live in IndexedDB (images.js).
  if (Array.isArray(raw.images)) note.images = raw.images.filter((id) => typeof id === 'string');
  else delete note.images;
  if (!PAPERS.includes(raw.paper)) delete note.paper;
  if (typeof raw.notebookId !== 'string') delete note.notebookId;
  if (!Number.isFinite(raw.deletedAt)) delete note.deletedAt;
  if (!Number.isFinite(raw.pinnedAt)) delete note.pinnedAt;
  return note;
}

const isBlank = (note) =>
  !note.title.trim()
  && note.blocks.every((b) => (b.type === 'text' ? !b.text.trim() : !b.items.some((it) => it.text.trim())))
  && !(note.images ?? []).length;

/**
 * Returns the saved notes, or null on first run (nothing saved yet).
 * Blank notes are dropped. Unreadable data is set aside, not overwritten.
 */
export function loadNotes() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === null) return null;

  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('not an array');
    return data.map(normalize).filter((n) => n && !isBlank(n));
  } catch {
    try {
      localStorage.setItem(`${STORAGE_KEY}.corrupt-${Date.now()}`, raw);
    } catch { /* storage full or blocked; nothing more we can do */ }
    return [];
  }
}

/** Saves all notes. Returns false if the browser refused (quota, private mode). */
export function saveNotes(notes) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
    return true;
  } catch {
    return false;
  }
}

// ---------- Notebooks: optional groups of notes ----------

function normalizeNotebook(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const name = str(raw.name).trim();
  if (!name) return null;
  return { id: raw.id, name, createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now() };
}

export function loadNotebooks() {
  try {
    const data = JSON.parse(localStorage.getItem(NOTEBOOKS_KEY) ?? '[]');
    return Array.isArray(data) ? data.map(normalizeNotebook).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function saveNotebooks(notebooks) {
  try {
    localStorage.setItem(NOTEBOOKS_KEY, JSON.stringify(notebooks));
    return true;
  } catch {
    return false;
  }
}

// ---------- Backup files ----------

const BACKUP_APP = 'notes';
const BACKUP_VERSION = 3; // 2 added `images`: { id: data URL }; 3 adds blocks and `notebooks`

/** The JSON text of a backup file holding all notes, notebooks and, optionally, images. */
export function backupJSON(notes, images = {}, notebooks = []) {
  return JSON.stringify({ app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: Date.now(), notes, notebooks, images }, null, 2);
}

/**
 * Reads a backup file's text. Returns { notes, images, notebooks } or { error } with a message
 * fit to show the user. Also accepts a bare array of notes, and older versions.
 */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'That file isn’t a notes backup (it isn’t valid JSON).' };
  }
  const list = Array.isArray(data) ? data : data?.notes;
  if (!Array.isArray(list) || (!Array.isArray(data) && data.app !== BACKUP_APP)) {
    return { error: 'That file isn’t a notes backup.' };
  }
  if (!Array.isArray(data) && data.version > BACKUP_VERSION) {
    return { error: 'That backup was made by a newer version of Notes.' };
  }
  const notes = list.map(normalize);
  if (notes.some((n) => !n)) return { error: 'That backup is damaged: some notes are unreadable.' };
  const images = {};
  if (!Array.isArray(data) && data.images && typeof data.images === 'object') {
    for (const [id, url] of Object.entries(data.images)) {
      if (typeof url === 'string' && url.startsWith('data:image/')) images[id] = url;
    }
  }
  const notebooks = !Array.isArray(data) && Array.isArray(data.notebooks)
    ? data.notebooks.map(normalizeNotebook).filter(Boolean) : [];
  return { notes: notes.filter((n) => !isBlank(n)), images, notebooks };
}

/**
 * Merges imported notes into `notes` in place, by id: the newer updatedAt
 * wins and unknown ids are added. Returns how many were added and updated.
 */
export function mergeNotes(notes, incoming) {
  let added = 0;
  let updated = 0;
  for (const note of incoming) {
    const i = notes.findIndex((n) => n.id === note.id);
    if (i === -1) {
      notes.push(note);
      added += 1;
    } else if (note.updatedAt > notes[i].updatedAt) {
      notes[i] = note;
      updated += 1;
    }
  }
  return { added, updated };
}
