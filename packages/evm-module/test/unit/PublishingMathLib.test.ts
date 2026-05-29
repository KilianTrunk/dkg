import { expect } from 'chai';
import hre from 'hardhat';

describe('@unit PublishingMathLib', () => {
  it('prorates active sink rewards across current, full, and final epochs', async () => {
    const Harness = await hre.ethers.getContractFactory('PublishingMathLibHarness');
    const harness = await Harness.deploy();

    const [starts, ends, amounts] = await harness.prorateActiveSink(
      1000n,
      10,
      4,
      100,
      50,
    );

    expect(starts).to.deep.equal([10n, 11n, 14n]);
    expect(ends).to.deep.equal([10n, 13n, 14n]);
    expect(amounts).to.deep.equal([125n, 750n, 125n]);
  });
});
