import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOptions } from '../main/files.mjs';

test('base and text settings coexist with both grass controls', () => {
  const options = validateOptions({
    baseText: '山行工坊', baseTextSizeMm: 4.2, textEnabled: true,
    baseColorSource: 'custom', baseColor: '#224466',
    textColorSource: 'custom', textColor: '#ffbb00',
    grassSensitivity: 72, grassContinuity: 85,
  });
  assert.equal(options.baseText, '山行工坊');
  assert.equal(options.baseTextSizeMm, 4.2);
  assert.equal(options.baseColor, '#224466');
  assert.equal(options.textColor, '#ffbb00');
  assert.equal(options.grassSensitivity, 72);
  assert.equal(options.grassContinuity, 85);
});
