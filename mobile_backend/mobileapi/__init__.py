"""TripMind AI mobile API.

A separate Flask application that exposes the traveller-facing subset of the
TripMind AI backend to a native client. It shares the database, the service
layer and the secrets with the web application; it does not share the route
module, because that module is web-request-coupled.

Run it with:

    python App/mobile_backend/app.py
"""
__all__ = ["config", "errors", "gateway", "serializers", "validators"]
