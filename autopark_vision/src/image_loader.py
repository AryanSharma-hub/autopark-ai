"""Decode and validate uploaded parking-lot images into OpenCV BGR arrays."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
MAX_FILE_BYTES = 20 * 1024 * 1024
MIN_DIMENSION = 100
MAX_DIMENSION = 10_000


class ImageLoadError(ValueError):
    """Raised when an image cannot be decoded or fails validation."""


def load_image_bytes(data: bytes, filename: str | None = None) -> np.ndarray:
    """Decode raw image bytes (e.g. an HTTP upload) into a BGR uint8 array."""
    if not data:
        raise ImageLoadError("Image is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise ImageLoadError(
            f"Image is {len(data) / 1e6:.1f} MB; limit is {MAX_FILE_BYTES / 1e6:.0f} MB."
        )
    if filename:
        ext = Path(filename).suffix.lower()
        if ext and ext not in ALLOWED_EXTENSIONS:
            raise ImageLoadError(
                f"Unsupported file type '{ext}'. Use one of: {sorted(ALLOWED_EXTENSIONS)}."
            )

    buffer = np.frombuffer(data, dtype=np.uint8)
    image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    if image is None:
        raise ImageLoadError("File could not be decoded as an image.")
    validate_image(image)
    return image


def load_image_path(path: str | Path) -> np.ndarray:
    path = Path(path)
    if not path.is_file():
        raise ImageLoadError(f"Image not found: {path}")
    return load_image_bytes(path.read_bytes(), path.name)


def validate_image(image: np.ndarray) -> None:
    if not isinstance(image, np.ndarray) or image.dtype != np.uint8:
        raise ImageLoadError("Image must be a uint8 numpy array.")
    if image.ndim != 3 or image.shape[2] != 3:
        raise ImageLoadError("Image must have 3 colour channels (BGR).")
    height, width = image.shape[:2]
    if min(height, width) < MIN_DIMENSION:
        raise ImageLoadError(
            f"Image is {width}x{height}; minimum side is {MIN_DIMENSION}px."
        )
    if max(height, width) > MAX_DIMENSION:
        raise ImageLoadError(
            f"Image is {width}x{height}; maximum side is {MAX_DIMENSION}px."
        )


def encode_jpeg(image: np.ndarray, quality: int = 90) -> bytes:
    ok, buffer = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise ImageLoadError("JPEG encoding failed.")
    return buffer.tobytes()


def encode_png(image: np.ndarray) -> bytes:
    ok, buffer = cv2.imencode(".png", image)
    if not ok:
        raise ImageLoadError("PNG encoding failed.")
    return buffer.tobytes()
