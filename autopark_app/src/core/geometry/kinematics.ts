/**
 * Kinematics for a four-motor rover that drives straight and rotates in place
 * (left wheels one way, right wheels the other; see firmware/uno_motor).
 *
 * Pose = rover CENTRE (x, y) and heading theta (rad, 0 = +x along the lane,
 * positive = counter-clockwise, towards +y / left). Rotating in place changes
 * theta only; the centre stays put.
 *
 * Shared by the route planner (planned path), the live map (pose along the
 * plan from ESP32 progress) and manual odometry (dead reckoning).
 */

import { ParkingConfig } from '../config/parkingConfig';

export interface Pose {
  x: number;
  y: number;
  theta: number;
}

export type Straight = 'F' | 'B';
export type Rotation = 'L' | 'R';
export type Move = Straight | Rotation;

export function degToRad(d: number): number {
  return (d * Math.PI) / 180;
}
export function radToDeg(r: number): number {
  return (r * 180) / Math.PI;
}

/** Drive straight `distanceCm` (>= 0) forward or backward along the heading. */
export function drive(p: Pose, dir: Straight, distanceCm: number): Pose {
  const s = dir === 'F' ? distanceCm : -distanceCm;
  return { x: p.x + s * Math.cos(p.theta), y: p.y + s * Math.sin(p.theta), theta: p.theta };
}

/** Rotate in place by `angleRad` (>= 0); L = counter-clockwise, R = clockwise. */
export function rotate(p: Pose, dir: Rotation, angleRad: number): Pose {
  return { x: p.x, y: p.y, theta: p.theta + (dir === 'L' ? angleRad : -angleRad) };
}

/** Pose with the centre at lane coordinate x on the driving line, heading +x. */
export function poseAtX(x: number): Pose {
  return { x, y: 0, theta: 0 };
}

/** Front bumper centre point (for drawing the nose). */
export function frontPoint(p: Pose, cfg: ParkingConfig): { x: number; y: number } {
  const d = cfg.vehicle.lengthCm / 2;
  return { x: p.x + d * Math.cos(p.theta), y: p.y + d * Math.sin(p.theta) };
}

/** Four body corners: rear-left, rear-right, front-right, front-left. */
export function bodyCorners(p: Pose, cfg: ParkingConfig): { x: number; y: number }[] {
  const hl = cfg.vehicle.lengthCm / 2;
  const hw = cfg.vehicle.widthCm / 2;
  const c = Math.cos(p.theta);
  const s = Math.sin(p.theta);
  const pts: [number, number][] = [
    [-hl, hw],
    [-hl, -hw],
    [hl, -hw],
    [hl, hw],
  ];
  return pts.map(([lx, ly]) => ({ x: p.x + lx * c - ly * s, y: p.y + lx * s + ly * c }));
}

/** Heading as compass-free text relative to the lane ("along lane", "facing bays", ...). */
export function normalizeAngle(theta: number): number {
  let a = theta % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}
