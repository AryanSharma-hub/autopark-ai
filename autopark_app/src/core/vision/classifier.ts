/**
 * On-device port of autopark_vision/src/local_classifier.py + occupancy_classifier.py.
 *
 *   slot crop (BGR) -> INTER_AREA resize to 96x96 (squash) -> BGR->RGB -> /255
 *   -> (x - mean) / std  [float32, NCHW] -> MobileNetV3-Small ONNX -> logits
 *   -> logits / T -> softmax (float64) -> max p >= threshold ? EMPTY|OCCUPIED : UNCERTAIN
 *
 * The ONNX runtime is injected through `ModelRunner` so this file runs unchanged
 * with onnxruntime-react-native (phone) and onnxruntime-node (parity tests).
 */

import { ImageBGR } from './image';
import { resizeArea } from './resize';
import { ROIConfig, SLOT_IDS, SlotId, checkCompatibility, cropSlots, NormalizedROI, PixelROI } from './roi';
import { validateImage } from './decode';

export type SlotStatus = 'EMPTY' | 'OCCUPIED' | 'UNCERTAIN';

export interface ModelMetadata {
  architecture?: string;
  version?: string;
  labels: string[];
  input_size: number;
  mean: number[];
  std: number[];
  resize?: string;
  color_order?: string;
  temperature?: number;
  uncertain_threshold?: number;
}

export interface ModelRunner {
  /** Run the network on an NCHW float32 batch; returns logits, row-major [batch, labels]. */
  run(input: Float32Array, dims: [number, number, number, number]): Promise<Float32Array>;
}

export class ClassifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassifierError';
  }
}

export interface ClassifierSettings {
  labels: string[];
  inputSize: number;
  mean: Float32Array;
  std: Float32Array;
  temperature: number;
  uncertainThreshold: number;
  modelName: string;
}

export function settingsFromMetadata(meta: ModelMetadata, thresholdOverride?: number): ClassifierSettings {
  const labels = [...meta.labels];
  if (labels.length !== 2 || !labels.includes('empty') || !labels.includes('occupied')) {
    throw new ClassifierError(`Model labels ${JSON.stringify(labels)} must be ["empty", "occupied"].`);
  }
  if ((meta.resize ?? 'squash') !== 'squash') throw new ClassifierError(`Unsupported resize mode ${meta.resize}.`);
  if ((meta.color_order ?? 'RGB') !== 'RGB') throw new ClassifierError(`Unsupported colour order ${meta.color_order}.`);
  const threshold = thresholdOverride ?? meta.uncertain_threshold ?? 0.8;
  if (!(threshold >= 0.5 && threshold <= 1.0)) throw new ClassifierError('Uncertain threshold must be in [0.5, 1.0].');
  const temperature = meta.temperature ?? 1.0;
  if (!(temperature > 0)) throw new ClassifierError('Temperature must be positive.');
  return {
    labels,
    inputSize: Math.trunc(meta.input_size),
    mean: Float32Array.from(meta.mean),
    std: Float32Array.from(meta.std),
    temperature,
    uncertainThreshold: threshold,
    modelName: `${meta.architecture ?? 'cnn'}@${meta.version ?? 'unknown'}`,
  };
}

/** BGR crop -> normalized CHW float32 (one image), exactly like LocalModelProvider.preprocess. */
export function preprocessCrop(crop: ImageBGR, s: ClassifierSettings): Float32Array {
  if (crop.width === 0 || crop.height === 0) throw new ClassifierError('Empty crop.');
  const n = s.inputSize;
  const resized = resizeArea(crop, n, n);
  const out = new Float32Array(3 * n * n);
  const plane = n * n;
  const f = Math.fround;
  for (let i = 0; i < plane; i++) {
    const b = resized.data[i * 3];
    const g = resized.data[i * 3 + 1];
    const r = resized.data[i * 3 + 2];
    // channel 0 = R, 1 = G, 2 = B (after BGR->RGB). numpy: float32(x)/255.0 then (x - mean)/std in float32.
    out[i] = f(f(f(r / 255) - s.mean[0]) / s.std[0]);
    out[plane + i] = f(f(f(g / 255) - s.mean[1]) / s.std[1]);
    out[2 * plane + i] = f(f(f(b / 255) - s.mean[2]) / s.std[2]);
  }
  return out;
}

export function softmax(values: number[]): number[] {
  const m = Math.max(...values);
  const e = values.map((v) => Math.exp(v - m));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}

export function calibratedProbabilities(logits: ArrayLike<number>, temperature: number): number[] {
  return softmax(Array.from(logits, (v) => v / temperature));
}

export interface SlotDecision {
  status: SlotStatus;
  confidence: number; // rounded to 4 decimals, like the Python report
  probability: number; // unrounded max probability
  pOccupied: number;
  pEmpty: number;
  reason: string;
}

export function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

export function decide(probs: number[], s: ClassifierSettings): SlotDecision {
  const best = probs[0] >= probs[1] ? 0 : 1; // numpy argmax returns the first maximum
  const p = probs[best];
  const pOcc = probs[s.labels.indexOf('occupied')];
  const pEmpty = probs[s.labels.indexOf('empty')];
  if (p < s.uncertainThreshold) {
    return {
      status: 'UNCERTAIN',
      confidence: round4(p),
      probability: p,
      pOccupied: pOcc,
      pEmpty,
      reason: `Local CNN unsure: P(occupied)=${pOcc.toFixed(2)}, below threshold ${s.uncertainThreshold.toFixed(2)}.`,
    };
  }
  return {
    status: s.labels[best] === 'empty' ? 'EMPTY' : 'OCCUPIED',
    confidence: round4(p),
    probability: p,
    pOccupied: pOcc,
    pEmpty,
    reason: `Local CNN: P(occupied)=${pOcc.toFixed(2)}.`,
  };
}

export async function classifyCrop(crop: ImageBGR, s: ClassifierSettings, runner: ModelRunner): Promise<SlotDecision> {
  const input = preprocessCrop(crop, s);
  let logits: Float32Array;
  try {
    logits = await runner.run(input, [1, 3, s.inputSize, s.inputSize]);
  } catch (e) {
    throw new ClassifierError(`Local model inference failed: ${(e as Error).message}`);
  }
  if (logits.length < s.labels.length) throw new ClassifierError('Model returned too few logits.');
  return decide(calibratedProbabilities(Array.from(logits.slice(0, s.labels.length)), s.temperature), s);
}

// ---------------------------------------------------------------------------
// Full five-slot analysis (occupancy_classifier.analyze_image)
// ---------------------------------------------------------------------------

export interface SlotResult {
  slot_id: SlotId;
  roi: { normalized: NormalizedROI; pixels: PixelROI };
  status: SlotStatus;
  confidence: number | null;
  reason: string | null;
  source: 'ai';
  error: string | null;
  p_occupied: number | null;
}

export interface AnalysisReport {
  schema_version: '1.0';
  analysis_id: string;
  timestamp: string;
  is_demo_data: false;
  provider: { source: 'ai'; name: 'local-cnn'; model: string; runtime: string };
  image: { filename: string | null; width: number; height: number };
  layout: { name: string; placeholder: boolean; compatible: boolean };
  warnings: string[];
  slots: SlotResult[];
  summary: { empty: number; occupied: number; uncertain: number; total: number; empty_slot_ids: SlotId[] };
}

function randomId(): string {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${hex()}-${hex()}${hex()}${hex()}`;
}

export async function analyzeImage(
  image: ImageBGR,
  config: ROIConfig,
  settings: ClassifierSettings,
  runner: ModelRunner,
  opts: { filename?: string | null; runtime?: string; now?: Date } = {},
): Promise<AnalysisReport> {
  validateImage(image);
  const crops = cropSlots(image, config);
  const compat = checkCompatibility(image, config, crops);
  const slots: SlotResult[] = [];
  for (const c of crops) {
    let result: SlotResult;
    try {
      const d = await classifyCrop(c.image, settings, runner);
      result = {
        slot_id: c.slotId,
        roi: { normalized: c.roiNormalized, pixels: c.roiPixels },
        status: d.status,
        confidence: d.confidence,
        reason: d.reason,
        source: 'ai',
        error: null,
        p_occupied: d.pOccupied,
      };
    } catch (e) {
      // A failing slot becomes UNCERTAIN, never EMPTY.
      result = {
        slot_id: c.slotId,
        roi: { normalized: c.roiNormalized, pixels: c.roiPixels },
        status: 'UNCERTAIN',
        confidence: null,
        reason: 'Provider failure.',
        source: 'ai',
        error: (e as Error).message,
        p_occupied: null,
      };
    }
    slots.push(result);
  }
  validateSlotResults(slots);
  const warnings = [...compat.warnings];
  const failed = slots.filter((s) => s.error).map((s) => s.slot_id);
  if (failed.length) warnings.push(`Provider failed for ${failed.join(', ')}; those slots are UNCERTAIN.`);
  const count = (st: SlotStatus) => slots.filter((s) => s.status === st).length;
  return {
    schema_version: '1.0',
    analysis_id: randomId(),
    timestamp: (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
    is_demo_data: false,
    provider: { source: 'ai', name: 'local-cnn', model: settings.modelName, runtime: opts.runtime ?? 'onnxruntime' },
    image: { filename: opts.filename ?? null, width: image.width, height: image.height },
    layout: { name: config.layoutName, placeholder: config.placeholder, compatible: compat.compatible },
    warnings,
    slots,
    summary: {
      empty: count('EMPTY'),
      occupied: count('OCCUPIED'),
      uncertain: count('UNCERTAIN'),
      total: slots.length,
      empty_slot_ids: slots.filter((s) => s.status === 'EMPTY').map((s) => s.slot_id),
    },
  };
}

export function validateSlotResults(slots: { slot_id: string; status: string }[]): void {
  const ids = slots.map((s) => s.slot_id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) throw new ClassifierError(`Duplicate slot ids in results: ${dup.join(', ')}.`);
  const missing = SLOT_IDS.filter((s) => !ids.includes(s));
  if (missing.length) throw new ClassifierError(`Missing slot ids in results: ${missing.join(', ')}.`);
  const unknown = ids.filter((id) => !(SLOT_IDS as readonly string[]).includes(id));
  if (unknown.length) throw new ClassifierError(`Unknown slot ids in results: ${unknown.join(', ')}.`);
  for (const s of slots) {
    if (!['EMPTY', 'OCCUPIED', 'UNCERTAIN'].includes(s.status)) {
      throw new ClassifierError(`${s.slot_id} has invalid status ${s.status}.`);
    }
  }
}
