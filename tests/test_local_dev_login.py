import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from backend.auth.local_dev import (
    is_local_browser_host,
    is_trusted_dev_peer,
    local_dev_login_email,
    local_dev_login_enabled,
)


def test_local_browser_host_accepts_localhost_with_port():
    assert is_local_browser_host("localhost:3100", None) is True
    assert is_local_browser_host("127.0.0.1:8501", None) is True


def test_local_browser_host_accepts_private_lan_address():
    assert is_local_browser_host("10.0.1.22:3100", None) is True
    assert is_local_browser_host("10.0.1.22:3100", "10.0.1.22:3100") is True
    assert is_local_browser_host("192.168.1.22", None) is True


def test_local_browser_host_rejects_public_and_mismatched_forwarded_host():
    assert is_local_browser_host("readingpal.kenpyfin.com", None) is False
    assert is_local_browser_host("8.8.8.8", None) is False
    assert is_local_browser_host("localhost:3100", "readingpal.kenpyfin.com") is False
    assert is_local_browser_host("10.0.1.22:3100", "readingpal.kenpyfin.com") is False


def test_trusted_peer_allows_loopback_and_docker_bridge_only():
    assert is_trusted_dev_peer("127.0.0.1") is True
    assert is_trusted_dev_peer("::1") is True
    assert is_trusted_dev_peer("172.18.0.4") is True
    assert is_trusted_dev_peer("192.168.1.20") is False
    assert is_trusted_dev_peer("8.8.8.8") is False
    assert is_trusted_dev_peer(None) is False


def test_local_dev_login_email_defaults_to_existing_gmail(monkeypatch):
    monkeypatch.delenv("LOCAL_DEV_LOGIN_EMAIL", raising=False)
    assert local_dev_login_email() == "lgyhz1234@gmail.com"
    monkeypatch.setenv("LOCAL_DEV_LOGIN_EMAIL", " Other@Example.com ")
    assert local_dev_login_email() == "other@example.com"


def test_local_dev_login_requires_explicit_true(monkeypatch):
    monkeypatch.delenv("ALLOW_LOCAL_DEV_LOGIN", raising=False)
    assert local_dev_login_enabled() is False
    monkeypatch.setenv("ALLOW_LOCAL_DEV_LOGIN", "true")
    assert local_dev_login_enabled() is True
    monkeypatch.setenv("ALLOW_LOCAL_DEV_LOGIN", "false")
    assert local_dev_login_enabled() is False
