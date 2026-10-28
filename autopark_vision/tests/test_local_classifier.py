"""LocalModelProvider tests. Logic tests use a fake ONNX session; the real-model
test runs only when models/slot_classifier.onnx exists."""

from types import SimpleNamespace

import numpy as np
import pytest

from src.local_classifier import DEFAULT_MODEL_PATH, LocalModelProvider, softmax
from src.occupancy_classifier import analyze_image
from src.schemas import ProviderSource, SlotStatus
from src.vision_provider import ProviderError

META = {
    "architecture": "mobilenet_v3_small",
    "version": "test",
    "labels": ["empty", "occupied"],
    "input_size": 32,
    "mean": [0.5, 0.5, 0.5],
    "std": [0.25, 0.25, 0.25],
    "temperature": 1.0,
    "uncertain_threshold": 0.8,
}


class FakeSession:
    """Returns fixed logits per call; records the input batch."""

    def __init__(self, logits):
        self.logits = np.asarray(logits, np.float32)
        self.inputs = []

    def get_inputs(self):
        return [SimpleNamespace(name="input")]

    def run(self, _outputs, feed):
        batch = feed["input"]
        self.inputs.append(batch)
        if isinstance(self.logits, Exception):
            raise self.logits
        return [np.repeat(self.logits[None, :], len(batch), axis=0) if self.logits.ndim == 1 else self.logits]


def make(logits, **meta_overrides):
    session = FakeSession(logits)
    return LocalModelProvider("unused.onnx", session=session, metadata={**META, **meta_overrides}), session


CROP = np.random.default_rng(0).integers(0, 255, (60, 40, 3), dtype=np.uint8)


def test_softmax_rows_sum_to_one():
    p = softmax(np.array([[1.0, 2.0], [1000.0, 0.0]]))
    assert np.allclose(p.sum(1), 1.0) and p[1, 0] == pytest.approx(1.0)


def test_preprocess_shape_and_normalization():
    provider, _ = make([0.0, 0.0])
    white = np.full((50, 70, 3), 255, np.uint8)
    batch = provider.preprocess([white, CROP])
    assert batch.shape == (2, 3, 32, 32) and batch.dtype == np.float32
    assert np.allclose(batch[0], (1.0 - 0.5) / 0.25)


def test_bgr_converted_to_rgb():
    provider, _ = make([0.0, 0.0])
    blue_bgr = np.zeros((40, 40, 3), np.uint8)
    blue_bgr[..., 0] = 255
    batch = provider.preprocess([blue_bgr])
    assert batch[0, 2].mean() > batch[0, 0].mean()  # channel 2 (B in RGB) is bright


@pytest.mark.parametrize(
    "logits,status",
    [([4.0, -4.0], SlotStatus.EMPTY), ([-4.0, 4.0], SlotStatus.OCCUPIED), ([0.2, 0.0], SlotStatus.UNCERTAIN)],
)
def test_decision_and_confidence(logits, status):
    provider, _ = make(logits)
    result = provider.classify(CROP, "S1")
    assert result.status is status
    assert 0.5 <= result.confidence <= 1.0
    assert "P(occupied)" in result.reason


def test_temperature_softens_probabilities():
    sharp, _ = make([2.0, 0.0])
    soft, _ = make([2.0, 0.0], temperature=4.0)
    assert sharp.classify(CROP, "S1").status is SlotStatus.EMPTY
    assert soft.classify(CROP, "S1").status is SlotStatus.UNCERTAIN


def test_threshold_override():
    provider = LocalModelProvider("x.onnx", uncertain_threshold=0.99, session=FakeSession([3.0, 0.0]), metadata=META)
    assert provider.classify(CROP, "S1").status is SlotStatus.UNCERTAIN


def test_label_order_respected():
    provider, _ = make([4.0, -4.0], labels=["occupied", "empty"])
    assert provider.classify(CROP, "S1").status is SlotStatus.OCCUPIED


def test_bad_metadata_and_threshold():
    with pytest.raises(ProviderError, match="labels"):
        make([0, 0], labels=["free", "taken"])
    with pytest.raises(ProviderError, match="threshold"):
        make([0, 0], uncertain_threshold=0.3)


def test_missing_model_files(tmp_path):
    with pytest.raises(ProviderError, match="metadata not found"):
        LocalModelProvider(tmp_path / "none.onnx")


def test_inference_failure_becomes_provider_error():
    provider, session = make([0, 0])
    session.logits = RuntimeError("bad input")
    with pytest.raises(ProviderError, match="inference failed"):
        provider.classify(CROP, "S1")


def test_empty_crop_rejected():
    provider, _ = make([0, 0])
    with pytest.raises(ProviderError):
        provider.classify(np.zeros((0, 0, 3), np.uint8), "S1")


def test_batch_matches_single():
    provider, _ = make([-3.0, 3.0])
    assert provider.classify_batch([CROP, CROP]) == [provider.classify(CROP, "S1")] * 2


def test_pipeline_with_local_provider(lot_image, config):
    provider, _ = make([-4.0, 4.0])
    report = analyze_image(lot_image, config, provider)
    assert report.provider.source is ProviderSource.AI and report.provider.name == "local-cnn"
    assert not report.is_demo_data
    assert report.summary.occupied == 5
    assert all(s.confidence is not None for s in report.slots)


@pytest.mark.skipif(not DEFAULT_MODEL_PATH.is_file(), reason="trained model not present")
def test_real_model_loads_and_predicts(lot_image, config):
    provider = LocalModelProvider()
    report = analyze_image(lot_image, config, provider)
    assert report.summary.total == 5
    assert all(0.5 <= s.confidence <= 1.0 for s in report.slots)
