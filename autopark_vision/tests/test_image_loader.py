import numpy as np
import pytest

from src.image_loader import ImageLoadError, encode_jpeg, encode_png, load_image_bytes, load_image_path


def test_png_round_trip(lot_image):
    decoded = load_image_bytes(encode_png(lot_image), "lot.png")
    assert decoded.shape == lot_image.shape
    assert np.array_equal(decoded, lot_image)


def test_jpeg_decodes(lot_image):
    assert load_image_bytes(encode_jpeg(lot_image), "lot.jpg").shape == lot_image.shape


@pytest.mark.parametrize("data", [b"", b"not an image at all"])
def test_rejects_empty_or_garbage(data):
    with pytest.raises(ImageLoadError):
        load_image_bytes(data, "x.png")


def test_rejects_bad_extension(lot_image):
    with pytest.raises(ImageLoadError, match="Unsupported"):
        load_image_bytes(encode_png(lot_image), "lot.gif")


def test_rejects_tiny_image():
    tiny = np.zeros((50, 50, 3), np.uint8)
    with pytest.raises(ImageLoadError, match="minimum"):
        load_image_bytes(encode_png(tiny), "tiny.png")


def test_greyscale_file_is_converted_to_bgr():
    grey = np.full((200, 300), 128, np.uint8)
    assert load_image_bytes(encode_png(grey), "g.png").shape == (200, 300, 3)


def test_missing_path(tmp_path):
    with pytest.raises(ImageLoadError, match="not found"):
        load_image_path(tmp_path / "nope.png")
