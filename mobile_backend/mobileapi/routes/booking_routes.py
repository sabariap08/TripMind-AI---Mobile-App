"""Bookings, payments, wallet and tickets for the mobile client.

Every write here delegates to `services.booking_service`, which owns the rules
that actually matter: the duplicate guard, the time-overlap check that stops a
traveller double-booking two things at once, guide availability, and the wallet
debit. Those are the parts of a booking system that are easy to get subtly wrong
and impossible to hand-roll per client, so there is exactly one implementation
and both clients call it.

The mobile layer adds only presentation concerns: narrow serialised shapes and
the QR token a camera can scan at the gate.
"""
from flask import Blueprint, jsonify

from mobileapi import gateway
from mobileapi.auth import current_user, require_auth
from mobileapi.errors import NotFoundError, ValidationError
from mobileapi.serializers import booking_summary, clean, wallet_summary
from mobileapi.validators import require_body

booking_bp = Blueprint("mobile_bookings", __name__)


def _own_booking(booking_id, user, *, write=True):
    """Fetch a booking the caller owns.

    A non-matching owner gets 404, not 403, for the same reason as trips:
    confirming that an id exists is itself a leak.
    """
    doc = gateway.bookings().find_one({"_id": booking_id})
    if not doc or str(doc.get("userId")) != str((user or {}).get("id") or ""):
        raise NotFoundError("Booking not found.", code="booking_not_found")
    return doc


@booking_bp.route("/bookings", methods=["GET"])
@require_auth
def list_bookings():
    from services.booking_service import list_bookings as shared_list
    rows = shared_list(current_user())
    return jsonify({"bookings": [booking_summary(b) for b in rows]})


@booking_bp.route("/bookings", methods=["POST"])
@require_auth
def create_booking():
    """Book one itinerary item.

    The body is the web booking payload, unchanged: `{tripId, type, serviceId,
    date, details, ...}`. Validating a subset here would risk accepting something
    the shared service rejects with a better message, so the service stays the
    authority on what is bookable.
    """
    from services.booking_service import create_booking as shared_create

    data = require_body()
    if not data.get("tripId"):
        raise ValidationError("'tripId' is required.", code="field_required",
                              details={"field": "tripId"})
    if not data.get("type"):
        raise ValidationError("'type' is required.", code="field_required",
                              details={"field": "type"})

    user = current_user()
    trip = gateway.accessible_trip(data["tripId"], user, write=True)

    doc, err = shared_create(data, user)
    if err:
        raise ValidationError(err, code="booking_rejected")

    message = ("Guide request sent. Awaiting guide confirmation."
               if doc.get("type") == "GUIDE" else "Booking confirmed.")
    return jsonify({"booking": booking_summary(doc), "tripId": trip.get("_id"),
                    "message": message}), 201


@booking_bp.route("/bookings/<booking_id>", methods=["GET"])
@require_auth
def get_booking(booking_id):
    return jsonify({"booking": clean(_own_booking(booking_id, current_user()))})


@booking_bp.route("/bookings/<booking_id>/pay", methods=["POST"])
@require_auth
def pay_booking(booking_id):
    from services.booking_service import pay_booking as shared_pay

    user = current_user()
    doc = _own_booking(booking_id, user)
    updated, err = shared_pay(doc, user)
    if err:
        raise ValidationError(err, code="payment_failed")
    return jsonify({"booking": booking_summary(updated),
                    "message": "Payment completed."})


@booking_bp.route("/bookings/<booking_id>", methods=["DELETE"])
@require_auth
def cancel_booking(booking_id):
    from services.booking_service import cancel_booking as shared_cancel

    doc, err = shared_cancel(booking_id, current_user())
    if err:
        raise ValidationError(err, code="cancellation_rejected")
    return jsonify({"booking": booking_summary(doc), "message": "Booking cancelled."})


@booking_bp.route("/trips/<trip_id>/pay", methods=["POST"])
@require_auth
def pay_trip(trip_id):
    """Pay every outstanding booking on a trip in one action."""
    from services.booking_service import pay_trip_bookings as shared_pay_trip

    user = current_user()
    trip = gateway.accessible_trip(trip_id, user, write=True)
    updated, err = shared_pay_trip(trip, user)
    if err:
        raise ValidationError(err, code="payment_failed")
    return jsonify({"bookings": [booking_summary(b) for b in (updated or [])],
                    "message": "Payment completed for the trip."})


# ------------------------------------------------------------------ wallet
@booking_bp.route("/wallet", methods=["GET"])
@require_auth
def get_wallet():
    # `get_wallet` takes a user *id*, not the public user dict, and creates the
    # wallet on first read. Both behaviours are the shared service's.
    from services.wallet_service import get_wallet as shared_wallet
    return jsonify({"wallet": wallet_summary(shared_wallet(current_user()["id"]))})


@booking_bp.route("/wallet/deposit", methods=["POST"])
@require_auth
def deposit():
    """Top up the wallet.

    A top-up is `credit`, not a separate `deposit` function - the wallet service
    has `credit`/`debit` only, and booking payments run through `debit` inside
    `pay_booking`. Same ledger either way.
    """
    from services.wallet_service import credit

    data = require_body()
    raw = data.get("amount")
    try:
        amount = float(raw)
    except (TypeError, ValueError):
        raise ValidationError("Enter a valid amount.", code="amount_invalid")
    if amount <= 0:
        raise ValidationError("The amount must be greater than zero.",
                              code="amount_invalid")
    if amount > 1_000_000:
        raise ValidationError("That deposit is above the per-transaction limit.",
                              code="amount_too_large")

    wallet, err = credit(current_user()["id"], amount, description="Wallet top-up")
    if err:
        raise ValidationError(err, code="deposit_failed")
    return jsonify({"wallet": wallet_summary(wallet), "message": "Deposit added."})


# ----------------------------------------------------------------- tickets
@booking_bp.route("/bookings/<booking_id>/token", methods=["GET"])
@require_auth
def booking_token(booking_id):
    """Signed QR payload for one booking.

    The app renders this as a QR code and the camera scans it at the gate. The
    token comes from the shared ticket service, so a verifier on any client
    accepts a code generated by any other client. `issue_token` (singular) is
    the per-booking issuer; `issue_trip_token` is the whole-trip one, exposed
    separately below.
    """
    from services.ticket_service import issue_token

    doc = _own_booking(booking_id, current_user())
    token = issue_token(doc)
    if not token:
        raise ValidationError("A ticket is issued once this booking is confirmed.",
                              code="ticket_not_ready")
    return jsonify({"token": token, "bookingId": booking_id})


@booking_bp.route("/trips/<trip_id>/token", methods=["GET"])
@require_auth
def trip_token(trip_id):
    """One QR code for the whole trip - the gate-scanning case.

    A traveller at a platform scans once, not once per leg, so the trip-level
    token carries every confirmed booking on the itinerary.
    """
    from services.ticket_service import issue_trip_token

    trip = gateway.accessible_trip(trip_id, current_user())
    token = issue_trip_token(trip)
    if not token:
        raise ValidationError(
            "A trip ticket is issued once at least one booking is confirmed.",
            code="ticket_not_ready")
    return jsonify({"token": token, "tripId": trip_id})
