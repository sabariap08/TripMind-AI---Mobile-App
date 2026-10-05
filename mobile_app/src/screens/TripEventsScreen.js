/**
 * The trip timeline.
 *
 * Every disruption, re-plan and resolution the server recorded, newest first.
 * This screen exists to answer one question a traveller actually asks: "what
 * has happened to my trip, and when?" - and to do it without them having to
 * reconstruct it from memory.
 *
 * Events are written server-side by the same code that performs the action, so
 * the timeline cannot disagree with the itinerary. When a delay is still active
 * the screen says so at the top, because "there is no new event" is otherwise
 * indistinguishable from "nothing is wrong".
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../context/AuthContext';
import { trips as tripsApi } from '../api/endpoints';
import { Badge, Button, Callout, Card, EmptyState, Skeleton } from '../components/ui';
import { colors, radius, space, type } from '../theme';
import { dateTime, longDate, relativeTime } from '../utils/format';
import { watchTripEvents } from '../utils/notifications';
import { describeError } from '../utils/errors';

const SEVERITY = {
  HIGH: { tone: 'danger', label: 'Needs attention' },
  MEDIUM: { tone: 'warning', label: 'Watch' },
  LOW: { tone: 'neutral', label: 'Noted' },
};

export default function TripEventsScreen({ route, navigation }) {
  const { tripId } = route.params || {};
  const insets = useSafeAreaInsets();
  const { token, user } = useAuth();

  const [trip, setTrip] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // The newest event id already notified about. A delay notification is only
  // worth sending once; re-polling the timeline must not re-alert for events the
  // user has already seen, or a flaky connection turns into a spam loop.
  const notifiedRef = useRef(null);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!quiet) setLoading(true);
      setError(null);
      try {
        const [tripResult, eventResult] = await Promise.all([
          tripsApi.get(token, tripId),
          tripsApi.events(token, tripId, 100),
        ]);
        setTrip(tripResult?.trip || null);
        setEvents(eventResult?.events || []);
      } catch (e) {
        setError(describeError(e));
      } finally {
        setLoading(false);
      }
    },
    [token, tripId],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Local alerts for anything the timeline has not shown yet.
  //
  // This is a poll, not a subscription, and the distinction matters: the mobile
  // API is a request/response service with no push channel, so the app can only
  // notice a delay while it is running and fetching this timeline. The helper
  // is explicit about that so nothing here over-promises. A real push channel
  // would mean a server-side token registry and an APNs/FCM send path, which
  // does not exist in this project yet.
  useEffect(() => {
    if (!events.length || !trip) return undefined;
    return watchTripEvents({
      events,
      trip,
      userName: user?.name,
      lastNotifiedId: notifiedRef.current,
      onNotified: (id) => { notifiedRef.current = id; },
    });
  }, [events, trip, user?.name]);

  // Group by calendar day. A timeline spanning a delay and its resolution reads
  // far better as two short dated sections than as one flat list with dates
  // repeated on every row.
  const sections = useMemo(() => groupByDay(events), [events]);

  const activeDelay = trip?.activeDelay;

  if (loading) {
    return (
      <View style={[styles.flex, { paddingTop: insets.top + space.lg, paddingHorizontal: space.lg }]}>
        <Skeleton height={72} style={styles.gap} />
        <Skeleton height={72} style={styles.gap} />
        <Skeleton height={72} />
      </View>
    );
  }

  return (
    <SectionList
      style={styles.flex}
      sections={sections}
      keyExtractor={(item, index) => item.id || `${item.type}-${index}`}
      contentContainerStyle={[
        styles.content,
        { paddingTop: space.md, paddingBottom: insets.bottom + space.xxxl },
      ]}
      showsVerticalScrollIndicator={false}
      stickySectionHeadersEnabled={false}
      refreshControl={
        <RefreshControl refreshing={false} onRefresh={() => load({ quiet: true })} />
      }
      ListHeaderComponent={
        <View>
          {activeDelay ? (
            <Callout
              tone="warning"
              title={`Delay of ${trip.delayMinutes} minutes is still active`}
              message="Nothing has been re-planned yet. Review the proposal before deciding."
              action="Review re-plan"
              onAction={() => navigation.navigate('Replan', { tripId })}
            />
          ) : null}

          {error ? (
            <Callout
              tone={error.tone || 'danger'}
              message={error.message}
              action={error.action === 'Retry' ? 'Try again' : undefined}
              onAction={error.action === 'Retry' ? () => load() : undefined}
            />
          ) : null}
        </View>
      }
      renderSectionHeader={({ section }) => (
        <Text style={styles.sectionHeader}>{section.title}</Text>
      )}
      renderItem={({ item, index, section }) => (
        <EventRow event={item} last={index === section.data.length - 1} />
      )}
      ListEmptyComponent={
        events.length === 0 ? (
          <EmptyState
            icon="🕘"
            title="Nothing has happened yet"
            message="Delays, re-plans and confirmations appear here as they occur, so you always have the current picture."
            compact
          />
        ) : null
      }
      ListFooterComponent={
        events.length ? (
          <Card style={styles.footerCard}>
            <Text style={styles.footerText}>
              {events.length} event{events.length === 1 ? '' : 's'} recorded. This timeline is
              written by the same server actions that change your trip, so it cannot drift from
              the plan.
            </Text>
            <Button
              label="Back to the itinerary"
              variant="ghost"
              onPress={() => navigation.goBack()}
            />
          </Card>
        ) : null
      }
    />
  );
}

/** One event on the rail. The vertical line is drawn by the parent row. */
function EventRow({ event, last }) {
  const severity = SEVERITY[String(event.severity || '').toUpperCase()] || SEVERITY.LOW;

  return (
    <View style={styles.row}>
      <View style={styles.rail}>
        <Text style={styles.icon}>{eventIcon(event.type)}</Text>
        {!last ? <View style={styles.line} /> : null}
      </View>
      <View style={[styles.card, last && styles.cardLast]}>
        <View style={styles.cardTop}>
          <Text style={styles.cardTitle}>{event.title || 'Update'}</Text>
          <Badge label={severity.label} tone={severity.tone} />
        </View>

        {event.description ? (
          <Text style={styles.cardBody}>{event.description}</Text>
        ) : null}

        <Text style={styles.cardTime}>
          {dateTime(event.occurredAt)}
          {event.occurredAt ? ` · ${relativeTime(event.occurredAt)}` : ''}
        </Text>
      </View>
    </View>
  );
}

/** Map a server event type onto a glyph, so the rail is scannable. */
function eventIcon(type) {
  switch (String(type || '').toUpperCase()) {
    case 'DELAY_RECORDED':
      return '⏱️';
    case 'DELAY_RESOLVED':
      return '✅';
    case 'REPLAN':
    case 'REPLANNED':
      return '🔄';
    case 'BOOKING':
    case 'BOOKED':
      return '🎫';
    case 'PAYMENT':
    case 'PAID':
      return '💳';
    case 'CANCEL':
    case 'CANCELLED':
      return '✖️';
    default:
      return '•';
  }
}

/** `[{ title, data }]`, newest day first, each day newest event first. */
function groupByDay(events) {
  const buckets = new Map();
  for (const event of events) {
    const key = String(event.occurredAt || '').slice(0, 10) || 'undated';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(event);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, data]) => ({
      title: key === 'undated' ? 'Earlier' : dayLabel(key),
      data,
    }));
}

function dayLabel(isoDay) {
  const d = new Date(`${isoDay}T00:00:00`);
  if (Number.isNaN(d.getTime())) return isoDay;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (d.getTime() === today.getTime()) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.getTime() === yesterday.getTime()) return 'Yesterday';
  return longDate(`${isoDay}T00:00:00`);
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.ink04 },
  content: { paddingHorizontal: space.lg, flexGrow: 1 },
  gap: { marginBottom: space.md },

  sectionHeader: { ...type.caption, fontWeight: '700', marginTop: space.md, marginBottom: space.sm },

  row: { flexDirection: 'row', gap: space.md },
  rail: { width: 34, alignItems: 'center' },
  icon: { fontSize: 18, marginTop: space.md },
  line: { flex: 1, width: 2, backgroundColor: colors.ink15, marginTop: space.xs },

  card: {
    flex: 1,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.ink08,
    padding: space.md,
    marginBottom: space.md,
  },
  cardLast: { marginBottom: space.sm },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.sm,
    marginBottom: space.xs,
  },
  cardTitle: { ...type.bodyStrong, flex: 1 },
  cardBody: { ...type.small, lineHeight: 20 },
  cardTime: { ...type.caption, marginTop: space.sm },

  footerCard: { marginTop: space.lg, backgroundColor: colors.ink04, borderColor: colors.ink08 },
  footerText: { ...type.caption, lineHeight: 18, marginBottom: space.sm },
});
