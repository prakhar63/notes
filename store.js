// Notes persistence in localStorage. No DOM code here.

export const STORAGE_KEY = 'notes.v1';
const COLORS = ['paper', 'cornflower', 'chartreuse', 'peach', 'mint', 'pink'];

// Validates the core fields. Any other fields (pins, checklists, images in
// later versions) pass through untouched, so a reload never drops them.
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const now = Date.now();
  return {
    ...raw,
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    color: COLORS.includes(raw.color) ? raw.color : 'paper',
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
  };
}

const isBlank = (note) => !note.title.trim() && !note.body.trim();

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
const BACKUP_VERSION = 1;

/** The JSON text of a backup file holding all notes. */
export function backupJSON(notes) {
  return JSON.stringify({ app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: Date.now(), notes }, null, 2);
}

/**
 * Reads a backup file's text. Returns { notes } or { error } with a message
 * fit to show the user. Also accepts a bare array of notes.
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
  return { notes: notes.filter((n) => !isBlank(n)) };
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
