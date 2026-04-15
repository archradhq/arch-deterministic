#!/usr/bin/env python3
"""
archlora/augment.py  (v2 — fixed response parsing)

Augment hand-written corpus pairs using GPT-4o.

Changes from v1:
  - Generates variants in chunks of 5 (not 10) to avoid token truncation
  - Stronger system prompt — GPT-4o must return an array
  - Robust parser — handles single object, wrapped array, direct array
  - --resume works correctly across runs

Usage:
  python augment.py --dry-run
  python augment.py --max-pairs 5 --variants 3   (test run)
  python augment.py --variants 10 --out corpus/augmented.jsonl
  python augment.py --resume --out corpus/augmented.jsonl

Cost estimate:
  130 pairs x 10 variants = 1,300 new pairs ~ $5-10
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

ROOT       = Path(__file__).parent.parent  # packages/deterministic
ROOT = Path(__file__).parent
CORPUS_DIR = ROOT / "corpus"

# ─── Name pools ──────────────────────────────────────────────────────────────

GATEWAY_NAMES = [
    "api-gateway", "web-gateway", "mobile-gateway", "payment-gateway",
    "checkout-gateway", "partner-gateway", "admin-gateway", "edge-gateway",
    "public-api", "rest-api", "graphql-api", "partner-api", "reporting-api",
]

SERVICE_NAMES = [
    "user-service", "order-service", "payment-service", "inventory-service",
    "notification-service", "billing-service", "shipping-service", "catalog-service",
    "fraud-service", "compliance-service", "profile-service", "search-service",
    "recommendation-service", "pricing-service", "fulfillment-service",
    "reporting-service", "analytics-service", "audit-service", "review-service",
    "subscription-service", "account-service", "identity-service", "session-service",
    "cart-service", "tax-service", "ledger-service", "risk-service",
]

DB_NAMES = [
    "user-db", "order-db", "payment-db", "inventory-db", "audit-db",
    "ledger-db", "session-cache", "content-db", "events-table", "archive-db",
    "main-postgres", "analytics-db", "fraud-db", "billing-db", "catalog-db",
    "media-bucket", "report-db", "compliance-db",
]

AUTH_NAMES = [
    "jwt-middleware", "oauth-provider", "keycloak", "okta", "auth0",
    "auth-middleware", "iam-service", "identity-provider", "cognito",
    "saml-provider", "ldap-service",
]

# ─── System prompt (v2 — explicit array requirement) ─────────────────────────

SYSTEM_PROMPT = """You are a training data generator for an architecture governance AI called ArchRad.

You receive one ArchRad training pair and must generate exactly N variants of it.

CRITICAL RULES:
1. You MUST return a JSON array containing exactly N objects. Never return a single object.
2. Each object in the array must have exactly three keys: "instruction", "input", "output".
3. Keep the EXACT same graph structure — same number of nodes, same edge pattern.
4. Keep the EXACT same violation codes and severity values in the output.
5. Only change: node ids and node names (use different service/database names).
6. Keep all node TYPE values identical (gateway stays gateway, database stays database).
7. Keep all edge metadata identical (protocol, auth flags, etc).
8. The output violations must reference the new node ids — not the original ones.
9. Do not add explanations, markdown, or any text outside the JSON array.

Example of correct response format for N=2:
[
  {"instruction": "...", "input": {...}, "output": {...}},
  {"instruction": "...", "input": {...}, "output": {...}}
]"""


def build_user_prompt(pair: dict, n: int, gw: list, svc: list, db: list, auth: list) -> str:
    clean = {k: pair[k] for k in ("instruction", "input", "output") if k in pair}
    return f"""Generate exactly {n} variants of this training pair.
Use these name pools to rename nodes (keep types identical):
- Gateways/APIs: {gw}
- Services: {svc}
- Databases/Datastores: {db}
- Auth nodes: {auth}

Original pair:
{json.dumps(clean, indent=2)}

Return a JSON array of exactly {n} objects. Each object must have instruction, input, output."""


# ─── Response parser (v2 — handles all GPT-4o shapes) ───────────────────────

def parse_response(raw: str, expected_n: int) -> list[dict]:
    """
    Parse GPT-4o response robustly.
    Handles:
      - Direct JSON array: [{...}, {...}]
      - Wrapped array: {"variants": [{...}]} or {"pairs": [{...}]}
      - Single object (fallback): {"instruction":..., "input":..., "output":...}
    """
    parsed = json.loads(raw)

    # Case 1: Already an array
    if isinstance(parsed, list):
        return _validate_pairs(parsed)

    # Case 2: Object wrapping an array
    if isinstance(parsed, dict):
        # Look for any list value that contains valid pairs
        for key, val in parsed.items():
            if isinstance(val, list) and len(val) > 0:
                pairs = _validate_pairs(val)
                if pairs:
                    return pairs

        # Case 3: Single pair object — use it as one variant
        if _is_valid_pair(parsed):
            return [parsed]

    raise ValueError(f"Could not extract pairs from response shape: {type(parsed)}")


def _is_valid_pair(obj: dict) -> bool:
    return (
        isinstance(obj, dict)
        and "instruction" in obj
        and "input" in obj
        and "output" in obj
    )


def _validate_pairs(items: list) -> list[dict]:
    return [item for item in items if _is_valid_pair(item)]


# ─── GPT-4o call (chunked) ───────────────────────────────────────────────────

def call_gpt4o_chunk(pair: dict, n: int, client) -> list[dict]:
    """Call GPT-4o for n variants. n should be <= 5 to avoid truncation."""
    import random

    gw   = random.sample(GATEWAY_NAMES, min(5, len(GATEWAY_NAMES)))
    svc  = random.sample(SERVICE_NAMES, min(8, len(SERVICE_NAMES)))
    db   = random.sample(DB_NAMES,      min(5, len(DB_NAMES)))
    auth = random.sample(AUTH_NAMES,    min(4, len(AUTH_NAMES)))

    prompt = build_user_prompt(pair, n, gw, svc, db, auth)

    response = client.chat.completions.create(
        model    = "gpt-4o",
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": prompt},
        ],
        temperature = 0.8,
        max_tokens  = 4000,
    )

    raw = response.choices[0].message.content.strip()

    # Strip markdown fences if present
    if raw.startswith("```"):
        lines = raw.split("\n")
        raw   = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    return parse_response(raw, n)


def call_gpt4o(pair: dict, total_variants: int, client, chunk_size: int = 5) -> list[dict]:
    """
    Generate total_variants by making multiple chunked calls.
    chunk_size=5 avoids token truncation on complex pairs.
    """
    all_variants = []
    remaining    = total_variants

    while remaining > 0:
        n        = min(chunk_size, remaining)
        variants = call_gpt4o_chunk(pair, n, client)
        all_variants.extend(variants)
        remaining -= n

        # Small delay between chunks to avoid rate limits
        if remaining > 0:
            time.sleep(0.3)

    return all_variants


# ─── Load hand-written corpus ─────────────────────────────────────────────────

def load_handwritten_pairs() -> list[dict]:
    pairs = []
    files = sorted(CORPUS_DIR.glob("corpus-*.json"))

    if not files:
        print(f"ERROR: No corpus-*.json files found in {CORPUS_DIR}")
        print(f"Expected path: {CORPUS_DIR}/corpus-auth-010-pairs.json etc.")
        raise SystemExit(1)

    for f in files:
        try:
            raw = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                for item in raw:
                    if _is_valid_pair(item):
                        item["_source_file"] = f.name
                        pairs.append(item)
        except Exception as e:
            print(f"  WARN: could not read {f.name}: {e}")

    print(f"Loaded {len(pairs)} hand-written pairs from {len(files)} files")
    return pairs


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Augment ArchRad corpus with GPT-4o (v2)")
    parser.add_argument("--variants",   type=int,   default=10,                        help="Variants per pair (default: 10)")
    parser.add_argument("--chunk-size", type=int,   default=5,                         help="Variants per API call (default: 5, reduces truncation)")
    parser.add_argument("--out",        default="corpus/augmented.jsonl",              help="Output JSONL path")
    parser.add_argument("--dry-run",    action="store_true",                           help="Show what would run, no API calls")
    parser.add_argument("--resume",     action="store_true",                           help="Skip pairs already in output file")
    parser.add_argument("--delay",      type=float, default=0.5,                       help="Seconds between pairs (default: 0.5)")
    parser.add_argument("--max-pairs",  type=int,   default=0,                        help="Max pairs to process (0 = all)")
    args = parser.parse_args()

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("ERROR: OPENAI_API_KEY not set.")
        print("  PowerShell: $env:OPENAI_API_KEY = 'sk-...'")
        raise SystemExit(1)

    try:
        from openai import OpenAI
    except ImportError:
        print("ERROR: pip install openai")
        raise SystemExit(1)

    client = OpenAI(api_key=api_key)
    pairs  = load_handwritten_pairs()

    if args.max_pairs > 0:
        pairs = pairs[:args.max_pairs]

    out_path = ROOT / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Resume — load already-processed pair ids
    processed_ids = set()
    if args.resume and out_path.exists():
        existing = [
            json.loads(l)
            for l in out_path.read_text(encoding="utf-8").splitlines()
            if l.strip()
        ]
        processed_ids = {e.get("_source_id") for e in existing if e.get("_source_id")}
        print(f"Resuming: {len(processed_ids)} pairs already done")

    if args.dry_run:
        print(f"\nDRY RUN")
        print(f"  Pairs to process: {len(pairs)}")
        print(f"  Variants each:    {args.variants}")
        print(f"  Chunk size:       {args.chunk_size} (calls per pair: {-(-args.variants // args.chunk_size)})")
        print(f"  Estimated output: ~{len(pairs) * args.variants} pairs")
        print(f"  Output:           {out_path}")
        print(f"\nRun without --dry-run to execute.")
        return

    total_generated = 0
    total_failed    = 0
    start           = time.time()

    calls_per_pair = -(-args.variants // args.chunk_size)  # ceiling division
    print(f"\nAugmenting {len(pairs)} pairs x {args.variants} variants ({calls_per_pair} API call(s) per pair)...")
    print(f"Output: {out_path}\n")

    with open(out_path, "a" if args.resume else "w", encoding="utf-8") as f:
        for i, pair in enumerate(pairs):
            pair_id = pair.get("id", f"pair-{i}")

            if pair_id in processed_ids:
                print(f"  [{i+1}/{len(pairs)}] {pair_id} — skipped")
                continue

            try:
                variants = call_gpt4o(pair, args.variants, client, chunk_size=args.chunk_size)

                written = 0
                for j, variant in enumerate(variants):
                    line = json.dumps({
                        "instruction":  variant["instruction"],
                        "input":        variant["input"],
                        "output":       variant["output"],
                        "_source_id":   pair_id,
                        "_source_file": pair.get("_source_file", ""),
                        "_variant_idx": j,
                    })
                    f.write(line + "\n")
                    written += 1

                total_generated += written
                elapsed = time.time() - start
                rate    = total_generated / (elapsed / 60) if elapsed > 0 else 0
                print(f"  [{i+1}/{len(pairs)}] {pair_id} → {written} variants  "
                      f"(total: {total_generated}, {rate:.0f}/min)")

            except Exception as e:
                total_failed += 1
                print(f"  [{i+1}/{len(pairs)}] {pair_id} → FAILED: {e}")

            time.sleep(args.delay)

    elapsed = time.time() - start
    print(f"\n{'='*50}")
    print(f"Augmentation complete")
    print(f"  Generated: {total_generated} pairs")
    print(f"  Failed:    {total_failed} pairs")
    print(f"  Time:      {elapsed/60:.1f} minutes")
    print(f"  Output:    {out_path}")

    if total_failed > 0:
        print(f"\n  To retry failed pairs:")
        print(f"  python augment.py --resume --out {args.out}")

    print(f"\nNext steps:")
    print(f"  1. node scripts/combine-corpus.mjs")
    print(f"  2. python train.py --split-corpus corpus/combined.jsonl")


if __name__ == "__main__":
    main()