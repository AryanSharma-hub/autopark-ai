import cv2
import numpy as np

from src.schemas import SLOT_IDS
from src.slot_detector import check_compatibility, crop_slots
from src.roi_manager import parse_config


def test_five_crops_in_order_with_expected_size(lot_image, config):
    crops = crop_slots(lot_image, config)
    assert [c.slot_id for c in crops] == list(SLOT_IDS)
    for c in crops:
        assert c.image.shape[:2] == (c.roi_pixels.h, c.roi_pixels.w)
        assert abs(c.roi_pixels.w - 0.16 * 1280) <= 1


def test_crops_are_copies(lot_image, config):
    crops = crop_slots(lot_image, config)
    crops[0].image[:] = 0
    assert lot_image.any()


def test_crops_scale_with_resolution(config, lot_image):
    small = cv2.resize(lot_image, (640, 360))
    crops = crop_slots(small, config)
    assert crops[0].roi_pixels.w == round(0.16 * 640)


def test_matching_image_is_compatible(lot_image, config):
    result = check_compatibility(lot_image, config, crop_slots(lot_image, config))
    assert result.compatible
    assert result.warnings == ()


def test_aspect_ratio_mismatch_flagged(config, lot_image):
    portrait = cv2.resize(lot_image, (720, 1280))
    result = check_compatibility(portrait, config, crop_slots(portrait, config))
    assert not result.compatible
    assert any("aspect ratio" in w for w in result.warnings)


def test_blank_crop_flagged(config):
    blank = np.full((720, 1280, 3), 128, np.uint8)
    result = check_compatibility(blank, config, crop_slots(blank, config))
    assert not result.compatible
    assert sum("almost uniform" in w for w in result.warnings) == 5


def test_placeholder_config_warns_but_stays_compatible(config_data, lot_image):
    config_data["placeholder"] = True
    config = parse_config(config_data)
    result = check_compatibility(lot_image, config, crop_slots(lot_image, config))
    assert result.compatible
    assert any("placeholders" in w for w in result.warnings)
