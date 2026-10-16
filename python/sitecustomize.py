"""Staleproof sandbox shim, loaded automatically through PYTHONPATH.

Docs examples connect to FalkorDB on localhost:6379. Inside the sandbox that
address is remapped to a scratch FalkorDB, and every other outbound connection
is refused, so an example can neither touch a real database nor reach the
network.
"""
import errno
import os
import socket

def _setting(name, default):
    return os.environ.get("STALEPROOF_" + name, os.environ.get("LOCKSTEP_" + name, default))


_SCRATCH_HOST = _setting("SCRATCH_HOST", "127.0.0.1")
_SCRATCH_PORT = int(_setting("SCRATCH_PORT", "6390"))
_DB_PORTS = {int(p) for p in _setting("DB_PORTS", "6379").split(",") if p}
_LOCAL = {"localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal", "falkordb", ""}

_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex


def _remap(address):
    if not isinstance(address, tuple) or len(address) < 2:
        return address  # unix sockets and the like
    host, port = address[0], address[1]
    if host in _LOCAL and port in _DB_PORTS:
        return (_SCRATCH_HOST, _SCRATCH_PORT)
    if host in (_SCRATCH_HOST, "localhost", "127.0.0.1") and port == _SCRATCH_PORT:
        return (_SCRATCH_HOST, _SCRATCH_PORT)
    raise OSError(
        errno.ECONNREFUSED,
        "Staleproof sandbox: outbound network is disabled (tried %s:%s); only FalkorDB on localhost:6379 is available" % (host, port),
    )


def _connect(self, address):
    if self.family in (socket.AF_INET, socket.AF_INET6):
        address = _remap(address)
    return _real_connect(self, address)


def _connect_ex(self, address):
    try:
        _connect(self, address)
        return 0
    except BlockingIOError:
        return errno.EINPROGRESS
    except OSError as e:
        return e.errno or errno.ECONNREFUSED


socket.socket.connect = _connect
socket.socket.connect_ex = _connect_ex

_real_getaddrinfo = socket.getaddrinfo


def _getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    # Resolve every name to IPv4 loopback so nothing tries IPv6 or real DNS.
    if host in _LOCAL or host is None:
        return _real_getaddrinfo("127.0.0.1", port, socket.AF_INET, type, proto, flags)
    raise socket.gaierror(socket.EAI_NONAME, "Staleproof sandbox: DNS is disabled (%s)" % host)


socket.getaddrinfo = _getaddrinfo
