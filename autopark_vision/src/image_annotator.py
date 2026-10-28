"""Draw slot boundaries, IDs and classifications onto the original image."""

from __future__ import annotations

import cv2
import numpy as np

from .schemas import AnalysisReport, PixelROI, ROIConfig, SlotStatus
from .roi_manager import to_pixels

# BGR colours
STATUS_COLORS = {
    SlotStatus.EMPTY: (60, 180, 75),
    SlotStatus.OCCUPIED: (40, 40, 220),
    SlotStatus.UNCERTAIN: (0, 190, 255),
}
NEUTRAL_COLOR = (255, 200, 0)
FONT = cv2.FONT_HERSHEY_SIMPLEX


def _scale(image: np.ndarray) -> tuple[float, int]:
    base = max(image.shape[:2]) / 1280
    return max(0.45, 0.7 * base), max(2, int(round(2 * base)))


def _label(img: np.ndarray, text: str, x: int, y: int, color, font_scale: float, thick: int) -> None:
    (tw, th), baseline = cv2.getTextSize(text, FONT, font_scale, thick)
    y_top = max(0, y - th - baseline - 6)
    cv2.rectangle(img, (x, y_top), (x + tw + 8, y_top + th + baseline + 6), color, -1)
    cv2.putText(img, text, (x + 4, y_top + th + 3), FONT, font_scale, (255, 255, 255), thick, cv2.LINE_AA)


def _box(img: np.ndarray, px: PixelROI, color, thick: int) -> None:
    cv2.rectangle(img, (px.x, px.y), (px.x + px.w - 1, px.y + px.h - 1), color, thick)


def draw_roi_preview(image: np.ndarray, config: ROIConfig) -> np.ndarray:
    """Overlay unclassified ROI boxes and IDs (used while adjusting regions)."""
    out = image.copy()
    font_scale, thick = _scale(out)
    h, w = out.shape[:2]
    for slot in config.slots:
        px = to_pixels(slot.roi, w, h)
        _box(out, px, NEUTRAL_COLOR, thick)
        _label(out, slot.slot_id, px.x, px.y, NEUTRAL_COLOR, font_scale, thick)
    return out


def annotate(image: np.ndarray, report: AnalysisReport) -> np.ndarray:
    out = image.copy()
    font_scale, thick = _scale(out)
    for slot in report.slots:
        color = STATUS_COLORS[slot.status]
        _box(out, slot.roi_pixels, color, thick + 1)
        text = f"{slot.slot_id}: {slot.status.value}"
        if cv2.getTextSize(text, FONT, font_scale, thick)[0][0] + 8 > slot.roi_pixels.w:
            text = f"{slot.slot_id}:{slot.status.value[0]}"  # narrow slot: "S1:O"
        _label(out, text, slot.roi_pixels.x, slot.roi_pixels.y, color, font_scale, thick)

    s = report.summary
    banner = (f"Empty {s.empty} | Occupied {s.occupied} | Uncertain {s.uncertain} | "
              f"Free: {', '.join(s.empty_slot_ids) or 'none'}")
    lines = [banner]
    if report.is_demo_data:
        lines.insert(0, "DEMO DATA - MOCK CLASSIFIER, NOT AI")
    if not report.layout_compatible:
        lines.append("WARNING: image may not match ROI layout")

    y = out.shape[0] - 10
    for text in reversed(lines):
        (tw, th), base = cv2.getTextSize(text, FONT, font_scale, thick)
        cv2.rectangle(out, (0, y - th - base - 8), (tw + 16, y + 2), (30, 30, 30), -1)
        cv2.putText(out, text, (8, y - base - 2), FONT, font_scale, (255, 255, 255), thick, cv2.LINE_AA)
        y -= th + base + 12
    return out
