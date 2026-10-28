/**
 * UI rendering tests (jest-expo, Android preset). They check that screens are
 * driven by real app state - not that pixels look right.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { LaneMap } from '../src/components/LaneMap';
import { DEFAULT_PARKING_CONFIG, ParkingConfig } from '../src/core/config/parkingConfig';
import { makeCalibration } from '../src/core/geometry/lane';
import { planRoute } from '../src/core/geometry/routePlanner';
import { attachPlan, initialTrack, updateTrack } from '../src/core/geometry/tracker';
import { parseStatus } from '../src/core/esp32/protocol';
import Dashboard from '../src/app/(tabs)/index';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
}));

const cfg = (): ParkingConfig => {
  const c: ParkingConfig = JSON.parse(JSON.stringify(DEFAULT_PARKING_CONFIG));
  c.speed.calibrations = [makeCalibration(130, 60, 3000)];
  c.rotation.leftMs90 = 1200;
  c.rotation.rightMs90 = 1200;
  return c;
};
const status = (o: Record<string, unknown>) =>
  parseStatus({ uptime: 5000, state: 'IDLE', speed: 130, movement: 'S', fwdMs: 0, revMs: 0, leftMs: 0, rightMs: 0, front: 50, rear: 50, left: 1, right: 1, ...o });

/** All strings drawn by react-native-svg <Text> (rendered as TSpan `content`). */
function svgTexts(json: unknown): string[] {
  const out: string[] = [];
  const walk = (n: any) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.props?.content === 'string') out.push(n.props.content);
    walk(n.children);
  };
  walk(json);
  return out;
}

/** Collect the rover body polygon's points attribute from the rendered SVG tree. */
function roverPoints(json: unknown): string | null {
  let found: string | null = null;
  const walk = (n: any) => {
    if (!n || found) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type && String(n.type).includes('RNSVGPath') && n.props?.d && n.props?.fillOpacity === 0.35) found = n.props.d;
    if (n.props?.points && n.props?.fillOpacity === 0.35) found = String(n.props.points);
    walk(n.children);
  };
  walk(json);
  return found;
}

describe('LaneMap', () => {
  test('renders five bays with classification colours and labels', async () => {
    const c = cfg();
    const r = await render(
      <LaneMap config={c} pose={initialTrack(c).pose} live statuses={{ S1: 'EMPTY', S2: 'OCCUPIED', S3: 'UNCERTAIN' }} selectedSlot="S1" />,
    );
    const texts = svgTexts(r.toJSON());
    for (const id of ['S1', 'S2', 'S3', 'S4', 'S5']) expect(texts).toContain(id);
    expect(texts).toEqual(expect.arrayContaining(['EMPTY', 'OCCUPIED', 'UNCERTAIN', '0', '26', '52', '78', '104', '130']));
  });

  test('rover moves on the map as manual telemetry arrives', async () => {
    const c = cfg();
    let track = updateTrack(initialTrack(c), status({ fwdMs: 0 }), c);
    const r = await render(<LaneMap config={c} pose={track.pose} live />);
    const before = roverPoints(r.toJSON());
    track = updateTrack(track, status({ fwdMs: 2000, movement: 'F', state: 'MANUAL' }), c);
    await r.rerender(<LaneMap config={c} pose={track.pose} live />);
    const after = roverPoints(r.toJSON());
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(after).not.toEqual(before);
  });

  test('autonomous run: rover follows the plan and the turn point is drawn', async () => {
    const c = cfg();
    const plan = planRoute(c, 'S3');
    let track = attachPlan(initialTrack(c), plan, 'r1');
    track = updateTrack(track, status({ state: 'TURNING', rid: 'r1', seg: 1, segMs: 300, segDurMs: 1200, dist: plan.segments[0].distanceCm, total: plan.totalDistanceCm }), c);
    expect(track.pose!.x).toBeCloseTo(plan.turnStartCm, 6);
    const r = await render(<LaneMap config={c} pose={track.pose} trail={track.trail} plan={plan} live selectedSlot="S3" roverLabel="TURNING" />);
    const texts = svgTexts(r.toJSON());
    expect(texts).toContain(`rotate left 90° at ${plan.turnStartCm.toFixed(1)}`);
    expect(texts).toContain('TURNING');
  });

  test('stale telemetry is labelled instead of shown as live', async () => {
    const c = cfg();
    const r = await render(<LaneMap config={c} pose={initialTrack(c).pose} live={false} roverLabel="APPROACHING" />);
    const texts = svgTexts(r.toJSON());
    expect(texts).toContain('STALE');
    expect(texts).not.toContain('APPROACHING');
  });
});

describe('Dashboard', () => {
  test('shows offline state from the store, never a fake connection', async () => {
    const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
    const r = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <Dashboard />
      </SafeAreaProvider>,
    );
    expect(screen.getByText(/Not connected/)).toBeTruthy();
    expect(screen.getByText('15.6 cm/s @ PWM 130')).toBeTruthy(); // your measured speed is the default
    expect(screen.getByText('rotation not calibrated')).toBeTruthy();
    expect(screen.getByText('No lot photo analysed yet.')).toBeTruthy();
    await r.unmount();
  });
});
