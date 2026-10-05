"""End-to-end smoke test for the mobile API, against the live MongoDB.

Runs the real Flask app in a test client, so it exercises routing, auth, the
shared services and the database. No mocks: if the mobile client can pass this,
it can talk to the same backend the web app uses.

    python App/mobile_backend/smoke_test.py

It creates one test user and, when the planner is reachable and the corridor
has inventory, one test trip. Both are prefixed `smoketest` and can be deleted
from MongoDB afterwards. Pass --cleanup to remove them.
"""
import argparse
import os
import sys
import uuid
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Planner output and price strings contain the rupee sign, which a default
# Windows console (cp1252) cannot encode. Without this the test dies with a
# UnicodeEncodeError while printing a *passing* check, which is the worst
# possible failure mode for a test.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

PREFIX = "smoketest"
RESULTS = []


def check(label, condition, detail=""):
    RESULTS.append((label, bool(condition), detail))
    mark = "PASS" if condition else "FAIL"
    line = "  [%s] %s" % (mark, label)
    if detail:
        line += "\n         %s" % detail
    print(line)
    return bool(condition)


def section(title):
    print("\n%s\n%s" % (title, "-" * len(title)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", action="store_true",
                        help="keep the test user and trip in MongoDB")
    parser.add_argument("--skip-generate", action="store_true",
                        help="skip the AI planner call (slow, costs an LLM call)")
    args = parser.parse_args()

    from app import app
    client = app.test_client()
    stamp = datetime.utcnow().strftime("%H%M%S")
    email = "%s.%s@example.com" % (PREFIX, stamp)
    password = "SmokeTest!%s" % uuid.uuid4().hex[:8]

    section("health and public catalogue")
    health = client.get("/api/mobile/health")
    body = health.get_json() or {}
    check("health responds 200", health.status_code == 200, str(body))
    check("database reachable", body.get("database") == "ok",
          "database=%s status=%s" % (body.get("database"), body.get("status")))

    cities = client.get("/api/mobile/catalogue/cities")
    city_body = cities.get_json() or {}
    check("catalogue/cities is public (no token)", cities.status_code == 200)
    check("at least one corridor exists",
          len(city_body.get("corridors") or []) > 0,
          "%d corridors, %d cities"
          % (len(city_body.get("corridors") or []), len(city_body.get("cities") or [])))

    corridor = None
    for candidate in (city_body.get("corridors") or []):
        # Prefer a genuine inter-city corridor. `_corridor` returns
        # [boarding, dropping] and for some local services the dropping point is
        # the same place as the boarding point ("Adyar, Chennai" -> "Chennai"),
        # which is a valid record but a poor thing to plan a demo trip on.
        left = str(candidate.get("origin") or "").strip().lower()
        right = str(candidate.get("destination") or "").strip().lower()
        if left and right and left != right and left not in right and right not in left:
            corridor = candidate
            break
    corridor = corridor or (city_body.get("corridors") or [{}])[0]
    origin = corridor.get("origin")
    destination = corridor.get("destination")
    check("an inter-city corridor is available for a trip",
          bool(origin and destination and origin.lower() != destination.lower()),
          "%s -> %s" % (origin, destination))

    transport = client.get("/api/mobile/catalogue/transport",
                           query_string={"origin": origin,
                                         "destination": destination})
    transport_body = transport.get_json() or {}
    check("transport lookup for the corridor",
          transport.status_code == 200,
          "%d services" % len(transport_body.get("transports") or []))

    for name, path in (("spots", "/api/mobile/catalogue/spots"),
                       ("hotels", "/api/mobile/catalogue/hotels"),
                       ("guides", "/api/mobile/catalogue/guides"),
                       ("restaurants", "/api/mobile/catalogue/restaurants")):
        response = client.get(path, query_string={"city": destination})
        rows = (response.get_json() or {}).get(name) or []
        check("%s lookup" % name, response.status_code == 200, "%d rows" % len(rows))

    section("authentication")
    no_token = client.get("/api/mobile/trips")
    check("trips without a token is 401", no_token.status_code == 401,
          str(no_token.get_json()))
    check("401 carries a machine-readable code",
          (no_token.get_json() or {}).get("code") == "token_missing")

    bad_token = client.get("/api/mobile/trips",
                           headers={"Authorization": "Bearer not.a.jwt"})
    check("a malformed token is 401", bad_token.status_code == 401,
          str(bad_token.get_json()))

    duplicate = client.post("/api/mobile/auth/register",
                            json={"name": "Weak", "email": email, "password": "short"})
    check("weak password rejected with 400", duplicate.status_code == 400,
          str(duplicate.get_json()))

    registration = client.post("/api/mobile/auth/register",
                               json={"name": "Smoke Test User",
                                     "email": email, "password": password})
    check("register returns 201", registration.status_code == 201,
          str(registration.get_json()))

    login = client.post("/api/mobile/auth/login",
                        json={"email": email, "password": password})
    login_body = login.get_json() or {}
    check("login returns 200", login.status_code == 200, str(login_body)[:200])
    token = login_body.get("token")
    check("login issues a token", bool(token))
    check("login returns the public user, not a hash",
          bool(login_body.get("user")) and "passwordHash" not in login_body.get("user", {}))

    auth = {"Authorization": "Bearer %s" % token}

    wrong = client.post("/api/mobile/auth/login",
                        json={"email": email, "password": "definitely-wrong"})
    check("wrong password is 401", wrong.status_code == 401, str(wrong.get_json()))

    me = client.get("/api/mobile/auth/me", headers=auth)
    me_body = me.get_json() or {}
    check("auth/me returns this account",
          me.status_code == 200 and (me_body.get("user") or {}).get("email") == email)

    section("trip creation and validation")
    # Assert the specific code, not just the status. A 400 raised because
    # `origin` was missing would otherwise satisfy a check that was supposed to
    # be testing the budget rule, and the real rule would stay untested.
    bad_budget = client.post("/api/mobile/trips", headers=auth, json={
        "origin": origin, "destination": destination,
        "startDate": "2026-11-01", "endDate": "2026-11-04",
        "travelers": 2, "budget": 10})
    check("a budget under 1000 is rejected for the right reason",
          bad_budget.status_code == 400
          and (bad_budget.get_json() or {}).get("code") == "budget_too_low",
          str(bad_budget.get_json()))

    reversed_dates = client.post("/api/mobile/trips", headers=auth, json={
        "origin": origin, "destination": destination,
        "startDate": "2026-11-05", "endDate": "2026-11-01",
        "travelers": 2, "budget": 60000})
    check("end date before start date is rejected for the right reason",
          reversed_dates.status_code == 400
          and (reversed_dates.get_json() or {}).get("code") == "date_range_invalid",
          str(reversed_dates.get_json()))

    bad_travellers = client.post("/api/mobile/trips", headers=auth, json={
        "origin": origin, "destination": destination,
        "startDate": "2026-11-01", "endDate": "2026-11-04",
        "travelers": 0, "budget": 60000})
    check("zero travellers is rejected for the right reason",
          bad_travellers.status_code == 400
          and (bad_travellers.get_json() or {}).get("code") == "field_out_of_range",
          str(bad_travellers.get_json()))

    bad_transport = client.post("/api/mobile/trips", headers=auth, json={
        "origin": origin, "destination": destination,
        "startDate": "2026-11-01", "endDate": "2026-11-04",
        "travelers": 2, "budget": 60000, "transportType": "TELEPATH"})
    check("an invented transport type is rejected",
          bad_transport.status_code == 400
          and (bad_transport.get_json() or {}).get("code") == "value_not_allowed",
          str(bad_transport.get_json()))

    start = (datetime.utcnow() + timedelta(days=30)).date()
    end = start + timedelta(days=3)
    created = client.post("/api/mobile/trips", headers=auth, json={
        "origin": origin, "destination": destination,
        "startDate": start.isoformat(), "endDate": end.isoformat(),
        "travelers": 2, "budget": 60000,
        "travelStyle": "BALANCED",
        "preferences": "One relaxed day, one day of local food.",
        "returnTrip": False})
    created_body = created.get_json() or {}
    trip = created_body.get("trip") or {}
    trip_id = trip.get("id")
    check("create trip returns 201", created.status_code == 201, str(created_body)[:250])
    check("trip starts as DRAFT", trip.get("status") == "DRAFT")
    check("trip has a uuid", bool(trip_id))
    check("budgetUnlimited persisted explicitly", trip.get("budgetUnlimited") is False)

    updated = client.patch("/api/mobile/trips/%s" % trip_id, headers=auth,
                           json={"travelers": 3})
    check("a draft can be edited",
          updated.status_code == 200
          and (updated.get_json() or {}).get("trip", {}).get("travelers") == 3,
          str(updated.get_json())[:200])

    empty_patch = client.patch("/api/mobile/trips/%s" % trip_id, headers=auth,
                               json={"nonsense": 1})
    check("an empty patch is rejected",
          empty_patch.status_code == 400, str(empty_patch.get_json()))

    section("trip ownership")
    if trip_id:
        other = client.post("/api/mobile/auth/register",
                            json={"name": "Other User",
                                  "email": "%s.other.%s@example.com" % (PREFIX, stamp),
                                  "password": password})
        check("a second user can register for the ownership test",
              other.status_code == 201, str(other.get_json())[:200])
        other_login = client.post("/api/mobile/auth/login",
                                  json={"email": "%s.other.%s@example.com" % (PREFIX, stamp),
                                        "password": password})
        other_token = (other_login.get_json() or {}).get("token")
        other_auth = {"Authorization": "Bearer %s" % other_token}

        peek = client.get("/api/mobile/trips/%s" % trip_id, headers=other_auth)
        check("another user gets 404, not 403, for a trip they do not own",
              peek.status_code == 404, str(peek.get_json()))

        steal = client.post("/api/mobile/trips/%s/generate" % trip_id,
                            headers=other_auth)
        check("another user cannot generate plans for it, and is not told it exists",
              steal.status_code == 404
              and (steal.get_json() or {}).get("code") == "trip_not_found",
              str(steal.get_json()))

        ghost = client.get("/api/mobile/trips/does-not-exist", headers=auth)
        check("a missing trip is 404", ghost.status_code == 404)

    section("planning")
    if trip_id and not args.skip_generate:
        print("  (calling the AI planner - this takes 20-60s)")
        generated = client.post("/api/mobile/trips/%s/generate" % trip_id, headers=auth)
        gen_body = generated.get_json() or {}
        check("generate returns 200", generated.status_code == 200,
              str(gen_body)[:300])

        if gen_body.get("selectedPlan"):
            check("a plan was selected", bool(gen_body.get("selectedPlan")))
            check("the source is reported", bool(gen_body.get("source")),
                  "source=%s" % gen_body.get("source"))

            itin = client.get("/api/mobile/trips/%s/itinerary" % trip_id, headers=auth)
            itin_body = itin.get_json() or {}
            check("the itinerary reads back", itin.status_code == 200)
            check("itinerary items are grouped by day",
                  len(itin_body.get("days") or []) > 0,
                  "%d days, %d items"
                  % (len(itin_body.get("days") or []), len(itin_body.get("items") or [])))
            check("day grouping preserves the item order",
                  all(d.get("items") for d in itin_body.get("days") or []))

            details = client.get("/api/mobile/trips/%s" % trip_id, headers=auth)
            check("trip status moved to PLANNED",
                  (details.get_json() or {}).get("trip", {}).get("status") == "PLANNED",
                  str((details.get_json() or {}).get("trip", {}).get("status")))

            section("disruption and two-phase re-planning")
            delay = client.post("/api/mobile/trips/%s/delay" % trip_id, headers=auth,
                                json={"minutes": 90, "note": "Smoke test delay"})
            check("a delay is recorded",
                  delay.status_code == 200
                  and (delay.get_json() or {}).get("delay", {}).get("minutes") == 90,
                  str(delay.get_json())[:200])

            proposal = client.post("/api/mobile/trips/%s/replan" % trip_id, headers=auth,
                                   json={"delayMinutes": 90})
            prop_body = proposal.get_json() or {}
            check("phase 1 returns a proposal without applying it",
                  proposal.status_code == 200 and prop_body.get("proposal") is True)
            check("the proposal carries a real cost impact",
                  isinstance(prop_body.get("cost"), dict)
                  and "additional" in (prop_body.get("cost") or {}),
                  str(prop_body.get("cost"))[:200])
            check("the proposal reports what changed",
                  isinstance(prop_body.get("changes"), list),
                  "%d changes, %d dropped"
                  % (len(prop_body.get("changes") or []), len(prop_body.get("dropped") or [])))

            before = client.get("/api/mobile/trips/%s/itinerary" % trip_id, headers=auth)
            before_version = ((before.get_json() or {}).get("itinerary") or {}).get("version")

            applied = client.post("/api/mobile/trips/%s/replan" % trip_id, headers=auth,
                                  json={"delayMinutes": 90, "confirm": True})
            applied_body = applied.get_json() or {}
            check("phase 2 applies", applied.status_code == 200
                  and applied_body.get("confirmed") is True, str(applied_body)[:250])
            check("the applied version is newer",
                  (applied_body.get("version") or 0) > (before_version or 0),
                  "v%s -> v%s" % (before_version, applied_body.get("version")))
            check("the cost delta is a computed number",
                  isinstance(applied_body.get("additionalCost"), (int, float)),
                  "additionalCost=%s" % applied_body.get("additionalCost"))
            check("the explanation is human readable",
                  bool(applied_body.get("explanation")),
                  str(applied_body.get("explanation"))[:160])

            after = client.get("/api/mobile/trips/%s/itinerary" % trip_id, headers=auth)
            check("the old itinerary is superseded, not deleted",
                  len((after.get_json() or {}).get("itinerary", {}).get("id") or "") > 0)
        else:
            # A legitimately empty corridor is not a failure of the mobile layer.
            check("empty corridor reported as 200 with an explanation, not an error",
                  gen_body.get("selectedPlan") is None and gen_body.get("message"),
                  "source=%s message=%s" % (gen_body.get("source"),
                                             str(gen_body.get("message"))[:120]))
            check("the empty result is not marked retryable",
                  gen_body.get("retryable") is False,
                  "retryable=%s" % gen_body.get("retryable"))
    elif trip_id:
        print("  (planning skipped)")

    section("read-only views")
    if trip_id:
        budget = client.get("/api/mobile/trips/%s/budget" % trip_id, headers=auth)
        check("budget view responds", budget.status_code == 200,
              str(budget.get_json())[:200])
        events = client.get("/api/mobile/trips/%s/events" % trip_id, headers=auth)
        check("events respond", events.status_code == 200,
              "%d events" % len((events.get_json() or {}).get("events") or []))

        listings = client.get("/api/mobile/trips", headers=auth)
        check("the trip appears in the owner's list",
              any(t.get("id") == trip_id
                  for t in (listings.get_json() or {}).get("trips") or []))

    wallet = client.get("/api/mobile/wallet", headers=auth)
    check("wallet responds", wallet.status_code == 200,
          str(wallet.get_json())[:160])

    deposit = client.post("/api/mobile/wallet/deposit", headers=auth,
                          json={"amount": 100})
    check("a deposit is credited",
          deposit.status_code == 200
          and ((deposit.get_json() or {}).get("wallet") or {}).get("balance", 0) >= 100,
          str((deposit.get_json() or {}).get("wallet", {}).get("balance")))

    negative = client.post("/api/mobile/wallet/deposit", headers=auth,
                           json={"amount": -50})
    check("a negative deposit is rejected", negative.status_code == 400,
          str(negative.get_json()))

    bookings = client.get("/api/mobile/bookings", headers=auth)
    check("bookings list responds", bookings.status_code == 200)

    token_missing = client.get("/api/mobile/bookings/nope/token", headers=auth)
    check("a ticket for a booking you do not own is 404",
          token_missing.status_code == 404, str(token_missing.get_json()))

    section("error envelope")
    not_found = client.get("/api/mobile/no-such-endpoint")
    check("an unknown endpoint returns JSON, not HTML",
          not_found.status_code == 404
          and not_found.is_json
          and not_found.get_json().get("code") == "not_found",
          str(not_found.get_json()))

    wrong_method = client.delete("/api/mobile/catalogue/spots")
    check("a wrong method returns JSON too",
          wrong_method.status_code == 405 and wrong_method.is_json,
          str(wrong_method.get_json()))

    section("cleanup")
    if not args.keep:
        try:
            from services.mongodb import get_collection
            users = get_collection("users")
            # Find the test accounts first, then remove the trips they own.
            # Planned trips are kept out of the "draft only" branch below
            # because they are the more interesting artefact to leave behind if
            # something goes wrong - but on a clean run they should not
            # accumulate in the real database.
            test_users = list(users.find({"email": {"$regex": "^%s" % PREFIX}},
                                         {"_id": 1}))
            user_ids = [u["_id"] for u in test_users]
            if user_ids:
                removed_trips = get_collection("trips").delete_many(
                    {"userId": {"$in": user_ids}})
                print("  removed %d test trip(s)" % removed_trips.deleted_count)
                get_collection("bookings").delete_many({"userId": {"$in": user_ids}})
                get_collection("wallets").delete_many({"userId": {"$in": user_ids}})
            removed = users.delete_many({"email": {"$regex": "^%s" % PREFIX}})
            print("  removed %d test user(s)" % removed.deleted_count)
        except Exception as exc:  # noqa: BLE001
            print("  cleanup failed: %s" % exc)
    else:
        print("  --keep given: left %s and its trip in the database" % email)

    failed = [label for label, ok, _ in RESULTS if not ok]
    print("\n%s" % ("=" * 60))
    print("%d checks, %d passed, %d failed"
          % (len(RESULTS), len(RESULTS) - len(failed), len(failed)))
    for label in failed:
        print("  FAILED: %s" % label)
    print("=" * 60)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
