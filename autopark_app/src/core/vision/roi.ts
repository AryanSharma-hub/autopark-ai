/**
 * Five-slot ROI configuration: port of autopark_vision/src/roi_manager.py and
 * the crop/compatibility logic of slot_detector.py.
 */

import { ImageBGR, bgrToGray, cropImage, roundHalfEven, stdDev } from './image';

export const SLOT_IDS = ['S1', 'S2', 'S3', 'S4', 'S5'] as const;
export type SlotId = (typeof SLOT_IDS)[number];

export const MIN_NORMALIZED_SIZE = 0.02;
export const MAX_OVERLAP_IOU = 0.25;
export const MIN_CROP_PIXELS = 24;
export const LOW_TEXTURE_STD = 4.0;

export interface NormalizedROI {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PixelROI {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface SlotDefinition {
  slotId: SlotId;
  roi: NormalizedROI;
}
export interface ROIConfig {
  layoutName: string;
  slots: SlotDefinition[]; // always S1..S5 in order
  referenceWidth: number;
  referenceHeight: number;
  aspectRatioTolerance: number;
  placeholder: boolean;
  version: number;
}

/** JSON shape of config/roi_*.json in autopark_vision. */
export interface ROIConfigJson {
  version?: number;
  layout_name?: string;
  placeholder?: boolean;
  reference_resolution?: { width?: number; height?: number };
  aspect_ratio_tolerance?: number;
  slots: { id: string; x: number; y: number; w: number; h: number }[];
}

export class ROIConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ROIConfigError';
  }
}

function num(value: unknown, name: string): number {
  if (typeof value !== 'number') throw new ROIConfigError(`${name} must be a number, got ${JSON.stringify(value)}.`);
  if (!Number.isFinite(value)) throw new ROIConfigError(`${name} must be finite, got ${value}.`);
  return value;
}

export function iou(a: NormalizedROI, b: NormalizedROI): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export function validateROI(roi: NormalizedROI, slotId: string): void {
  for (const k of ['x', 'y'] as const) {
    const v = roi[k];
    if (!(v >= 0 && v < 1)) throw new ROIConfigError(`${slotId}.${k}=${v} must be in [0, 1).`);
  }
  for (const k of ['w', 'h'] as const) {
    const v = roi[k];
    if (!(v >= MIN_NORMALIZED_SIZE && v <= 1)) {
      throw new ROIConfigError(`${slotId}.${k}=${v} must be in [${MIN_NORMALIZED_SIZE}, 1].`);
    }
  }
  if (roi.x + roi.w > 1 + 1e-9) throw new ROIConfigError(`${slotId} extends past the right edge (x + w > 1).`);
  if (roi.y + roi.h > 1 + 1e-9) throw new ROIConfigError(`${slotId} extends past the bottom edge (y + h > 1).`);
}

export function parseROIConfig(data: ROIConfigJson): ROIConfig {
  if (!data || typeof data !== 'object') throw new ROIConfigError('ROI config must be a JSON object.');
  if (!Array.isArray(data.slots)) throw new ROIConfigError("'slots' must be a list.");
  const seen = new Set<string>();
  const slots: SlotDefinition[] = [];
  data.slots.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new ROIConfigError(`slots[${i}] must be an object.`);
    const id = raw.id;
    if (typeof id !== 'string') throw new ROIConfigError(`slots[${i}].id must be a string.`);
    if (!(SLOT_IDS as readonly string[]).includes(id)) {
      throw new ROIConfigError(`Unknown slot id '${id}'. Allowed: ${SLOT_IDS.join(', ')}.`);
    }
    if (seen.has(id)) throw new ROIConfigError(`Duplicate slot id '${id}'.`);
    seen.add(id);
    const missing = (['x', 'y', 'w', 'h'] as const).filter((k) => !(k in raw));
    if (missing.length) throw new ROIConfigError(`${id} missing keys: ${missing.join(', ')}.`);
    const roi = {
      x: num(raw.x, `${id}.x`),
      y: num(raw.y, `${id}.y`),
      w: num(raw.w, `${id}.w`),
      h: num(raw.h, `${id}.h`),
    };
    validateROI(roi, id);
    slots.push({ slotId: id as SlotId, roi });
  });
  const missing = SLOT_IDS.filter((s) => !seen.has(s));
  if (missing.length) throw new ROIConfigError(`Missing slot ids: ${missing.join(', ')}. Exactly S1-S5 are required.`);
  slots.sort((a, b) => SLOT_IDS.indexOf(a.slotId) - SLOT_IDS.indexOf(b.slotId));
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const v = iou(slots[i].roi, slots[j].roi);
      if (v > MAX_OVERLAP_IOU) {
        throw new ROIConfigError(
          `${slots[i].slotId} and ${slots[j].slotId} overlap too much (IoU ${v.toFixed(2)} > ${MAX_OVERLAP_IOU}).`,
        );
      }
    }
  }
  const ref = data.reference_resolution ?? {};
  const refW = num(ref.width ?? 1280, 'reference_resolution.width');
  const refH = num(ref.height ?? 720, 'reference_resolution.height');
  if (refW <= 0 || refH <= 0) throw new ROIConfigError('reference_resolution width/height must be positive.');
  const tol = num(data.aspect_ratio_tolerance ?? 0.15, 'aspect_ratio_tolerance');
  if (!(tol > 0 && tol <= 1)) throw new ROIConfigError('aspect_ratio_tolerance must be in (0, 1].');
  const placeholder = data.placeholder ?? true;
  if (typeof placeholder !== 'boolean') throw new ROIConfigError("'placeholder' must be true or false.");
  const layoutName = data.layout_name ?? 'unnamed_layout';
  if (typeof layoutName !== 'string' || !layoutName.trim()) {
    throw new ROIConfigError("'layout_name' must be a non-empty string.");
  }
  return {
    layoutName,
    slots,
    referenceWidth: Math.trunc(refW),
    referenceHeight: Math.trunc(refH),
    aspectRatioTolerance: tol,
    placeholder,
    version: Math.trunc(num(data.version ?? 1, 'version')),
  };
}

export function roiConfigToJson(c: ROIConfig): ROIConfigJson {
  return {
    version: c.version,
    layout_name: c.layoutName,
    placeholder: c.placeholder,
    reference_resolution: { width: c.referenceWidth, height: c.referenceHeight },
    aspect_ratio_tolerance: c.aspectRatioTolerance,
    slots: c.slots.map((s) => ({ id: s.slotId, ...s.roi })),
  };
}

/** Same as roi_manager.to_pixels: Python round() is round-half-to-even. */
export function toPixels(roi: NormalizedROI, imageWidth: number, imageHeight: number): PixelROI {
  let x0 = roundHalfEven(roi.x * imageWidth);
  let y0 = roundHalfEven(roi.y * imageHeight);
  let x1 = roundHalfEven((roi.x + roi.w) * imageWidth);
  let y1 = roundHalfEven((roi.y + roi.h) * imageHeight);
  x0 = Math.max(0, x0);
  x1 = Math.min(imageWidth, x1);
  y0 = Math.max(0, y0);
  y1 = Math.min(imageHeight, y1);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

export interface SlotCrop {
  slotId: SlotId;
  roiNormalized: NormalizedROI;
  roiPixels: PixelROI;
  image: ImageBGR;
}

export function cropSlots(image: ImageBGR, config: ROIConfig): SlotCrop[] {
  return config.slots.map((s) => {
    const px = toPixels(s.roi, image.width, image.height);
    return { slotId: s.slotId, roiNormalized: s.roi, roiPixels: px, image: cropImage(image, px.x, px.y, px.w, px.h) };
  });
}

export interface CompatibilityResult {
  compatible: boolean;
  warnings: string[];
}

export function checkCompatibility(image: ImageBGR, config: ROIConfig, crops: SlotCrop[]): CompatibilityResult {
  const warnings: string[] = [];
  let compatible = true;
  const ratio = image.width / image.height;
  const expected = config.referenceWidth / config.referenceHeight;
  const deviation = Math.abs(ratio - expected) / expected;
  if (deviation > config.aspectRatioTolerance) {
    compatible = false;
    warnings.push(
      `Image aspect ratio ${ratio.toFixed(2)} differs from the ROI layout's ${expected.toFixed(2)} ` +
        `(${config.referenceWidth}x${config.referenceHeight}) by ${Math.round(deviation * 100)}%. ` +
        'The camera viewpoint probably does not match the configured slots; results may be misleading. ' +
        'Re-align the ROIs for this image.',
    );
  }
  for (const crop of crops) {
    const px = crop.roiPixels;
    if (px.w < MIN_CROP_PIXELS || px.h < MIN_CROP_PIXELS) {
      compatible = false;
      warnings.push(`${crop.slotId} crop is only ${px.w}x${px.h}px; image resolution is too low for this layout.`);
      continue;
    }
    if (stdDev(bgrToGray(crop.image)) < LOW_TEXTURE_STD) {
      compatible = false;
      warnings.push(
        `${crop.slotId} crop is almost uniform (no visible detail). The ROI may be off the parking surface, ` +
          'or the image is over/under-exposed.',
      );
    }
  }
  if (config.placeholder) {
    warnings.push(
      'ROI coordinates are placeholders and have not been aligned to a real image of the lot. ' +
        'Adjust and save the regions before trusting results.',
    );
  }
  return { compatible, warnings };
}
