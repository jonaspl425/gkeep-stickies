const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('preload exposes live window drag methods for detached note windows', () => {
  const exposures = {};
  const context = {
    require: (name) => {
      if (name === 'electron') {
        return {
          contextBridge: {
            exposeInMainWorld: (name, api) => {
              exposures[name] = api;
            }
          },
          ipcRenderer: {
            invoke: () => Promise.resolve({}),
            on: () => {}
          }
        };
      }

      throw new Error(`Unexpected module: ${name}`);
    }
  };

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8'),
    context,
    { filename: path.join(__dirname, '..', 'src', 'preload.js') }
  );

  assert.equal(typeof exposures.electronAPI?.startWindowDragLive, 'function');
  assert.equal(typeof exposures.electronAPI?.moveWindowLive, 'function');
  assert.equal(typeof exposures.electronAPI?.stopWindowDragLive, 'function');
});
