"""End-to-end pipeline: analysis, counts, annotation, JSON report."""

import json

import cv2
import numpy as np
import pytest

from src.image_annotator import STATUS_COLORS, annotate, draw_roi_preview
from src.image_loader import encode_png
from src.occupancy_classifier import IncompatibleImageError, analyze_image, analyze_image_bytes, summarize
from src.schemas import SLOT_IDS, ProviderClassification, ProviderInfo, ProviderSource, SlotStatus
from src.vision_provider import MockVisionProvider, ProviderError


class ScriptedProvider:
    """Returns fixed answers per slot; raises for slots mapped to an exception."""

    def __init__(self, answers):
        self.answers = answers

    @property
    def info(self):
        return ProviderInfo(ProviderSource.AI, "scripted", "test-model")

    def classify(self, crop, slot_id):
        answer = self.answers[slot_id]
        if isinstance(answer, Exception):
            raise answer
        return ProviderClassification(answer, reason=f"{slot_id} scripted")


def test_mock_analysis_report(lot_image, config):
    report = analyze_image(lot_image, config, MockVisionProvider(), image_filename="lot.png")
    assert tuple(s.slot_id for s in report.slots) == SLOT_IDS
    assert report.is_demo_data
    assert report.layout_compatible
    s = report.summary
    assert (s.empty, s.occupied, s.uncertain, s.total) == (3, 2, 0, 5)
    assert s.empty_slot_ids == ("S1", "S3", "S5")


def test_report_json_contract(lot_image, config):
    report = analyze_image(lot_image, config, MockVisionProvider(), image_filename="lot.png")
    data = json.loads(json.dumps(report.to_dict()))
    assert data["is_demo_data"] is True
    assert data["provider"]["source"] == "mock"
    assert data["image"] == {"filename": "lot.png", "width": 1280, "height": 720}
    assert len(data["analysis_id"]) == 36 and data["timestamp"].endswith("+00:00")
    slot = data["slots"][0]
    assert set(slot) == {"slot_id", "roi", "status", "confidence", "reason", "source", "error"}
    assert slot["roi"]["normalized"] == {"x": 0.04, "y": 0.3, "w": 0.16, "h": 0.45}
    assert slot["roi"]["pixels"]["w"] == 205
    assert slot["confidence"] is None and slot["source"] == "mock"
    assert data["summary"]["empty_slot_ids"] == ["S1", "S3", "S5"]


def test_provider_failure_isolated_to_slot(lot_image, config):
    provider = ScriptedProvider({
        "S1": SlotStatus.EMPTY, "S2": ProviderError("boom"), "S3": SlotStatus.OCCUPIED,
        "S4": RuntimeError("bug"), "S5": SlotStatus.EMPTY,
    })
    report = analyze_image(lot_image, config, provider)
    by_id = {s.slot_id: s for s in report.slots}
    assert by_id["S2"].status is SlotStatus.UNCERTAIN and by_id["S2"].error == "boom"
    assert by_id["S4"].status is SlotStatus.UNCERTAIN and "RuntimeError" in by_id["S4"].error
    assert by_id["S1"].source is ProviderSource.AI
    assert not report.is_demo_data
    assert (report.summary.empty, report.summary.occupied, report.summary.uncertain) == (2, 1, 2)
    assert any("S2, S4" in w for w in report.warnings)


def test_strict_mode_rejects_incompatible(lot_image, config):
    portrait = cv2.resize(lot_image, (720, 1280))
    with pytest.raises(IncompatibleImageError):
        analyze_image(portrait, config, MockVisionProvider(), strict=True)
    report = analyze_image(portrait, config, MockVisionProvider())
    assert not report.layout_compatible and report.warnings


def test_analyze_bytes(lot_image, config):
    report = analyze_image_bytes(encode_png(lot_image), "lot.png", config, MockVisionProvider())
    assert report.summary.total == 5


def test_summarize_counts():
    class R:
        def __init__(self, i, st):
            self.slot_id, self.status = i, st
    s = summarize([R("S1", SlotStatus.OCCUPIED), R("S2", SlotStatus.UNCERTAIN), R("S3", SlotStatus.EMPTY)])
    assert (s.empty, s.occupied, s.uncertain, s.total, s.empty_slot_ids) == (1, 1, 1, 3, ("S3",))


def test_annotation_draws_status_colours(lot_image, config):
    report = analyze_image(lot_image, config, MockVisionProvider())
    before = lot_image.copy()
    out = annotate(lot_image, report)
    assert np.array_equal(before, lot_image)
    assert out.shape == lot_image.shape and not np.array_equal(out, lot_image)
    for slot in report.slots:
        px = slot.roi_pixels
        # bottom border line sits inside the ROI and is drawn in the status colour
        y = px.y + px.h - 2
        assert tuple(out[y, px.x + px.w // 2]) == STATUS_COLORS[slot.status]


def test_roi_preview_does_not_modify_input(lot_image, config):
    before = lot_image.copy()
    out = draw_roi_preview(lot_image, config)
    assert np.array_equal(before, lot_image) and not np.array_equal(out, lot_image)
