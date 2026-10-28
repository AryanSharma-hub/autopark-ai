import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';

import { Badge, Banner, Button, Card, Check, KV, Row, Screen, T, STATUS_COLORS, useTheme } from '../../components/ui';
import { AnalyzedImage } from '../../components/AnalyzedImage';
import { LaneMap } from '../../components/LaneMap';
import { useApp } from '../../state/store';
import { useLink } from '../../services/hooks';
import { analyzeImageUri } from '../../services/classifierService';
import { canSelectSlot } from '../../core/parking/parkFlow';
import { neighbourIntrusionCm, planRoute } from '../../core/geometry/routePlanner';
import { SlotId } from '../../core/vision/roi';
import modelMeta from '../../../assets/model/slot_classifier.json';

const STEP_LABEL = {
  reading: 'Reading image…',
  decoding: 'Decoding pixels…',
  'loading-model': 'Loading model…',
  classifying: 'Classifying S1–S5…',
} as const;

export default function Park() {
  const t = useTheme();
  const { live } = useLink();
  const config = useApp((s) => s.config);
  const analysis = useApp((s) => s.analysis);
  const selected = useApp((s) => s.selectedSlot);
  const allowIncompatible = useApp((s) => s.allowIncompatibleLayout);
  const roiLayoutName = useApp((s) => s.roiLayoutName);
  const [busy, setBusy] = useState<keyof typeof STEP_LABEL | null>(null);
  const [error, setError] = useState<string | null>(null);

  const plan = useMemo(() => (selected ? planRoute(config, selected) : null), [config, selected]);

  const pick = async (source: 'camera' | 'library') => {
    setError(null);
    try {
      let result: ImagePicker.ImagePickerResult;
      if (source === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          setError('Camera permission was denied.');
          return;
        }
        result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: false, exif: false });
      } else {
        result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: false, exif: false });
      }
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      const roi = useApp.getState().roiConfig();
      const out = await analyzeImageUri(asset.uri, roi, asset.fileName ?? null, (s) => setBusy(s));
      useApp.getState().setAnalysis({
        report: out.report,
        imageUri: out.displayUri, // the normalized (rotated, resized) image the boxes were computed on
        width: out.width,
        height: out.height,
        analyzedAt: Date.now(),
        roiLayout: roiLayoutName,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const report = analysis?.report ?? null;
  const choose = (id: SlotId) => {
    const check = canSelectSlot(report, id, { allowIncompatibleLayout: allowIncompatible });
    if (check.ok) useApp.getState().selectSlot(id);
    else setError(check.reason);
  };

  return (
    <Screen>
      <Card title="1 · Photo of the lot">
        <T muted>
          Top-down photo from the calibrated viewpoint. ROI layout: {roiLayoutName === 'custom' ? 'custom' : roiLayoutName} (change in Settings).
          The on-device MobileNetV3 model labels each of S1–S5 EMPTY, OCCUPIED or UNCERTAIN.
        </T>
        <Row gap={8}>
          <Button label="Take photo" onPress={() => pick('camera')} disabled={!!busy} style={{ flex: 1 }} />
          <Button label="Choose image" variant="ghost" onPress={() => pick('library')} disabled={!!busy} style={{ flex: 1 }} />
        </Row>
        {busy ? (
          <Row>
            <ActivityIndicator />
            <T muted>{STEP_LABEL[busy]}</T>
          </Row>
        ) : null}
        {error ? <Banner kind="error">{error}</Banner> : null}
      </Card>

      {analysis && report ? (
        <>
          <Card title="2 · Results" right={<Badge label={`${report.summary.empty} empty`} color={t.ok} />}>
            <AnalyzedImage uri={analysis.imageUri} width={analysis.width} height={analysis.height} report={report} selected={selected} onPressSlot={choose} />
            {report.warnings.map((w, i) => (
              <Banner key={i} kind={report.layout.compatible ? 'warn' : 'error'}>
                {w}
              </Banner>
            ))}
            {!report.layout.compatible ? (
              <Check
                label="I checked the photo: the five boxes sit on the real bays. Allow selecting EMPTY slots anyway."
                value={allowIncompatible}
                onChange={(v) => useApp.getState().setFlag('allowIncompatibleLayout', v)}
              />
            ) : null}
            <T muted size={12}>
              {report.provider.model} · {report.image.width}×{report.image.height}px · T = {modelMeta.temperature} · UNCERTAIN below{' '}
              {modelMeta.uncertain_threshold} · OCCUPIED and UNCERTAIN slots are never offered as destinations.
            </T>
          </Card>

          <Card title="3 · Choose a destination">
            {report.slots.map((s) => {
              const check = canSelectSlot(report, s.slot_id, { allowIncompatibleLayout: allowIncompatible });
              const sel = selected === s.slot_id;
              return (
                <Pressable
                  key={s.slot_id}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !check.ok, selected: sel }}
                  disabled={!check.ok}
                  onPress={() => choose(s.slot_id)}
                  style={{
                    borderWidth: sel ? 2 : 1,
                    borderColor: sel ? t.accent : t.border,
                    borderRadius: 12,
                    padding: 12,
                    opacity: check.ok ? 1 : 0.6,
                    backgroundColor: sel ? t.accent + '14' : 'transparent',
                  }}
                >
                  <Row style={{ justifyContent: 'space-between' }}>
                    <T bold size={16}>
                      {s.slot_id}
                    </T>
                    <Badge label={s.status} color={STATUS_COLORS[s.status]} />
                  </Row>
                  <T muted size={13}>
                    Confidence {s.confidence === null ? '—' : `${(s.confidence * 100).toFixed(2)}%`} · P(occupied){' '}
                    {s.p_occupied === null ? '—' : s.p_occupied.toFixed(3)}
                  </T>
                  {!check.ok ? <T size={12} color={t.danger}>{check.reason}</T> : sel ? <T size={12} color={t.accent}>Selected destination</T> : null}
                  {s.error ? <T size={12} color={t.danger}>{s.error}</T> : null}
                </Pressable>
              );
            })}
          </Card>
        </>
      ) : null}

      {selected && plan ? (
        <Card title={`4 · Route preview → ${selected}`}>
          <LaneMap config={config} pose={plan.startPose} trail={[]} plan={plan} statuses={Object.fromEntries((report?.slots ?? []).map((s) => [s.slot_id, s.status]))} selectedSlot={selected} live={live} />
          <KV k="Slot interval" v={`${plan.slotStartCm}–${plan.slotEndCm} cm (centre ${plan.slotCentreCm})`} />
          <KV k="Rotate at (rover centre)" v={`${plan.turnStartCm} cm · ${plan.turnStartSource === 'slot-centre' ? 'slot centre' : 'measured'}`} />
          <KV
            k="Rotation"
            v={`90° ${plan.rotation === 'L' ? 'left' : 'right'} · ${plan.rotationMs === null ? 'NOT CALIBRATED' : `${plan.rotationMs} ms @ PWM ${plan.rotationPwm}`}`}
            color={plan.rotationMs === null ? t.danger : undefined}
          />
          <KV k="Entry" v={`${plan.entryMode}-in, ${plan.entryCm} cm into the bay (bays on the ${config.lane.baySide})`} />
          <KV k="Side gaps when parked" v={`${plan.sweep.finalGapLowerCm} / ${plan.sweep.finalGapHigherCm} cm`} />
          <KV k="Rotation accuracy needed" v={`±${plan.headingToleranceDeg}° (corner sweep radius ${plan.rotationRadiusCm} cm)`} />
          <KV k="Swing into a neighbour bay" v={neighbourIntrusionCm(plan) > 0.5 ? `${neighbourIntrusionCm(plan)} cm` : 'none'} />
          {plan.errors.map((e, i) => (
            <Banner key={i} kind="error">{e}</Banner>
          ))}
          {plan.warnings.map((w, i) => (
            <Banner key={i} kind="warn">{w}</Banner>
          ))}
          <Button label="Continue to autonomous parking" onPress={() => router.push('/autopark')} big />
          <T muted size={12}>Nothing moves until you confirm on the next screen.</T>
        </Card>
      ) : null}
    </Screen>
  );
}
