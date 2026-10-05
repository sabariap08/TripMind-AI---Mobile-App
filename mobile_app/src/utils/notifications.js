/**
 * Delay alerts.
 *
 * Read this before believing the file name: there is no server push here, and
 * pretending otherwise would be the easiest dishonesty in the whole project.
 *
 * The mobile API is request/response only. It has no token registry, no APNs or
 * FCM send path, and nothing that runs when the app is closed. So this module
 * cannot tell a traveller their train is delayed while the phone is in their
 * pocket - it only raises a local notification when the app is open and has
 * just read a timeline containing something new. That is genuinely useful (you
 * open the app after re-planning and get told), and it is a long way from
 * "push notifications".
 *
 * What real push would need, so the gap is legible rather than hidden:
 *
 *   1. A device-token endpoint: the app POSTs its Expo push token, the server
 *      stores it against the user.
 *   2. A send path in the delay handler: after `trip_service` records a delay,
 *      look up the affected traveller's tokens and POST to Expo's push service.
 *   3. A receipt store, so a failed send is visible rather than assumed fine.
 *
 * Two design decisions in what *does* exist:
 *
 *   * Alerts are deduplicated by event id. Without that, any re-render or
 *     pull-to-refresh re-fires every alert the user has already seen, which
 *     trains people to dismiss notifications without reading them.
 *
 *   * Every function swallows its own errors. A notification that fails must not
 *     take the timeline down with it - the user came to read their trip, not to
 *     grant a permission.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';

const OPT_OUT_KEY = 'tripmind.notifications.optOut';

/**
 * Event types worth interrupting someone for.
 *
 * A booking confirmation is not here: the user just performed that action and
 * is looking at the result. A delay is, because they may not be looking.
 */
const ALERTING = new Set(['DELAY', 'DELAY_RECORDED', 'DISRUPTION', 'REPLAN']);

// ---------------------------------------------------------------- permission

/** Has the user previously said no? Checked before prompting, because a second
 *  system prompt after an explicit refusal is how apps get uninstalled. */
export async function isOptedOut() {
  try {
    return (await AsyncStorage.getItem(OPT_OUT_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function setOptedOut(value) {
  try {
    if (value) await AsyncStorage.setItem(OPT_OUT_KEY, '1');
    else await AsyncStorage.removeItem(OPT_OUT_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask for permission if it has not been decided, and return the final status.
 *
 * `requested` distinguishes "never asked" from "denied", because the Settings
 * screen needs to say different things: a prompt offer versus instructions to
 * enable it in system settings.
 */
export async function ensurePermission() {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return { status: 'granted', canAskAgain: current.canAskAgain };
    if (!current.canAskAgain) {
      return { status: 'denied', canAskAgain: false };
    }
    const asked = await Notifications.requestPermissionsAsync();
    return { status: asked.granted ? 'granted' : 'denied', canAskAgain: asked.canAskAgain };
  } catch {
    // Notifications unavailable on this build (web, or a stripped profile).
    // Treated as denied rather than throwing: it is a feature absence, not a
    // failure of the screen the user is trying to use.
    return { status: 'denied', canAskAgain: false, unavailable: true };
  }
}

/** The Android channel. Created once per app start; repeated calls are free. */
async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync('trip-disruptions', {
      name: 'Trip disruptions',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#1F6F5C',
      description: 'Delays, disruptions and re-plans affecting your trips.',
    });
  } catch {
    // Channel creation failing does not stop a notification being posted; the
    // OS falls back to a default channel.
  }
}

// ------------------------------------------------------------------ alerts

function titleFor(event, trip) {
  const route = `${trip?.origin || 'your trip'} to ${trip?.destination || 'your destination'}`;
  switch (String(event.type || '').toUpperCase()) {
    case 'DELAY':
    case 'DELAY_RECORDED':
      return `Delay on ${route}`;
    case 'DISRUPTION':
      return `Disruption on ${route}`;
    case 'REPLAN':
      return `Your ${route} plan changed`;
    default:
      return `Update on ${route}`;
  }
}

function bodyFor(event) {
  const parts = [];
  if (event.minutes) parts.push(`${event.minutes} minutes late`);
  else if (event.delayMinutes) parts.push(`${event.delayMinutes} minutes late`);
  if (event.reason) parts.push(event.reason);
  if (event.note) parts.push(event.note);
  if (event.title) parts.push(event.title);
  return parts.join(' · ') || 'Open TripMind for the details.';
}

/**
 * Fire local notifications for events the user has not been told about.
 *
 * Returns a cleanup function so the caller can hold it in a `useEffect` without
 * leaking a subscription. Returns a no-op when nothing should be announced,
 * which includes the very common cases of no permission and no new events.
 */
export function watchTripEvents({
  events,
  trip,
  userName = null,
  lastNotifiedId = null,
  onNotified = () => {},
}) {
  const fresh = (events || []).filter(
    (e) => ALERTING.has(String(e.type || '').toUpperCase()) && e.id,
  );
  if (!fresh.length) return () => {};

  // The timeline is newest-first. Anything at or before the last notified id has
  // already been announced, so only the slice above it is new.
  const unseen = lastNotifiedId
    ? fresh.filter((e) => String(e.id) > String(lastNotifiedId))
    : [];

  // With nothing to compare against (first load of the screen) assume the user
  // has just seen the whole list. Alerting them about it would be pure noise.
  if (!unseen.length) {
    return () => {};
  }

  let cancelled = false;

  (async () => {
    const permission = await ensurePermission();
    if (cancelled || permission.status !== 'granted') return;
    if (await isOptedOut()) return;
    await ensureAndroidChannel();

    // Newest first, and cap it: a re-plan that logged six events should be one
    // notification, not six.
    const toAnnounce = unseen.slice(0, 3);

    for (const event of toAnnounce) {
      if (cancelled) return;
      try {
        await Notifications.scheduleNotificationAsync({
          content: {
            title: titleFor(event, trip),
            body: bodyFor(event),
            data: {
              tripId: trip?.id,
              eventId: event.id,
              type: event.type,
            },
            ...(Platform.OS === 'android' ? { channelId: 'trip-disruptions' } : {}),
          },
          trigger: null, // immediately
        });
      } catch {
        // One failed alert must not stop the others.
      }
    }

    onNotified(toAnnounce[toAnnounce.length - 1].id);
  })();

  return () => { cancelled = true; };
}

/**
 * The scheduling handle used by the Trips list, so a delay is announced even if
 * the user never opens the timeline.
 *
 * Same honesty constraint: it works when the app is open, because that is the
 * only time it runs.
 */
export async function notifyDelayDetected(trip, delay) {
  try {
    const permission = await ensurePermission();
    if (permission.status !== 'granted') return false;
    if (await isOptedOut()) return false;
    await ensureAndroidChannel();
    await Notifications.scheduleNotificationAsync({
      content: {
        title: titleFor({ type: 'DELAY' }, trip),
        body: bodyFor(delay || {}),
        data: { tripId: trip?.id, type: 'DELAY' },
        ...(Platform.OS === 'android' ? { channelId: 'trip-disruptions' } : {}),
      },
      trigger: null,
    });
    return true;
  } catch {
    return false;
  }
}

/** Cancel anything pending. Used on sign-out so alerts do not outlive it. */
export async function cancelAll() {
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
    return true;
  } catch {
    return false;
  }
}

/**
 * A one-line, accurate description of what this feature does and does not do.
 * The Settings screen shows this verbatim, because a toggle labelled "Push
 * notifications" on a feature that only works while the app is open would be a
 * lie told by the interface.
 */
export const HONEST_SUMMARY =
  'Alerts while TripMind is open. We check your trip timeline when you use the app and tell you about delays and re-plans. No background server push yet.';

export default {
  ensurePermission,
  isOptedOut,
  setOptedOut,
  watchTripEvents,
  notifyDelayDetected,
  cancelAll,
  HONEST_SUMMARY,
};
