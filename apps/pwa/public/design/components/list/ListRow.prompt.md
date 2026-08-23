ListRow — the student list, notice list and notification list all use this one row shape: leading avatar/icon, title + subtitle, optional trailing badge/action. Avoids one-card-per-row (brief §10/§26); rows are separated by a hairline, not individual card shadows.

```jsx
<ListRow leading={<Avatar name="আরিফ রহমান" />} title="আরিফ রহমান" subtitle="৮ম শ্রেণি · রোল ১২" trailing={<Badge tone="success">✓</Badge>} />
```
