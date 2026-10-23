import { buildEnv } from '../src/config';
import { ConnectionPool } from '../src/connection-pool';
import { describeError } from '../src/util';

const main = async () => {
    const env = await buildEnv();
    const connectionPool = ConnectionPool.build(env);
    const connectionPromises = connectionPool.connectionPool.map((connectionWrapper) =>
        connectionPool.getConnectionHealth(connectionWrapper.connection).then((data) => {
            if (data !== 'ok')
                console.log(
                    `${connectionPool.getConnectionDescription('getHealth', connectionWrapper)}: ${JSON.stringify(data, null, 2)}`,
                );
        }),
    );
    await Promise.all(connectionPromises);
};

main().catch((e) => console.error(describeError(e)));
