/**
 * Sign in.
 *
 * The demo-account shortcut is here on purpose, and it is honest about what it
 * is: one tap to a seeded traveller account so the app can be opened and used
 * during a demo without typing a password on stage. The credentials are shown
 * on screen rather than hidden, because a login form that silently logs you in
 * as someone else is worse than no shortcut at all.
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../context/AuthContext';
import { Button, Callout, Input } from '../components/ui';
import { colors, radius, space, type } from '../theme';
import { describeError } from '../utils/errors';

const DEMO_EMAIL = 'demo@tripmind.ai';

export default function SignInScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { signIn } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  const submit = useCallback(
    async (override) => {
      const credentials = override || { email: email.trim(), password };
      setError(null);
      setFieldErrors({});

      if (!override) {
        const problems = {};
        if (!credentials.email) problems.email = 'Enter your email.';
        if (!credentials.password) problems.password = 'Enter your password.';
        if (Object.keys(problems).length) {
          setFieldErrors(problems);
          return;
        }
      }

      setBusy(true);
      try {
        await signIn(credentials.email, credentials.password);
      } catch (e) {
        const described = describeError(e);
        setError(described);
        // A wrong password is the common case, and re-typing an email on the
        // next attempt is pure friction, so only the password is cleared.
        if (e?.code === 'invalid_credentials') setPassword('');
      } finally {
        setBusy(false);
      }
    },
    [email, password, signIn],
  );

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + space.xxxl, paddingBottom: insets.bottom + space.xl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brandBlock}>
          <View style={styles.mark}>
            <Text style={styles.markText}>T</Text>
          </View>
          <Text style={styles.title}>TripMind AI</Text>
          <Text style={styles.tagline}>Plan once. Survive anything.</Text>
        </View>

        <View style={styles.form}>
          {error ? (
            <Callout
              tone={error.tone || 'danger'}
              title={error.tone === 'warning' ? 'Cannot sign in' : 'Sign-in failed'}
              message={error.message}
              action={error.action === 'Retry' ? 'Retry' : undefined}
              onAction={error.action === 'Retry' ? () => submit() : undefined}
            />
          ) : null}

          <Input
            label="Email"
            testID="signin-email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            error={fieldErrors.email}
            required
          />
          <Input
            label="Password"
            testID="signin-password"
            value={password}
            onChangeText={setPassword}
            placeholder="Your password"
            secureTextEntry
            error={fieldErrors.password}
            required
          />

          <Button
            label="Sign in"
            testID="signin-submit"
            onPress={() => submit()}
            loading={busy}
            size="lg"
          />

          <Pressable
            onPress={() => navigation.navigate('Register')}
            accessibilityRole="button"
            hitSlop={10}
            style={styles.switchLink}
          >
            <Text style={styles.switchText}>
              New to TripMind? <Text style={styles.switchAction}>Create an account</Text>
            </Text>
          </Pressable>
        </View>

        <View style={styles.demoBlock}>
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>OR</Text>
            <View style={styles.dividerLine} />
          </View>
          <Button
            label="Continue as the demo traveller"
            variant="secondary"
            onPress={() => submit({ email: DEMO_EMAIL, password: 'Demo@12345' })}
            disabled={busy}
          />
          <Text style={styles.demoNote}>
            Signs you in as {DEMO_EMAIL}, a seeded account with existing trips and bookings.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.white },

  content: { flexGrow: 1, paddingHorizontal: space.xl },

  brandBlock: { alignItems: 'center', marginBottom: space.xxl },
  mark: {
    width: 64,
    height: 64,
    borderRadius: radius.xl,
    backgroundColor: colors.brand700,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.md,
  },
  markText: { fontSize: 32, fontWeight: '800', color: colors.white },
  title: { ...type.display, marginBottom: space.xs },
  tagline: { ...type.small, color: colors.ink50 },

  form: { width: '100%' },

  switchLink: { alignSelf: 'center', paddingVertical: space.lg },
  switchText: { ...type.small, color: colors.ink50 },
  switchAction: { color: colors.brand700, fontWeight: '700' },

  demoBlock: { marginTop: 'auto', paddingTop: space.xl },
  divider: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.lg },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.ink15 },
  dividerText: { ...type.caption, letterSpacing: 1 },
  demoNote: { ...type.caption, textAlign: 'center', marginTop: space.sm, lineHeight: 17 },
});
