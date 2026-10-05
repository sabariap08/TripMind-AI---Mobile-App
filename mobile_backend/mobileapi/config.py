"""Mobile API configuration.

This module wires the mobile backend to the EXISTING TripMind AI backend so the
two applications share one database, one set of service modules and one set of
secrets. It deliberately does not duplicate any of that configuration.

Two things matter here:

1. ``Website/backend`` is prepended to ``sys.path`` so that ``import config``
   and ``from services.x import y`` resolve to the real, existing modules
   rather than to anything local. Every module in this package is imported as
   ``mobileapi.*`` so nothing here can shadow the shared top-level names
   (``config``, ``routes``, ``services``).

2. The JWT signing key is a *separate* secret from the web session key. The web
   app signs cookies; this signs bearer tokens. Sharing one key would mean a
   forged web session key could mint mobile tokens, so they are independent.
"""
import os
import sys
import secrets

# --------------------------------------------------------------------- paths
_HERE = os.path.dirname(os.path.abspath(__file__))
_MOBILE_BACKEND = os.path.dirname(_HERE)          # App/mobile_backend
_APP_ROOT = os.path.dirname(_MOBILE_BACKEND)       # App
_PROJECT_ROOT = os.path.dirname(_APP_ROOT)         # TripMind-AI
WEB_BACKEND = os.path.join(_PROJECT_ROOT, "Website", "backend")
WEB_ROOT = os.path.join(_PROJECT_ROOT, "Website")
SHARED_ENV = os.path.join(WEB_ROOT, ".env")

# Prepended so the shared modules win over anything with the same name.
if os.path.isdir(WEB_BACKEND) and WEB_BACKEND not in sys.path:
    sys.path.insert(0, WEB_BACKEND)

# The shared config loads Website/.env itself via python-dotenv, which is how
# the mobile backend ends up reading the same Mongo URI, the same LLM keys and
# the same Google Maps key as the web app. Load it here so the values are
# available to this module too.
import config as web_config  # noqa: E402  (path must be set first)

MONGODB_URI = web_config.MONGODB_URI
MONGODB_DB_NAME = web_config.MONGODB_DB_NAME
DEV_MODE = web_config.DEV_MODE
ROLES = web_config.ROLES
PROVIDER_ROLES = web_config.PROVIDER_ROLES
IRCTC_ADMIN_EMAIL = web_config.IRCTC_ADMIN_EMAIL

# ------------------------------------------------------------------- serving
API_PREFIX = "/api/mobile"
HOST = os.getenv("MOBILE_API_HOST", "0.0.0.0")
PORT = int(os.getenv("MOBILE_API_PORT", "5001") or "5001")

# CORS is not needed by a native client, but Expo web and the browser-based
# debug view both send an Origin, so it stays enabled and permissive for the
# mobile API only. The web backend keeps its own policy untouched.
CORS_ORIGINS = os.getenv("MOBILE_CORS_ORIGINS", "*")

# ---------------------------------------------------------------------- auth
# Resolution order, deliberately mirroring config.py in the web backend:
#   1. MOBILE_JWT_SECRET from the environment
#   2. a previously generated key in mobile_backend/.mobile_jwt_secret
#   3. a fresh key written to that file (development only)
# The web app refuses to boot in production without an explicit SECRET_KEY.
# This does the same rather than silently signing tokens with a guessable key.
_JWT_FALLBACK = "tripmind-mobile-dev-secret"
_JWT_KEY_FILE = os.path.join(_MOBILE_BACKEND, ".mobile_jwt_secret")

JWT_ALGORITHM = "HS256"
# Seven days, matching the web app's permanent_session_lifetime so a user does
# not get signed out of the app more aggressively than out of the site.
JWT_TTL_SECONDS = int(os.getenv("MOBILE_JWT_TTL", str(7 * 24 * 60 * 60)))
JWT_ISSUER = "tripmind-mobile"


def _read_generated_jwt_key():
    try:
        with open(_JWT_KEY_FILE, "r", encoding="utf-8") as handle:
            return handle.read().strip() or None
    except OSError:
        return None


def _write_generated_jwt_key(value):
    try:
        with open(_JWT_KEY_FILE, "w", encoding="utf-8") as handle:
            handle.write(value)
        os.chmod(_JWT_KEY_FILE, 0o600)
    except OSError:
        # Read-only checkout: this process still works, the key just will not
        # survive a restart. Invalidating tokens is better than refusing to boot.
        pass


def _resolve_jwt_secret():
    raw = (os.getenv("MOBILE_JWT_SECRET") or "").strip()
    if raw and raw != _JWT_FALLBACK:
        return raw, "env"
    if not DEV_MODE:
        raise RuntimeError(
            "MOBILE_JWT_SECRET must be set to a unique random value when "
            "DEV_MODE is false. Generate one with: python -c \"import secrets;"
            "print(secrets.token_urlsafe(48))\""
        )
    existing = _read_generated_jwt_key()
    if existing:
        return existing, "generated-file"
    value = "%s-%s" % (_JWT_FALLBACK, secrets.token_hex(16))
    _write_generated_jwt_key(value)
    return value, "generated-new"


JWT_SECRET, JWT_SECRET_SOURCE = _resolve_jwt_secret()
JWT_SECRET_IS_EPHEMERAL = JWT_SECRET_SOURCE != "env"

# ------------------------------------------------------------------- limits
MAX_CONTENT_LENGTH = 4 * 1024 * 1024  # no data-URI uploads from the mobile app
