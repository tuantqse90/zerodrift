// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { HedgeRegistry } from "../src/HedgeRegistry.sol";

contract HedgeRegistryTest is Test {
    HedgeRegistry internal registry;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

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

    function setUp() public {
        registry = new HedgeRegistry();
    }

    function test_openEpoch_storesFieldsAndEmits() public {
        vm.warp(1_000_000);
        vm.expectEmit(true, true, true, true);
        emit EpochOpened(alice, 0, 10, 100e6, bytes32(uint256(1)), bytes32(uint256(2)));

        vm.prank(alice);
        uint256 id = registry.openEpoch(10, 100e6, bytes32(uint256(1)), bytes32(uint256(2)));

        assertEq(id, 0);
        HedgeRegistry.HedgeEpoch memory epoch = registry.getEpoch(alice, 0);
        assertEq(epoch.openedAt, 1_000_000);
        assertEq(epoch.closedAt, 0);
        assertEq(epoch.marketId, 10);
        assertEq(epoch.notionalUsd6, 100e6);
        assertEq(epoch.spotTxRef, bytes32(uint256(1)));
        assertEq(epoch.perpRef, bytes32(uint256(2)));
        assertEq(registry.epochCount(alice), 1);
    }

    function test_openEpoch_sequentialIdsPerOwner() public {
        vm.prank(alice);
        assertEq(registry.openEpoch(10, 1e6, 0, 0), 0);
        vm.prank(bob);
        assertEq(registry.openEpoch(10, 2e6, 0, 0), 0);
        vm.prank(alice);
        assertEq(registry.openEpoch(10, 3e6, 0, 0), 1);
        vm.prank(bob);
        assertEq(registry.openEpoch(10, 4e6, 0, 0), 1);

        assertEq(registry.epochCount(alice), 2);
        assertEq(registry.epochCount(bob), 2);
        assertEq(registry.getEpoch(alice, 1).notionalUsd6, 3e6);
        assertEq(registry.getEpoch(bob, 1).notionalUsd6, 4e6);
    }

    function test_closeEpoch_setsClosedAtAndEmits() public {
        vm.warp(1_000_000);
        vm.prank(alice);
        registry.openEpoch(10, 100e6, bytes32(uint256(1)), bytes32(uint256(2)));

        vm.warp(1_000_500);
        vm.expectEmit(true, true, false, true);
        emit EpochClosed(alice, 0, 99e6, bytes32(uint256(3)), bytes32(uint256(4)));

        vm.prank(alice);
        registry.closeEpoch(0, 99e6, bytes32(uint256(3)), bytes32(uint256(4)));

        HedgeRegistry.HedgeEpoch memory epoch = registry.getEpoch(alice, 0);
        assertEq(epoch.closedAt, 1_000_500);
        assertEq(epoch.closeNotionalUsd6, 99e6);
        assertEq(epoch.closeSpotTxRef, bytes32(uint256(3)));
        assertEq(epoch.closePerpRef, bytes32(uint256(4)));
    }

    function test_closeEpoch_revert_outOfRange() public {
        vm.prank(alice);
        vm.expectRevert(HedgeRegistry.OutOfRange.selector);
        registry.closeEpoch(0, 0, 0, 0);
    }

    function test_closeEpoch_revert_alreadyClosed() public {
        vm.startPrank(alice);
        registry.openEpoch(10, 100e6, 0, 0);
        registry.closeEpoch(0, 100e6, 0, 0);
        vm.expectRevert(HedgeRegistry.AlreadyClosed.selector);
        registry.closeEpoch(0, 100e6, 0, 0);
        vm.stopPrank();
    }

    function test_closeEpoch_cannotTouchOtherOwners() public {
        vm.prank(alice);
        registry.openEpoch(10, 100e6, 0, 0);

        // bob has no epochs, so alice's id 0 is out of range for him
        vm.prank(bob);
        vm.expectRevert(HedgeRegistry.OutOfRange.selector);
        registry.closeEpoch(0, 100e6, 0, 0);

        // alice's epoch untouched
        assertEq(registry.getEpoch(alice, 0).closedAt, 0);
    }

    function test_multipleConcurrentOpenEpochs_sameOwner() public {
        vm.startPrank(alice);
        registry.openEpoch(10, 1e6, 0, 0);
        registry.openEpoch(1, 2e6, 0, 0);
        registry.openEpoch(20, 3e6, 0, 0);

        // close the middle one only
        registry.closeEpoch(1, 2e6, 0, 0);
        vm.stopPrank();

        assertEq(registry.getEpoch(alice, 0).closedAt, 0);
        assertGt(registry.getEpoch(alice, 1).closedAt, 0);
        assertEq(registry.getEpoch(alice, 2).closedAt, 0);
    }

    function test_getEpoch_revert_outOfRange() public {
        vm.expectRevert(HedgeRegistry.OutOfRange.selector);
        registry.getEpoch(alice, 0);
    }

    function testFuzz_openClose_roundTrip(uint32 marketId, uint128 notional, bytes32 spotRef, bytes32 perpRef)
        public
    {
        vm.warp(1_000_000);
        vm.prank(alice);
        uint256 id = registry.openEpoch(marketId, notional, spotRef, perpRef);

        vm.warp(1_000_000 + 3600);
        vm.prank(alice);
        registry.closeEpoch(id, notional, spotRef, perpRef);

        HedgeRegistry.HedgeEpoch memory epoch = registry.getEpoch(alice, id);
        assertEq(epoch.marketId, marketId);
        assertEq(epoch.notionalUsd6, notional);
        assertEq(epoch.spotTxRef, spotRef);
        assertEq(epoch.perpRef, perpRef);
        assertEq(epoch.closeNotionalUsd6, notional);
        assertGe(epoch.closedAt, epoch.openedAt);
    }
}
