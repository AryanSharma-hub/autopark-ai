import copy
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.roi_manager import parse_config  # noqa: E402
from src.synthetic_lot import make_lot_image  # noqa: E402

CONFIG_DATA = {
    "version": 1,
    "layout_name": "test_layout",
    "placeholder": False,
    "reference_resolution": {"width": 1280, "height": 720},
    "aspect_ratio_tolerance": 0.15,
    "slots": [
        {"id": f"S{i + 1}", "x": 0.04 + i * 0.19, "y": 0.3, "w": 0.16, "h": 0.45}
        for i in range(5)
    ],
}


@pytest.fixture
def config_data():
    return copy.deepcopy(CONFIG_DATA)


@pytest.fixture
def config(config_data):
    return parse_config(config_data)


@pytest.fixture
def lot_image(config):
    """Synthetic lot with S2 and S4 occupied."""
    return make_lot_image(config, occupied=("S2", "S4"))


@pytest.fixture
def config_file(tmp_path, config_data):
    path = tmp_path / "roi.json"
    path.write_text(json.dumps(config_data))
    return path
