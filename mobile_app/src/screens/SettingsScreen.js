/**
 * Settings.
 *
 * The server address lives here, not in a config file, because a demo happens on
 * someone else's Wi-Fi. Rebuilding an app to change a host is the difference
 * between a working demo and a story about a working demo.
 *
 * The health check is a real GET /health against the address currently in use,
 * and it reports what the server said - database reachable or not, planner
 * configured or not - rather than a bare "connected". On a demo, the difference
 * between "the phone cannot reach the API" and "the API is up but MongoDB is
 * not" is the difference between a five-second fix and a lost slot.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../context/AuthContext';
import { auth as authApi, catalogue as catalogueApi } from '../api/endpoints';
import { invalidateBaseUrl, resolveBaseUrl, setBaseUrl } from '../api/client';
import {
  Button, Callout, Card, DataRow, Divider, Input, Row, SectionHeader, Toggle,
} from '../components/ui';
import { colors, space, type } from '../theme';
import { dateTime, relativeTime } from '../utils/format';
import { describeError, errorLine } from '../utils/errors';
import {
  HONEST_SUMMARY, ensurePermission, isOptedOut, setOptedOut,
} from '../utils/notifications';
import { cacheSummary } from '../utils/cache';

export default function SettingsScreen({ route }) {
  const insets = useSafeAreaInsets();
  const { token, user, cacheScope } = useAuth();

  const [baseUrl, setBaseUrlValue] = useState('');
  const [savedUrl, setSavedUrl] = useState('');
  const [health, setHealth] = useState(null);
  const [checking, setChecking] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState(null);
  const [passwordDone, setPasswordDone] = useState(false);

  const [alertsOn, setAlertsOn] = useState(false);
  const [alertsNote, setAlertsNote] = useState(null);
  const [notificationPermission, setNotificationPermission] = useState('unknown');
  const [cacheInfo, setCacheInfo] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const current = await resolveBaseUrl();
      if (!cancelled) {
        setBaseUrlValue(current);
        setSavedUrl(current);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Reflect the real permission state rather than assuming it. `denied` with
  // canAskAgain false means the OS will not prompt again, so the note has to
  // point at system settings instead of offering a button that does nothing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [permission, optedOut] = await Promise.all([
        ensurePermission(),
        isOptedOut(),
      ]);
      if (cancelled) return;
      setNotificationPermission(permission.unavailable ? 'unavailable' : permission.status);
      setAlertsOn(permission.status === 'granted' && !optedOut);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    cacheSummary(cacheScope).then((info) => {
      if (!cancelled) setCacheInfo(info);
    });
    return () => { cancelled = true; };
  }, [cacheScope]);

  const toggleAlerts = useCallback(async (next) => {
    setAlertsNote(null);
    if (!next) {
      await setOptedOut(true);
      setAlertsOn(false);
      return;
    }
    const permission = await ensurePermission();
    if (permission.status !== 'granted') {
      setNotificationPermission(permission.unavailable ? 'unavailable' : permission.status);
      setAlertsNote(
        permission.unavailable
          ? 'Notifications are not available on this build.'
          : permission.canAskAgain
            ? 'Permission was not granted, so alerts stay off.'
            : 'Alerts are blocked for TripMind. Enable them in your phone’s Settings, then come back.',
      );
      return;
    }
    await setOptedOut(false);
    setAlertsOn(true);
  }, []);

  // A demo with an unverifiable alert setting is not worth much, and a toggle
  // that has never fired is indistinguishable from one that is broken. This
  // proves the whole path - permission, channel, delivery - in one tap.
  const testAlert = useCallback(async () => {
    setAlertsNote(null);
    const permission = await ensurePermission();
    if (permission.status !== 'granted') {
      setNotificationPermission(permission.unavailable ? 'unavailable' : permission.status);
      setAlertsNote('Grant notification permission first.');
      return;
    }
    if (await isOptedOut()) {
      setAlertsNote('Alerts are switched off. Turn them on above.');
      return;
    }
    const { notifyDelayDetected } = await import('../utils/notifications');
    const sent = await notifyDelayDetected(
      { id: 'test', origin: 'Mumbai', destination: 'Goa' },
      { minutes: 25, reason: 'Test alert from TripMind settings' },
    );
    setAlertsNote(
      sent
        ? 'Test alert sent. It should appear within a few seconds.'
        : 'Could not post the alert on this device.',
    );
  }, []);

  const checkHealth = useCallback(async () => {
    setChecking(true);
    setHealth(null);
    try {
      const result = await catalogueApi.health();
      setHealth({ ok: true, data: result });
    } catch (e) {
      setHealth({ ok: false, error: describeError(e) });
    } finally {
      setChecking(false);
    }
  }, []);

  const saveBaseUrl = useCallback(async () => {
    try {
      const applied = await setBaseUrl(baseUrl);
      invalidateBaseUrl();
      setBaseUrlValue(applied);
      setSavedUrl(applied);
      setHealth(null);
    } catch (e) {
      Alert.alert('Could not save', errorLine(e));
    }
  }, [baseUrl]);

  const changePassword = useCallback(async () => {
    setPasswordError(null);
    setPasswordDone(false);
    if (!currentPassword || !newPassword) {
      setPasswordError('Enter both your current and new password.');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('Choose a new password of at least 8 characters.');
      return;
    }
    setPasswordBusy(true);
    try {
      await authApi.changePassword(token, currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setPasswordDone(true);
    } catch (e) {
      setPasswordError(describeError(e)?.message || errorLine(e));
    } finally {
      setPasswordBusy(false);
    }
  }, [currentPassword, newPassword, token]);

  const dirty = baseUrl.trim().replace(/\/+$/, '') !== savedUrl;

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
        keyboardShouldPersistTaps="handled"
      >
        {/* ------------------------------------------------------ server */}
        <SectionHeader title="Server" />

        <Card>
          <Input
            label="API address"
            value={baseUrl}
            onChangeText={setBaseUrlValue}
            placeholder="http://10.0.0.5:5001/api/mobile"
            autoCapitalize="none"
            keyboardType="url"
            hint="Must include /api/mobile. A saved address overrides the one built into the app."
          />
          <Button
            label="Save address"
            onPress={saveBaseUrl}
            disabled={!dirty}
            style={styles.saveButton}
          />
        </Card>

        <Card>
          <Row style={styles.healthRow}>
            <View style={styles.healthText}>
              <Text style={type.bodyStrong}>Connection</Text>
              <Text style={styles.healthMeta}>
                {health?.ok
                  ? `Checked ${dateTime(new Date().toISOString())}`
                  : health
                    ? 'Last check failed'
                    : 'Not checked yet'}
              </Text>
            </View>
            <Button
              label={checking ? 'Checking...' : 'Test'}
              variant="secondary"
              full={false}
              onPress={checkHealth}
              loading={checking}
            />
          </Row>

          {health?.ok ? <HealthReport data={health.data} /> : null}
          {health && !health.ok ? (
            <Callout
              tone={health.error?.tone || 'danger'}
              title="Cannot reach the API"
              message={health.error?.message}
            />
          ) : null}
        </Card>

        {/* ---------------------------------------------------- password */}
        <SectionHeader title="Password" />

        <Card>
          <Input
            label="Current password"
            value={currentPassword}
            onChangeText={setCurrentPassword}
            secureTextEntry
            autoCapitalize="none"
          />
          <Input
            label="New password"
            value={newPassword}
            onChangeText={setNewPassword}
            secureTextEntry
            autoCapitalize="none"
            hint="At least 8 characters."
            error={passwordError}
          />
          {passwordDone ? (
            <Callout tone="success" message="Your password has been changed." />
          ) : null}
          <Button
            label="Change password"
            onPress={changePassword}
            loading={passwordBusy}
          />
        </Card>

        {/* ------------------------------------------------------- alerts */}
        <SectionHeader title="Alerts" />
        <Card>
          <Toggle
            label="Trip disruption alerts"
            hint={HONEST_SUMMARY}
            value={alertsOn}
            onChange={toggleAlerts}
          />
          <Button
            label={alertsOn ? 'Send a test alert' : 'Enable alerts'}
            onPress={testAlert}
            variant="secondary"
          />
          {alertsNote ? <Text style={styles.aboutBody}>{alertsNote}</Text> : null}
        </Card>

        {/* -------------------------------------------------------- device */}
        <SectionHeader title="This device" />
        <Card>
          <DataRow
            label="Notifications"
            value={notificationPermission === 'unknown' ? '—' : notificationPermission}
          />
          <DataRow
            label="Offline cache"
            value={cacheInfo ? `${cacheInfo.count} saved · ${relativeTime(cacheInfo.oldest)}` : 'empty'}
          />
          <Text style={styles.aboutBody}>
            Alerts only arrive while TripMind is open. There is no background server push
            yet, so a delay recorded while the app is closed will not notify you until you
            next open the app.
          </Text>
        </Card>

        {/* --------------------------------------------------------- about */}
        <SectionHeader title="About" />
        <Card>
          <DataRow label="Signed in as" value={user?.email || '—'} />
          <DataRow label="App version" value="1.0.0" />
          <DataRow label="Runtime" value="Expo SDK 57 · React Native 0.86" />
          <Divider />
          <Text style={styles.aboutBody}>
            Planning runs on TripMind's server so the catalogue, pricing and re-planning logic
            are shared with the web app. Health notes and identity documents are never sent to
            the AI.
          </Text>
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Show what the server actually reported, not just that it answered. */
function HealthReport({ data }) {
  const rows = [
    ['Service', data?.service],
    ['Database', data?.database],
    ['Status', data?.status],
    ['Version', data?.version],
    ['JWT secret', data?.jwtSecretEphemeral ? 'generated per run' : 'configured'],
  ].filter(([, value]) => value !== undefined && value !== null);

  return (
    <>
      <Divider />
      <Callout
        tone={healthy(data) ? 'success' : 'warning'}
        title={healthy(data) ? 'API reachable' : 'API reachable, with a warning'}
        message={
          healthy(data)
            ? 'The server responded and reports itself healthy.'
            : 'The server responded but reported a degraded dependency. See the detail below.'
        }
      />
      {rows.map(([label, value]) => (
        <DataRow key={label} label={label} value={String(value)} />
      ))}
    </>
  );
}

/**
 * `GET /health` reports `status: "ok" | "degraded"`, where degraded means the
 * process is up but the database round trip failed. That distinction is the
 * whole point of the endpoint, so it is honoured rather than collapsed into
 * "reachable".
 */
function healthy(data) {
  if (!data) return false;
  if (typeof data.status === 'string') return data.status.toLowerCase() === 'ok';
  if (typeof data.ok === 'boolean') return data.ok;
  return data.database !== 'unreachable';
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.ink04 },
  content: { paddingHorizontal: space.lg },

  saveButton: { marginTop: space.xs },

  healthRow: { justifyContent: 'space-between', gap: space.md, marginBottom: space.md },
  healthText: { flex: 1 },
  healthMeta: { ...type.caption, marginTop: 2 },

  aboutBody: { ...type.small, lineHeight: 20 },
});
