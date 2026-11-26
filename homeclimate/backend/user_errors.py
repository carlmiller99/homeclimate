"""Fixed, user-safe validation messages for API responses.

Route handlers never return ``str(exc)`` (CWE-209, security alert #4). Instead,
every message a validation error may carry is declared once at import time
with :func:`fixed`, and handlers return :func:`safe_text`, which looks the
error up in that registry and returns the registered constant. An error whose
text was never registered comes back as :data:`GENERIC`.
"""

from __future__ import annotations

GENERIC = "The request was not valid"

_MESSAGES: dict[str, str] = {}


def fixed(text: str) -> str:
    """Register ``text`` as a message that is safe to return, and return it."""
    _MESSAGES[text] = text
    return text


class UserError(ValueError):
    """A validation error whose message is one of the registered constants."""


def safe_text(exc: BaseException) -> str:
    key = exc.args[0] if exc.args and isinstance(exc.args[0], str) else ""
    return _MESSAGES.get(key, GENERIC)
