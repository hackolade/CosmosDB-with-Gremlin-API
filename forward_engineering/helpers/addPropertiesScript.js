const _ = require('lodash');
const { convertPropertyValue } = require('./convertPropertyValue');
const { handleMetaProperties } = require('./handleMetaProperties');
const { getChoices } = require('./getChoices');
const { getListValues } = require('./getListValues');
const { resolveChoices } = require('./resolveChoices');
const { DEFAULT_INDENT } = require('../config/constants');

const getPropertyStatement = (name, propCardinality, valueScript, metaPropertiesScript) => {
	const cardinality = propCardinality === 'single' ? '' : propCardinality + ', ';
	return `.\n${DEFAULT_INDENT}property(${cardinality}${JSON.stringify(name)}, ${valueScript}${metaPropertiesScript})`;
};

const handleMultiProperty = (property, name, jsonData) => {
	let properties = _.get(property, 'items', []);
	if (!_.isArray(properties)) {
		properties = [properties];
	}
	if (properties.length === 1) {
		properties = [...properties, ...properties];
		jsonData.push(_.first(jsonData));
	}

	const type = property.childType || property.type;
	const nameString = JSON.stringify(name);
	const propertiesValues = properties.map((property, index) =>
		convertPropertyValue(property, 2, type, jsonData[index]),
	);
	const metaProperties = properties.map(property => {
		const metaPropertiesScript = handleMetaProperties(property.metaProperties);
		if (_.isEmpty(metaPropertiesScript)) {
			return '';
		}

		return ', ' + metaPropertiesScript;
	});

	return propertiesValues.reduce(
		(script, valueScript, index) =>
			`${script}.\n${DEFAULT_INDENT}property(single, ${nameString}, ${valueScript}${metaProperties[index]})`,
		'',
	);
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

module.exports = {
	addPropertiesScript,
};
