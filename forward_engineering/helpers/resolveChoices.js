const _ = require('lodash');

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

		if (_.isUndefined(choicePropertiesIndex) || Object.keys(sortedProperties).length <= choicePropertiesIndex) {
			return { ...sortedProperties, ...choiceProperties };
		}

		return Object.keys(sortedProperties).reduce((result, propertyKey, index) => {
			if (index !== choicePropertiesIndex) {
				return { ...result, [propertyKey]: sortedProperties[propertyKey] };
			}

			return { ...result, ...choiceProperties, [propertyKey]: sortedProperties[propertyKey] };
		}, {});
	}, properties || {});
};

module.exports = {
	resolveChoices,
};
