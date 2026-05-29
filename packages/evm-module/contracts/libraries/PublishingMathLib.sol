// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

library PublishingMathLib {
    function discountBps(uint96 committedTRAC) internal pure returns (uint256) {
        if (committedTRAC >= 1_000_000 ether) return 7500;
        if (committedTRAC >= 500_000 ether)   return 5000;
        if (committedTRAC >= 250_000 ether)   return 4000;
        if (committedTRAC >= 100_000 ether)   return 3000;
        if (committedTRAC >= 50_000 ether)    return 2000;
        if (committedTRAC >= 25_000 ether)    return 1000;
        return 0;
    }
}
