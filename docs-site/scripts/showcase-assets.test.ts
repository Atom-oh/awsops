import assert from 'node:assert/strict';
import test from 'node:test';
import {ASSETS, validateAssetSpecs} from './showcase-assets';

test('showcase asset outputs are unique WebP files', () => {
  const outputs = ASSETS.map((asset) => asset.output);
  assert.equal(new Set(outputs).size, outputs.length);
  assert.ok(outputs.every((output) => output.endsWith('.webp')));
});

test('all crops and privacy overlays are valid', () => {
  assert.doesNotThrow(() => validateAssetSpecs(1920, 1080));
  for (const asset of ASSETS) {
    assert.ok(asset.outputWidth <= 1600);
    for (const overlay of asset.overlays) {
      assert.ok(overlay.left >= 0 && overlay.top >= 0);
      assert.ok(overlay.left + overlay.width <= asset.crop.width);
      assert.ok(overlay.top + overlay.height <= asset.crop.height);
    }
  }
});

test('topology and diagnosis have baked-in identifier replacements', () => {
  const topology = ASSETS.find((asset) => asset.output === 'topology.webp');
  const diagnosis = ASSETS.find((asset) => asset.output === 'ai-diagnosis.webp');
  assert.deepEqual(
    topology?.overlays.map((overlay) => overlay.label),
    ['DNS endpoint', 'CloudFront', 'Load balancer', 'Target group', 'Healthy targets'],
  );
  assert.equal(diagnosis?.overlays[0]?.label, '호스트 계정 (mid)');
});

test('topology overlays cover the complete resource label area', () => {
  const topology = ASSETS.find((asset) => asset.output === 'topology.webp');
  assert.ok(topology);
  assert.ok(topology.overlays.every((overlay) => overlay.left + overlay.width >= 932));
});
