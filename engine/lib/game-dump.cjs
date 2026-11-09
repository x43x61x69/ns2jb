'use strict';
// Host-only streaming export. The injected client exposes read-only game handles.
const fs = require('node:fs/promises');
const {createReadStream, constants} = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const CHUNK_SIZE = 0x40000;
const MAX_ENTRIES = 1000000;
const check = (ok, message) => {if (!ok) throw Error(message);};

function checkedName(name) {
  check(typeof name === 'string' && name && !['.', '..'].includes(name) &&
    !/[\/\\\x00-\x1f\x7f]/.test(name) && Buffer.byteLength(name, 'utf8') < 0x301,
  'Invalid remote filename: ' + JSON.stringify(name));
  return name;
}

function fileSize(value) {
  check((typeof value === 'bigint' || typeof value === 'number' ||
    typeof value === 'string' && /^\d+$/.test(value)), 'Invalid remote file size');
  const size = Number(value);
  check(Number.isSafeInteger(size) && size >= 0, 'Invalid remote file size');
  return size;
}

async function diskHash(filename) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}

async function dumpGame({client, output, title, parts = ['exefs', 'romfs'], progress = () => {}}) {
  check(/^[0-9a-f]{16}$/.test(title) && BigInt('0x' + title) !== 0n, 'Invalid title ID');
  check(Array.isArray(parts) && parts.length && parts.length <= 2 &&
    new Set(parts).size === parts.length && parts.every(p => ['exefs', 'romfs'].includes(p)), 'Invalid dump selection');
  output = path.resolve(output);
  await fs.mkdir(path.dirname(output), {recursive: true});
  // mkdir is exclusive even for an existing empty destination.
  await fs.mkdir(output, {mode: 0o700});
  const root = await fs.realpath(output);
  await fs.mkdir(path.join(root, '.partials'), {mode: 0o700});
  const report = {kind: 'ns2jb-game-files', version: 1, title, session: client.session,
    started: new Date().toISOString(), complete: false, selection: parts,
    sources: {}, directories: [], files: [], totalBytes: 0,
    fileJournal: 'files.jsonl', progressFile: 'progress.json'};
  const manifest = path.join(root, 'dump.json');
  await fs.writeFile(path.join(root, report.fileJournal), '', {flag: 'wx', mode: 0o600});
  let lastSnapshot = 0;
  const save = async (force = false) => {
    // Keep per-chunk progress small; don't rewrite a huge manifest for every read.
    const progress = path.join(root, report.progressFile);
    await fs.writeFile(progress + '.pending', JSON.stringify({complete: report.complete,
      files: report.files.length, totalBytes: report.totalBytes, activeFile: report.activeFile,
      cleanup: report.cleanup}) + '\n', {mode: 0o600});
    await fs.rename(progress + '.pending', progress);
    if (!force && Date.now() - lastSnapshot < 5000) return;
    const temporary = manifest + '.pending';
    await fs.writeFile(temporary, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
    await fs.rename(temporary, manifest);
    lastSnapshot = Date.now();
  };
  let count = 0, failure;
  const seen = new Set();

  async function capture(part, relative, listedSize) {
    const remote = '/' + relative;
    report.activeFile = {part, path: remote, size: fileSize(listedSize), captured: 0};
    await save();
    const file = await client.openFile(part, remote);
    let out;
    const temporary = path.join(root, '.partials', crypto.randomUUID() + '.partial');
    try {
      const size = fileSize(file.size);
      check(size === fileSize(listedSize), 'File size changed since listing: ' + remote);
      check(Number.isSafeInteger(report.totalBytes + size), 'Dump byte count exceeds safe integer capacity');
      report.activeFile = {part, path: remote, size, captured: 0, temporary: path.relative(root, temporary)};
      await save();
      out = await fs.open(temporary, 'wx', 0o600);
      const digest = crypto.createHash('sha256');
      let header = Buffer.alloc(0), lastProgress = 0;
      for (let offset = 0; offset < size;) {
        const length = Math.min(CHUNK_SIZE, size - offset);
        const bytes = await client.readFile(file.handle, offset, length);
        check(Buffer.isBuffer(bytes) && bytes.length === length, 'Short file read: ' + remote);
        let written = 0;
        while (written < bytes.length) {
          const result = await out.write(bytes, written, bytes.length - written, offset + written);
          check(result.bytesWritten > 0, 'Local file write made no progress');
          written += result.bytesWritten;
        }
        digest.update(bytes);
        if (header.length < 0x60) header = Buffer.concat([header, bytes]).subarray(0, 0x60);
        offset += length;
        report.activeFile.captured = offset;
        await save();
        if (Date.now() - lastProgress >= 1000 || offset === size) {
          progress({...report.activeFile}); lastProgress = Date.now();
        }
      }
      check(fileSize(await client.fileSize(file.handle)) === size, 'File size changed while reading: ' + remote);
      await out.sync(); await out.close(); out = null;
      const sha256 = digest.digest('hex');
      check((await fs.stat(temporary)).size === size && await diskHash(temporary) === sha256,
        'Local disk readback differs: ' + remote);
      if (part === 'exefs' && relative === 'main') {
        check(header.length >= 0x60 && header.subarray(0, 4).toString('ascii') === 'NSO0', 'ExeFS main is not an NSO0 executable');
        report.buildId = header.subarray(0x40, 0x60).toString('hex');
      }
      // Publication is exclusive, including on volumes without hard-link support.
      const target = path.join(root, part, ...relative.split('/'));
      try {await fs.link(temporary, target);}
      catch (error) {
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error.code)) throw error;
        await fs.copyFile(temporary, target, constants.COPYFILE_EXCL);
        check((await fs.stat(target)).size === size && await diskHash(target) === sha256,
          'Published file disk readback differs: ' + remote);
      }
      await fs.unlink(temporary);
      report.files.push({part, path: remote, size, sha256, verified: true});
      await fs.appendFile(path.join(root, report.fileJournal), JSON.stringify(report.files.at(-1)) + '\n');
      report.totalBytes += size;
      delete report.activeFile;
      await save();
      if (size === 0) progress({part, path: remote, size, captured: 0});
    } finally {
      if (out) await out.close();
      await client.closeFile(file.handle);
    }
  }

  async function walk(part) {
    const pending = [''];
    while (pending.length) {
      const relative = pending.pop(), remote = relative ? '/' + relative : '/';
      check(Buffer.byteLength(remote, 'utf8') < 0x301, 'Remote path exceeds filesystem capacity');
      await fs.mkdir(path.join(root, part, ...relative.split('/')), {recursive: true, mode: 0o700});
      report.directories.push({part, path: remote});
      for await (const entry of client.listDirectory(part, remote)) {
        const name = checkedName(entry.name), next = relative ? relative + '/' + name : name;
        check(Buffer.byteLength('/' + next, 'utf8') < 0x301, 'Remote path exceeds filesystem capacity');
        check(++count <= MAX_ENTRIES, 'Dump exceeds the directory-entry limit');
        const key = part + '/' + next;
        check(!seen.has(key), 'Duplicate remote entry: ' + key); seen.add(key);
        if (entry.type === 0) pending.push(next);
        else if (entry.type === 1) await capture(part, next, entry.size);
        else throw Error('Unsupported directory entry type at ' + key);
      }
    }
  }

  await save(true);
  try {
    await client.initialize();
    for (const part of parts) {
      report.sources[part] = await client.open(part);
      try {
        await walk(part);
        if (part === 'exefs') check(report.buildId, 'ExeFS listing contained no main executable');
        report.sources[part].complete = true;
        await save(true);
      } finally {await client.close(part);}
    }
  } catch (error) {failure = error; report.error = error.stack || String(error);}
  finally {
    try {report.cleanup = await client.finish();}
    catch (error) {report.cleanup = {complete: false, error: error.message}; failure ||= error;}
    report.finished = new Date().toISOString();
    report.complete = !failure && report.cleanup?.complete === true;
    await save(true);
  }
  if (failure || !report.complete) throw Error((failure?.message || 'Dump cleanup did not finish') +
    '; dump is incomplete. Inspect ' + manifest + (report.cleanup?.deferred ? '; restart the console before another native operation.' : ''));
  await fs.rmdir(path.join(root, '.partials'));
  return report;
}

module.exports = {dumpGame, checkedName, fileSize, diskHash, CHUNK_SIZE};
