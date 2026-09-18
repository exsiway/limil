// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * An account with session keys, for delegation under EIP-7702.
 *
 * A limit order has to execute while the user is away. The signature is needed
 * at the moment the order triggers — a relay quote expires within minutes, so
 * nothing can be signed in advance — and therefore somebody has to sign
 * without the user. Handing a server the Privy session would give it the right
 * to sign anything, i.e. custody. Instead the owner delegates their address to
 * this contract once and registers a SESSION KEY with strict limits. Only that
 * key is held by the executor.
 *
 * WHAT A LEAKED KEY CAN DO. It can send the allowed (target, selector) pairs
 * until the expiry, within maxOps operations, valueBudget of native value and
 * feeBudget for gas. The direct ways to move tokens are closed: transferFrom,
 * permit and the other transfer-like selectors are banned outright, the
 * spender of an approve must be a target of the same session, and an allowed
 * transfer only goes to a listed fee recipient.
 *
 * BUT THE ROUTER PAIR IS GRANTED AS A WHOLE. The contract does not parse the
 * swap arguments: the router calldata is opaque to it, and the swap recipient
 * is checked by nobody. Anyone can create a relay quote with any recipient
 * without authorization. So a leaked key can route through the router whatever
 * its approve allowed — and the contract answers that in two places.
 *
 * FIRST, THE APPROVE IS BOUNDED PER TOKEN. Every token the key may approve is
 * named in the grant with its own cap per operation and its own budget for the
 * whole session, in that token's raw units. Caps are not shared between
 * tokens: a cap sized for an 18-decimal token says nothing about a 6-decimal
 * one, so a shared number would be a million times too large for the second.
 * A token without a cap cannot be approved at all, whatever the pair list
 * says. Sums are taken over the WHOLE operation, not per call: a second
 * approve next to the first is added, not counted anew.
 *
 * SECOND, THE BUDGET IS CHARGED FROM WHAT ACTUALLY LEAVES. The relay proxy
 * pulls the token with transferFrom from whoever calls it, and the amounts it
 * will pull are arguments of the call the key signs — tokens[] and amounts[]
 * of transferAndMulticall. Those are what the contract parses and charges,
 * not the argument of `approve`. An allowance that already stands therefore
 * buys nothing: the pull is charged either way, and an allowance this account
 * granted is spendable only when this account itself calls the proxy.
 *
 * The two remaining head words, refundTo and nftRecipient, are deliberately
 * NOT constrained: in the live quotes they are relay's own address, not the
 * wallet's, and requiring otherwise would refuse every real sell. They
 * receive leftover native value and minted NFTs, and this key is granted
 * neither — valueBudget is zero and the trade is ERC-20.
 *
 * THIRD, THE FLOOR IS THE OWNER'S NUMBER, NOT THE SIGNER'S. Every operation
 * must be executeBatch opening with guard.snapshot(settlementToken,
 * depository) and closing with guard.assertGained(settlementToken,
 * depository, floor); the guard appears nowhere else. Each token's cap
 * carries minOutPerUnit, a price fixed at grant time, and the floor must be
 * at least the amount sold times that price. The previous version let the
 * signature write one wei there.
 *
 * WHAT THE GUARD STILL DOES NOT PROVE, said here rather than in a document
 * nobody opens: the depository is a SHARED relay contract, the payout it
 * leads to is named in an off-chain quote, and anyone may pay into it. So a
 * measured gain means a bad fill did not happen; it does not mean the money
 * reached the owner. An attacker holding the key can satisfy the floor with
 * their own deposit credited to their own request. Binding the recipient on
 * chain is impossible while the sale settles cross-chain, and the sale must
 * settle cross-chain for the position to stay visible in the app that opened
 * it. The bound on that case is the per-token budget above, and nothing else.
 *
 * Draining the balance through gas is impossible: the worst-case cost of every
 * operation is charged against feeBudget already in validation.
 *
 * WHAT THE LIMITS DO NOT DO. They bound what the key may REQUEST and do not
 * touch what was allowed before. If the FOMO app granted the router a large
 * allowance in its own flow, the budgets do not reduce it. The target list
 * and the caps are the full picture of the KEY's rights, not of the account's.
 * The token allowance cannot be read in validation (ERC-7562 forbids foreign
 * storage), so "the router has no prior allowance" is on whoever issues the key.
 *
 * The account's allowance to the relay proxy is not a way around any of this:
 * the proxy moves tokens with transferFrom(msg.sender, ...), and msg.sender
 * is whoever calls it. An allowance this account granted is spendable only
 * when this account calls the proxy — which is exactly the path that parses
 * and charges the amounts.
 *
 * increaseAllowance is banned outright: it adds rather than sets, and a cap on
 * its argument would mean nothing. The live FOMO flow sends approve.
 *
 * THE SELECTOR BLACKLIST IS THE SECOND LINE, NOT THE FIRST. It is incomplete by
 * nature: there are more token-moving standards than listed below. The
 * contract's guarantee is the explicit (target, selector) pair in the
 * allow-list. Whoever issues a key must be able to say of every pair whether
 * that selector moves the account's tokens.
 *
 * RESIDUAL RISK, STATED PLAINLY. Two items.
 *
 * The larger: a leaked key can sell the position of each capped token, within
 * that token's budget, at the owner's price, and direct the proceeds to
 * itself by naming its own off-chain relay request. Bounded by the budget —
 * that token's live orders plus one retry — and by nothing finer.
 *
 * The smaller: within maxFeePerOp × maxOps a leaked key could send fees on
 * empty trades to a listed recipient. Vandalism, not theft.
 *
 * AND THE BOUNDARY OF ALL THIS. It is about what a LEAKED SESSION KEY can do,
 * i.e. the cost of a compromised machine. A flaw in THIS contract is a risk of
 * another order: under EIP-7702 its code becomes the account's code, and
 * execute/executeBatch call anything, so a validation bypass would mean losing
 * everything on the wallet. Any smart account works that way, including the
 * one the wallet is delegated to by default; the choice is not between "with
 * risk" and "without" but between whose code runs. This code has had no
 * external audit.
 *
 * The bundler is not a boundary: EntryPoint.handleOps is public, and with a
 * leaked key the attacker becomes their own bundler for their own gas.
 *
 * THE ZERO RULE. Everywhere alike: 0 = forbidden. A zero expiry and a zero
 * maxOps are not issued at all; a zero valueBudget means no native value; a
 * token without a cap entry cannot be approved; a zero feeBudget means the
 * account pays no gas (the working configuration under sponsored operations);
 * a zero guard means "no template" and therefore no approve at all.
 * "Unlimited" is expressed explicitly: type(uint256).max.
 *
 * THE MOST DANGEROUS PART. The limits are checked over the INNER calls of the
 * batch, not over the batch as a whole: from the outside every operation
 * looks like executeBatch, and without parsing its contents the limit would be
 * decorative. The sums (value, approve per token, fee) are added over the
 * WHOLE batch. The callData cannot change between validation and execution:
 * the EntryPoint executes exactly the bytes parsed here.
 *
 * COMPATIBILITY. The external interface repeats Simple7702Account, which the
 * wallet is delegated to by default: the same execute/executeBatch/
 * validateUserOp/isValidSignature/entryPoint and the same token receivers, so
 * the FOMO app keeps working as before. The key's lifetime is NOT checked by
 * the contract itself: validUntil is returned in validationData and the
 * EntryPoint checks it, as ERC-7562 requires (TIMESTAMP is forbidden in the
 * validation phase). No events in validation: ERC-7562 does not forbid them,
 * but paying for LOG in a phase every bundler simulates is pointless — the
 * write to our own storage is enough.
 *
 * HISTORY. Version 3. Version 1 summed approves across all tokens of a
 * session and allowed, without requiring, the guard pair. Version 2 fixed
 * both, but measured a shared relay depository against a floor the signer
 * chose, and charged the budget from `approve`, so a standing allowance was
 * free. Every one of these was found in review rather than in use. Each
 * version is storage-incompatible with the last, lives at its own address,
 * and wallets migrate by the ordinary "revoke, redelegate, grant" flow.
 */

/// @dev Exactly the EntryPoint (v0.8) used by live FOMO operations.
address constant ENTRY_POINT = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;

/// @dev validateUserOp return value on a rejected signature or limit.
uint256 constant VALIDATION_FAILED = 1;

/// @dev Fixed-point scale of TokenBudget.minOutPerUnit.
uint256 constant PRICE_SCALE = 1e18;

/// @dev Distinct tokens one operation may sell. A sell batch trades one.
uint256 constant MAX_OP_TOKENS = 8;

struct Call {
    address target;
    uint256 value;
    bytes data;
}

struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/**
 * Session key state.
 *
 * Every field narrows what the key may do, and for every limit zero means
 * forbidden, not "unset". The allowed calls and the per-token approve budgets
 * live separately, under an epoch number, see Store.
 *
 * "PerOp" means per OPERATION, i.e. over the sum of all calls of one batch. A
 * cap on a single call protects against nothing: a second one goes next to it.
 */
struct Session {
    uint48 validUntil;        // expiry; checked by the EntryPoint through validationData
    uint64 maxOps;            // cap on the number of operations per session
    uint64 opsUsed;           // operations accepted by validation so far
    bool exists;
    uint256 maxValuePerCall;  // cap on native value in ONE inner call
    uint256 valueBudget;      // total native value per session (0 = native forbidden)
    uint256 spentValue;       // spent from valueBudget
    uint256 feeBudget;        // cap on worst-case gas spending (0 = sponsored operations only)
    uint256 spentFees;        // charged against feeBudget
    uint256 maxFeePerOp;      // cap on the SUM of fee transfers per operation (0 = forbidden)
    address guard;            // output guard every operation must open and close with (0 = no trading at all)
    address guardToken;       // settlement token the guard measures
    address guardHolder;      // whose balance the guard measures (the relay depository)
    address swapRouter;       // the one contract the key may hand tokens to
    bytes4 swapSelector;      // the one function on it; its arguments are parsed
}

/**
 * What one key may sell of one token in one epoch, in the token's raw units,
 * and at what price.
 *
 * `spent` counts what the router was asked to PULL, read from the swap call's
 * own arguments — not what `approve` allowed. `minOutPerUnit` is settlement
 * units per 1e18 raw units of this token: the owner's limit price, which the
 * operation's guard floor must meet.
 */
struct TokenBudget {
    bool exists;
    uint256 maxPerOp;         // cap on the SUM sold in one operation
    uint256 budget;           // cap on the sum over the WHOLE session
    uint256 spent;            // charged against budget
    uint256 minOutPerUnit;    // settlement units per 1e18 token units
}

contract LimilSessionAccount {
    error NotAuthorized();
    error BadSessionConfig();
    error TargetNotAllowed(address target);
    error SelectorNotAllowed(bytes4 selector);

    event SessionGranted(address indexed key, uint256 epoch, uint48 validUntil);
    event SessionRevoked(address indexed key);

    /**
     * Storage per ERC-7201, not in slots 0..N.
     *
     * Under EIP-7702 this code runs in the storage of the EOA itself. If the
     * owner ever redelegates to another implementation, slots 0..N would almost
     * certainly collide with its variables; the namespace reduces that to a
     * keccak collision.
     *
     * The flip side: the state SURVIVES redelegation. Leaving for another
     * implementation and coming back within validUntil brings a live session
     * back. Revoke the keys before changing the delegate.
     *
     * Permissions live under an EPOCH number. The key's epoch grows on every
     * grant and every revoke and is never reused, so old allow-lists after a
     * revoke or a repeated grant become unreachable garbage rather than quietly
     * active rights. Without it "revoked and granted again" would in effect
     * mean "old and new rights added up".
     */
    /// @custom:storage-location erc7201:limil.session.account.v3
    struct Store {
        mapping(address => Session) sessions;
        mapping(address => uint256) epoch;
        // key => epoch => target => selector. The permission is a PAIR: two
        // independent lists would multiply into unintended combinations such
        // as router.approve or token.multicall.
        mapping(address => mapping(uint256 => mapping(address => mapping(bytes4 => bool)))) allowed;
        // key => epoch => target. Needed by the spender check in approve: the
        // spender may only be an address already named as a target of this session.
        mapping(address => mapping(uint256 => mapping(address => bool))) knownTarget;
        // key => epoch => fee recipient. A SEPARATE list, not knownTarget:
        // otherwise adding a new router to the targets would silently make it
        // a legitimate recipient of the account's tokens.
        mapping(address => mapping(uint256 => mapping(address => bool))) feeRecipient;
        // key => epoch => token. The approve caps, per token.
        mapping(address => mapping(uint256 => mapping(address => TokenBudget))) tokenBudget;
    }

    // keccak256(abi.encode(uint256(keccak256("limil.session.account.v3")) - 1)) & ~bytes32(uint256(0xff))
    // A new namespace per version: the Session and TokenBudget layouts differ,
    // and a wallet that comes back from an older delegate must never read its
    // fields as these.
    bytes32 private constant STORE_SLOT =
        0xe3e267253ccf4776b9ca7655a74d79086d1dd3a168906690ebb5eb1a60a91e00;

    function _s() private pure returns (Store storage st) {
        assembly {
            st.slot := STORE_SLOT
        }
    }

    // ------------------------------------------------------ dangerous selectors

    // Selectors that move tokens directly. They are never granted to a session
    // key under any configuration: valueBudget does not see them, it guards
    // native value only. The values are verified against the signatures by a
    // test (test/session-account.test.mjs). The list is incomplete by nature,
    // see the header.
    bytes4 private constant SEL_TRANSFER_FROM = 0x23b872dd;     // transferFrom(address,address,uint256)
    bytes4 private constant SEL_SET_APPROVAL_ALL = 0xa22cb465;  // setApprovalForAll(address,bool)
    bytes4 private constant SEL_SAFE_721 = 0x42842e0e;          // safeTransferFrom(address,address,uint256)
    bytes4 private constant SEL_SAFE_721_DATA = 0xb88d4fde;     // safeTransferFrom(...,bytes)
    bytes4 private constant SEL_SAFE_1155 = 0xf242432a;         // safeTransferFrom(...,uint256,uint256,bytes)
    bytes4 private constant SEL_SAFE_1155_BATCH = 0x2eb2c2d6;   // safeBatchTransferFrom(...)
    bytes4 private constant SEL_PERMIT_2612 = 0xd505accf;       // permit(...) EIP-2612
    bytes4 private constant SEL_PERMIT_DAI = 0x8fcbaf0c;        // permit(...) DAI variant
    bytes4 private constant SEL_INC_ALLOWANCE = 0x39509351;     // increaseAllowance(address,uint256)
    bytes4 private constant SEL_TRANSFER_AND_CALL = 0x4000aea0; // transferAndCall(address,uint256,bytes) ERC-677
    bytes4 private constant SEL_APPROVE_AND_CALL = 0xcae9ca51;  // approveAndCall(address,uint256,bytes) ERC-1363
    bytes4 private constant SEL_AUTHORIZE_OPERATOR = 0x959b8c3f; // authorizeOperator(address) ERC-777

    // These two may be granted, but their ARGUMENTS are checked separately,
    // deeper than the selector, see _allowedCall. Without that check either
    // would mean "the whole token".
    bytes4 private constant SEL_APPROVE = 0x095ea7b3;           // approve(address,uint256)

    /**
     * transfer — the only way to pay a fee to a listed recipient.
     *
     * The ban is replaced by two conditions, both mandatory: the recipient is
     * in the separate fee recipient list and the sum per operation is at most
     * maxFeePerOp. Stealing WITH THIS SELECTOR is impossible: the only
     * reachable destinations are the listed recipients. What remains is
     * vandalism within the cap, and the cap exists for exactly that.
     *
     * A caveat so the line above is not read too broadly: it is about transfer
     * and transfer only. A leaked key can still move tokens through an allowed
     * router call whose arguments are opaque to the contract. See "WHAT A
     * LEAKED KEY CAN DO" in the header.
     */
    bytes4 private constant SEL_TRANSFER = 0xa9059cbb;          // transfer(address,uint256)

    // The output guard's two functions (LimilOutputGuard). Verified against
    // the signatures by the same test as the bans.
    bytes4 private constant SEL_SNAPSHOT = 0x204e94b0;          // snapshot(address,address)
    bytes4 private constant SEL_ASSERT_GAINED = 0xdb794558;     // assertGained(address,address,uint256)

    function _bannedSelector(bytes4 sel) private pure returns (bool) {
        return sel == SEL_TRANSFER_FROM
            || sel == SEL_SET_APPROVAL_ALL || sel == SEL_SAFE_721
            || sel == SEL_SAFE_721_DATA || sel == SEL_SAFE_1155
            || sel == SEL_SAFE_1155_BATCH || sel == SEL_PERMIT_2612
            || sel == SEL_PERMIT_DAI || sel == SEL_INC_ALLOWANCE
            || sel == SEL_TRANSFER_AND_CALL || sel == SEL_APPROVE_AND_CALL
            || sel == SEL_AUTHORIZE_OPERATOR;
    }

    /**
     * Allowed to the account itself (i.e. the key owner) or to the EntryPoint —
     * otherwise anyone could manage sessions.
     */
    modifier onlySelfOrEntryPoint() {
        if (msg.sender != address(this) && msg.sender != ENTRY_POINT) revert NotAuthorized();
        _;
    }

    // --------------------------------------------------------------- sessions

    /// Consumable limits of a key. Approve caps are not here: they are per token, see TokenCap.
    struct Limits {
        uint48 validUntil;
        uint64 maxOps;
        uint256 maxValuePerCall;
        uint256 valueBudget;
        uint256 feeBudget;
        uint256 maxFeePerOp;
    }

    /**
     * What one token may be sold for, in its raw units, and at what price.
     *
     * Per operation, not per call: with a per-call cap a batch of N swaps
     * would take N caps in one operation. Per token, not per session: raw
     * units of different tokens do not add, and a cap sized for eighteen
     * decimals is a million times too large for six.
     *
     * `minOutPerUnit` is the owner's limit price — settlement units per 1e18
     * raw units of this token. It is what stops a leaked key from selling at
     * a floor of its own choosing: the operation's guard floor must be at
     * least the amount sold times this price.
     *
     * By the zero rule all three are non-zero: an entry that forbids
     * everything, or one that demands nothing, is an unfinished configuration
     * and is refused at grant time.
     */
    struct TokenCap {
        address token;
        uint256 maxPerOp;
        uint256 budget;
        uint256 minOutPerUnit;
    }

    /**
     * The execution template. With a non-zero guard every operation of the key
     * must be executeBatch, opening with guard.snapshot(settlementToken,
     * depository) and closing with guard.assertGained(settlementToken,
     * depository, floor). A zero guard means no template — and, because
     * selling without one is unbounded, no token caps and no router either.
     */
    struct GuardSpec {
        address guard;
        address settlementToken;
        address depository;
    }

    /**
     * The one contract the key may hand tokens to, and the one function on it.
     *
     * Its arguments are parsed, not trusted: the first two are the tokens and
     * the amounts it will pull with transferFrom, which is what the budgets
     * are charged from, and two more are the addresses leftovers and mints go
     * to, which must be this account. Any other selector on this address is
     * refused at grant time, so the parse cannot be stepped around.
     */
    struct SwapSpec {
        address router;
        bytes4 selector;
    }

    /**
     * Everything a grant says, in one struct: a swapped pair of arrays or
     * uint256 fields in a positional call gives itself away to neither the
     * compiler nor the tests, while the mistake costs money.
     *
     * targets and selectors are parallel arrays of equal length: the i-th pair
     * (targets[i], selectors[i]) is one permission. The same address may occur
     * in several pairs. The guard's own two pairs are added by the contract.
     */
    struct Grant {
        Limits limits;
        TokenCap[] tokenCaps;
        GuardSpec guard;
        SwapSpec swap;
        address[] targets;
        bytes4[] selectors;
        address[] feeRecipients;
    }

    /**
     * Grants a session key. Every grant opens a new epoch: the key's previous
     * permissions stop applying as a whole and only what is named here
     * applies. Narrowing the limits by re-granting IS possible — that is the
     * ordinary "revoke and re-issue" rotation.
     */
    function grantSession(address key, Grant calldata g) external onlySelfOrEntryPoint {
        if (key == address(0)) revert BadSessionConfig();
        // Zero here would mean "forever" and "uncounted" — the zero rule
        // demands the opposite. Open-ended values are expressed only by an
        // explicit maximum.
        if (g.limits.validUntil == 0 || g.limits.maxOps == 0) revert BadSessionConfig();
        if (g.targets.length != g.selectors.length) revert BadSessionConfig();

        Store storage st = _s();
        uint256 ep = ++st.epoch[key];
        // Writing the session is a separate function out of necessity: inline,
        // the compiler runs out of stack. The helpers below read what they
        // need from the stored session for the same reason.
        _setSession(st, key, g.limits, g.guard, g.swap);
        _setTokenCaps(st, key, ep, g.tokenCaps);
        _allowPairs(st, key, ep, g.targets, g.selectors);
        _allowFeeRecipients(st, key, ep, g.feeRecipients);
        emit SessionGranted(key, ep, g.limits.validUntil);
    }

    function _setSession(
        Store storage st,
        address key,
        Limits calldata limits,
        GuardSpec calldata guard,
        SwapSpec calldata swap
    ) private {
        if (guard.guard == address(0)) {
            // No template. The other fields would be dead data; a value in
            // them means the caller thought it was setting one.
            if (guard.settlementToken != address(0) || guard.depository != address(0)) revert BadSessionConfig();
            if (swap.router != address(0) || swap.selector != bytes4(0)) revert BadSessionConfig();
        } else {
            if (guard.settlementToken == address(0) || guard.depository == address(0)) revert BadSessionConfig();
            if (guard.guard == address(this) || guard.guard == ENTRY_POINT) revert TargetNotAllowed(guard.guard);
            // A template without a router would allow nothing to be sold, and
            // a router without a template would sell without a floor.
            if (swap.router == address(0) || swap.selector == bytes4(0)) revert BadSessionConfig();
            if (swap.router == address(this) || swap.router == ENTRY_POINT || swap.router == guard.guard) {
                revert TargetNotAllowed(swap.router);
            }
            if (_bannedSelector(swap.selector)) revert SelectorNotAllowed(swap.selector);
        }
        st.sessions[key] = Session({
            validUntil: limits.validUntil,
            maxOps: limits.maxOps,
            opsUsed: 0,
            exists: true,
            maxValuePerCall: limits.maxValuePerCall,
            valueBudget: limits.valueBudget,
            spentValue: 0,
            feeBudget: limits.feeBudget,
            spentFees: 0,
            maxFeePerOp: limits.maxFeePerOp,
            guard: guard.guard,
            guardToken: guard.settlementToken,
            guardHolder: guard.depository,
            swapRouter: swap.router,
            swapSelector: swap.selector
        });
        if (guard.guard != address(0)) {
            // The template's pairs and the router's one pair are granted by
            // the CONTRACT, not by the caller, so the list the caller sends is
            // about the tokens alone and cannot widen either of them.
            uint256 ep = st.epoch[key];
            st.allowed[key][ep][guard.guard][SEL_SNAPSHOT] = true;
            st.allowed[key][ep][guard.guard][SEL_ASSERT_GAINED] = true;
            // Deliberately NOT a knownTarget: the guard is never an approve spender.
            st.allowed[key][ep][swap.router][swap.selector] = true;
            // The router IS a knownTarget: it is the only legitimate spender
            // of an approve, and the approve is what lets it pull.
            st.knownTarget[key][ep][swap.router] = true;
        }
    }

    function _setTokenCaps(Store storage st, address key, uint256 ep, TokenCap[] calldata caps) private {
        // Selling without the template is unbounded; the caps are only
        // meaningful under the guard and its price.
        Session storage s = st.sessions[key];
        if (caps.length != 0 && s.guard == address(0)) revert BadSessionConfig();
        if (caps.length > MAX_OP_TOKENS) revert BadSessionConfig();
        for (uint256 i = 0; i < caps.length; ++i) {
            TokenCap calldata c = caps[i];
            if (c.token == address(0) || c.token == address(this) || c.token == ENTRY_POINT) {
                revert TargetNotAllowed(c.token);
            }
            // The settlement token is what the guard MEASURES; selling it
            // would let a batch satisfy its own floor out of the proceeds.
            if (c.token == s.guardToken || c.token == s.guard || c.token == s.swapRouter) {
                revert TargetNotAllowed(c.token);
            }
            // The zero rule: a cap that forbids is not written, it is refused,
            // and so is a price that demands nothing.
            if (c.maxPerOp == 0 || c.budget == 0 || c.minOutPerUnit == 0) revert BadSessionConfig();
            if (c.maxPerOp > c.budget) revert BadSessionConfig();
            TokenBudget storage tb = st.tokenBudget[key][ep][c.token];
            // Two entries for one token would mean two budgets; the second
            // would silently replace the first.
            if (tb.exists) revert BadSessionConfig();
            tb.exists = true;
            tb.maxPerOp = c.maxPerOp;
            tb.budget = c.budget;
            tb.minOutPerUnit = c.minOutPerUnit;
        }
    }

    function _allowPairs(
        Store storage st,
        address key,
        uint256 ep,
        address[] calldata targets,
        bytes4[] calldata selectors
    ) private {
        Session storage s = st.sessions[key];
        bool feeAllowed = s.maxFeePerOp != 0;
        address guard = s.guard;
        for (uint256 i = 0; i < targets.length; ++i) {
            address t = targets[i];
            bytes4 sel = selectors[i];
            // The account itself and the EntryPoint as targets mean escalation
            // to owner (grantSession, nested executeBatch) and moving the
            // deposit (withdrawTo). A session key never needs them.
            if (t == address(this) || t == ENTRY_POINT) revert TargetNotAllowed(t);
            if (_bannedSelector(sel)) revert SelectorNotAllowed(sel);
            // transfer without a cap means "the whole token". Granting such a
            // pair and relying on validation is not acceptable: it would be
            // rejected silently there, and the key would look fine until the
            // first trade.
            if (sel == SEL_TRANSFER && !feeAllowed) revert SelectorNotAllowed(sel);
            // The same for approve: a pair on a token without its own cap
            // would mean "the whole balance to the router". Refused here.
            if (sel == SEL_APPROVE && !st.tokenBudget[key][ep][t].exists) revert SelectorNotAllowed(sel);
            // The guard's and the router's pairs are the contract's to grant,
            // and only the ones the template names: a third function on either
            // in the pair list would be a way around the parse.
            if (t == guard || t == s.swapRouter) revert TargetNotAllowed(t);
            st.allowed[key][ep][t][sel] = true;
            st.knownTarget[key][ep][t] = true;
        }
    }

    /**
     * Fee recipients. A list separate from the targets: mixing them would let
     * a new router in targets silently become a legitimate destination for the
     * account's tokens.
     */
    function _allowFeeRecipients(
        Store storage st,
        address key,
        uint256 ep,
        address[] calldata feeRecipients
    ) private {
        uint256 maxFeePerOp = st.sessions[key].maxFeePerOp;
        // A cap without recipients and recipients without a cap are both
        // meaningless alone and mean an unfinished configuration.
        if ((maxFeePerOp == 0) != (feeRecipients.length == 0)) revert BadSessionConfig();
        for (uint256 i = 0; i < feeRecipients.length; ++i) {
            address to = feeRecipients[i];
            // The zero address is a burn, not a fee.
            if (to == address(0) || to == address(this) || to == ENTRY_POINT) {
                revert TargetNotAllowed(to);
            }
            st.feeRecipient[key][ep][to] = true;
        }
    }

    /// Revokes a key. Takes effect at once; the epoch grows here too, so the
    /// old permissions become unreachable regardless of the exists flag.
    function revokeSession(address key) external onlySelfOrEntryPoint {
        _revoke(_s(), key);
    }

    /// Revokes several keys in one operation — the disconnect path, where a
    /// wallet may hold a browser key and a server key.
    function revokeSessions(address[] calldata keys) external onlySelfOrEntryPoint {
        Store storage st = _s();
        for (uint256 i = 0; i < keys.length; ++i) _revoke(st, keys[i]);
    }

    function _revoke(Store storage st, address key) private {
        delete st.sessions[key];
        ++st.epoch[key];
        emit SessionRevoked(key);
    }

    // ---------------------------------------------------------------- views

    function getSession(address key) external view returns (Session memory) {
        return _s().sessions[key];
    }

    function sessionEpoch(address key) external view returns (uint256) {
        return _s().epoch[key];
    }

    /// What the key may still sell of one token in its current epoch; exists=false means the token is untouchable.
    function tokenBudget(address key, address token) external view returns (TokenBudget memory) {
        Store storage st = _s();
        return st.tokenBudget[key][st.epoch[key]][token];
    }

    /// Whether the (target, selector) pair applies to the key in its current epoch.
    function isAllowedCall(address key, address target, bytes4 selector)
        external
        view
        returns (bool)
    {
        Store storage st = _s();
        return st.allowed[key][st.epoch[key]][target][selector];
    }

    /**
     * Whether the address is accepted as a fee recipient in the key's current
     * epoch. Needed from outside for the same reason as isAllowedCall: the
     * client must be able to TELL the user which limit does not match instead
     * of learning it from an opaque bundler refusal.
     */
    function isFeeRecipient(address key, address to) external view returns (bool) {
        Store storage st = _s();
        return st.feeRecipient[key][st.epoch[key]][to];
    }

    // ------------------------------------------------------------ execution

    function execute(address target, uint256 value, bytes calldata data)
        external
        onlySelfOrEntryPoint
    {
        _call(target, value, data);
    }

    function executeBatch(Call[] calldata calls) external onlySelfOrEntryPoint {
        for (uint256 i = 0; i < calls.length; ++i) {
            _call(calls[i].target, calls[i].value, calls[i].data);
        }
    }

    function _call(address target, uint256 value, bytes memory data) internal {
        (bool ok, bytes memory result) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    // ------------------------------------------------------------ validation

    /**
     * Signature validation.
     *
     * The owner is tried first — so the account behaves exactly as before and
     * the FOMO app notices nothing. If the signature is not the owner's, it is
     * checked against the session keys, and the operation against the key's
     * limits.
     *
     * Returns validationData per ERC-4337: 0 for the owner (no expiry), 1 on
     * refusal, validUntil<<160 for a session key — the EntryPoint checks the time.
     */
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData) {
        if (msg.sender != ENTRY_POINT) revert NotAuthorized();

        address signer = _recover(userOpHash, userOp.signature);
        if (signer == address(0)) {
            validationData = VALIDATION_FAILED;
        } else if (signer == address(this)) {
            validationData = 0;
        } else {
            validationData = _validateSessionOp(signer, userOp);
        }

        if (missingAccountFunds != 0) {
            // The return value is deliberately not checked: the EntryPoint
            // decides whether the funds sufficed, and a revert here would block
            // the operation for no reason.
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}("");
            ok;
        }
    }

    /// Sums over one operation, collected while parsing its calls.
    struct Totals {
        uint256 value;          // native value
        uint256 fee;            // transfer arguments to a fee recipient
        uint256 floor;          // the gain the batch's guard call demands
        uint256 requiredFloor;  // the gain the owner's prices demand of it
        address[] tokens;       // tokens sold in this operation, each once
        uint256[] amounts;      // the summed amount the router will pull, per token
        uint256 count;          // how many of tokens/amounts are in use
    }

    /**
     * Whether a session key operation fits the limits. Returns validationData.
     *
     * An ordinary refusal is VALIDATION_FAILED, not a revert. On BROKEN
     * callData, however, abi.decode in _checkCalls reverts the whole
     * validation — also a refusal, just a loud one (AA23 for the EntryPoint):
     * malformed bytes never execute.
     *
     * Besides the call contents, four consumable limits are charged here: the
     * operation count, native value, the per-token approve budgets and the
     * worst-case gas cost. The cost is computed from the maxFeePerGas and gas
     * limits signed by the key — otherwise a leaked key, spending no wei of
     * value, could drain the account through prefund with an endless stream
     * of operations at an inflated gas price.
     *
     * Charging happens in validation while execution may revert; the budget
     * then burns without an actual spend. Deliberate: a refund in the
     * execution phase would open a reverse channel, and losing budget on
     * reverts is better than complicating the phase that moves money.
     */
    function _validateSessionOp(address key, PackedUserOperation calldata userOp)
        internal
        returns (uint256)
    {
        Store storage st = _s();
        Session storage s = st.sessions[key];
        if (!s.exists) return VALIDATION_FAILED;
        if (s.opsUsed >= s.maxOps) return VALIDATION_FAILED;

        (bool ok, Totals memory t) = _checkCalls(key, userOp.callData);
        if (!ok) return VALIDATION_FAILED;

        // All sums over the whole batch: a per-call cap would be bypassed by a
        // second identical call next to it.
        uint256 spentValue = s.spentValue + t.value;
        if (spentValue > s.valueBudget) return VALIDATION_FAILED;

        if (t.fee > s.maxFeePerOp) return VALIDATION_FAILED;

        // The price the OWNER fixed, not the one the key wrote: the batch's
        // guard floor has to be at least what the sold amounts are worth at
        // the grant's own minOutPerUnit. This is what makes the guard mean
        // something against a leaked key.
        if (t.floor < t.requiredFloor) return VALIDATION_FAILED;

        // Worst-case gas cost: maxFeePerGas * (all gas limits of the operation).
        // Field packing per EntryPoint v0.8: the high 128 bits of
        // accountGasLimits are verificationGasLimit, the low ones callGasLimit;
        // the low 128 bits of gasFees are maxFeePerGas. Under sponsored FOMO
        // operations all of these are zero and the charge is zero. On absurd
        // values the multiplication overflows and reverts validation — a
        // refusal as well.
        uint256 gasLimits = userOp.preVerificationGas
            + (uint256(userOp.accountGasLimits) >> 128)
            + uint256(uint128(uint256(userOp.accountGasLimits)));
        uint256 maxFeePerGas = uint256(uint128(uint256(userOp.gasFees)));
        uint256 spentFees = s.spentFees + maxFeePerGas * gasLimits;
        if (spentFees > s.feeBudget) return VALIDATION_FAILED;

        // The per-token budgets, checked and charged last: nothing after this
        // line can refuse, so a refusal never leaves a token budget spent.
        if (!_chargeSpend(st, key, t)) return VALIDATION_FAILED;

        s.opsUsed += 1;
        s.spentValue = spentValue;
        s.spentFees = spentFees;
        return uint256(s.validUntil) << 160;
    }

    /// Checks every token the operation sells against its own caps, then charges them.
    function _chargeSpend(Store storage st, address key, Totals memory t) private returns (bool) {
        uint256 ep = st.epoch[key];
        for (uint256 i = 0; i < t.count; ++i) {
            TokenBudget storage tb = st.tokenBudget[key][ep][t.tokens[i]];
            // The swap parse already needs a cap entry for the token; this
            // repeats it on purpose, so a sale never rests on one check.
            if (!tb.exists) return false;
            if (t.amounts[i] > tb.maxPerOp) return false;
            if (tb.spent + t.amounts[i] > tb.budget) return false;
        }
        for (uint256 i = 0; i < t.count; ++i) {
            st.tokenBudget[key][ep][t.tokens[i]].spent += t.amounts[i];
        }
        return true;
    }

    /**
     * Parses the operation's callData and checks EVERY inner call, adding up
     * the sums over the operation along the way.
     *
     * This is where the whole protection lives. From the outside every
     * operation looks the same — `executeBatch(...)` — so the contents have to
     * be bounded, not the form. abi.decode checks the layout: on wrong lengths
     * and offsets it reverts and the operation dies in validation. There is no
     * substitution between check and execution: executeBatch decodes the same
     * bytes by the same rule.
     */
    function _checkCalls(address key, bytes calldata callData)
        internal
        view
        returns (bool ok, Totals memory t)
    {
        if (callData.length < 4) return (false, t);
        bytes4 outer = bytes4(callData[:4]);
        Session storage s = _s().sessions[key];

        if (outer == this.execute.selector) {
            // A single call cannot carry the template, so a guarded key has no
            // use for execute — and must not have it, or the template would be
            // a formality.
            if (s.guard != address(0)) return (false, t);
            (address target, uint256 value, bytes memory data) =
                abi.decode(callData[4:], (address, uint256, bytes));
            t.tokens = new address[](MAX_OP_TOKENS);
            t.amounts = new uint256[](MAX_OP_TOKENS);
            if (!_allowedCall(key, target, value, data, t)) return (false, t);
            return (true, t);
        }

        if (outer == this.executeBatch.selector) {
            Call[] memory calls = abi.decode(callData[4:], (Call[]));
            if (s.guard != address(0)) {
                (bool fits, uint256 floor) = _fitsTemplate(s, calls);
                if (!fits) return (false, t);
                t.floor = floor;
            }
            t.tokens = new address[](MAX_OP_TOKENS);
            t.amounts = new uint256[](MAX_OP_TOKENS);
            for (uint256 i = 0; i < calls.length; ++i) {
                if (!_allowedCall(key, calls[i].target, calls[i].value, calls[i].data, t)) {
                    return (false, t);
                }
            }
            return (true, t);
        }

        // An unknown entry point is unavailable to a session key: the list of
        // what is allowed grows only deliberately, never by default.
        return (false, t);
    }

    /**
     * The execution template of a guarded key: snapshot first, assertGained
     * last, both on the session's settlement token and on THIS ACCOUNT, and
     * the guard nowhere else. Two guard calls exactly — a second snapshot
     * before the assert would reset the measurement. Returns the floor the
     * batch demands, which the caller weighs against the owner's prices.
     */
    function _fitsTemplate(Session storage s, Call[] memory calls) private view returns (bool, uint256) {
        uint256 n = calls.length;
        if (n < 2) return (false, 0);
        (bool okFirst,) = _guardCall(s, calls[0], SEL_SNAPSHOT, 68);
        if (!okFirst) return (false, 0);
        (bool okLast, uint256 floor) = _guardCall(s, calls[n - 1], SEL_ASSERT_GAINED, 100);
        if (!okLast) return (false, 0);
        for (uint256 i = 1; i + 1 < n; ++i) {
            if (calls[i].target == s.guard) return (false, 0);
        }
        return (true, floor);
    }

    /// One guard call of the template: exact selector, exact length, the session's token, this account, floor > 0.
    function _guardCall(Session storage s, Call memory c, bytes4 sel, uint256 length)
        private
        view
        returns (bool, uint256)
    {
        if (c.target != s.guard || c.value != 0) return (false, 0);
        bytes memory data = c.data;
        if (data.length != length) return (false, 0);
        bytes4 selector;
        uint256 tokenWord;
        uint256 holderWord;
        assembly {
            selector := mload(add(data, 32))
            tokenWord := mload(add(data, 36))
            holderWord := mload(add(data, 68))
        }
        if (selector != sel) return (false, 0);
        // Full words compared, not truncated addresses: dirty high bits would
        // be a different argument to a contract that checks them.
        if (tokenWord != uint256(uint160(s.guardToken))) return (false, 0);
        if (holderWord != uint256(uint160(s.guardHolder))) return (false, 0);
        if (sel != SEL_ASSERT_GAINED) return (true, 0);
        uint256 floor;
        assembly {
            floor := mload(add(data, 100))
        }
        if (floor == 0) return (false, 0);
        return (true, floor);
    }

    /**
     * Whether one inner call is allowed. The call's sums (value, approve, fee)
     * are added to t; the sums are checked against the caps at the operation
     * level, in _validateSessionOp, because the caps are per operation.
     */
    function _allowedCall(
        address key,
        address target,
        uint256 value,
        bytes memory data,
        Totals memory t
    ) internal view returns (bool) {
        // The account itself and the EntryPoint are closed unconditionally,
        // independent of the allow-list: a call into self would bypass the
        // parser by nesting (it is not recursive), a call into the EntryPoint
        // could move the deposit. grant would not issue them, but these two
        // lines must not depend on grant.
        if (target == address(this) || target == ENTRY_POINT) return false;

        Store storage st = _s();
        Session storage s = st.sessions[key];
        // Zero in maxValuePerCall forbids native value entirely — the zero
        // rule: any value > 0 fails the comparison with a zero cap.
        if (value > s.maxValuePerCall) return false;
        t.value += value;

        // A call without a selector is a plain native transfer. Not allowed
        // to the key: the targets are bounded, but a transfer past the
        // selectors would bypass the whole list of allowed actions.
        if (data.length < 4) return false;

        bytes4 selector;
        assembly {
            selector := mload(add(data, 32))
        }
        // Repeats the grantSession ban on purpose: the protection against
        // moving tokens must not rest on one check in one function.
        if (_bannedSelector(selector)) return false;

        uint256 ep = st.epoch[key];
        if (!st.allowed[key][ep][target][selector]) return false;

        // approve is checked deeper than the selector: the spender may only be
        // an allowed target of this session (the router). Otherwise "an
        // allowed approve" would mean approve(attacker, max) — and the token
        // would leave by an ordinary transferFrom from a foreign address, past
        // every limit. The amount goes to t under ITS token and is checked
        // against that token's caps above.
        // approve is checked deeper than the selector: the spender may only be
        // an allowed target of this session — in a guarded grant that is the
        // router and nothing else. It is NOT what the budget is charged from:
        // an allowance is only a permission, and one that already stands would
        // then cost nothing. What is charged is the amount the router is asked
        // to pull, parsed from the swap call below. The cap here is a second
        // line, so a leaked key cannot leave an enormous standing allowance
        // behind for some other path to use.
        if (selector == SEL_APPROVE) {
            if (data.length < 68) return false;
            uint256 word;
            uint256 allowance;
            assembly {
                word := mload(add(data, 36))
                allowance := mload(add(data, 68))
            }
            // The high bits of the address word are dropped; a 0.8 token
            // reverts such a call, an old one truncates the same way. Both
            // outcomes are safe.
            address spender = address(uint160(word));
            if (!st.knownTarget[key][ep][spender]) return false;
            TokenBudget storage cap = st.tokenBudget[key][ep][target];
            if (!cap.exists || allowance > cap.maxPerOp) return false;
        }

        // The swap. Its arguments are the only ones that say what actually
        // leaves this account, so they are parsed rather than trusted.
        if (target == s.swapRouter && selector == s.swapSelector) {
            if (!_swapCall(key, data, t)) return false;
        }

        // transfer is a fee to a listed recipient and nothing else. BOTH
        // arguments are checked: the recipient from the separate list and the
        // amount under the operation cap. Checking the recipient alone is not
        // enough — a leaked key could send the whole token balance to a
        // recipient: not theft, but damage to the user's position, and the cap
        // exists against exactly that.
        if (selector == SEL_TRANSFER) {
            if (data.length < 68) return false;
            uint256 toWord;
            uint256 amount;
            assembly {
                toWord := mload(add(data, 36))
                amount := mload(add(data, 68))
            }
            if (!st.feeRecipient[key][ep][address(uint160(toWord))]) return false;
            t.fee += amount;
        }
        return true;
    }

    /**
     * Reads the swap call's own arguments and charges the operation with them.
     *
     * The relay proxy's entry point is
     *   transferAndMulticall(address[] tokens, uint256[] amounts,
     *                        Call3Value[] calls, address refundTo,
     *                        address nftRecipient, bytes metadata)
     * and it moves the tokens with transferFrom(msg.sender, ...) — msg.sender
     * being this account. So `tokens` and `amounts` are exactly what will
     * leave, whatever allowance happens to stand.
     *
     * Only the two arrays are read. `calls` is not parsed and cannot be — it
     * is arbitrary. refundTo and nftRecipient are not checked either: the
     * live quotes put relay's own address there, and this key may send no
     * native value and receives no mints, so there is nothing to leak.
     *
     * Every offset is bounded against the call's own length before it is
     * followed. A malformed call is a refusal, not a read past the end.
     */
    function _swapCall(address key, bytes memory data, Totals memory t) private view returns (bool) {
        // Selector plus six head words: anything shorter is not this function.
        if (data.length < 4 + 6 * 32) return false;
        uint256 base;
        assembly { base := add(data, 36) }

        uint256 tokensAt;
        uint256 amountsAt;
        uint256 n;
        {
            uint256 args = data.length - 4;
            assembly {
                tokensAt := mload(base)
                amountsAt := mload(add(base, 32))
            }
            // Each offset must leave room for a length word inside the args.
            if (tokensAt > args - 32 || amountsAt > args - 32) return false;
            uint256 m;
            assembly {
                n := mload(add(base, tokensAt))
                m := mload(add(base, amountsAt))
            }
            if (n == 0 || n != m || n > MAX_OP_TOKENS) return false;
            // And room for every element after it. The multiplication reverts
            // on an absurd length, which is a refusal too.
            if (tokensAt + 32 + n * 32 > args) return false;
            if (amountsAt + 32 + n * 32 > args) return false;
        }

        uint256 ep = _s().epoch[key];
        for (uint256 i = 0; i < n; ++i) {
            uint256 tokenWord;
            uint256 amount;
            assembly {
                tokenWord := mload(add(add(base, tokensAt), add(32, mul(i, 32))))
                amount := mload(add(add(base, amountsAt), add(32, mul(i, 32))))
            }
            if (!_sellOne(key, ep, address(uint160(tokenWord)), amount, t)) return false;
        }
        return true;
    }

    /// One (token, amount) of a swap: it must be capped, and it costs the budget and demands a floor.
    function _sellOne(address key, uint256 ep, address token, uint256 amount, Totals memory t)
        private
        view
        returns (bool)
    {
        TokenBudget storage tb = _s().tokenBudget[key][ep][token];
        if (!tb.exists) return false;
        if (!_addSpend(t, token, amount)) return false;
        // What the owner's price says this much of the token is worth. Rounded
        // down, so the floor is never demanded to be higher than the price implies.
        t.requiredFloor += (amount * tb.minOutPerUnit) / PRICE_SCALE;
        return true;
    }

    /// Adds a sale to the operation's sum for ITS token. Two sales of one token add up.
    function _addSpend(Totals memory t, address token, uint256 amount) private pure returns (bool) {
        for (uint256 i = 0; i < t.count; ++i) {
            if (t.tokens[i] == token) {
                t.amounts[i] += amount;
                return true;
            }
        }
        if (t.count >= MAX_OP_TOKENS) return false;
        t.tokens[t.count] = token;
        t.amounts[t.count] = amount;
        t.count += 1;
        return true;
    }

    // ----------------------------------------------------------- compatibility

    function entryPoint() external pure returns (address) {
        return ENTRY_POINT;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        // Owner only. Not a convenience but a boundary: the wallet issued
        // Permit2 an unlimited allowance, and a session key signature accepted
        // here would open the whole balance through it, past every limit.
        return _recover(hash, signature) == address(this) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x150b7a02 || id == 0x4e2312e0 || id == 0x1626ba7e;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external pure returns (bytes4)
    {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external pure returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    receive() external payable {}

    // -------------------------------------------------------------- signature

    /**
     * Address recovery from a 65-byte signature.
     *
     * The upper half of s is rejected: (r, s) and (r, -s) give the same point,
     * so every signature has two equivalent representations. Without this
     * check one operation would have two different valid signatures.
     */
    function _recover(bytes32 hash, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        // Half the order of the secp256k1 curve. A long number in which a
        // digit is easily lost: with a shortened threshold the contract rejects
        // almost every legitimate signature, silently, as "bad signature".
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(hash, v, r, s);
    }
}
