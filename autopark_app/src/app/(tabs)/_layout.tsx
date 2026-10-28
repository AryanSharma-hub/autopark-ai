import React from 'react';
import { ColorValue, Text } from 'react-native';
import { Tabs } from 'expo-router/js-tabs';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RoverBar } from '../../components/RoverBar';
import { useTheme } from '../../components/ui';

function Header({ title }: { title?: string }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <>
      <Text style={{ color: t.text, fontSize: 20, fontWeight: '800', paddingHorizontal: 12, paddingTop: insets.top + 8, paddingBottom: 6, backgroundColor: t.card }}>
        {title}
      </Text>
      <RoverBar />
    </>
  );
}

const icon = (glyph: string) =>
  function TabIcon({ color }: { color: ColorValue }) {
    return <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;
  };

export default function TabsLayout() {
  const t = useTheme();
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: t.accent,
        tabBarStyle: { backgroundColor: t.card, borderTopColor: t.border },
        headerStyle: { backgroundColor: t.card },
        headerTitleStyle: { color: t.text },
        sceneStyle: { backgroundColor: t.bg },
        header: ({ options }) => <Header title={options.title} />,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Dashboard', tabBarIcon: icon('◉') }} />
      <Tabs.Screen name="manual" options={{ title: 'Manual', tabBarIcon: icon('✥') }} />
      <Tabs.Screen name="park" options={{ title: 'Park', tabBarIcon: icon('▣') }} />
      <Tabs.Screen name="map" options={{ title: 'Live Map', tabBarIcon: icon('⌖') }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('⚙') }} />
    </Tabs>
  );
}
