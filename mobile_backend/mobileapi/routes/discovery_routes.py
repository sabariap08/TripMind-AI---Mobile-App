"""Read-only catalogue browsing for the mobile search screens.

These are the endpoints behind the trip planner's "what's available on this
route" lookups: transport on a corridor, spots in a city, hotels, restaurants,
guides, tours.

Everything is public - no session, no token - because browsing a catalogue does
not require an account, and making the app sign in before it can show a price
is a good way to lose someone in the first ten seconds. Provider listings still
respect the approval gate inside the shared services, so a pending partner's
inventory is not visible here either.
"""
from flask import Blueprint, jsonify, request

from mobileapi.errors import ValidationError
from mobileapi.serializers import clean, clean_list
from mobileapi.validators import optional_int

discovery_bp = Blueprint("mobile_discovery", __name__)


def _city(field="city"):
    return (request.args.get(field) or "").strip()[:120]


def _limit(default=40, maximum=100):
    return optional_int({"n": request.args.get("limit")}, "n", minimum=1,
                        maximum=maximum, default=default)


@discovery_bp.route("/catalogue/transport", methods=["GET"])
def transports():
    """Available transport for a corridor, with an honest match caveat.

    With no corridor, returns the approved catalogue so the app can offer
    origin/destination suggestions.

    `with_detail=True` is used deliberately. Without it the service silently
    falls back to "destination-only" matching, which means a KPR traveller can
    be shown a Coimbatore->Chennai train that does not actually board them, with
    nothing in the payload to say so. The detail form carries `matchQuality` and
    `matchNote` per document, so the app can render "Departs Coimbatore, not KPR"
    instead of quietly selling the wrong ticket.
    """
    from services.transport_service import (available_transports,
                                           list_transports)

    origin = _city("origin")
    destination = _city("destination")
    ttype = (request.args.get("type") or "").strip().upper() or None

    if origin and destination:
        rows = available_transports(origin, destination, ttype,
                                    with_detail=True) or []
        return jsonify({"origin": origin, "destination": destination,
                        "matchQuality": rows[0].get("matchQuality")
                        if rows else None,
                        "transports": clean_list(rows,
                                                 drop=("operatorDetails",))})
    rows = list_transports(approved_only=True) or []
    if ttype:
        rows = [t for t in rows if t.get("type") == ttype]
    return jsonify({"transports": clean_list(rows[:_limit()],
                                             drop=("operatorDetails",))})


@discovery_bp.route("/catalogue/cities", methods=["GET"])
def cities():
    """Origin/destination pairs the platform can genuinely plan.

    Better than a static list on a phone: every option offered is a corridor
    with real approved inventory, so the app cannot talk a user into a request
    that is certain to come back empty.

    The station fields differ per transport type (`boardingStation` for trains,
    `boardingPoint` for buses, `departureAirport` for flights), so the real
    `_corridor` helper is reused rather than reimplementing the mapping here and
    getting it wrong for one mode.
    """
    from services.transport_service import _corridor, list_transports

    pairs = {}
    for service in list_transports(approved_only=True) or []:
        corridor = _corridor(service)
        if len(corridor) < 2:
            continue
        origin, destination = str(corridor[0]).strip(), str(corridor[1]).strip()
        if not origin or not destination:
            continue
        key = (origin.lower(), destination.lower())
        entry = pairs.setdefault(key, {"origin": origin, "destination": destination,
                                       "types": set()})
        if service.get("type"):
            entry["types"].add(service["type"])

    corridors = [{"origin": e["origin"], "destination": e["destination"],
                  "types": sorted(e["types"])}
                 for e in sorted(pairs.values(),
                                 key=lambda x: (x["origin"], x["destination"]))]
    cities_only = sorted({c for pair in corridors
                          for c in (pair["origin"], pair["destination"])},
                         key=str.lower)
    return jsonify({"cities": cities_only, "corridors": corridors})


@discovery_bp.route("/catalogue/spots", methods=["GET"])
def spots():
    from services.tourist_service import list_spots
    rows = list_spots(city=_city() or None) or []
    return jsonify({"spots": clean_list(rows[:_limit()])})


@discovery_bp.route("/catalogue/tours", methods=["GET"])
def tours():
    from services.tourist_service import list_tours
    rows = list_tours(city=_city() or None) or []
    return jsonify({"tours": clean_list(rows[:_limit()])})


@discovery_bp.route("/catalogue/guides", methods=["GET"])
def guides():
    from services.guide_service import browse_guides
    rows = browse_guides(location=_city() or None) or []
    return jsonify({"guides": clean_list(rows[:_limit()],
                                         drop=("identityNumber", "documents"))})


@discovery_bp.route("/catalogue/hotels", methods=["GET"])
def hotels():
    from services.hotel_service import search_hotels
    rows = search_hotels(city=_city() or None) or []
    return jsonify({"hotels": clean_list(rows[:_limit()])})


@discovery_bp.route("/catalogue/restaurants", methods=["GET"])
def restaurants():
    from services.restaurant_service import list_restaurants
    rows = list_restaurants(None, city=_city() or None) or []
    return jsonify({"restaurants": clean_list(rows[:_limit()],
                                             drop=("gstNumber", "documents"))})


@discovery_bp.route("/catalogue/restaurants/<restaurant_id>/menu", methods=["GET"])
def menu(restaurant_id):
    from services.restaurant_service import list_food_items
    rows = list_food_items(restaurant_id, only_available=True) or []
    return jsonify({"restaurantId": restaurant_id, "items": clean_list(rows[:_limit()])})


@discovery_bp.route("/places/distance", methods=["GET"])
def distance():
    """Real driving distance between two points, coordinates or addresses.

    This is the endpoint behind "your pickup is 42 km from the boarding point".
    It calls `services.maps_distance.route_distance_km`, which consults the
    Google Routes API first and falls back to haversine on the coordinates, so
    the app gets a road distance rather than a straight line and degrades
    gracefully when Maps is unconfigured.

    There is no server-side place autocomplete on this platform: the app
    reverse-geocodes the handset's own GPS fix on-device, which is both faster
    and one less network round trip on a weak connection.
    """
    from services import maps_distance

    origin = _city("origin")
    destination = _city("destination")

    def _coord(a, b):
        try:
            lat = float(request.args.get(a)) if request.args.get(a) else None
            lng = float(request.args.get(b)) if request.args.get(b) else None
        except (TypeError, ValueError):
            raise ValidationError("Coordinates must be numbers.",
                                  code="coordinate_invalid")
        return lat, lng

    origin_lat, origin_lng = _coord("originLat", "originLng")
    dest_lat, dest_lng = _coord("destLat", "destLng")

    if not origin and origin_lat is None:
        raise ValidationError("Supply an origin address or coordinates.",
                              code="origin_required")
    if not destination and dest_lat is None:
        raise ValidationError("Supply a destination address or coordinates.",
                              code="destination_required")

    km = maps_distance.route_distance_km(
        origin or None, destination or None,
        origin_lat, origin_lng, dest_lat, dest_lng,
        label="mobile:%s->%s" % (origin or "gps", destination or "gps"),
        log=False)

    if km is None:
        return jsonify({"distanceKm": None, "source": None,
                        "mapsEnabled": _maps_enabled(),
                        "message": "No road distance available for these points."})

    return jsonify({
        "distanceKm": round(float(km), 2),
        # Indicative only: the platform has no live traffic feed, so this is a
        # planning estimate and the app labels it as such.
        "estimatedMinutes": int(round(float(km) / 32.0 * 60)),
        "source": "google" if _maps_enabled() else "haversine",
        "mapsEnabled": _maps_enabled(),
    })


def _maps_enabled():
    try:
        import config as web_config
        return bool(web_config.MAPS_ENABLED)
    except Exception:
        return False


@discovery_bp.route("/health", methods=["GET"])
def health():
    """Liveness plus a real database round trip.

    Reported separately from liveness because "the process is up" and "the
    database is reachable" fail independently, and a demo on hotel wifi needs
    to tell them apart in one glance.
    """
    from mobileapi import config

    database = "unknown"
    try:
        from services.mongodb import get_collection
        get_collection("users").estimated_document_count()
        database = "ok"
    except Exception:
        database = "unreachable"

    return jsonify({
        "service": "tripmind-mobile-api",
        "version": "1.0.0",
        "status": "ok" if database == "ok" else "degraded",
        "database": database,
        "jwtSecretSource": config.JWT_SECRET_SOURCE,
        "jwtSecretEphemeral": config.JWT_SECRET_IS_EPHEMERAL,
    })
