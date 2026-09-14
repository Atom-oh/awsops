"""Real TLS verifies original SNI/Host while only the TCP destination changes."""
import http.cookiejar
import http.server
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from ci_edge_http import EdgeHTTPSHandler, cloudfront_domain
from ci_origin_common import ReleaseError

ORIGIN = "service.example.test"
EDGE = "d123example.cloudfront.net"


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.seen = []
        self.sni = []

    def server(self, hostname):
        root = Path(self.directory.name)
        key, cert = root / "key.pem", root / "cert.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-keyout", str(key), "-out", str(cert), "-days", "1",
                        "-subj", "/CN=" + hostname, "-addext", "subjectAltName=DNS:" + hostname],
                       check=True, capture_output=True)
        key.chmod(0o600)
        seen = self.seen

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                seen.append((self.headers["Host"], json.loads(
                    self.rfile.read(int(self.headers["Content-Length"])))))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Set-Cookie", "awsops_token=fixture; Path=/; Secure; HttpOnly")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            def do_GET(self):
                seen.append((self.headers["Host"], self.headers.get("Cookie")))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        context.set_servername_callback(lambda sock, name, ctx: self.sni.append(name))
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        client = ssl.create_default_context(cafile=str(cert))
        return server.server_address, client

    def opener(self, context):
        jar = http.cookiejar.CookieJar()
        return urllib.request.build_opener(
            urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar),
            EdgeHTTPSHandler(ORIGIN, EDGE, context=context)), jar

    def test_preserves_sni_host_password_body_and_cookie_scope(self):
        address, context = self.server(ORIGIN)
        opener, jar = self.opener(context)
        connect = socket.create_connection
        targets = []

        def route(target, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
            targets.append(target)
            self.assertEqual(target, (EDGE, 443))
            return connect(address, timeout, source_address)

        with patch("socket.create_connection", side_effect=route):
            request = urllib.request.Request("https://" + ORIGIN + "/api/auth/login",
                data=json.dumps({"email": "fixture@example.test", "password": "fixture-only"}).encode(),
                headers={"Content-Type": "application/json"})
            with opener.open(request, timeout=5) as response:
                self.assertEqual(response.status, 200)
            with opener.open("https://" + ORIGIN + "/api/me", timeout=5) as response:
                self.assertEqual(response.status, 200)
        self.assertEqual(self.sni, [ORIGIN, ORIGIN])
        self.assertEqual(self.seen[0][0], ORIGIN)
        self.assertEqual(self.seen[1], (ORIGIN, "awsops_token=fixture"))
        self.assertEqual([cookie.domain for cookie in jar], [ORIGIN])
        self.assertEqual(targets, [(EDGE, 443), (EDGE, 443)])

    def test_wrong_certificate_hostname_is_rejected(self):
        address, context = self.server("wrong.example.test")
        opener, _ = self.opener(context)
        connect = socket.create_connection
        with patch("socket.create_connection", side_effect=lambda *args, **kwargs: connect(address)):
            with self.assertRaises(urllib.error.URLError) as failure:
                opener.open("https://" + ORIGIN + "/api/health", timeout=5)
        self.assertIsInstance(failure.exception.reason, ssl.SSLCertVerificationError)
        self.assertEqual(self.seen, [])

    def test_foreign_origin_fails_before_connecting(self):
        opener, _ = self.opener(ssl.create_default_context())
        with patch("socket.create_connection") as connect:
            with self.assertRaises(ReleaseError):
                opener.open("https://other.example.test/api/auth/login", data=b"fixture", timeout=5)
            connect.assert_not_called()

    def test_only_owned_metadata_shape_and_verified_tls_are_accepted(self):
        self.assertIsNone(cloudfront_domain(""))
        self.assertEqual(cloudfront_domain(EDGE), EDGE)
        for value in ["127.0.0.1", "localhost", EDGE + ".evil.test", EDGE + ":443",
                      "https://" + EDGE, "user@" + EDGE, EDGE + "\n"]:
            with self.subTest(value=value), self.assertRaises(ReleaseError):
                cloudfront_domain(value)
        with self.assertRaises(ReleaseError):
            EdgeHTTPSHandler(ORIGIN, EDGE, context=ssl._create_unverified_context())


if __name__ == "__main__":
    unittest.main()
