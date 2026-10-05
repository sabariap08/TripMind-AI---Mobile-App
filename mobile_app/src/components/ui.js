/**
 * Shared UI primitives.
 *
 * Every interactive element here is at least `touch.min` (48px) tall and every
 * text input is 16px, for the reasons in `theme.js`. Screens compose these
 * rather than styling raw `Pressable`/`TextInput`, so those two guarantees hold
 * everywhere without anyone having to remember them per screen.
 */
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, shadow, space, statusTone, touch, type } from '../theme';

// ------------------------------------------------------------------ Screen
export function Screen({ children, scroll = true, padded = true, refreshControl, style }) {
  const insets = useSafeAreaInsets();
  const body = (
    <View style={[{ flex: 1, paddingHorizontal: padded ? space.lg : 0 }, style]}>
      {children}
    </View>
  );
  if (!scroll) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        {body}
      </View>
    );
  }
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        { paddingTop: insets.top + space.sm, paddingBottom: space.xxxl },
        padded && { paddingHorizontal: space.lg },
      ]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={refreshControl}
    >
      {children}
    </ScrollView>
  );
}

// ------------------------------------------------------------------ Button
export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  icon = null,
  full = true,
  style,
  testID,
}) {
  const isDisabled = disabled || loading;
  const height = size === 'lg' ? touch.comfortable : touch.min;
  const palette = BUTTON_TONES[variant] || BUTTON_TONES.primary;

  return (
    <Pressable
      testID={testID}
      onPress={isDisabled ? undefined : onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: height,
          backgroundColor: palette.bg,
          borderColor: palette.border,
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
          transform: [{ scale: pressed && !isDisabled ? 0.985 : 1 }],
          alignSelf: full ? 'stretch' : 'flex-start',
        },
        full && styles.buttonFull,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.fg} size="small" />
      ) : (
        <>
          {icon ? <Text style={[styles.buttonIcon, { color: palette.fg }]}>{icon}</Text> : null}
          <Text
            numberOfLines={1}
            style={[styles.buttonLabel, size === 'lg' && styles.buttonLabelLg, { color: palette.fg }]}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

const BUTTON_TONES = {
  primary: { bg: colors.brand700, fg: colors.white, border: colors.brand700 },
  secondary: { bg: colors.white, fg: colors.brand700, border: colors.brand300 },
  ghost: { bg: 'transparent', fg: colors.ink70, border: 'transparent' },
  danger: { bg: colors.dangerBg, fg: colors.danger, border: colors.dangerBg },
  success: { bg: colors.success, fg: colors.white, border: colors.success },
};

// ------------------------------------------------------------------- Input
export function Field({ label, hint, error, children, required }) {
  return (
    <View style={styles.field}>
      {label ? (
        <Text style={styles.fieldLabel}>
          {label}
          {required ? <Text style={{ color: colors.danger }}> *</Text> : null}
        </Text>
      ) : null}
      {children}
      {error ? (
        <Text style={styles.fieldError}>{error}</Text>
      ) : hint ? (
        <Text style={styles.fieldHint}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function Input({
  label,
  hint,
  error,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
  autoCapitalize = 'none',
  autoCorrect = false,
  multiline = false,
  required,
  editable = true,
  testID,
  right,
  style,
}) {
  return (
    <Field label={label} hint={hint} error={error} required={required}>
      <View style={[styles.inputWrap, error && styles.inputWrapError, !editable && styles.inputWrapDisabled]}>
        <TextInput
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.ink30}
          secureTextEntry={secureTextEntry}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          multiline={multiline}
          editable={editable}
          accessibilityLabel={label}
          style={[
            styles.input,
            multiline && styles.inputMultiline,
            right && styles.inputWithRight,
            style,
          ]}
        />
        {right}
      </View>
    </Field>
  );
}

/** Horizontally scrollable single-select. Sized for a thumb, not a cursor. */
export function ChipGroup({ label, options, value, onChange, hint, required }) {
  return (
    <Field label={label} hint={hint} required={required}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={String(option.value)}
              onPress={() => onChange(option.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={option.label}
              style={({ pressed }) => [
                styles.chip,
                selected && styles.chipSelected,
                pressed && { opacity: 0.8 },
              ]}
            >
              <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </Field>
  );
}

export function Toggle({ label, hint, value, onChange, testID }) {
  return (
    <Pressable
      testID={testID}
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: !!value }}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.toggleRow, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.toggleText}>
        <Text style={type.bodyStrong}>{label}</Text>
        {hint ? <Text style={styles.toggleHint}>{hint}</Text> : null}
      </View>
      <View style={[styles.track, value && styles.trackOn]}>
        <View style={[styles.thumb, value && styles.thumbOn]} />
      </View>
    </Pressable>
  );
}

// -------------------------------------------------------------------- Card
export function Card({ children, style, onPress, testID }) {
  const content = <View style={[styles.card, style]}>{children}</View>;
  if (!onPress) return content;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [pressed && { opacity: 0.9, transform: [{ scale: 0.995 }] }]}
    >
      {content}
    </Pressable>
  );
}

export function SectionHeader({ title, action, onAction }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={type.heading}>{title}</Text>
      {action ? (
        <Pressable onPress={onAction} accessibilityRole="button" hitSlop={12}>
          <Text style={styles.sectionAction}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------------- Badge
export function Badge({ label, tone = 'neutral', style }) {
  const t = statusTone[tone] || statusTone.neutral;
  return (
    <View style={[styles.badge, { backgroundColor: t.bg }, style]}>
      <Text style={[styles.badgeLabel, { color: t.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

// --------------------------------------------------------------- Callouts
/**
 * A boxed message. `tone` picks the semantic colour, so a warning never looks
 * like an error and a success never looks like a button.
 */
export function Callout({ tone = 'info', title, message, action, onAction, style }) {
  const t = statusTone[tone] || statusTone.info;
  return (
    <View style={[styles.callout, { backgroundColor: t.bg, borderColor: t.fg }, style]}>
      <View style={styles.calloutBody}>
        {title ? <Text style={[styles.calloutTitle, { color: t.fg }]}>{title}</Text> : null}
        {message ? <Text style={styles.calloutMessage}>{message}</Text> : null}
      </View>
      {action ? (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          hitSlop={10}
          style={styles.calloutAction}
        >
          <Text style={[styles.calloutActionText, { color: t.fg }]}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function EmptyState({ icon = '🧳', title, message, action, onAction, compact = false }) {
  return (
    <View style={[styles.empty, compact && styles.emptyCompact]}>
      <Text style={styles.emptyIcon}>{icon}</Text>
      <Text style={styles.emptyTitle}>{title}</Text>
      {message ? <Text style={styles.emptyMessage}>{message}</Text> : null}
      {action ? (
        <Button label={action} onPress={onAction} variant="secondary" full={false} style={styles.emptyButton} />
      ) : null}
    </View>
  );
}

export function Loading({ label = 'Loading' }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.brand600} size="large" />
      {label ? <Text style={styles.loadingLabel}>{label}</Text> : null}
    </View>
  );
}

/** A neutral placeholder block. Used instead of a spinner for short waits. */
export function Skeleton({ height = 16, width = '100%', style }) {
  return <View style={[styles.skeleton, { height, width }, style]} />;
}

export function Row({ children, style, gap = space.sm }) {
  return <View style={[styles.row, { gap }, style]}>{children}</View>;
}

export function Divider({ style }) {
  return <View style={[styles.divider, style]} />;
}

/** Label/value line, used for budgets, wallets and cost breakdowns. */
export function DataRow({ label, value, tone, bold = false, hint }) {
  const color = tone ? (statusTone[tone]?.fg || colors.ink) : colors.ink;
  return (
    <View style={styles.dataRow}>
      <View style={styles.dataRowLeft}>
        <Text style={[type.body, bold && type.bodyStrong]}>{label}</Text>
        {hint ? <Text style={styles.dataRowHint}>{hint}</Text> : null}
      </View>
      <Text style={[bold ? type.subheading : type.bodyStrong, { color }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink04 },

  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  buttonFull: { width: '100%' },
  buttonLabel: { fontSize: 15, fontWeight: '700', letterSpacing: 0.2 },
  buttonLabelLg: { fontSize: 16 },
  buttonIcon: { fontSize: 16 },

  field: { marginBottom: space.lg },
  fieldLabel: { ...type.small, color: colors.ink70, marginBottom: space.xs, fontWeight: '600' },
  fieldHint: { ...type.caption, marginTop: space.xs },
  fieldError: { ...type.caption, color: colors.danger, marginTop: space.xs },

  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.ink15,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    minHeight: touch.min,
  },
  inputWrapError: { borderColor: colors.danger },
  inputWrapDisabled: { backgroundColor: colors.ink08, borderColor: colors.ink15 },
  input: { ...type.input, flex: 1, paddingVertical: space.md },
  inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
  inputWithRight: { paddingRight: space.sm },

  chipRow: { gap: space.sm, paddingRight: space.lg },
  chip: {
    minHeight: touch.min,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.ink15,
  },
  chipSelected: { backgroundColor: colors.brand700, borderColor: colors.brand700 },
  chipLabel: { ...type.small, fontWeight: '600', color: colors.ink70 },
  chipLabelSelected: { color: colors.white },

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    minHeight: touch.min,
    marginBottom: space.md,
  },
  toggleText: { flex: 1 },
  toggleHint: { ...type.caption, marginTop: 2 },
  track: {
    width: 52,
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: colors.ink15,
    padding: 3,
    justifyContent: 'center',
  },
  trackOn: { backgroundColor: colors.brand600 },
  thumb: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.white,
    ...shadow.card,
  },
  thumbOn: { transform: [{ translateX: 22 }] },

  card: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: space.lg,
    marginBottom: space.md,
    borderWidth: 1,
    borderColor: colors.ink08,
    ...shadow.card,
  },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.md,
    marginTop: space.sm,
  },
  sectionAction: { ...type.small, color: colors.brand700, fontWeight: '700' },

  badge: {
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  badgeLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },

  callout: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderRadius: radius.md,
    borderLeftWidth: 4,
    padding: space.md,
    marginBottom: space.md,
  },
  calloutBody: { flex: 1 },
  calloutTitle: { fontSize: 14, fontWeight: '700', marginBottom: 2 },
  calloutMessage: { ...type.small, color: colors.ink70 },
  calloutAction: { paddingHorizontal: space.sm, paddingVertical: space.xs },
  calloutActionText: { fontSize: 13, fontWeight: '700' },

  empty: { alignItems: 'center', paddingVertical: space.xxxl, paddingHorizontal: space.lg },
  emptyCompact: { paddingVertical: space.xl },
  emptyIcon: { fontSize: 40, marginBottom: space.md },
  emptyTitle: { ...type.subheading, textAlign: 'center' },
  emptyMessage: {
    ...type.small,
    textAlign: 'center',
    marginTop: space.xs,
    maxWidth: 300,
  },
  emptyButton: { marginTop: space.lg },

  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  loadingLabel: { ...type.small },

  skeleton: { backgroundColor: colors.ink08, borderRadius: radius.sm },

  row: { flexDirection: 'row', alignItems: 'center' },
  divider: { height: 1, backgroundColor: colors.ink08, marginVertical: space.md },

  dataRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingVertical: space.sm,
  },
  dataRowLeft: { flex: 1 },
  dataRowHint: { ...type.caption, marginTop: 1 },
});

export default {
  Screen, Button, Field, Input, ChipGroup, Toggle, Card,
  SectionHeader, Badge, Callout, EmptyState, Loading, Skeleton,
  Row, Divider, DataRow,
};
