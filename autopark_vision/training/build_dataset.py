"""Build the AutoPark top-view slot dataset.

Sources
-------
* ``syn``   - procedural top-down lots (training/synth_topview.py). Exact labels.
              Splits use disjoint random seeds.
* ``carpk`` - real drone images of parking lots (training/fetch_carpk.py).
              Occupied = annotated car boxes; empty = car-free lot regions of
              car size next to parked cars. Split by lot, never by frame:
              GF1, GF2 -> train, NTU -> valid, TPZ -> test.

Ambiguous CARPK crops (a car partly inside) are skipped, not guessed.

Output: training/data/topview/{train,valid,test}/{empty,occupied}/<source>_*.jpg

Usage: python training/build_dataset.py [--syn-train 600] [--syn-eval 120]
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from synth_topview import render_scene, slot_patches  # noqa: E402

OUT = ROOT / "data" / "topview"
CARPK = ROOT / "data" / "raw" / "carpk"
SIZE = 128
CARPK_SPLIT = {"GF1": "train", "GF2": "train", "NTU": "valid", "TPZ": "test"}
SEED_BASE = {"train": 1_000_000, "valid": 2_000_000, "test": 3_000_000}


def save(split: str, label: str, name: str, patch: np.ndarray) -> None:
    path = OUT / split / label / f"{name}.jpg"
    cv2.imwrite(str(path), patch, [cv2.IMWRITE_JPEG_QUALITY, 93])


# ------------------------------------------------------------------ synthetic


def synth_job(args) -> Counter:
    split, scene_id = args
    rng = np.random.default_rng(SEED_BASE[split] + scene_id)
    img, slots, _ = render_scene(rng)
    counts = Counter()
    for k, (patch, occupied) in enumerate(slot_patches(rng, img, slots, size=SIZE)):
        label = "occupied" if occupied else "empty"
        save(split, label, f"syn_{scene_id:06d}_{k:02d}", patch)
        counts[label] += 1
    return counts


# ------------------------------------------------------------------ CARPK


def overlap_fraction(box, boxes) -> tuple[float, float]:
    """(max fraction of `box` covered by any car, max fraction of any car covered by `box`)."""
    x, y, w, h = box
    ix = np.clip(np.minimum(x + w, boxes[:, 0] + boxes[:, 2]) - np.maximum(x, boxes[:, 0]), 0, None)
    iy = np.clip(np.minimum(y + h, boxes[:, 1] + boxes[:, 3]) - np.maximum(y, boxes[:, 1]), 0, None)
    inter = ix * iy
    return float((inter / (w * h)).max()), float((inter / (boxes[:, 2] * boxes[:, 3])).max())


def is_vegetation(patch) -> bool:
    """Mostly green/saturated patches are grass or trees, not parking surface."""
    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
    green = (hsv[..., 0] > 30) & (hsv[..., 0] < 90) & (hsv[..., 1] > 50)
    return float(green.mean()) > 0.3


def crop(img, x, y, w, h):
    H, W = img.shape[:2]
    x0, y0, x1, y1 = int(round(x)), int(round(y)), int(round(x + w)), int(round(y + h))
    if x0 < 0 or y0 < 0 or x1 > W or y1 > H or x1 - x0 < 16 or y1 - y0 < 16:
        return None
    return cv2.resize(img[y0:y1, x0:x1], (SIZE, SIZE), interpolation=cv2.INTER_AREA)


def carpk_job(args) -> Counter:
    name, meta, seed = args
    split = CARPK_SPLIT[name.split("_")[1]]
    img = cv2.imread(str(CARPK / "images" / name), cv2.IMREAD_COLOR)
    counts = Counter()
    if img is None or not meta["boxes"]:
        return counts
    rng = np.random.default_rng(seed)
    boxes = np.array(meta["boxes"], np.float32)
    stem = Path(name).stem

    # occupied: each annotated car, with slot-like margins and ROI jitter
    for k, (x, y, w, h) in enumerate(boxes):
        s = rng.uniform(1.05, 1.4, 2)
        cw, ch = w * s[0], h * s[1]
        cx = x + w / 2 + rng.normal(0, 0.06) * w
        cy = y + h / 2 + rng.normal(0, 0.06) * h
        cand = (cx - cw / 2, cy - ch / 2, cw, ch)
        _, car_cov = overlap_fraction(cand, boxes[k : k + 1])
        if car_cov < 0.75:
            continue
        patch = crop(img, *cand)
        if patch is not None:
            save(split, "occupied", f"carpk_{stem}_o{k:03d}", patch)
            counts["occupied"] += 1

    # empty: car-sized, car-free regions adjacent to parked cars (i.e. inside the lot)
    n_target, attempts = len(boxes), 0
    sizes = boxes[:, 2:]
    while counts["empty"] < n_target and attempts < n_target * 40:
        attempts += 1
        ref = boxes[rng.integers(0, len(boxes))]
        w, h = ref[2:] * rng.uniform(1.0, 1.3, 2)
        if rng.random() < 0.7:  # the neighbouring slot position in the same row/column
            axis = rng.integers(0, 2)
            sign = rng.choice([-1, 1])
            step = (ref[2] if axis == 0 else ref[3]) * rng.uniform(1.0, 1.35)
            cx = ref[0] + ref[2] / 2 + (sign * step if axis == 0 else rng.normal(0, 0.05) * ref[2])
            cy = ref[1] + ref[3] / 2 + (sign * step if axis == 1 else rng.normal(0, 0.05) * ref[3])
        else:  # anywhere near parked cars
            ang = rng.uniform(0, 2 * np.pi)
            dist = rng.uniform(1.0, 2.5) * max(ref[2], ref[3])
            cx = ref[0] + ref[2] / 2 + np.cos(ang) * dist
            cy = ref[1] + ref[3] / 2 + np.sin(ang) * dist
        cand = (cx - w / 2, cy - h / 2, w, h)
        cov_patch, cov_car = overlap_fraction(cand, boxes)
        if cov_patch > 0.05 or cov_car > 0.12:
            continue  # a car is (partly) inside -> not a clean empty example
        patch = crop(img, *cand)
        if patch is not None and not is_vegetation(patch):
            save(split, "empty", f"carpk_{stem}_e{attempts:04d}", patch)
            counts["empty"] += 1
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--syn-train", type=int, default=600, help="synthetic scenes for train")
    parser.add_argument("--syn-eval", type=int, default=120, help="synthetic scenes for valid and for test")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--no-carpk", action="store_true")
    args = parser.parse_args()

    if OUT.exists():
        shutil.rmtree(OUT)
    for split in SEED_BASE:
        for label in ("empty", "occupied"):
            (OUT / split / label).mkdir(parents=True)

    totals: dict[str, Counter] = {s: Counter() for s in SEED_BASE}
    jobs = [("train", i) for i in range(args.syn_train)]
    jobs += [(s, i) for s in ("valid", "test") for i in range(args.syn_eval)]
    with ProcessPoolExecutor(args.workers) as pool:
        for (split, _), c in zip(jobs, pool.map(synth_job, jobs, chunksize=16)):
            totals[split].update({f"syn_{k}": v for k, v in c.items()})
    print("synthetic:", {s: dict(c) for s, c in totals.items()}, flush=True)

    if not args.no_carpk:
        ann = json.loads((CARPK / "annotations.json").read_text())
        names = sorted(p.name for p in (CARPK / "images").glob("*.png"))
        cjobs = [(n, ann[n], i) for i, n in enumerate(names)]
        with ProcessPoolExecutor(args.workers) as pool:
            for (name, _, _), c in zip(cjobs, pool.map(carpk_job, cjobs)):
                totals[CARPK_SPLIT[name.split("_")[1]]].update({f"carpk_{k}": v for k, v in c.items()})
        print(f"carpk: {len(names)} frames", flush=True)

    summary = {s: dict(sorted(c.items())) for s, c in totals.items()}
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2))
    for s, c in summary.items():
        print(f"{s}: {c}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
