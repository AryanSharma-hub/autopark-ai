/** onnxLite (the app's on-device runtime) vs onnxruntime on the real model file. */
import * as fs from 'fs';
import * as path from 'path';
import * as ort from 'onnxruntime-node';

import { OnnxLiteError, parseOnnxModel, runOnnxModel } from '../src/core/vision/onnxLite';

const MODEL = path.join(__dirname, '..', 'assets', 'model', 'slot_classifier.onnx');

describe('onnxLite', () => {
  const model = parseOnnxModel(new Uint8Array(fs.readFileSync(MODEL)));
  let session: ort.InferenceSession;
  beforeAll(async () => {
    session = await ort.InferenceSession.create(MODEL);
  });

  test('parses the graph: one input, logits output, MobileNetV3 operator set', () => {
    expect(model.inputs).toEqual(['input']);
    expect(model.outputs).toEqual(['logits']);
    expect(model.nodes.length).toBe(122);
    const params = [...model.initializers.values()].reduce((a, t) => a + t.data.length, 0);
    expect(params).toBe(1513850);
  });

  test.each([1, 2, 3, 4])('random batch %#: logits match onnxruntime within 1e-4', async (seed) => {
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 5;
    const N = seed === 1 ? 1 : 3;
    const data = new Float32Array(N * 3 * 96 * 96).map(rnd);
    const ref = (await session.run({ input: new ort.Tensor('float32', data, [N, 3, 96, 96]) })).logits.data as Float32Array;
    const got = (await runOnnxModel(model, { input: { dims: [N, 3, 96, 96], data } })).logits;
    expect(got.dims).toEqual([N, 2]);
    for (let i = 0; i < ref.length; i++) expect(Math.abs(got.data[i] - ref[i])).toBeLessThan(1e-4);
  });

  test('rejects wrong input sizes and non-ONNX bytes', async () => {
    await expect(runOnnxModel(model, { input: { dims: [1, 3, 96, 96], data: new Float32Array(10) } })).rejects.toThrow(OnnxLiteError);
    await expect(runOnnxModel(model, {})).rejects.toThrow(/Missing input/);
    expect(() => parseOnnxModel(new Uint8Array([1, 2, 3]))).toThrow();
  });

  test('progress callback fires once per node (used to keep the UI responsive)', async () => {
    let calls = 0;
    await runOnnxModel(model, { input: { dims: [1, 3, 96, 96], data: new Float32Array(3 * 96 * 96) } }, () => {
      calls++;
    });
    expect(calls).toBe(model.nodes.length);
  });
});
