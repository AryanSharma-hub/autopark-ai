/**
 * Longitudinal lane model: five 26 cm slots, 0-130 cm.
 *
 * Boundary convention (half-open intervals):
 *   S1 = [0, 26)  S2 = [26, 52)  S3 = [52, 78)  S4 = [78, 104)  S5 = [104, 130)
 *   slotIndex = floor(x / 26) + 1  for 0 <= x < 130
 * x = 130 is the lane END POINT; it is reported as 'end', never as a 6th slot.
 */

import { SLOT_IDS, SlotId } from '../vision/roi';
import { ParkingConfig, SpeedCalibration, laneLengthCm } from '../config/parkingConfig';

export type LanePosition =
  | { kind: 'slot'; slotId: SlotId; index: number }
  | { kind: 'before-start' } // x < 0
  | { kind: 'end' } // x === lane length
  | { kind: 'beyond-end' } // x > lane length
  | { kind: 'invalid' }; // NaN / Infinity / non-number

export function slotAt(xCm: number, slotLengthCm = 26, slotCount = 5): LanePosition {
  if (typeof xCm !== 'number' || !Number.isFinite(xCm)) return { kind: 'invalid' };
  const laneLength = slotLengthCm * slotCount;
  if (xCm < 0) return { kind: 'before-start' };
  if (xCm === laneLength) return { kind: 'end' };
  if (xCm > laneLength) return { kind: 'beyond-end' };
  const index = Math.min(Math.floor(xCm / slotLengthCm), slotCount - 1) + 1;
  return { kind: 'slot', slotId: SLOT_IDS[index - 1], index };
}

export function slotIndexOf(slotId: SlotId): number {
  const i = SLOT_IDS.indexOf(slotId);
  if (i < 0) throw new Error(`Unknown slot ${slotId}`);
  return i + 1;
}

export function slotInterval(slotId: SlotId, slotLengthCm = 26): { startCm: number; endCm: number } {
  const i = slotIndexOf(slotId);
  return { startCm: (i - 1) * slotLengthCm, endCm: i * slotLengthCm };
}

export function slotCentreCm(slotId: SlotId, slotLengthCm = 26): number {
  const { startCm, endCm } = slotInterval(slotId, slotLengthCm);
  return (startCm + endCm) / 2;
}

export function describeLanePosition(p: LanePosition): string {
  switch (p.kind) {
    case 'slot':
      return p.slotId;
    case 'before-start':
      return 'before S1';
    case 'end':
      return 'lane end (130 cm)';
    case 'beyond-end':
      return 'past lane end';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Speed / distance
// ---------------------------------------------------------------------------

/** distanceCm = calibratedSpeedCmPerSecond * elapsedTimeSeconds */
export function estimateDistanceCm(cmPerS: number, elapsedS: number): number {
  if (!Number.isFinite(cmPerS) || cmPerS < 0) throw new RangeError('Speed must be a finite, non-negative cm/s value.');
  if (!Number.isFinite(elapsedS) || elapsedS < 0) throw new RangeError('Elapsed time must be a finite, non-negative number of seconds.');
  return cmPerS * elapsedS;
}

export function timeForDistanceMs(distanceCm: number, cmPerS: number): number {
  if (!(cmPerS > 0)) throw new RangeError('Speed must be positive.');
  if (!(distanceCm >= 0)) throw new RangeError('Distance must be >= 0.');
  return Math.round((distanceCm / cmPerS) * 1000);
}

/**
 * Calibration run: the ESP32 drives straight at `pwm` for `durationMs` (it reports
 * the exact time it actually ran); the user measures the distance with a ruler.
 */
export function makeCalibration(pwm: number, measuredCm: number, durationMs: number, at = new Date()): SpeedCalibration {
  if (!(Number.isInteger(pwm) && pwm > 0 && pwm <= 255)) throw new RangeError('PWM must be 1-255.');
  if (!(measuredCm > 0 && measuredCm < 1000)) throw new RangeError('Measured distance must be between 0 and 1000 cm.');
  if (!(durationMs >= 300 && durationMs <= 20000)) throw new RangeError('Run time must be 300-20000 ms.');
  return { pwm, cmPerS: measuredCm / (durationMs / 1000), measuredCm, durationMs, measuredAt: at.toISOString(), source: 'run' };
}

export function upsertCalibration(list: SpeedCalibration[], c: SpeedCalibration): SpeedCalibration[] {
  return [...list.filter((x) => x.pwm !== c.pwm), c].sort((a, b) => a.pwm - b.pwm);
}

export type SpeedLookup =
  | { kind: 'measured'; cmPerS: number; pwm: number }
  | { kind: 'interpolated'; cmPerS: number; pwm: number; between: [number, number] }
  | { kind: 'uncalibrated'; pwm: number };

/**
 * A PWM value is not a speed. Only a measured PWM (or interpolation between two
 * measured PWMs) gives cm/s; anything else is reported as uncalibrated.
 */
export function speedForPwm(calibrations: SpeedCalibration[], pwm: number): SpeedLookup {
  if (pwm <= 0) return { kind: 'measured', cmPerS: 0, pwm };
  const exact = calibrations.find((c) => c.pwm === pwm);
  if (exact) return { kind: 'measured', cmPerS: exact.cmPerS, pwm };
  const sorted = [...calibrations].sort((a, b) => a.pwm - b.pwm);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (pwm > a.pwm && pwm < b.pwm) {
      const t = (pwm - a.pwm) / (b.pwm - a.pwm);
      return { kind: 'interpolated', cmPerS: a.cmPerS + t * (b.cmPerS - a.cmPerS), pwm, between: [a.pwm, b.pwm] };
    }
  }
  return { kind: 'uncalibrated', pwm };
}

/**
 * Speed used for autonomous parking at the configured PWM: measured exactly, or
 * linearly interpolated between two measured PWMs (flagged so the UI can say so).
 */
export function parkingSpeed(cfg: ParkingConfig): { cmPerS: number; kind: 'measured' | 'interpolated' } | { error: string } {
  const s = speedForPwm(cfg.speed.calibrations, cfg.speed.pwm);
  if (s.kind === 'uncalibrated') {
    return {
      error:
        `Speed at PWM ${cfg.speed.pwm} has not been measured` +
        (cfg.speed.calibrations.length ? ` (measured: ${cfg.speed.calibrations.map((c) => c.pwm).join(', ')})` : '') +
        '. Run the speed calibration in Settings, or pick a measured PWM.',
    };
  }
  if (!(s.cmPerS > 0.5 && s.cmPerS < 200)) return { error: `Calibrated speed ${s.cmPerS.toFixed(1)} cm/s is implausible; recalibrate.` };
  return { cmPerS: s.cmPerS, kind: s.kind };
}

/**
 * Inverse lookup for "set the speed in cm/s": the PWM that gives `cmPerS`,
 * from a measured point or by interpolating between two measured points.
 * Null when the target is outside the measured range (PWM is not proportional to speed).
 */
export function pwmForSpeed(calibrations: SpeedCalibration[], cmPerS: number): { pwm: number; kind: 'measured' | 'interpolated' } | null {
  if (!(cmPerS > 0)) return null;
  const sorted = [...calibrations].sort((a, b) => a.pwm - b.pwm);
  const exact = sorted.find((c) => Math.abs(c.cmPerS - cmPerS) < 0.05);
  if (exact) return { pwm: exact.pwm, kind: 'measured' };
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const lo = Math.min(a.cmPerS, b.cmPerS);
    const hi = Math.max(a.cmPerS, b.cmPerS);
    if (cmPerS > lo && cmPerS < hi && b.cmPerS !== a.cmPerS) {
      const t = (cmPerS - a.cmPerS) / (b.cmPerS - a.cmPerS);
      return { pwm: Math.round(a.pwm + t * (b.pwm - a.pwm)), kind: 'interpolated' };
    }
  }
  return null;
}

/** 90-degree rotation time from one trial: rotated `angleDeg` in `ms`. */
export function rotationMsFor90(ms: number, angleDeg: number): number {
  if (!(ms > 0 && Number.isFinite(ms))) throw new RangeError('Rotation time must be positive.');
  if (!(angleDeg >= 10 && angleDeg <= 360)) throw new RangeError('Measured angle must be 10-360 degrees.');
  const v = Math.round((ms * 90) / angleDeg);
  if (v < 50 || v > 10000) throw new RangeError(`That gives ${v} ms for 90°, outside 50-10000 ms. Re-measure.`);
  return v;
}

export { laneLengthCm };
