import { DEFAULT_PARKING_CONFIG, ParkingConfig } from '../src/core/config/parkingConfig';
import { makeCalibration } from '../src/core/geometry/lane';
import { planRoute } from '../src/core/geometry/routePlanner';
import { attachPlan, initialTrack, laneX, poseForStatus, resetTrack, updateTrack } from '../src/core/geometry/tracker';
import { RoverStatus, buildParkRequest, encodeSegments, formEncode, parseStatus, isAutonomous, isLatched } from '../src/core/esp32/protocol';
import { INITIAL_CONNECTION, evaluateLink, isLive, onPollFailure, onPollSuccess } from '../src/core/esp32/connection';
import { SingleFlight, canSelectSlot, manualBlockers, selectableSlots, startBlockers, StartContext } from '../src/core/parking/parkFlow';
import { AnalysisReport, SlotStatus } from '../src/core/vision/classifier';

const cfg = (): ParkingConfig => {
  const c: ParkingConfig = JSON.parse(JSON.stringify(DEFAULT_PARKING_CONFIG));
  c.route.entryMode = 'forward';
  c.speed.calibrations = [makeCalibration(130, 60, 3000)]; // 20 cm/s
  c.rotation.leftMs90 = 1200;
  c.rotation.rightMs90 = 1100;
  return c;
};

const rawStatus = (o: Record<string, unknown> = {}) => ({
  fw: 'autopark-uno-2.0', uptime: 10000, state: 'IDLE', reason: '', movement: 'S', speed: 130, estop: false,
  rid: '', slot: '', seg: -1, segCount: 0, segPhase: '-', segMove: '-', settling: false, segMs: 0, segDurMs: 0,
  segDist: 0, dist: 0, total: 0, elapsed: 0, cms: 0,
  fwdMs: 0, revMs: 0, leftMs: 0, rightMs: 0, blocked: '', calibMs: 0, calibMove: 'F',
  front: 50.2, rear: null, left: 12, right: 30, irFL: 0, irFR: 0, irRL: 0, irRR: 1,
  sensorAge: 40, ...o,
});
const status = (o: Record<string, unknown> = {}): RoverStatus => parseStatus(rawStatus(o));

const report = (statuses: SlotStatus[], compatible = true): AnalysisReport => ({
  schema_version: '1.0', analysis_id: 'x', timestamp: 't', is_demo_data: false,
  provider: { source: 'ai', name: 'local-cnn', model: 'm', runtime: 'r' },
  image: { filename: null, width: 331, height: 153 },
  layout: { name: 'l', placeholder: false, compatible },
  warnings: [],
  slots: statuses.map((s, i) => ({
    slot_id: (['S1', 'S2', 'S3', 'S4', 'S5'] as const)[i], roi: { normalized: { x: 0, y: 0, w: 0.1, h: 0.1 }, pixels: { x: 0, y: 0, w: 10, h: 10 } },
    status: s, confidence: 0.999, reason: '', source: 'ai', error: null, p_occupied: s === 'OCCUPIED' ? 0.999 : 0.001,
  })),
  summary: { empty: 0, occupied: 0, uncertain: 0, total: 5, empty_slot_ids: [] },
});

describe('ESP32 status parsing', () => {
  test('parses a full status and keeps null distances', () => {
    const s = status();
    expect(s.state).toBe('IDLE');
    expect(s.rear).toBeNull();
    expect(s.irRR).toBe(1);
  });
  test('rotation movements and counters are parsed', () => {
    const s = status({ movement: 'L', leftMs: 1234, rightMs: 55, segMove: 'L', segMs: 300, segDurMs: 1200 });
    expect(s.movement).toBe('L');
    expect(s.leftMs).toBe(1234);
    expect(s.rightMs).toBe(55);
    expect(s.segMs).toBe(300);
    expect(status({ movement: 'Q' }).movement).toBe('S');
  });
  test('rejects unknown states and malformed numbers', () => {
    expect(() => parseStatus(rawStatus({ state: 'FLYING' }))).toThrow();
    expect(() => parseStatus(rawStatus({ uptime: 'x' }))).toThrow();
    expect(() => parseStatus(null)).toThrow();
  });
  test('state classes', () => {
    expect(isAutonomous('TURNING')).toBe(true);
    expect(isAutonomous('MANUAL')).toBe(false);
    expect(isLatched('OBSTACLE_STOP')).toBe(true);
    expect(isLatched('COMPLETED')).toBe(false);
  });
});

describe('park request', () => {
  test('encodes the validated plan for the ESP32 (straight in cm, rotation in ms)', () => {
    const c = cfg();
    const plan = planRoute(c, 'S2');
    const req = buildParkRequest(plan, c, 'abc-123');
    expect(req.slot).toBe('S2');
    expect(req.cms).toBe(20);
    expect(req.pwm).toBe(130);
    expect(req.rpwm).toBe(130);
    expect(req.settle).toBe(c.rotation.settleMs);
    expect(req.segs).toBe(encodeSegments(plan));
    const [a, tr, p] = req.segs.split(';');
    expect(a).toBe('A,F,28.00'); // centre 11 -> slot centre 39
    expect(tr).toBe('T,L,1200'); // bays on the left, forward-in
    expect(p).toBe('P,F,38.00'); // 20 cm offset + 36/2 cm
    expect(formEncode({ segs: 'A,F,1.00;T' })).toBe('segs=A%2CF%2C1.00%3BT');
  });
  test('refuses infeasible / uncalibrated plans and bad ids', () => {
    const c: ParkingConfig = JSON.parse(JSON.stringify(DEFAULT_PARKING_CONFIG)); // rotation not calibrated
    expect(() => buildParkRequest(planRoute(c, 'S2'), c, 'abc-123')).toThrow(/not feasible/);
    const ok = cfg();
    expect(() => buildParkRequest(planRoute(ok, 'S2'), ok, 'bad id!')).toThrow(/request id/);
  });
});

describe('connection loss and stale telemetry', () => {
  test('connected -> stale -> disconnected', () => {
    let c = onPollSuccess(INITIAL_CONNECTION, status(), 1000);
    expect(isLive(c, 1200, 1500)).toBe(true);
    c = evaluateLink(c, 3000, 1500);
    expect(c.link).toBe('stale');
    expect(isLive(c, 3000, 1500)).toBe(false);
    c = onPollFailure(c, 'timeout', 3100);
    c = onPollFailure(c, 'timeout', 3400);
    expect(c.link).toBe('stale');
    c = onPollFailure(c, 'timeout', 3700);
    expect(c.link).toBe('disconnected');
    expect(c.status).not.toBeNull(); // last values kept for display, flagged not live
    expect(isLive(c, 3700, 1500)).toBe(false);
    c = onPollSuccess(c, status({ uptime: 12000 }), 4000);
    expect(c.link).toBe('connected');
    expect(c.consecutiveFailures).toBe(0);
  });
  test('detects an ESP32 reboot', () => {
    let c = onPollSuccess(INITIAL_CONNECTION, status({ uptime: 50000 }), 1);
    c = onPollSuccess(c, status({ uptime: 300 }), 2);
    expect(c.bootCount).toBe(1);
  });
});

describe('map tracking', () => {
  test('manual: forward motor time x calibrated speed moves the rover along the lane', () => {
    const c = cfg();
    let t = initialTrack(c);
    expect(laneX(t)).toBe(11);
    t = updateTrack(t, status({ fwdMs: 0 }), c);
    t = updateTrack(t, status({ fwdMs: 1500, movement: 'F', state: 'MANUAL' }), c);
    expect(laneX(t)).toBeCloseTo(41, 6);
    expect(t.source).toBe('manual');
    t = updateTrack(t, status({ fwdMs: 1500, revMs: 500, uptime: 10500 }), c);
    expect(laneX(t)).toBeCloseTo(31, 6);
    expect(t.odometerCm).toBeCloseTo(40, 6);
  });
  test('the speed you measured (15.6 cm/s at PWM 130) is the default', () => {
    const c: ParkingConfig = JSON.parse(JSON.stringify(DEFAULT_PARKING_CONFIG));
    let t = updateTrack(initialTrack(c), status({ fwdMs: 0 }), c);
    t = updateTrack(t, status({ fwdMs: 2000 }), c);
    expect(laneX(t)).toBeCloseTo(11 + 31.2, 6);
  });
  test('manual at an unmeasured PWM is reported as uncalibrated, not guessed', () => {
    const c = cfg();
    let t = updateTrack(initialTrack(c), status({ fwdMs: 0 }), c);
    t = updateTrack(t, status({ fwdMs: 1000, speed: 200 }), c);
    expect(t.quality).toBe('uncalibrated');
    expect(laneX(t)).toBe(11);
    expect(t.unaccountedMs).toBe(1000);
  });
  test('manual rotation turns the heading in place by the calibrated 90° time', () => {
    const c = cfg();
    let t = updateTrack(initialTrack(c), status({ fwdMs: 0 }), c);
    t = updateTrack(t, status({ leftMs: 600 }), c); // half of 1200 ms -> 45 deg
    expect(t.pose!.theta).toBeCloseTo(Math.PI / 4, 6);
    expect(t.pose!.x).toBe(11);
    t = updateTrack(t, status({ leftMs: 1200 }), c); // full 90 deg
    expect(t.pose!.theta).toBeCloseTo(Math.PI / 2, 6);
    t = updateTrack(t, status({ leftMs: 1200, fwdMs: 1000 }), c); // now drives sideways (+y)
    expect(t.pose!.y).toBeCloseTo(20, 6);
    expect(t.pose!.x).toBeCloseTo(11, 6);
    t = updateTrack(t, status({ leftMs: 1200, fwdMs: 1000, rightMs: 1100 }), c); // back to along-lane
    expect(t.pose!.theta).toBeCloseTo(0, 6);
  });
  test('uncalibrated rotation is not guessed', () => {
    const c = cfg();
    c.rotation.rightMs90 = null;
    let t = updateTrack(initialTrack(c), status(), c);
    t = updateTrack(t, status({ rightMs: 900 }), c);
    expect(t.pose!.theta).toBe(0);
    expect(t.quality).toBe('uncalibrated');
    expect(t.note).toMatch(/right rotation not calibrated/);
  });
  test('ESP32 reboot re-baselines the counters', () => {
    const c = cfg();
    let t = updateTrack(initialTrack(c), status({ fwdMs: 5000, uptime: 60000 }), c);
    t = updateTrack(t, status({ fwdMs: 100, uptime: 500 }), c);
    expect(laneX(t)).toBe(11);
    t = updateTrack(t, status({ fwdMs: 600, uptime: 1000 }), c);
    expect(laneX(t)).toBeCloseTo(21, 6);
  });
  test('autonomous: pose follows the reported progress along the SAME plan as the preview', () => {
    const c = cfg();
    const plan = planRoute(c, 'S3');
    let t = attachPlan(initialTrack(c), plan, 'rid-1');
    t = updateTrack(t, status({ state: 'APPROACHING', rid: 'rid-1', slot: 'S3', seg: 0, segDist: 20, dist: 20, total: plan.totalDistanceCm }), c);
    expect(t.source).toBe('autonomous');
    expect(laneX(t)).toBeCloseTo(31, 6);
    // half-way through the rotation
    t = updateTrack(t, status({ state: 'TURNING', rid: 'rid-1', slot: 'S3', seg: 1, segMs: 600, segDurMs: 1200, dist: plan.segments[0].distanceCm }), c);
    expect(t.pose!.x).toBeCloseTo(plan.turnStartCm, 6);
    expect(t.pose!.theta).toBeCloseTo(Math.PI / 4, 6);
    t = updateTrack(t, status({ state: 'COMPLETED', reason: 'route finished', rid: 'rid-1', slot: 'S3', dist: plan.totalDistanceCm, total: plan.totalDistanceCm }), c);
    expect(t.pose!.x).toBeCloseTo(plan.finalPose.x, 6);
    expect(t.pose!.y).toBeCloseTo(38, 6);
    // afterwards manual dead reckoning continues from the parked pose
    const parked = t.pose!;
    t = updateTrack(t, status({ state: 'IDLE', fwdMs: 0 }), c);
    expect(t.pose).toEqual(parked);
  });
  test('settling between segments holds the pose at the segment start', () => {
    const c = cfg();
    const plan = planRoute(c, 'S4');
    const p = poseForStatus(plan, status({ state: 'TURNING', seg: 1, settling: true, segMs: 0, segDurMs: 1200 }));
    expect(p.x).toBeCloseTo(plan.turnStartCm, 6);
    expect(p.theta).toBe(0);
  });
  test('obstacle stop mid-run leaves the pose where the ESP32 stopped', () => {
    const c = cfg();
    const plan = planRoute(c, 'S5');
    let t = attachPlan(initialTrack(c), plan, 'r2');
    t = updateTrack(t, status({ state: 'APPROACHING', rid: 'r2', seg: 0, segDist: 40, dist: 40 }), c);
    t = updateTrack(t, status({ state: 'OBSTACLE_STOP', rid: 'r2', seg: 0, segDist: 41.2, dist: 41.2, reason: 'front 11.0cm' }), c);
    expect(laneX(t)).toBeCloseTo(52.2, 6);
  });
  test('reset puts the rover back at the start mark', () => {
    const c = cfg();
    let t = updateTrack(initialTrack(c), status({ fwdMs: 0 }), c);
    t = updateTrack(t, status({ fwdMs: 2000 }), c);
    t = resetTrack(t, c);
    expect(laneX(t)).toBe(11);
    expect(t.odometerCm).toBe(0);
    t = updateTrack(t, status({ fwdMs: 2000 }), c); // counters are not double counted after reset
    expect(laneX(t)).toBe(11);
  });
});

describe('slot selection and start guards', () => {
  test('only EMPTY slots are selectable', () => {
    const r = report(['EMPTY', 'OCCUPIED', 'UNCERTAIN', 'EMPTY', 'OCCUPIED']);
    expect(selectableSlots(r)).toEqual(['S1', 'S4']);
    expect(canSelectSlot(r, 'S2')).toEqual({ ok: false, reason: 'S2 is OCCUPIED.' });
    expect(canSelectSlot(r, 'S3').ok).toBe(false);
    expect(canSelectSlot(null, 'S1').ok).toBe(false);
  });
  test('an incompatible layout needs an explicit override', () => {
    const r = report(['EMPTY', 'EMPTY', 'EMPTY', 'EMPTY', 'EMPTY'], false);
    expect(selectableSlots(r)).toEqual([]);
    expect(selectableSlots(r, { allowIncompatibleLayout: true })).toHaveLength(5);
  });

  const base = (): StartContext => {
    const c = cfg();
    return {
      report: report(['EMPTY', 'OCCUPIED', 'EMPTY', 'EMPTY', 'EMPTY']),
      slotId: 'S3',
      plan: planRoute(c, 'S3'),
      linkLive: true,
      roverState: 'IDLE',
      estop: false,
      appMode: 'autonomous',
      requestInFlight: false,
      estimatesAcknowledged: true,
      slotConfirmedOnImage: true,
      roverAtStartConfirmed: true,
      analysisAgeMs: 1000,
    };
  };
  test('a valid context has no blockers', () => {
    expect(startBlockers(base())).toEqual([]);
  });
  test.each<[string, Partial<StartContext>, RegExp]>([
    ['occupied slot', { slotId: 'S2' }, /OCCUPIED/],
    ['no slot', { slotId: null }, /Select a destination/],
    ['disconnected', { linkLive: false }, /not connected/],
    ['estop', { estop: true }, /Emergency stop/],
    ['obstacle latched', { roverState: 'OBSTACLE_STOP' }, /OBSTACLE_STOP/],
    ['already running', { roverState: 'TURNING' }, /already in progress/],
    ['manual mode', { appMode: 'manual' }, /manual mode/],
    ['duplicate request', { requestInFlight: true }, /already being sent/],
    ['estimates not acknowledged', { estimatesAcknowledged: false }, /estimated/],
    ['image not confirmed', { slotConfirmedOnImage: false }, /Confirm/],
    ['rover not at start', { roverAtStartConfirmed: false }, /start mark/],
    ['old analysis', { analysisAgeMs: 11 * 60 * 1000 }, /10 minutes/],
  ])('%s blocks the start', (_n, patch, re) => {
    expect(startBlockers({ ...base(), ...patch }).join(' ')).toMatch(re);
  });
  test('single-flight prevents duplicate commands', () => {
    const g = new SingleFlight();
    expect(g.begin('a')).toBe(true);
    expect(g.begin('b')).toBe(false);
    expect(g.busy).toBe(true);
    g.end('b');
    expect(g.busy).toBe(true);
    g.end('a');
    expect(g.begin('b')).toBe(true);
  });
  test('manual control is blocked during autonomous runs and latched stops', () => {
    expect(manualBlockers('APPROACHING', false, true).join(' ')).toMatch(/abort/);
    expect(manualBlockers('ABORTED', false, true).join(' ')).toMatch(/reset/);
    expect(manualBlockers('IDLE', true, true).join(' ')).toMatch(/Emergency/);
    expect(manualBlockers('IDLE', false, false).join(' ')).toMatch(/not connected/);
    expect(manualBlockers('COMPLETED', false, true)).toEqual([]);
  });
});
