"""TripMind AI mobile API - entry point.

A separate Flask application from the web backend, sharing the same database,
the same service modules and the same secrets.

    python App/mobile_backend/app.py

Environment (all optional in development):
    MOBILE_API_HOST     default 0.0.0.0 - reachable from a handset on the LAN
    MOBILE_API_PORT     default 5001    - 5000 stays with the web app
    MOBILE_JWT_SECRET   required when DEV_MODE is false
    MOBILE_JWT_TTL      access token lifetime in seconds, default 7 days
    MOBILE_CORS_ORIGINS default *      - permissive for this API only

It binds 0.0.0.0 so a physical iQOO on the same Wi-Fi can reach it at
http://<your-LAN-IP>:5001 . Plain HTTP is acceptable for that because the
traffic never leaves the local network; anything beyond it needs TLS terminated
in front of this process.
"""
import logging
import sys

from flask import Flask, jsonify, request
from werkzeug.exceptions import HTTPException

from mobileapi import config
from mobileapi.errors import MobileApiError

# `mobileapi.config` puts Website/backend on sys.path as a side effect of being
# imported, so it must come before anything that imports `config` or `services`.
from mobileapi.routes import BLUEPRINTS


def create_app():
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = config.MAX_CONTENT_LENGTH
    app.config["JSON_SORT_KEYS"] = False
    app.config["PROPAGATE_EXCEPTIONS"] = False

    _install_cors(app)
    _install_error_handlers(app)

    for blueprint in BLUEPRINTS:
        app.register_blueprint(blueprint, url_prefix=config.API_PREFIX)

    _install_root_routes(app)
    return app


def _install_cors(app):
    """Permissive CORS, scoped to this app only.

    A native client does not need CORS. It stays enabled because Expo web and
    the browser debug view do send an Origin, and because a developer running
    the API locally should not have to configure anything to see it work. The
    web backend keeps its own policy and is not touched by this.
    """
    @app.after_request
    def add_cors_headers(response):
        origin = request.headers.get("Origin")
        if origin:
            allowed = config.CORS_ORIGINS
            if allowed == "*":
                response.headers["Access-Control-Allow-Origin"] = "*"
            elif origin in [o.strip() for o in allowed.split(",")]:
                # Echo the specific origin rather than "*" so the browser will
                # accept it alongside credentials.
                response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
            response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Access-Control-Allow-Headers"] = (
            "Authorization, Content-Type, Accept, X-Requested-With")
        response.headers["Access-Control-Allow-Methods"] = (
            "GET, POST, PATCH, PUT, DELETE, OPTIONS")
        response.headers["Access-Control-Max-Age"] = "600"
        return response

    # No catch-all OPTIONS route on purpose. A `/<path:_any>` rule with only
    # OPTIONS registered matches the *path* of any unmatched URL, so a GET to a
    # typo'd endpoint resolved to that rule and answered 405 "method not
    # allowed" instead of 404 "no such endpoint" - which sends a client looking
    # for a wrong HTTP verb rather than a wrong URL. Flask already answers
    # OPTIONS automatically for every registered rule, and `after_request` adds
    # the headers to those responses too.


def _install_error_handlers(app):
    """Every failure leaves as the same JSON envelope.

    An unhandled exception in Flask returns HTML. A React Native fetch that
    receives HTML cannot parse it, so the app would show a generic network
    error for what is actually a server bug - exactly the case where a clear
    message matters most. Logs the traceback server-side; returns a code the
    client can branch on.
    """
    @app.errorhandler(MobileApiError)
    def handle_mobile_error(exc):
        return jsonify(exc.to_dict()), exc.status

    @app.errorhandler(HTTPException)
    def handle_http_error(exc):
        body = exc.get_response()
        if exc.code in (404, 405):
            message = ("Endpoint not found. Check the mobile API base URL."
                       if exc.code == 404 else "That method is not allowed here.")
            return jsonify({"error": message, "code": "not_found" if exc.code == 404
                            else "method_not_allowed"}), exc.code
        return jsonify({"error": exc.description, "code": "http_error"}), exc.code

    @app.errorhandler(Exception)
    def handle_unexpected(exc):
        logging.getLogger("tripmind.mobile").exception(
            "Unhandled mobile API error on %s %s", request.method, request.path)
        return jsonify({
            "error": ("Something went wrong on our side. Please try again."),
            "code": "internal_error",
        }), 500


def _install_root_routes(app):
    @app.route("/", methods=["GET"])
    def root():
        return jsonify({
            "service": "TripMind AI mobile API",
            "version": "1.0.0",
            "apiPrefix": config.API_PREFIX,
            "sharedWith": "Website/backend (same MongoDB, same services)",
            "endpoints": sorted(
                "%s %s" % (sorted(m.methods - {"HEAD", "OPTIONS"})[0], str(r))
                for r in app.url_map.iter_rules()
                if str(r).startswith(config.API_PREFIX)
            ),
        })

    @app.route("/api/mobile", methods=["GET"])
    def api_root():
        return jsonify({
            "service": "TripMind AI mobile API",
            "apiPrefix": config.API_PREFIX,
            "database": config.MONGODB_DB_NAME,
            "docs": "App/mobile_backend/README.md",
        })


app = create_app()


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s [mobile-api] %(message)s",
    )
    log = logging.getLogger("tripmind.mobile")

    log.info("database      : %s", config.MONGODB_DB_NAME)
    log.info("jwt secret    : %s%s", config.JWT_SECRET_SOURCE,
             "  (ephemeral - tokens will not survive a restart)"
             if config.JWT_SECRET_IS_EPHEMERAL else "")
    log.info("api prefix    : %s", config.API_PREFIX)
    log.info("web backend   : untouched, still on port 5000")

    try:
        from services.mongodb import get_collection
        get_collection("users").estimated_document_count()
        log.info("mongodb       : connected")
    except Exception as exc:  # noqa: BLE001 - report, do not crash
        log.warning("mongodb       : NOT reachable (%s)", exc)
        log.warning("the API will start but every request that needs data will fail")

    log.info("listening on  : http://%s:%d", config.HOST, config.PORT)
    log.info("handset test  : curl http://<your-LAN-IP>:%d/api/mobile/health",
             config.PORT)

    try:
        app.run(host=config.HOST, port=config.PORT, debug=False, threaded=True)
    except KeyboardInterrupt:
        log.info("shutting down")
        sys.exit(0)
