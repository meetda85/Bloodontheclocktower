/**
 * Integración con Spotify:
 *   · Login OAuth con PKCE (no hace falta servidor ni client secret).
 *   · Llamadas a la Web API con refresco automático del token.
 *   · Reproductor integrado (Web Playback SDK) o cualquier otro dispositivo Spotify.
 *   · Cambios de lista con fundido de volumen.
 *
 * Controlar la reproducción requiere cuenta Spotify Premium.
 */

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const TOKEN_KEY = 'botc-timer.spotify.token.v1';
const PKCE_KEY = 'botc-timer.spotify.pkce.v1';

const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
];

export class SpotifyError extends Error {
  constructor(message, { status = 0, needsAuth = false } = {}) {
    super(message);
    this.status = status;
    this.needsAuth = needsAuth;
  }
}

/* ── Tokens ──────────────────────────────────────────────── */

let token = readToken();

function readToken() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch { return null; }
}

function writeToken(value) {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, JSON.stringify(value));
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignorado */ }
}

export function isConnected() { return Boolean(token?.refresh_token || token?.access_token); }

export function logout() {
  writeToken(null);
  disconnectPlayer();
}

/* ── Login con PKCE ──────────────────────────────────────── */

export function redirectUri() {
  // Spotify exige que coincida carácter a carácter con la del dashboard.
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function base64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function beginLogin(clientId) {
  if (!clientId) throw new SpotifyError('Falta el Client ID de Spotify.');
  if (!crypto?.subtle) {
    throw new SpotifyError('El login necesita una conexión segura (https:// o http://127.0.0.1).');
  }

  const verifier = randomString(96);
  const state = randomString(16);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));

  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, clientId }));
  localStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, clientId }));

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: base64url(digest),
    state,
    scope: SCOPES.join(' '),
  });
  window.location.assign(`${AUTH_URL}?${params}`);
}

/**
 * Se llama al arrancar: si volvemos del login de Spotify, canjea el código.
 * Devuelve 'connected', 'none' o lanza SpotifyError.
 */
export async function completeLoginFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');
  const state = params.get('state');
  if (!code && !error) return 'none';

  cleanUrl();

  const pending = readPkce();
  sessionStorage.removeItem(PKCE_KEY);
  localStorage.removeItem(PKCE_KEY);

  if (error) throw new SpotifyError(`Spotify rechazó el acceso: ${error}`);
  if (!pending) throw new SpotifyError('La sesión de login caducó. Inténtalo otra vez.');
  if (pending.state !== state) throw new SpotifyError('Respuesta de login inválida (state).');

  const body = new URLSearchParams({
    client_id: pending.clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: pending.verifier,
  });
  const data = await tokenRequest(body);
  writeToken({ ...data, client_id: pending.clientId, expires_at: Date.now() + data.expires_in * 1000 });
  return 'connected';
}

function readPkce() {
  for (const store of [sessionStorage, localStorage]) {
    try {
      const raw = store.getItem(PKCE_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignorado */ }
  }
  return null;
}

function cleanUrl() {
  const url = new URL(window.location.href);
  url.search = '';
  window.history.replaceState({}, '', url.toString());
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new SpotifyError(data.error_description || 'No se pudo obtener el token de Spotify.', {
      status: res.status,
      needsAuth: true,
    });
  }
  return data;
}

async function accessToken() {
  if (!token) throw new SpotifyError('Conecta primero con Spotify.', { needsAuth: true });
  if (token.access_token && Date.now() < token.expires_at - 30_000) return token.access_token;
  if (!token.refresh_token) throw new SpotifyError('La sesión de Spotify caducó.', { needsAuth: true });

  const data = await tokenRequest(new URLSearchParams({
    client_id: token.client_id,
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
  }));
  writeToken({
    ...token,
    ...data,
    refresh_token: data.refresh_token || token.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  });
  return token.access_token;
}

/* ── Web API ─────────────────────────────────────────────── */

async function api(path, { method = 'GET', body, query, retry = true } = {}) {
  const url = new URL(path.startsWith('http') ? path : API + path);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204 || res.status === 202) return null;
  if (res.status === 429 && retry) {
    const wait = Number(res.headers.get('Retry-After') || 1);
    await new Promise((r) => setTimeout(r, Math.min(wait, 5) * 1000));
    return api(path, { method, body, query, retry: false });
  }

  const data = await res.json().catch(() => null);
  if (res.ok) return data;

  const message = data?.error?.message || `Error de Spotify (${res.status})`;
  if (res.status === 401) { writeToken(null); throw new SpotifyError('Sesión caducada, vuelve a conectar.', { status: 401, needsAuth: true }); }
  if (res.status === 403) throw new SpotifyError(`${message} — recuerda que controlar la reproducción requiere Spotify Premium.`, { status: 403 });
  if (res.status === 404) throw new SpotifyError('No hay ningún dispositivo de Spotify activo donde reproducir.', { status: 404 });
  throw new SpotifyError(message, { status: res.status });
}

export async function getProfile() { return api('/me'); }

export async function getDevices() {
  const data = await api('/me/player/devices');
  return data?.devices || [];
}

/** Todas las listas del usuario (paginando). */
export async function getMyPlaylists() {
  const items = [];
  let next = '/me/playlists?limit=50';
  while (next && items.length < 400) {
    const page = await api(next);
    items.push(...(page?.items || []).filter(Boolean));
    next = page?.next || null;
  }
  return items.map((p) => ({ uri: p.uri, name: p.name, owner: p.owner?.display_name || '' }));
}

/* ── Reproductor integrado (Web Playback SDK) ────────────── */

let player = null;
let localDeviceId = '';
let sdkReady = null;
const listeners = { state: [], status: [] };

export function on(event, fn) { listeners[event]?.push(fn); }
function emit(event, payload) { listeners[event]?.forEach((fn) => fn(payload)); }

function whenSdkReady() {
  if (sdkReady) return sdkReady;
  sdkReady = new Promise((resolve) => {
    if (window.Spotify) return resolve();
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
  });
  return sdkReady;
}

export async function initPlayer({ volume = 0.5, name = 'Clocktower Timer' } = {}) {
  if (player) return localDeviceId;
  await whenSdkReady();
  if (!window.Spotify) throw new SpotifyError('No se pudo cargar el reproductor de Spotify.');

  player = new window.Spotify.Player({
    name,
    volume,
    getOAuthToken: (cb) => { accessToken().then(cb).catch(() => cb('')); },
  });

  player.addListener('ready', ({ device_id }) => {
    localDeviceId = device_id;
    emit('status', { kind: 'ready', deviceId: device_id });
  });
  player.addListener('not_ready', () => {
    localDeviceId = '';
    emit('status', { kind: 'not_ready' });
  });
  player.addListener('player_state_changed', (state) => {
    if (!state) return;
    const track = state.track_window?.current_track;
    emit('state', {
      paused: state.paused,
      trackName: track?.name || '',
      artists: (track?.artists || []).map((a) => a.name).join(', '),
      contextUri: state.context?.uri || '',
      trackUri: track?.uri || '',
      positionMs: state.position || 0,
    });
  });
  for (const kind of ['initialization_error', 'authentication_error', 'account_error', 'playback_error']) {
    player.addListener(kind, ({ message }) => emit('status', { kind, message }));
  }

  const ok = await player.connect();
  if (!ok) throw new SpotifyError('El navegador no pudo iniciar el reproductor de Spotify.');

  // El evento "ready" llega de forma asíncrona.
  await new Promise((resolve) => {
    if (localDeviceId) return resolve();
    const started = Date.now();
    const poll = setInterval(() => {
      if (localDeviceId || Date.now() - started > 10_000) { clearInterval(poll); resolve(); }
    }, 150);
  });
  return localDeviceId;
}

export function disconnectPlayer() {
  try { player?.disconnect(); } catch { /* ignorado */ }
  player = null;
  localDeviceId = '';
}

export function getLocalDeviceId() { return localDeviceId; }
export function hasLocalPlayer() { return Boolean(player && localDeviceId); }

/** Activa el elemento de audio en móviles/tablets: exige gesto del usuario. */
export async function activateElement() {
  try { await player?.activateElement(); } catch { /* ignorado */ }
}

/* ── Reproducción ────────────────────────────────────────── */

/** Acepta URI (spotify:playlist:…) o enlace (https://open.spotify.com/playlist/…). */
export function toContextUri(input) {
  const text = (input || '').trim();
  if (!text) return '';
  if (text.startsWith('spotify:')) return text.split('?')[0];
  try {
    const url = new URL(text);
    if (!url.hostname.endsWith('spotify.com')) return '';
    const parts = url.pathname.split('/').filter(Boolean);
    // /intl-es/playlist/<id>
    const typeIndex = parts.findIndex((p) => ['playlist', 'album', 'artist', 'show'].includes(p));
    if (typeIndex === -1 || !parts[typeIndex + 1]) return '';
    return `spotify:${parts[typeIndex]}:${parts[typeIndex + 1]}`;
  } catch {
    return '';
  }
}

function isLocal(deviceId) {
  return Boolean(localDeviceId) && (!deviceId || deviceId === localDeviceId);
}

export async function setVolume(percent, deviceId) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  if (isLocal(deviceId) && player) {
    await player.setVolume(clamped / 100).catch(() => {});
    return;
  }
  await api('/me/player/volume', { method: 'PUT', query: { volume_percent: clamped, device_id: deviceId } })
    .catch(() => { /* algunos dispositivos no permiten cambiar el volumen remoto */ });
}

/** Fundido lineal de volumen. Con dispositivos remotos usa pasos largos (límite de peticiones). */
export async function fadeVolume(from, to, seconds, deviceId) {
  const local = isLocal(deviceId);
  const stepMs = local ? 60 : 350;
  const steps = Math.max(1, Math.round((seconds * 1000) / stepMs));
  if (seconds <= 0) { await setVolume(to, deviceId); return; }
  for (let i = 1; i <= steps; i += 1) {
    await setVolume(from + ((to - from) * i) / steps, deviceId);
    if (i < steps) await new Promise((r) => setTimeout(r, stepMs));
  }
}

export async function transferTo(deviceId, { play = false } = {}) {
  if (!deviceId) return;
  await api('/me/player', { method: 'PUT', body: { device_ids: [deviceId], play } });
}

export async function setShuffle(state, deviceId) {
  await api('/me/player/shuffle', { method: 'PUT', query: { state: String(Boolean(state)), device_id: deviceId } })
    .catch(() => { /* no todos los contextos admiten aleatorio */ });
}

export async function startContext({ contextUri, deviceId, offsetUri = '', positionMs = 0 }) {
  const body = { context_uri: contextUri };
  if (offsetUri) body.offset = { uri: offsetUri };
  if (positionMs) body.position_ms = Math.max(0, Math.round(positionMs));
  await api('/me/player/play', { method: 'PUT', query: { device_id: deviceId }, body });
}

export async function resume(deviceId) {
  await api('/me/player/play', { method: 'PUT', query: { device_id: deviceId } });
}

export async function pause(deviceId) {
  await api('/me/player/pause', { method: 'PUT', query: { device_id: deviceId } })
    .catch((err) => { if (err.status !== 403 && err.status !== 404) throw err; });
}

export async function nextTrack(deviceId) {
  await api('/me/player/next', { method: 'POST', query: { device_id: deviceId } });
}

/** Estado actual de reproducción (del reproductor local si lo hay, si no del remoto). */
export async function getPlaybackState(deviceId) {
  if (isLocal(deviceId) && player) {
    const state = await player.getCurrentState().catch(() => null);
    if (!state) return null;
    return {
      paused: state.paused,
      contextUri: state.context?.uri || '',
      trackUri: state.track_window?.current_track?.uri || '',
      positionMs: state.position || 0,
      trackName: state.track_window?.current_track?.name || '',
      artists: (state.track_window?.current_track?.artists || []).map((a) => a.name).join(', '),
    };
  }
  const data = await api('/me/player').catch(() => null);
  if (!data) return null;
  return {
    paused: !data.is_playing,
    contextUri: data.context?.uri || '',
    trackUri: data.item?.uri || '',
    positionMs: data.progress_ms || 0,
    trackName: data.item?.name || '',
    artists: (data.item?.artists || []).map((a) => a.name).join(', '),
  };
}
