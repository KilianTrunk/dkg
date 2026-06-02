import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * V10 — deploys `V8MigrationEligibility`, the frozen registry of V8
 * delegators that qualify for the 60-day V10 conviction-lock credit on
 * the 6m / 12m tiers.
 *
 * Contract has no `initialize()`: it is a stateless HubDependent registry
 * whose entire authoritative state (`isEligible`, `frozen`, `eligibleCount`)
 * is populated by HubOwner via `setEligibleBatch` + `freeze` AFTER the
 * snapshot job completes off-chain. Hub registration alone is sufficient
 * for `StakingV10._convertToNFT` to resolve and read it.
 *
 * Numbered between the conviction-storage step (049b) and the StakingV10
 * step (055) so that StakingV10's deploy can list it as a dependency
 * without bumping any earlier file's number.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'V8MigrationEligibility',
  });
};

export default func;
func.tags = ['V8MigrationEligibility', 'v10'];
func.dependencies = ['Hub'];
