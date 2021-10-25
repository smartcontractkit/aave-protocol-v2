// SPDX-License-Identifier: agpl-3.0
pragma solidity 0.6.12;

import {AToken} from './AToken.sol';
import {IAPoRToken} from '../../interfaces/IAPoRToken.sol';
import {ILendingPool} from '../../interfaces/ILendingPool.sol';
import {IChainlinkAggregatorV3} from '../../interfaces/IChainlinkAggregatorV3.sol';
import {SafeMath} from '../../dependencies/openzeppelin/contracts/SafeMath.sol';
import {IERC20Detailed} from '../../dependencies/openzeppelin/contracts/IERC20Detailed.sol';
import {Errors} from '../libraries/helpers/Errors.sol';

/**
 * @title Aave's APoRToken (aToken with proof-of-reserves) Contract
 * @notice AToken that checks reserves before minting
 * @author Chainlink
 */
contract APoRToken is AToken, IAPoRToken {
  using SafeMath for uint256;

  uint256 public constant MAX_AGE = 7 days;
  address public feed;
  uint256 public heartbeat;

  modifier onlyPoolAdmin {
    require(
      _msgSender() == ILendingPool(_pool).getAddressesProvider().getPoolAdmin(),
      Errors.CALLER_NOT_POOL_ADMIN
    );
    _;
  }

  /**
   * @dev This constructor only serves to set a default heartbeat.
   *  Don't forget to use `initialize(...)` as you would with a regular AToken.
   */
  constructor() public {
    heartbeat = MAX_AGE;
  }

  /**
   * @notice Overriden mint function that checks the specified proof-of-reserves feed to
   * ensure that the supply of the underlying assets is not greater than the reported
   * reserves.
   * @dev The proof-of-reserves check is bypassed if feed is not set.
   * @param account The address to mint tokens to
   * @param amount The amount of tokens to mint
   */
  function _mint(address account, uint256 amount) internal virtual override {
    if (feed == address(0)) {
      super._mint(account, amount);
      return;
    }

    // Get latest proof-of-reserves from the feed
    (, int256 answer, , uint256 updatedAt, ) = IChainlinkAggregatorV3(feed).latestRoundData();
    require(answer > 0, Errors.AT_POR_INVALID_ANSWER);

    // Check the answer is fresh enough (i.e., within the specified heartbeat)
    uint256 oldestAllowed = block.timestamp.sub(heartbeat, Errors.AT_POR_INVALID_TIMESTAMP);
    require(updatedAt >= oldestAllowed, Errors.AT_POR_ANSWER_TOO_OLD);

    // Get required info about underlying/reserves supply & decimals
    uint256 underlyingSupply = IERC20Detailed(_underlyingAsset).totalSupply();
    uint8 underlyingDecimals = IERC20Detailed(_underlyingAsset).decimals();
    uint8 reserveDecimals = IChainlinkAggregatorV3(feed).decimals();
    uint256 reserves = uint256(answer);
    // Normalise underlying & reserve decimals
    if (underlyingDecimals < reserveDecimals) {
      underlyingSupply = underlyingSupply.mul(10**uint256(reserveDecimals - underlyingDecimals));
    } else if (underlyingDecimals > reserveDecimals) {
      reserves = reserves.mul(10**uint256(underlyingDecimals - reserveDecimals));
    }

    // Check that the supply of underlying tokens is NOT greater than the supply
    // provided by the latest valid proof-of-reserves.
    require(underlyingSupply <= reserves, Errors.AT_POR_UNDERLYING_GREATER_THAN_RESERVES);
    super._mint(account, amount);
  }

  /**
   * @notice Sets a new feed address
   * @dev Admin function to set a new feed
   * @param newFeed Address of the new feed
   */
  function setFeed(address newFeed) external override onlyPoolAdmin returns (uint256) {
    emit NewFeed(feed, newFeed);
    feed = newFeed;
  }

  /**
   * @notice Sets the feed's heartbeat expectation
   * @dev Admin function to set the heartbeat
   * @param newHeartbeat Value of the age of the latest update from the feed
   */
  function setHeartbeat(uint256 newHeartbeat) external override onlyPoolAdmin returns (uint256) {
    require(newHeartbeat <= MAX_AGE, Errors.AT_POR_HEARTBEAT_GREATER_THAN_MAX_AGE);

    emit NewHeartbeat(heartbeat, newHeartbeat);
    heartbeat = newHeartbeat == 0 ? MAX_AGE : newHeartbeat;
  }
}
