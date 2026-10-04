"""Observable adapter around the frozen full-A bootstrap; no recipe replacement."""
LIVE_LOCK = threading.Lock()
LIVE_STOP = threading.Event()
LIVE_PHASE = "python_startup"
LIVE_FILE = Path("/kaggle/working/full-live-events.ndjson")
_original_run_logged = run_logged
_original_progress_watch = progress_watch


def live_event(kind, **fields):
    record = {"event": kind, "utc": datetime.now(timezone.utc).isoformat(),
              "elapsed_seconds": round(time.time()-EXECUTION_STARTED_UNIX, 3),
              "phase": LIVE_PHASE, "segment_id": BINDINGS["segment_id"], **fields}
    line = json.dumps(record, allow_nan=False)
    with LIVE_LOCK:
        print(line, flush=True)
        with LIVE_FILE.open("a", encoding="utf-8") as stream:
            stream.write(line + "\n")
            stream.flush()
            os.fsync(stream.fileno())


def log(message):
    global LIVE_PHASE
    LIVE_PHASE = clean(message)
    live_event("phase", message=LIVE_PHASE)


def heartbeat():
    while not LIVE_STOP.wait(15):
        live_event("heartbeat", python_process_alive=True)


def progress_watch(raw, seen):
    _original_progress_watch(raw, seen)
    state = read(OUTPUT / "state.json", {})
    name = state.get("last_log")
    if name:
        path = relative(OUTPUT, name)
        if path.is_file():
            cursor = seen.setdefault("log_offsets", {}).get(name, 0)
            with path.open("rb") as stream:
                stream.seek(cursor)
                content = stream.read(256 * 1024)
                end = content.rfind(b"\n")
                if end >= 0:
                    for line in content[:end].decode("utf-8", errors="replace").splitlines():
                        print(clean(line), flush=True)
                    seen["log_offsets"][name] = cursor + end + 1


def run_logged(command, name, raw=None):
    if name == "install":
        command = list(command) + ["huggingface_hub==1.33.0"]
    if name == "runner":
        changes = []
        for item in BINDINGS["source_overlays"]:
            path = relative(SCRATCH, item["path"])
            if item.get("before_sha256"):
                if sha(path) != item["before_sha256"]:
                    raise ValueError("Frozen pre-overlay source differs: " + item["path"])
            elif path.exists():
                raise ValueError("New helper unexpectedly already exists")
            text = item["source"]
            if hashlib.sha256(text.encode()).hexdigest() != item["sha256"]:
                raise ValueError("Bound overlay bytes differ")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            if sha(path) != item["sha256"]:
                raise ValueError("Installed overlay content differs")
            changes.append({key: value for key, value in item.items() if key != "source"})
        atomic(BOOTSTRAP / "source-overlays.json", changes)
        raw["gpu_budget_seconds"] = BINDINGS["teacher_lifetime_budget_seconds"]
        # One original Judy recording is 32.51 s, but its sole aligned target
        # is 13.51 s. Admit the unchanged source; the target window stays 30 s.
        raw["max_utterance_seconds"] = 33
        raw["log_freq"] = 1
        raw["private_remote_checkpoints"] = True
        raw["remote_checkpoint_run_id"] = BINDINGS["remote_checkpoint_run_id"]
        raw["remote_checkpoint_max_keep"] = 3
        path = SCRATCH / (BINDINGS["role"] + "-execution-spec.json")
        atomic(path, raw)
        atomic(BOOTSTRAP / "execution-spec.json", raw)
        live_event("full_recipe_ready", train_rows=8140, effective_batch=64, gpus=2,
                   planned_updates=raw["teacher_max_steps"], learning_rate=raw["teacher_learning_rate"],
                   warmup_updates=raw["teacher_warmup_steps"], diagnostic_subset=False,
                   checkpoint_max_keep=3, checkpoint_storage="private_bucket")
    return _original_run_logged(command, name, raw)


os.environ["PYTHONUNBUFFERED"] = "1"
live_event("python_started", planned_role="teacher", diagnostic_subset=False)
threading.Thread(target=heartbeat, daemon=True).start()
try:
    full_original_main()
except BaseException as error:
    live_event("failure", type=type(error).__name__, message=clean(error))
    raise
finally:
    LIVE_STOP.set()
