/**
 * Rover position estimate for the live 2D map, shared by manual and
 * autonomous operation.
 *
 * - Autonomous: the ESP32 reports which plan segment it is executing and how
 *   far into it it is (straight: cm = time x calibrated speed; rotation: motor
 *   time / calibrated 90-degree time). The pose is that progress applied to the
 *   SAME plan the app previewed and sent.
 * - Manual: the ESP32 reports cumulative forward / reverse / rotate-left /
 *   rotate-right motor-on times. The app converts the increments with the speed
 *   measured for the current PWM and the 90-degree rotation times.
 *
 * Everything here is an ESTIMATE (dead reckoning, no encoders). The UI says so.
 */

import { ParkingConfig } from '../config/parkingConfig';
import { RoverStatus, isAutonomous } from '../esp32/protocol';
import { Pose, drive, frontPoint, poseAtX, rotate } from './kinematics';
import { RoutePlan, applySegment, poseAtProgress } from './routePlanner';
import { speedForPwm } from './lane';

export type TrackSource = 'start' | 'manual' | 'autonomous' | 'unknown';

export interface TrackState {
  pose: Pose | null;
  source: TrackSource;
  /** 'estimate' = dead reckoning with measured values; 'uncalibrated' = some motion could not be converted. */
  quality: 'estimate' | 'uncalibrated' | 'unknown';
  note: string;
  lastFwdMs: number | null;
  lastRevMs: number | null;
  lastLeftMs: number | null;
  lastRightMs: number | null;
  lastUptimeMs: number | null;
  /** Motor-on time that could not be converted (unmeasured PWM / uncalibrated rotation). */
  unaccountedMs: number;
  /** Total straight distance driven since the last reset (cm, estimate). */
  odometerCm: number;
  trail: { x: number; y: number }[];
  /** Plan the rover is executing / executed (by request id). */
  plan: RoutePlan | null;
  planRid: string | null;
  /** Last reported straight distance along the plan (cm). */
  planAlongCm: number;
}

const TRAIL_MAX = 400;

export function initialTrack(cfg: ParkingConfig): TrackState {
  return {
    pose: poseAtX(cfg.route.startCm),
    source: 'start',
    quality: 'estimate',
    note: `Assumed at the start position (rover centre x = ${cfg.route.startCm} cm, facing along the lane).`,
    lastFwdMs: null,
    lastRevMs: null,
    lastLeftMs: null,
    lastRightMs: null,
    lastUptimeMs: null,
    unaccountedMs: 0,
    odometerCm: 0,
    trail: [],
    plan: null,
    planRid: null,
    planAlongCm: 0,
  };
}

/** User placed the rover back at the start mark. */
export function resetTrack(t: TrackState, cfg: ParkingConfig): TrackState {
  return {
    ...initialTrack(cfg),
    lastFwdMs: t.lastFwdMs,
    lastRevMs: t.lastRevMs,
    lastLeftMs: t.lastLeftMs,
    lastRightMs: t.lastRightMs,
    lastUptimeMs: t.lastUptimeMs,
  };
}

export function attachPlan(t: TrackState, plan: RoutePlan, rid: string): TrackState {
  return { ...t, plan, planRid: rid, planAlongCm: 0 };
}

function pushTrail(trail: TrackState['trail'], p: { x: number; y: number }) {
  const last = trail[trail.length - 1];
  if (last && Math.hypot(last.x - p.x, last.y - p.y) < 0.5) return trail;
  const next = [...trail, p];
  return next.length > TRAIL_MAX ? next.slice(next.length - TRAIL_MAX) : next;
}

/** Pose for an autonomous status report on `plan`. */
export function poseForStatus(plan: RoutePlan, s: RoverStatus): Pose {
  if (s.state === 'COMPLETED' && s.reason === 'route finished') return plan.finalPose;
  if (s.seg < 0 || s.seg >= plan.segments.length) return poseAtProgress(plan, plan.segments.length, 1);
  const seg = plan.segments[s.seg];
  let fraction = 0;
  if (!s.settling) {
    if (seg.distanceCm > 0) fraction = s.segDistCm / seg.distanceCm;
    else if (s.segDurMs > 0) fraction = s.segMs / s.segDurMs;
  }
  return poseAtProgress(plan, s.seg, fraction);
}

export function updateTrack(t: TrackState, s: RoverStatus, cfg: ParkingConfig): TrackState {
  // ESP32 reboot: cumulative counters restart from 0 -> re-baseline, keep pose.
  const rebooted = t.lastUptimeMs !== null && s.uptimeMs + 1000 < t.lastUptimeMs;
  const base = (last: number | null, now: number) => (last === null || rebooted ? now : last);
  const dF = Math.max(0, s.fwdMs - base(t.lastFwdMs, s.fwdMs));
  const dB = Math.max(0, s.revMs - base(t.lastRevMs, s.revMs));
  const dL = Math.max(0, s.leftMs - base(t.lastLeftMs, s.leftMs));
  const dR = Math.max(0, s.rightMs - base(t.lastRightMs, s.rightMs));
  const next: TrackState = {
    ...t,
    lastFwdMs: s.fwdMs,
    lastRevMs: s.revMs,
    lastLeftMs: s.leftMs,
    lastRightMs: s.rightMs,
    lastUptimeMs: s.uptimeMs,
  };
  if (rebooted) next.note = 'ESP32 restarted; position kept from before the restart.';

  // ---- autonomous: progress along the plan the app sent
  const ownsPlan = t.plan && t.planRid && s.rid === t.planRid;
  const runActive =
    isAutonomous(s.state) || (ownsPlan && ['COMPLETED', 'OBSTACLE_STOP', 'ABORTED', 'ERROR'].includes(s.state) && t.source === 'autonomous');
  if (ownsPlan && runActive && t.plan) {
    const prevAlong = t.source === 'autonomous' ? t.planAlongCm : 0;
    const pose = poseForStatus(t.plan, s);
    const seg = s.seg >= 0 ? t.plan.segments[s.seg] : null;
    const what = seg ? (seg.move === 'L' || seg.move === 'R' ? `rotating ${seg.move === 'L' ? 'left' : 'right'}` : `${s.distCm.toFixed(1)} of ${s.totalCm.toFixed(1)} cm`) : s.state;
    return {
      ...next,
      pose,
      source: 'autonomous',
      quality: 'estimate',
      note: `Autonomous ${s.slot}: ${what} (time x calibrated speed / rotation).`,
      odometerCm: t.odometerCm + Math.max(0, s.distCm - prevAlong),
      trail: pushTrail(t.trail, { x: pose.x, y: pose.y }),
      planAlongCm: s.distCm,
    };
  }

  if (dF === 0 && dB === 0 && dL === 0 && dR === 0) return { ...next, source: t.source === 'autonomous' ? 'manual' : t.source };
  if (!next.pose) return { ...next, quality: 'unknown' };

  // ---- manual: dead reckoning
  let pose = next.pose;
  let unaccounted = 0;
  const notes: string[] = [];
  let moved = 0;
  if (dF || dB) {
    const speed = speedForPwm(cfg.speed.calibrations, s.pwm);
    if (speed.kind === 'uncalibrated') {
      unaccounted += dF + dB;
      notes.push(`speed at PWM ${s.pwm} is not calibrated`);
    } else {
      pose = drive(pose, 'F', (speed.cmPerS * dF) / 1000);
      pose = drive(pose, 'B', (speed.cmPerS * dB) / 1000);
      moved = (speed.cmPerS * (dF + dB)) / 1000;
      if (speed.kind === 'interpolated') notes.push(`speed interpolated between PWM ${speed.between[0]} and ${speed.between[1]}`);
    }
  }
  for (const [ms, dir, cal] of [
    [dL, 'L', cfg.rotation.leftMs90],
    [dR, 'R', cfg.rotation.rightMs90],
  ] as const) {
    if (!ms) continue;
    if (cal === null || s.pwm !== cfg.rotation.pwm) {
      unaccounted += ms;
      notes.push(cal === null ? `90° ${dir === 'L' ? 'left' : 'right'} rotation not calibrated` : `rotation at PWM ${s.pwm} (calibrated at ${cfg.rotation.pwm})`);
    } else {
      pose = rotate(pose, dir, (Math.PI / 2) * (ms / cal));
    }
  }
  const totalUnaccounted = t.unaccountedMs + unaccounted;
  return {
    ...next,
    pose,
    source: 'manual',
    quality: totalUnaccounted > 0 ? 'uncalibrated' : 'estimate',
    unaccountedMs: totalUnaccounted,
    note:
      notes.length || totalUnaccounted > 0
        ? `Manual: ${notes.join('; ') || 'earlier motion not converted'}${totalUnaccounted > 0 ? ` - ${(totalUnaccounted / 1000).toFixed(1)} s of motion is not on the map` : ''}.`
        : 'Manual: dead reckoning from motor time x calibrated speed / rotation.',
    odometerCm: t.odometerCm + moved,
    trail: pushTrail(t.trail, { x: pose.x, y: pose.y }),
  };
}

/** Lane coordinate (rover-centre x) of the current estimate, or null if unknown. */
export function laneX(t: TrackState): number | null {
  return t.pose ? t.pose.x : null;
}

export { applySegment, frontPoint };
