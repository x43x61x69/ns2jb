'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {dumpGame, diskHash, CHUNK_SIZE} = require('../engine/lib/game-dump.cjs');
const {parseArgs} = require('../dump-game.cjs');
const {createClient, loadClient} = require('../engine/lib/game-dump-client.cjs');
const title = '0400486024dec000';

async function destination(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'game-dump-test-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  return path.join(parent, 'export');
}

function fakeClient({short = false, changeSize = false, unsafe = false, duplicate = false, cleanup = true} = {}) {
  const main = Buffer.alloc(CHUNK_SIZE + 23, 0x42);
  main.write('NSO0'); main.fill(0x12, 0x40, 0x60);
  const contents = new Map([['exefs/main', main], ['exefs/main.npdm', Buffer.from('policy')],
    ['romfs/data/asset.bin', Buffer.alloc(CHUNK_SIZE * 2 + 7, 0x33)], ['romfs/empty.bin', Buffer.alloc(0)]]);
  const directories = {
    'exefs/': [{name: 'main', type: 1, size: main.length}, {name: 'main.npdm', type: 1, size: 6}],
    'romfs/': [{name: 'data', type: 0}, {name: 'emptydir', type: 0}, {name: 'empty.bin', type: 1, size: 0}],
    'romfs/data': [{name: 'asset.bin', type: 1, size: CHUNK_SIZE * 2 + 7}], 'romfs/emptydir': [],
  };
  if (unsafe) directories['exefs/'] = [{name: '../escape', type: 1, size: 1}];
  if (duplicate) directories['exefs/'].push(directories['exefs/'][0]);
  let initialized = 0, next = 10;
  const handles = new Map(), reads = [], queries = new Map(), events = [];
  return {
    session: 'test-session', contents, reads, handles, events, directories,
    get initialized() {return initialized;},
    async initialize() {initialized++;},
    async open(part) {events.push('open:' + part); return {method: 'fake-read-only'};},
    async *listDirectory(part, remote) {yield* directories[part + remote];},
    async openFile(part, remote) {
      const handle = next++, bytes = contents.get(part + remote);
      handles.set(handle, bytes); return {handle, size: bytes.length};
    },
    async readFile(handle, offset, length) {
      reads.push({offset, length});
      assert.ok(length > 0 && length <= CHUNK_SIZE);
      return handles.get(handle).subarray(offset, offset + length - (short ? 1 : 0));
    },
    async fileSize(handle) {
      queries.set(handle, (queries.get(handle) || 0) + 1);
      return handles.get(handle).length + (changeSize ? 1 : 0);
    },
    async closeFile(handle) {handles.delete(handle);},
    async close(part) {events.push('close:' + part);},
    async finish() {return {complete: cleanup, deferred: !cleanup};},
  };
}

test('exports complete ExeFS and nested RomFS, hashes disk bytes and records the NSO Build ID', async t => {
  const output = await destination(t), client = fakeClient();
  const report = await dumpGame({client, output, title});
  assert.equal(report.complete, true);
  assert.equal(report.buildId, '12'.repeat(32));
  assert.equal(report.files.length, 4);
  assert.equal(report.totalBytes, [...client.contents.values()].reduce((sum, b) => sum + b.length, 0));
  for (const entry of report.files) {
    const filename = path.join(output, entry.part, entry.path);
    assert.deepEqual(await fs.readFile(filename), client.contents.get(entry.part + entry.path));
    assert.equal(entry.sha256, await diskHash(filename));
  }
  assert.equal((await fs.stat(path.join(output, 'romfs/emptydir'))).isDirectory(), true);
  assert.deepEqual(client.events, ['open:exefs', 'close:exefs', 'open:romfs', 'close:romfs']);
  assert.equal(client.handles.size, 0);
  assert.ok(client.reads.some(r => r.offset === CHUNK_SIZE));
  assert.equal((await fs.readdir(output)).includes('.partials'), false);
});

test('RomFS-only export does not require main and handles directories with more than 128 files', async t => {
  const output = await destination(t), client = fakeClient();
  const entries = Array.from({length: 140}, (_, i) => ({name: 'file-' + i, type: 1, size: 0}));
  client.directories['romfs/'] = entries;
  for (const e of entries) client.contents.set('romfs/' + e.name, Buffer.alloc(0));
  const report = await dumpGame({client, output, title, parts: ['romfs']});
  assert.equal(report.files.length, 140);
  assert.equal(report.buildId, undefined);
  assert.equal(client.reads.length, 0);
});

test('refuses existing output without touching its files or contacting the console', async t => {
  const output = await destination(t), client = fakeClient();
  await fs.mkdir(output); await fs.writeFile(path.join(output, 'keep'), 'untouched');
  await assert.rejects(dumpGame({client, output, title}), {code: 'EEXIST'});
  assert.equal(client.initialized, 0);
  assert.equal(await fs.readFile(path.join(output, 'keep'), 'utf8'), 'untouched');
});

test('exports without overwriting on host volumes that do not support hard links', async t => {
  const output = await destination(t);
  t.mock.method(fs, 'link', async () => {throw Object.assign(Error('unsupported'), {code: 'EOPNOTSUPP'});});
  const report = await dumpGame({client: fakeClient(), output, title});
  assert.equal(report.complete, true);
  for (const entry of report.files)
    assert.equal(await diskHash(path.join(output, entry.part, entry.path)), entry.sha256);
});

for (const [name, options, expected] of [
  ['short read', {short: true}, /Short file read/],
  ['changing file', {changeSize: true}, /File size changed/],
  ['traversal', {unsafe: true}, /Invalid remote filename/],
  ['duplicate entry', {duplicate: true}, /Duplicate remote entry/],
]) test('fails incomplete on ' + name + ' and never opens the next filesystem', async t => {
  const output = await destination(t), client = fakeClient(options);
  await assert.rejects(dumpGame({client, output, title}), expected);
  const report = JSON.parse(await fs.readFile(path.join(output, 'dump.json')));
  assert.equal(report.complete, false);
  assert.equal(client.events.includes('open:romfs'), false);
  assert.equal(client.handles.size, 0);
  if (name === 'short read') {
    assert.equal(client.reads.length, 1, 'failed read was not replayed');
    assert.equal(report.activeFile.captured, 0);
    assert.equal((await fs.stat(path.join(output, report.activeFile.temporary))).size, 0);
  }
});

test('cleanup uncertainty prevents a successful manifest', async t => {
  const output = await destination(t);
  await assert.rejects(dumpGame({client: fakeClient({cleanup: false}), output, title}), /restart the console/);
  const report = JSON.parse(await fs.readFile(path.join(output, 'dump.json')));
  assert.equal(report.complete, false);
  assert.equal(report.cleanup.deferred, true);
});

test('CLI validates selection, title, storage and repeated/missing options before connection', () => {
  assert.equal(parseArgs(['--help']).help, true);
  const parsed = parseArgs(['/run', title.toUpperCase(), '--romfs', '--storage', '2', '--attributes', '3']);
  assert.deepEqual(parsed.parts, ['romfs']);
  assert.equal(parsed.title, title);
  assert.equal(parsed.storage, 2);
  assert.equal(parsed.attributes, 3);
  for (const args of [[], ['/run', 'not-a-title'], ['/run', '0'.repeat(16)],
    ['/run', title, '--exefs', '--both'], ['/run', title, '--out'],
    ['/run', title, '--storage', '1'], ['/run', title, '--attributes', '16'],
    ['/run', title, '--out', 'a', '--out', 'b'], ['/run', title, '--resume']])
    assert.throws(() => parseArgs(args));
});

function nativeFixture({failRead = false, idle = true, directoryEntries = 0} = {}) {
  const events = [], instances = [], data = Buffer.alloc(16, 0x42);
  let next = 100;
  class Session {
    constructor() {this.handles = new Set(); this.base = 0; this.cursors = new Map(); instances.push(this);}
    async initialize() {events.push('initialize'); this.base = 0x100000;}
    async write(at, bytes) {this.lastWrite = {at, bytes};}
    async readOwned(at, size) {
      if (at === this.base + 0x6000) return this.directoryBytes.subarray(0, size);
      return this.lastWrite.bytes.subarray(0, size);
    }
    async ipc(label, handle, command, input, options) {
      events.push({label, handle, command, input, options});
      if (label === 'Game dump ReadDirectory') {
        const at = this.cursors.get(handle), count = Math.min(4, directoryEntries - at);
        this.directoryBytes = Buffer.alloc(count * 0x310);
        for (let i = 0; i < count; i++) {
          this.directoryBytes.write('file-' + (at + i), i * 0x310);
          this.directoryBytes[i * 0x310 + 0x304] = 1;
          this.directoryBytes.writeBigUInt64LE(16n, i * 0x310 + 0x308);
        }
        this.cursors.set(handle, at + count);
        const data = Buffer.alloc(8); data.writeBigUInt64LE(BigInt(count));
        return {result: 0, data};
      }
      if (command === 4) {const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(data.length)); return {result: 0, data: b};}
      const child = next++; this.handles.add(child);
      return {result: 0, moves: [child], copies: []};
    }
    async close(handle) {events.push('close:' + handle); this.handles.delete(handle);}
    async cleanup() {events.push('cleanup'); for (const h of [...this.handles]) await this.close(h); this.base = 0;}
  }
  const domain = {
    wire: {control: id => Buffer.from([id])},
    async send(s, label, handle, packet) {
      events.push({label, handle, packet}); const child = next++; s.handles.add(child);
      return {result: 0, moves: [child], copies: []};
    },
    oneHandle: reply => reply.moves[0],
  };
  const filesystem = {
    async pathMethod(s, root, command, filename, input) {
      assert.equal(command, 9); assert.equal(input.readUInt32LE(), 3);
      const h = next++; s.handles.add(h); s.cursors.set(h, 0);
      return {result: 0, moves: [h], copies: []};
    },
    async openFile(s) {const h = next++; s.handles.add(h); return {result: 0, handle: h};},
    async readFile(s, h, offset, length) {
      events.push('read'); if (failRead) throw Error('Native request timed out; it was not replayed');
      return data.subarray(offset, offset + length);
    },
  };
  const client = createClient({Session, domain, filesystem, title, storage: 2, attributes: 3,
    acquisition: {session: 'session', socketPath: '/unused'}, root: {rootHandle: 8}, loader: {copy: {handle: 9}},
    request: async (_socket, request) => request.command === 'root-info'
      ? {session: 'session', initialized: true, clones: [8]}
      : {session: 'session', worker: {joined: idle}, domainCopies: [{handle: 9}]}});
  return {client, events, instances};
}

test('client opens ExeFS and RomFS with the right IPC layouts and closes only its own handles', async () => {
  const {client, events} = nativeFixture();
  await client.initialize();
  await client.open('exefs'); await client.close('exefs');
  await client.open('romfs'); await client.close('romfs');
  const code = events.find(e => e.label === 'Game dump OpenCodeFileSystem');
  assert.equal(code.command, 0);
  assert.equal(code.input.length, 16);
  assert.equal(code.input[0], 3); assert.equal(code.input[1], 2);
  assert.equal(code.input.readBigUInt64LE(8), BigInt('0x' + title));
  assert.equal(code.options.receive[0].size, 0x1a4);
  const rom = events.find(e => e.label === 'Game dump OpenDataFileSystemByProgramId');
  assert.equal(rom.command, 9);
  assert.equal(rom.input.length, 8);
  assert.equal(rom.input.readBigUInt64LE(), BigInt('0x' + title));
  assert.equal(events.includes('close:8') || events.includes('close:9'), false);
  assert.equal((await client.finish()).complete, true);
});

test('native read uncertainty blocks all subsequent cleanup requests and preserves resource identity', async () => {
  const {client, events} = nativeFixture({failRead: true});
  await client.initialize(); await client.open('romfs');
  const file = await client.openFile('romfs', '/asset');
  await assert.rejects(client.readFile(file.handle, 0, 16), /timed out/);
  const before = events.length;
  await client.closeFile(file.handle); await client.close('romfs');
  const cleanup = await client.finish();
  assert.equal(events.length, before);
  assert.equal(cleanup.complete, false); assert.equal(cleanup.deferred, true);
  assert.ok(cleanup.handles.includes(file.handle));
  assert.equal(cleanup.base, 0x100000);
  await assert.rejects(client.readFile(file.handle, 0, 16), /further requests are blocked/);
  assert.equal(events.length, before);
});

test('native directory pagination reaches EOF beyond the old 128-entry probe limit', async () => {
  const {client, events} = nativeFixture({directoryEntries: 133});
  await client.initialize(); await client.open('romfs');
  const entries = [];
  for await (const entry of client.listDirectory('romfs', '/')) entries.push(entry);
  assert.equal(entries.length, 133);
  assert.deepEqual(entries[132], {name: 'file-132', type: 1, size: '16'});
  assert.equal(events.filter(e => e.label === 'Game dump ReadDirectory').length, 35);
  await client.close('romfs');
  assert.equal((await client.finish()).complete, true);
});

test('a pending held worker is rejected before creating a new allocation', async () => {
  const {client, instances} = nativeFixture({idle: false});
  await assert.rejects(client.initialize(), /not idle/);
  assert.equal(instances.length, 0);
  assert.equal((await client.finish()).complete, true);
});

test('stale promoted-root proof is rejected before importing any run engine or opening native connections', async t => {
  const run = await destination(t);
  await fs.mkdir(path.join(run, 'switch2/ro/root'), {recursive: true});
  const write = (rel, value) => fs.writeFile(path.join(run, rel), JSON.stringify(value));
  await write('connection.json', {addresses: {platform: 2, session: 'new'}});
  await write('switch2/current-acquisition.json', {session: 'new', report: '/unused', socketPath: '/unused'});
  await write('switch2/ro/root/current-root.json', {session: 'old', pid: 1, rootHandle: 8, report: '/unused'});
  await assert.rejects(loadClient({run, title, parts: ['romfs']}), /same-session promoted root/);
});
