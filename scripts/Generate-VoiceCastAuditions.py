"""Plan isolated all-cast auditions; --generate explicitly runs one GPU worker.

Source qualification is not listening approval. This helper never writes the
production local-voices config, promotion flags, game files or Convai memory.
All references and generated WAVs remain unprocessed. Results are integration
auditions under current conditions, never hardware/latency benchmark results.
"""
from pathlib import Path
from contextlib import contextmanager
import argparse
import base64
import copy
import hashlib
import importlib.util
import io
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import wave

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('audition_preparation', ROOT / 'scripts/Prepare-LocalVoices.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)
validation = prepare.validation
MAX_PROFILES = 79
MAX_FRAME_BYTES = 32 * 1024 * 1024
AUDITION_TEXT = "Good to see you. Let's take this one step at a time."
WARNING = 'Source-qualified audition only; no listening approval or promotion. Timings are not benchmark results.'


class Cancelled(RuntimeError):
    pass


def digest(path):
    hasher = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            hasher.update(block)
    return hasher.hexdigest()


def runtime_path(root, value, prefix, *, must_exist=False):
    root = root.resolve()
    path = Path(value)
    path = path if path.is_absolute() else root / path
    try:
        relative = path.relative_to(root).as_posix()
    except ValueError as error:
        raise ValueError('Audition paths must stay inside the project') from error
    if not relative.startswith(prefix + '/') or any(part in ('', '.', '..') for part in relative.split('/')):
        raise ValueError('Audition path is outside its owned directory')
    if must_exist:
        return validation.contained_file(root, relative, prefix)
    current = root
    for part in Path(relative).parts:
        current /= part
        attributes = getattr(current.lstat(), 'st_file_attributes', 0) if current.exists() else 0
        if current.is_symlink() or attributes & 0x400:
            raise ValueError('Linked audition paths are not supported')
    if not path.resolve().is_relative_to(root / prefix):
        raise ValueError('Audition path escaped its owned directory')
    return path


def selected_candidate(profile):
    candidates = profile.get('candidates')
    if not isinstance(candidates, list) or len(candidates) > 6:
        raise ValueError('Invalid bounded candidate list')
    candidates = [item for item in candidates if isinstance(item, dict) and item.get('sourceVerified') is True and not item.get('errors')]
    provisional = profile.get('provisional', {})
    if not isinstance(provisional, dict):
        raise ValueError('Invalid provisional selection')
    primary = provisional.get('primary')
    if primary:
        matches = [item for item in candidates if item.get('reference') == primary]
        if len(matches) != 1:
            raise ValueError('Provisional primary is not an exact verified candidate')
        return matches[0], 'Provisional primary from the reviewed lane; not a listening verdict.'
    if not candidates:
        raise ValueError('No source-qualified original reference')
    # Missing lane ranking is explicit. Choose one technically suitable original
    # for audition, never invent approval or borrow another character's voice.
    candidates.sort(key=lambda item: (abs(float(item.get('pcm', {}).get('durationSeconds', 0)) - 6), item.get('reference', '')))
    return candidates[0], 'Deterministic technical audition choice; no primary/listening approval was supplied.'


def qualify_source(root, key, candidate, inventory, index_hashes):
    source = runtime_path(root, candidate.get('reference', ''), 'runtime/voice-cast', must_exist=True)
    if not 44 <= source.stat().st_size <= validation.MAX_REFERENCE_BYTES:
        raise ValueError('Original WAV exceeded supported byte limits')
    if digest(source) != candidate.get('sha256'):
        raise ValueError('Original WAV hash changed')
    receipt_path = runtime_path(root, source.with_name('receipt.json'), 'runtime/voice-cast', must_exist=True)
    if digest(receipt_path) != candidate.get('receiptSha256'):
        raise ValueError('Immutable source receipt hash changed')
    receipt = prepare.read_json(receipt_path)
    if (receipt.get('key') != key or receipt.get('reference') != candidate['reference']
            or receipt.get('sha256') != candidate.get('sha256') or receipt.get('transcript') != candidate.get('transcript')
            or receipt.get('transcriptSha256') != candidate.get('transcriptSha256')
            or receipt.get('status') != 'decoded_verified' or receipt.get('attributionVerified') is not True
            or receipt.get('transcriptAgreement') is not True):
        raise ValueError('Aggregate and immutable native source receipt disagree')
    proof = receipt.get('provenance', {})
    quality = proof.get('quality', {})
    duration = quality.get('durationSeconds')
    if (quality.get('nonSilent') is not True or quality.get('clippedSamples') != 0
            or quality.get('originalPcm') is not True or not isinstance(duration, (int, float))
            or not 3 <= duration <= 12 or len(receipt['transcript'].split()) < 5
            or quality.get('rejected') is True or quality.get('overlap') is True):
        raise ValueError('Original reference did not pass the bounded source-quality gates')
    descriptor = {name: receipt[name] for name in ('reference', 'sha256', 'transcript', 'transcriptSha256')}
    # Candidate WAVs live in their lane; the worker uses the later unchanged copy
    # under voice-references. Verify the same bytes through a temporary descriptor
    # without creating files or altering any promotion/listening flag.
    with wave.open(str(source), 'rb') as wav:
        if (wav.getnchannels(), wav.getframerate(), wav.getsampwidth() * 8, wav.getnframes()) != (
                quality['channels'], quality['sampleRate'], quality['bitsPerSample'], quality['frames']):
            raise ValueError('Actual original PCM does not match the quality receipt')
        if len(wav.readframes(wav.getnframes())) != wav.getnframes() * wav.getnchannels() * wav.getsampwidth():
            raise ValueError('Original PCM is truncated')
    entry = {'key': key, 'approved': False, 'reference': descriptor, 'provenance': copy.deepcopy(proof)}
    policy = entry['provenance']['quality'].get('processingPolicy')
    if policy is None:
        policy = 'canonical-processed' if key == 'adam-smasher' else 'ordinary-spoken'
    entry['provenance']['quality']['processingPolicy'] = policy
    entry['provenance']['quality']['overlap'] = quality.get('overlap', False)
    if policy == 'canonical-processed':
        entry['provenance']['quality'].setdefault('processingReason', 'Canonical cyborg source performance, pending generated-voice listening review.')
    prepare.validate_provenance(key, entry, require_review=False)
    roster = root / 'runtime/voice-cast-inventory-20261001/cast-roster-inventory.json'
    prepare.verify_provenance_sources(root, key, entry, roster, index_hashes=index_hashes)
    if proof.get('rosterSha256') != inventory.get('rosterSha256'):
        raise ValueError('Source and aggregate historical roster fingerprints disagree')
    return {'key': key, 'source': str(source.relative_to(root)).replace('\\', '/'), 'descriptor': descriptor,
            'receipt': str(receipt_path.relative_to(root)).replace('\\', '/'), 'receiptSha256': candidate['receiptSha256'],
            'sourceQualified': True, 'listeningVerified': False, 'approved': False,
            'referenceSha256': descriptor['sha256'], 'transcriptSha256': descriptor['transcriptSha256']}


def plan_auditions(root, inventory_path, *, keys=None, max_profiles=MAX_PROFILES):
    if type(max_profiles) is not int or not 1 <= max_profiles <= MAX_PROFILES:
        raise ValueError('Audition profile limit must be between1 and79')
    path = runtime_path(root, inventory_path, 'runtime/voice-cast/review', must_exist=True)
    inventory_digest = digest(path)
    inventory = prepare.read_json(path)
    if digest(path) != inventory_digest:
        raise ValueError('Review inventory changed during the bounded read')
    profiles = inventory.get('profiles')
    if inventory.get('schemaVersion') != 1 or not isinstance(profiles, list) or len(profiles) > MAX_PROFILES:
        raise ValueError('Invalid all-cast review inventory')
    seen, selected, rejected, index_hashes = set(), [], [], {}
    requested = set(keys) if keys else None
    if keys and (len(requested) != len(keys) or any(not validation.valid_key(key) for key in keys)):
        raise ValueError('Invalid/duplicate requested audition profiles')
    legacy_path = root / 'runtime/local-voices.json'
    legacy_digest = digest(legacy_path)
    legacy = prepare.read_json(legacy_path)
    if digest(legacy_path) != legacy_digest:
        raise ValueError('Accepted legacy configuration changed during the bounded read')
    accepted = prepare.accepted_legacy(root, legacy)
    for profile in profiles:
        key = profile.get('key') if isinstance(profile, dict) else None
        if not validation.valid_key(key) or key in seen:
            raise ValueError('Invalid/duplicate all-cast profile identity')
        seen.add(key)
        if requested is not None and key not in requested:
            continue
        try:
            if key in validation.LEGACY_KEYS:
                descriptor = copy.deepcopy(accepted[key])
                matches = [candidate for candidate in profile.get('candidates', []) if candidate.get('acceptedReference') is True
                           and all(candidate.get(field) == descriptor.get(field) for field in ('reference', 'sha256', 'transcript'))]
                if profile.get('status') != 'accepted' or len(matches) != 1:
                    raise ValueError('Aggregate did not retain the exact accepted legacy descriptor')
                row = {'key': key, 'source': descriptor['reference'], 'descriptor': descriptor,
                       'sourceQualified': True, 'acceptedExisting': True, 'approved': False, 'listeningVerified': False,
                       'referenceSha256': descriptor['sha256'], 'transcriptSha256': prepare.sha256_text(descriptor['transcript']),
                       'selection': 'Previously accepted original descriptor; unchanged.'}
            else:
                candidate, reason = selected_candidate(profile)
                row = qualify_source(root, key, candidate, inventory, index_hashes)
                row['selection'] = reason
            selected.append(row)
        except (ValueError, OSError, KeyError, TypeError) as error:
            rejected.append({'key': key, 'status': 'unprepared', 'reason': str(error)})
    if requested is not None and not requested <= seen:
        raise ValueError('Requested profile is not present in the review inventory')
    if len(selected) > max_profiles:
        raise ValueError('Qualified profile count exceeded the requested generation bound')
    if digest(path) != inventory_digest or digest(legacy_path) != legacy_digest:
        raise ValueError('Audition source inventory changed during qualification; rebuild the plan')
    return {'version': 1, 'kind': 'offline-source-audition-plan', 'warning': WARNING,
            'inventory': str(path.relative_to(root)).replace('\\', '/'), 'inventorySha256': inventory_digest,
            'sampleText': AUDITION_TEXT, 'steps': 32, 'selected': selected, 'unprepared': rejected,
            'legacyModel': {name: legacy[name] for name in ('model', 'revision')},
            'productionConfigSha256': legacy_digest}


def copy_source_reference(root, row):
    """Copy one source unchanged; also used by source-qualified activation."""
    key, descriptor = row['key'], row['descriptor']
    prefix = 'runtime/voice-references' if row.get('acceptedExisting') else 'runtime/voice-cast'
    source = runtime_path(root, row['source'], prefix, must_exist=True)
    if digest(source) != descriptor['sha256']:
        raise ValueError('Selected original reference changed after planning')
    if row.get('receipt'):
        receipt = runtime_path(root, row['receipt'], 'runtime/voice-cast', must_exist=True)
        if digest(receipt) != row['receiptSha256']:
            raise ValueError('Selected immutable attribution receipt changed after planning')
    target = runtime_path(root, f'runtime/voice-references/full-cast-draft/{key}/reference.wav', 'runtime/voice-references/full-cast-draft')
    if target.exists() and digest(target) != descriptor['sha256']:
        raise ValueError('Another draft owns a different original reference for ' + key)
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        with source.open('rb') as original:
            content = original.read(validation.MAX_REFERENCE_BYTES + 1)
        if len(content) > validation.MAX_REFERENCE_BYTES or hashlib.sha256(content).hexdigest() != descriptor['sha256']:
            raise ValueError('Original reference changed while copying')
        created = False
        try:
            with target.open('xb') as output:
                created = True
                output.write(content)
        except Exception:
            if created:
                target.unlink(missing_ok=True)
            raise
    if digest(target) != descriptor['sha256']:
        raise ValueError('Unchanged draft-copy verification failed')
    copied = str(target.relative_to(root)).replace('\\', '/')
    configured = copy.deepcopy(descriptor) if row.get('acceptedExisting') else {**descriptor, 'reference': copied, 'status': 'ready'}
    return configured, copied


def make_draft(root, plan, destination):
    destination = runtime_path(root, destination, 'runtime/voice-cast/auditions')
    if destination.exists():
        raise ValueError('Audition destination already exists; no sample is regenerated')
    if digest(root / plan['inventory']) != plan['inventorySha256'] or digest(root / 'runtime/local-voices.json') != plan['productionConfigSha256']:
        raise ValueError('Audition inputs changed after planning')
    voices, copied = {}, []
    for row in plan['selected']:
        voices[row['key']], target = copy_source_reference(root, row)
        copied.append(target)
    for row in plan['unprepared']:
        voices[row['key']] = {'status': 'unprepared'}
    config = {'version': 2, 'provider': 'hybrid', 'engine': 'omnivoice', 'steps': 32, **plan['legacyModel'],
              'preparation': {'mode': 'lazy', 'startupProfiles': [], 'maxCachedProfiles': 8}, 'voices': voices}
    registry = validation.validate_config(config, root)
    if set(registry['refs']) != {row['key'] for row in plan['selected']}:
        raise ValueError('Draft references became unavailable')
    destination.mkdir(parents=True)
    config_path = destination / 'local-voices.draft.json'
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (destination / 'plan.json').write_text(json.dumps({**plan, 'copiedOriginals': copied}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return config_path, config


def assert_no_resident_workers():
    import psutil
    own = os.getpid()
    blocked = []
    for process in psutil.process_iter(['pid', 'cmdline']):
        try:
            command = process.info['cmdline'] or []
            if process.pid != own and any(Path(argument).name.lower() in ('resident-voice-worker.py', 'convai-bridge.mjs', 'generate-voicecastauditions.py') for argument in command):
                blocked.append(process.pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    if blocked:
        raise RuntimeError('Stop the conversation bridge and other audition/resident workers before generation')


@contextmanager
def gpu_slot(root):
    path = runtime_path(root, 'runtime/voice-cast/.locks/audition-gpu.lock', 'runtime/voice-cast')
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as handle:
        if os.fstat(handle.fileno()).st_size == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise RuntimeError('Another audition owns the single GPU generation slot') from error
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


class PipeWorker:
    def __init__(self, root, config_path, destination, cancel):
        executable = root / 'vendor/reference-voicestudio/.venv/Scripts/python.exe'
        self.cancel, self.sequence, self.frames = cancel, 0, queue.Queue(maxsize=8)
        self.stop_reader, self.child, self.log, self.reader = threading.Event(), None, None, None
        try:
            self.log = (destination / 'worker.log').open('wb')
            self.child = subprocess.Popen([str(executable), '-B', str(root / 'bridge/resident-voice-worker.py'), '--config', str(config_path)],
                    cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            def publish(frame):
                while not self.stop_reader.is_set():
                    try:
                        self.frames.put(frame, timeout=.25)
                        return
                    except queue.Full:
                        continue
            def reader():
                try:
                    while not self.stop_reader.is_set():
                        line = self.child.stdout.readline(MAX_FRAME_BYTES + 1)
                        if not line:
                            raise RuntimeError('Owned voice worker exited before its expected response')
                        if len(line) > MAX_FRAME_BYTES:
                            raise RuntimeError('Oversized voice worker protocol frame')
                        frame = json.loads(line.decode('utf-8'))
                        if not isinstance(frame, dict):
                            raise RuntimeError('Invalid voice worker protocol frame')
                        publish(frame)
                except Exception as error:
                    publish(RuntimeError(str(error)))
            self.reader = threading.Thread(target=reader, daemon=True)
            self.reader.start()
        except Exception:
            # Constructor failure must retire the child before ownership can
            # disappear from generate_auditions' worker variable.
            self.close()
            raise

    def wait(self, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.cancel():
                raise Cancelled('Audition generation cancelled')
            try:
                frame = self.frames.get(timeout=max(.001, min(.25, deadline - time.monotonic())))
            except queue.Empty:
                continue
            if isinstance(frame, Exception):
                raise frame
            if frame.get('op') == 'state':
                continue
            return frame
        raise TimeoutError('Owned voice worker exceeded its bounded phase deadline')

    def start(self, config):
        started = time.perf_counter()
        frame = self.wait(180)
        refs = {key: value for key, value in config['voices'].items() if value.get('status', 'ready') == 'ready'}
        if (frame.get('op') != 'ready' or frame.get('protocolVersion') != 2 or sorted(frame.get('profiles', [])) != sorted(refs)
                or frame.get('preparedProfiles') != [] or frame.get('device') != 'cuda:0' or frame.get('dtype') != 'torch.float16'
                or frame.get('referenceHashes') != {key: value['sha256'] for key, value in refs.items()}
                or frame.get('transcriptHashes') != {key: prepare.sha256_text(value['transcript']) for key, value in refs.items()}):
            raise RuntimeError('Audition worker did not attest the selected references and FP16 CUDA model')
        return {'startupMs': (time.perf_counter() - started) * 1000, 'worker': {key: frame.get(key) for key in (
                'device', 'dtype', 'runtime', 'tensorrt', 'acceleration', 'cudaAllocatedMiB', 'cudaReservedMiB')}}

    def request(self, op, profile, **values):
        self.sequence += 1
        request_id = self.sequence
        self.child.stdin.write((json.dumps({'op': op, 'id': request_id, 'profile': profile, **values}) + '\n').encode('utf-8'))
        self.child.stdin.flush()
        started = time.perf_counter()
        frame = self.wait(120)
        expected = 'prepared' if op == 'prepare' else 'audio'
        if frame.get('id') != request_id or frame.get('op') not in (expected, 'error'):
            raise RuntimeError('Unexpected audition worker response identity')
        if frame['op'] == 'error':
            raise ValueError('Selected profile preparation or generation failed')
        prepared = frame.get('preparedProfiles')
        if frame.get('profile') != profile or not isinstance(prepared, list) or len(prepared) > 8 or profile not in prepared:
            raise RuntimeError('Audition profile readiness/identity changed')
        if op == 'synthesize' and frame.get('steps') != values.get('steps'):
            raise RuntimeError('Audition quality changed')
        return frame, (time.perf_counter() - started) * 1000

    def close(self):
        self.stop_reader.set()
        if self.child is None:
            if self.log:
                self.log.close()
            return
        if self.child.stdin and not self.child.stdin.closed:
            self.child.stdin.close()
        try:
            self.child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.child.terminate()
            try:
                self.child.wait(timeout=5)
            except subprocess.TimeoutExpired as error:
                raise RuntimeError('Owned audition worker exit could not be confirmed') from error
        finally:
            if self.log:
                self.log.close()
            if self.reader and self.reader.ident is not None:
                self.reader.join(timeout=1)
            # BufferedReader.close can wait on a blocked readline mutex. Never
            # cross the exit deadline by closing a still-active reader stream.
            if self.child.poll() is not None and (not self.reader or not self.reader.is_alive()) and self.child.stdout:
                self.child.stdout.close()


def generate_auditions(root, plan, destination, *, cancel=lambda: False, worker_factory=PipeWorker, guard=assert_no_resident_workers):
    if not plan['selected']:
        raise ValueError('No source-qualified profiles are available to generate')
    guard()
    destination = runtime_path(root, destination, 'runtime/voice-cast/auditions')
    with gpu_slot(root):
        guard()
        config_path, config = make_draft(root, plan, destination)
        report = {'version': 1, 'kind': 'generated-voice-auditions', 'warning': WARNING, 'sampleText': AUDITION_TEXT,
                  'steps': 32, 'listeningVerified': False, 'approved': False, 'renders': [], 'unprepared': plan['unprepared']}
        worker = None
        try:
            if cancel():
                raise Cancelled('Audition generation cancelled before model loading')
            worker = worker_factory(root, config_path, destination, cancel)
            report.update(worker.start(config))
            for row in plan['selected']:
                if cancel():
                    raise Cancelled('Audition generation cancelled')
                key = row['key']
                try:
                    prepared, preparation_ms = worker.request('prepare', key)
                    audio, roundtrip_ms = worker.request('synthesize', key, text=AUDITION_TEXT, steps=32)
                    data = base64.b64decode(audio.get('audio', ''), validate=True)
                    if not 44 <= len(data) <= 8 * 1024 * 1024:
                        raise ValueError('Audition WAV exceeded supported byte limits')
                    with wave.open(io.BytesIO(data), 'rb') as wav:
                        duration = wav.getnframes() / wav.getframerate()
                        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or not 0 < duration <= 30:
                            raise ValueError('Audition WAV is not supported unprocessed PCM speech')
                        if len(wav.readframes(wav.getnframes())) != wav.getnframes() * 2:
                            raise ValueError('Audition WAV is truncated')
                    target = destination / (key + '.wav')
                    target.write_bytes(data)
                    report['renders'].append({'key': key, 'status': 'generated', 'sample': target.name,
                        'sha256': hashlib.sha256(data).hexdigest(), 'durationSeconds': duration,
                        'referenceSha256': row['referenceSha256'], 'transcriptSha256': row['transcriptSha256'],
                        'preparationMs': preparation_ms, 'generationMs': audio.get('generationMs'), 'roundTripMs': roundtrip_ms,
                        'preparedProfiles': audio['preparedProfiles'], 'listeningVerified': False, 'approved': False})
                    print(json.dumps({'state': 'generated', 'profile': key, 'generationMs': audio.get('generationMs')}), flush=True)
                except (ValueError, wave.Error, EOFError) as error:
                    report['renders'].append({'key': key, 'status': 'generation_failed', 'reason': str(error),
                                              'listeningVerified': False, 'approved': False})
                (destination / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            successful = sum(row['status'] == 'generated' for row in report['renders'])
            report['state'] = 'complete' if successful == len(plan['selected']) else 'partial' if successful else 'failed'
        except (Cancelled, TimeoutError, RuntimeError) as error:
            report['state'] = 'cancelled' if isinstance(error, Cancelled) else 'failed'
            report['error'] = str(error)
        finally:
            try:
                if worker:
                    worker.close()
                report['workerExited'] = True
            except Exception as error:
                report['workerExited'] = False
                report['state'] = 'failed'
                report['error'] = str(error)
                raise
            finally:
                if digest(root / 'runtime/local-voices.json') != plan['productionConfigSha256']:
                    report['productionConfigChangedExternally'] = True
                (destination / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                (destination / 'README.md').write_text('# Voice cast auditions\n\n' + WARNING + '\n\n' +
                    'One shared FP16 OmniVoice model;32 steps. Original source references and returned WAVs are unchanged.\n' +
                    'No promotion, listening approval, cloud request or conversation memory was created.\n', encoding='utf-8')
        return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path, default=Path('runtime/voice-cast/review/inventory.json'))
    parser.add_argument('--output', type=Path, default=Path('runtime/voice-cast/auditions/full-cast'))
    parser.add_argument('--profile', action='append', dest='profiles')
    parser.add_argument('--max-profiles', type=int, default=MAX_PROFILES)
    parser.add_argument('--generate', action='store_true')
    parser.add_argument('--cancel-file', type=Path)
    args = parser.parse_args(argv)
    plan = plan_auditions(ROOT, args.inventory, keys=args.profiles, max_profiles=args.max_profiles)
    if not args.generate:
        print(json.dumps({'state': 'plan', 'qualifiedProfiles': len(plan['selected']), 'unpreparedProfiles': len(plan['unprepared']),
                          'profiles': [row['key'] for row in plan['selected']], 'warning': WARNING}))
        return 0
    cancelled = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: cancelled.set())
    cancel_path = runtime_path(ROOT, args.cancel_file, 'runtime/voice-cast/auditions') if args.cancel_file else None
    result = generate_auditions(ROOT, plan, args.output, cancel=lambda: cancelled.is_set() or bool(cancel_path and cancel_path.exists()))
    print(json.dumps({'state': result['state'], 'generated': sum(row['status'] == 'generated' for row in result['renders']),
                      'failed': sum(row['status'] != 'generated' for row in result['renders']), 'workerExited': result.get('workerExited', False)}))
    return 0 if result['state'] == 'complete' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, RuntimeError, KeyError) as error:
        print('Audition preparation failed: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
