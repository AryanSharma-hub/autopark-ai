"""Temporary Streamlit demo for the five-slot parking classifier.

Run:  streamlit run app.py
All analysis logic lives in src/; this file only handles UI.
"""

from __future__ import annotations

import json

import cv2
import pandas as pd
import streamlit as st
from dotenv import load_dotenv

from src.image_annotator import STATUS_COLORS, annotate, draw_roi_preview
from src.image_loader import ImageLoadError, encode_png, load_image_bytes
from src.local_classifier import DEFAULT_MODEL_PATH as LOCAL_MODEL_PATH, LocalModelProvider
from src.occupancy_classifier import analyze_image
from src.roi_manager import DEFAULT_CONFIG_PATH, ROIConfigError, load_config, parse_config, save_config
from src.slot_detector import check_compatibility, crop_slots
from src.vision_provider import (
    ENV_MODEL,
    DEFAULT_MODEL,
    MockVisionProvider,
    ProviderError,
    ai_credentials_present,
    AnthropicVisionProvider,
)

load_dotenv()
st.set_page_config(page_title="AutoPark AI - Slot Classifier", layout="wide")


def rgb(image):
    return cv2.cvtColor(image, cv2.COLOR_BGR2RGB)


def config_to_frame(config) -> pd.DataFrame:
    return pd.DataFrame(
        [{"id": s.slot_id, "x": s.roi.x, "y": s.roi.y, "w": s.roi.w, "h": s.roi.h} for s in config.slots]
    )


def frame_to_config(frame: pd.DataFrame, base, width: int | None, height: int | None, placeholder: bool):
    data = base.to_dict()
    data["slots"] = [
        {"id": str(r["id"]), "x": float(r["x"]), "y": float(r["y"]), "w": float(r["w"]), "h": float(r["h"])}
        for r in frame.to_dict("records")
    ]
    data["placeholder"] = placeholder
    if width and height:
        data["reference_resolution"] = {"width": width, "height": height}
    return parse_config(data)


# ---------------------------------------------------------------- state
try:
    saved_config = load_config()
except ROIConfigError as exc:
    st.error(f"Saved ROI config is invalid: {exc}")
    st.stop()

if "roi_frame" not in st.session_state:
    st.session_state.roi_frame = config_to_frame(saved_config)

# ---------------------------------------------------------------- sidebar
st.sidebar.header("Classifier")
provider_choice = st.sidebar.radio(
    "Provider",
    ["Local model (offline CNN)", "Mock (demo data, offline)", "AI (Claude vision, online)"],
    help="Local: small CNN in models/, no network. Mock: deterministic heuristic, not an AI prediction.",
)
use_ai = provider_choice.startswith("AI")
use_local = provider_choice.startswith("Local")
if use_local:
    if LOCAL_MODEL_PATH.is_file():
        _meta = json.loads(LOCAL_MODEL_PATH.with_suffix(".json").read_text(encoding="utf-8"))
        _test = _meta.get("metrics", {}).get("test", {})
        st.sidebar.caption(
            f"Model: `{_meta.get('architecture')}@{_meta.get('version')}` — PKLot test accuracy "
            f"{_test.get('accuracy', 'n/a')}. Not measured on your lot."
        )
    else:
        st.sidebar.warning("No local model found. Run `python training/train.py` first.")
if use_ai:
    import os

    st.sidebar.caption(f"Model: `{os.getenv(ENV_MODEL, DEFAULT_MODEL)}`")
    if not ai_credentials_present():
        st.sidebar.warning(
            "ANTHROPIC_API_KEY is not set. Add it to `.env` (see `.env.example`). "
            "A saved `ant auth login` profile also works."
        )
strict = st.sidebar.checkbox(
    "Strict layout check", value=False,
    help="Refuse to classify when the image does not fit the ROI layout.",
)
st.sidebar.divider()
st.sidebar.caption(f"ROI config: `{DEFAULT_CONFIG_PATH.name}` — layout `{saved_config.layout_name}`")

# ---------------------------------------------------------------- main
st.title("AutoPark AI — Five-Slot Occupancy Classifier")
st.caption("Prototype module. Slot IDs S1–S5 are stable and map to the five physical slots.")

upload = st.file_uploader("Parking-lot image", type=["jpg", "jpeg", "png", "bmp", "webp"])
if upload is None:
    st.info("Upload an image to begin. A synthetic test image is in `sample_images/` "
            "(run `python scripts/make_sample_images.py` if it is missing).")
    st.stop()

try:
    image = load_image_bytes(upload.getvalue(), upload.name)
except ImageLoadError as exc:
    st.error(str(exc))
    st.stop()
img_h, img_w = image.shape[:2]

# ---------------------------------------------------------------- ROI editor
with st.expander("Adjust parking-slot regions (normalized 0–1 coordinates)", expanded=saved_config.placeholder):
    st.caption("x, y = top-left corner; w, h = size. All values are fractions of image width/height.")
    edited = st.data_editor(
        st.session_state.roi_frame,
        disabled=["id"],
        hide_index=True,
        num_rows="fixed",
        column_config={
            c: st.column_config.NumberColumn(c, min_value=0.0, max_value=1.0, step=0.005, format="%.3f")
            for c in ("x", "y", "w", "h")
        },
        key="roi_editor",
    )
    try:
        working_config = frame_to_config(edited, saved_config, None, None, saved_config.placeholder)
        roi_error = None
    except ROIConfigError as exc:
        working_config, roi_error = saved_config, str(exc)
        st.error(f"Invalid regions, using saved config: {roi_error}")

    preview_col, crops_col = st.columns([3, 2])
    preview_col.image(rgb(draw_roi_preview(image, working_config)), caption="ROI preview",
                      width="stretch")
    preview_crops = crop_slots(image, working_config)
    cols = crops_col.columns(5)
    for col, crop in zip(cols, preview_crops):
        col.image(rgb(crop.image), caption=crop.slot_id, width="stretch")

    b1, b2 = st.columns(2)
    if b1.button("Save regions for this image layout", disabled=roi_error is not None, type="primary"):
        to_save = frame_to_config(edited, saved_config, img_w, img_h, placeholder=False)
        save_config(to_save)
        st.session_state.roi_frame = config_to_frame(to_save)
        st.success(f"Saved to {DEFAULT_CONFIG_PATH} (reference resolution {img_w}x{img_h}).")
        st.rerun()
    if b2.button("Revert to saved regions"):
        st.session_state.roi_frame = config_to_frame(saved_config)
        st.session_state.pop("roi_editor", None)
        st.rerun()

compat = check_compatibility(image, working_config, preview_crops)
for w in compat.warnings:
    (st.warning if compat.compatible else st.error)(w)

# ---------------------------------------------------------------- analysis
if not st.button("Classify slots", type="primary"):
    st.stop()

if strict and not compat.compatible:
    st.error("Strict layout check is on and the image does not fit the ROI layout. Nothing classified.")
    st.stop()

try:
    if use_local:
        provider = LocalModelProvider()
    elif use_ai:
        provider = AnthropicVisionProvider()
    else:
        provider = MockVisionProvider()
except ProviderError as exc:
    st.error(str(exc))
    st.stop()

with st.spinner("Classifying five slots…"):
    report = analyze_image(image, working_config, provider, image_filename=upload.name)

if report.is_demo_data:
    st.warning("DEMO DATA — these results come from the offline mock heuristic, not an AI model.")

annotated = annotate(image, report)
report_dict = report.to_dict()
s = report.summary

m1, m2, m3, m4 = st.columns(4)
m1.metric("Empty", s.empty)
m2.metric("Occupied", s.occupied)
m3.metric("Uncertain", s.uncertain)
m4.metric("Free slots", ", ".join(s.empty_slot_ids) or "none")

st.image(rgb(annotated), caption="Annotated result", width="stretch")

st.subheader("Per-slot results")
crop_by_id = {c.slot_id: c for c in preview_crops}
cols = st.columns(5)
for col, slot in zip(cols, report.slots):
    b, g, r = STATUS_COLORS[slot.status]
    col.image(rgb(crop_by_id[slot.slot_id].image), width="stretch")
    col.markdown(f"**{slot.slot_id}** — <span style='color:rgb({r},{g},{b})'>**{slot.status.value}**</span>",
                 unsafe_allow_html=True)
    col.caption(f"Confidence: {'unavailable' if slot.confidence is None else f'{slot.confidence:.2f}'}")
    if slot.reason:
        col.caption(slot.reason)
    if slot.error:
        col.error(slot.error)

for w in report.warnings:
    if w not in compat.warnings:
        st.warning(w)

d1, d2 = st.columns(2)
d1.download_button("Download annotated image (PNG)", encode_png(annotated),
                   file_name=f"annotated_{report.analysis_id}.png", mime="image/png")
d2.download_button("Download report (JSON)", json.dumps(report_dict, indent=2),
                   file_name=f"report_{report.analysis_id}.json", mime="application/json")

with st.expander("JSON report"):
    st.json(report_dict)
