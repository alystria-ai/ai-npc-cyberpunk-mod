"""Offline CPU checks; these never qualify CUDA hardware or generated audio."""

from __future__ import annotations

from contextlib import nullcontext
import copy
import json
import os
from pathlib import Path
import random
import sys
import tempfile
from typing import Any


def run_indexing_tests(source: Path) -> dict[str, Any]:
    """Pure cursor/sampling checks using stub IO and no model execution."""
    from collections import Counter
    from types import SimpleNamespace

    sys.path.insert(0, str(source))
    from training.args import TrainArgs
    from pocket_training.runner import IndexedBatches, atomic_rows, with_terminal_slot
    import torch

    target = torch.randn(3, 6, 8)
    mask = torch.arange(6)[None] < torch.tensor([6, 4, 2])[:, None]
    voice, frames = torch.randn(3, 4, 8), torch.tensor([4, 3, 2])
    extended = with_terminal_slot((target, mask, voice, frames))
    assert extended[0].shape[1] == 7
    assert torch.equal(extended[0][:, :6], target) and torch.equal(extended[1][:, :6], mask)
    assert extended[2] is voice and extended[3] is frames
    shifted = torch.cat([extended[1][:, :1], extended[1][:, :-1]], dim=1)
    assert torch.equal(((~extended[1]) & shifted).sum(dim=1), torch.ones(3, dtype=torch.long))
    repeated = with_terminal_slot(extended)
    assert repeated[0] is extended[0] and repeated[1] is extended[1]

    with tempfile.TemporaryDirectory(prefix="pocket-cursor-cpu-") as temporary:
        path = Path(temporary) / "train.jsonl"
        rows = [{"path": f"audio/{i}.wav", "duration": 4, "transcript": "Test.",
                 "character": "a" if i < 2 else "b"} for i in range(8)]
        atomic_rows(path, rows)
        args = TrainArgs(batch_size=1, seed=42, compile=False)
        args.data.train_jsonl = str(path)
        model = SimpleNamespace(flow_lm=SimpleNamespace(conditioner=SimpleNamespace(
            tokenizer=SimpleNamespace(encode=lambda text: [1]))))
        mimi = SimpleNamespace(sample_rate=24000, frame_rate=12.5)

        def loader(balanced: bool) -> Any:
            result = IndexedBatches(args, model, mimi, balanced=balanced)
            result.loader._sample = lambda entry: (entry.path, result.loader.rng.random())
            result.loader._collate = lambda samples: samples
            return result

        for balanced in (False, True):
            current = loader(balanced)
            draws = [current.batch(i)[0] for i in range(64)]
            resumed = loader(balanced)
            assert current.batch(64) == resumed.batch(64), "Resume changed cut RNG or utterance cursor"
            counts = Counter(path for path, _cut in draws)
            assert set(counts) == {r["path"] for r in rows}
            a = sum(counts[r["path"]] for r in rows if r["character"] == "a")
            assert a == (32 if balanced else 16), "Speaker sampling distribution differs from its declared policy"
            if balanced:
                # With two actors and two ranks, each rank must still see both.
                actors_on_rank_zero = {"a" if int(path.split("/")[-1].split(".")[0]) < 2 else "b"
                                       for path, _cut in draws[::2]}
                assert actors_on_rank_zero == {"a", "b"}
    return {"exact_resume_cursor_and_cut_seed": True, "uniform_full_epoch_coverage": True,
            "speaker_balance_and_rank_cast_mixing": True, "one_positive_eos_label_per_row": True,
            "flow_targets_preserved": True, "model_execution": False}


def tiny_model() -> Any:
    import torch
    from torch import nn
    from pocket_tts.models.flow_lm import FlowLMModel
    from pocket_tts.modules.mlp import SimpleMLPAdaLN
    from pocket_tts.modules.text_conditioner import LUTConditioner
    from pocket_tts.modules.transformer import StreamingTransformer
    from training.args import TrainArgs
    from training.modules.model import TrainableTTS
    from training.modules.samplers import build_flow
    from training.modules.utils import dit_init

    class LocalConditioner(LUTConditioner):
        def __init__(self) -> None:
            nn.Module.__init__(self)
            self.dim = self.output_dim = 32
            self.embed = nn.Embedding(17, 32)

        def forward(self, tokens: Any) -> Any:
            return self.embed(tokens)

    flow = build_flow("lsd", distill_prob=1.0)
    head = SimpleMLPAdaLN(8, 16, 8, 32, 2, 2)
    dit_init(head)
    backbone = StreamingTransformer(d_model=32, num_heads=2, num_layers=2, dim_feedforward=64)
    fl = FlowLMModel(conditioner=LocalConditioner(), flow_net=head, transformer=backbone,
                     dim=32, ldim=8, insert_bos_before_voice=True)
    fl.speaker_proj_weight = nn.Parameter(torch.randn(32, 8) * 0.1)
    args = TrainArgs(compile=False, text_dropout=0, voice_dropout=0, flow_batch_multiplier=2)
    return TrainableTTS(fl, flow, args)


def batch() -> tuple[Any, ...]:
    import torch

    return (torch.randn(3, 11, 8), torch.arange(11)[None] < torch.tensor([11, 8, 6])[:, None],
            [torch.randint(0, 16, (n,)) for n in (4, 2, 6)], torch.randn(3, 5, 8))


def pooled_gradient_check(*, rank: int | None = None, distill: bool = False) -> dict[str, Any]:
    """Ragged batch-64 gradient parity, with rank one carrying longer audio."""
    import torch
    import torch.nn.functional as F
    from pocket_training.runner import pooled_objective_weights

    torch.manual_seed(713)
    base = torch.nn.Linear(3, 2, dtype=torch.float64)
    examples = []
    for i in range(64):
        frames = 2 + i % 5 if i < 32 else 30 + i % 17
        features = torch.randn(frames + 1, 3, dtype=torch.float64)
        targets = torch.randn(frames + 1, 2, dtype=torch.float64)
        labels = torch.zeros(frames + 1, dtype=torch.float64)
        labels[-1] = 1
        examples.append((features, targets, labels, frames))
    global_frames = sum(e[3] for e in examples)
    global_shifted = global_frames + 64
    assert sum(e[3] for e in examples[:32]) != sum(e[3] for e in examples[32:])
    reference = copy.deepcopy(base)
    numerator_flow = torch.zeros((), dtype=torch.float64)
    numerator_eos = torch.zeros((), dtype=torch.float64)
    for features, targets, labels, frames in examples:
        prediction = reference(features)
        if distill:
            numerator_eos = numerator_eos + (prediction - targets).square().mean(-1).sum()
        else:
            numerator_flow = numerator_flow + (prediction[:frames, 0] - targets[:frames, 0]).square().sum()
            numerator_eos = numerator_eos + F.binary_cross_entropy_with_logits(prediction[:, 1], labels, reduction="sum")
    expected_loss = numerator_eos / global_shifted if distill else numerator_flow / global_frames + 0.1 * numerator_eos / global_shifted
    expected_loss.backward()
    if rank is None:
        replicas = [copy.deepcopy(base), copy.deepcopy(base)]
        for which, replica in enumerate(replicas):
            for features, targets, labels, frames in examples[which * 32:(which + 1) * 32]:
                prediction = replica(features)
                scale, eos_weight = pooled_objective_weights(frames, frames + 1, global_frames,
                                       global_shifted, 2, 0.1, distill=distill)
                local_loss = (prediction - targets).square().mean() if distill else (
                    (prediction[:frames, 0] - targets[:frames, 0]).square().mean()
                    + eos_weight * F.binary_cross_entropy_with_logits(prediction[:, 1], labels))
                (scale * local_loss).backward()
        actual_grads = [(a.grad + b.grad) / 2 for a, b in zip(replicas[0].parameters(), replicas[1].parameters(), strict=True)]
    else:
        from torch.nn.parallel import DistributedDataParallel as DDP

        model = copy.deepcopy(base)
        wrapped = DDP(model)
        shard = examples[rank * 32:(rank + 1) * 32]
        totals = torch.tensor([sum(e[3] for e in shard), sum(e[3] + 1 for e in shard)], dtype=torch.int64)
        torch.distributed.all_reduce(totals)
        assert totals.tolist() == [global_frames, global_shifted]
        for micro, (features, targets, labels, frames) in enumerate(shard):
            with wrapped.no_sync() if micro < 31 else nullcontext():
                prediction = wrapped(features)
                scale, eos_weight = pooled_objective_weights(frames, frames + 1, global_frames,
                                       global_shifted, 2, 0.1, distill=distill)
                local_loss = (prediction - targets).square().mean() if distill else (
                    (prediction[:frames, 0] - targets[:frames, 0]).square().mean()
                    + eos_weight * F.binary_cross_entropy_with_logits(prediction[:, 1], labels))
                (scale * local_loss).backward()
        actual_grads = [p.grad for p in model.parameters()]
    error = max(float((actual - expected.grad).abs().max()) for actual, expected in zip(actual_grads, reference.parameters(), strict=True))
    assert error < 2e-12, f"Pooled ragged batch64 gradients differ: {error}"
    # A regression to equal utterance means must fail this fixture.
    old = copy.deepcopy(base)
    for features, targets, labels, frames in examples:
        prediction = old(features)
        local_loss = (prediction - targets).square().mean() if distill else (
            (prediction[:frames, 0] - targets[:frames, 0]).square().mean()
            + 0.1 * F.binary_cross_entropy_with_logits(prediction[:, 1], labels))
        (local_loss / 64).backward()
    assert any(not torch.allclose(a.grad, b.grad, rtol=1e-5, atol=1e-7) for a, b in zip(old.parameters(), reference.parameters(), strict=True))
    return {"distill": distill, "global_frames": global_frames, "global_shifted": global_shifted,
            "maximum_gradient_error": error, "unequal_rank_frames": True}


def run_correction_tests(source: Path) -> dict[str, Any]:
    """Focused CPU checks for calibration, forced JVP, and pooled weighting."""
    from types import SimpleNamespace
    from unittest.mock import patch
    import torch
    from pocket_training.runner import (Spec, atomic_json, make_training_args,
        install_fp32_reductions, precision_probe, capture_rng, force_complete_lsd_probe)

    sys.path.insert(0, str(source))
    with tempfile.TemporaryDirectory(prefix="pocket-correction-cpu-") as directory:
        output = Path(directory)
        spec = Spec(output / "spec.json", {}, output, source, output, "correction-test", {})
        atomic_json(output / "prepared.json", {"input_identity": spec.identity, "counts": {"train": 3274}})
        teacher_args, _text, _ceiling = make_training_args(spec, "teacher", 2)
        atomic_json(output / "teacher/state.json", {"status": "completed"})
        (output / "teacher/best.pt").write_bytes(b"placeholder-only-not-loaded")
        student_args, _text, _ceiling = make_training_args(spec, "distill", 2)
        assert teacher_args.stats_ema_steps == student_args.stats_ema_steps == 0
    torch.manual_seed(123)
    model = tiny_model().train()
    model.args.stats_ema_steps = teacher_args.stats_ema_steps
    install_fp32_reductions(model)
    mean, std = model.flow_lm.emb_mean.clone(), model.flow_lm.emb_std.clone()
    updates = []
    def forbidden_update(*args: Any, **kwargs: Any) -> None:
        updates.append(True)
        raise AssertionError("Accumulation attempted a calibration update")
    model._update_latent_stats = forbidden_update
    inputs = batch()
    micro = (inputs[0][:1] * 2 + 10, inputs[1][:1], inputs[2][:1], inputs[3][:1])
    model.zero_grad(set_to_none=True)
    for _ in range(32):
        loss, _metrics = model(*micro, update_stats=False)
        (loss / 32).backward()
    assert not updates and torch.equal(mean, model.flow_lm.emb_mean) and torch.equal(std, model.flow_lm.emb_std)

    probe_model = tiny_model().train()
    probe_model.flow.distill_prob = 0.25
    probe_model.flow._skip_rng.manual_seed(0)
    install_fp32_reductions(probe_model)
    saved_rng = capture_rng(torch, probe_model)
    shadow_rng = torch.Generator().set_state(saved_rng["lsd_skip"])
    assert float(torch.rand((), generator=shadow_rng)) > 0.25, "Fixture would accidentally take the JVP branch"
    probe_inputs = batch()
    encoded = (probe_inputs[0], probe_inputs[1], probe_inputs[3], torch.tensor([5, 5, 5]))
    optimizer = torch.optim.AdamW(probe_model.parameters(), lr=2e-5)
    original_scaler = torch.amp.GradScaler
    # Input construction legitimately draws randomness before the probe. Its
    # contract is to restore the RNG at entry, not before fixture preparation.
    saved_rng = capture_rng(torch, probe_model)
    with patch("training.dataloader.encode_batch", return_value=encoded), patch("torch.amp.GradScaler", side_effect=lambda device, **kwargs: original_scaler("cpu", **kwargs)):
        receipt = precision_probe(None, probe_model, None, optimizer,
                  SimpleNamespace(text_tokens=probe_inputs[2]), "fp16", torch.device("cpu"))
    assert receipt["forced_lsd_jvp"]
    assert receipt["jvp_metrics_verified_by_precision"] == {"fp32": True, "fp16": True}
    assert probe_model.flow.distill_prob == 0.25
    restored_rng = capture_rng(torch, probe_model)
    assert torch.equal(saved_rng["cpu"], restored_rng["cpu"])
    assert torch.equal(saved_rng["lsd_skip"], restored_rng["lsd_skip"])
    assert saved_rng["python"] == restored_rng["python"]
    try:
        with force_complete_lsd_probe(probe_model):
            raise RuntimeError("deliberate probe interruption")
    except RuntimeError:
        pass
    assert probe_model.flow.distill_prob == 0.25
    return {"teacher_and_distill_stats_ema_steps": 0, "accumulation_forwards_checked": 32,
            "calibration_bitwise_preserved": True, "actual_teacher_jvp_probe": receipt,
            "teacher_pooled_gradient": pooled_gradient_check(),
            "student_pooled_gradient": pooled_gradient_check(distill=True)}


def ddp_worker(rank: int, rendezvous: str, output: str) -> None:
    os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
    import torch
    import torch.distributed as dist
    from torch.nn.parallel import DistributedDataParallel as DDP

    torch.set_num_threads(1)
    dist.init_process_group("gloo", init_method=rendezvous, rank=rank, world_size=2)
    torch.manual_seed(7919)
    full_input = torch.randn(64, 3)
    full_target = torch.randn(64, 2)
    model = torch.nn.Linear(3, 2)
    reference = copy.deepcopy(model)
    reference_loss = (reference(full_input) - full_target).square().mean()
    reference_loss.backward()
    reference_norm = torch.nn.utils.clip_grad_norm_(reference.parameters(), 0.2)
    reference_optimizer = torch.optim.SGD(reference.parameters(), lr=0.1)
    reference_optimizer.step()

    wrapped = DDP(model)
    optimizer = torch.optim.SGD(model.parameters(), lr=0.1)
    scaler = torch.amp.GradScaler("cpu", enabled=True, init_scale=128)
    for micro in range(8):
        start = micro * 8 + rank * 4
        sync = wrapped.no_sync() if micro < 7 else nullcontext()
        with sync:
            loss = (wrapped(full_input[start:start + 4]) - full_target[start:start + 4]).square().mean()
            scaler.scale(loss / 8).backward()
    scaler.unscale_(optimizer)
    actual_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), 0.2)
    assert torch.allclose(actual_norm, reference_norm, rtol=2e-6, atol=2e-7), "Accumulated gradient norm differs from batch 64"
    scaler.step(optimizer)
    scaler.update()
    for actual, expected in zip(model.parameters(), reference.parameters(), strict=True):
        assert torch.allclose(actual, expected, rtol=2e-6, atol=2e-7), "DDP update differs from a true batch 64"
    # Exercise uneven conditioning graphs using the official tiny LSD wrapper.
    from pocket_training.runner import install_fp32_reductions

    torch.manual_seed(17)
    official = tiny_model().train()
    install_fp32_reductions(official)
    official_wrapped = DDP(official, find_unused_parameters=True)
    for micro in range(2):
        official.args.text_dropout = 1.0 if (rank + micro) % 2 else 0.0
        official.args.voice_dropout = 1.0 if rank == 1 else 0.0
        sync = official_wrapped.no_sync() if micro == 0 else nullcontext()
        with sync:
            loss, metrics = official_wrapped(*batch())
            assert loss.dtype == torch.float32 and torch.isfinite(loss)
            (loss / 2).backward()
    norm = torch.nn.utils.clip_grad_norm_(official.parameters(), 1.0)
    assert torch.isfinite(norm), "Official DDP/dropout gradients are non-finite"
    teacher_pooled = pooled_gradient_check(rank=rank)
    student_pooled = pooled_gradient_check(rank=rank, distill=True)
    dist.barrier()
    if rank == 0:
        Path(output).write_text(json.dumps({"world_size": 2, "effective_batch": 64,
                                          "gradient_norm": float(actual_norm),
                                          "official_lsd_dropout_ddp": True,
                                          "teacher_pooled": teacher_pooled,
                                          "student_pooled": student_pooled}))
    dist.destroy_process_group()


def serial_accumulation_reference() -> None:
    """Compare both simulated rank gradients to a true 64-row clipped update."""
    import torch

    torch.manual_seed(7919)
    inputs, targets = torch.randn(64, 3), torch.randn(64, 2)
    base = torch.nn.Linear(3, 2)
    reference = copy.deepcopy(base)
    loss = (reference(inputs) - targets).square().mean()
    loss.backward()
    expected_norm = torch.nn.utils.clip_grad_norm_(reference.parameters(), 0.2)
    torch.optim.SGD(reference.parameters(), lr=0.1).step()
    replicas = [copy.deepcopy(base), copy.deepcopy(base)]
    for rank, replica in enumerate(replicas):
        optimizer = torch.optim.SGD(replica.parameters(), lr=0.1)
        scaler = torch.amp.GradScaler("cpu", enabled=True, init_scale=128)
        for micro in range(8):
            start = micro * 8 + rank * 4
            loss = (replica(inputs[start:start + 4]) - targets[start:start + 4]).square().mean()
            scaler.scale(loss / 8).backward()
        scaler.unscale_(optimizer)
    for left, right in zip(replicas[0].parameters(), replicas[1].parameters(), strict=True):
        left.grad.copy_((left.grad + right.grad) / 2)
    norm = torch.nn.utils.clip_grad_norm_(replicas[0].parameters(), 0.2)
    assert torch.allclose(norm, expected_norm, rtol=2e-6, atol=2e-7)
    torch.optim.SGD(replicas[0].parameters(), lr=0.1).step()
    for actual, expected in zip(replicas[0].parameters(), reference.parameters(), strict=True):
        assert torch.allclose(actual, expected, rtol=2e-6, atol=2e-7)


def run_tests(source: Path) -> int:
    # This must precede Torch import even in a CUDA-enabled Python installation.
    os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    sys.path.insert(0, str(source))
    import torch
    from training.checkpointing import EMA
    from pocket_training.runner import (
        Spec, atomic_json, atomic_torch_save, capture_rng, cpu_tree, ema_weights,
        fence_splits, fixed_validation_indices, install_fp32_reductions,
        load_spec, plan, resolve_inference_config, restore_rng, source_digest, valid_words,
    )

    if torch.cuda.is_available():
        raise AssertionError("Self-test must remain CPU-only")
    torch.set_num_threads(1)
    torch.manual_seed(123)
    checks = []
    run_indexing_tests(source)
    checks.append("exact_resume_coverage_prompt_seed_and_optional_cast_balancing")
    corrections = run_correction_tests(source)
    checks.extend(["calibration_frozen_through_32_accumulated_forwards",
                   "actual_teacher_probe_forces_diagonal_and_jvp_and_restores_probability_rng",
                   "variable_length_batch64_pooled_teacher_eos_and_student_gradient_parity"])
    model = tiny_model().train()
    before = set(model.state_dict())
    install_fp32_reductions(model)
    assert set(model.state_dict()) == before, "FP32 reductions changed checkpoint keys"
    test_batch = batch()
    # Force the official LSD self-distillation/JVP path, rather than getting a
    # probabilistically skipped smoke test.
    for dtype in (torch.float32, torch.float16, torch.bfloat16):
        model.zero_grad(set_to_none=True)
        with torch.autocast("cpu", dtype=dtype if dtype != torch.float32 else torch.bfloat16,
                            enabled=dtype != torch.float32):
            loss, metrics = model(*test_batch)
        assert loss.dtype == torch.float32 and torch.isfinite(loss), f"Invalid {dtype} LSD loss"
        assert "flow_distill" in metrics, "LSD JVP path was skipped"
        loss.backward()
        grads = [p.grad for p in model.parameters() if p.grad is not None]
        assert grads and all(torch.isfinite(g).all() for g in grads), f"Invalid {dtype} LSD gradients"
    checks.append("official_lsd_jvp_fp32_loss_finite_backward_under_cpu_fp16_bf16")

    student = tiny_model().train()
    student.args.distill_cfg_coef = 2.0
    teacher = copy.deepcopy(student.flow_lm).eval().requires_grad_(False)
    student.__dict__["distill_teacher"] = teacher
    for module in (student.flow_lm.flow_net, student.flow_lm.out_eos, student.flow):
        module.requires_grad_(False)
    install_fp32_reductions(student)
    with torch.autocast("cpu", dtype=torch.float16):
        loss, metrics = student(*test_batch)
    assert loss.dtype == torch.float32 and torch.isfinite(loss)
    loss.backward()
    assert not any(p.grad is not None for p in teacher.parameters())
    assert not any(p.grad is not None for m in (student.flow_lm.flow_net, student.flow_lm.out_eos) for p in m.parameters())
    assert any(p.grad is not None for p in student.flow_lm.transformer.parameters())
    checks.append("official_cfg2_distillation_fp32_mse_and_frozen_teacher_heads")

    ema = EMA(model, 0.999)
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-5)
    optimizer.step()
    ema.update(model)
    saved_rng = capture_rng(torch, model)
    expected_random = torch.randn(12)
    restore_rng(torch, model, saved_rng)
    assert torch.equal(expected_random, torch.randn(12))
    raw = {k: v.clone() for k, v in model.named_parameters()}
    with ema_weights(model, ema):
        assert all(torch.equal(dict(model.named_parameters())[k], v) for k, v in ema.shadow.items())
    assert all(torch.equal(dict(model.named_parameters())[k], v) for k, v in raw.items())
    checks.append("ema_overlay_restore_and_lsd_cpu_rng_resume")

    with tempfile.TemporaryDirectory(prefix="pocket-runner-cpu-") as temp_name:
        temp = Path(temp_name)
        spec = Spec(temp / "spec.json", {"max_output_gib": 8}, temp, source, temp,
                    "cpu-self-test", {})
        payload = {"step": 1, "model": cpu_tree(model.state_dict(), torch),
                   "ema": cpu_tree(ema.state_dict(), torch), "optimizer": cpu_tree(optimizer.state_dict(), torch),
                   "scaler": torch.amp.GradScaler("cpu", enabled=False).state_dict(),
                   "rng_by_rank": [saved_rng], "runner": {"input_identity": spec.identity}}
        atomic_torch_save(temp / "last.pt", payload, spec)
        original_checkpoint_hash = sha256_for_test(temp / "last.pt")
        loaded = torch.load(temp / "last.pt", map_location="cpu", weights_only=True)
        clone = tiny_model()
        install_fp32_reductions(clone)
        clone.load_state_dict(loaded["model"], strict=True)
        clone_optimizer = torch.optim.AdamW(clone.parameters(), lr=2e-5)
        clone_optimizer.load_state_dict(loaded["optimizer"])
        clone_ema = EMA(clone, 0.999)
        clone_ema.load_state_dict(loaded["ema"])
        assert loaded["step"] == 1 and clone_optimizer.state
        assert all(torch.equal(v, clone.state_dict()[k]) for k, v in model.state_dict().items())
        broken = copy.deepcopy(payload)
        key = next(k for k, value in broken["model"].items() if value.is_floating_point())
        broken["model"][key].flatten()[0] = float("nan")
        try:
            atomic_torch_save(temp / "last.pt", broken, spec)
        except RuntimeError:
            pass
        else:
            raise AssertionError("Non-finite checkpoint was accepted")
        assert sha256_for_test(temp / "last.pt") == original_checkpoint_hash
        reloaded = torch.load(temp / "last.pt", map_location="cpu", weights_only=True)
        assert all(torch.equal(v, reloaded["model"][k]) for k, v in loaded["model"].items())
        checks.append("atomic_full_checkpoint_optimizer_scaler_rng_roundtrip_and_nonfinite_rejection")

        # The referenced source hash must not depend on ancestor .git or newly
        # generated Python bytecode.
        small_source = temp / "source"
        small_source.mkdir()
        (small_source / "file.py").write_text("a = 1\n")
        digest = source_digest(small_source)
        (small_source / "__pycache__").mkdir()
        (small_source / "__pycache__/cached.pyc").write_bytes(b"ignored")
        assert source_digest(small_source) == digest
        (small_source / "file.py").write_text("a = 2\n")
        assert source_digest(small_source) != digest
        checks.append("zip_source_content_digest_ignores_bytecode_and_detects_edits")

        entries = [{"path": f"audio/{i}.wav", "id": str(i), "character": str(i % 3)} for i in range(17)]
        selected = fixed_validation_indices(entries, 7, 42)
        assert len(selected) == 7 and len(set(selected)) == 7
        assert {entries[i]["character"] for i in selected} == {"0", "1", "2"}
        assert selected == fixed_validation_indices(entries, 7, 42)
        aligned = {"path": "a.wav", "duration": 4, "words": [
            {"word": "first", "start": 0.1, "end": 1.0},
            {"word": "second", "start": 1.3, "end": 3.5}]}
        assert valid_words(aligned)
        assert not valid_words({**aligned, "words": [{"word": "short", "start": 0.0, "end": 0.2}]})
        refs = temp / "refs.json"
        reference = temp / "reference.wav"
        reference.write_bytes(b"reference")
        atomic_json(refs, [{"id": "johnny", "path": str(reference), "texts": ["Test."]}])
        spec.raw["reference_manifest"] = str(refs)
        try:
            fence_splits(spec, {"train": [{"path": "overlap.wav"}], "dev": [{"path": "overlap.wav"}]})
        except ValueError:
            pass
        else:
            raise AssertionError("Audio leakage was accepted")
        checks.append("fixed_cast_heldout_sampling_word_cut_and_leakage_gates")

        # Baseline mode must work before the expanded corpus exists. Validate
        # the full local path/configuration contract without loading weights.
        import yaml

        model_dir = temp / "models"
        model_dir.mkdir()
        (model_dir / "teacher.safetensors").write_bytes(b"local-teacher-placeholder")
        (model_dir / "student.safetensors").write_bytes(b"local-student-placeholder")
        (model_dir / "tokenizer.json").write_text("{}\n")
        for kind, released in (("teacher", "english_2026-04_24l"), ("student", "english_2026-09")):
            raw = yaml.safe_load((source / f"pocket_tts/config/{released}.yaml").read_text())
            raw["weights_path"] = f"models/{kind}.safetensors"
            (temp / f"{kind}.yaml").write_text(yaml.safe_dump(raw))
        baseline_spec = temp / "baseline.json"
        atomic_json(baseline_spec, {"source_revision": "41cbc84af539ea78a804ffca5f9c6edc1a22ce44",
            "source_digest": source_digest(source), "source_dir": str(source),
            "teacher_config": "teacher.yaml", "student_config": "student.yaml",
            "tokenizer": "models/tokenizer.json", "reference_manifest": str(refs),
            "output_dir": "results", "session_budget_seconds": 120, "gpu_budget_seconds": 120})
        baseline = load_spec(baseline_spec, require_manifests=False)
        receipt = plan(baseline)
        assert receipt["baseline_only"] and receipt["counts"] == {}
        resolved = resolve_inference_config(baseline, "teacher", temp / "resolved-teacher.yaml")
        assert Path(resolved["weights_path"]).is_file()
        assert resolved["weights_path_without_voice_cloning"] is None
        assert Path(resolved["flow_lm"]["lookup_table"]["tokenizer_path"]).is_file()
        try:
            load_spec(baseline_spec, require_manifests=True)
        except ValueError:
            pass
        else:
            raise AssertionError("Training without corpus manifests was accepted")
        checks.append("corpus_free_baseline_plan_and_local_config_resolution_with_strict_training_manifest_gate")

        serial_accumulation_reference()
        checks.append("two_rank_serial_accumulation_equals_batch64_after_unscale_and_clip")
        import torch.distributed as dist

        try:
            dist.ProcessGroupGloo.create_device(hostname="127.0.0.1")
        except RuntimeError as exc:
            ddp = {"status": "unavailable", "reason": str(exc), "actual_ddp_tested": False}
        else:
            import torch.multiprocessing as mp

            rendezvous = (temp / "gloo-rendezvous").as_uri()
            mp.spawn(ddp_worker, args=(rendezvous, str(temp / "ddp.json")), nprocs=2, join=True)
            ddp = {"status": "passed", "actual_ddp_tested": True,
                   **json.loads((temp / "ddp.json").read_text())}
            checks.append("two_process_cpu_ddp_batch64_and_official_conditioning_dropout")
    print(json.dumps({"status": "local_checks_passed", "checks": checks, "ddp": ddp,
                      "corrections": corrections,
                      "device": "cpu", "torch": str(torch.__version__),
                      "source_digest": source_digest(source), "cuda_t4_precision_qualified": False,
                      "audio_quality_qualified": False}, indent=2), flush=True)
    return 0


def sha256_for_test(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()
