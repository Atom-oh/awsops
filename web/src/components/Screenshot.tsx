import React from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';

interface ScreenshotProps {
  src: string;
  alt: string;
  fullWidth?: boolean;
}

export default function Screenshot({ src, alt, fullWidth }: ScreenshotProps): React.ReactElement {
  // Strip .png extension to build variant paths
  const base = src.replace(/\.png$/, '');
  const src1x = `${base}.png`;
  const src1_5x = `${base}@1.5x.png`;
  const src2x = `${base}@2x.png`;

  const resolvedSrc = useBaseUrl(src1x);
  const resolvedSrcSet = `${useBaseUrl(src1x)} 1x, ${useBaseUrl(src1_5x)} 1.5x, ${useBaseUrl(src2x)} 2x`;

  return (
    <img
      src={resolvedSrc}
      srcSet={resolvedSrcSet}
      alt={alt}
      loading="lazy"
      onError={(e) => {
        // If high-DPR variants are missing, fall back to base src only
        const img = e.currentTarget;
        if (img.srcSet) {
          img.srcSet = '';
          img.src = resolvedSrc;
        }
      }}
      style={{
        width: fullWidth ? '100%' : undefined,
        maxWidth: '100%',
        borderRadius: 8,
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
      }}
    />
  );
}
