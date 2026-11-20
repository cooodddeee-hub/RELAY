# Phase 1 MongoDB Integration Tests

## Availability checked

The current development environment has no `mongod`, Docker, or Podman executable, no `mongodb-memory-server` package, and no `RELAY_TEST_MONGODB_URI` configured. A transaction-capable MongoDB instance was therefore not available for this run. The integration test was added but cannot exercise a live MongoDB server here.

## Safety contract

`server/test/handoverVersion.mongo.test.js` reads only `RELAY_TEST_MONGODB_URI`; it does not use the application's `MONGODB_URI`. Before connecting, it rejects non-local hosts and database names that do not end in `_test` or `-test`. After connecting, it verifies the MongoDB server is an elected member of a replica set. It creates uniquely named test projects, then deletes only handovers and projects matching the IDs it created. It never drops a database or runs the handover index migration.

If the test URI is unset, Node reports the integration test as skipped. If it points at a shared/production host or a non-test database name, the test fails before opening a connection.

## Safe local setup

Use an isolated local MongoDB Community Server with `mongod` and `mongosh` available. Do not point this test at Atlas, a shared development cluster, or production. Example for a disposable local replica set, in one terminal:

```sh
ROUND3_MONGO_TEST_DIR="$(mktemp -d)"
mongod --replSet rs0 --port 27018 --bind_ip 127.0.0.1 --dbpath "$ROUND3_MONGO_TEST_DIR"
```

In a second terminal, initialize the single-node replica set and run only the integration test:

```sh
mongosh --host 127.0.0.1 --port 27018 --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27018"}]})'
cd server
export RELAY_TEST_MONGODB_URI='mongodb://127.0.0.1:27018/relay_round3_test?replicaSet=rs0'
npm test -- test/handoverVersion.mongo.test.js
```

The database name is deliberately `relay_round3_test`. The test initializes the Mongoose model indexes in that local test database; it does not invoke the production migration script. Stop `mongod` and remove only the temporary directory created for this test after the run.

## Scenarios covered

- Concurrent atomic allocations return distinct sequential versions and persist successfully under the unique `{ project, version }` index.
- The compound index rejects a duplicate version for the same project.
- A legacy project with saved handovers and no counter allocates above the highest saved version.
- A duplicate-key save failure does not cause the reserved version to be reused; gaps are permitted by the Phase 1 allocator contract.
