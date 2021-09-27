import { network } from 'hardhat';
import { MAX_UINT_AMOUNT, ZERO_ADDRESS } from '../../helpers/constants';
import { BUIDLEREVM_CHAINID } from '../../helpers/buidler-constants';
import {
  buildPermitParams,
  convertToCurrencyDecimals,
  getSignatureFromTypedData,
} from '../../helpers/contracts-helpers';
import { expect } from 'chai';
import { BigNumber, BigNumberish, ethers } from 'ethers';
import { ProtocolErrors } from '../../helpers/types';
import { makeSuite, TestEnv } from './helpers/make-suite';
import { DRE } from '../../helpers/misc-utils';
import {
  ConfigNames,
  getATokenDomainSeparatorPerNetwork,
  getTreasuryAddress,
  loadPoolConfig,
} from '../../helpers/configuration';
import { waitForTx } from '../../helpers/misc-utils';
import {
  deployAporToken,
  deployMockV3Aggregator,
  deployMockVariableDebtToken,
} from '../../helpers/contracts-deployments';
import AaveConfig from '../../markets/aave';
import {
  APoRToken,
  AToken,
  ATokenFactory,
  Errors,
  ErrorsFactory,
  LendingPoolAddressesProviderFactory,
  MintableERC20,
  MockV3Aggregator,
} from '../../types';
import { getMintableERC20 } from '../../helpers/contracts-getters';

const { parseEther } = ethers.utils;

// = base * 10^{exponent}
const exp = (base: BigNumberish, exponent: BigNumberish): BigNumber => {
  return BigNumber.from(base).mul(BigNumber.from(10).pow(exponent));
};

makeSuite(
  'APoRToken: Mint with proof-of-reserves check',
  (testEnv: TestEnv) => {
    const WBTC_AGG_INITIAL_ANSWER = exp(1_000_000, 8).toString(); // "1M WBTC in reserves"
    const poolConfig = loadPoolConfig(ConfigNames.Commons);
    let aporWbtc = <APoRToken>{};
    let mockV3Aggregator: MockV3Aggregator;

    beforeEach(async () => {
      // Deploy mock V3 aggregator as the PoR feed
      mockV3Aggregator = await deployMockV3Aggregator('8', WBTC_AGG_INITIAL_ANSWER);
    });

    describe('Proof-of-reserves check', () => {
      it('should mint successfully when feed is unset', async () => {
        const { wbtc, aWbtc, users, pool } = testEnv;
        const user = users[1];

        // Mint some fake WBTC
        const amountToDeposit = await convertToCurrencyDecimals(wbtc.address, '10');
        await wbtc.connect(user.signer).mint(amountToDeposit);
        await wbtc.connect(user.signer).approve(pool.address, amountToDeposit);

        // Make sure feed is unset
        expect(await aWbtc.feed()).to.equal(ZERO_ADDRESS);

        // Deposit WBTC - the aToken will call the feed before minting to check PoR
        const balanceBefore = await aWbtc.balanceOf(user.address);
        await pool.connect(user.signer).deposit(wbtc.address, amountToDeposit, user.address, '0');
        expect(await aWbtc.balanceOf(user.address)).to.equal(balanceBefore.add(amountToDeposit));
      });

      it('should mint successfully when feed is set, but heartbeat is unset', async () => {
        const { wbtc, aWbtc, users, pool } = testEnv;
        const user = users[1];

        // Mint some fake WBTC
        const amountToDeposit = await convertToCurrencyDecimals(wbtc.address, '10');
        await wbtc.connect(user.signer).mint(amountToDeposit);
        await wbtc.connect(user.signer).approve(pool.address, amountToDeposit);

        // Make sure feed and heartbeat values are what we're testing for
        await aWbtc._setFeed(mockV3Aggregator.address);
        expect(await aWbtc.feed()).to.equal(mockV3Aggregator.address);
        await aWbtc._setHeartbeat(0);
        expect(await aWbtc.heartbeat()).to.equal(0);

        // Deposit WBTC - the aToken will call the feed before minting to check PoR
        const balanceBefore = await aWbtc.balanceOf(user.address);
        await pool.connect(user.signer).deposit(wbtc.address, amountToDeposit, user.address, '0');
        expect(await aWbtc.balanceOf(user.address)).to.equal(amountToDeposit.add(balanceBefore));
      });

      it('should mint successfully when both feed and heartbeat are set', async () => {
        const { wbtc, aWbtc, users, pool } = testEnv;
        const user = users[1];

        // Mint some fake WBTC
        const amountToDeposit = await convertToCurrencyDecimals(wbtc.address, '10');
        await wbtc.connect(user.signer).mint(amountToDeposit);
        await wbtc.connect(user.signer).approve(pool.address, amountToDeposit);

        // Make sure feed and heartbeat values are what we're testing for
        await aWbtc._setFeed(mockV3Aggregator.address);
        expect(await aWbtc.feed()).to.equal(mockV3Aggregator.address);
        await aWbtc._setHeartbeat(24 * 60 * 60); // 1 day, in seconds
        expect(await aWbtc.heartbeat()).to.equal(24 * 60 * 60);

        // Deposit WBTC - the aToken will call the feed before minting to check PoR
        const balanceBefore = await aWbtc.balanceOf(user.address);
        await pool.connect(user.signer).deposit(wbtc.address, amountToDeposit, user.address, '0');
        expect(await aWbtc.balanceOf(user.address)).to.equal(balanceBefore.add(amountToDeposit));
      });

      it('should mint successfully when feed decimals < underlying decimals', async () => {
        const { wbtc, aWbtc, users, pool } = testEnv;
        const user = users[1];

        // Mint some fake WBTC
        const amountToDeposit = await convertToCurrencyDecimals(wbtc.address, '10');
        await wbtc.connect(user.signer).mint(amountToDeposit);
        await wbtc.connect(user.signer).approve(pool.address, amountToDeposit);

        // Re-deploy aggregator with fewer decimals
        const currentWbtcSupply = await wbtc.totalSupply();
        mockV3Aggregator = await deployMockV3Aggregator(
          '6',
          currentWbtcSupply.div(exp(1, 2)).toString()
        );

        // Make sure feed and heartbeat values are set
        await aWbtc._setFeed(mockV3Aggregator.address);
        expect(await aWbtc.feed()).to.equal(mockV3Aggregator.address);
        await aWbtc._setHeartbeat(24 * 60 * 60); // 1 day, in seconds
        expect(await aWbtc.heartbeat()).to.equal(24 * 60 * 60);

        // Deposit WBTC - the aToken will call the feed before minting to check PoR
        const balanceBefore = await aWbtc.balanceOf(user.address);
        await pool.connect(user.signer).deposit(wbtc.address, amountToDeposit, user.address, '0');
        expect(await aWbtc.balanceOf(user.address)).to.equal(balanceBefore.add(amountToDeposit));
      });

      it('should mint successfully when feed decimals > underlying decimals', async () => {
        const { wbtc, aWbtc, users, pool } = testEnv;
        const user = users[1];

        // Mint some fake WBTC
        const amountToDeposit = await convertToCurrencyDecimals(wbtc.address, '10');
        await wbtc.connect(user.signer).mint(amountToDeposit);
        await wbtc.connect(user.signer).approve(pool.address, amountToDeposit);

        // Re-deploy aggregator with more decimals
        const currentWbtcSupply = await wbtc.totalSupply();
        mockV3Aggregator = await deployMockV3Aggregator(
          '18',
          currentWbtcSupply.mul(exp(1, 10)).toString()
        );

        // Make sure feed and heartbeat values are set
        await aWbtc._setFeed(mockV3Aggregator.address);
        expect(await aWbtc.feed()).to.equal(mockV3Aggregator.address);
        await aWbtc._setHeartbeat(24 * 60 * 60); // 1 day, in seconds
        expect(await aWbtc.heartbeat()).to.equal(24 * 60 * 60);

        // Deposit WBTC - the aToken will call the feed before minting to check PoR
        const balanceBefore = await aWbtc.balanceOf(user.address);
        await pool.connect(user.signer).deposit(wbtc.address, amountToDeposit, user.address, '0');
        expect(await aWbtc.balanceOf(user.address)).to.equal(balanceBefore.add(amountToDeposit));
      });

      it('should revert if underlying supply > proof-of-reserves', async () => {
        const { wbtc, aWbtc, users, pool } = testEnv;
        const user = users[1];

        // Mint some fake WBTC
        const amountToDeposit = await convertToCurrencyDecimals(wbtc.address, '10');
        await wbtc.connect(user.signer).mint(amountToDeposit);
        await wbtc.connect(user.signer).approve(pool.address, amountToDeposit);

        // Re-deploy aggregator with fewer WBTC in reserves
        const currentWbtcSupply = await wbtc.totalSupply();
        const notEnoughReserves = currentWbtcSupply.sub('1');
        mockV3Aggregator = await deployMockV3Aggregator('18', notEnoughReserves.toString());

        // Make sure feed and heartbeat values are set
        await aWbtc._setFeed(mockV3Aggregator.address);
        expect(await aWbtc.feed()).to.equal(mockV3Aggregator.address);
        await aWbtc._setHeartbeat(24 * 60 * 60); // 1 day, in seconds
        expect(await aWbtc.heartbeat()).to.equal(24 * 60 * 60);

        // Deposit WBTC - the aToken will call the feed before minting to check PoR
        const balanceBefore = await aWbtc.balanceOf(user.address);
        await expect(
          pool.connect(user.signer).deposit(wbtc.address, amountToDeposit, user.address, '0')
        ).to.be.revertedWith(ProtocolErrors.AT_POR_UNDERLYING_GREATER_THAN_RESERVES);
        expect(await aWbtc.balanceOf(user.address)).to.equal(balanceBefore);
      });

      it('should revert if the feed is not updated within the heartbeat', async () => {
        const { wbtc, aWbtc, users, pool } = testEnv;
        const user = users[1];

        // Mint some fake WBTC
        const amountToDeposit = await convertToCurrencyDecimals(wbtc.address, '10');
        await wbtc.connect(user.signer).mint(amountToDeposit);
        await wbtc.connect(user.signer).approve(pool.address, amountToDeposit);

        // Re-deploy aggregator with fewer decimals
        mockV3Aggregator = await deployMockV3Aggregator('18', WBTC_AGG_INITIAL_ANSWER);

        // Make sure feed and heartbeat values are set
        await aWbtc._setFeed(mockV3Aggregator.address);
        expect(await aWbtc.feed()).to.equal(mockV3Aggregator.address);
        const heartbeatSeconds = 24 * 60 * 60;
        await aWbtc._setHeartbeat(heartbeatSeconds); // 1 day, in seconds
        expect(await aWbtc.heartbeat()).to.equal(heartbeatSeconds);

        // Heartbeat is set to 1 day, so fast-forward 2 days
        await network.provider.send('evm_increaseTime', [2 * heartbeatSeconds]);

        // Deposit WBTC - the aToken will call the feed before minting to check PoR
        const balanceBefore = await aWbtc.balanceOf(user.address);
        await expect(
          pool.connect(user.signer).deposit(wbtc.address, amountToDeposit, user.address, '0')
        ).to.be.revertedWith(ProtocolErrors.AT_POR_ANSWER_TOO_OLD);
        expect(await aWbtc.balanceOf(user.address)).to.equal(balanceBefore);
      });

      it('should revert if feed returns an invalid answer', async () => {
        const { wbtc, aWbtc, users, pool } = testEnv;
        const user = users[1];

        // Mint some fake WBTC
        const amountToDeposit = await convertToCurrencyDecimals(wbtc.address, '10');
        await wbtc.connect(user.signer).mint(amountToDeposit);
        await wbtc.connect(user.signer).approve(pool.address, amountToDeposit);

        // Update feed with invalid answer
        await mockV3Aggregator.updateAnswer(0);

        // Make sure feed and heartbeat values are set
        await aWbtc._setFeed(mockV3Aggregator.address);
        expect(await aWbtc.feed()).to.equal(mockV3Aggregator.address);
        const heartbeatSeconds = 24 * 60 * 60;
        await aWbtc._setHeartbeat(heartbeatSeconds); // 1 day, in seconds
        expect(await aWbtc.heartbeat()).to.equal(heartbeatSeconds);

        // Deposit WBTC - the aToken will call the feed before minting to check PoR
        const balanceBefore = await aWbtc.balanceOf(user.address);
        await expect(
          pool.connect(user.signer).deposit(wbtc.address, amountToDeposit, user.address, '0')
        ).to.be.revertedWith(ProtocolErrors.AT_POR_INVALID_ANSWER);
        expect(await aWbtc.balanceOf(user.address)).to.equal(balanceBefore);
      });
    });

    describe('Set feed', () => {
      it('should only be callable by poolAdmin', async () => {
        const { aWbtc, users } = testEnv;
        const regularUser = users[1];
        await expect(
          aWbtc.connect(regularUser.signer)._setFeed(mockV3Aggregator.address)
        ).to.be.revertedWith(ProtocolErrors.CALLER_NOT_POOL_ADMIN);
      });

      it('should unset feed if called by pool admin', async () => {
        const { aWbtc, users } = testEnv;
        await aWbtc._setFeed(ZERO_ADDRESS);
        expect(await aWbtc.feed()).to.equal(ZERO_ADDRESS);
      });
    });

    describe('Set heartbeat', () => {
      it('should only be callable by poolAdmin', async () => {
        const { aWbtc, users } = testEnv;
        const regularUser = users[1];
        const oneDaySeconds = 24 * 60 * 60;
        await expect(
          aWbtc.connect(regularUser.signer)._setHeartbeat(oneDaySeconds)
        ).to.be.revertedWith(ProtocolErrors.CALLER_NOT_POOL_ADMIN);
      });

      it('should revert if newHeartbeat > MAX_AGE', async () => {
        const { aWbtc, users } = testEnv;
        const regularUser = users[1];
        const eightDaySeconds = 8 * 24 * 60 * 60;
        await expect(aWbtc._setHeartbeat(eightDaySeconds)).to.be.revertedWith(
          ProtocolErrors.AT_POR_HEARTBEAT_GREATER_THAN_MAX_AGE
        );
      });

      it('should unset heartbeat if called by pool admin', async () => {
        const { aWbtc } = testEnv;
        await aWbtc._setHeartbeat(0);
        expect(await aWbtc.heartbeat()).to.equal(0);
      });
    });
  },
  { isolate: true }
);
