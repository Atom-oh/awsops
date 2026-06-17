"""
Shared datasource-connector helper for the v1 datasource family (ClickHouse/Prometheus/Loki/Tempo/
Mimir). Each is a user-supplied HTTP endpoint + credential queried in a query language. This module
centralizes: reading the per-slug credential from the single integrations secret, SSRF host guarding
(always-block metadata/loopback/...; private allowed — in-cluster datasources are the target),
auth headers (Basic/Bearer), and a no-redirect HTTP fetch. Stdlib + boto3 only.

SECURITY: never log credential material. The endpoint is user-supplied → assert_host_allowed before
every request; redirects are NOT auto-followed (a malicious endpoint can't 30x to metadata/internal).
KNOWN LIMITATION (accepted, matches agent.py inc2 + ADR-011): resolve-and-recheck, not IP-pinning —
a DNS-rebinding host could resolve safe here and blocked at connect; layered defenses = always-block
+ no-redirect + (for SQL) read-only/table-function guards. IP-pinning deferred.
"""
import base64
import ipaddress
import json
import os
import socket
import urllib.error
import urllib.request
from urllib.parse import urlparse

HTTP_TIMEOUT = 12

_SM = None
_SECRET_CACHE = None


class NotConnected(Exception):
    """Raised when a datasource slug has no stored credential/endpoint."""


class SsrfBlocked(Exception):
    """Raised when an endpoint host/scheme is disallowed."""


# Cloud instance-metadata endpoints blocked even though private is otherwise allowed (mirror agent.py).
_METADATA_IPS = frozenset({
    ipaddress.ip_address("169.254.169.254"),
    ipaddress.ip_address("fd00:ec2::254"),
})


def _ip_always_blocked(ip_str):
    """Metadata, loopback, link-local, multicast, reserved, unspecified — blocked regardless of private."""
    try:
        ip = ipaddress.ip_address(ip_str)
        # Normalize embedded IPv4 so ::ffff:169.254.169.254 / ::ffff:127.0.0.1 / 2002::/16 can't
        # evade the IPv4 metadata/loopback/link-local checks via a dual-stack socket.
        mapped = getattr(ip, "ipv4_mapped", None)
        if mapped is not None:
            ip = mapped
        sixtofour = getattr(ip, "sixtofour", None)
        if sixtofour is not None:
            ip = sixtofour
        if ip in _METADATA_IPS:
            return True
        return ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified
    except ValueError:
        return True  # invalid IP → blocked


def assert_host_allowed(endpoint, resolver=socket.getaddrinfo):
    """Allow only http/https to a host whose every resolved IP is not always-blocked. Private
    (RFC1918/ULA) is ALLOWED — in-cluster datasources are the intended target."""
    parsed = urlparse(endpoint)
    if parsed.scheme not in ("http", "https"):
        raise SsrfBlocked(f"endpoint blocked: scheme '{parsed.scheme}' not allowed (http/https only)")
    host = parsed.hostname
    if not host:
        raise SsrfBlocked(f"endpoint blocked: missing host in URL")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        addr_info = resolver(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise SsrfBlocked(f"endpoint blocked: cannot resolve host {host}: {e}")
    if not addr_info:
        raise SsrfBlocked(f"endpoint blocked: cannot resolve host {host}")
    for entry in addr_info:
        ip_str = entry[4][0]
        if _ip_always_blocked(ip_str):
            raise SsrfBlocked(f"endpoint blocked: {host} resolved to blocked IP {ip_str}")


def auth_headers(creds):
    """Basic (username[/password]) or Bearer (token) or none. Never logged."""
    if creds.get("username"):
        raw = f"{creds['username']}:{creds.get('password', '')}".encode()
        return {"Authorization": "Basic " + base64.b64encode(raw).decode()}
    if creds.get("token"):
        return {"Authorization": f"Bearer {creds['token']}"}
    return {}


def _sm():
    global _SM
    if _SM is None:
        import boto3
        _SM = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
    return _SM


def _load_secret_map():
    global _SECRET_CACHE
    if _SECRET_CACHE is not None:
        return _SECRET_CACHE
    name = os.environ.get("INTEGRATIONS_SECRET_NAME", "ops/awsops-v2/integrations/credentials")
    try:
        raw = _sm().get_secret_value(SecretId=name).get("SecretString", "")
    except Exception as e:  # noqa: BLE001
        if "ResourceNotFound" in type(e).__name__ or "ResourceNotFound" in str(e):
            raw = ""
        else:
            raise
    _SECRET_CACHE = json.loads(raw) if raw else {}
    return _SECRET_CACHE if isinstance(_SECRET_CACHE, dict) else {}


def load_datasource(slug):
    creds = _load_secret_map().get(slug)
    if not isinstance(creds, dict) or not creds.get("endpoint"):
        raise NotConnected(f"{slug} not connected (no endpoint configured in the Connectors UI)")
    return creds


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SsrfBlocked(f"endpoint blocked: redirect to {newurl} not followed")


_opener = urllib.request.build_opener(_NoRedirect)


def _parse(raw):
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except ValueError:
        return {"raw": raw.decode("utf-8", "replace")[:4000]}


def http_json(method, url, headers=None, body=None, timeout=HTTP_TIMEOUT):
    """Send a request (no auto-redirect). Returns (status, parsed_dict). Non-2xx → (status, body)."""
    data = body if isinstance(body, (bytes, bytearray)) else (body.encode() if isinstance(body, str) else None)
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        resp = _opener.open(req, timeout=timeout)
        return resp.getcode(), _parse(resp.read())
    except urllib.error.HTTPError as e:
        try:
            raw = e.read()
        except Exception:  # noqa: BLE001
            raw = b""
        return e.code, _parse(raw)
