# Rollback migrations

One `down` file per forward migration, applied in **descending** order:

```bash
for f in $(ls -r db/rollback/*.down.sql); do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

Every statement is `IF EXISTS` + `CASCADE`, so a partial rollback is re-runnable.

**Scope note.** These are structural rollbacks — they drop objects, they do not
preserve data. That is correct for the current pre-production stage, where the
purpose is the CI up → down → up cycle. Once real institutions are live, any
migration that drops or rewrites a column needs a data-preserving down file
written alongside it, and the expand/contract pattern (add nullable → backfill →
switch reads → drop) should be used instead of in-place ALTERs.
