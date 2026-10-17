import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useFonts } from 'expo-font';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation/RootNavigator';
import { BACKEND_URL } from './src/shared/config/env';

// Wake a sleeping server while the app is still starting, so the first real request is not the one that waits.
fetch(BACKEND_URL + '/health', { method: 'GET' }).catch(() => {});

export default function App() {
  // The vector icons are fonts. On a phone they must be loaded before the first screen, or tab bar icons stay blank.
  const [fontsLoaded, fontError] = useFonts({ ...Ionicons.font });
  const [waited, setWaited] = React.useState(false);
  React.useEffect(() => {
    const t = setTimeout(() => setWaited(true), 4000); // never hold the app for more than 4 seconds
    return () => clearTimeout(t);
  }, []);
  if (!fontsLoaded && !fontError && !waited) {
    return (
      <View style={{ flex: 1, backgroundColor: '#075E54', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#FFFFFF" />
      </View>
    );
  }
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <RootNavigator />
    </SafeAreaProvider>
  );
}
