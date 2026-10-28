// Jest runs tests in a separate VM realm, so typed arrays created in a test fail
// onnxruntime-node's `instanceof Float32Array` checks. Share the host realm's
// typed-array constructors with the test realm (test-only; the app is unaffected).
const { TestEnvironment } = require('jest-environment-node');

class SharedTypedArrayEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    for (const name of [
      'ArrayBuffer', 'Uint8Array', 'Uint8ClampedArray', 'Int8Array', 'Uint16Array', 'Int16Array',
      'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
    ]) {
      this.global[name] = globalThis[name];
    }
  }
}
module.exports = SharedTypedArrayEnvironment;
