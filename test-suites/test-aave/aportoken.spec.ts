import { network } from 'hardhat';
import { ZERO_ADDRESS } from '../../helpers/constants';
import { convertToCurrencyDecimals } from '../../helpers/contracts-helpers';
import { expect } from 'chai';
import { BigNumber, BigNumberish, ethers } from 'ethers';
import { ProtocolErrors } from '../../helpers/types';
import { makeSuite, SignerWithAddress, TestEnv } from './helpers/make-suite';
import { deployMockV3Aggregator } from '../../helpers/contracts-deployments';
import AaveConfig from '../../markets/aave';
import { APoRToken, LendingPool, MintableERC20, MockV3Aggregator } from '../../types';

// = base * 10^{exponent}
const exp = (base: BigNumberish, exponent: BigNumberish): BigNumber => {
  return BigNumber.from(base).mul(BigNumber.from(10).pow(exponent));
};

makeSuite('APoRToken: Mint with proof-of-reserves check', (testEnv: TestEnv) => {
  const ONE_DAY_SECONDS = 24 * 60 * 60; // seconds in a day
  const WBTC_FEED_INITIAL_ANSWER = exp(1_000_000, 8).toString(); // "1M WBTC in reserves"
  let wbtc: MintableERC20;
  let aWbtc: APoRToken;
  let users: SignerWithAddress[];
  let pool: LendingPool;
  let regularUser: SignerWithAddress;
  let amountToDeposit;
  let mockV3Aggregator: MockV3Aggregator;

  beforeEach(async () => {
    // `testEnv` is initialised in an async `before` hook up the tree,
    // so they must be initialised here
    wbtc = testEnv.wbtc;
    aWbtc = testEnv.aWbtc;
    users = testEnv.users;
    pool = testEnv.pool;
    regularUser = users[1];

    // Mint some fake WBTC
    amountToDeposit = await convertToCurrencyDecimals(wbtc.address, '10');
    await wbtc.connect(regularUser.signer).mint(amountToDeposit);
    await wbtc.connect(regularUser.signer).approve(pool.address, amountToDeposit);

    // Deploy mock V3 aggregator as the PoR feed
    mockV3Aggregator = await deployMockV3Aggregator('8', WBTC_FEED_INITIAL_ANSWER);
  });

  describe('Proof-of-reserves check', () => {
    it('should mint successfully when feed is unset', async () => {
      // Make sure feed is unset
      expect(await aWbtc.feed()).to.equal(ZERO_ADDRESS);

      // Deposit WBTC - the aToken will call the feed before minting to check PoR
      const balanceBefore = await aWbtc.balanceOf(regularUser.address);
      await pool
        .connect(regularUser.signer)
        .deposit(wbtc.address, amountToDeposit, regularUser.address, '0');
      expect(await aWbtc.balanceOf(regularUser.address)).to.equal(
        balanceBefore.add(amountToDeposit)
      );
    });

    it('should mint successfully when feed is set, but heartbeat is unset (defaulting to MAX_AGE)', async () => {
      // Make sure feed and heartbeat values are what we're testing for
      await aWbtc.setFeed(mockV3Aggregator.address);
      expect(await aWbtc.feed()).to.equal(mockV3Aggregator.address);
      await aWbtc.setHeartbeat(0);
      expect(await aWbtc.heartbeat()).to.equal(await aWbtc.MAX_AGE());

      // Deposit WBTC - the aToken will call the feed before minting to check PoR
      const balanceBefore = await aWbtc.balanceOf(regularUser.address);
      await pool
        .connect(regularUser.signer)
        .deposit(wbtc.address, amountToDeposit, regularUser.address, '0');
      expect(await aWbtc.balanceOf(regularUser.address)).to.equal(
        amountToDeposit.add(balanceBefore)
      );
    });

    it('should mint successfully when both feed and heartbeat are set', async () => {
      // Make sure feed and heartbeat values are what we're testing for
      await aWbtc.setFeed(mockV3Aggregator.address);
      expect(await aWbtc.feed()).to.equal(mockV3Aggregator.address);
      await aWbtc.setHeartbeat(ONE_DAY_SECONDS);
      expect(await aWbtc.heartbeat()).to.equal(ONE_DAY_SECONDS);

      // Deposit WBTC - the aToken will call the feed before minting to check PoR
      const balanceBefore = await aWbtc.balanceOf(regularUser.address);
      await pool
        .connect(regularUser.signer)
        .deposit(wbtc.address, amountToDeposit, regularUser.address, '0');
      expect(await aWbtc.balanceOf(regularUser.address)).to.equal(
        balanceBefore.add(amountToDeposit)
      );
    });

    it('should mint successfully when feed decimals < underlying decimals', async () => {
      // Re-deploy aggregator with fewer decimals
      const currentWbtcSupply = await wbtc.totalSupply();
      mockV3Aggregator = await deployMockV3Aggregator(
        '6',
        currentWbtcSupply.div(exp(1, 2)).toString()
      );

      // Make sure feed and heartbeat values are set
      await aWbtc.setFeed(mockV3Aggregator.address);
      expect(await aWbtc.feed()).to.equal(mockV3Aggregator.address);
      await aWbtc.setHeartbeat(ONE_DAY_SECONDS);
      expect(await aWbtc.heartbeat()).to.equal(ONE_DAY_SECONDS);

      // Deposit WBTC - the aToken will call the feed before minting to check PoR
      const balanceBefore = await aWbtc.balanceOf(regularUser.address);
      await pool
        .connect(regularUser.signer)
        .deposit(wbtc.address, amountToDeposit, regularUser.address, '0');
      expect(await aWbtc.balanceOf(regularUser.address)).to.equal(
        balanceBefore.add(amountToDeposit)
      );
    });

    it('should mint successfully when feed decimals > underlying decimals', async () => {
      // Re-deploy aggregator with more decimals
      const currentWbtcSupply = await wbtc.totalSupply();
      mockV3Aggregator = await deployMockV3Aggregator(
        '18',
        currentWbtcSupply.mul(exp(1, 10)).toString()
      );

      // Make sure feed and heartbeat values are set
      await aWbtc.setFeed(mockV3Aggregator.address);
      expect(await aWbtc.feed()).to.equal(mockV3Aggregator.address);
      await aWbtc.setHeartbeat(ONE_DAY_SECONDS);
      expect(await aWbtc.heartbeat()).to.equal(ONE_DAY_SECONDS);

      // Deposit WBTC - the aToken will call the feed before minting to check PoR
      const balanceBefore = await aWbtc.balanceOf(regularUser.address);
      await pool
        .connect(regularUser.signer)
        .deposit(wbtc.address, amountToDeposit, regularUser.address, '0');
      expect(await aWbtc.balanceOf(regularUser.address)).to.equal(
        balanceBefore.add(amountToDeposit)
      );
    });

    it('should mint successfully when underlying supply == proof-of-reserves', async () => {
      // Re-deploy aggregator with WBTC reserves == WBTC underlying supply
      const currentWbtcSupply = await wbtc.totalSupply();
      mockV3Aggregator = await deployMockV3Aggregator('8', currentWbtcSupply.toString());

      // Make sure feed and heartbeat values are set
      await aWbtc.setFeed(mockV3Aggregator.address);
      expect(await aWbtc.feed()).to.equal(mockV3Aggregator.address);
      await aWbtc.setHeartbeat(ONE_DAY_SECONDS);
      expect(await aWbtc.heartbeat()).to.equal(ONE_DAY_SECONDS);

      // Deposit WBTC - the aToken will call the feed before minting to check PoR
      const balanceBefore = await aWbtc.balanceOf(regularUser.address);
      await pool
        .connect(regularUser.signer)
        .deposit(wbtc.address, amountToDeposit, regularUser.address, '0');
      expect(await aWbtc.balanceOf(regularUser.address)).to.equal(
        balanceBefore.add(amountToDeposit)
      );
    });

    it('should revert if underlying supply > proof-of-reserves', async () => {
      // Re-deploy aggregator with fewer WBTC in reserves
      const currentWbtcSupply = await wbtc.totalSupply();
      const notEnoughReserves = currentWbtcSupply.sub('1');
      mockV3Aggregator = await deployMockV3Aggregator('8', notEnoughReserves.toString());

      // Make sure feed and heartbeat values are set
      await aWbtc.setFeed(mockV3Aggregator.address);
      expect(await aWbtc.feed()).to.equal(mockV3Aggregator.address);
      await aWbtc.setHeartbeat(ONE_DAY_SECONDS);
      expect(await aWbtc.heartbeat()).to.equal(ONE_DAY_SECONDS);

      // Deposit WBTC - the aToken will call the feed before minting to check PoR
      const balanceBefore = await aWbtc.balanceOf(regularUser.address);
      await expect(
        pool
          .connect(regularUser.signer)
          .deposit(wbtc.address, amountToDeposit, regularUser.address, '0')
      ).to.be.revertedWith(ProtocolErrors.AT_POR_UNDERLYING_GREATER_THAN_RESERVES);
      expect(await aWbtc.balanceOf(regularUser.address)).to.equal(balanceBefore);
    });

    it('should revert if the feed is not updated within the heartbeat', async () => {
      mockV3Aggregator = await deployMockV3Aggregator('8', WBTC_FEED_INITIAL_ANSWER);

      // Make sure feed and heartbeat values are set
      await aWbtc.setFeed(mockV3Aggregator.address);
      expect(await aWbtc.feed()).to.equal(mockV3Aggregator.address);
      await aWbtc.setHeartbeat(ONE_DAY_SECONDS);
      expect(await aWbtc.heartbeat()).to.equal(ONE_DAY_SECONDS);

      // Heartbeat is set to 1 day, so fast-forward 2 days
      await network.provider.send('evm_increaseTime', [2 * ONE_DAY_SECONDS]);

      // Deposit WBTC - the aToken will call the feed before minting to check PoR
      const balanceBefore = await aWbtc.balanceOf(regularUser.address);
      await expect(
        pool
          .connect(regularUser.signer)
          .deposit(wbtc.address, amountToDeposit, regularUser.address, '0')
      ).to.be.revertedWith(ProtocolErrors.AT_POR_ANSWER_TOO_OLD);
      expect(await aWbtc.balanceOf(regularUser.address)).to.equal(balanceBefore);
    });

    it('should revert if feed returns an invalid answer', async () => {
      // Update feed with invalid answer
      await mockV3Aggregator.updateAnswer(0);

      // Make sure feed and heartbeat values are set
      await aWbtc.setFeed(mockV3Aggregator.address);
      expect(await aWbtc.feed()).to.equal(mockV3Aggregator.address);
      await aWbtc.setHeartbeat(ONE_DAY_SECONDS); // 1 day, in seconds
      expect(await aWbtc.heartbeat()).to.equal(ONE_DAY_SECONDS);

      // Deposit WBTC - the aToken will call the feed before minting to check PoR
      const balanceBefore = await aWbtc.balanceOf(regularUser.address);
      await expect(
        pool
          .connect(regularUser.signer)
          .deposit(wbtc.address, amountToDeposit, regularUser.address, '0')
      ).to.be.revertedWith(ProtocolErrors.AT_POR_INVALID_ANSWER);
      expect(await aWbtc.balanceOf(regularUser.address)).to.equal(balanceBefore);
    });
  });

  describe('Set feed', () => {
    it('should only be callable by poolAdmin', async () => {
      await expect(
        aWbtc.connect(regularUser.signer).setFeed(mockV3Aggregator.address)
      ).to.be.revertedWith(ProtocolErrors.CALLER_NOT_POOL_ADMIN);
    });

    it('should unset feed if called by pool admin', async () => {
      await aWbtc.setFeed(ZERO_ADDRESS);
      expect(await aWbtc.feed()).to.equal(ZERO_ADDRESS);
    });
  });

  describe('Set heartbeat', () => {
    it('should only be callable by poolAdmin', async () => {
      await expect(
        aWbtc.connect(regularUser.signer).setHeartbeat(ONE_DAY_SECONDS)
      ).to.be.revertedWith(ProtocolErrors.CALLER_NOT_POOL_ADMIN);
    });

    it('should revert if newHeartbeat > MAX_AGE', async () => {
      await expect(aWbtc.setHeartbeat(8 * ONE_DAY_SECONDS)).to.be.revertedWith(
        ProtocolErrors.AT_POR_HEARTBEAT_GREATER_THAN_MAX_AGE
      );
    });

    it('should set heartbeat to MAX_AGE by default if called by pool admin with 0', async () => {
      await aWbtc.setHeartbeat(0);
      expect(await aWbtc.heartbeat()).to.equal(await aWbtc.MAX_AGE());
    });
  });
});
