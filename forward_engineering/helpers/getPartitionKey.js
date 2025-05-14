const _ = require('lodash');

const getPartitionKey = containerData => {
	return _.get(containerData, '[0].partitionKey[0].name', '').trim().replace(/\/$/, null);
};

module.exports = {
	getPartitionKey,
};
