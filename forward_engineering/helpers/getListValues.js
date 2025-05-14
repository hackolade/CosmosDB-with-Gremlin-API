const _ = require('lodash');
const { getChoices } = require('./getChoices');
const { convertPropertyValue } = require('./convertPropertyValue');
const { resolveArrayChoices } = require('./resolveArrayChoices');

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

module.exports = {
	getListValues,
};
