Button — the product's one action primitive. Use `primary` for the single main action per screen (Save Attendance, Pay Now), `secondary` for supporting actions, `danger` for destructive ones, `success` sparingly for confirm-style actions (Mark All Present), `ghost` for low-emphasis text actions. Height floor is 44px (52 with `size="lg"`) for comfortable taps on a shared phone.

```jsx
<Button variant="primary" size="lg" fullWidth>উপস্থিতি সংরক্ষণ করুন</Button>
```

Never place more than one `primary` button in the same view (brief §26).
