Skeleton — a lightweight shimmer placeholder for slow-network loading states (brief §17: no blank screens, but nothing heavier than CSS). Needs one global keyframe, added once per page:

```css
@keyframes ds-skeleton { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
```

```jsx
<Skeleton width={160} height={16} />
```
