"""Generate synthetic five-slot parking-lot images for tests and offline demos.

These images are drawn shapes, not photographs. Results on them say nothing
about accuracy on real parking images.
"""

from __future__ import annotations

from typing import Iterable

import cv2
import numpy as np

from .roi_manager import to_pixels
from .schemas import ROIConfig


def draw_car(img: np.ndarray, x: int, y: int, w: int, h: int, color=(40, 60, 200)) -> None:
    """Draw a top-down toy car filling most of the (x, y, w, h) box."""
    mx, my = int(w * 0.15), int(h * 0.08)
    x0, y0, x1, y1 = x + mx, y + my, x + w - mx, y + h - my
    cw, ch = x1 - x0, y1 - y0
    # wheels
    for wx in (x0 - cw // 12, x1 - cw // 12):
        for wy in (y0 + ch // 8, y1 - ch // 4):
            cv2.rectangle(img, (wx, wy), (wx + cw // 6, wy + ch // 8), (20, 20, 20), -1)
    cv2.rectangle(img, (x0, y0), (x1, y1), color, -1)
    cv2.rectangle(img, (x0, y0), (x1, y1), (15, 15, 15), 2)
    # windscreens and roof
    cv2.rectangle(img, (x0 + cw // 8, y0 + ch // 6), (x1 - cw // 8, y0 + ch // 3), (230, 210, 170), -1)
    cv2.rectangle(img, (x0 + cw // 8, y1 - ch // 4), (x1 - cw // 8, y1 - ch // 8), (230, 210, 170), -1)
    cv2.line(img, (x0 + cw // 2, y0 + ch // 3), (x0 + cw // 2, y1 - ch // 4), (15, 15, 15), 2)
    # headlights
    for hx in (x0 + cw // 6, x1 - cw // 6):
        cv2.circle(img, (hx, y0 + ch // 14), max(3, cw // 14), (0, 230, 255), -1)


def make_lot_image(
    config: ROIConfig,
    occupied: Iterable[str] = (),
    width: int = 1280,
    height: int = 720,
    seed: int = 0,
) -> np.ndarray:
    rng = np.random.default_rng(seed)
    noise = rng.normal(0, 10, (height, width, 1))
    img = np.clip(np.full((height, width, 3), 95.0) + noise, 0, 255).astype(np.uint8)

    occupied = set(occupied)
    rois = [to_pixels(s.roi, width, height) for s in config.slots]
    # painted separator lines just outside each ROI edge
    for px in rois:
        for lx in (px.x - 8, px.x + px.w + 8):
            if 0 <= lx < width:
                cv2.line(img, (lx, px.y - 10), (lx, px.y + px.h + 10), (235, 235, 235), 4)
    for slot, px in zip(config.slots, rois):
        if slot.slot_id in occupied:
            draw_car(img, px.x, px.y, px.w, px.h)
    return img
