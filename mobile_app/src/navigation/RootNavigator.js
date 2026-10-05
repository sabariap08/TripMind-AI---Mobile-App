/**
 * Navigation.
 *
 * Five tabs for the five things a traveller actually does, and one root stack
 * above them for anything that needs the full screen. Re-planning, the trip
 * detail and the ticket are not tabs because they are not destinations - they
 * are answers to a question the user asked on one of them.
 *
 * The signed-out state is a completely separate stack, so no signed-in screen
 * can ever be reached without a token behind it.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../context/AuthContext';
import { colors, space, type } from '../theme';

import SignInScreen from '../screens/SignInScreen';
import RegisterScreen from '../screens/RegisterScreen';
import PlanTripScreen from '../screens/PlanTripScreen';
import TripsScreen from '../screens/TripsScreen';
import TripDetailScreen from '../screens/TripDetailScreen';
import ReplanScreen from '../screens/ReplanScreen';
import BookingsScreen from '../screens/BookingsScreen';
import TicketScreen from '../screens/TicketScreen';
import WalletScreen from '../screens/WalletScreen';
import ProfileScreen from '../screens/ProfileScreen';
import SettingsScreen from '../screens/SettingsScreen';
import TripEventsScreen from '../screens/TripEventsScreen';

const RootStack = createNativeStackNavigator();
const AuthStack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

const headerOptions = {
  headerStyle: { backgroundColor: colors.brand800 },
  headerTintColor: colors.white,
  headerTitleStyle: { fontSize: 17, fontWeight: '700' },
  headerShadowVisible: false,
  contentStyle: { backgroundColor: colors.ink04 },
};

const TAB_ICONS = {
  Plan: '✈️',
  Trips: '🗺️',
  Bookings: '🎫',
  Wallet: '💳',
  Account: '👤',
};

// ------------------------------------------------------------------- auth
function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={headerOptions}>
      <AuthStack.Screen
        name="SignIn"
        component={SignInScreen}
        options={{ headerShown: false }}
      />
      <AuthStack.Screen
        name="Register"
        component={RegisterScreen}
        options={{ title: 'Create your account' }}
      />
    </AuthStack.Navigator>
  );
}

// ------------------------------------------------------------------- tabs
function MainTabs() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.brand700,
        tabBarInactiveTintColor: colors.ink50,
        tabBarStyle: [
          styles.tabBar,
          // The bottom inset is added to the bar rather than to a wrapper, so
          // the gesture bar area is part of the tappable surface and the labels
          // never sit under the home indicator.
          { height: 58 + insets.bottom, paddingBottom: insets.bottom + 6 },
        ],
        tabBarLabelStyle: styles.tabLabel,
        tabBarIcon: ({ focused }) => (
          <Text style={[styles.tabIcon, focused && styles.tabIconActive]}>
            {TAB_ICONS[route.name] || '•'}
          </Text>
        ),
      })}
    >
      <Tabs.Screen name="Plan" component={PlanTripScreen} />
      <Tabs.Screen name="Trips" component={TripsScreen} />
      <Tabs.Screen name="Bookings" component={BookingsScreen} />
      <Tabs.Screen name="Wallet" component={WalletScreen} />
      <Tabs.Screen name="Account" component={ProfileScreen} />
    </Tabs.Navigator>
  );
}

// ------------------------------------------------------------------- root
export default function RootNavigator() {
  const { isSignedIn, restoring } = useAuth();

  if (restoring) return <BootSplash />;
  if (!isSignedIn) return <AuthNavigator />;

  return (
    <RootStack.Navigator screenOptions={headerOptions}>
      <RootStack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
      <RootStack.Screen
        name="TripDetail"
        component={TripDetailScreen}
        options={{ title: 'Your itinerary' }}
      />
      <RootStack.Screen
        name="Replan"
        component={ReplanScreen}
        options={{ title: 'Re-plan this trip' }}
      />
      <RootStack.Screen
        name="TripEvents"
        component={TripEventsScreen}
        options={{ title: 'Trip timeline' }}
      />
      <RootStack.Screen name="Ticket" component={TicketScreen} options={{ title: 'Your ticket' }} />
      <RootStack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
    </RootStack.Navigator>
  );
}

/**
 * Shown for the moment it takes to read the keystore and confirm the token.
 *
 * A branded splash rather than a spinner, so a cold start looks deliberate
 * instead of broken.
 */
function BootSplash() {
  return (
    <View style={styles.splash}>
      <Text style={styles.splashMark}>TripMind AI</Text>
      <Text style={styles.splashTagline}>Plan once. Survive anything.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.white,
    borderTopColor: colors.ink08,
    borderTopWidth: 1,
    paddingTop: 6,
  },
  tabLabel: { fontSize: 11, fontWeight: '600', marginTop: 2 },
  tabIcon: { fontSize: 20, opacity: 0.55 },
  tabIconActive: { opacity: 1 },

  splash: {
    flex: 1,
    backgroundColor: colors.brand800,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  splashMark: { fontSize: 30, fontWeight: '800', color: colors.white, letterSpacing: -0.5 },
  splashTagline: { ...type.small, color: colors.brand300 },
});
