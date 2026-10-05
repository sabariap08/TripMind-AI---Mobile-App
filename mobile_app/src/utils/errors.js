/**
 * Turning an ApiError into something worth reading.
 *
 * The server already sends a human sentence. The job here is to add the one
 * thing it cannot know: what the user should *do* next. An offline error and a
 * validation error both need different buttons, and the raw message does not
 * carry that.
 */
import { ApiError } from '../api/client';

/**
 * Resolve a failure into `{ message, action, tone }`.
 *
 * `tone` drives the colour; `action` is the label for the button the screen
 * should offer. Returning `null` means "there is nothing sensible to offer",
 * and the caller shows the message alone rather than inventing a retry.
 */
export function describeError(error) {
  if (!error) return null;

  if (!(error instanceof ApiError)) {
    return { message: error.message || 'Something went wrong.', action: null, tone: 'danger' };
  }

  switch (error.code) {
    case 'offline':
    case 'network_unreachable':
      return {
        message: 'Cannot reach the TripMind server. Check your Wi-Fi or data, and confirm the API address in Settings.',
        action: 'Retry',
        tone: 'warning',
      };

    case 'timeout':
      return {
        message: 'The server took too long to respond. The plan may still have been generated - pull to refresh before retrying.',
        action: 'Refresh',
        tone: 'warning',
      };

    case 'ai_unavailable':
      // The one error where retrying is genuinely the right advice, because
      // nothing about the request was wrong.
      return {
        message: error.message || 'The AI planner is not reachable right now. Your trip is saved - try generating again in a moment.',
        action: 'Try again',
        tone: 'warning',
      };

    case 'bad_response':
      return {
        message: error.message,
        action: 'Check settings',
        tone: 'danger',
      };

    case 'token_expired':
    case 'token_invalid':
    case 'token_missing':
    case 'account_missing':
      return {
        message: 'Your session expired. Please sign in again.',
        action: 'Sign in',
        tone: 'neutral',
      };

    case 'account_inactive':
    case 'account_suspended':
    case 'account_not_permitted':
    case 'admin_read_only':
    case 'role_forbidden':
    case 'provider_only':
      return { message: error.message, action: null, tone: 'danger' };

    case 'trip_not_found':
    case 'booking_not_found':
    case 'itinerary_not_found':
      return {
        message: 'That is not available any more.',
        action: 'Go back',
        tone: 'neutral',
      };

    case 'trip_locked':
    case 'trip_not_deletable':
      return { message: error.message, action: null, tone: 'neutral' };

    case 'weak_password':
    case 'password_mismatch':
    case 'password_required':
    case 'email_invalid':
    case 'mobile_invalid':
    case 'identity_incomplete':
    case 'budget_too_low':
    case 'field_required':
    case 'field_invalid':
    case 'field_invalid_date':
    case 'field_out_of_range':
    case 'field_too_long':
    case 'value_not_allowed':
    case 'date_range_invalid':
    case 'date_range_too_long':
    case 'too_many_items':
    case 'amount_invalid':
    case 'amount_too_large':
    case 'coordinate_invalid':
    case 'query_too_short':
    case 'nothing_to_update':
    case 'body_required':
    case 'body_not_object':
    case 'registration_rejected':
    case 'booking_rejected':
    case 'cancellation_rejected':
    case 'payment_failed':
    case 'deposit_failed':
    case 'replan_rejected':
    case 'no_selected_itinerary':
      return { message: error.message, action: null, tone: 'danger' };

    default:
      // Include the code so an unexpected failure is diagnosable from a
      // screenshot rather than being an anonymous "something went wrong".
      return {
        message: error.message || 'Something went wrong.',
        action: error.retryable ? 'Retry' : null,
        tone: 'danger',
      };
  }
}

/** One line for a toast or an inline error, with no action affordance. */
export function errorLine(error) {
  const described = describeError(error);
  return described?.message || 'Something went wrong.';
}

export default { describeError, errorLine };
