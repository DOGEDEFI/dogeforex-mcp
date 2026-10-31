# IMF agent-ready MCP

`@dogeforex/mcp` is the local Model Context Protocol server for the
**International Money Foundry (IMF)**. It gives agents verified V2 reads and
exact, non-executable planning through `@dogeforex/sdk/v2` across the 12
configured DogeOS Chikyū testnet currencies. No private key is needed for V2.

Two deliberately separate protocol paths remain:

- **Protocol V2:** 14 advertised read/plan tools, exact units, source-block
  provenance, and no signer, transaction simulation, writes, keeper, or
  guardian/bootstrap compatibility layer.
- **Legacy V1:** the original registry, guardian/bootstrap reads, fee model, and
  signer/write tools remain available separately. Its
  `dogeforex.registry/v2` schema label is a legacy registry-schema version; it
  does **not** mean protocol V2.

The SDK is linked from `../dogeforex-sdk-ts` and imported from its built `dist`.
Synthetic fixtures and mocked RPC in the default tests are not live deployment
verification; the opt-in V2 live suite below uses the real testnet registry.

## Agent-ready V2 quickstart

Use Node 22 and keep `dogeforex-sdk-ts`, `dogeforex-mcp`, and
`dogeforex-protocol` as sibling directories. Build the SDK first, then verify
and build the MCP server:

```sh
cd dogeforex-sdk-ts
npm install
npm run build

cd ../dogeforex-mcp
npm install
npm run typecheck
npm test
npm run build
```

Add this to an MCP client, replacing only the absolute package path:

```json
{
  "mcpServers": {
    "imf": {
      "command": "npm",
      "args": [
        "--prefix",
        "/absolute/path/to/dogeforex-mcp",
        "run",
        "start:v2"
      ]
    }
  }
}
```

The client launches the server over **stdio**. `start:v2` selects
`../dogeforex-protocol/scripts/deployment/deployments/chikyuV2` and
`https://rpc.testnet.dogeos.com`, loading all 12 actual V2 artifacts with no
signer environment variables. This is a local MCP server, not a hosted remote
endpoint. All diagnostics go to **stderr**; stdout carries MCP.

Useful first prompts:

1. `Use v2_verify for USD and CHF. Report the chain, source block, and any failed check.`
2. `Use list_instances to compare all 12 systems in native units. Do not total unlike currencies.`
3. `Use v2_savings for CHF and explain the current and next rate without treating it as a quote.`
4. `Use position_state for this explicit position address and preserve unknown eligibility as unknown.`

During MCP initialization the server supplies instructions covering verification,
exact raw integers, source blocks, independent currency systems, read health,
and the read-only authority boundary. Only the 14 V2 read/plan tools are
advertised; legacy write and log-enumeration tools are not registered for V2.

## Custom registry configuration

For another registry or RPC, run `node dist/index.js` with explicit environment
variables instead of `start:v2`:

```json
{
  "mcpServers": {
    "imf-custom": {
      "command": "node",
      "args": ["/absolute/path/to/dogeforex-mcp/dist/index.js"],
      "env": {
        "DOGEOS_REGISTRY_PATH": "/absolute/path/to/USD_V2Registry.json",
        "DOGEOS_RPC_URL": "https://rpc.example.invalid"
      }
    }
  }
}
```

Replace the example RPC with the endpoint for the registry's actual network.
The server checks the registry network key and chain ID independently; a matching
chain ID alone never identifies protocol V2. Running `node dist/index.js`
without `DOGEOS_REGISTRY_PATH` preserves the legacy V1 default.

## Registry configuration

| Variable | Default | Purpose |
|---|---|---|
| `DOGEOS_RPC_URL` | `https://rpc.testnet.dogeos.com` | JSON-RPC endpoint; must match the selected registry chain |
| `DOGEOS_REGISTRY_PATH` | `../dogeforex-protocol/deployments/k9usd.chikyu.json` (cwd-relative) | Legacy default, or an explicitly supplied protocol-V2 source |
| `DOGEFOREX_DEPLOYER_KEY` | — | Legacy deployer signer only |
| `DOGEFOREX_TREASURY_KEY` | — | Legacy signer for `mint`, `open_position` |
| `DOGEFOREX_GUARDIAN_KEY` | — | Legacy signer for the three guardian tools |
| `DOGEFOREX_BOT_KEY` | — | Legacy signer for `launch_challenge`, `place_bid` |
| `DOGEFOREX_BASELINE_TOTAL` | — | Optional legacy total-L1-fee baseline in DOGE |

The legacy default behavior is unchanged. An explicit V2 path can be:

1. one deployer artifact containing `linkedData`;
2. a bare `linkedData` JSON object;
3. an array of V2 artifacts; or
4. a directory, from which the SDK loads only `*_V2Registry.json`.

V2 loading uses `detectProtocolRegistry`, `parseV2Registry`, and the Node
`loadProtocolRegistry` API. Staged subsets are supported: requests are limited to
the currency codes actually present. Missing files, empty directories, mixed or
invalid artifacts, and unknown formats produce errors describing both legacy and
V2 input forms. A V1 registry is never substituted for V2.

**Signer envs are never needed or validated for V2 reads.** They are parsed only
on the legacy path. Legacy keys must be `0x`-prefixed 64-character hex, are never
logged or returned, and error messages defensively redact key-shaped strings.

## V2 output contract

Every V2 snapshot includes its source block. Calls within an SDK snapshot are
pinned to that block; different module snapshots in `list_instances` and
`instance_state` each carry their own source block. Failed reads, wrong chains,
missing bytecode, malformed responses, and link mismatches remain errors—they
are not converted to zero balances or successful checks.

Read tools return:

- `snapshot`: the SDK model with every bigint represented as a raw integer
  string;
- `formatted`: exact human views, generally
  `{ "raw": "1000000", "value": "1.0", "decimals": 6, "unit": "sUSDC" }`;
- `sourceBlock`: number, hash, raw Unix timestamp, and ISO timestamp;
- `transactionSimulation: "not_performed"`; and
- protocol generation, network key, chain ID, and currency code where applicable.

No raw money, price, quote, vote, or bridge capacity is converted through
`Number`. Amount inputs are unsigned human decimal strings. Scientific notation,
signs, malformed values, and excess precision are rejected. Seconds, absolute
timestamps, challenge indices, and raw PPM inputs are decimal integer strings.

| Value | Exact unit used by V2 tools |
|---|---|
| Local token supply, debt, gross/usable mint, repayment, opening fee | 18 decimals; local token symbol |
| Position collateral balance/minimum/challenged/withdrawal | Position collateral's actual decimals and symbol |
| Liquidation, challenge, and expired-purchase prices | `36 - collateralDecimals` decimals; local per whole collateral |
| Equity shares and share price | 18 decimals; price is local per share |
| Savings balances/interest and equity investment/proceeds | Local 18-decimal units |
| PPM fields | Raw millionths; formatted `value` is percent (`20000` -> `2.0`) |
| Source bridge amounts, balances, allowances, and credits | Source token's actual decimals and symbol |
| Bridge limit/minted/capacity/burn/remainder | Local 18-decimal units |
| Governance votes | Time-weighted 18-decimal units; relative votes also have raw form |
| Cooldowns, durations, deadlines, expiry, horizon | Unix seconds; absolute times also include ISO form |

`eligible` and caller-dependent funding/approval fields can be `true`, `false`,
or `null`. Omitting a caller makes caller-dependent checks **unknown** (`null`);
it never implies authorization. Eligibility is derived from view reads, not from
a nonpersistent transaction simulation, signing, or an execution guarantee.

## V2 read tools

The three existing instance/position tools support V2 directly. New V2-specific
tools use a `v2_` prefix so legacy method semantics remain separate.

| Tool | Required arguments | Optional arguments | Purpose |
|---|---|---|---|
| `list_instances` | — | — | Current token, five-minter, source bridge, savings, and equity reads for every supplied instance; deployment evidence is separate |
| `instance_state` | `code` | — | Contracts and the same current module reads for one instance, plus constructor/transaction/postcondition evidence |
| `position_state` | `code`, `positionAddress` | `caller`, `recipient`, `grossAmount` or `usableAmount` | Position state, expiry/expired price, exact collateral units, mint quote, and complete eligibility |
| `v2_verify` | `code` | — | Chain ID, bytecode, metadata, source decimals, and cross-contract link verification |
| `v2_new_position` | `code`, `caller`, `collateralToken`, `collateralDecimals`, `minCollateral`, `initialCollateral`, `mintingMaximum`, `initPeriodSeconds`, `durationSeconds`, `challengePeriodSeconds`, `riskPremiumPPM`, `liquidationPrice`, `reserveContributionPPM` | `plannedMintAmount` | All `openPosition` terms, static issues/bounds, opening-fee/collateral funding, illustrative quote, and separately scoped planned-mint review |
| `v2_clone_position` | `code`, `parent`, `collateralFunder`, `childOwner`, `initialCollateral`, `initialMint`, `expiration` | — | Inherited parent terms, funder/owner funding, original family capacity, and absolute child-expiration quote |
| `v2_position_mint` | `code`, `position` | `caller`, `recipient`, `grossAmount` or `usableAmount` | Existing-position mint state and exact forward/inverse quote with full eligibility |
| `v2_repayment` | `code`, `position` | `caller`, `amount` | Wallet payment versus gross-debt reduction, assigned reserve, funding, and roller full candidate |
| `v2_withdrawal` | `code`, `position`, `amount` | `caller` | Exact collateral withdrawal, post-withdrawal backing, and closure state; separate from repayment |
| `v2_challenge` | `code`, `challengeIndex` | — | One explicit challenge record, size/price, first-phase deadline and active flag |
| `v2_bridge` | `code` | `account`, `mintSourceAmount` or `burnLocalAmount`, `credit` | Source/local bridge state, cap/horizon/credits, funding, and mint/burn plan |
| `v2_savings` | `code` | `account` | Current/next rates, clocks, ticks, interest, deposit acceptance, and lock state |
| `v2_equity` | `code` | `account`, `investment`, `redemptionShares` | Share price/supply, holding/redemption state, investment and redemption view quotes |
| `v2_governance` | `code`, `caller` | `helpers` | Own/delegated/total votes and strict greater-than-2% qualification; zero totals do not qualify |

`grossAmount` and `usableAmount` are mutually exclusive. Bridge mint and burn
amounts are also mutually exclusive. `v2_new_position.plannedMintAmount` and
`v2_clone_position.initialMint` are gross local amounts. Clone `expiration` is
the absolute child expiration, not a duration and not the parent's current fee
expiration.

Example existing-position read:

```json
{
  "code": "USD",
  "position": "<position-address>",
  "caller": "<caller-address>",
  "recipient": "<recipient-address>",
  "usableAmount": "100"
}
```

Example source-bridge mint read:

```json
{
  "code": "USD",
  "account": "<account-address>",
  "mintSourceAmount": "25.5"
}
```

Replace every placeholder with a real explicitly supplied address.
The server does not invent deployment addresses, discover positions, or enumerate
challenge history.

### New-proposal validity and planned-mint review

For `v2_new_position`, `valid` means only that the opening terms and funding are
valid. The adjacent `validityScope` states this explicitly as `opening terms and
funding only; not later mint eligibility`. `openPosition` does not mint
immediately.

When `plannedMintAmount` produces an illustrative quote, `plannedMintReview`
separately checks:

- `openingTermsAndFunding`: the opening-scoped `valid` value;
- `capacity`: `grossAmount <= terms.mintingMaximum`;
- `overflowSafe`: both the collateral-value and required-backing products fit
  uint256;
- `backing`: overflow-safe `initialCollateral * liquidationPrice >= grossAmount
  * 1e18`, using raw integers; and
- `positiveUsableAmount`: `usableAmount > 0`.

`plannedMintReview.eligible` is true only when opening validity and every review
check pass. Gross and usable amounts, the minting maximum, and the two 36-decimal
backing products include raw integer strings and exact formatted values. If no
quote was requested or one is unavailable, review eligibility is `null`, checks
are unavailable, and `unavailableReason` explains that no future-mint eligibility
was inferred. The review describes a possible later mint using current reads and
assumed timestamps; it requires fresh position state and a requote after opening
and is not transaction simulation or authorization.

### Deployment evidence versus current reads

`deploymentEvidence` contains registry source/rate evidence, constructor args,
and (in `instance_state`) transactions and postconditions. It is explicitly not
current chain state. `currentReads` contains SDK snapshots. A configured initial
savings rate is not presented as the current rate. Run `v2_verify` before treating
a supplied registry as a verified live contract set; successful verification is
still not a production endorsement or an audit.

### Challenges, expiry, and settlement

`v2_challenge.active` is labelled `firstPhaseActive` in the formatted view. It
means only that the source-block timestamp is within the first challenge phase.
`settlementComplete` is always `null`: inactive or empty does not prove complete
settlement. There is no keeper service, auction-outcome reconstruction, or hidden
log enumeration. Legacy `list_challenges` is not advertised for V2; use
`v2_challenge` with an explicit index. Position expiry and expired purchase
price are available in `position_state` and `v2_position_mint`.

## V2 read-only boundary

Protocol V2 advertises only the 14 read/plan tools: no write, fee-quote, or
legacy log-enumeration path is registered. The internal legacy compatibility
handlers remain defense-in-depth and deterministically throw **"disabled in V2
read-only integration"** before signer lookup, fee sampling, RPC/staticCall, or
send for `mint`, `launch_challenge`, `place_bid`, `open_position`, all three
guardian writes, and `fee_quote`, with either `dryRun` value.

V2 never calls `guardianState`, `bootstrapState`, admission-guardian methods, or
an allocation minter/bootstrap. Guardian calldata is never redirected to a V2
MintingHub.

Quotes and eligibility are planning data. In particular, repayment's full
candidate is not a promise of complete repayment, repayment does not establish
withdrawal eligibility, and new-proposal reads cannot prove a collateral token's
non-view transfer behavior. Separately authorized simulation/execution tooling
would be required for those guarantees; it is not included here.

## Legacy V1 tools

Legacy behavior remains available only when the legacy registry was explicitly
selected (including the unchanged default). Amounts continue to use the legacy
human-unit conventions. Position minimum/challenged collateral and challenge
sizes now correctly use the position collateral's decimals rather than local
18-decimal units; liquidation prices use `36 - collateralDecimals`.

### Reads

| Tool | Arguments | Returns |
|---|---|---|
| `list_instances` | — | Legacy token supply/reserve, equity price, guardian and admission-gate state |
| `instance_state` | `code` | Legacy token/equity/bootstrap/guardian/timelock state |
| `position_state` | `code`, `positionAddress` | Legacy position state and derived fee/reserve information |
| `list_challenges` | `code`, optional `position` | Legacy open challenges with exact collateral size formatting |
| `fee_quote` | `code`, `tool` | Sampled L1-data plus L2-execution fee estimate in DOGE |

### Writes (`dryRun` defaults to `true`)

| Tool | Signer | Arguments |
|---|---|---|
| `mint` | treasury | `code`, `position`, `amount`, `dryRun?` |
| `launch_challenge` | bot | `code`, `position`, `size`, `bid`, `dryRun?` |
| `place_bid` | bot | `code`, `challengeNumber`, `size`, `postpone?`, `dryRun?` |
| `guardian_pause` | guardian | `code`, `dryRun?` |
| `guardian_schedule_unpause` | guardian | `code`, `dryRun?` |
| `guardian_unpause` | guardian | `code`, `dryRun?` |
| `open_position` | treasury | `code`, `collateralToken`, `minAmount`, `minCollateral`, `initialCollateral`, `liqPrice`, `durationSeconds`, optional `feePPM`, `initPeriodSeconds`, `challengePeriodSeconds`, `reserveContributionPPM`, `dryRun?` |

On the legacy path only, `dryRun: true` runs `staticCall` and returns a fee quote;
`dryRun: false` enforces the fee-regime guard, sends, and reports the mined
receipt's actual L1-inclusive fee. A status-0 receipt is surfaced as an MCP
error, never a success-shaped payload. The test suite mocks these paths and does
not invoke live writes.

The legacy fee model samples recent mined transactions because the OP-stack
GasPriceOracle is not wired on Chikyu. It fits `l1Fee ≈ fixed + perByte × bytes`,
uses static per-tool L2 gas estimates, rejects outliers and insufficient samples,
and aborts sends when either the per-byte rate or median total L1 fee exceeds 2×
baseline. `DOGEFOREX_BASELINE_TOTAL` can set the total baseline explicitly.

## Tests and limitations

Default `npm test` is entirely offline: real registry shapes/staged subsets,
MCP initialization/tool discovery, exact formatting, every V2 read tool,
disabled-write barriers, error states, fee math, and legacy read/write
regressions use local fixtures or mocks. The real `chikyuV2` directory is also
checked offline for all 12 currencies and zero signer configuration.

The V2 live testnet suite is opt-in and read-only:

```sh
DOGEOS_LIVE_V2_TESTS=1 npm test -- test/v2-live.test.ts
```

It verifies all 12 real registries and lists current source-block state for all
12 systems while asserting that no signing or broadcast RPC method is used.
The pre-existing legacy Chikyu read-only smoke suite is separately available:

```sh
DOGEOS_LIVE_TESTS=1 npm test -- test/smoke.test.ts
```

Remaining boundaries: no V2 transaction simulation/signing/writes, no position
or challenge log discovery, no settlement/keeper service, no hosted remote MCP
endpoint, and no browser frontend in this package. The frontend and static Agent
workflows guide live in `dogeforex-ui/imf-v2`.

See [SECURITY.md](SECURITY.md) for security guidance.
