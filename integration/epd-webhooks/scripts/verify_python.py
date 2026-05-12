"""EPD webhook signature verifier — Python, stdlib only.

Mirrors WebhookSigningService in the EPD backend:
    header:  EPD-Signature: t=<unix_seconds>,v1=<hex_sha256>
    signed:  HMAC-SHA256(secret, f"{timestamp}.{raw_body}")
    replay:  reject if |now - t| > tolerance_seconds (default 300)
"""

from __future__ import annotations

import hashlib
import hmac
import time
from dataclasses import dataclass
from typing import Union

SIGNATURE_VERSION = "v1"
DEFAULT_TOLERANCE_SECONDS = 300
SIGNING_SECRET_PREFIX = "whsec_"


@dataclass(frozen=True)
class VerifyResult:
    valid: bool
    reason: str | None = None


def verify_webhook(
    payload: Union[str, bytes],
    signature_header: str,
    secret: str,
    tolerance_seconds: int = DEFAULT_TOLERANCE_SECONDS,
) -> VerifyResult:
    """Verify an EPD webhook signature.

    Args:
        payload: Raw request body — exact bytes as received. Pass ``bytes``
            from your framework (``request.body``, ``request.get_data()``, etc.)
            rather than re-serialized JSON.
        signature_header: Value of the ``EPD-Signature`` header.
        secret: Endpoint signing secret (``whsec_...``).
        tolerance_seconds: Replay window.

    Returns:
        ``VerifyResult(valid=True)`` if the signature checks out; otherwise
        ``VerifyResult(valid=False, reason=<machine-readable code>)``.
    """
    if not signature_header or not isinstance(signature_header, str):
        return VerifyResult(False, "missing_signature_header")
    if not secret or not isinstance(secret, str):
        return VerifyResult(False, "missing_secret")

    parsed = _parse_signature_header(signature_header)
    if parsed is None:
        return VerifyResult(False, "malformed_signature_header")
    timestamp, signature_hex = parsed

    now = int(time.time())
    if abs(now - timestamp) > tolerance_seconds:
        return VerifyResult(False, "timestamp_outside_tolerance")

    payload_bytes = payload.encode("utf-8") if isinstance(payload, str) else payload
    signed_payload = f"{timestamp}.".encode("utf-8") + payload_bytes

    # EPD strips the `whsec_` prefix before HMAC. Mirror that behavior so the
    # caller can pass the secret as-is from their secret store.
    hmac_key = secret[len(SIGNING_SECRET_PREFIX):] if secret.startswith(SIGNING_SECRET_PREFIX) else secret
    expected = hmac.new(hmac_key.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()

    try:
        expected_b = bytes.fromhex(expected)
        actual_b = bytes.fromhex(signature_hex)
    except ValueError:
        return VerifyResult(False, "malformed_signature_hex")

    if not hmac.compare_digest(expected_b, actual_b):
        return VerifyResult(False, "signature_mismatch")
    return VerifyResult(True)


def _parse_signature_header(header: str) -> tuple[int, str] | None:
    timestamp: int | None = None
    signature: str | None = None
    for part in header.split(","):
        if "=" not in part:
            continue
        k, _, v = part.partition("=")
        k, v = k.strip(), v.strip()
        if k == "t":
            try:
                n = int(v)
                if n > 0:
                    timestamp = n
            except ValueError:
                pass
        elif k == SIGNATURE_VERSION:
            signature = v
    if timestamp is None or signature is None:
        return None
    return timestamp, signature


# ----- Self-test (runs only when invoked directly) -----
if __name__ == "__main__":
    import json

    secret = "whsec_test1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
    body = json.dumps({"id": "evt_test", "type": "order.succeeded", "data": {"id": "ord_123"}})
    ts = int(time.time())
    hmac_key = secret[len(SIGNING_SECRET_PREFIX):]
    sig = hmac.new(hmac_key.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    header = f"t={ts},v1={sig}"

    print("valid signature:", verify_webhook(body, header, secret))
    print("tampered body:  ", verify_webhook(body + "x", header, secret))
    print("expired:        ", verify_webhook(body, f"t={ts - 1000},v1={sig}", secret))
    print("malformed:      ", verify_webhook(body, "not a signature", secret))
