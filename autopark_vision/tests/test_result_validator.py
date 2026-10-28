import pytest

from src.result_validator import ResultValidationError, parse_provider_payload, validate_slot_results
from src.schemas import SLOT_IDS, NormalizedROI, PixelROI, ProviderSource, SlotResult, SlotStatus


def make_result(slot_id, status=SlotStatus.EMPTY):
    return SlotResult(slot_id, NormalizedROI(0, 0, 0.1, 0.1), PixelROI(0, 0, 10, 10), status, ProviderSource.MOCK)


@pytest.mark.parametrize(
    "payload,status",
    [
        ('{"status": "EMPTY", "reason": "clear asphalt"}', SlotStatus.EMPTY),
        ({"status": "occupied"}, SlotStatus.OCCUPIED),
        ({"status": " Uncertain ", "reason": None}, SlotStatus.UNCERTAIN),
    ],
)
def test_valid_payloads(payload, status):
    assert parse_provider_payload(payload).status is status


def test_confidence_kept_only_when_valid():
    assert parse_provider_payload({"status": "EMPTY", "confidence": 0.8}).confidence == 0.8
    assert parse_provider_payload({"status": "EMPTY"}).confidence is None


@pytest.mark.parametrize(
    "payload,match",
    [
        ("not json", "not valid JSON"),
        ("[1, 2]", "JSON object"),
        ({}, "missing a string 'status'"),
        ({"status": "FREE"}, "Invalid status"),
        ({"status": "EMPTY", "confidence": 1.5}, "Invalid confidence"),
        ({"status": "EMPTY", "confidence": True}, "Invalid confidence"),
        ({"status": "EMPTY", "reason": 42}, "'reason' must be"),
    ],
)
def test_malformed_payloads(payload, match):
    with pytest.raises(ResultValidationError, match=match):
        parse_provider_payload(payload)


def test_reason_truncated():
    assert len(parse_provider_payload({"status": "EMPTY", "reason": "x" * 1000}).reason) == 300


def test_slot_set_ordered():
    results = validate_slot_results(make_result(s) for s in reversed(SLOT_IDS))
    assert tuple(r.slot_id for r in results) == SLOT_IDS


@pytest.mark.parametrize(
    "ids,match",
    [
        (["S1", "S2", "S3", "S4"], "Missing"),
        (["S1", "S1", "S2", "S3", "S4", "S5"], "Duplicate"),
        (["S1", "S2", "S3", "S4", "S5", "S6"], "Unknown"),
    ],
)
def test_bad_slot_sets(ids, match):
    with pytest.raises(ResultValidationError, match=match):
        validate_slot_results(make_result(s) for s in ids)


def test_invalid_status_type():
    bad = make_result("S1", status="EMPTY")
    with pytest.raises(ResultValidationError, match="invalid status"):
        validate_slot_results([bad] + [make_result(s) for s in SLOT_IDS[1:]])
