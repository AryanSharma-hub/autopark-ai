/**
 * Shared configuration for the lane geometry, vehicle, speed, rotation
 * calibration, route and safety. The route planner, the 2D map, the manual
 * odometry and the ESP32 request builder all read THIS object, so the map can
 * never drift from what the rover is told to do.
 *
 * Hardware (your sketches): ESP32 -> UART -> Arduino UNO + Adafruit Motor Shield,
 * four motors. Commands are forward / reverse / rotate-in-place left / right.
 * There is no steering servo: a turn is a timed rotation in place.
 *
 * Provenance matters: values you gave (slot 26 cm, car 22 x 22 cm, 15.6 cm/s)
 * are facts; values listed in `estimated` are starting points to measure on the
 * real lot. Settings lists them and a run asks for acknowledgement.
 *
 * Coordinate model
 *   x = longitudinal lane coordinate in cm, 0 .. 130 (5 slots x 26 cm), of the
 *       rover's CENTRE (its rotation point when it turns in place).
 *   y = lateral offset from the lane driving line in cm; bays are on the
 *       configured side (left => +y, right => -y).
 *   heading 0 = facing +x along the lane.
 */

import { SlotId } from '../vision/roi';

export type BaySide = 'left' | 'right';
export type EntryMode = 'forward' | 'reverse';

export interface SpeedCalibration {
  pwm: number;
  cmPerS: number;
  /** Raw measurement, kept so the user can audit it. */
  measuredCm: number;
  durationMs: number;
  measuredAt: string;
  /** 'user' = value you gave, 'run' = measured with the calibration drive. */
  source?: 'user' | 'run';
}

export interface ParkingConfig {
  version: 3;
  lane: {
    slotCount: 5;
    slotLengthCm: number; // 26 (given)
    baySide: BaySide;
    /** Lateral distance from the lane driving line (rover centre) to the bay mouth. */
    bayOffsetCm: number;
    bayDepthCm: number;
  };
  vehicle: {
    lengthCm: number; // 22 (given)
    widthCm: number; // 22 (given): 22 + 4 cm margin = 26 cm bay
  };
  speed: {
    /** PWM for straight driving in autonomous parking (and the manual default). */
    pwm: number;
    calibrations: SpeedCalibration[];
  };
  rotation: {
    /** PWM used for in-place rotation (the 90-degree times below are measured at this PWM). */
    pwm: number;
    /** Motor-on time that rotates the rover exactly 90 degrees. Null = not calibrated yet. */
    leftMs90: number | null;
    rightMs90: number | null;
    /** Pause (motors off) between segments so the rover is at rest before the next move. */
    settleMs: number;
  };
  route: {
    entryMode: EntryMode;
    /** Rover-centre x where you place the rover before an autonomous run. */
    startCm: number;
    /** Straight distance into the bay after the rotation. Null = to the bay centre (offset + depth / 2). */
    bayEntryCm: number | null;
    /** Added to every turn point (cm). Positive = rotate later. */
    turnStartTrimCm: number;
    /** Measured turn points per slot (rover-centre x). Null = the slot centre. */
    turnStartOverrideCm: Record<SlotId, number | null>;
  };
  safety: {
    /** Stop (OBSTACLE_STOP) when the ultrasonic in the direction of travel reads <= this. */
    obstacleStopCm: number;
    /** During the final bay entry, a reading <= this ends the manoeuvre (COMPLETED). */
    bayStopCm: number;
    /** Stop on IR detections in the direction of travel. */
    irStopEnabled: boolean;
    /** Also stop manual driving at obstacles. */
    manualObstacleStop: boolean;
    /** ESP32 aborts autonomous parking if the app is silent this long. */
    heartbeatTimeoutMs: number;
    /** ESP32 stops a manual move if no repeat/keep-alive arrives within this time. */
    manualWatchdogMs: number;
  };
  esp32: {
    host: string; // 192.168.4.1 (firmware soft-AP)
    pollIntervalMs: number;
    requestTimeoutMs: number;
    staleAfterMs: number;
  };
  /** Dotted paths of values that are estimates, not measurements. */
  estimated: string[];
}

/** The speed you measured: 15.6 cm/s. Recorded at PWM 130, the firmware's default speed. */
export const GIVEN_SPEED: SpeedCalibration = {
  pwm: 130,
  cmPerS: 15.6,
  measuredCm: 15.6,
  durationMs: 1000,
  measuredAt: '2026-10-28T00:00:00.000Z',
  source: 'user',
};

export const DEFAULT_PARKING_CONFIG: ParkingConfig = {
  version: 3,
  lane: {
    slotCount: 5,
    slotLengthCm: 26,
    baySide: 'left',
    bayOffsetCm: 20,
    bayDepthCm: 36,
  },
  vehicle: {
    lengthCm: 22,
    widthCm: 22,
  },
  speed: {
    pwm: 130,
    calibrations: [GIVEN_SPEED],
  },
  rotation: {
    pwm: 130,
    leftMs90: null,
    rightMs90: null,
    settleMs: 300,
  },
  route: {
    entryMode: 'forward',
    startCm: 11,
    bayEntryCm: null,
    turnStartTrimCm: 0,
    turnStartOverrideCm: { S1: null, S2: null, S3: null, S4: null, S5: null },
  },
  safety: {
    obstacleStopCm: 12,
    bayStopCm: 6,
    irStopEnabled: true,
    manualObstacleStop: true,
    heartbeatTimeoutMs: 2000,
    manualWatchdogMs: 1000,
  },
  esp32: {
    host: '192.168.4.1',
    pollIntervalMs: 300,
    requestTimeoutMs: 1500,
    staleAfterMs: 1500,
  },
  estimated: ['lane.baySide', 'lane.bayOffsetCm', 'lane.bayDepthCm', 'route.startCm', 'safety.obstacleStopCm', 'safety.bayStopCm'],
};

/** Human-readable description of each tunable, used by Settings and the docs. */
export const PARAMETER_HELP: Record<string, string> = {
  'lane.baySide': 'Which side of the driving line the five bays are on, seen from the rover at x = 0 facing +x.',
  'lane.bayOffsetCm':
    'Lateral distance from the rover centre (while driving the lane) to the bay entrance line. Must exceed half the rover width (11 cm).',
  'lane.bayDepthCm': 'Depth of a bay, measured perpendicular to the lane.',
  'vehicle.lengthCm': 'Bumper-to-bumper length of the rover.',
  'vehicle.widthCm': 'Outside width (breadth) of the rover. 22 cm in a 26 cm bay leaves 2 cm per side.',
  'route.startCm': 'Rover-centre x where you place the rover before pressing Park (11 cm = rear bumper on the 0 cm line).',
  'route.bayEntryCm': 'Straight distance driven into the bay after the rotation (blank = to the bay centre).',
  'safety.obstacleStopCm': 'Ultrasonic reading at which the rover stops for an obstacle.',
  'safety.bayStopCm': 'Ultrasonic reading at the bay end that ends the bay entry early.',
};

export function isEstimated(cfg: ParkingConfig, path: string): boolean {
  return cfg.estimated.includes(path);
}

export function markMeasured(cfg: ParkingConfig, path: string): ParkingConfig {
  return { ...cfg, estimated: cfg.estimated.filter((p) => p !== path) };
}

export function laneLengthCm(cfg: ParkingConfig): number {
  return cfg.lane.slotCount * cfg.lane.slotLengthCm;
}

/** Radius of the circle the body sweeps when rotating in place about its centre. */
export function rotationRadiusCm(cfg: ParkingConfig): number {
  return Math.hypot(cfg.vehicle.lengthCm / 2, cfg.vehicle.widthCm / 2);
}

/** Bay entry distance actually used (explicit, or to the bay centre). */
export function bayEntryCm(cfg: ParkingConfig): number {
  return cfg.route.bayEntryCm ?? cfg.lane.bayOffsetCm + cfg.lane.bayDepthCm / 2;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Validate ranges that, if wrong, would make the rover do something unsafe or meaningless. */
export function validateParkingConfig(cfg: ParkingConfig): string[] {
  const errors: string[] = [];
  const pos = (v: number, name: string) => {
    if (!(Number.isFinite(v) && v > 0)) errors.push(`${name} must be a positive number.`);
  };
  pos(cfg.lane.slotLengthCm, 'Slot length');
  pos(cfg.lane.bayDepthCm, 'Bay depth');
  pos(cfg.vehicle.lengthCm, 'Vehicle length');
  pos(cfg.vehicle.widthCm, 'Vehicle width');
  if (cfg.vehicle.widthCm >= cfg.lane.slotLengthCm) {
    errors.push(`Vehicle width (${cfg.vehicle.widthCm} cm) must be less than the bay width (${cfg.lane.slotLengthCm} cm).`);
  }
  if (!(cfg.lane.bayOffsetCm > cfg.vehicle.widthCm / 2)) {
    errors.push(
      `Bay mouth offset (${cfg.lane.bayOffsetCm} cm) must be more than half the vehicle width (${cfg.vehicle.widthCm / 2} cm), ` +
        'or the rover body overlaps the bays while driving the lane.',
    );
  }
  if (!(Number.isInteger(cfg.speed.pwm) && cfg.speed.pwm >= 1 && cfg.speed.pwm <= 255)) errors.push('Driving PWM must be 1-255.');
  const r = cfg.rotation;
  if (!(Number.isInteger(r.pwm) && r.pwm >= 1 && r.pwm <= 255)) errors.push('Rotation PWM must be 1-255.');
  for (const [k, v] of [
    ['left', r.leftMs90],
    ['right', r.rightMs90],
  ] as const) {
    if (v !== null && !(Number.isFinite(v) && v >= 50 && v <= 10000)) errors.push(`90° ${k} rotation time must be 50-10000 ms.`);
  }
  if (!(r.settleMs >= 0 && r.settleMs <= 3000)) errors.push('Settle time must be 0-3000 ms.');
  const entry = bayEntryCm(cfg);
  if (!(entry > 0 && entry <= 100)) errors.push('Bay entry distance must be 0-100 cm.');
  if (!Number.isFinite(cfg.route.startCm)) errors.push('Start position must be a number.');
  if (!(cfg.safety.obstacleStopCm >= 2 && cfg.safety.obstacleStopCm <= 100)) errors.push('Obstacle stop distance must be 2-100 cm.');
  if (!(cfg.safety.bayStopCm >= 2 && cfg.safety.bayStopCm <= 100)) errors.push('Bay stop distance must be 2-100 cm.');
  if (!(cfg.safety.heartbeatTimeoutMs >= 500 && cfg.safety.heartbeatTimeoutMs <= 10000)) errors.push('Heartbeat timeout must be 500-10000 ms.');
  if (!(cfg.safety.manualWatchdogMs >= 300 && cfg.safety.manualWatchdogMs <= 5000)) errors.push('Manual watchdog must be 300-5000 ms.');
  return errors;
}

/** Merge a persisted (possibly older/partial) config over the defaults. */
export function mergeWithDefaults(saved: Partial<ParkingConfig> | null | undefined): ParkingConfig {
  const d = DEFAULT_PARKING_CONFIG;
  // Configs from the servo-steering version (v2) describe different hardware: start fresh,
  // keeping only the network settings and any speed calibrations.
  if (!saved || typeof saved !== 'object') return structuredCloneSafe(d);
  if ((saved as { version?: number }).version !== 3) {
    const fresh = structuredCloneSafe(d);
    if (saved.esp32) fresh.esp32 = { ...fresh.esp32, ...saved.esp32 };
    const cals = saved.speed?.calibrations;
    if (Array.isArray(cals) && cals.length) {
      const merged = [...fresh.speed.calibrations.filter((c) => !cals.some((x) => x.pwm === c.pwm)), ...cals];
      fresh.speed.calibrations = merged.sort((a, b) => a.pwm - b.pwm);
    }
    return fresh;
  }
  return {
    version: 3,
    lane: { ...d.lane, ...(saved.lane ?? {}), slotCount: 5 },
    vehicle: { ...d.vehicle, ...(saved.vehicle ?? {}) },
    speed: { ...d.speed, ...(saved.speed ?? {}), calibrations: [...(saved.speed?.calibrations ?? d.speed.calibrations)] },
    rotation: { ...d.rotation, ...(saved.rotation ?? {}) },
    route: {
      ...d.route,
      ...(saved.route ?? {}),
      turnStartOverrideCm: { ...d.route.turnStartOverrideCm, ...(saved.route?.turnStartOverrideCm ?? {}) },
    },
    safety: { ...d.safety, ...(saved.safety ?? {}) },
    esp32: { ...d.esp32, ...(saved.esp32 ?? {}) },
    estimated: Array.isArray(saved.estimated) ? [...saved.estimated] : [...d.estimated],
  };
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
