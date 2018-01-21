const path = require('path');
const Promise = require('bluebird');

const Fund = artifacts.require('./Fund.sol');
const NavCalculator = artifacts.require('./NavCalculator.sol');
const DataFeed = artifacts.require('./DataFeed.sol');

const { increaseTime, sendTransaction, arrayToObject } = require('../js/helpers');

const scriptName = path.basename(__filename);

const keys = ['date2', 'navPerShare', 'lossCarryforward', 'accumulatedMgmtFees', 'accumulatedAdminFees'];

if (typeof web3.eth.getAccountsPromise === 'undefined') {
  Promise.promisifyAll(web3.eth, { suffix: 'Promise' });
}

contract('NavCalculator', (accounts) => {
  const MANAGER = accounts[0];
  const EXCHANGE = accounts[1];
  const GAS_AMT = 500000;
  const MGMT_FEE_BPS = 0;
  const ADMIN_FEE_BPS = 100;
  const SECONDS_IN_YEAR = 31536000;
  const PERFORM_FEE_BPS = 2000;
  const TIMEDIFF = 60 * 60 * 24 * 30;

  let fund;
  let calculator;
  let dataFeed;
  let totalSupply;
  let totalEthPendingSubscription;
  let totalEthPendingWithdrawal;
  let navPerShare;
  let accumulatedMgmtFees;
  let accumulatedAdminFees;
  let accumulatedPerfFees;
  let lossCarryforward;
  let usdEth;
  let navCalculator;

  // Helpers
  const getBalancePromise = address => web3.eth.getBalancePromise(address);
  const weiToNum = wei => web3.fromWei(wei, 'ether').toNumber();
  const ethToUsd = eth => (eth * usdEth) / 1e20;
  const usdToEth = usd => (usd * 1e20) / usdEth;

  const changeExchangeValue = _multiplier => new Promise((resolve, reject) => {
    resolve(dataFeed.updateWithExchange(_multiplier));
    // .then(() => dataFeed.value())
    // .then((_val) => console.log("new portfolio value (USD):", parseInt(_val)))
    // );
  });

  const retrieveFundParams = () => Promise.all([
    fund.lastCalcDate.call(),
    fund.navPerShare.call(),
    fund.lossCarryforward.call(),
    fund.accumulatedMgmtFees.call(),
    fund.accumulatedAdminFees.call(),
  ]);

  const checkRoughEqual = (vals, _navPerShare, _lossCarryforward, _accumulatedMgmtFees, _accumulatedAdminFees) => {
    const [ansNAV, ansLCF, ansAMF, ansAAF] = vals;

    assert(Math.abs((Number(_navPerShare) / ansNAV) - 1) < 0.0001, 'incorrect navPerShare');

    if (ansLCF !== 0) assert(Math.abs((Number(_lossCarryforward) / ansLCF) - 1) < 0.0001, 'incorrect lossCarryforward');
    else assert.equal(Number(lossCarryforward), 0, 'incorrect lossCarryforward');

    if (ansAMF !== 0) assert((Math.abs(Number(_accumulatedMgmtFees) / ansAMF) - 1) < 0.0001, 'incorrect accumulatedMgmtFees');
    else assert.equal(Number(_accumulatedMgmtFees), 0, 'incorrect accumulatedMgmtFees');

    if (ansAAF !== 0) assert(Math.abs((Number(_accumulatedAdminFees) / ansAAF) - 1) < 0.0001, 'incorrect accumulatedAdminFees');
    else assert.equal(Number(_accumulatedAdminFees), 0, 'incorrect accumulatedAdminFees');
  };

  const calc = elapsedTime => new Promise((resolve, reject) => {
    let fundBal;
    let portfolioValueUsd;
    let ts;
    Promise.all([dataFeed.value(), fund.getBalance(), fund.totalSupply()])
      .then((_vals) => {
        [portfolioValueUsd, fundBal, ts] = _vals;
        const gav = Number(portfolioValueUsd) + ethToUsd(Number(fundBal));
        // console.log('gav', gav);
        let nav = (ts * navPerShare) / 10000;
        // console.log('nav', nav);
        const mgmtFee = Math.trunc(navPerShare * (MGMT_FEE_BPS / 10000) * (elapsedTime / SECONDS_IN_YEAR) * (ts / 10000));
        const adminFee = Math.trunc(navPerShare * (ADMIN_FEE_BPS / 10000) * (elapsedTime / SECONDS_IN_YEAR) * (ts / 10000));
        // console.log('mgmtFee', mgmtFee);
        const gpvLessFees = gav - accumulatedMgmtFees - accumulatedAdminFees;
        // console.log('gpvlessFees', gpvlessFees);
        const gainLoss = gpvLessFees - nav - mgmtFee - adminFee;

        // If there are any accumulated performance fees and if there is a loss in calculation period
        // return the performance fees first
        const performFeePayback = (accumulatedPerfFees > 0 && gainLoss < 0) ? Math.min(accumulatedPerfFees, -gainLoss) : 0;

        const lossPayback = gainLoss > 0 ? Math.min(gainLoss, lossCarryforward) : 0;
        const gainLossAfterPayback = gainLoss - lossPayback;
        const performFee = gainLossAfterPayback > 0 ? Math.trunc(gainLossAfterPayback * (PERFORM_FEE_BPS / 10000)) : 0;
        // console.log('performFee', performFee);
        const netGainLossAfterPerformFee = (gainLossAfterPayback + lossPayback) - performFee;
        // console.log('netGainLossAfterPerformFee', netGainLossAfterPerformFee);
        nav += netGainLossAfterPerformFee + performFeePayback;
        if (netGainLossAfterPerformFee < 0) lossCarryforward += Math.abs(netGainLossAfterPerformFee);

        navPerShare = Math.trunc((nav * 10000) / totalSupply);

        lossCarryforward -= lossPayback + (performFeePayback / (PERFORM_FEE_BPS / 10000));
        accumulatedMgmtFees += (mgmtFee + performFee) - performFeePayback;
        accumulatedAdminFees += adminFee;
        accumulatedPerfFees += performFee - performFeePayback;
        resolve([navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedAdminFees]);
      })
      .catch(reject);
  });

  before(() => {
    console.log(`  ****** START TEST [ ${scriptName} ] *******`);
    return Promise.all([Fund.deployed(), NavCalculator.deployed(), DataFeed.deployed()])
      .then((_values) => {
        [fund, navCalculator, dataFeed] = _values;
        return navCalculator.setFund(fund.address);
      })
      .then(() => Promise.all([
        fund.totalSupply(),
        fund.totalEthPendingSubscription(),
        fund.totalEthPendingWithdrawal(),
        fund.accumulatedMgmtFees(),
        fund.accumulatedAdminFees(),
        fund.lossCarryforward(),
        dataFeed.usdEth(),
      ]))
      .then((_vals) => {
        [totalSupply, totalEthPendingSubscription, totalEthPendingWithdrawal,
          accumulatedMgmtFees, accumulatedAdminFees, lossCarryforward, usdEth] = _vals.map(parseInt);
        totalEthPendingSubscription = totalEthPendingSubscription || 0;
        accumulatedPerfFees = 0;
        return fund.navPerShare();
      })
      .then(_navPerShare => navPerShare = _navPerShare)
      .catch(console.error);
  });

  it('should set fund to the correct fund address', (done) => {
    navCalculator.setFund(fund.address)
      .then(() => navCalculator.fundAddress.call())
      .then((_fundAddress) => {
        assert.equal(_fundAddress, fund.address, 'fund addresses don\'t match');
        done();
      });
  });

  it('should set value feed to the correct data feed address', (done) => {
    navCalculator.setDataFeed(dataFeed.address)
      .then(() => navCalculator.dataFeed.call())
      .then((_address) => {
        assert.equal(_address, dataFeed.address, 'data feed addresses don\'t match');
        done();
      });
  });

  it('should calculate the navPerShare correctly (base case)', (done) => {
    let date1;
    let date2;
    let navPerShare;
    let lossCarryforward;
    let accumulatedMgmtFees;
    let accumulatedAdminFees;

    Promise.resolve(changeExchangeValue(100))
      .then(() => fund.lastCalcDate.call())
      .then(_date => date1 = _date)
      .then(() => Promise.resolve(increaseTime(TIMEDIFF)))
      .then(() => fund.calcNav())
      .then(() => retrieveFundParams())
      .then((_values) => {
        [date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedAdminFees] = _values;
        assert(date2 - date1 >= TIMEDIFF, 'timelapse error');
        return calc(date2 - date1);
      })
      .then((_vals) => {
        checkRoughEqual(_vals, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedAdminFees);
        done();
      })
      .catch(console.error);
  });

  it('should calculate the navPerShare correctly (portfolio goes down)', (done) => {
    let date1, date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedAdminFees;

    Promise.resolve(changeExchangeValue(75))
      .then(() => fund.lastCalcDate.call())
      .then(_date => date1 = _date)
      .then(() => Promise.resolve(increaseTime(TIMEDIFF)))
      .then(() => fund.calcNav())
      .then(() => retrieveFundParams())
      .then((_values) => {
        [date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedAdminFees] = _values;
        assert(date2 - date1 >= TIMEDIFF, 'timelapse error');
        return calc(date2 - date1);
      })
      .then((_vals) => {
        checkRoughEqual(_vals, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedAdminFees);
        done();
      })
      .catch(console.error);
  });


  it('should calculate the navPerShare correctly (portfolio recovers from loss)', (done) => {
    let date1, date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedAdminFees;

    Promise.resolve(changeExchangeValue(150))
      .then(() => fund.lastCalcDate.call())
      .then(_date => date1 = _date)
      .then(() => Promise.resolve(increaseTime(TIMEDIFF)))
      .then(() => fund.calcNav())
      .then(() => retrieveFundParams())
      .then((_values) => {
        [date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedAdminFees] = _values;
        assert(date2 - date1 >= TIMEDIFF, 'timelapse error');
        return calc(date2 - date1);
      })
      .then((_vals) => {
        checkRoughEqual(_vals, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedAdminFees);
        done();
      })
      .catch(console.error);
  });

  it('should calculate the navPerShare correctly (portfolio loses its gains, goes down 10x)', (done) => {
    let date1, date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedAdminFees;

    Promise.resolve(changeExchangeValue(15))
      .then(() => fund.lastCalcDate.call())
      .then(_date => date1 = _date)
      .then(() => Promise.resolve(increaseTime(TIMEDIFF)))
      .then(() => fund.calcNav())
      .then(() => retrieveFundParams())
      .then((_values) => {
        [date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedAdminFees] = _values;
        assert(date2 - date1 >= TIMEDIFF, 'timelapse error');
        return calc(date2 - date1);
      })
      .then((_vals) => {
        checkRoughEqual(_vals, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedAdminFees);
        done();
      })
      .catch(console.error);
  });

  it('should calculate the navPerShare correctly (portfolio goes up 50x)', (done) => {
    let date1, date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedAdminFees;

    Promise.resolve(changeExchangeValue(5000))
      .then(() => fund.lastCalcDate.call())
      .then(_date => date1 = _date)
      .then(() => Promise.resolve(increaseTime(TIMEDIFF)))
      .then(() => fund.calcNav())
      .then(() => retrieveFundParams())
      .then((_values) => {
        [date2, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedAdminFees] = _values;
        assert(date2 - date1 >= TIMEDIFF, 'timelapse error');
        return calc(date2 - date1);
      })
      .then((_vals) => {
        checkRoughEqual(_vals, navPerShare, lossCarryforward, accumulatedMgmtFees, accumulatedAdminFees);
        done();
      })
      .catch(console.error);
  });
});
