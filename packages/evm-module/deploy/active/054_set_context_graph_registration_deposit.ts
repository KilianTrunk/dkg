import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

// OT-RFC-53 anti-spam: the per-CG registration deposit ships at 0 in the
// ParametersStorage constructor (so isolated test fixtures are unaffected) and
// is set to its live value here as part of the standard deploy. This protects
// production automatically — no manual governance step, no "we shipped it but
// it was off" silent failure. Test fixtures that don't include the
// `SetContextGraphRegistrationDeposit` tag keep the deposit at 0.
const CONTEXT_GRAPH_REGISTRATION_DEPOSIT = 100n * 10n ** 18n; // 100 TRAC

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const parametersStorageAddress =
    hre.helpers.contractDeployments.contracts['ParametersStorage'].evmAddress;

  const ParametersStorage = await hre.ethers.getContractAt(
    'ParametersStorage',
    parametersStorageAddress,
  );

  const current = await ParametersStorage.contextGraphRegistrationDeposit();
  if (current === CONTEXT_GRAPH_REGISTRATION_DEPOSIT) {
    console.log(
      `contextGraphRegistrationDeposit already ${current} (100 TRAC), skipping`,
    );
    return;
  }

  console.log(
    `Setting contextGraphRegistrationDeposit to ${CONTEXT_GRAPH_REGISTRATION_DEPOSIT} (100 TRAC)...`,
  );
  const tx = await ParametersStorage.setContextGraphRegistrationDeposit(
    CONTEXT_GRAPH_REGISTRATION_DEPOSIT,
  );
  await tx.wait();
  console.log(`contextGraphRegistrationDeposit set (tx: ${tx.hash})`);
};

export default func;
// NB: intentionally NOT tagged 'v10' — only a full deploy (runs every script)
// or a fixture explicitly listing this tag activates the deposit, so v10-group
// test fixtures stay at 0.
func.tags = ['SetContextGraphRegistrationDeposit'];
func.dependencies = ['ParametersStorage'];
