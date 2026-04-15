#!/usr/bin/env python3
"""
archlora/scrape_adrs.py  (v4)

Scrapes Architecture Decision Records from permissively licensed public
GitHub repos, converts to ArchRad IR training pairs via GPT-4o.

Changes from v3:
  - Focused on government digital service orgs (UK GDS, US USDC, Canada CDS)
    and known enterprise ADR publishers — much higher signal-to-noise
  - Removed broad generic queries that produced mostly noise
  - Relaxed GPT minimum from 3 nodes + 2 edges → 3 nodes + 1 edge
  - Added second GPT pass with simplified prompt for ADRs that fail first pass
  - Attribution file enabled by default

Usage:
  python scrape_adrs.py --dry-run --max-adrs 100
  python scrape_adrs.py --max-adrs 500
  python scrape_adrs.py --resume --max-adrs 1000

Requirements:
  pip install openai requests

Environment:
  GITHUB_TOKEN   — GitHub personal access token (public_repo scope)
  OPENAI_API_KEY — OpenAI API key
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
import hashlib
from pathlib import Path
from typing import Optional

ROOT       = Path(__file__).parent.parent
CORPUS_DIR = ROOT / "archlora" / "corpus"
CACHE_DIR  = ROOT / "archlora" / ".adr-cache"

# ─── License allowlist ────────────────────────────────────────────────────────

PERMISSIVE_LICENSES = frozenset({
    "MIT",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "Unlicense",
    "CC-BY-4.0",
    "CC-BY-3.0",
    "CC0-1.0",
    "0BSD",
    "BlueOak-1.0.0",
    # CC-BY-SA-4.0 excluded by default (ShareAlike)
})

ATTRIBUTION_HEADER = """# Third-party ADR sources — archlora/scrape_adrs.py v4
# ADR text is not stored in training pairs; GPT-4o converts to IR graphs.
# Retain with distributed corpus for license attribution obligations.

"""

# ─── Search queries v4 ────────────────────────────────────────────────────────
# Focused on government digital services and known enterprise ADR publishers.
# These orgs consistently publish permissive-licensed ADRs with real topology.

SEARCH_QUERIES = [
    # UK Government Digital Service and related
    "org:alphagov path:docs/architecture/decisions extension:md",
    "org:alphagov path:adr extension:md",
    "org:communitiesuk path:docs/decisions extension:md",
    "org:ministryofjustice path:docs/architecture/decisions extension:md",
    "org:ministryofjustice path:adr extension:md",
    "org:dwp-health path:docs/adr extension:md",
    "org:MHCLG path:docs/adr extension:md",
    "org:hmrc path:docs/adr extension:md",
    "org:ukhomeoffice path:docs/adr extension:md",

    # US Government / Civic Tech
    "org:18F path:docs/adr extension:md",
    "org:18F path:decisions extension:md",
    "org:trussworks path:docs/adr extension:md",
    "org:navapbc path:docs/decisions extension:md",
    "org:department-of-veterans-affairs path:docs/adr extension:md",
    "org:cds-snc path:docs/adr extension:md",
    "org:usdigitalservice path:docs/adr extension:md",

    # Canada / Australia Government
    "org:cds-snc path:adr extension:md",
    "org:govau path:docs/adr extension:md",
    "org:AusDTO path:docs/adr extension:md",

    # Confirmed high-yield from v2/v3
    "org:microsoft path:docs/adr extension:md status",
    "org:github path:docs/adr extension:md decision",

    # Known enterprise ADR publishers (confirmed permissive)
    "org:eclipse-cdt-cloud path:doc/adr extension:md",
    "org:fogfish path:doc/adr extension:md",
    "org:BrighterCommand path:doc/adr extension:md",
    "org:FormulaMonks path:architecture/decisions extension:md",
    "org:Kaikei-e path:doc/adr extension:md",
    "org:ruvnet path:adr extension:md",

    # ThoughtWorks and consulting firms
    "org:thoughtworks-studios path:docs/adr extension:md",
    "org:pivotal path:docs/adr extension:md",

    # Financial / Fintech with permissive licenses
    "org:gocardless path:docs/adr extension:md",
    "org:monzo path:docs/adr extension:md",
    "org:stripe path:docs/adr extension:md",

    # Cloud-native and infrastructure ADRs
    "path:docs/adr extension:md status accepted microservice api gateway authentication",
    "path:docs/adr extension:md status accepted database cache queue kafka",
    "path:docs/adr extension:md status accepted kubernetes deployment service",
    "path:doc/adr extension:md status accepted service api database auth",
    "path:architecture/decisions extension:md status accepted api service database",
]

# ─── Skip list ────────────────────────────────────────────────────────────────

SKIP_FILENAMES = frozenset({
    "index.md", "readme.md", "adrs.md", "decisions.md",
    "adr.md", "overview.md", "template.md", "toc.md",
    "0000-adr-template.md", "0000-record-architecture-decisions.md",
    "0000-template.md", "adr-template.md", "adr_template.md",
    "adr-000-template.md", "000-template.md", "_template.md",
    "adr-0000-template.md", "0001-record-architecture-decisions.md",
})

# ─── GPT-4o prompts ───────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are an expert software architect converting Architecture Decision Records (ADRs) into ArchRad IR graphs for AI training.

ArchRad IR format:
{
  "graph": {
    "nodes": [
      {
        "id": "kebab-case-id",
        "type": "gateway|api|bff|service|database|postgres|mongodb|redis|queue|kafka|auth|oauth|jwt|http",
        "name": "Display Name",
        "config": {
          "url": "/health",
          "method": "GET",
          "authRequired": true
        }
      }
    ],
    "edges": [
      {
        "from": "node-id",
        "to": "node-id",
        "metadata": { "protocol": "https|grpc|tcp|async", "async": false }
      }
    ]
  }
}

Node types:
- gateway/api/bff: HTTP entry points, API gateways, BFF layer
- service: backend microservices or domain services
- database/postgres/mongodb/mysql: relational or document stores
- redis/cache: caching layers
- queue/kafka/sqs/rabbitmq: message brokers
- auth/oauth/jwt/keycloak: authentication services
- http: generic HTTP endpoint nodes

Valid violation codes (ONLY these exact strings):
IR-LINT-SYNC-CHAIN-001, IR-LINT-DIRECT-DB-ACCESS-002, IR-LINT-NO-HEALTHCHECK-003,
IR-LINT-HIGH-FANOUT-004, IR-LINT-ISOLATED-NODE-005, IR-LINT-DUPLICATE-EDGE-006,
IR-LINT-HTTP-MISSING-NAME-007, IR-LINT-DATASTORE-NO-INCOMING-008,
IR-LINT-MULTIPLE-HTTP-ENTRIES-009, IR-LINT-MISSING-AUTH-010, IR-LINT-DEAD-NODE-011

RULES:
1. Return ONLY a JSON object with keys "ir" and "violations"
2. "ir" must be a valid IR graph with at least 3 nodes and at least 1 edge
3. "violations" = array of { code, severity: "warning", message, nodeId? }
4. If fewer than 3 distinct architectural components exist, return {"ir": null, "violations": []}
5. Be creative — infer reasonable IR even if the ADR is not explicit about all connections
6. No markdown, no explanation outside the JSON"""

SIMPLIFIED_PROMPT = """Convert this Architecture Decision Record to an ArchRad IR graph.
Be generous — if 3 or more software components are mentioned (services, databases, APIs,
caches, queues, auth systems), build a graph connecting them.

Return ONLY JSON: {"ir": <graph or null>, "violations": [...]}

ArchRad IR: { "graph": { "nodes": [{"id":"x","type":"service|database|gateway|queue|auth|redis|api","name":"X"}], "edges": [{"from":"x","to":"y"}] } }

Violations: use only these codes if applicable:
IR-LINT-MISSING-AUTH-010, IR-LINT-DIRECT-DB-ACCESS-002, IR-LINT-NO-HEALTHCHECK-003,
IR-LINT-HIGH-FANOUT-004, IR-LINT-SYNC-CHAIN-001, IR-LINT-DATASTORE-NO-INCOMING-008"""


def build_prompt(content: str, repo: str, filename: str) -> str:
    truncated = content[:3500] if len(content) > 3500 else content
    return f"""Convert this ADR to an ArchRad IR graph and identify violations.

Source: {repo} / {filename}

---
{truncated}
---

Return: {{"ir": <graph or null>, "violations": [...]}}"""


def build_simple_prompt(content: str) -> str:
    truncated = content[:2000] if len(content) > 2000 else content
    return f"""ADR content:
---
{truncated}
---

List every software component mentioned (services, APIs, databases, caches, queues, auth).
Then build an IR graph connecting them.
Return: {{"ir": <graph>, "violations": []}}"""


# ─── GitHub API ───────────────────────────────────────────────────────────────

def gh_headers(token: str) -> dict:
    return {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def gh_get(url: str, token: str, params: dict = None, retries: int = 3) -> Optional[dict]:
    import requests
    for attempt in range(retries):
        try:
            resp = requests.get(
                url, headers=gh_headers(token), params=params, timeout=15
            )
        except Exception as e:
            print(f"  Network error: {e}")
            time.sleep(3)
            continue

        if resp.status_code == 403:
            reset = int(resp.headers.get("X-RateLimit-Reset", time.time() + 61))
            wait  = max(reset - int(time.time()), 10)
            print(f"  Rate limited — waiting {wait}s...")
            time.sleep(wait)
            continue

        if resp.status_code == 422:
            return None

        if resp.status_code not in (200, 201):
            if attempt < retries - 1:
                time.sleep(3)
                continue
            return None

        return resp.json()

    return None


def search_code(query: str, token: str, page: int = 1) -> list[dict]:
    result = gh_get(
        "https://api.github.com/search/code",
        token,
        params={"q": query, "per_page": 30, "page": page},
    )
    return result.get("items", []) if result else []


def fetch_repo_license(repo_full_name: str, token: str) -> tuple[Optional[str], Optional[str]]:
    cache_key  = hashlib.md5(f"license:{repo_full_name}".encode()).hexdigest()
    cache_file = CACHE_DIR / f"{cache_key}.json"

    if cache_file.exists():
        data = json.loads(cache_file.read_text())
        return data.get("spdx_id"), data.get("license_sha256")

    result = gh_get(f"https://api.github.com/repos/{repo_full_name}/license", token)

    spdx_id        = None
    license_sha256 = None
    if result:
        spdx_id = result.get("license", {}).get("spdx_id")
        b64     = result.get("content")
        if b64 and result.get("encoding") == "base64":
            import base64
            try:
                raw            = base64.b64decode(b64)
                license_sha256 = hashlib.sha256(raw).hexdigest()
            except Exception:
                pass

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps({"spdx_id": spdx_id, "license_sha256": license_sha256}))
    return spdx_id, license_sha256


def fetch_file_content(url: str, token: str) -> Optional[str]:
    cache_key  = hashlib.md5(url.encode()).hexdigest()
    cache_file = CACHE_DIR / f"{cache_key}.txt"

    if cache_file.exists():
        return cache_file.read_text(encoding="utf-8")

    data = gh_get(url, token)
    if not data:
        return None

    if data.get("encoding") == "base64":
        import base64
        try:
            text = base64.b64decode(data["content"]).decode("utf-8", errors="replace")
        except Exception:
            return None
    else:
        text = data.get("content", "")

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(text, encoding="utf-8")
    return text

# ─── Quality filter ───────────────────────────────────────────────────────────

ARCH_KEYWORDS = [
    "service", "gateway", "api", "database", "cache", "queue", "kafka",
    "auth", "microservice", "component", "system", "integration", "event",
    "message", "broker", "proxy", "load.?balanc", "storage", "redis",
    "postgres", "mongodb", "elasticsearch", "grpc", "rest", "http",
    "endpoint", "container", "kubernetes", "docker", "deployment", "cdn",
]

ADR_STRUCTURE_PATTERNS = [
    r'##\s*(status|context|decision|consequences|rationale)',
    r'\*\*status\*\*',
    r'status:\s*(accepted|proposed|deprecated|superseded)',
    r'##\s*decision\s*[\n\r]',
    r'#\s*decision\s*[\n\r]',
]


def is_quality_adr(filename: str, content: str) -> tuple[bool, str]:
    if filename.lower() in SKIP_FILENAMES:
        return False, "table-of-contents filename"

    if len(content) < 400:
        return False, f"too short ({len(content)} chars)"

    content_lower = content.lower()

    has_structure = any(re.search(p, content_lower) for p in ADR_STRUCTURE_PATTERNS)
    if not has_structure:
        return False, "no ADR structure"

    keyword_hits = [kw for kw in ARCH_KEYWORDS if re.search(kw, content_lower)]
    if len(keyword_hits) < 3:
        return False, f"too few architecture keywords ({len(keyword_hits)})"

    return True, "ok"

# ─── GPT-4o conversion ────────────────────────────────────────────────────────

VALID_CODES = frozenset({
    "IR-LINT-SYNC-CHAIN-001", "IR-LINT-DIRECT-DB-ACCESS-002",
    "IR-LINT-NO-HEALTHCHECK-003", "IR-LINT-HIGH-FANOUT-004",
    "IR-LINT-ISOLATED-NODE-005", "IR-LINT-DUPLICATE-EDGE-006",
    "IR-LINT-HTTP-MISSING-NAME-007", "IR-LINT-DATASTORE-NO-INCOMING-008",
    "IR-LINT-MULTIPLE-HTTP-ENTRIES-009", "IR-LINT-MISSING-AUTH-010",
    "IR-LINT-DEAD-NODE-011",
})


def parse_gpt_response(raw: str) -> Optional[dict]:
    parsed     = json.loads(raw)
    ir         = parsed.get("ir")
    violations = parsed.get("violations", [])

    if not ir or not isinstance(ir, dict):
        return None

    nodes = ir.get("graph", {}).get("nodes", [])
    edges = ir.get("graph", {}).get("edges", [])

    # v4: relaxed to 3 nodes + 1 edge (was 3 + 2)
    if len(nodes) < 3 or len(edges) < 1:
        return None

    clean_violations = [
        v for v in violations
        if isinstance(v, dict) and v.get("code") in VALID_CODES
    ]

    return {
        "instruction": "Given this IR graph derived from an Architecture Decision Record, what architecture violations exist?",
        "input":       ir,
        "output":      {"violations": clean_violations},
    }


def convert_to_pair(content: str, repo: str, filename: str, client) -> Optional[dict]:
    """First pass — full prompt."""
    try:
        resp = client.chat.completions.create(
            model           = "gpt-4o",
            messages        = [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user",   "content": build_prompt(content, repo, filename)},
            ],
            temperature     = 0.3,
            max_tokens      = 2000,
            response_format = {"type": "json_object"},
        )
        return parse_gpt_response(resp.choices[0].message.content.strip())
    except Exception:
        return None


def convert_to_pair_simple(content: str, client) -> Optional[dict]:
    """Second pass — simplified prompt for ADRs that failed the first pass."""
    try:
        resp = client.chat.completions.create(
            model           = "gpt-4o",
            messages        = [
                {"role": "system", "content": SIMPLIFIED_PROMPT},
                {"role": "user",   "content": build_simple_prompt(content)},
            ],
            temperature     = 0.5,
            max_tokens      = 1500,
            response_format = {"type": "json_object"},
        )
        return parse_gpt_response(resp.choices[0].message.content.strip())
    except Exception:
        return None

# ─── Attribution ──────────────────────────────────────────────────────────────

def append_attribution(fp, *, license_id, repo, filename, source_url, license_sha256):
    fp.write("---\n")
    fp.write(f"SPDX-License-Identifier: {license_id}\n")
    fp.write(f"Repository: {repo}\n")
    fp.write(f"File: {filename}\n")
    fp.write(f"Source: {source_url}\n")
    if license_sha256:
        fp.write(f"License-file-SHA256: {license_sha256}\n")
    fp.write("\n")

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="ADR scraper v4")
    parser.add_argument("--max-adrs",        type=int,   default=500)
    parser.add_argument("--out",                         default="archlora/corpus/adr-scraped.jsonl")
    parser.add_argument("--dry-run",         action="store_true")
    parser.add_argument("--resume",          action="store_true")
    parser.add_argument("--delay",           type=float, default=1.0)
    parser.add_argument("--gpt-delay",       type=float, default=0.5)
    parser.add_argument("--no-second-pass",  action="store_true", help="Skip simplified GPT retry")
    parser.add_argument("--no-attribution",  action="store_true")
    args = parser.parse_args()

    github_token = os.getenv("GITHUB_TOKEN")
    openai_key   = os.getenv("OPENAI_API_KEY")

    if not github_token:
        print("ERROR: GITHUB_TOKEN not set.\n  $env:GITHUB_TOKEN = 'ghp_...'")
        raise SystemExit(1)
    if not openai_key and not args.dry_run:
        print("ERROR: OPENAI_API_KEY not set.\n  $env:OPENAI_API_KEY = 'sk-...'")
        raise SystemExit(1)

    try:
        import requests
    except ImportError:
        print("ERROR: pip install requests")
        raise SystemExit(1)

    client = None
    if not args.dry_run:
        try:
            from openai import OpenAI
            client = OpenAI(api_key=openai_key)
        except ImportError:
            print("ERROR: pip install openai")
            raise SystemExit(1)

    out_path = ROOT / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)

    att_path = None
    if not args.no_attribution and not args.dry_run:
        att_path = out_path.parent / f"{out_path.stem}.attribution.txt"

    # Resume
    processed_urls = set()
    if args.resume and out_path.exists():
        for line in out_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    obj = json.loads(line)
                    if obj.get("_source_url"):
                        processed_urls.add(obj["_source_url"])
                except Exception:
                    pass
        print(f"Resuming: {len(processed_urls)} already done")

    print(f"\nADR scraper v4")
    print(f"  Max ADRs:     {args.max_adrs}  |  Dry run: {args.dry_run}")
    print(f"  Second pass:  {not args.no_second_pass}")
    print(f"  Queries:      {len(SEARCH_QUERIES)}")
    print(f"  Output:       {out_path}")
    if att_path:
        print(f"  Attribution:  {att_path}")
    print()

    seen_urls     = set(processed_urls)
    total_found   = 0
    total_license = 0
    total_passed  = 0
    total_pairs   = 0
    total_skip    = 0
    total_retry   = 0
    start         = time.time()

    att_f = None
    if att_path:
        att_path.parent.mkdir(parents=True, exist_ok=True)
        att_mode = "a" if args.resume and att_path.exists() else "w"
        att_f    = open(att_path, att_mode, encoding="utf-8")
        if att_path.stat().st_size == 0:
            att_f.write(ATTRIBUTION_HEADER)

    try:
        with open(out_path, "a" if args.resume else "w", encoding="utf-8") as f:
            for qi, query in enumerate(SEARCH_QUERIES):
                if total_found >= args.max_adrs:
                    break

                print(f"\nQuery [{qi+1}/{len(SEARCH_QUERIES)}]: {query}")

                for page in range(1, 5):
                    if total_found >= args.max_adrs:
                        break

                    items = search_code(query, github_token, page=page)
                    if not items:
                        break

                    for item in items:
                        if total_found >= args.max_adrs:
                            break

                        url      = item.get("url", "")
                        repo     = item.get("repository", {}).get("full_name", "?")
                        filename = item.get("name", "")

                        if url in seen_urls:
                            continue
                        seen_urls.add(url)
                        total_found += 1

                        # License check
                        license_id, license_sha = fetch_repo_license(repo, github_token)
                        if license_id not in PERMISSIVE_LICENSES:
                            total_license += 1
                            print(f"  [{total_found}] {repo}/{filename} — license={license_id or 'none'}")
                            time.sleep(0.3)
                            continue

                        # Fetch content
                        content = fetch_file_content(url, github_token)
                        if not content:
                            print(f"  [{total_found}] {repo}/{filename} — fetch failed")
                            continue

                        # Quality filter
                        ok, reason = is_quality_adr(filename, content)
                        if not ok:
                            print(f"  [{total_found}] {repo}/{filename} — filtered: {reason}")
                            continue

                        total_passed += 1

                        if args.dry_run:
                            kws = [kw for kw in ARCH_KEYWORDS if re.search(kw, content.lower())]
                            print(f"  [{total_found}] ✓ {repo}/{filename} ({license_id}) — {len(content)} chars, kw: {kws[:5]}")
                            continue

                        # GPT first pass
                        pair = convert_to_pair(content, repo, filename, client)

                        # GPT second pass (simplified prompt)
                        if pair is None and not args.no_second_pass:
                            time.sleep(args.gpt_delay)
                            pair = convert_to_pair_simple(content, client)
                            if pair is not None:
                                total_retry += 1

                        if pair is None:
                            total_skip += 1
                            print(f"  [{total_found}] {repo}/{filename} — skipped (both passes)")
                        else:
                            row = {
                                "instruction":  pair["instruction"],
                                "input":        pair["input"],
                                "output":       pair["output"],
                                "_source_url":  url,
                                "_source_repo": repo,
                                "_source_file": filename,
                                "_license":     license_id,
                            }
                            if license_sha:
                                row["_license_sha256"] = license_sha
                            f.write(json.dumps(row) + "\n")

                            if att_f:
                                append_attribution(
                                    att_f,
                                    license_id     = license_id,
                                    repo           = repo,
                                    filename       = filename,
                                    source_url     = url,
                                    license_sha256 = license_sha,
                                )

                            total_pairs += 1
                            elapsed = time.time() - start
                            rate    = total_pairs / (elapsed / 60) if elapsed > 0 else 0
                            vcount  = len(pair["output"].get("violations", []))
                            retry   = " [retry]" if total_retry > 0 and pair is not None else ""
                            print(f"  [{total_found}] ✓ {repo}/{filename} ({license_id}) — {vcount} violations  (pairs: {total_pairs}, {rate:.0f}/min){retry}")

                        time.sleep(args.gpt_delay)

                    time.sleep(args.delay)

    finally:
        if att_f:
            att_f.close()

    elapsed = time.time() - start
    print(f"\n{'='*50}")
    print(f"ADR scraper v4 complete")
    print(f"  ADRs fetched:        {total_found}")
    print(f"  Skipped (license):   {total_license}")
    print(f"  Passed quality:      {total_passed}")
    if not args.dry_run:
        print(f"  Pairs generated:     {total_pairs}")
        print(f"  Saved by retry:      {total_retry}")
        print(f"  Skipped (both):      {total_skip}")
    print(f"  Time:                {elapsed/60:.1f} min")
    print(f"  Output:              {out_path}")
    if att_path and not args.dry_run:
        print(f"  Attribution:         {att_path}")
    if not args.dry_run and total_pairs > 0:
        print(f"\nNext:")
        print(f"  node scripts/combine-corpus.mjs")
        print(f"  python archlora/train.py --split-corpus archlora/corpus/combined.jsonl")


if __name__ == "__main__":
    main()