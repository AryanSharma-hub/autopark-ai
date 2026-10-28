/** The analysed photo with the five ROI boxes, status colours and confidences. */
import React, { useState } from 'react';
import { Image, LayoutChangeEvent, Pressable, View } from 'react-native';
import Svg, { G, Rect, Text as SvgText } from 'react-native-svg';

import { AnalysisReport } from '../core/vision/classifier';
import { SlotId } from '../core/vision/roi';
import { STATUS_COLORS, useTheme } from './ui';

export function AnalyzedImage({
  uri,
  width,
  height,
  report,
  selected,
  onPressSlot,
}: {
  uri: string;
  width: number;
  height: number;
  report: AnalysisReport;
  selected: SlotId | null;
  onPressSlot?: (id: SlotId) => void;
}) {
  const t = useTheme();
  const [boxW, setBoxW] = useState(0);
  const scale = boxW / width;
  const onLayout = (e: LayoutChangeEvent) => setBoxW(e.nativeEvent.layout.width);
  return (
    <View onLayout={onLayout} style={{ width: '100%', aspectRatio: width / height, borderRadius: 10, overflow: 'hidden', backgroundColor: t.chip }}>
      <Image source={{ uri }} style={{ position: 'absolute', width: '100%', height: '100%' }} resizeMode="stretch" />
      {boxW > 0 ? (
        <Svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} style={{ position: 'absolute' }}>
          {report.slots.map((s) => {
            const p = s.roi.pixels;
            const c = STATUS_COLORS[s.status];
            const sel = s.slot_id === selected;
            const fs = Math.max(10, Math.min(p.w, p.h) * 0.22);
            return (
              <G key={s.slot_id}>
                <Rect x={p.x} y={p.y} width={p.w} height={p.h} fill={c} fillOpacity={0.15} stroke={sel ? '#2f6bff' : c} strokeWidth={(sel ? 5 : 3) / Math.max(scale, 0.05)} />
                <SvgText x={p.x + 4 / scale} y={p.y + fs * 1.05} fontSize={fs} fontWeight="bold" fill="#fff" stroke="#000" strokeWidth={fs * 0.06}>
                  {s.slot_id}
                </SvgText>
                <SvgText x={p.x + 4 / scale} y={p.y + p.h - fs * 0.35} fontSize={fs * 0.7} fontWeight="bold" fill="#fff" stroke="#000" strokeWidth={fs * 0.05}>
                  {s.status[0]} {s.confidence !== null ? `${(s.confidence * 100).toFixed(1)}%` : '--'}
                </SvgText>
              </G>
            );
          })}
        </Svg>
      ) : null}
      {onPressSlot && boxW > 0
        ? report.slots.map((s) => (
            <Pressable
              key={s.slot_id}
              accessibilityLabel={`Select ${s.slot_id}`}
              onPress={() => onPressSlot(s.slot_id)}
              style={{ position: 'absolute', left: s.roi.pixels.x * scale, top: s.roi.pixels.y * scale, width: s.roi.pixels.w * scale, height: s.roi.pixels.h * scale }}
            />
          ))
        : null}
    </View>
  );
}

/** Cropped view of one slot from the photo (for "confirm the bay is empty"). */
export function SlotCrop({ uri, width, height, roi, size = 140 }: { uri: string; width: number; height: number; roi: { x: number; y: number; w: number; h: number }; size?: number }) {
  const s = size / Math.max(roi.w, roi.h);
  return (
    <View style={{ width: roi.w * s, height: roi.h * s, overflow: 'hidden', borderRadius: 8 }}>
      <Image source={{ uri }} style={{ position: 'absolute', left: -roi.x * s, top: -roi.y * s, width: width * s, height: height * s }} resizeMode="stretch" />
    </View>
  );
}
