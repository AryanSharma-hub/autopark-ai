import React, { ReactNode, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, ViewStyle, useColorScheme } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useApp } from '../state/store';

export const palette = {
  light: {
    bg: '#f4f5f7',
    card: '#ffffff',
    text: '#14171c',
    muted: '#5d6673',
    border: '#e1e4e8',
    accent: '#2457d6',
    danger: '#c62828',
    ok: '#1e8a4c',
    warn: '#b7791f',
    chip: '#eef1f5',
  },
  dark: {
    bg: '#0f1115',
    card: '#181b21',
    text: '#eceff3',
    muted: '#9aa3ae',
    border: '#2a2f37',
    accent: '#6b93ff',
    danger: '#ef5350',
    ok: '#4cc38a',
    warn: '#e0b050',
    chip: '#22262e',
  },
};
export type Palette = typeof palette.light;

export const STATUS_COLORS = { EMPTY: '#1e8a4c', OCCUPIED: '#c62828', UNCERTAIN: '#c98a12' } as const;

/** 'dark' | 'light' after applying the user's preference (Settings › Appearance) over the system setting. */
export function useColorMode(): 'dark' | 'light' {
  const system = useColorScheme();
  const pref = useApp((s) => s.themePref);
  if (pref === 'dark' || pref === 'light') return pref;
  return system === 'dark' ? 'dark' : 'light';
}

export function useTheme(): Palette {
  return useColorMode() === 'dark' ? palette.dark : palette.light;
}

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const content = <View style={{ padding: 16, paddingBottom: 32 + insets.bottom, gap: 12 }}>{children}</View>;
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {scroll ? <ScrollView keyboardShouldPersistTaps="handled">{content}</ScrollView> : content}
    </View>
  );
}

export function Card({ title, children, right, style }: { title?: string; children: ReactNode; right?: ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return (
    <View style={[{ backgroundColor: t.card, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, padding: 14, gap: 10 }, style]}>
      {title ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{title}</Text>
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function T({ children, muted, size = 14, bold, color, style }: { children: ReactNode; muted?: boolean; size?: number; bold?: boolean; color?: string; style?: object }) {
  const t = useTheme();
  return <Text style={[{ color: color ?? (muted ? t.muted : t.text), fontSize: size, fontWeight: bold ? '700' : '400' }, style]}>{children}</Text>;
}

export function Row({ children, gap = 8, wrap, style }: { children: ReactNode; gap?: number; wrap?: boolean; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap, flexWrap: wrap ? 'wrap' : 'nowrap' }, style]}>{children}</View>;
}

export function KV({ k, v, color }: { k: string; v: ReactNode; color?: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <Text style={{ color: t.muted, fontSize: 14 }}>{k}</Text>
      <Text style={{ color: color ?? t.text, fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'right' }}>{v}</Text>
    </View>
  );
}

type BtnVariant = 'primary' | 'danger' | 'ghost' | 'ok';

export function Button({
  label,
  onPress,
  onPressIn,
  onPressOut,
  variant = 'primary',
  disabled,
  big,
  style,
  testID,
}: {
  label: string;
  onPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  variant?: BtnVariant;
  disabled?: boolean;
  big?: boolean;
  style?: ViewStyle;
  testID?: string;
}) {
  const t = useTheme();
  const bg = variant === 'primary' ? t.accent : variant === 'danger' ? t.danger : variant === 'ok' ? t.ok : t.chip;
  const fg = variant === 'ghost' ? t.text : '#ffffff';
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          opacity: disabled ? 0.4 : pressed ? 0.75 : 1,
          paddingVertical: big ? 18 : 11,
          paddingHorizontal: 14,
          borderRadius: 12,
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 44,
        },
        style,
      ]}
    >
      <Text style={{ color: fg, fontWeight: '700', fontSize: big ? 18 : 15 }}>{label}</Text>
    </Pressable>
  );
}

export function Badge({ label, color }: { label: string; color: string }) {
  return (
    <View style={{ backgroundColor: color + '22', borderColor: color, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
      <Text style={{ color, fontSize: 12, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

export function Check({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, opacity: disabled ? 0.5 : 1, paddingVertical: 4 }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          borderWidth: 2,
          borderColor: value ? t.accent : t.muted,
          backgroundColor: value ? t.accent : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 1,
        }}
      >
        {value ? <Text style={{ color: '#fff', fontWeight: '900', fontSize: 13 }}>✓</Text> : null}
      </View>
      <Text style={{ color: t.text, fontSize: 14, flex: 1 }}>{label}</Text>
    </Pressable>
  );
}

/** Numeric input that only commits valid numbers (on blur / submit). */
export function NumberField({
  label,
  value,
  onCommit,
  unit,
  estimated,
  integer,
  min,
  max,
  help,
  allowEmpty,
}: {
  label: string;
  value: number | null;
  onCommit: (v: number | null) => void;
  unit?: string;
  estimated?: boolean;
  integer?: boolean;
  min?: number;
  max?: number;
  help?: string;
  allowEmpty?: boolean;
}) {
  const t = useTheme();
  const [text, setText] = useState(value === null ? '' : String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(value === null ? '' : String(value)), [value]);
  const commit = () => {
    if (text.trim() === '' && allowEmpty) {
      setError(null);
      onCommit(null);
      return;
    }
    const v = Number(text.replace(',', '.'));
    if (!Number.isFinite(v)) return setError('Not a number');
    if (integer && !Number.isInteger(v)) return setError('Whole number required');
    if (min !== undefined && v < min) return setError(`Min ${min}`);
    if (max !== undefined && v > max) return setError(`Max ${max}`);
    setError(null);
    if (v !== value) onCommit(v);
  };
  return (
    <View style={{ gap: 4 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row gap={6} style={{ flexShrink: 1 }}>
          <Text style={{ color: t.text, fontSize: 14, flexShrink: 1 }}>{label}</Text>
          {estimated ? <Badge label="ESTIMATE" color={t.warn} /> : null}
        </Row>
        <Row gap={6}>
          <TextInput
            value={text}
            onChangeText={setText}
            onBlur={commit}
            onSubmitEditing={commit}
            keyboardType="numeric"
            placeholder={allowEmpty ? 'auto' : ''}
            placeholderTextColor={t.muted}
            style={{
              minWidth: 76,
              textAlign: 'right',
              color: t.text,
              borderWidth: 1,
              borderColor: error ? t.danger : t.border,
              borderRadius: 8,
              paddingHorizontal: 8,
              paddingVertical: 6,
              fontSize: 15,
              backgroundColor: t.bg,
            }}
          />
          {unit ? <Text style={{ color: t.muted, width: 34 }}>{unit}</Text> : null}
        </Row>
      </Row>
      {help ? <Text style={{ color: t.muted, fontSize: 12 }}>{help}</Text> : null}
      {error ? <Text style={{ color: t.danger, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', backgroundColor: t.chip, borderRadius: 10, padding: 3 }}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          onPress={() => onChange(o.value)}
          accessibilityRole="button"
          accessibilityState={{ selected: o.value === value }}
          style={{ flex: 1, paddingVertical: 8, borderRadius: 8, backgroundColor: o.value === value ? t.card : 'transparent', alignItems: 'center' }}
        >
          <Text style={{ color: t.text, fontWeight: o.value === value ? '700' : '500', fontSize: 13 }}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Banner({ kind, children }: { kind: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  const t = useTheme();
  const c = kind === 'error' ? t.danger : kind === 'warn' ? t.warn : kind === 'ok' ? t.ok : t.accent;
  return (
    <View style={{ borderLeftWidth: 4, borderLeftColor: c, backgroundColor: c + '18', padding: 10, borderRadius: 8 }}>
      {typeof children === 'string' ? <Text style={{ color: t.text, fontSize: 13 }}>{children}</Text> : children}
    </View>
  );
}

export function ProgressBar({ value, color }: { value: number; color?: string }) {
  const t = useTheme();
  const v = Math.max(0, Math.min(1, value));
  return (
    <View style={{ height: 10, borderRadius: 5, backgroundColor: t.chip, overflow: 'hidden' }}>
      <View style={{ width: `${v * 100}%`, height: '100%', backgroundColor: color ?? t.accent }} />
    </View>
  );
}
