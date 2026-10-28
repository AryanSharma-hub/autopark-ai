"""Evaluate the exported ONNX model exactly as the app runs it (LocalModelProvider).

1. Top-view test split (training/data/topview/test), per source.
2. Hand-labelled held-out photos in training/domain_test/*.json.

Usage: python training/evaluate.py [--model models/slot_classifier.onnx] [--threshold 0.8]
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent
sys.path.insert(0, str(PROJECT))

from src.local_classifier import DEFAULT_MODEL_PATH, LocalModelProvider  # noqa: E402
from src.schemas import SlotStatus  # noqa: E402

STATUS_OF = {"empty": SlotStatus.EMPTY, "occupied": SlotStatus.OCCUPIED}


def score(name: str, truths: list[SlotStatus], preds) -> None:
    n = len(truths)
    decided = [(t, p) for t, p in zip(truths, preds) if p.status is not SlotStatus.UNCERTAIN]
    wrong = sum(t is not p.status for t, p in decided)
    line = f"[{name}] n={n}  decided={len(decided)} ({len(decided) / n:.1%})  wrong_when_decided={wrong}"
    for status in (SlotStatus.EMPTY, SlotStatus.OCCUPIED):
        said = [t for t, p in decided if p.status is status]
        prec = sum(t is status for t in said) / len(said) if said else float("nan")
        rec = sum(1 for t, p in decided if t is status and p.status is status) / max(1, truths.count(status))
        line += f"  {status.value}: precision={prec:.4f} recall={rec:.4f}"
    print(line)
    print(f"  outcomes: {dict(Counter(f'{t.value}->{p.status.value}' for t, p in zip(truths, preds)))}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL_PATH)
    parser.add_argument("--threshold", type=float, default=None)
    parser.add_argument("--batch", type=int, default=256)
    args = parser.parse_args()
    provider = LocalModelProvider(args.model, uncertain_threshold=args.threshold)
    print(f"model {provider.info.model}  T={provider.temperature}  threshold={provider.uncertain_threshold}")

    test_dir = ROOT / "data" / "topview" / "test"
    if test_dir.is_dir():
        files = [(p, STATUS_OF[p.parent.name]) for p in sorted(test_dir.glob("*/*.jpg"))]
        preds = []
        for i in range(0, len(files), args.batch):
            chunk = files[i : i + args.batch]
            preds += provider.classify_batch([cv2.imread(str(p)) for p, _ in chunk])
        for source in sorted({p.name.split("_", 1)[0] for p, _ in files}):
            idx = [i for i, (p, _) in enumerate(files) if p.name.startswith(source + "_")]
            score(f"test/{source}", [files[i][1] for i in idx], [preds[i] for i in idx])

    for spec_path in sorted((ROOT / "domain_test").glob("*.json")):
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        image = cv2.imread(str(PROJECT / spec["image"]))
        crops = [image[y : y + h, x : x + w] for x, y, w, h in (s["box"] for s in spec["slots"])]
        truths = [STATUS_OF[s["label"]] for s in spec["slots"]]
        preds = provider.classify_batch(crops)
        score(spec_path.stem, truths, preds)
        for i, (t, p) in enumerate(zip(truths, preds)):
            flag = "" if t is p.status else "   <-- " + ("uncertain" if p.status is SlotStatus.UNCERTAIN else "WRONG")
            print(f"  slot {i:2d}: true={t.value:<8} pred={p.status.value:<9} conf={p.confidence:.2f}{flag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
