const _ = require('lodash');

const getChoices = item => {
	const availableChoices = ['oneOf', 'allOf', 'anyOf'];

	const choices = availableChoices.reduce((choices, choiceType) => {
		const choice = _.get(item, choiceType, []);
		if (_.isEmpty(choice)) {
			return choices;
		}

		return {
			...choices,
			[choiceType]: {
				choice: _.get(item, choiceType, []),
				meta: _.get(item, `${choiceType}_meta`, {}),
			},
		};
	}, {});

	if (_.isEmpty(choices)) {
		return [];
	}

	const choicePropertiesData = Object.keys(choices).map(choiceType => {
		const choiceData = choices[choiceType];
		const index = _.get(choiceData, 'meta.index');

		return {
			properties: _.first(choiceData.choice).properties || {},
			index,
		};
	});

	const sortedChoices = choicePropertiesData.toSorted((a, b) => a.index - b.index);

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
			index: choiceData.index + additionalPropertiesCount,
		};
	});
};

module.exports = {
	getChoices,
};
