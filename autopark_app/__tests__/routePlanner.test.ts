import { DEFAULT_PARKING_CONFIG, ParkingConfig, rotationRadiusCm, validateParkingConfig } from '../src/core/config/parkingConfig';
import { applySegment, neighbourIntrusionCm, planRoute, poseAtProgress, samplePlanPath } from '../src/core/geometry/routePlanner';
import { makeCalibration, pwmForSpeed, rotationMsFor90 } from '../src/core/geometry/lane';
import { bodyCorners, drive, poseAtX, rotate } from '../src/core/geometry/kinematics';
import { SLOT_IDS } from '../src/core/vision/roi';

/** Calibrated config: your 15.6 cm/s at PWM 130 (default) + 90-degree times. */
const calibrated = (): ParkingConfig => {
  const c: ParkingConfig = JSON.parse(JSON.stringify(DEFAULT_PARKING_CONFIG));
  c.rotation.leftMs90 = 1200;
  c.rotation.rightMs90 = 1150;
  return c;
};

describe('kinematics (rotate in place)', () => {
  test('rotation changes heading only; the centre stays put', () => {
    const p = rotate(poseAtX(40), 'L', Math.PI / 2);
    expect(p.x).toBe(40);
    expect(p.y).toBe(0);
    expect(p.theta).toBeCloseTo(Math.PI / 2, 9);
    expect(rotate(p, 'R', Math.PI / 2).theta).toBeCloseTo(0, 9);
  });
  test('driving follows the heading', () => {
    const p = drive(rotate(poseAtX(40), 'L', Math.PI / 2), 'F', 10);
    expect(p.x).toBeCloseTo(40, 9);
    expect(p.y).toBeCloseTo(10, 9);
    expect(drive(poseAtX(40), 'B', 5).x).toBeCloseTo(35, 9);
  });
  test('22 x 22 cm body: corners at +-11 cm, rotation sweep radius = half diagonal', () => {
    const c = calibrated();
    const xs = bodyCorners(poseAtX(50), c).map((q) => q.x);
    expect(Math.min(...xs)).toBeCloseTo(39, 9);
    expect(Math.max(...xs)).toBeCloseTo(61, 9);
    expect(rotationRadiusCm(c)).toBeCloseTo(Math.hypot(11, 11), 9);
    expect(rotationRadiusCm(c)).toBeCloseTo(15.56, 2);
  });
});

describe('deterministic slot -> route mapping', () => {
  test('segments: straight approach to the slot centre, 90° rotation, straight bay entry', () => {
    const c = calibrated();
    const p = planRoute(c, 'S3');
    expect(p.feasible).toBe(true);
    expect(p.errors).toEqual([]);
    expect(p.segments.map((s) => `${s.phase}:${s.move}`)).toEqual(['APPROACHING:F', 'TURNING:L', 'PARKING:F']);
    expect(p.turnStartCm).toBe(65); // S3 centre
    expect(p.segments[0].distanceCm).toBe(54); // 65 - 11
    expect(p.segments[0].durationMs).toBe(Math.round((54 / 15.6) * 1000));
    expect(p.segments[1].durationMs).toBe(1200);
    expect(p.segments[1].angleRad).toBeCloseTo(Math.PI / 2, 9);
    expect(p.segments[2].distanceCm).toBe(38); // 20 + 36/2
  });

  test('every slot: turn point = slot centre, rover ends centred and perpendicular in the bay', () => {
    const c = calibrated();
    for (const [i, id] of SLOT_IDS.entries()) {
      const p = planRoute(c, id);
      const centre = 26 * i + 13;
      expect(p.turnStartCm).toBe(centre);
      expect(p.finalPose.x).toBeCloseTo(centre, 9);
      expect(p.finalPose.y).toBeCloseTo(38, 9);
      expect(p.finalPose.theta).toBeCloseTo(Math.PI / 2, 9);
      expect(p.sweep.finalGapLowerCm).toBeCloseTo(2, 6); // 22 cm in 26 cm
      expect(p.sweep.finalGapHigherCm).toBeCloseTo(2, 6);
    }
  });

  test('S1 is behind/near the start: no approach if already there; reverse approach if the turn point is behind', () => {
    const c = calibrated();
    c.route.startCm = 13;
    expect(planRoute(c, 'S1').segments[0].phase).toBe('TURNING');
    c.route.startCm = 20;
    const p = planRoute(c, 'S1');
    expect(p.segments[0].move).toBe('B');
    expect(p.segments[0].distanceCm).toBe(7);
    expect(p.warnings.join(' ')).toMatch(/reverses 7 cm/);
  });

  test('reverse-in rotates the other way and reverses into the bay', () => {
    const c = calibrated();
    c.route.entryMode = 'reverse';
    const p = planRoute(c, 'S2');
    expect(p.segments.map((s) => s.move)).toEqual(['F', 'R', 'B']);
    expect(p.segments[1].durationMs).toBe(1150);
    expect(p.finalPose.y).toBeCloseTo(38, 9);
    expect(p.finalPose.theta).toBeCloseTo(-Math.PI / 2, 9); // nose to the lane
  });

  test('right-hand bays mirror the manoeuvre', () => {
    const c = calibrated();
    c.lane.baySide = 'right';
    const p = planRoute(c, 'S4');
    expect(p.rotation).toBe('R');
    expect(p.finalPose.y).toBeCloseTo(-38, 9);
    expect(neighbourIntrusionCm(p)).toBe(0);
  });

  test('uncalibrated rotation or speed makes the plan infeasible (never guessed)', () => {
    const c: ParkingConfig = JSON.parse(JSON.stringify(DEFAULT_PARKING_CONFIG));
    const p = planRoute(c, 'S3');
    expect(p.feasible).toBe(false);
    expect(p.errors.join(' ')).toMatch(/90° left rotation is not calibrated/);
    const d = calibrated();
    d.speed.pwm = 200;
    expect(planRoute(d, 'S3').errors.join(' ')).toMatch(/PWM 200 has not been measured/);
  });

  test('interpolated speed between two measured PWMs is allowed, with a warning', () => {
    const c = calibrated();
    c.speed.calibrations.push(makeCalibration(200, 75, 3000)); // 25 cm/s
    c.speed.pwm = 165;
    const p = planRoute(c, 'S3');
    expect(p.feasible).toBe(true);
    expect(p.cmPerS).toBeCloseTo(15.6 + (25 - 15.6) / 2, 6);
    expect(p.warnings.join(' ')).toMatch(/interpolated/);
  });

  test('rotation sweep stays out of the bays when the lane offset exceeds the sweep radius', () => {
    const c = calibrated(); // offset 20 > 15.56
    for (const id of SLOT_IDS) expect(neighbourIntrusionCm(planRoute(c, id))).toBe(0);
  });

  test('a 22 x 22 cm body rotating in place never reaches a neighbour bay, even close to the bays', () => {
    const c = calibrated();
    c.lane.bayOffsetCm = 12; // corners dip 3.6 cm into the bay row, but only within +-8.5 cm of the slot centre
    for (const id of SLOT_IDS) {
      const p = planRoute(c, id);
      expect(neighbourIntrusionCm(p)).toBe(0);
      expect(p.warnings.join(' ')).not.toMatch(/corners/);
    }
  });

  test('a longer body rotating close to the bays reaches the neighbours (warned + measured)', () => {
    const c = calibrated();
    c.vehicle.lengthCm = 34; // sweep radius 20.2 cm
    c.lane.bayOffsetCm = 13; // reach sqrt(20.2^2 - 13^2) = 15.5 cm > 13 cm half slot
    const p = planRoute(c, 'S3');
    expect(p.warnings.join(' ')).toMatch(/past this slot's edges/);
    expect(neighbourIntrusionCm(p)).toBeGreaterThan(2);
    // a quarter turn left sweeps the corners through the +x side of the bay mouth only
    expect(p.sweep.higherNeighbour).toBe('S4');
    expect(p.sweep.lowerNeighbour).toBeNull();
    const s5 = planRoute(c, 'S5');
    expect(s5.sweep.higherNeighbour).toBe('lot edge'); // not counted as a neighbour
    expect(neighbourIntrusionCm(s5)).toBe(0);
    expect(s5.warnings.join(' ')).toMatch(/past the edge of the lot/);
  });

  test('heading tolerance: 2 cm per side over the bay entry', () => {
    const c = calibrated();
    const p = planRoute(c, 'S3');
    expect(p.headingToleranceDeg).toBeCloseTo((Math.atan(2 / (38 + 11)) * 180) / Math.PI, 1);
  });

  test('a measured per-slot rotation point and the global trim override the slot centre', () => {
    const c = calibrated();
    c.route.turnStartOverrideCm.S2 = 41.5;
    c.route.turnStartTrimCm = -0.5;
    const p = planRoute(c, 'S2');
    expect(p.turnStartCm).toBe(41);
    expect(p.turnStartSource).toBe('measured-override');
    expect(planRoute(c, 'S3').turnStartCm).toBe(64.5);
  });

  test('a turn point outside the lane is an error, not clamped', () => {
    const c = calibrated();
    c.route.turnStartOverrideCm.S5 = 140;
    const p = planRoute(c, 'S5');
    expect(p.feasible).toBe(false);
    expect(p.errors.join(' ')).toMatch(/outside the 0–130 cm lane/);
  });

  test('bay entry too short leaves the rover sticking out; too long hits the end', () => {
    const c = calibrated();
    c.route.bayEntryCm = 20;
    expect(planRoute(c, 'S3').warnings.join(' ')).toMatch(/outside the bay mouth/);
    c.route.bayEntryCm = 60;
    expect(planRoute(c, 'S3').warnings.join(' ')).toMatch(/past the bay end/);
  });

  test('invalid geometry is reported', () => {
    const c = calibrated();
    c.vehicle.widthCm = 26;
    expect(validateParkingConfig(c).join(' ')).toMatch(/less than the bay width/);
    c.vehicle.widthCm = 22;
    c.lane.bayOffsetCm = 10;
    expect(validateParkingConfig(c).join(' ')).toMatch(/more than half the vehicle width/);
  });

  test('deterministic: same input, same plan', () => {
    const c = calibrated();
    expect(JSON.stringify(planRoute(c, 'S2'))).toBe(JSON.stringify(planRoute(c, 'S2')));
  });
});

describe('plan progress (map)', () => {
  test('poseAtProgress walks the same segments', () => {
    const c = calibrated();
    const p = planRoute(c, 'S3');
    expect(poseAtProgress(p, 0, 0)).toEqual(p.startPose);
    expect(poseAtProgress(p, 0, 0.5).x).toBeCloseTo(11 + 27, 9);
    const mid = poseAtProgress(p, 1, 0.5);
    expect(mid.x).toBeCloseTo(65, 9);
    expect(mid.theta).toBeCloseTo(Math.PI / 4, 9);
    expect(poseAtProgress(p, 3, 0)).toEqual(p.finalPose);
    expect(applySegment(p.startPose, p.segments[0], 2).x).toBeCloseTo(65, 9); // clamped
  });
  test('sampled path: along the lane, then straight into the bay (rotation adds no length)', () => {
    const c = calibrated();
    const p = planRoute(c, 'S3');
    const pts = samplePlanPath(p, 1);
    expect(pts[0]).toEqual({ x: 11, y: 0 });
    expect(pts[pts.length - 1].x).toBeCloseTo(65, 9);
    expect(pts[pts.length - 1].y).toBeCloseTo(38, 9);
    expect(pts.length).toBe(1 + 54 + 38);
  });
});

describe('speed and rotation helpers', () => {
  test('pwmForSpeed: exact and interpolated, null outside the measured range', () => {
    const cals = [makeCalibration(130, 46.8, 3000), makeCalibration(200, 75, 3000)]; // 15.6, 25
    expect(pwmForSpeed(cals, 15.6)).toEqual({ pwm: 130, kind: 'measured' });
    expect(pwmForSpeed(cals, 20.3)).toEqual({ pwm: 165, kind: 'interpolated' });
    expect(pwmForSpeed(cals, 30)).toBeNull();
    expect(pwmForSpeed([cals[0]], 20)).toBeNull();
  });
  test('rotationMsFor90 from a trial run', () => {
    expect(rotationMsFor90(1000, 75)).toBe(1200);
    expect(rotationMsFor90(1300, 90)).toBe(1300);
    expect(() => rotationMsFor90(1000, 5)).toThrow(RangeError);
    expect(() => rotationMsFor90(20, 90)).toThrow(/outside/);
  });
});
