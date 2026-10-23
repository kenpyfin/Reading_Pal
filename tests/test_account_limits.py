import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from backend.services.account_limits import (
    BOOK_LIMIT_DETAIL,
    GUIDE_GENERATION_LIMIT_DETAIL,
    NEW_ACCOUNT_BOOK_LIMIT,
    NEW_ACCOUNT_GUIDE_GENERATION_LIMIT,
    book_upload_allowed,
    guide_generation_decision,
    new_google_account_limits,
)


def test_new_google_account_limits_are_five_books_and_two_guides():
    limits = new_google_account_limits()
    assert limits["book_limit"] == NEW_ACCOUNT_BOOK_LIMIT == 5
    assert limits["guide_generation_limit"] == NEW_ACCOUNT_GUIDE_GENERATION_LIMIT == 2
    assert limits["guide_generations_used"] == 0


def test_missing_user_or_limit_fields_stay_unlimited():
    assert book_upload_allowed(None, 99) is True
    assert book_upload_allowed({}, 99) is True
    assert book_upload_allowed({"email": "existing@example.com"}, 99) is True
    assert guide_generation_decision(None) == "unlimited"
    assert guide_generation_decision({}) == "unlimited"
    assert guide_generation_decision({"email": "existing@example.com"}) == "unlimited"


def test_book_cap_counts_the_current_library():
    user = new_google_account_limits()
    assert book_upload_allowed(user, 4) is True
    assert book_upload_allowed(user, 5) is False
    assert book_upload_allowed(user, 0) is True


def test_guide_cap_allows_two_successful_generations():
    user = new_google_account_limits()
    assert guide_generation_decision(user) == "allow"
    user = {**user, "guide_generations_used": 1}
    assert guide_generation_decision(user) == "allow"
    user = {**user, "guide_generations_used": 2}
    assert guide_generation_decision(user) == "deny"
    user = {**user, "guide_generations_used": 3}
    assert guide_generation_decision(user) == "deny"


def test_refusal_copy_is_plain_language():
    assert "5 books" in BOOK_LIMIT_DETAIL
    assert "Delete one" in BOOK_LIMIT_DETAIL
    assert "2 reading guides" in GUIDE_GENERATION_LIMIT_DETAIL
