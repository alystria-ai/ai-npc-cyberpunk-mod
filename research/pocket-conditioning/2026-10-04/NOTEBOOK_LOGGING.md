# Notebook progress output

Future training notebooks should show concise progress in their main stdout stream while keeping detailed worker logs in saved output. Accepted notebooks must not be restarted solely to improve logging.

`notebook_stdout_logging.py` adds this behavior to the existing source-bound independent pilot templates. It rebuilds the controller overlay from its exact original bytes, updates the derived hash, and parses the resulting Python. It does not submit a job, upload data, load weights, or change training math.

```powershell
python research/pocket-conditioning/2026-10-04/notebook_stdout_logging.py --training-dir runtime/voice-data-expansion-20261003/current-parent-audit/training
```

The command creates `future-logged-notebooks/` beneath that training directory. Future launch generators should call `add_logging(template, driver_path)` before final source/approval binding; both current independent launch generators do so. Do not copy the generated template over an accepted job.

Messages cover:

- Input staging, dependency setup and codec/cache preparation.
- Training start and observed optimizer steps, with loss, measured seconds per update and a range for remaining optimizer work. Audio generation and checkpoint I/O are excluded from that estimate.
- Checkpoints confirmed by the runner's saved state, completed diagnostic panels and durable output collection.
- Completion only after the controller and final checkpoint step agree with the planned count.
- A sanitized traceback and a nonzero exit on failure, with exit code 130 for keyboard interruption. Credentials and environment dumps are not logged.

Step totals come from each arm's `teacher_max_steps`; they are not fixed in the progress messages. The pilot driver itself still enforces its separately approved pilot recipe.

The messages use `print(..., flush=True)` in the main notebook process rather than only the redirected worker file. Kaggle's output API has reliably exposed this notebook log after publication. Live availability depends on the provider; the template does not claim that a running notebook's log can always be fetched.

Verification for this change was limited to exact overlay reconstruction and Python parsing. Cloud behavior will be checked on the next authorized run; existing A/B/C source and results remain unchanged.
