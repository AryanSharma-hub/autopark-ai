"""AutoPark AI five-slot parking occupancy classifier (UI-independent core)."""

from .occupancy_classifier import IncompatibleImageError, analyze_image, analyze_image_bytes
from .schemas import SLOT_IDS, AnalysisReport, SlotStatus

__all__ = [
    "SLOT_IDS",
    "AnalysisReport",
    "IncompatibleImageError",
    "SlotStatus",
    "analyze_image",
    "analyze_image_bytes",
]
