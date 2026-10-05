/**
 * Presentation helpers.
 *
 * The rule throughout: a value the server could not determine renders as "not
 * known", never as 0. The backend deliberately sends `null` for "unknown" and
 * counts unpriced items separately, so `money(null)` showing `₹0` here would
 * undo the most careful thing the server does.
 */

const RUPEE = '₹';

export function money(value, { currency = 'INR', compact = false } = {}) {
  if (value === null || value === undefined || value === '') return 'Not known';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'Not known';
  if (compact && Math.abs(n) >= 100000) {
    return `${RUPEE}${(n / 100000).toFixed(n % 100000 === 0 ? 0 : 1)}L`;
  }
  if (compact && Math.abs(n) >= 1000) {
    return `${RUPEE}${Math.round(n / 1000)}k`;
  }
  const formatted = new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: Number.isInteger(n) ? 0 : 2,
  }).format(n);
  return currency === 'INR' ? `${RUPEE}${formatted}` : `${currency} ${formatted}`;
}

export function moneyDelta(value) {
  if (value === null || value === undefined) return 'Not known';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'Not known';
  if (n === 0) return 'No change';
  return `${n > 0 ? '+' : '-'}${money(Math.abs(n))}`;
}

export function shortDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export function longDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function dateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });
}

export function timeOnly(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

export function relativeTime(value) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return shortDate(value);
}

export function nightsBetween(start, end) {
  const a = new Date(start);
  const b = new Date(end);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const days = Math.round((b - a) / 86400000);
  return days > 0 ? days : null;
}

export function titleCase(value) {
  if (!value) return '';
  return String(value)
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

export function initials(name) {
  if (!name) return '?';
  return String(name)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('') || '?';
}

/** Map a trip status onto a tone from `theme.statusTone`. */
export function statusTone(status) {
  switch (status) {
    case 'DRAFT':
      return 'neutral';
    case 'PLANNED':
    case 'REPLANNING':
      return 'info';
    case 'BOOKED':
    case 'CONFIRMED':
      return 'brand';
    case 'COMPLETED':
      return 'success';
    case 'CANCELLED':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function itineraryIcon(type) {
  switch (String(type || '').toUpperCase()) {
    case 'FLIGHT':
    case 'TRAIN':
    case 'BUS':
    case 'CAB':
    case 'AUTO':
      return '🚆';
    case 'HOTEL':
      return '🏨';
    case 'FOOD':
    case 'RESTAURANT':
      return '🍽️';
    case 'ACTIVITY':
    case 'TOUR':
    case 'SPOT':
      return '🎟️';
    case 'GUIDE':
      return '🧭';
    default:
      return '📍';
  }
}

export const TRANSPORT_TYPES = [
  { value: null, label: 'Any' },
  { value: 'TRAIN', label: 'Train' },
  { value: 'BUS', label: 'Bus' },
  { value: 'FLIGHT', label: 'Flight' },
  { value: 'CAB', label: 'Cab' },
  { value: 'AUTO', label: 'Auto' },
];

export const TRAVEL_STYLES = [
  { value: 'BALANCED', label: 'Balanced' },
  { value: 'BUDGET', label: 'Budget' },
  { value: 'COMFORT', label: 'Comfort' },
  { value: 'LUXURY', label: 'Luxury' },
];

export const PREMIUM_SERVICES = [
  { value: 'TRANSPORT', label: 'Transport' },
  { value: 'HOTELS', label: 'Hotels' },
  { value: 'ACTIVITIES', label: 'Activities' },
  { value: 'GUIDE', label: 'Guide' },
];

/** ISO `YYYY-MM-DD`, which is what the API validator accepts. */
export function isoDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
