"""Download a balanced subset of PKLot and cut it into labelled slot patches.

Source: Hugging Face mirror ``dronefreak/PKLot`` (CC BY 4.0, Almeida et al. 2015).
Output layout (ImageFolder):

    training/data/patches/{train,valid,test}/{empty,occupied}/*.jpg

Images are sampled evenly across the three lots (PUCPR, UFPR04, UFPR05) and
across dates, so weather and lighting vary. Splits follow the mirror's own
train/valid/test split, so no source image appears in two splits.

Usage: python training/prepare_pklot.py [--per-lot-train 120] [--per-lot-eval 30]
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

BASE_URL = "https://huggingface.co/datasets/dronefreak/PKLot/resolve/main/data/images"
SPLITS = ("train", "valid", "test")
CLASS_NAMES = {0: "empty", 1: "occupied"}
PATCH_SIZE = 128
BOX_MARGIN = 0.08  # grow each box slightly so the patch includes the slot edges

ROOT = Path(__file__).resolve().parent
RAW_DIR = ROOT / "data" / "raw"
PATCH_DIR = ROOT / "data" / "patches"


def fetch(url: str, dest: Path, retries: int = 3) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    last = None
    for _ in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=120) as resp:
                data = resp.read()
            tmp = dest.with_suffix(dest.suffix + ".part")
            tmp.write_bytes(data)
            tmp.replace(dest)
            return dest
        except OSError as exc:
            last = exc
    raise RuntimeError(f"download failed: {url}: {last}")


def sample_rows(rows: list[dict], per_lot: int, seed: int) -> list[dict]:
    """Pick `per_lot` images per lot, spread evenly over the sorted (date-ordered) list."""
    by_lot: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_lot[r["file_name"].split("_")[0]].append(r)
    picked = []
    rng = random.Random(seed)
    for lot, items in sorted(by_lot.items()):
        items.sort(key=lambda r: r["file_name"])
        if len(items) <= per_lot:
            picked += items
            continue
        step = len(items) / per_lot
        picked += [items[min(len(items) - 1, int(i * step + rng.random() * step))] for i in range(per_lot)]
    return picked


def cut_patches(image: np.ndarray, row: dict, out_dir: Path) -> Counter:
    h, w = image.shape[:2]
    counts: Counter = Counter()
    stem = Path(row["file_name"]).stem
    objects = row["objects"]
    for i, (box, cat) in enumerate(zip(objects["bbox"], objects["categories"])):
        x, y, bw, bh = box
        mx, my = bw * BOX_MARGIN, bh * BOX_MARGIN
        x0, y0 = max(0, int(x - mx)), max(0, int(y - my))
        x1, y1 = min(w, int(x + bw + mx)), min(h, int(y + bh + my))
        if x1 - x0 < 12 or y1 - y0 < 12:
            continue
        patch = cv2.resize(image[y0:y1, x0:x1], (PATCH_SIZE, PATCH_SIZE), interpolation=cv2.INTER_AREA)
        label = CLASS_NAMES[int(cat)]
        dest = out_dir / label / f"{stem}_{i:03d}.jpg"
        dest.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(dest), patch, [cv2.IMWRITE_JPEG_QUALITY, 92])
        counts[label] += 1
    return counts


def process_split(split: str, per_lot: int, seed: int, workers: int) -> Counter:
    meta = fetch(f"{BASE_URL}/{split}/metadata.jsonl", RAW_DIR / split / "metadata.jsonl")
    rows = [json.loads(line) for line in meta.read_text(encoding="utf-8").splitlines() if line.strip()]
    rows = sample_rows(rows, per_lot, seed)
    out_dir = PATCH_DIR / split

    def work(row: dict) -> Counter:
        img_path = fetch(f"{BASE_URL}/{split}/{row['file_name']}", RAW_DIR / split / row["file_name"])
        image = cv2.imread(str(img_path), cv2.IMREAD_COLOR)
        if image is None:
            return Counter(bad_image=1)
        return cut_patches(image, row, out_dir)

    total: Counter = Counter()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for n, c in enumerate(pool.map(work, rows), 1):
            total += c
            if n % 25 == 0 or n == len(rows):
                print(f"  {split}: {n}/{len(rows)} images, {dict(total)}", flush=True)
    return total


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--per-lot-train", type=int, default=120)
    parser.add_argument("--per-lot-eval", type=int, default=30)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    for split in SPLITS:
        per_lot = args.per_lot_train if split == "train" else args.per_lot_eval
        print(f"{split}: sampling {per_lot} images per lot")
        counts = process_split(split, per_lot, args.seed, args.workers)
        print(f"{split} done: {dict(counts)}")
    print(f"patches in {PATCH_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
