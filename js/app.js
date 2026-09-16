/**
 * Clocktower Timer — temporizador por fases con bandas sonoras de Spotify
 * para dirigir partidas de Blood on the Clocktower desde una tablet.
 */

import { settings, save, resetAll } from './store.js';
import * as sch from './schedule.js';
import { createTimer, formatClock } from './timer.js';
import { gong, unlock as unlockAudio } from './audio.js';
import * as sp from './spotify.js';

/* ── Atajos al DOM ───────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const app = $('app');
const el = {
  clock: $('clock'),
  phaseLabel: $('phase-label'),
  phaseIcon: $('phase-icon'),
  progress: $('progress-bar'),
  nowPlaying: $('now-playing'),
  play: $('btn-play'),
  toast: $('toast'),
  spotifyStatus: $('spotify-status'),
  deviceStatus: $('device-status'),
  volume: $('volume'),
  volumeOut: $('volume-out'),
  music: $('btn-music'),
  scheduleBody: $('schedule-body'),
  playlistSelect: { night: $('playlist-night'), day: $('playlist-day') },
  playlistUri: { night: $('playlist-night-uri'), day: $('playlist-day-uri') },
};

/* ── Estado de la partida ────────────────────────────────── */
const game = {
  round: 1,
  phase: 'night',        // 'night' | 'day'
  musicPhase: null,      // fase cuya lista está sonando ahora mismo
  musicPaused: false,
  volume: settings.options.volumeNight,
};

/** Dónde se quedó cada lista, para poder retomarla. */
const playbackMemory = { night: null, day: null };

let wakeLock = null;
let audioUnlocked = false;

const timer = createTimer({ onTick: renderClock, onEnd: handleTimerEnd });

/* ── Arranque ────────────────────────────────────────────── */

init();

async function init() {
  $('redirect-uri').textContent = sp.redirectUri();
  bindUi();
  renderSettings();
  renderSchedule();
  enterPhase(1, 'night', { autoStart: false });

  try {
    if (await sp.completeLoginFromUrl() === 'connected') toast('Spotify conectado ✔');
  } catch (err) {
    toast(err.message, true);
  }

  if (sp.isConnected()) await onConnected();
  else setSpotifyStatus('Spotify: sin conectar', 'off');

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && timer.running) requestWakeLock();
  });
}

/* ── Fases ───────────────────────────────────────────────── */

function enterPhase(round, phase, { autoStart = settings.options.autoStart, music = true } = {}) {
  game.round = Math.max(1, round);
  game.phase = phase;
  app.dataset.phase = phase;

  el.phaseIcon.textContent = sch.phaseIcon[phase];
  el.phaseLabel.textContent = `${sch.phaseLabel[phase]} ${game.round}`;
  document.title = `${sch.phaseLabel[phase]} ${game.round} · Clocktower Timer`;

  game.volume = phase === 'night' ? settings.options.volumeNight : settings.options.volumeDay;
  el.volume.value = game.volume;
  el.volumeOut.textContent = game.volume;

  timer.set(sch.msFor(settings.schedule, game.round, phase), { autoStart });
  renderSchedule();
  if (autoStart) requestWakeLock();
  if (music) playPhaseMusic(phase).catch(showError);
}

function nextPhase() {
  if (game.phase === 'night') enterPhase(game.round, 'day');
  else enterPhase(game.round + 1, 'night');
}

function prevPhase() {
  if (game.phase === 'day') enterPhase(game.round, 'night');
  else if (game.round > 1) enterPhase(game.round - 1, 'day');
  else enterPhase(1, 'night');
}

function handleTimerEnd() {
  if (settings.options.alarm) gong();
  if (settings.options.autoAdvance) nextPhase();
  else renderClock({ remainingMs: 0, durationMs: timer.durationMs, running: false });
}

/* ── Pintado del reloj ───────────────────────────────────── */

function renderClock({ remainingMs, durationMs, running }) {
  el.clock.textContent = formatClock(remainingMs);

  const ratio = durationMs > 0 ? remainingMs / durationMs : 0;
  el.progress.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;

  const warning = settings.options.warningSeconds * 1000;
  el.clock.classList.toggle('is-warning', remainingMs > 0 && warning > 0 && remainingMs <= warning);
  el.clock.classList.toggle('is-over', remainingMs <= 0 && durationMs > 0);

  el.play.textContent = running ? '⏸ Pausa' : (remainingMs <= 0 ? '↺ Reiniciar' : '▶ Iniciar');
}

/* ── Música ──────────────────────────────────────────────── */

function activeDeviceId() {
  return settings.spotify.playbackTarget === 'remote'
    ? settings.spotify.remoteDeviceId
    : sp.getLocalDeviceId();
}

async function ensureDevice() {
  if (settings.spotify.playbackTarget === 'remote') {
    if (!settings.spotify.remoteDeviceId) throw new sp.SpotifyError('Elige un dispositivo de Spotify en Ajustes.');
    return settings.spotify.remoteDeviceId;
  }
  if (!sp.hasLocalPlayer()) {
    setSpotifyStatus('Spotify: iniciando reproductor…', 'muted');
    await sp.initPlayer({ volume: game.volume / 100 });
  }
  await sp.activateElement();
  const id = sp.getLocalDeviceId();
  if (!id) throw new sp.SpotifyError('El reproductor de esta tablet no está listo todavía.');
  return id;
}

/** Guarda por dónde iba la lista de una fase para poder retomarla luego. */
async function rememberPhase(phase) {
  if (!phase || !settings.options.resumePlaylist) return;
  const uri = settings.playlists[phase].uri;
  if (!uri) return;
  const state = await sp.getPlaybackState(activeDeviceId()).catch(() => null);
  if (state?.contextUri === uri && state.trackUri) {
    playbackMemory[phase] = { trackUri: state.trackUri, positionMs: state.positionMs };
  }
}

async function playPhaseMusic(phase) {
  if (!sp.isConnected()) return;

  const uri = settings.playlists[phase].uri;
  const fade = Number(settings.options.fadeSeconds) || 0;
  const target = phase === 'night' ? settings.options.volumeNight : settings.options.volumeDay;

  await rememberPhase(game.musicPhase);

  if (!uri) {                                   // fase sin lista: silencio
    if (game.musicPhase) {
      await sp.fadeVolume(game.volume, 0, fade, activeDeviceId());
      await sp.pause(activeDeviceId());
    }
    game.musicPhase = null;
    game.musicPaused = false;
    updateMusicButton();
    el.nowPlaying.textContent = '—';
    return;
  }

  const deviceId = await ensureDevice();

  if (game.musicPhase) await sp.fadeVolume(game.volume, 0, fade, deviceId);
  await sp.setVolume(0, deviceId);

  if (settings.options.shuffle) await sp.setShuffle(true, deviceId);

  const memory = settings.options.resumePlaylist ? playbackMemory[phase] : null;
  await sp.startContext({
    contextUri: uri,
    deviceId,
    offsetUri: memory?.trackUri || '',
    positionMs: memory?.positionMs || 0,
  });

  game.musicPhase = phase;
  game.musicPaused = false;
  game.volume = target;
  el.volume.value = target;
  el.volumeOut.textContent = target;
  updateMusicButton();
  await sp.fadeVolume(0, target, fade, deviceId);
}

async function toggleMusic() {
  if (!sp.isConnected()) return toast('Conecta primero con Spotify.', true);
  try {
    const deviceId = activeDeviceId();
    if (game.musicPaused || !game.musicPhase) {
      if (!game.musicPhase) { await playPhaseMusic(game.phase); return; }
      await sp.resume(deviceId);
      game.musicPaused = false;
    } else {
      await sp.pause(deviceId);
      game.musicPaused = true;
    }
    updateMusicButton();
  } catch (err) { showError(err); }
}

function updateMusicButton() {
  const playing = game.musicPhase && !game.musicPaused;
  el.music.textContent = playing ? '⏸ Música' : '▶ Música';
}

/* ── Spotify: conexión, listas y dispositivos ────────────── */

async function onConnected() {
  setSpotifyStatus('Spotify: conectado', 'on');
  try {
    const profile = await sp.getProfile();
    setSpotifyStatus(`Spotify: ${profile.display_name || profile.id}`, 'on');
    if (profile.product && profile.product !== 'premium') {
      toast('Tu cuenta no es Premium: Spotify no permite controlar la reproducción.', true);
    }
  } catch (err) {
    if (err.needsAuth) { setSpotifyStatus('Spotify: vuelve a conectar', 'error'); return; }
  }

  loadPlaylists().catch(showError);
  loadDevices().catch(() => {});

  sp.on('status', ({ kind, message, deviceId }) => {
    if (kind === 'ready') {
      el.deviceStatus.hidden = false;
      el.deviceStatus.textContent = 'Reproductor de la tablet listo';
      el.deviceStatus.dataset.deviceId = deviceId;
    } else if (kind === 'account_error') {
      showError(new Error('Spotify Premium es necesario para reproducir desde la tablet.'));
    } else if (message) {
      showError(new Error(message));
    }
  });

  sp.on('state', (state) => {
    game.musicPaused = state.paused;
    updateMusicButton();
    el.nowPlaying.textContent = state.trackName
      ? `${state.paused ? '⏸' : '♪'} ${state.trackName} — ${state.artists}`
      : '—';
  });

  if (settings.spotify.playbackTarget === 'this') {
    sp.initPlayer({ volume: game.volume / 100 }).catch(showError);
  }

  // El SDK solo avisa del reproductor local: con dispositivos remotos, sondeamos.
  setInterval(() => {
    if (settings.spotify.playbackTarget !== 'remote' || !sp.isConnected()) return;
    sp.getPlaybackState(activeDeviceId())
      .then((state) => {
        if (!state) return;
        game.musicPaused = state.paused;
        updateMusicButton();
        el.nowPlaying.textContent = state.trackName
          ? `${state.paused ? '⏸' : '♪'} ${state.trackName} — ${state.artists}`
          : '—';
      })
      .catch(() => {});
  }, 8000);
}

async function loadPlaylists() {
  const lists = await sp.getMyPlaylists();
  for (const phase of sch.PHASES) {
    const select = el.playlistSelect[phase];
    const current = settings.playlists[phase].uri;
    select.innerHTML = '<option value="">— Sin música —</option>';
    for (const list of lists) {
      const option = document.createElement('option');
      option.value = list.uri;
      option.textContent = list.owner ? `${list.name} · ${list.owner}` : list.name;
      select.append(option);
    }
    select.value = lists.some((l) => l.uri === current) ? current : '';
    el.playlistUri[phase].value = select.value ? '' : current;
  }
}

async function loadDevices() {
  const devices = await sp.getDevices();
  const select = $('device-select');
  select.innerHTML = '<option value="">— Elige dispositivo —</option>';
  for (const device of devices) {
    const option = document.createElement('option');
    option.value = device.id;
    option.textContent = `${device.name} (${device.type})${device.is_active ? ' · activo' : ''}`;
    select.append(option);
  }
  select.value = settings.spotify.remoteDeviceId || '';
}

/* ── Ajustes: pintado y enlaces ──────────────────────────── */

function renderSettings() {
  $('client-id').value = settings.spotify.clientId;
  $('playback-target').value = settings.spotify.playbackTarget;
  $('remote-device-row').hidden = settings.spotify.playbackTarget !== 'remote';

  for (const phase of sch.PHASES) {
    const uri = settings.playlists[phase].uri;
    const select = el.playlistSelect[phase];
    const inList = Boolean(uri) && [...select.options].some((o) => o.value === uri);
    select.value = inList ? uri : '';
    el.playlistUri[phase].value = inList ? '' : uri;
  }

  $('sch-start').value = settings.schedule.start;
  $('sch-step').value = settings.schedule.step;
  $('sch-min').value = settings.schedule.min;
  $('sch-rounds').value = settings.schedule.rounds;
  $('sch-apply').value = settings.schedule.applyTo;
  $('sch-fixed').value = settings.schedule.fixed;

  const o = settings.options;
  $('opt-autoadvance').checked = o.autoAdvance;
  $('opt-autostart').checked = o.autoStart;
  $('opt-alarm').checked = o.alarm;
  $('opt-keepawake').checked = o.keepAwake;
  $('opt-shuffle').checked = o.shuffle;
  $('opt-resume').checked = o.resumePlaylist;
  $('opt-warning').value = o.warningSeconds;
  $('opt-fade').value = o.fadeSeconds;
  $('opt-vol-night').value = o.volumeNight;
  $('opt-vol-day').value = o.volumeDay;
}

function renderSchedule() {
  const rounds = Math.max(1, Math.min(30, Number(settings.schedule.rounds) || 12));
  el.scheduleBody.innerHTML = '';

  for (let round = 1; round <= rounds; round += 1) {
    const tr = document.createElement('tr');
    if (round === game.round) tr.classList.add('is-current');

    const roundCell = document.createElement('td');
    roundCell.className = 'round-cell';
    roundCell.textContent = `#${round}`;
    tr.append(roundCell);

    for (const phase of sch.PHASES) {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '120';
      input.step = '0.5';
      input.value = String(sch.minutesFor(settings.schedule, round, phase));
      input.classList.toggle('is-override', sch.hasOverride(settings.schedule, round, phase));
      input.addEventListener('change', () => {
        const value = Number(input.value);
        sch.setOverride(settings.schedule, round, phase, Number.isFinite(value) ? value : null);
        save();
        syncCurrentPhaseDuration(round, phase);
        renderSchedule();
      });
      td.append(input);
      tr.append(td);
    }

    const actions = document.createElement('td');
    const reset = document.createElement('button');
    reset.className = 'mini-btn';
    reset.textContent = '↺';
    reset.title = 'Volver al valor automático';
    reset.addEventListener('click', () => {
      for (const phase of sch.PHASES) sch.setOverride(settings.schedule, round, phase, null);
      save();
      syncCurrentPhaseDuration(round, 'night');
      syncCurrentPhaseDuration(round, 'day');
      renderSchedule();
    });
    actions.append(reset);
    tr.append(actions);

    el.scheduleBody.append(tr);
  }
}

/** Si se edita la fase que está en pantalla y el reloj no corre, recárgala. */
function syncCurrentPhaseDuration(round, phase) {
  if (round === game.round && phase === game.phase && !timer.running) {
    timer.set(sch.msFor(settings.schedule, round, phase), { autoStart: false });
  }
}

function bindUi() {
  /* Controles principales */
  el.play.addEventListener('click', () => {
    unlockOnce();
    if (timer.remainingMs <= 0 && !timer.running) timer.reset({ autoStart: true });
    else timer.toggle();
    if (timer.running) requestWakeLock();
    renderClock({ remainingMs: timer.remainingMs, durationMs: timer.durationMs, running: timer.running });
  });
  $('btn-plus').addEventListener('click', () => timer.adjust(60_000));
  $('btn-minus').addEventListener('click', () => timer.adjust(-60_000));
  $('btn-reset').addEventListener('click', () => timer.reset({ autoStart: false }));
  $('btn-next').addEventListener('click', () => { unlockOnce(); nextPhase(); });
  $('btn-prev').addEventListener('click', () => { unlockOnce(); prevPhase(); });
  $('btn-music').addEventListener('click', () => { unlockOnce(); toggleMusic(); });
  $('btn-skip-track').addEventListener('click', () => sp.nextTrack(activeDeviceId()).catch(showError));

  el.volume.addEventListener('input', () => {
    game.volume = Number(el.volume.value);
    el.volumeOut.textContent = game.volume;
    if (game.phase === 'night') settings.options.volumeNight = game.volume;
    else settings.options.volumeDay = game.volume;
    save();
    $('opt-vol-night').value = settings.options.volumeNight;
    $('opt-vol-day').value = settings.options.volumeDay;
    sp.setVolume(game.volume, activeDeviceId());
  });

  $('btn-fullscreen').addEventListener('click', toggleFullscreen);

  /* Cajón de ajustes */
  $('btn-settings').addEventListener('click', () => openDrawer(true));
  $('btn-close-settings').addEventListener('click', () => openDrawer(false));
  $('scrim').addEventListener('click', () => openDrawer(false));

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      document.querySelectorAll('.tab-panel').forEach((p) => {
        p.classList.toggle('is-active', p.dataset.panel === tab.dataset.tab);
      });
    });
  }

  /* Spotify */
  $('client-id').addEventListener('change', (e) => {
    settings.spotify.clientId = e.target.value.trim();
    save();
  });
  $('btn-copy-redirect').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(sp.redirectUri());
      toast('URL copiada');
    } catch { toast(sp.redirectUri()); }
  });
  $('btn-connect').addEventListener('click', async () => {
    settings.spotify.clientId = $('client-id').value.trim();
    save();
    try { await sp.beginLogin(settings.spotify.clientId); } catch (err) { showError(err); }
  });
  $('btn-disconnect').addEventListener('click', () => {
    sp.logout();
    setSpotifyStatus('Spotify: sin conectar', 'off');
    el.deviceStatus.hidden = true;
    toast('Sesión de Spotify cerrada');
  });

  $('playback-target').addEventListener('change', (e) => {
    settings.spotify.playbackTarget = e.target.value;
    save();
    $('remote-device-row').hidden = e.target.value !== 'remote';
    if (e.target.value === 'remote') loadDevices().catch(showError);
    else if (sp.isConnected()) sp.initPlayer({ volume: game.volume / 100 }).catch(showError);
  });
  $('device-select').addEventListener('change', (e) => {
    settings.spotify.remoteDeviceId = e.target.value;
    save();
  });
  $('btn-refresh-devices').addEventListener('click', () => loadDevices().catch(showError));
  $('btn-reload-playlists').addEventListener('click', () => loadPlaylists().catch(showError));

  for (const phase of sch.PHASES) {
    el.playlistSelect[phase].addEventListener('change', (e) => {
      settings.playlists[phase] = {
        uri: e.target.value,
        name: e.target.selectedOptions[0]?.textContent || '',
      };
      el.playlistUri[phase].value = '';
      playbackMemory[phase] = null;
      save();
    });
    el.playlistUri[phase].addEventListener('change', (e) => {
      const raw = e.target.value.trim();
      const uri = sp.toContextUri(raw);
      if (raw && !uri) return showError(new Error('Ese enlace de Spotify no es válido.'));
      settings.playlists[phase] = { uri, name: uri };
      el.playlistSelect[phase].value = '';
      playbackMemory[phase] = null;
      save();
      if (uri) toast(`Lista de ${sch.phaseLabel[phase].toLowerCase()} guardada`);
    });
  }

  for (const button of document.querySelectorAll('.btn-preview')) {
    button.addEventListener('click', () => {
      unlockOnce();
      playPhaseMusic(button.dataset.phase).catch(showError);
    });
  }

  /* Temporizadores */
  const scheduleInputs = {
    'sch-start': 'start', 'sch-step': 'step', 'sch-min': 'min',
    'sch-rounds': 'rounds', 'sch-fixed': 'fixed',
  };
  for (const [id, key] of Object.entries(scheduleInputs)) {
    $(id).addEventListener('change', (e) => {
      const value = Number(e.target.value);
      settings.schedule[key] = Number.isFinite(value) ? value : settings.schedule[key];
      save();
      renderSchedule();
      syncCurrentPhaseDuration(game.round, game.phase);
    });
  }
  $('sch-apply').addEventListener('change', (e) => {
    settings.schedule.applyTo = e.target.value;
    save();
    renderSchedule();
    syncCurrentPhaseDuration(game.round, game.phase);
  });
  $('btn-apply-schedule').addEventListener('click', () => {
    sch.clearOverrides(settings.schedule);
    save();
    renderSchedule();
    syncCurrentPhaseDuration(game.round, game.phase);
    toast('Progresión aplicada a todas las rondas');
  });
  $('btn-clear-overrides').addEventListener('click', () => {
    sch.clearOverrides(settings.schedule);
    save();
    renderSchedule();
    syncCurrentPhaseDuration(game.round, game.phase);
  });

  /* Opciones */
  const checks = {
    'opt-autoadvance': 'autoAdvance', 'opt-autostart': 'autoStart', 'opt-alarm': 'alarm',
    'opt-keepawake': 'keepAwake', 'opt-shuffle': 'shuffle', 'opt-resume': 'resumePlaylist',
  };
  for (const [id, key] of Object.entries(checks)) {
    $(id).addEventListener('change', (e) => {
      settings.options[key] = e.target.checked;
      save();
      if (key === 'keepAwake') e.target.checked ? requestWakeLock() : releaseWakeLock();
    });
  }
  const numbers = {
    'opt-warning': 'warningSeconds', 'opt-fade': 'fadeSeconds',
    'opt-vol-night': 'volumeNight', 'opt-vol-day': 'volumeDay',
  };
  for (const [id, key] of Object.entries(numbers)) {
    $(id).addEventListener('change', (e) => {
      const value = Number(e.target.value);
      if (Number.isFinite(value)) { settings.options[key] = value; save(); }
    });
  }

  $('btn-new-game').addEventListener('click', () => {
    openDrawer(false);
    playbackMemory.night = null;
    playbackMemory.day = null;
    enterPhase(1, 'night', { autoStart: false });
    toast('Partida reiniciada');
  });
  $('btn-reset-all').addEventListener('click', () => {
    if (!confirm('¿Borrar toda la configuración guardada?')) return;
    resetAll();
    renderSettings();
    renderSchedule();
    enterPhase(1, 'night', { autoStart: false, music: false });
    toast('Configuración borrada');
  });

  /* Teclado (útil con teclado bluetooth o en portátil) */
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    const keys = {
      ' ': () => el.play.click(),
      ArrowRight: nextPhase,
      ArrowLeft: prevPhase,
      r: () => timer.reset({ autoStart: false }),
      R: () => timer.reset({ autoStart: false }),
      f: toggleFullscreen,
      F: toggleFullscreen,
    };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
  });

  document.addEventListener('pointerdown', unlockOnce, { once: true });
}

function openDrawer(open) {
  $('drawer').hidden = !open;
  $('scrim').hidden = !open;
  if (open) { renderSettings(); renderSchedule(); }
}

/* ── Utilidades ──────────────────────────────────────────── */

function unlockOnce() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  unlockAudio();
  sp.activateElement();
}

function setSpotifyStatus(text, kind) {
  el.spotifyStatus.textContent = text;
  el.spotifyStatus.className = `pill pill-${kind}`;
}

let toastHandle = null;
function toast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('is-error', isError);
  el.toast.hidden = false;
  clearTimeout(toastHandle);
  toastHandle = setTimeout(() => { el.toast.hidden = true; }, isError ? 7000 : 3000);
}

function showError(err) {
  console.error(err);
  toast(err?.message || 'Algo ha fallado', true);
  if (err?.needsAuth) setSpotifyStatus('Spotify: vuelve a conectar', 'error');
}

async function requestWakeLock() {
  if (!settings.options.keepAwake || wakeLock || !navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* el navegador puede denegarlo */ }
}

function releaseWakeLock() {
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
