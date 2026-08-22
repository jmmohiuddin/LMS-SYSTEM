import React from 'react';

const TONES = {
  info: { bg: 'var(--color-info-soft)', fg: 'var(--color-info-ink)' },
  success: { bg: 'var(--color-success-soft)', fg: 'var(--color-success-ink)' },
  warning: { bg: 'var(--color-warning-soft)', fg: 'var(--color-warning-ink)' },
  danger: { bg: 'var(--color-danger-soft)', fg: 'var(--color-danger-ink)' },
  neutral: { bg: 'var(--color-surface-muted)', fg: 'var(--color-text)' },
};

export function Alert({ tone = 'info', icon, children, action }) {
  const t = TONES[tone] || TONES.info;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
      borderRadius: 'var(--radius-md)', background: t.bg, color: t.fg,
      fontFamily: 'var(--font-bn)', fontSize: 13.5, lineHeight: 1.5,
    }}>
      {icon && <span aria-hidden="true" style={{ width: 18, height: 18, flex: 'none', display: 'flex' }}>{icon}</span>}
      <span style={{ flex: 1 }}>{children}</span>
      {action}
    </div>
  );
}
