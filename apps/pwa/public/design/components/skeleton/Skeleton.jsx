import React from 'react';

export function Skeleton({ width = '100%', height = 14, radius = 6 }) {
  return (
    <div style={{
      width, height, borderRadius: radius,
      background: 'linear-gradient(90deg, var(--color-surface-muted) 25%, var(--color-border) 50%, var(--color-surface-muted) 75%)',
      backgroundSize: '200% 100%', animation: 'ds-skeleton 1.4s ease-in-out infinite',
    }} />
  );
}
