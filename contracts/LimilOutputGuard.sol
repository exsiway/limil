// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * Output guard: a minimum trade result checked inside the same operation.
 *
 * A sell through relay is executed by an aggregator with its own tolerance
 * (about 10% below the quote), and pools whose hooks take 8–14% on top of the
 * displayed price fit inside it. The user sets 5% slippage while the trade may
 * legitimately finish 10% worse on chain. This contract sets ITS OWN bound: in
 * one batch the account snapshots the recipient's balance, makes the trade and
 * checks that the recipient gained at least the floor. Less — the whole batch
 * reverts, the token stays with the user, the attempt costs only gas.
 *
 * Deliberately absent: an owner, upgrades, receiving ether, persistent state.
 * The snapshot lives in transient storage (EIP-1153), i.e. exactly until the
 * end of the transaction: a stale snapshot cannot exist by construction. The
 * snapshot key includes the caller, so a foreign contract can neither plant a
 * snapshot for us nor read ours. The only external call is balanceOf, made as
 * a staticcall: the token state cannot be changed.
 */
interface IERC20Balance {
    function balanceOf(address owner) external view returns (uint256);
}

contract LimilOutputGuard {
    error NoSnapshot();
    error OutputBelowFloor(uint256 gained, uint256 floor);
    error FloorIsZero();

    /** Snapshot slot: caller, token and holder all take part in the key. */
    function _slot(address token, address holder) private view returns (bytes32) {
        return keccak256(abi.encode(msg.sender, token, holder));
    }

    /**
     * Records the balance of `token` at `holder` for the caller. Stored with an
     * offset of one, to tell "a snapshot of zero" from "no snapshot".
     */
    function snapshot(address token, address holder) external {
        uint256 before = IERC20Balance(token).balanceOf(holder);
        bytes32 slot = _slot(token, holder);
        assembly {
            tstore(slot, add(before, 1))
        }
    }

    /**
     * Checks the balance gain against the floor and clears the snapshot.
     * Without a snapshot in this transaction it reverts: a check without a
     * reference point would check nothing. A zero floor reverts too: such a
     * check protects nothing while its presence in the batch suggests otherwise.
     */
    function assertGained(address token, address holder, uint256 minGain) external {
        if (minGain == 0) revert FloorIsZero();
        bytes32 slot = _slot(token, holder);
        uint256 stored;
        assembly {
            stored := tload(slot)
            tstore(slot, 0)
        }
        if (stored == 0) revert NoSnapshot();
        uint256 before = stored - 1;
        uint256 current = IERC20Balance(token).balanceOf(holder);
        uint256 gained = current > before ? current - before : 0;
        if (gained < minGain) revert OutputBelowFloor(gained, minGain);
    }
}
