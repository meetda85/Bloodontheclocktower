/** Campanada sintetizada con Web Audio: no hace falta ningún fichero de sonido. */

let ctx = null;

function context() {
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Los navegadores móviles exigen un gesto del usuario para abrir el audio. */
export function unlock() { context(); }

export function gong({ volume = 0.5 } = {}) {
  const ac = context();
  if (!ac) return;

  const start = ac.currentTime;
  const master = ac.createGain();
  master.gain.value = volume;
  master.connect(ac.destination);

  // Parciales inarmónicos: dan el timbre metálico de una campana.
  for (const [ratio, level, decay] of [[1, 1, 3.2], [2.02, 0.5, 2.4], [2.98, 0.32, 1.8], [4.51, 0.18, 1.2]]) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = 110 * ratio;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(level, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + decay);
    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + decay + 0.1);
  }
}
