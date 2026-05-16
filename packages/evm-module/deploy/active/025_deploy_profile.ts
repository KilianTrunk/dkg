import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'Profile',
  });
};

export default func;
func.tags = ['Profile'];
func.dependencies = [
  'Hub',
  'Identity',
  'IdentityStorage',
  'ParametersStorage',
  'ProfileStorage',
  'WhitelistStorage',
  'Ask',
  // D13 — Profile.initialize() reads `isOperatorFeeClaimedForEpoch` via CSS
  // after the DelegatorsInfo redirect. V6/V8 DelegatorsInfo migrators
  // retired in TB-1 (archive).
  'ConvictionStakingStorage',
  'Chronos',
];
