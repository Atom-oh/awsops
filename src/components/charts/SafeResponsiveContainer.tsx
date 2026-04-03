'use client';

import { useState, useEffect, type ReactElement } from 'react';
import { ResponsiveContainer } from 'recharts';

interface Props {
  width?: number | `${number}%`;
  height?: number | `${number}%`;
  children: ReactElement;
}

// Defers ResponsiveContainer render until after mount to prevent
// Recharts width(-1)/height(-1) warning when container has no dimensions yet.
export default function SafeResponsiveContainer({ width = '100%', height = '100%', children }: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!mounted) return null;
  return (
    <ResponsiveContainer width={width} height={height}>
      {children}
    </ResponsiveContainer>
  );
}
