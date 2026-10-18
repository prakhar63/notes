// Images for notes, kept in IndexedDB: localStorage (where notes live) holds only ~5 MB,
// far too little for photos. A note stores just the image ids. No DOM code here,
// apart from the canvas used to shrink pictures.

const DB_NAME = 'notes-images';
const STORE = 'images';
const MAX_SIDE = 1600; // px: plenty for reading on any screen, ~200–400 KB per photo
const QUALITY = 0.85;

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(mode, fn) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    // A request's answer can legitimately be undefined (no such image): return it as-is.
    tx.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Shrinks a picked or pasted image to at most 1600px on its longer side, as JPEG. */
export async function prepareImage(file) {
  // createImageBitmap applies the photo's EXIF rotation, so phone pictures come out upright.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // JPEG has no transparency: put see-through parts on white
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) throw new Error('Could not encode image');
  return { blob, width, height };
}

/** Saves an image and returns its new id. */
export async function addImage({ blob, width, height }, id = crypto.randomUUID()) {
  await run('readwrite', (store) => store.put({ id, blob, width, height, createdAt: Date.now() }));
  return id;
}

/** The stored record { id, blob, width, height }, or undefined. */
export function getImage(id) {
  return run('readonly', (store) => store.get(id));
}

export function allImageIds() {
  return run('readonly', (store) => store.getAllKeys());
}

export function deleteImage(id) {
  return run('readwrite', (store) => store.delete(id));
}

/** Removes stored images that no note refers to any more (e.g. removed or in deleted notes). */
export async function cleanUpImages(usedIds) {
  const used = new Set(usedIds);
  const ids = await allImageIds();
  await Promise.all(ids.filter((id) => !used.has(id)).map(deleteImage));
}

// Backup files carry images as data: URLs.
export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function dataURLToBlob(url) {
  return (await fetch(url)).blob();
}
