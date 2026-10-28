import React from 'react';
import { router } from 'expo-router';

import { Banner, Badge, Button, Card, KV, Row, Screen, T, STATUS_COLORS, useTheme } from '../../components/ui';
import { LaneMap } from '../../components/LaneMap';
import { useApp } from '../../state/store';
import { useLink } from '../../services/hooks';
import { isAutonomous, isLatched } from '../../core/esp32/protocol';
import { parkingSpeed, slotAt, describeLanePosition } from '../../core/geometry/lane';
import { laneX } from '../../core/geometry/tracker';
import { SLOT_IDS } from '../../core/vision/roi';

const MOVE_LABEL = { F: 'Forward', B: 'Reverse', L: 'Rotating left', R: 'Rotating right', S: 'Stopped' } as const;

export default function Dashboard() {
  const t = useTheme();
  const { connection, status, live, ageMs } = useLink();
  const config = useApp((s) => s.config);
  const track = useApp((s) => s.track);
  const analysis = useApp((s) => s.analysis);
  const selected = useApp((s) => s.selectedSlot);
  const park = useApp((s) => s.park);
  const speed = parkingSpeed(config);
  const x = laneX(track);
  const statuses = analysis ? Object.fromEntries(analysis.report.slots.map((s) => [s.slot_id, s.status])) : null;

  const reset = async () => {
    await useApp.getState().client().reset();
  };

  return (
    <Screen>
      <Card title="Rover">
        <KV k="ESP32" v={`${config.esp32.host} · ${live ? 'live' : connection.link}`} color={live ? t.ok : t.danger} />
        {connection.lastError && !live ? <KV k="Last error" v={connection.lastError} /> : null}
        <KV k="Telemetry age" v={ageMs === null ? '—' : `${(ageMs / 1000).toFixed(1)} s`} />
        <KV k="Firmware" v={status?.fw || '—'} />
        <KV k="State" v={status ? `${status.state}${status.reason ? ' · ' + status.reason : ''}` : '—'} />
        <KV k="Movement" v={status ? `${MOVE_LABEL[status.movement]} · PWM ${status.pwm}` : '—'} />
        {status && (isLatched(status.state) || status.estop) ? (
          <Banner kind="error">
            <T>
              {status.estop ? 'Emergency stop is latched.' : `Rover stopped: ${status.state} (${status.reason}).`} Check the rover, then reset.
            </T>
            <Button label="Reset rover" variant="ghost" onPress={reset} style={{ marginTop: 8 }} />
          </Banner>
        ) : null}
        {!live ? (
          <Banner kind="warn">
            {`Not connected. Join the "ESP32-Robot" Wi-Fi (password in the firmware) and keep mobile data from taking over (see README › Networking). Values shown are the last received${ageMs !== null ? `, ${(ageMs / 1000).toFixed(0)} s ago` : ''}.`}
          </Banner>
        ) : null}
      </Card>

      <Card title="Parking overview" right={park && status && isAutonomous(status.state) ? <Badge label="RUNNING" color={t.accent} /> : null}>
        <LaneMap
          config={config}
          pose={track.pose}
          trail={track.trail}
          plan={park?.plan ?? null}
          statuses={statuses}
          selectedSlot={selected}
          live={live}
        />
        <KV k="Estimated position" v={x === null ? 'unknown' : `${x.toFixed(1)} cm (${describeLanePosition(slotAt(Math.round(x * 100) / 100))}) · estimate`} />
        <Row wrap gap={6}>
          {SLOT_IDS.map((id) => {
            const st = analysis?.report.slots.find((s) => s.slot_id === id)?.status;
            return <Badge key={id} label={`${id} ${st ?? '—'}`} color={st ? STATUS_COLORS[st] : t.muted} />;
          })}
        </Row>
        {analysis ? <T muted size={12}>Analysed {new Date(analysis.analyzedAt).toLocaleTimeString()} · layout {analysis.report.layout.name}</T> : <T muted>No lot photo analysed yet.</T>}
        {selected ? <KV k="Destination" v={selected} color={t.accent} /> : null}
      </Card>

      <Card title="Readiness">
        <KV k="Speed calibration" v={'cmPerS' in speed ? `${speed.cmPerS.toFixed(1)} cm/s @ PWM ${config.speed.pwm}` : 'not calibrated'} color={'cmPerS' in speed ? t.ok : t.warn} />
        <KV
          k="90° rotation"
          v={
            config.rotation.leftMs90 && config.rotation.rightMs90
              ? `L ${config.rotation.leftMs90} ms · R ${config.rotation.rightMs90} ms @ PWM ${config.rotation.pwm}`
              : 'rotation not calibrated'
          }
          color={config.rotation.leftMs90 && config.rotation.rightMs90 ? t.ok : t.warn}
        />
        <KV k="Unmeasured parameters" v={`${config.estimated.length}`} color={config.estimated.length ? t.warn : t.ok} />
      </Card>

      <Row gap={8}>
        <Button label="Manual control" variant="ghost" onPress={() => router.navigate('/manual')} style={{ flex: 1 }} />
        <Button label="Park the car" onPress={() => router.navigate('/park')} style={{ flex: 1 }} />
      </Row>
      <Row gap={8}>
        <Button label="Live map" variant="ghost" onPress={() => router.navigate('/map')} style={{ flex: 1 }} />
        <Button label={park ? 'Parking run' : 'Settings'} variant="ghost" onPress={() => router.navigate(park ? '/autopark' : '/settings')} style={{ flex: 1 }} />
      </Row>
    </Screen>
  );
}
