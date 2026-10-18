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
  if (!Number.isFinite(raw.changedAt)) delete note.changedAt;
  return note;
}

// ---------- Change tracking, for sync ----------
//
// Sync needs to know when anything about a note changed (including pins, Trash and its
// notebook, which don't count as edits), and which notes were removed for good. Rather
// than every action remembering to say so, saving compares each note with how it was
// last saved: a difference stamps `changedAt`, and a note that is gone leaves a deletion
// record ("tombstone") so another device doesn't bring it back.

export const TOMBSTONES_KEY = 'notes.tombstones';
const TOMBSTONE_DAYS = 180;
const lastSaved = { notes: new Map(), notebooks: new Map() }; // id → fingerprint

const fingerprint = ({ changedAt, ...rest }) => JSON.stringify(rest);

/** When this note or notebook last changed in any way (older saves only have updatedAt). */
export const changeTime = (item) => (Number.isFinite(item.changedAt) ? item.changedAt : (item.updatedAt ?? item.createdAt ?? 0));

function remember(kind, items) {
  lastSaved[kind] = new Map(items.map((it) => [it.id, fingerprint(it)]));
}

/** Deletion records: { notes: { id: when }, notebooks: { id: when } }. */
export function loadTombstones() {
  try {
    const data = JSON.parse(localStorage.getItem(TOMBSTONES_KEY) ?? '{}');
    const clean = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([, t]) => Number.isFinite(t)));
    return { notes: clean(data.notes), notebooks: clean(data.notebooks) };
  } catch {
    return { notes: {}, notebooks: {} };
  }
}

function saveTombstones(t) {
  const cutoff = Date.now() - TOMBSTONE_DAYS * 24 * 60 * 60 * 1000;
  const recent = (o) => Object.fromEntries(Object.entries(o).filter(([, when]) => when > cutoff));
  try {
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify({ notes: recent(t.notes), notebooks: recent(t.notebooks) }));
  } catch { /* storage full or blocked */ }
}

// Stamps what changed since the last save and records what was removed.
function track(kind, items) {
  const now = Date.now();
  const before = lastSaved[kind];
  const tombs = loadTombstones();
  let tombsChanged = false;
  for (const it of items) {
    const old = before.get(it.id);
    if (old === undefined ? !Number.isFinite(it.changedAt) : old !== fingerprint(it)) it.changedAt = now;
    if (tombs[kind][it.id] !== undefined) { delete tombs[kind][it.id]; tombsChanged = true; } // back again (undo, import)
  }
  const present = new Set(items.map((it) => it.id));
  for (const id of before.keys()) {
    if (!present.has(id)) { tombs[kind][id] = now; tombsChanged = true; }
  }
  if (tombsChanged) saveTombstones(tombs);
  remember(kind, items);
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
    const list = data.map(normalize).filter((n) => n && !isBlank(n));
    remember('notes', list);
    return list;
  } catch {
    try {
      localStorage.setItem(`${STORAGE_KEY}.corrupt-${Date.now()}`, raw);
    } catch { /* storage full or blocked; nothing more we can do */ }
    return [];
  }
}

/** Saves all notes. Returns false if the browser refused (quota, private mode). */
export function saveNotes(notes) {
  track('notes', notes);
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
  const nb = { id: raw.id, name, createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now() };
  if (Number.isFinite(raw.changedAt)) nb.changedAt = raw.changedAt;
  return nb;
}

export function loadNotebooks() {
  let list = [];
  try {
    const data = JSON.parse(localStorage.getItem(NOTEBOOKS_KEY) ?? '[]');
    if (Array.isArray(data)) list = data.map(normalizeNotebook).filter(Boolean);
  } catch { /* unreadable: start empty */ }
  remember('notebooks', list);
  return list;
}

export function saveNotebooks(notebooks) {
  track('notebooks', notebooks);
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

// ---------- Sync: merging two devices' notes ----------

/** Saves the result of a sync as is: no new change stamps, and its deletion records replace ours. */
export function saveSynced(notes, notebooks, tombstones) {
  remember('notes', notes);
  remember('notebooks', notebooks);
  saveTombstones(tombstones);
  return saveNotes(notes) && saveNotebooks(notebooks);
}

/** What this device sends for a sync. Blank notes stay behind. */
export function syncState(notes, notebooks, lastSyncAt = 0) {
  return { notes: notes.filter((n) => !isBlank(n)), notebooks, tombstones: loadTombstones(), lastSyncAt };
}

const isLive = (note) => note && !Number.isFinite(note.deletedAt);

/**
 * Merges this device's state with the other device's. Both devices run this on the same
 * two states and get the same result: for each note and notebook the one changed most
 * recently wins; something deleted for good stays deleted unless it changed after that.
 * Returns { notes, notebooks, tombstones, stats } with stats from this device's view.
 */
export function mergeStates(local, remote) {
  const remoteNotes = (Array.isArray(remote?.notes) ? remote.notes : []).map(normalize).filter((n) => n && !isBlank(n));
  const remoteBooks = (Array.isArray(remote?.notebooks) ? remote.notebooks : []).map(normalizeNotebook).filter(Boolean);
  const tombs = { notes: { ...local.tombstones.notes }, notebooks: { ...local.tombstones.notebooks } };
  for (const kind of ['notes', 'notebooks']) {
    for (const [id, when] of Object.entries(remote?.tombstones?.[kind] ?? {})) {
      if (Number.isFinite(when) && !(tombs[kind][id] >= when)) tombs[kind][id] = when;
    }
  }

  // The newer one wins; on an exact tie, both devices pick the same one by content.
  const pick = (a, b) => {
    if (!a || !b) return a ?? b;
    const ta = changeTime(a);
    const tb = changeTime(b);
    if (ta !== tb) return ta > tb ? a : b;
    return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
  };
  const mergeKind = (kind, mine, theirs) => {
    const byId = new Map(mine.map((x) => [x.id, x]));
    const other = new Map(theirs.map((x) => [x.id, x]));
    const out = [];
    for (const id of new Set([...byId.keys(), ...other.keys()])) {
      const winner = pick(byId.get(id), other.get(id));
      const deletedAt = tombs[kind][id];
      if (deletedAt !== undefined && changeTime(winner) <= deletedAt) continue;
      delete tombs[kind][id]; // changed after it was deleted elsewhere: keep it
      out.push(winner);
    }
    return { out, byId, other };
  };

  const books = mergeKind('notebooks', local.notebooks, remoteBooks);
  const bookIds = new Set(books.out.map((b) => b.id));
  const merged = mergeKind('notes', local.notes, remoteNotes);
  // A note whose notebook is gone stays, outside any notebook (on both devices alike).
  const notes = merged.out.map((n) => {
    if (!n.notebookId || bookIds.has(n.notebookId)) return n;
    const { notebookId, ...rest } = n;
    return rest;
  });

  const same = (a, b) => a && b && fingerprint(a) === fingerprint(b);
  const stats = { added: 0, updated: 0, removed: 0, sent: 0, conflicts: [] };
  const resultIds = new Set(notes.map((n) => n.id));
  for (const n of notes) {
    const mine = merged.byId.get(n.id);
    const theirs = merged.other.get(n.id);
    if (!mine) { if (isLive(n)) stats.added += 1; } else if (!same(mine, n)) {
      if (isLive(mine) && !isLive(n)) stats.removed += 1;
      else stats.updated += 1;
    }
    if (!same(theirs, n)) stats.sent += 1;
    // Changed on both devices since each last synced: one version had to lose.
    // (Not on a first sync: there's no "since" to compare with.)
    if (mine && theirs && !same(mine, theirs) && local.lastSyncAt > 0 && remote?.lastSyncAt > 0
      && changeTime(mine) > local.lastSyncAt && changeTime(theirs) > remote.lastSyncAt) {
      stats.conflicts.push({ id: n.id, title: n.title, keptMine: pick(mine, theirs) === mine, at: changeTime(n) });
    }
  }
  for (const n of local.notes) if (!resultIds.has(n.id) && isLive(n)) stats.removed += 1;

  return { notes, notebooks: books.out, tombstones: tombs, stats };
}
