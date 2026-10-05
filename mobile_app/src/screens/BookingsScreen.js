/**
 * Bookings.
 *
 * Grouped by trip rather than by date, because that is how the question is
 * asked: "is my Goa trip sorted?" - not "what did I book on the 14th?".
 * Within a trip, bookings sort by date, so the next thing to happen is first.
 *
 * Actions are deliberately gated by status rather than shown and then refused:
 * an outstanding booking can be paid, a guide request awaiting approval cannot,
 * and a cancelled booking offers nothing. The shared booking service is the
 * authority on all of these rules, so the client only mirrors the states it
 * knows about and never blocks itself in a way the server would allow.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../context/AuthContext';
import { bookings as bookingsApi, trips as tripsApi } from '../api/endpoints';
import {
  Badge, Button, Callout, Card, EmptyState, Row, Skeleton,
} from '../components/ui';
import { colors, space, type } from '../theme';
import { itineraryIcon, money, relativeTime, shortDate } from '../utils/format';
import { describeError, errorLine } from '../utils/errors';

/** Status -> badge tone. Kept here so bookings and tickets read identically. */
const STATUS_TONE = {
  CONFIRMED: 'success',
  PENDING: 'warning',
  APPROVED: 'success',
  ACTIVE: 'brand',
  COMPLETED: 'brand',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
};

export default function BookingsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { token } = useAuth();

  const [bookings, setBookings] = useState([]);
  const [tripsById, setTripsById] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!quiet) setLoading(true);
      try {
        const [bookingResult, tripResult] = await Promise.all([
          bookingsApi.list(token),
          tripsApi.list(token, 100),
        ]);
        setBookings(bookingResult?.bookings || []);
        setTripsById(
          Object.fromEntries((tripResult?.trips || []).map((t) => [t.id, t])),
        );
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

  // Paying in the wallet tab changes what this list shows, so refresh on focus.
  useFocusEffect(
    useCallback(() => {
      load({ quiet: true });
    }, [load]),
  );

  const sections = useMemo(
    () => groupByTrip(bookings, tripsById),
    [bookings, tripsById],
  );

  const outstanding = useMemo(
    () =>
      bookings.filter(
        (b) => b.paymentStatus === 'PENDING' && b.status !== 'CANCELLED' && b.status !== 'REJECTED',
      ),
    [bookings],
  );

  const run = useCallback(
    async (booking, action) => {
      setBusyId(booking.id);
      try {
        if (action === 'pay') {
          await bookingsApi.pay(token, booking.id);
        } else {
          await bookingsApi.cancel(token, booking.id);
        }
        await load({ quiet: true });
      } catch (e) {
        const described = describeError(e);
        Alert.alert(
          action === 'pay' ? 'Payment did not go through' : 'Could not cancel',
          described?.message || errorLine(e),
        );
      } finally {
        setBusyId(null);
      }
    },
    [token, load],
  );

  const confirmCancel = useCallback(
    (booking) => {
      Alert.alert(
        'Cancel this booking?',
        `${describeBooking(booking)}${
          booking.paymentStatus === 'COMPLETED'
            ? '\n\nYou have already paid for this. Cancellation depends on the provider refund policy.'
            : '\n\nAny amount held for it will be returned to your wallet.'
        }`,
        [
          { text: 'Keep it', style: 'cancel' },
          { text: 'Cancel booking', style: 'destructive', onPress: () => run(booking, 'cancel') },
        ],
      );
    },
    [run],
  );

  const payAll = useCallback(async () => {
    if (!outstanding.length) return;
    Alert.alert(
      'Pay every outstanding booking?',
      `${outstanding.length} booking${outstanding.length === 1 ? '' : 's'} totalling ${money(
        outstanding.reduce((sum, b) => sum + (Number(b.cost) || 0), 0),
      )} will be charged to your TripMind wallet in one action.`,
      [
        { text: 'Not yet', style: 'cancel' },
        { text: 'Pay all', onPress: async () => {
          setBusyId('all');
          try {
            const tripIds = [...new Set(outstanding.map((b) => b.tripId).filter(Boolean))];
            for (const id of tripIds) await bookingsApi.payTrip(token, id);
            await load({ quiet: true });
          } catch (e) {
            Alert.alert('Payment incomplete', describeError(e)?.message || errorLine(e));
          } finally {
            setBusyId(null);
          }
        } },
      ],
    );
  }, [outstanding, token, load]);

  if (loading) {
    return (
      <View style={[styles.flex, { paddingTop: insets.top + space.lg, paddingHorizontal: space.lg }]}>
        <Skeleton height={64} style={styles.gap} />
        <Skeleton height={96} style={styles.gap} />
        <Skeleton height={96} />
      </View>
    );
  }

  return (
    <SectionList
      style={styles.flex}
      sections={sections}
      keyExtractor={(item) => item.id}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl },
      ]}
      showsVerticalScrollIndicator={false}
      stickySectionHeadersEnabled={false}
      refreshControl={
        <RefreshControl refreshing={false} onRefresh={() => load({ quiet: true })} />
      }
      ListHeaderComponent={
        <View>
          <Text style={styles.title}>Bookings</Text>
          {bookings.length ? (
            <Text style={styles.subtitle}>
              {bookings.length} across {sections.length} trip{sections.length === 1 ? '' : 's'}
            </Text>
          ) : null}

          {error ? (
            <Callout
              tone={error.tone || 'danger'}
              message={error.message}
              action={error.action === 'Retry' ? 'Try again' : undefined}
              onAction={error.action === 'Retry' ? () => load() : undefined}
            />
          ) : null}

          {outstanding.length ? (
            <Card style={styles.payCard}>
              <Row style={styles.payRow}>
                <View style={styles.payText}>
                  <Text style={styles.payTitle}>
                    {outstanding.length} booking{outstanding.length === 1 ? '' : 's'} unpaid
                  </Text>
                  <Text style={styles.payMeta}>
                    {money(outstanding.reduce((sum, b) => sum + (Number(b.cost) || 0), 0))} from your
                    wallet
                  </Text>
                </View>
                <Badge label="Due" tone="warning" />
              </Row>
              <Button
                label="Pay all from wallet"
                onPress={payAll}
                loading={busyId === 'all'}
                style={styles.payButton}
              />
            </Card>
          ) : null}
        </View>
      }
      renderSectionHeader={({ section }) => (
        <PressableTripHeader section={section} onPress={() => navigation.navigate('TripDetail', { tripId: section.tripId })} />
      )}
      renderItem={({ item }) => (
        <BookingCard
          booking={item}
          busy={busyId === item.id}
          onPay={() => run(item, 'pay')}
          onCancel={() => confirmCancel(item)}
          onShowTicket={() => navigation.navigate('Ticket', { bookingId: item.id, tripId: item.tripId })}
        />
      )}
      ListEmptyComponent={
        <EmptyState
          icon="🎫"
          title="No bookings yet"
          message="Once you book from a generated itinerary, every confirmation and ticket lands here."
        />
      }
    />
  );
}

function PressableTripHeader({ section, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${section.title}`}
      style={styles.sectionHeader}
    >
      <Text style={styles.sectionTitle}>{section.title}</Text>
      <Text style={styles.sectionAction}>Open trip ›</Text>
    </Pressable>
  );
}

function BookingCard({ booking, busy, onPay, onCancel, onShowTicket }) {
  const tone = STATUS_TONE[String(booking.status || '').toUpperCase()] || 'neutral';
  const unpaid = booking.paymentStatus === 'PENDING';
  const dead = ['CANCELLED', 'REJECTED'].includes(String(booking.status || '').toUpperCase());
  const paid = booking.paymentStatus === 'COMPLETED';

  return (
    <Card>
      <Row style={styles.cardTop}>
        <Text style={styles.cardIcon}>{itineraryIcon(booking.type)}</Text>
        <View style={styles.cardText}>
          <Text style={styles.cardTitle}>{describeBooking(booking)}</Text>
          <Text style={styles.cardMeta}>
            {booking.reference ? `${booking.reference} · ` : ''}
            {booking.date ? shortDate(booking.date) : 'Date not set'}
            {booking.qty > 1 ? ` · ${booking.qty} travellers` : ''}
          </Text>
        </View>
        <Badge label={String(booking.status || 'UNKNOWN')} tone={tone} />
      </Row>

      <Row style={styles.cardBottom}>
        <Text style={styles.cardCost}>{money(booking.cost)}</Text>
        <Text style={styles.cardAge}>{relativeTime(booking.createdAt)}</Text>
      </Row>

      {unpaid && !dead ? (
        <Callout
          tone="info"
          title="Payment pending"
          message="This booking is held but not paid. Complete it before the provider releases the seat or room."
          style={styles.cardCallout}
        />
      ) : null}

      {!dead ? (
        <View style={styles.cardActions}>
          {unpaid ? (
            <Button label="Pay now" onPress={onPay} loading={busy} />
          ) : (
            <Button label="Show ticket QR" icon="🎫" variant="secondary" onPress={onShowTicket} />
          )}
          {!dead ? (
            <Button label="Cancel" variant="ghost" onPress={onCancel} disabled={busy} />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

/** A human name for a booking, from whatever the document actually stored. */
function describeBooking(booking) {
  return (
    booking.routeLabel ||
    booking.foodName ||
    booking.provider ||
    titleCaseType(booking.type) ||
    'Booking'
  );
}

function titleCaseType(type) {
  if (!type) return '';
  return String(type).toLowerCase().replace(/^[a-z]/, (c) => c.toUpperCase());
}

/**
 * `[{ title, tripId, data }]`, trips newest first.
 *
 * A booking with no `tripId` (a one-off restaurant table) still gets its own
 * section rather than being dropped, because losing a paid booking from a list
 * is the one unacceptable outcome here.
 */
function groupByTrip(bookings, tripsById) {
  const buckets = new Map();
  for (const booking of bookings) {
    const key = booking.tripId || '__loose__';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(booking);
  }

  return [...buckets.entries()]
    .sort((a, b) => {
      const ta = tripsById[a[0]];
      const tb = tripsById[b[0]];
      if (ta && tb) return String(tb.startDate || '').localeCompare(String(ta.startDate || ''));
      if (ta) return -1;
      if (tb) return 1;
      return 0;
    })
    .map(([key, data]) => {
      const trip = tripsById[key];
      data.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
      return {
        tripId: trip?.id || key,
        title: trip ? `${trip.origin} → ${trip.destination}` : 'Standalone bookings',
        data,
      };
    });
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.ink04 },
  content: { paddingHorizontal: space.lg, flexGrow: 1 },
  gap: { marginBottom: space.md },

  title: { ...type.display },
  subtitle: { ...type.caption, marginBottom: space.lg },

  payCard: { backgroundColor: colors.brand50, borderColor: colors.brand100 },
  payRow: { alignItems: 'flex-start' },
  payText: { flex: 1 },
  payTitle: { ...type.bodyStrong },
  payMeta: { ...type.caption, marginTop: 2 },
  payButton: { marginTop: space.md },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.md,
    marginBottom: space.sm,
    minHeight: 32,
  },
  sectionTitle: { ...type.subheading, flex: 1 },
  sectionAction: { ...type.caption, color: colors.brand700, fontWeight: '700' },

  cardTop: { alignItems: 'flex-start', marginBottom: space.sm },
  cardIcon: { fontSize: 20, marginRight: space.sm },
  cardText: { flex: 1, paddingRight: space.sm },
  cardTitle: { ...type.bodyStrong },
  cardMeta: { ...type.caption, marginTop: 2 },
  cardBottom: { justifyContent: 'space-between' },
  cardCost: { ...type.subheading, color: colors.brand700 },
  cardAge: { ...type.caption },
  cardCallout: { marginTop: space.md, marginBottom: 0 },
  cardActions: { marginTop: space.md, gap: space.xs },
});
