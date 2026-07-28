import {createHash} from 'node:crypto';
import path from 'node:path';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Overlay extends Rect {
  fill: string;
  text: string;
  label?: string;
  sample: {
    left: number;
    top: number;
  };
}

export interface AssetSpec {
  source: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceSha256: string;
  output: string;
  crop: Rect;
  outputWidth: number;
  overlays: Overlay[];
}

const SCREENSHOTS = path.join('static', 'screenshots');

export const ASSETS: AssetSpec[] = [
  {
    source: path.join(SCREENSHOTS, 'overview', 'dashboard.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: '2fbc6fbd1c37a3ca0bc7bb8586be48e0737dc7637d0a9aab2cd345a2b5bf030e',
    output: 'dashboard.webp',
    crop: {left: 0, top: 0, width: 1920, height: 1080},
    outputWidth: 1600,
    overlays: [
      {
        left: 8, top: 976, width: 230, height: 48,
        fill: '#f4f6f8', text: '#526173', label: 'Demo operator',
        sample: {left: 40, top: 995},
      },
      {
        left: 828, top: 167, width: 534, height: 201,
        fill: '#fff', text: '#526173', label: 'Recent AI conversation',
        sample: {left: 900, top: 230},
      },
      {
        left: 1378, top: 167, width: 504, height: 201,
        fill: '#fff', text: '#526173', label: 'AI analysis',
        sample: {left: 1450, top: 230},
      },
    ],
  },
  {
    source: path.join(SCREENSHOTS, 'overview', 'assistant-answer.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: '8ec351e94e76e42ee8ea5515fa49a15509864a7648a1faf6fe8e74eb9b30bc0c',
    output: 'assistant-answer.webp',
    crop: {left: 606, top: 114, width: 904, height: 894},
    outputWidth: 1200,
    overlays: [],
  },
  {
    source: path.join(SCREENSHOTS, 'resources', 'topology-detail.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: 'f57282d1fdc738072988830baa8ccaec2ed4641c6030ad5ce5c805c4c54688e1',
    output: 'topology.webp',
    crop: {left: 400, top: 250, width: 1055, height: 720},
    outputWidth: 1400,
    overlays: [
      {
        left: 330, top: 26, width: 278, height: 44,
        fill: '#e8f8ee', text: '#17362b', label: 'DNS endpoint',
        sample: {left: 400, top: 44},
      },
      {
        left: 185, top: 186, width: 276, height: 46,
        fill: '#eaf1ff', text: '#1f3763', label: 'CloudFront',
        sample: {left: 260, top: 206},
      },
      {
        left: 620, top: 349, width: 282, height: 44,
        fill: '#fff0dc', text: '#523819', label: 'Load balancer',
        sample: {left: 700, top: 368},
      },
      {
        left: 480, top: 510, width: 270, height: 42,
        fill: '#f2e9ff', text: '#3e2a5c', label: 'Target group',
        sample: {left: 560, top: 528},
      },
      {
        left: 773, top: 510, width: 270, height: 42,
        fill: '#f2e9ff', text: '#3e2a5c', label: 'Target group',
        sample: {left: 853, top: 528},
      },
      {
        left: 480, top: 670, width: 270, height: 42,
        fill: '#e5f8f5', text: '#173d38', label: 'Healthy targets',
        sample: {left: 560, top: 688},
      },
      {
        left: 773, top: 670, width: 270, height: 42,
        fill: '#e5f8f5', text: '#173d38', label: 'Healthy targets',
        sample: {left: 853, top: 688},
      },
    ],
  },
  {
    source: path.join(SCREENSHOTS, 'cost', 'cost-explorer.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: '61168cb98800b80dc2a9d0b2124f7b2ac0bd3801cebd880ae11d548402032f13',
    output: 'cost-explorer.webp',
    crop: {left: 288, top: 104, width: 1600, height: 900},
    outputWidth: 1600,
    overlays: [],
  },
  {
    source: path.join(SCREENSHOTS, 'overview', 'dashboard.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: '2fbc6fbd1c37a3ca0bc7bb8586be48e0737dc7637d0a9aab2cd345a2b5bf030e',
    output: 'compliance.webp',
    crop: {left: 288, top: 408, width: 1600, height: 190},
    outputWidth: 1600,
    overlays: [],
  },
  {
    source: path.join(SCREENSHOTS, 'operations', 'ai-diagnosis.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: 'e902a17f2333bbb5ea5ba9449692e3c1161590c5ffc0af86513313e3ee3242e5',
    output: 'ai-diagnosis.webp',
    crop: {left: 568, top: 128, width: 1320, height: 900},
    outputWidth: 1600,
    overlays: [
      {
        left: 190, top: 214, width: 275, height: 42,
        fill: '#f4f6f8', text: '#18212d', label: '호스트 계정 (mid)',
        sample: {left: 378, top: 235},
      },
    ],
  },
];

function assertPositiveFiniteInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite integer`);
  }
}

export function assertSourceMatchesSpec(asset: AssetSpec, source: Buffer): void {
  const actualSha256 = createHash('sha256').update(source).digest('hex');
  if (actualSha256 !== asset.sourceSha256) {
    throw new Error(
      `source hash mismatch for ${asset.output}: expected ${asset.sourceSha256}, got ${actualSha256}`,
    );
  }

  const pngSignature = '89504e470d0a1a0a';
  if (
    source.length < 24 ||
    source.subarray(0, 8).toString('hex') !== pngSignature ||
    source.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    throw new Error(`source dimensions mismatch for ${asset.output}: source is not a valid PNG`);
  }

  const actualWidth = source.readUInt32BE(16);
  const actualHeight = source.readUInt32BE(20);
  if (actualWidth !== asset.sourceWidth || actualHeight !== asset.sourceHeight) {
    throw new Error(
      `source dimensions mismatch for ${asset.output}: expected ${asset.sourceWidth}x${asset.sourceHeight}, got ${actualWidth}x${actualHeight}`,
    );
  }
}

export function validateAssetSpecs(
  sourceWidth: number,
  sourceHeight: number,
  assets: AssetSpec[] = ASSETS,
): void {
  const outputs = new Set<string>();
  for (const asset of assets) {
    if (outputs.has(asset.output)) {
      throw new Error(`duplicate output: ${asset.output}`);
    }
    outputs.add(asset.output);

    if (path.basename(asset.output) !== asset.output || !/^[^/\\]+\.webp$/.test(asset.output)) {
      throw new Error(`invalid WebP output basename: ${asset.output}`);
    }
    assertPositiveFiniteInteger(asset.outputWidth, 'outputWidth');
    assertPositiveFiniteInteger(asset.crop.width, 'crop width');
    assertPositiveFiniteInteger(asset.crop.height, 'crop height');
    assertPositiveFiniteInteger(asset.sourceWidth, 'sourceWidth');
    assertPositiveFiniteInteger(asset.sourceHeight, 'sourceHeight');
    if (!/^[a-f0-9]{64}$/.test(asset.sourceSha256)) {
      throw new Error(`invalid source SHA-256: ${asset.output}`);
    }
    if (asset.sourceWidth !== sourceWidth || asset.sourceHeight !== sourceHeight) {
      throw new Error(
        `unexpected source dimensions for ${asset.output}: expected ${sourceWidth}x${sourceHeight}`,
      );
    }

    const {crop} = asset;
    if (
      crop.left < 0 ||
      crop.top < 0 ||
      crop.left + crop.width > sourceWidth ||
      crop.top + crop.height > sourceHeight
    ) {
      throw new Error(`crop outside source: ${asset.output}`);
    }

    for (const overlay of asset.overlays) {
      if (
        overlay.left < 0 ||
        overlay.top < 0 ||
        overlay.left + overlay.width > crop.width ||
        overlay.top + overlay.height > crop.height
      ) {
        throw new Error(`overlay outside crop: ${asset.output}`);
      }
      if (
        !Number.isInteger(overlay.sample?.left) ||
        !Number.isInteger(overlay.sample?.top) ||
        overlay.sample.left < overlay.left ||
        overlay.sample.top < overlay.top ||
        overlay.sample.left >= overlay.left + overlay.width ||
        overlay.sample.top >= overlay.top + overlay.height
      ) {
        throw new Error(`overlay sample outside overlay: ${asset.output}`);
      }
    }
  }
}
