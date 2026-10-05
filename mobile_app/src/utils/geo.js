/**
 * Geolocation helpers.
 *
 * There is no server-side reverse geocoder on this platform, so the app does
 * the nearest-known-place match on the handset. That is not a workaround: it is
 * the right place for it. It works with no network, it costs nothing, and it
 * cannot leak a user's coordinates to a third-party geocoding provider.
 *
 * The match is only ever used to pre-fill the origin field, which stays
 * editable. A wrong guess is a one-tap correction, not a broken plan.
 */

const EARTH_RADIUS_KM = 6371;

export function distanceKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => typeof v !== 'number' || Number.isNaN(v))) {
    return null;
  }
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/**
 * Nearest entry from `places` to a GPS fix.
 *
 * `places` entries need `{ name, lat, lng }`. Places without coordinates are
 * skipped rather than treated as zero, because (0, 0) is in the Gulf of Guinea
 * and would happily win every comparison in India.
 *
 * Returns `{ place, distanceKm }` or null when nothing is close enough. Beyond
 * `maxKm` the answer is "I do not know where you are" rather than a confident
 * wrong city.
 */
export function nearestPlace(places, { lat, lng, maxKm = 120 } = {}) {
  let best = null;
  for (const place of places || []) {
    const placeLat = Number(place?.lat);
    const placeLng = Number(place?.lng);
    if (!Number.isFinite(placeLat) || !Number.isFinite(placeLng)) continue;
    const km = distanceKm(lat, lng, placeLat, placeLng);
    if (km === null) continue;
    if (!best || km < best.distanceKm) {
      best = { place, distanceKm: km };
    }
  }
  if (!best || best.distanceKm > maxKm) return null;
  return best;
}

/**
 * Reference coordinates for cities the platform actually serves.
 *
 * Used only as match targets for the GPS fix. They are city centroids, not
 * addresses, and the app never presents them as a precise location.
 */
export const KNOWN_PLACES = [
  { name: 'Chennai', lat: 13.0827, lng: 80.2707 },
  { name: 'Coimbatore', lat: 11.0168, lng: 76.9558 },
  { name: 'Chennai Egmore', lat: 13.0799, lng: 80.2562 },
  { name: 'Chennai Central', lat: 13.0827, lng: 80.2754 },
  { name: 'Coimbatore Junction', lat: 11.0096, lng: 76.9538 },
  { name: 'Mettupalayam', lat: 11.3392, lng: 77.0008 },
  { name: 'Udupi', lat: 13.3409, lng: 74.7553 },
  { name: 'Mangaluru', lat: 12.9141, lng: 74.856 },
  { name: 'Kochi', lat: 9.9312, lng: 76.2673 },
  { name: 'Bengaluru', lat: 12.9716, lng: 77.5946 },
  { name: 'Madurai', lat: 9.9252, lng: 78.1198 },
  { name: 'Tiruchirappalli', lat: 10.7905, lng: 78.7047 },
  { name: 'Salem', lat: 11.6643, lng: 78.146 },
  { name: 'Tirunelveli', lat: 8.7139, lng: 77.7567 },
  { name: 'Kanyakumari', lat: 8.0883, lng: 77.5385 },
  { name: 'Pondicherry', lat: 11.9416, lng: 79.8083 },
  { name: 'Thanjavur', lat: 10.787, lng: 79.1378 },
  { name: 'Dindigul', lat: 10.3624, lng: 77.9695 },
  { name: 'Erode', lat: 11.341, lng: 77.7172 },
];

/** Readable summary of a GPS fix for the "using your location" state. */
export function describeFix(coords) {
  if (!coords) return null;
  const { latitude, longitude, accuracy } = coords;
  const rounded = `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`;
  if (typeof accuracy === 'number') {
    return `Within ${Math.round(accuracy)} m of ${rounded}`;
  }
  return rounded;
}
