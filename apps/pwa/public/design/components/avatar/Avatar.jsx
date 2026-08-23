import React from 'react';

const COLORS = ['#e53935', '#3b82f6', '#22c55e', '#f59e0b', '#8b5cf6', '#0ea5e9'];
function hash(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

export function Avatar({ name = '', size = 40, src }) {
  const initial = name.trim().charAt(0) || '?';
  const bg = COLORS[hash(name) % COLORS.length];
  const style = {
    width: size, height: size, borderRadius: '50%', flex: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: bg, color: '#fff', fontFamily: 'var(--font-bn)', fontWeight: 600,
    fontSize: size * 0.42, overflow: 'hidden',
  };
  if (src) return <div style={style}><img src={src} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></div>;
  return <div style={style}>{initial}</div>;
}
