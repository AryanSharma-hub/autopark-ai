"""Command-line analysis: writes the annotated PNG and JSON report to output/.

Usage: python scripts/analyze.py IMAGE [--provider local|mock|ai] [--config PATH] [--strict]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

from src.image_annotator import annotate  # noqa: E402
from src.image_loader import ImageLoadError, encode_png, load_image_path  # noqa: E402
from src.occupancy_classifier import IncompatibleImageError, analyze_image  # noqa: E402
from src.roi_manager import DEFAULT_CONFIG_PATH, ROIConfigError, load_config  # noqa: E402
from src.vision_provider import ProviderError, get_provider  # noqa: E402


def main() -> int:
    load_dotenv(ROOT / ".env")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--provider", choices=["local", "mock", "ai"], default=None)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    parser.add_argument("--output", type=Path, default=ROOT / "output")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    try:
        image = load_image_path(args.image)
        config = load_config(args.config)
        provider = get_provider(args.provider)
        report = analyze_image(image, config, provider, strict=args.strict, image_filename=args.image.name)
    except (ImageLoadError, ROIConfigError, ProviderError, IncompatibleImageError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    args.output.mkdir(parents=True, exist_ok=True)
    png = args.output / f"annotated_{report.analysis_id}.png"
    js = args.output / f"report_{report.analysis_id}.json"
    png.write_bytes(encode_png(annotate(image, report)))
    js.write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")

    if report.is_demo_data:
        print("DEMO DATA - mock classifier, not AI")
    for w in report.warnings:
        print(f"warning: {w}")
    for slot in report.slots:
        print(f"{slot.slot_id}: {slot.status.value:<9} {slot.reason or ''}")
    s = report.summary
    print(f"empty={s.empty} occupied={s.occupied} uncertain={s.uncertain} free={list(s.empty_slot_ids)}")
    print(f"wrote {png}\nwrote {js}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
