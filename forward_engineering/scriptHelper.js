
const add = (key, items, mapper) => (script) => {
	if (!items.length) {
		return script;
	}

	return {
		...script,
		[key]: mapper(items),
	};
};

const addItems = (_) => (containerData) => {
	return _.flow(
		add('Stored Procedures', _.get(containerData, '[2].storedProcs', []), mapStoredProcs),
		add('User Defined Functions', _.get(containerData, '[3].udfs', []), mapUDFs),
		add('Triggers', _.get(containerData, '[4].triggers', []), mapTriggers),
	)();
};

const mapUDFs = (udfs) => {
	return udfs.map(udf => {
		return {
			id: udf.udfID,
			body: udf.udfFunction,
		};
	});
};

const mapTriggers = (triggers) => {
	return triggers.map(trigger => {
		return {
			id: trigger.triggerID,
			body: trigger.triggerFunction,
			triggerOperation: trigger.triggerOperation,
			triggerType: trigger.prePostTrigger === 'Pre-Trigger' ? 'Pre' : 'Post'
		};
	});
};

const mapStoredProcs = (storedProcs) => {
	return storedProcs.map(proc => {
		return {
			id: proc.storedProcID,
			body: proc.storedProcFunction,
		};
	});
};

module.exports = {
	addItems,
};
