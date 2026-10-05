/**
 * The clarify step.
 *
 * The planner asks what it still does not know before it commits to an
 * itinerary. The web app renders this in a modal over the planner page; on a
 * phone it is a full screen in its own right, because the questions are the
 * screen's whole job and half of them are multi-choice.
 *
 * Two things are deliberate:
 *
 *   * Answers are required-blocking only for questions the server marked
 *     `required`. Inventing an answer to "how relaxed do you want this trip"
 *     produces a confidently wrong plan, but demanding an answer to a free-text
 *     "any special requests" would be a wall.
 *
 *   * "Skip and plan anyway" is always available. Clarification improves a
 *     plan; it must never be able to prevent one. A traveller on a flaky
 *     connection who cannot load this screen still gets an itinerary.
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Callout, Card } from '../components/ui';
import { colors, radius, space, touch, type } from '../theme';

/**
 * The planner returns `radio`, `checkbox`, `select` and `textarea`. Anything
 * unrecognised falls back to text rather than being dropped, because a silently
 * missing question is worse than a slightly wrong input type.
 */
const kindOf = (question) => {
  const type_ = String(question.type || '').toLowerCase();
  if (['radio', 'checkbox', 'select', 'textarea', 'text'].includes(type_)) return type_;
  if (Array.isArray(question.options)) return question.options.length ? 'select' : 'textarea';
  return 'textarea';
};

export default function ClarifyScreen({ route, navigation }) {
  const { questions = [], tripId, summary } = route.params || {};
  const insets = useSafeAreaInsets();

  const [answers, setAnswers] = useState({});
  const [error, setError] = useState(null);

  const required = useMemo(
    () => questions.filter((q) => q.required),
    [questions],
  );

  const missing = useMemo(
    () => required.filter((q) => {
      const value = answers[q.id];
      if (Array.isArray(value)) return value.length === 0;
      return !String(value ?? '').trim();
    }),
    [required, answers],
  );

  const setAnswer = useCallback((id, value) => {
    setAnswers((prev) => ({ ...prev, [id]: value }));
    setError(null);
  }, []);

  const toggleMulti = useCallback((id, option) => {
    setAnswers((prev) => {
      const current = Array.isArray(prev[id]) ? prev[id] : [];
      const next = current.includes(option)
        ? current.filter((v) => v !== option)
        : [...current, option];
      return { ...prev, [id]: next };
    });
    setError(null);
  }, []);

  const proceed = useCallback(() => {
    if (missing.length) {
      setError(`Still need: ${missing.map((q) => q.label).join(', ')}`);
      return;
    }
    // Only non-empty answers travel. Sending 8 empty strings would put 8 empty
    // lines in the planner's prompt for no benefit.
    const payload = Object.fromEntries(
      Object.entries(answers).filter(([, v]) =>
        Array.isArray(v) ? v.length > 0 : String(v ?? '').trim() !== '',
      ),
    );
    navigation.navigate('TripDetail', { tripId, clarifications: payload, justCreated: true });
  }, [answers, missing, navigation, tripId]);

  const skip = useCallback(() => {
    navigation.navigate('TripDetail', { tripId, clarifications: {}, justCreated: true });
  }, [navigation, tripId]);

  const labelFor = (option) => (typeof option === 'string' ? option : option?.label || option?.value || '');

  const valueOf = (option) => (typeof option === 'string' ? option : option?.value ?? option?.label ?? '');

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
        <Text style={styles.title}>A few details first</Text>
        <Text style={styles.subtitle}>
          {summary
            ? `TripMind is planning ${summary}. These answers are the difference between a plan that fits you and one that is merely correct.`
            : 'These answers are the difference between a plan that fits you and one that is merely correct.'}
        </Text>

        {error ? (
          <Callout tone="warning" title="One more thing" message={error} />
        ) : null}

        {questions.map((question, index) => {
          const kind = kindOf(question);
          const answer = answers[question.id];
          const options = Array.isArray(question.options) ? question.options : [];

          return (
            <Card key={question.id || index}>
              <Text style={styles.questionLabel}>
                {question.label}
                {question.required ? <Text style={styles.required}> *</Text> : null}
              </Text>
              {question.hint ? <Text style={styles.questionHint}>{question.hint}</Text> : null}

              {kind === 'radio' ? (
                options.map((option) => {
                  const value = valueOf(option);
                  const selected = answer === value;
                  return (
                    <Pressable
                      key={value}
                      onPress={() => setAnswer(question.id, value)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      accessibilityLabel={labelFor(option)}
                      style={[styles.option, selected && styles.optionSelected]}
                    >
                      <View style={[styles.radio, selected && styles.radioSelected]}>
                        {selected ? <View style={styles.radioDot} /> : null}
                      </View>
                      <Text style={[styles.optionText, selected && styles.optionTextSelected]}>
                        {labelFor(option)}
                      </Text>
                    </Pressable>
                  );
                })
              ) : null}

              {kind === 'select' ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.chipRow}
                >
                  {options.map((option) => {
                    const value = valueOf(option);
                    const selected = answer === value;
                    return (
                      <Pressable
                        key={value}
                        onPress={() => setAnswer(question.id, value)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        style={[styles.chip, selected && styles.chipSelected]}
                      >
                        <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                          {labelFor(option)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              ) : null}

              {kind === 'checkbox' ? (
                <Row gap={space.xs}>
                  {options.map((option) => {
                    const value = valueOf(option);
                    const selected = Array.isArray(answer) && answer.includes(value);
                    return (
                      <Pressable
                        key={value}
                        onPress={() => toggleMulti(question.id, value)}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: selected }}
                        accessibilityLabel={labelFor(option)}
                        style={[styles.checkOption, selected && styles.checkOptionSelected]}
                      >
                        <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
                          {selected ? <Text style={styles.checkGlyph}>✓</Text> : null}
                        </View>
                        <Text
                          style={[styles.checkText, selected && styles.checkTextSelected]}
                        >
                          {labelFor(option)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </Row>
              ) : null}

              {kind === 'textarea' ? (
                <TextInput
                  testID={`clarify-${question.id}`}
                  value={typeof answer === 'string' ? answer : ''}
                  onChangeText={(text) => setAnswer(question.id, text)}
                  placeholder={question.placeholder}
                  placeholderTextColor={colors.ink30}
                  multiline
                  accessibilityLabel={question.label}
                  style={styles.textarea}
                />
              ) : null}
            </Card>
          );
        })}

        {!questions.length ? (
          <Callout
            tone="info"
            title="Nothing to ask"
            message="The planner already has everything it needs. Continue to generate."
          />
        ) : null}

        <Button
          label={questions.length ? 'Build my itinerary' : 'Continue'}
          testID="clarify-continue"
          onPress={proceed}
          size="lg"
          style={styles.submit}
        />
        {questions.length ? (
          <Pressable
            onPress={skip}
            accessibilityRole="button"
            style={styles.skip}
          >
            <Text style={styles.skipText}>Skip and plan anyway</Text>
          </Pressable>
        ) : null}
        <Text style={styles.footnote}>
          Answers go to the planner to shape your itinerary. Nothing here is shared with
          providers.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Vertical stack with a gap. The shared `Row` is horizontal-only. */
function Row({ children, gap }) {
  return <View style={[styles.row, { gap }]}>{children}</View>;
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.ink04 },
  content: { paddingHorizontal: space.lg },

  title: { ...type.display },
  subtitle: { ...type.small, marginTop: space.xs, marginBottom: space.lg, lineHeight: 19 },

  questionLabel: { ...type.bodyStrong, marginBottom: space.xs, lineHeight: 21 },
  required: { color: colors.danger },
  questionHint: { ...type.caption, marginBottom: space.sm },

  row: { gap: space.sm },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: touch.min,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.ink04,
    borderWidth: 1,
    borderColor: colors.ink08,
  },
  optionSelected: { backgroundColor: colors.brand50, borderColor: colors.brand300 },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.ink30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: { borderColor: colors.brand700 },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.brand700,
  },
  optionText: { ...type.small, flex: 1, lineHeight: 20 },
  optionTextSelected: { color: colors.brand800, fontWeight: '600' },

  chipRow: { gap: space.xs, paddingRight: space.lg },
  chip: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.ink08,
  },
  chipSelected: { backgroundColor: colors.brand700 },
  chipText: { ...type.caption, fontWeight: '600', color: colors.ink70 },
  chipTextSelected: { color: colors.white },

  checkOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 44,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.ink04,
    borderWidth: 1,
    borderColor: colors.ink08,
  },
  checkOptionSelected: { backgroundColor: colors.brand50, borderColor: colors.brand300 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: radius.xs,
    borderWidth: 2,
    borderColor: colors.ink30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxSelected: { borderColor: colors.brand700, backgroundColor: colors.brand700 },
  checkGlyph: { color: colors.white, fontSize: 13, fontWeight: '900', lineHeight: 15 },
  checkText: { ...type.caption, flex: 1, lineHeight: 18 },
  checkTextSelected: { color: colors.brand800, fontWeight: '600' },

  textarea: {
    ...type.small,
    minHeight: 88,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.ink08,
    textAlignVertical: 'top',
  },

  submit: { marginTop: space.lg },
  skip: { minHeight: touch.min, alignItems: 'center', justifyContent: 'center' },
  skipText: { ...type.small, fontWeight: '600', color: colors.ink50 },
  footnote: { ...type.caption, textAlign: 'center', lineHeight: 17 },
});
