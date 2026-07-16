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
}

export interface AssetSpec {
  source: string;
  output: string;
  crop: Rect;
  outputWidth: number;
  overlays: Overlay[];
}

const SCREENSHOTS = path.join('static', 'screenshots');

export const ASSETS: AssetSpec[] = [
  {
    source: path.join(SCREENSHOTS, 'overview', 'dashboard.png'),
    output: 'dashboard.webp',
    crop: {left: 0, top: 0, width: 1920, height: 1080},
    outputWidth: 1600,
    overlays: [
      {left: 42, top: 958, width: 180, height: 58, fill: '#f4f6f8', text: '#526173', label: 'Demo operator'},
      {left: 846, top: 210, width: 448, height: 112, fill: '#fff', text: '#526173', label: 'Recent AI operations'},
    ],
  },
  {
    source: path.join(SCREENSHOTS, 'overview', 'assistant-answer.png'),
    output: 'assistant-answer.webp',
    crop: {left: 590, top: 112, width: 720, height: 890},
    outputWidth: 1200,
    overlays: [],
  },
  {
    source: path.join(SCREENSHOTS, 'resources', 'topology-detail.png'),
    output: 'topology.webp',
    crop: {left: 288, top: 160, width: 1150, height: 860},
    outputWidth: 1400,
    overlays: [
      {left: 700, top: 108, width: 232, height: 38, fill: '#e8f8ee', text: '#17362b', label: 'DNS endpoint'},
      {left: 700, top: 270, width: 232, height: 38, fill: '#eaf1ff', text: '#1f3763', label: 'CloudFront'},
      {left: 700, top: 429, width: 232, height: 38, fill: '#fff0dc', text: '#523819', label: 'Load balancer'},
      {left: 700, top: 591, width: 232, height: 38, fill: '#f2e9ff', text: '#3e2a5c', label: 'Target group'},
      {left: 700, top: 752, width: 232, height: 38, fill: '#e5f8f5', text: '#173d38', label: 'Healthy targets'},
    ],
  },
  {
    source: path.join(SCREENSHOTS, 'cost', 'cost-explorer.png'),
    output: 'cost-explorer.webp',
    crop: {left: 288, top: 104, width: 1600, height: 900},
    outputWidth: 1600,
    overlays: [],
  },
  {
    source: path.join(SCREENSHOTS, 'overview', 'dashboard.png'),
    output: 'compliance.webp',
    crop: {left: 288, top: 386, width: 1600, height: 190},
    outputWidth: 1600,
    overlays: [],
  },
  {
    source: path.join(SCREENSHOTS, 'operations', 'ai-diagnosis.png'),
    output: 'ai-diagnosis.webp',
    crop: {left: 568, top: 128, width: 1320, height: 900},
    outputWidth: 1600,
    overlays: [
      {left: 190, top: 214, width: 275, height: 42, fill: '#f4f6f8', text: '#18212d', label: '호스트 계정 (mid)'},
    ],
  },
];

export function validateAssetSpecs(sourceWidth: number, sourceHeight: number): void {
  const outputs = new Set<string>();
  for (const asset of ASSETS) {
    if (outputs.has(asset.output)) {
      throw new Error(`duplicate output: ${asset.output}`);
    }
    outputs.add(asset.output);

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
    }
  }
}
