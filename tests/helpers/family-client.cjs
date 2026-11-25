'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const root = path.resolve(__dirname, '../..');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

// Only the device and transport are simulated: store, sync, validators and
// server handlers all execute their production implementation.
function createFamilyClient({environment, actor, env, now}) {
  const storage = new Map(), localFiles = new Map(), modules = new Map(), requests = [], timers = new Map();
  let serial = 0;
  const config = {env, functionName: 'babyBitesSync', socialEnabled: false};
  const dispatch = (options, operation) => Promise.resolve().then(operation).then(options.success, options.fail);
  const readLocal = filename => {
    if (!localFiles.has(filename)) throw Error('Missing device file: ' + filename);
    return localFiles.get(filename);
  };
  const download = fileID => {
    if (!environment.files.has(fileID)) throw Error('Missing cloud file: ' + fileID);
    const tempFilePath = 'wxfile://usr/download-' + ++serial;
    localFiles.set(tempFilePath, Buffer.from(environment.files.get(fileID)));
    return {tempFilePath, statusCode: 200};
  };
  const manager = {
    writeFile(options) { dispatch(options, () => {localFiles.set(options.filePath, Buffer.from(options.data)); return {};}); },
    readFile(options) { dispatch(options, () => ({data: options.encoding === 'utf8' ? readLocal(options.filePath).toString() : readLocal(options.filePath)})); },
    getFileInfo(options) { dispatch(options, () => ({size: readLocal(options.filePath).length})); },
    unlink(options) { dispatch(options, () => {localFiles.delete(options.filePath); return {};}); }
  };
  const wx = {
    env: {USER_DATA_PATH: 'wxfile://usr'},
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync(key, value) { storage.set(key, clone(value)); },
    getStorageInfoSync: () => ({keys: [...storage.keys()]}),
    getFileSystemManager: () => manager,
    downloadFile(options) { dispatch(options, () => download(decodeURIComponent(options.url.slice('https://signed.test/'.length)))); },
    cloud: {
      init() {},
      callFunction(options) { dispatch(options, async () => {
        const request = {name: options.name, data: clone(options.data)};
        requests.push(request);
        const handler = options.name === 'babyBitesSocial' ? environment.social(actor) : environment.api(actor);
        const result = await handler(options.data);
        request.result = clone(result);
        return {result};
      }); },
      uploadFile(options) { dispatch(options, () => {
        const fileID = `cloud://${env}.bucket-test/${options.cloudPath}`;
        environment.files.set(fileID, Buffer.from(readLocal(options.filePath)));
        return {fileID};
      }); },
      downloadFile(options) { dispatch(options, () => download(options.fileID)); }
    }
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now()])); }
    static now() { return now(); }
  }
  function load(filename) {
    if (filename === path.join(root, 'config/cloud.js')) return config;
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = {exports: {}};
    modules.set(filename, module);
    const nativeRequire = createRequire(filename);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, wx, console, Date: ClockDate, ArrayBuffer, Uint8Array,
      require(name) {
        const target = nativeRequire.resolve(name);
        return target.startsWith(root + path.sep) ? load(target) : nativeRequire(name);
      },
      setTimeout(callback) { const id = ++serial; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); }
    }, {filename});
    return module.exports;
  }
  return {store: load(path.join(root, 'utils/store.js')), sync: load(path.join(root, 'utils/cloud-sync.js')),
    storage, requests, localFiles};
}

module.exports = {createFamilyClient};
