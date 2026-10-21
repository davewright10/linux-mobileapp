import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ProgressProvider } from '@/lib/progress';
import { colors } from '@/lib/theme';

export default function RootLayout() {
  return (
    <ProgressProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700' },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Linux Study' }} />
        <Stack.Screen name="terminal" options={{ title: 'Practice terminal' }} />
        <Stack.Screen name="tutor" options={{ title: 'Ask the tutor' }} />
      </Stack>
    </ProgressProvider>
  );
}
