"""Observable adapter around the frozen full-A bootstrap; no recipe replacement."""
LIVE_LOCK = threading.Lock()
LIVE_STOP = threading.Event()
LIVE_PHASE = "python_startup"
LIVE_FILE = Path("/kaggle/working/full-live-events.ndjson")
LIVE_STAGE = "teacher" if BINDINGS["role"] == "teacher" else "distill"
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


def import_bucket_teacher():
    """Student only: fetch the selected teacher candidate and export it.

    A stopped teacher run has no completed Kaggle output to mount, so the
    selected compact candidate comes from the private checkpoint bucket.
    Returns the import_teacher_* fields the student recipe leaves empty.
    """
    selected = BINDINGS["bucket_teacher"]
    root = SCRATCH / "teacher-results/teacher"
    checkpoint = root / "candidates" / PurePosixPath(selected["path_in_bucket"]).name
    result = BOOTSTRAP / "selected-teacher-export.json"
    log("Fetching the selected teacher from the private checkpoint bucket and exporting it")
    command = [sys.executable, str(SCRATCH / "candidate/scripts/pocket_training/selected_teacher_export.py"),
        "--download", "--bucket-path", selected["path_in_bucket"], "--expected-bytes", str(selected["bytes"]),
        "--source", str(SCRATCH / "pocket-source"), "--config", str(SCRATCH / selected["architecture_config"]),
        "--assets-root", str(SCRATCH), "--tokenizer", str(SCRATCH / "models/tokenizer.json"),
        "--checkpoint", str(checkpoint), "--export-dir", str(root / "export"),
        "--expected-step", str(selected["step"]), "--expected-weights", selected["weights"],
        "--expected-input-identity", selected["input_identity"],
        "--selection-basis", selected["selection_basis"], "--result", str(result)]
    # A transfer can die without a traceback; each attempt is a new process
    # and a completed download is reused.
    for attempt in range(1, 4):
        code = _original_run_logged(command, f"teacher-import-{attempt}")
        if code == 0:
            break
        live_event("selected_teacher_attempt_failed", attempt=attempt, returncode=code)
    else:
        raise RuntimeError("Selected teacher download/export failed three times")
    exported = read(result)
    live_event("selected_teacher_ready", step=exported["step"], weights=exported["weights"],
               model_bytes=exported["model_bytes"], path_in_bucket=selected["path_in_bucket"])
    return {"import_teacher_checkpoint": checkpoint.relative_to(SCRATCH).as_posix(),
            "import_teacher_weight_kind": exported["weights"],
            "import_teacher_expected_sha256": exported["model_sha256"],
            "import_teacher_expected_checkpoint_sha256": exported["checkpoint_sha256"],
            "import_teacher_expected_input_identity": exported["input_identity"],
            "import_teacher_expected_step": exported["step"]}


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
        if BINDINGS["role"] == "student":
            raw.update(import_bucket_teacher())
            raw["gpu_budget_seconds"] = BINDINGS["available_execution_seconds"]
        else:
            raw["gpu_budget_seconds"] = BINDINGS["teacher_lifetime_budget_seconds"]
        # One original Judy recording is 32.51 s, but its sole aligned target
        # is 13.51 s. Admit the unchanged source; the target window stays 30 s.
        raw["max_utterance_seconds"] = 33
        # The end-of-session save writes and uploads a ~5 GB resumable state.
        # The runner's 300 s default can lose up to 1000 updates at Kaggle's
        # hard stop; give the save ample time. Not part of the run identity.
        raw["checkpoint_reserve_seconds"] = 1800
        # Saving ~5 GB every 10 minutes buys nothing: a crashed worker ends the
        # session as failed (not resumable from its output). The 1000-update
        # saves publish to the bucket and the end-of-session save remains.
        raw["checkpoint_seconds"] = 43200
        raw["log_freq"] = 1
        raw["private_remote_checkpoints"] = True
        raw["remote_checkpoint_run_id"] = BINDINGS["remote_checkpoint_run_id"]
        raw["remote_checkpoint_max_keep"] = 3
        # Launcher-declared recipe changes (the student's stopping rule).
        raw.update(BINDINGS.get("recipe_overrides", {}))
        path = SCRATCH / (BINDINGS["role"] + "-execution-spec.json")
        atomic(path, raw)
        atomic(BOOTSTRAP / "execution-spec.json", raw)
        live_event("full_recipe_ready", role=BINDINGS["role"], train_rows=8140, effective_batch=64, gpus=2,
                   planned_updates=raw[LIVE_STAGE + "_max_steps"], learning_rate=raw[LIVE_STAGE + "_learning_rate"],
                   warmup_updates=raw[LIVE_STAGE + "_warmup_steps"], diagnostic_subset=False,
                   checkpoint_max_keep=3, checkpoint_storage="private_bucket",
                   recipe_overrides=sorted(BINDINGS.get("recipe_overrides", {})))
    return _original_run_logged(command, name, raw)


os.environ["PYTHONUNBUFFERED"] = "1"
live_event("python_started", planned_role=BINDINGS["role"], diagnostic_subset=False)
threading.Thread(target=heartbeat, daemon=True).start()
try:
    full_original_main()
except BaseException as error:
    live_event("failure", type=type(error).__name__, message=clean(error))
    raise
finally:
    LIVE_STOP.set()
