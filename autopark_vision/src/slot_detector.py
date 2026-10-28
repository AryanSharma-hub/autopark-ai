"""Crop the five configured parking slots and check the image fits the layout.

This is fixed-ROI cropping, not general-purpose parking-space detection.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .roi_manager import to_pixels
from .schemas import NormalizedROI, PixelROI, ROIConfig

MIN_CROP_PIXELS = 24  # each side; smaller crops carry too little detail to classify
LOW_TEXTURE_STD = 4.0  # grey-level std below this means the crop is near-uniform


@dataclass(frozen=True)
class SlotCrop:
    slot_id: str
    roi_normalized: NormalizedROI
    roi_pixels: PixelROI
    image: np.ndarray  # BGR crop (a copy, safe to modify)


@dataclass(frozen=True)
class CompatibilityResult:
    compatible: bool
    warnings: tuple[str, ...]


def crop_slots(image: np.ndarray, config: ROIConfig) -> list[SlotCrop]:
    height, width = image.shape[:2]
    crops: list[SlotCrop] = []
    for slot in config.slots:
        px = to_pixels(slot.roi, width, height)
        crop = image[px.y : px.y + px.h, px.x : px.x + px.w].copy()
        crops.append(SlotCrop(slot.slot_id, slot.roi, px, crop))
    return crops


def check_compatibility(
    image: np.ndarray, config: ROIConfig, crops: list[SlotCrop]
) -> CompatibilityResult:
    """Flag images whose composition likely does not match the configured ROIs.

    Hard problems (wrong aspect ratio, unusably small or blank crops) mark the
    result incompatible. Advisory notes (placeholder ROIs) only add warnings.
    """
    height, width = image.shape[:2]
    warnings: list[str] = []
    compatible = True

    ratio = width / height
    expected = config.reference_aspect_ratio
    deviation = abs(ratio - expected) / expected
    if deviation > config.aspect_ratio_tolerance:
        compatible = False
        warnings.append(
            f"Image aspect ratio {ratio:.2f} differs from the ROI layout's "
            f"{expected:.2f} ({config.reference_width}x{config.reference_height}) by "
            f"{deviation:.0%}. The camera viewpoint probably does not match the "
            "configured slots; results may be misleading. Re-align the ROIs for this image."
        )

    for crop in crops:
        px = crop.roi_pixels
        if px.w < MIN_CROP_PIXELS or px.h < MIN_CROP_PIXELS:
            compatible = False
            warnings.append(
                f"{crop.slot_id} crop is only {px.w}x{px.h}px; image resolution is too low "
                "for this layout."
            )
            continue
        grey = cv2.cvtColor(crop.image, cv2.COLOR_BGR2GRAY)
        if float(grey.std()) < LOW_TEXTURE_STD:
            compatible = False
            warnings.append(
                f"{crop.slot_id} crop is almost uniform (no visible detail). The ROI may "
                "be off the parking surface, or the image is over/under-exposed."
            )

    if config.placeholder:
        warnings.append(
            "ROI coordinates are placeholders and have not been aligned to a real image "
            "of the lot. Adjust and save the regions before trusting results."
        )

    return CompatibilityResult(compatible=compatible, warnings=tuple(warnings))
