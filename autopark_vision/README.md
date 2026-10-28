# AutoPark AI — Five-Slot Parking Image Classifier

This is the image-labelling and occupancy-classification module of the AutoPark AI self-parking prototype. It takes one image of the cardboard parking lot, crops five fixed parking-slot regions (S1–S5), and classifies each one as `EMPTY`, `OCCUPIED` or `UNCERTAIN`. It then annotates the image and produces a JSON report.

Scope of this phase: this module only. There is no mobile app, FastAPI backend, ESP32 link, rover control, 2D map or automatic parking yet.

> **Accuracy has not been measured.** The tests use synthetic drawn images. No accuracy claim holds until the classifier is tested on representative photos of the real lot.

## Layout

```text
autopark_vision/
├── app.py                     Streamlit demo (UI only)
├── config/roi_config.json     Five slot regions, normalized 0–1
├── src/
│   ├── schemas.py             JSON-serializable request/response types, SLOT_IDS
│   ├── image_loader.py        Decode + validate uploads, JPEG/PNG encode
│   ├── roi_manager.py         Load/validate/save ROI config, scale to pixels
│   ├── slot_detector.py       Crop the five ROIs, layout-compatibility checks
│   ├── vision_provider.py     Provider interface, Claude provider, mock provider
│   ├── result_validator.py    Validate provider payloads and the S1–S5 result set
│   ├── occupancy_classifier.py  Service entry points: analyze_image / analyze_image_bytes
│   ├── image_annotator.py     Draw boxes, IDs, statuses, summary banner
│   └── synthetic_lot.py       Synthetic lot images for tests/demos (not photos)
├── scripts/
│   ├── make_sample_images.py  Write synthetic images to sample_images/
│   └── analyze.py             CLI: analyse one image, write PNG + JSON to output/
├── tests/                     pytest suite (no network)
├── sample_images/
└── output/
```

Dependencies only point one way: `app.py` and `scripts/` import `src/`, and `src/` never imports Streamlit. The pipeline stages are separate modules: preprocessing (`image_loader`), cropping (`roi_manager`, `slot_detector`), inference (`vision_provider`), validation (`result_validator`) and annotation (`image_annotator`).

## Setup

Requires Python 3.10 or newer. Run these commands from `autopark_vision/`:

```bash
python -m venv .venv
# Windows PowerShell:  .venv\Scripts\Activate.ps1
# macOS/Linux:         source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # Windows: copy .env.example .env
python scripts/make_sample_images.py
```

## Run

```bash
streamlit run app.py                                   # demo UI at http://localhost:8501
python scripts/analyze.py sample_images/synthetic_lot_S2_S4_occupied.png            # mock
python scripts/analyze.py path/to/photo.jpg --provider ai                           # Claude
python -m pytest                                       # tests
```

### Using the demo

1. Pick a provider in the sidebar. **Mock** works offline. **AI** calls Claude.
2. Upload an image.
3. Open **Adjust parking-slot regions**. Edit `x, y, w, h` for each slot and check the overlay and crops.
4. Click **Save regions for this image layout**. This writes `config/roi_config.json`, records the image resolution as the reference, and clears the `placeholder` flag.
5. Click **Classify slots**. The page shows the annotated image, the five crops with status and reason, the counts, and the free slot IDs. Use the download buttons to save the PNG and the JSON report.

## Local offline model (recommended)

`src/local_classifier.py` classifies slot crops with a small CNN on your own machine. It makes no API calls and needs no internet at inference time.

| | |
|---|---|
| Network | MobileNetV3-Small (about 1.5M parameters), 128×128 RGB input, ImageNet-pretrained, then fine-tuned to classify `empty` vs `occupied` |
| Runtime | `onnxruntime` on CPU. PyTorch is needed only for training. |
| Files | `models/slot_classifier.onnx` (about 6 MB) and `models/slot_classifier.json` (preprocessing, calibration, threshold, metrics) |
| Confidence | Softmax probability after temperature scaling, fitted on the validation split |
| UNCERTAIN | Returned when the confidence is below `uncertain_threshold`. The threshold is chosen on validation as the lowest value at which both classes reach at least 99.5% precision, so the model abstains rather than guesses. Override it with `AUTOPARK_LOCAL_THRESHOLD`. |

### Training dataset: AutoPark top-view

`training/build_dataset.py` builds the dataset from two sources and writes it to `training/data/topview/{train,valid,test}/{empty,occupied}`. Each filename is prefixed with its source.

1. **`syn`: procedural top-down lots** (`training/synth_topview.py`). Every label is exact, and the train, validation and test splits use disjoint random seeds. Variation covers:
   - **Grounds:** asphalt, concrete with seams, cardboard, paper, painted boards.
   - **Line styles:** white, yellow and black lines in full, T, open-end and double layouts.
   - **Vehicles:** real-style and toy cars (sedan, hatch, SUV, van, pickup, motorbike) with shading, glass, lights and shadows.
   - **Hard negatives in empty slots:** shadows, oil stains, arrows, numbers, wheel stoppers, leaves, manholes, tape, a neighbouring car's overhang.
   - **Camera and image effects:** lighting gradients, white balance, mild perspective, 90° rotations, blur, noise, resolution loss, JPEG compression.
   - **ROI misalignment:** about ±8% shift and scale, to mimic hand-set regions.
2. **`carpk`: real drone footage** of parking lots (CARPK, Hsieh et al., ICCV 2017, via the Hugging Face mirror `ShantyCam/carpk`). `training/fetch_carpk.py` reads only the frames it needs from the remote zip using HTTP Range requests.
   - **Occupied patches** are annotated cars with slot-like margins.
   - **Empty patches** are car-free regions the size of a car next to parked cars. Patches that are mostly vegetation are dropped. Crops with a car partly inside are skipped rather than labelled.
   - **Splits are by lot:** GF1 and GF2 for training, NTU for validation, TPZ for testing. The test lot is never seen during training.

To build and train:

```bash
pip install -r training/requirements-train.txt --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple
python training/fetch_carpk.py --per-lot 60   # about 400 MB of selected drone frames
python training/build_dataset.py              # synthetic + CARPK patches
python training/train.py                      # fine-tune, calibrate, set threshold, export ONNX
python training/evaluate.py                   # test split per source + hand-labelled photos
```

`training/prepare_pklot.py` is an optional extra source. PKLot is shot from angled CCTV cameras, not top-down.

**Adapting to your own lot.** This step improves quality the most. Save crops of your cardboard lot into `my_lot/empty/*.jpg` and `my_lot/occupied/*.jpg`, aim for 50 or more per class, and vary the lighting. Then run:

```bash
python training/train.py --extra-data my_lot
```

**Measuring accuracy on your lot.** Label held-out photos in a JSON file in `training/domain_test/`, following the format of `real_lot_1.json`, then rerun `evaluate.py`. PKLot metrics only measure performance on PKLot's own camera views.

## Provider configuration

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Claude API key. Alternatively run `ant auth login`. |
| `AUTOPARK_PROVIDER` | `mock` | Default provider for `scripts/analyze.py`: `local`, `mock` or `ai`. |
| `AUTOPARK_LOCAL_MODEL` | `models/slot_classifier.onnx` | Path to the local ONNX model. Its `.json` metadata must sit next to it. |
| `AUTOPARK_LOCAL_THRESHOLD` | from metadata (0.8) | Calibrated probability below which the local model returns `UNCERTAIN`. |
| `AUTOPARK_AI_MODEL` | `claude-opus-5-5` | Vision model. |
| `AUTOPARK_AI_TIMEOUT_SECONDS` | `60` | Per-request timeout. The SDK also retries twice. |
| `AUTOPARK_AI_FALLBACKS` | `1` | Server-side refusal fallback (`server-side-fallback-2026-07-01`, `fallbacks: "default"`). Set it to `0` to disable. |

Keys are read only from the environment or `.env`. `.env` is listed in `.gitignore`.

**How the AI provider works.** It makes one request per slot crop, and the five requests run in parallel. Each request uses structured output (a JSON schema with `status` and `reason`) and effort `low`. The response is validated again locally.

**Confidence.** Claude does not return a calibrated probability, so `confidence` is always `null` for AI results. The mock also reports `null`.

**Failures.** A network, auth, rate-limit or malformed-response failure on one slot makes only that slot `UNCERTAIN`, with `error` set. A refusal does the same. The report's `warnings` lists the failed slots.

**Mock provider.** The mock uses a deterministic Canny edge-density threshold. Its output is demo data: the report has `is_demo_data: true` and `provider.source: "mock"`, the reason text starts with `DEMO`, and the annotated image carries a banner. It is tuned only for the synthetic images.

**Swapping the provider.** Any object with an `info` property (`ProviderInfo`) and `classify(crop_bgr, slot_id) -> ProviderClassification` works. Pass it to `analyze_image(...)`.

## ROI configuration

`config/roi_config.json`:

```json
{
  "layout_name": "cardboard_lot_5_slots_placeholder",
  "placeholder": true,
  "reference_resolution": {"width": 1280, "height": 720},
  "aspect_ratio_tolerance": 0.15,
  "slots": [{"id": "S1", "x": 0.04, "y": 0.3, "w": 0.16, "h": 0.45}, "..."]
}
```

- Coordinates are fractions of the image width and height. `(x, y)` is the top-left corner.
- Validation requires exactly S1–S5, with no duplicates and no unknown IDs. Values must be numeric and finite, each region must lie inside the image, each side must be at least 2% of the image, and two slots may not overlap with IoU above 0.25.
- The shipped coordinates are placeholders (`placeholder: true`). Align them to a real photo of the lot before you trust any result.

**Compatibility check.** An image is marked `layout_compatible: false`, with warnings, when:

- its aspect ratio differs from the reference by more than the tolerance;
- any crop is smaller than 24 px on a side; or
- any crop is almost uniform (for example, the region is off the lot or the image is badly exposed).

By default the module still classifies and shows the warnings. `strict=True`, `--strict` or the sidebar checkbox refuses to classify instead.

## Report format (`AnalysisReport.to_dict()`)

```json
{
  "schema_version": "1.0",
  "analysis_id": "uuid4",
  "timestamp": "2026-10-26T18:05:00+00:00",
  "is_demo_data": false,
  "provider": {"source": "ai", "name": "anthropic", "model": "claude-opus-5-5"},
  "image": {"filename": "lot.jpg", "width": 1280, "height": 720},
  "layout": {"name": "cardboard_lot_5_slots", "placeholder": false, "compatible": true},
  "warnings": [],
  "slots": [
    {
      "slot_id": "S1",
      "roi": {"normalized": {"x": 0.04, "y": 0.3, "w": 0.16, "h": 0.45},
              "pixels": {"x": 51, "y": 216, "w": 205, "h": 324}},
      "status": "EMPTY",
      "confidence": null,
      "reason": "Bare cardboard with painted lines, no vehicle.",
      "source": "ai",
      "error": null
    }
  ],
  "summary": {"empty": 3, "occupied": 2, "uncertain": 0, "total": 5, "empty_slot_ids": ["S1", "S3", "S5"]}
}
```

`slots` always holds exactly S1–S5, in that order.

## Future FastAPI integration contract

This section describes a future endpoint. It is not implemented in this phase.

**Endpoint:** `POST /api/parking/analyze`, `multipart/form-data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `image` | file (jpg/png/bmp/webp, ≤ 20 MB) | yes | One photo of the lot from the fixed camera position |
| `provider` | `"ai"` \| `"mock"` | no | Defaults to the server's `AUTOPARK_PROVIDER` |
| `strict` | bool | no | If true, an image that does not fit the layout is rejected with 422 |

**Response 200:** the `AnalysisReport` JSON shown above.

**Errors:**

- 400: undecodable or invalid image (`ImageLoadError`).
- 422: incompatible layout in strict mode (`IncompatibleImageError.warnings`).
- 500: invalid server ROI config (`ROIConfigError`).

A failure inside the provider does not make the request fail. It returns 200, and the affected slots are `UNCERTAIN` with `error` set.

A sketch of the endpoint:

```python
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from src.occupancy_classifier import IncompatibleImageError, analyze_image_bytes
from src.image_loader import ImageLoadError
from src.vision_provider import get_provider

app = FastAPI()

@app.post("/api/parking/analyze")
def analyze(image: UploadFile = File(...), provider: str | None = Form(None), strict: bool = Form(False)):
    try:
        report = analyze_image_bytes(image.file.read(), image.filename, provider=get_provider(provider), strict=strict)
    except ImageLoadError as e:
        raise HTTPException(400, str(e))
    except IncompatibleImageError as e:
        raise HTTPException(422, {"warnings": list(e.warnings)})
    return report.to_dict()
```

Use a sync `def` route, or `run_in_threadpool`, because analysis blocks on five provider calls.

**Notes for the React Native + Expo app:**

- Upload with `FormData`, then render `summary.empty_slot_ids` as the selectable slots.
- Show `UNCERTAIN` slots as not selectable.
- Show `warnings` to the user.
- Hide or label results when `is_demo_data` is true.

**Mapping to the physical lot:** S1–S5 are stable logical IDs (`src/schemas.py: SLOT_IDS`). The backend should keep its own `slot_id -> rover route` table. ROI coordinates may change when the camera moves, but the IDs must not.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ModuleNotFoundError: cv2` / `streamlit` | Activate the venv, then run `pip install -r requirements.txt`. |
| `ModuleNotFoundError: src` | Run commands from `autopark_vision/`. |
| AI slots show "rejected the credentials (401)" | Set `ANTHROPIC_API_KEY` in `.env`, then restart Streamlit. |
| "Model ... not found (404)" | Check `AUTOPARK_AI_MODEL`. |
| "rate limit (429)" | Wait and retry. Five requests run per image. |
| "Could not connect" | Check network or proxy settings. Use Mock offline. |
| Red "aspect ratio" error | The photo framing differs from the saved layout. Re-align the ROIs and save, or crop the photo to match. |
| "almost uniform" warning | The ROI is off the lot, or the image is over- or under-exposed. |
| Placeholder warning | The shipped ROIs are not aligned to any real photo. Adjust them and save. |
| Mock gives wrong labels on real photos | Expected. The mock is a demo heuristic. Use the AI provider. |
| Saved ROI config is invalid at start-up | Fix `config/roi_config.json`. The error message names the field. |
