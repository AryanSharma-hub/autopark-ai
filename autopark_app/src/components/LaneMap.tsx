/**
 * 2D map of the cardboard lot drawn from the SAME ParkingConfig and RoutePlan
 * the rover executes: lane 0-130 cm, five 26 cm bays, the planned path, the
 * rotation point (with the circle the body sweeps), the estimated rover body
 * and its trail.
 */
import React, { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, G, Line, Polygon, Polyline, Rect, Text as SvgText } from 'react-native-svg';

import { ParkingConfig, laneLengthCm } from '../core/config/parkingConfig';
import { Pose, bodyCorners, frontPoint } from '../core/geometry/kinematics';
import { RoutePlan, samplePlanPath } from '../core/geometry/routePlanner';
import { SLOT_IDS, SlotId } from '../core/vision/roi';
import { SlotStatus } from '../core/vision/classifier';
import { STATUS_COLORS, useTheme } from './ui';

export interface LaneMapProps {
  config: ParkingConfig;
  pose: Pose | null;
  trail?: { x: number; y: number }[];
  plan?: RoutePlan | null;
  statuses?: Partial<Record<SlotId, SlotStatus>> | null;
  selectedSlot?: SlotId | null;
  /** false = telemetry stale/disconnected: rover drawn grey and labelled. */
  live: boolean;
  roverLabel?: string;
}

export function LaneMap({ config, pose, trail, plan, statuses, selectedSlot, live, roverLabel }: LaneMapProps) {
  const t = useTheme();
  const L = laneLengthCm(config);
  const left = config.lane.baySide === 'left';
  const side = left ? 1 : -1;
  const { bayOffsetCm: off, bayDepthCm: depth, slotLengthCm: sl } = config.lane;
  const laneHalf = Math.max(14, config.vehicle.widthCm / 2 + 6);

  const minX = Math.min(-8, config.route.startCm - config.vehicle.lengthCm / 2 - 4);
  const maxX = L + 8;
  const yTop = left ? off + depth + 8 : laneHalf + 6;
  const yBottom = left ? -laneHalf - 10 : -(off + depth + 8);
  const width = maxX - minX;
  const height = yTop - yBottom;
  // world (x, y) -> svg (x, -y)
  const sy = (y: number) => -y;

  const path = useMemo(() => (plan ? samplePlanPath(plan, 1) : []), [plan]);
  const pts = (arr: { x: number; y: number }[]) => arr.map((p) => `${p.x.toFixed(2)},${sy(p.y).toFixed(2)}`).join(' ');

  const body = pose ? bodyCorners(pose, config) : null;
  const nose = pose ? frontPoint(pose, config) : null;
  const roverColor = live ? t.accent : t.muted;

  return (
    <View style={{ width: '100%', aspectRatio: width / height }}>
      <Svg width="100%" height="100%" viewBox={`${minX} ${sy(yTop)} ${width} ${height}`}>
        {/* lane surface */}
        <Rect x={0} y={sy(left ? off : laneHalf)} width={L} height={left ? off + laneHalf : laneHalf + off} fill={t.chip} />
        <Line x1={minX} y1={0} x2={maxX} y2={0} stroke={t.muted} strokeWidth={0.4} strokeDasharray="2,2" />
        {/* bays */}
        {SLOT_IDS.map((id, i) => {
          const st = statuses?.[id];
          const fill = st ? STATUS_COLORS[st] : t.border;
          const y0 = left ? off + depth : -off;
          const selected = selectedSlot === id;
          return (
            <G key={id}>
              <Rect
                x={i * sl}
                y={sy(y0)}
                width={sl}
                height={depth}
                fill={fill}
                fillOpacity={st ? 0.22 : 0.12}
                stroke={selected ? t.accent : t.muted}
                strokeWidth={selected ? 1.6 : 0.5}
              />
              <SvgText x={i * sl + sl / 2} y={sy(left ? off + depth / 2 : -off - depth / 2) + 2} fontSize={5.5} fontWeight="bold" fill={t.text} textAnchor="middle">
                {id}
              </SvgText>
              {st ? (
                <SvgText x={i * sl + sl / 2} y={sy(left ? off + depth / 2 : -off - depth / 2) + 8} fontSize={3.4} fill={fill} textAnchor="middle">
                  {st}
                </SvgText>
              ) : null}
            </G>
          );
        })}
        {/* x-axis ticks every slot boundary */}
        {Array.from({ length: config.lane.slotCount + 1 }, (_, i) => i * sl).map((x) => (
          <G key={x}>
            <Line x1={x} y1={sy(left ? -laneHalf : laneHalf)} x2={x} y2={sy(left ? -laneHalf - 2 : laneHalf + 2)} stroke={t.muted} strokeWidth={0.4} />
            <SvgText x={x} y={sy(left ? -laneHalf - 6.5 : laneHalf + 2.5)} fontSize={3.4} fill={t.muted} textAnchor="middle">
              {x}
            </SvgText>
          </G>
        ))}
        {/* start mark */}
        <Line x1={config.route.startCm} y1={sy(-laneHalf + 2)} x2={config.route.startCm} y2={sy(laneHalf - 2)} stroke={t.ok} strokeWidth={0.6} />
        {/* plan */}
        {path.length > 1 ? <Polyline points={pts(path)} fill="none" stroke={t.accent} strokeOpacity={0.7} strokeWidth={0.8} strokeDasharray="2.5,1.5" /> : null}
        {plan ? (
          <G>
            <Circle cx={plan.turnStartCm} cy={0} r={plan.rotationRadiusCm} fill="none" stroke={t.warn} strokeOpacity={0.6} strokeWidth={0.5} strokeDasharray="1.5,1.5" />
            <Circle cx={plan.turnStartCm} cy={0} r={1} fill={t.warn} />
            <SvgText x={plan.turnStartCm} y={sy(side * -(plan.rotationRadiusCm + 3.5)) + (left ? 1 : 0)} fontSize={3.2} fill={t.warn} textAnchor="middle">
              {`rotate ${plan.rotation === 'L' ? 'left' : 'right'} 90° at ${plan.turnStartCm.toFixed(1)}`}
            </SvgText>
          </G>
        ) : null}
        {/* trail */}
        {trail && trail.length > 1 ? <Polyline points={pts(trail)} fill="none" stroke={t.muted} strokeWidth={0.6} /> : null}
        {/* rover */}
        {body && nose ? (
          <G>
            <Polygon points={pts(body)} fill={roverColor} fillOpacity={0.35} stroke={roverColor} strokeWidth={0.8} />
            <Circle cx={nose.x} cy={sy(nose.y)} r={1.2} fill={roverColor} />
            <Circle cx={pose!.x} cy={sy(pose!.y)} r={0.8} fill={t.text} />
            {!live ? (
              <SvgText x={nose.x} y={sy(nose.y) - 3} fontSize={3.4} fill={t.danger} textAnchor="middle">
                STALE
              </SvgText>
            ) : roverLabel ? (
              <SvgText x={nose.x} y={sy(nose.y) - 3} fontSize={3.2} fill={t.text} textAnchor="middle">
                {roverLabel}
              </SvgText>
            ) : null}
          </G>
        ) : null}
      </Svg>
    </View>
  );
}
