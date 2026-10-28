// Bundle the ONNX model as an asset (assets/model/slot_classifier.onnx).
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('onnx');
// Keep test fixtures and native build output out of the bundle graph.
config.resolver.blockList = [/__tests__\/fixtures\/.*/, /dist-android\/.*/];
module.exports = config;
