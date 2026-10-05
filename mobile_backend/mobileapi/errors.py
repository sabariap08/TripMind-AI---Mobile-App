"""Uniform error envelope for the mobile API.

The web API returns bare ``{"error": "..."}`` bodies, which is fine for a
browser that only ever renders text. A native client needs to know *which*
failure it is in order to choose what to show, so every mobile failure carries
a machine-readable ``code`` alongside the human message. The message text is
identical in tone to the web API so the two products do not feel like different
applications.
"""


class MobileApiError(Exception):
    """Base class. `status` is the HTTP code, `code` the client-facing constant."""

    status = 400
    code = "bad_request"

    def __init__(self, message, code=None, status=None, details=None):
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code
        if status is not None:
            self.status = status
        self.details = details or {}

    def to_dict(self):
        body = {"error": self.message, "code": self.code}
        if self.details:
            body["details"] = self.details
        return body


class ValidationError(MobileApiError):
    status = 400
    code = "validation_error"


class AuthError(MobileApiError):
    status = 401
    code = "unauthorized"


class ForbiddenError(MobileApiError):
    status = 403
    code = "forbidden"


class NotFoundError(MobileApiError):
    status = 404
    code = "not_found"


class ConflictError(MobileApiError):
    status = 409
    code = "conflict"


class AiUnavailableError(MobileApiError):
    """The planner could not be reached.

    Kept distinct from an empty result on purpose. The web API made this
    mistake: it answered 200 with `selectedPlan: null`, which on the wire is
    indistinguishable from "we genuinely have nothing for this corridor". The
    mobile client must be able to tell "the AI is down, retry" from "no
    inventory here", so it gets a distinct status and a `retryable` flag.
    """

    status = 503
    code = "ai_unavailable"

    def __init__(self, message, retryable=True, details=None):
        super().__init__(message, details=details)
        self.retryable = retryable

    def to_dict(self):
        body = super().to_dict()
        body["retryable"] = self.retryable
        return body
