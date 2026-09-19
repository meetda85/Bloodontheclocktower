/**
 * Configuración persistente de la aplicación (localStorage).
 * Todo lo que el narrador ajusta en el cajón de "Ajustes" vive aquí.
 */

const KEY = 'botc-timer.settings.v1';

export const defaults = {
  spotify: {
    // Client ID de la app de Spotify del repositorio. En el flujo PKCE no es un
    // secreto (viaja en la URL de login) y solo funciona desde las Redirect URIs
    // registradas en el panel de Spotify. Se puede cambiar desde Ajustes.
    clientId: '4802fa4cf6634a2a9be42e96e04e68b0',
    playbackTarget: 'this',   // 'this' = reproductor integrado | 'remote' = otro dispositivo
    remoteDeviceId: '',
  },
  playlists: {
    night: { uri: '', name: '' },
    day: { uri: '', name: '' },
  },
  schedule: {
    start: 10,       // minutos de la primera ronda
    step: 2,         // minutos que baja en cada ronda
    min: 6,          // suelo: nunca baja de aquí
    rounds: 12,      // rondas listadas en la tabla
    applyTo: 'night',// 'night' | 'day' | 'both' — a qué fase se aplica la progresión
    fixed: 5,        // duración de la fase que no sigue la progresión
    overrides: {},   // { "2": { night: 20, day: 7 } } — valores fijados a mano
  },
  options: {
    autoAdvance: true,     // al llegar a 0, pasa solo a la fase siguiente
    autoStart: true,       // arranca el reloj al entrar en una fase
    alarm: true,           // campanada final
    keepAwake: true,       // Screen Wake Lock
    shuffle: true,
    resumePlaylist: true,  // continuar la lista donde se quedó
    warningSeconds: 60,
    fadeSeconds: 3,
    volumeNight: 45,
    volumeDay: 60,
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Mezcla profunda de los valores guardados sobre los valores por defecto.
 * Solo se aceptan claves conocidas, salvo en los diccionarios abiertos
 * (un objeto vacío por defecto, como `overrides`), que se copian enteros.
 */
function merge(base, saved) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(saved)) return out;
  for (const [key, value] of Object.entries(saved)) {
    if (!(key in base)) continue;
    if (isPlainObject(base[key]) && isPlainObject(value)) {
      out[key] = Object.keys(base[key]).length === 0
        ? structuredClone(value)
        : merge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function read() {
  let value;
  try {
    const raw = localStorage.getItem(KEY);
    value = raw ? merge(defaults, JSON.parse(raw)) : structuredClone(defaults);
  } catch {
    value = structuredClone(defaults);
  }
  // Si se guardó antes de que hubiera Client ID por defecto, lo recuperamos.
  if (!value.spotify.clientId) value.spotify.clientId = defaults.spotify.clientId;
  return value;
}

export const settings = read();

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* modo privado o almacenamiento lleno: seguimos en memoria */
  }
}

export function resetAll() {
  try { localStorage.removeItem(KEY); } catch { /* ignorado */ }
  Object.assign(settings, structuredClone(defaults));
}
