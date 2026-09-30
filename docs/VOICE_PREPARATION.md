# Prepare OmniVoice when its setting changes

Selecting **OmniVoice + Convai** in Companion Manager starts loading and warming
the shared model before Apply, a new invitation or a conversation. Apply saves
the voice choice; an already accepted reply keeps its original provider and
quality until it finishes. Revert or leaving the unsaved Settings page cancels
preparation that exists only for that preview. An applied Omni selection keeps
the model resident as before.

## MCM signal

The installed MCM v2 API provides `subscribe('drafts.changed', ...)`, `getValue`
and `hasDrafts`. Its callback only marks work pending. The top-level mod update
reads the effective voice/quality drafts and publishes a bounded request in
`runtime/voice-preview.json`; it never writes `settings.json` before Apply.
No native framework files are patched.

The version 1 record includes an opaque per-menu owner, monotonic sequence,
active flag, provider, steps and update time. Every change/cancel advances the
sequence, including same-second toggles. The active lease refreshes once per
second. It cancels on Apply, Revert, loss of the owned Settings page, reset and
shutdown. All ink text changes stay outside native callbacks, preserving the
stack-safe MCM styling path. Only the owned Voice service value is refreshed;
the draft controls are not rebuilt.

## Bridge behavior

`VoicePreviewLease` accepts only valid, bounded records up to 4 seconds old,
with at most 1.5 seconds of future clock skew. A transient missing or partial
read retains the previously admitted lease until its original expiry. Stale
sequences and foreign-owner cancellations cannot revoke a newer preview.

The bridge reads preview state before committed settings. MCM saves settings
before withdrawing its Apply preview, so this order cannot combine a completed
Apply cancellation with a pre-Apply saved choice and throw away a warm model.

`VoiceSelection` separates model residency from committed routing. A draft or
pending applied Omni choice can start preparation during a remote reply, while
`usesProfile` and the current step setting retain the active reply's contract.
Apply reuses the prepared worker. Unsaved cancellation retires a preview-only
worker; applying Convai waits for a current local reply to finish. Replacement
workers wait for confirmed retirement, including rapid toggles and cancellation
during CUDA initialization. Unconfirmed exits still block replacements.

Status distinguishes an unsaved ready model from an applied switch waiting for
the current reply. Preview expiry also releases a model after an unexpected
menu/game disappearance. The existing worker warmup prepares all three local
voice references; generation steps remain 16/32 and precision remains FP16.

## Verification

82 focused checks pass, with no skips, including the actual installed MCM API,
draft publication/cancellation, same-second sequence ordering, expired and
malformed files, startup with a saved Convai choice, early preparation while
remote speech owns the route, Apply reuse, Revert release and single-worker
ownership. The compiled native menu is unchanged. Real selector/GPU warmup
and the prepared gaze controls are the next combined live check.

Receipt: ignored `runtime/voice-preview-integration-tests-20261001.log`.
