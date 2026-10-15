# music-warehouse

## Verifying changes

For changes to `migrations/`, `/auth/*`, or the shape of an `/api/*` response (fields, types, paging), prove the change end to end with the `verify-warehouse` skill before calling it done, and include the evidence path in your report. The five clients depend on these shapes, and unit tests start from an empty database. For anything else (docs, tests, refactors, small fixes), the unit tests are enough; skip it.
