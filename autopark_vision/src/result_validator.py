"""Validate provider output and the final five-slot result set."""

from __future__ import annotations

import json
import math
from typing import Any, Iterable

from .schemas import SLOT_IDS, ProviderClassification, SlotResult, SlotStatus

MAX_REASON_CHARS = 300


class ResultValidationError(ValueError):
    """Raised when classification output is malformed or inconsistent."""


def parse_provider_payload(payload: Any) -> ProviderClassification:
    """Turn a raw provider answer (dict or JSON text) into a validated classification.

    Expected shape: {"status": "EMPTY|OCCUPIED|UNCERTAIN", "reason": str?,
    "confidence": float in [0, 1]?}. Raises ResultValidationError otherwise.
    """
    if isinstance(payload, (str, bytes)):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise ResultValidationError(f"Provider response is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ResultValidationError("Provider response must be a JSON object.")

    raw_status = payload.get("status")
    if not isinstance(raw_status, str):
        raise ResultValidationError("Provider response is missing a string 'status'.")
    try:
        status = SlotStatus(raw_status.strip().upper())
    except ValueError as exc:
        raise ResultValidationError(
            f"Invalid status '{raw_status}'. Expected one of {[s.value for s in SlotStatus]}."
        ) from exc

    confidence = payload.get("confidence")
    if confidence is not None:
        if (
            isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
            or not math.isfinite(confidence)
            or not 0.0 <= confidence <= 1.0
        ):
            raise ResultValidationError(f"Invalid confidence {confidence!r}; expected 0..1 or null.")
        confidence = float(confidence)

    reason = payload.get("reason")
    if reason is not None:
        if not isinstance(reason, str):
            raise ResultValidationError("'reason' must be a string or null.")
        reason = reason.strip()[:MAX_REASON_CHARS] or None

    return ProviderClassification(status=status, confidence=confidence, reason=reason)


def validate_slot_results(results: Iterable[SlotResult]) -> tuple[SlotResult, ...]:
    """Require exactly one result per slot S1-S5 with a valid status; return them ordered."""
    results = tuple(results)
    ids = [r.slot_id for r in results]
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        raise ResultValidationError(f"Duplicate slot ids in results: {duplicates}.")
    unknown = sorted(set(ids) - set(SLOT_IDS))
    if unknown:
        raise ResultValidationError(f"Unknown slot ids in results: {unknown}.")
    missing = [s for s in SLOT_IDS if s not in ids]
    if missing:
        raise ResultValidationError(f"Missing slot ids in results: {missing}.")
    for r in results:
        if not isinstance(r.status, SlotStatus):
            raise ResultValidationError(f"{r.slot_id} has invalid status {r.status!r}.")
    return tuple(sorted(results, key=lambda r: SLOT_IDS.index(r.slot_id)))
