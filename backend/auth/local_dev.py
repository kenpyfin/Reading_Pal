"""Gates for the development login bypass on localhost and private LAN hosts."""

import ipaddress
import os

_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1"})
# Compose attaches the frontend container to a bridge in this range.
# The proxy's TCP peer is that container address, not the browser.
_DOCKER_BRIDGE = ipaddress.ip_network("172.16.0.0/12")


def hostname_from_host_header(value: str) -> str:
    raw = (value or "").split(",")[0].strip()
    if raw.startswith("["):
        end = raw.find("]")
        return raw[1:end].lower() if end != -1 else ""
    return raw.split(":")[0].lower()


def _is_dev_hostname(hostname: str) -> bool:
    """Loopback names, or a private address such as the LAN server 10.0.1.22."""
    if hostname in _LOCAL_HOSTS:
        return True
    try:
        addr = ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return bool(addr.is_private)


def is_local_browser_host(host_header: str, forwarded_host: str | None) -> bool:
    """True when the browser-facing host is localhost or a private LAN address."""
    if not _is_dev_hostname(hostname_from_host_header(host_header)):
        return False
    if forwarded_host:
        if not _is_dev_hostname(hostname_from_host_header(forwarded_host)):
            return False
    return True


def is_trusted_dev_peer(client_host: str | None) -> bool:
    """True for loopback or the Docker bridge peer that proxies localhost.

    Public clients can spoof Host: localhost. The TCP peer cannot be spoofed
    the same way, so a request that arrives from the internet is rejected.
    """
    if not client_host:
        return False
    try:
        addr = ipaddress.ip_address(client_host)
    except ValueError:
        return False
    if addr.is_loopback:
        return True
    return addr in _DOCKER_BRIDGE


def local_dev_login_enabled() -> bool:
    return os.getenv("ALLOW_LOCAL_DEV_LOGIN", "").strip().lower() == "true"


# Existing Google account used by the LAN/localhost tester button.
# Override with LOCAL_DEV_LOGIN_EMAIL. This does not create a new user.
DEFAULT_LOCAL_DEV_EMAIL = "lgyhz1234@gmail.com"


def local_dev_login_email() -> str:
    raw = os.getenv("LOCAL_DEV_LOGIN_EMAIL", DEFAULT_LOCAL_DEV_EMAIL).strip().lower()
    return raw or DEFAULT_LOCAL_DEV_EMAIL
