"""Write synthetic sample images (drawn shapes, not photos) to sample_images/.

Usage: python scripts/make_sample_images.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.roi_manager import load_config  # noqa: E402
from src.synthetic_lot import make_lot_image  # noqa: E402

SAMPLES = {
    "synthetic_lot_all_empty.png": (),
    "synthetic_lot_S1_occupied.png": ("S1",),
    "synthetic_lot_S2_S4_occupied.png": ("S2", "S4"),
    "synthetic_lot_S1_S3_S5_occupied.png": ("S1", "S3", "S5"),
    "synthetic_lot_all_occupied.png": ("S1", "S2", "S3", "S4", "S5"),
}


def main() -> None:
    config = load_config()
    out_dir = ROOT / "sample_images"
    out_dir.mkdir(exist_ok=True)
    for name, occupied in SAMPLES.items():
        path = out_dir / name
        cv2.imwrite(str(path), make_lot_image(config, occupied))
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
