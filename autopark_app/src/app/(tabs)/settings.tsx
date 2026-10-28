import React, { useEffect, useMemo, useState } from 'react';
import { Alert, TextInput } from 'react-native';

import { Badge, Banner, Button, Card, Check, KV, NumberField, Row, Screen, Segmented, T, useTheme } from '../../components/ui';
import { ThemePref, useApp, ROI_PRESETS } from '../../state/store';
import { useLink } from '../../services/hooks';
import { PARAMETER_HELP, ParkingConfig, bayEntryCm, markMeasured, rotationRadiusCm, validateParkingConfig } from '../../core/config/parkingConfig';
import { makeCalibration, pwmForSpeed, rotationMsFor90, speedForPwm, upsertCalibration } from '../../core/geometry/lane';
import { ROIConfigError, ROIConfigJson, SLOT_IDS, parseROIConfig } from '../../core/vision/roi';

function setPath(cfg: ParkingConfig, path: string, value: unknown): ParkingConfig {
  const next = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  const keys = path.split('.');
  let o = next as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]] as Record<string, unknown>;
  o[keys[keys.length - 1]] = value;
  return markMeasured(next as unknown as ParkingConfig, path);
}

function getPath(cfg: ParkingConfig, path: string): number {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], cfg) as number;
}

type CalKind = 'speed' | 'rotation';

export default function Settings() {
  const t = useTheme();
  const config = useApp((s) => s.config);
  const setConfig = useApp((s) => s.setConfig);
  const themePref = useApp((s) => s.themePref);
  const { status, live } = useLink();
  const errors = validateParkingConfig(config);

  const num = (path: string, label: string, unit?: string, opts: { integer?: boolean; min?: number; max?: number } = {}) => (
    <NumberField
      key={path}
      label={label}
      unit={unit}
      value={getPath(config, path)}
      estimated={config.estimated.includes(path)}
      help={PARAMETER_HELP[path]}
      integer={opts.integer}
      min={opts.min}
      max={opts.max}
      onCommit={(v) => setConfig((c) => setPath(c, path, v))}
    />
  );

  // ---- connection
  const [host, setHost] = useState(config.esp32.host);
  useEffect(() => setHost(config.esp32.host), [config.esp32.host]);
  const [connMsg, setConnMsg] = useState<string | null>(null);
  const testConnection = async () => {
    setConnMsg('Testing…');
    try {
      const st = await useApp.getState().client().status();
      setConnMsg(`OK: ${st.fw} · ${st.state} · uptime ${(st.uptimeMs / 1000).toFixed(0)} s`);
    } catch (e) {
      setConnMsg(`Failed: ${(e as Error).message}`);
    }
  };

  // ---- calibration runs (one at a time)
  const [running, setRunning] = useState<CalKind | null>(null);
  useEffect(() => {
    if (!running || !status || status.state === 'CALIBRATING') return;
    const kind = running;
    setRunning(null);
    const ok = status.state === 'IDLE' && status.calibMs > 0;
    if (kind === 'speed') {
      if (status.calibMs > 0) setCalRunMs(status.calibMs);
      setCalMsg(
        ok
          ? `Drove ${status.calibMs} ms. Measure how far the rover moved and enter it below.`
          : `Calibration interrupted: ${status.state} (${status.reason}). Drove ${status.calibMs} ms - measure it or reset and retry.`,
      );
    } else {
      if (status.calibMs > 0) setRotRunMs(status.calibMs);
      setRotMsg(
        ok
          ? `Rotated ${rotDir === 'L' ? 'left' : 'right'} for ${status.calibMs} ms. Exactly 90°? Save it. Otherwise adjust the time and run again, or enter the angle it actually turned.`
          : `Rotation interrupted: ${status.state} (${status.reason}). Reset and retry.`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, running]);

  // ---- speed calibration
  const [calPwm, setCalPwm] = useState(config.speed.pwm);
  const [calMs, setCalMs] = useState(3000);
  const [calRunMs, setCalRunMs] = useState<number | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  const [calMsg, setCalMsg] = useState<string | null>(null);
  const [targetCms, setTargetCms] = useState<number | null>(null);
  const runSpeedCalibration = () => {
    Alert.alert(
      'Speed calibration drive',
      `The rover will drive STRAIGHT FORWARD for ${calMs} ms at PWM ${calPwm}. Give it a clear path of at least ${Math.ceil((calMs / 1000) * 25)} cm and mark its position.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Drive',
          onPress: async () => {
            setCalRunMs(null);
            setMeasured(null);
            const r = await useApp.getState().client().calibrate('F', calPwm, calMs, config.safety.obstacleStopCm);
            if (r.ok) {
              setRunning('speed');
              setCalMsg('Driving…');
            } else setCalMsg(`Rejected: ${r.result} ${r.message}`);
          },
        },
      ],
    );
  };
  const saveSpeedCalibration = () => {
    try {
      if (calRunMs === null || measured === null) return;
      const c = makeCalibration(calPwm, measured, calRunMs);
      setConfig((cfg) => ({ ...cfg, speed: { ...cfg.speed, calibrations: upsertCalibration(cfg.speed.calibrations, c) } }));
      setCalMsg(`Saved: ${c.cmPerS.toFixed(2)} cm/s at PWM ${c.pwm}.`);
      setCalRunMs(null);
      setMeasured(null);
    } catch (e) {
      setCalMsg((e as Error).message);
    }
  };
  const drivingSpeed = speedForPwm(config.speed.calibrations, config.speed.pwm);
  const target = targetCms !== null ? pwmForSpeed(config.speed.calibrations, targetCms) : null;

  // ---- 90-degree rotation calibration
  const [rotDir, setRotDir] = useState<'L' | 'R'>('L');
  const savedRot = rotDir === 'L' ? config.rotation.leftMs90 : config.rotation.rightMs90;
  const [rotMs, setRotMs] = useState<number>(savedRot ?? 1000);
  useEffect(() => setRotMs((savedRot ?? rotMs) as number), [rotDir]); // eslint-disable-line react-hooks/exhaustive-deps
  const [rotRunMs, setRotRunMs] = useState<number | null>(null);
  const [rotAngle, setRotAngle] = useState<number | null>(null);
  const [rotMsg, setRotMsg] = useState<string | null>(null);
  const runRotation = async () => {
    setRotRunMs(null);
    setRotAngle(null);
    const r = await useApp.getState().client().calibrate(rotDir, config.rotation.pwm, rotMs, config.safety.obstacleStopCm);
    if (r.ok) {
      setRunning('rotation');
      setRotMsg('Rotating…');
    } else setRotMsg(`Rejected: ${r.result} ${r.message}`);
  };
  const saveRotation = (ms: number) => {
    const key = rotDir === 'L' ? 'leftMs90' : 'rightMs90';
    setConfig((c) => ({ ...c, rotation: { ...c.rotation, [key]: Math.round(ms) } }));
    setRotMs(Math.round(ms));
    setRotMsg(`Saved: 90° ${rotDir === 'L' ? 'left' : 'right'} = ${Math.round(ms)} ms at PWM ${config.rotation.pwm}.`);
  };
  const saveFromAngle = () => {
    if (rotRunMs === null || rotAngle === null) return;
    try {
      saveRotation(rotationMsFor90(rotRunMs, rotAngle));
    } catch (e) {
      setRotMsg((e as Error).message);
    }
  };

  // ---- ROI
  const roiLayoutName = useApp((s) => s.roiLayoutName);
  const customRoi = useApp((s) => s.customRoi);
  const [roiDraft, setRoiDraft] = useState<ROIConfigJson>(() => customRoi ?? (ROI_PRESETS[roiLayoutName] ?? ROI_PRESETS.roi_config));
  const [roiMsg, setRoiMsg] = useState<string | null>(null);
  const roiOptions = useMemo(
    () => [...Object.keys(ROI_PRESETS).map((k) => ({ value: k, label: k.replace('roi_', '') })), { value: 'custom', label: 'custom' }],
    [],
  );

  const R = rotationRadiusCm(config);
  const busy = running !== null;

  return (
    <Screen>
      {errors.length ? <Banner kind="error">{errors.join('\n')}</Banner> : null}
      {config.estimated.length ? (
        <Banner kind="warn">
          {`${config.estimated.length} value(s) are ESTIMATES, not measurements. Measure them on the real rover and lot; editing a value marks it measured.`}
        </Banner>
      ) : null}

      <Card title="Appearance">
        <Segmented<ThemePref>
          value={themePref}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          onChange={(v) => useApp.getState().setThemePref(v)}
        />
      </Card>

      <Card title="ESP32 connection" right={<Badge label={live ? 'LIVE' : 'OFFLINE'} color={live ? t.ok : t.danger} />}>
        <T muted size={12}>Default soft-AP: SSID ESP32-Robot, address 192.168.4.1. Use host:port for the PC simulator.</T>
        <Row>
          <TextInput
            value={host}
            onChangeText={setHost}
            autoCapitalize="none"
            autoCorrect={false}
            style={{ flex: 1, color: t.text, borderWidth: 1, borderColor: t.border, borderRadius: 8, padding: 8, backgroundColor: t.bg }}
          />
          <Button label="Save" variant="ghost" onPress={() => setConfig((c) => ({ ...c, esp32: { ...c.esp32, host: host.trim() } }))} />
        </Row>
        <Button label="Test connection" variant="ghost" onPress={testConnection} />
        {connMsg ? <T size={13}>{connMsg}</T> : null}
        {num('esp32.pollIntervalMs', 'Status poll interval', 'ms', { integer: true, min: 150, max: 2000 })}
        {num('esp32.staleAfterMs', 'Telemetry is stale after', 'ms', { integer: true, min: 500, max: 10000 })}
      </Card>

      <Card title="Driving speed">
        <T muted size={12}>
          PWM is not a speed: the map and the parking route convert time to distance with MEASURED speeds. You measured 15.6 cm/s (recorded at PWM 130,
          the firmware default); add more points below to use other speeds.
        </T>
        {num('speed.pwm', 'PWM for autonomous parking', '', { integer: true, min: 1, max: 255 })}
        <KV
          k="Speed at that PWM"
          v={drivingSpeed.kind === 'uncalibrated' ? 'not measured' : `${drivingSpeed.cmPerS.toFixed(2)} cm/s${drivingSpeed.kind === 'interpolated' ? ' (interpolated)' : ''}`}
          color={drivingSpeed.kind === 'uncalibrated' ? t.danger : undefined}
        />
        <NumberField label="Set a target speed instead" unit="cm/s" allowEmpty value={targetCms} min={1} max={150} onCommit={setTargetCms} />
        {targetCms !== null ? (
          target ? (
            <Button
              label={`Use PWM ${target.pwm} for ${targetCms} cm/s${target.kind === 'interpolated' ? ' (interpolated)' : ''}`}
              variant="ghost"
              onPress={() => setConfig((c) => setPath(c, 'speed.pwm', target.pwm))}
            />
          ) : (
            <T size={12} color={t.warn}>
              {targetCms} cm/s is outside the measured range. Measure a PWM above and below it first (PWM is not proportional to speed).
            </T>
          )
        ) : null}
        <T bold>Measured speeds</T>
        {config.speed.calibrations.map((c) => (
          <Row key={c.pwm} style={{ justifyContent: 'space-between' }}>
            <T>{`PWM ${c.pwm}: ${c.cmPerS.toFixed(2)} cm/s${c.source === 'user' ? ' (your value)' : ` (${c.measuredCm} cm in ${c.durationMs} ms)`}`}</T>
            <Button
              label="Delete"
              variant="ghost"
              onPress={() => setConfig((cfg) => ({ ...cfg, speed: { ...cfg.speed, calibrations: cfg.speed.calibrations.filter((x) => x.pwm !== c.pwm) } }))}
            />
          </Row>
        ))}
        {!config.speed.calibrations.length ? <T color={t.warn}>No measured speed - autonomous parking is disabled.</T> : null}
        <T bold>Measure a speed</T>
        <NumberField label="Calibration PWM" value={calPwm} integer min={1} max={255} onCommit={(v) => setCalPwm(v ?? 130)} />
        <NumberField label="Drive time" unit="ms" value={calMs} integer min={300} max={10000} onCommit={(v) => setCalMs(v ?? 3000)} />
        <Button label={running === 'speed' ? 'Driving…' : 'Run calibration drive'} onPress={runSpeedCalibration} disabled={!live || busy} />
        {calMsg ? <T size={13}>{calMsg}</T> : null}
        {calRunMs !== null ? (
          <>
            <NumberField label="Measured distance" unit="cm" value={measured} min={0.1} max={999} allowEmpty onCommit={setMeasured} />
            <Button label="Save measured speed" variant="ok" onPress={saveSpeedCalibration} disabled={measured === null} />
          </>
        ) : null}
      </Card>

      <Card title="Calibrate 90° rotation">
        <T muted size={12}>
          The rover turns by rotating in place, timed by the ESP32. Mark the rover's heading (e.g. tape along its side), run a rotation, and adjust the time
          until it turns exactly 90°. Calibrate left and right separately; both at the rotation PWM below.
        </T>
        <NumberField
          label="Rotation PWM"
          value={config.rotation.pwm}
          integer
          min={1}
          max={255}
          onCommit={(v) => {
            if (v === null || v === config.rotation.pwm) return;
            // times measured at another PWM are no longer valid
            setConfig((c) => ({ ...c, rotation: { ...c.rotation, pwm: v, leftMs90: null, rightMs90: null } }));
            setRotMsg('Rotation PWM changed: calibrate 90° left and right again.');
          }}
        />
        <KV k="90° left" v={config.rotation.leftMs90 ? `${config.rotation.leftMs90} ms` : 'not calibrated'} color={config.rotation.leftMs90 ? t.ok : t.danger} />
        <KV k="90° right" v={config.rotation.rightMs90 ? `${config.rotation.rightMs90} ms` : 'not calibrated'} color={config.rotation.rightMs90 ? t.ok : t.danger} />
        <Segmented
          value={rotDir}
          options={[
            { value: 'L', label: 'Rotate left' },
            { value: 'R', label: 'Rotate right' },
          ]}
          onChange={setRotDir}
        />
        <NumberField label="Rotation time" unit="ms" value={rotMs} integer min={100} max={10000} onCommit={(v) => setRotMs(v ?? 1000)} />
        <Row gap={6}>
          {[-100, -20, 20, 100].map((d) => (
            <Button key={d} label={`${d > 0 ? '+' : ''}${d}`} variant="ghost" onPress={() => setRotMs((m) => Math.min(10000, Math.max(100, m + d)))} style={{ flex: 1 }} />
          ))}
        </Row>
        <Button label={running === 'rotation' ? 'Rotating…' : `Rotate ${rotDir === 'L' ? 'left' : 'right'} for ${rotMs} ms`} onPress={runRotation} disabled={!live || busy} />
        {rotMsg ? <T size={13}>{rotMsg}</T> : null}
        {rotRunMs !== null ? (
          <>
            <Button label={`It turned exactly 90° → save ${rotRunMs} ms`} variant="ok" onPress={() => saveRotation(rotRunMs)} />
            <NumberField label="Or: angle it actually turned" unit="°" allowEmpty value={rotAngle} min={10} max={360} onCommit={setRotAngle} />
            <Button label="Compute the 90° time from that angle" variant="ghost" onPress={saveFromAngle} disabled={rotAngle === null} />
          </>
        ) : null}
        {num('rotation.settleMs', 'Pause between moves', 'ms', { integer: true, min: 0, max: 3000 })}
      </Card>

      <Card title="Vehicle">
        {num('vehicle.lengthCm', 'Length', 'cm', { min: 5, max: 60 })}
        {num('vehicle.widthCm', 'Width (breadth)', 'cm', { min: 3, max: 40 })}
        <KV k="Rotation sweep radius" v={`${R.toFixed(1)} cm (half the diagonal)`} />
        <KV k="Clearance per side in a bay" v={`${((config.lane.slotLengthCm - config.vehicle.widthCm) / 2).toFixed(1)} cm`} />
      </Card>

      <Card title="Lane and bays">
        <T muted size={12}>Five slots S1–S5 along x = 0–130 cm (26 cm each). x is the rover's centre.</T>
        {num('lane.slotLengthCm', 'Slot length', 'cm', { min: 10, max: 60 })}
        <Row style={{ justifyContent: 'space-between' }}>
          <Row gap={6}>
            <T>Bays are on the</T>
            {config.estimated.includes('lane.baySide') ? <Badge label="ESTIMATE" color={t.warn} /> : null}
          </Row>
          <Segmented value={config.lane.baySide} options={[{ value: 'left', label: 'left' }, { value: 'right', label: 'right' }]} onChange={(v) => setConfig((c) => setPath(c, 'lane.baySide', v))} />
        </Row>
        {num('lane.bayOffsetCm', 'Bay mouth offset from driving line', 'cm', { min: 0, max: 100 })}
        {config.lane.bayOffsetCm < R ? (
          <T size={12} muted>
            {`While rotating, the corners (${R.toFixed(1)} cm from the centre) dip ${(R - config.lane.bayOffsetCm).toFixed(1)} cm into the target bay, within ±${Math.sqrt(R * R - config.lane.bayOffsetCm ** 2).toFixed(1)} cm of its centre${Math.sqrt(R * R - config.lane.bayOffsetCm ** 2) > config.lane.slotLengthCm / 2 ? ' - that reaches the neighbouring bays!' : ' - inside the slot, so neighbours are safe.'}`}
          </T>
        ) : null}
        {num('lane.bayDepthCm', 'Bay depth', 'cm', { min: 5, max: 100 })}
      </Card>

      <Card title="Route">
        <Row style={{ justifyContent: 'space-between' }}>
          <T>Entry</T>
          <Segmented
            value={config.route.entryMode}
            options={[
              { value: 'forward', label: 'forward-in' },
              { value: 'reverse', label: 'reverse-in' },
            ]}
            onChange={(v) => setConfig((c) => ({ ...c, route: { ...c.route, entryMode: v } }))}
          />
        </Row>
        {num('route.startCm', 'Start position (rover centre)', 'cm', { min: -50, max: 130 })}
        <NumberField
          label="Straight distance into the bay (blank = to bay centre)"
          unit="cm"
          allowEmpty
          value={config.route.bayEntryCm}
          min={1}
          max={100}
          help={PARAMETER_HELP['route.bayEntryCm']}
          onCommit={(v) => setConfig((c) => ({ ...c, route: { ...c.route, bayEntryCm: v } }))}
        />
        <KV k="Bay entry used" v={`${bayEntryCm(config).toFixed(1)} cm`} />
        <NumberField label="Turn point trim (all slots)" unit="cm" value={config.route.turnStartTrimCm} min={-30} max={30} onCommit={(v) => setConfig((c) => ({ ...c, route: { ...c.route, turnStartTrimCm: v ?? 0 } }))} />
        <T muted size={12}>
          The rover rotates when its centre is at the slot centre. If it consistently ends off-centre in a slot, enter the measured rotation point for that slot.
        </T>
        {SLOT_IDS.map((id, i) => (
          <NumberField
            key={id}
            label={`${id} rotation point (blank = ${i * config.lane.slotLengthCm + config.lane.slotLengthCm / 2} cm)`}
            unit="cm"
            allowEmpty
            value={config.route.turnStartOverrideCm[id]}
            min={0}
            max={130}
            onCommit={(v) => setConfig((c) => ({ ...c, route: { ...c.route, turnStartOverrideCm: { ...c.route.turnStartOverrideCm, [id]: v } } }))}
          />
        ))}
      </Card>

      <Card title="Safety">
        {num('safety.obstacleStopCm', 'Obstacle stop distance', 'cm', { min: 2, max: 100 })}
        {num('safety.bayStopCm', 'Bay end stop distance', 'cm', { min: 2, max: 100 })}
        <Check label="Stop on IR detection in the direction of travel" value={config.safety.irStopEnabled} onChange={(v) => setConfig((c) => ({ ...c, safety: { ...c.safety, irStopEnabled: v } }))} />
        <Check label="Obstacle stop also in manual mode" value={config.safety.manualObstacleStop} onChange={(v) => setConfig((c) => ({ ...c, safety: { ...c.safety, manualObstacleStop: v } }))} />
        {num('safety.heartbeatTimeoutMs', 'Abort parking if the phone is silent for', 'ms', { integer: true, min: 500, max: 10000 })}
        {num('safety.manualWatchdogMs', 'Manual move watchdog', 'ms', { integer: true, min: 300, max: 5000 })}
      </Card>

      <Card title="Slot regions (ROI)">
        <Segmented
          value={roiLayoutName}
          options={roiOptions}
          onChange={(v) => {
            if (v !== 'custom') setRoiDraft(ROI_PRESETS[v]);
            useApp.getState().setRoiLayout(v);
          }}
        />
        <T muted size={12}>Normalized 0–1 rectangles, exactly S1–S5 (same files as autopark_vision/config). Edit and save as the custom layout.</T>
        <NumberField label="Reference width" unit="px" integer min={1} value={roiDraft.reference_resolution?.width ?? 1280} onCommit={(v) => setRoiDraft((d) => ({ ...d, reference_resolution: { ...d.reference_resolution, width: v ?? 1280 } }))} />
        <NumberField label="Reference height" unit="px" integer min={1} value={roiDraft.reference_resolution?.height ?? 720} onCommit={(v) => setRoiDraft((d) => ({ ...d, reference_resolution: { ...d.reference_resolution, height: v ?? 720 } }))} />
        {roiDraft.slots.map((sl, i) =>
          (['x', 'y', 'w', 'h'] as const).map((k) => (
            <NumberField
              key={`${sl.id}${k}`}
              label={`${sl.id}.${k}`}
              value={sl[k]}
              min={0}
              max={1}
              onCommit={(v) => setRoiDraft((d) => ({ ...d, slots: d.slots.map((x, j) => (j === i ? { ...x, [k]: v ?? 0 } : x)) }))}
            />
          )),
        )}
        <Button
          label="Validate & use as custom layout"
          variant="ghost"
          onPress={() => {
            try {
              parseROIConfig({ ...roiDraft, layout_name: 'custom', placeholder: false });
              useApp.getState().setRoiLayout('custom', { ...roiDraft, layout_name: 'custom', placeholder: false });
              setRoiMsg('Custom layout saved.');
            } catch (e) {
              setRoiMsg(e instanceof ROIConfigError ? e.message : (e as Error).message);
            }
          }}
        />
        {roiMsg ? <T size={13}>{roiMsg}</T> : null}
      </Card>

      <Card title="Reset">
        <Button
          label="Restore defaults"
          variant="danger"
          onPress={() =>
            Alert.alert('Restore defaults?', 'Calibrations and measured values will be lost.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Restore', style: 'destructive', onPress: () => useApp.getState().resetConfig() },
            ])
          }
        />
      </Card>
    </Screen>
  );
}
