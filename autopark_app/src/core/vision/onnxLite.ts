/**
 * onnxLite: a small, dependency-free ONNX interpreter in TypeScript.
 *
 * It reads the real model file (assets/model/slot_classifier.onnx, the same
 * bytes onnxruntime loads) and executes its graph on the CPU. It implements
 * exactly the operators MobileNetV3-Small uses:
 *   Conv (groups / strides / pads / dilations), Relu, HardSwish, HardSigmoid,
 *   GlobalAveragePool, Mul, Add (numpy broadcasting), Flatten, Gemm.
 * Anything else throws, so a different model can never be silently mis-run.
 *
 * Why: it runs in plain JavaScript (Hermes) with no native module, so it cannot
 * crash the app natively, works in every build, and is verified against
 * onnxruntime in __tests__/onnxLite.test.ts.
 */

export interface LiteTensor {
  dims: number[];
  data: Float32Array;
}

type AttrValue = number | number[] | string | LiteTensor;

interface LiteNode {
  op: string;
  inputs: string[];
  outputs: string[];
  attrs: Record<string, AttrValue>;
}

export interface LiteModel {
  inputs: string[];
  outputs: string[];
  nodes: LiteNode[];
  initializers: Map<string, LiteTensor>;
}

export class OnnxLiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnnxLiteError';
  }
}

// ---------------------------------------------------------------- protobuf --

class Reader {
  pos: number;
  constructor(readonly buf: Uint8Array, start = 0, readonly end = buf.length) {
    this.pos = start;
  }
  get done() {
    return this.pos >= this.end;
  }
  /** Varint as a JS number (exact up to 2^53); 10-byte negatives become negative numbers. */
  varint(): number {
    let lo = 0;
    let hi = 0;
    let shift = 0;
    let b: number;
    // low 28 bits
    do {
      if (this.pos >= this.end) throw new OnnxLiteError('Truncated varint.');
      b = this.buf[this.pos++];
      if (shift < 28) lo |= (b & 0x7f) << shift;
      else if (shift === 28) {
        lo |= (b & 0x0f) << 28;
        hi |= (b & 0x7f) >> 4;
      } else hi |= (b & 0x7f) << (shift - 32);
      shift += 7;
    } while (b & 0x80);
    lo >>>= 0;
    hi >>>= 0;
    if (hi & 0x80000000) {
      // two's complement negative int64
      const nlo = (~lo + 1) >>> 0;
      const nhi = (~hi + (nlo === 0 ? 1 : 0)) >>> 0;
      return -(nhi * 4294967296 + nlo);
    }
    return hi * 4294967296 + lo;
  }
  bytes(): Uint8Array {
    const n = this.varint();
    if (this.pos + n > this.end) throw new OnnxLiteError('Truncated field.');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  sub(): Reader {
    const n = this.varint();
    const r = new Reader(this.buf, this.pos, this.pos + n);
    this.pos += n;
    return r;
  }
  float32(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    return v;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      const n = this.varint(); // read first: `pos += varint()` would use the stale pos
      this.pos += n;
    }
    else if (wire === 5) this.pos += 4;
    else throw new OnnxLiteError(`Unsupported protobuf wire type ${wire}.`);
  }
}

const utf8 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  try {
    return decodeURIComponent(escape(s));
  } catch {
    return s;
  }
};

function readInts(r: Reader, wire: number, into: number[]) {
  if (wire === 2) {
    const s = r.sub();
    while (!s.done) into.push(s.varint());
  } else into.push(r.varint());
}

function parseTensor(r: Reader): { name: string; tensor: LiteTensor } {
  const dims: number[] = [];
  let dataType = 0;
  let name = '';
  let raw: Uint8Array | null = null;
  const floats: number[] = [];
  while (!r.done) {
    const key = r.varint();
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1) readInts(r, wire, dims);
    else if (field === 2) dataType = r.varint();
    else if (field === 4) {
      if (wire === 2) {
        const s = r.sub();
        while (!s.done) floats.push(s.float32());
      } else floats.push(r.float32());
    } else if (field === 8) name = utf8(r.bytes());
    else if (field === 9) raw = r.bytes();
    else r.skip(wire);
  }
  if (dataType !== 1) throw new OnnxLiteError(`Initializer ${name}: only float32 tensors are supported (type ${dataType}).`);
  const size = dims.reduce((a, b) => a * b, 1);
  let data: Float32Array;
  if (raw) {
    // copy into an aligned buffer (raw_data may sit at any byte offset)
    const copy = new Uint8Array(raw.length);
    copy.set(raw);
    data = new Float32Array(copy.buffer);
    const le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    if (!le) throw new OnnxLiteError('Big-endian platforms are not supported.');
  } else data = Float32Array.from(floats);
  if (data.length !== size) throw new OnnxLiteError(`Initializer ${name}: ${data.length} values for dims [${dims}].`);
  return { name, tensor: { dims, data } };
}

function parseAttribute(r: Reader): [string, AttrValue] {
  let name = '';
  let f: number | undefined;
  let i: number | undefined;
  let s: string | undefined;
  let t: LiteTensor | undefined;
  const ints: number[] = [];
  const floats: number[] = [];
  while (!r.done) {
    const key = r.varint();
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1) name = utf8(r.bytes());
    else if (field === 2) f = r.float32();
    else if (field === 3) i = r.varint();
    else if (field === 4) s = utf8(r.bytes());
    else if (field === 5) t = parseTensor(r.sub()).tensor;
    else if (field === 7) {
      if (wire === 2) {
        const sub = r.sub();
        while (!sub.done) floats.push(sub.float32());
      } else floats.push(r.float32());
    } else if (field === 8) readInts(r, wire, ints);
    else r.skip(wire);
  }
  const value: AttrValue = ints.length ? ints : floats.length ? floats : f ?? i ?? s ?? t ?? 0;
  return [name, value];
}

function parseNode(r: Reader): LiteNode {
  const node: LiteNode = { op: '', inputs: [], outputs: [], attrs: {} };
  while (!r.done) {
    const key = r.varint();
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1) node.inputs.push(utf8(r.bytes()));
    else if (field === 2) node.outputs.push(utf8(r.bytes()));
    else if (field === 4) node.op = utf8(r.bytes());
    else if (field === 5) {
      const [k, v] = parseAttribute(r.sub());
      node.attrs[k] = v;
    } else if (field === 7) {
      const domain = utf8(r.bytes());
      if (domain && domain !== 'ai.onnx') throw new OnnxLiteError(`Unsupported operator domain "${domain}".`);
    } else r.skip(wire);
  }
  return node;
}

function valueInfoName(r: Reader): string {
  let name = '';
  while (!r.done) {
    const key = r.varint();
    if (key >>> 3 === 1) name = utf8(r.bytes());
    else r.skip(key & 7);
  }
  return name;
}

export function parseOnnxModel(bytes: Uint8Array): LiteModel {
  const r = new Reader(bytes);
  let graph: Reader | null = null;
  while (!r.done) {
    const key = r.varint();
    if (key >>> 3 === 7 && (key & 7) === 2) graph = r.sub();
    else r.skip(key & 7);
  }
  if (!graph) throw new OnnxLiteError('Not an ONNX model (no graph).');
  const model: LiteModel = { inputs: [], outputs: [], nodes: [], initializers: new Map() };
  while (!graph.done) {
    const key = graph.varint();
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1) model.nodes.push(parseNode(graph.sub()));
    else if (field === 5) {
      const { name, tensor } = parseTensor(graph.sub());
      model.initializers.set(name, tensor);
    } else if (field === 11) model.inputs.push(valueInfoName(graph.sub()));
    else if (field === 12) model.outputs.push(valueInfoName(graph.sub()));
    else graph.skip(wire);
  }
  // graph inputs may list initializers too (older exporters)
  model.inputs = model.inputs.filter((n) => !model.initializers.has(n));
  for (const n of model.nodes) if (!(n.op in OPS)) throw new OnnxLiteError(`Unsupported operator ${n.op}.`);
  return model;
}

// --------------------------------------------------------------- operators --

const size = (d: number[]) => d.reduce((a, b) => a * b, 1);
const ints = (v: AttrValue | undefined, dflt: number[]) => (Array.isArray(v) ? (v as number[]) : dflt);
const num = (v: AttrValue | undefined, dflt: number) => (typeof v === 'number' ? v : dflt);

function conv(x: LiteTensor, w: LiteTensor, b: LiteTensor | undefined, a: LiteNode['attrs']): LiteTensor {
  const [N, C, H, W] = x.dims;
  const [M, CperG, KH, KW] = w.dims;
  const group = num(a.group, 1);
  const [sh, sw] = ints(a.strides, [1, 1]);
  const [dh, dw] = ints(a.dilations, [1, 1]);
  const [pt, pl, pb, pr] = ints(a.pads, [0, 0, 0, 0]);
  if (a.auto_pad && a.auto_pad !== 'NOTSET') throw new OnnxLiteError('Conv auto_pad is not supported.');
  if (C !== CperG * group) throw new OnnxLiteError(`Conv channel mismatch: input ${C}, weight ${CperG}x${group}.`);
  const OH = Math.floor((H + pt + pb - dh * (KH - 1) - 1) / sh) + 1;
  const OW = Math.floor((W + pl + pr - dw * (KW - 1) - 1) / sw) + 1;
  const out = new Float32Array(N * M * OH * OW);
  const MperG = M / group;
  const xd = x.data;
  const wd = w.data;
  const bd = b?.data;
  const HW = H * W;
  const OHW = OH * OW;
  const pointwise = KH === 1 && KW === 1 && sh === 1 && sw === 1 && pt === 0 && pl === 0 && pb === 0 && pr === 0;
  for (let n = 0; n < N; n++) {
    for (let g = 0; g < group; g++) {
      for (let mo = 0; mo < MperG; mo++) {
        const m = g * MperG + mo;
        const ob = (n * M + m) * OHW;
        const bias = bd ? bd[m] : 0;
        for (let i = 0; i < OHW; i++) out[ob + i] = bias;
        for (let ci = 0; ci < CperG; ci++) {
          const c = g * CperG + ci;
          const xb = (n * C + c) * HW;
          const wb = (m * CperG + ci) * KH * KW;
          if (pointwise) {
            const wv = wd[wb];
            if (wv === 0) continue;
            for (let i = 0; i < OHW; i++) out[ob + i] += wv * xd[xb + i];
            continue;
          }
          for (let kh = 0; kh < KH; kh++) {
            for (let kw = 0; kw < KW; kw++) {
              const wv = wd[wb + kh * KW + kw];
              if (wv === 0) continue;
              for (let oh = 0; oh < OH; oh++) {
                const ih = oh * sh - pt + kh * dh;
                if (ih < 0 || ih >= H) continue;
                const xr = xb + ih * W;
                const orow = ob + oh * OW;
                for (let ow = 0; ow < OW; ow++) {
                  const iw = ow * sw - pl + kw * dw;
                  if (iw < 0 || iw >= W) continue;
                  out[orow + ow] += wv * xd[xr + iw];
                }
              }
            }
          }
        }
      }
    }
  }
  return { dims: [N, M, OH, OW], data: out };
}

function unary(x: LiteTensor, f: (v: number) => number): LiteTensor {
  const out = new Float32Array(x.data.length);
  for (let i = 0; i < out.length; i++) out[i] = f(x.data[i]);
  return { dims: x.dims.slice(), data: out };
}

function broadcast(a: LiteTensor, b: LiteTensor, f: (x: number, y: number) => number): LiteTensor {
  const rank = Math.max(a.dims.length, b.dims.length);
  const ad = Array(rank - a.dims.length).fill(1).concat(a.dims);
  const bd = Array(rank - b.dims.length).fill(1).concat(b.dims);
  const od = ad.map((v, i) => {
    if (v !== bd[i] && v !== 1 && bd[i] !== 1) throw new OnnxLiteError(`Cannot broadcast [${a.dims}] with [${b.dims}].`);
    return Math.max(v, bd[i]);
  });
  const total = size(od);
  const out = new Float32Array(total);
  if (total === a.data.length && a.data.length === b.data.length) {
    for (let i = 0; i < total; i++) out[i] = f(a.data[i], b.data[i]);
    return { dims: od, data: out };
  }
  // strides (0 on broadcast axes)
  const strides = (d: number[]) => {
    const s = Array(rank).fill(0);
    let acc = 1;
    for (let i = rank - 1; i >= 0; i--) {
      s[i] = d[i] === 1 ? 0 : acc;
      acc *= d[i];
    }
    return s;
  };
  const as = strides(ad);
  const bs = strides(bd);
  const idx = Array(rank).fill(0);
  for (let i = 0; i < total; i++) {
    let ai = 0;
    let bi = 0;
    for (let k = 0; k < rank; k++) {
      ai += idx[k] * as[k];
      bi += idx[k] * bs[k];
    }
    out[i] = f(a.data[ai], b.data[bi]);
    for (let k = rank - 1; k >= 0; k--) {
      if (++idx[k] < od[k]) break;
      idx[k] = 0;
    }
  }
  return { dims: od, data: out };
}

function globalAveragePool(x: LiteTensor): LiteTensor {
  const [N, C] = x.dims;
  const spatial = size(x.dims.slice(2));
  const out = new Float32Array(N * C);
  for (let i = 0; i < N * C; i++) {
    let s = 0;
    const base = i * spatial;
    for (let j = 0; j < spatial; j++) s += x.data[base + j];
    out[i] = s / spatial;
  }
  return { dims: [N, C, ...x.dims.slice(2).map(() => 1)], data: out };
}

function gemm(A: LiteTensor, B: LiteTensor, Cb: LiteTensor | undefined, a: LiteNode['attrs']): LiteTensor {
  const alpha = num(a.alpha, 1);
  const beta = num(a.beta, 1);
  const tA = num(a.transA, 0) === 1;
  const tB = num(a.transB, 0) === 1;
  const [M, K] = tA ? [A.dims[1], A.dims[0]] : [A.dims[0], A.dims[1]];
  const [K2, N] = tB ? [B.dims[1], B.dims[0]] : [B.dims[0], B.dims[1]];
  if (K !== K2) throw new OnnxLiteError(`Gemm shape mismatch ${K} vs ${K2}.`);
  const out = new Float32Array(M * N);
  for (let m = 0; m < M; m++) {
    for (let n = 0; n < N; n++) {
      let s = 0;
      for (let k = 0; k < K; k++) {
        const av = tA ? A.data[k * M + m] : A.data[m * K + k];
        const bv = tB ? B.data[n * K + k] : B.data[k * N + n];
        s += av * bv;
      }
      out[m * N + n] = alpha * s;
    }
  }
  if (Cb) {
    const c = broadcast({ dims: [M, N], data: new Float32Array(M * N) }, Cb, (_x, y) => y);
    for (let i = 0; i < out.length; i++) out[i] += beta * c.data[i];
  }
  return { dims: [M, N], data: out };
}

type OpFn = (inputs: (LiteTensor | undefined)[], attrs: LiteNode['attrs']) => LiteTensor;

const OPS: Record<string, OpFn> = {
  Conv: ([x, w, b], a) => conv(x!, w!, b, a),
  Relu: ([x]) => unary(x!, (v) => (v > 0 ? v : 0)),
  HardSwish: ([x]) => unary(x!, (v) => v * Math.max(0, Math.min(1, v / 6 + 0.5))),
  HardSigmoid: ([x], a) => {
    const alpha = num(a.alpha, 0.2);
    const beta = num(a.beta, 0.5);
    return unary(x!, (v) => Math.max(0, Math.min(1, alpha * v + beta)));
  },
  GlobalAveragePool: ([x]) => globalAveragePool(x!),
  Mul: ([a, b]) => broadcast(a!, b!, (x, y) => x * y),
  Add: ([a, b]) => broadcast(a!, b!, (x, y) => x + y),
  Flatten: ([x], a) => {
    let axis = num(a.axis, 1);
    if (axis < 0) axis += x!.dims.length;
    const outer = size(x!.dims.slice(0, axis));
    return { dims: [outer, x!.data.length / outer], data: x!.data };
  },
  Gemm: ([A, B, C], a) => gemm(A!, B!, C, a),
};

/**
 * Run the graph. `onLayer` is awaited after every node so a UI thread can stay
 * responsive (Hermes runs JS on the UI's JS thread).
 */
export async function runOnnxModel(
  model: LiteModel,
  feeds: Record<string, LiteTensor>,
  onLayer?: (done: number, total: number) => Promise<void> | void,
): Promise<Record<string, LiteTensor>> {
  const values = new Map<string, LiteTensor>(model.initializers);
  for (const name of model.inputs) {
    const t = feeds[name];
    if (!t) throw new OnnxLiteError(`Missing input "${name}".`);
    if (t.data.length !== size(t.dims)) throw new OnnxLiteError(`Input "${name}" has ${t.data.length} values for dims [${t.dims}].`);
    values.set(name, t);
  }
  // free intermediates as soon as their last consumer has run
  const lastUse = new Map<string, number>();
  model.nodes.forEach((n, i) => n.inputs.forEach((name) => lastUse.set(name, i)));
  for (let i = 0; i < model.nodes.length; i++) {
    const n = model.nodes[i];
    const ins = n.inputs.map((name) => {
      if (name === '') return undefined;
      const v = values.get(name);
      if (!v) throw new OnnxLiteError(`Node ${n.op}: input "${name}" is not available.`);
      return v;
    });
    const out = OPS[n.op](ins, n.attrs);
    values.set(n.outputs[0], out);
    for (const name of n.inputs) {
      if (lastUse.get(name) === i && !model.initializers.has(name) && !model.outputs.includes(name)) values.delete(name);
    }
    if (onLayer) await onLayer(i + 1, model.nodes.length);
  }
  const result: Record<string, LiteTensor> = {};
  for (const name of model.outputs) {
    const v = values.get(name);
    if (!v) throw new OnnxLiteError(`Output "${name}" was not produced.`);
    result[name] = v;
  }
  return result;
}
