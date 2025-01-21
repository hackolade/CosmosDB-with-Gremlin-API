const _ = require('lodash');
const applyToInstanceHelper = require('./applyToInstanceHelper');
const { generateContainerScript } = require('./generateContainerScript');
const { getPartitionKey } = require('./helpers/getPartitionKey');

module.exports = {
	generateContainerScript,

	async applyToInstance(data, logger, cb, app) {
		try {
			logger.clear();
			logger.log('info', data, data.hiddenKeys);

			if (!data.script) {
				return cb({ message: 'Empty script' });
			}

			if (!data.containerData) {
				return cb({ message: "Graph wasn't specified" });
			}
			const targetScriptOptions = data.targetScriptOptions || {};
			const containerProps = _.get(data.containerData, '[0]', {});
			if (!containerProps.dbId) {
				return cb({ message: "Database id wasn't specified" });
			}
			const graphName = containerProps.code || containerProps.name;
			if (!graphName) {
				return cb({ message: "Graph name wasn't specified" });
			}
			const progress = createLogger(logger, containerProps.dbId, graphName);

			const cosmosClient = applyToInstanceHelper(_).setUpDocumentClient(data);

			progress('Create database if not exists ...');

			await cosmosClient.databases.createIfNotExists({
				id: containerProps.dbId,
			});

			progress('Create container if not exists ...');

			const containerResponse = await cosmosClient.database(containerProps.dbId).containers.createIfNotExists({
				id: graphName,
				partitionKey: getPartitionKey(_)(data.containerData),
				...applyToInstanceHelper(_).getContainerThroughputProps(containerProps),
				defaultTtl: applyToInstanceHelper(_).getTTL(containerProps),
			});

			progress('Applying Cosmos DB script ...');
			const splittedScript = data.script.split('\n');
			let cosmosDBStartLineNumber = splittedScript.indexOf('{');
			if (cosmosDBStartLineNumber === -1) {
				cosmosDBStartLineNumber = splittedScript.length;
			}
			let gremlinScript = splittedScript.slice(0, cosmosDBStartLineNumber).join('\n');
			let cosmosDBScript = JSON.parse(splittedScript.slice(cosmosDBStartLineNumber).join('\n') || '""');

			progress('Update indexing policy ...');

			await containerResponse.container.replace({
				id: graphName,
				partitionKey: containerResponse.resource.partitionKey,
				indexingPolicy: updateIndexingPolicy(cosmosDBScript.indexingPolicy),
			});

			const storedProcs = _.get(cosmosDBScript, 'Stored Procedures', []);
			if (storedProcs.length) {
				progress('Upload stored procs ...');
				await applyToInstanceHelper(_).createStoredProcs(storedProcs, containerResponse.container);
			}

			const udfs = _.get(cosmosDBScript, 'User Defined Functions', []);
			if (udfs.length) {
				progress('Upload user defined functions ...');
				await applyToInstanceHelper(_).createUDFs(udfs, containerResponse.container);
			}

			const triggers = _.get(cosmosDBScript, 'Triggers', []);
			if (triggers.length) {
				progress('Upload triggers ...');
				await applyToInstanceHelper(_).createTriggers(triggers, containerResponse.container);
			}

			if (!gremlinScript) {
				return cb();
			}

			progress('Applying Gremlin script ...');

			const { labels, edges } = applyToInstanceHelper(_).parseScriptStatements(gremlinScript);
			const gremlinClient = await applyToInstanceHelper(_).getGremlinClient(data, containerProps.dbId, graphName);

			progress('Uploading labels ...');

			await applyToInstanceHelper(_).runGremlinQueries(gremlinClient, labels);

			progress('Uploading edges ...');

			await applyToInstanceHelper(_).runGremlinQueries(gremlinClient, edges);

			cb();
		} catch (err) {
			logger.log('error', mapError(err));
			cb(mapError(err));
		}
	},

	async testConnection(connectionInfo, logger, cb, app) {
		logger.clear();
		logger.log('info', connectionInfo, 'Test connection', connectionInfo.hiddenKeys);
		try {
			const client = applyToInstanceHelper(_).setUpDocumentClient(connectionInfo);
			await applyToInstanceHelper(_).testConnection(client);
			return cb();
		} catch (err) {
			logger.log('error', mapError(err), 'Connection failed');
			return cb(mapError(err));
		}
	},
};

const updateIndexingPolicy = indexes => {
	const result = { ...indexes };

	if (Array.isArray(result.includedPaths)) {
		result.includedPaths = addDataType(result.includedPaths);
	}

	if (Array.isArray(result.excludedPaths)) {
		result.excludedPaths = addDataType(result.excludedPaths);
	}

	if (Array.isArray(result.spatialIndexes)) {
		result.spatialIndexes = result.spatialIndexes.map(addSpatialTypes);
	}

	return result;
};

const addDataType = indexes => {
	return indexes.map(index => {
		if (!Array.isArray(index.indexes)) {
			return index;
		}

		return {
			...index,
			indexes: index.indexes.map(item => ({
				...item,
				dataType: item.dataType || 'String',
			})),
		};
	});
};

const addSpatialTypes = spatialIndex => {
	if (Array.isArray(spatialIndex.types) && spatialIndex.types.length) {
		return spatialIndex;
	}

	return {
		...spatialIndex,
		types: ['Point', 'LineString', 'Polygon', 'MultiPolygon'],
	};
};

const createLogger = (logger, containerName, entityName) => message => {
	logger.progress({ message, containerName, entityName });
	logger.log('info', { message }, 'Applying to instance');
};

const mapError = error => {
	return {
		message: error.message,
		stack: error.stack,
	};
};
