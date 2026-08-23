import React from 'react';

const TONES = {
  success: { bg: 'var(--color-success-soft)', fg: 'var(--color-success-ink)' },
  warning: { bg: 'var(--color-warning-soft)', fg: 'var(--color-warning-ink)' },
  danger: { bg: 'var(--color-danger-soft)', fg: 'var(--color-danger-ink)' },
  info: { bg: 'var(--color-info-soft)', fg: 'var(--color-info-ink)' },
  accent: { bg: 'var(--color-accent-2-soft)', fg: 'var(--color-accent-2-ink)' },
  neutral: { bg: 'var(--color-surface-muted)', fg: 'var(--color-text-muted)' },
};

export function Badge({ tone = 'neutral', icon, children }) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px',
      borderRadius: 'var(--radius-pill)', background: t.bg, color: t.fg,
      fontFamily: 'var(--font-bn)', fontSize: 12, fontWeight: 600, lineHeight: 1.4,
    }}>{icon}{children}</span>
  );
}
