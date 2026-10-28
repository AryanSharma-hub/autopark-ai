"""Train the local slot classifier (empty vs occupied) and export it to ONNX.

Model: MobileNetV3-Small, ImageNet-pretrained, fine-tuned end to end.
Data:  training/data/topview (python training/build_dataset.py), ImageFolder layout,
       file names prefixed with their source (``syn_``, ``carpk_``) for per-source metrics.

After training:
1. temperature scaling is fitted on the validation split (calibrated confidence);
2. the UNCERTAIN threshold is the lowest calibrated probability at which BOTH
   classes reach --target-precision on validation (abstain rather than guess);
3. the best checkpoint is exported to models/slot_classifier.onnx with a JSON
   metadata file holding preprocessing, threshold and test metrics.

Training-only dependencies: training/requirements-train.txt. Inference needs onnxruntime only.

Usage:
    python training/train.py [--epochs 4] [--extra-data my_lot ...]
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torchvision.transforms.functional as TF
from torch.utils.data import ConcatDataset, DataLoader
from torchvision import datasets, models, transforms

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent
DATA_DIR = ROOT / "data" / "topview"
MODEL_DIR = PROJECT / "models"

LABELS = ["empty", "occupied"]  # ImageFolder sorts class dirs alphabetically -> same order
MEAN = [0.485, 0.456, 0.406]
STD = [0.229, 0.224, 0.225]


class RandomRot90:
    """Top-down cameras see cars at any heading: rotate by a random multiple of 90 degrees."""

    def __call__(self, img):
        return TF.rotate(img, 90 * random.randint(0, 3), expand=True)


def build_transforms(size: int):
    train = transforms.Compose([
        RandomRot90(),
        transforms.RandomResizedCrop(size, scale=(0.75, 1.0), ratio=(0.6, 1.66)),
        transforms.RandomHorizontalFlip(),
        transforms.RandomVerticalFlip(),
        transforms.RandomApply([transforms.RandomRotation(8)], p=0.3),
        transforms.ColorJitter(0.35, 0.35, 0.35, 0.04),
        transforms.RandomGrayscale(0.05),
        transforms.RandomApply([transforms.GaussianBlur(5, (0.1, 1.2))], p=0.2),
        transforms.ToTensor(),
        transforms.Normalize(MEAN, STD),
    ])
    evaluate = transforms.Compose([
        transforms.Resize((size, size)),
        transforms.ToTensor(),
        transforms.Normalize(MEAN, STD),
    ])
    return train, evaluate


def build_model() -> nn.Module:
    model = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.IMAGENET1K_V1)
    model.classifier[3] = nn.Linear(model.classifier[3].in_features, len(LABELS))
    return model


def source_of(path: str) -> str:
    return Path(path).name.split("_", 1)[0]


@torch.no_grad()
def collect_logits(model, loader, device):
    model.eval()
    out_logits, out_targets = [], []
    for x, y in loader:
        out_logits.append(model(x.to(device)).float().cpu())
        out_targets.append(y)
    return torch.cat(out_logits), torch.cat(out_targets)


def fit_temperature(logits: torch.Tensor, targets: torch.Tensor) -> float:
    """Temperature scaling (Guo et al., 2017) on held-out logits."""
    log_t = torch.zeros(1, requires_grad=True)
    opt = torch.optim.LBFGS([log_t], lr=0.05, max_iter=200)
    nll = nn.CrossEntropyLoss()

    def closure():
        opt.zero_grad()
        loss = nll(logits / log_t.exp(), targets)
        loss.backward()
        return loss

    opt.step(closure)
    return float(log_t.exp().clamp(0.05, 20.0))


def class_report(probs: torch.Tensor, targets: torch.Tensor, threshold: float) -> dict:
    conf, pred = probs.max(1)
    decided = conf >= threshold
    report = {
        "n": int(len(targets)),
        "accuracy_no_abstain": round(float((pred == targets).float().mean()), 4),
        "coverage": round(float(decided.float().mean()), 4),
        "errors_when_decided": int(((pred != targets) & decided).sum()),
    }
    for c, name in enumerate(LABELS):
        tp = int(((pred == c) & (targets == c) & decided).sum())
        fp = int(((pred == c) & (targets != c) & decided).sum())
        pos = int((targets == c).sum())
        report[name] = {
            "precision": round(tp / (tp + fp), 4) if tp + fp else None,
            "recall": round(tp / pos, 4) if pos else None,  # abstentions count as misses
            "support": pos,
        }
    return report


def evaluate(logits, targets, sources, temperature, threshold) -> dict:
    probs = torch.softmax(logits / temperature, dim=1)
    out = {"all": class_report(probs, targets, threshold)}
    for src in sorted(set(sources)):
        idx = torch.tensor([i for i, s in enumerate(sources) if s == src])
        out[src] = class_report(probs[idx], targets[idx], threshold)
    return out


def choose_threshold(logits, targets, temperature, target_precision: float) -> float:
    """Lowest threshold at which both classes reach target precision on validation."""
    probs = torch.softmax(logits / temperature, dim=1)
    for t in np.arange(0.5, 0.9995, 0.0025):
        r = class_report(probs, targets, float(t))
        if all((r[c]["precision"] or 0) >= target_precision for c in LABELS):
            return round(float(t), 4)
    return 0.999


def export_onnx(model: nn.Module, size: int, path: Path) -> None:
    model.eval().cpu()
    torch.onnx.export(
        model, torch.zeros(1, 3, size, size), str(path), input_names=["input"], output_names=["logits"],
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}}, opset_version=17, dynamo=False,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=DATA_DIR)
    parser.add_argument("--extra-data", type=Path, nargs="*", default=[])
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=96)
    parser.add_argument("--lr", type=float, default=2e-3)
    parser.add_argument("--input-size", type=int, default=96)
    parser.add_argument("--target-precision", type=float, default=0.995)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--out", type=Path, default=MODEL_DIR / "slot_classifier.onnx")
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    train_tf, eval_tf = build_transforms(args.input_size)
    train_sets = [datasets.ImageFolder(args.data / "train", train_tf)]
    train_sets += [datasets.ImageFolder(d, train_tf) for d in args.extra_data]
    for ds in train_sets:
        if ds.classes != LABELS:
            print(f"error: {ds.root} has classes {ds.classes}, expected {LABELS}", file=sys.stderr)
            return 1
    train_ds = ConcatDataset(train_sets)
    valid_ds = datasets.ImageFolder(args.data / "valid", eval_tf)
    test_ds = datasets.ImageFolder(args.data / "test", eval_tf)
    valid_src = [source_of(p) for p, _ in valid_ds.samples]
    test_src = [source_of(p) for p, _ in test_ds.samples]

    counts = defaultdict(int)
    for ds in train_sets:
        for p, y in ds.samples:
            counts[(source_of(p), LABELS[y])] += 1
    print(f"train={len(train_ds)} {dict(counts)}\nvalid={len(valid_ds)} test={len(test_ds)} device={device}",
          flush=True)

    loader = lambda ds, shuffle: DataLoader(  # noqa: E731
        ds, batch_size=args.batch_size, shuffle=shuffle, num_workers=args.workers,
        persistent_workers=args.workers > 0, drop_last=shuffle,
    )
    train_loader, valid_loader, test_loader = loader(train_ds, True), loader(valid_ds, False), loader(test_ds, False)

    model = build_model().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=args.lr, total_steps=args.epochs * len(train_loader), pct_start=0.1
    )
    criterion = nn.CrossEntropyLoss(label_smoothing=0.05)

    best_loss, best_state, best_epoch = float("inf"), None, 0
    for epoch in range(1, args.epochs + 1):
        model.train()
        start, running, seen, correct = time.time(), 0.0, 0, 0
        for x, y in train_loader:
            x, y = x.to(device), y.to(device)
            optimizer.zero_grad(set_to_none=True)
            out = model(x)
            loss = criterion(out, y)
            loss.backward()
            optimizer.step()
            scheduler.step()
            running += float(loss) * len(y)
            correct += int((out.argmax(1) == y).sum())
            seen += len(y)
        v_logits, v_targets = collect_logits(model, valid_loader, device)
        v_loss = float(nn.functional.cross_entropy(v_logits, v_targets))
        v_acc = float((v_logits.argmax(1) == v_targets).float().mean())
        print(f"epoch {epoch:2d}/{args.epochs} train_loss={running / seen:.4f} train_acc={correct / seen:.4f} "
              f"valid_loss={v_loss:.4f} valid_acc={v_acc:.4f} ({time.time() - start:.0f}s)", flush=True)
        if v_loss < best_loss:  # select on validation NLL: better-ranked confidences than raw accuracy
            best_loss, best_epoch = v_loss, epoch
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}

    model.load_state_dict(best_state)
    v_logits, v_targets = collect_logits(model, valid_loader, device)
    temperature = fit_temperature(v_logits, v_targets)
    threshold = choose_threshold(v_logits, v_targets, temperature, args.target_precision)
    t_logits, t_targets = collect_logits(model, test_loader, device)
    valid_metrics = evaluate(v_logits, v_targets, valid_src, temperature, threshold)
    test_metrics = evaluate(t_logits, t_targets, test_src, temperature, threshold)
    print(f"best_epoch={best_epoch} temperature={temperature:.3f} threshold={threshold}")
    print("valid:", json.dumps(valid_metrics["all"]))
    print("test: ", json.dumps(test_metrics, indent=1), flush=True)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    export_onnx(model, args.input_size, args.out)
    summary_path = args.data / "summary.json"
    meta = {
        "architecture": "mobilenet_v3_small",
        "version": datetime.now(timezone.utc).strftime("%Y%m%d%H%M"),
        "labels": LABELS,
        "input_size": args.input_size,
        "mean": MEAN,
        "std": STD,
        "resize": "squash",
        "color_order": "RGB",
        "temperature": round(temperature, 4),
        "uncertain_threshold": threshold,
        "threshold_rule": f"lowest calibrated probability with precision >= {args.target_precision} "
                          "for both classes on the validation split",
        "training": {
            "datasets": {
                "syn": "procedural top-down lots (training/synth_topview.py)",
                "carpk": "CARPK drone images (Hsieh et al., ICCV 2017): GF1+GF2 train, NTU valid, TPZ test",
                "extra": [str(d) for d in args.extra_data],
            },
            "patch_counts": json.loads(summary_path.read_text()) if summary_path.exists() else None,
            "epochs": args.epochs,
            "best_epoch": best_epoch,
            "seed": args.seed,
        },
        "metrics": {"valid": valid_metrics, "test": test_metrics},
        "note": "Metrics are on synthetic scenes and on an unseen real lot (CARPK TPZ). "
                "They do not guarantee accuracy on a different camera or lot; validate on your own images.",
    }
    args.out.with_suffix(".json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.out} and {args.out.with_suffix('.json')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
