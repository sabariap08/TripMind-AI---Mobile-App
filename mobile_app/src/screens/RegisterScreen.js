/**
 * Create a traveller account.
 *
 * Only name, email and password are required. Identity document details are
 * collected but never leave the server unmasked, which the note on that field
 * states plainly - a form that quietly harvests an Aadhaar number without
 * saying what happens to it is the reason people distrust travel apps.
 */
import React, { useCallback, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useAuth } from '../context/AuthContext';
import { Button, Callout, Divider, Input } from '../components/ui';
import { colors, space, type } from '../theme';
import { describeError } from '../utils/errors';

const IDENTITY_TYPES = [
  { value: 'AADHAAR', label: 'Aadhaar' },
  { value: 'PAN', label: 'PAN' },
  { value: 'PASSPORT', label: 'Passport' },
  { value: 'DL', label: "Driving licence" },
];

export default function RegisterScreen({ navigation }) {
  const { register, signIn } = useAuth();

  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    mobile: '',
    identityType: '',
    identityNumber: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  const set = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));

  const validate = () => {
    const problems = {};
    if (!form.name.trim()) problems.name = 'Enter your name.';
    if (!form.email.trim()) problems.email = 'Enter your email.';
    else if (!form.email.includes('@')) problems.email = 'That does not look like an email.';
    if (form.password.length < 8) problems.password = 'Use at least 8 characters.';
    if (form.mobile && form.mobile.replace(/\D/g, '').length !== 10) {
      problems.mobile = 'Enter a 10-digit mobile number.';
    }
    if ((form.identityType || form.identityNumber) && !(form.identityType && form.identityNumber)) {
      problems.identityType = 'Provide both the document type and its number.';
    }
    setFieldErrors(problems);
    return Object.keys(problems).length === 0;
  };

  const submit = useCallback(async () => {
    setError(null);
    if (!validate()) return;

    setBusy(true);
    try {
      const payload = {
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
      };
      if (form.mobile.trim()) payload.mobile = form.mobile.trim();
      if (form.identityType) {
        payload.identityType = form.identityType;
        payload.identityNumber = form.identityNumber.trim();
      }

      await register(payload);
      // Registration deliberately does not return a token on this API, matching
      // the web app. Signing in immediately is fewer taps than bouncing the
      // user back to a form they have just filled in.
      await signIn(payload.email, payload.password);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }, [form, register, signIn]);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {error ? (
          <Callout
            tone={error.tone || 'danger'}
            title="Could not create your account"
            message={error.message}
          />
        ) : null}

        <Text style={styles.sectionTitle}>Your details</Text>

        <Input
          label="Full name"
          testID="register-name"
          value={form.name}
          onChangeText={set('name')}
          placeholder="As it appears on your ID"
          autoCapitalize="words"
          autoCorrect={false}
          error={fieldErrors.name}
          required
        />
        <Input
          label="Email"
          testID="register-email"
          value={form.email}
          onChangeText={set('email')}
          placeholder="you@example.com"
          keyboardType="email-address"
          error={fieldErrors.email}
          required
        />
        <Input
          label="Password"
          testID="register-password"
          value={form.password}
          onChangeText={set('password')}
          placeholder="At least 8 characters"
          secureTextEntry
          error={fieldErrors.password}
          required
        />
        <Input
          label="Mobile number"
          hint="Optional. Used for booking confirmations."
          testID="register-mobile"
          value={form.mobile}
          onChangeText={set('mobile')}
          placeholder="10 digits"
          keyboardType="phone-pad"
          error={fieldErrors.mobile}
        />

        <Divider />

        <Text style={styles.sectionTitle}>Identity document</Text>
        <Text style={styles.sectionNote}>
          Optional, and only needed if you want to book a rail service. Stored in full
          server-side and masked everywhere it is displayed - it is never sent back to
          this app.
        </Text>

        <View style={styles.identityRow}>
          {IDENTITY_TYPES.map((option) => {
            const selected = form.identityType === option.value;
            return (
              <Pressable
                key={option.value}
                onPress={() => set('identityType')(selected ? '' : option.value)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                style={[styles.identityChip, selected && styles.identityChipSelected]}
              >
                <Text style={[styles.identityChipText, selected && styles.identityChipTextSelected]}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {fieldErrors.identityType ? (
          <Text style={styles.fieldError}>{fieldErrors.identityType}</Text>
        ) : null}

        {form.identityType ? (
          <Input
            label="Document number"
            testID="register-identity-number"
            value={form.identityNumber}
            onChangeText={set('identityNumber')}
            placeholder={`Your ${IDENTITY_TYPES.find((t) => t.value === form.identityType)?.label} number`}
            autoCapitalize="characters"
          />
        ) : null}

        <Button
          label="Create account"
          testID="register-submit"
          onPress={submit}
          loading={busy}
          size="lg"
          style={styles.submit}
        />

        <Pressable
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          hitSlop={10}
          style={styles.switchLink}
        >
          <Text style={styles.switchText}>
            Already have an account? <Text style={styles.switchAction}>Sign in</Text>
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.ink04 },
  content: { padding: space.lg, paddingBottom: space.xxxl },

  sectionTitle: { ...type.heading, marginBottom: space.xs },
  sectionNote: { ...type.caption, lineHeight: 17, marginBottom: space.lg },

  identityRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg },
  identityChip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: 999,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.ink15,
  },
  identityChipSelected: { backgroundColor: colors.brand700, borderColor: colors.brand700 },
  identityChipText: { ...type.caption, fontWeight: '600', color: colors.ink70 },
  identityChipTextSelected: { color: colors.white },
  fieldError: { ...type.caption, color: colors.danger, marginTop: -space.sm, marginBottom: space.md },

  submit: { marginTop: space.sm },
  switchLink: { alignSelf: 'center', paddingVertical: space.lg },
  switchText: { ...type.small, color: colors.ink50 },
  switchAction: { color: colors.brand700, fontWeight: '700' },
});
