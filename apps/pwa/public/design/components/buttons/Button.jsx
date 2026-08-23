import React from 'react';

const VARIANTS = {
  primary: { bg: 'var(--color-primary)', hover: 'var(--color-primary-hover)', fg: 'var(--color-text-on-primary)', border: 'transparent' },
  secondary: { bg: 'var(--color-bg)', hover: 'var(--color-surface-muted)', fg: 'var(--color-text)', border: 'var(--color-border-strong)' },
  success: { bg: 'var(--color-success)', hover: '#16a34a', fg: '#ffffff', border: 'transparent' },
  danger: { bg: 'var(--color-danger)', hover: '#b91c1c', fg: '#ffffff', border: 'transparent' },
  ghost: { bg: 'transparent', hover: 'var(--color-surface-muted)', fg: 'var(--color-primary)', border: 'transparent' },
};

export function Button({ variant = 'primary', size = 'md', icon, fullWidth = false, disabled = false, children, onClick }) {
  const v = VARIANTS[variant] || VARIANTS.primary;
  const [hover, setHover] = React.useState(false);
  const height = size === 'lg' ? 52 : 44;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        height, padding: '0 20px', width: fullWidth ? '100%' : undefined,
        background: disabled ? 'var(--color-surface-muted)' : (hover ? v.hover : v.bg),
        color: disabled ? 'var(--color-text-faint)' : v.fg,
        border: v.border === 'transparent' ? 'none' : `1px solid ${v.border}`,
        borderRadius: 'var(--radius-md)',
        fontFamily: 'var(--font-bn)', fontSize: 14, fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background var(--transition-fast)',
        boxShadow: variant === 'primary' && !disabled ? 'var(--shadow-sm)' : 'none',
      }}
    >
      {icon}{children}
    </button>
  );
}
