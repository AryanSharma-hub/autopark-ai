/**
 * App <-> firmware integration test (software only, no rover).
 *
 * Builds firmware/sim/rover_sim.cpp, which runs the REAL firmware controller
 * (ParkingController.h + StatusJson.h) behind the same HTTP endpoints as the
 * ESP32, and drives it with the app's Esp32Client, route planner and request
 * encoder. Skipped automatically if no C++ compiler is available.
 */
import { execFileSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Esp32Client } from '../src/services/esp32Client';
import { DEFAULT_PARKING_CONFIG, ParkingConfig } from '../src/core/config/parkingConfig';
import { makeCalibration } from '../src/core/geometry/lane';
import { planRoute } from '../src/core/geometry/routePlanner';
import { buildParkRequest, newRequestId, RoverStatus } from '../src/core/esp32/protocol';
import { attachPlan, initialTrack, laneX, updateTrack } from '../src/core/geometry/tracker';

const FW = path.join(__dirname, '..', '..', 'firmware');
const BIN = path.join(os.tmpdir(), `rover_sim_${process.pid}`);
let compiler: string | null = null;
for (const c of ['g++', 'clang++']) {
  try {
    execFileSync(c, ['--version'], { stdio: 'ignore' });
    compiler = c;
    break;
  } catch {
    /* try next */
  }
}
const d = compiler ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d('app <-> firmware controller over HTTP (rover_sim)', () => {
  let proc: ChildProcess;
  let port: number;
  let client: Esp32Client;
  let base: string;

  const sim = async (q: string) => (await fetch(`${base}${q}`)).text();
  const fresh = async () => {
    // abort anything running and clear latches between tests
    await client.abort();
    await client.reset();
    await sim('/sim/sensors?front=80&rear=80&irFL=0&irFR=0&irRL=0&irRR=0');
    await sim('/sim/freeze?front=0&rear=0');
  };
  /** Poll /status (which is also the app heartbeat) until `until` is true. */
  const pollUntil = async (until: (s: RoverStatus) => boolean, timeoutMs = 8000, every = 100) => {
    const t0 = Date.now();
    let s = await client.status();
    while (!until(s)) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout; last state ${s.state} ${s.reason}`);
      await sleep(every);
      s = await client.status();
    }
    return s;
  };
  const cfg = (): ParkingConfig => {
    const c: ParkingConfig = JSON.parse(JSON.stringify(DEFAULT_PARKING_CONFIG));
    // Fast simulated rover so the run takes ~2 s: 100 cm/s at PWM 130.
    c.speed.calibrations = [makeCalibration(130, 300, 3000)];
    c.rotation.settleMs = 100;
    c.rotation.leftMs90 = 300;
    c.rotation.rightMs90 = 300;
    return c;
  };

  beforeAll(async () => {
    execFileSync(compiler!, ['-std=c++17', '-O2', `-I${path.join(FW, 'autopark_esp32')}`, path.join(FW, 'sim', 'rover_sim.cpp'), '-o', BIN]);
    port = 18000 + Math.floor(Math.random() * 2000);
    proc = spawn(BIN, [String(port)], { stdio: 'ignore' });
    base = `http://127.0.0.1:${port}`;
    client = new Esp32Client(base, 1500);
    for (let i = 0; i < 50; i++) {
      try {
        await client.status();
        return;
      } catch {
        await sleep(100);
      }
    }
    throw new Error('rover_sim did not start');
  }, 60000);

  afterAll(() => {
    proc?.kill();
    if (fs.existsSync(BIN)) fs.unlinkSync(BIN);
  });

  test('status parses with the app protocol; your /data format is kept', async () => {
    const s = await client.status();
    expect(s.state).toBe('IDLE');
    const raw = JSON.parse(await sim('/sensors'));
    for (const k of ['irFL', 'irFR', 'irRL', 'irRR', 'front', 'rear', 'left', 'right', 'speed', 'movement', 'leftMs', 'rightMs']) {
      expect(raw).toHaveProperty(k);
    }
    const data = JSON.parse(await sim('/data'));
    expect(data.distances.map((d: { name: string }) => d.name)).toEqual(['Front', 'Rear', 'Left', 'Right']);
    expect(data.ir.map((d: { name: string }) => d.name)).toEqual(['Front Left', 'Front Right', 'Rear Left', 'Rear Right']);
    expect(typeof data.speed).toBe('number');
  });

  test('autonomous parking: plan -> request -> ESP32 executes -> COMPLETED; map follows', async () => {
    await fresh();
    const c = cfg();
    const plan = planRoute(c, 'S2');
    const rid = newRequestId();
    const req = buildParkRequest(plan, c, rid);
    let track = attachPlan(initialTrack(c), plan, rid);
    const res = await client.park(req);
    expect(res).toMatchObject({ ok: true, result: 'OK' });
    const states = new Set<string>();
    let sawRotation = false;
    const s = await pollUntil((st) => {
      states.add(st.state);
      if (st.movement === 'L') sawRotation = true;
      track = updateTrack(track, st, c);
      return st.state === 'COMPLETED';
    }, 10000, 50);
    expect(states).toEqual(new Set(['APPROACHING', 'TURNING', 'PARKING', 'COMPLETED']));
    expect(sawRotation).toBe(true);
    expect(s.distCm).toBeCloseTo(plan.totalDistanceCm, 1);
    expect(s.slot).toBe('S2');
    track = updateTrack(track, s, c);
    expect(track.pose!.x).toBeCloseTo(plan.finalPose.x, 1);
    expect(track.pose!.theta).toBeCloseTo(Math.PI / 2, 6);
    expect(JSON.parse(await sim('/sim/outputs'))).toMatchObject({ motor: 'S', uno: 'S' });
  }, 20000);

  test('duplicate parking requests are not executed twice', async () => {
    await fresh();
    const c = cfg();
    const plan = planRoute(c, 'S1');
    const req = buildParkRequest(plan, c, newRequestId());
    const [a, b] = await Promise.all([client.park(req), client.park(req)]);
    expect([a.result, b.result].sort()).toEqual(['DUPLICATE', 'OK']);
    const other = await client.park(buildParkRequest(plan, c, newRequestId()));
    expect(other).toMatchObject({ ok: false, httpStatus: 409, result: 'BUSY' });
    await pollUntil((s) => s.state === 'COMPLETED', 10000, 50);
    const again = await client.park(req);
    expect(again.result).toBe('DUPLICATE');
  }, 20000);

  test('manual commands are refused during autonomous parking', async () => {
    await fresh();
    const c = cfg();
    await client.park(buildParkRequest(planRoute(c, 'S5'), c, newRequestId()));
    expect((await client.move('B')).httpStatus).toBe(409);
    expect((await client.move('L')).httpStatus).toBe(409);
    expect((await client.timed('F', 2000)).httpStatus).toBe(409);
    expect((await client.setSpeed(255)).httpStatus).toBe(409);
    expect(await client.abort()).toMatchObject({ ok: true });
    expect((await client.status()).state).toBe('ABORTED');
  });

  test('obstacle during approach -> OBSTACLE_STOP, latched until reset', async () => {
    await fresh();
    const c = cfg();
    c.speed.calibrations = [makeCalibration(130, 60, 3000)]; // 20 cm/s: slow enough to inject
    await client.park(buildParkRequest(planRoute(c, 'S5'), c, newRequestId()));
    await pollUntil((s) => s.state === 'APPROACHING' && !s.settling && s.movement === 'F', 3000, 30);
    await sim('/sim/sensors?front=8');
    const s = await pollUntil((st) => st.state === 'OBSTACLE_STOP', 3000, 30);
    expect(s.reason).toMatch(/^front 8\.0cm/);
    expect(s.movement).toBe('S');
    await sim('/sim/sensors?front=80');
    expect((await client.move('F')).httpStatus).toBe(423);
    expect((await client.reset()).ok).toBe(true);
    expect((await client.move('F')).ok).toBe(true);
    await client.move('S');
  }, 15000);

  test('emergency stop latches and stops the UNO', async () => {
    await fresh();
    await client.move('F');
    expect((await client.estop()).ok).toBe(true);
    const s = await client.status();
    expect(s.estop).toBe(true);
    expect(s.movement).toBe('S');
    expect(JSON.parse(await sim('/sim/outputs')).uno).toBe('S');
    expect((await client.move('F')).httpStatus).toBe(423);
    await client.reset();
    expect((await client.status()).estop).toBe(false);
  });

  test('connection loss: app goes silent -> ESP32 aborts with ERROR (heartbeat)', async () => {
    await fresh();
    const c = cfg();
    c.speed.calibrations = [makeCalibration(130, 30, 3000)]; // slow: 10 cm/s, run lasts > 5 s
    c.safety.heartbeatTimeoutMs = 700;
    await client.park(buildParkRequest(planRoute(c, 'S5'), c, newRequestId()));
    await sleep(1200); // no requests at all
    const s = await client.status();
    expect(s.state).toBe('ERROR');
    expect(s.reason).toBe('heartbeat lost');
  }, 10000);

  test('Wi-Fi client disconnect stops a run', async () => {
    await fresh();
    const c = cfg();
    c.speed.calibrations = [makeCalibration(130, 30, 3000)];
    await client.park(buildParkRequest(planRoute(c, 'S4'), c, newRequestId()));
    await sim('/sim/disconnect');
    const s = await client.status();
    expect(s.state).toBe('ERROR');
    expect(s.reason).toMatch(/disconnected/);
  });

  test('manual move expires without repeats; repeats keep it alive', async () => {
    await fresh();
    expect((await client.move('F')).ok).toBe(true);
    await sleep(400);
    expect((await client.status()).movement).toBe('F'); // status polls keep the link, not the motor
    await sleep(900);
    let s = await client.status();
    expect(s.movement).toBe('S');
    expect(s.reason).toMatch(/watchdog/);
    for (let i = 0; i < 6; i++) {
      await client.move('B');
      await sleep(250);
    }
    s = await client.status();
    expect(s.movement).toBe('B');
    expect(s.revMs).toBeGreaterThan(1000);
    await client.move('S');
  }, 10000);

  test('speed calibration run reports the actual driving time', async () => {
    await fresh();
    const r = await client.calibrate('F', 130, 1000, 12);
    expect(r.ok).toBe(true);
    const s = await pollUntil((st) => st.state === 'IDLE' && st.calibMs > 0, 5000, 50);
    expect(s.calibMs).toBeGreaterThanOrEqual(1000);
    expect(s.calibMs).toBeLessThan(1100);
  });

  test('90° rotation calibration over HTTP: rotates at the requested PWM for the requested time', async () => {
    await fresh();
    const r = await client.calibrate('L', 150, 800, 12);
    expect(r.ok).toBe(true);
    const during = await pollUntil((st) => st.state === 'CALIBRATING' && st.movement === 'L', 3000, 30);
    expect(during.pwm).toBe(150);
    expect(JSON.parse(await sim('/sim/outputs')).uno).toBe('L,150');
    const done = await pollUntil((st) => st.state === 'IDLE' && st.calibMs > 0, 5000, 50);
    expect(done.calibMs).toBeGreaterThanOrEqual(800);
    expect(done.calibMove).toBe('L');
    expect(done.movement).toBe('S');
    expect(await client.calibrate('X' as never, 150, 800, 12)).toMatchObject({ httpStatus: 400, result: 'INVALID' });
  });

  test('timed move and live speed change (your web page features)', async () => {
    await fresh();
    expect((await client.setSpeed(170)).ok).toBe(true);
    expect((await client.timed('R', 600)).ok).toBe(true);
    let s = await client.status();
    expect(s.movement).toBe('R');
    expect(s.pwm).toBe(170);
    expect(JSON.parse(await sim('/sim/outputs')).uno).toBe('R,170');
    s = await pollUntil((st) => st.movement === 'S', 3000, 50);
    expect(s.rightMs).toBeGreaterThanOrEqual(580);
    await client.setSpeed(130);
  });

  test('invalid park requests are rejected by the firmware validator', async () => {
    await fresh();
    const c = cfg();
    const req = buildParkRequest(planRoute(c, 'S3'), c, newRequestId());
    expect(await client.park({ ...req, segs: 'A,F,170,10.00' })).toMatchObject({ httpStatus: 400, result: 'INVALID' });
    expect(await client.park({ ...req, segs: 'T,F,1200' })).toMatchObject({ httpStatus: 400, result: 'INVALID' });
    expect(await client.park({ ...req, segs: 'A,L,10.00' })).toMatchObject({ httpStatus: 400, result: 'INVALID' });
    expect(await client.park({ ...req, rpwm: 0 })).toMatchObject({ httpStatus: 400 });
    expect(await client.park({ ...req, slot: 'S12' })).toMatchObject({ httpStatus: 400 });
    expect(await client.park({ ...req, cms: 0 })).toMatchObject({ httpStatus: 400 });
  });

  test('stale front sensor during autonomous motion -> ERROR', async () => {
    await fresh();
    const c = cfg();
    c.speed.calibrations = [makeCalibration(130, 30, 3000)];
    await client.park(buildParkRequest(planRoute(c, 'S5'), c, newRequestId()));
    await pollUntil((s) => s.movement === 'F', 3000, 30);
    await sim('/sim/freeze?front=1');
    const s = await pollUntil((st) => st.state === 'ERROR', 3000, 50);
    expect(s.reason).toMatch(/front ultrasonic not updating/);
  });

  test('unreachable ESP32 is reported as a network failure, never as success', async () => {
    const dead = new Esp32Client('http://127.0.0.1:1', 300);
    const r = await dead.move('F');
    expect(r).toMatchObject({ ok: false, result: 'NETWORK' });
    await expect(dead.status()).rejects.toThrow();
  });

  test('manual driving updates the map from motor time', async () => {
    await fresh();
    const c = cfg();
    let track = initialTrack(c);
    track = updateTrack(track, await client.status(), c);
    for (let i = 0; i < 4; i++) {
      await client.move('F');
      await sleep(200);
    }
    await client.move('S');
    const s = await client.status();
    track = updateTrack(track, s, c);
    const x = laneX(track)!;
    expect(x).toBeGreaterThan(11 + 70); // ~0.8 s at 100 cm/s from the start mark
    expect(x).toBeLessThan(11 + 95);
  });

  test('manual rotation turns the rover on the map', async () => {
    await fresh();
    const c = cfg();
    c.rotation.pwm = 130;
    c.rotation.leftMs90 = 600;
    await client.setSpeed(130);
    let track = updateTrack(initialTrack(c), await client.status(), c);
    expect((await client.timed('L', 600)).ok).toBe(true);
    await pollUntil((st) => st.movement === 'S', 3000, 50);
    track = updateTrack(track, await client.status(), c);
    expect(track.pose!.theta).toBeGreaterThan((Math.PI / 2) * 0.9);
    expect(track.pose!.theta).toBeLessThan((Math.PI / 2) * 1.15);
    expect(track.pose!.x).toBe(11);
  });
});
