const _ = require('lodash');
const { getChoices } = require('./getChoices');
const { resolveChoices } = require('./resolveChoices');
const { DEFAULT_INDENT } = require('../config/constants');
const { resolveArrayChoices } = require('./resolveArrayChoices');

const isGraphSONType = type => ['map', 'set', 'list', 'timestamp', 'date', 'uuid', 'number'].includes(type);

const convertMap = (property, level, value) => {
	const choices = getChoices(property);
	const properties = resolveChoices(choices, _.get(property, 'properties', {}));

	const childProperties = Object.keys(properties).map(name => ({
		name,
		property: properties[name],
	}));
	const indent = _.range(0, level).reduce(indent => indent + DEFAULT_INDENT, '');
	const previousIndent = _.range(0, level - 1).reduce(indent => indent + DEFAULT_INDENT, '');

	let mapValue = childProperties.reduce((result, { name, property }) => {
		const childValue = value[name];
		const type = property.childType || property.type;

		return (
			result +
			`, \n${indent}${JSON.stringify(name)}: ${convertPropertyValue(property, level + 1, type, childValue)}`
		);
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
		listValue = listValue.slice(2);
	}

	return `[${listValue}]`;
};

const convertSet = (property, level, value) => {
	const setValue = convertList(property, level, value);

	return `${setValue}.toSet()`;
};

const convertTimestamp = value => `new java.sql.Timestamp(${JSON.stringify(value)})`;

const convertDate = value =>
	`new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSX").parse(${JSON.stringify(value)})`;

const convertUUID = value => `UUID.fromString(${JSON.stringify(value)})`;

const convertNumber = (property, value) => {
	const mode = property.mode;
	const numberValue = JSON.stringify(value);

	switch (mode) {
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

	switch (type) {
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

module.exports = {
	convertPropertyValue,
};
