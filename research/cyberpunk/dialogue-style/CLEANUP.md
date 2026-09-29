# Disposable-profile cleanup

Run receipt hash: a3f0bd7590131a71.

All 10 disposable profiles were removed, with fresh list verification after each deletion. At most one was alive at a time. 37 text turns were dispatched; 36 completed replies are included in the comparison.

The first eight responses were complete when the operator changed the synthetic-user reuse policy. One in-flight send was abandoned with no recorded response; it was excluded without inspecting or selecting its output. The operator explicitly authorized one replacement send (37 total cap) in a fresh two-turn session. No ambiguous Core create/update/delete was retried. Five synthetic end-user IDs had been allocated before the stop; all remaining exchanges reused the first durable synthetic ID. All three pre-stop disposable profiles were verified absent before continuing.

All profiles had memory_settings.enabled read back as false before any conversation. Each two-turn exchange used a fresh session. No production profile, real end-user ID, game state, microphone, local voice model or installed bridge was changed. Provider-side temporary analytics/end-user records may remain; no verified account-deletion endpoint was invoked. Recovery receipts and raw remote IDs are kept only in ignored .private storage.
