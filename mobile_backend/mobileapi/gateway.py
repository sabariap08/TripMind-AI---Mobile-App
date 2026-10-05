"""Orchestration adapter between the mobile API and the shared services.

This module exists because `Website/backend/routes/__init__.py` cannot be
imported from here. That file is not a library: it is a 4400-line blueprint
module whose module-level code calls `Blueprint()` seventeen times and whose
handlers read Flask's `session` and `request` globals directly. Importing it
would drag the entire web API into the mobile process and couple the two clients
together at the module level, which is exactly the coupling this architecture
exists to avoid.

So the *orchestration logic* is reproduced here against the same service layer.
What is shared, unchanged, is everything that carries behaviour:

    services.travel_orchestrator.generate_travel_plans   the planner
    services.ai_plan_builder                             materialisation
    services.trip_optimizer                              catalogue optimiser
    services.replanner                                   two-phase re-planning
    services.transport_service / hotel_service / ...     the catalogue
    services.mongodb.get_collection                      the database

What is duplicated, and deliberately so, is the thin orchestration shell around
them: which collections are read, what a trip document looks like, and how a
plan becomes persisted itineraries. That shell is data shape, not business
logic, and it is kept here in one readable block rather than spread across route
handlers. If the trip document schema changes, this file and the web route file
are the only two places that need to change.
"""
import uuid
from datetime import datetime

from mobileapi.errors import (AiUnavailableError, ConflictError,
                              ForbiddenError, NotFoundError, ValidationError)
from mobileapi.serializers import clean

from services.auth import is_admin
from services.mongodb import get_collection
from services.travel_orchestrator import generate_travel_plans
from services.transport_service import available_transports
from services.tourist_service import list_spots, list_tours
from services.guide_service import browse_guides
from services.hotel_service import search_hotels


def _now():
    return datetime.utcnow().isoformat()


def trips():
    return get_collection("trips")


def bookings():
    return get_collection("bookings")


# ---------------------------------------------------------------- access
def accessible_trip(trip_id, user, *, write=False):
    """Fetch a trip the user may read (and, when `write`, modify).

    Same rule as the web API: the owner has full access, an admin has read
    access. Admin read is NOT admin write - a moderator must not be able to
    re-plan someone else's trip - so `write=True` refuses non-owners even for
    admins. The web API has no write route for admins at all, so this matches
    rather than extends it.

    A non-owner who is not an admin gets the same 404 as a missing trip, on the
    write path too. A 403 there would confirm that somebody else's trip id
    exists, which turns the endpoint into an id oracle; the distinction between
    "you may not do this" and "there is nothing here" is only ever surfaced to
    a user who genuinely has read access.
    """
    trip = trips().find_one({"_id": trip_id})
    if not trip:
        raise NotFoundError("Trip not found.", code="trip_not_found")
    user_id = str((user or {}).get("id") or "")
    owner = str(trip.get("userId") or "") == user_id and user_id != ""
    if not owner:
        if not is_admin(user):
            raise NotFoundError("Trip not found.", code="trip_not_found")
        if write:
            # An admin can read this trip but must not be able to change it.
            raise ForbiddenError("Admins have read-only access to this trip.",
                                 code="admin_read_only")
    return trip


def list_trips(user, *, limit=50):
    user_id = str((user or {}).get("id") or "")
    if not user_id:
        return []
    cursor = (trips().find({"userId": user_id})
              .sort([("createdAt", -1)])
              .limit(max(1, min(int(limit or 50), 200))))
    return list(cursor)


def ensure_trip_completed(trip):
    """Lazily mark a BOOKED trip COMPLETED once its end date has passed.

    Trip completion is a property of the trip, not of its individual bookings:
    the trip is complete when its last travel day is behind us and it had been
    booked. Replicated from the web route because the mobile trip list would
    otherwise show stale BOOKED trips indefinitely.
    """
    if not trip or trip.get("status") != "BOOKED":
        return trip
    if trip.get("status") == "COMPLETED":
        return trip
    end = str(trip.get("endDate") or "")[:10]
    try:
        done = datetime.strptime(end, "%Y-%m-%d").date() < datetime.utcnow().date()
    except (ValueError, TypeError):
        return trip
    if not done:
        return trip
    now = _now()
    trips().update_one({"_id": trip["_id"]}, {"$set": {
        "status": "COMPLETED", "completedAt": now, "updatedAt": now}})
    trip["status"] = "COMPLETED"
    for booking in trip.get("bookings") or []:
        booking_id = booking.get("_id")
        if not booking_id:
            continue
        try:
            bookings().update_one({"_id": booking_id},
                                   {"$set": {"status": "COMPLETED",
                                             "completedAt": now}})
        except Exception:
            pass
        booking["status"] = "COMPLETED"
    return trip


# ------------------------------------------------------------ catalogue
def gather_db_data(trip):
    """Pull real catalogue data for the trip corridor.

    Identical intent to the web `_gather_db_data`, including the defensive
    try/except per catalogue: a missing hotel partner must degrade the plan,
    never fail the request. That is why the mobile client sees the same plans
    the web client sees for the same corridor.
    """
    origin = str(trip.get("origin") or "")
    destination = str(trip.get("destination") or "")
    data = {}

    try:
        transports = available_transports(origin, destination,
                                          trip.get("transportType"))
        if transports:
            data["transports"] = transports
    except Exception:
        pass

    # CAB/AUTO fare cards (base + per-km + minimum) price the transfer legs from
    # real road distance rather than a flat rate.
    try:
        from services.transport_service import list_transports
        cabs = []
        for service in list_transports(approved_only=True) or []:
            if service.get("type") not in ("CAB", "AUTO"):
                continue
            area = (str(service.get("serviceArea") or "") + " "
                    + str(service.get("baseLocation") or "")).lower()
            if any(city in area for city in (origin.lower(), destination.lower())):
                cabs.append(service)
        if cabs:
            data["cabs"] = cabs
    except Exception:
        pass

    for key, fn in (("spots", lambda: list_spots(city=destination)),
                    ("tours", lambda: list_tours(city=destination)),
                    ("guides", lambda: browse_guides(location=destination)),
                    ("hotels", lambda: search_hotels(city=destination))):
        try:
            found = fn()
            if found:
                data[key] = found
        except Exception:
            pass

    try:
        from services.restaurant_service import list_restaurants, list_food_items
        foods = []
        for restaurant in (list_restaurants(None, city=destination) or [])[:3]:
            items = list_food_items(restaurant["id"], only_available=True)
            if not items:
                continue
            item = items[0]
            foods.append({
                "name": restaurant.get("name", ""),
                "restaurantName": restaurant.get("name", ""),
                "restaurantProvider": restaurant.get("provider") or "TripMind",
                "restaurantImages": restaurant.get("images") or [],
                "restaurantRating": restaurant.get("popularity") or None,
                "restaurantId": restaurant["id"],
                "pricePerPerson": float(item.get("price") or 0),
                "foodId": item.get("id"),
                "foodName": item.get("name", ""),
                "bookableId": "restaurant:%s:%s" % (restaurant["id"],
                                                   item.get("id") or ""),
            })
        if foods:
            data["foods"] = foods
    except Exception:
        pass

    return data


# ------------------------------------------------------------ trip create
def create_trip(user_id, payload):
    """Persist a DRAFT trip document in exactly the web schema.

    Field-for-field identical to the web POST /api/trips document, including
    `budgetUnlimited` being persisted explicitly rather than recomputed on read.
    A trip created in the app must be indistinguishable from one created on the
    web, otherwise the two clients would diverge on the same collection.
    """
    if not user_id:
        raise ForbiddenError("Authentication required. Please sign in.",
                             code="auth_required")

    budget_unlimited = bool(payload.get("budgetUnlimited"))
    budget = 0 if budget_unlimited else int(payload.get("budget") or 0)
    if not budget_unlimited and budget < 1000:
        raise ValidationError("Budget must be at least 1000.",
                              code="budget_too_low")

    return_trip = bool(payload.get("returnTrip"))
    premium_services = [s for s in (payload.get("premiumServices") or [])
                        if s in ("TRANSPORT", "HOTELS", "ACTIVITIES", "GUIDE")]
    now = _now()

    trip = {
        "_id": str(uuid.uuid4()),
        "userId": user_id,
        "origin": payload["origin"],
        "destination": payload["destination"],
        "startLocation": payload.get("startLocation") or None,
        "destinationLocation": None,
        "startDate": payload["startDate"],
        "endDate": payload["endDate"],
        "travelers": int(payload.get("travelers") or 1),
        "budget": budget,
        "budgetUnlimited": budget_unlimited,
        "currency": payload.get("currency", "INR"),
        "travelStyle": payload.get("travelStyle", "BALANCED"),
        "transportType": payload.get("transportType"),
        "servicePreference": payload.get("servicePreference"),
        "preferences": payload.get("preferences") or "",
        "prioritizedSpotIds": [str(s) for s in (payload.get("prioritizedSpotIds") or [])
                               if str(s)],
        "returnTrip": return_trip,
        "premiumServices": premium_services,
        "voice": None,
        "status": "DRAFT",
        "totalEstimatedCost": None,
        "createdAt": now,
        "updatedAt": now,
        "itineraries": [],
        "bookings": [],
        "events": [],
        "recommendations": [],
    }
    if payload.get("foodPreference"):
        trip["foodPreference"] = payload["foodPreference"]
    if payload.get("voiceLanguage") or payload.get("voiceOriginal"):
        trip["voice"] = {
            "language": str(payload.get("voiceLanguage") or "")[:60],
            "original": str(payload.get("voiceOriginal") or "")[:500],
        }
    trips().insert_one(trip)
    return trip


def update_trip(trip, changes):
    """Apply validated field changes to a DRAFT trip."""
    if trip.get("status") not in ("DRAFT",):
        raise ConflictError(
            "This trip has already been planned, so its inputs are locked. "
            "Create a new trip to change the brief.",
            code="trip_locked")
    changes = dict(changes)
    if changes.get("budgetUnlimited"):
        changes["budget"] = 0
    changes["updatedAt"] = _now()
    trips().update_one({"_id": trip["_id"]}, {"$set": changes})
    trip.update(changes)
    return trip


# --------------------------------------------------------------- planning
def _planner_request(trip):
    """Build the planner input from a stored trip document."""
    return {
        "origin": trip.get("origin"),
        "destination": trip.get("destination"),
        "startDate": trip.get("startDate"),
        "endDate": trip.get("endDate"),
        "travelers": trip.get("travelers"),
        "budget": trip.get("budget"),
        "budgetUnlimited": bool(trip.get("budgetUnlimited")),
        "currency": trip.get("currency", "INR"),
        "travelStyle": trip.get("travelStyle", "BALANCED"),
        "foodPreference": trip.get("foodPreference"),
        "transportType": trip.get("transportType"),
        "servicePreference": trip.get("servicePreference"),
        "preferences": trip.get("preferences") or "",
        "prioritizedSpotIds": trip.get("prioritizedSpotIds") or [],
        "startLocation": trip.get("startLocation"),
        "returnTrip": bool(trip.get("returnTrip")),
        "premiumServices": trip.get("premiumServices") or [],
    }


def _materialise_item(item, day, order):
    """Persist one itinerary item with the web app's full field whitelist.

    The operator/images/rating/stars/vehicle/nightLabel fields are populated by
    `ai_plan_builder._materialize`; they must be copied through or the app
    renders a blank card for every activity. Same list, same reasons.
    """
    images = item.get("images") or []
    return {
        "_id": str(uuid.uuid4()),
        "type": item.get("type"),
        "title": item.get("title"),
        "provider": item.get("provider", ""),
        "operator": item.get("operator"),
        "images": images,
        "image": images[0] if images else None,
        "rating": item.get("rating"),
        "stars": item.get("stars"),
        "vehicle": item.get("vehicle"),
        "nightLabel": item.get("nightLabel"),
        "location": item.get("location", ""),
        "startTime": item.get("startTime"),
        "endTime": item.get("endTime"),
        "cost": item.get("cost", 0),
        "currency": "INR",
        "status": item.get("status", "PLANNED"),
        "day": day,
        "sortOrder": order,
        "metadata": None,
        "bookableId": item.get("bookableId"),
        "distanceKm": item.get("distanceKm"),
        "fareError": item.get("fareError"),
    }


def _recommendation_text(plan):
    leg = plan.get("transport")
    if leg:
        reference = (leg.get("busNumber") or leg.get("trainNumber")
                     or leg.get("flightNumber") or leg.get("vehicleNumber"))
        return "Book %s via %s (%s)" % (leg.get("type"),
                                        leg.get("serviceName", ""), reference)
    if plan.get("flight"):
        return "Book %s flight" % plan["flight"].get("airline")
    return "Plan ready - no transport booking recommended."


def _clean_clarifications(raw):
    """Normalise the clarify step's answers into the planner's expected shape.

    `ai_plan_builder._build_prompt` formats each entry as "%s: %s", so an answer
    must render as readable text. A native client sends checkbox questions as a
    list and radio questions as a bare string, and the keys are whatever `id`
    the question carried. Lists are joined into a comma-separated phrase rather
    than str()'d, because "activity_types: ['nature', 'food']" in a prompt
    reads as a programming artefact to the model.

    Anything that is not a short string, or a list of short strings, is dropped
    rather than rejected: these answers only ever make the plan more specific,
    so a malformed one should degrade the prompt, never fail the request the
    traveller has been staring at for a minute.
    """
    if not isinstance(raw, dict):
        return None
    out = {}
    for key, value in raw.items():
        if not isinstance(key, str):
            continue
        label = key.strip()[:60]
        if not label:
            continue
        if isinstance(value, str):
            text = value.strip()[:400]
        elif isinstance(value, list):
            parts = [str(v).strip()[:80] for v in value if isinstance(v, str)]
            text = ", ".join(p for p in parts if p)[:400]
        elif isinstance(value, bool) or isinstance(value, (int, float)):
            text = str(value)[:40]
        else:
            continue
        if text:
            out[label] = text
    return out or None


def generate_plans(trip, clarifications=None):
    """Run the shared planner and persist its itineraries.

    `clarifications` is the answer set from the clarify step, passed straight
    through to `generate_travel_plans`. The web client sends the same body, so
    both clients get an identical prompt for identical answers.

    Returns a JSON-safe result. Raises `AiUnavailableError` when the LLM could
    not be reached, and returns `selectedPlan: None` (HTTP 200) when the corridor
    genuinely has no registered services. The two are deliberately distinct so
    the app can offer "retry" for one and "no inventory here" for the other.
    """
    request_data = _planner_request(trip)
    db_data = gather_db_data(trip)

    result = generate_travel_plans(request_data, db_data,
                                   _clean_clarifications(clarifications))
    selected = result.get("selectedPlan")
    now = _now()

    if not selected:
        if result.get("source") == "ai_unavailable":
            raise AiUnavailableError(
                result.get("aiExplanation")
                or "The AI planner did not return plans. Please try again.",
                details={"tripId": trip.get("_id")})

        trips().update_one({"_id": trip["_id"]},
                           {"$set": {"itineraries": [], "recommendations": [],
                                     "updatedAt": now}})
        return {
            "selectedPlan": None,
            "plans": [],
            "aiExplanation": result.get("aiExplanation"),
            "source": "empty",
            "retryable": False,
            "message": ("No registered services found for this route yet. "
                        "Ask a transport or hotel provider to register services "
                        "for this route, then generate the plan again."),
        }

    itineraries = []
    for index, plan in enumerate(result["plans"]):
        items = []
        for day_plan in plan.get("dailyPlan", []):
            for order, item in enumerate(day_plan.get("items", [])):
                items.append(_materialise_item(item, day_plan["day"], order))
        itineraries.append({
            "_id": str(uuid.uuid4()),
            "tripId": trip["_id"],
            "version": 1,
            "status": "SELECTED" if index == 0 else "AVAILABLE",
            "totalCost": plan["totalCost"],
            "generatedBy": "AI",
            "planType": plan["planType"],
            "reasoning": plan.get("reasoning", []),
            "createdAt": now,
            "items": items,
            "optimizationScore": plan.get("optimizationScore", 0),
            "comfortScore": plan.get("comfortScore", 0),
            "travelTime": plan.get("travelTime", "N/A"),
        })

    selected_itin = itineraries[0]
    recommendation = {
        "_id": str(uuid.uuid4()),
        "tripId": trip["_id"],
        "category": "TRANSPORT" if selected.get("transport") else "FLIGHT",
        "recommendation": _recommendation_text(selected),
        "reasoning": result.get("aiExplanation"),
        "estimatedCost": (selected.get("flight", {}).get("price")
                          or (selected.get("transport") or {}).get("fare")),
        "confidence": selected.get("optimizationScore", 0.8),
        "createdAt": now,
    }

    trips().update_one({"_id": trip["_id"]}, {"$set": {
        "totalEstimatedCost": selected["totalCost"],
        "status": "PLANNED",
        "updatedAt": now,
        "itineraries": itineraries,
        "recommendations": [recommendation],
    }})

    # Feed the shared reinforcement learner. Best-effort: the plan is already
    # saved, and a failure here must not turn a successful plan into an error.
    try:
        from services.ml.injector import reinforce_cost, reinforce_timing
        reinforce_cost(trip, selected["totalCost"])
        for day_plan in selected.get("dailyPlan", []):
            for item in day_plan.get("items", []):
                reinforce_timing(item.get("type"), item.get("startTime"),
                                 item.get("endTime"))
    except Exception:
        pass

    return {
        "selectedPlan": selected,
        "plans": result["plans"],
        "aiExplanation": result.get("aiExplanation"),
        "ml": result.get("ml", {}),
        "source": result.get("source", "mock"),
        "itineraries": itineraries,
        "selectedItineraryId": selected_itin["_id"],
    }


def select_itinerary(trip, itinerary_id):
    """Promote one of the generated alternatives to SELECTED."""
    itineraries = list(trip.get("itineraries") or [])
    target = next((i for i in itineraries if i.get("_id") == itinerary_id), None)
    if target is None:
        raise NotFoundError("Itinerary not found.", code="itinerary_not_found")
    for itin in itineraries:
        itin["status"] = "SELECTED" if itin.get("_id") == itinerary_id else "AVAILABLE"
    trips().update_one({"_id": trip["_id"]},
                       {"$set": {"itineraries": itineraries, "updatedAt": _now()}})
    return target


# -------------------------------------------------------------- replanning
def replan(trip, *, delay_minutes=0, reason=None, confirm=False):
    """Two-phase re-planning: propose, then apply.

    Phase one (`confirm=False`) returns the revised items, a diff, the real cost
    impact and warnings without writing anything. Phase two writes. Replanning
    rewrites the plan the user is looking at, so it never happens behind their
    back - which is also why the mobile app shows the cost delta and waits.
    """
    from services import replanner

    selected = next((i for i in trip.get("itineraries") or []
                     if i.get("status") == "SELECTED"), None)
    if not selected:
        raise ValidationError("Generate a plan before re-planning this trip.",
                              code="no_selected_itinerary")

    active_delay = (trip.get("delay") or {}).get("status") == "ACTIVE"
    if not delay_minutes and active_delay:
        delay_minutes = int((trip.get("delay") or {}).get("minutes") or 0)
    effective_reason = "delay" if delay_minutes else (reason or "manual")

    try:
        proposal = replanner.build_proposal(trip, selected,
                                            delay_minutes=delay_minutes,
                                            reason=effective_reason)
    except replanner.ReplanError as exc:
        raise ValidationError(str(exc), code="replan_rejected")

    if not confirm:
        return {
            "proposal": True,
            "summary": proposal["summary"],
            "changes": proposal["changes"],
            "dropped": proposal["dropped"],
            "warnings": proposal["warnings"],
            "cost": proposal["cost"],
            "diff": replanner.diff_counts(proposal["changes"]),
            "items": proposal["items"],
            "delayMinutes": delay_minutes,
        }

    now = _now()
    version = max((i.get("version", 0) for i in trip.get("itineraries") or []),
                  default=0) + 1

    new_itin = {
        "_id": str(uuid.uuid4()),
        "tripId": trip["_id"],
        "version": version,
        "status": "SELECTED",
        "totalCost": proposal["cost"]["revised"],
        "generatedBy": "REPLAN",
        "planType": selected.get("planType", "BALANCED"),
        "reasoning": list(selected.get("reasoning") or []) + [proposal["summary"]],
        "createdAt": now,
        "items": proposal["items"],
        "optimizationScore": selected.get("optimizationScore", 0),
        "comfortScore": selected.get("comfortScore", 0),
        "travelTime": selected.get("travelTime", "N/A"),
        "replannedFromVersion": selected.get("version"),
        "replanReason": effective_reason,
    }

    updated = []
    for itin in trip.get("itineraries") or []:
        if itin.get("status") == "SELECTED":
            itin["status"] = "SUPERSEDED"
        updated.append(itin)
    updated.append(new_itin)

    # Clear the delay markers the replan resolves, on both the embedded copy and
    # the canonical bookings collection, or the app keeps showing a stale
    # "delayed" badge on a trip that has already been re-planned.
    trip_bookings = []
    for booking in trip.get("bookings") or []:
        booking.pop("delayStatus", None)
        booking.pop("delay", None)
        trip_bookings.append(booking)
        if booking.get("_id"):
            try:
                bookings().update_one({"_id": booking["_id"]},
                                      {"$unset": {"delayStatus": "", "delay": ""}})
            except Exception:
                pass

    delay_doc = dict(trip.get("delay") or {})
    delay_doc.update({"status": "RESOLVED", "resolvedAt": now})

    replan_rec = {
        "_id": str(uuid.uuid4()),
        "tripId": trip["_id"],
        "category": "REPLANNING",
        "recommendation": proposal["summary"],
        "reasoning": ("; ".join([c.get("reason") for c in proposal["changes"][:5]
                                 if c.get("reason")]) or proposal["summary"]),
        "estimatedCost": proposal["cost"]["additional"],
        "confidence": 1.0,
        "createdAt": now,
    }

    trips().update_one({"_id": trip["_id"]}, {
        "$set": {
            "status": "PLANNED",
            "totalEstimatedCost": proposal["cost"]["revised"],
            "updatedAt": now,
            "itineraries": updated,
            "bookings": trip_bookings,
            "delay": delay_doc,
        },
        "$push": {
            "recommendations": replan_rec,
            "events": {"_id": str(uuid.uuid4()), "tripId": trip["_id"],
                       "type": "DELAY_RESOLVED", "title": "Replanned after delay",
                       "description": proposal["summary"], "severity": "LOW",
                       "occurredAt": now},
        }})

    additional = proposal["cost"]["additional"]
    if additional > 0:
        cost_note = "Costs increase by INR %.2f." % additional
    elif additional < 0:
        cost_note = "Costs decrease by INR %.2f." % abs(additional)
    else:
        cost_note = "Total cost is unchanged."

    return {
        "confirmed": True,
        "version": version,
        "itineraryId": new_itin["_id"],
        "items": proposal["items"],
        "changes": proposal["changes"],
        "dropped": proposal["dropped"],
        "warnings": proposal["warnings"],
        "diff": replanner.diff_counts(proposal["changes"]),
        "originalCost": proposal["cost"]["original"],
        "revisedCost": proposal["cost"]["revised"],
        "additionalCost": additional,
        "allCostsVerified": proposal["cost"]["allCostsVerified"],
        "explanation": "%s %s" % (proposal["summary"], cost_note),
    }


def record_delay(trip, minutes, *, note=None):
    """Record an active disruption against the trip and its bookings.

    Separate from `replan` on purpose: the delay is a fact about the world, the
    re-plan is a decision about what to do about it. The app records the delay
    first (from a push, a delay prediction or the user), then proposes.
    """
    if minutes < 0:
        raise ValidationError("Delay minutes cannot be negative.",
                              code="delay_negative")
    now = _now()
    delay = {
        "minutes": int(minutes),
        "status": "ACTIVE",
        "reason": (note or "Service disruption"),
        "recordedAt": now,
    }
    trips().update_one({"_id": trip["_id"]},
                       {"$set": {"delay": delay, "updatedAt": now},
                        "$push": {"events": {
                            "_id": str(uuid.uuid4()), "tripId": trip["_id"],
                            "type": "DELAY_RECORDED",
                            "title": "Delay reported (%d min)" % int(minutes),
                            "description": note or "Service disruption",
                            "severity": "MEDIUM" if minutes >= 60 else "LOW",
                            "occurredAt": now}}})
    trip["delay"] = delay
    return delay


# ------------------------------------------------------------- budget view
def budget_view(trip):
    """Planned / booked / remaining for one trip.

    Every money field is a number or null, where null means "not known" and
    never zero. Unpriced items are counted separately so a total that quietly
    omits them cannot be mistaken for a complete one.
    """
    from services.budget import build_budget_view, is_unlimited
    trip_bookings = list(bookings().find({"tripId": trip["_id"]}))
    view = build_budget_view(trip, trip_bookings)
    view["budgetUnlimited"] = is_unlimited(trip)
    return view


def trip_events(trip, *, limit=50):
    """Timeline for the trip screen, newest first.

    Uses `clean_list`, not `clean`: `clean` expects a single document and calls
    `.items()` on it, so passing a list raised AttributeError and the endpoint
    answered 500 on every request.
    """
    from mobileapi.serializers import clean_list
    events = list(trip.get("events") or [])
    events.sort(key=lambda e: str(e.get("occurredAt") or ""), reverse=True)
    capped = max(1, min(int(limit or 50), 200))
    return clean_list(events[:capped])
