import React, { useEffect } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { ErrorBoundaryProps, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useApp } from '../state/store';
import { useSafetySync, useTelemetryPoller } from '../services/hooks';
import { Button, useColorMode, useTheme } from '../components/ui';

/** Any render error below this layout shows this screen instead of closing the app. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.bg, padding: 20, paddingTop: 60, gap: 12 }}>
      <Text style={{ color: t.danger, fontSize: 20, fontWeight: '800' }}>Something went wrong</Text>
      <Text style={{ color: t.text }}>The rover keeps itself safe on its own (its watchdog stops the motors without the app).</Text>
      <ScrollView style={{ maxHeight: 240, backgroundColor: t.card, borderRadius: 10, padding: 10 }}>
        <Text style={{ color: t.muted, fontFamily: 'monospace', fontSize: 12 }}>{String(error?.message ?? error)}</Text>
      </ScrollView>
      <Button label="Try again" onPress={retry} big />
    </View>
  );
}

export default function RootLayout() {
  const hydrate = useApp((s) => s.hydrate);
  const t = useTheme();
  const mode = useColorMode();
  useEffect(() => {
    void hydrate();
  }, [hydrate]);
  useTelemetryPoller();
  useSafetySync();
  return (
    <SafeAreaProvider>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.card },
          headerTintColor: t.text,
          headerTitleStyle: { color: t.text },
          contentStyle: { backgroundColor: t.bg },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="autopark" options={{ title: 'Autonomous Parking' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
