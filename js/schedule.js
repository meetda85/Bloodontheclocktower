/**
 * Cálculo de la duración de cada fase.
 *
 * Por defecto: ronda 1 = 10 min y baja 2 min por ronda hasta un suelo de 6 min.
 * Cualquier casilla puede fijarse a mano (overrides) sin tocar la progresión.
 */

export const PHASES = ['night', 'day'];

export const phaseLabel = { night: 'Noche', day: 'Día' };
export const phaseIcon = { night: '🌙', day: '☀️' };

/** Valor que dicta la progresión automática para esa ronda y fase. */
export function autoMinutes(schedule, round, phase) {
  const followsRamp = schedule.applyTo === 'both' || schedule.applyTo === phase;
  if (!followsRamp) return num(schedule.fixed, 5);

  const start = num(schedule.start, 10);
  const step = num(schedule.step, 2);
  const min = num(schedule.min, 6);
  const value = start - step * (Math.max(1, round) - 1);
  // El suelo solo actúa en el sentido de la progresión (bajando o subiendo).
  return step >= 0 ? Math.max(min, value) : Math.min(min, value);
}

/** Valor real de la ronda: el fijado a mano si existe, si no el automático. */
export function minutesFor(schedule, round, phase) {
  const override = schedule.overrides?.[String(round)]?.[phase];
  return typeof override === 'number' ? override : autoMinutes(schedule, round, phase);
}

export function msFor(schedule, round, phase) {
  return Math.max(0, Math.round(minutesFor(schedule, round, phase) * 60_000));
}

export function setOverride(schedule, round, phase, minutes) {
  const key = String(round);
  schedule.overrides[key] = schedule.overrides[key] || {};
  if (minutes === null || Number.isNaN(minutes)) delete schedule.overrides[key][phase];
  else schedule.overrides[key][phase] = Math.max(0, minutes);
  if (Object.keys(schedule.overrides[key]).length === 0) delete schedule.overrides[key];
}

export function hasOverride(schedule, round, phase) {
  return typeof schedule.overrides?.[String(round)]?.[phase] === 'number';
}

/** Fija en la tabla lo que dicta la progresión (útil tras cambiar los parámetros). */
export function clearOverrides(schedule) {
  schedule.overrides = {};
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
