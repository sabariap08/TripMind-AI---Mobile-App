"""Mongo document -> mobile JSON shapes.

The web client receives whole Mongo documents and renders them in the browser.
A native client wants a stable, narrow contract, and PyMongo returns types
that are not JSON serialisable (ObjectId, datetime, Decimal128). Everything the
mobile API returns therefore passes through here, which also guarantees no
document can leak a field the API did not intend to expose - notably
`passwordHash`, which is never in a `_public_user` payload but would be a real
leak if a raw document were ever passed through by accident.
"""
import datetime as _dt

from bson import ObjectId
from bson.decimal128 import Decimal128

# Never serialised from a raw document under any circumstance.
_FORBIDDEN = frozenset({
    "passwordHash", "secret", "token", "apiKey", "identityNumberRaw",
})


def jsonify_value(value):
    """Convert one Mongo value into something jsonify can encode."""
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, _dt.datetime):
        return value.isoformat()
    if isinstance(value, _dt.date):
        return value.isoformat()
    if isinstance(value, Decimal128):
        return float(value.to_decimal())
    if isinstance(value, dict):
        return {k: jsonify_value(v) for k, v in value.items() if k not in _FORBIDDEN}
    if isinstance(value, (list, tuple)):
        return [jsonify_value(v) for v in value]
    return value


def clean(doc, drop=()):
    """Serialise a document, dropping `drop` keys and any forbidden field."""
    if not doc:
        return None
    forbidden = _FORBIDDEN.union(drop)
    return {k: jsonify_value(v) for k, v in doc.items() if k not in forbidden}


def clean_list(docs, drop=()):
    return [clean(d, drop) for d in (docs or []) if d]


# ------------------------------------------------------------------ trips
def trip_summary(trip):
    """Compact form for list screens: no itineraries, no bookings."""
    if not trip:
        return None
    selected = next((i for i in trip.get("itineraries") or []
                     if i.get("status") == "SELECTED"), None)
    delay = trip.get("delay") or {}
    return clean({
        "id": trip.get("_id"),
        "origin": trip.get("origin"),
        "destination": trip.get("destination"),
        "startDate": trip.get("startDate"),
        "endDate": trip.get("endDate"),
        "travelers": trip.get("travelers"),
        "budget": trip.get("budget"),
        "budgetUnlimited": trip.get("budgetUnlimited"),
        "currency": trip.get("currency", "INR"),
        "status": trip.get("status"),
        "totalEstimatedCost": trip.get("totalEstimatedCost"),
        "travelStyle": trip.get("travelStyle"),
        "createdAt": trip.get("createdAt"),
        "itineraryCount": len(trip.get("itineraries") or []),
        "hasSelectedItinerary": bool(selected),
        "bookingCount": len(trip.get("bookings") or []),
        "activeDelay": (delay.get("status") == "ACTIVE") or None,
        "delayMinutes": delay.get("minutes"),
        "eventCount": len(trip.get("events") or []),
    })


def trip_detail(trip):
    """Full form for the trip screen, including the selected itinerary."""
    if not trip:
        return None
    body = trip_summary(trip)
    selected = next((i for i in trip.get("itineraries") or []
                     if i.get("status") == "SELECTED"), None)
    body["preferences"] = trip.get("preferences")
    body["foodPreference"] = trip.get("foodPreference")
    body["transportType"] = trip.get("transportType")
    body["servicePreference"] = trip.get("servicePreference")
    body["returnTrip"] = trip.get("returnTrip")
    body["premiumServices"] = trip.get("premiumServices") or []
    body["prioritizedSpotIds"] = trip.get("prioritizedSpotIds") or []
    body["itinerary"] = clean(selected)
    body["itineraries"] = [clean({
        "id": i.get("_id"),
        "version": i.get("version"),
        "status": i.get("status"),
        "totalCost": i.get("totalCost"),
        "generatedBy": i.get("generatedBy"),
        "planType": i.get("planType"),
        "itemCount": len(i.get("items") or []),
        "createdAt": i.get("createdAt"),
        "replanReason": i.get("replanReason"),
    }) for i in trip.get("itineraries") or []]
    body["recommendations"] = clean_list(trip.get("recommendations"))
    body["events"] = clean_list((trip.get("events") or [])[-20:])
    return body


def itinerary_items(itinerary):
    """Itinerary items as an ordered list ready for a day-grouped list view."""
    if not itinerary:
        return []
    items = sorted(itinerary.get("items") or [],
                   key=lambda i: (i.get("day", 1), i.get("sortOrder", 0)))
    return clean_list(items)


def group_by_day(items):
    """[{day, dateLabel, items, totalCost}] from a flat item list."""
    days = []
    index = {}
    for item in items:
        day = item.get("day", 1)
        if day not in index:
            index[day] = {"day": day, "items": [], "totalCost": 0}
            days.append(index[day])
        index[day]["items"].append(item)
        try:
            index[day]["totalCost"] += float(item.get("cost") or 0)
        except (TypeError, ValueError):
            pass
    return days


# ---------------------------------------------------------------- bookings
def booking_summary(booking):
    """Compact form for the bookings list and booking detail.

    The stored document calls the amount `total`, not `cost` - booking_service
    writes `total`/`unitPrice`/`qty`. Renaming it here to `cost` keeps one
    vocabulary across the API for the client, and means a client bug cannot be
    blamed on the service. `cost` therefore falls back through `total` and only
    then to `None`, so an unpriced booking stays "not known" instead of 0.
    """
    if not booking:
        return None
    cost = booking.get("total")
    if cost is None:
        cost = booking.get("cost")
    return clean({
        "id": booking.get("_id"),
        "reference": booking.get("reference"),
        "tripId": booking.get("tripId"),
        "type": booking.get("type"),
        "status": booking.get("status"),
        "cost": cost,
        "currency": booking.get("currency", "INR"),
        "qty": booking.get("qty"),
        "unitPrice": booking.get("unitPrice"),
        "date": booking.get("date"),
        "paymentStatus": booking.get("paymentStatus"),
        "walletPaid": booking.get("walletPaid"),
        "provider": booking.get("provider"),
        "serviceId": booking.get("serviceId"),
        "routeLabel": booking.get("routeLabel"),
        "delayStatus": booking.get("delayStatus"),
        "delay": booking.get("delay"),
        "createdAt": booking.get("createdAt"),
    })


# ------------------------------------------------------------------ wallet
def wallet_summary(wallet):
    """Wallet balance plus the transaction ledger.

    The ledger is the last 50 entries, oldest-first within the slice so the
    client renders it as a list without re-sorting. `totalDeposited` and
    `totalSpent` come from the wallet document itself rather than being summed
    from the truncated slice - a partial sum would understate both.
    """
    if not wallet:
        return {"balance": 0, "currency": "INR", "transactions": [],
                "totalDeposited": 0, "totalSpent": 0}
    txs = wallet.get("transactions") or wallet.get("history") or []
    return clean({
        "userId": wallet.get("userId"),
        "balance": wallet.get("balance", 0),
        "currency": wallet.get("currency", "INR"),
        "totalDeposited": wallet.get("totalDeposited", 0),
        "totalSpent": wallet.get("totalSpent", 0),
        "updatedAt": wallet.get("updatedAt"),
        "transactions": clean_list(txs[-50:]),
    })
