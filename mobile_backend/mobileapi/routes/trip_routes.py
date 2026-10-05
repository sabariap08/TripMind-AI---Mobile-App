"""Trip lifecycle for the mobile client.

Create -> clarify -> generate -> view -> disrupt -> re-plan.

The planning, disruption and re-planning behaviour all lives in
`mobileapi.gateway`, which calls the same services the web app calls. These
handlers do three things and nothing else: authenticate, validate, serialise.

Two design decisions worth stating, because they are the difference between a
mobile client and a web page in a small window:

  * `generate` can return "no plans" (HTTP 200, `selectedPlan: null`) or
    "the AI is down" (HTTP 503, `retryable: true`). The app shows a retry
    button for one and an explanatory empty state for the other. Collapsing them
    into one "something went wrong" screen would make the app untestable during
    a demo, which is the worst possible time to discover the distinction.

  * `replan` is two-phase. The first call proposes with a real cost delta and
    writes nothing; the second applies. The confirm screen is the feature.
"""
from flask import Blueprint, jsonify

from mobileapi import gateway
from mobileapi.auth import current_user, require_auth
from mobileapi.errors import ValidationError
from mobileapi.serializers import (clean_list, group_by_day, itinerary_items,
                                   trip_detail, trip_summary)
from mobileapi.validators import (optional_bool, optional_int, optional_str,
                                  require_body, require_int, require_str,
                                  validate_trip_payload)

trip_bp = Blueprint("mobile_trips", __name__)


# ------------------------------------------------------------------ trips
@trip_bp.route("/trips", methods=["POST"])
@require_auth
def create_trip():
    data = require_body()
    payload = validate_trip_payload(data)
    trip = gateway.create_trip(current_user()["id"], payload)
    return jsonify({"trip": trip_summary(trip), "message": "Trip created"}), 201


@trip_bp.route("/trips", methods=["GET"])
@require_auth
def list_trips():
    limit = optional_int({"limit": _arg("limit")}, "limit", minimum=1, maximum=200,
                         default=50)
    trips = [gateway.ensure_trip_completed(t) for t in gateway.list_trips(current_user(),
                                                                          limit=limit)]
    return jsonify({"trips": [trip_summary(t) for t in trips]})


@trip_bp.route("/trips/<trip_id>", methods=["GET"])
@require_auth
def get_trip(trip_id):
    trip = gateway.ensure_trip_completed(
        gateway.accessible_trip(trip_id, current_user()))
    return jsonify({"trip": trip_detail(trip)})


@trip_bp.route("/trips/<trip_id>", methods=["PATCH"])
@require_auth
def update_trip(trip_id):
    data = require_body()
    changes = validate_trip_payload(data, partial=True)
    trip = gateway.accessible_trip(trip_id, current_user(), write=True)
    trip = gateway.update_trip(trip, changes)
    return jsonify({"trip": trip_summary(trip), "message": "Trip updated"})


@trip_bp.route("/trips/<trip_id>", methods=["DELETE"])
@require_auth
def delete_trip(trip_id):
    """Delete a DRAFT trip.

    Only drafts are removable. A planned or booked trip has bookings, payments
    and a ticket history attached, and deleting it would orphan all of them -
    so the app hides the action rather than being told no at the worst moment.
    """
    trip = gateway.accessible_trip(trip_id, current_user(), write=True)
    if trip.get("status") != "DRAFT":
        raise ValidationError(
            "Only a draft trip can be deleted. Cancel this trip instead.",
            code="trip_not_deletable")
    gateway.trips().delete_one({"_id": trip_id})
    return jsonify({"message": "Trip deleted"})


# -------------------------------------------------------------- planning
@trip_bp.route("/trips/<trip_id>/clarify", methods=["POST"])
@require_auth
def clarify_trip(trip_id):
    """Ask the AI what it still needs to know before planning.

    The app presents these as typed controls (choice, multi-choice, text), so
    the response is passed through as-is rather than flattened into prose.
    """
    from services.travel_orchestrator import generate_clarifying_questions

    trip = gateway.accessible_trip(trip_id, current_user(), write=True)
    questions = generate_clarifying_questions(gateway._planner_request(trip),
                                             gateway.gather_db_data(trip))
    return jsonify({"questions": clean_list(questions), "tripId": trip_id})


@trip_bp.route("/trips/<trip_id>/generate", methods=["POST"])
@require_auth
def generate_plans(trip_id):
    """Run the shared planner and persist its itineraries.

    Slow by nature (an LLM round trip). The app calls this with a generous
    timeout and shows a progress state; there is no partial-result streaming
    because the planner returns whole plans, not tokens.
    """
    trip = gateway.accessible_trip(trip_id, current_user(), write=True)
    result = gateway.generate_plans(trip)
    result.pop("itineraries", None)
    return jsonify(result)


@trip_bp.route("/trips/<trip_id>/itinerary", methods=["GET"])
@require_auth
def get_itinerary(trip_id):
    """The selected itinerary, grouped by day and ready for a list view."""
    trip = gateway.accessible_trip(trip_id, current_user())
    selected = next((i for i in trip.get("itineraries") or []
                     if i.get("status") == "SELECTED"), None)
    if not selected:
        return jsonify({"itinerary": None, "days": [],
                        "message": "This trip has not been planned yet."})
    items = itinerary_items(selected)
    return jsonify({
        "itinerary": {"id": selected.get("_id"),
                      "version": selected.get("version"),
                      "totalCost": selected.get("totalCost"),
                      "generatedBy": selected.get("generatedBy"),
                      "planType": selected.get("planType"),
                      "reasoning": selected.get("reasoning") or [],
                      "optimizationScore": selected.get("optimizationScore"),
                      "comfortScore": selected.get("comfortScore"),
                      "travelTime": selected.get("travelTime"),
                      "createdAt": selected.get("createdAt")},
        "items": items,
        "days": group_by_day(items),
    })


@trip_bp.route("/trips/<trip_id>/itinerary/select", methods=["POST"])
@require_auth
def select_itinerary(trip_id):
    """Switch to one of the generated alternatives."""
    data = require_body()
    itinerary_id = require_str(data, "itineraryId", max_length=64)
    trip = gateway.accessible_trip(trip_id, current_user(), write=True)
    target = gateway.select_itinerary(trip, itinerary_id)
    return jsonify({"message": "Itinerary selected.",
                    "itinerary": {"id": target.get("_id"),
                                  "totalCost": target.get("totalCost")}})


# ------------------------------------------------------------ disruption
@trip_bp.route("/trips/<trip_id>/delay", methods=["POST"])
@require_auth
def record_delay(trip_id):
    """Record an active disruption before deciding what to do about it."""
    data = require_body()
    minutes = require_int(data, "minutes", minimum=0, maximum=10080)
    note = optional_str(data, "note", max_length=300, default="")
    trip = gateway.accessible_trip(trip_id, current_user(), write=True)
    delay = gateway.record_delay(trip, minutes, note=note or None)
    return jsonify({"delay": delay,
                    "message": "Delay recorded. Review the re-plan proposal."})


@trip_bp.route("/trips/<trip_id>/delay", methods=["DELETE"])
@require_auth
def clear_delay(trip_id):
    """Withdraw a recorded disruption without re-planning."""
    from mobileapi.serializers import clean
    trip = gateway.accessible_trip(trip_id, current_user(), write=True)
    now = gateway._now()
    gateway.trips().update_one({"_id": trip_id},
                               {"$set": {"delay": {"status": "CLEARED",
                                                   "resolvedAt": now},
                                         "updatedAt": now}})
    return jsonify({"message": "Delay cleared."})


@trip_bp.route("/trips/<trip_id>/replan", methods=["POST"])
@require_auth
def replan_trip(trip_id):
    """Propose (default) or apply (`confirm: true`) a revised itinerary."""
    data = require_body()
    trip = gateway.accessible_trip(trip_id, current_user(), write=True)
    result = gateway.replan(
        trip,
        delay_minutes=optional_int(data, "delayMinutes", minimum=0,
                                   maximum=10080, default=0) or 0,
        reason=optional_str(data, "reason", max_length=60, default="manual"),
        confirm=optional_bool(data, "confirm", False))
    return jsonify(result)


# --------------------------------------------------------- read-only views
@trip_bp.route("/trips/<trip_id>/budget", methods=["GET"])
@require_auth
def trip_budget(trip_id):
    trip = gateway.accessible_trip(trip_id, current_user())
    return jsonify({"budget": gateway.budget_view(trip)})


@trip_bp.route("/trips/<trip_id>/events", methods=["GET"])
@require_auth
def trip_events(trip_id):
    trip = gateway.accessible_trip(trip_id, current_user())
    limit = optional_int({"limit": _arg("limit")}, "limit", minimum=1, maximum=200,
                         default=50)
    return jsonify({"events": gateway.trip_events(trip, limit=limit)})


# ------------------------------------------------------------------ helper
def _arg(name):
    from flask import request
    return request.args.get(name)
