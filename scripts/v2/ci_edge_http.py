"""Optional CloudFront connection target; application Host/SNI/TLS stay unchanged."""
import http.client
import re
import socket
import ssl
import urllib.request

from ci_origin_common import require


def cloudfront_domain(value):
    if not value:
        return None
    require(isinstance(value, str) and re.fullmatch(r"d[a-z0-9]{3,63}\.cloudfront\.net", value),
            "invalid_cloudfront_domain")
    return value


class EdgeHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, hostname, edge, *, context=None):
        require(isinstance(hostname, str) and re.fullmatch(r"[a-z0-9][a-z0-9.-]+", hostname),
                "invalid_edge_origin")
        self.hostname = hostname
        self.edge = cloudfront_domain(edge)
        require(self.edge is not None, "invalid_cloudfront_domain")
        require(context is None or (context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname),
                "unverified_tls_forbidden")
        super().__init__(context=context)

    def https_open(self, request):
        def connection(host, **kwargs):
            result = http.client.HTTPSConnection(host, **kwargs)
            require(result.host == self.hostname and result.port == 443, "edge_origin_mismatch")

            def connect(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
                require(address == (self.hostname, 443), "edge_origin_mismatch")
                return socket.create_connection((self.edge, 443), timeout, source_address)

            # HTTPSConnection still wraps this socket using its original host
            # for SNI and certificate verification; HTTP Host/cookies use that
            # same application URL. Only DNS/TCP destination is substituted.
            result._create_connection = connect
            return result

        return self.do_open(connection, request, context=self._context)
