import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';

import { Badge, Banner, Button, Card, Check, KV, ProgressBar, Row, Screen, T, useTheme } from '../components/ui';
import { LaneMap } from '../components/LaneMap';
import { SlotCrop } from '../components/AnalyzedImage';
import { RoverBar, stateColor } from '../components/RoverBar';
import { useApp } from '../state/store';
import { useLink } from '../services/hooks';
import { PlannedSegment, RoutePlan, planRoute } from '../core/geometry/routePlanner';
import { SingleFlight, startBlockers } from '../core/parking/parkFlow';
import { RoverStatus, buildParkRequest, isAutonomous, isLatched, newRequestId, TERMINAL_STATES } from '../core/esp32/protocol';
import { PARAMETER_HELP } from '../core/config/parkingConfig';
import { describeLanePosition, slotAt } from '../core/geometry/lane';
import { laneX } from '../core/geometry/tracker';

const startGuard = new SingleFlight();

function describeSegment(g: PlannedSegment): string {
  if (g.move === 'L' || g.move === 'R') return `rotate 90° ${g.move === 'L' ? 'left' : 'right'} in place`;
  return `${g.move === 'F' ? 'forward' : 'reverse'} ${g.distanceCm} cm`;
}

/** Fraction of the run done, counting each segment by its planned time. */
function timeProgress(st: RoverStatus | null, plan: RoutePlan): number {
  if (!st) return 0;
  if (st.state === 'COMPLETED') return 1;
  if (st.seg < 0) return 0;
  const durs = plan.segments.map((g) => g.durationMs ?? 0);
  const total = durs.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  return (durs.slice(0, st.seg).reduce((a, b) => a + b, 0) + (st.settling ? 0 : Math.min(st.segMs, durs[st.seg] ?? 0))) / total;
}

export default function AutoPark() {
  useKeepAwake(); // the app's status polls are the rover's heartbeat
  const t = useTheme();
  const { status, live } = useLink();
  const s = useApp();
  const { config, analysis, selectedSlot, park, track } = s;
  const [sending, setSending] = useState(false);

  const previewPlan = useMemo(() => (selectedSlot ? planRoute(config, selectedSlot) : null), [config, selectedSlot]);
  const plan = park?.plan ?? previewPlan;
  const runMatches = !!park && !!status && status.rid === park.rid;
  const running = runMatches && isAutonomous(status!.state);
  const finished = runMatches && TERMINAL_STATES.includes(status!.state);
  const statuses = analysis ? Object.fromEntries(analysis.report.slots.map((x) => [x.slot_id, x.status])) : null;
  const slotResult = analysis?.report.slots.find((x) => x.slot_id === selectedSlot) ?? null;

  const blockers = startBlockers({
    report: analysis?.report ?? null,
    slotId: selectedSlot,
    plan: previewPlan,
    linkLive: live,
    roverState: status?.state ?? null,
    estop: !!status?.estop,
    appMode: s.appMode,
    requestInFlight: sending || startGuard.busy,
    estimatesAcknowledged: s.estimatesAcknowledged,
    slotConfirmedOnImage: s.slotConfirmedOnImage,
    roverAtStartConfirmed: s.roverAtStartConfirmed,
    allowIncompatibleLayout: s.allowIncompatibleLayout,
    analysisAgeMs: analysis ? Date.now() - analysis.analyzedAt : undefined,
  });

  const send = async (rid: string) => {
    if (!previewPlan && !park) return;
    const p = park?.plan ?? previewPlan!;
    if (!startGuard.begin(rid)) return;
    setSending(true);
    try {
      const req = buildParkRequest(p, config, rid);
      if (!park || park.rid !== rid) {
        useApp.getState().beginPark({ rid, slotId: p.slotId, plan: p, phase: 'sending', message: '', sentAt: Date.now() });
      } else {
        useApp.getState().updatePark({ phase: 'sending', message: '' });
      }
      useApp.getState().setAppMode('autonomous');
      const r = await useApp.getState().client().park(req);
      if (r.ok) {
        useApp.getState().updatePark({ phase: 'accepted', message: r.result === 'DUPLICATE' ? 'Already running this request.' : '' });
      } else if (r.result === 'NETWORK') {
        useApp.getState().updatePark({
          phase: 'failed',
          message: `No answer from the rover (${r.message}). It may or may not have started; watch the status. Retrying with the same request id cannot start it twice.`,
        });
      } else {
        useApp.getState().updatePark({ phase: 'rejected', message: `${r.result}: ${r.message}` });
        useApp.getState().setAppMode('idle');
      }
    } catch (e) {
      useApp.getState().updatePark({ phase: 'rejected', message: (e as Error).message });
      useApp.getState().setAppMode('idle');
    } finally {
      startGuard.end(rid);
      setSending(false);
    }
  };

  const abort = async () => {
    const r = await useApp.getState().client().abort();
    if (!r.ok) useApp.getState().updatePark({ message: `Abort not confirmed (${r.result}: ${r.message}). Use E-STOP or switch the rover off.` });
  };

  const finish = async () => {
    if (status && (isLatched(status.state) || status.state === 'COMPLETED')) await useApp.getState().client().reset();
    useApp.getState().clearPark();
    useApp.getState().setAppMode('idle');
    router.navigate('/');
  };

  if (!selectedSlot && !park) {
    return (
      <Screen>
        <RoverBar />
        <Card title="No destination">
          <T>Analyse a photo and choose an EMPTY slot first.</T>
          <Button label="Go to Park" onPress={() => router.navigate('/park')} />
        </Card>
      </Screen>
    );
  }

  // ------------------------------------------------------------------ run view
  if (park && (park.phase !== 'rejected' || runMatches)) {
    const st = runMatches ? status! : null;
    const x = laneX(track);
    const seg = st && st.seg >= 0 ? park.plan.segments[st.seg] : null;
    return (
      <View style={{ flex: 1 }}>
        <RoverBar />
        <Screen>
          <Card title={`Parking → ${park.slotId}`} right={st ? <Badge label={st.state} color={stateColor(st.state, t)} /> : <Badge label={park.phase.toUpperCase()} color={t.muted} />}>
            {park.message ? <Banner kind={park.phase === 'failed' ? 'warn' : 'info'}>{park.message}</Banner> : null}
            {!live ? <Banner kind="error">Telemetry is stale. The rover aborts by itself if it stops hearing from the phone ({config.safety.heartbeatTimeoutMs} ms).</Banner> : null}
            <ProgressBar value={timeProgress(st, park.plan)} color={st?.state === 'COMPLETED' ? t.ok : st && isLatched(st.state) ? t.danger : t.accent} />
            <KV k="Phase" v={st ? `${st.state}${seg ? ` · segment ${st.seg + 1}/${st.segCount}${st.settling ? ' · pausing' : ''}` : ''}` : park.phase} />
            {seg ? <KV k="Segment" v={describeSegment(seg)} /> : null}
            <KV k="Distance (estimate)" v={st ? `${st.distCm.toFixed(1)} / ${st.totalCm.toFixed(1)} cm` : '—'} />
            <KV k="Elapsed" v={st ? `${(st.elapsedMs / 1000).toFixed(1)} s` : '—'} />
            <KV k="Speed (calibrated)" v={`${park.plan.cmPerS?.toFixed(1)} cm/s @ PWM ${config.speed.pwm}`} />
            <KV k="Lane position (estimate)" v={x === null ? '—' : `${x.toFixed(1)} cm · ${describeLanePosition(slotAt(Math.round(x * 100) / 100))}`} />
            {st?.reason ? <KV k="Reason" v={st.reason} color={isLatched(st.state) ? t.danger : undefined} /> : null}
            <LaneMap config={config} pose={track.pose} trail={track.trail} plan={park.plan} statuses={statuses} selectedSlot={park.slotId} live={live} />
            {running || park.phase === 'sending' ? <Button label="ABORT" variant="danger" big onPress={abort} /> : null}
            {park.phase === 'failed' && !runMatches ? <Button label="Retry (same request id)" onPress={() => send(park.rid)} disabled={sending} /> : null}
            {finished ? (
              <>
                <Banner kind={st!.state === 'COMPLETED' ? 'ok' : 'error'}>
                  {st!.state === 'COMPLETED'
                    ? `Finished: ${st!.reason}. Position is an estimate (no encoders) - check the car in ${park.slotId}.`
                    : `${st!.state}: ${st!.reason}. The motor is off and the rover refuses motion until reset.`}
                </Banner>
                <Button label={st!.state === 'COMPLETED' ? 'Done' : 'Acknowledge & reset rover'} onPress={finish} />
              </>
            ) : null}
            {!running && !finished && park.phase !== 'sending' && park.phase !== 'failed' ? (
              <Button label="Back" variant="ghost" onPress={finish} />
            ) : null}
          </Card>
        </Screen>
      </View>
    );
  }

  // ----------------------------------------------------------- confirmation view
  const p = previewPlan!;
  return (
    <View style={{ flex: 1 }}>
      <RoverBar />
      <Screen>
        {park?.phase === 'rejected' ? <Banner kind="error">{`Rover rejected the request: ${park.message}`}</Banner> : null}
        <Card title={`Destination ${selectedSlot}`}>
          <KV k="Classification" v={slotResult ? `${slotResult.status} · ${(slotResult.confidence! * 100).toFixed(2)}%` : '—'} color={t.ok} />
          <KV k="Slot interval" v={`${p.slotStartCm}–${p.slotEndCm} cm`} />
          <KV k="Start position (rover centre)" v={`${config.route.startCm} cm`} />
          <KV k="Rotate at (rover centre)" v={`${p.turnStartCm} cm · ${p.turnStartSource === 'slot-centre' ? 'slot centre' : 'measured'}`} />
          <KV
            k="90° rotation"
            v={`${p.rotation === 'L' ? 'left' : 'right'} · ${p.rotationMs === null ? 'NOT CALIBRATED' : `${p.rotationMs} ms @ PWM ${p.rotationPwm}`}`}
            color={p.rotationMs === null ? t.danger : undefined}
          />
          <KV k="Calibrated speed" v={p.cmPerS ? `${p.cmPerS.toFixed(2)} cm/s @ PWM ${config.speed.pwm}` : 'NOT CALIBRATED'} color={p.cmPerS ? undefined : t.danger} />
          <KV k="Planned time" v={p.totalMoveMs !== null ? `${((p.totalMoveMs + p.totalSettleMs) / 1000).toFixed(1)} s` : '—'} />
          <LaneMap config={config} pose={track.pose} trail={[]} plan={p} statuses={statuses} selectedSlot={selectedSlot} live={live} />
        </Card>

        <Card title="Manoeuvre (executed by the ESP32)">
          {p.segments.map((g, i) => (
            <KV
              key={i}
              k={`${i + 1}. ${g.phase}`}
              v={`${describeSegment(g)} · ${g.durationMs !== null ? (g.durationMs / 1000).toFixed(2) + ' s' : '—'}`}
            />
          ))}
          <T muted size={12}>
            Between segments the motors pause for {config.rotation.settleMs} ms so the rover is at rest. Straight segments stop at an obstacle ≤{' '}
            {config.safety.obstacleStopCm} cm{config.safety.irStopEnabled ? ' or IR' : ''} in the direction of travel; bay end ≤ {config.safety.bayStopCm} cm
            ends the bay entry. The rotation is timed ({p.rotationMs ?? '—'} ms); it needs to be accurate to about ±{p.headingToleranceDeg}° because a
            22 cm wide rover has only {((config.lane.slotLengthCm - config.vehicle.widthCm) / 2).toFixed(0)} cm per side in a {config.lane.slotLengthCm} cm bay.
          </T>
        </Card>

        <Card title="Confirm">
          {analysis && slotResult ? (
            <Row gap={12} style={{ alignItems: 'flex-start' }}>
              <SlotCrop uri={analysis.imageUri} width={analysis.width} height={analysis.height} roi={slotResult.roi.pixels} />
              <View style={{ flex: 1 }}>
                <Check label={`${selectedSlot} is empty in the photo`} value={s.slotConfirmedOnImage} onChange={(v) => s.setFlag('slotConfirmedOnImage', v)} />
              </View>
            </Row>
          ) : null}
          <Check
            label={`The rover is on the start mark (centre at x = ${config.route.startCm} cm), on the driving line, facing along the lane`}
            value={s.roverAtStartConfirmed}
            onChange={(v) => {
              s.setFlag('roverAtStartConfirmed', v);
              if (v) s.resetPosition();
            }}
          />
          {p.estimatesUsed.length ? (
            <>
              <Banner kind="warn">
                {`This route uses ${p.estimatesUsed.length} value(s) that have not been measured on your rover:\n` +
                  p.estimatesUsed.map((k) => `• ${k}: ${PARAMETER_HELP[k] ?? ''}`).join('\n')}
              </Banner>
              <Check label="I understand the turn may miss the bay until these are measured (Settings)." value={s.estimatesAcknowledged} onChange={(v) => s.setFlag('estimatesAcknowledged', v)} />
            </>
          ) : null}
          {blockers.length ? <Banner kind="error">{blockers.map((b) => `• ${b}`).join('\n')}</Banner> : <Banner kind="ok">Ready. Keep a hand near the E-STOP.</Banner>}
          <Button label={sending ? 'Sending…' : `Start parking in ${selectedSlot}`} big disabled={blockers.length > 0 || sending} onPress={() => send(newRequestId())} testID="start-park" />
        </Card>
      </Screen>
    </View>
  );
}
