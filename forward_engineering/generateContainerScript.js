const _ = require('lodash');
const getIndexPolicyScript = require('./getIndexPolicyScript');
const scriptHelper = require('./scriptHelper');
const { addPropertiesScript } = require('./helpers/addPropertiesScript');
const { DEFAULT_INDENT } = require('./config/constants');
const { getPartitionKey } = require('./helpers/getPartitionKey');

let graphName = 'g';

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
			return script + `graph.variables().set("${key}", "${value}");\n`;
		}
	}, '');
};

const generateIndex = indexData =>
	`graph.createIndex("${indexData.propertyName}", ${indexData.elementType || 'Vertex'})`;

const generateIndexes = indexesData => {
	const correctIndexes = indexesData.filter(index => index.propertyName);
	const script = correctIndexes.map(generateIndex).join(';\n');

	if (!script) {
		return '';
	}

	return script + ';';
};

const generateEdge = (from, to, relationship, edgeData) => {
	const edgeName = transformToValidGremlinName(relationship.name);
	const propertiesScript = addPropertiesScript(relationship, edgeData);

	return `${from}.addE(${JSON.stringify(edgeName)}).\n${DEFAULT_INDENT}to(${to})${propertiesScript}`;
};

const getVertexVariableScript = vertexName => `${graphName}.V().hasLabel(${JSON.stringify(vertexName)})`;

const generateVertex = (collection, vertexData) => {
	const vertexName = transformToValidGremlinName(collection.collectionName);
	const propertiesScript = addPropertiesScript(collection, vertexData);

	return `${graphName}.addV(${JSON.stringify(vertexName)})${propertiesScript}`;
};

const generateVertices = (collections, jsonData) => {
	const vertices = collections.map(collection => {
		const vertexData = JSON.parse(jsonData[collection.GUID]);

		return generateVertex(collection, vertexData);
	});

	const script = vertices.join(';\n\n');
	if (!script) {
		return '';
	}

	return script + ';';
};

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

		return edges.concat(
			generateEdge(getVertexVariableScript(from), getVertexVariableScript(to), relationship, edgeData),
		);
	}, []);

	if (_.isEmpty(edges)) {
		return '';
	}

	return edges.join(';\n\n') + ';';
};

const getGremlinScript = data => {
	let { collections, relationships, jsonData, containerData, options } = data;
	let resultScript = '';
	const traversalSource = _.get(containerData, [0, 'traversalSource'], 'g');
	graphName = transformToValidGremlinName(traversalSource);
	collections = collections.map(JSON.parse);
	relationships = relationships.map(JSON.parse);
	const indexesData = _.get(containerData, [1, 'indexes'], []);

	const variables = _.get(containerData, [0, 'graphVariables'], []);
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

const getCosmosDbScript = containerData => {
	const partitionKey = getPartitionKey(containerData);

	const getContainerConfig = () => {
		const baseConfig = {
			indexingPolicy: getIndexPolicyScript(containerData),
			...scriptHelper.addItems(containerData),
		};
		if (partitionKey) {
			return {
				partitionKey,
				...baseConfig,
			};
		}
		return baseConfig;
	};
	return JSON.stringify(getContainerConfig(), null, 2);
};

const generateContainerScript = (data, logger, cb, app) => {
	logger.clear();
	try {
		const scriptId = _.get(data, 'options.targetScriptOptions.keyword');

		if (data.options.origin === 'ui') {
			cb(null, [
				{
					script: getGremlinScript(data),
				},
				{
					script: getCosmosDbScript(data.containerData),
				},
			]);
		} else if (scriptId === 'cosmosdb') {
			cb(null, getCosmosDbScript(data.containerData));
		} else {
			cb(null, getGremlinScript(data));
		}
	} catch (e) {
		logger.log('error', { message: e.message, stack: e.stack }, 'Forward-Engineering Error');
		setTimeout(() => {
			cb({ message: e.message, stack: e.stack });
		}, 150);
	}
};

module.exports = {
	generateContainerScript,
};
