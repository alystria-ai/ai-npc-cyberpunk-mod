"""CPU-only checks of the replay adapter's memory/error fallback contract."""
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, main
from unittest.mock import Mock, patch
import importlib.util
import torch

spec = importlib.util.spec_from_file_location('voice_cuda_graph', Path(__file__).resolve().parents[1] / 'bridge/voice-cuda-graph.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class FallbackTests(TestCase):
    def setUp(self):
        self.patches = [patch.object(torch.cuda, 'Stream'), patch.object(torch.cuda, 'synchronize'),
            patch.object(torch.cuda, 'empty_cache')]
        for item in self.patches: item.start()
        self.addCleanup(lambda: [item.stop() for item in reversed(self.patches)])
        self.original = Mock(return_value=SimpleNamespace(logits='original result'))
        self.model = SimpleNamespace(forward=self.original, llm=SimpleNamespace(config=SimpleNamespace(use_cache=True)))
        self.graph = module.VoiceGraph(self.model)
        self.graph.supported = lambda *args: not self.graph.disabled_reason
        self.ids = SimpleNamespace(shape=(2, 8, 315))
        self.addCleanup(self.graph.close)

    def test_low_memory_attempts_capture_once_per_render_and_retries_next_render(self):
        with patch.object(torch.cuda, 'mem_get_info', return_value=(100, 12288 * 1024**2)) as memory:
            for _ in range(32):
                self.assertEqual(self.graph.forward(self.ids).logits, 'original result')
            self.assertEqual(memory.call_count, 1)
            self.graph.begin_request(); self.graph.forward(self.ids)
            self.assertEqual(memory.call_count, 2)
        self.assertEqual(self.original.call_count, 33)

    def test_reserved_graph_pool_counts_against_budget_even_if_live_tensors_are_small(self):
        self.graph.capture_entry = Mock(return_value={'bytes': 18 * 1024**2, 'reserved': 600 * 1024**2})
        with patch.object(torch.cuda, 'mem_get_info', return_value=(4096 * 1024**2, 12288 * 1024**2)):
            self.assertEqual(self.graph.forward(self.ids).logits, 'original result')
        self.assertIsNone(self.graph.entry)
        self.assertIn('budget', self.graph.last_fallback)

    def test_recoverable_capture_failure_uses_original_and_disables_further_captures(self):
        self.graph.capture_entry = Mock(side_effect=RuntimeError('Unsupported capture operator'))
        with patch.object(torch.cuda, 'mem_get_info', return_value=(4096 * 1024**2, 12288 * 1024**2)):
            for _ in range(2): self.assertEqual(self.graph.forward(self.ids).logits, 'original result')
        self.assertEqual(self.graph.capture_entry.call_count, 1)
        self.assertIsNone(self.graph.entry)
        self.assertIn('Unsupported capture', self.graph.disabled_reason)
        self.graph.install(); self.graph.close()
        self.assertEqual(self.model.forward, self.original)
        self.assertTrue(self.model.llm.config.use_cache)


if __name__ == '__main__': main()
