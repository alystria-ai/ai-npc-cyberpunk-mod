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


def subset_name(name):
    if (not isinstance(name, str) or not name or name.startswith("/") or "\\" in name
            or ":" in name or any(piece in ("", ".", "..") for piece in name.split("/"))):
        raise ValueError("Unsafe selected resource member")
    return name


def subset_unlinked(path, mount):
    mount = mount.resolve()
    current = path
    while current != mount:
        if current.is_symlink():
            raise ValueError("Selected resource traverses a symbolic link")
        current = current.parent
        if current == current.parent:
            raise ValueError("Selected resource lies outside mounted input")
    if not path.resolve().is_relative_to(mount):
        raise ValueError("Selected resource escapes mounted input")


def subset_source(descriptor):
    """Find one named ZIP or one anchor-qualified extracted root; no ZIP hash."""
    mount = Path("/kaggle/input")
    archive_name = subset_name(descriptor["archive_name"])
    if "/" in archive_name:
        raise ValueError("Expected an archive filename, not a path")
    archives = [path for path in mount.rglob(archive_name) if path.is_file() or path.is_symlink()]
    if archives:
        if len(archives) != 1:
            raise ValueError("Ambiguous selected resource archive")
        subset_unlinked(archives[0], mount)
        return "zip", archives[0]
    anchor = subset_name(descriptor["anchor"])
    parts = anchor.split("/")
    roots = []
    for path in mount.rglob(parts[-1]):
        if stopped():
            raise InterruptedError("Selected resource discovery stopped")
        if not path.is_file() or path.is_symlink():
            continue
        candidate = path
        for _ in parts:
            candidate = candidate.parent
        if candidate.joinpath(*parts) != path:
            continue
        subset_unlinked(path, mount)
        if sha(path) == descriptor["anchor_sha256"]:
            roots.append(candidate)
    if len(roots) != 1:
        raise ValueError("Expected one extracted root with the pinned selection anchor")
    return "extracted", roots[0]


def subset_entries(bundle, names):
    """Inspect ZIP directory records; reject duplicates/symlinks for used names."""
    found = {}
    for item in bundle.infolist():
        if item.filename not in names:
            continue
        name = subset_name(item.filename)
        if name in found or item.is_dir() or ((item.external_attr >> 16) & 0o170000) == 0o120000:
            raise ValueError("Duplicate, directory, or symbolic-link selected ZIP member: " + name)
        found[name] = item
    if set(found) != names:
        raise ValueError("Selected ZIP member inventory is incomplete")
    return found


def subset_anchor(descriptor, mode, source):
    name = subset_name(descriptor["anchor"])
    if mode == "zip":
        with zipfile.ZipFile(source) as bundle:
            info = subset_entries(bundle, {name})[name]
            if info.file_size > 128 * 1024 * 1024:
                raise ValueError("Selection anchor exceeds the bounded metadata size")
            with bundle.open(info) as stream:
                contents = stream.read(128 * 1024 * 1024 + 1)
    else:
        path = source.joinpath(*name.split("/"))
        subset_unlinked(path, Path("/kaggle/input"))
        if not path.is_file() or path.stat().st_size > 128 * 1024 * 1024:
            raise ValueError("Extracted selection anchor is missing or oversized")
        contents = path.read_bytes()
    if hashlib.sha256(contents).hexdigest() != descriptor["anchor_sha256"]:
        raise ValueError("Selection anchor differs from pinned descriptor")
    event("subset_anchor_verified", role=descriptor["label"], anchor=name,
          anchor_bytes=len(contents), anchor_sha256=descriptor["anchor_sha256"],
          transport_archive_sha256_checked=False)
    return contents


def stage_subset(descriptor, wanted, *, source=None):
    """Copy only authenticated selected members and hash bytes while copying."""
    mount = Path("/kaggle/input")
    mode, origin = source or subset_source(descriptor)
    total = 0
    for name, expected in wanted.items():
        subset_name(name)
        if (not isinstance(expected, dict) or not isinstance(expected.get("bytes"), int)
                or expected["bytes"] < 0 or not re.fullmatch(r"[0-9a-f]{64}", expected.get("sha256", ""))):
            raise ValueError("Selected member lacks its pinned byte size and SHA-256: " + name)
        total += expected["bytes"]
    report = {"label": descriptor["label"], "mode": mode,
              "transport_archive_sha256_checked": False,
              "transport_archive_sha256_expected": descriptor.get("archive_sha256"),
              "anchor_sha256_verified": descriptor["anchor_sha256"],
              "files_verified": 0, "bytes_copied": 0, "selected_expected_bytes": total,
              "selected_member_hashes_checked": True}
    if mode == "zip":
        report["archive_name"] = origin.name
        report["archive_bytes_observed"] = origin.stat().st_size
        bundle = zipfile.ZipFile(origin)
        entries = subset_entries(bundle, set(wanted))
    else:
        bundle = None
        entries = {}
        report["extracted_root"] = origin.relative_to(mount).as_posix()
    try:
        for name, expected in sorted(wanted.items()):
            if stopped():
                raise InterruptedError("Selected member staging stopped")
            destination = SCRATCH.joinpath(*name.split("/"))
            if destination.is_symlink() or not destination.resolve().is_relative_to(SCRATCH.resolve()):
                raise ValueError("Selected member destination escapes scratch")
            if destination.exists():
                raise ValueError("Selected member destination already exists: " + name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name(destination.name + ".staging")
            if temporary.exists() or temporary.is_symlink():
                raise ValueError("Selected member temporary destination already exists")
            if mode == "zip":
                if entries[name].file_size != expected["bytes"]:
                    raise ValueError("Selected ZIP member size differs: " + name)
                incoming = bundle.open(entries[name])
            else:
                source_file = origin.joinpath(*name.split("/"))
                subset_unlinked(source_file, mount)
                if not source_file.is_file() or source_file.stat().st_size != expected["bytes"]:
                    raise ValueError("Selected extracted member missing or size differs: " + name)
                incoming = source_file.open("rb")
            digest = hashlib.sha256()
            size = 0
            try:
                with incoming, temporary.open("xb") as outgoing:
                    while True:
                        if stopped():
                            raise InterruptedError("Selected member copy stopped")
                        block = incoming.read(1024 * 1024)
                        if not block:
                            break
                        size += len(block)
                        if size > expected["bytes"]:
                            raise ValueError("Selected member exceeds pinned size: " + name)
                        digest.update(block)
                        outgoing.write(block)
                    outgoing.flush()
                    os.fsync(outgoing.fileno())
                if size != expected["bytes"] or digest.hexdigest() != expected["sha256"]:
                    raise ValueError("Selected member content differs: " + name)
                temporary.replace(destination)
            finally:
                temporary.unlink(missing_ok=True)
            report["files_verified"] += 1
            report["bytes_copied"] += size
            event("subset_member_verified", role=descriptor["label"], member=name,
                  bytes=size, files_verified=report["files_verified"],
                  files_total=len(wanted), bytes_copied=report["bytes_copied"],
                  bytes_total=total)
    finally:
        if bundle is not None:
            bundle.close()
    return report


def observable_main():
    event("python_started", pid=os.getpid(), python=sys.version.split()[0],
          planned_updates=BINDINGS["probe_steps"], automatic_promotion=False)
    threading.Thread(target=heartbeat, daemon=True).start()
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    SCRATCH.mkdir(exist_ok=False)
    atomic(BOOTSTRAP / "binding.json", BINDINGS)
    if BINDINGS.get("remote_checkpoint_source") and not os.environ.get("HF_TOKEN"):
        raise RuntimeError("Private checkpoint upload credential is missing")
    phase("verify_and_stage_input")
    descriptor = {"label": "full-a-input", **BINDINGS["payload"]}
    source = subset_source(descriptor)
    selection = json.loads(subset_anchor(descriptor, *source))
    if selection.get("schema") != "full_a_continuation_payload_v1" or selection.get("role") != "full-a-input":
        raise ValueError("Wrong pinned full-A selection schema")
    required = set(BINDINGS["selected_members"])
    required.update(name for name in selection["files"]
                    if name.startswith("candidate/scripts/") or name in {
                        "configs/a-teacher.yaml", "fixed-resources.json",
                        "data/train.jsonl", "orchestration/requirements.txt"})
    wanted = {name: selection["files"][name] for name in required}
    atomic(BOOTSTRAP / "payload-staging.json", stage_subset(descriptor, wanted, source=source))
    fixed = read(SCRATCH / "fixed-resources.json")
    for item in fixed["resources"]:
        if item["role"] not in ("common", "a-initialization"):
            continue
        phase("stage_" + item["role"])
        wanted = {name: value for name, value in item["descriptor"]["required_files"].items()
                  if item["role"] == "a-initialization" or
                  name.startswith("pocket-source/") or name == "models/tokenizer.json"}
        resource = subset_source(item["descriptor"])
        subset_anchor(item["descriptor"], *resource)
        atomic(BOOTSTRAP / (item["role"] + ".json"), stage_subset(
            item["descriptor"], wanted, source=resource))
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
    if BINDINGS.get("remote_checkpoint_source"):
        uploader = SCRATCH / "remote_checkpoints.py"
        uploader.write_text(BINDINGS["remote_checkpoint_source"], encoding="utf-8")
        if sha(uploader) != BINDINGS["remote_checkpoint_sha256"]:
            raise ValueError("Remote checkpoint helper changed during staging")
        atomic(SCRATCH / "remote-checkpoint-config.json", {"run_id": BINDINGS["segment_id"]})
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
