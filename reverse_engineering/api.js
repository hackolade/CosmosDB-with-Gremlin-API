'use strict';

const async = require('async');
let _;
const { setDependencies, dependencies } = require('./appDependencies');
const { CosmosClient } = require('@azure/cosmos');
const axios = require('axios');
const qs = require('qs');
const gremlinHelper = require('./gremlinHelper');
let client;

module.exports = {
	connect: function (connectionInfo, logger, cb, app) {
		setDependencies(app);
		_ = dependencies.lodash;
		logger.clear();
		logger.log('info', connectionInfo, 'connectionInfo', connectionInfo.hiddenKeys);
		cb();
	},

	disconnect: function (connectionInfo, cb) {
		gremlinHelper.close();
		cb();
	},

	testConnection: async function (connectionInfo, logger, cb, app) {
		try {
			setDependencies(app);
			_ = dependencies.lodash;
			logger.clear();
			client = setUpDocumentClient(connectionInfo);

			await getDatabasesData();
			return cb();
		} catch (err) {
			logger.log('error', mapError(err));
			return cb(mapError(err));
		}
	},

	getDatabases: async function (connectionInfo, logger, cb, app) {
		try {
			setDependencies(app);
			_ = dependencies.lodash;
			client = setUpDocumentClient(connectionInfo);
			logger.clear();
			logger.log('info', connectionInfo, 'Reverse-Engineering connection settings', connectionInfo.hiddenKeys);

			const dbsData = await getDatabasesData();
			const dbs = dbsData.map(item => item.id);
			logger.log('info', dbs, 'All databases list', connectionInfo.hiddenKeys);
			return cb(null, dbs);
		} catch (err) {
			logger.log('error', err);
			return cb(mapError(err));
		}
	},

	getDocumentKinds: function (connectionInfo, logger, cb) {
		cb(null, []);
	},

	getDbCollectionsNames: async function (connectionInfo, logger, cb, app) {
		try {
			setDependencies(app);
			_ = dependencies.lodash;
			client = setUpDocumentClient(connectionInfo);
			logger.log('info', connectionInfo, 'Reverse-Engineering connection settings', connectionInfo.hiddenKeys);
			logger.log(
				'info',
				{ Database: connectionInfo.database },
				'Getting collections list for current database',
				connectionInfo.hiddenKeys,
			);
			const collections = await listCollections(connectionInfo.database);

			logger.log(
				'info',
				{ CollectionList: collections },
				'Collection list for current database',
				connectionInfo.hiddenKeys,
			);
			const result = await collections.reduce(async (acc, collection) => {
				const res = await acc;
				await gremlinHelper.connect({ ...connectionInfo, collection: collection.id });
				logger.log('info', '', 'Connected to the Gremlin API', connectionInfo.hiddenKeys);
				let collectionLabels;
				try {
					collectionLabels = await gremlinHelper.getLabels();
					logger.log(
						'info',
						{ collectionLabels: collectionLabels },
						'Collection labels list',
						connectionInfo.hiddenKeys,
					);
					gremlinHelper.close();
				} catch (err) {
					if (err.message?.includes('NullReferenceException')) {
						logger.log(
							'info',
							{ collectionName: collection.id },
							'Skipping document collection',
							connectionInfo.hiddenKeys,
						);
						gremlinHelper.close();
						return res;
					} else {
						throw err;
					}
				}

				return [
					...res,
					{
						dbName: collection.id,
						dbCollections: collectionLabels,
					},
				];
			}, []);

			cb(null, result);
		} catch (err) {
			logger.log('error', err);
			return cb(mapError(err));
		}
	},

	getDbCollectionsData: async function (data, logger, cb, app) {
		try {
			setDependencies(app);
			_ = dependencies.lodash;
			logger.clear();
			logger.log('info', data, 'connectionInfo', data.hiddenKeys);

			const collections = data.collectionData.collections;
			const collectionNames = data.collectionData.dataBaseNames;
			const fieldInference = data.fieldInference;
			const includeEmptyCollection = data.includeEmptyCollection;
			const recordSamplingSettings = data.recordSamplingSettings;
			logger.log('info', '', 'Getting DB account info', data.hiddenKeys);
			const { resource: accountInfo } = await client.getDatabaseAccount();
			const additionalAccountInfo = await getAdditionalAccountInfo(data, logger);
			const modelInfo = {
				defaultConsistency: accountInfo.consistencyPolicy,
				preferredLocation: accountInfo.writableLocations[0] ? accountInfo.writableLocations[0].name : '',
				tenant: data.tenantId,
				resGrp: data.resourceGroupName,
				subscription: data.subscriptionId,
				...additionalAccountInfo,
			};

			const packages = await collectionNames.reduce(
				async (acc, collectionName) => {
					const packages = await acc;
					const labels = collections[collectionName];

					const containerInstance = client.database(data.database).container(collectionName);
					const storedProcs = await getStoredProcedures(containerInstance);
					const triggers = await getTriggers(containerInstance);
					const udfs = await getUdfs(containerInstance);
					const collection = await getCollectionById(containerInstance);
					const offerInfo = await getOfferType(collection, logger);
					const { autopilot, throughput, capacityMode } = getOfferProps(offerInfo);
					const partitionKey = getPartitionKey(collection);
					const indexes = getIndexes(collection.indexingPolicy);
					const bucketInfo = Object.assign(
						{
							dbId: data.database,
							throughput,
							autopilot,
							partitionKey,
							capacityMode,
							uniqueKey: getUniqueKeys(collection),
							storedProcs,
							triggers,
							udfs,
							TTL: getTTL(collection.defaultTtl),
							TTLseconds: collection.defaultTtl,
						},
						indexes,
					);

					logger.log('info', { collection: collectionName }, 'Getting container nodes data', data.hiddenKeys);
					await gremlinHelper.connect({ collection: collectionName });
					const nodesData = await getNodesData(collectionName, labels, logger, {
						recordSamplingSettings,
						fieldInference,
						includeEmptyCollection,
						indexes,
						bucketInfo,
						partitionKey,
					});
					let relationships = [];
					packages.labels.push(nodesData);
					const labelNames = nodesData.reduce((result, packageData) => result.concat([packageData.collectionName]), []);
					const labelsRelationships = await gremlinHelper.getRelationshipSchema(labelNames);
					labelsRelationships.forEach(labelRelationships =>
						labelRelationships
							.filter(relationship => labelNames.includes(relationship.start) && labelNames.includes(relationship.end))
							.forEach(relationship => relationships.push(relationship)),
					);
					const relationshipData = await getRelationshipData(
						relationships,
						collectionName,
						recordSamplingSettings,
						fieldInference,
					);
					packages.relationships.push(relationshipData);
					gremlinHelper.close();

					return packages;
				},
				{
					labels: [],
					relationships: [],
				},
			);

			cb(null, packages.labels, modelInfo, [].concat.apply([], packages.relationships));
		} catch (err) {
			gremlinHelper.close();
			logger.log('error', mapError(err), 'Error');
			cb(mapError(err));
		}
	},
};

const getSampleDocSize = (count, recordSamplingSettings) => {
	if (recordSamplingSettings.active === 'absolute') {
		return Number(recordSamplingSettings.absolute.value);
	}

	const limit = Math.ceil((count * recordSamplingSettings.relative.value) / 100);

	return Math.min(limit, recordSamplingSettings.maxValue);
};

const isEmptyLabel = documents => {
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
		async.map(
			labels,
			(labelName, nextLabel) => {
				logger.progress({ message: 'Start sampling data', containerName: dbName, entityName: labelName });
				gremlinHelper
					.getNodesCount(labelName)
					.then(quantity => {
						logger.progress({ message: 'Start getting data from graph', containerName: dbName, entityName: labelName });
						const count = getSampleDocSize(quantity, data.recordSamplingSettings);

						return gremlinHelper.getNodes(labelName, count).then(documents => ({ limit: count, documents }));
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
							bucketInfo: data.bucketInfo,
							partitionKey: data.partitionKey,
						});
						if (packageData) {
							packages.push(packageData);
						}
						nextLabel(null);
					})
					.catch(nextLabel);
			},
			err => {
				if (err) {
					reject(err);
				} else {
					const sortedPackages = sortPackagesByLabels(labels, packages);
					resolve(sortedPackages);
				}
			},
		);
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
	});
};

const getRelationshipData = (schema, dbName, recordSamplingSettings, fieldInference) => {
	return new Promise((resolve, reject) => {
		async.map(
			schema,
			(chain, nextChain) => {
				gremlinHelper
					.getCountRelationshipsData(chain.start, chain.relationship, chain.end)
					.then(quantity => {
						const count = getSampleDocSize(quantity, recordSamplingSettings);
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
								jsonSchema: schema,
							},
						};

						if (fieldInference.active === 'field') {
							packageData.documentTemplate = getTemplate(documents, template);
						}

						nextChain(null, packageData);
					})
					.catch(nextChain);
			},
			(err, packages) => {
				if (err) {
					reject(err);
				} else {
					resolve(packages);
				}
			},
		);
	});
};

const getLabelPackage = ({
	dbName,
	labelName,
	documents,
	includeEmptyCollection,
	bucketInfo,
	bucketIndexes,
	fieldInference,
	partitionKey,
}) => {
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

const mapError = error => {
	return {
		message: error.message,
		stack: error.stack,
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
	};

	const getNestedObject = path => {
		if (path.length === 1) {
			return {
				[path[0]]: {
					primaryKey: true,
					partitionKey: true,
				},
			};
		}
		return {
			[path[0]]: {
				properties: getNestedObject(_.tail(path)),
			},
		};
	};

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
			properties: getNestedObject(namePath),
		},
	};
}

const setUpDocumentClient = connectionInfo => {
	const dbNameRegExp = /wss:\/\/(\S*).gremlin\.cosmos\./i;
	const dbName = dbNameRegExp.exec(connectionInfo.gremlinEndpoint);
	if (!dbName || !dbName[1]) {
		throw new Error('Incorrect endpoint provided. Expected format: wss://<account name>.gremlin.cosmos.');
	}
	const endpoint = `https://${dbName[1]}.documents.azure.com:443/`;
	const key = connectionInfo.accountKey;

	return new CosmosClient({ endpoint, key });
};

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

async function getOfferType(collection, logger) {
	try {
		const querySpec = {
			query: 'SELECT * FROM root r WHERE  r.resource = @link',
			parameters: [
				{
					name: '@link',
					value: collection._self,
				},
			],
		};
		const { resources: offer } = await client.offers.query(querySpec).fetchAll();

		return offer.length > 0 && offer[0];
	} catch (e) {
		logger.log('error', { message: e.message, stack: e.stack }, '[Warning] Error querying offers');

		return;
	}
}

function getPartitionKey(collection) {
	if (!collection.partitionKey) {
		return '';
	}
	if (!Array.isArray(collection.partitionKey.paths)) {
		return '';
	}
	return collection.partitionKey.paths.map(getKeyPath);
}

function getUniqueKeys(collection) {
	if (!collection.uniqueKeyPolicy) {
		return [];
	}

	if (!Array.isArray(collection.uniqueKeyPolicy.uniqueKeys)) {
		return [];
	}

	return collection.uniqueKeyPolicy.uniqueKeys
		.map(item => {
			if (!Array.isArray(item.paths)) {
				return;
			}

			return {
				attributePath: item.paths.join(','),
			};
		})
		.filter(Boolean);
}

function getOfferProps(offer) {
	if (!offer) {
		return {
			capacityMode: 'Serverless',
		};
	}
	const isAutopilotOn = _.get(offer, 'content.offerAutopilotSettings');
	if (isAutopilotOn) {
		return {
			autopilot: true,
			throughput: offer.content.offerAutopilotSettings.maximumTierThroughput,
			capacityMode: 'Provisioned throughput',
		};
	}
	return {
		autopilot: false,
		throughput: offer ? offer.content.offerThroughput : '',
		capacityMode: 'Provisioned throughput',
	};
}

async function getStoredProcedures(containerInstance) {
	const { resources } = await containerInstance.scripts.storedProcedures.readAll().fetchAll();
	return resources.map((item, i) => {
		return {
			storedProcID: item.id,
			name: `New Stored procedure(${i + 1})`,
			storedProcFunction: item.body,
		};
	});
}

async function getTriggers(containerInstance) {
	const { resources } = await containerInstance.scripts.triggers.readAll().fetchAll();
	return resources.map((item, i) => {
		return {
			triggerID: item.id,
			name: `New Trigger(${i + 1})`,
			prePostTrigger: item.triggerType === 'Pre' ? 'Pre-Trigger' : 'Post-Trigger',
			triggerOperation: item.triggerOperation,
			triggerFunction: item.body,
		};
	});
}

async function getUdfs(containerInstance) {
	const { resources } = await containerInstance.scripts.userDefinedFunctions.readAll().fetchAll();
	return resources.map((item, i) => {
		return {
			udfID: item.id,
			name: `New UDFS(${i + 1})`,
			udfFunction: item.body,
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
				resource: 'https://management.azure.com/',
			}),
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
		});
		const dbAccountBaseUrl = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.DocumentDB/databaseAccounts/${accountName}?api-version=2015-04-08`;
		const { data: accountData } = await axios({
			method: 'get',
			url: dbAccountBaseUrl,
			headers: {
				'Authorization': `${tokenData.token_type} ${tokenData.access_token}`,
			},
		});
		logger.progress({
			message: 'Getting account information',
			containerName: connectionInfo.database,
			entityName: '',
		});
		return {
			enableMultipleWriteLocations: accountData.properties.enableMultipleWriteLocations,
			enableAutomaticFailover: accountData.properties.enableAutomaticFailover,
			isVirtualNetworkFilterEnabled: accountData.properties.isVirtualNetworkFilterEnabled,
			virtualNetworkRules: accountData.properties.virtualNetworkRules.map(
				({ id, ignoreMissingVNetServiceEndpoint }) => ({
					virtualNetworkId: id,
					ignoreMissingVNetServiceEndpoint,
				}),
			),
			ipRangeFilter: accountData.properties.ipRangeFilter,
			tags: Object.entries(accountData.tags).map(([tagName, tagValue]) => ({ tagName, tagValue })),
			locations: accountData.properties.locations.map(({ id, locationName, failoverPriority, isZoneRedundant }) => ({
				locationId: id,
				locationName,
				failoverPriority,
				isZoneRedundant,
			})),
		};
	} catch (err) {
		logger.log('error', { message: _.get(err, 'response.data.error.message', err.message), stack: err.stack });
		logger.progress({
			message: 'Error while getting account information',
			containerName: connectionInfo.database,
		});
		return {};
	}
}

function capitalizeFirstLetter(str) {
	return str.charAt(0).toUpperCase() + str.slice(1);
}

function getIndexes(indexingPolicy) {
	return {
		indexingMode: capitalizeFirstLetter(indexingPolicy.indexingMode || ''),
		indexingAutomatic: indexingPolicy.automatic === true ? 'true' : 'false',
		includedPaths: (indexingPolicy.includedPaths || []).map((index, i) => {
			return {
				name: `Included (${i + 1})`,
				indexIncludedPath: [getIndexPath(index.path)],
			};
		}),
		excludedPaths: indexingPolicy.excludedPaths.map((index, i) => {
			return {
				name: `Excluded (${i + 1})`,
				indexExcludedPath: [getIndexPath(index.path)],
			};
		}),
		spatialIndexes: (indexingPolicy.spatialIndexes || []).map((index, i) => {
			return {
				name: `Spatial (${i + 1})`,
				indexIncludedPath: [getIndexPath(index.path)],
				dataTypes: (index.types || []).map(spatialType => ({
					spatialType,
				})),
			};
		}),
		compositeIndexes: (indexingPolicy.compositeIndexes || []).map((indexes, i) => {
			const compositeFieldPath = indexes.map((index, i) => {
				return {
					name: getKeyPath(index.path),
					type: index.order || 'ascending',
				};
			}, {});

			return {
				name: `Composite (${i + 1})`,
				compositeFieldPath,
			};
		}),
	};
}

const getIndexPathType = path => {
	if (/\?$/.test(path)) {
		return '?';
	} else if (/\*$/.test(path)) {
		return '*';
	} else {
		return '';
	}
};

const getIndexPath = path => {
	const type = getIndexPathType(path);
	const name = path.replace(/\/(\?|\*)$/, '');

	return {
		name: getKeyPath(name),
		type,
	};
};

const trimKey = key => {
	const trimRegexp = /^\"([\s\S]+)\"$/i;

	if (!trimRegexp.test(key)) {
		return key;
	}

	const result = key.match(trimRegexp);

	return result[1] || key;
};

const getKeyPath = keyPath => {
	return (keyPath || '')
		.split('/')
		.filter(Boolean)
		.map(trimKey)
		.map(item => (item === '[]' ? 0 : item))
		.join('.');
};
