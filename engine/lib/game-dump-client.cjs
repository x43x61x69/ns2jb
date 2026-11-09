'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {fileSize} = require('./game-dump.cjs');
const check = (ok, message) => {if (!ok) throw Error(message);};
const resultCode = (label, reply) => {
  check(reply && Number.isInteger(reply.result) && reply.result >= 0 && reply.result <= 0xffffffff,
    label + ' returned an invalid result');
  const code = reply.result & 0x3fffff;
  check(reply.result === 0 || code !== 0, label + ' returned an invalid success result');
  return code;
};
const resultError = (label, reply) => {
  resultCode(label, reply);
  check(reply.result === 0, label + ' failed: 0x' + (reply.result & 0x3fffff).toString(16));
};
const STORAGES = [{id: 4, name: 'BuiltInUser'}, {id: 5, name: 'SdCard'},
  {id: 2, name: 'GameCard'}, {id: 3, name: 'BuiltInSystem'}];
// NCM module 5: ContentMetaNotFound=7, per-storage database inactive=261..264.
// https://github.com/Atmosphere-NX/Atmosphere/blob/master/libraries/libvapours/include/vapours/results/ncm_results.hpp
const ncmResult = description => description * 512 + 5;

// Wire layouts follow libnx fs.c (command 9) and fsldr.c (20.0.0+ command 0):
// https://github.com/switchbrew/libnx/tree/master/nx/source/services
function codeInput(title, storage, attributes) {
  const input = Buffer.alloc(16);
  input[0] = attributes; input[1] = storage;
  input.writeBigUInt64LE(BigInt('0x' + title), 8);
  return input;
}

function createClient({Session, filesystem, domain, request, acquisition, root, loader,
  storage = 'auto', attributes = 1, title, note = () => {}}) {
  let s, uncertain = false, nativeInfo;
  const mounts = new Map();
  const exports = new Set();
  const native = async action => {
    check(!uncertain, 'Native result is uncertain; further requests are blocked');
    try {return await action();}
    catch (error) {uncertain = true; throw error;}
  };
  const closeHandle = async handle => {
    if (!uncertain && s?.handles.has(handle)) await native(() => s.close(handle));
  };
  const ownedHandle = reply => {
    resultError('Open filesystem', reply);
    const handle = domain.oneHandle(reply);
    check(Number.isInteger(handle) && handle > 0 && s.handles.has(handle), 'Filesystem handle is not owned');
    return handle;
  };
  const getSize = async handle => {
    const reply = await native(() => s.ipc('Game dump FileGetSize', handle, 4));
    resultError('FileGetSize', reply);
    return fileSize(reply.data.readBigUInt64LE());
  };
  const closeExport = async handle => {
    if (!uncertain && exports.has(handle)) {
      await native(async () => {
        const reply = await request(acquisition.socketPath, {command: 'root-native-close-handle', handle});
        check(reply.closed === handle, 'NCM exported handle did not close');
      });
      exports.delete(handle);
    }
  };
  async function detectStorage() {
    const sm = nativeInfo.services?.find(item => item.name === 'pm:shell')?.sm;
    check(Number.isInteger(sm) && sm > 0, 'NCM discovery requires the retained SM client; specify --storage to override');
    const lookup = await native(() => request(acquisition.socketPath,
      {command: 'root-native-sm-service', handle: sm, name: 'ncm'}));
    check(lookup.transport === 0 && lookup.result === 0 && lookup.moves?.length === 1 &&
      Number.isInteger(lookup.moves[0]) && lookup.moves[0] > 0, 'NCM lookup failed; specify --storage to override');
    const ncm = lookup.moves[0]; exports.add(ncm);
    const probes = [], candidates = [];
    try {
      for (const location of STORAGES) {
        const opened = await native(() => s.ipc('Game dump NCM OpenContentMetaDatabase', ncm, 5, Buffer.from([location.id])));
        if (resultCode('NCM database ' + location.name, opened) === ncmResult(location.id + 259)) {
          probes.push({...location, status: 'database-inactive'}); continue;
        }
        resultError('NCM database ' + location.name, opened);
        const database = ownedHandle(opened);
        try {
          const input = Buffer.alloc(8); input.writeBigUInt64LE(BigInt('0x' + title));
          const reply = await native(() => s.ipc('Game dump NCM GetLatestContentMetaKey', database, 6, input));
          if (resultCode('NCM metadata ' + location.name, reply) === ncmResult(7)) {
            probes.push({...location, status: 'title-not-found'}); continue;
          }
          resultError('NCM metadata ' + location.name, reply);
          check(reply.data.length >= 16 && reply.data.readBigUInt64LE() === BigInt('0x' + title),
            'NCM returned a short or mismatched content-meta key');
          const key = {id: title, version: reply.data.readUInt32LE(8), type: reply.data[12], installType: reply.data[13]};
          const executable = [1, 0x80].includes(key.type) && key.installType === 0;
          const probe = {...location, status: executable ? 'found' : 'not-a-full-program', key};
          probes.push(probe);
          if (executable) candidates.push(probe);
        } finally {await closeHandle(database);}
      }
    } finally {await closeExport(ncm);}
    check(candidates.length, 'NCM found no complete program for ' + title + '; check the Title ID/media or specify --storage');
    check(candidates.length === 1, 'Multiple ExeFS storage candidates: ' + candidates.map(c => c.id + ':' + c.name + ':v' + c.key.version).join(', ') + '; specify --storage to select one');
    const selected = candidates[0];
    note('ExeFS: NCM selected ' + selected.name + ' (' + selected.id + '), metadata version ' + selected.key.version);
    return {storage: selected.id, selection: 'ncm', probes, key: selected.key};
  }

  return {
    session: acquisition.session,
    async initialize() {
      const state = await request(acquisition.socketPath, {command: 'root-info'});
      check(state.session === acquisition.session && state.initialized && state.clones?.includes(root.rootHandle),
        'The promoted root is no longer retained in this session');
      const info = await request(acquisition.socketPath, {command: 'root-native-info'});
      check(info.session === acquisition.session && info.worker?.joined,
        'The held native worker is not idle');
      if (loader) check(info.domainCopies?.some(item => item.handle === loader.copy.handle),
        'The verified Loader root is no longer retained');
      nativeInfo = info;
      s = new Session('game-dump-' + Date.now() + '-' + process.pid, 0x80000);
      // The dump journal records progress; avoid a per-RPC log for gigabytes of data.
      s.record = async () => {};
      await native(() => s.initialize());
    },
    async open(part) {
      check(s?.base && !mounts.has(part), 'Dump session is not initialized or part is already open');
      const discovery = part === 'exefs' && storage === 'auto' ? await detectStorage() : null;
      const borrowed = part === 'exefs' ? loader?.copy.handle : root.rootHandle;
      check(Number.isInteger(borrowed) && borrowed > 0, 'Required filesystem root proof is missing');
      // Own an additional root reference; never close or alter the held root.
      const copy = await native(() => domain.send(s, 'Game dump clone root', borrowed, domain.wire.control(2)));
      const ownRoot = ownedHandle(copy);
      let opened, metadata;
      if (part === 'exefs') {
        const output = s.base + 0x4000, infoSize = 0x1a4, guard = Buffer.alloc(32, 0x5c);
        await native(() => s.write(output - 32, Buffer.concat([guard, Buffer.alloc(infoSize), guard])));
        opened = await native(() => s.ipc('Game dump OpenCodeFileSystem', ownRoot, 0,
          codeInput(title, discovery?.storage ?? storage, attributes), {receive: [{address: output, size: infoSize, mode: 0}]}));
        resultError('OpenCodeFileSystem', opened);
        const info = await native(() => s.readOwned(output - 32, infoSize + 64));
        check(info.subarray(0, 32).equals(guard) && info.subarray(-32).equals(guard), 'Code-info output exceeded its buffer');
        metadata = {method: 'Loader.OpenCodeFileSystem', storage: discovery?.storage ?? storage, attributes,
          storageSelection: discovery?.selection || 'manual', ...(discovery ? {storageDiscovery: discovery} : {}),
          codeInfoHex: info.subarray(32, 32 + infoSize).toString('hex')};
      } else {
        check(part === 'romfs', 'Unknown filesystem selection');
        const input = Buffer.alloc(8); input.writeBigUInt64LE(BigInt('0x' + title));
        opened = await native(() => s.ipc('Game dump OpenDataFileSystemByProgramId', ownRoot, 9, input));
        resultError('OpenDataFileSystemByProgramId', opened);
        metadata = {method: 'FSP.OpenDataFileSystemByProgramId',
          resolution: 'OS-selected program content; no explicit NCA version selection'};
      }
      mounts.set(part, {handle: ownedHandle(opened), root: ownRoot});
      return metadata;
    },
    async *listDirectory(part, filename) {
      const mount = mounts.get(part);
      check(mount, 'Filesystem is not open');
      const input = Buffer.alloc(4); input.writeUInt32LE(3); // files + directories
      const opened = await native(() => filesystem.pathMethod(s, mount.handle, 9, filename, input));
      resultError('OpenDirectory ' + filename, opened);
      const handle = ownedHandle(opened);
      try {
        for (;;) {
          const reply = await native(() => s.ipc('Game dump ReadDirectory', handle, 0, Buffer.alloc(0),
            {receive: [{address: s.base + 0x6000, size: 4 * 0x310, mode: 0}]}));
          resultError('ReadDirectory', reply);
          const count = Number(reply.data.readBigUInt64LE());
          check(Number.isInteger(count) && count >= 0 && count <= 4, 'Invalid directory entry count');
          if (!count) return;
          const bytes = await native(() => s.readOwned(s.base + 0x6000, count * 0x310));
          for (let i = 0; i < count; i++) {
            const entry = bytes.subarray(i * 0x310, (i + 1) * 0x310);
            const nameBytes = entry.subarray(0, 0x301), end = nameBytes.indexOf(0);
            check(end > 0, 'Directory name is empty or not terminated');
            const name = nameBytes.subarray(0, end).toString('utf8');
            check(Buffer.from(name, 'utf8').equals(nameBytes.subarray(0, end)), 'Directory name is not valid UTF-8');
            yield {name, type: entry[0x304], size: entry.readBigUInt64LE(0x308).toString()};
          }
        }
      } finally {await closeHandle(handle);}
    },
    async openFile(part, filename) {
      const mount = mounts.get(part);
      check(mount, 'Filesystem is not open');
      const opened = await native(() => filesystem.openFile(s, mount.handle, filename));
      resultError('OpenFile ' + filename, opened);
      check(s.handles.has(opened.handle), 'File handle is not owned');
      return {handle: opened.handle, size: await getSize(opened.handle)};
    },
    readFile(handle, offset, length) {
      check(s?.handles.has(handle), 'File handle is not owned');
      // Existing helper verifies every chunk against native SHA-256.
      return native(() => filesystem.readFile(s, handle, offset, length));
    },
    fileSize: getSize,
    closeFile: closeHandle,
    async close(part) {
      const mount = mounts.get(part);
      if (mount) {
        await closeHandle(mount.handle);
        await closeHandle(mount.root);
        mounts.delete(part);
      }
    },
    async finish() {
      if (!s) return {complete: true};
      let error;
      try {
        if (!uncertain) {
          for (const handle of [...exports]) await closeExport(handle);
          await native(() => s.cleanup());
        }
      }
      catch (failure) {error = failure.message;}
      const complete = !uncertain && s.base === 0 && s.handles.size === 0 && exports.size === 0;
      return {complete, deferred: !complete, base: s.base, handles: [...s.handles],
        ...(exports.size ? {exportedHandles: [...exports]} : {}), ...(error ? {error} : {})};
    },
  };
}

async function loadClient({run, title, parts, storage, attributes, note}) {
  const read = filename => fs.readFile(filename, 'utf8').then(JSON.parse);
  const engine = path.join(run, 'switch2');
  const connection = await read(path.join(run, 'connection.json'));
  const acquisition = await read(path.join(engine, 'current-acquisition.json'));
  const root = await read(path.join(engine, 'ro/root/current-root.json'));
  check(connection.addresses?.platform === 2 && acquisition.session === connection.addresses.session &&
    root.session === acquisition.session && root.pid === 1 && Number.isInteger(root.rootHandle) && root.rootHandle > 0 &&
    typeof acquisition.report === 'string' && root.report === acquisition.report &&
    typeof acquisition.socketPath === 'string' && path.isAbsolute(acquisition.socketPath),
  'A same-session promoted root in a completed --rpc run is required');
  const report = await read(acquisition.report);
  check(report.session === acquisition.session && report.memoryControl?.ready &&
    report.memoryControl.socketPath === acquisition.socketPath && !report.memoryControl.pending &&
    report.retainedMemory?.ready && report.retainedMemory.zeroCountVerified && !report.retainedMemory.pending &&
    !report.cleanedUp && !report.cleanupError && !report.placementUncertain,
  'The retained endpoint is not ready or has uncertain placement/cleanup');
  let loader;
  if (parts.includes('exefs')) {
    loader = await read(path.join(engine, 'ro', acquisition.session + '-loader-root-copy.json'));
    check(loader.session === acquisition.session && loader.report === acquisition.report &&
      loader.verified && loader.restored && Number.isInteger(loader.copy?.handle) && loader.copy.handle > 0,
    'This run has no verified, restored Loader-root copy');
  }
  const {Session} = require(path.join(engine, 'app/session.cjs'));
  return createClient({Session, acquisition, root, loader, title, storage, attributes, note,
    filesystem: require(path.join(engine, 'app/filesystem.cjs')),
    domain: require(path.join(engine, 'app/domain.cjs')),
    request: require(path.join(engine, 'tools/endpoint.cjs')).request});
}

module.exports = {createClient, loadClient, codeInput};
