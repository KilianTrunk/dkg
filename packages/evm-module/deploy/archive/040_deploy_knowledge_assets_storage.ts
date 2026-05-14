import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const uri =
    hre.helpers.parametersConfig[hre.network.config.environment]?.KnowledgeAssetsStorage?.uriBase ??
    hre.helpers.parametersConfig[hre.network.config.environment]?.KnowledgeCollectionStorage?.uriBase ??
    'did:dkg:v9';

  await hre.helpers.deploy({
    newContractName: 'KnowledgeAssetsStorage',
    setContractInHub: false,
    setAssetStorageInHub: true,
    additionalArgs: [uri],
  });
};

export default func;
func.tags = ['KnowledgeAssetsStorage', 'v9'];
func.dependencies = ['Hub', 'Token'];

// Archived per PRD §4.1 (V8/V9 contract stack retired in V10).
// hardhat-deploy still discovers this file via recursive scan of paths.deploy;
// func.skip guarantees the deployment step is a no-op.
func.skip = async () => true;
