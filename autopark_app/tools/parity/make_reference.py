"""Generate Python reference outputs for the mobile classifier parity tests.

Runs the ORIGINAL autopark_vision pipeline (src.occupancy_classifier.analyze_image
with src.local_classifier.LocalModelProvider) on identical sample images and
writes what the TypeScript port must reproduce:

  * per-slot pixel ROI, status, confidence, P(occupied)
  * the exact preprocessed tensor for one crop (hash + a few values)
  * cv2.resize(INTER_AREA) outputs for a spread of crop sizes

Also writes JPEG copies of the samples (one with an EXIF orientation tag) so
the JPEG decode path can be compared too.

Usage (from the repository root):
    python -I autopark_app/tools/parity/make_reference.py autopark_vision autopark_app/__tests__/fixtures
"""

from __future__ import annotations

import base64
import hashlib
import json
import sys
from pathlib import Path

import cv2
import numpy as np


def main(vision_dir: Path, out_dir: Path) -> None:
    sys.path.insert(0, str(vision_dir))
    from src.local_classifier import LocalModelProvider  # noqa: E402
    from src.occupancy_classifier import analyze_image  # noqa: E402
    from src.image_loader import load_image_path  # noqa: E402
    from src.roi_manager import load_config  # noqa: E402
    from src.slot_detector import crop_slots  # noqa: E402

    out_dir.mkdir(parents=True, exist_ok=True)
    img_dir = out_dir / "images"
    img_dir.mkdir(exist_ok=True)

    provider = LocalModelProvider(vision_dir / "models" / "slot_classifier.onnx")
    configs = {
        "roi_config": load_config(vision_dir / "config" / "roi_config.json"),
        "roi_real_lot_1": load_config(vision_dir / "config" / "roi_real_lot_1.json"),
    }

    # Images: shipped PNG samples + JPEG re-encodes (+ one rotated with EXIF orientation 6).
    images: list[tuple[str, Path]] = []
    for p in sorted((vision_dir / "sample_images").glob("*.png")):
        dst = img_dir / p.name
        dst.write_bytes(p.read_bytes())
        images.append((p.name, dst))
    real = cv2.imread(str(vision_dir / "sample_images" / "real_lot_1.png"))
    jpg = img_dir / "real_lot_1_q90.jpg"
    cv2.imwrite(str(jpg), real, [cv2.IMWRITE_JPEG_QUALITY, 90])
    images.append((jpg.name, jpg))
    synth = cv2.imread(str(vision_dir / "sample_images" / "synthetic_lot_S2_S4_occupied.png"))
    jpg2 = img_dir / "synthetic_lot_S2_S4_occupied_q92.jpg"
    cv2.imwrite(str(jpg2), synth, [cv2.IMWRITE_JPEG_QUALITY, 92])
    images.append((jpg2.name, jpg2))
    try:
        from PIL import Image

        # Store the pixels rotated 90 deg counter-clockwise and tag Orientation=6 ("rotate 90 CW to display").
        rot = cv2.rotate(real, cv2.ROTATE_90_COUNTERCLOCKWISE)
        pil = Image.fromarray(cv2.cvtColor(rot, cv2.COLOR_BGR2RGB))
        exif = Image.Exif()
        exif[0x0112] = 6
        jpg3 = img_dir / "real_lot_1_exif6.jpg"
        pil.save(jpg3, quality=90, exif=exif.tobytes())
        images.append((jpg3.name, jpg3))
    except ImportError:
        print("Pillow not installed; skipping EXIF orientation fixture")

    cases = []
    for name, path in images:
        image = load_image_path(path)
        for cfg_name, cfg in configs.items():
            report = analyze_image(image, cfg, provider, image_filename=name)
            crops = crop_slots(image, cfg)
            probs = provider.predict_proba([c.image for c in crops])
            slots = []
            for s, pr in zip(report.slots, probs):
                slots.append(
                    {
                        "slot_id": s.slot_id,
                        "pixels": s.roi_pixels.to_dict(),
                        "status": s.status.value,
                        "confidence": s.confidence,
                        "p_occupied": float(pr[provider.labels.index("occupied")]),
                    }
                )
            first = provider.preprocess([crops[0].image])[0]
            cases.append(
                {
                    "image": name,
                    "config": cfg_name,
                    "width": int(image.shape[1]),
                    "height": int(image.shape[0]),
                    "compatible": report.layout_compatible,
                    "warnings": list(report.warnings),
                    "slots": slots,
                    "empty_slot_ids": list(report.summary.empty_slot_ids),
                    "first_crop_tensor_sha256": hashlib.sha256(first.astype(np.float32).tobytes()).hexdigest(),
                    "first_crop_tensor_head": [float(v) for v in first.reshape(-1)[:8]],
                    "decoded_sha256": hashlib.sha256(image.tobytes()).hexdigest(),
                }
            )

    # Resize cases: random + real crops over the size range that slot ROIs produce.
    rng = np.random.default_rng(7)
    sizes = [(59, 130), (96, 96), (192, 192), (288, 192), (53, 69), (150, 97), (97, 150), (40, 40), (30, 300), (120, 61)]
    sizes += [(int(rng.integers(24, 260)), int(rng.integers(24, 260))) for _ in range(20)]
    resize_cases = []
    for w, h in sizes:
        if rng.random() < 0.5:
            crop = rng.integers(0, 256, (h, w, 3), dtype=np.uint8)
        else:
            y0 = int(rng.integers(0, max(1, real.shape[0] - h))) if real.shape[0] > h else 0
            x0 = int(rng.integers(0, max(1, real.shape[1] - w))) if real.shape[1] > w else 0
            crop = cv2.resize(real, (max(w, real.shape[1]), max(h, real.shape[0])))[y0 : y0 + h, x0 : x0 + w].copy()
        out = cv2.resize(crop, (96, 96), interpolation=cv2.INTER_AREA)
        resize_cases.append(
            {
                "w": w,
                "h": h,
                "src": base64.b64encode(crop.tobytes()).decode(),
                "dst_sha256": hashlib.sha256(out.tobytes()).hexdigest(),
            }
        )

    ref = {
        "generator": "autopark_app/tools/parity/make_reference.py",
        "opencv": cv2.__version__,
        "numpy": np.__version__,
        "model": provider.info.model,
        "temperature": provider.temperature,
        "threshold": provider.uncertain_threshold,
        "cases": cases,
    }
    (out_dir / "parity_reference.json").write_text(json.dumps(ref, indent=1))
    (out_dir / "resize_reference.json").write_text(json.dumps(resize_cases))
    print(f"wrote {len(cases)} pipeline cases and {len(resize_cases)} resize cases to {out_dir}")


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
