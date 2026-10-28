"""Fetch a subset of CARPK (drone, top-down views of real parking lots).

CARPK: Hsieh et al., "Drone-based Object Counting by Spatially Regularized
Regional Proposal Network", ICCV 2017. Mirror: Hugging Face ``ShantyCam/carpk``.

Only the selected frames are downloaded, read straight out of the remote zip
with HTTP Range requests. Frames are spread evenly over each lot's sequence,
because neighbouring frames of the drone video are near-duplicates.

Lots: GF1, GF2, NTU (CARPK train split) and TPZ (CARPK test split, a different lot).

Usage: python training/fetch_carpk.py [--per-lot 24]
Output: training/data/raw/carpk/{images/*.png, annotations.json}
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import zipfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "tools"))
from http_zip import HTTPRangeFile  # noqa: E402

URL = "https://huggingface.co/datasets/ShantyCam/carpk/resolve/main/carpk.zip"
OUT = Path(__file__).resolve().parent / "data" / "raw" / "carpk"
ANNOTATION_MEMBERS = {"train": "carpk_coco/train_annotations.json", "test": "carpk_coco/test_annotations.json"}

_local = threading.local()


def zip_handle() -> zipfile.ZipFile:
    if not hasattr(_local, "zip"):
        _local.zip = zipfile.ZipFile(HTTPRangeFile(URL))
    return _local.zip


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--per-lot", type=int, default=24)
    parser.add_argument("--workers", type=int, default=3)
    args = parser.parse_args()

    (OUT / "images").mkdir(parents=True, exist_ok=True)
    ann_path = OUT / "annotations.json"
    if ann_path.exists():
        merged = json.loads(ann_path.read_text())
    else:
        merged = {}
        for split, member in ANNOTATION_MEMBERS.items():
            coco = json.loads(zip_handle().read(member))
            boxes = defaultdict(list)
            for a in coco["annotations"]:
                boxes[a["image_id"]].append(a["bbox"])
            for img in coco["images"]:
                merged[img["file_name"]] = {
                    "split": split, "width": img["width"], "height": img["height"],
                    "boxes": boxes[img["id"]],
                }
        ann_path.write_text(json.dumps(merged))
    print(f"annotations: {len(merged)} images")

    by_lot = defaultdict(list)
    for name, meta in merged.items():
        by_lot[name.split("_")[1]].append(name)
    selected = []
    for lot, names in sorted(by_lot.items()):
        names.sort()
        step = len(names) / args.per_lot
        selected += [names[int(i * step)] for i in range(min(args.per_lot, len(names)))]
    todo = [n for n in selected if not (OUT / "images" / n).exists()]
    print(f"selected {len(selected)} frames ({len(todo)} to download)")

    member_of = {}
    for split in ("train", "test"):
        for n in selected:
            if merged[n]["split"] == split:
                member_of[n] = f"carpk_coco/{split}/{n}"

    def fetch(name: str) -> str:
        data = zip_handle().read(member_of[name])
        tmp = OUT / "images" / (name + ".part")
        tmp.write_bytes(data)
        tmp.replace(OUT / "images" / name)
        return name

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i, name in enumerate(pool.map(fetch, todo), 1):
            print(f"  {i}/{len(todo)} {name}", flush=True)
    (OUT / "selected.json").write_text(json.dumps(selected, indent=0))
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
