import { slotAt, slotInterval, slotCentreCm, estimateDistanceCm, timeForDistanceMs, makeCalibration, speedForPwm, upsertCalibration, parkingSpeed } from '../src/core/geometry/lane';
import { DEFAULT_PARKING_CONFIG, ParkingConfig, laneLengthCm, mergeWithDefaults, validateParkingConfig } from '../src/core/config/parkingConfig';

const clone = (): ParkingConfig => JSON.parse(JSON.stringify(DEFAULT_PARKING_CONFIG));

describe('slot indexing: slotIndex = floor(x / 26) + 1 on [0, 130)', () => {
  test.each([
    [0, 'S1'],
    [25.99, 'S1'],
    [26, 'S2'],
    [51.99, 'S2'],
    [52, 'S3'],
    [77.99, 'S3'],
    [78, 'S4'],
    [103.99, 'S4'],
    [104, 'S5'],
    [129.99, 'S5'],
  ])('x = %p cm -> %s', (x, slot) => {
    const p = slotAt(x);
    expect(p.kind).toBe('slot');
    if (p.kind === 'slot') expect(p.slotId).toBe(slot);
  });

  test('x = 130 is the lane end, not a sixth slot', () => {
    expect(slotAt(130)).toEqual({ kind: 'end' });
  });
  test('out-of-range and invalid values', () => {
    expect(slotAt(-0.01)).toEqual({ kind: 'before-start' });
    expect(slotAt(130.01)).toEqual({ kind: 'beyond-end' });
    expect(slotAt(1e9)).toEqual({ kind: 'beyond-end' });
    expect(slotAt(NaN)).toEqual({ kind: 'invalid' });
    expect(slotAt(Infinity)).toEqual({ kind: 'invalid' });
    expect(slotAt(-Infinity)).toEqual({ kind: 'invalid' });
    expect(slotAt('12' as unknown as number)).toEqual({ kind: 'invalid' });
  });
  test('no x in [0,130) ever maps outside S1-S5', () => {
    for (let x = 0; x < 130; x += 0.01) {
      const p = slotAt(x);
      expect(p.kind).toBe('slot');
    }
  });
  test('slot intervals and centres', () => {
    expect(slotInterval('S1')).toEqual({ startCm: 0, endCm: 26 });
    expect(slotInterval('S5')).toEqual({ startCm: 104, endCm: 130 });
    expect(slotCentreCm('S3')).toBe(65);
    expect(laneLengthCm(DEFAULT_PARKING_CONFIG)).toBe(130);
  });
});

describe('speed x time distance estimation', () => {
  test('distance = speed * time', () => {
    expect(estimateDistanceCm(20, 2.5)).toBe(50);
    expect(estimateDistanceCm(0, 10)).toBe(0);
    expect(estimateDistanceCm(13.3, 0)).toBe(0);
  });
  test('rejects negative or non-finite inputs', () => {
    expect(() => estimateDistanceCm(-1, 1)).toThrow(RangeError);
    expect(() => estimateDistanceCm(1, -1)).toThrow(RangeError);
    expect(() => estimateDistanceCm(NaN, 1)).toThrow(RangeError);
    expect(() => estimateDistanceCm(1, Infinity)).toThrow(RangeError);
  });
  test('time for distance is the inverse', () => {
    expect(timeForDistanceMs(50, 20)).toBe(2500);
    expect(() => timeForDistanceMs(10, 0)).toThrow();
  });
});

describe('speed calibration', () => {
  test('cm/s from a measured run', () => {
    const c = makeCalibration(130, 61.5, 3000, new Date('2026-10-27T00:00:00Z'));
    expect(c.cmPerS).toBeCloseTo(20.5, 6);
    expect(c.measuredAt).toBe('2026-10-27T00:00:00.000Z');
  });
  test('rejects nonsense measurements', () => {
    expect(() => makeCalibration(130, 0, 3000)).toThrow();
    expect(() => makeCalibration(130, 50, 100)).toThrow();
    expect(() => makeCalibration(300, 50, 3000)).toThrow();
  });
  test('PWM without a measurement is uncalibrated (PWM is not a speed)', () => {
    expect(speedForPwm([], 130).kind).toBe('uncalibrated');
    const cfg = clone();
    cfg.speed.calibrations = [];
    expect('error' in parkingSpeed(cfg)).toBe(true);
  });
  test('exact and interpolated lookups; extrapolation refused', () => {
    let list = upsertCalibration([], makeCalibration(100, 30, 3000));
    list = upsertCalibration(list, makeCalibration(160, 60, 3000));
    expect(speedForPwm(list, 100)).toMatchObject({ kind: 'measured', cmPerS: 10 });
    const mid = speedForPwm(list, 130);
    expect(mid.kind).toBe('interpolated');
    if (mid.kind === 'interpolated') expect(mid.cmPerS).toBeCloseTo(15, 6);
    expect(speedForPwm(list, 200).kind).toBe('uncalibrated');
    expect(speedForPwm(list, 80).kind).toBe('uncalibrated');
  });
  test('recalibrating a PWM replaces the old value', () => {
    let list = upsertCalibration([], makeCalibration(130, 30, 3000));
    list = upsertCalibration(list, makeCalibration(130, 45, 3000));
    expect(list).toHaveLength(1);
    expect(list[0].cmPerS).toBeCloseTo(15);
  });
  test('autonomous parking needs a measured speed, or one interpolated between two measured PWMs', () => {
    const cfg = clone();
    cfg.speed.calibrations = [makeCalibration(100, 30, 3000), makeCalibration(160, 60, 3000)];
    cfg.speed.pwm = 130; // between two measured points
    expect(parkingSpeed(cfg)).toEqual({ cmPerS: 15, kind: 'interpolated' });
    cfg.speed.pwm = 200; // outside the measured range: not guessed
    expect('error' in parkingSpeed(cfg)).toBe(true);
    cfg.speed.pwm = 130;
    cfg.speed.calibrations.push(makeCalibration(130, 45, 3000));
    expect(parkingSpeed(cfg)).toEqual({ cmPerS: 15, kind: 'measured' });
  });
});

describe('configuration', () => {
  test('defaults are valid and carry the values you gave', () => {
    expect(validateParkingConfig(DEFAULT_PARKING_CONFIG)).toEqual([]);
    expect(DEFAULT_PARKING_CONFIG.lane.slotLengthCm).toBe(26);
    expect(DEFAULT_PARKING_CONFIG.lane.slotCount * DEFAULT_PARKING_CONFIG.lane.slotLengthCm).toBe(130);
    // 22 x 22 cm rover, 22 cm + 4 cm margin = 26 cm bay
    expect(DEFAULT_PARKING_CONFIG.vehicle).toEqual({ lengthCm: 22, widthCm: 22 });
    expect(DEFAULT_PARKING_CONFIG.lane.slotLengthCm - DEFAULT_PARKING_CONFIG.vehicle.widthCm).toBe(4);
    // measured speed 15.6 cm/s, recorded at the firmware's default PWM 130
    expect(DEFAULT_PARKING_CONFIG.speed.pwm).toBe(130);
    expect(DEFAULT_PARKING_CONFIG.speed.calibrations).toEqual([expect.objectContaining({ pwm: 130, cmPerS: 15.6, source: 'user' })]);
    expect(parkingSpeed(DEFAULT_PARKING_CONFIG)).toEqual({ cmPerS: 15.6, kind: 'measured' });
    // rotation must be calibrated on the real rover, never assumed
    expect(DEFAULT_PARKING_CONFIG.rotation.leftMs90).toBeNull();
    expect(DEFAULT_PARKING_CONFIG.rotation.rightMs90).toBeNull();
    expect(DEFAULT_PARKING_CONFIG.estimated).not.toContain('vehicle.widthCm');
    expect(DEFAULT_PARKING_CONFIG.estimated).not.toContain('vehicle.lengthCm');
    expect(DEFAULT_PARKING_CONFIG.estimated).toContain('lane.bayOffsetCm');
  });
  test('invalid values are reported', () => {
    const cfg = clone();
    cfg.rotation.leftMs90 = 20;
    cfg.rotation.pwm = 300;
    cfg.safety.obstacleStopCm = 0;
    const errs = validateParkingConfig(cfg).join(' ');
    expect(errs).toMatch(/90° left rotation time/);
    expect(errs).toMatch(/Rotation PWM/);
    expect(errs).toMatch(/Obstacle stop/);
  });
  test('merging a partial saved config keeps defaults and stable slot ids', () => {
    const merged = mergeWithDefaults({ version: 3, route: { turnStartOverrideCm: { S3: 60 } } } as never);
    expect(merged.route.turnStartOverrideCm).toEqual({ S1: null, S2: null, S3: 60, S4: null, S5: null });
    expect(merged.vehicle.lengthCm).toBe(22);
    expect(mergeWithDefaults(null)).toEqual(DEFAULT_PARKING_CONFIG);
  });
  test('a saved config from the servo-steering version starts fresh but keeps network + speed calibrations', () => {
    const old = { version: 2, steering: { servoLeftDeg: 150 }, esp32: { host: '10.0.0.5' }, speed: { pwm: 160, calibrations: [makeCalibration(160, 60, 3000)] } };
    const m = mergeWithDefaults(old as never);
    expect(m.version).toBe(3);
    expect((m as unknown as Record<string, unknown>).steering).toBeUndefined();
    expect(m.esp32.host).toBe('10.0.0.5');
    expect(m.speed.calibrations.map((c) => c.pwm)).toEqual([130, 160]);
    expect(m.speed.pwm).toBe(130);
  });
});
