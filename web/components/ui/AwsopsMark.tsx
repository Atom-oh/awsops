import type { CSSProperties } from 'react';

/**
 * AWSops brand mark — a claude-500 rounded-square tile (radius 10/40)
 * with a white stroked cube. Inline SVG, no external asset.
 * Used in the sidebar lockup, login, KPI watermark, and AI avatar.
 */
export default function AwsopsMark({ size = 36, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={style}
    >
      {/* rounded-square brand tile — radius 10 on a 40 viewBox */}
      <rect width="40" height="40" rx="10" fill="#D97757" />
      {/* white stroked cube */}
      <g stroke="#FFFFFF" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" fill="none">
        <path d="M20 9 L29 14 L29 24 L20 29 L11 24 L11 14 Z" />
        <path d="M20 9 L20 19 M20 19 L29 14 M20 19 L11 14" />
        {/* base accent */}
        <path d="M14 27 L26 27" opacity="0.7" />
      </g>
    </svg>
  );
}
