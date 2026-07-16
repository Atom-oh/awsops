import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {ASSETS, validateAssetSpecs} from './showcase-assets';

const here = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(here, '..');
const outputDir = path.join(siteRoot, 'static', 'showcase', 'media');

async function main(): Promise<void> {
  validateAssetSpecs(1920, 1080);

  const sourcePaths = ASSETS.map((asset) => path.join(siteRoot, asset.source));
  for (const sourcePath of sourcePaths) {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`missing source: ${sourcePath}`);
    }
  }

  fs.mkdirSync(outputDir, {recursive: true});
  const browser = await chromium.launch({headless: true});

  try {
    const page = await browser.newPage();
    for (const [index, asset] of ASSETS.entries()) {
      const source = fs.readFileSync(sourcePaths[index]).toString('base64');
      const dataUrl = await page.evaluate(async ({source, asset}) => {
        const image = new Image();
        image.src = `data:image/png;base64,${source}`;
        await image.decode();

        const scale = asset.outputWidth / asset.crop.width;
        const canvas = document.createElement('canvas');
        canvas.width = asset.outputWidth;
        canvas.height = Math.round(asset.crop.height * scale);

        const context = canvas.getContext('2d', {alpha: false});
        if (!context) {
          throw new Error('2D canvas unavailable');
        }

        context.drawImage(
          image,
          asset.crop.left,
          asset.crop.top,
          asset.crop.width,
          asset.crop.height,
          0,
          0,
          canvas.width,
          canvas.height,
        );

        for (const overlay of asset.overlays) {
          const x = Math.round(overlay.left * scale);
          const y = Math.round(overlay.top * scale);
          const width = Math.round(overlay.width * scale);
          const height = Math.round(overlay.height * scale);
          context.fillStyle = overlay.fill;
          context.fillRect(x, y, width, height);

          if (overlay.label) {
            const padding = Math.round(12 * scale);
            context.fillStyle = overlay.text;
            context.font = `600 ${Math.max(14, Math.round(14 * scale))}px system-ui, sans-serif`;
            context.textBaseline = 'middle';
            context.fillText(overlay.label, x + padding, y + height / 2, width - padding * 2);
          }
        }

        return canvas.toDataURL('image/webp', 0.86);
      }, {source, asset});

      if (!dataUrl.startsWith('data:image/webp;base64,')) {
        throw new Error(`WebP encoding failed: ${asset.output}`);
      }

      const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const outputPath = path.join(outputDir, asset.output);
      fs.writeFileSync(outputPath, Buffer.from(encoded, 'base64'));
      console.log(`${asset.output}: ${fs.statSync(outputPath).size} bytes`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
