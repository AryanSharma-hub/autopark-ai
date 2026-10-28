/**
 * Mobile classifier vs. the original Python pipeline, on identical images.
 *
 * Reference data comes from tools/parity/make_reference.py, which runs
 * autopark_vision/src (cv2 + onnxruntime) unchanged. The same ONNX file is run
 * here through onnxruntime-node AND through onnxLite, the TypeScript interpreter
 * the app uses on the phone; both must reproduce the Python decisions.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as ort from 'onnxruntime-node';

import { decodeImageBytes } from '../src/core/vision/decode';
import { resizeArea } from '../src/core/vision/resize';
import { parseROIConfig, cropSlots, ROIConfigJson } from '../src/core/vision/roi';
import {
  analyzeImage,
  ModelRunner,
  preprocessCrop,
  settingsFromMetadata,
  ModelMetadata,
} from '../src/core/vision/classifier';
import { LiteModel, parseOnnxModel, runOnnxModel } from '../src/core/vision/onnxLite';

const FIX = path.join(__dirname, 'fixtures');
const MODEL_DIR = path.join(__dirname, '..', 'assets', 'model');
const ref = JSON.parse(fs.readFileSync(path.join(FIX, 'parity_reference.json'), 'utf8'));
const resizeRef: { w: number; h: number; src: string; dst_sha256: string }[] = JSON.parse(
  fs.readFileSync(path.join(FIX, 'resize_reference.json'), 'utf8'),
);
const meta: ModelMetadata = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'slot_classifier.json'), 'utf8'));
const settings = settingsFromMetadata(meta);
const configs: Record<string, ROIConfigJson> = {
  roi_config: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'roi', 'roi_config.json'), 'utf8')),
  roi_real_lot_1: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'roi', 'roi_real_lot_1.json'), 'utf8')),
};

const sha = (b: ArrayBufferView) => createHash('sha256').update(Buffer.from(b.buffer, b.byteOffset, b.byteLength)).digest('hex');

let session: ort.InferenceSession;
const runner: ModelRunner = {
  async run(input, dims) {
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, dims) });
    return out[session.outputNames[0]].data as Float32Array;
  },
};

let lite: LiteModel;
const liteRunner: ModelRunner = {
  async run(input, dims) {
    const out = await runOnnxModel(lite, { [lite.inputs[0]]: { dims: [...dims], data: input } });
    return out[lite.outputs[0]].data;
  },
};

beforeAll(async () => {
  session = await ort.InferenceSession.create(path.join(MODEL_DIR, 'slot_classifier.onnx'));
  lite = parseOnnxModel(new Uint8Array(fs.readFileSync(path.join(MODEL_DIR, 'slot_classifier.onnx'))));
});

describe('model metadata', () => {
  test('matches the documented architecture and calibration', () => {
    expect(meta.architecture).toBe('mobilenet_v3_small');
    expect(meta.input_size).toBe(96);
    expect(meta.labels).toEqual(['empty', 'occupied']);
    expect(meta.temperature).toBeCloseTo(0.5901, 4); // summary says 0.59; the JSON value is used at runtime
    expect(meta.uncertain_threshold).toBe(0.9875);
    expect(settings.uncertainThreshold).toBe(ref.threshold);
    expect(settings.temperature).toBe(ref.temperature);
  });
  test('ONNX graph has the expected input/output', () => {
    expect(session.inputNames).toEqual(['input']);
    expect(session.outputNames).toEqual(['logits']);
  });
});

describe('cv2.resize INTER_AREA port', () => {
  test.each(resizeRef.map((c) => [`${c.w}x${c.h}`, c] as const))('%s -> 96x96 is bit-exact', (_n, c) => {
    const src = { width: c.w, height: c.h, data: new Uint8Array(Buffer.from(c.src, 'base64')) };
    const out = resizeArea(src, 96, 96);
    expect(sha(out.data)).toBe(c.dst_sha256);
  });
});

describe.each<[string, () => ModelRunner]>([
  ['onnxruntime-node', () => runner],
  ['onnxLite (app runtime)', () => liteRunner],
])('end-to-end parity with autopark_vision via %s', (_name, getRunner) => {
  const pngCases = ref.cases.filter((c: any) => c.image.endsWith('.png'));
  const jpgCases = ref.cases.filter((c: any) => c.image.endsWith('.jpg'));

  test.each<[string, any]>(pngCases.map((c: any) => [`${c.image} / ${c.config}`, c]))('%s (PNG: exact)', async (_n, c) => {
    const bytes = new Uint8Array(fs.readFileSync(path.join(FIX, 'images', c.image)));
    const img = decodeImageBytes(bytes, c.image);
    expect([img.width, img.height]).toEqual([c.width, c.height]);
    expect(sha(img.data)).toBe(c.decoded_sha256);
    const cfg = parseROIConfig(configs[c.config]);
    const crops = cropSlots(img, cfg);
    const t = preprocessCrop(crops[0].image, settings);
    expect(sha(t)).toBe(c.first_crop_tensor_sha256);
    const report = await analyzeImage(img, cfg, settings, getRunner(), { filename: c.image });
    expect(report.layout.compatible).toBe(c.compatible);
    expect(report.warnings).toEqual(c.warnings);
    expect(report.summary.empty_slot_ids).toEqual(c.empty_slot_ids);
    report.slots.forEach((s, i) => {
      const r = c.slots[i];
      expect(s.slot_id).toBe(r.slot_id);
      expect(s.roi.pixels).toEqual(r.pixels);
      expect(s.status).toBe(r.status);
      expect(s.confidence).toBeCloseTo(r.confidence, 4);
      expect(s.p_occupied!).toBeCloseTo(r.p_occupied, 6);
    });
  });

  // jpeg-js and libjpeg-turbo (used by cv2) use different IDCT/chroma upsampling, so
  // decoded pixels differ by a few levels. Statuses must still agree; probabilities
  // are reported and bounded.
  test.each<[string, any]>(jpgCases.map((c: any) => [`${c.image} / ${c.config}`, c]))('%s (JPEG: same decisions)', async (_n, c) => {
    const bytes = new Uint8Array(fs.readFileSync(path.join(FIX, 'images', c.image)));
    const img = decodeImageBytes(bytes, c.image);
    expect([img.width, img.height]).toEqual([c.width, c.height]); // EXIF orientation applied like cv2
    const cfg = parseROIConfig(configs[c.config]);
    const report = await analyzeImage(img, cfg, settings, getRunner(), { filename: c.image });
    expect(report.layout.compatible).toBe(c.compatible);
    const deltas: number[] = [];
    report.slots.forEach((s, i) => {
      const r = c.slots[i];
      expect(s.roi.pixels).toEqual(r.pixels);
      expect(s.status).toBe(r.status);
      deltas.push(Math.abs(s.p_occupied! - r.p_occupied));
    });
    expect(Math.max(...deltas)).toBeLessThan(0.05);
  });
});
