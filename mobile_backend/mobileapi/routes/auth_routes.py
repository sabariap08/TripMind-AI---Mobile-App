"""Mobile authentication endpoints.

Token-based, not cookie-based: a native client has no cookie jar, so the web
app's signed-session approach does not transfer. Everything else - the password
hash, the duplicate-registration rules, the approval gating, the public user
shape - is the shared `services.auth` code, called unchanged.

Only the traveller role is registrable here. Partner registration collects a
business identity, uploads documents and requires an approval review; that
belongs in the web portal, and pretending otherwise on a phone would produce
accounts the mobile app cannot service.
"""
import datetime as _dt

from flask import Blueprint, jsonify

from mobileapi import config
from mobileapi.auth import (authenticate_credentials, current_user,
                            issue_token, register_mobile_user, require_auth)
from mobileapi.errors import AuthError, ConflictError, ValidationError
from mobileapi.validators import optional_str, require_body, require_str, validate_registration

auth_bp = Blueprint("mobile_auth", __name__)


def _token_response(user, *, message, status=200, remember=False):
    token, claims = issue_token(user)
    body = {
        "token": token,
        "tokenType": "Bearer",
        "expiresIn": config.JWT_TTL_SECONDS,
        "expiresAt": claims["exp"],
        "user": user,
        "message": message,
    }
    if remember:
        body["remember"] = True
    return jsonify(body), status


@auth_bp.route("/auth/register", methods=["POST"])
def register():
    data = require_body()
    payload = validate_registration(data)

    # The shared duplicate check runs first so the app shows the same
    # field-specific message the web form does ("That e-mail is already
    # registered") rather than a generic failure.
    try:
        from services import duplicate
        dup = duplicate.register_duplicate_check(payload)
    except Exception:
        dup = None
    if dup:
        raise ConflictError(dup["message"], code=dup.get("field") or "duplicate",
                            details={"field": dup.get("field")})

    user, err = register_mobile_user(payload)
    if err:
        raise ValidationError(err, code="registration_rejected")

    # Registration does not sign the client in on the web either, so the app is
    # sent to the login screen instead of holding a token nobody asked for.
    return jsonify({"user": {"id": str(user["_id"]),
                             "name": user.get("name"),
                             "email": user.get("email")},
                    "message": "Account created. Please log in."}), 201


@auth_bp.route("/auth/login", methods=["POST"])
def login():
    data = require_body()
    email = require_str(data, "email", max_length=160)
    password = data.get("password")
    if not isinstance(password, str) or not password:
        raise ValidationError("Email and password are required.",
                              code="password_required")

    user, err = authenticate_credentials(email, password)
    if err:
        # 401 for a wrong password and 403 for a suspended or unapproved
        # account are different problems for the client, so the mobile API
        # separates them where the web API returns a flat 401.
        if "not active" in err.lower() or "suspended" in err.lower() \
                or "approval" in err.lower() or "approved" in err.lower():
            from mobileapi.errors import ForbiddenError
            raise ForbiddenError(err, code="account_not_permitted")
        raise AuthError(err, code="invalid_credentials")

    remember = bool(data.get("remember"))
    return _token_response(user, message="Logged in.", remember=remember)


@auth_bp.route("/auth/me", methods=["GET"])
@require_auth
def me():
    user = current_user()
    return jsonify({"user": user,
                    "provider": bool(user.get("role") in config.PROVIDER_ROLES)})


@auth_bp.route("/auth/logout", methods=["POST"])
@require_auth
def logout():
    # Tokens are stateless and short of a revocation list on purpose: a native
    # app dropping its copy is the whole logout. Stating it explicitly means the
    # client has a call to make when it wants to be sure.
    return jsonify({"message": "Signed out."})


@auth_bp.route("/auth/password", methods=["POST"])
@require_auth
def change_password():
    data = require_body()
    current = optional_str(data, "currentPassword", max_length=200, default="")
    new_password = data.get("newPassword")
    if not current:
        raise ValidationError("Your current password is required.",
                              code="password_required")
    if not isinstance(new_password, str) or len(new_password) < 8:
        raise ValidationError("The new password must be at least 8 characters.",
                              code="weak_password")

    from werkzeug.security import check_password_hash, generate_password_hash
    from services.mongodb import get_collection

    user_id = current_user()["id"]
    record = get_collection("users").find_one({"_id": user_id})
    if not record or not check_password_hash(record.get("passwordHash", ""), current):
        raise AuthError("Your current password is incorrect.",
                        code="password_mismatch")

    get_collection("users").update_one(
        {"_id": user_id},
        {"$set": {"passwordHash": generate_password_hash(new_password),
                  "passwordChangedAt": _dt.datetime.utcnow().isoformat()}})
    return jsonify({"message": "Password updated. Please sign in again."})
