# Strings

New strings go in your domain's file, never in another unit's domain. Create a
new domain file only for a new surface, import it in `../strings.ts`, and give
`ar` the type `Record<keyof typeof en, string>` so the compiler enforces the
EN/AR mirror. Run `node scripts/check-strings.mjs check` before committing;
when you intentionally add or change keys, re-run it with `snapshot` and commit
the updated `scripts/strings-snapshot.json` together with your keys.
