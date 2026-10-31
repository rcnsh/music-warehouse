# Optional features

Both are off until you give the Worker a key. While off, their routes answer
`404`, as a route the Worker doesn't have would. The routes themselves are
under [Concerts](api.md#concerts) and [Lyrics](api.md#lyrics) in the API
reference.

## Setting up concerts

1. **Get a Ticketmaster key.** Sign up at <https://developer.ticketmaster.com>
   and open **My Apps**. The default app's **Consumer Key** is the key; the
   consumer secret isn't needed.
   It's free, with a quota of 5,000 calls a day and 5 a second.
2. **Choose your regions**, up to five, as a JSON list. Each has a `key`
   (lowercase letters, digits and `-`, shown to clients), a `label`, and
   either a Ticketmaster `countryCode` (ISO 3166, e.g. `"GB"`) or a `geoPoint`
   [geohash](https://www.movable-type.co.uk/scripts/geohash.html) with a
   `radius` in km:

   ```json
   [{ "key": "uk", "label": "United Kingdom", "countryCode": "GB" },
    { "key": "nyc", "label": "New York", "geoPoint": "dr5ru", "radius": 40 }]
   ```

3. **Give both to the Worker**, as secrets (a `geoPoint` can say roughly where
   you live, so keep it out of `wrangler.local.jsonc` and the repo):

   ```bash
   npx wrangler secret put TICKETMASTER_API_KEY    # paste the consumer key
   npx wrangler secret put CONCERT_REGIONS         # paste the JSON on one line
   ```

   No binding or migration beyond the usual ones is needed (the tables come
   with `npm run migrate:remote`). Locally, put both in `.dev.vars`.
4. **Run the first check** rather than waiting for 01:23 UTC, then look:

   ```bash
   curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER_URL/admin/concert-check"
   curl -s -H "Authorization: Bearer $READ_TOKEN" "$WORKER_URL/api/concerts" | head -c 400
   curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER_URL/admin/concert-artists?unmatched=1"
   ```

   The first answers with what it did (or `skipped` and why); the last lists
   top artists Ticketmaster has no exact match for, to [pin](api.md#admin) if you
   want them. Artists are matched 25 a day, so expect the list to grow over
   the first few days. `{"error":"Not found"}` from `/api/concerts` means the
   key or regions aren't set; `500 Worker
   misconfigured: CONCERT_REGIONS …` means the JSON is malformed.

To turn concerts off again, delete either secret
(`npx wrangler secret delete TICKETMASTER_API_KEY`). The stored rows stay in
D1 and come back if you turn it on again.

**Costs and limits.** The check runs once a day in its own cron invocation, so
it gets a full subrequest budget and fits the Free plan's 50: a few
Ticketmaster calls per region plus the day's artist lookups, well inside
Ticketmaster's quota. Reading `/api/concerts` is one small D1 query.
Ticketmaster's [terms of use](https://developer.ticketmaster.com/support/terms-of-use/)
apply to you as the key's owner. Each event's `url` is Ticketmaster's own page
for it.

## Setting up lyrics

1. **Make an application.** Sign in at <https://developers.spicylyrics.org>,
   open the [dashboard](https://developers.spicylyrics.org/dashboard/applications)
   and create an application. It shows a **secret key** (`sl_sk_…`) once; copy
   it then. Use the secret key, not client access's publishable key
   (`sl_pk_…`): Spicy Lyrics' terms put secret keys "on a server you control"
   and publishable keys in code shipped to users, and a secret key has no
   per-viewer limit (every request comes from the Worker) and can be rotated
   without breaking an installed app. The Worker refuses a publishable key.
2. **Give it to the Worker:**

   ```bash
   npx wrangler secret put SPICY_LYRICS_SECRET_KEY    # paste the sl_sk_… key
   ```

   No `wrangler.jsonc` change, binding or migration is needed: the cache is
   the Workers Cache API. Locally, put `SPICY_LYRICS_SECRET_KEY=sl_sk_…` in
   `.dev.vars`.
3. **Check it** with a read token and any track id:

   ```bash
   curl -s -H "Authorization: Bearer $READ_TOKEN" "$WORKER_URL/api/lyrics?track=4uLU6hMCjMI75M1A2tKUQC" | head -c 300
   curl -sI -H "Authorization: Bearer $READ_TOKEN" "$WORKER_URL/api/lyrics?track=4uLU6hMCjMI75M1A2tKUQC" | grep -i '^x-cache'   # hit the second time
   ```

   `{"error":"Not found"}` means the secret isn't set; `Lyrics upstream: key rejected` means Spicy Lyrics doesn't accept the key.

To turn lyrics off again: `npx wrangler secret delete SPICY_LYRICS_SECRET_KEY`.

**Costs and limits.** Spicy Lyrics is free, with no uptime promise, and sets a
per-application rate limit that its dashboard shows (it can change it at any
time). On the Worker's side each lyrics request is one request, plus one
subrequest to Spicy Lyrics when it isn't cached; no D1 reads or writes. On the
Free plan they count against the 100,000 requests a day the cron shares.

**Spicy Lyrics' [terms](https://developers.spicylyrics.org/terms)** apply to
you as the key's owner. In short: use your own key; serve only your own
clients (don't hand out read tokens or add other people's sites to
`CORS_ORIGINS`); show the provider (`source`), and for `spicy_lyrics` the
uploader and maker from `UploadAttribution`, wherever lyrics show; refetch or
drop anything you store within 30 days (date it from the response's `Age`);
and honour `Retry-After`.
