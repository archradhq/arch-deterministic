"""
archlora/train.py

Complete ArchLora fine-tuning script.
Covers: corpus splitting, training, evaluation, checkpoint management, retraining.

Local usage (corpus split only — no GPU needed):
  pip install datasets transformers
  python train.py --split-corpus corpus/combined.jsonl

RunPod usage (full training — GPU required):
  pip install unsloth trl peft datasets wandb bitsandbytes transformers
  python train.py --run v1 --epochs 3

Other commands:
  python train.py --run v2 --resume archlora/adapters/archlora-v1 --epochs 2
  python train.py --eval-only --adapter archlora/adapters/archlora-v1
  python train.py --analyze v1
  python train.py --compare v1 v2 v3
  python train.py --merge archlora/adapters/archlora-v4 --run v4
  python train.py --run smoke --max-steps 10

Directory layout:
  packages/deterministic/
    train.py
    corpus/
      combined.jsonl        <- all pairs (input to --split-corpus)
      training.jsonl        <- 80% split (auto-created)
      validation.jsonl      <- 10% split (auto-created)
      test.jsonl            <- 10% split (never seen during training)
    archlora/
      runs/v1/              <- checkpoints
      adapters/archlora-v1/ <- saved adapter weights
      merged/               <- final merged model for deployment
      eval/results/         <- eval JSON reports
"""

from __future__ import annotations

import argparse
import json
import os
import random
import time
from datetime import datetime
from pathlib import Path

# ─── Directories ─────────────────────────────────────────────────────────────

ROOT        = Path(__file__).parent
CORPUS_DIR  = ROOT / "corpus"
ARCHLORA    = ROOT / "archlora"
RUNS_DIR    = ARCHLORA / "runs"
ADAPTER_DIR = ARCHLORA / "adapters"
EVAL_DIR    = ARCHLORA / "eval" / "results"
MERGED_DIR  = ARCHLORA / "merged"

# ─── Model + LoRA config ─────────────────────────────────────────────────────

BASE_MODEL      = "unsloth/Meta-Llama-3.1-8B"
MAX_SEQ_LENGTH  = 2048
LOAD_IN_4BIT    = True

LORA_R          = 16
LORA_ALPHA      = 16
LORA_DROPOUT    = 0.0
LORA_TARGETS    = [
    "q_proj", "k_proj", "v_proj", "o_proj",
    "gate_proj", "up_proj", "down_proj",
]

# ─── Training defaults ────────────────────────────────────────────────────────

DEFAULT_EPOCHS     = 3
DEFAULT_BATCH      = 4
DEFAULT_GRAD_ACCUM = 4
DEFAULT_LR         = 2e-4
DEFAULT_WARMUP     = 10
DEFAULT_SAVE_STEPS = 50
DEFAULT_LOG_STEPS  = 10

# ─── Eval targets ─────────────────────────────────────────────────────────────

TARGET_JSON_VALIDITY  = 0.99
TARGET_PRECISION      = 0.85
TARGET_RECALL         = 0.80
TARGET_CODE_ACCURACY  = 0.90
TARGET_FP_RATE        = 0.10

# ─── Prompt ──────────────────────────────────────────────────────────────────

def format_prompt(instruction: str, input_text: str, output: str = "") -> str:
    return f"""### Instruction:
{instruction}

### Input:
{input_text}

### Response:
{output}"""


def format_example(example: dict) -> dict:
    instruction = example.get("instruction", "Given this IR graph, what architecture violations exist?")
    input_text  = json.dumps(example.get("input", {}), separators=(",", ":"))
    output_text = json.dumps(example.get("output", {}), separators=(",", ":"))
    return {"text": format_prompt(instruction, input_text, output_text)}

# ─── Corpus split ─────────────────────────────────────────────────────────────

def split_corpus(source_path: str, train_ratio: float = 0.8, val_ratio: float = 0.1, seed: int = 42):
    """
    Split combined.jsonl into training / validation / test splits.
    Call once before first training run.
    """
    source = Path(source_path)
    if not source.exists():
        print(f"ERROR: {source_path} not found.")
        print("Run: node scripts/combine-corpus.mjs first.")
        return

    lines = [l for l in source.read_text(encoding="utf-8").splitlines() if l.strip()]

    rng = random.Random(seed)
    rng.shuffle(lines)

    n       = len(lines)
    n_train = int(n * train_ratio)
    n_val   = int(n * val_ratio)
    n_test  = n - n_train - n_val

    CORPUS_DIR.mkdir(parents=True, exist_ok=True)
    (CORPUS_DIR / "training.jsonl").write_text(
        "\n".join(lines[:n_train]) + "\n", encoding="utf-8")
    (CORPUS_DIR / "validation.jsonl").write_text(
        "\n".join(lines[n_train:n_train + n_val]) + "\n", encoding="utf-8")
    (CORPUS_DIR / "test.jsonl").write_text(
        "\n".join(lines[n_train + n_val:]) + "\n", encoding="utf-8")

    print(f"Corpus split complete:")
    print(f"  Source:     {source_path}")
    print(f"  Total:      {n}")
    print(f"  Training:   {n_train}  ({train_ratio:.0%})")
    print(f"  Validation: {n_val}    ({val_ratio:.0%})")
    print(f"  Test:       {n_test}   ({1-train_ratio-val_ratio:.0%})")
    print(f"  Seed:       {seed}")
    print(f"\n  Files written to: {CORPUS_DIR}/")
    print(f"    training.jsonl")
    print(f"    validation.jsonl")
    print(f"    test.jsonl")
    print(f"\nNext step (on RunPod):")
    print(f"  python train.py --run v1 --epochs 3")

# ─── Model loading ────────────────────────────────────────────────────────────

def load_base_model(resume_adapter: str | None = None):
    """Load base model. Requires unsloth — RunPod only."""
    try:
        from unsloth import FastLanguageModel
        from peft import PeftModel
    except ImportError:
        print("ERROR: unsloth not installed.")
        print("This command requires RunPod with full ML stack.")
        print("Local usage: python train.py --split-corpus corpus/combined.jsonl")
        raise SystemExit(1)

    print(f"\nLoading base model: {BASE_MODEL}")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name     = BASE_MODEL,
        max_seq_length = MAX_SEQ_LENGTH,
        load_in_4bit   = LOAD_IN_4BIT,
        dtype          = None,
    )

    if resume_adapter:
        print(f"  Resuming from adapter: {resume_adapter}")
        model = PeftModel.from_pretrained(model, resume_adapter, is_trainable=True)
    else:
        print(f"  Attaching fresh LoRA adapters (r={LORA_R})")
        model = FastLanguageModel.get_peft_model(
            model,
            r                          = LORA_R,
            target_modules             = LORA_TARGETS,
            lora_alpha                 = LORA_ALPHA,
            lora_dropout               = LORA_DROPOUT,
            bias                       = "none",
            use_gradient_checkpointing = True,
            random_state               = 42,
        )

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total     = sum(p.numel() for p in model.parameters())
    print(f"  Trainable: {trainable:,} / {total:,} ({100*trainable/total:.2f}%)")
    return model, tokenizer

# ─── Dataset loading ──────────────────────────────────────────────────────────

def load_corpus(tokenizer, split: str = "training"):
    try:
        from datasets import load_dataset
    except ImportError:
        print("ERROR: pip install datasets")
        raise SystemExit(1)

    path = CORPUS_DIR / f"{split}.jsonl"
    if not path.exists():
        print(f"ERROR: {path} not found.")
        print("Run: python train.py --split-corpus corpus/combined.jsonl")
        raise SystemExit(1)

    raw = load_dataset("json", data_files=str(path), split="train")
    print(f"  Loaded {split}: {len(raw)} examples")
    return raw.map(format_example, remove_columns=raw.column_names)

# ─── Training ─────────────────────────────────────────────────────────────────

def train(args):
    try:
        import torch
        from transformers import TrainingArguments
        from trl import SFTTrainer
    except ImportError:
        print("ERROR: pip install unsloth trl peft datasets wandb bitsandbytes transformers")
        raise SystemExit(1)

    run_dir = RUNS_DIR / args.run
    run_dir.mkdir(parents=True, exist_ok=True)

    model, tokenizer = load_base_model(resume_adapter=args.resume)

    print(f"\nLoading corpus...")
    train_dataset = load_corpus(tokenizer, "training")
    val_dataset   = load_corpus(tokenizer, "validation")

    import torch
    training_args = TrainingArguments(
        output_dir                   = str(run_dir),
        num_train_epochs             = args.epochs,
        max_steps                    = args.max_steps if args.max_steps > 0 else -1,
        per_device_train_batch_size  = DEFAULT_BATCH,
        gradient_accumulation_steps  = DEFAULT_GRAD_ACCUM,
        learning_rate                = DEFAULT_LR,
        warmup_steps                 = DEFAULT_WARMUP,
        fp16                         = not torch.cuda.is_bf16_supported(),
        bf16                         = torch.cuda.is_bf16_supported(),
        logging_steps                = DEFAULT_LOG_STEPS,
        save_steps                   = DEFAULT_SAVE_STEPS,
        save_total_limit             = 3,
        evaluation_strategy          = "steps",
        eval_steps                   = DEFAULT_SAVE_STEPS,
        load_best_model_at_end       = True,
        metric_for_best_model        = "eval_loss",
        report_to                    = "wandb" if os.getenv("WANDB_API_KEY") else "none",
        run_name                     = f"archlora-{args.run}",
        seed                         = 42,
    )

    from trl import SFTTrainer
    trainer = SFTTrainer(
        model              = model,
        tokenizer          = tokenizer,
        train_dataset      = train_dataset,
        eval_dataset       = val_dataset,
        dataset_text_field = "text",
        max_seq_length     = MAX_SEQ_LENGTH,
        args               = training_args,
    )

    print(f"\nStarting training run: {args.run}")
    print(f"  Epochs:         {args.epochs}")
    print(f"  Train examples: {len(train_dataset)}")
    print(f"  Val examples:   {len(val_dataset)}")
    print(f"  Output dir:     {run_dir}\n")

    start = time.time()
    trainer.train()
    elapsed = time.time() - start
    print(f"\nTraining complete in {elapsed/60:.1f} minutes")

    adapter_path = ADAPTER_DIR / f"archlora-{args.run}"
    adapter_path.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(adapter_path))
    tokenizer.save_pretrained(str(adapter_path))
    print(f"Adapter saved: {adapter_path}")

    run_eval(model, tokenizer, run_name=args.run)

# ─── Inference ────────────────────────────────────────────────────────────────

def infer(model, tokenizer, ir_graph: dict, max_new_tokens: int = 512) -> dict:
    try:
        import torch
        from unsloth import FastLanguageModel
    except ImportError:
        raise SystemExit(1)

    prompt = format_prompt(
        "Given this IR graph, what architecture violations exist?",
        json.dumps(ir_graph, separators=(",", ":")),
        output=""
    )

    FastLanguageModel.for_inference(model)
    inputs = tokenizer(prompt, return_tensors="pt").to("cuda")

    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens = max_new_tokens,
            temperature    = 0.1,
            do_sample      = True,
            pad_token_id   = tokenizer.eos_token_id,
        )

    new_tokens = outputs[0][inputs["input_ids"].shape[1]:]
    response   = tokenizer.decode(new_tokens, skip_special_tokens=True).strip()
    response   = response.split("###")[0].strip()
    return json.loads(response)

# ─── Evaluation ───────────────────────────────────────────────────────────────

def run_eval(model, tokenizer, run_name: str):
    test_path = CORPUS_DIR / "test.jsonl"
    if not test_path.exists():
        print("No test.jsonl found — skipping eval")
        return

    print(f"\nRunning eval on test set...")
    examples = [
        json.loads(l)
        for l in test_path.read_text(encoding="utf-8").splitlines()
        if l.strip()
    ]

    total = json_valid = true_pos = false_pos = false_neg = 0
    code_correct = code_total = clean_correct = clean_total = 0
    failures = []

    for ex in examples:
        total += 1
        expected  = ex["output"].get("violations", [])
        exp_codes = {v["code"] for v in expected}
        is_clean  = len(expected) == 0

        try:
            predicted = infer(model, tokenizer, ex["input"])
            json_valid += 1
        except Exception as e:
            failures.append({
                "id": ex.get("id", total),
                "error": f"JSON parse failed: {e}",
                "variant": ex.get("variant", ""),
            })
            false_neg += len(expected)
            continue

        pred_violations = predicted.get("violations", [])
        pred_codes      = {v.get("code", "") for v in pred_violations}

        if is_clean:
            clean_total += 1
            if len(pred_violations) == 0:
                clean_correct += 1
            else:
                false_pos += len(pred_violations)
            continue

        for code in exp_codes:
            code_total += 1
            if code in pred_codes:
                true_pos += 1
                code_correct += 1
            else:
                false_neg += 1
                failures.append({
                    "id": ex.get("id", total),
                    "error": f"Missed: {code}",
                    "variant": ex.get("variant", ""),
                    "expected": list(exp_codes),
                    "predicted": list(pred_codes),
                })

        for code in pred_codes:
            if code not in exp_codes:
                false_pos += 1

    precision     = true_pos / (true_pos + false_pos)   if (true_pos + false_pos) > 0  else 0
    recall        = true_pos / (true_pos + false_neg)    if (true_pos + false_neg) > 0  else 0
    json_validity = json_valid / total                    if total > 0                   else 0
    code_acc      = code_correct / code_total            if code_total > 0              else 0
    fp_rate       = 1 - (clean_correct / clean_total)    if clean_total > 0             else 0

    report = {
        "run":            run_name,
        "timestamp":      datetime.utcnow().isoformat(),
        "total_examples": total,
        "metrics": {
            "json_validity":      round(json_validity, 4),
            "precision":          round(precision, 4),
            "recall":             round(recall, 4),
            "code_accuracy":      round(code_acc, 4),
            "false_positive_rate": round(fp_rate, 4),
        },
        "targets": {
            "json_validity":      TARGET_JSON_VALIDITY,
            "precision":          TARGET_PRECISION,
            "recall":             TARGET_RECALL,
            "code_accuracy":      TARGET_CODE_ACCURACY,
            "false_positive_rate": TARGET_FP_RATE,
        },
        "passed": {
            "json_validity":      json_validity >= TARGET_JSON_VALIDITY,
            "precision":          precision     >= TARGET_PRECISION,
            "recall":             recall        >= TARGET_RECALL,
            "code_accuracy":      code_acc      >= TARGET_CODE_ACCURACY,
            "false_positive_rate": fp_rate      <= TARGET_FP_RATE,
        },
        "top_failures": failures[:20],
    }
    report["overall_pass"] = all(report["passed"].values())

    EVAL_DIR.mkdir(parents=True, exist_ok=True)
    report_path = EVAL_DIR / f"{run_name}.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"\n{'='*50}")
    print(f"EVAL REPORT — archlora-{run_name}")
    print(f"{'='*50}")
    print(f"  Total:               {total}")
    print(f"  JSON validity:       {json_validity:.1%}  {'✓' if report['passed']['json_validity'] else '✗'}  (target {TARGET_JSON_VALIDITY:.0%})")
    print(f"  Precision:           {precision:.1%}  {'✓' if report['passed']['precision'] else '✗'}  (target {TARGET_PRECISION:.0%})")
    print(f"  Recall:              {recall:.1%}  {'✓' if report['passed']['recall'] else '✗'}  (target {TARGET_RECALL:.0%})")
    print(f"  Code accuracy:       {code_acc:.1%}  {'✓' if report['passed']['code_accuracy'] else '✗'}  (target {TARGET_CODE_ACCURACY:.0%})")
    print(f"  False positive rate: {fp_rate:.1%}  {'✓' if report['passed']['false_positive_rate'] else '✗'}  (target <{TARGET_FP_RATE:.0%})")
    print(f"{'='*50}")
    print(f"  Overall: {'PASS ✓' if report['overall_pass'] else 'FAIL ✗'}")
    print(f"  Report:  {report_path}")

    return report

# ─── Failure analysis ─────────────────────────────────────────────────────────

def analyze_failures(run_name: str):
    report_path = EVAL_DIR / f"{run_name}.json"
    if not report_path.exists():
        print(f"No eval report for run: {run_name}")
        print(f"Expected: {report_path}")
        return

    report   = json.loads(report_path.read_text(encoding="utf-8"))
    passed   = report["passed"]
    failures = report.get("top_failures", [])

    print(f"\n{'='*50}")
    print(f"RETRAINING ANALYSIS — archlora-{run_name}")
    print(f"{'='*50}")

    failing = [k for k, v in passed.items() if not v]
    if not failing:
        print("  All metrics passed.")
        print(f"  Next: python train.py --run {_next_run(run_name)} --resume {ADAPTER_DIR}/archlora-{run_name}")
        return

    print(f"  Failing: {', '.join(failing)}\n")

    if not passed["json_validity"]:
        print("  JSON VALIDITY LOW")
        print("  → Check if IR graphs exceed MAX_SEQ_LENGTH (2048 tokens)")
        print("  → Add more simple single-violation examples\n")

    if not passed["precision"]:
        print("  PRECISION LOW — too many false violations")
        print("  → Add more clean graph examples (target 25-30%)\n")

    if not passed["recall"]:
        missed = {}
        for f in failures:
            if "Missed:" in f.get("error", ""):
                code = f["error"].split(": ")[-1]
                missed[code] = missed.get(code, 0) + 1
        print("  RECALL LOW — missing real violations")
        if missed:
            for code, count in sorted(missed.items(), key=lambda x: -x[1])[:5]:
                print(f"    {code}: missed {count}x → add 20+ pairs")
        print()

    if not passed["code_accuracy"]:
        print("  CODE ACCURACY LOW — wrong rule code emitted")
        print("  → Add contrast pairs for similar rules:")
        print("    ISOLATED-NODE-005 vs DEAD-NODE-011")
        print("    DIRECT-DB-ACCESS-002 vs DATASTORE-NO-INCOMING-008\n")

    if not passed["false_positive_rate"]:
        print("  FALSE POSITIVE RATE HIGH")
        print("  → Re-run engine on test clean graphs to verify labels")
        print("  → Add 50+ explicit clean graph examples\n")

    print(f"  Next run:")
    print(f"    python train.py --run {_next_run(run_name)} --resume {ADAPTER_DIR}/archlora-{run_name} --epochs 2")

# ─── Compare runs ─────────────────────────────────────────────────────────────

def compare_runs(run_names: list[str]):
    reports = {}
    for name in run_names:
        path = EVAL_DIR / f"{name}.json"
        if path.exists():
            reports[name] = json.loads(path.read_text(encoding="utf-8"))
        else:
            print(f"  No report for: {name}")

    if not reports:
        return

    metrics = ["json_validity", "precision", "recall", "code_accuracy", "false_positive_rate"]
    header  = f"{'Metric':<26}" + "".join(f"{n:>14}" for n in reports)
    sep     = "=" * len(header)
    print(f"\n{sep}\nRUN COMPARISON\n{sep}")
    print(header)
    print("-" * len(header))
    for m in metrics:
        row = f"{m:<26}"
        for name, r in reports.items():
            val    = r["metrics"].get(m, 0)
            symbol = "✓" if r["passed"].get(m) else "✗"
            row   += f"{val:.1%} {symbol}".rjust(14)
        print(row)
    print("-" * len(header))
    row = f"{'Overall':<26}"
    for r in reports.values():
        row += ("PASS" if r.get("overall_pass") else "FAIL").rjust(14)
    print(row)

# ─── Merge ────────────────────────────────────────────────────────────────────

def merge_adapter(adapter_path: str, run_name: str):
    try:
        from unsloth import FastLanguageModel
    except ImportError:
        print("ERROR: unsloth not installed. Run on RunPod.")
        raise SystemExit(1)

    print(f"\nMerging adapter: {adapter_path}")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name     = adapter_path,
        max_seq_length = MAX_SEQ_LENGTH,
        load_in_4bit   = LOAD_IN_4BIT,
    )
    model = model.merge_and_unload()

    out = MERGED_DIR / f"archlora-{run_name}-merged"
    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(out), safe_serialization=True)
    tokenizer.save_pretrained(str(out))
    print(f"Merged model saved: {out}")
    print(f"Ready for RunPod serverless or VPC Docker image (~4.5GB)")

# ─── Utilities ────────────────────────────────────────────────────────────────

def _next_run(current: str) -> str:
    if current == "smoke":
        return "v1"
    try:
        return f"v{int(current.lstrip('v')) + 1}"
    except ValueError:
        return f"{current}-retrain"

# ─── CLI ──────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(
        description="ArchLora fine-tuning",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Local (no GPU):
  python train.py --split-corpus corpus/combined.jsonl

  # RunPod (GPU required):
  python train.py --run smoke --max-steps 10
  python train.py --run v1 --epochs 3
  python train.py --run v2 --resume archlora/adapters/archlora-v1 --epochs 2
  python train.py --eval-only --adapter archlora/adapters/archlora-v1
  python train.py --analyze v1
  python train.py --compare v1 v2 v3
  python train.py --merge archlora/adapters/archlora-v4 --run v4
        """
    )
    p.add_argument("--split-corpus", default=None,  help="Path to combined.jsonl — splits 80/10/10 locally")
    p.add_argument("--run",          default="v1",  help="Run name: v1, v2, smoke ...")
    p.add_argument("--epochs",       type=int, default=DEFAULT_EPOCHS)
    p.add_argument("--max-steps",    type=int, default=0, help="0 = use epochs; >0 = fixed steps")
    p.add_argument("--resume",       default=None,  help="Adapter path to resume from")
    p.add_argument("--eval-only",    action="store_true")
    p.add_argument("--adapter",      default=None,  help="Adapter path for --eval-only")
    p.add_argument("--analyze",      default=None,  help="Analyze failures for a run name")
    p.add_argument("--compare",      nargs="+",     help="Compare multiple run names side by side")
    p.add_argument("--merge",        default=None,  help="Adapter path to merge for deployment")
    return p.parse_args()


def main():
    args = parse_args()

    if args.split_corpus:
        split_corpus(args.split_corpus)
        return

    if args.analyze:
        analyze_failures(args.analyze)
        return

    if args.compare:
        compare_runs(args.compare)
        return

    if args.merge:
        merge_adapter(args.merge, run_name=args.run)
        return

    if args.eval_only:
        if not args.adapter:
            print("--eval-only requires --adapter <path>")
            return
        model, tokenizer = load_base_model(resume_adapter=args.adapter)
        run_eval(model, tokenizer, run_name=Path(args.adapter).name)
        return

    train(args)


if __name__ == "__main__":
    main()