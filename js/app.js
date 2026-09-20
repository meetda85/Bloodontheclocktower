/**
 * Clocktower Timer — reloj y banda sonora para dirigir partidas de
 * Blood on the Clocktower desde una tablet.
 *
 * El ciclo de juego tiene cuatro pasos:
 *   1. NOCHE      — sin cuenta atrás: suena la lista nocturna mientras el
 *                   narrador despierta a los personajes. La cierra él.
 *   2. AMANECE    — golpe siniestro, entra la lista del día subiendo poco a
 *                   poco (15 s) mientras se cuenta lo que ha pasado.
 *   3. DÍA        — al pulsar, la música salta al 100 % y corre el reloj.
 *   4. al acabar  — la música se apaga y se pausa 3 s antes del cero, suenan
 *                   tres campanadas graves y cae la noche siguiente.
 */

import { settings, save, resetAll } from './store.js';
import * as sch from './schedule.js';
import { createTimer, formatClock } from './timer.js';
import { playEffect, stopEffect, unlock as unlockAudio } from './audio.js';
import { saveSound, clearSound, getSound } from './sounds.js';
import * as sp from './spotify.js';

/* ── Atajos al DOM ───────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const app = $('app');
const el = {
  clock: $('clock'),
  caption: $('clock-caption'),
  phaseLabel: $('phase-label'),
  phaseIcon: $('phase-icon'),
  progress: $('progress-bar'),
  nowPlaying: $('now-playing'),
  play: $('btn-play'),
  stage: $('btn-stage'),
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
  step: 'night',         // 'night' | 'night-timed' | 'dawn' | 'day'
  musicPhase: null,      // fase cuya lista está sonando ahora mismo
  musicPaused: false,
  volume: settings.options.volumeNight,
  endFadeDone: false,     // el silencio previo al cero solo se lanza una vez
  seq: 0,                 // cada cambio de paso invalida lo que quedara en vuelo
};

/** Dónde se quedó cada lista, para poder retomarla. */
const playbackMemory = { night: null, day: null };

let wakeLock = null;
let audioUnlocked = false;

const timer = createTimer({ onTick: renderClock, onEnd: handleTimerEnd });

const phaseOf = (step) => (step === 'day' ? 'day' : 'night');
const isNight = (step) => step === 'night' || step === 'night-timed';

/* ── Arranque ────────────────────────────────────────────── */

async function init() {
  $('redirect-uri').textContent = sp.redirectUri();
  bindUi();
  renderSettings();
  renderSchedule();
  enterNight(1, { autoStart: false, music: false });

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

/* ── Pasos del ciclo ─────────────────────────────────────── */

function enterNight(round, { autoStart = true, music = true } = {}) {
  game.round = Math.max(1, round);
  game.step = settings.options.untimedNight ? 'night' : 'night-timed';
  game.seq += 1;

  if (settings.options.untimedNight) {
    timer.setStopwatch({ autoStart });
  } else {
    timer.setCountdown(sch.msFor(settings.schedule, game.round, 'night'), {
      autoStart: autoStart && settings.options.autoStart,
    });
  }

  renderStep();
  if (autoStart) requestWakeLock();
  if (music) playPhaseMusic('night').catch(showError);
}

/** Primera pulsación de la noche: arranca cronómetro y música. */
function startNight() {
  timer.start();
  requestWakeLock();
  playPhaseMusic('night').catch(showError);
}

/**
 * Se acabó la noche: golpe siniestro y, acto seguido, entra la lista del día
 * subiendo poco a poco mientras el narrador cuenta lo que ha pasado.
 */
function enterDawn({ effect = true } = {}) {
  timer.pause();
  game.step = 'dawn';
  game.seq += 1;
  renderStep();
  runDawn(game.seq, effect).catch(showError);
}

async function runDawn(seq, effect) {
  // La música nocturna se va primero: el efecto tiene que oírse limpio.
  await stopMusic(1);
  if (seq !== game.seq) return;

  if (effect && settings.options.nightEffect) {
    unlockOnce();
    await playEffect('night', { url: settings.sounds.night.url });
    if (seq !== game.seq) return;
  }
  // Y ahora sí, el día entra desde cero y va subiendo.
  await playPhaseMusic('day', { fadeIn: Number(settings.options.dayRiseSeconds) || 0 });
}

/** Arranca el reloj del día y sube la música del todo, sin esperar al fundido. */
function enterDay(round) {
  game.round = Math.max(1, round);
  game.step = 'day';
  game.endFadeDone = false;
  game.seq += 1;
  timer.setCountdown(sch.msFor(settings.schedule, game.round, 'day'), { autoStart: true });
  renderStep();
  requestWakeLock();

  if (game.musicPhase === 'day' && !game.musicPaused) {
    // La lista ya venía sonando desde el amanecer: solo hay que abrir el grifo.
    const volume = settings.options.volumeDay;
    setVolumeUi(volume);
    sp.setVolume(volume, activeDeviceId()).catch(() => {});
  } else {
    playPhaseMusic('day').catch(showError);
  }
}

function handleTimerEnd() {
  if (game.step === 'day') runDayEnd(game.round + 1).catch(showError);
  else if (game.step === 'night-timed') enterDawn();
}

/**
 * Cierre del día: silencio, campanadas enteras y, cuando acaban, la noche.
 * La pantalla pasa a la noche enseguida; solo la música espera al sonido.
 */
async function runDayEnd(nextRound) {
  await stopMusic(0.4);

  const sound = settings.options.dayBells
    ? playEffect('dayEnd', { url: settings.sounds.dayEnd.url })
    : Promise.resolve();

  const advance = settings.options.autoAdvance;
  if (advance) enterNight(nextRound, { music: false });

  const seq = game.seq;
  await sound;
  if (seq !== game.seq || !advance) return;
  await playPhaseMusic('night');
}

/** Apaga y pausa lo que esté sonando, recordando por dónde iba. */
async function stopMusic(seconds) {
  if (!game.musicPhase || game.musicPaused) return;
  await rememberPhase(game.musicPhase);
  const deviceId = activeDeviceId();
  await sp.fadeVolume(game.volume, 0, seconds, deviceId);
  await sp.pause(deviceId);
  game.musicPaused = true;
  updateMusicButton();
}

/** Unos segundos antes del cero: la música se apaga y se pausa. */
function silenceBeforeDayEnd(seconds) {
  stopMusic(seconds).catch(() => { /* si falla, el reloj sigue su curso */ });
}

function nextStep() {
  if (isNight(game.step)) enterDawn();
  else if (game.step === 'dawn') enterDay(game.round);
  else enterNight(game.round + 1);
}

function prevStep() {
  if (game.step === 'dawn') enterNight(game.round);
  else if (game.step === 'day') enterNight(game.round);
  else if (game.round > 1) enterDay(game.round - 1);
  else enterNight(1, { autoStart: false, music: false });
}

/** El botón grande hace lo que toque en cada paso. */
function onPrimary() {
  unlockOnce();
  stopEffect();
  switch (game.step) {
    case 'night':
      if (timer.running) enterDawn();
      else startNight();
      break;
    case 'night-timed':
      if (timer.value <= 0) enterDawn();
      else timer.toggle();
      break;
    case 'dawn':
      enterDay(game.round);
      break;
    default:
      if (timer.value <= 0 && !timer.running) timer.reset({ autoStart: true });
      else timer.toggle();
      if (timer.running) requestWakeLock();
  }
  renderClock({ mode: timer.mode, value: timer.value, durationMs: timer.durationMs, running: timer.running });
}

/* ── Pintado ─────────────────────────────────────────────── */

const stepInfo = {
  'night': { phase: 'night', icon: '🌙', caption: 'la noche corre · ciérrala cuando termines' },
  'night-timed': { phase: 'night', icon: '🌙', caption: '' },
  'dawn': { phase: 'dawn', icon: '🌅', caption: 'cuenta lo que ha pasado esta noche' },
  'day': { phase: 'day', icon: '☀️', caption: '' },
};

function renderStep() {
  const info = stepInfo[game.step];
  app.dataset.step = game.step;
  app.dataset.phase = info.phase;
  el.phaseIcon.textContent = info.icon;
  el.phaseLabel.textContent = game.step === 'dawn'
    ? `Amanece · noche ${game.round}`
    : `${sch.phaseLabel[phaseOf(game.step)]} ${game.round}`;
  el.caption.textContent = info.caption;
  document.title = `${el.phaseLabel.textContent} · Clocktower Timer`;

  const volume = phaseOf(game.step) === 'night' ? settings.options.volumeNight : settings.options.volumeDay;
  if (game.step !== 'dawn') setVolumeUi(volume);
  renderSchedule();
  renderClock({ mode: timer.mode, value: timer.value, durationMs: timer.durationMs, running: timer.running });
}

function renderClock({ mode, value, durationMs, running }) {
  el.clock.textContent = formatClock(value, { mode });

  const ratio = mode === 'down' && durationMs > 0 ? value / durationMs : 0;
  el.progress.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;

  const warning = settings.options.warningSeconds * 1000;
  const counting = mode === 'down' && durationMs > 0;
  el.clock.classList.toggle('is-warning', counting && value > 0 && warning > 0 && value <= warning);
  el.clock.classList.toggle('is-over', counting && value <= 0);

  const label = primaryLabel(running, value);
  el.play.textContent = label;
  el.stage.textContent = label;

  // En la noche abierta el reloj se va al pie, como dato de apoyo.
  if (game.step === 'night') {
    el.caption.textContent = running
      ? `la noche lleva ${formatClock(value, { mode: 'up' })} · ciérrala cuando termines`
      : 'la partida empieza al caer la noche';
  }

  // Tres segundos antes del cero, silencio para que entren las campanas.
  const endFade = Number(settings.options.fadeSeconds) || 0;
  if (game.step === 'day' && mode === 'down' && running && endFade > 0
      && value > 0 && value <= endFade * 1000 && !game.endFadeDone) {
    game.endFadeDone = true;
    silenceBeforeDayEnd(value / 1000);
  }
}

function primaryLabel(running, value) {
  switch (game.step) {
    case 'night': return running ? '🌒 Finalizó la noche' : '▶ Empezar la noche';
    case 'night-timed': return value <= 0 ? '🌒 Finalizó la noche' : (running ? '⏸ Pausa' : '▶ Iniciar');
    case 'dawn': return '☀️ Iniciar temporizador del día';
    default: return running ? '⏸ Pausa' : (value <= 0 ? '↺ Reiniciar' : '▶ Iniciar');
  }
}

function setVolumeUi(volume) {
  game.volume = volume;
  el.volume.value = volume;
  el.volumeOut.textContent = Math.round(volume);
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

let volumeWarned = false;
function warnIfVolumeBlocked() {
  if (volumeWarned || !sp.isVolumeBlocked()) return;
  volumeWarned = true;
  toast('Este dispositivo de Spotify no deja que la app cambie su volumen: no habrá fundidos. Prueba con «esta tablet» en Ajustes.', true);
}

async function playPhaseMusic(phase, { fadeIn = null, fadeOut = null } = {}) {
  if (!sp.isConnected()) return;

  const uri = settings.playlists[phase].uri;
  const fade = Number(settings.options.fadeSeconds) || 0;
  const rise = fadeIn === null ? fade : fadeIn;
  const drop = fadeOut === null ? fade : fadeOut;
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

  if (game.musicPhase && !game.musicPaused) await sp.fadeVolume(game.volume, 0, drop, deviceId);
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
  setVolumeUi(target);
  updateMusicButton();
  await sp.fadeVolume(0, target, rise, deviceId);
  warnIfVolumeBlocked();
}

async function toggleMusic() {
  if (!sp.isConnected()) return toast('Conecta primero con Spotify.', true);
  try {
    const deviceId = activeDeviceId();
    if (game.musicPaused || !game.musicPhase) {
      if (!game.musicPhase) { await playPhaseMusic(phaseOf(game.step)); return; }
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
  $('opt-untimed-night').checked = o.untimedNight;
  $('opt-autoadvance').checked = o.autoAdvance;
  $('opt-autostart').checked = o.autoStart;
  $('opt-night-fx').checked = o.nightEffect;
  $('opt-day-bells').checked = o.dayBells;
  $('opt-keepawake').checked = o.keepAwake;
  $('opt-shuffle').checked = o.shuffle;
  $('opt-resume').checked = o.resumePlaylist;
  $('opt-warning').value = o.warningSeconds;
  $('opt-fade').value = o.fadeSeconds;
  $('opt-rise').value = o.dayRiseSeconds;
  $('opt-vol-night').value = o.volumeNight;
  $('opt-vol-day').value = o.volumeDay;
}

/** Enseña de dónde sale cada efecto: archivo propio, ruta o sintetizado. */
async function renderSoundSources() {
  const synth = { night: 'efecto siniestro sintetizado', dayEnd: 'campanas de catedral sintetizadas' };
  for (const kind of ['night', 'dayEnd']) {
    const stored = await getSound(kind).catch(() => null);
    const url = settings.sounds[kind].url;
    $(`snd-${kind}-url`).value = url;
    $(`snd-${kind}-name`).textContent = stored?.name
      ? `${stored.name} (guardado en esta tablet)`
      : (url || synth[kind]);
  }
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
      if (phase === 'night' && settings.options.untimedNight) {
        td.innerHTML = '<span class="muted-cell">sin tiempo</span>';
        tr.append(td);
        continue;
      }
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
        syncCurrentDuration(round, phase);
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
      syncCurrentDuration(round, phaseOf(game.step));
      renderSchedule();
    });
    actions.append(reset);
    tr.append(actions);

    el.scheduleBody.append(tr);
  }
}

/** Si se edita la fase que está en pantalla y el reloj no corre, recárgala. */
function syncCurrentDuration(round, phase) {
  if (round === game.round && phase === phaseOf(game.step) && timer.mode === 'down' && !timer.running) {
    timer.setCountdown(sch.msFor(settings.schedule, round, phase), { autoStart: false });
  }
}

function bindUi() {
  /* Controles principales */
  el.play.addEventListener('click', onPrimary);
  el.stage.addEventListener('click', onPrimary);
  $('btn-plus').addEventListener('click', () => timer.adjust(60_000));
  $('btn-minus').addEventListener('click', () => timer.adjust(-60_000));
  $('btn-reset').addEventListener('click', () => timer.reset({ autoStart: false }));
  $('btn-next').addEventListener('click', () => { unlockOnce(); stopEffect(); nextStep(); });
  $('btn-prev').addEventListener('click', () => { unlockOnce(); stopEffect(); prevStep(); });
  $('btn-replay-fx').addEventListener('click', () => {
    unlockOnce();
    playEffect('night', { url: settings.sounds.night.url }).catch(() => {});
  });
  $('btn-music').addEventListener('click', () => { unlockOnce(); toggleMusic(); });
  $('btn-skip-track').addEventListener('click', () => sp.nextTrack(activeDeviceId()).catch(showError));

  el.volume.addEventListener('input', () => {
    game.volume = Number(el.volume.value);
    el.volumeOut.textContent = game.volume;
    if (phaseOf(game.step) === 'night' && game.step !== 'dawn') settings.options.volumeNight = game.volume;
    else if (game.step === 'day') settings.options.volumeDay = game.volume;
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
  $('opt-untimed-night').addEventListener('change', (e) => {
    settings.options.untimedNight = e.target.checked;
    save();
    renderSchedule();
    if (isNight(game.step)) enterNight(game.round, { autoStart: false, music: false });
  });

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
      syncCurrentDuration(game.round, phaseOf(game.step));
    });
  }
  $('sch-apply').addEventListener('change', (e) => {
    settings.schedule.applyTo = e.target.value;
    save();
    renderSchedule();
    syncCurrentDuration(game.round, phaseOf(game.step));
  });
  $('btn-apply-schedule').addEventListener('click', () => {
    sch.clearOverrides(settings.schedule);
    save();
    renderSchedule();
    syncCurrentDuration(game.round, phaseOf(game.step));
    toast('Progresión aplicada a todas las rondas');
  });
  $('btn-clear-overrides').addEventListener('click', () => {
    sch.clearOverrides(settings.schedule);
    save();
    renderSchedule();
    syncCurrentDuration(game.round, phaseOf(game.step));
  });

  /* Opciones */
  const checks = {
    'opt-autoadvance': 'autoAdvance', 'opt-autostart': 'autoStart',
    'opt-night-fx': 'nightEffect', 'opt-day-bells': 'dayBells',
    'opt-keepawake': 'keepAwake', 'opt-shuffle': 'shuffle', 'opt-resume': 'resumePlaylist',
  };
  for (const [id, key] of Object.entries(checks)) {
    $(id).addEventListener('change', (e) => {
      settings.options[key] = e.target.checked;
      save();
      if (key === 'keepAwake') e.target.checked ? requestWakeLock() : releaseWakeLock();
    });
  }
  $('btn-test-night-fx').addEventListener('click', () => {
    unlockOnce();
    playEffect('night', { url: settings.sounds.night.url }).catch(() => {});
  });
  $('btn-test-bells').addEventListener('click', () => {
    unlockOnce();
    playEffect('dayEnd', { url: settings.sounds.dayEnd.url }).catch(() => {});
  });

  /* Audio propio de cada efecto */
  for (const kind of ['night', 'dayEnd']) {
    $(`snd-${kind}-file`).addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        await saveSound(kind, file);
        settings.sounds[kind].fileName = file.name;
        save();
        renderSoundSources();
        toast(`Audio guardado: ${file.name}`);
      } catch { showError(new Error('No se pudo guardar el audio en la tablet.')); }
      e.target.value = '';
    });
    $(`snd-${kind}-clear`).addEventListener('click', async () => {
      stopEffect();
      await clearSound(kind);
      settings.sounds[kind] = { url: '', fileName: '' };
      save();
      renderSoundSources();
      toast('Vuelve el sonido sintetizado');
    });
    $(`snd-${kind}-url`).addEventListener('change', (e) => {
      settings.sounds[kind].url = e.target.value.trim();
      save();
      renderSoundSources();
    });
  }

  const numbers = {
    'opt-warning': 'warningSeconds', 'opt-fade': 'fadeSeconds', 'opt-rise': 'dayRiseSeconds',
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
    enterNight(1, { autoStart: false, music: false });
    toast('Partida reiniciada');
  });
  $('btn-reset-all').addEventListener('click', () => {
    if (!confirm('¿Borrar toda la configuración guardada?')) return;
    resetAll();
    renderSettings();
    enterNight(1, { autoStart: false, music: false });
    toast('Configuración borrada');
  });

  /* Teclado (útil con teclado bluetooth o en portátil) */
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    const keys = {
      ' ': onPrimary,
      ArrowRight: nextStep,
      ArrowLeft: prevStep,
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
  if (open) { renderSettings(); renderSchedule(); renderSoundSources().catch(() => {}); }
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

init();
