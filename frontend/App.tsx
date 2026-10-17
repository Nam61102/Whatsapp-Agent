import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation/RootNavigator';
import { BACKEND_URL } from './src/shared/config/env';

// Wake a sleeping server while the app is still starting, so the first real request is not the one that waits.
fetch(BACKEND_URL + '/docs', { method: 'GET' }).catch(() => {});

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <RootNavigator />
    </SafeAreaProvider>
  );
}
