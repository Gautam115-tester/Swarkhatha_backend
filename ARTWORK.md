# Centralized artwork: ONE ALBUM = ONE IMAGE, ONE SERIES = ONE IMAGE

## Model

| Entity | Identity | Owns artwork? |
|---|---|---|
| `albums` | normalized name **+ release year** (`name_key`, `release_year`) | yes: `cover_image_url`, `image_storage_account_id/file_id/hash` |
| `media_items` (music) | `album_id` | no, reads it through `album_id` |
| `story_series` | normalized title, the text before ` Ep ` (`title_key`) | yes, same columns |
| `media_items` (story) | `story_series_id` | no, reads it through `story_series_id` |

`media_items.cover_image_url` still exists only as a mirror for older app builds. The API resolves
artwork through the parent on every read (`GET /api/media`, `/stories/:id/episodes`,
`/continue-listening`, `/api/follows`), so a stale mirror can never show a different image.

## Root causes that were fixed

1. **Duplicate uploads.** The admin app uploaded cover art to Drime *before* asking whether the album
   already had one. The single-track screen did it for every track; the batch screen only de-duplicated
   within one session. The backend ignored the extra image (first cover wins) and never deleted it.
2. **Wrong album identity.** Albums were `unique(name, artist)`: no year (Love Aaj Kal 2009 vs 2020 were
   indistinguishable), one album credited to several artists split into several rows (each with its own
   image), and `NULL` artists were never deduplicated. Find-then-insert and `track_count + 1` were racy.
3. **Listener grouped albums by title only**, so same-named albums from different years merged, and
   each surface picked its own cover (notification: the track's copy; UI: the "most common" copy).
4. **Stale snapshots**: follows stored a cover URL at follow time; counters never decreased on delete.

## Upload flow (new admin builds)

```
POST /api/media/albums/resolve   {name, artist, releaseYear}  -> album (+ hasArtwork)
PUT  /api/media/albums/:id/artwork   (multipart image)         -> stored ONLY if the album still has none
POST /api/media                  {albumId, ...track fields}
```
Series: `POST /stories/resolve {title}`, `PUT /stories/:id/artwork` (admin-picked; replaces the single
image and deletes the old file once unreferenced), then `POST /api/media {storySeriesId, ...}`.

Safety layers (so duplicates are impossible, not just unlikely):
- per-identity in-process lock + unique indexes (`migration_centralized_artwork.sql`);
- artwork upload and the "has artwork?" check happen under one per-album lock; DB write is a
  compare-and-set (`cover_image_url is null`); a lost race deletes the just-uploaded file;
- `lib/coverImageStorage.js` stores byte-identical images once (concurrent + repeat uploads);
- older admin builds that still upload per track: the redundant file is deleted if nothing references it.

## Deploying (in this order)

1. Deploy the backend code (works with the old schema until step 2; old admin builds keep working).
2. Run `supabase/migration_centralized_artwork.sql` (adds columns/indexes only, no destructive statements).
   It prints a NOTICE if duplicate rows block a unique index; that is expected on existing data.
3. `node scripts/consolidate-artwork.js` (**dry run**; read the output), then
   `node scripts/consolidate-artwork.js --confirm`.
   - merges albums with the same name **and** same year (never across different years), merges series by title;
   - gives albums/series that lost their image the most common one their tracks still have;
   - points every track/episode/follow at the parent image;
   - deletes only Drime files that nothing references, older than `--min-age-minutes` (default 30), each
     re-verified against the database right before deletion.
4. Re-run `migration_centralized_artwork.sql` so the unique indexes get created. Restart the backend.
5. Ship the new admin and listener apps.

### Existing albums have no release year
Rows created before this change have `release_year = null`. The script merges only rows whose name AND
(unknown) year match. If you know two same-named legacy albums are different releases, set the year
first so they are never merged:
`PATCH /api/media/albums/:id {"releaseYear": 2009}` (returns 409 instead of merging if the name+year is taken).
New uploads take the year from the file's `date`/`year` tag automatically.

## Tests
`node --test test/artwork.test.js test/coverImageStorage.test.js test/consolidate-artwork.test.js`
(`subscriptions.routes.test.js` needs `nodemailer` installed; unrelated to this change).
