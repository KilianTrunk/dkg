// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

library IdentityLib {
    uint256 public constant ADMIN_KEY = 1;
    uint256 public constant OPERATIONAL_KEY = 2;
    uint256 public constant ECDSA = 1;
    uint256 public constant RSA = 2;

    error OperationalAddressZero();
    error AdminAddressZero();
    error AdminEqualsOperational();
    error KeyIsEmpty();
    error OperationalKeyTaken(bytes32 key);
    error KeyAlreadyAttached(bytes32 key);
    error KeyNotAttached(bytes32 key);
    error CannotDeleteOnlyAdminKey(uint72 identityId);
    error CannotDeleteOnlyOperationalKey(uint72 identityId);
    error AdminFunctionOnly(uint72 identityId, address sender);

    // Distinct diagnostics for the createProfile op-wallet pre-flight
    // validation block. `OperationalKeyTaken(bytes32)` remains in use for
    // the cross-identity (global `identityIds`) collision case.
    error OperationalWalletDuplicate(address wallet);
    error OperationalWalletAlreadyPrimary(address wallet);
    error OperationalWalletEqualsAdmin(address wallet);
}
