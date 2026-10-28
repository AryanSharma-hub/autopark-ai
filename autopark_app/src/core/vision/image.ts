/**
 * Minimal image container and pixel operations used by the on-device classifier.
 *
 * Images are kept in OpenCV's BGR interleaved byte order so that every step
 * mirrors the Python pipeline in autopark_vision/src (which works on cv2 BGR
 * arrays) one-to-one.
 */

export interface ImageBGR {
  width: number;
  height: number;
  /** Interleaved B,G,R bytes, row-major, length = width * height * 3. */
  data: Uint8Array;
}

export function createImage(width: number, height: number): ImageBGR {
  return { width, height, data: new Uint8Array(width * height * 3) };
}

/** RGBA (as produced by jpeg-js / upng-js) -> BGR. Alpha is dropped like cv2.IMREAD_COLOR does for opaque images. */
export function rgbaToBGR(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): ImageBGR {
  const out = createImage(width, height);
  const n = width * height;
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) {
    out.data[k] = rgba[j + 2];
    out.data[k + 1] = rgba[j + 1];
    out.data[k + 2] = rgba[j];
  }
  return out;
}

/** Copy a rectangular region (already clamped to the image). Equivalent to image[y:y+h, x:x+w].copy(). */
export function cropImage(img: ImageBGR, x: number, y: number, w: number, h: number): ImageBGR {
  const out = createImage(w, h);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * img.width + x) * 3;
    out.data.set(img.data.subarray(srcStart, srcStart + w * 3), row * w * 3);
  }
  return out;
}

/**
 * cvRound for values produced in float32 arithmetic: round half to even
 * (x86 cvtss2si / lrint semantics), then saturate to uint8.
 */
export function saturateU8(v: number): number {
  const r = roundHalfEven(v);
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

export function roundHalfEven(v: number): number {
  const f = Math.floor(v);
  const diff = v - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) for 8-bit images. OpenCV uses fixed-point
 * coefficients with 14-bit precision: Y = (B*1868 + G*9617 + R*4899 + 8192) >> 14.
 */
export function bgrToGray(img: ImageBGR): Uint8Array {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  const d = img.data;
  for (let i = 0, k = 0; i < n; i++, k += 3) {
    out[i] = (d[k] * 1868 + d[k + 1] * 9617 + d[k + 2] * 4899 + 8192) >> 14;
  }
  return out;
}

/** numpy ndarray.std() (population standard deviation) of a uint8 array. */
export function stdDev(values: Uint8Array): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  const mean = sum / values.length;
  let sq = 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - mean;
    sq += d * d;
  }
  return Math.sqrt(sq / values.length);
}
