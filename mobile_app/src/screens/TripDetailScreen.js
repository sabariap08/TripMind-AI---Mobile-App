/**
 * Trip detail.
 *
 * One screen for the whole planning conversation, because that is how it
 * actually goes: draft it, let the AI ask what it is missing, generate, read it,
 * then deal with whatever happens next.
 *
 * The three states are deliberately distinct rather than one "something went
 * wrong" panel:
 *
 *   DRAFT    nothing planned yet -> a single clear action
 *   PLANNED  the itinerary, grouped by day
 *   failed   the AI could not be reached -> retry, and the trip is still safe
 *
 * That last one matters. The server tells the client which of these it is, and
 * collapsing them into a spinner that eventually gives up would throw away the
 * most careful thing the backend does.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../context/AuthContext';
import { trips as tripsApi } from '../api/endpoints';
import {
  Badge, Button, Callout, Card, DataRow, Divider, EmptyState,
  Row, SectionHeader, Skeleton,
} from '../components/ui';
import { colors, radius, space, type } from '../theme';
import {
  itineraryIcon, money, nightsBetween, relativeTime, statusTone, timeOnly,
} from '../utils/format';
import { describeError, errorLine } from '../utils/errors';
import { cachedFetch, savedAtOf } from '../utils/cache';

export default function TripDetailScreen({ route, navigation }) {
  const { tripId, justCreated } = route.params || {};
  const insets = useSafeAreaInsets();
  const { token, cacheScope } = useAuth();

  const [trip, setTrip] = useState(null);
  const [itinerary, setItinerary] = useState(null);
  const [days, setDays] = useState([]);
  const [alternatives, setAlternatives] = useState([]);
  const [budget, setBudget] = useState(null);

  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [generationNote, setGenerationNote] = useState(null);
  const [staleAt, setStaleAt] = useState(null);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!quiet) setLoading(true);
      setError(null);
      try {
        // Trip and itinerary are fetched together: the screen cannot render
        // meaningfully with one and not the other, and two sequential requests
        // would double the time to first paint.
        //
        // Both are cached per trip id. This is the screen that matters most
        // offline - it is what a traveller opens when the train enters a tunnel
        // - so it degrades to the last copy rather than to an error page.
        const [tripResult, itinResult] = await Promise.all([
          cachedFetch({
            userId: cacheScope,
            cacheName: 'trip',
            cacheId: tripId,
            request: () => tripsApi.get(token, tripId),
          }),
          cachedFetch({
            userId: cacheScope,
            cacheName: 'itinerary',
            cacheId: tripId,
            request: () => tripsApi.itinerary(token, tripId),
          }),
        ]);
        setTrip(tripResult?.trip || null);
        setItinerary(itinResult?.itinerary || null);
        setDays(itinResult?.days || []);
        setAlternatives(
          (tripResult?.trip?.itineraries || []).filter((i) => i.status !== 'SUPERSEDED'),
        );
        // Whichever half came from disk decides whether this is a stale view.
        const saved = savedAtOf(tripResult) || savedAtOf(itinResult);
        setStaleAt(saved || null);
      } catch (e) {
        setError(describeError(e));
      } finally {
        setLoading(false);
      }
    },
    [token, tripId, cacheScope],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Budget is fetched separately once there is a plan worth budgeting against.
  useEffect(() => {
    if (trip?.status === 'DRAFT') return;
    tripsApi
      .budget(token, tripId)
      .then((r) => setBudget(r?.budget || null))
      .catch(() => setBudget(null));
  }, [token, tripId, trip?.status]);

  const generate = useCallback(async (clarifications) => {
    setGenerating(true);
    setError(null);
    setGenerationNote(null);
    try {
      const result = await tripsApi.generate(token, tripId, clarifications);

      if (result?.selectedPlan) {
        setGenerationNote({
          tone: 'success',
          title: 'Itinerary ready',
          message: result.aiExplanation || 'Your plan has been generated.',
        });
      } else {
        // HTTP 200 with no plan is a real answer: this corridor has no
        // registered services. It is not a failure and must not read like one.
        setGenerationNote({
          tone: 'warning',
          title: 'Nothing to plan yet',
          message:
            result?.message ||
            'No providers have registered services for this route yet. Try a different route, or ask a provider to register.',
        });
      }
      await load({ quiet: true });
    } catch (e) {
      const described = describeError(e);
      setError(described);
      if (described.tone === 'warning') {
        setGenerationNote({ tone: 'warning', title: described.action, message: described.message });
      }
    } finally {
      setGenerating(false);
    }
  }, [token, tripId, load]);

  // Ask the planner what it still needs before committing to an itinerary.
  //
  // A failure here is swallowed deliberately. Clarification improves a plan; it
  // is not a gate on having one, so a traveller on a bad connection who cannot
  // load the questions must still get an itinerary. Falling straight through to
  // generate is the correct behaviour, not an error state to surface.
  const clarifyThenGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    setGenerationNote(null);

    let questions = [];
    try {
      const result = await tripsApi.clarify(token, tripId);
      questions = Array.isArray(result?.questions) ? result.questions : [];
    } catch {
      questions = [];
    }

    if (questions.length) {
      setGenerating(false);
      navigation.navigate('Clarify', {
        tripId,
        questions,
        summary: trip ? `${trip.origin} to ${trip.destination}` : undefined,
      });
      return;
    }
    await generate(undefined);
  }, [token, tripId, trip, navigation, generate]);

  const chooseAlternative = useCallback(
    async (itineraryId) => {
      try {
        await tripsApi.selectItinerary(token, tripId, itineraryId);
        await load({ quiet: true });
      } catch (e) {
        Alert.alert('Could not switch', errorLine(e));
      }
    },
    [token, tripId, load],
  );

  const nights = trip ? nightsBetween(trip.startDate, trip.endDate) : null;

  const activeDelay = trip?.activeDelay;
  const selectedId = itinerary?.id;

  if (loading) return <DetailSkeleton insets={insets} />;

  if (error && !trip) {
    return (
      <View style={[styles.centre, { paddingTop: insets.top }]}>
        <EmptyState
          icon="⚠️"
          title={error.tone === 'warning' ? 'Cannot reach the server' : 'Trip unavailable'}
          message={error.message}
          action={error.action === 'Retry' ? 'Try again' : 'Go back'}
          onAction={error.action === 'Retry' ? () => load() : navigation.goBack}
        />
      </View>
    );
  }

  if (!trip) return null;

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[
        styles.content,
        { paddingTop: space.md, paddingBottom: insets.bottom + space.xxxl },
      ]}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => load({ quiet: true })} />}
    >
      {staleAt ? (
        <View style={styles.offlineBar}>
          <Text style={styles.offlineText}>
            Offline — saved copy from {relativeTime(staleAt)}. Times and availability
            may have changed.
          </Text>
        </View>
      ) : null}

      {/* ------------------------------------------------------------ header */}
      <Card style={styles.heroCard}>
        <Row style={styles.heroTop}>
          <View style={styles.heroText}>
            <Text style={styles.route}>
              {trip.origin} <Text style={styles.routeArrow}>→</Text> {trip.destination}
            </Text>
            <Text style={styles.dates}>
              {trip.startDate} to {trip.endDate}
              {nights ? ` · ${nights} night${nights === 1 ? '' : 's'}` : ''}
            </Text>
          </View>
          <Badge label={trip.status} tone={statusTone(trip.status)} />
        </Row>

        <Divider />

        <DataRow label="Travellers" value={String(trip.travelers)} />
        <DataRow
          label="Budget"
          value={trip.budgetUnlimited ? 'Flexible' : money(trip.budget)}
        />
        {trip.totalEstimatedCost !== null && trip.totalEstimatedCost !== undefined ? (
          <DataRow label="Planned cost" value={money(trip.totalEstimatedCost)} bold />
        ) : null}
        {itinerary?.optimizationScore ? (
          <DataRow
            label="Optimisation score"
            value={`${Math.round(itinerary.optimizationScore * 100)}%`}
            hint={itinerary.travelTime ? `Travel time ${itinerary.travelTime}` : undefined}
          />
        ) : null}
      </Card>

      {/* ------------------------------------------------------- active delay */}
      {activeDelay ? (
        <Callout
          tone="warning"
          title={`Delay of ${trip.delayMinutes} minutes is active`}
          message="Nothing has been changed yet. Review what re-planning would do before you decide."
          action="Review re-plan"
          onAction={() => navigation.navigate('Replan', { tripId })}
        />
      ) : null}

      {generationNote ? (
        <Callout
          tone={generationNote.tone}
          title={generationNote.title}
          message={generationNote.message}
          action="Dismiss"
          onAction={() => setGenerationNote(null)}
        />
      ) : null}

      {error && trip ? (
        <Callout
          tone={error.tone || 'danger'}
          message={error.message}
          action={error.action === 'Retry' ? 'Retry' : undefined}
          onAction={error.action === 'Retry' ? () => load({ quiet: true }) : undefined}
        />
      ) : null}

      {/* ------------------------------------------------------ draft / plan */}
      {trip.status === 'DRAFT' || !itinerary ? (
        <Card>
          <Text style={styles.emptyTitle}>
            {justCreated ? 'Ready to plan' : 'Not planned yet'}
          </Text>
          <Text style={styles.emptyBody}>
            We will read the live catalogue for this route, price every option against
            real records, and build the itinerary. This usually takes 20 to 60 seconds.
          </Text>
          <Button
            label={generating ? 'Planning...' : 'Generate my itinerary'}
            testID="generate-plan"
            onPress={clarifyThenGenerate}
            loading={generating}
            size="lg"
            style={styles.generateButton}
          />
        </Card>
      ) : (
        <>
          {itinerary.reasoning?.length ? (
            <Card style={styles.reasoningCard}>
              <Text style={styles.reasoningLabel}>Why this plan</Text>
              {itinerary.reasoning.slice(0, 4).map((line, index) => (
                <Text key={index} style={styles.reasoningLine}>
                  • {line}
                </Text>
              ))}
            </Card>
          ) : null}

          <SectionHeader title="Your itinerary" />
          {days.map((day) => (
            <View key={day.day}>
              <Row style={styles.dayHeader}>
                <Text style={styles.dayLabel}>Day {day.day}</Text>
                <Text style={styles.dayCost}>{money(day.totalCost, { compact: true })}</Text>
              </Row>
              {day.items.map((item) => (
                <ItineraryRow key={item.id || `${day.day}-${item.sortOrder}`} item={item} />
              ))}
            </View>
          ))}

          {/* ------------------------------------------------- alternatives */}
          {alternatives.length > 1 ? (
            <>
              <SectionHeader title="Other options we generated" />
              {alternatives.map((option) => {
                const isSelected = option.id === selectedId;
                return (
                  <Pressable
                    key={option.id}
                    onPress={() => !isSelected && chooseAlternative(option.id)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={`${option.planType} option, ${money(option.totalCost)}`}
                    style={[styles.option, isSelected && styles.optionSelected]}
                  >
                    <View style={styles.optionText}>
                      <Text style={styles.optionTitle}>{option.planType || 'Option'}</Text>
                      <Text style={styles.optionMeta}>
                        {option.itemCount} items · v{option.version}
                        {option.replanReason ? ` · after ${String(option.replanReason).toLowerCase()}` : ''}
                      </Text>
                    </View>
                    <Text style={styles.optionCost}>{money(option.totalCost, { compact: true })}</Text>
                    {isSelected ? <Badge label="Selected" tone="brand" /> : null}
                  </Pressable>
                );
              })}
            </>
          ) : null}

          {/* ------------------------------------------------------- actions */}
          <View style={styles.actions}>
            <Button
              label="Re-plan if something changes"
              icon="🔄"
              variant="secondary"
              onPress={() => navigation.navigate('Replan', { tripId })}
            />
            <Button
              label="Trip timeline"
              icon="🕘"
              variant="ghost"
              onPress={() => navigation.navigate('TripEvents', { tripId })}
            />
            <Button
              label="Show ticket QR"
              icon="🎫"
              variant="ghost"
              onPress={() => navigation.navigate('Ticket', { tripId })}
            />
          </View>
        </>
      )}

      {/* ---------------------------------------------------------- budget */}
      {budget ? <BudgetCard budget={budget} /> : null}

      {trip.preferences ? (
        <Card style={styles.prefsCard}>
          <Text style={styles.prefsLabel}>Your brief</Text>
          <Text style={styles.prefsBody}>{trip.preferences}</Text>
        </Card>
      ) : null}
    </ScrollView>
  );
}

/** One itinerary item. Times on the left, content on the right, thumb-friendly. */
function ItineraryRow({ item }) {
  const start = timeOnly(item.startTime);
  const end = timeOnly(item.endTime);
  return (
    <View style={styles.item}>
      <View style={styles.itemTime}>
        {start ? <Text style={styles.itemTimeText}>{start}</Text> : null}
        {end ? <Text style={styles.itemTimeEnd}>{end}</Text> : null}
      </View>
      <View style={styles.itemRail}>
        <Text style={styles.itemIcon}>{itineraryIcon(item.type)}</Text>
      </View>
      <View style={styles.itemBody}>
        <Text style={styles.itemTitle} numberOfLines={2}>
          {item.title || item.type}
        </Text>
        <Row gap={space.sm} style={styles.itemMetaRow}>
          {item.provider || item.operator ? (
            <Text style={styles.itemMeta} numberOfLines={1}>
              {item.operator || item.provider}
            </Text>
          ) : null}
          {item.nightLabel ? <Text style={styles.itemMeta}>· {item.nightLabel}</Text> : null}
          {item.rating ? <Text style={styles.itemMeta}>· ★ {item.rating}</Text> : null}
        </Row>
        {item.location ? (
          <Text style={styles.itemLocation} numberOfLines={1}>
            {item.location}
          </Text>
        ) : null}
        <Row style={styles.itemCostRow}>
          <Text style={styles.itemCost}>
            {item.cost === null || item.cost === undefined ? 'Not known' : money(item.cost)}
          </Text>
          {item.bookableId ? <Badge label="Bookable" tone="info" /> : null}
        </Row>
      </View>
    </View>
  );
}

function BudgetCard({ budget }) {
  const remaining = budget.remaining;
  const tone =
    remaining === null || remaining === undefined
      ? undefined
      : remaining < 0
        ? 'danger'
        : remaining < (budget.budgetTotal || 0) * 0.1
          ? 'warning'
          : 'success';

  return (
    <>
      <SectionHeader title="Budget" />
      <Card>
        <DataRow label="Allowed" value={money(budget.budgetTotal)} />
        <DataRow label="Planned" value={money(budget.plannedTotal)} />
        <DataRow label="Booked" value={money(budget.bookedTotal)} />
        <Divider />
        <DataRow label="Remaining" value={money(remaining)} tone={tone} bold />

        {budget.unpricedItemCount || budget.unpricedBookingCount ? (
          <Callout
            tone="info"
            title="Some items have no price yet"
            message={`${
              (budget.unpricedItemCount || 0) + (budget.unpricedBookingCount || 0)
            } item(s) could not be priced from the catalogue, so the planned total is a floor rather than a complete figure.`}
            style={styles.budgetNote}
          />
        ) : null}
      </Card>
    </>
  );
}

function DetailSkeleton({ insets }) {
  return (
    <View style={[styles.content, { paddingTop: insets.top + space.md }]}>
      <Skeleton height={140} style={styles.skeletonBlock} />
      <Skeleton height={64} />
      <Skeleton height={64} />
      <Skeleton height={180} />
      <Text style={styles.loadingHint}>Loading your trip...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.ink04 },
  content: { paddingHorizontal: space.lg },
  centre: { flex: 1, backgroundColor: colors.ink04, justifyContent: 'center' },

  // Inside the padded scroll content, so this is a bordered box rather than the
  // full-bleed strip the list screen uses.
  offlineBar: {
    backgroundColor: colors.warningBg,
    borderRadius: radius.sm,
    borderLeftWidth: 4,
    borderLeftColor: colors.warning,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    marginBottom: space.md,
  },
  offlineText: { ...type.caption, color: colors.ink70, lineHeight: 16 },

  heroCard: { paddingVertical: space.lg },
  heroTop: { alignItems: 'flex-start', marginBottom: space.md },
  heroText: { flex: 1, paddingRight: space.md },
  route: { fontSize: 21, lineHeight: 28, fontWeight: '800', color: colors.ink },
  routeArrow: { color: colors.brand500 },
  dates: { ...type.small, marginTop: space.xs },

  emptyTitle: { ...type.heading },
  emptyBody: { ...type.small, marginTop: space.xs, lineHeight: 20 },
  generateButton: { marginTop: space.lg },

  reasoningCard: { backgroundColor: colors.brand50, borderColor: colors.brand100 },
  reasoningLabel: { ...type.caption, fontWeight: '700', color: colors.brand700, marginBottom: space.xs },
  reasoningLine: { ...type.small, lineHeight: 20, marginBottom: 2 },

  dayHeader: {
    justifyContent: 'space-between',
    marginTop: space.md,
    marginBottom: space.sm,
    paddingHorizontal: space.xs,
  },
  dayLabel: { ...type.subheading, color: colors.ink },
  dayCost: { ...type.small, fontWeight: '700', color: colors.ink50 },

  item: { flexDirection: 'row', marginBottom: space.md },
  itemTime: { width: 58, paddingTop: 2 },
  itemTimeText: { ...type.caption, fontWeight: '700', color: colors.ink },
  itemTimeEnd: { ...type.caption, color: colors.ink30 },
  itemRail: { width: 36, alignItems: 'center' },
  itemIcon: { fontSize: 20 },
  itemBody: {
    flex: 1,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    padding: space.md,
    borderWidth: 1,
    borderColor: colors.ink08,
  },
  itemTitle: { ...type.bodyStrong, marginBottom: 3 },
  itemMetaRow: { flexWrap: 'wrap' },
  itemMeta: { ...type.caption },
  itemLocation: { ...type.caption, color: colors.ink50, marginTop: 2 },
  itemCostRow: { marginTop: space.sm, justifyContent: 'space-between' },
  itemCost: { ...type.small, fontWeight: '700', color: colors.brand700 },

  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.sm,
    borderWidth: 1,
    borderColor: colors.ink08,
    minHeight: 64,
  },
  optionSelected: { borderColor: colors.brand300, backgroundColor: colors.brand50 },
  optionText: { flex: 1 },
  optionTitle: { ...type.bodyStrong },
  optionMeta: { ...type.caption, marginTop: 2 },
  optionCost: { ...type.bodyStrong, color: colors.brand700 },

  actions: { marginTop: space.lg, gap: space.sm },
  budgetNote: { marginTop: space.md, marginBottom: 0 },

  prefsCard: { backgroundColor: colors.ink04, borderColor: colors.ink08 },
  prefsLabel: { ...type.caption, fontWeight: '700', marginBottom: space.xs },
  prefsBody: { ...type.small, lineHeight: 20 },

  skeletonBlock: { marginBottom: space.md },
  loadingHint: { ...type.caption, textAlign: 'center', marginTop: space.xl },
});
