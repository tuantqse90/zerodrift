// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HedgeRegistry
/// @notice Permissionless on-chain attestation log for delta-neutral hedge epochs.
///         A hedge epoch pairs a spot leg (e.g. a NullTerminal aggregator swap) with a
///         perp leg (e.g. a Perpl short) at equal notional. Anyone can record their own
///         epochs; records are keyed by msg.sender and immutable once closed.
/// @dev    Holds no funds, has no owner, and cannot be upgraded. References are opaque
///         32-byte values (tx hashes for on-chain legs, digest of fill ids for CLOB legs).
contract HedgeRegistry {
    struct HedgeEpoch {
        uint64 openedAt; // block.timestamp at open
        uint64 closedAt; // 0 while open
        uint32 marketId; // perp venue market id (Perpl MON = 10)
        uint128 notionalUsd6; // 6-decimal USD notional at open
        uint128 closeNotionalUsd6; // 6-decimal USD notional at close
        bytes32 spotTxRef; // spot-leg reference at open
        bytes32 perpRef; // perp-leg reference at open
        bytes32 closeSpotTxRef; // spot-leg reference at close
        bytes32 closePerpRef; // perp-leg reference at close
    }

    mapping(address => HedgeEpoch[]) private _epochs;

    event EpochOpened(
        address indexed owner,
        uint256 indexed epochId,
        uint32 indexed marketId,
        uint128 notionalUsd6,
        bytes32 spotTxRef,
        bytes32 perpRef
    );

    event EpochClosed(
        address indexed owner,
        uint256 indexed epochId,
        uint128 closeNotionalUsd6,
        bytes32 closeSpotTxRef,
        bytes32 closePerpRef
    );

    error OutOfRange();
    error AlreadyClosed();

    /// @notice Record the opening of a hedge epoch for msg.sender.
    /// @param marketId Perp venue market id (Perpl MON = 10).
    /// @param notionalUsd6 USD notional of each leg at open, 6 decimals.
    /// @param spotTxRef Reference to the spot leg (tx hash).
    /// @param perpRef Reference to the perp leg (digest of order/fill ids).
    /// @return epochId Sequential id within msg.sender's epoch list.
    function openEpoch(uint32 marketId, uint128 notionalUsd6, bytes32 spotTxRef, bytes32 perpRef)
        external
        returns (uint256 epochId)
    {
        epochId = _epochs[msg.sender].length;
        _epochs[msg.sender].push(
            HedgeEpoch({
                openedAt: uint64(block.timestamp),
                closedAt: 0,
                marketId: marketId,
                notionalUsd6: notionalUsd6,
                closeNotionalUsd6: 0,
                spotTxRef: spotTxRef,
                perpRef: perpRef,
                closeSpotTxRef: bytes32(0),
                closePerpRef: bytes32(0)
            })
        );
        emit EpochOpened(msg.sender, epochId, marketId, notionalUsd6, spotTxRef, perpRef);
    }

    /// @notice Record the close of one of msg.sender's open epochs.
    /// @param epochId Id returned by openEpoch.
    /// @param closeNotionalUsd6 USD notional unwound at close, 6 decimals.
    /// @param closeSpotTxRef Reference to the closing spot leg.
    /// @param closePerpRef Reference to the closing perp leg.
    function closeEpoch(uint256 epochId, uint128 closeNotionalUsd6, bytes32 closeSpotTxRef, bytes32 closePerpRef)
        external
    {
        if (epochId >= _epochs[msg.sender].length) revert OutOfRange();
        HedgeEpoch storage epoch = _epochs[msg.sender][epochId];
        if (epoch.closedAt != 0) revert AlreadyClosed();

        epoch.closedAt = uint64(block.timestamp);
        epoch.closeNotionalUsd6 = closeNotionalUsd6;
        epoch.closeSpotTxRef = closeSpotTxRef;
        epoch.closePerpRef = closePerpRef;

        emit EpochClosed(msg.sender, epochId, closeNotionalUsd6, closeSpotTxRef, closePerpRef);
    }

    /// @notice Number of epochs ever opened by an address.
    function epochCount(address owner) external view returns (uint256) {
        return _epochs[owner].length;
    }

    /// @notice Read a single epoch.
    function getEpoch(address owner, uint256 epochId) external view returns (HedgeEpoch memory) {
        if (epochId >= _epochs[owner].length) revert OutOfRange();
        return _epochs[owner][epochId];
    }
}
