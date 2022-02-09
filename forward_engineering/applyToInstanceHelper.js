const { CosmosClient, StoredProcedure, UserDefinedFunction, Trigger } = require('../reverse_engineering/node_modules/@azure/cosmos');
const gremlin = require('../reverse_engineering/node_modules/gremlin');


const applyToInstanceHelper = _ => ({
	setUpDocumentClient(connectionInfo) {
		const dbNameRegExp = /wss:\/\/(\S*).gremlin\.cosmos\./i;
		const dbName = dbNameRegExp.exec(connectionInfo.gremlinEndpoint);
		if(!dbName || !dbName[1]) {
			throw new Error('Incorrect endpoint provided. Expected format: wss://<account name>.gremlin.cosmos.');
		}
		const endpoint = `https://${dbName[1]}.documents.azure.com:443/`;
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

	mapUDFs(udfs) {
		return udfs.map(udf => {
			return {
				id: udf.udfID,
				body: udf.udfFunction,
			};
		});
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

	createStoredProcs(storedProcs, containerInstance) {
		return storedProcs.reduce(async (next, proc) => {
			await next;

			try {
				return await containerInstance.scripts.storedProcedures.create(proc);
			} catch (error) {
				if (error.code !== 409) {
					throw error;
				}
				const result = new StoredProcedure(containerInstance, proc.id, containerInstance.clientContext);

				return await result.replace(proc);
			}
		}, Promise.resolve());
	},

	createUDFs(udfs, containerInstance) {
		return udfs.reduce(async (next, udf) => {
			await next;

			try {
				return await containerInstance.scripts.userDefinedFunctions.create(udf);
			} catch (error) {
				if (error.code !== 409) {
					throw error;
				}
				const result = new UserDefinedFunction(containerInstance, udf.id, containerInstance.clientContext);

				return await result.replace(udf);
			}
		}, Promise.resolve());
	},

	createTriggers(triggers, containerInstance) {
		return triggers.reduce(async (next, trigger) => {
			await next;

			try {
				return await containerInstance.scripts.triggers.create(trigger);
			} catch (error) {
				if (error.code !== 409) {
					throw error;
				}
				const result = new Trigger(containerInstance, trigger.id, containerInstance.clientContext);

				return await result.replace(trigger);
			}
		}, Promise.resolve());
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

	getContainerThroughputProps(containerProps) {
		if (containerProps.capacityMode === "Serverless") {
			return {};
		}
		if (containerProps.autopilot) {
			return { maxThroughput: containerProps.throughput || 4000 };
		}
		return { throughput: containerProps.throughput || 400 };
	}
});

module.exports = applyToInstanceHelper;