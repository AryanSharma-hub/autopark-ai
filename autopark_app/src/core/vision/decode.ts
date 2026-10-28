/**
 * Decode uploaded/captured image bytes into a BGR image, mirroring
 * autopark_vision/src/image_loader.py (cv2.imdecode with IMREAD_COLOR):
 *  - JPEG and PNG supported (the formats phone cameras and galleries produce),
 *  - EXIF orientation is applied for JPEG (OpenCV does this by default),
 *  - alpha is dropped, grey is replicated to 3 channels,
 *  - the same size limits as the Python loader are enforced.
 *
 * Pure TypeScript (jpeg-js / upng-js) so the identical code runs in the app
 * and in the Node parity tests.
 */

import * as jpeg from 'jpeg-js';
import UPNG from 'upng-js';
import { ImageBGR, createImage, rgbaToBGR } from './image';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MIN_DIMENSION = 100;
export const MAX_DIMENSION = 10_000;
export const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp', '.webp'];

export class ImageLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageLoadError';
  }
}

export type ImageFormat = 'jpeg' | 'png' | 'unknown';

export function sniffFormat(bytes: Uint8Array): ImageFormat {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  return 'unknown';
}

export function decodeImageBytes(bytes: Uint8Array, filename?: string): ImageBGR {
  if (!bytes || bytes.length === 0) throw new ImageLoadError('Image is empty.');
  if (bytes.length > MAX_FILE_BYTES) {
    throw new ImageLoadError(
      `Image is ${(bytes.length / 1e6).toFixed(1)} MB; limit is ${(MAX_FILE_BYTES / 1e6).toFixed(0)} MB.`,
    );
  }
  if (filename) {
    const dot = filename.lastIndexOf('.');
    const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
    if (ext && !ALLOWED_EXTENSIONS.includes(ext)) {
      throw new ImageLoadError(`Unsupported file type '${ext}'. Use JPEG or PNG.`);
    }
  }
  const format = sniffFormat(bytes);
  let image: ImageBGR;
  if (format === 'jpeg') {
    let decoded: { width: number; height: number; data: Uint8Array };
    try {
      decoded = jpeg.decode(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        maxResolutionInMP: 120,
        maxMemoryUsageInMB: 1024,
      }) as unknown as { width: number; height: number; data: Uint8Array };
    } catch (e) {
      throw new ImageLoadError(`File could not be decoded as a JPEG image: ${(e as Error).message}`);
    }
    image = rgbaToBGR(decoded.data, decoded.width, decoded.height);
    const orientation = readJpegOrientation(bytes);
    if (orientation > 1) image = applyOrientation(image, orientation);
  } else if (format === 'png') {
    let rgba: Uint8Array;
    let width: number;
    let height: number;
    try {
      const png = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      width = png.width;
      height = png.height;
      rgba = new Uint8Array(UPNG.toRGBA8(png)[0]);
    } catch (e) {
      throw new ImageLoadError(`File could not be decoded as a PNG image: ${(e as Error).message}`);
    }
    image = rgbaToBGR(rgba, width, height);
  } else {
    throw new ImageLoadError('File could not be decoded as an image (only JPEG and PNG are supported on the phone).');
  }
  validateImage(image);
  return image;
}

export function validateImage(image: ImageBGR): void {
  const { width, height } = image;
  if (Math.min(width, height) < MIN_DIMENSION) {
    throw new ImageLoadError(`Image is ${width}x${height}; minimum side is ${MIN_DIMENSION}px.`);
  }
  if (Math.max(width, height) > MAX_DIMENSION) {
    throw new ImageLoadError(`Image is ${width}x${height}; maximum side is ${MAX_DIMENSION}px.`);
  }
}

/** Read the EXIF Orientation tag (1-8) from a JPEG APP1 segment; 1 if absent. */
export function readJpegOrientation(bytes: Uint8Array): number {
  let p = 2;
  while (p + 4 < bytes.length) {
    if (bytes[p] !== 0xff) return 1;
    const marker = bytes[p + 1];
    if (marker === 0xda || marker === 0xd9) return 1; // start of scan / end: no more metadata
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    if (marker === 0xe1 && len >= 8) {
      const s = p + 4;
      if (bytes[s] === 0x45 && bytes[s + 1] === 0x78 && bytes[s + 2] === 0x69 && bytes[s + 3] === 0x66 && bytes[s + 4] === 0 && bytes[s + 5] === 0) {
        const t = s + 6; // TIFF header
        const little = bytes[t] === 0x49 && bytes[t + 1] === 0x49;
        const u16 = (o: number) => (little ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
        const u32 = (o: number) =>
          little
            ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
            : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
        const ifd = t + u32(t + 4);
        if (ifd + 2 > bytes.length) return 1;
        const count = u16(ifd);
        for (let i = 0; i < count; i++) {
          const e = ifd + 2 + i * 12;
          if (e + 12 > bytes.length) return 1;
          if (u16(e) === 0x0112) {
            const v = u16(e + 8);
            return v >= 1 && v <= 8 ? v : 1;
          }
        }
      }
      return 1;
    }
    p += 2 + len;
  }
  return 1;
}

/** Rotate/flip so the image is displayed upright (EXIF orientation 2-8). */
export function applyOrientation(img: ImageBGR, orientation: number): ImageBGR {
  const { width: w, height: h } = img;
  const swap = orientation >= 5;
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const out = createImage(ow, oh);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let sx: number;
      let sy: number;
      switch (orientation) {
        case 2: sx = w - 1 - x; sy = y; break;
        case 3: sx = w - 1 - x; sy = h - 1 - y; break;
        case 4: sx = x; sy = h - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = h - 1 - x; break;
        case 7: sx = w - 1 - y; sy = h - 1 - x; break;
        case 8: sx = w - 1 - y; sy = x; break;
        default: sx = x; sy = y;
      }
      const si = (sy * w + sx) * 3;
      const di = (y * ow + x) * 3;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
    }
  }
  return out;
}
