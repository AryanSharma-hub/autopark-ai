"""JSON-serializable data contracts for the five-slot parking classifier.

These types are deliberately free of Streamlit, OpenCV and provider SDK objects
so they can be returned unchanged from a future FastAPI endpoint
(``POST /api/parking/analyze``) and consumed by the React Native app.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Optional

SCHEMA_VERSION = "1.0"

# Stable logical slot IDs. These map 1:1 to the five physical slots of the
# cardboard lot and must not be renamed or reordered.
SLOT_IDS: tuple[str, ...] = ("S1", "S2", "S3", "S4", "S5")


class SlotStatus(str, Enum):
    EMPTY = "EMPTY"
    OCCUPIED = "OCCUPIED"
    UNCERTAIN = "UNCERTAIN"


class ProviderSource(str, Enum):
    AI = "ai"
    MOCK = "mock"


@dataclass(frozen=True)
class NormalizedROI:
    """Slot rectangle as fractions of image width/height (0..1)."""

    x: float
    y: float
    w: float
    h: float

    def to_dict(self) -> dict[str, float]:
        return asdict(self)


@dataclass(frozen=True)
class PixelROI:
    x: int
    y: int
    w: int
    h: int

    def to_dict(self) -> dict[str, int]:
        return asdict(self)


@dataclass(frozen=True)
class SlotDefinition:
    slot_id: str
    roi: NormalizedROI


@dataclass(frozen=True)
class ROIConfig:
    layout_name: str
    slots: tuple[SlotDefinition, ...]
    reference_width: int
    reference_height: int
    aspect_ratio_tolerance: float = 0.15
    placeholder: bool = True
    version: int = 1

    @property
    def reference_aspect_ratio(self) -> float:
        return self.reference_width / self.reference_height

    def slot(self, slot_id: str) -> SlotDefinition:
        for slot in self.slots:
            if slot.slot_id == slot_id:
                return slot
        raise KeyError(slot_id)

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "layout_name": self.layout_name,
            "placeholder": self.placeholder,
            "reference_resolution": {
                "width": self.reference_width,
                "height": self.reference_height,
            },
            "aspect_ratio_tolerance": self.aspect_ratio_tolerance,
            "slots": [{"id": s.slot_id, **s.roi.to_dict()} for s in self.slots],
        }


@dataclass(frozen=True)
class ProviderClassification:
    """One provider answer for one slot, after validation."""

    status: SlotStatus
    confidence: Optional[float] = None  # None = provider gave no meaningful score
    reason: Optional[str] = None
    error: Optional[str] = None


@dataclass(frozen=True)
class SlotResult:
    slot_id: str
    roi_normalized: NormalizedROI
    roi_pixels: PixelROI
    status: SlotStatus
    source: ProviderSource
    confidence: Optional[float] = None
    reason: Optional[str] = None
    error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "slot_id": self.slot_id,
            "roi": {
                "normalized": self.roi_normalized.to_dict(),
                "pixels": self.roi_pixels.to_dict(),
            },
            "status": self.status.value,
            "confidence": self.confidence,
            "reason": self.reason,
            "source": self.source.value,
            "error": self.error,
        }


@dataclass(frozen=True)
class OccupancySummary:
    empty: int
    occupied: int
    uncertain: int
    total: int
    empty_slot_ids: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "empty": self.empty,
            "occupied": self.occupied,
            "uncertain": self.uncertain,
            "total": self.total,
            "empty_slot_ids": list(self.empty_slot_ids),
        }


@dataclass(frozen=True)
class ProviderInfo:
    source: ProviderSource
    name: str
    model: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {"source": self.source.value, "name": self.name, "model": self.model}


@dataclass(frozen=True)
class AnalysisReport:
    analysis_id: str
    timestamp: str  # ISO 8601, UTC
    provider: ProviderInfo
    image_width: int
    image_height: int
    layout_name: str
    roi_placeholder: bool
    layout_compatible: bool
    slots: tuple[SlotResult, ...]
    summary: OccupancySummary
    warnings: tuple[str, ...] = field(default_factory=tuple)
    image_filename: Optional[str] = None

    @property
    def is_demo_data(self) -> bool:
        return self.provider.source is ProviderSource.MOCK

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "analysis_id": self.analysis_id,
            "timestamp": self.timestamp,
            "is_demo_data": self.is_demo_data,
            "provider": self.provider.to_dict(),
            "image": {
                "filename": self.image_filename,
                "width": self.image_width,
                "height": self.image_height,
            },
            "layout": {
                "name": self.layout_name,
                "placeholder": self.roi_placeholder,
                "compatible": self.layout_compatible,
            },
            "warnings": list(self.warnings),
            "slots": [s.to_dict() for s in self.slots],
            "summary": self.summary.to_dict(),
        }
