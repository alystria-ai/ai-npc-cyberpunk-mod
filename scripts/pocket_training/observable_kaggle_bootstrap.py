"""Appended to the verified existing bootstrap by Pocket-ObservableKaggle.py.

This is an isolated execution/logging check. Its smaller batch is not a new
teacher recipe, and its outputs must not replace accepted speech models.
"""

EVENT_LOCK = threading.Lock()
HEARTBEAT_STOP = threading.Event()
PHASE = "bootstrap"
os.environ["PYTHONUNBUFFERED"] = "1"
BOOTSTRAP.mkdir(parents=True, exist_ok=False)
EVENT_FILE = BOOTSTRAP / "events.ndjson"


def event(name, **details):
    record = {"event": name, "utc": datetime.now(timezone.utc).isoformat(),
              "elapsed_seconds": round(time.time() - EXECUTION_STARTED_UNIX, 3),
              "phase": PHASE, "segment_id": BINDINGS["segment_id"], **details}
    line = json.dumps(record, ensure_ascii=True, allow_nan=False)
    with EVENT_LOCK:
        print(line, flush=True)
        with EVENT_FILE.open("a", encoding="utf-8") as stream:
            stream.write(line + "\n")
            stream.flush()
            os.fsync(stream.fileno())


def log(message):
    event("detail", message=clean(message))


def phase(value):
    global PHASE
    PHASE = value
    event("phase_started")


def heartbeat():
    while not HEARTBEAT_STOP.wait(15):
        event("heartbeat", worker_process_alive=True)


def observable_main():
    event("python_started", pid=os.getpid(), python=sys.version.split()[0],
          planned_updates=BINDINGS["probe_steps"], automatic_promotion=False)
    threading.Thread(target=heartbeat, daemon=True).start()
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    SCRATCH.mkdir(exist_ok=False)
    atomic(BOOTSTRAP / "binding.json", BINDINGS)
    phase("verify_and_stage_input")
    stage, descriptor, selection = seed_stager()
    required = set(BINDINGS["selected_members"])
    required.update(name for name in selection["files"]
                    if name.startswith("candidate/scripts/") or name in {
                        "configs/a-teacher.yaml", "fixed-resources.json",
                        "data/train.jsonl", "orchestration/requirements.txt"})
    wanted = {name: selection["files"][name] for name in required}
    atomic(BOOTSTRAP / "payload-staging.json", stage.stage(
        Path("/kaggle/input"), SCRATCH, descriptor, wanted=wanted, stop=stopped))
    fixed = read(SCRATCH / "fixed-resources.json")
    for item in fixed["resources"]:
        if item["role"] not in ("common", "a-initialization"):
            continue
        phase("stage_" + item["role"])
        wanted = {name: value for name, value in item["descriptor"]["required_files"].items()
                  if item["role"] == "a-initialization" or
                  name.startswith("pocket-source/") or name == "models/tokenizer.json"}
        atomic(BOOTSTRAP / (item["role"] + ".json"), stage.stage(
            Path("/kaggle/input"), SCRATCH, item["descriptor"], wanted=wanted, stop=stopped))
    atomic(SCRATCH / "probe-selection.json", {"rows": BINDINGS["selected_rows"],
        "source_manifest_sha256": selection["files"]["data/train.jsonl"]["sha256"],
        "anchor_sha256": "ce80dd672670de6b0b2aa658023db7699b1782ecff8d8a66cf1f1ec15c803fbc",
        "payload_anchor_sha256": BINDINGS["payload"]["anchor_sha256"]})
    phase("install_dependencies")
    if run_logged([sys.executable, "-u", "-m", "pip", "install", "--no-input",
                   "--disable-pip-version-check", "--progress-bar", "off", "-r",
                   str(SCRATCH / "orchestration/requirements.txt")], "install"):
        raise RuntimeError("Dependency installation failed")
    worker = SCRATCH / "observable_probe_worker.py"
    worker.write_text(BINDINGS["worker_source"], encoding="utf-8")
    if sha(worker) != BINDINGS["worker_sha256"]:
        raise ValueError("Probe worker changed during staging")
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
        HF_HUB_DISABLE_TELEMETRY="1", TOKENIZERS_PARALLELISM="false",
        PYTHONDONTWRITEBYTECODE="1", OMP_NUM_THREADS="2")
    phase("train_100_update_probe")
    code = run_logged([sys.executable, "-u", str(worker), "--root", str(SCRATCH),
                       "--output", str(OUTPUT), "--steps", str(BINDINGS["probe_steps"])], "worker")
    event("worker_exited", returncode=code)
    if code:
        raise RuntimeError("Probe failed; preserve its logs and any finished checkpoints")
    phase("publish_output_inventory")
    files = {str(path.relative_to(Path('/kaggle/working'))).replace('\\', '/'):
             {"bytes": path.stat().st_size, "sha256": sha(path)}
             for path in sorted(OUTPUT.rglob('*')) if path.is_file()}
    atomic(Path("/kaggle/working/probe-collection.json"), {
        "schema": "pocket_observable_probe_v1", "segment_id": BINDINGS["segment_id"],
        "status": "completed", "files": files, "automatic_promotion": False,
        "scope": "100 diagnostic updates; not a qualified continuation teacher"})
    event("probe_completed", saved_files=len(files))


try:
    observable_main()
except BaseException as error:
    event("failed", error_type=type(error).__name__, message=clean(error))
    atomic(BOOTSTRAP / "failure.json", {"type": type(error).__name__, "message": clean(error)})
    raise
finally:
    HEARTBEAT_STOP.set()
