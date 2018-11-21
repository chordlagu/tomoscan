'use strict'

const Web3Util = require('../helpers/web3')
const BigNumber = require('bignumber.js')

const db = require('../models')
const config = require('config')

const TomoValidatorABI = require('../contracts/abi/TomoValidator')
const contractAddress = require('../contracts/contractAddress')

const consumer = {}
consumer.name = 'RewardValidatorProcess'
consumer.processNumber = 1
consumer.task = async function (job, done) {
    let epoch = job.data.epoch
    console.log('Process reward for validator at epoch: ', epoch)

    let endBlock = parseInt(epoch) * config.get('BLOCK_PER_EPOCH')
    let startBlock = endBlock - config.get('BLOCK_PER_EPOCH') + 1

    let totalReward = new BigNumber(config.get('REWARD'))
    let validatorRewardPercent = new BigNumber(config.get('MASTER_NODE_REWARD_PERCENT'))
    let foundationRewardPercent = new BigNumber(config.get('FOUNDATION_REWARD_PERCENT'))
    let voterRewardPercent = new BigNumber(config.get('VOTER_REWARD_PERCENT'))

    try {
        let web3 = await Web3Util.getWeb3()
        let validatorContract = await new web3.eth.Contract(TomoValidatorABI, contractAddress.TomoValidator)

        let totalSignNumber = 0

        const q = require('./index')

        let validators = []
        let voteHistory = await db.UserVoteAmount.find({ epoch: epoch })
        for (let i = 0; i < voteHistory.length; i++) {
            if (validators.indexOf(voteHistory[i].candidate) < 0) {
                validators.push(voteHistory[i].candidate)
            }
        }

        let rewardValidator = []
        let validatorSigners = []
        let validatorMap = validators.map(async (validator) => {
            validator = validator.toString().toLowerCase()
            let validatorSignNumber = await db.BlockSigner
                .countDocuments({
                    blockNumber: { $gte: startBlock, $lte: endBlock },
                    signers: validator
                })
            if (validatorSignNumber > 0) {
                totalSignNumber += validatorSignNumber
                validatorSigners.push({
                    address: validator,
                    signNumber: validatorSignNumber
                })
            }
        })
        await Promise.all(validatorMap)

        let validatorFinal = validatorSigners.map(async (validator) => {
            let reward4group = totalReward.multipliedBy(validator.signNumber).dividedBy(totalSignNumber)
            let reward4validator = reward4group.multipliedBy(validatorRewardPercent).dividedBy(100)
            let reward4foundation = reward4group.multipliedBy(foundationRewardPercent).dividedBy(100)
            let reward4voter = reward4group.multipliedBy(voterRewardPercent).dividedBy(100)

            let blockRewardCalculate = (epoch + 1) * config.get('BLOCK_PER_EPOCH')

            let block = await db.Block.findOne({ number: blockRewardCalculate })
            let timestamp = new Date()
            if (!block) {
                let _block = await web3.eth.getBlock(blockRewardCalculate)
                if (_block) {
                    timestamp = _block.timestamp * 1000
                }
            } else {
                timestamp = block.timestamp
            }

            q.create('RewardVoterProcess', {
                epoch: epoch,
                validator: validator.address,
                validatorSignNumber: validator.signNumber,
                totalReward: reward4voter.toString(),
                rewardTime: timestamp
            })
                .priority('normal').removeOnComplete(true).save()

            let ownerValidator = await validatorContract.methods.getCandidateOwner(validator.address).call()
            ownerValidator = ownerValidator.toString().toLowerCase()

            // Add reward for validator
            // q.create('AddRewardToAccount', { address: ownerValidator, balance: reward4validator.toString() })
            //     .priority('normal').removeOnComplete(true).save()
            let voteEpoch = await db.UserVoteAmount.findOne({
                epoch: epoch,
                candidate: validator.address,
                voter: ownerValidator
            })
            await rewardValidator.push({
                epoch: epoch,
                startBlock: startBlock,
                endBlock: endBlock,
                address: ownerValidator,
                validator: validator.address,
                reason: 'MasterNode',
                lockBalance: String(voteEpoch ? voteEpoch.voteAmount : 50000),
                reward: reward4validator.toString(),
                rewardTime: timestamp,
                signNumber: validator.signNumber
            })

            // Reward for foundation
            await rewardValidator.push({
                epoch: epoch,
                startBlock: startBlock,
                endBlock: endBlock,
                address: contractAddress.foundation,
                validator: validator.address,
                reason: 'Foundation',
                lockBalance: 0,
                reward: reward4foundation.toString(),
                rewardTime: timestamp,
                signNumber: validator.signNumber
            })
            // q.create('AddRewardToAccount', { address: contractAddress.foundation, balance: reward4foundation })
            //     .priority('normal').removeOnComplete(true).save()
        })
        await Promise.all(validatorFinal)
        if (rewardValidator.length > 0) {
            await db.Reward.insertMany(rewardValidator)
        }
    } catch (e) {
        console.error(consumer.name, e)
        done(e)
    }

    done()
}

module.exports = consumer
