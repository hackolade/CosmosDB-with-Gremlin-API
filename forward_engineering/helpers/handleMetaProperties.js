const _ = require('lodash');

const getDefaultMetaPropertyValue = type => {
	switch (type) {
		case 'map':
		case 'list':
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
	if (!metaProperties) {
		return '';
	}

	const metaPropertiesFlatList = metaProperties.reduce((list, property) => {
		if (!property.metaPropName) {
			return list;
		}

		const sample = _.isUndefined(property.metaPropSample)
			? getDefaultMetaPropertyValue(property.metaPropType)
			: property.metaPropSample;

		return list.concat(JSON.stringify(property.metaPropName), sample);
	}, []);

	return metaPropertiesFlatList.join(', ');
};

module.exports = {
	handleMetaProperties,
};
