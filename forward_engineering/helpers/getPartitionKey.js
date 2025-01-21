const getPartitionKey = _ => containerData => {
	return _.get(containerData, '[0].partitionKey[0].name', '').trim().replace(/\/$/, '');
};

module.exports = {
	getPartitionKey,
};
