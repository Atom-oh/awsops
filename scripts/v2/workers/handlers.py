"""AWSops v2 P2 — job-type registry. READ/COMPUTE only (no mutate ops until P3 ADR-029 controls).
Each handler: (payload: dict, dry_run: bool) -> (result_dict_or_None, artifact_bytes_or_None).
P2 ships ONE synthetic proof handler ('noop') exercising sleep / memory / optional OOM."""
import time


def _noop(payload, dry_run):
    secs = int(payload.get("sleep_s", 0))
    mb = int(payload.get("alloc_mb", 0))
    if dry_run:
        return {"dry_run": True, "would_sleep_s": secs, "would_alloc_mb": mb}, None
    if secs:
        time.sleep(secs)
    blob = bytearray(mb * 1024 * 1024) if mb else None
    out = {"slept_s": secs, "alloc_mb": mb, "ok": True}
    del blob
    return out, None


# type -> (handler, runtime). runtime drives SFN routing (lambda<15min / fargate long+heavy).
REGISTRY = {
    "noop":       (_noop, "lambda"),
    "noop-heavy": (_noop, "fargate"),
}


def is_allowed(type_):
    return type_ in REGISTRY


def runtime_for(type_):
    return REGISTRY[type_][1]
