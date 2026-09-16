/**
 * Cuenta atrás basada en marcas de tiempo reales: no acumula desfase aunque
 * el navegador de la tablet ralentice los temporizadores en segundo plano.
 */

export function createTimer({ onTick, onEnd }) {
  let durationMs = 0;
  let remainingMs = 0;
  let deadline = 0;      // instante (epoch ms) en que llega a cero
  let running = false;
  let ended = false;
  let handle = null;

  function now() { return Date.now(); }

  function currentRemaining() {
    return running ? Math.max(0, deadline - now()) : remainingMs;
  }

  function emit() {
    onTick?.({ remainingMs: currentRemaining(), durationMs, running });
  }

  function loop() {
    const left = currentRemaining();
    if (running && left <= 0) {
      running = false;
      remainingMs = 0;
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

  return {
    /** Carga una fase nueva (opcionalmente arrancándola). */
    set(ms, { autoStart = false } = {}) {
      durationMs = Math.max(0, ms);
      remainingMs = durationMs;
      ended = false;
      running = false;
      stopLoop();
      if (autoStart && durationMs > 0) this.start();
      else emit();
    },
    start() {
      if (running || currentRemaining() <= 0) return;
      deadline = now() + remainingMs;
      running = true;
      ended = false;
      startLoop();
      emit();
    },
    pause() {
      if (!running) return;
      remainingMs = currentRemaining();
      running = false;
      stopLoop();
      emit();
    },
    toggle() { running ? this.pause() : this.start(); },
    /** Suma (o resta) tiempo sin parar el reloj. */
    adjust(deltaMs) {
      const left = Math.max(0, currentRemaining() + deltaMs);
      durationMs = Math.max(durationMs, left);
      if (running) deadline = now() + left;
      else remainingMs = left;
      if (left > 0) ended = false;
      emit();
    },
    reset({ autoStart = false } = {}) { this.set(durationMs, { autoStart }); },
    get running() { return running; },
    get remainingMs() { return currentRemaining(); },
    get durationMs() { return durationMs; },
  };
}

export function formatClock(ms) {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const mm = minutes < 100 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${mm}:${String(seconds).padStart(2, '0')}`;
}
