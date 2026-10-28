/**
 * ESP32 HTTP protocol (firmware/autopark_esp32, ESP32 + UNO motor driver).
 * Your original endpoints are kept; app endpoints are additive.
 *
 *   GET  /                      built-in control page (hold-to-drive)
 *   GET  /cmd?m=F|B|L|R|S       manual move / rotate / stop. Moves expire after the
 *                               manual watchdog unless repeated. 409 while autonomous
 *                               parking runs (S always works and aborts), 423 while latched.
 *   GET  /timed?m=..&seconds=N  timed move (your page); also &ms=N
 *   GET  /speed?v=N             PWM 0-255 (409 during autonomous)
 *   GET  /data                  your original JSON
 *   GET  /status                full state JSON (see RoverStatus)
 *   GET  /ping                  keep-alive
 *   POST /park                  start autonomous parking (form fields below)
 *   POST /calib                 timed calibration move (m=F|B|L|R, pwm, ms)
 *   GET  /abort                 stop autonomous/calibration run -> ABORTED
 *   GET  /estop                 emergency stop: motors off, latched
 *   GET  /reset                 acknowledge ABORTED/OBSTACLE_STOP/ERROR/COMPLETED -> IDLE
 *   GET  /config?...            safety parameters for manual mode
 */

import { ParkingConfig } from '../config/parkingConfig';
import { PHASE_CODE, RoutePlan } from '../geometry/routePlanner';

export type MotionCode = 'F' | 'B' | 'L' | 'R' | 'S';

export const ROVER_STATES = [
  'IDLE',
  'MANUAL',
  'CALIBRATING',
  'APPROACHING',
  'TURNING',
  'PARKING',
  'COMPLETED',
  'OBSTACLE_STOP',
  'ABORTED',
  'ERROR',
] as const;
export type RoverState = (typeof ROVER_STATES)[number];

export const AUTONOMOUS_STATES: RoverState[] = ['APPROACHING', 'TURNING', 'PARKING'];
export const TERMINAL_STATES: RoverState[] = ['COMPLETED', 'OBSTACLE_STOP', 'ABORTED', 'ERROR'];
export const LATCHED_STATES: RoverState[] = ['OBSTACLE_STOP', 'ABORTED', 'ERROR'];

export function isAutonomous(s: RoverState | undefined | null): boolean {
  return !!s && AUTONOMOUS_STATES.includes(s);
}
export function isLatched(s: RoverState | undefined | null): boolean {
  return !!s && LATCHED_STATES.includes(s);
}

export interface RoverStatus {
  fw: string;
  uptimeMs: number;
  state: RoverState;
  /** Why the rover is in a terminal state / stopped (e.g. "front 9.8cm", "heartbeat lost"). */
  reason: string;
  movement: MotionCode;
  pwm: number;
  estop: boolean;
  // autonomous run
  rid: string;
  slot: string;
  seg: number; // current segment index, -1 when none
  segCount: number;
  segPhase: string; // 'A' | 'T' | 'P' | '-'
  segMove: string; // 'F' | 'B' | 'L' | 'R' | '-'
  settling: boolean;
  segMs: number; // motor-on time inside the current segment
  segDurMs: number;
  segDistCm: number; // estimated straight distance inside the current segment
  distCm: number; // estimated straight distance along the whole plan
  totalCm: number;
  elapsedMs: number;
  cms: number; // speed used by the run (cm/s), 0 if none
  // manual odometry (cumulative motor-on time since boot)
  fwdMs: number;
  revMs: number;
  leftMs: number;
  rightMs: number;
  blocked: string; // manual obstacle block ("front"/"rear"/"")
  calibMs: number; // duration of the last calibration run actually driven
  calibMove: string;
  // sensors
  front: number | null;
  rear: number | null;
  left: number | null;
  right: number | null;
  irFL: 0 | 1;
  irFR: 0 | 1;
  irRL: 0 | 1;
  irRR: 0 | 1;
  sensorAgeMs: number;
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const num = (v: unknown, name: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ProtocolError(`status.${name} is not a number`);
  return v;
};
const dist = (v: unknown, name: string): number | null => (v === null || v === undefined ? null : num(v, name));
const bit = (v: unknown): 0 | 1 => (v ? 1 : 0);

export function parseStatus(raw: unknown): RoverStatus {
  if (!raw || typeof raw !== 'object') throw new ProtocolError('status is not an object');
  const r = raw as Record<string, unknown>;
  const state = r.state as RoverState;
  if (!ROVER_STATES.includes(state)) throw new ProtocolError(`unknown rover state ${String(r.state)}`);
  const movement: MotionCode = ['F', 'B', 'L', 'R'].includes(String(r.movement)) ? (r.movement as MotionCode) : 'S';
  return {
    fw: String(r.fw ?? ''),
    uptimeMs: num(r.uptime, 'uptime'),
    state,
    reason: String(r.reason ?? ''),
    movement,
    pwm: num(r.speed, 'speed'),
    estop: !!r.estop,
    rid: String(r.rid ?? ''),
    slot: String(r.slot ?? ''),
    seg: num(r.seg ?? -1, 'seg'),
    segCount: num(r.segCount ?? 0, 'segCount'),
    segPhase: String(r.segPhase ?? '-'),
    segMove: String(r.segMove ?? '-'),
    settling: !!r.settling,
    segMs: num(r.segMs ?? 0, 'segMs'),
    segDurMs: num(r.segDurMs ?? 0, 'segDurMs'),
    segDistCm: num(r.segDist ?? 0, 'segDist'),
    distCm: num(r.dist ?? 0, 'dist'),
    totalCm: num(r.total ?? 0, 'total'),
    elapsedMs: num(r.elapsed ?? 0, 'elapsed'),
    cms: num(r.cms ?? 0, 'cms'),
    fwdMs: num(r.fwdMs ?? 0, 'fwdMs'),
    revMs: num(r.revMs ?? 0, 'revMs'),
    leftMs: num(r.leftMs ?? 0, 'leftMs'),
    rightMs: num(r.rightMs ?? 0, 'rightMs'),
    blocked: String(r.blocked ?? ''),
    calibMs: num(r.calibMs ?? 0, 'calibMs'),
    calibMove: String(r.calibMove ?? 'F'),
    front: dist(r.front, 'front'),
    rear: dist(r.rear, 'rear'),
    left: dist(r.left, 'left'),
    right: dist(r.right, 'right'),
    irFL: bit(r.irFL),
    irFR: bit(r.irFR),
    irRL: bit(r.irRL),
    irRR: bit(r.irRR),
    sensorAgeMs: num(r.sensorAge ?? 0, 'sensorAge'),
  };
}

export interface ParkRequest {
  rid: string;
  slot: string;
  /** straight driving PWM */
  pwm: number;
  /** rotation PWM (the 90-degree time was calibrated at this PWM) */
  rpwm: number;
  cms: number;
  /** "A,F,58.75;T,L,1180;P,F,38.00" (straight: cm, rotation: ms) */
  segs: string;
  obst: number;
  bay: number;
  ir: 0 | 1;
  hb: number;
  settle: number;
}

export function encodeSegments(plan: RoutePlan): string {
  return plan.segments
    .map((s) => {
      if (s.move === 'L' || s.move === 'R') {
        if (s.durationMs === null) throw new ProtocolError('Rotation is not calibrated.');
        return `${PHASE_CODE[s.phase]},${s.move},${Math.round(s.durationMs)}`;
      }
      return `${PHASE_CODE[s.phase]},${s.move},${s.distanceCm.toFixed(2)}`;
    })
    .join(';');
}

export function buildParkRequest(plan: RoutePlan, cfg: ParkingConfig, rid: string): ParkRequest {
  if (!plan.feasible) throw new ProtocolError(`Plan for ${plan.slotId} is not feasible: ${plan.errors.join(' ')}`);
  if (!plan.cmPerS) throw new ProtocolError('Speed is not calibrated.');
  if (!/^[A-Za-z0-9-]{4,40}$/.test(rid)) throw new ProtocolError('Invalid request id.');
  return {
    rid,
    slot: plan.slotId,
    pwm: cfg.speed.pwm,
    rpwm: cfg.rotation.pwm,
    cms: Math.round(plan.cmPerS * 100) / 100,
    segs: encodeSegments(plan),
    obst: cfg.safety.obstacleStopCm,
    bay: cfg.safety.bayStopCm,
    ir: cfg.safety.irStopEnabled ? 1 : 0,
    hb: cfg.safety.heartbeatTimeoutMs,
    settle: cfg.rotation.settleMs,
  };
}

export function formEncode(fields: Record<string, string | number>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

export function newRequestId(): string {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0');
  return `${t}-${r}`;
}
