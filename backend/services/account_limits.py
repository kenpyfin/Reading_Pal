"""Caps written only when a Google account is first created.

Missing limit fields mean the account is unlimited. That covers accounts that
already existed, email matches that only get a Google id linked, and the
separate admin login, which is not a user document.
"""

from typing import Any, Dict, Optional

NEW_ACCOUNT_BOOK_LIMIT = 5
NEW_ACCOUNT_GUIDE_GENERATION_LIMIT = 2

BOOK_LIMIT_DETAIL = "You can keep 5 books. Delete one to upload another."
GUIDE_GENERATION_LIMIT_DETAIL = (
    "You can generate 2 reading guides. This account has used both."
)


def new_google_account_limits() -> Dict[str, int]:
    return {
        "book_limit": NEW_ACCOUNT_BOOK_LIMIT,
        "guide_generation_limit": NEW_ACCOUNT_GUIDE_GENERATION_LIMIT,
        "guide_generations_used": 0,
    }


def book_upload_allowed(user: Optional[Dict[str, Any]], library_count: int) -> bool:
    """True when this user may add another book that shows in the library."""
    if not user:
        return True
    raw_limit = user.get("book_limit")
    if raw_limit is None:
        return True
    return int(library_count) < int(raw_limit)


def guide_generation_decision(user: Optional[Dict[str, Any]]) -> str:
    """Return ``unlimited``, ``allow``, or ``deny``.

    ``allow`` means a limited account still has a generation left and the
    caller should consume one. ``unlimited`` must not touch the counter.
    """
    if not user:
        return "unlimited"
    raw_limit = user.get("guide_generation_limit")
    if raw_limit is None:
        return "unlimited"
    used = int(user.get("guide_generations_used") or 0)
    if used >= int(raw_limit):
        return "deny"
    return "allow"
