import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'KnowledgeAssets',
  });
};

export default func;
func.tags = ['KnowledgeAssets', 'v9'];
func.dependencies = [
  'Hub',
  'KnowledgeAssetsStorage',
  'Chronos',
  'ShardingTableStorage',
  'ParametersStorage',
  'IdentityStorage',
  'PaymasterManager',
  'ContextGraphs',
];

// Archived per PRD §4.1 (V8/V9 contract stack retired in V10).
// hardhat-deploy still discovers this file via recursive scan of paths.deploy;
// func.skip guarantees the deployment step is a no-op.
func.skip = async () => true;
