"""Bounded CLI and private-file primitives for operator release controllers."""
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess

ROOT = Path(__file__).resolve().parents[2]
MAX_JSON = 4 * 1024 * 1024


class ReleaseError(Exception):
    """Only static, non-sensitive error codes cross the CLI boundary."""


def require(condition, code):
    if not condition:
        raise ReleaseError(code)


def sha256_digest(value):
    return isinstance(value, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", value) is not None


def nonnegative_integer(value):
    return type(value) is int and value >= 0


def decode_json(text):
    def pairs(items):
        obj = {}
        for key, value in items:
            require(key not in obj, "invalid_json")
            obj[key] = value
        return obj

    def invalid_constant(_):
        raise ReleaseError("invalid_json")

    try:
        require(len(text) <= MAX_JSON, "response_too_large")
        return json.loads(text, object_pairs_hook=pairs, parse_constant=invalid_constant)
    except (ValueError, TypeError, UnicodeError):
        raise ReleaseError("invalid_json") from None


def command(argv, *, timeout=60, env=None):
    """Capture both streams. Kill the entire command group on a bounded timeout."""
    child_env = dict(os.environ if env is None else env)
    child_env.update(AWS_PAGER="", AWS_CLI_AUTO_PROMPT="off")
    try:
        proc = subprocess.Popen(
            list(argv), cwd=ROOT, env=child_env, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, start_new_session=True,
        )
        try:
            stdout, _ = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                # A detached descendant may retain pipe handles after the group
                # dies. Do not turn timeout cleanup into an unbounded second wait.
                proc.stdout.close()
                proc.stderr.close()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
            raise ReleaseError("command_timeout") from None
        require(proc.returncode == 0, "command_failed")
        return stdout.strip()
    except (OSError, UnicodeError):
        raise ReleaseError("command_failed") from None


def private_bytes(path, limit=MAX_JSON):
    """Reject symlinks, devices/FIFOs, wrong ownership and group/world permissions."""
    require(path.is_absolute(), "private_file_invalid")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as file:
            info = os.fstat(file.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                    and not info.st_mode & 0o077 and info.st_size <= limit, "private_file_invalid")
            data = file.read(limit + 1)
            require(len(data) <= limit, "private_file_invalid")
            return data
    except OSError:
        raise ReleaseError("private_file_invalid") from None
