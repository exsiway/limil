// Local by default: nothing reaches a server of the user's until the
// autonomous switch is on. The pure rule and the two gates that consult it.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { autonomousOn, runnerExecutes } from '../src/shared/autonomy.js';

function fakeChrome(settings) {
  const bag = { settings };
  return {
    storage: {
      local: {
        async get(key) { return { [key]: structuredClone(bag[key]) }; },
        async set(obj) { Object.assign(bag, structuredClone(obj)); },
      },
    },
    permissions: { async contains() { return true; } },
  };
}

test('the rule: only an explicit true counts', () => {
  assert.equal(autonomousOn({ autonomousEnabled: true }), true);
  assert.equal(autonomousOn({ autonomousEnabled: 'true' }), false);
  assert.equal(autonomousOn({ autonomousEnabled: 1 }), false);
  assert.equal(autonomousOn({}), false);
  assert.equal(autonomousOn(undefined), false);
});

const paired = {
  daemonEnabled: true,
  daemon: { url: 'http://100.100.1.1:8788', sessionKey: '0x1111111111111111111111111111111111111111' },
  mirrorEnabled: true,
  mirror: { url: 'http://daemon:8787' },
};

test('the laptop stands down only for a hub that has a runner browser to execute', () => {
  const hub = { autonomousEnabled: true, daemonEnabled: true, daemon: { url: 'http://100.100.1.1:8787' } };
  assert.equal(runnerExecutes({ ...hub, daemon: { ...hub.daemon, sessionKey: null } }), false, 'a hub alone executes nothing');
  assert.equal(runnerExecutes({ ...hub, daemon: { ...hub.daemon, sessionKey: '0xrunner' } }), true);
  assert.equal(runnerExecutes({ ...hub, autonomousEnabled: false, daemon: { ...hub.daemon, sessionKey: '0xrunner' } }), false);
  assert.equal(runnerExecutes({ ...hub, daemonEnabled: false, daemon: { ...hub.daemon, sessionKey: '0xrunner' } }), false);
  assert.equal(runnerExecutes(undefined), false);
});

test('a paired and enabled hub is inactive while autonomous mode is off', async () => {
  globalThis.chrome = fakeChrome({ ...paired, autonomousEnabled: false });
  const { daemonActive, pair, sync, pull } = await import('../src/background/daemon.js');
  assert.equal(await daemonActive(), false);
  assert.deepEqual(await sync(), { skipped: true }, 'no order list leaves the browser');
  assert.equal(await pull(), null, 'the hub is not polled');
  await assert.rejects(pair({ pairing: 'http://100.100.1.1:8788#abcdefghijklmnop' }), /autonomous mode is off/);
  globalThis.chrome = fakeChrome({ ...paired, autonomousEnabled: true });
  assert.equal(await daemonActive(), true);
});

test('the runner browser stands down while autonomous mode is off', async () => {
  globalThis.chrome = fakeChrome({ ...paired, autonomousEnabled: false });
  const { mirrorActive, pair, pull } = await import('../src/background/mirror.js');
  assert.equal(await mirrorActive(), false);
  assert.equal(await pull(), null);
  await assert.rejects(pair({ pairing: 'http://daemon:8787#abcdefghijklmnop' }), /autonomous mode is off/);
  globalThis.chrome = fakeChrome({ ...paired, autonomousEnabled: true });
  assert.equal(await mirrorActive(), true);
});
