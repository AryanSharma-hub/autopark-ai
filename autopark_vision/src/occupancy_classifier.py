"""Service interface: one image in, five validated slot classifications out.

Pipeline: decode -> crop ROIs -> compatibility check -> per-slot inference
-> validation -> summary. Annotation is a separate step (image_annotator).
Nothing here depends on Streamlit, so a FastAPI route can call
``analyze_image_bytes`` directly.
"""

from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Iterable, Optional

import numpy as np

from .image_loader import load_image_bytes, validate_image
from .result_validator import validate_slot_results
from .roi_manager import load_config
from .schemas import (
    AnalysisReport,
    OccupancySummary,
    ProviderClassification,
    ROIConfig,
    SlotResult,
    SlotStatus,
)
from .slot_detector import check_compatibility, crop_slots
from .vision_provider import ProviderError, VisionProvider, get_provider


class IncompatibleImageError(ValueError):
    """Raised in strict mode when the image does not fit the ROI layout."""

    def __init__(self, warnings: Iterable[str]):
        self.warnings = tuple(warnings)
        super().__init__("Image is incompatible with the ROI layout: " + " ".join(self.warnings))


def summarize(results: Iterable[SlotResult]) -> OccupancySummary:
    results = tuple(results)
    count = lambda status: sum(1 for r in results if r.status is status)  # noqa: E731
    return OccupancySummary(
        empty=count(SlotStatus.EMPTY),
        occupied=count(SlotStatus.OCCUPIED),
        uncertain=count(SlotStatus.UNCERTAIN),
        total=len(results),
        empty_slot_ids=tuple(r.slot_id for r in results if r.status is SlotStatus.EMPTY),
    )


def _classify_safely(provider: VisionProvider, crop, slot_id: str) -> ProviderClassification:
    try:
        return provider.classify(crop, slot_id)
    except ProviderError as exc:
        return ProviderClassification(SlotStatus.UNCERTAIN, reason="Provider failure.", error=str(exc))
    except Exception as exc:  # a provider bug must not crash the whole analysis
        return ProviderClassification(
            SlotStatus.UNCERTAIN, reason="Unexpected provider error.", error=f"{type(exc).__name__}: {exc}"
        )


def analyze_image(
    image: np.ndarray,
    config: Optional[ROIConfig] = None,
    provider: Optional[VisionProvider] = None,
    *,
    strict: bool = False,
    image_filename: Optional[str] = None,
    max_workers: int = 5,
) -> AnalysisReport:
    """Classify the five configured slots of a BGR image.

    strict=True raises IncompatibleImageError instead of classifying an image
    that does not match the layout; otherwise the report carries
    ``layout_compatible=False`` and the warnings.
    """
    validate_image(image)
    config = config or load_config()
    provider = provider or get_provider()

    crops = crop_slots(image, config)
    compat = check_compatibility(image, config, crops)
    if strict and not compat.compatible:
        raise IncompatibleImageError(compat.warnings)

    with ThreadPoolExecutor(max_workers=max(1, min(max_workers, len(crops)))) as pool:
        answers = list(pool.map(lambda c: _classify_safely(provider, c.image, c.slot_id), crops))

    source = provider.info.source
    results = validate_slot_results(
        SlotResult(
            slot_id=c.slot_id,
            roi_normalized=c.roi_normalized,
            roi_pixels=c.roi_pixels,
            status=a.status,
            source=source,
            confidence=a.confidence,
            reason=a.reason,
            error=a.error,
        )
        for c, a in zip(crops, answers)
    )

    warnings = list(compat.warnings)
    failed = [r.slot_id for r in results if r.error]
    if failed:
        warnings.append(f"Provider failed for {', '.join(failed)}; those slots are UNCERTAIN.")

    height, width = image.shape[:2]
    return AnalysisReport(
        analysis_id=str(uuid.uuid4()),
        timestamp=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        provider=provider.info,
        image_width=width,
        image_height=height,
        image_filename=image_filename,
        layout_name=config.layout_name,
        roi_placeholder=config.placeholder,
        layout_compatible=compat.compatible,
        slots=results,
        summary=summarize(results),
        warnings=tuple(warnings),
    )


def analyze_image_bytes(
    data: bytes,
    filename: Optional[str] = None,
    config: Optional[ROIConfig] = None,
    provider: Optional[VisionProvider] = None,
    *,
    strict: bool = False,
) -> AnalysisReport:
    """Entry point for upload-style callers (Streamlit today, FastAPI later)."""
    image = load_image_bytes(data, filename)
    return analyze_image(image, config, provider, strict=strict, image_filename=filename)
