/**
 * The ticket.
 *
 * Two jobs, in one screen, because they happen at the same moment in a
 * traveller's life - at a gate, holding a phone:
 *
 *   show      render the signed QR a verifier scans
 *   scan      read a QR with the camera
 *
 * The payload is issued server-side by `ticket_service`, the same issuer the web
 * app uses, so a code shown here verifies on any client. The app never builds a
 * payload itself and never uploads a scan: the barcode is decoded on-device and
 * the string is shown for the user to read. Deciding whether a ticket is *valid*
 * is the provider verifier's job on the server, and this screen does not
 * pretend otherwise.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../context/AuthContext';
import { bookings as bookingsApi, trips as tripsApi } from '../api/endpoints';
import {
  Badge, Button, Callout, Card, Divider, EmptyState, Loading, Row,
} from '../components/ui';
import { colors, radius, space, type } from '../theme';
import { titleCase } from '../utils/format';
import { describeError } from '../utils/errors';

export default function TicketScreen({ route, navigation }) {
  const { tripId, bookingId } = route.params || {};
  const insets = useSafeAreaInsets();
  const { token } = useAuth();

  const [mode, setMode] = useState('show');

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <ModeSwitch mode={mode} onChange={setMode} />

      {mode === 'show' ? (
        <ShowTicket token={token} tripId={tripId} bookingId={bookingId} onGoBack={navigation.goBack} />
      ) : (
        <ScanTicket />
      )}
    </View>
  );
}

function ModeSwitch({ mode, onChange }) {
  return (
    <Row gap={space.sm} style={styles.switch}>
      {[
        { key: 'show', label: 'My ticket' },
        { key: 'scan', label: 'Scan a code' },
      ].map((option) => {
        const active = mode === option.key;
        return (
          <Pressable
            key={option.key}
            onPress={() => onChange(option.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[styles.switchTab, active && styles.switchTabActive]}
          >
            <Text style={[styles.switchLabel, active && styles.switchLabelActive]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </Row>
  );
}

// -------------------------------------------------------------------- show
/**
 * A booking id is more specific than a trip id, so it wins when both are
 * present. The trip-level token is the fallback for "I scan once for the whole
 * journey" at a platform gate.
 */
function ShowTicket({ token, tripId, bookingId, onGoBack }) {
  const insets = useSafeAreaInsets();
  const [state, setState] = useState({ loading: true, error: null, payload: null, label: null });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      let payload;
      let label;

      if (bookingId) {
        const [result, detail] = await Promise.all([
          bookingsApi.token(token, bookingId),
          bookingsApi.get(token, bookingId).catch(() => null),
        ]);
        payload = result?.token;
        const doc = detail?.booking;
        label = [titleCase(doc?.type), doc?.date].filter(Boolean).join(' · ') || 'Booking';
      } else {
        const result = await tripsApi.tripToken(token, tripId);
        payload = result?.token;
        label = 'Whole trip';
      }

      setState({ loading: false, error: null, payload, label });
    } catch (e) {
      setState({ loading: false, error: describeError(e), payload: null, label: null });
    }
  }, [token, tripId, bookingId]);

  useEffect(() => {
    load();
  }, [load]);

  if (state.loading) return <Loading label="Preparing your ticket" />;

  if (state.error) {
    // "A ticket is issued once..." means nothing is confirmed yet. That is a
    // state of the trip, not a failure, so it gets an explanation and a next
    // step instead of a red error.
    const notReady = String(state.error.message || '').includes('once');
    if (notReady) {
      return (
        <ScrollView contentContainerStyle={[styles.padded, { paddingBottom: insets.bottom + space.xxxl }]}>
          <EmptyState
            icon="🎫"
            title="No ticket yet"
            message="A ticket is issued once a booking on this trip is confirmed. Pay an outstanding booking and it will appear here."
            action="Go back"
            onAction={onGoBack}
          />
        </ScrollView>
      );
    }
    return (
      <ScrollView contentContainerStyle={[styles.padded, { paddingBottom: insets.bottom + space.xxxl }]}>
        <Callout
          tone={state.error.tone || 'danger'}
          title="Could not load the ticket"
          message={state.error.message}
          action="Try again"
          onAction={load}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={[styles.padded, { paddingBottom: insets.bottom + space.xxxl }]}>
      <View style={styles.qrCard}>
        <Text style={styles.qrLabel}>{state.label}</Text>
        <View style={styles.qrFrame}>
          {/* High error correction. Gate scanners are frequently at an angle, in
              low light, or on a cracked screen, and a ticket that will not scan
              is worth nothing at the gate. */}
          <QRCode value={state.payload} size={240} ecl="H" />
        </View>
        <Text style={styles.qrHint}>Hold this flat and centred in front of the scanner.</Text>
      </View>

      <Card style={styles.detailCard}>
        <Text style={styles.detailTitle}>How this works</Text>
        <Text style={styles.detailBody}>
          The code is signed by TripMind when it is issued, and a verifier checks that signature
          against the booking record on the server. It therefore cannot be edited or reused, and
          the same ticket works in the web app and any other TripMind client.
        </Text>
      </Card>

      <Button label="Refresh" variant="secondary" onPress={load} />
    </ScrollView>
  );
}

// -------------------------------------------------------------------- scan
/**
 * Camera scanner.
 *
 * The barcode is decoded on-device by the OS detector and never uploaded. The
 * screen shows what was read and stops there: approving a ticket is the
 * provider verifier's decision on the server, and claiming otherwise from a
 * phone camera would be a lie with a camera permission attached to it.
 */
function ScanTicket() {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(null);

  const onBarcodeScanned = useCallback(
    ({ data }) => {
      setScanned((current) => {
        if (current) return current;
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        return data;
      });
    },
    [],
  );

  const reset = useCallback(() => setScanned(null), []);

  if (!permission) return <Loading label="Checking camera access" />;

  if (!permission.granted) {
    return (
      <ScrollView contentContainerStyle={[styles.padded, { paddingBottom: insets.bottom + space.xxxl }]}>
        <EmptyState
          icon="📷"
          title="Camera access needed"
          message="Scanning a QR needs the camera. TripMind uses it only while this screen is open, and nothing it reads is uploaded."
          action="Allow camera"
          onAction={requestPermission}
        />
      </ScrollView>
    );
  }

  if (!scanned) {
    return (
      <View style={styles.flex}>
        <CameraView
          style={styles.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={onBarcodeScanned}
        />
        <View style={styles.reticle} pointerEvents="none">
          <View style={styles.reticleBox} />
        </View>
        <View style={styles.cameraHint} pointerEvents="none">
          <Text style={styles.cameraHintText}>Point at a TripMind QR code</Text>
        </View>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={[styles.padded, { paddingBottom: insets.bottom + space.xxxl }]}>
      <Card>
        <Row style={styles.resultTop}>
          <Badge label="Scanned" tone="success" />
          <Text style={styles.resultMeta}>{scanned.length} characters</Text>
        </Row>

        <Text style={styles.payload} numberOfLines={4} selectable>
          {scanned}
        </Text>

        <Divider />

        <Callout
          tone="info"
          title="Decoded on this device"
          message="The barcode was read locally and nothing was sent anywhere. Whether this ticket is valid is decided by the provider's verifier against the booking record on the server."
        />

        <View style={styles.resultActions}>
          <Button label="Scan another" onPress={reset} />
        </View>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.ink04 },
  padded: { padding: space.lg, flexGrow: 1 },

  switch: { paddingHorizontal: space.lg, paddingVertical: space.md },
  switchTab: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.ink08,
  },
  switchTabActive: { backgroundColor: colors.brand700, borderColor: colors.brand700 },
  switchLabel: { ...type.small, fontWeight: '700', color: colors.ink70 },
  switchLabelActive: { color: colors.white },

  qrCard: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: space.xl,
    alignItems: 'center',
    marginBottom: space.lg,
  },
  qrLabel: { ...type.caption, marginBottom: space.md, textAlign: 'center' },
  qrFrame: {
    padding: space.lg,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.ink08,
  },
  qrHint: { ...type.caption, marginTop: space.md, textAlign: 'center' },

  detailCard: { backgroundColor: colors.brand50, borderColor: colors.brand100 },
  detailTitle: { ...type.bodyStrong, marginBottom: space.xs },
  detailBody: { ...type.small, lineHeight: 20 },

  camera: { flex: 1, backgroundColor: colors.ink },
  reticle: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  reticleBox: {
    width: 240,
    height: 240,
    borderRadius: radius.lg,
    borderWidth: 3,
    borderColor: colors.brand300,
    backgroundColor: 'transparent',
  },
  cameraHint: { position: 'absolute', left: 0, right: 0, bottom: space.xxxl, alignItems: 'center' },
  cameraHintText: {
    ...type.small,
    color: colors.white,
    backgroundColor: colors.overlay,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },

  resultTop: { justifyContent: 'space-between', marginBottom: space.md },
  resultMeta: { ...type.caption },
  payload: { ...type.mono, fontSize: 12, lineHeight: 17, color: colors.ink50 },
  resultActions: { marginTop: space.md },
});
