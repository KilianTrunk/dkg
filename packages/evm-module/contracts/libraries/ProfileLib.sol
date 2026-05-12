// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

library ProfileLib {
    // Network Relay Registry (RFC 04 / Issue #461) — bounds for the
    // multiaddr advertisement appended to each profile. Modest caps:
    // a node listening on a handful of transports rarely needs more than
    // a few entries; a full /dns/.../tcp/.../p2p/<peerId> fits in 256.
    uint16 internal constant MAX_MULTIADDRS = 8;
    uint16 internal constant MAX_MULTIADDR_LENGTH = 256;

    struct OperatorFee {
        uint16 feePercentage;
        uint256 effectiveDate;
    }

    struct ProfileInfo {
        string name;
        bytes nodeId;
        uint96 ask;
        OperatorFee[] operatorFees;
        // Network Relay Registry (RFC 04 / Issue #461). Appended to the
        // tail of the struct so existing storage layouts in mappings stay
        // backwards-compatible at the slot level: old keys read these as
        // zero/empty until the operator opts in via Profile.updateMultiaddrs.
        bool relayCapable;
        string[] multiaddrs;
    }

    error IdentityAlreadyExists(uint72 identityId, address wallet);
    error TooManyOperationalWallets(uint16 allowed, uint16 provided);
    error EmptyNodeName();
    error EmptyNodeId();
    error NodeNameAlreadyExists(string nodeName);
    error NodeIdAlreadyExists(bytes nodeId);
    error OperatorFeeOutOfRange(uint16 operatorFee);
    error ZeroAsk();
    error AskUpdateOnCooldown(uint72 identityId, uint256 cooldownEnd);
    error NoOperatorFees(uint72 identityId);
    error ProfileDoesntExist(uint72 identityId);
    error NoPendingNodeAsk();
    error NoPendingOperatorFee();
    error InvalidOperatorFee();
    error TooManyMultiaddrs(uint16 allowed, uint16 provided);
    error MultiaddrTooLong(uint16 maxLen, uint16 provided);
    error EmptyMultiaddr(uint16 index);
}
