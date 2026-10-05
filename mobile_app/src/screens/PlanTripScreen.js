/**
 * Plan a trip.
 *
 * The screen is ordered the way a traveller thinks: where from, where to, when,
 * how many, how much, how. Everything after "how much" is optional and collapsed
 * behind an expander, because the honest majority of trips are "somewhere, some
 * time, N of us, don't spend too much".
 *
 * Origin can be filled from the handset's GPS. That is the one place the device
 * is genuinely load-bearing rather than decorative: it replaces typing a city
 * name with a permission prompt and a nearest-known-place match that runs
 * locally, and it works with no network.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';

import { useAuth } from '../context/AuthContext';
import { catalogue, trips as tripsApi } from '../api/endpoints';
import {
  Badge, Button, Callout, Card, ChipGroup, Divider, Input,
  Row, SectionHeader, Toggle,
} from '../components/ui';
import { colors, radius, space, touch, type } from '../theme';
import {
  PREMIUM_SERVICES, TRANSPORT_TYPES, TRAVEL_STYLES,
  addDays, isoDate, nightsBetween,
} from '../utils/format';
import { describeError, errorLine } from '../utils/errors';
import { KNOWN_PLACES, describeFix, nearestPlace } from '../utils/geo';

const today = () => new Date();

export default function PlanTripScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { token, user } = useAuth();

  const [corridors, setCorridors] = useState([]);
  const [catalogueError, setCatalogueError] = useState(null);
  const [loadingCorridors, setLoadingCorridors] = useState(true);

  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [startDate, setStartDate] = useState(isoDate(addDays(today(), 14)));
  const [endDate, setEndDate] = useState(isoDate(addDays(today(), 17)));
  const [travelers, setTravelers] = useState(2);
  const [budget, setBudget] = useState('50000');
  const [unlimited, setUnlimited] = useState(false);
  const [transportType, setTransportType] = useState(null);
  const [travelStyle, setTravelStyle] = useState('BALANCED');
  const [preferences, setPreferences] = useState('');
  const [premium, setPremium] = useState([]);
  const [returnTrip, setReturnTrip] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const [locating, setLocating] = useState(false);
  const [fix, setFix] = useState(null);
  const [locationNote, setLocationNote] = useState(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  // The corridors that actually have approved inventory. Offering only these
  // means the planner cannot be sent down a road with nothing on it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await catalogue.cities();
        if (!cancelled) setCorridors(result?.corridors || []);
      } catch (e) {
        if (!cancelled) setCatalogueError(describeError(e));
      } finally {
        if (!cancelled) setLoadingCorridors(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const nights = useMemo(() => nightsBetween(startDate, endDate), [startDate, endDate]);

  const suggestions = useMemo(() => {
    const query = (origin || destination).trim().toLowerCase();
    if (query.length < 2) return corridors.slice(0, 6);
    return corridors
      .filter((c) =>
        `${c.origin} ${c.destination}`.toLowerCase().includes(query))
      .slice(0, 6);
  }, [corridors, origin, destination]);

  const applyCorridor = useCallback((corridor) => {
    setOrigin(corridor.origin);
    setDestination(corridor.destination);
    setFieldErrors((prev) => ({ ...prev, origin: undefined, destination: undefined }));
  }, []);

  const useMyLocation = useCallback(async () => {
    setLocationNote(null);
    setLocating(true);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setLocationNote({
          tone: 'warning',
          message:
            permission.canAskAgain === false
              ? 'Location is blocked for TripMind. Enable it in Settings to fill this in automatically.'
              : 'Location permission denied. You can type your origin instead.',
        });
        return;
      }
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const coords = position.coords;
      setFix(coords);

      const match = nearestPlace(KNOWN_PLACES, {
        lat: coords.latitude,
        lng: coords.longitude,
      });
      if (match) {
        setOrigin(match.place.name);
        setFieldErrors((prev) => ({ ...prev, origin: undefined }));
        setLocationNote({
          tone: 'success',
          message: `Matched to ${match.place.name}, ${match.distanceKm.toFixed(0)} km away. Change it if that is not right.`,
        });
      } else {
        setLocationNote({
          tone: 'warning',
          message: `You appear to be ${describeFix(coords)}, which is outside the corridors TripMind serves. Type your origin instead.`,
        });
      }
    } catch (e) {
      setLocationNote({
        tone: 'danger',
        message: `Could not read your location: ${errorLine(e)}`,
      });
    } finally {
      setLocating(false);
    }
  }, []);

  const validate = () => {
    const problems = {};
    if (!origin.trim()) problems.origin = 'Where are you starting from?';
    if (!destination.trim()) problems.destination = 'Where are you going?';
    if (origin.trim() && origin.trim().toLowerCase() === destination.trim().toLowerCase()) {
      problems.destination = 'Origin and destination are the same.';
    }
    if (!startDate) problems.startDate = 'Choose a start date.';
    if (!endDate) problems.endDate = 'Choose an end date.';
    if (startDate && endDate && nightsBetween(startDate, endDate) === null) {
      problems.endDate = 'The end date must be after the start date.';
    }
    if (!unlimited) {
      const value = Number(budget);
      if (!Number.isFinite(value) || value < 1000) {
        problems.budget = 'Enter a budget of at least 1000, or switch on unlimited.';
      }
    }
    if (travelers < 1 || travelers > 20) problems.travelers = 'Between 1 and 20 travellers.';
    setFieldErrors(problems);
    return Object.keys(problems).length === 0;
  };

  const submit = useCallback(async () => {
    setError(null);
    if (!validate()) {
      Alert.alert('Check the form', 'Some details still need attention.');
      return;
    }

    setBusy(true);
    try {
      const created = await tripsApi.create(token, {
        origin: origin.trim(),
        destination: destination.trim(),
        startDate,
        endDate,
        travelers,
        budgetUnlimited: unlimited,
        budget: unlimited ? 0 : Number(budget),
        travelStyle,
        transportType,
        preferences: preferences.trim(),
        premiumServices: premium,
        returnTrip,
        // Coordinates travel with the trip so the planner can price the
        // home->boarding transfer from a real distance instead of a guess.
        startLocation: fix
          ? { lat: fix.latitude, lng: fix.longitude, address: origin.trim() }
          : null,
      });

      const tripId = created?.trip?.id;
      if (!tripId) throw new Error('The trip was created but no id came back.');
      // Hand straight to the trip screen, which owns clarification, generation
      // and the re-plan flow. Planning is one continuous conversation, not four
      // separate forms.
      navigation.navigate('TripDetail', { tripId, justCreated: true });
    } catch (e) {
      setError(describeError(e));
      Alert.alert('Could not create the trip', errorLine(e));
    } finally {
      setBusy(false);
    }
  }, [
    token, origin, destination, startDate, endDate, travelers, unlimited,
    budget, travelStyle, transportType, preferences, premium, returnTrip,
    fix, navigation,
  ]);

  const togglePremium = (value) =>
    setPremium((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );

  const shiftDates = (days) => {
    const start = addDays(new Date(startDate || today()), days);
    const length = nights || 3;
    setStartDate(isoDate(start));
    setEndDate(isoDate(addDays(start, length)));
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + space.md, paddingBottom: space.xxxl },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.greeting}>
          {user?.name ? `Hello, ${user.name.split(' ')[0]}` : 'Plan a trip'}
        </Text>
        <Text style={styles.subGreeting}>
          Give us the constraints. We will coordinate the providers and keep the plan
          honest if anything changes.
        </Text>

        {error ? (
          <Callout
            tone={error.tone || 'danger'}
            title="Something went wrong"
            message={error.message}
            action={error.action === 'Retry' ? 'Retry' : undefined}
            onAction={error.action === 'Retry' ? submit : undefined}
          />
        ) : null}

        {/* ------------------------------------------------------------ route */}
        <SectionHeader title="Route" />
        <Card>
          <Input
            label="From"
            testID="plan-origin"
            value={origin}
            onChangeText={setOrigin}
            placeholder="City or station"
            autoCapitalize="words"
            error={fieldErrors.origin}
            required
          />

          <Button
            label={locating ? 'Locating...' : 'Use my current location'}
            icon="📍"
            variant="secondary"
            size="md"
            onPress={useMyLocation}
            loading={locating}
            style={styles.locateButton}
          />
          {locationNote ? (
            <Text
              style={[
                styles.locationNote,
                {
                  color:
                    locationNote.tone === 'success'
                      ? colors.success
                      : locationNote.tone === 'warning'
                        ? colors.warning
                        : colors.danger,
                },
              ]}
            >
              {locationNote.message}
            </Text>
          ) : null}

          <Input
            label="To"
            testID="plan-destination"
            value={destination}
            onChangeText={setDestination}
            placeholder="City or station"
            autoCapitalize="words"
            error={fieldErrors.destination}
            required
            style={styles.destinationInput}
          />

          {catalogueError ? (
            <Callout
              tone="warning"
              title="Corridors unavailable"
              message="We could not load the list of served routes. You can still type your route manually."
            />
          ) : null}

          {suggestions.length ? (
            <>
              <Text style={styles.suggestLabel}>
                {loadingCorridors ? 'Loading routes...' : 'Routes we can plan'}
              </Text>
              <View style={styles.suggestions}>
                {suggestions.map((corridor) => {
                  const selected =
                    corridor.origin.toLowerCase() === origin.trim().toLowerCase() &&
                    corridor.destination.toLowerCase() === destination.trim().toLowerCase();
                  return (
                    <Pressable
                      key={`${corridor.origin}-${corridor.destination}`}
                      onPress={() => applyCorridor(corridor)}
                      accessibilityRole="button"
                      accessibilityLabel={`${corridor.origin} to ${corridor.destination}`}
                      style={[styles.suggestion, selected && styles.suggestionSelected]}
                    >
                      <Text style={[styles.suggestionText, selected && styles.suggestionTextSelected]}>
                        {corridor.origin} → {corridor.destination}
                      </Text>
                      <Text style={styles.suggestionTypes}>
                        {(corridor.types || []).join(' · ')}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}
        </Card>

        {/* ------------------------------------------------------------- when */}
        <SectionHeader title="When" />
        <Card>
          <Input
            label="Departure date"
            testID="plan-start"
            value={startDate}
            onChangeText={setStartDate}
            placeholder="YYYY-MM-DD"
            hint="ISO format, so it is unambiguous."
            error={fieldErrors.startDate}
            required
          />
          <Row gap={space.sm} style={styles.shiftRow}>
            {[7, 14, 30, 60].map((days) => (
              <Pressable
                key={days}
                onPress={() => shiftDates(days)}
                accessibilityRole="button"
                style={styles.shiftChip}
              >
                <Text style={styles.shiftChipText}>+{days}d</Text>
              </Pressable>
            ))}
          </Row>
          <Input
            label="Return date"
            testID="plan-end"
            value={endDate}
            onChangeText={setEndDate}
            placeholder="YYYY-MM-DD"
            error={fieldErrors.endDate}
            required
          />
          {nights ? (
            <Badge
              label={`${nights} night${nights === 1 ? '' : 's'} · ${travelers} traveller${travelers === 1 ? '' : 's'}`}
              tone="brand"
              style={styles.nightsBadge}
            />
          ) : null}
        </Card>

        {/* ------------------------------------------------------------- party */}
        <SectionHeader title="Who and how much" />
        <Card>
          <Text style={styles.fieldLabel}>Travellers</Text>
          <Row gap={space.sm} style={styles.stepper}>
            <Pressable
              onPress={() => setTravelers((n) => Math.max(1, n - 1))}
              accessibilityRole="button"
              accessibilityLabel="One fewer traveller"
              disabled={travelers <= 1}
              style={[styles.stepButton, travelers <= 1 && styles.stepButtonOff]}
            >
              <Text style={styles.stepSymbol}>−</Text>
            </Pressable>
            <Text style={styles.stepValue}>{travelers}</Text>
            <Pressable
              onPress={() => setTravelers((n) => Math.min(20, n + 1))}
              accessibilityRole="button"
              accessibilityLabel="One more traveller"
              disabled={travelers >= 20}
              style={[styles.stepButton, travelers >= 20 && styles.stepButtonOff]}
            >
              <Text style={styles.stepSymbol}>+</Text>
            </Pressable>
          </Row>
          {fieldErrors.travelers ? <Text style={styles.error}>{fieldErrors.travelers}</Text> : null}

          <Divider />

          <Input
            label="Budget for the whole trip (INR)"
            testID="plan-budget"
            value={budget}
            onChangeText={setBudget}
            placeholder="50000"
            keyboardType="number-pad"
            editable={!unlimited}
            error={fieldErrors.budget}
            hint={unlimited ? 'Ignored while budget is unlimited.' : 'At least 1000.'}
            required={!unlimited}
          />
          <Toggle
            label="Budget is flexible"
            hint="We optimise for the best trip we can build rather than to a ceiling."
            value={unlimited}
            onChange={setUnlimited}
            testID="plan-unlimited"
          />
        </Card>

        {/* ---------------------------------------------------------- advanced */}
        <Pressable
          onPress={() => setAdvanced((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: advanced }}
          style={styles.expander}
        >
          <Text style={styles.expanderText}>
            {advanced ? 'Hide' : 'Show'} travel preferences
          </Text>
          <Text style={styles.expanderChevron}>{advanced ? '▲' : '▼'}</Text>
        </Pressable>

        {advanced ? (
          <Card>
            <ChipGroup
              label="Preferred transport"
              options={TRANSPORT_TYPES}
              value={transportType}
              onChange={setTransportType}
              hint="Leave on Any and we will weigh every mode on this corridor."
            />
            <ChipGroup
              label="Travel style"
              options={TRAVEL_STYLES}
              value={travelStyle}
              onChange={setTravelStyle}
            />

            <Input
              label="Anything else we should know?"
              testID="plan-preferences"
              value={preferences}
              onChangeText={setPreferences}
              placeholder="One relaxed day, vegetarian food, avoid early starts, a museum on the second day..."
              multiline
              hint="Free text. The phone keyboard's microphone button works here too."
            />

            <Text style={styles.fieldLabel}>Services to coordinate</Text>
            <Row gap={space.sm} style={styles.premiumRow}>
              {PREMIUM_SERVICES.map((service) => {
                const selected = premium.includes(service.value);
                return (
                  <Pressable
                    key={service.value}
                    onPress={() => togglePremium(service.value)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected }}
                    style={[styles.premiumChip, selected && styles.premiumChipSelected]}
                  >
                    <Text style={[styles.premiumText, selected && styles.premiumTextSelected]}>
                      {service.label}
                    </Text>
                  </Pressable>
                );
              })}
            </Row>
            <Text style={styles.hint}>
              Selected services get coordinated with real providers. Anything not selected
              is left out rather than invented.
            </Text>

            <Divider />
            <Toggle
              label="Return journey too"
              value={returnTrip}
              onChange={setReturnTrip}
            />
          </Card>
        ) : null}

        <Button
          label="Create trip and plan it"
          testID="plan-submit"
          onPress={submit}
          loading={busy}
          size="lg"
          style={styles.submit}
        />
        <Text style={styles.footnote}>
          Planning takes 20 to 60 seconds while the AI reads the live catalogue. Your trip
          is saved first, so nothing is lost if the connection drops.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.ink04 },
  content: { paddingHorizontal: space.lg },

  greeting: { ...type.display },
  subGreeting: { ...type.small, marginTop: space.xs, marginBottom: space.lg, lineHeight: 19 },

  locateButton: { marginTop: -space.sm, marginBottom: space.md },
  locationNote: { ...type.caption, marginTop: -space.sm, marginBottom: space.md, lineHeight: 17 },
  destinationInput: { marginTop: space.sm },

  suggestLabel: { ...type.caption, marginBottom: space.sm, marginTop: space.xs },
  suggestions: { gap: space.sm },
  suggestion: {
    minHeight: touch.min,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.ink04,
    borderWidth: 1,
    borderColor: colors.ink08,
  },
  suggestionSelected: { backgroundColor: colors.brand50, borderColor: colors.brand300 },
  suggestionText: { ...type.small, fontWeight: '600' },
  suggestionTextSelected: { color: colors.brand700 },
  suggestionTypes: { ...type.caption, marginTop: 1 },

  shiftRow: { marginTop: -space.sm, marginBottom: space.lg, flexWrap: 'wrap' },
  shiftChip: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.ink08,
  },
  shiftChipText: { ...type.caption, fontWeight: '700', color: colors.ink70 },
  nightsBadge: { marginTop: -space.sm },

  fieldLabel: { ...type.small, color: colors.ink70, marginBottom: space.sm, fontWeight: '600' },
  error: { ...type.caption, color: colors.danger, marginTop: -space.sm },
  hint: { ...type.caption, marginTop: space.sm, lineHeight: 17 },

  stepper: { marginBottom: space.md },
  stepButton: {
    width: touch.min,
    height: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.brand50,
    borderWidth: 1,
    borderColor: colors.brand100,
  },
  stepButtonOff: { opacity: 0.4 },
  stepSymbol: { fontSize: 22, fontWeight: '700', color: colors.brand700 },
  stepValue: { ...type.title, minWidth: 56, textAlign: 'center' },

  expander: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: touch.min,
    marginTop: space.sm,
    marginBottom: space.sm,
  },
  expanderText: { ...type.small, fontWeight: '700', color: colors.brand700 },
  expanderChevron: { fontSize: 12, color: colors.brand700 },

  premiumRow: { flexWrap: 'wrap', marginBottom: space.sm },
  premiumChip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.ink08,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  premiumChipSelected: { backgroundColor: colors.brand700 },
  premiumText: { ...type.caption, fontWeight: '600', color: colors.ink70 },
  premiumTextSelected: { color: colors.white },

  submit: { marginTop: space.lg },
  footnote: { ...type.caption, textAlign: 'center', marginTop: space.md, lineHeight: 17 },
});
