'use strict';

/**
 * The only thing the rest of the app needs to know about classification: call
 * enqueueNewMusic(id) after a music row has been successfully inserted.
 *
 * Contract (the upload API depends on it): synchronous return of a promise that
 * NEVER rejects and never waits on a provider -- it only inserts one row into the
 * jobs table. If that fails (database hiccup, migration not applied yet) the upload
 * is unaffected; the track simply has no classification metadata, so the historical
 * backfill discovers it later.
 *
 * CLASSIFICATION_ENABLED=off turns the whole system off (and routes/media.js falls
 * back to the previous Groq auto-categorizer for music).
 */
const isEnabled = () => !/^(0|false|off|no)$/i.test(String(process.env.CLASSIFICATION_ENABLED || 'on'));

function enqueueNewMusic(musicId) {
  if (!isEnabled()) return Promise.resolve({ created: false, disabled: true });
  try {
    return require('./service').getService().enqueueForUpload(musicId).catch((e) => ({ created: false, error: e.message }));
  } catch (e) {
    console.error('[classification] could not enqueue', musicId, e.message);
    return Promise.resolve({ created: false, error: e.message });
  }
}

module.exports = { enqueueNewMusic, isEnabled };
