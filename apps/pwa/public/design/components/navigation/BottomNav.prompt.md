BottomNav — mobile primary navigation, hard-capped at 5 items (matches `shell.ts`'s existing `MAX_TABS` rule) so labels never wrap to two lines at 360px. Everything past 5 goes under "আরও" (More), not onto the bar.

```jsx
<BottomNav active="home" items={[{value:'home',label:'হোম',icon:<HomeIcon/>}, ...]} />
```
