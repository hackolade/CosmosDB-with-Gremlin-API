const _ = require('lodash');
const applyToInstanceHelper = require('./applyToInstanceHelper');
const getIndexPolicyScript = require('./getIndexPolicyScript');
const scriptHelper = require('./scriptHelper');

const DEFAULT_INDENT = '    ';
let graphName = 'g';

module.exports = {
	generateContainerScript(data, logger, cb, app) {
		logger.clear();
		try {
			const _ = app.require('lodash');
			const scriptId = _.get(data, 'options.targetScriptOptions.keyword');

			if (data.options.origin === 'ui') {
				cb(null, [
					{
						script: getGremlinScript(_, data),
					},
					{
						script: getCosmosDbScript(_, data.containerData),
					}
				]);
			} else if (scriptId === 'cosmosdb') {
				cb(null, getCosmosDbScript(_, data.containerData));
			} else {
				cb(null, getGremlinScript(_, data));
			}
		} catch(e) {
			logger.log('error', { message: e.message, stack: e.stack }, 'Forward-Engineering Error');
			setTimeout(() => {
				cb({ message: e.message, stack: e.stack });
			}, 150);
			return;
		}
	},

	async applyToInstance(data, logger, cb, app) {
		try {
			logger.clear();
			logger.log('info', data, data.hiddenKeys);

			if (!data.script) {
				return cb({ message: 'Empty script' });
			}

			if (!data.containerData) {
				return cb({ message: 'Graph wasn\'t specified' });
			}
			const targetScriptOptions = data.targetScriptOptions || {};
			const containerProps = _.get(data.containerData, '[0]', {});
			if (!containerProps.dbId) {
				return cb({ message: 'Database id wasn\'t specified' });
			}
			const graphName = containerProps.code || containerProps.name;
			if (!graphName) {
				return cb({ message: 'Graph name wasn\'t specified' });
			}
			const progress = createLogger(logger, containerProps.dbId, graphName);

			const cosmosClient = applyToInstanceHelper.setUpDocumentClient(data);

			progress('Create database if not exists ...');

			await cosmosClient.databases.createIfNotExists({
				id: containerProps.dbId
			});

			progress('Create container if not exists ...');

			const containerResponse = await cosmosClient
				.database(containerProps.dbId)
				.containers.createIfNotExists({
					id: graphName,
					partitionKey: getPartitionKey(_)(data.containerData),
					...(containerProps.autopilot
						? { maxThroughput: containerProps.throughput || 400 }
						: { throughput: containerProps.throughput || 400 }),
					defaultTtl: applyToInstanceHelper.getTTL(containerProps),
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
				await applyToInstanceHelper.createStoredProcs(storedProcs, containerResponse.container);
			}

			const udfs = _.get(cosmosDBScript, 'User Defined Functions', []);
			if (udfs.length) {
				progress('Upload user defined functions ...');
				await applyToInstanceHelper.createUDFs(udfs, containerResponse.container);
			}

			const triggers = _.get(cosmosDBScript, 'Triggers', []);
			if (triggers.length) {
				progress('Upload triggers ...');
				await applyToInstanceHelper.createTriggers(triggers, containerResponse.container);
			}

			if (!gremlinScript) {
				return cb();
			}

			progress('Applying Gremlin script ...');

			const { labels, edges } = applyToInstanceHelper.parseScriptStatements(gremlinScript);
			const gremlinClient = await applyToInstanceHelper.getGremlinClient(data, containerProps.dbId, graphName);

			progress('Uploading labels ...');
			
			await applyToInstanceHelper.runGremlinQueries(gremlinClient, labels);
			
			progress('Uploading edges ...');

			await applyToInstanceHelper.runGremlinQueries(gremlinClient, edges);
			
			cb();
		} catch(err) {
			logger.log('error', mapError(err));
			cb(mapError(err));
		}
	},

	async testConnection(connectionInfo, logger, cb, app) {
		logger.clear();
		logger.log('info', connectionInfo, 'Test connection', connectionInfo.hiddenKeys);
		try {
			const client = applyToInstanceHelper.setUpDocumentClient(connectionInfo);
			await applyToInstanceHelper.testConnection(client);
			return cb();
		} catch(err) {
			logger.log('error', mapError(err), 'Connection failed');
			return cb(mapError(err));
		}
	}
};

const getGremlinScript = (_, data) => {
	let { collections, relationships, jsonData, containerData, options } = data;
	let resultScript = '';
	const traversalSource = _.get(containerData, [0, 'traversalSource'], 'g');
	graphName = transformToValidGremlinName(traversalSource);
	collections = collections.map(JSON.parse);
	relationships = relationships.map(JSON.parse);
	const indexesData = _.get(containerData, [1, 'indexes'], [])

	const variables = _.get(containerData, [0, 'graphVariables'], [])
	const variablesScript = generateVariables(variables);
	const verticesScript = generateVertices(collections, jsonData);
	const edgesScript = generateEdges(collections, relationships, jsonData);
	const indexesScript = generateIndexes(indexesData);

	if (variablesScript) {
		resultScript += variablesScript + '\n';
	}

	if (verticesScript) {
		resultScript += verticesScript;
	}

	if (edgesScript) {
		resultScript += '\n\n' + edgesScript;
	}

	if (indexesScript) {
		resultScript += '\n\n' + indexesScript;
	}

	return resultScript;
};

const getCosmosDbScript = (_, containerData) => {
	const script = JSON.stringify(
		{
			partitionKey: getPartitionKey(_)(containerData),
			indexingPolicy: getIndexPolicyScript(_)(containerData),
			...scriptHelper.addItems(_)(containerData),
		},
		null,
		2
	);

	return script;
};

const getPartitionKey = (_) => (containerData) => {
	const partitionKey = _.get(containerData, '[0].partitionKey[0].name', '').trim().replace(/\/$/, '');

	return partitionKey;
};

const updateIndexingPolicy = (indexes) => {
	const result = {...indexes};
	
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

const addDataType = (indexes) => {
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

const addSpatialTypes = (spatialIndex) => {
	if (Array.isArray(spatialIndex.types) && spatialIndex.types.length) {
		return spatialIndex;
	}
	
	return {
		...spatialIndex,
		types: [
			"Point",
			"LineString",
			"Polygon",
			"MultiPolygon"
		]
	};
};

const createLogger = (logger, containerName, entityName) => (message) => {
	logger.progress({ message, containerName, entityName });
	logger.log('info', { message }, 'Applying to instance');
};

const generateVariables = variables => {
	return variables.reduce((script, variable) => {
		const key = variable.graphVariableKey;
		const value = variable.GraphVariableValue || '';
		if (!key) {
			return script;
		}
		try {
			const parsedValue = JSON.parse(value);
			if (!_.isString(parsedValue)) {
				return script + `graph.variables().set("${key}", ${value});\n`;
			}

			return script + `graph.variables().set("${key}", "${value}");\n`;
		} catch (e) {
			return script + `graph.variables().set("${key}", "${value}");\n`
		}
	}, '');
};

const generateVertex = (collection, vertexData) => {
	const vertexName = transformToValidGremlinName(collection.collectionName);
	const propertiesScript = addPropertiesScript(collection, vertexData);

	return `${graphName}.addV(${JSON.stringify(vertexName)})${propertiesScript}`;
};

const generateVertices = (collections, jsonData) => {
	const vertices = collections.map(collection => {
		const vertexData = JSON.parse(jsonData[collection.GUID]);

		return generateVertex(collection, vertexData)
	});	

	const script = vertices.join(';\n\n');
	if (!script) {
		return '';
	}

	return script + ';';
}

const generateEdge = (from, to, relationship, edgeData) => {
	const edgeName = transformToValidGremlinName(relationship.name);
	const propertiesScript = addPropertiesScript(relationship, edgeData);

	return `${from}.addE(${JSON.stringify(edgeName)}).\n${DEFAULT_INDENT}to(${to})${propertiesScript}`;
};

const getVertexVariableScript = vertexName => `${graphName}.V().hasLabel(${JSON.stringify(vertexName)})`;

const generateEdges = (collections, relationships, jsonData) => {
	const edges = relationships.reduce((edges, relationship) => {
		const parentCollection = collections.find(collection => collection.GUID === relationship.parentCollection);
		const childCollection = collections.find(collection => collection.GUID === relationship.childCollection);
		if (!parentCollection || !childCollection) {
			return edges;
		}
		const from = transformToValidGremlinName(parentCollection.collectionName);
		const to = transformToValidGremlinName(childCollection.collectionName);
		const edgeData = JSON.parse(jsonData[relationship.GUID]);

		return edges.concat(generateEdge(getVertexVariableScript(from), getVertexVariableScript(to), relationship, edgeData));
	}, []);

	if (_.isEmpty(edges)) {
		return '';
	}

	return edges.join(';\n\n') + ';';
}

const getDefaultMetaPropertyValue = type => {
	switch(type) {
		case 'map': case 'list':
			return '[]';
		case 'set':
			return '[].toSet()';
		case 'string':
			return '"Lorem"';
		case 'number':
			return '1';
		case 'date':
			return 'new Date()';
		case 'timestamp':
			return 'new java.sql.Timestamp(1234567890123)';
		case 'uuid':
			return 'UUID.randomUUID()';
		case 'boolean':
			return 'true';
	}

	return '"Lorem"';
};

const handleMetaProperties = metaProperties => {
	if (!metaProperties){
		return '';
	}

	const metaPropertiesFlatList = metaProperties.reduce((list, property) => {
		if (!property.metaPropName) {
			return list;
		}

		const sample = _.isUndefined(property.metaPropSample) ? getDefaultMetaPropertyValue(property.metaPropType) : property.metaPropSample;

		return list.concat(
			JSON.stringify(property.metaPropName), 
			sample
		);
	}, []);

	return metaPropertiesFlatList.join(', ');
};

const handleMultiProperty = (property, name, jsonData) => {
	let properties = _.get(property, 'items', []);
	if (!_.isArray(properties)) {
		properties = [properties];
	}
	if (properties.length === 1) {
		properties = [ ...properties, ...properties];
		jsonData.push(_.first(jsonData));
	}

	const type = property.childType || property.type;
	const nameString = JSON.stringify(name);
	const propertiesValues = properties.map((property, index) => convertPropertyValue(property, 2, type, jsonData[index]));
	const metaProperties = properties.map(property => {
		const metaPropertiesScript = handleMetaProperties(property.metaProperties);
		if (_.isEmpty(metaPropertiesScript)) {
			return '';
		}

		return ', ' + metaPropertiesScript;
	});

	return propertiesValues.reduce((script, valueScript, index) => 
		`${script}.\n${DEFAULT_INDENT}property(single, ${nameString}, ${valueScript}${metaProperties[index]})`
	, '');
};

const getChoices = item => {
	const availableChoices = ['oneOf', 'allOf', 'anyOf'];

	const choices = availableChoices.reduce((choices, choiceType) => {
		const choice = _.get(item, choiceType, []);
		if (_.isEmpty(choice)) {
			return choices;
		}

		return Object.assign({}, choices, {
			[choiceType]: {
				choice: _.get(item, choiceType, []),
				meta: _.get(item, `${choiceType}_meta`, {}),
			}
		});
	}, {});
	
	if (_.isEmpty(choices)) {
		return [];
	}

	const choicePropertiesData = Object.keys(choices).map(choiceType => {
		const choiceData = choices[choiceType];
		const index = _.get(choiceData, 'meta.index');

		return {
			properties: _.first(choiceData.choice).properties || {},
			index
		};
	});

	const sortedChoices = choicePropertiesData.sort((a, b) => a.index - b.index);

	return sortedChoices.map((choiceData, index, choicesData) => {
		if (index === 0) {
			return choiceData;
		}

		const additionalPropertiesCount = choicesData.reduce((count, choiceData, choiceDataIndex) => {
			if (choiceDataIndex >= index) {
				return count;
			}

			return count + Object.keys(choiceData.properties).length - 1;
		}, 0);

		return {
			properties: choiceData.properties,
			index: choiceData.index + additionalPropertiesCount
		};
	});
};

const resolveArrayChoices = (choices, items) => {
	if (_.isEmpty(choices)) {
		return items;
	}
	
	const choiceItems = choices.reduce((choiceItems, choice) => {
		const choiceProperties = _.get(choice, 'properties', {});

		return choiceItems.concat(Object.keys(choiceProperties).map(key => choiceProperties[key]));
	}, []);

	return [...items, ...choiceItems];
};

const resolveChoices = (choices, properties) => {
	if (_.isEmpty(choices)) {
		return properties;
	}

	return choices.reduce((sortedProperties, choiceData) => {
		const choiceProperties = choiceData.properties;
		const choicePropertiesIndex = choiceData.index;
		if (_.isEmpty(sortedProperties)) {
			return choiceProperties;
		}

		if (
			_.isUndefined(choicePropertiesIndex) ||
			Object.keys(sortedProperties).length <= choicePropertiesIndex
		) {
			return Object.assign({}, sortedProperties, choiceProperties);
		}

		return Object.keys(sortedProperties).reduce((result, propertyKey, index) => {
			if (index !== choicePropertiesIndex) {
				return Object.assign({}, result, {
					[propertyKey] : sortedProperties[propertyKey]
				});
			}

			return Object.assign({}, result, choiceProperties, {
				[propertyKey] : sortedProperties[propertyKey]
			});
		}, {});
	}, properties || {});
};

const getListValues = (property, level, value) => {
	let items = _.get(property, 'items', []);
	if (!_.isArray(items)) {
		items = [items];
	}

	const choices = getChoices(property);
	items = resolveArrayChoices(choices, items);

	return items.map((item, index) => {
		const childValue = value[index];
		const type = item.childType || item.type;

		return convertPropertyValue(item, level + 1, type, childValue);
	});
};

const addPropertiesScript = (collection, vertexData) => {
	const properties = _.get(collection, 'properties', {});

	const choices = getChoices(collection);
	const propertiesWithResolvedChoices = resolveChoices(choices, properties);

	if (_.isEmpty(propertiesWithResolvedChoices)) {
		return '';
	}

	return Object.keys(propertiesWithResolvedChoices).reduce((script, name) => {
		const property = propertiesWithResolvedChoices[name];
		const type = property.childType || property.type;
		let metaPropertiesScript = handleMetaProperties(property.metaProperties);
		if (!_.isEmpty(metaPropertiesScript)) {
			metaPropertiesScript = ', ' + metaPropertiesScript;
		}
		if (type === 'multi-property') {
			return script + `${handleMultiProperty(property, name, vertexData[name])}`;
		}
		if (type === 'list') {
			const listValues = getListValues(property, 2, vertexData[name]);
			return listValues.reduce((script, valueScript) => {
				return script + getPropertyStatement(name, 'list', valueScript, metaPropertiesScript);
			}, script);

		}
		const valueScript = convertPropertyValue(property, 2, type, vertexData[name]);

		return script + getPropertyStatement(name, 'single', valueScript, metaPropertiesScript);
	}, '');
};

const getPropertyStatement = (name, propCardinality, valueScript, metaPropertiesScript) => {
	const cardinality = propCardinality === 'single' ? '' : propCardinality + ', '; 
	return `.\n${DEFAULT_INDENT}property(${cardinality}${JSON.stringify(name)}, ${valueScript}${metaPropertiesScript})`
};

const isGraphSONType = type => ['map', 'set', 'list', 'timestamp', 'date', 'uuid', 'number'].includes(type);

const convertMap = (property, level, value) => {
	const choices = getChoices(property);
	const properties = resolveChoices(choices, _.get(property, 'properties', {}));

	const childProperties = Object.keys(properties).map(name => ({
		name,
		property: properties[name]
	}));
	const indent = _.range(0, level).reduce(indent => indent + DEFAULT_INDENT, '');
	const previousIndent = _.range(0, level - 1).reduce(indent => indent + DEFAULT_INDENT, '');

	let mapValue = childProperties.reduce((result, {name, property}) => {
		const childValue = value[name];
		const type = property.childType || property.type;

		return result + `, \n${indent}${JSON.stringify(name)}: ${convertPropertyValue(property, level + 1, type, childValue)}`;
	}, '');

	if (mapValue.slice(0, 2) === ', ') {
		mapValue = mapValue.slice(2);
	}

	return `[${mapValue}\n${previousIndent}]`;
};

const convertList = (property, level, value) => {
	let items = _.get(property, 'items', []);
	if (!_.isArray(items)) {
		items = [items];
	}

	const choices = getChoices(property);
	items = resolveArrayChoices(choices, items);

	let listValue = items.reduce((result, item, index) => {
		const childValue = value[index];
		const type = item.childType || item.type;

		return result + `, ${convertPropertyValue(item, level + 1, type, childValue)}`;
	}, '');

	if (listValue.slice(0, 2) === ', ') {
		listValue = listValue.slice(2)
	}

	return `[${listValue}]`;
};

const convertSet = (property, level, value) => {
	const setValue = convertList(property, level, value);

	return `${setValue}.toSet()`;
};

const convertTimestamp = value => `new java.sql.Timestamp(${JSON.stringify(value)})`;

const convertDate = value => `new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSX").parse(${JSON.stringify(value)})`;

const convertUUID = value => `UUID.fromString(${JSON.stringify(value)})`;

const convertNumber = (property, value) => {
	const mode = property.mode;
	const numberValue = JSON.stringify(value);

	switch(mode) {
		case 'double':
			return `${numberValue}d`;
		case 'float':
			return `${numberValue}f`;
		case 'long':
			return `${numberValue}l`;
	}

	return numberValue;
};

const convertPropertyValue = (property, level, type, value) => {
	if (!isGraphSONType(type)) {
		return JSON.stringify(value);
	}

	switch(type) {
		case 'uuid':
			return convertUUID(value);
		case 'map':
			return convertMap(property, level, value);
		case 'set':
			return convertSet(property, level, value);
		case 'list':
			return convertList(property, level, value);
		case 'timestamp':
			return convertTimestamp(value);
		case 'date':
			return convertDate(value);
		case 'number':
			return convertNumber(property, value);
	}

	return convertMap(property, level, value);
};

const transformToValidGremlinName = name => {
	const DEFAULT_NAME = 'New vertex';
	const DEFAULT_PREFIX = 'v';

	if (!name || !_.isString(name)) {
		return DEFAULT_NAME;
	}

	const nameWithoutSpecialCharacters = name.replace(/[\f\t\n\v\r`~!@#%^&*_|+\-=?;:'",.<>\{\}\[\]\\\/]/gi, '_');
	const startsFromDigit = nameWithoutSpecialCharacters.match(/^[0-9].*$/);

	if (startsFromDigit) {
		return `${DEFAULT_PREFIX}_${nameWithoutSpecialCharacters}`;
	}

	return nameWithoutSpecialCharacters;
};

const generateIndex = indexData => `graph.createIndex("${indexData.propertyName}", ${indexData.elementType || 'Vertex'})`;

const generateIndexes = indexesData => {
	const correctIndexes = indexesData.filter(index => index.propertyName);
	const script = correctIndexes.map(generateIndex).join(';\n');

	if (!script) {
		return '';
	}

	return script + ';';
};

const mapError = (error) => {
	return {
		message: error.message,
		stack: error.stack
	};
};
