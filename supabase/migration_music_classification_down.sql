-- Removes everything added by migration_music_classification.sql.
-- Destroys all classification results (labels, jobs, metadata, caches). It does NOT
-- touch media_items, content_labels, albums or any other pre-existing table, so the
-- app keeps working with its legacy category / content_label_id values.
drop function if exists classification_stats();
drop function if exists classification_record_provider_call(text, text, text);
drop function if exists classification_backfill_candidates(uuid, int, text[], int);
drop function if exists classification_recover_stale(int);
drop function if exists classification_claim_jobs(int, text);
drop table if exists music_classification_backfill;
drop table if exists music_provider_stats;
drop table if exists music_provider_cache;
drop table if exists music_classification_sources;
drop table if exists music_classification_metadata;
drop table if exists music_classification_jobs;
drop table if exists music_track_labels;
drop table if exists music_labels;
