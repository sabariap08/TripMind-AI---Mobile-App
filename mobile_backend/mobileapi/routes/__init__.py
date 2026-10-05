"""Mobile API blueprints.

Grouped by what the app screen does, not by what the web API groups them by:

  auth_routes        sign in, register, current account
  trip_routes        plan, view, re-plan a trip
  booking_routes     bookings, payments, wallet, tickets
  discovery_routes   read-only catalogue browsing for the search screens

Each blueprint is registered under `config.API_PREFIX` by app.py.
"""
from mobileapi.routes.auth_routes import auth_bp
from mobileapi.routes.booking_routes import booking_bp
from mobileapi.routes.discovery_routes import discovery_bp
from mobileapi.routes.trip_routes import trip_bp

BLUEPRINTS = (auth_bp, trip_bp, booking_bp, discovery_bp)

__all__ = ["BLUEPRINTS", "auth_bp", "trip_bp", "booking_bp", "discovery_bp"]
