/**
 * The traveller's trips.
 *
 * Sorted by most recent, newest first, with the trip that needs attention -
 * an active delay - pulled to the top. Everything else is a card, because a
 * list of trips is a list of decisions, not a document to read.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../context/AuthContext';
import { trips as tripsApi } from '../api/endpoints';
import {
  Badge, Button, Card, EmptyState, Row, Skeleton,
} from '../components/ui';
import { colors, radius, space, type } from '../theme';
import { money, nightsBetween, relativeTime, statusTone } from '../utils/format';
import { describeError } from '../utils/errors';

export default function TripsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { token } = useAuth();

  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!quiet) setLoading(true);
      try {
        const result = await tripsApi.list(token, 100);
        setTrips(result?.trips || []);
        setError(null);
      } catch (e) {
        setError(describeError(e));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [token],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Refresh on focus: a trip replanned or booked from another screen should be
  // current when the user comes back to the list, not stale until a pull.
  useFocusEffect(
    useCallback(() => {
      load({ quiet: true });
    }, [load]),
  );

  // An active delay is the one thing on this list that is time-critical, so it
  // sorts above everything else regardless of when the trip was created.
  const ordered = useMemo(() => {
    const needsAttention = (t) => t.activeDelay;
    return [...trips].sort((a, b) => {
      const attention = Number(needsAttention(b)) - Number(needsAttention(a));
      if (attention) return attention;
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
  }, [trips]);

  const onRefresh = () => {
    setRefreshing(true);
    load({ quiet: true });
  };

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Your trips</Text>
        {trips.length ? <Text style={styles.count}>{trips.length} total</Text> : null}
      </View>

      <View style={styles.body}>
        {loading ? (
          <View style={styles.skeletons}>
            <Skeleton height={120} style={styles.skeletonBlock} />
            <Skeleton height={120} style={styles.skeletonBlock} />
            <Skeleton height={120} />
          </View>
        ) : error && !trips.length ? (
          <EmptyState
            icon="⚠️"
            title={error.tone === 'warning' ? 'Cannot reach the server' : 'Something went wrong'}
            message={error.message}
            action={error.action === 'Retry' ? 'Try again' : undefined}
            onAction={() => load()}
          />
        ) : !ordered.length ? (
          <EmptyState
            icon="🧳"
            title="No trips yet"
            message="Plan your first trip and we will coordinate the providers, then keep the plan honest if anything changes."
            action="Plan a trip"
            onAction={() => navigation.navigate('Plan')}
          />
        ) : (
          <FlatList
            data={ordered}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
            ListHeaderComponent={
              ordered.some((t) => t.activeDelay) ? (
                <View style={styles.alertHeader}>
                  {ordered
                    .filter((t) => t.activeDelay)
                    .map((trip) => (
                      <DisruptionAlert
                        key={trip.id}
                        trip={trip}
                        onPress={() => navigation.navigate('Replan', { tripId: trip.id })}
                      />
                    ))}
                </View>
              ) : null
            }
            renderItem={({ item }) => (
              <TripCard
                trip={item}
                onOpen={(tripId) => navigation.navigate('TripDetail', { tripId })}
                onReplan={(tripId) => navigation.navigate('Replan', { tripId })}
              />
            )}
          />
        )}
      </View>
    </View>
  );
}

/** The prominent banner for a trip with a live disruption. */
function DisruptionAlert({ trip, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Re-plan ${trip.origin} to ${trip.destination}, ${trip.delayMinutes} minutes late`}
      style={styles.alert}
    >
      <View style={styles.alertText}>
        <Text style={styles.alertTitle}>
          {trip.origin} → {trip.destination} is {trip.delayMinutes} min late
        </Text>
        <Text style={styles.alertBody}>Tap to see what re-planning would change</Text>
      </View>
      <Text style={styles.alertCta}>Review</Text>
    </Pressable>
  );
}

function TripCard({ trip, onOpen, onReplan }) {
  const nights = nightsBetween(trip.startDate, trip.endDate);
  const unplanned = trip.status === 'DRAFT' || !trip.hasSelectedItinerary;

  return (
    <Card onPress={() => onOpen(trip.id)} testID={`trip-card-${trip.id}`}>
      <Row style={styles.cardTop}>
        <View style={styles.cardRoute}>
          <Text style={styles.route} numberOfLines={1}>
            {trip.origin} → {trip.destination}
          </Text>
          <Text style={styles.dates} numberOfLines={1}>
            {trip.startDate}
            {nights ? ` · ${nights} night${nights === 1 ? '' : 's'}` : ''}
            {trip.travelers ? ` · ${trip.travelers} traveller${trip.travelers === 1 ? '' : 's'}` : ''}
          </Text>
        </View>
        <Badge label={trip.status} tone={statusTone(trip.status)} />
      </Row>

      <Row style={styles.cardBottom}>
        <Text style={styles.cardCost}>
          {unplanned
            ? 'Not planned yet'
            : `${money(trip.totalEstimatedCost, { compact: true })} planned`}
        </Text>
        <Text style={styles.cardMeta}>
          {trip.bookingCount ? `${trip.bookingCount} booking${trip.bookingCount === 1 ? '' : 's'}` : null}
          {trip.bookingCount ? ' · ' : ''}
          {relativeTime(trip.createdAt)}
        </Text>
      </Row>

      {trip.activeDelay ? (
        <Button
          label="Re-plan this trip"
          variant="danger"
          size="md"
          onPress={() => onReplan(trip.id)}
          style={styles.cardAction}
        />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.ink04 },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  title: { ...type.display },
  count: { ...type.caption },
  body: { flex: 1 },

  list: { paddingHorizontal: space.lg, paddingBottom: space.xxxl },

  skeletons: { padding: space.lg },
  skeletonBlock: { marginBottom: space.md },

  alertHeader: { marginBottom: space.md },
  alert: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.warningBg,
    borderRadius: radius.md,
    borderLeftWidth: 4,
    borderLeftColor: colors.warning,
    padding: space.md,
    marginBottom: space.sm,
    minHeight: 64,
  },
  alertText: { flex: 1 },
  alertTitle: { ...type.bodyStrong, color: colors.warning },
  alertBody: { ...type.caption, marginTop: 2 },
  alertCta: { ...type.small, fontWeight: '700', color: colors.warning },

  cardTop: { alignItems: 'flex-start', marginBottom: space.md },
  cardRoute: { flex: 1, paddingRight: space.sm },
  route: { ...type.subheading },
  dates: { ...type.caption, marginTop: 2 },

  cardBottom: { justifyContent: 'space-between' },
  cardCost: { ...type.small, fontWeight: '700', color: colors.brand700 },
  cardMeta: { ...type.caption },
  cardAction: { marginTop: space.md },
});
