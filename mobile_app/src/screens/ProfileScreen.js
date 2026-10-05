/**
 * Account.
 *
 * Identity, privacy, and the way out. Grouped as three short lists rather than
 * one long settings page, because the three questions here are different:
 * "who am I", "what do you hold about me", and "how do I change or leave".
 *
 * The privacy row is not decoration. The system makes a real claim - raw names,
 * ages, health free text and identity documents never leave the server - and a
 * claim like that should be readable in the app, not buried in a policy page.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../context/AuthContext';
import { bookings as bookingsApi, trips as tripsApi } from '../api/endpoints';
import {
  Badge, Button, Callout, Card, DataRow, Divider, Row, Skeleton,
} from '../components/ui';
import { colors, space, type } from '../theme';
import { initials, money, relativeTime } from '../utils/format';
import { describeError } from '../utils/errors';

export default function ProfileScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { token, user, signOut } = useAuth();

  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!quiet) setLoading(true);
      try {
        const [tripResult, bookingResult] = await Promise.all([
          tripsApi.list(token, 100),
          bookingsApi.list(token),
        ]);
        const trips = tripResult?.trips || [];
        const bookings = bookingResult?.bookings || [];
        setStats({
          trips: trips.length,
          planned: trips.filter((t) => t.hasSelectedItinerary).length,
          disrupted: trips.filter((t) => t.activeDelay).length,
          bookings: bookings.length,
          spent: bookings
            .filter((b) => b.paymentStatus === 'COMPLETED')
            .reduce((sum, b) => sum + (Number(b.cost) || 0), 0),
        });
        setError(null);
      } catch (e) {
        setError(describeError(e));
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      load({ quiet: true });
    }, [load]),
  );

  const confirmSignOut = useCallback(() => {
    Alert.alert('Sign out?', 'Your trips stay saved to your account.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: signOut },
    ]);
  }, [signOut]);

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.xxxl },
      ]}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={false} onRefresh={() => load({ quiet: true })} />
      }
    >
      {/* ------------------------------------------------------ identity */}
      <Card style={styles.identityCard}>
        <Row gap={space.md}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(user?.name)}</Text>
          </View>
          <View style={styles.identityText}>
            <Text style={styles.name}>{user?.name || 'Traveller'}</Text>
            <Text style={styles.email}>{user?.email}</Text>
          </View>
          {user?.role && user.role !== 'TRAVELLER' ? (
            <Badge label={titleCaseRole(user.role)} tone="brand" />
          ) : null}
        </Row>

        {user?.mobile || user?.phone ? (
          <>
            <Divider />
            <DataRow label="Mobile" value={user.mobile || user.phone} />
          </>
        ) : null}
        {user?.createdAt ? (
          <DataRow label="Member since" value={relativeTime(user.createdAt)} />
        ) : null}
      </Card>

      {/* --------------------------------------------------------- stats */}
      {loading ? (
        <Skeleton height={92} style={styles.gap} />
      ) : stats ? (
        <Card style={styles.statsCard}>
          <Row gap={space.sm}>
            <Stat label="Trips" value={stats.trips} />
            <Stat label="Planned" value={stats.planned} />
            <Stat label="Bookings" value={stats.bookings} />
          </Row>
          <Divider />
          <DataRow label="Paid through TripMind" value={money(stats.spent)} />
          {stats.disrupted ? (
            <Callout
              tone="warning"
              title={`${stats.disrupted} trip with an active delay`}
              message="Something changed and has not been re-planned yet."
              action="Review"
              onAction={() => navigation.navigate('Trips')}
              style={styles.statsCallout}
            />
          ) : null}
        </Card>
      ) : null}

      {error ? (
        <Callout
          tone={error.tone || 'danger'}
          message={error.message}
          action={error.action === 'Retry' ? 'Try again' : undefined}
          onAction={error.action === 'Retry' ? () => load() : undefined}
        />
      ) : null}

      {/* -------------------------------------------------------- privacy */}
      <Text style={styles.sectionTitle}>What we hold</Text>
      <Card style={styles.privacyCard}>
        <Row gap={space.md} style={styles.privacyHead}>
          <Text style={styles.privacyIcon}>🔒</Text>
          <Text style={styles.privacyTitle}>Health and identity stay on the server</Text>
        </Row>
        <Text style={styles.privacyBody}>
          Names, ages, health notes and identity documents are stored server-side and never sent
          to the AI planner. Planning receives only derived signals - for example that a
          traveller needs step-free access - and each booking keeps its own snapshot of who was
          travelling, so changing details later cannot silently rewrite a confirmed booking's
          safety notes.
        </Text>
      </Card>

      {/* ------------------------------------------------------ settings */}
      <Text style={styles.sectionTitle}>Settings</Text>
      <Card style={styles.menuCard}>
        <MenuRow
          icon="⚙️"
          label="App settings"
          hint="Server address, API status, storage"
          onPress={() => navigation.navigate('Settings')}
        />
        <Divider />
        <MenuRow
          icon="🔑"
          label="Change password"
          hint="Requires your current password"
          onPress={() => navigation.navigate('Settings', { focus: 'password' })}
        />
      </Card>

      <Button
        label="Sign out"
        icon="↩"
        variant="secondary"
        onPress={confirmSignOut}
        style={styles.signOut}
      />

      <Text style={styles.version}>TripMind AI · Expo 57 · React Native 0.86</Text>
    </ScrollView>
  );
}

function Stat({ label, value }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

/** A settings row: glyph, label, hint, chevron. Not a button - a link. */
function MenuRow({ icon, label, hint, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={hint ? `${label}. ${hint}` : label}
      style={({ pressed }) => [styles.menuRow, pressed && { opacity: 0.7 }]}
    >
      <Text style={styles.menuIcon}>{icon}</Text>
      <View style={styles.menuText}>
        <Text style={type.bodyStrong}>{label}</Text>
        {hint ? <Text style={styles.menuHint}>{hint}</Text> : null}
      </View>
      <Text style={styles.menuChevron}>›</Text>
    </Pressable>
  );
}

function titleCaseRole(role) {
  return String(role).toLowerCase().replace(/^[a-z]/, (c) => c.toUpperCase());
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.ink04 },
  content: { paddingHorizontal: space.lg },
  gap: { marginBottom: space.md },

  identityCard: { paddingVertical: space.lg },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.brand700,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 19, fontWeight: '800', color: colors.white },
  identityText: { flex: 1 },
  name: { ...type.heading },
  email: { ...type.caption, marginTop: 2 },

  statsCard: {},
  statsCallout: { marginTop: space.md, marginBottom: 0 },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { fontSize: 22, fontWeight: '800', color: colors.ink },
  statLabel: { ...type.caption, marginTop: 2 },

  sectionTitle: { ...type.subheading, marginTop: space.lg, marginBottom: space.sm },

  privacyCard: { backgroundColor: colors.brand50, borderColor: colors.brand100 },
  privacyHead: { alignItems: 'flex-start', marginBottom: space.sm },
  privacyIcon: { fontSize: 20 },
  privacyTitle: { ...type.bodyStrong, color: colors.brand800, flex: 1 },
  privacyBody: { ...type.small, lineHeight: 20 },

  menuCard: { paddingVertical: space.xs },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 56,
    paddingVertical: space.sm,
  },
  menuIcon: { fontSize: 18, width: 24, textAlign: 'center' },
  menuText: { flex: 1 },
  menuHint: { ...type.caption, marginTop: 1 },
  menuChevron: { fontSize: 22, color: colors.ink30 },

  signOut: { marginTop: space.xl },
  version: { ...type.caption, textAlign: 'center', marginTop: space.lg },
});
