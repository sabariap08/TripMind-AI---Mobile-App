"""JWT authentication for the mobile API.

Why this exists rather than reusing services/auth.py directly: the shared auth
service is built on Flask signed-cookie sessions. `current_user()` reads
`session`, and `login_user()` writes to it. A native client does not have a
cookie jar, so those two functions are unusable here without a session.

What IS reused, unchanged, is the part that actually carries the security
weight:

  * `services.auth.register_user`  - account creation, normalisation and the
    DuplicateKeyError handling. It never touches a session, so it is called
    as-is and a mobile registration produces a document byte-identical to a
    web registration.
  * `services.auth._public_user`   - the single definition of the public user
    shape, including the masking of the identity number. One shape for both
    clients means the mobile app cannot leak a field the web app hides.
  * the approval gating rules       - reproduced below in
    `authenticate_credentials` and `load_user`, with the same fail-closed
    behaviour: an unknown or missing approval state is a refusal, never a
    silent success.
"""
import datetime as _dt
from functools import wraps

import jwt
from flask import g, request

from mobileapi import config
from mobileapi.errors import AuthError, ForbiddenError
from werkzeug.security import check_password_hash

from services.mongodb import get_collection
from services.auth import (register_user, _public_user, is_irctc_admin,
                           provider_is_approved)

_SESSION_USER_KEY = "tripmind_user"


# ------------------------------------------------------------------ tokens
def issue_token(user):
    """Mint an access token for a public user dict."""
    now = _dt.datetime.now(_dt.timezone.utc)
    payload = {
        "sub": str(user["id"]),
        "role": user.get("role") or config.ROLES["USER"],
        "approvalStatus": user.get("approvalStatus") or "APPROVED",
        "name": user.get("name") or "",
        "email": user.get("email") or "",
        "iss": config.JWT_ISSUER,
        "iat": int(now.timestamp()),
        "exp": int((now + _dt.timedelta(seconds=config.JWT_TTL_SECONDS)).timestamp()),
    }
    return jwt.encode(payload, config.JWT_SECRET, algorithm=config.JWT_ALGORITHM), payload


def decode_token(token):
    """Verify a token and return its claims, or raise AuthError."""
    if not token:
        raise AuthError("Authentication required. Please sign in.",
                        code="token_missing")
    try:
        claims = jwt.decode(token, config.JWT_SECRET, algorithms=[config.JWT_ALGORITHM],
                            issuer=config.JWT_ISSUER,
                            options={"require": ["exp", "sub", "iss"]})
    except jwt.ExpiredSignatureError:
        raise AuthError("Your session has expired. Please sign in again.",
                        code="token_expired")
    except jwt.InvalidTokenError:
        raise AuthError("Invalid authentication token. Please sign in again.",
                        code="token_invalid")
    return claims


def _bearer_from_request():
    header = request.headers.get("Authorization", "")
    if not header:
        return None
    parts = header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip()


# ------------------------------------------------------------- credentials
def _account_refusal(user):
    """Return an error message when this account must not sign in, else None.

    Mirrors the checks in services.auth.login_user, including the fail-closed
    branch for provider accounts whose approval state is missing or unknown.
    """
    if user.get("status") != "ACTIVE":
        return "Account is not active."
    status = user.get("approvalStatus")
    if status == "SUSPENDED":
        return ("Your account has been suspended. Please contact the platform "
                "administrator.")
    if user.get("role") in config.PROVIDER_ROLES and status != "APPROVED":
        if status == "PENDING":
            return "Your account is pending Main Admin approval."
        if status == "REJECTED":
            return ("Your registration was rejected. Reason: %s"
                    % (user.get("approvalReason") or "no reason provided"))
        return ("Your account is not approved. Please contact the platform "
                "administrator.")
    return None


def authenticate_credentials(email, password):
    """Verify credentials and return (public_user, error_message).

    Same rules as the web login: unknown e-mail and wrong password give the
    identical message so the endpoint cannot be used to enumerate accounts.
    """
    email = (email or "").strip().lower()
    user = get_collection("users").find_one({"email": email})
    if not user or not check_password_hash(user.get("passwordHash", ""), password or ""):
        return None, "Invalid email or password."
    refusal = _account_refusal(user)
    if refusal:
        return None, refusal
    return _public_user(user), None


def load_user(user_id):
    """Fetch the public user for a token subject, or None."""
    user = get_collection("users").find_one({"_id": user_id})
    return _public_user(user) if user else None


def register_mobile_user(data):
    """Create a traveller account by calling the shared registration service."""
    user, err = register_user(data, role=config.ROLES["USER"])
    return user, err


# ------------------------------------------------------------------ guards
def require_auth(f):
    """Populate g.current_user from the bearer token, or raise 401."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        token = _bearer_from_request()
        if not token:
            raise AuthError("Authentication required. Please sign in.",
                            code="token_missing")
        claims = decode_token(token)
        user = load_user(claims["sub"])
        if not user:
            # The token is well formed but the account is gone. Force a fresh
            # sign-in rather than trusting a subject that no longer resolves.
            raise AuthError("Your account could not be found. Please sign in again.",
                            code="account_missing")
        if user.get("status") != "ACTIVE":
            raise ForbiddenError("Your account is not active.", code="account_inactive")
        if user.get("approvalStatus") == "SUSPENDED":
            raise ForbiddenError("Your account has been suspended. Please contact "
                                 "the platform administrator.", code="account_suspended")
        g.current_user = user
        g.token_claims = claims
        return f(*args, **kwargs)
    return wrapper


def require_roles(*roles):
    """RBAC guard, mirroring services.auth.require_roles."""
    allowed = set(roles)

    def decorator(f):
        @wraps(f)
        def wrapper(*args, **kwargs):
            user = getattr(g, "current_user", None)
            if not user:
                raise AuthError("Authentication required. Please sign in.",
                                code="token_missing")
            if user.get("role") not in allowed:
                raise ForbiddenError("You do not have access to this resource.",
                                     code="role_forbidden")
            return f(*args, **kwargs)
        return wrapper
    return decorator


def require_approved_provider(f):
    """Provider guard, mirroring services.auth.require_approved_provider."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        user = getattr(g, "current_user", None)
        if not user:
            raise AuthError("Authentication required. Please sign in.",
                            code="token_missing")
        if user.get("role") not in config.PROVIDER_ROLES and not is_irctc_admin(user):
            raise ForbiddenError("Only approved partners can access this resource.",
                                 code="provider_only")
        if not provider_is_approved(user):
            raise ForbiddenError("Your partner account is not approved.",
                                 code="provider_not_approved")
        return f(*args, **kwargs)
    return wrapper


def current_user():
    return getattr(g, "current_user", None)
