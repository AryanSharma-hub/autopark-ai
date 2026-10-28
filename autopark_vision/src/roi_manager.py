"""Load, validate, scale and save the five-slot ROI configuration."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from .schemas import SLOT_IDS, NormalizedROI, PixelROI, ROIConfig, SlotDefinition

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "roi_config.json"
MIN_NORMALIZED_SIZE = 0.02  # a slot narrower/shorter than 2% of the image is a config error
MAX_OVERLAP_IOU = 0.25


class ROIConfigError(ValueError):
    """Raised when an ROI configuration is malformed or inconsistent."""


def _number(value: Any, name: str) -> float:
    # bool is a subclass of int; reject it explicitly.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ROIConfigError(f"{name} must be a number, got {value!r}.")
    if not math.isfinite(value):
        raise ROIConfigError(f"{name} must be finite, got {value!r}.")
    return float(value)


def _iou(a: NormalizedROI, b: NormalizedROI) -> float:
    ix = max(0.0, min(a.x + a.w, b.x + b.w) - max(a.x, b.x))
    iy = max(0.0, min(a.y + a.h, b.y + b.h) - max(a.y, b.y))
    inter = ix * iy
    union = a.w * a.h + b.w * b.h - inter
    return inter / union if union > 0 else 0.0


def validate_roi(roi: NormalizedROI, slot_id: str) -> None:
    for name in ("x", "y"):
        v = getattr(roi, name)
        if not 0.0 <= v < 1.0:
            raise ROIConfigError(f"{slot_id}.{name}={v} must be in [0, 1).")
    for name in ("w", "h"):
        v = getattr(roi, name)
        if not MIN_NORMALIZED_SIZE <= v <= 1.0:
            raise ROIConfigError(
                f"{slot_id}.{name}={v} must be in [{MIN_NORMALIZED_SIZE}, 1]."
            )
    if roi.x + roi.w > 1.0 + 1e-9:
        raise ROIConfigError(f"{slot_id} extends past the right edge (x + w > 1).")
    if roi.y + roi.h > 1.0 + 1e-9:
        raise ROIConfigError(f"{slot_id} extends past the bottom edge (y + h > 1).")


def parse_config(data: dict[str, Any]) -> ROIConfig:
    """Build a validated ROIConfig from a JSON-compatible dict."""
    if not isinstance(data, dict):
        raise ROIConfigError("ROI config must be a JSON object.")

    raw_slots = data.get("slots")
    if not isinstance(raw_slots, list):
        raise ROIConfigError("'slots' must be a list.")

    seen: set[str] = set()
    slots: list[SlotDefinition] = []
    for i, raw in enumerate(raw_slots):
        if not isinstance(raw, dict):
            raise ROIConfigError(f"slots[{i}] must be an object.")
        slot_id = raw.get("id")
        if not isinstance(slot_id, str):
            raise ROIConfigError(f"slots[{i}].id must be a string.")
        if slot_id not in SLOT_IDS:
            raise ROIConfigError(f"Unknown slot id '{slot_id}'. Allowed: {list(SLOT_IDS)}.")
        if slot_id in seen:
            raise ROIConfigError(f"Duplicate slot id '{slot_id}'.")
        seen.add(slot_id)
        missing_keys = [k for k in ("x", "y", "w", "h") if k not in raw]
        if missing_keys:
            raise ROIConfigError(f"{slot_id} missing keys: {missing_keys}.")
        roi = NormalizedROI(
            x=_number(raw["x"], f"{slot_id}.x"),
            y=_number(raw["y"], f"{slot_id}.y"),
            w=_number(raw["w"], f"{slot_id}.w"),
            h=_number(raw["h"], f"{slot_id}.h"),
        )
        validate_roi(roi, slot_id)
        slots.append(SlotDefinition(slot_id, roi))

    missing = [s for s in SLOT_IDS if s not in seen]
    if missing:
        raise ROIConfigError(f"Missing slot ids: {missing}. Exactly S1-S5 are required.")

    slots.sort(key=lambda s: SLOT_IDS.index(s.slot_id))

    for i, a in enumerate(slots):
        for b in slots[i + 1 :]:
            iou = _iou(a.roi, b.roi)
            if iou > MAX_OVERLAP_IOU:
                raise ROIConfigError(
                    f"{a.slot_id} and {b.slot_id} overlap too much (IoU {iou:.2f} > {MAX_OVERLAP_IOU})."
                )

    ref = data.get("reference_resolution", {})
    if not isinstance(ref, dict):
        raise ROIConfigError("'reference_resolution' must be an object.")
    ref_w = _number(ref.get("width", 1280), "reference_resolution.width")
    ref_h = _number(ref.get("height", 720), "reference_resolution.height")
    if ref_w <= 0 or ref_h <= 0:
        raise ROIConfigError("reference_resolution width/height must be positive.")

    tolerance = _number(data.get("aspect_ratio_tolerance", 0.15), "aspect_ratio_tolerance")
    if not 0.0 < tolerance <= 1.0:
        raise ROIConfigError("aspect_ratio_tolerance must be in (0, 1].")

    placeholder = data.get("placeholder", True)
    if not isinstance(placeholder, bool):
        raise ROIConfigError("'placeholder' must be true or false.")

    layout_name = data.get("layout_name", "unnamed_layout")
    if not isinstance(layout_name, str) or not layout_name.strip():
        raise ROIConfigError("'layout_name' must be a non-empty string.")

    return ROIConfig(
        layout_name=layout_name,
        slots=tuple(slots),
        reference_width=int(ref_w),
        reference_height=int(ref_h),
        aspect_ratio_tolerance=tolerance,
        placeholder=placeholder,
        version=int(_number(data.get("version", 1), "version")),
    )


def load_config(path: str | Path = DEFAULT_CONFIG_PATH) -> ROIConfig:
    path = Path(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ROIConfigError(f"ROI config not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ROIConfigError(f"ROI config is not valid JSON: {exc}") from exc
    return parse_config(data)


def save_config(config: ROIConfig, path: str | Path = DEFAULT_CONFIG_PATH) -> Path:
    # Round-trip through the parser so an invalid config is never written.
    parse_config(config.to_dict())
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(config.to_dict(), indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return path


def to_pixels(roi: NormalizedROI, image_width: int, image_height: int) -> PixelROI:
    """Scale a normalized ROI to pixel coordinates, clamped inside the image."""
    x0 = int(round(roi.x * image_width))
    y0 = int(round(roi.y * image_height))
    x1 = int(round((roi.x + roi.w) * image_width))
    y1 = int(round((roi.y + roi.h) * image_height))
    x0, x1 = max(0, x0), min(image_width, x1)
    y0, y1 = max(0, y0), min(image_height, y1)
    return PixelROI(x=x0, y=y0, w=max(0, x1 - x0), h=max(0, y1 - y0))
