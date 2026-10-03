"""Run the exact reviewed recovery gates against current production modules.

The immutable actual-source fixtures and failed-before snapshot are retained in
the reviewed proposal. This changes placement/imports only; no native parser,
audio decoder, model or original artifact write occurs.
"""
import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
PROJECT = Path(__file__).resolve().parents[1]
PROPOSAL = PROJECT / "runtime/voice-data-expansion-20261003/source-recovery-producer/proposal-cast269-9b39aa2f-r2"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


reviewed = load("reviewed_source_recovery_gates", PROPOSAL / "test_candidate_recovery.py")
current = load("current_production_source_recovery", PROJECT / "scripts/Cast-VoiceReferenceCandidates.py")
reviewed.PROJECT = PROJECT
reviewed.HERE = PROPOSAL
reviewed.cast = current
reviewed.bridge = current.recovery_bridge()


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromTestCase(reviewed.CandidateRecoveryTests)


if __name__ == "__main__":
    unittest.main(verbosity=2)
