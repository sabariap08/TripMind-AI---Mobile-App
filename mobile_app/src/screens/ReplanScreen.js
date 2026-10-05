/**
 * Re-plan a disrupted trip.
 *
 * This screen is the reason the project exists, so it is built around one rule:
 * nothing is written until the user has seen what it will cost.
 *
 *   Phase 1  choose what happened -> POST /replan            -> proposal, nothing saved
 *   Phase 2  read the diff and the money -> POST /replan{confirm} -> applied
 *
 * The proposal is shown in full: every item that moves, every item that could
 * not be reached and was dropped, and the actual rupee delta computed from the
 * replanner rather than asserted. If a figure could not be verified against the
 * catalogue, `allCostsVerified` is false and the screen says so instead of
 * implying the number is exact.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../context/AuthContext';
import { trips as tripsApi } from '../api/endpoints';
import {
  Badge, Button, Callout, Card, DataRow, Divider, Row, SectionHeader,
} from '../components/ui';
import { colors, radius, space, touch, type } from '../theme';
import { itineraryIcon, money, moneyDelta, timeOnly } from '../utils/format';
import { describeError } from '../utils/errors';

const COMMON_DELAYS = [
  { minutes: 30, label: '30 min late' },
  { minutes: 60, label: '1 hour late' },
  { minutes: 90, label: '1.5 hours late' },
  { minutes: 120, label: '2 hours late' },
  { minutes: 240, label: '4 hours late' },
];

export default function ReplanScreen({ route, navigation }) {
  const { tripId } = route.params || {};
  const insets = useSafeAreaInsets();
  const { token } = useAuth();

  const [trip, setTrip] = useState(null);
  const [minutes, setMinutes] = useState(60);
  const [note, setNote] = useState('');

  const [proposal, setProposal] = useState(null);
  const [applied, setApplied] = useState(null);

  const [loadingTrip, setLoadingTrip] = useState(true);
  const [proposing, setProposing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await tripsApi.get(token, tripId);
        if (!cancelled) {
          setTrip(result?.trip || null);
          // Pre-fill from a delay that is already recorded, so the common case
          // (the user tapped "record a delay" earlier) needs one tap, not four.
          if (result?.trip?.delayMinutes) setMinutes(result.trip.delayMinutes);
        }
      } catch (e) {
        if (!cancelled) setError(describeError(e));
      } finally {
        if (!cancelled) setLoadingTrip(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, tripId]);

  const requestProposal = useCallback(async () => {
    setProposing(true);
    setError(null);
    setApplied(null);
    try {
      // Recording the delay first is deliberate: the disruption is a fact, the
      // re-plan is a decision. Recording it now means the trip timeline shows
      // what happened even if the user decides not to re-plan.
      await tripsApi.recordDelay(token, tripId, minutes, note.trim() || undefined);
      const result = await tripsApi.replan(token, tripId, {
        delayMinutes: minutes,
        reason: 'delay',
      });
      setProposal(result);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setProposing(false);
    }
  }, [token, tripId, minutes, note]);

  const applyProposal = useCallback(async () => {
    setApplying(true);
    setError(null);
    try {
      const result = await tripsApi.replan(token, tripId, {
        delayMinutes: minutes,
        reason: 'delay',
        confirm: true,
      });
      setApplied(result);
      setProposal(null);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setApplying(false);
    }
  }, [token, tripId, minutes]);

  const cost = proposal?.cost || {};
  const diff = proposal?.diff || {};

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: space.md, paddingBottom: insets.bottom + space.xxxl },
        ]}
        keyboardShouldPresentTaps="handled"
      >
        {trip ? (
          <Card style={styles.heroCard}>
            <Text style={styles.heroRoute}>
              {trip.origin} → {trip.destination}
            </Text>
            <Text style={styles.heroMeta}>
              {trip.startDate} to {trip.endDate} · planned{' '}
              {money(trip.totalEstimatedCost, { compact: true })}
            </Text>
          </Card>
        ) : null}

        {/* ------------------------------------------------------ applied view */}
        {applied ? (
          <Card style={styles.appliedCard}>
            <Badge label="Re-planned" tone="success" style={styles.appliedBadge} />
            <Text style={styles.appliedTitle}>Your itinerary is updated</Text>
            <Text style={styles.appliedBody}>{applied.explanation}</Text>

            <Divider />

            <DataRow label="New total" value={money(applied.revisedCost)} bold />
            <DataRow
              label="Change"
              value={moneyDelta(applied.additionalCost)}
              tone={
                applied.additionalCost > 0
                  ? 'danger'
                  : applied.additionalCost < 0
                    ? 'success'
                    : undefined
              }
            />
            <DataRow label="Version" value={`v${applied.version}`} />

            {!applied.allCostsVerified ? (
              <Callout
                tone="warning"
                title="Some prices could not be verified"
                message="At least one changed item had no confirmed price in the catalogue, so this total may move once the provider confirms."
                style={styles.appliedNote}
              />
            ) : null}

            <Button
              label="View the new itinerary"
              onPress={() => navigation.goBack()}
              size="lg"
              style={styles.appliedButton}
            />
          </Card>
        ) : null}

        {/* --------------------------------------------------- pick what broke */}
        {!applied ? (
          <>
            <SectionHeader title="What happened?" />

            <Card>
              <Text style={styles.prompt}>
                How late are you? We will work out what it breaks and what it costs to fix.
              </Text>

              <View style={styles.delayGrid}>
                {COMMON_DELAYS.map((option) => {
                  const selected = minutes === option.minutes;
                  return (
                    <Pressable
                      key={option.minutes}
                      onPress={() => setMinutes(option.minutes)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      style={[styles.delayChip, selected && styles.delayChipSelected]}
                    >
                      <Text
                        style={[
                          styles.delayChipText,
                          selected && styles.delayChipTextSelected,
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <View style={styles.customRow}>
                <Pressable
                  onPress={() => setMinutes((m) => Math.max(0, m - 15))}
                  accessibilityRole="button"
                  accessibilityLabel="Fifteen minutes less"
                  style={styles.stepButton}
                >
                  <Text style={styles.stepSymbol}>−</Text>
                </Pressable>
                <View style={styles.customValue}>
                  <Text style={styles.customNumber}>{minutes}</Text>
                  <Text style={styles.customUnit}>minutes late</Text>
                </View>
                <Pressable
                  onPress={() => setMinutes((m) => Math.min(10080, m + 15))}
                  accessibilityRole="button"
                  accessibilityLabel="Fifteen minutes more"
                  style={styles.stepButton}
                >
                  <Text style={styles.stepSymbol}>+</Text>
                </Pressable>
              </View>

              <Button
                label={proposing ? 'Working out the impact...' : 'See what would change'}
                testID="replan-propose"
                onPress={requestProposal}
                loading={proposing}
                size="lg"
              />
              <Text style={styles.footnote}>
                Nothing is changed yet. You will see every difference and the exact cost
                before anything is booked.
              </Text>
            </Card>
          </>
        ) : null}

        {/* ------------------------------------------------------ the proposal */}
        {proposal ? (
          <>
            <SectionHeader title="What re-planning would do" />

            <Card style={styles.summaryCard}>
              <Text style={styles.summaryText}>{proposal.summary}</Text>

              <Divider />

              <Row gap={space.xl}>
                <Stat label="Moved" value={diff.moved ?? 0} tone={colors.info} />
                <Stat label="Dropped" value={diff.dropped ?? 0} tone={colors.danger} />
                <Stat label="Added" value={diff.added ?? 0} tone={colors.success} />
              </Row>

              <Divider />

              <DataRow label="Current total" value={money(cost.original)} />
              <DataRow label="Revised total" value={money(cost.revised)} bold />
              <DataRow
                label="Cost impact"
                value={moneyDelta(cost.additional)}
                tone={
                  cost.additional > 0 ? 'danger' : cost.additional < 0 ? 'success' : undefined
                }
                bold
              />
              {cost.removedValue ? (
                <DataRow
                  label="Value of what could not be kept"
                  value={money(cost.removedValue)}
                  hint="Already paid or non-refundable, so it is shown separately from the delta."
                />
              ) : null}
            </Card>

            {!cost.allCostsVerified ? (
              <Callout
                tone="warning"
                title="Not every price could be verified"
                message="At least one changed item has no confirmed price in the catalogue. The figures above are our best estimate and may shift once the provider responds."
              />
            ) : null}

            {(proposal.warnings || []).length ? (
              <Callout
                tone="warning"
                title="Worth knowing before you decide"
                message={proposal.warnings.join('\n')}
              />
            ) : null}

            {(proposal.changes || []).length ? (
              <>
                <SectionHeader title={`${proposal.changes.length} changes`} />
                <Card>
                  {proposal.changes.slice(0, 12).map((change, index) => (
                    <View key={`${change.itemId || 'x'}-${index}`} style={styles.change}>
                      <Text style={styles.changeIcon}>{itineraryIcon(change.type)}</Text>
                      <View style={styles.changeBody}>
                        <Text style={styles.changeTitle} numberOfLines={1}>
                          {change.title || 'Item'}
                        </Text>
                        <Text style={styles.changeReason}>{change.reason}</Text>
                      </View>
                      <View style={styles.changeTimes}>
                        <Text style={styles.changeTime}>{timeOnly(change.from) || '—'}</Text>
                        <Text style={styles.changeArrow}>↓</Text>
                        <Text style={styles.changeTime}>{timeOnly(change.to) || '—'}</Text>
                      </View>
                    </View>
                  ))}
                  {proposal.changes.length > 12 ? (
                    <Text style={styles.more}>
                      and {proposal.changes.length - 12} more
                    </Text>
                  ) : null}
                </Card>
              </>
            ) : (
              <Callout
                tone="info"
                title="Nothing needs to move"
                message="Your itinerary absorbs this delay without any change. You can still record it for the timeline."
              />
            )}

            {(proposal.dropped || []).length ? (
              <>
                <SectionHeader title="What gets dropped" />
                <Card style={styles.droppedCard}>
                  {(proposal.dropped || []).map((item, index) => (
                    <View key={item.id || index} style={styles.change}>
                      <Text style={styles.changeIcon}>{itineraryIcon(item.type)}</Text>
                      <View style={styles.changeBody}>
                        <Text style={styles.changeTitle} numberOfLines={1}>
                          {item.title || 'Item'}
                        </Text>
                        <Text style={styles.changeReason}>
                          Can no longer be reached in time
                        </Text>
                      </View>
                      <Text style={styles.droppedCost}>
                        {money(item.cost, { compact: true })}
                      </Text>
                    </View>
                  ))}
                </Card>
              </>
            ) : null}

            <View style={styles.confirmBlock}>
              <Button
                label="Yes, re-plan my trip"
                testID="replan-confirm"
                onPress={applyProposal}
                loading={applying}
                size="lg"
              />
              <Button
                label="No, keep my current plan"
                variant="ghost"
                onPress={() => setProposal(null)}
                disabled={applying}
              />
            </View>

            {error ? (
              <Callout tone={error.tone || 'danger'} message={error.message} />
            ) : null}
          </>
        ) : null}

        {error && !proposal && !applied ? (
          <Callout
            tone={error.tone || 'danger'}
            title="Could not work out the impact"
            message={error.message}
            action={error.action === 'Retry' ? 'Try again' : undefined}
            onAction={error.action === 'Retry' ? requestProposal : undefined}
          />
        ) : null}

        {loadingTrip ? <Text style={styles.loading}>Loading trip...</Text> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Stat({ label, value, tone }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: tone }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.ink04 },
  content: { paddingHorizontal: space.lg },

  heroCard: { backgroundColor: colors.brand800, borderColor: colors.brand800 },
  heroRoute: { fontSize: 18, fontWeight: '700', color: colors.white },
  heroMeta: { ...type.caption, color: colors.brand300, marginTop: 2 },

  prompt: { ...type.body, marginBottom: space.lg, lineHeight: 21 },

  delayGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg },
  delayChip: {
    minHeight: touch.min,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.ink04,
    borderWidth: 1,
    borderColor: colors.ink08,
  },
  delayChipSelected: { backgroundColor: colors.brand700, borderColor: colors.brand700 },
  delayChipText: { ...type.small, fontWeight: '600', color: colors.ink70 },
  delayChipTextSelected: { color: colors.white },

  customRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    marginBottom: space.lg,
  },
  stepButton: {
    width: touch.min,
    height: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.brand50,
  },
  stepSymbol: { fontSize: 22, fontWeight: '700', color: colors.brand700 },
  customValue: { alignItems: 'center', minWidth: 110 },
  customNumber: { fontSize: 32, fontWeight: '800', color: colors.ink },
  customUnit: { ...type.caption },

  footnote: { ...type.caption, textAlign: 'center', marginTop: space.md, lineHeight: 17 },

  summaryCard: { backgroundColor: colors.white },
  summaryText: { ...type.body, lineHeight: 21, marginBottom: space.md },

  stat: { alignItems: 'center', flex: 1 },
  statValue: { fontSize: 24, fontWeight: '800' },
  statLabel: { ...type.caption, marginTop: 2 },

  change: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.ink08,
  },
  changeIcon: { fontSize: 18 },
  changeBody: { flex: 1 },
  changeTitle: { ...type.small, fontWeight: '600' },
  changeReason: { ...type.caption, marginTop: 1 },
  changeTimes: { alignItems: 'flex-end' },
  changeTime: { ...type.caption, fontWeight: '700' },
  changeArrow: { fontSize: 10, color: colors.ink30 },
  droppedCost: { ...type.small, fontWeight: '700', color: colors.danger },
  droppedCard: { backgroundColor: colors.dangerBg, borderColor: colors.dangerBg },
  more: { ...type.caption, textAlign: 'center', marginTop: space.sm },

  confirmBlock: { marginTop: space.lg, gap: space.sm },

  appliedCard: { backgroundColor: colors.white },
  appliedBadge: { marginBottom: space.md },
  appliedTitle: { ...type.heading },
  appliedBody: { ...type.small, marginTop: space.xs, marginBottom: space.md, lineHeight: 20 },
  appliedNote: { marginTop: space.md, marginBottom: 0 },
  appliedButton: { marginTop: space.lg },

  loading: { ...type.caption, textAlign: 'center', marginTop: space.xl },
});
