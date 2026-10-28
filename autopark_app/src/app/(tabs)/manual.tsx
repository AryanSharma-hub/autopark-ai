import React, { useCallback, useState } from 'react';
import { Alert, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { Badge, Banner, Button, Card, KV, Row, Screen, T, useTheme } from '../../components/ui';
import { useApp } from '../../state/store';
import { useHoldToDrive, useLink } from '../../services/hooks';
import { isAutonomous, isLatched } from '../../core/esp32/protocol';
import { manualBlockers } from '../../core/parking/parkFlow';
import { speedForPwm } from '../../core/geometry/lane';

const PWM_PRESETS = [80, 100, 130, 160, 200, 255];
const MOVE_LABEL = { F: 'Forward', B: 'Reverse', L: 'Rotating left', R: 'Rotating right', S: 'Stopped' } as const;

function fmtDist(v: number | null | undefined) {
  return v === null || v === undefined ? 'No echo' : `${v.toFixed(1)} cm`;
}

export default function Manual() {
  const t = useTheme();
  const { status, live } = useLink();
  const config = useApp((s) => s.config);
  const appMode = useApp((s) => s.appMode);
  const setAppMode = useApp((s) => s.setAppMode);
  const { start, stop, lastError } = useHoldToDrive();
  const [msg, setMsg] = useState<string | null>(null);

  // Leaving the screen ends manual mode and stops the motor.
  useFocusEffect(
    useCallback(() => {
      return () => {
        if (useApp.getState().appMode === 'manual') {
          void useApp.getState().client().move('S');
          useApp.getState().setAppMode('idle');
        }
      };
    }, []),
  );

  const enable = () => {
    const doEnable = async () => {
      if (status && isAutonomous(status.state)) {
        const r = await useApp.getState().client().abort();
        if (!r.ok) {
          setMsg(`Could not abort the autonomous run (${r.result}). Manual mode not enabled.`);
          return;
        }
        await useApp.getState().client().reset();
      }
      setAppMode('manual');
      setMsg(null);
    };
    if (status && isAutonomous(status.state)) {
      Alert.alert('Abort autonomous parking?', 'Manual mode stops the running parking manoeuvre.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Abort & take control', style: 'destructive', onPress: () => void doEnable() },
      ]);
    } else {
      void doEnable();
    }
  };

  const blockers = manualBlockers(status?.state ?? null, !!status?.estop, live);
  const manual = appMode === 'manual';
  const canDrive = manual && blockers.length === 0;

  const cmd = async (fn: () => Promise<{ ok: boolean; result: string; message: string }>) => {
    const r = await fn();
    setMsg(r.ok ? null : `${r.result}${r.message ? ': ' + r.message : ''}`);
  };
  const client = () => useApp.getState().client();
  const pwm = status?.pwm ?? config.speed.pwm;
  const speed = speedForPwm(config.speed.calibrations, pwm);

  return (
    <Screen>
      <Card title="Manual control" right={<Badge label={manual ? 'MANUAL MODE' : 'OFF'} color={manual ? t.accent : t.muted} />}>
        {!manual ? (
          <>
            <T muted>Manual control is a separate mode: no autonomous manoeuvre runs while it is on.</T>
            <Button label="Enable manual control" onPress={enable} disabled={!live} />
          </>
        ) : (
          <Button label="Exit manual mode" variant="ghost" onPress={() => { void client().move('S'); setAppMode('idle'); }} />
        )}
        {blockers.length && manual ? <Banner kind="warn">{blockers.join('\n')}</Banner> : null}
        {status && (isLatched(status.state) || status.estop) ? (
          <Button label="Reset rover (acknowledge stop)" variant="ghost" onPress={() => cmd(() => client().reset())} />
        ) : null}
        {msg || lastError ? <Banner kind="error">{msg ?? lastError ?? ''}</Banner> : null}
      </Card>

      <Card title="Drive (hold)">
        <View style={{ gap: 8 }}>
          <Button label="▲  Forward" big disabled={!canDrive} onPressIn={() => start('F')} onPressOut={stop} testID="fwd" />
          <Row gap={8}>
            <Button label="⟲  Rotate left" big disabled={!canDrive} onPressIn={() => start('L')} onPressOut={stop} style={{ flex: 1 }} testID="rotl" />
            <Button label="Rotate right  ⟳" big disabled={!canDrive} onPressIn={() => start('R')} onPressOut={stop} style={{ flex: 1 }} testID="rotr" />
          </Row>
          <Button label="▼  Reverse" big disabled={!canDrive} onPressIn={() => start('B')} onPressOut={stop} testID="rev" />
          <Button label="■  STOP" big variant="danger" onPress={() => void client().move('S')} />
        </View>
        <T muted size={12}>
          Rotating turns the rover in place (left wheels one way, right wheels the other). The command repeats while you hold the button; the rover
          stops by itself {config.safety.manualWatchdogMs} ms after the last repeat (watchdog), at obstacles closer than {config.safety.obstacleStopCm} cm
          when driving straight, or when the phone disconnects.
        </T>
      </Card>

      <Card title="Quick 90° turns">
        <T muted size={12}>
          Uses your calibrated 90° times at rotation PWM {config.rotation.pwm} (Settings › Calibrate 90° rotation).
        </T>
        <Row gap={8}>
          <Button
            label={config.rotation.leftMs90 ? `90° left (${config.rotation.leftMs90} ms)` : '90° left: calibrate first'}
            variant="ghost"
            disabled={!canDrive || !config.rotation.leftMs90}
            onPress={() => cmd(async () => {
              const r = await client().setSpeed(config.rotation.pwm);
              return r.ok ? client().timed('L', config.rotation.leftMs90!) : r;
            })}
            style={{ flex: 1 }}
          />
          <Button
            label={config.rotation.rightMs90 ? `90° right (${config.rotation.rightMs90} ms)` : '90° right: calibrate first'}
            variant="ghost"
            disabled={!canDrive || !config.rotation.rightMs90}
            onPress={() => cmd(async () => {
              const r = await client().setSpeed(config.rotation.pwm);
              return r.ok ? client().timed('R', config.rotation.rightMs90!) : r;
            })}
            style={{ flex: 1 }}
          />
        </Row>
      </Card>

      <Card title="Speed">
        <KV k="Current PWM" v={String(pwm)} />
        <KV
          k="Speed"
          v={speed.kind === 'uncalibrated' ? 'not measured at this PWM' : `${speed.cmPerS.toFixed(1)} cm/s${speed.kind === 'interpolated' ? ' (interpolated)' : ''}`}
          color={speed.kind === 'uncalibrated' ? t.warn : undefined}
        />
        <Row wrap gap={6}>
          {PWM_PRESETS.map((p) => (
            <Button key={p} label={String(p)} variant={p === pwm ? 'primary' : 'ghost'} disabled={!canDrive} onPress={() => cmd(() => client().setSpeed(p))} style={{ minWidth: 52 }} />
          ))}
        </Row>
        <Row gap={6}>
          <Button label="−10" variant="ghost" disabled={!canDrive} onPress={() => cmd(() => client().setSpeed(Math.max(0, pwm - 10)))} style={{ flex: 1 }} />
          <Button label="−1" variant="ghost" disabled={!canDrive} onPress={() => cmd(() => client().setSpeed(Math.max(0, pwm - 1)))} style={{ flex: 1 }} />
          <Button label="+1" variant="ghost" disabled={!canDrive} onPress={() => cmd(() => client().setSpeed(Math.min(255, pwm + 1)))} style={{ flex: 1 }} />
          <Button label="+10" variant="ghost" disabled={!canDrive} onPress={() => cmd(() => client().setSpeed(Math.min(255, pwm + 10)))} style={{ flex: 1 }} />
        </Row>
        <T muted size={12}>
          The new speed applies immediately, also while moving. The map can only convert motion to distance at PWMs with a measured speed (you gave
          15.6 cm/s at PWM 130; add more in Settings › Speed calibration).
        </T>
      </Card>

      <Card title="Sensors" right={live ? <Badge label="LIVE" color={t.ok} /> : <Badge label="STALE" color={t.danger} />}>
        <View style={{ opacity: live ? 1 : 0.5, gap: 6 }}>
          <KV k="Front" v={fmtDist(status?.front)} color={status?.front !== null && (status?.front ?? 999) <= config.safety.obstacleStopCm ? t.danger : undefined} />
          <KV k="Rear" v={fmtDist(status?.rear)} color={status?.rear !== null && (status?.rear ?? 999) <= config.safety.obstacleStopCm ? t.danger : undefined} />
          <KV k="Left" v={fmtDist(status?.left)} />
          <KV k="Right" v={fmtDist(status?.right)} />
          <Row wrap gap={6}>
            {(['irFL', 'irFR', 'irRL', 'irRR'] as const).map((k) => (
              <Badge key={k} label={`${k.slice(2)} ${status?.[k] ? 'DETECTED' : 'clear'}`} color={status?.[k] ? t.danger : t.ok} />
            ))}
          </Row>
          <KV k="Movement" v={status ? MOVE_LABEL[status.movement] : '—'} />
          {status?.blocked ? <KV k="Blocked" v={status.blocked} color={t.danger} /> : null}
          <KV k="Sensor age" v={status ? `${status.sensorAgeMs} ms` : '—'} />
        </View>
      </Card>

      <Card title="Map position">
        <T muted>Dead reckoning starts from the start mark (facing along the lane). Put the rover back on the mark and reset when the estimate drifts.</T>
        <Button label={`Rover is at the start mark (centre x = ${config.route.startCm} cm)`} variant="ghost" onPress={() => useApp.getState().resetPosition()} />
      </Card>
    </Screen>
  );
}
