/**
 * Every API the app uses, in one place.
 *
 * Screens call these, never `api.get('/trips/...')` directly. That keeps the
 * server contract in a single file, so a backend route rename is one edit here
 * rather than a grep across ten screens - and it means the shape of a response
 * can be normalised once instead of defensively unwrapped at every call site.
 */
import { api } from './client';

const q = (params) => {
  const parts = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

// ------------------------------------------------------------------- auth
export const auth = {
  signIn: (email, password) => api.signIn(email, password),
  register: (payload) => api.register(payload),
  me: (token) => api.me(token),
  signOut: () => api.signOut(),
  changePassword: (token, currentPassword, newPassword) =>
    api.post('/auth/password', { currentPassword, newPassword }, { token }),
};

// ------------------------------------------------------------- catalogue
export const catalogue = {
  health: () => api.health(),
  cities: () => api.get('/catalogue/cities'),
  transport: ({ origin, destination, type } = {}) =>
    api.get(`/catalogue/transport${q({ origin, destination, type })}`),
  spots: (city) => api.get(`/catalogue/spots${q({ city })}`),
  tours: (city) => api.get(`/catalogue/tours${q({ city })}`),
  guides: (city) => api.get(`/catalogue/guides${q({ city })}`),
  hotels: (city) => api.get(`/catalogue/hotels${q({ city })}`),
  restaurants: (city) => api.get(`/catalogue/restaurants${q({ city })}`),
  menu: (restaurantId) => api.get(`/catalogue/restaurants/${restaurantId}/menu`),
  distance: ({ origin, destination, originLat, originLng, destLat, destLng } = {}) =>
    api.get(`/places/distance${q({ origin, destination, originLat, originLng, destLat, destLng })}`),
};

// ------------------------------------------------------------------ trips
export const trips = {
  list: (token, limit = 50) => api.get(`/trips${q({ limit })}`, { token }),
  get: (token, id) => api.get(`/trips/${id}`, { token }),
  create: (token, payload) => api.post('/trips', payload, { token }),
  update: (token, id, changes) => api.patch(`/trips/${id}`, changes, { token }),
  remove: (token, id) => api.del(`/trips/${id}`, { token }),

  clarify: (token, id) => api.clarify(`/trips/${id}/clarify`, { token }),
  generate: (token, id) => api.generate(`/trips/${id}/generate`, { token }),

  itinerary: (token, id) => api.get(`/trips/${id}/itinerary`, { token }),
  selectItinerary: (token, id, itineraryId) =>
    api.post(`/trips/${id}/itinerary/select`, { itineraryId }, { token }),

  recordDelay: (token, id, minutes, note) =>
    api.post(`/trips/${id}/delay`, { minutes, note }, { token }),
  clearDelay: (token, id) => api.del(`/trips/${id}/delay`, { token }),
  replan: (token, id, { delayMinutes, reason, confirm } = {}) =>
    api.post(`/trips/${id}/replan`, { delayMinutes, reason, confirm }, { token }),

  budget: (token, id) => api.get(`/trips/${id}/budget`, { token }),
  events: (token, id, limit = 50) => api.get(`/trips/${id}/events${q({ limit })}`, { token }),
};

// --------------------------------------------------------------- bookings
export const bookings = {
  list: (token) => api.get('/bookings', { token }),
  get: (token, id) => api.get(`/bookings/${id}`, { token }),
  create: (token, payload) => api.post('/bookings', payload, { token }),
  pay: (token, id) => api.post(`/bookings/${id}/pay`, {}, { token }),
  cancel: (token, id) => api.del(`/bookings/${id}`, { token }),
  payTrip: (token, tripId) => api.post(`/trips/${tripId}/pay`, {}, { token }),
  token: (token, id) => api.get(`/bookings/${id}/token`, { token }),
  tripToken: (token, tripId) => api.get(`/trips/${tripId}/token`, { token }),
};

// ----------------------------------------------------------------- wallet
export const wallet = {
  get: (token) => api.get('/wallet', { token }),
  deposit: (token, amount) => api.post('/wallet/deposit', { amount }, { token }),
};

export default { auth, catalogue, trips, bookings, wallet };
