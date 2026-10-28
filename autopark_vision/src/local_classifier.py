"""Offline slot classifier: a small CNN exported to ONNX, run with onnxruntime.

No network access at inference time. The model is produced by
``training/train.py`` and consists of two files:

* ``models/slot_classifier.onnx`` - the network (MobileNetV3-Small, 2 classes)
* ``models/slot_classifier.json`` - preprocessing, labels, calibration
  temperature, UNCERTAIN threshold and the metrics measured at training time

``confidence`` is the temperature-calibrated softmax probability of the
predicted class. Calibration was fitted on the PKLot validation split, so it
is only trustworthy on images that resemble that data.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

from .schemas import ProviderClassification, ProviderInfo, ProviderSource, SlotStatus
from .vision_provider import ProviderError

DEFAULT_MODEL_PATH = Path(__file__).resolve().parent.parent / "models" / "slot_classifier.onnx"
ENV_LOCAL_MODEL = "AUTOPARK_LOCAL_MODEL"
ENV_LOCAL_THRESHOLD = "AUTOPARK_LOCAL_THRESHOLD"

LABEL_TO_STATUS = {"empty": SlotStatus.EMPTY, "occupied": SlotStatus.OCCUPIED}


def softmax(logits: np.ndarray) -> np.ndarray:
    z = logits - logits.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)


class LocalModelProvider:
    """VisionProvider backed by a local ONNX model. Thread-safe for concurrent classify()."""

    def __init__(
        self,
        model_path: Optional[str | Path] = None,
        uncertain_threshold: Optional[float] = None,
        session=None,
        metadata: Optional[dict] = None,
    ):
        self.model_path = Path(model_path or os.getenv(ENV_LOCAL_MODEL) or DEFAULT_MODEL_PATH)
        if metadata is None:
            meta_path = self.model_path.with_suffix(".json")
            if not meta_path.is_file():
                raise ProviderError(
                    f"Local model metadata not found: {meta_path}. Train a model with "
                    "`python training/train.py` or set AUTOPARK_LOCAL_MODEL."
                )
            metadata = json.loads(meta_path.read_text(encoding="utf-8"))
        self.metadata = metadata
        self.labels: list[str] = list(metadata["labels"])
        if set(self.labels) != set(LABEL_TO_STATUS):
            raise ProviderError(f"Model labels {self.labels} must be {sorted(LABEL_TO_STATUS)}.")
        self.input_size = int(metadata["input_size"])
        self.mean = np.asarray(metadata["mean"], np.float32).reshape(1, 3, 1, 1)
        self.std = np.asarray(metadata["std"], np.float32).reshape(1, 3, 1, 1)
        self.temperature = float(metadata.get("temperature", 1.0))
        env_threshold = os.getenv(ENV_LOCAL_THRESHOLD)
        self.uncertain_threshold = float(
            uncertain_threshold
            if uncertain_threshold is not None
            else env_threshold or metadata.get("uncertain_threshold", 0.8)
        )
        if not 0.5 <= self.uncertain_threshold <= 1.0:
            raise ProviderError("Uncertain threshold must be in [0.5, 1.0].")

        if session is None:
            if not self.model_path.is_file():
                raise ProviderError(f"Local model not found: {self.model_path}.")
            try:
                import onnxruntime as ort
            except ImportError as exc:  # pragma: no cover - depends on install
                raise ProviderError("onnxruntime is not installed. Run: pip install -r requirements.txt") from exc
            options = ort.SessionOptions()
            options.log_severity_level = 3
            session = ort.InferenceSession(str(self.model_path), options, providers=["CPUExecutionProvider"])
        self._session = session
        self._input_name = session.get_inputs()[0].name

    @property
    def info(self) -> ProviderInfo:
        return ProviderInfo(
            source=ProviderSource.AI,
            name="local-cnn",
            model=f"{self.metadata.get('architecture', 'cnn')}@{self.metadata.get('version', 'unknown')}",
        )

    def preprocess(self, crops: list[np.ndarray]) -> np.ndarray:
        """BGR crops -> normalized NCHW float32 batch (squash-resize, as in training)."""
        size = (self.input_size, self.input_size)
        batch = np.stack(
            [cv2.cvtColor(cv2.resize(c, size, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB) for c in crops]
        ).astype(np.float32) / 255.0
        batch = batch.transpose(0, 3, 1, 2)
        return (batch - self.mean) / self.std

    def predict_proba(self, crops: list[np.ndarray]) -> np.ndarray:
        """Calibrated class probabilities, shape (N, len(labels))."""
        if any(c.size == 0 for c in crops):
            raise ProviderError("Empty crop.")
        try:
            logits = self._session.run(None, {self._input_name: self.preprocess(crops)})[0]
        except Exception as exc:
            raise ProviderError(f"Local model inference failed: {exc}") from exc
        return softmax(np.asarray(logits, np.float64) / self.temperature)

    def _decide(self, probs: np.ndarray) -> ProviderClassification:
        best = int(np.argmax(probs))
        p = float(probs[best])
        p_occ = float(probs[self.labels.index("occupied")])
        if p < self.uncertain_threshold:
            return ProviderClassification(
                SlotStatus.UNCERTAIN,
                confidence=round(p, 4),
                reason=f"Local CNN unsure: P(occupied)={p_occ:.2f}, below threshold {self.uncertain_threshold:.2f}.",
            )
        return ProviderClassification(
            LABEL_TO_STATUS[self.labels[best]],
            confidence=round(p, 4),
            reason=f"Local CNN: P(occupied)={p_occ:.2f}.",
        )

    def classify(self, crop: np.ndarray, slot_id: str) -> ProviderClassification:
        return self._decide(self.predict_proba([crop])[0])

    def classify_batch(self, crops: list[np.ndarray]) -> list[ProviderClassification]:
        return [self._decide(p) for p in self.predict_proba(crops)]
