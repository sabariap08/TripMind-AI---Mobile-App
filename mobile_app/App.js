import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';

import { AuthProvider } from './src/context/AuthContext';
import RootNavigator from './src/navigation/RootNavigator';
import { colors } from './src/theme';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AuthProvider>
        <NavigationContainer
          // Matching the header colour stops a white flash between screens
          // while the native stack animates, which is very visible on the deep
          // green used in the header.
          theme={{
            dark: false,
            colors: {
              primary: colors.brand700,
              background: colors.ink04,
              card: colors.white,
              text: colors.ink,
              border: colors.ink08,
              notification: colors.danger,
            },
          }}
        >
          <RootNavigator />
        </NavigationContainer>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
