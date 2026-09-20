/**
 * Efectos de sonido sintetizados con Web Audio: no hace falta ningún fichero.
 *
 *   nightStinger()   — golpe oscuro y siniestro para cerrar la noche.
 *   cathedralBells() — campanas graves de catedral al acabar el día.
 *
 * Todo pasa por una reverberación larga (convolución con ruido decreciente),
 * que es lo que da la sensación de nave de piedra.
 */

let ctx = null;
let bus = null;

function context() {
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') {
    try { ctx.resume().catch(() => {}); } catch { /* ignorado */ }
  }
  return ctx;
}

/** Los navegadores móviles exigen un gesto del usuario para abrir el audio. */
export function unlock() { context(); }

/** Respuesta al impulso: ruido que decae, o sea, una sala grande. */
function impulse(ac, seconds, curve) {
  const length = Math.floor(ac.sampleRate * seconds);
  const buffer = ac.createBuffer(2, length, ac.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** curve;
    }
  }
  return buffer;
}

function noise(ac, seconds) {
  const length = Math.floor(ac.sampleRate * seconds);
  const buffer = ac.createBuffer(1, length, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** Entrada común: seco + reverberación. */
function output(ac) {
  if (bus?.ac === ac) return bus.input;
  const input = ac.createGain();
  const dry = ac.createGain();
  const wet = ac.createGain();
  const hall = ac.createConvolver();
  // Limitador: tres campanadas solapadas se suman y saturarían el altavoz.
  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -7;
  limiter.knee.value = 6;
  limiter.ratio.value = 16;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  dry.gain.value = 0.8;
  wet.gain.value = 0.6;
  hall.buffer = impulse(ac, 3.8, 2.2);
  limiter.connect(ac.destination);
  input.connect(dry).connect(limiter);
  input.connect(hall).connect(wet).connect(limiter);
  bus = { ac, input };
  return input;
}

/** Golpe oscuro: subida de tensión, impacto grave y cuerda disonante. */
export function nightStinger({ volume = 0.9 } = {}) {
  const ac = context();
  if (!ac) return;
  const master = ac.createGain();
  master.gain.value = volume;
  master.connect(output(ac));

  const t0 = ac.currentTime + 0.05;
  const hit = t0 + 1.35;

  // Subida: ruido que barre de grave a agudo y se corta en seco.
  const riser = ac.createBufferSource();
  const sweep = ac.createBiquadFilter();
  const riserGain = ac.createGain();
  riser.buffer = noise(ac, 2);
  sweep.type = 'bandpass';
  sweep.Q.value = 1.4;
  sweep.frequency.setValueAtTime(170, t0);
  sweep.frequency.exponentialRampToValueAtTime(2600, hit);
  riserGain.gain.setValueAtTime(0.0001, t0);
  riserGain.gain.exponentialRampToValueAtTime(0.3, hit - 0.02);
  riserGain.gain.exponentialRampToValueAtTime(0.0001, hit + 0.35);
  riser.connect(sweep).connect(riserGain).connect(master);
  riser.start(t0);
  riser.stop(t0 + 2);

  // Impacto: seno que se desploma en frecuencia.
  const sub = ac.createOscillator();
  const subGain = ac.createGain();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(95, hit);
  sub.frequency.exponentialRampToValueAtTime(27, hit + 0.7);
  subGain.gain.setValueAtTime(0.0001, hit);
  subGain.gain.exponentialRampToValueAtTime(0.95, hit + 0.02);
  subGain.gain.exponentialRampToValueAtTime(0.0001, hit + 2.4);
  sub.connect(subGain).connect(master);
  sub.start(hit);
  sub.stop(hit + 2.5);

  // Cuerpo del impacto: ruido filtrado que se cierra.
  const boom = ac.createBufferSource();
  const boomFilter = ac.createBiquadFilter();
  const boomGain = ac.createGain();
  boom.buffer = noise(ac, 1);
  boomFilter.type = 'lowpass';
  boomFilter.frequency.setValueAtTime(900, hit);
  boomFilter.frequency.exponentialRampToValueAtTime(130, hit + 0.5);
  boomGain.gain.setValueAtTime(0.5, hit);
  boomGain.gain.exponentialRampToValueAtTime(0.0001, hit + 0.9);
  boom.connect(boomFilter).connect(boomGain).connect(master);
  boom.start(hit);
  boom.stop(hit + 1);

  // Cola disonante: segunda menor y tritono, muy graves y apagados.
  for (const [freq, level] of [[55, 0.16], [58.3, 0.13], [77.8, 0.09]]) {
    const osc = ac.createOscillator();
    const tone = ac.createBiquadFilter();
    const gain = ac.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    tone.type = 'lowpass';
    tone.frequency.value = 420;
    gain.gain.setValueAtTime(0.0001, hit);
    gain.gain.exponentialRampToValueAtTime(level, hit + 0.9);
    gain.gain.exponentialRampToValueAtTime(0.0001, hit + 4.2);
    osc.connect(tone).connect(gain).connect(master);
    osc.start(hit);
    osc.stop(hit + 4.3);
  }
}

/** Una campanada: parciales inarmónicos (hum, prima, tercera, quinta, nominal…). */
function toll(ac, out, at, volume, f0) {
  const master = ac.createGain();
  master.gain.value = volume;
  master.connect(out);

  const partials = [
    [0.5, 0.60, 9.0],   // hum, la octava grave que hace de cola
    [1.0, 1.00, 7.5],   // prima
    [1.19, 0.48, 5.0],  // tercera menor: el color sombrío de la campana
    [1.5, 0.34, 4.2],   // quinta
    [2.0, 0.44, 3.4],   // nominal: la nota que se percibe
    [2.5, 0.17, 2.2],
    [3.01, 0.13, 1.7],
    [4.07, 0.08, 1.1],
  ];
  for (const [ratio, level, decay] of partials) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = f0 * ratio;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    osc.connect(gain).connect(master);
    osc.start(at);
    osc.stop(at + decay + 0.1);
  }

  // Golpe del badajo contra el bronce.
  const clapper = ac.createBufferSource();
  const band = ac.createBiquadFilter();
  const gain = ac.createGain();
  clapper.buffer = noise(ac, 0.3);
  band.type = 'bandpass';
  band.frequency.value = 2400;
  band.Q.value = 0.9;
  gain.gain.setValueAtTime(0.32, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
  clapper.connect(band).connect(gain).connect(master);
  clapper.start(at);
  clapper.stop(at + 0.3);
}

export function cathedralBells({ tolls = 3, volume = 0.85, spacing = 2.7, root = 73.4 } = {}) {
  const ac = context();
  if (!ac) return;
  const out = output(ac);
  const start = ac.currentTime + 0.05;
  for (let i = 0; i < tolls; i += 1) {
    // Cada campanada un pelín más floja y desafinada: no suena a máquina.
    toll(ac, out, start + i * spacing, volume * (1 - i * 0.07), root * (1 + (i % 2 ? 0.004 : -0.002)));
  }
}
