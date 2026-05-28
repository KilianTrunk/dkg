// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockReentrantPublisher
 * @notice Test-only harness for the `nonReentrant` perimeter on
 *         `KnowledgeAssetsV10.publish` / `update` /
 *         `extendKnowledgeCollectionLifetime`. The mock acts as the
 *         publisher (msg.sender) of a real V10 publish and re-enters the
 *         target entrypoint from inside the ERC-1155 mint acceptance
 *         callback (`onERC1155BatchReceived`).
 *
 * ERC1155Delta wraps the receiver callback in try/catch and converts any
 * revert into `TransferToNonERC1155ReceiverImplementer()` — so we cannot
 * propagate the inner `ReentrancyGuardReentrantCall()` directly. Instead,
 * the mock captures the inner-call result itself, asserts the selector
 * matches the OpenZeppelin reentrancy-guard error, and exposes the result
 * via `reentryRejected()`. The outer publish completes normally.
 *
 * Selector cross-check:
 *   bytes4(keccak256("ReentrancyGuardReentrantCall()")) == 0x3ee5aeb5
 *
 * Not deployed in production; lives outside the staked contract set.
 */
contract MockReentrantPublisher is IERC1155Receiver {
    bytes4 internal constant _REENTRANCY_SELECTOR = 0x3ee5aeb5;

    address public kav10;
    bytes public innerCalldata;
    bool public reentryAttempted;
    bool public reentryRejected;
    bytes4 public lastInnerSelector;

    function setKAV10(address _kav10) external {
        kav10 = _kav10;
    }

    function arm(bytes calldata _innerCalldata) external {
        innerCalldata = _innerCalldata;
        reentryAttempted = false;
        reentryRejected = false;
        lastInnerSelector = bytes4(0);
    }

    function approveTrac(address token, uint256 amount) external {
        IERC20(token).approve(kav10, amount);
    }

    /**
     * @notice Forward an arbitrary call to KAV10 from this contract's
     *         storage context (so msg.sender at the target == this mock).
     *         Bubbles up any revert from the underlying call.
     */
    function callKAV10(bytes calldata callPayload) external returns (bytes memory) {
        (bool ok, bytes memory ret) = kav10.call(callPayload);
        if (!ok) {
            // Propagate the original revert reason / selector unchanged.
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external override returns (bytes4) {
        _maybeReenter();
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external override returns (bytes4) {
        _maybeReenter();
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    function _maybeReenter() internal {
        if (innerCalldata.length == 0 || reentryAttempted) {
            return;
        }
        reentryAttempted = true;

        (bool ok, bytes memory ret) = kav10.call(innerCalldata);
        if (ok) {
            // Re-entry SUCCEEDED — guard is missing. Leave both flags so
            // the test sees reentryRejected == false and the assertion
            // fails loudly.
            return;
        }
        if (ret.length >= 4) {
            bytes4 sel;
            // solhint-disable-next-line no-inline-assembly
            assembly {
                sel := mload(add(ret, 0x20))
            }
            lastInnerSelector = sel;
            if (sel == _REENTRANCY_SELECTOR) {
                reentryRejected = true;
            }
        }
    }
}
