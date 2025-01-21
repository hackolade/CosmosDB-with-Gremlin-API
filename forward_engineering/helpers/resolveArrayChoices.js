const _ = require('lodash');

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

module.exports = {
	resolveArrayChoices,
};
