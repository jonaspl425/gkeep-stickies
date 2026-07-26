const fs = require('fs');
const path = require('path');

function createCredentialStore(app, safeStorage) {
  const credentialsPath = path.join(app.getPath('userData'), 'keep-credentials.json');

  function ensureDir() {
    fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  }

  function encrypt(value) {
    if (!safeStorage?.isEncryptionAvailable()) {
      throw new Error('Encrypted credential storage is not available on this system.');
    }

    return {
      mode: 'safeStorage',
      value: safeStorage.encryptString(value).toString('base64')
    };
  }

  function decrypt(payload) {
    if (!payload || payload.mode !== 'safeStorage' || typeof payload.value !== 'string') {
      throw new Error('Stored Google Keep credential is invalid.');
    }

    if (!safeStorage?.isEncryptionAvailable()) {
      throw new Error('Encrypted credential storage is not available on this system.');
    }

    return safeStorage.decryptString(Buffer.from(payload.value, 'base64'));
  }

  function save({ email, masterToken, settings = {} }) {
    ensureDir();
    const record = {
      email,
      masterToken: encrypt(masterToken),
      settings,
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(credentialsPath, JSON.stringify(record, null, 2), 'utf8');
    return { email, settings, savedAt: record.savedAt };
  }

  function load() {
    if (!fs.existsSync(credentialsPath)) {
      return null;
    }

    const record = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    return {
      email: record.email,
      masterToken: decrypt(record.masterToken),
      settings: record.settings || {},
      savedAt: record.savedAt || null
    };
  }

  function getStatus() {
    if (!fs.existsSync(credentialsPath)) {
      return null;
    }

    const record = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    return {
      email: record.email,
      settings: record.settings || {},
      savedAt: record.savedAt || null
    };
  }

  function clear() {
    if (fs.existsSync(credentialsPath)) {
      fs.unlinkSync(credentialsPath);
    }
  }

  return {
    save,
    load,
    getStatus,
    clear
  };
}

module.exports = {
  createCredentialStore
};
