"""Request validation for the mobile API.

Every mobile endpoint validates before it touches a service. The shared web
routes mostly trust their caller (the browser) to send well-formed JSON; a
native client on a flaky connection can send truncated bodies, stale payloads
from a cached screen, or a date picker value in the wrong format, so the checks
are explicit here.
"""
import datetime as _dt

from mobileapi.errors import ValidationError

TRIP_STATUSES = {"PLANNED", "REPLANNING", "CONFIRMED", "COMPLETED", "CANCELLED"}
TRANSPORT_TYPES = {"BUS", "TRAIN", "FLIGHT", "CAB", "AUTO", "MIXED", None}
PREMIUM_SERVICES = {"TRANSPORT", "HOTELS", "ACTIVITIES", "GUIDE"}


def require_body():
    """Return the JSON body or fail. Never returns None."""
    from flask import request
    data = request.get_json(silent=True)
    if data is None:
        raise ValidationError("A JSON request body is required.",
                              code="body_required")
    if not isinstance(data, dict):
        raise ValidationError("The request body must be a JSON object.",
                              code="body_not_object")
    return data


def require_str(data, field, *, max_length=400, min_length=1):
    value = data.get(field)
    if not isinstance(value, str):
        raise ValidationError("'%s' must be text." % field,
                              code="field_invalid", details={"field": field})
    value = value.strip()
    if len(value) < min_length:
        raise ValidationError("'%s' is required." % field,
                              code="field_required", details={"field": field})
    if len(value) > max_length:
        raise ValidationError("'%s' is too long (max %d characters)."
                              % (field, max_length),
                              code="field_too_long", details={"field": field})
    return value


def optional_str(data, field, *, max_length=400, default=None):
    value = data.get(field, default)
    if value is None:
        return default
    if not isinstance(value, str):
        raise ValidationError("'%s' must be text." % field,
                              code="field_invalid", details={"field": field})
    value = value.strip()
    if not value:
        return default
    return value[:max_length]


def require_int(data, field, *, minimum=None, maximum=None, default=None):
    raw = data.get(field, default)
    if raw is None or raw == "":
        raise ValidationError("'%s' is required." % field,
                              code="field_required", details={"field": field})
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ValidationError("'%s' must be a whole number." % field,
                              code="field_invalid", details={"field": field})
    if minimum is not None and value < minimum:
        raise ValidationError("'%s' must be at least %s." % (field, minimum),
                              code="field_out_of_range", details={"field": field})
    if maximum is not None and value > maximum:
        raise ValidationError("'%s' must be at most %s." % (field, maximum),
                              code="field_out_of_range", details={"field": field})
    return value


def optional_int(data, field, *, minimum=None, maximum=None, default=None):
    if data.get(field) is None:
        return default
    return require_int(data, field, minimum=minimum, maximum=maximum, default=default)


def parse_date(value, field, *, required=True):
    """Accept an ISO date or datetime string and return a naive datetime.

    Naive is deliberate: the shared planner does naive arithmetic on these
    values, and mixing an aware datetime into it raises TypeError deep inside
    the prompt builder, which surfaces as "the plan could not be materialised".
    """
    if isinstance(value, _dt.datetime):
        return value.replace(tzinfo=None)
    if not isinstance(value, str) or not value.strip():
        if required:
            raise ValidationError("'%s' is required." % field,
                                  code="field_required", details={"field": field})
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = _dt.datetime.fromisoformat(text)
    except ValueError:
        raise ValidationError(
            "'%s' must be an ISO date, for example 2026-09-30." % field,
            code="field_invalid_date", details={"field": field})
    return parsed.replace(tzinfo=None)


def require_date_range(data, start_field="startDate", end_field="endDate"):
    start = parse_date(data.get(start_field), start_field)
    end = parse_date(data.get(end_field), end_field)
    if end < start:
        raise ValidationError("The end date cannot be before the start date.",
                              code="date_range_invalid")
    if (end - start).days > 120:
        raise ValidationError("A single trip cannot span more than 120 days.",
                              code="date_range_too_long")
    return start, end


def optional_bool(data, field, default=False):
    raw = data.get(field, default)
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        low = raw.strip().lower()
        if low in ("true", "1", "yes"):
            return True
        if low in ("false", "0", "no", ""):
            return False
    if isinstance(raw, (int, float)):
        return bool(raw)
    return default


def string_list(data, field, *, allowed=None, max_items=40, max_length=80):
    """Coerce a value to a clean list of short strings, enforcing `allowed`."""
    raw = data.get(field) or []
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        raise ValidationError("'%s' must be a list." % field,
                              code="field_invalid", details={"field": field})
    if len(raw) > max_items:
        raise ValidationError("'%s' accepts at most %d entries." % (field, max_items),
                              code="too_many_items", details={"field": field})
    out = []
    for entry in raw:
        if not isinstance(entry, str):
            continue
        entry = entry.strip()[:max_length]
        if not entry:
            continue
        if allowed is not None and entry not in allowed:
            raise ValidationError(
                "'%s' contains an unsupported value: %s" % (field, entry),
                code="value_not_allowed",
                details={"field": field, "value": entry,
                         "allowed": sorted(allowed)})
        out.append(entry)
    return out


def validate_trip_payload(data, *, partial=False):
    """Validate the create/update trip body.

    Field names and permitted values are exactly those the shared planner
    understands (see services.travel_orchestrator.parse_trip_request), so the
    mobile form cannot submit something the planner will silently ignore.
    """
    out = {}
    has_any = False

    if not partial or "origin" in data:
        out["origin"] = require_str(data, "origin", max_length=120)
        has_any = True
    if not partial or "destination" in data:
        out["destination"] = require_str(data, "destination", max_length=120)
        has_any = True

    if "startDate" in data or "endDate" in data or not partial:
        start, end = require_date_range(data)
        out["startDate"] = start.isoformat()
        out["endDate"] = end.isoformat()
        has_any = True

    if "travelers" in data or not partial:
        out["travelers"] = require_int(data, "travelers", minimum=1, maximum=60,
                                       default=1)
        has_any = True

    if not partial or "budgetUnlimited" in data:
        out["budgetUnlimited"] = optional_bool(data, "budgetUnlimited", False)
    if not partial or "budget" in data:
        out["budget"] = optional_int(data, "budget", minimum=0, maximum=100_000_000,
                                     default=None)
    if out.get("budgetUnlimited"):
        out["budget"] = 0
    if "budget" in out and out["budget"] is None and not out.get("budgetUnlimited"):
        out["budget"] = 50000

    if not partial or "travelStyle" in data:
        style = optional_str(data, "travelStyle", max_length=40, default="BALANCED")
        out["travelStyle"] = (style or "BALANCED").upper()

    if "transportType" in data or not partial:
        ttype = optional_str(data, "transportType", max_length=20)
        ttype = ttype.upper() if ttype else None
        if ttype not in TRANSPORT_TYPES:
            raise ValidationError("Unsupported transport type.",
                                  code="value_not_allowed",
                                  details={"field": "transportType",
                                           "allowed": sorted(t for t in TRANSPORT_TYPES if t)})
        out["transportType"] = ttype

    if "servicePreference" in data or not partial:
        out["servicePreference"] = optional_str(data, "servicePreference",
                                                 max_length=40)
    if "foodPreference" in data or not partial:
        out["foodPreference"] = optional_str(data, "foodPreference", max_length=80)
    if "preferences" in data or not partial:
        out["preferences"] = optional_str(data, "preferences", max_length=2000,
                                           default="")
    if "returnTrip" in data or not partial:
        out["returnTrip"] = optional_bool(data, "returnTrip", False)
    if "premiumServices" in data or not partial:
        out["premiumServices"] = string_list(data, "premiumServices",
                                             allowed=PREMIUM_SERVICES, max_items=4)
    if "prioritizedSpotIds" in data or not partial:
        out["prioritizedSpotIds"] = string_list(data, "prioritizedSpotIds",
                                                max_items=20, max_length=64)
    if "startLocation" in data or not partial:
        loc = data.get("startLocation")
        if loc is None:
            out["startLocation"] = None
        elif isinstance(loc, dict):
            out["startLocation"] = {
                "lat": loc.get("lat"), "lng": loc.get("lng"),
                "address": optional_str(loc, "address", max_length=200, default=""),
            }
        else:
            raise ValidationError("'startLocation' must be an object.",
                                  code="field_invalid",
                                  details={"field": "startLocation"})
    if "currency" in data:
        out["currency"] = (optional_str(data, "currency", max_length=8,
                                        default="INR") or "INR").upper()

    if partial and not has_any:
        raise ValidationError("No valid fields were supplied.", code="nothing_to_update")
    return out


def validate_registration(data):
    """Validate a traveller registration body against the shared rules."""
    name = require_str(data, "name", max_length=80)
    email = require_str(data, "email", max_length=160)
    password = data.get("password")
    if not isinstance(password, str) or len(password) < 8:
        raise ValidationError("Password must be at least 8 characters.",
                              code="weak_password")
    if len(password) > 200:
        raise ValidationError("Password is too long.", code="password_too_long")
    if "@" not in email or "." not in email.split("@")[-1]:
        raise ValidationError("Enter a valid email address.", code="email_invalid")

    out = {"name": name, "email": email, "password": password}
    mobile = optional_str(data, "mobile", max_length=20)
    if mobile:
        digits = "".join(ch for ch in mobile if ch.isdigit())
        if len(digits) != 10:
            raise ValidationError("Enter a 10-digit mobile number.",
                                  code="mobile_invalid")
        out["mobile"] = digits

    identity_type = optional_str(data, "identityType", max_length=40)
    identity_number = optional_str(data, "identityNumber", max_length=60)
    if identity_type or identity_number:
        if not (identity_type and identity_number):
            raise ValidationError(
                "Provide both the identity document type and its number.",
                code="identity_incomplete")
        out["identityType"] = identity_type
        out["identityNumber"] = identity_number

    gst = optional_str(data, "gst", max_length=20)
    if gst:
        out["gst"] = gst

    prefs = data.get("preferences")
    if prefs is not None:
        if not isinstance(prefs, dict):
            raise ValidationError("'preferences' must be an object.",
                                  code="field_invalid")
        out["preferences"] = prefs
    return out
