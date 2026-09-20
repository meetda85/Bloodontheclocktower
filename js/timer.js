/**
 * Reloj de la partida. Dos modos:
 *   · 'down' — cuenta atrás del día (o de la noche, si se le pone tiempo).
 *   · 'up'   — cronómetro de la noche abierta: corre hasta que el narrador la cierra.
 *
 * Todo se calcula con marcas de tiempo reales, así que no acumula desfase
 * aunque el navegador de la tablet ralentice los temporizadores de fondo.
 */

export function createTimer({ onTick, onEnd }) {
  let mode = 'down';
  let durationMs = 0;    // solo en cuenta atrás
  let baseMs = 0;        // valor congelado mientras está parado
  let anchor = 0;        // Date.now() del último arranque
  let running = false;
  let ended = false;
  let handle = null;

  function value() {
    const since = running ? Date.now() - anchor : 0;
    return mode === 'up' ? baseMs + since : Math.max(0, baseMs - since);
  }

  function emit() {
    onTick?.({ mode, value: value(), durationMs, running });
  }

  function loop() {
    if (mode === 'down' && running && value() <= 0) {
      baseMs = 0;
      running = false;
      stopLoop();
      emit();
      if (!ended) { ended = true; onEnd?.(); }
      return;
    }
    emit();
  }

  function startLoop() {
    stopLoop();
    handle = setInterval(loop, 200);
  }

  function stopLoop() {
    if (handle !== null) { clearInterval(handle); handle = null; }
  }

  const api = {
    /** Carga una cuenta atrás. */
    setCountdown(ms, { autoStart = false } = {}) {
      mode = 'down';
      durationMs = Math.max(0, ms);
      baseMs = durationMs;
      ended = false;
      running = false;
      stopLoop();
      if (autoStart && durationMs > 0) api.start();
      else emit();
    },
    /** Carga el cronómetro (noche sin tiempo). */
    setStopwatch({ autoStart = true } = {}) {
      mode = 'up';
      durationMs = 0;
      baseMs = 0;
      ended = false;
      running = false;
      stopLoop();
      if (autoStart) api.start();
      else emit();
    },
    start() {
      if (running) return;
      if (mode === 'down' && value() <= 0) return;
      baseMs = value();
      anchor = Date.now();
      running = true;
      ended = false;
      startLoop();
      emit();
    },
    pause() {
      if (!running) return;
      baseMs = value();
      running = false;
      stopLoop();
      emit();
    },
    toggle() { running ? api.pause() : api.start(); },
    /** Suma o resta tiempo sin parar el reloj (solo cuenta atrás). */
    adjust(deltaMs) {
      if (mode !== 'down') return;
      baseMs = Math.max(0, value() + deltaMs);
      anchor = Date.now();
      durationMs = Math.max(durationMs, baseMs);
      if (baseMs > 0) ended = false;
      emit();
    },
    reset({ autoStart = false } = {}) {
      if (mode === 'up') api.setStopwatch({ autoStart });
      else api.setCountdown(durationMs, { autoStart });
    },
    get mode() { return mode; },
    get running() { return running; },
    get value() { return value(); },
    get durationMs() { return durationMs; },
  };
  return api;
}

/**
 * La cuenta atrás redondea hacia arriba (arranca en 10:00 y el último segundo
 * se ve como 00:01); el cronómetro hacia abajo (arranca en 00:00).
 */
export function formatClock(ms, { mode = 'down' } = {}) {
  const seconds_ = Math.max(0, ms) / 1000;
  const total = mode === 'up' ? Math.floor(seconds_) : Math.ceil(seconds_ - 1e-6);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const mm = minutes < 100 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${mm}:${String(seconds).padStart(2, '0')}`;
}
