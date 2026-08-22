Alert — a persistent inline banner (offline status, sync status, a school-wide notice), not a modal (brief §4/§16). Also doubles as a toast: mount the same shape in a fixed corner, auto-dismiss after ~3s, for confirmations like "উপস্থিতি সংরক্ষিত হয়েছে". Copy is always human, never a raw error — "সংযোগ পাওয়া যাচ্ছে না। আপনার তথ্য সংরক্ষিত আছে, সংযোগ পেলে আপনাআপনি জমা হবে।"

```jsx
<Alert tone="neutral">অফলাইন — কাজ চালিয়ে যান, সংযোগ পেলে জমা হবে</Alert>
```
