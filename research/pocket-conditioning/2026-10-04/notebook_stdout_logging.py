"""Add readable stdout to future kernels; does not touch accepted jobs or training math."""
import ast
import hashlib
import json
from pathlib import Path

MARKER = '# READABLE_PILOT_STDOUT_V1'


def add_logging(template, driver_path):
    tree = ast.parse(template)
    assignment = next(n for n in tree.body if isinstance(n, ast.Assign)
                      and any(isinstance(t, ast.Name) and t.id == 'CONTROL_OVERLAYS' for t in n.targets))
    old_literal = ast.get_source_segment(template, assignment.value.args[0])
    overlays = json.loads(ast.literal_eval(assignment.value.args[0]))
    if MARKER in template:
        return template, overlays
    original = Path(driver_path).read_bytes()
    rule = overlays['orchestration/driver.py']
    assert hashlib.sha256(original).hexdigest() == rule['before']
    pairs = rule['replacements']
    pairs += [
        ('STOP = False', 'STOP = False\n\ndef progress(message):\n    print("[Pocket] " + message, flush=True)'),
        ("label='prepare' if mode=='prepare' else arm",
         "label='prepare' if mode=='prepare' else arm\n        planned=int(self.specs[arm].raw['teacher_max_steps'])\n        progress('Preparing codec/cache' if mode=='prepare' else f'{arm}: training start; loading weights, initial audio, then {planned} updates')"),
        ('start=time.monotonic();samples=[];seen=set();stop_reason=None;signalled=None',
         'start=time.monotonic();samples=[];seen=set();stop_reason=None;signalled=None\n        logged_checkpoints=set();logged_panels=set()'),
        ("samples.append({'step':current['step'],'seconds_per_step':value})",
         "samples.append({'step':current['step'],'seconds_per_step':value})\n                                recent=[x['seconds_per_step'] for x in samples[-20:]]\n                                left=max(0,planned-int(current['step']))\n                                progress(f\"{arm}: step {current['step']}/{planned} | loss {current['train']['loss']:.5f} | {value:.2f} s/update | remaining updates approximately {left*min(recent)/60:.1f}-{left*max(recent)*1.25/60:.1f} min; audio/checkpoint work extra\")"),
        ("if STOP:stop_reason=stop_reason or 'owner_stop'",
         "if mode=='teacher':\n                        status_path=output/'teacher/state.json'\n                        if status_path.exists():\n                            saved=read(status_path);saved_step=saved.get('checkpoint_step')\n                            if saved_step is not None and saved_step not in logged_checkpoints:\n                                logged_checkpoints.add(saved_step)\n                                progress(f\"{arm}: checkpoint {saved_step}/{planned} saved ({saved.get('checkpoint_bytes',0):,} bytes); diagnostic audio may follow\")\n                        for panel in output.glob('pilot-panel-step*.json'):\n                            if panel.name not in logged_panels:\n                                logged_panels.add(panel.name)\n                                progress(arm+': diagnostic audio panel complete '+panel.stem)\n                    if STOP:stop_reason=stop_reason or 'owner_stop'"),
        ("self.state['phases'][label]=receipt;atomic(self.persistent/'driver-state.json',self.state)",
         "self.state['phases'][label]=receipt;atomic(self.persistent/'driver-state.json',self.state)\n        progress(f\"{label}: phase {'complete' if code==0 and not stop_reason else 'failed'} after {receipt['seconds']/60:.1f} min; return code {code}\")"),
        ("self.state['artifacts'][arm]=receipt",
         "self.state['artifacts'][arm]=receipt\n        progress(f\"{arm}: checkpoint and audio copied to saved output; checkpoint step {meta['step'] if meta else 'missing'}\")"),
    ]
    derived = original.decode('utf-8')
    for old, new in pairs:
        if derived.count(old) != 1:
            raise ValueError('Future logging overlay occurrence differs: ' + old[:100])
        derived = derived.replace(old, new, 1)
    ast.parse(derived)
    rule['after'] = hashlib.sha256(derived.encode()).hexdigest()
    template = template.replace(old_literal, repr(json.dumps(overlays, separators=(',', ':'))), 1)
    helper = '''
# READABLE_PILOT_STDOUT_V1
def progress(message):
    print('[Pocket] ' + message, flush=True)

def readable_failure(kind, error, trace):
    import traceback
    details = ''.join(traceback.format_exception(kind, error, trace))
    details = re.sub(r'https?://\\S+|hf_[A-Za-z0-9]+|KGAT_[A-Za-z0-9]+', '[redacted]', details)
    print('[Pocket] Failed; traceback follows. Detailed worker logs remain in saved output.', flush=True)
    print(details, flush=True)

'''
    template = template.replace('\nSTOP = False\n', helper + '\nSTOP = False\n', 1)
    substitutions = [
        ('    global DEADLINE, DRIVER', '    global DEADLINE, DRIVER\n    progress("Setup started: locating private inputs")'),
        ('        fixed = json.loads((scratch / "fixed-resources.json").read_text())',
         '        progress("Pilot source and corpus staged")\n        fixed = json.loads((scratch / "fixed-resources.json").read_text())'),
        ('            atomic(bootstrap / "fixed-staging.json", receipts)',
         '            atomic(bootstrap / "fixed-staging.json", receipts)\n            progress("Fixed input staged: " + item["role"])'),
        ('        install_requirements(DRIVER, scratch, bootstrap, scratch / "orchestration/requirements-pilot.txt")',
         '        progress("Installing pinned runtime dependencies")\n        install_requirements(DRIVER, scratch, bootstrap, scratch / "orchestration/requirements-pilot.txt")\n        progress("Dependencies ready; validating runtime and preparing data")'),
        ('        DRIVER.Driver(runtime_plan).run()',
         '        controller = DRIVER.Driver(runtime_plan)\n        controller.run()\n        completed = controller.state.get("status") in ("single_arm_completed_pending_matched_comparison", "matched_pilot_completed_pending_listening_and_analysis")\n        expected = {arm: int(controller.specs[arm].raw["teacher_max_steps"]) for arm in DRIVER.ARMS}\n        if not completed or any(controller.state["artifacts"][arm]["checkpoint"]["step"] != total for arm,total in expected.items()):\n            raise RuntimeError("Final saved checkpoint does not confirm planned completion")\n        progress("Notebook complete: " + ", ".join(f"{arm} {total} updates" for arm,total in expected.items()) + "; diagnostic audio and checkpoints saved; awaiting matched comparison")'),
        ('if __name__ == "__main__":\n    main()',
         'if __name__ == "__main__":\n    try:\n        main()\n    except BaseException as error:\n        readable_failure(type(error), error, error.__traceback__)\n        code = 130 if isinstance(error, KeyboardInterrupt) else error.code if isinstance(error, SystemExit) and isinstance(error.code, int) else 1\n        raise SystemExit(code or 1) from None'),
    ]
    for old, new in substitutions:
        if template.count(old) != 1:
            raise ValueError('Future bootstrap logging occurrence differs: ' + old)
        template = template.replace(old, new, 1)
    ast.parse(template)
    return template, overlays


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--training-dir', type=Path, default=Path(__file__).resolve().parent)
    here = parser.parse_args().training_dir.resolve()
    destination = here / 'future-logged-notebooks'
    destination.mkdir(exist_ok=True)
    records = {}
    for letter in 'abc':
        source = here / f'kernel-template-independent-{letter}.py'
        result, _ = add_logging(source.read_text(), here / 'matched-pilot-500/driver.py')
        target = destination / source.name
        target.write_bytes(result.encode())
        records[letter] = {'path': str(target), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
                           'source_template_sha256': hashlib.sha256(source.read_bytes()).hexdigest()}
    (destination / 'manifest.json').write_text(json.dumps({'templates': records, 'accepted_jobs_changed': False,
        'verification': 'Exact source overlay reconstruction and Python parsing only; no cloud execution',
        'stdout': 'Main notebook process prints flushed messages; detailed worker logs remain saved files',
        'api_limit': 'Current Kaggle API exposes published logs reliably after completion; no live availability claim'}, indent=2)+'\n')
    print(json.dumps(records))
