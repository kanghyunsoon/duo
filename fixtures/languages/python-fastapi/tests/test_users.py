import pytest

from app.users import create_user


def test_create_user_trims_the_name():
    assert create_user("  ada ") == {"name": "ada"}
