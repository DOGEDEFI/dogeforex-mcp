# dogeforex-mcp

MCP (Model Context Protocol) server that lets AI agents operate the
[DogeForex](../dogeforex-protocol) multi-instance stablecoin protocol on the
**DogeOS Chikyu testnet** (chainId `6281971`, OP-stack L2, gas in tDOGE).

Built on the [`@dogeforex/sdk`](../dogeforex-sdk-ts) TypeScript SDK
(`file:../dogeforex-sdk-ts`, imports from its built `dist`).

## Install & build

```sh
npm install
npm run build        # tsc -> dist (ESM, strict)
npm run typecheck    # tsc --noEmit
npm test             # live read-only smoke test vs the Chikyu testnet (vitest)
```

## Run

```sh
node dist/index.js            # or: npm start  /  npx dogeforex-mcp (when packaged)
```

The server speaks MCP over **stdio**. Wire it into an MCP client, e.g.:

```json
{
  "mcpServers": {
    "dogeforex": {
      "command": "node",
      "args": ["/absolute/path/to/dogeforex-mcp/dist/index.js"],
      "env": {
        "DOGEOS_REGISTRY_PATH": "/absolute/path/to/dogeforex-protocol/deployments/k9usd.chikyu.json"
      }
    }
  }
}
```

All diagnostics go to **stderr** — stdout carries the MCP protocol.

## Configuration (env vars only)

| Variable | Default | Purpose |
|---|---|---|
| `DOGEOS_RPC_URL` | `https://rpc.testnet.dogeos.com` | Chikyu RPC endpoint |
| `DOGEOS_REGISTRY_PATH` | `../dogeforex-protocol/deployments/k9usd.chikyu.json` (cwd-relative; existence validated at startup) | schema-v2 deployment registry |
| `DOGEFOREX_DEPLOYER_KEY` | — | optional signer (validated if set) |
| `DOGEFOREX_TREASURY_KEY` | — | signer for `mint`, `open_position` |
| `DOGEFOREX_GUARDIAN_KEY` | — | signer for `guardian_pause` / `guardian_schedule_unpause` / `guardian_unpause` |
| `DOGEFOREX_BOT_KEY` | — | signer for `launch_challenge`, `place_bid` |

Signers are hex private keys with a `0x` prefix, one per role. They are
**never committed, logged, echoed in tool output, or placed in error
messages** (an error-message scrubber also strips anything that looks like a
64-hex secret). If a write tool is called without its signer env var, it
returns a clean error naming the missing variable. The server never reads
`~/.dogeforex/keys.json` — env vars are the only key source.

## Fee model & the fee-regime abort rule

DogeOS Chikyu receipts carry an L1 data fee in the raw `l1Fee` field; ethers'
`receipt.fee` is L2-only and **must not** be used. This server:

- reports mined-tx fees via the SDK's L1-inclusive `totalTxFee` helper;
- quotes prospective fees from a sampled model `l1Fee ≈ fixed +
  perByte · bytes` fitted over recent mined transactions (the GasPriceOracle
  predeploy is not wired on this chain, so the regime is sampled from chain
  data; the L2 component uses a static per-tool gas estimate — it is small
  next to the L1 data fee);
- enforces the hard ops rule before **sending** any write: if the sampled
  marginal per-byte rate exceeds **2× the 7.1e-5 DOGE/B baseline** (the
  2026-10-14 spike twice aborted real deploys), the tool aborts with
  `fee regime shift … retry later`. `fee_quote` always reports the rate,
  the ratio, and a `regimeShift` warning flag without aborting.

## Tools

Amounts are human-unit decimal strings (e.g. `"3500"`), parsed with the SDK's
`parseStable`/`parseUnits`; results are reported in human units.

### Read tools (no signer)

| Tool | Arguments | Returns |
|---|---|---|
| `list_instances` | — | all 11 instances: symbol, token address, total supply, minter reserve, equity share price, guardian paused + admission-gate state |
| `instance_state` | `code` | full snapshot: token supply/minterReserve/registered minters, equity price/shares, bootstrap status, guardian + timelock state, admission gate |
| `position_state` | `code`, `positionAddress` | collateral, liquidation price, limit, minted, available-for-minting, cooldown/mintable state, derived minting fee + reserve contribution, `isMintable` |
| `list_challenges` | `code`, optional `position` | open challenges: number, challenger, size, deadline, active flag |
| `fee_quote` | `code`, `tool` | estimated total tx fee in DOGE (L1 data + L2 exec) for any write tool, plus the current per-byte rate vs the 7.1e-5 baseline and `regimeShift` warning |

### Write tools (signer required; `dryRun` defaults to `true`)

With `dryRun: true` the tool runs `staticCall` only — no tx is sent — and
returns what **would** happen plus a fee quote. With `dryRun: false` the tool
enforces the fee-regime abort rule, sends the transaction, and reports the
**actual** L1-inclusive total fee from the mined receipt plus the resulting
state deltas.

| Tool | Signer | Arguments | Returns |
|---|---|---|---|
| `mint` | treasury | `code`, `position`, `amount`, `dryRun?` | `positionState` minted/available delta + actual total fee |
| `launch_challenge` | bot | `code`, `position`, `size` (collateral units), `bid` (K9XXX), `dryRun?` | challenge number from `ChallengeStarted` |
| `place_bid` | bot | `code`, `challengeNumber`, `size`, `postpone?`, `dryRun?` | whether the bid closed the challenge (`ChallengeSucceeded` presence) |
| `guardian_pause` | guardian | `code`, `dryRun?` | guardian state after |
| `guardian_schedule_unpause` | guardian | `code`, `dryRun?` | guardian state after (unpause available at = now + timelock) |
| `guardian_unpause` | guardian | `code`, `dryRun?` | guardian state after |
| `open_position` | treasury | `code`, `collateralToken`, `minAmount` (= minting maximum), `minCollateral`, `initialCollateral`, `liqPrice`, `durationSeconds`, optional `feePPM` (default 0), `initPeriodSeconds` (432000), `challengePeriodSeconds` (86400), `reserveContributionPPM` (100000), `dryRun?` | new position address from `PositionOpened` |

Liquidation prices carry `36 − collateral.decimals` decimals; `open_position`
reads the collateral's decimals from chain and parses accordingly. Collateral
amounts for challenges/bids are parsed with the position collateral's actual
decimals (wDOGE is 8-dec; MOFX 18-dec).

## Known deviations

- **SDK `formatSharePrice` is mis-scaled** (divides by `10^3`; on-chain share
  prices are 18-dec fixed point — `3e18 == 3.0` per the SDK's own docstring and
  the deployment registry). This server formats equity prices with
  `formatUnits(price, 18)` instead. Flagged for the SDK repo; not patched here
  since the SDK is consumed as a pinned sibling dependency.
- The L1 fee quote samples recent mined transactions
  (`l1Fee ≈ fixed + perByte·bytes`) because the OP-stack GasPriceOracle
  predeploy is not wired on Chikyu (calls return empty). Sampled quotes match
  the ops-runbook methodology (`deployments/k9usd.chikyu.json` `feePreflight`).
  The L2 component uses static per-tool gas estimates — immaterial next to the
  dominant L1 data fee on this chain.

## Smoke test

`npm test` (vitest) instantiates the tool handlers directly (no stdio) and
runs `list_instances`, `instance_state(EUR)`, and `fee_quote(EUR, mint)`
against the live testnet, read-only. It also verifies that write tools called
without signer env vars fail fast, naming the missing variable, without
touching the chain. The EUR guardian may be paused intermittently during ops
rehearsals — the test reports the value but never asserts `paused === false`.

## Security

See [SECURITY.md](SECURITY.md). Role keys are testnet throwaways; still treat
them as secrets (env vars only, never committed).
