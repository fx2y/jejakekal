import { DBOS } from '@dbos-inc/dbos-sdk';
import { registerDbosWorkflows } from './dbos-workflows.mjs';

let startPromise = null;

function getSystemDatabaseUrl() {
  const url = process.env.DBOS_SYSTEM_DATABASE_URL;
  if (!url) {
    throw new Error('DBOS_SYSTEM_DATABASE_URL is required');
  }
  return url;
}

export async function ensureDbosRuntime() {
  if (DBOS.isInitialized()) {
    return;
  }
  if (startPromise) {
    await startPromise;
    return;
  }

  startPromise = (async () => {
    registerDbosWorkflows();
    DBOS.setConfig({
      name: 'jejakekal-kernel',
      systemDatabaseUrl: getSystemDatabaseUrl(),
      runAdminServer: false
    });
    if (typeof DBOS.logRegisteredEndpoints === 'function') {
      DBOS.logRegisteredEndpoints();
    }
    await DBOS.launch();
  })();

  try {
    await startPromise;
  } finally {
    startPromise = null;
  }
}

export async function shutdownDbosRuntime() {
  if (!DBOS.isInitialized()) {
    return;
  }
  await DBOS.shutdown();
}
