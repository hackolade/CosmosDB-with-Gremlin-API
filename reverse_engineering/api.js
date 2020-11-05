'use strict';

const async = require('async');
const _ = require('lodash');
const { CosmosClient } = require('@azure/cosmos');
const axios = require('axios');
const gremlinHelper = require('./gremlinHelper');
let client;

module.exports = {
	connect: function(connectionInfo, logger, cb){
		logger.clear();
		logger.log('info', connectionInfo, 'connectionInfo', connectionInfo.hiddenKeys);
		cb();
	},

	disconnect: function(connectionInfo, cb){
		gremlinHelper.close();
		cb();
	},

	testConnection: async function(connectionInfo, logger, cb) {
		logger.clear();
		client = setUpDocumentClient(connectionInfo);
		try {
			await getDatabasesData();
			return cb();
		} catch(err) {
			logger.log('error', mapError(err));
			return cb(mapError(err));
		}
	},

	getDatabases: async function(connectionInfo, logger, cb){
		client = setUpDocumentClient(connectionInfo);
		logger.clear();
		logger.log('info', connectionInfo, 'Reverse-Engineering connection settings', connectionInfo.hiddenKeys);

		try {
			const dbsData = await getDatabasesData();
			const dbs = dbsData.map(item => item.id);
			logger.log('info', dbs, 'All databases list', connectionInfo.hiddenKeys);
			return cb(null, dbs);
		} catch(err) {
			logger.log('error', err);
			return cb(mapError(err));
		}
	},

	getDocumentKinds: function(connectionInfo, logger, cb) {
		cb(null, []);
	},

	getDbCollectionsNames: async function(connectionInfo, logger, cb) {
		try {
			client = setUpDocumentClient(connectionInfo);
			logger.log('info', connectionInfo, 'Reverse-Engineering connection settings', connectionInfo.hiddenKeys);
			
			logger.log('info', { Database: connectionInfo.database }, 'Getting collections list for current database', connectionInfo.hiddenKeys);
			const collections = await listCollections(connectionInfo.database);
			
			logger.log('info', { CollectionList: collections }, 'Collection list for current database', connectionInfo.hiddenKeys);
			const result = await Promise.all(collections.map(async collection => {
				await gremlinHelper.connect({ ...connectionInfo, collection: collection.id });
				const collectionLebels = await gremlinHelper.getLabels();
				gremlinHelper.close();

				return {
					dbName: collection.id,
					dbCollections: collectionLebels,
				};
			}));
			
			cb(null, result);
		} catch(err) {
			logger.log('error', err);
			return cb(mapError(err));
		}
	},

	getDbCollectionsData: async function(data, logger, cb) {
		try {
			logger.clear();
			logger.log('info', data, 'connectionInfo', data.hiddenKeys);
	
			const collections = data.collectionData.collections;
			const collectionNames = data.collectionData.dataBaseNames;
			const fieldInference = data.fieldInference;
			const includeEmptyCollection = data.includeEmptyCollection;
			const includeSystemCollection = data.includeSystemCollection;
			const recordSamplingSettings = data.recordSamplingSettings;
			let packages = {
				labels: [],
				relationships: []
			};
			const { resource: accountInfo } = await client.getDatabaseAccount();
			const additionalAccountInfo = await getAdditionalAccountInfo(data, logger);
			const modelInfo = {
				defaultConsistency: accountInfo.consistencyPolicy,
				preferredLocation: accountInfo.writableLocations[0] ? accountInfo.writableLocations[0].name : '',
				...additionalAccountInfo,
			};
	
			const dbCollectionsPromise = collectionNames.map(async collectionName => {
				const labels = collections[collectionName];

				const containerInstance = client.database(data.database).container(collectionName);
				const storedProcs = await getStoredProcedures(containerInstance);
				const triggers = await getTriggers(containerInstance);
				const udfs = await getUdfs(containerInstance);
				const collection = await getCollectionById(containerInstance);
				const offerInfo = await getOfferType(collection);
				const { autopilot, throughput } = getOfferProps(offerInfo);
				const partitionKey = getPartitionKey(collection);
				const bucketInfo = {
					dbId: data.database,
					throughput,
					autopilot,
					partitionKey,
					uniqueKey: getUniqueKeys(collection),
					storedProcs,
					triggers,
					udfs,
					TTL: getTTL(collection.defaultTtl),
					TTLseconds: collection.defaultTtl
				};
				const indexes = getIndexes(collection.indexingPolicy);

				await gremlinHelper.connect({ collection: collectionName });
				const nodesData = await getNodesData(collectionName, labels, logger, {
					recordSamplingSettings,
					fieldInference,
					includeEmptyCollection,
					indexes,
					bucketInfo,
					partitionKey,
				});
				packages.labels.push(nodesData);
				const labelNames = nodesData.reduce((result, packageData) => result.concat([packageData.collectionName]), []);
				let relationships = await gremlinHelper.getRelationshipSchema(labelNames);
				relationships = relationships.filter(data => {
					return (labelNames.includes(data.start) && labelNames.includes(data.end));
				});
				const relationshipData = await getRelationshipData(relationships, collectionName, recordSamplingSettings, fieldInference);
				packages.relationships.push(relationshipData);
				gremlinHelper.close();
			});
			
			await Promise.all(dbCollectionsPromise);
	
			cb(null, packages.labels, modelInfo, [].concat.apply([], packages.relationships));
		} catch (err) {
				gremlinHelper.close();
				logger.log('error', mapError(err), "Error");
				cb(mapError(err));
		}
	}
};

const getCount = (count, recordSamplingSettings) => {
	const per = recordSamplingSettings.relative.value;
	const size = (recordSamplingSettings.active === 'absolute')
		? recordSamplingSettings.absolute.value
		: Math.round(count / 100 * per);
	return size;
};

const isEmptyLabel = (documents) => {
	if (!Array.isArray(documents)) {
		return true;
	}

	return documents.reduce((result, doc) => result && _.isEmpty(doc), true);
};

const getTemplate = (documents, rootTemplateArray = []) => {
	const template = rootTemplateArray.reduce((template, key) => Object.assign({}, template, { [key]: {} }), {});

	if (!_.isArray(documents)) {
		return template;
	}

	return documents.reduce((tpl, doc) => _.merge(tpl, doc), template);
};

const getNodesData = (dbName, labels, logger, data) => {
	return new Promise((resolve, reject) => {
		let packages = [];
		async.map(labels, (labelName, nextLabel) => {
			logger.progress({ message: 'Start sampling data', containerName: dbName, entityName: labelName });
			gremlinHelper.getNodesCount(labelName)
			.then(quantity => {
				logger.progress({ message: 'Start getting data from graph', containerName: dbName, entityName: labelName });
				const count = getCount(quantity, data.recordSamplingSettings);

				return gremlinHelper.getNodes(labelName, count).then(documents => (
					{ limit: count, documents }
				));
			})
			.then(({ documents }) => {
				logger.progress({ message: `Data has successfully got`, containerName: dbName, entityName: labelName });
				const packageData = getLabelPackage({
					dbName, 
					labelName, 
					documents,
					includeEmptyCollection: data.includeEmptyCollection, 
					fieldInference: data.fieldInference,
					indexes: [],
					bucketIndexes: data.indexes,
					bucketInfo: data.bucketInfo,
					partitionKey: data.partitionKey,
				});
				if (packageData) {
					packages.push(packageData);
				}
				nextLabel(null);
			}).catch(nextLabel);
		}, (err) => {
			if (err) {
				reject(err);
			} else {
				const sortedPackages = sortPackagesByLabels(labels, packages);
				resolve(sortedPackages);
			}
		});
	});
};

const sortPackagesByLabels = (labels, packages) => {
	return [...packages].sort((a, b) => {
		const indexA = _.indexOf(labels, a['collectionName']);
		const indexB = _.indexOf(labels, b['collectionName']);
		if (_.isUndefined(indexA)) {
			return 1;
		}
		if (_.isUndefined(indexB)) {
			return -1;
		}

		return indexA - indexB;
	})
}

const getRelationshipData = (schema, dbName, recordSamplingSettings, fieldInference) => {
	return new Promise((resolve, reject) => {
		async.map(schema, (chain, nextChain) => {
			gremlinHelper.getCountRelationshipsData(chain.start, chain.relationship, chain.end).then((quantity) => {
				const count = getCount(quantity, recordSamplingSettings);
				return gremlinHelper.getRelationshipData(chain.start, chain.relationship, chain.end, count);
			})
			.then(({ documents, schema, template }) => {
				let packageData = {
					dbName,
					parentCollection: chain.start, 
					relationshipName: chain.relationship, 
					childCollection: chain.end,
					documents,
					validation: {
						jsonSchema: schema
					}
				};

				if (fieldInference.active === 'field') {
					packageData.documentTemplate = getTemplate(documents, template);
				}

				nextChain(null, packageData);
			}).catch(nextChain);
		}, (err, packages) => {
			if (err) {
				reject(err);
			} else {
				resolve(packages);
			}
		});
	});
};

const getLabelPackage = ({dbName, labelName, documents, includeEmptyCollection, bucketInfo, bucketIndexes, fieldInference, partitionKey}) => {
	let packageData = {
		dbName,
		collectionName: labelName,
		documents,
		views: [],
		emptyBucket: false,
		bucketInfo,
		bucketIndexes,
		validation: createSchemaByPartitionKeyPath(partitionKey, documents),
	};
	if (fieldInference.active === 'field') {
		packageData.documentTemplate = documents.reduce((tpl, doc) => _.merge(tpl, doc), {});
	}

	if (includeEmptyCollection || !isEmptyLabel(documents)) {
		return packageData;
	} else {
		return null;
	}
}; 

const mapError = (error) => {
	return {
		message: error.message,
		stack: error.stack
	};
};

function createSchemaByPartitionKeyPath(path, documents = []) {
	const checkIfDocumentContaintPath = (path, document = {}) => {
		if (_.isEmpty(path)) {
			return true;
		}
		const value = _.get(document, `${path[0]}`);
		if (value) {
			return checkIfDocumentContaintPath(_.tail(path), value);
		}
		return false;
	}

	const getNestedObject = (path) => {
		if (path.length === 1) {
			return {
				[path[0]]: {
					primaryKey: true,
					partitionKey: true,
				}
			}
		}
		return {
			[path[0]]: {
				properties: getNestedObject(_.tail(path))
			}
		};
	}

	if (!path || typeof path !== 'string') {
		return false;
	}
	const namePath = _.tail(path.split('/'));
	if (namePath.length === 0) {
		return false;
	}
	if (!documents.some(doc => checkIfDocumentContaintPath(namePath, doc))) {
		return false;
	} 

	return {
		jsonSchema: {
			properties: getNestedObject(namePath)
		}
	};
}

const setUpDocumentClient = (connectionInfo) => {
	const dbNameRegExp = /wss:\/\/(\S*).gremlin\.cosmos\./i;
	const dbName = dbNameRegExp.exec(connectionInfo.gremlinEndpoint)[1];
	const endpoint = `https://${dbName}.documents.azure.com:443/`;
	const key = connectionInfo.accountKey;

	return new CosmosClient({ endpoint, key });
}

async function getCollectionById(containerInstance) {
	const { resource: collection } = await containerInstance.read();
	return collection;
}

async function getDatabasesData() {
	const dbResponse = await client.databases.readAll().fetchAll();
	return dbResponse.resources;

}

async function listCollections(databaseId) {
	const { resources: containers } = await client.database(databaseId).containers.readAll().fetchAll();
	return containers;
}

function getIndexes(indexingPolicy){
	const rangeIndexes = getRangeIndexes(indexingPolicy);
	const spatialIndexes = getSpatialIndexes(indexingPolicy);
	const compositeIndexes = getCompositeIndexes(indexingPolicy);

	return rangeIndexes.concat(spatialIndexes).concat(compositeIndexes);
}

async function getOfferType(collection) {
	const querySpec = {
		query: 'SELECT * FROM root r WHERE  r.resource = @link',
		parameters: [
			{
				name: '@link',
				value: collection._self
			}
		]
	};
	const { resources: offer } = await client.offers.query(querySpec).fetchAll();
	return offer.length > 0 && offer[0];
}

function getRangeIndexes(indexingPolicy) {
	let rangeIndexes = [];
	const excludedPaths = indexingPolicy.excludedPaths.map(({ path }) => path).join(', ');
	
	if(indexingPolicy) {
		indexingPolicy.includedPaths.forEach((item, i) => {
			if (item.indexes) {
				const indexes = item.indexes.map((index, j) => {
					return {
						name: `New Index(${j+1})`,
						indexPrecision: index.precision,
						automatic: indexingPolicy.automatic,
						mode: indexingPolicy.indexingMode,
						indexIncludedPath: item.path,
						indexExcludedPath: excludedPaths,
						dataType: index.dataType,
						kind: index.kind
					};
				});
				rangeIndexes = rangeIndexes.concat(rangeIndexes, indexes);
			} else {
				const index = {
					name: `New Index(${i+1})`,
					automatic: indexingPolicy.automatic,
					mode: indexingPolicy.indexingMode,
					indexIncludedPath: item.path,
					indexExcludedPath: excludedPaths,
					kind: 'Range'
				}
				rangeIndexes.push(index);
			}
		});
	}
	return rangeIndexes;
}

function getSpatialIndexes(indexingPolicy) {
	if (!indexingPolicy.spatialIndexes) {
		return [];
	}
	return indexingPolicy.spatialIndexes.map(item => {
		return {
			name: 'Spatial index',
			automatic: indexingPolicy.automatic,
			mode: indexingPolicy.indexingMode,
			kind: 'Spatial',
			indexIncludedPath: item.path,
			dataTypes: item.types.map(type => ({ spatialType: type }))
		};
	});
}

function getCompositeIndexes(indexingPolicy) {
	if (!indexingPolicy.compositeIndexes) {
		return [];
	}
	return indexingPolicy.compositeIndexes.map(item => {
		return {
			name: 'Composite index',
			automatic: indexingPolicy.automatic,
			mode: indexingPolicy.indexingMode,
			kind: 'Composite',
			compositeFields: item.map(({ order, path }) => ({ compositeFieldPath: path, compositeFieldOrder: order }))
		};
	});
}

function getPartitionKey(collection) {
	if (!collection.partitionKey) {
		return '';
	}
	if (!Array.isArray(collection.partitionKey.paths)) {
		return '';
	}
	
	return collection.partitionKey.paths.join(',');
}

function getUniqueKeys(collection) {
	if (!collection.uniqueKeyPolicy) {
		return [];
	}

	if (!Array.isArray(collection.uniqueKeyPolicy.uniqueKeys)) {
		return [];
	}

	return collection.uniqueKeyPolicy.uniqueKeys.map(item => {
		if (!Array.isArray(item.paths)) {
			return;
		}

		return {
			attributePath: item.paths.join(',')
		};
	}).filter(Boolean);
}

function getOfferProps(offer) {
	const isAutopilotOn = _.get(offer, 'content.offerAutopilotSettings');
	if (isAutopilotOn) {
		return {
			autopilot: true,
			throughput: offer.content.offerAutopilotSettings.maximumTierThroughput
		};
	}
	return {
		autopilot: false,
		throughput: offer ? offer.content.offerThroughput : ''
	};
}

async function getStoredProcedures(containerInstance) {
	const { resources } = await containerInstance.scripts.storedProcedures.readAll().fetchAll();
	return resources.map((item, i) => {
		return {
			storedProcID: item.id,
			name: `New Stored procedure(${i+1})`,
			storedProcFunction: item.body
		};
	});
}

async function getTriggers(containerInstance) {
	const { resources } = await containerInstance.scripts.triggers.readAll().fetchAll();
	return resources.map((item, i) => {
		return {
			triggerID: item.id,
			name: `New Trigger(${i+1})`,
			prePostTrigger: item.triggerType === 'Pre' ? 'Pre-Trigger' : 'Post-Trigger',
			triggerOperation: item.triggerOperation,
			triggerFunction: item.body
		};
	});
}

async function getUdfs(containerInstance) {
	const { resources } = await containerInstance.scripts.userDefinedFunctions.readAll().fetchAll();
	return resources.map((item, i) => {
		return {
			udfID: item.id,
			name: `New UDFS(${i+1})`,
			udfFunction: item.body
		};
	});
}

function getTTL(defaultTTL) {
	if (!defaultTTL) {
		return 'Off';
	}
	return defaultTTL === -1 ? 'On (no default)' : 'On';
}

async function getAdditionalAccountInfo(connectionInfo, logger) {
	if (!connectionInfo.includeAccountInformation) {
		return {};
	}

	logger.log('info', {}, 'Account additional info', connectionInfo.hiddenKeys);

	try {
		const { clientId, appSecret, tenantId, subscriptionId, resourceGroupName, gremlinEndpoint } = connectionInfo;
		const accNameRegex = /wss:\/\/(.+)\.gremlin.+/i;
		const accountName = accNameRegex.test(gremlinEndpoint) ? accNameRegex.exec(gremlinEndpoint)[1] : '';
		const tokenBaseURl = `https://login.microsoftonline.com/${tenantId}/oauth2/token`;
		const { data: tokenData } = await axios({
			method: 'post',
			url: tokenBaseURl,
			data: qs.stringify({
				grant_type: 'client_credentials',
				client_id: clientId,
				client_secret: appSecret,
				resource: 'https://management.azure.com/'
			}),
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			}
		});
		const dbAccountBaseUrl = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.DocumentDB/databaseAccounts/${accountName}?api-version=2015-04-08`;
		const { data: accountData } = await axios({
			method: 'get',
			url: dbAccountBaseUrl,
			headers: {
				'Authorization': `${tokenData.token_type} ${tokenData.access_token}`
			}
		});
		logger.progress({
			message: 'Getting account information',
			containerName: connectionInfo.database,
			entityName: ''
		});
		return {
			enableMultipleWriteLocations: accountData.properties.enableMultipleWriteLocations,
			enableAutomaticFailover: accountData.properties.enableAutomaticFailover,
			isVirtualNetworkFilterEnabled: accountData.properties.isVirtualNetworkFilterEnabled,
			virtualNetworkRules: accountData.properties.virtualNetworkRules.map(({ id, ignoreMissingVNetServiceEndpoint }) => ({
				virtualNetworkId: id,
				ignoreMissingVNetServiceEndpoint
			})),
			ipRangeFilter: accountData.properties.ipRangeFilter,
			tags: Object.entries(accountData.tags).map(([tagName, tagValue]) => ({ tagName, tagValue })),
			locations: accountData.properties.locations.map(({ id, locationName, failoverPriority, isZoneRedundant }) => ({
				locationId: id,
				locationName,
				failoverPriority,
				isZoneRedundant
			}))
		};
	} catch(err) {
		logger.log('error', { message: _.get(err, 'response.data.error.message', err.message), stack: err.stack });
		logger.progress({
			message: 'Error while getting account information',
			containerName: connectionInfo.database
		});
		return {};
	}
}
