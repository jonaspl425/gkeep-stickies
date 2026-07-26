const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function resolvePythonPath(projectRoot) {
  const localPython = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(localPython)) {
    return localPython;
  }

  return process.env.STICKY_NOTES_PYTHON || 'python';
}

function createKeepBridgeManager({ projectRoot, scriptPath, requestTimeoutMs = 45000 }) {
  let processRef = null;
  let stdoutBuffer = '';
  const pending = new Map();

  function rejectAll(error) {
    for (const { reject, timeout } of pending.values()) {
      clearTimeout(timeout);
      reject(error);
    }
    pending.clear();
  }

  function handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (_error) {
      return;
    }

    const request = pending.get(message.id);
    if (!request) {
      return;
    }

    clearTimeout(request.timeout);
    pending.delete(message.id);

    if (message.ok) {
      request.resolve(message.result);
      return;
    }

    const error = new Error(message.error?.message || 'Google Keep bridge request failed.');
    error.code = message.error?.code || 'BRIDGE_ERROR';
    error.retryable = Boolean(message.error?.retryable);
    request.reject(error);
  }

  function ensureStarted() {
    if (processRef && !processRef.killed) {
      return processRef;
    }

    const pythonPath = resolvePythonPath(projectRoot);
    processRef = spawn(pythonPath, [scriptPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PYTHONPATH: [
          path.join(projectRoot, '.python-packages'),
          process.env.PYTHONPATH || ''
        ].filter(Boolean).join(path.delimiter)
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    processRef.stdout.setEncoding('utf8');
    processRef.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      lines.forEach(handleLine);
    });

    processRef.once('error', (error) => {
      rejectAll(error);
      processRef = null;
    });

    processRef.once('exit', (code) => {
      rejectAll(new Error(`Google Keep bridge exited with code ${code ?? 'unknown'}.`));
      processRef = null;
      stdoutBuffer = '';
    });

    return processRef;
  }

  async function request(method, params = {}, timeoutMs = requestTimeoutMs) {
    const bridge = ensureStarted();
    const id = randomUUID();
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Google Keep bridge timed out during ${method}.`));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timeout });
      bridge.stdin.write(`${payload}\n`, 'utf8', (error) => {
        if (error) {
          clearTimeout(timeout);
          pending.delete(id);
          reject(error);
        }
      });
    });
  }

  function stop() {
    if (processRef && !processRef.killed) {
      processRef.kill();
    }
    processRef = null;
    stdoutBuffer = '';
    rejectAll(new Error('Google Keep bridge stopped.'));
  }

  return {
    request,
    stop
  };
}

module.exports = {
  createKeepBridgeManager
};
