#!/usr/bin/env bash
# Mutation spot-checks for the adversarial matrix (docs/architecture/test-matrix.md, #27).
# Run from the repo root: bash scripts/qa/mutation-spot-check.sh
# Each mutation is applied with sed, the targeted tests run, then the original file is restored.
# Expected: every line except the documented survivors shows failing tests ("killed").
set -u
run() { # id file sed-expr tests...
  local id=$1 file=$2 expr=$3; shift 3
  cp "$file" "$file.bak"
  sed -i "$expr" "$file"
  if cmp -s "$file" "$file.bak"; then echo "$id: MUTATION DID NOT APPLY"; mv "$file.bak" "$file"; return; fi
  local out; out=$(pnpm -s vitest run "$@" 2>&1)
  mv "$file.bak" "$file"
  local summary; summary=$(echo "$out" | grep -E "^\s+Tests " | sed 's/^ *//')
  local killed; killed=$(echo "$out" | grep -E "^\s+×" | sed 's/^ *× //; s/ [0-9]*ms$//' | head -6 | paste -sd';' -)
  echo "$id | $summary | failing: ${killed:-none (SURVIVED)}"
}
E=packages/simulation/src/engine.ts
L=packages/domain/src/ledger.ts
Y=packages/payments/src/paypal.ts
run M1-command-replay-ignored "$E" 's/    return { state, result: prior, duplicate: true, events: \[\] };/    void prior;/' packages/simulation/test/adversarial-matrix.test.ts packages/simulation/test/foundation-fixture.test.ts packages/simulation/test/command-id-policy.test.ts
run M2-provider-dedup-removed "$E" 's/if (tx.s.appliedProviderEvents.includes(ev.providerEventId)) return;/if (false) return;/' packages/simulation/test/adversarial-matrix.test.ts packages/simulation/test/liquidity-and-guards.test.ts packages/simulation/test/pending-payment-invariants.test.ts
run M3-approved-counts-as-success "$Y" 's/      return "PENDING"; \/\/ approved by buyer/      return "SUCCEEDED"; \/\/ approved by buyer/' packages/payments/test/paypal.test.ts
run M4-time-jumps-blockers "$E" 's/      if (tx.s.blocking.length > 0) break; \/\/ never jump/      if (false) break; \/\/ never jump/' packages/simulation/test/foundation-fixture.test.ts packages/simulation/test/adversarial-matrix.test.ts
run M5-imbalance-check-off "$L" 's/    if (off.size > 0) {/    if (false) {/' packages/domain/test/ledger.test.ts packages/simulation/test/adversarial-review.test.ts
run M6-elimination-skips-assets "$L" 's/      if (cls === "ASSET") assets = subtract(assets, side);/      void 0;/' packages/domain/test/adversarial-matrix.test.ts packages/domain/test/eco-021-trace.test.ts
run M7-fingerprint-drops-origin "$E" 's/canonicalJson({ kind: cmd.kind, intent, origin, actorId, worldId: cmd.worldId })/canonicalJson({ kind: cmd.kind, intent, actorId, worldId: cmd.worldId })/' packages/simulation/test/command-id-policy.test.ts
git status --short packages/*/src && echo "sources restored"
