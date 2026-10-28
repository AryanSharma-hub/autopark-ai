/**
 * Deterministic slot -> route mapping (the predefined parking strategy) for a
 * rover that turns by rotating in place.
 *
 * The classifier decides WHICH slots are free; this module decides HOW the
 * rover reaches the selected one, from configuration only:
 *
 *   1. APPROACHING  drive straight along the lane until the rover CENTRE is at
 *                   the slot's turn point (the slot centre unless you measured
 *                   a correction),
 *   2. TURNING      rotate 90 degrees in place towards the bays
 *                   (forward-in: nose to the bays; reverse-in: tail to the bays),
 *   3. PARKING      drive straight into the bay (forward or reverse), ended
 *                   early by the bay-end ultrasonic threshold.
 *
 * Straight distances become times on the ESP32 via the measured speed
 * (t = distance / cm-per-s); the rotation time is your calibrated "ms per 90
 * degrees" at the rotation PWM.
 *
 * Because the rover rotates about its centre, the turn point is simply the slot
 * centre: no turning-radius geometry is needed. What matters instead:
 *   - the body sweeps a circle of radius hypot(L/2, W/2) while rotating
 *     (15.6 cm for 22 x 22 cm); where it crosses the bay mouth it must stay
 *     within the target slot (checked), which a 22 x 22 cm body always does;
 *   - with 2 cm per side (22 cm in 26 cm), a heading error of d degrees after the
 *     rotation shifts the rover sideways by about entry * sin(d) while it drives
 *     in, so the 90-degree calibration has to be accurate.
 */

import { ParkingConfig, bayEntryCm, laneLengthCm, rotationRadiusCm, validateParkingConfig } from '../config/parkingConfig';
import { SlotId } from '../vision/roi';
import { parkingSpeed, slotCentreCm, slotInterval } from './lane';
import { Move, Pose, bodyCorners, drive, poseAtX, radToDeg, rotate } from './kinematics';

export type PhaseName = 'APPROACHING' | 'TURNING' | 'PARKING';
export const PHASE_CODE: Record<PhaseName, 'A' | 'T' | 'P'> = { APPROACHING: 'A', TURNING: 'T', PARKING: 'P' };
export const CODE_PHASE: Record<string, PhaseName> = { A: 'APPROACHING', T: 'TURNING', P: 'PARKING' };

export interface PlannedSegment {
  phase: PhaseName;
  move: Move;
  /** Straight segments: distance (cm). Rotations: 0. */
  distanceCm: number;
  /** Rotations: angle (rad). Straight: 0. */
  angleRad: number;
  /** Straight: distance / calibrated speed; rotation: calibrated ms per 90 deg. Null while uncalibrated. */
  durationMs: number | null;
  /** Cumulative straight distance where this segment starts. */
  startAlongCm: number;
}

/**
 * Swept-body clearance inside the bay row. Only the part of the rover that is
 * past the bay mouth counts (inside the lane it cannot touch a parked car).
 */
export interface SweepClearance {
  intoLowerCm: number;
  intoHigherCm: number;
  finalGapLowerCm: number;
  finalGapHigherCm: number;
  lowerNeighbour: SlotId | 'lot edge' | null;
  higherNeighbour: SlotId | 'lot edge' | null;
}

export interface RoutePlan {
  slotId: SlotId;
  entryMode: 'forward' | 'reverse';
  feasible: boolean;
  errors: string[];
  warnings: string[];
  /** Estimated parameters this plan depends on. */
  estimatesUsed: string[];
  slotStartCm: number;
  slotEndCm: number;
  slotCentreCm: number;
  /** Rover-centre x where the rotation happens. */
  turnStartCm: number;
  turnStartSource: 'slot-centre' | 'measured-override';
  rotation: 'L' | 'R';
  rotationPwm: number;
  rotationMs: number | null;
  rotationRadiusCm: number;
  entryCm: number;
  /** Largest heading error (deg) that still keeps the body inside the bay on the way in. */
  headingToleranceDeg: number;
  cmPerS: number | null;
  segments: PlannedSegment[];
  totalDistanceCm: number;
  totalMoveMs: number | null;
  totalSettleMs: number;
  startPose: Pose;
  finalPose: Pose;
  sweep: SweepClearance;
}

const RELEVANT_ESTIMATES = ['lane.baySide', 'lane.bayOffsetCm', 'lane.bayDepthCm', 'route.startCm', 'safety.obstacleStopCm', 'safety.bayStopCm'];
const SLOT_ORDER: SlotId[] = ['S1', 'S2', 'S3', 'S4', 'S5'];
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Swing into a NEIGHBOUR bay (where a car may be parked). Swinging past the lot edge is reported separately. */
export const neighbourIntrusionCm = (p: RoutePlan) =>
  Math.max(p.sweep.lowerNeighbour === 'lot edge' ? 0 : p.sweep.intoLowerCm, p.sweep.higherNeighbour === 'lot edge' ? 0 : p.sweep.intoHigherCm);

export function planRoute(cfg: ParkingConfig, slotId: SlotId): RoutePlan {
  const errors = validateParkingConfig(cfg);
  const warnings: string[] = [];
  const L = laneLengthCm(cfg);
  const { startCm: slotStart, endCm: slotEnd } = slotInterval(slotId, cfg.lane.slotLengthCm);
  const c = slotCentreCm(slotId, cfg.lane.slotLengthCm);
  const left = cfg.lane.baySide === 'left';
  const forward = cfg.route.entryMode === 'forward';
  // Forward-in: nose towards the bays. Bays on the left -> rotate left (CCW).
  // Reverse-in: tail towards the bays -> rotate the other way.
  const rotation: 'L' | 'R' = left === forward ? 'L' : 'R';
  const rotationMs = rotation === 'L' ? cfg.rotation.leftMs90 : cfg.rotation.rightMs90;
  const R = rotationRadiusCm(cfg);
  const entry = bayEntryCm(cfg);

  const override = cfg.route.turnStartOverrideCm[slotId];
  const turnStartCm = (override ?? c) + cfg.route.turnStartTrimCm;
  const turnStartSource = override !== null && override !== undefined ? 'measured-override' : 'slot-centre';

  const speed = parkingSpeed(cfg);
  const cmPerS = 'cmPerS' in speed ? speed.cmPerS : null;
  if ('error' in speed) errors.push(speed.error);
  else if (speed.kind === 'interpolated') {
    warnings.push(`Speed at PWM ${cfg.speed.pwm} is interpolated between measured PWMs (${speed.cmPerS.toFixed(1)} cm/s); measure it for best accuracy.`);
  }
  if (rotationMs === null) {
    errors.push(
      `The 90° ${rotation === 'L' ? 'left' : 'right'} rotation is not calibrated. Run "Calibrate 90° rotation" in Settings (rotation PWM ${cfg.rotation.pwm}).`,
    );
  }

  if (!Number.isFinite(turnStartCm)) {
    errors.push(`${slotId}: turn point is not a finite number.`);
  } else if (turnStartCm < 0 || turnStartCm > L) {
    errors.push(`${slotId}: the turn point x = ${round2(turnStartCm)} cm is outside the 0–${L} cm lane.`);
  }

  // While rotating, the body only enters the bay row where the sweep circle crosses the bay mouth:
  // |x - centre| <= sqrt(R^2 - offset^2). Beyond half a slot that reaches the neighbours (checked
  // precisely by sweptClearance below); otherwise it only dips into the (empty) target bay.
  const reach = R > cfg.lane.bayOffsetCm ? Math.sqrt(R * R - cfg.lane.bayOffsetCm * cfg.lane.bayOffsetCm) : 0;
  if (reach > cfg.lane.slotLengthCm / 2) {
    warnings.push(
      `While rotating, the corners (${round2(R)} cm from the centre) reach ${round2(reach)} cm sideways into the bay row - past this slot's edges. ` +
        `Drive the lane further from the bays (offset > ${Math.ceil(Math.sqrt(R * R - (cfg.lane.slotLengthCm / 2) ** 2))} cm).`,
    );
  }

  const startPose = poseAtX(cfg.route.startCm);
  const approach = turnStartCm - cfg.route.startCm;
  const raw: Omit<PlannedSegment, 'startAlongCm'>[] = [];
  if (Math.abs(approach) > 0.05) {
    const dist = round2(Math.abs(approach));
    raw.push({
      phase: 'APPROACHING',
      move: approach > 0 ? 'F' : 'B',
      distanceCm: dist,
      angleRad: 0,
      durationMs: cmPerS ? Math.round((dist / cmPerS) * 1000) : null,
    });
  }
  raw.push({ phase: 'TURNING', move: rotation, distanceCm: 0, angleRad: Math.PI / 2, durationMs: rotationMs !== null ? Math.round(rotationMs) : null });
  raw.push({
    phase: 'PARKING',
    move: forward ? 'F' : 'B',
    distanceCm: round2(entry),
    angleRad: 0,
    durationMs: cmPerS ? Math.round((entry / cmPerS) * 1000) : null,
  });
  if (raw.length && raw[0].phase === 'APPROACHING' && raw[0].move === 'B') {
    warnings.push(`${slotId}: the turn point is behind the start position, so the rover first reverses ${raw[0].distanceCm} cm.`);
  }

  let along = 0;
  const segments: PlannedSegment[] = raw.map((s) => {
    const seg = { ...s, startAlongCm: round2(along) };
    along += s.distanceCm;
    return seg;
  });
  const finalPose = segments.reduce((p, s) => applySegment(p, s, 1), startPose);

  const sweep = sweptClearance(segments, startPose, cfg, slotId, slotStart, slotEnd);
  for (const [cm, n] of [
    [sweep.intoLowerCm, sweep.lowerNeighbour],
    [sweep.intoHigherCm, sweep.higherNeighbour],
  ] as const) {
    if (cm <= 0.5) continue;
    warnings.push(
      n === 'lot edge'
        ? `Predicted: the body swings ${round2(cm)} cm past the edge of the lot (fine unless there is a wall there).`
        : `Predicted: the body swings ${round2(cm)} cm into ${n}. A car parked in ${n} would be hit.`,
    );
  }
  const halfGap = (cfg.lane.slotLengthCm - cfg.vehicle.widthCm) / 2;
  if (halfGap < 0.5) warnings.push(`Only ${round2(halfGap)} cm clearance per side: there is no room for error.`);
  const lever = entry + cfg.vehicle.lengthCm / 2;
  const headingToleranceDeg = halfGap > 0 ? round2(radToDeg(Math.atan(halfGap / Math.max(lever, 1)))) : 0;

  const bayFar = cfg.lane.bayOffsetCm + cfg.lane.bayDepthCm;
  const finalOuter = Math.abs(finalPose.y) + cfg.vehicle.lengthCm / 2;
  const finalInner = Math.abs(finalPose.y) - cfg.vehicle.lengthCm / 2;
  if (finalInner < cfg.lane.bayOffsetCm - 0.5) {
    warnings.push(`Predicted: about ${round2(cfg.lane.bayOffsetCm - finalInner)} cm of the rover stays outside the bay mouth. Increase the bay entry distance.`);
  }
  if (finalOuter > bayFar + 0.5) {
    warnings.push(`Predicted: the rover would reach ${round2(finalOuter - bayFar)} cm past the bay end (the bay-stop sensor should stop it).`);
  }

  const estimatesUsed = RELEVANT_ESTIMATES.filter((p) => cfg.estimated.includes(p));
  const totalSettleMs = segments.length * cfg.rotation.settleMs;
  const allTimed = segments.every((s) => s.durationMs !== null);
  return {
    slotId,
    entryMode: cfg.route.entryMode,
    feasible: errors.length === 0,
    errors,
    warnings,
    estimatesUsed,
    slotStartCm: slotStart,
    slotEndCm: slotEnd,
    slotCentreCm: c,
    turnStartCm: round2(turnStartCm),
    turnStartSource,
    rotation,
    rotationPwm: cfg.rotation.pwm,
    rotationMs,
    rotationRadiusCm: round2(R),
    entryCm: round2(entry),
    headingToleranceDeg,
    cmPerS,
    segments,
    totalDistanceCm: round2(along),
    totalMoveMs: allTimed ? segments.reduce((a, s) => a + (s.durationMs ?? 0), 0) : null,
    totalSettleMs,
    startPose,
    finalPose,
    sweep,
  };
}

/** Pose after doing `fraction` (0..1) of one segment, starting from `p`. */
export function applySegment(p: Pose, s: PlannedSegment, fraction: number): Pose {
  const f = Math.max(0, Math.min(1, fraction));
  if (s.move === 'L' || s.move === 'R') return rotate(p, s.move, s.angleRad * f);
  return drive(p, s.move, s.distanceCm * f);
}

/** Pose at segment `index` with `fraction` of it done (index past the end = final pose). */
export function poseAtProgress(plan: RoutePlan, index: number, fraction: number): Pose {
  let pose = plan.startPose;
  for (let i = 0; i < plan.segments.length; i++) {
    if (i < index) pose = applySegment(pose, plan.segments[i], 1);
    else if (i === index) return applySegment(pose, plan.segments[i], fraction);
    else break;
  }
  return index >= plan.segments.length ? plan.finalPose : pose;
}

/** Polyline of centre positions along the plan (for drawing). Rotations add no length. */
export function samplePlanPath(plan: RoutePlan, stepCm = 1): { x: number; y: number }[] {
  const pts = [{ x: plan.startPose.x, y: plan.startPose.y }];
  let pose = plan.startPose;
  for (const s of plan.segments) {
    if (s.distanceCm > 0) {
      const n = Math.max(1, Math.ceil(s.distanceCm / stepCm));
      for (let i = 1; i <= n; i++) {
        const q = applySegment(pose, s, i / n);
        pts.push({ x: q.x, y: q.y });
      }
    }
    pose = applySegment(pose, s, 1);
  }
  return pts;
}

/** Clip a polygon to the half-plane side * y >= limit (Sutherland-Hodgman, one edge). */
function clipToBayRow(poly: { x: number; y: number }[], side: number, limit: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const inside = (p: { y: number }) => side * p.y >= limit;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ia = inside(a);
    const ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) {
      const t = (limit - side * a.y) / (side * b.y - side * a.y);
      out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
    }
  }
  return out;
}

function sweptClearance(
  segments: PlannedSegment[],
  startPose: Pose,
  cfg: ParkingConfig,
  slotId: SlotId,
  slotStart: number,
  slotEnd: number,
): SweepClearance {
  const side = cfg.lane.baySide === 'left' ? 1 : -1;
  const mouth = cfg.lane.bayOffsetCm;
  let intoLower = 0;
  let intoHigher = 0;
  const visit = (p: Pose) => {
    for (const q of clipToBayRow(bodyCorners(p, cfg), side, mouth)) {
      intoLower = Math.max(intoLower, slotStart - q.x);
      intoHigher = Math.max(intoHigher, q.x - slotEnd);
    }
  };
  let pose = startPose;
  visit(pose);
  for (const s of segments) {
    const n = s.distanceCm > 0 ? Math.max(1, Math.ceil(s.distanceCm / 0.5)) : 90; // 1 degree steps when rotating
    for (let i = 1; i <= n; i++) visit(applySegment(pose, s, i / n));
    pose = applySegment(pose, s, 1);
  }
  const finalXs = bodyCorners(pose, cfg).map((q) => q.x);
  const idx = SLOT_ORDER.indexOf(slotId);
  return {
    intoLowerCm: round2(Math.max(0, intoLower)),
    intoHigherCm: round2(Math.max(0, intoHigher)),
    finalGapLowerCm: round2(Math.min(...finalXs) - slotStart),
    finalGapHigherCm: round2(slotEnd - Math.max(...finalXs)),
    lowerNeighbour: intoLower > 0 ? (idx > 0 ? SLOT_ORDER[idx - 1] : 'lot edge') : null,
    higherNeighbour: intoHigher > 0 ? (idx < SLOT_ORDER.length - 1 ? SLOT_ORDER[idx + 1] : 'lot edge') : null,
  };
}
