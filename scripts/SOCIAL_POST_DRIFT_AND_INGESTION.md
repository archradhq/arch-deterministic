# Draft reply: drift + “where does the IR come from?”

Use as a Reddit (or similar) follow-up after the drift thread. Trim voice to match your account.

---

**On drift:** The enforcement story is not “hope people read the docs.” It’s **gate the blueprint artifact**. You run **`archrad validate`** on the **IR** in CI (or pre-commit): the linter fires on the graph — e.g. **`IR-LINT-DIRECT-DB-ACCESS-002`** when an HTTP node talks straight to a datastore — **before** you generate or ship code. The fix is **an edit to the IR** (introduce a service layer, health route, etc.), then the gate passes. Same loop you’d want for any contract-first workflow: **blueprint in → violation found → fix on the graph → gate passes**. No generated-code diff required for that 30-second story.

**On “where does the IR come from?”** Fair question for any real team. Today the honest answer is **multiple on-ramps**: hand-authored JSON/YAML graph, **`archrad yaml-to-ir`**, and **`archrad ingest openapi`** (OpenAPI 3.x → HTTP-shaped IR — structural surface, not full system semantics). **That ingestion path is the part we’re actively building out** (OpenAPI, and toward **IaC / other specs** as inputs), with **manual IR** as the **starting point**, not the end state. Stating that clearly tends to turn “but where does IR come from?” into **someone following the journey** instead of **blocking on a strawman permanent end state**.

---

Optional one-liner for the post body: *IR from OpenAPI ingest + YAML graph today; more ingestion sources in progress — validate runs on whatever lands in the repo as the blueprint.*

---

**Internal / roadmap:** OSS **`archrad validate-drift`** and Cloud **`POST /api/v1/deterministic/drift-check`** are the **thin** deterministic drift checks; dashboard KPI + **SYNC** remain roadmap — **`docs/PHASE_B_C_DRIFT_AND_OSS_REGEN.md`**.
