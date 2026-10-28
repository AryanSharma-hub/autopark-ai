/**
 * Port of cv2.resize(src, (dw, dh), interpolation=cv2.INTER_AREA) for 8-bit,
 * 3-channel images, written to reproduce OpenCV's integer/float32 arithmetic.
 *
 * The Python classifier (autopark_vision/src/local_classifier.py) resizes every
 * slot crop to 96x96 with INTER_AREA before inference. OpenCV implements
 * INTER_AREA with three different code paths and the mobile port must take the
 * same one for each crop size:
 *
 *  1. Both axes shrink by the same integer factor  -> block averaging ("area fast").
 *  2. Both axes shrink (scale >= 1)                 -> fractional pixel-area weights (float32).
 *  3. Any axis enlarges (scale < 1)                 -> OpenCV *emulates* area with
 *     bilinear-style fixed-point interpolation (11-bit coefficients).
 *
 * Path 3 matters in practice: slot crops are often narrower than 96 px.
 * The parity test (__tests__/resize.parity.test.ts) checks this module against
 * cv2 output for many crop sizes.
 */

import { ImageBGR, createImage, saturateU8 } from './image';

const f32 = Math.fround;
const DBL_EPSILON = 2.220446049250313e-16;
const COEF_BITS = 11;
const COEF_SCALE = 1 << COEF_BITS; // 2048

export function resizeArea(src: ImageBGR, dw: number, dh: number): ImageBGR {
  if (src.width <= 0 || src.height <= 0) throw new Error('Cannot resize an empty image.');
  if (dw <= 0 || dh <= 0) throw new Error('Target size must be positive.');
  if (src.width === dw && src.height === dh) {
    return { width: dw, height: dh, data: src.data.slice() };
  }
  const invScaleX = dw / src.width;
  const invScaleY = dh / src.height;
  const scaleX = 1 / invScaleX;
  const scaleY = 1 / invScaleY;

  if (scaleX >= 1 && scaleY >= 1) {
    const iscaleX = roundHalfEvenInt(scaleX);
    const iscaleY = roundHalfEvenInt(scaleY);
    const isAreaFast = Math.abs(scaleX - iscaleX) < DBL_EPSILON && Math.abs(scaleY - iscaleY) < DBL_EPSILON;
    if (isAreaFast) return resizeAreaFast(src, dw, dh, iscaleX, iscaleY);
    return resizeAreaFractional(src, dw, dh, scaleX, scaleY);
  }
  return resizeLinearAreaMode(src, dw, dh, scaleX, scaleY, invScaleX, invScaleY);
}

function roundHalfEvenInt(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

// ---------------------------------------------------------------------------
// Path 1: integer decimation (resizeAreaFast_)
// ---------------------------------------------------------------------------
function resizeAreaFast(src: ImageBGR, dw: number, dh: number, sx: number, sy: number): ImageBGR {
  const cn = 3;
  const out = createImage(dw, dh);
  const area = sx * sy;
  const scale = f32(1 / area);
  const w = dw * cn;
  const srcStep = src.width * cn;
  for (let dy = 0; dy < dh; dy++) {
    const rowBase = dy * sy * srcStep;
    let dxStart = 0;
    if (sx === 2 && sy === 2) {
      // ResizeAreaFastVec_SIMD_8u, cn == 3: (a + b + c + d + 2) >> 2 in groups of 6 elements.
      const S = rowBase;
      const N = rowBase + srcStep;
      let dx = 0;
      for (; dx <= w - 6; dx += 6) {
        for (let k = 0; k < 6; k++) {
          const pix = Math.floor((dx + k) / cn);
          const c = (dx + k) % cn;
          const s0 = pix * 2 * cn + c;
          const v = src.data[S + s0] + src.data[S + s0 + cn] + src.data[N + s0] + src.data[N + s0 + cn];
          out.data[dy * w + dx + k] = (v + 2) >> 2;
        }
      }
      dxStart = dx;
    }
    for (let dx = dxStart; dx < w; dx++) {
      const pix = Math.floor(dx / cn);
      const c = dx % cn;
      let sum = 0;
      for (let yy = 0; yy < sy; yy++) {
        const r = rowBase + yy * srcStep;
        for (let xx = 0; xx < sx; xx++) sum += src.data[r + (pix * sx + xx) * cn + c];
      }
      out.data[dy * w + dx] = saturateU8(f32(sum * scale));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path 2: fractional area (computeResizeAreaTab + ResizeArea_Invoker), float32
// ---------------------------------------------------------------------------
interface DecimateAlpha {
  si: number;
  di: number;
  alpha: number;
}

function computeResizeAreaTab(ssize: number, dsize: number, cn: number, scale: number): DecimateAlpha[] {
  const tab: DecimateAlpha[] = [];
  for (let dx = 0; dx < dsize; dx++) {
    const fsx1 = dx * scale;
    const fsx2 = fsx1 + scale;
    const cellWidth = Math.min(scale, ssize - fsx1);
    let sx1 = Math.ceil(fsx1);
    let sx2 = Math.floor(fsx2);
    sx2 = Math.min(sx2, ssize - 1);
    sx1 = Math.min(sx1, sx2);
    if (sx1 - fsx1 > 1e-3) tab.push({ di: dx * cn, si: (sx1 - 1) * cn, alpha: f32((sx1 - fsx1) / cellWidth) });
    for (let sx = sx1; sx < sx2; sx++) tab.push({ di: dx * cn, si: sx * cn, alpha: f32(1.0 / cellWidth) });
    if (fsx2 - sx2 > 1e-3) {
      tab.push({ di: dx * cn, si: sx2 * cn, alpha: f32(Math.min(Math.min(fsx2 - sx2, 1), cellWidth) / cellWidth) });
    }
  }
  return tab;
}

function resizeAreaFractional(src: ImageBGR, dw: number, dh: number, scaleX: number, scaleY: number): ImageBGR {
  const cn = 3;
  const out = createImage(dw, dh);
  const xtab = computeResizeAreaTab(src.width, dw, cn, scaleX);
  const ytab = computeResizeAreaTab(src.height, dh, 1, scaleY);
  const width = dw * cn;
  const buf = new Float32Array(width);
  const sum = new Float32Array(width);
  const srcStep = src.width * cn;
  let prevDy = ytab[0].di;
  for (let j = 0; j < ytab.length; j++) {
    const beta = ytab[j].alpha;
    const dy = ytab[j].di;
    const rowBase = ytab[j].si * srcStep;
    buf.fill(0);
    for (let k = 0; k < xtab.length; k++) {
      const sxn = rowBase + xtab[k].si;
      const dxn = xtab[k].di;
      const a = xtab[k].alpha;
      buf[dxn] = f32(buf[dxn] + f32(src.data[sxn] * a));
      buf[dxn + 1] = f32(buf[dxn + 1] + f32(src.data[sxn + 1] * a));
      buf[dxn + 2] = f32(buf[dxn + 2] + f32(src.data[sxn + 2] * a));
    }
    if (dy !== prevDy) {
      const base = prevDy * width;
      for (let dx = 0; dx < width; dx++) {
        out.data[base + dx] = saturateU8(sum[dx]);
        sum[dx] = f32(beta * buf[dx]);
      }
      prevDy = dy;
    } else {
      for (let dx = 0; dx < width; dx++) sum[dx] = f32(sum[dx] + f32(beta * buf[dx]));
    }
  }
  const base = prevDy * width;
  for (let dx = 0; dx < width; dx++) out.data[base + dx] = saturateU8(sum[dx]);
  return out;
}

// ---------------------------------------------------------------------------
// Path 3: INTER_AREA emulated with fixed-point linear interpolation (resizeGeneric_)
// ---------------------------------------------------------------------------
interface AxisTable {
  ofs: Int32Array; // source index per destination index
  a0: Int16Array;
  a1: Int16Array;
  /** First destination index from which only the left/top sample is used (xmax in OpenCV). */
  limit: number;
}

function areaModeAxis(ssize: number, dsize: number, scale: number, invScale: number): AxisTable {
  const ofs = new Int32Array(dsize);
  const a0 = new Int16Array(dsize);
  const a1 = new Int16Array(dsize);
  let limit = dsize;
  for (let d = 0; d < dsize; d++) {
    let s = Math.floor(d * scale);
    let f = f32(d + 1 - (s + 1) * invScale);
    f = f <= 0 ? 0 : f32(f - Math.floor(f));
    if (s + 1 >= ssize) {
      limit = Math.min(limit, d);
      if (s >= ssize - 1) {
        f = 0;
        s = ssize - 1;
      }
    }
    ofs[d] = s;
    a0[d] = roundHalfEvenInt(f32(f32(1 - f) * COEF_SCALE));
    a1[d] = roundHalfEvenInt(f32(f * COEF_SCALE));
  }
  return { ofs, a0, a1, limit };
}

function resizeLinearAreaMode(
  src: ImageBGR,
  dw: number,
  dh: number,
  scaleX: number,
  scaleY: number,
  invScaleX: number,
  invScaleY: number,
): ImageBGR {
  const cn = 3;
  const out = createImage(dw, dh);
  const xt = areaModeAxis(src.width, dw, scaleX, invScaleX);
  const yt = areaModeAxis(src.height, dh, scaleY, invScaleY);
  const width = dw * cn;
  const srcStep = src.width * cn;

  const hresize = (row: number): Int32Array => {
    const D = new Int32Array(width);
    const base = row * srcStep;
    for (let dx = 0; dx < dw; dx++) {
      const sx = xt.ofs[dx] * cn;
      for (let c = 0; c < cn; c++) {
        const v0 = src.data[base + sx + c];
        if (dx < xt.limit) {
          D[dx * cn + c] = v0 * xt.a0[dx] + src.data[base + sx + cn + c] * xt.a1[dx];
        } else {
          D[dx * cn + c] = v0 * COEF_SCALE;
        }
      }
    }
    return D;
  };

  const cache = new Map<number, Int32Array>();
  const rowBuf = (r: number) => {
    let v = cache.get(r);
    if (!v) {
      v = hresize(r);
      cache.set(r, v);
    }
    return v;
  };
  const clip = (v: number) => (v >= 0 ? (v < src.height ? v : src.height - 1) : 0);

  for (let dy = 0; dy < dh; dy++) {
    const sy0 = yt.ofs[dy];
    const S0 = rowBuf(clip(sy0));
    const S1 = rowBuf(clip(sy0 + 1));
    const b0 = yt.a0[dy];
    const b1 = yt.a1[dy];
    const base = dy * width;
    for (let x = 0; x < width; x++) {
      out.data[base + x] = vresizeSimd(S0[x], S1[x], b0, b1);
    }
  }
  return out;
}

/**
 * VResizeLinearVec_32s8u (OpenCV universal intrinsics, used for every pixel when
 * the row length is a multiple of the SIMD width - true for 96 px x 3 channels):
 *   rshr_pack_u<2>( mulhi(S0 >> 4, b0) + mulhi(S1 >> 4, b1) )
 */
function vresizeSimd(s0: number, s1: number, b0: number, b1: number): number {
  const m0 = ((s0 >> 4) * b0) >> 16;
  const m1 = ((s1 >> 4) * b1) >> 16;
  // int16 wrap-around of the sum cannot happen for 8-bit inputs (max 1020).
  const v = (m0 + m1 + 2) >> 2;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Scalar reference (FixedPtCast<int, uchar, 22>) kept for diagnostics. */
export function vresizeScalar(s0: number, s1: number, b0: number, b1: number): number {
  const v = (s0 * b0 + s1 * b1 + (1 << 21)) >> 22;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
