const _ = require('lodash');
const { CosmosClient } = require('../reverse_engineering/node_modules/@azure/cosmos');
const gremlin = require('../reverse_engineering/node_modules/gremlin');


const applyToInstanceHelper = {
	setUpDocumentClient(connectionInfo) {
		const dbNameRegExp = /wss:\/\/(\S*).gremlin\.cosmos\./i;
		const dbName = dbNameRegExp.exec(connectionInfo.gremlinEndpoint)[1];
		const endpoint = `https://${dbName}.documents.azure.com:443/`;
		const key = connectionInfo.accountKey;
	
		return new CosmosClient({ endpoint, key });
	},

	async getGremlinClient(connectionInfo, databaseId, collection) {
		const traversalSource = 'g';
		
		const authenticator = new gremlin.driver.auth.PlainTextSaslAuthenticator(
			`/dbs/${databaseId}/colls/${collection}`,
			connectionInfo.accountKey
		);
		
		const client = new gremlin.driver.Client(connectionInfo.gremlinEndpoint, {
			authenticator,
			traversalSource,
			rejectUnauthorized : true,
			mimeType : 'application/vnd.gremlin-v2.0+json',
		});

		await client.open();
		return client;
	},

	runGremlinQueries(gremlinClient, queries) {
		return Promise.all(queries.map(query => {
			return gremlinClient.submit(query);
		}));
	},

	testConnection(client) {
		return this.getDatabases(client);
	},

	async getDatabases(client) {
		const dbResponse = await client.databases.readAll().fetchAll();
		return dbResponse.resources;
	
	},

	async getContainers(databaseId, client) {
		const { resources: containers } = await client.database(databaseId).containers.readAll().fetchAll();
		return containers;
	},

	parseScriptStatements(script) {
		const scriptStatements = script.split('\n\n').map(item => item.replace(/\.\s+/g, '.'));
		const [labels, edges] = _.partition(scriptStatements, statement => statement.startsWith('g.addV'));

		return { labels, edges };
	},

	mapStoredProcs(storedPropcs) {
		return storedPropcs.map(proc => {
			return {
				id: proc.storedProcID,
				body: proc.storedProcFunction,
			};
		});
	},

	createStoredProcs(storedProcs, containerInstance) {
		return Promise.all(this.mapStoredProcs(storedProcs).map(proc => {
			return containerInstance.scripts.storedProcedures.create(proc);
		}));
	},

	mapUDFs(udfs) {
		return udfs.map(udf => {
			return {
				id: udf.udfID,
				body: udf.udfFunction,
			};
		});
	},

	createUDFs(udfs, containerInstance) {
		return Promise.all(this.mapUDFs(udfs).map(udf => {
			return containerInstance.scripts.userDefinedFunctions.create(udf);
		}));
	},

	mapTriggers(triggers) {
		return triggers.map(trigger => {
			return {
				id: trigger.triggerID,
				body: trigger.triggerFunction,
				triggerOperation: trigger.triggerOperation,
				triggerType: trigger.prePostTrigger === 'Pre-Trigger' ? 'Pre' : 'Post'
			};
		});
	},

	createTriggers(triggers, containerInstance) {
		return Promise.all(this.mapTriggers(triggers).map(trigger => {
			return containerInstance.scripts.triggers.create(trigger);
		}));
	},

	getTTL(containerData) {
		switch (containerData.TTL) {
			case 'On (no default)':
				return -1;
			case 'On':
				return _.parseInt(TTLseconds) || 0;
			default:
				return -1;
		}
	},
};

module.exports = applyToInstanceHelper;