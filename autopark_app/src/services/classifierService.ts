/**
 * On-device classification of the five slots.
 *
 * Model: assets/model/slot_classifier.onnx (your trained MobileNetV3-Small, unchanged)
 * plus slot_classifier.json (preprocessing, temperature, threshold) - the same two
 * files the Python LocalModelProvider reads.
 *
 * Runtime: onnxLite, a TypeScript ONNX interpreter that executes that file's graph
 * (verified against onnxruntime in __tests__/onnxLite.test.ts). It needs no native
 * module, so it cannot crash the app natively and works in every build.
 *
 * Memory: phone photos (12+ MP) are first shrunk natively by expo-image-manipulator
 * to at most MAX_SIDE px and saved as lossless PNG (this also converts HEIC and
 * applies the EXIF rotation). Decoding a full-resolution photo in JavaScript needs
 * hundreds of MB and was what crashed the app after an upload.
 */

import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import modelMeta from '../../assets/model/slot_classifier.json';
import {
  AnalysisReport,
  ClassifierSettings,
  ModelMetadata,
  ModelRunner,
  analyzeImage,
  settingsFromMetadata,
} from '../core/vision/classifier';
import { decodeImageBytes } from '../core/vision/decode';
import { LiteModel, parseOnnxModel, runOnnxModel } from '../core/vision/onnxLite';
import { ROIConfig } from '../core/vision/roi';

/** Longest image side used for analysis. Slot crops are squash-resized to 96x96 anyway. */
export const MAX_SIDE = 1280;
export const RUNTIME_NAME = 'onnxLite (TypeScript, on-device)';

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

let classifierPromise: Promise<{ runner: ModelRunner; settings: ClassifierSettings }> | null = null;

async function loadModel(): Promise<LiteModel> {
  const asset = Asset.fromModule(require('../../assets/model/slot_classifier.onnx'));
  await asset.downloadAsync();
  const uri = asset.localUri ?? asset.uri;
  if (!uri) throw new Error('The model file could not be found in the app bundle.');
  const bytes = await new File(uri).bytes();
  return parseOnnxModel(bytes);
}

export function getClassifier(): Promise<{ runner: ModelRunner; settings: ClassifierSettings }> {
  if (!classifierPromise) {
    classifierPromise = (async () => {
      const model = await loadModel();
      const inputName = model.inputs[0];
      const outputName = model.outputs[0];
      let layers = 0;
      const runner: ModelRunner = {
        async run(input, dims) {
          const out = await runOnnxModel(model, { [inputName]: { dims: [...dims], data: input } }, async () => {
            // keep the UI thread responsive during inference
            if (++layers % 12 === 0) await yieldToUi();
          });
          return out[outputName].data;
        },
      };
      return { runner, settings: settingsFromMetadata(modelMeta as ModelMetadata) };
    })().catch((e) => {
      classifierPromise = null; // allow a retry
      throw e;
    });
  }
  return classifierPromise;
}

export interface AnalyzeProgress {
  (step: 'reading' | 'decoding' | 'loading-model' | 'classifying'): void;
}

/** Shrink (if needed) and re-encode as PNG natively; returns a file URI. */
async function normalizePhoto(uri: string): Promise<{ uri: string; width: number; height: number }> {
  const ctx = ImageManipulator.manipulate(uri);
  let ref = await ctx.renderAsync();
  const { width, height } = ref;
  if (Math.max(width, height) > MAX_SIDE) {
    ctx.resize(width >= height ? { width: MAX_SIDE } : { height: MAX_SIDE });
    ref = await ctx.renderAsync();
  }
  const saved = await ref.saveAsync({ format: SaveFormat.PNG });
  return { uri: saved.uri, width: saved.width, height: saved.height };
}

/** Full pipeline for a picked/captured image URI. */
export async function analyzeImageUri(
  uri: string,
  roi: ROIConfig,
  filename: string | null,
  onProgress?: AnalyzeProgress,
): Promise<{ report: AnalysisReport; width: number; height: number; displayUri: string }> {
  onProgress?.('reading');
  await yieldToUi();
  let normalized: { uri: string };
  try {
    normalized = await normalizePhoto(uri);
  } catch (e) {
    throw new Error(`Could not open the photo: ${(e as Error).message}`);
  }
  const bytes = await new File(normalized.uri).bytes();
  onProgress?.('decoding');
  await yieldToUi();
  const image = decodeImageBytes(bytes, 'photo.png');
  onProgress?.('loading-model');
  await yieldToUi();
  const { runner, settings } = await getClassifier();
  onProgress?.('classifying');
  await yieldToUi();
  const report = await analyzeImage(image, roi, settings, runner, { filename, runtime: RUNTIME_NAME });
  return { report, width: image.width, height: image.height, displayUri: normalized.uri };
}
