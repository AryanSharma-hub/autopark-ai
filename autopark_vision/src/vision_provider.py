"""Replaceable vision providers that classify a single parking-slot crop.

A provider receives one BGR crop plus its slot ID and returns a validated
``ProviderClassification``. Providers raise ``ProviderError`` on transport or
API failures; the classifier turns those into UNCERTAIN results.

* ``AnthropicVisionProvider`` - real AI classification via the Claude API.
* ``MockVisionProvider``      - deterministic offline heuristic. DEMO DATA ONLY.
"""

from __future__ import annotations

import base64
import os
from typing import Optional, Protocol, runtime_checkable

import cv2
import numpy as np

from .image_loader import encode_jpeg
from .result_validator import ResultValidationError, parse_provider_payload
from .schemas import ProviderClassification, ProviderInfo, ProviderSource, SlotStatus

ENV_PROVIDER = "AUTOPARK_PROVIDER"  # "ai" | "mock"
ENV_MODEL = "AUTOPARK_AI_MODEL"
ENV_TIMEOUT = "AUTOPARK_AI_TIMEOUT_SECONDS"
ENV_FALLBACKS = "AUTOPARK_AI_FALLBACKS"  # "1" (default) enables server-side refusal fallback
DEFAULT_MODEL = "claude-opus-5-5"

CLASSIFICATION_PROMPT = (
    "This image is a crop of exactly one parking space ({slot_id}) taken from a fixed "
    "camera looking at a small parking lot (it may be a scale model with toy cars). "
    "Decide whether a vehicle occupies this parking space.\n"
    "- EMPTY: the space is clearly vacant.\n"
    "- OCCUPIED: a vehicle (full-size or model car) occupies the space, even partially.\n"
    "- UNCERTAIN: the crop is ambiguous, blurred, obstructed, badly lit, or does not "
    "appear to show a parking space.\n"
    "Give a short reason (one sentence) describing what you see."
)

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["EMPTY", "OCCUPIED", "UNCERTAIN"]},
        "reason": {"type": "string"},
    },
    "required": ["status", "reason"],
    "additionalProperties": False,
}


class ProviderError(RuntimeError):
    """Raised when a provider cannot produce a classification."""


@runtime_checkable
class VisionProvider(Protocol):
    @property
    def info(self) -> ProviderInfo: ...

    def classify(self, crop: np.ndarray, slot_id: str) -> ProviderClassification: ...


class MockVisionProvider:
    """Deterministic edge-density heuristic for offline tests and demos.

    Its output is DEMO DATA. It is not an AI prediction and has no measured
    accuracy on real parking images.
    """

    def __init__(self, empty_below: float = 0.01, occupied_above: float = 0.03):
        if not 0.0 <= empty_below < occupied_above <= 1.0:
            raise ValueError("Require 0 <= empty_below < occupied_above <= 1.")
        self.empty_below = empty_below
        self.occupied_above = occupied_above

    @property
    def info(self) -> ProviderInfo:
        return ProviderInfo(source=ProviderSource.MOCK, name="mock-edge-density")

    @staticmethod
    def edge_density(crop: np.ndarray) -> float:
        grey = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        grey = cv2.GaussianBlur(grey, (5, 5), 0)
        edges = cv2.Canny(grey, 50, 150)
        return float(np.count_nonzero(edges)) / edges.size

    def classify(self, crop: np.ndarray, slot_id: str) -> ProviderClassification:
        if crop.size == 0:
            raise ProviderError(f"{slot_id}: empty crop.")
        density = self.edge_density(crop)
        if density < self.empty_below:
            status = SlotStatus.EMPTY
        elif density > self.occupied_above:
            status = SlotStatus.OCCUPIED
        else:
            status = SlotStatus.UNCERTAIN
        return ProviderClassification(
            status=status,
            confidence=None,
            reason=f"DEMO heuristic, not AI: edge density {density:.3f}.",
        )


class AnthropicVisionProvider:
    """Classifies crops with a Claude vision model via the official Anthropic SDK.

    Credentials come from the environment (ANTHROPIC_API_KEY, or an
    ``ant auth login`` profile); nothing is read from source code. Claude does
    not return a calibrated probability, so ``confidence`` is always None.
    """

    def __init__(
        self,
        model: Optional[str] = None,
        timeout_seconds: Optional[float] = None,
        use_fallbacks: Optional[bool] = None,
        client=None,
    ):
        self.model = model or os.getenv(ENV_MODEL, DEFAULT_MODEL)
        self.timeout_seconds = timeout_seconds or float(os.getenv(ENV_TIMEOUT, "60"))
        if use_fallbacks is None:
            use_fallbacks = os.getenv(ENV_FALLBACKS, "1").strip() not in ("0", "false", "no")
        self.use_fallbacks = use_fallbacks
        if client is None:
            try:
                import anthropic
            except ImportError as exc:  # pragma: no cover - depends on install
                raise ProviderError(
                    "The 'anthropic' package is not installed. Run: pip install -r requirements.txt"
                ) from exc
            client = anthropic.Anthropic(timeout=self.timeout_seconds, max_retries=2)
        self._client = client

    @property
    def info(self) -> ProviderInfo:
        return ProviderInfo(source=ProviderSource.AI, name="anthropic", model=self.model)

    def _request(self, image_b64: str, slot_id: str):
        params = dict(
            model=self.model,
            max_tokens=4096,
            output_config={
                "effort": "low",
                "format": {"type": "json_schema", "schema": RESPONSE_SCHEMA},
            },
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/jpeg",
                                "data": image_b64,
                            },
                        },
                        {"type": "text", "text": CLASSIFICATION_PROMPT.format(slot_id=slot_id)},
                    ],
                }
            ],
        )
        if self.use_fallbacks:
            # Server-side refusal fallback: a declined request is re-run on a
            # recommended fallback model inside the same call.
            return self._client.beta.messages.create(
                betas=["server-side-fallback-2026-07-01"], fallbacks="default", **params
            )
        return self._client.messages.create(**params)

    def classify(self, crop: np.ndarray, slot_id: str) -> ProviderClassification:
        import anthropic

        if crop.size == 0:
            raise ProviderError(f"{slot_id}: empty crop.")
        image_b64 = base64.standard_b64encode(encode_jpeg(crop)).decode("ascii")

        try:
            response = self._request(image_b64, slot_id)
        except anthropic.AuthenticationError as exc:
            raise ProviderError("AI provider rejected the credentials (401). Check ANTHROPIC_API_KEY.") from exc
        except anthropic.NotFoundError as exc:
            raise ProviderError(f"Model '{self.model}' not found (404). Check {ENV_MODEL}.") from exc
        except anthropic.RateLimitError as exc:
            raise ProviderError("AI provider rate limit reached (429). Retry shortly.") from exc
        except anthropic.APIStatusError as exc:
            raise ProviderError(f"AI provider error {exc.status_code}: {exc.message}") from exc
        except anthropic.APITimeoutError as exc:
            raise ProviderError(f"AI provider timed out after {self.timeout_seconds:.0f}s.") from exc
        except anthropic.APIConnectionError as exc:
            raise ProviderError("Could not connect to the AI provider. Check network access.") from exc

        if response.stop_reason == "refusal":
            return ProviderClassification(
                status=SlotStatus.UNCERTAIN,
                reason="AI provider declined to classify this image.",
                error="refusal",
            )
        if response.stop_reason == "max_tokens":
            raise ProviderError("AI response was truncated (max_tokens).")

        text = next((b.text for b in response.content if b.type == "text"), None)
        if text is None:
            raise ProviderError("AI response contained no text block.")
        try:
            result = parse_provider_payload(text)
        except ResultValidationError as exc:
            raise ProviderError(f"Malformed AI response: {exc}") from exc
        # The model's own wording is not a calibrated score; never report one.
        return ProviderClassification(status=result.status, confidence=None, reason=result.reason)


def ai_credentials_present() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN"))


def get_provider(name: Optional[str] = None) -> VisionProvider:
    """Build a provider by name ("local", "ai" or "mock").

    Default: AUTOPARK_PROVIDER, else "local" when a trained model is present, else "mock".
    """
    if not name and not os.getenv(ENV_PROVIDER):
        from .local_classifier import DEFAULT_MODEL_PATH

        name = "local" if DEFAULT_MODEL_PATH.is_file() else "mock"
    name = (name or os.getenv(ENV_PROVIDER, "mock")).strip().lower()
    if name == "mock":
        return MockVisionProvider()
    if name == "local":
        from .local_classifier import LocalModelProvider

        return LocalModelProvider()
    if name == "ai":
        return AnthropicVisionProvider()
    raise ValueError(f"Unknown provider '{name}'. Use 'local', 'ai' or 'mock'.")
