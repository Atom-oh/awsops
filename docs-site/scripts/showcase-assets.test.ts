import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {buildShowcaseMedia} from './build-showcase-media';
import {
  ASSETS,
  assertSourceMatchesSpec,
  type AssetSpec,
  validateAssetSpecs,
} from './showcase-assets';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function cloneAsset(asset: AssetSpec): AssetSpec {
  return {
    ...asset,
    crop: {...asset.crop},
    overlays: asset.overlays.map((overlay) => ({...overlay})),
  };
}

function hexToRgb(fill: string): [number, number, number] {
  const hex = fill.slice(1);
  const expanded = hex.length === 3
    ? [...hex].map((character) => character.repeat(2)).join('')
    : hex;
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}

test('showcase asset outputs are unique WebP files', () => {
  const outputs = ASSETS.map((asset) => asset.output);
  assert.equal(new Set(outputs).size, outputs.length);
  assert.ok(outputs.every((output) => path.basename(output) === output));
  assert.ok(outputs.every((output) => /^[^/\\]+\.webp$/.test(output)));

  for (const output of ['nested/file.webp', String.raw`nested\file.webp`, 'file.png', '.webp']) {
    const asset = cloneAsset(ASSETS[0]);
    asset.output = output;
    assert.throws(
      () => validateAssetSpecs(1920, 1080, [asset]),
      /invalid WebP output basename/,
    );
  }
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

test('output width and crop dimensions are positive finite integers', () => {
  for (const asset of ASSETS) {
    assert.ok(Number.isInteger(asset.outputWidth) && asset.outputWidth > 0);
    assert.ok(Number.isInteger(asset.crop.width) && asset.crop.width > 0);
    assert.ok(Number.isInteger(asset.crop.height) && asset.crop.height > 0);
  }

  for (const invalid of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
    const invalidOutput = cloneAsset(ASSETS[0]);
    invalidOutput.outputWidth = invalid;
    assert.throws(
      () => validateAssetSpecs(1920, 1080, [invalidOutput]),
      /outputWidth must be a positive finite integer/,
    );

    const invalidCropWidth = cloneAsset(ASSETS[0]);
    invalidCropWidth.crop.width = invalid;
    assert.throws(
      () => validateAssetSpecs(1920, 1080, [invalidCropWidth]),
      /crop width must be a positive finite integer/,
    );

    const invalidCropHeight = cloneAsset(ASSETS[0]);
    invalidCropHeight.crop.height = invalid;
    assert.throws(
      () => validateAssetSpecs(1920, 1080, [invalidCropHeight]),
      /crop height must be a positive finite integer/,
    );
  }
});

test('source dimensions and SHA-256 match the approved PNGs', () => {
  for (const asset of ASSETS) {
    assert.equal(asset.sourceWidth, 1920);
    assert.equal(asset.sourceHeight, 1080);
    assert.match(asset.sourceSha256, /^[a-f0-9]{64}$/);
    const source = fs.readFileSync(path.join(siteRoot, asset.source));
    assert.doesNotThrow(() => assertSourceMatchesSpec(asset, source));
  }
});

test('source identity mismatches fail closed', () => {
  const asset = ASSETS[0];
  const source = fs.readFileSync(path.join(siteRoot, asset.source));

  assert.throws(
    () => assertSourceMatchesSpec({...asset, sourceSha256: '0'.repeat(64)}, source),
    /source hash mismatch/,
  );
  assert.throws(
    () => assertSourceMatchesSpec({...asset, sourceWidth: asset.sourceWidth + 1}, source),
    /source dimensions mismatch/,
  );
  assert.throws(
    () => assertSourceMatchesSpec({...asset, sourceHeight: asset.sourceHeight + 1}, source),
    /source dimensions mismatch/,
  );
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

test('generator writes decoded WebPs with baked-in overlay pixels', {timeout: 30_000}, async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsops-showcase-media-'));

  try {
    await buildShowcaseMedia(outputDir);
    assert.deepEqual(
      fs.readdirSync(outputDir).sort(),
      ASSETS.map((asset) => asset.output).sort(),
    );

    const browser = await chromium.launch({headless: true});
    try {
      const page = await browser.newPage();

      for (const asset of ASSETS) {
        const output = fs.readFileSync(path.join(outputDir, asset.output));
        assert.equal(output.subarray(0, 4).toString('ascii'), 'RIFF');
        assert.equal(output.subarray(8, 12).toString('ascii'), 'WEBP');

        const scale = asset.outputWidth / asset.crop.width;
        const samples = asset.overlays.map((overlay) => ({
          x: Math.round((overlay.left + overlay.width - 16) * scale),
          y: Math.round((overlay.top + 8) * scale),
        }));
        const decoded = await page.evaluate(async ({source, samples}) => {
          const image = new Image();
          image.src = `data:image/webp;base64,${source}`;
          await image.decode();

          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d');
          if (!context) {
            throw new Error('2D canvas unavailable');
          }
          context.drawImage(image, 0, 0);

          return {
            width: image.naturalWidth,
            height: image.naturalHeight,
            pixels: samples.map(({x, y}) => [...context.getImageData(x, y, 1, 1).data]),
          };
        }, {source: output.toString('base64'), samples});

        assert.equal(decoded.width, asset.outputWidth);
        assert.equal(
          decoded.height,
          Math.round(asset.crop.height * asset.outputWidth / asset.crop.width),
        );

        for (const [index, actual] of decoded.pixels.entries()) {
          const expected = hexToRgb(asset.overlays[index].fill);
          for (let channel = 0; channel < expected.length; channel += 1) {
            assert.ok(
              Math.abs(actual[channel] - expected[channel]) <= 12,
              `${asset.output} overlay ${index} channel ${channel}: expected ${expected[channel]}, got ${actual[channel]}`,
            );
          }
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    fs.rmSync(outputDir, {recursive: true, force: true});
  }
});
