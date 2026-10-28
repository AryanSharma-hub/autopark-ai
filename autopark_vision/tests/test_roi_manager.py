import json

import pytest

from src.roi_manager import (
    DEFAULT_CONFIG_PATH,
    ROIConfigError,
    load_config,
    parse_config,
    save_config,
    to_pixels,
)
from src.schemas import SLOT_IDS, NormalizedROI


def test_shipped_config_is_valid():
    config = load_config(DEFAULT_CONFIG_PATH)
    assert tuple(s.slot_id for s in config.slots) == SLOT_IDS
    assert config.placeholder is True


def test_slots_sorted_into_canonical_order(config_data):
    config_data["slots"].reverse()
    assert tuple(s.slot_id for s in parse_config(config_data).slots) == SLOT_IDS


def test_missing_slot(config_data):
    config_data["slots"].pop()
    with pytest.raises(ROIConfigError, match="Missing slot ids"):
        parse_config(config_data)


def test_duplicate_slot(config_data):
    config_data["slots"][4]["id"] = "S1"
    with pytest.raises(ROIConfigError, match="Duplicate"):
        parse_config(config_data)


def test_unknown_slot(config_data):
    config_data["slots"].append({"id": "S6", "x": 0.0, "y": 0.0, "w": 0.03, "h": 0.03})
    with pytest.raises(ROIConfigError, match="Unknown slot id"):
        parse_config(config_data)


@pytest.mark.parametrize(
    "field,value,match",
    [
        ("x", -0.1, r"must be in \[0, 1\)"),
        ("w", 0.0, "must be in"),
        ("w", 0.99, "right edge"),
        ("h", 0.9, "bottom edge"),
        ("x", "0.1", "must be a number"),
        ("y", True, "must be a number"),
        ("x", float("nan"), "finite"),
    ],
)
def test_bad_coordinates(config_data, field, value, match):
    config_data["slots"][0][field] = value
    with pytest.raises(ROIConfigError, match=match):
        parse_config(config_data)


def test_missing_coordinate_key(config_data):
    del config_data["slots"][2]["h"]
    with pytest.raises(ROIConfigError, match="missing keys"):
        parse_config(config_data)


def test_overlapping_slots(config_data):
    config_data["slots"][1].update(x=0.05)
    with pytest.raises(ROIConfigError, match="overlap"):
        parse_config(config_data)


def test_invalid_json_file(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text("{not json")
    with pytest.raises(ROIConfigError, match="not valid JSON"):
        load_config(path)


def test_save_and_reload(tmp_path, config):
    path = save_config(config, tmp_path / "sub" / "roi.json")
    assert load_config(path) == config
    assert json.loads(path.read_text())["slots"][0]["id"] == "S1"


def test_to_pixels_scales_and_clamps():
    px = to_pixels(NormalizedROI(0.5, 0.25, 0.5, 0.5), 200, 100)
    assert (px.x, px.y, px.w, px.h) == (100, 25, 100, 50)
    px = to_pixels(NormalizedROI(0.9, 0.9, 0.1, 0.1), 101, 101)
    assert px.x + px.w <= 101 and px.y + px.h <= 101
