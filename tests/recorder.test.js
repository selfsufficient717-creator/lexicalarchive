import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav } from '../recorder.js';
import { validateWav } from '../server/validation.js';

test('browser encoder creates provider-compatible mono PCM WAV with accurate duration', () => {
  const samples = new Float32Array(32000);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 16) / 2;
  const bytes = Buffer.from(encodeWav(samples));
  const audio = validateWav({ format: 'wav', base64: bytes.toString('base64') }, 2);
  assert.equal(audio.durationSeconds, 2);
  assert.equal(bytes.readUInt32LE(24), 16000);
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt16LE(34), 16);
});

test('WAV clips sample excursions rather than wrapping PCM values', () => {
  const view = new DataView(encodeWav(new Float32Array([-2, 0, 2])));
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(46, true), 0);
  assert.equal(view.getInt16(48, true), 32767);
});

test('two-minute browser limit fits backend audio limits and cannot submit tiny empty clips', () => {
  const long = Buffer.from(encodeWav(new Float32Array(120 * 16000)));
  assert.equal(validateWav({ format: 'wav', base64: long.toString('base64') }, 120).durationSeconds, 120);
  const short = Buffer.from(encodeWav(new Float32Array(100)));
  assert.throws(() => validateWav({ format: 'wav', base64: short.toString('base64') }), /between 1 and 120/);
});
