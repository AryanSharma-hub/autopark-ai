import React from 'react';

import { Badge, Banner, Button, Card, KV, ProgressBar, Row, Screen, T, useTheme } from '../../components/ui';
import { LaneMap } from '../../components/LaneMap';
import { useApp } from '../../state/store';
import { useLink } from '../../services/hooks';
import { RoverStatus, isAutonomous, isLatched } from '../../core/esp32/protocol';
import { RoutePlan } from '../../core/geometry/routePlanner';
import { describeLanePosition, slotAt, speedForPwm } from '../../core/geometry/lane';
import { laneX } from '../../core/geometry/tracker';
import { stateColor } from '../../components/RoverBar';

/** Fraction of the plan done, counting each segment by its planned time. */
function planProgress(st: RoverStatus, plan: RoutePlan | null): number {
  if (st.state === 'COMPLETED') return 1;
  if (!plan || st.seg < 0) return 0;
  const durs = plan.segments.map((g) => g.durationMs ?? 0);
  const total = durs.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  const done = durs.slice(0, st.seg).reduce((a, b) => a + b, 0) + (st.settling ? 0 : Math.min(st.segMs, durs[st.seg] ?? 0));
  return done / total;
}

export default function MapScreen() {
  const t = useTheme();
  const { status, live, ageMs } = useLink();
  const config = useApp((s) => s.config);
  const track = useApp((s) => s.track);
  const park = useApp((s) => s.park);
  const analysis = useApp((s) => s.analysis);
  const selected = useApp((s) => s.selectedSlot);

  const x = laneX(track);
  const pos = x === null ? null : slotAt(Math.round(x * 100) / 100);
  const runMatches = !!park && !!status && status.rid === park.rid;
  const plan = park?.plan ?? null;
  const auto = runMatches && status ? status : null;
  const speed = status ? speedForPwm(config.speed.calibrations, status.pwm) : null;
  const statuses = analysis ? Object.fromEntries(analysis.report.slots.map((s) => [s.slot_id, s.status])) : null;
  const dirLabel = status ? { F: 'Forward', B: 'Reverse', L: 'Rotating left ⟲', R: 'Rotating right ⟳', S: 'Stopped' }[status.movement] : '—';
  const headingDeg = track.pose ? Math.round(((((track.pose.theta * 180) / Math.PI) % 360) + 540) % 360 - 180) : null;

  return (
    <Screen>
      <Card
        title="Lane 0–130 cm"
        right={<Badge label={live ? 'LIVE ESTIMATE' : 'STALE'} color={live ? t.ok : t.danger} />}
      >
        <LaneMap
          config={config}
          pose={track.pose}
          trail={track.trail}
          plan={plan}
          statuses={statuses}
          selectedSlot={park?.slotId ?? selected}
          live={live}
          roverLabel={status && live ? status.state : undefined}
        />
        <Row wrap gap={6}>
          <Badge label="planned route" color={t.accent} />
          <Badge label="rotation point + swept circle" color={t.warn} />
          <Badge label="start mark" color={t.ok} />
          <Badge label="driven trail" color={t.muted} />
        </Row>
        {!live ? (
          <Banner kind="error">{`No live telemetry${ageMs !== null ? ` for ${(ageMs / 1000).toFixed(1)} s` : ''}. The rover is drawn at its last known estimate, not its live position.`}</Banner>
        ) : null}
      </Card>

      <Card title="Movement" right={status ? <Badge label={status.state} color={live ? stateColor(status.state, t) : t.muted} /> : null}>
        <KV k="Direction" v={dirLabel} />
        <KV k="Estimated lane position (centre)" v={x === null ? 'unknown' : `≈ ${x.toFixed(0)} cm · ${pos ? describeLanePosition(pos) : ''}`} />
        <KV k="Heading" v={headingDeg === null ? '—' : headingDeg === 0 ? 'along the lane (0°)' : `${headingDeg > 0 ? '+' : ''}${headingDeg}° (+ = turned left)`} />
        <KV k="Source" v={track.source === 'autonomous' ? 'ESP32 run progress (time × speed)' : track.source === 'manual' ? 'manual dead reckoning' : 'start mark'} />
        <KV k="Distance driven since reset" v={`≈ ${track.odometerCm.toFixed(0)} cm`} />
        <KV
          k="Speed"
          v={
            !speed
              ? '—'
              : speed.kind === 'uncalibrated'
                ? `PWM ${speed.pwm}: not calibrated`
                : `${speed.cmPerS.toFixed(1)} cm/s @ PWM ${speed.pwm} (${speed.kind})`
          }
          color={speed?.kind === 'uncalibrated' ? t.warn : undefined}
        />
        {track.quality !== 'estimate' || track.note ? <T muted size={12}>{track.note}</T> : null}
        {auto ? (
          <>
            <KV k="Parking" v={`${auto.slot} · ${auto.state}${auto.settling ? ' (pausing)' : ''}${auto.segMove === 'L' || auto.segMove === 'R' ? ` · rotating ${auto.segMs}/${auto.segDurMs} ms` : ''}`} />
            <ProgressBar value={planProgress(auto, plan)} color={isLatched(auto.state) ? t.danger : auto.state === 'COMPLETED' ? t.ok : t.accent} />
            <KV k="Progress" v={`${auto.distCm.toFixed(1)} / ${auto.totalCm.toFixed(1)} cm · ${(auto.elapsedMs / 1000).toFixed(1)} s`} />
            {auto.reason ? <KV k="Reason" v={auto.reason} color={isLatched(auto.state) ? t.danger : undefined} /> : null}
          </>
        ) : null}
        {status && isAutonomous(status.state) && !runMatches ? (
          <Banner kind="warn">The rover is running a parking request this app did not start; its path is not drawn.</Banner>
        ) : null}
        <T muted size={12}>
          Positions are dead-reckoned (calibrated speed × motor time; rotations from your calibrated 90° times). There are no wheel encoders, so error grows with distance; reset on the start mark.
        </T>
        <Button label={`Rover is at the start mark (centre x = ${config.route.startCm} cm)`} variant="ghost" onPress={() => useApp.getState().resetPosition()} />
      </Card>
    </Screen>
  );
}
