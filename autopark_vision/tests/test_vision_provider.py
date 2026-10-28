"""Provider tests. The real Anthropic client is replaced by fakes; no network calls."""

from types import SimpleNamespace

import anthropic
import httpx2 as httpx
import numpy as np
import pytest

from src.schemas import ProviderSource, SlotStatus
from src.slot_detector import crop_slots
from src.vision_provider import (
    AnthropicVisionProvider,
    MockVisionProvider,
    ProviderError,
    get_provider,
)

REQUEST = httpx.Request("POST", "https://api.anthropic.com/v1/messages")


def response(text=None, stop_reason="end_turn"):
    content = [] if text is None else [SimpleNamespace(type="text", text=text)]
    return SimpleNamespace(content=content, stop_reason=stop_reason)


class FakeClient:
    def __init__(self, result):
        self.calls = []
        self.result = result
        self.messages = SimpleNamespace(create=self._create)
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def provider_with(result, **kw):
    client = FakeClient(result)
    return AnthropicVisionProvider(model="claude-opus-5-5", client=client, **kw), client


CROP = np.random.default_rng(1).integers(0, 255, (120, 80, 3), dtype=np.uint8)


# ---------------------------------------------------------------- mock


def test_mock_is_deterministic_and_labelled(lot_image, config):
    provider = MockVisionProvider()
    crops = crop_slots(lot_image, config)
    first = [provider.classify(c.image, c.slot_id) for c in crops]
    second = [provider.classify(c.image, c.slot_id) for c in crops]
    assert first == second
    assert provider.info.source is ProviderSource.MOCK
    assert all(r.confidence is None and "DEMO" in r.reason for r in first)


def test_mock_classifies_synthetic_lot(lot_image, config):
    provider = MockVisionProvider()
    statuses = {c.slot_id: provider.classify(c.image, c.slot_id).status for c in crop_slots(lot_image, config)}
    assert statuses == {
        "S1": SlotStatus.EMPTY, "S2": SlotStatus.OCCUPIED, "S3": SlotStatus.EMPTY,
        "S4": SlotStatus.OCCUPIED, "S5": SlotStatus.EMPTY,
    }


def test_mock_empty_crop_errors():
    with pytest.raises(ProviderError):
        MockVisionProvider().classify(np.zeros((0, 0, 3), np.uint8), "S1")


def test_mock_threshold_validation():
    with pytest.raises(ValueError):
        MockVisionProvider(empty_below=0.5, occupied_above=0.1)


def test_get_provider(monkeypatch, tmp_path):
    import src.local_classifier as lc

    monkeypatch.delenv("AUTOPARK_PROVIDER", raising=False)
    monkeypatch.setattr(lc, "DEFAULT_MODEL_PATH", tmp_path / "missing.onnx")
    assert isinstance(get_provider(), MockVisionProvider)  # no trained model -> mock
    monkeypatch.setenv("AUTOPARK_PROVIDER", "mock")
    assert isinstance(get_provider(), MockVisionProvider)
    with pytest.raises(ValueError):
        get_provider("bogus")


# ---------------------------------------------------------------- AI provider


def test_ai_success_request_shape():
    provider, client = provider_with(response('{"status": "OCCUPIED", "reason": "red car"}'))
    result = provider.classify(CROP, "S3")
    assert result.status is SlotStatus.OCCUPIED
    assert result.reason == "red car"
    assert result.confidence is None
    call = client.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["fallbacks"] == "default"
    assert call["output_config"]["format"]["type"] == "json_schema"
    image_block, text_block = call["messages"][0]["content"]
    assert image_block["source"]["media_type"] == "image/jpeg"
    assert "S3" in text_block["text"]
    assert provider.info.source is ProviderSource.AI


def test_ai_without_fallbacks_uses_plain_endpoint():
    provider, client = provider_with(response('{"status": "EMPTY", "reason": "x"}'), use_fallbacks=False)
    provider.classify(CROP, "S1")
    assert "fallbacks" not in client.calls[0]


def test_ai_confidence_from_model_is_dropped():
    provider, _ = provider_with(response('{"status": "EMPTY", "reason": "x", "confidence": 0.99}'))
    assert provider.classify(CROP, "S1").confidence is None


def test_ai_refusal_becomes_uncertain():
    provider, _ = provider_with(response(None, stop_reason="refusal"))
    result = provider.classify(CROP, "S1")
    assert result.status is SlotStatus.UNCERTAIN and result.error == "refusal"


@pytest.mark.parametrize(
    "resp,match",
    [
        (response("I think it's empty"), "Malformed"),
        (response('{"status": "MAYBE"}'), "Malformed"),
        (response(None), "no text block"),
        (response('{"status": "EM', stop_reason="max_tokens"), "truncated"),
    ],
)
def test_ai_malformed_responses(resp, match):
    provider, _ = provider_with(resp)
    with pytest.raises(ProviderError, match=match):
        provider.classify(CROP, "S1")


def status_error(cls, code):
    return cls("err", response=httpx.Response(code, request=REQUEST), body=None)


@pytest.mark.parametrize(
    "exc,match",
    [
        (status_error(anthropic.AuthenticationError, 401), "credentials"),
        (status_error(anthropic.NotFoundError, 404), "not found"),
        (status_error(anthropic.RateLimitError, 429), "rate limit"),
        (status_error(anthropic.InternalServerError, 500), "error 500"),
        (anthropic.APITimeoutError(request=REQUEST), "timed out"),
        (anthropic.APIConnectionError(request=REQUEST), "connect"),
    ],
)
def test_ai_transport_errors(exc, match):
    provider, _ = provider_with(exc)
    with pytest.raises(ProviderError, match=match):
        provider.classify(CROP, "S1")
