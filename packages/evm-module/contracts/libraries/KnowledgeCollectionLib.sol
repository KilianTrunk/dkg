// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

library KnowledgeCollectionLib {
    /// @dev `publisher` is `msg.sender` of the publish/update tx (payment of
    ///      record). `author` is the verified agent identity from the
    ///      EIP-712 author attestation (V10.1+ publish path) or `address(0)`
    ///      for legacy KC mutations that predate author attestation. Readers
    ///      should treat `author == address(0)` as "this state change did
    ///      not carry an author attestation," never as a valid post-upgrade
    ///      identity claim. Trust path is on-chain verification at write
    ///      time; off-chain `dkg:authoredBy` triples mirror this for
    ///      SPARQL filtering convenience only.
    struct MerkleRoot {
        address publisher;
        bytes32 merkleRoot;
        uint256 timestamp;
        address author;
    }

    struct KnowledgeCollection {
        MerkleRoot[] merkleRoots;
        uint256[] burned;
        uint256 minted;
        uint88 byteSize;
        uint40 startEpoch;
        uint40 endEpoch;
        uint96 tokenAmount;
        bool isImmutable;
        /// @notice Number of leaves in the V10 flat-KC Merkle tree (sorted +
        ///         deduped `hashTripleV10` public leaves plus private roots),
        ///         matching `V10MerkleTree` in `@origintrail-official/dkg-core`.
        ///         `RandomSampling` uses this for `leafIndex = seed % count`.
        uint32 merkleLeafCount;
    }

    error ExceededKnowledgeCollectionMaxSize(uint256 id, uint256 minted, uint256 requested, uint256 maxSize);
    error InvalidTokenId(uint256 tokenId, uint256 startTokenId, uint256 endTokenId);
    error BurnFromZeroAddress();
    error BurnFromNonOwnerAddress();
    error InvalidTokenAmount(uint96 expectedTokenAMount, uint96 tokenAmount);
    error InvalidSignature(uint72 identityId, bytes32 messageHash, bytes32 r, bytes32 vs);
    error SignerIsNotNodeOperator(uint72 identityId, address signer);
    error KnowledgeCollectionExpired(uint256 id, uint256 currentEpoch, uint256 endEpoch);
    error NotPartOfKnowledgeCollection(uint256 id, uint256 tokenId);
    error SignaturesSignersMismatch(uint256 rAmount, uint256 vsAmount, uint256 identityIdsAmount);
    error MinSignaturesRequirementNotMet(uint256 requiredSignatures, uint256 receivedSignatures);
    error CannotUpdateImmutableKnowledgeCollection(uint256 id);
}
