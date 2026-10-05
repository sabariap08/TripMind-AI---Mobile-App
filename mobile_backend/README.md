# TripMind Mobile API

A second HTTP entry point for the TripMind platform, built for the Expo
React Native client. It reuses every service the web app already uses and adds
only what a native client needs: bearer-token auth, narrow JSON shapes, and
machine-readable errors.

## Why this is separate from the web app

The web app authenticates with an HTTP-only session cookie and its route
handlers read `flask.request`/`session` globals directly. A native client cannot
use a cookie jar reliably and should not depend on Flask's session machinery.

So this is a separate blueprint set under `/api/mobile`, not a second
implementation of the business logic:

```
Expo app  ──bearer JWT──►  /api/mobile  ──►  services/*  ──►  MongoDB
Web app   ──cookie────────►  /api/...     ──►  services/*  ──►  MongoDB
```

`mobileapi/gateway.py` is the only new logic of substance. It adapts the shared
services to a mobile-shaped request/response and keeps their quirks in one
place — for example `booking_service` stores the amount as `total`, while the
API exposes it as `cost`.

## Running it

```bash
cd App/mobile_backend
pip install -r requirements.txt
python app.py
```

Listens on port **5001** so it never collides with the web app on 5000.

```bash
curl http://localhost:5001/api/mobile/health
```

`health` reports liveness and a real MongoDB round trip separately, because
"the process is up" and "the database is reachable" fail independently.

## Configuration

Read from the environment, all optional:

| Variable | Default | Notes |
| --- | --- | --- |
| `MOBILE_PORT` | `5001` | |
| `MOBILE_JWT_SECRET` | generated | **Set this in production.** Without it a random secret is generated per process, so restarting invalidates every issued token. |
| `MOBILE_JWT_TTL` | `604800` | Token lifetime in seconds (7 days). |
| `MOBILE_CORS_ORIGINS` | `*` | Comma-separated. |

MongoDB and the AI planner credentials come from the web app's `.env`, so both
clients read the same database.

## Route surface

**Public**

| Method | Path |
| --- | --- |
| GET | `/health` |
| GET | `/catalogue/cities` |
| GET | `/catalogue/transport` |
| GET | `/catalogue/spots`, `/tours`, `/guides`, `/hotels`, `/restaurants` |
| GET | `/catalogue/restaurants/<id>/menu` |
| GET | `/places/distance` |
| POST | `/auth/register`, `/auth/login` |

**Authenticated** (bearer token)

| Method | Path |
| --- | --- |
| GET/POST | `/trips` |
| GET/PATCH/DELETE | `/trips/<id>` |
| POST | `/trips/<id>/clarify`, `/generate` |
| GET | `/trips/<id>/itinerary`, `/budget`, `/events`, `/token` |
| POST | `/trips/<id>/itinerary/select`, `/delay`, `/replan`, `/pay` |
| DELETE | `/trips/<id>/delay` |
| GET/POST | `/bookings` |
| GET/DELETE | `/bookings/<id>` |
| POST | `/bookings/<id>/pay` |
| GET | `/bookings/<id>/token` |
| GET | `/wallet` |
| POST | `/wallet/deposit` |
| GET | `/auth/me` |
| POST | `/auth/password` |

## Two decisions worth knowing

**Ownership failures return 404, not 403.** Confirming that an id exists is
itself a leak, so a request for someone else's trip or booking gets the same
answer as a request for something that never existed.

**Re-planning is two-phase.** `POST /trips/<id>/replan` proposes with a real
cost delta and writes nothing. The same call with `confirm: true` applies it.
`replanner.py` computes the rupee figures; the mobile layer only surfaces them,
including `allCostsVerified: false` when a changed item had no confirmed price.

## Errors

Every failure is the same shape, so the client can branch on `code` rather than
parsing prose:

```json
{ "error": "A trip ticket is issued once at least one booking is confirmed.",
  "code": "ticket_not_ready",
  "retryable": false,
  "details": null }
```

`retryable` is what lets the app distinguish "the AI is down, try again"
(503) from "there is no inventory on this corridor" (200 with an empty plan).

## Smoke test

```bash
python smoke_test.py
```

Exercises the full flow against the live database: auth, trip creation,
validation, ownership, catalogue, distance, planning, delay, replan proposal,
confirm, budgets, events, bookings, wallet, and QR tokens. It creates and then
removes its own data.
