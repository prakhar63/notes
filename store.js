// Notes persistence in localStorage. No DOM code here.

export const STORAGE_KEY = 'notes.v1';
const COLORS = ['paper', 'cornflower', 'chartreuse', 'peach', 'mint', 'pink'];

// Validates the core fields. Any other fields (pins, checklists, images in
// later versions) pass through untouched, so a reload never drops them.
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const now = Date.now();
  const note = {
    ...raw,
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    color: COLORS.includes(raw.color) ? raw.color : 'paper',
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
  };
  // Checklist notes keep their items as [{ id, text, done }].
  if (raw.kind === 'checklist') {
    note.items = (Array.isArray(raw.items) ? raw.items : [])
      .filter((it) => it && typeof it === 'object')
      .map((it, i) => ({
        id: typeof it.id === 'string' ? it.id : `${raw.id}-${i}`,
        text: typeof it.text === 'string' ? it.text : '',
        done: it.done === true,
      }));
  } else {
    delete note.kind;
    delete note.items;
  }
  // Images: a list of ids; the pictures themselves live in IndexedDB (images.js).
  if (Array.isArray(raw.images)) note.images = raw.images.filter((id) => typeof id === 'string');
  else delete note.images;
  return note;
}

const isBlank = (note) =>
  !note.title.trim() && !note.body.trim() && !(note.items ?? []).some((it) => it.text.trim())
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

// ---------- Backup files ----------

const BACKUP_APP = 'notes';
const BACKUP_VERSION = 2; // 2 adds `images`: { id: data URL }

/** The JSON text of a backup file holding all notes and, optionally, their images. */
export function backupJSON(notes, images = {}) {
  return JSON.stringify({ app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: Date.now(), notes, images }, null, 2);
}

/**
 * Reads a backup file's text. Returns { notes, images } or { error } with a message
 * fit to show the user. Also accepts a bare array of notes (and version 1 files).
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
  return { notes: notes.filter((n) => !isBlank(n)), images };
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
