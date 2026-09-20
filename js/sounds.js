/**
 * Sonidos propios para los dos efectos de la partida.
 *
 * El archivo que elige el narrador se guarda en IndexedDB (localStorage no da
 * para un audio de un minuto), así que sobrevive a recargas y sigue ahí sin
 * conexión. También vale una ruta o URL, útil si el audio se sube al repositorio
 * y se quiere tener en todas las tablets a la vez.
 */

const DB_NAME = 'botc-timer-sounds';
const STORE = 'files';
const urls = new Map();   // caché de object URLs por efecto

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transact(mode, run) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  }));
}

export async function saveSound(kind, file) {
  await transact('readwrite', (store) => store.put({ blob: file, name: file.name, type: file.type }, kind));
  revoke(kind);
  return { name: file.name };
}

export async function getSound(kind) {
  try {
    const record = await transact('readonly', (store) => store.get(kind));
    return record || null;
  } catch {
    return null;
  }
}

export async function clearSound(kind) {
  try { await transact('readwrite', (store) => store.delete(kind)); } catch { /* ignorado */ }
  revoke(kind);
}

/** URL reproducible del audio guardado, o cadena vacía si no hay ninguno. */
export async function soundUrl(kind) {
  if (urls.has(kind)) return urls.get(kind);
  const record = await getSound(kind);
  if (!record?.blob) return '';
  const url = URL.createObjectURL(record.blob);
  urls.set(kind, url);
  return url;
}

function revoke(kind) {
  const url = urls.get(kind);
  if (url) { URL.revokeObjectURL(url); urls.delete(kind); }
}
