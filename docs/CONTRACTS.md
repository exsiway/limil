# Contracts

Two small Solidity contracts, both in `contracts/`, compiled with solc 0.8.28,
optimizer on, `evmVersion: cancun`. Both have the same address on every chain
through CREATE2. The account contract is at its third version; the two earlier
ones are listed below because wallets still delegated to them are recognised
and migrated. The source of a deployed contract is kept byte for byte,
comments included: a changed byte is a changed address.

## Contents

1. [Deployed addresses](#1-deployed-addresses)
2. [LimilSessionAccount](#2-limilsessionaccount)
3. [LimilOutputGuard](#3-limiloutputguard)
4. [Verifying the bytecode](#4-verifying-the-bytecode)
5. [Deploying your own](#5-deploying-your-own)

---

## 1. Deployed addresses

| Contract | Address | Chains |
|---|---|---|
| `LimilSessionAccount` v3 (live delegate, CREATE2) | `0xc21366f5e034d1E13171aa150E1d0e31e31cc364` | Robinhood Chain (4663), Base (8453), BNB Chain (56) |
| `LimilSessionAccount` v2 (legacy, never delegated to again) | `0x53C265D677C9c2A4A480b6445372E75153029f26` | Robinhood Chain (4663), Base (8453), BNB Chain (56) |
| `LimilSessionAccount` v1 (legacy, never delegated to again) | `0xdd118986d9357FECdBc1ba6C90Cd1838817ee3Ac` | Robinhood Chain (4663) |
| `LimilSessionAccount` v1 (legacy, CREATE2) | `0xE3BEa55fDE39539E25fd239796DF96c21CBEb614` | Base (8453), BNB Chain (56) |
| `LimilOutputGuard` | `0x55f1dd8f6afe957fdfabb70e31b0f9ff46f237f3` | Robinhood Chain (4663), Base (8453), BNB Chain (56) |
| EntryPoint v0.8 (reference) | `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` | all |
| Simple7702Account (FOMO's default delegate) | `0xe6cae83bde06e4c305530e199d7217f42808555b` | all |
| Relay router | `0xccc88a9d1b4ed6b0eaba998850414b24f1c315be` | all |
| Relay depository (guard watches it) | `0x4cd00e387622c35bddb9b4c962c136462338bc31` | all |

Constants live in `src/shared/chains.js` (`DELEGATES`, `LEGACY_DELEGATES`) and
`src/shared/output-guard.js`. The v3 address follows from the salt
`keccak256("limil.session-account.v3")` and the bytecode of
`contracts/LimilSessionAccount.sol`, kept byte for byte as deployed;
`test/chains.test.mjs` recomputes it from the artifact. The deployed v3 runtime
on all three chains matches its artifact byte for byte.

### Version 3

Two things a leaked session key cannot do on this version:

- **The budget is charged from what actually leaves.** Charging the approve
  argument would let an allowance that already stands to the relay proxy move
  tokens for free. The proxy pulls with `transferFrom(msg.sender, …)`, and the
  amounts it will pull are arguments of the call the key signs, so the
  contract parses `tokens[]` and `amounts[]` out of that call and charges
  those. A standing allowance buys nothing. The parse stops at the two
  arrays: `refundTo` and `nftRecipient` are not checked (see below).
- **The floor is the owner's number.** A floor checked only for being above
  zero would let a leaked key write one wei. Each token's cap carries
  `minOutPerUnit`, a price fixed at grant time from the order's own target,
  and the operation's guard floor must be at least the amount sold times that
  price.

**What v3 does NOT bind, and why.** The guard still measures the relay
depository, which is a shared contract anyone may pay into, and the payout it
leads to is named in an off-chain quote the chain never sees. A key holder can
therefore satisfy the floor with their own deposit credited to their own
request. Measuring the wallet instead would prove delivery, but only for a
sale that settles on the origin chain, and FOMO's API refuses such a quote
outright:

> Invalid input: One of the following must be true: Input token is SOL-USDC or
> output token is SOL-USDC

Routing sells around their API would settle into the wallet and close this,
at the cost of the position and its profit disappearing from the app that
opened it. That trade was considered and declined. So the bound on a leaked
key is the per-token budget, that token's live orders plus one retry, and
this is recorded as an accepted risk rather than a defect awaiting a patch.

The two head words `refundTo` and `nftRecipient` are deliberately not
constrained by the contract: its header says live quotes put relay's own
address there, so requiring the wallet would refuse every real sell, and the
key may send no native value and receives no mints.
`test/session-account.test.mjs` pins this: a swap whose `refundTo` is a
stranger is accepted on chain. The extension is stricter with the batches it
builds itself: its verifier (`src/shared/runner-verify.js`) refuses a batch
whose `refundTo` is not the wallet. The contract itself does not check it,
so that refusal binds the extension's own path and nothing a leaked key
signs.

Also new: `revokeSessions(address[])`, one `Grant` struct in the ABI, and a
new ERC-7201 namespace per version so a wallet returning from an older
delegate cannot read its fields as these.

### Version 2

Two rules this version adds over version 1, both about what a LEAKED session
key could do, both needing a new storage layout:

- **Approve caps are per token.** One cap per key summed over raw units of
  every token of the session is a million times too large for a 6-decimal
  token when sized for an 18-decimal one.
- **The output guard is required.** Granting the guard's two pairs like any
  others would validate a batch without them.

**Migration.** The extension recognises every version (`isLimilDelegate`) but
plans grants against the newest only. On a wallet still delegated to an older
one the next grant round first revokes every key there (one owner operation of
self-calls to `revokeSession`, since that storage survives the change of
code), then sends the usual operation carrying the 7702 authorization and the
new grant. Disconnect works on any version.

## 2. LimilSessionAccount

An ERC-4337 account meant to be the EIP-7702 delegate of an EOA. When the
wallet's code points at it, `address(this)` is the wallet itself, and the
wallet keeps behaving as before for its owner while gaining bounded session
keys.

### Owner

The owner is the account itself (`address(this)`): a signature that recovers
to the wallet address is the owner's. The owner may call anything through
`execute` / `executeBatch` with no list and no caps, and `validateUserOp`
returns plain zero for owner-signed operations.

### Sessions

`grantSession(key, Grant)`, callable by the owner or through the EntryPoint
from the owner. `Grant` is `{ Limits limits; TokenCap[] tokenCaps; GuardSpec
guard; SwapSpec swap; address[] targets; bytes4[] selectors; address[]
feeRecipients; }`:

| Field | Rule |
|---|---|
| `validUntil` | must be non-zero; returned to the EntryPoint in `validationData` rather than checked inside validation (ERC-7562) |
| `maxOps` | must be non-zero; counts validations, not successful sales |
| `maxValuePerCall`, `valueBudget` | zero means forbidden, not unlimited; the budget is checked against the sum of a batch |
| `feeBudget`, and the gas fields of the UserOperation | worst-case gas cost is charged against `feeBudget`; zero budget requires zero gas fields (the sponsored flow) |
| `maxFeePerOp`, `feeRecipients` | either both set or both empty; a `transfer` pair is only accepted with both, and only to a listed recipient, summed per operation |
| `tokenCaps[]` = `{token, maxPerOp, budget, minOutPerUnit}` | one entry per token the key may sell, in that token's raw units; all three non-zero, cap ≤ budget, one entry per token, never the settlement token; charged from the SWAP's declared amounts, summed per operation and per token; a rejected operation does not spend the budget; `minOutPerUnit` is settlement units per 1e18 raw units and sets the floor the operation must demand |
| `guard` = `{guard, settlementToken, depository}` | all three set or all zero; with a guard the key may send `executeBatch` only, opening with `snapshot(settlementToken, depository)` and closing with `assertGained(settlementToken, depository, floor)`, the guard nowhere else; the holder measured is the `depository` the owner names in the grant, and the extension names relay's depository (`guardSpecFor` in `src/shared/output-guard.js`); the two guard pairs are granted by the contract and refused in the pair list |
| `swap` = `{router, selector}` | the one contract and function the key may hand tokens to; granted by the contract and refused in the pair list, so no other selector on that address is reachable; its `tokens[]`/`amounts[]` are parsed and charged, its `refundTo`/`nftRecipient` are not checked; required with a guard, forbidden without one |

`targets` and `selectors` are pairs, not sets: `(TOKEN, approve)` and
`(ROUTER, swap)` do not imply `(TOKEN, swap)`. Lists of unequal length revert.

Refused at grant time and again at validation time:

- targets equal to the account itself or the EntryPoint;
- selectors that move tokens: `transferFrom`, `setApprovalForAll`, the three
  `safeTransferFrom` forms, `safeBatchTransferFrom`, both `permit` forms,
  `increaseAllowance`, `transferAndCall`, `approveAndCall`, `authorizeOperator`;
- `approve` to a spender that is not among the granted targets (the guard is
  never a spender), or above that token's per-operation cap;
- `approve` or a sale of a token without its own cap;
- a swap whose head does not decode, or whose array offsets point past the
  call's own length;
- an operation whose guard floor is below what the granted prices demand of
  the amounts it sells;
- `approve` or `transfer` with truncated arguments;
- for a guarded key: `execute`, a batch of fewer than two calls, a batch that
  does not open with the snapshot or close with the check, a guard call on
  another token or holder or with extra or missing bytes, a zero floor, a
  third guard call anywhere in between;
- a bare call (empty calldata) even to an allowed target;
- malformed `executeBatch` calldata (reverts rather than passing).

`revokeSession(key)` kills the key immediately; `revokeSessions(keys[])` does
the same for several. Every grant bumps an epoch for that key, so a re-grant
(with or without a revoke) replaces the pair list and the token budgets instead
of accumulating rights. Views: `getSession`, `tokenBudget(key, token)`,
`isAllowedCall`, `isFeeRecipient`, `sessionEpoch`.

### Validation

`validateUserOp` accepts calls from the EntryPoint only. For a session key it
parses the `executeBatch` calldata, checks the template first when the key has
a guard, then each call against the pair list and the caps, sums values and
fee transfers across the batch and approve amounts per token, charges the
budgets (the token budgets last, so no refusal leaves one spent), and returns
`validUntil` packed into `validationData`. Any failure returns the "signature
failed" authorizer or reverts; nothing is partially accepted.

### Where the proceeds go

The guard measures the settlement-token balance of an address the owner fixes
at grant time (`GuardSpec.depository`), and the contract refuses any batch
whose guard call names a different one. Every key gets relay's depository,
because every sale settles cross-chain through FOMO's own pipeline.

A narrower guard on the WALLET was written and then removed with the mode it
served: a daemon executing on its own, selling inside one chain so the
proceeds had to arrive in the wallet. It closed the leaked-key case
completely, and it sold outside FOMO's pipeline, so their app recorded no
PnL line. The owner weighed that and chose the PnL. The contract still
supports it (`depository` is any address), so bringing it back is a grant
change, not a contract change.

### Known limitation: the router recipient (browser route)

The contract reads `tokens[]` and `amounts[]` out of the swap call and nothing
else of it: the inner `calls` are opaque, and the RECIPIENT of the sale is
named in an off-chain relay quote, so it is checked by nobody on chain.

**What the guard proves, exactly.** Within the operation, the settlement-token
balance of the relay depository rose by at least the floor. That is all. It
does **not** prove the rise came from this trade: the depository is relay's
shared contract, and a deposit made by anyone in the same transaction counts.
It does **not** prove the proceeds were credited to this account's relay
request: the destination of a relay sale is named in an off-chain quote, and
this contract does not read it. What it does prove about the price is only
what the owner fixed: the floor must be at least the amount sold times the
grant's `minOutPerUnit`, so a leaked key cannot lower it, but it can satisfy
it with its own deposit.

The guard bounds ACCIDENT, a pool that pays far less than the quote, and pins
the shape of every operation. It is not a proof of delivery: a swap routed to
a stranger does not revert by itself.

**The deployed contract's own header comment is out of date in two places**
(`contracts/LimilSessionAccount.sol`). Its second paragraph still says "The
contract does not parse the swap arguments: the router calldata is opaque to
it", which the paragraph headed "SECOND, THE BUDGET IS CHARGED FROM WHAT
ACTUALLY LEAVES" contradicts a few lines later; and it says "Binding the
recipient on chain is impossible while the sale settles cross-chain", which
the section below shows is not so. Both are left there on purpose: solc puts a
hash of the source text into the bytecode, so editing even a comment changes
the CREATE2 address and the file would stop matching the contract that is
actually deployed at `0xc213…c364`. Reproducing the deployed address from this
repository is worth more than a tidy comment. This section is the correction;
the header is wrong where the two disagree.

**So what does bound a leaked key.** The per-token budget, charged from the
swap's own `tokens[]`/`amounts[]`: the sum of that token's live orders plus
one retry, at no less than the owner's price. Around it, off chain, the
browser-side verifier refuses an approve above the order amount and a
`refundTo` that is not the wallet, and sizes the floor from the order. That
covers the honest path and nothing else, because a key holder writes their
own batch.

**Standing allowances.** In v2 a batch without an `approve` charged nothing,
so an allowance that already stood to the router was spendable outside the
budget. v3 charges the swap's declared amounts whether or not the batch
approves anything, so a standing allowance buys nothing more than the budget
allows. Every batch the extension builds still ends with `approve(router, 0)`
(`src/shared/swaps.js`) as hygiene, so our own trades leave no allowance
behind. The contract still cannot read token allowances in validation
(ERC-7562); with the budget on the pull rather than on the approve, it no
longer needs to.

**Status: accepted risk, not a fixed defect.** Neither the per-token budget
nor the guard nor the allowance reset removes it, and the corrections above
are wording, not mitigation. Anyone reading this to decide how much to keep on
the wallet should treat the machine holding the session key as a hot wallet
bounded by the per-token budget, and nothing stronger.

**What would actually close it, and what stands in the way.** The recipient of a relay sale lives in the order data behind
the `orderId` that the deposit calldata carries. Both halves of a proof were
verified against a live 4663 to Solana quote from relay's own API:

- `protocol.v2.orderId` is the EIP-712 `hashStruct` of `orderData` with the
  types published in `relayprotocol/relay-protocol-sdk` (`src/order/index.ts`):
  EVM addresses encoded as 20-byte `bytes`, Solana keys as the 32 decoded
  bytes, `deadline` as `uint32`, no domain separator. Recomputed in JavaScript
  from the live `orderData`, it matched the id relay returned bit for bit.
- The id sits inside the swap call, in the nested
  `depositErc20(depositor, token, id)` to relay's depository, so the contract
  can find it during validation.

So a contract that received `orderData` as an argument could recompute the
id, require it to equal the embedded one, and refuse an output recipient the
owner never named. That contract is buildable today.

What is missing is the `orderData` itself. The order carries a random
32-byte `salt`, so the id cannot be recomputed from anything the owner knows
in advance, and it has to travel with the quote. FOMO's `/swaps/v2` does not
pass it on: the live response holds `relayTransaction` (the approval and the
deposit calldata) and `relaySwapId`, and nothing of relay's `protocol` block.
Relay's public API does not hand the order out by id before the deposit
either (`/requests/v2` answers an empty list until the deposit lands, and the
quote is not retrievable). Requesting a quote from relay directly would give
the data, but a sale executed on that quote goes around FOMO's pipeline and
loses the PnL entry, which is the one trade-off this project refuses.

The ask is therefore one field on FOMO's side: return relay's `protocol.v2`
(`orderId` and `orderData`) alongside `relayTransaction`. With it, the next
contract version binds the recipient and the residual described above goes to
zero for the sell route.

**What bounds a leaked key meanwhile, beyond the budget.** Every grant sets
`feeBudget` to zero (`src/shared/grant-plan.js`), so the contract refuses any
operation whose `maxFeePerGas` times its gas limits is not zero. Such an
operation is executable only by a bundler that pays the gas itself, which is
what FOMO's bundler does for this account and what a public bundler will not
do. A leaked key therefore cannot use its own bundler; it has to get its
operation through FOMO's, with calldata FOMO did not produce. Whether FOMO's
bundler accepts that is FOMO's policy, not a property of this contract, and
it is not counted on here.

Note on the deployed source: v3 is the version that shipped after this was
found, and the comment at the head of `contracts/LimilSessionAccount.sol`
still says the binding is impossible. It is wrong there. It is left exactly
as it is on purpose: the comment is part of the compiler metadata, so editing
it changes the bytecode and with it the CREATE2 address of a contract that is
deployed on three chains and holds live grants. The wording is corrected here
instead, and the source gets the correction with the next version that
changes the bytecode anyway.

### Known issue (low, v3 only): the approve spender is any listed target

On the live v3, `approve` is accepted when its spender is any target of the
pair list, not only the swap router (`contracts/LimilSessionAccount.sol`).
The extension's grant lists only the order tokens as targets, so with two
tokens in one grant the key could approve token A to token B's contract. An
ERC-20 contract does not call `transferFrom` on another token, so nothing
moves, and the approve is still bounded by the per-operation cap; the verifier
in `src/shared/runner-verify.js` refuses any spender but the router for the
extension's own batches.

### Tests

`test/session-account.test.mjs` runs the compiled bytecode at an owner address
on an in-memory EVM (`@ethereumjs/vm`) and exercises every rule above,
including every combination that must be refused.
`test/session-account-limits.test.mjs` replays four cases
against the grant the extension's own planner produces (the 6-decimal token
measured by its own cap, the unguarded batch refused, the swap without an
approve charged all the same, the floor fixed by the owner), and keeps one
regression check (an approve to a stranger is refused).

## 3. LimilOutputGuard

Stateless except for transient storage. Two functions, meant to bracket a sell:

- `snapshot(token, holder)` records `token.balanceOf(holder)` in transient
  storage under a key that includes `msg.sender`.
- `assertGained(token, holder, minGain)` reads the snapshot, clears it, and
  reverts with `OutputBelowFloor` if the holder's balance grew by less than
  `minGain`. A zero `minGain` reverts with `FloorIsZero`; a missing snapshot
  reverts with `NoSnapshot`; a balance that fell counts as zero gain.

The holder is the relay depository, the token is the chain's cash token (USDG
on Robinhood Chain, USDC on Base, Binance-Peg USDC on BNB Chain), the floor is `target × (1 − slippage)` scaled to the token's decimals
(`src/shared/output-guard.js`). Because the snapshot dies with the transaction
and the key includes the caller, a snapshot from another transaction or another
caller does not count. The contract accepts no ether and no unknown selectors.

`test/output-guard-evm.test.mjs` compiles a mock token and executes the batch
`[snapshot, mint, assertGained]` through the account's `executeBatch` on the
in-memory EVM, for the passing case and every revert.

## 4. Verifying the bytecode

```bash
npm install
npm run build:contract          # artifacts/contracts/*.json
```

Fetch the deployed runtime code from an RPC (`eth_getCode`) and compare it to
`deployedBytecode` in the artifact. The last 53 bytes are solc's CBOR metadata
and may differ between builds; everything before them must match exactly.

`node scripts/verify-contract.mjs` does exactly that for both contracts on
every chain they stand on, and says whether each one is published on Sourcify.
It spends nothing and needs no key. With `--send` it publishes the sources
there, which is how an explorer comes to show the code behind the address:
Sourcify is explorer-independent and the address is the same on every chain,
so one submission per chain covers the explorers that read it.

For the account contract the artifact also reproduces the address:
`test/chains.test.mjs` recomputes `CREATE2_DELEGATE` from the salt and the
artifact's initcode. For the guard it does not: the deployed guard's
executable code is what the artifact produces today, but its metadata tail
differs (the hash of the source text and the compiler settings inside it), so
the artifact's initcode hashes
differently and lands at another address. `test/output-guard-pin.test.mjs`
pins the executable part of the guard runtime instead, and
`scripts/deploy-guard.mjs` rebuilds the initcode from the runtime already on
chain before deploying to a new chain, refusing when that would not land at
`GUARD_ADDRESS`.

## 5. Deploying your own

`scripts/deploy-guard.mjs` deploys the guard through the canonical CREATE2
deployer (`0x4e59b44847b379578588920ca78fbf26c0b4956c`) with the salt in
`src/shared/output-guard.js`, so any chain yields the same address. Gas is paid
by the deployer key in `secrets/courier.key` (create one with `npm run courier`,
`scripts/new-courier.mjs`); it is a plain funded EOA for deployments, unrelated
to the gas courier of the removed self-executing daemon;
`CHAIN_ID=8453 node scripts/deploy-guard.mjs` is a dry run, add `--send` to
deploy. Running it where the guard already stands sends nothing.

`scripts/deploy-delegate.mjs` deploys the account contract the same way, with
`DELEGATE_SALT`, so every chain shares one address (`CREATE2_DELEGATE`). The
script refuses to run when the artifact would land elsewhere than chains.js
expects, a changed byte in the source is a changed address. The map is
`DELEGATES` in `src/shared/chains.js`; a chain missing from it gets no
auto-execution of sells, and the panel says so. The guard's cash token per
chain is `GUARD_CASH` in `src/shared/output-guard.js` (USDG on Robinhood Chain,
USDC on Base, Binance-Peg USDC with 18 decimals on BNB Chain); a chain without
an entry has no template and therefore no grant.

Order of a release that changes the account contract: deploy the new address
on every supported chain first, then ship the extension that targets it.
Wallets on the previous version migrate on their next grant round.
