"""Scoped weight comparisons tested with tiny CPU models only."""
from pathlib import Path
import random
import tempfile
from types import SimpleNamespace
import unittest

from pocket_training.runner import Spec
from pocket_training.teacher_overlay import comparison_weights


class TeacherOverlayTests(unittest.TestCase):
    def fixture(self, root, different_codec=False):
        import torch
        from torch import nn
        from safetensors.torch import save_file
        class Flow(nn.Module):
            def __init__(self):
                super().__init__()
                self.core = nn.Linear(2, 2)
                self.register_buffer("emb_mean", torch.zeros(2))
                self.register_buffer("emb_std", torch.ones(2))
        model = nn.Module()
        model.flow_lm = Flow()
        model.flow = SimpleNamespace()
        model.flow_lm.core.eval()
        model.flow_lm.core.bias.requires_grad_(False)
        mimi = nn.Linear(2, 2).eval()
        source = {"flow_lm." + name: value.detach().clone() for name, value in model.flow_lm.state_dict().items()}
        source["flow_lm.core.weight"].fill_(3.)
        source.update({"mimi." + name: value.detach().clone() for name, value in mimi.state_dict().items()})
        if different_codec:
            source["mimi.weight"].add_(1.)
        path = root / "comparison.safetensors"
        save_file(source, str(path))
        spec = Spec(root / "spec", {"teacher_comparison_weights": str(path)}, root, root, root / "out", "fixture", {})
        return spec, model, mimi

    def test_weight_mode_grad_buffer_and_rng_restore_after_body_error(self):
        import numpy as np
        import torch
        with tempfile.TemporaryDirectory() as folder:
            spec, model, mimi = self.fixture(Path(folder))
            before = {name: value.clone() for name, value in model.state_dict().items()}
            modes = [(module, module.training) for module in (*model.modules(), *mimi.modules())]
            gradients = [(parameter, parameter.requires_grad) for parameter in (*model.parameters(), *mimi.parameters())]
            torch.manual_seed(42)
            random.seed(42)
            np.random.seed(42)
            torch_rng, python_rng, numpy_rng = torch.get_rng_state(), random.getstate(), np.random.get_state()
            with self.assertRaisesRegex(RuntimeError, "fixture body failure"):
                with comparison_weights(spec, model, mimi, torch.device("cpu"), 0, 1):
                    self.assertTrue(torch.equal(model.flow_lm.core.weight, torch.full((2, 2), 3.)))
                    model.eval()
                    mimi.train()
                    model.flow_lm.core.bias.requires_grad_(True)
                    model.flow_lm.emb_mean.fill_(8.)
                    torch.rand(3)
                    random.random()
                    np.random.rand()
                    raise RuntimeError("fixture body failure")
            self.assertTrue(all(torch.equal(value, before[name]) for name, value in model.state_dict().items()))
            self.assertEqual([(module, module.training) for module, _ in modes], modes)
            self.assertEqual([(parameter, parameter.requires_grad) for parameter, _ in gradients], gradients)
            self.assertTrue(torch.equal(torch.get_rng_state(), torch_rng))
            self.assertEqual(random.getstate(), python_rng)
            self.assertEqual(np.random.get_state()[0], numpy_rng[0])
            self.assertTrue(np.array_equal(np.random.get_state()[1], numpy_rng[1]))

    def test_codec_mismatch_refuses_overlay_and_restores_original(self):
        import torch
        with tempfile.TemporaryDirectory() as folder:
            spec, model, mimi = self.fixture(Path(folder), different_codec=True)
            before = {name: value.clone() for name, value in model.state_dict().items()}
            with self.assertRaisesRegex(RuntimeError, "setup failed"):
                with comparison_weights(spec, model, mimi, torch.device("cpu"), 0, 1):
                    self.fail("A different codec cannot enter the comparison")
            self.assertTrue(all(torch.equal(value, before[name]) for name, value in model.state_dict().items()))


if __name__ == "__main__":
    unittest.main()
