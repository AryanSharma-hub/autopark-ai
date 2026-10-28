/** Connection + rover state strip with an always-available emergency stop. */
import React, { useState } from 'react';
import { Text, View } from 'react-native';

import { useApp } from '../state/store';
import { useLink } from '../services/hooks';
import { isAutonomous, isLatched } from '../core/esp32/protocol';
import { Badge, Button, Row, useTheme } from './ui';

export function linkColor(link: string, t: ReturnType<typeof useTheme>) {
  return link === 'connected' ? t.ok : link === 'stale' ? t.warn : link === 'disconnected' ? t.danger : t.muted;
}

export function stateColor(state: string | undefined, t: ReturnType<typeof useTheme>) {
  if (!state) return t.muted;
  if (state === 'COMPLETED') return t.ok;
  if (isLatched(state as never)) return t.danger;
  if (isAutonomous(state as never) || state === 'MANUAL' || state === 'CALIBRATING') return t.accent;
  return t.muted;
}

export function RoverBar() {
  const t = useTheme();
  const { connection, status, live, ageMs } = useLink();
  const [msg, setMsg] = useState<string | null>(null);
  const estop = async () => {
    const r = await useApp.getState().client().estop();
    setMsg(r.ok ? 'Emergency stop sent' : `E-STOP NOT CONFIRMED (${r.result}: ${r.message}) - switch the rover off!`);
  };
  const linkLabel = live ? 'LIVE' : connection.link === 'unknown' ? 'CONNECTING' : connection.link === 'stale' ? 'STALE' : 'OFFLINE';
  return (
    <View style={{ backgroundColor: t.card, borderBottomWidth: 1, borderBottomColor: t.border, paddingHorizontal: 12, paddingVertical: 8, gap: 6 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row gap={6} wrap style={{ flexShrink: 1 }}>
          <Badge label={linkLabel} color={live ? t.ok : linkColor(connection.link, t)} />
          {status ? <Badge label={status.state + (status.estop ? ' · E-STOP' : '')} color={live ? stateColor(status.state, t) : t.muted} /> : null}
          {ageMs !== null && !live ? <Text style={{ color: t.muted, fontSize: 12 }}>{(ageMs / 1000).toFixed(1)} s old</Text> : null}
        </Row>
        <Button label="E-STOP" variant="danger" onPress={estop} style={{ paddingVertical: 6, minHeight: 36 }} testID="estop" />
      </Row>
      {msg ? <Text style={{ color: msg.startsWith('E-STOP NOT') ? t.danger : t.muted, fontSize: 12 }}>{msg}</Text> : null}
    </View>
  );
}
