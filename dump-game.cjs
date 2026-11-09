#!/usr/bin/env node
'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const {dumpGame} = require('./engine/lib/game-dump.cjs');

const HELP = `Usage: node dump-game.cjs <run-directory> <16-digit-title-id> [options]
  --exefs | --romfs | --both   Select extracted filesystems (default: --both)
  --out <new-directory>        Refuse existing destinations; never overwrite
  --storage <auto|2|3|4|5>     ExeFS: detect via NCM (default), or override
  --attributes <0..15>         ExeFS content attributes (default: 1)
Requires a completed node run.cjs --rpc session. Keep its runner open.
RomFS uses the OS-resolved program filesystem, not a manually selected NCA.
No native request is replayed after failure. Hardware validation is pending.`;

function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return {help: true};
  const [run, title, ...rest] = argv;
  if (!run || !/^(?:0x)?[0-9a-f]{16}$/i.test(title || '') || BigInt('0x' + title.replace(/^0x/i, '')) === 0n)
    throw Error(HELP);
  const options = {run: path.resolve(run), title: title.replace(/^0x/i, '').toLowerCase(),
    parts: ['exefs', 'romfs'], storage: 'auto', attributes: 1};
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (['--exefs', '--romfs', '--both'].includes(flag)) {
      if (seen.has('parts')) throw Error('Select only one of --exefs, --romfs or --both');
      seen.add('parts');
      options.parts = flag === '--both' ? ['exefs', 'romfs'] : [flag.slice(2)];
    } else if (['--out', '--storage', '--attributes'].includes(flag)) {
      if (seen.has(flag) || !rest[i + 1] || rest[i + 1].startsWith('--')) throw Error('Missing or repeated option: ' + flag);
      seen.add(flag);
      const value = rest[++i];
      if (flag === '--out') options.output = path.resolve(value);
      else if (flag === '--storage' && value === 'auto') options.storage = 'auto';
      else {
        if (!/^\d+$/.test(value)) throw Error('Invalid number for ' + flag);
        options[flag.slice(2)] = Number(value);
      }
    } else throw Error('Unknown option: ' + flag);
  }
  if (!['auto', 2, 3, 4, 5].includes(options.storage)) throw Error('--storage must be auto, 2, 3, 4 or 5');
  if (!Number.isInteger(options.attributes) || options.attributes < 0 || options.attributes > 15)
    throw Error('--attributes must be 0..15');
  options.output ||= path.join(__dirname, 'game-dumps', options.title,
    new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {console.log(HELP); return;}
  const lockPath = path.join(options.run, 'game-dump.lock');
  let lock;
  try {lock = await fs.open(lockPath, 'wx', 0o600);}
  catch (error) {
    if (error.code === 'EEXIST') throw Error('A dump lock exists: ' + lockPath + '. Check the previous dumper; if cleanup was not recorded, restart the console before removing a stale lock.');
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({pid: process.pid, started: new Date().toISOString(), title: options.title}));
    const {loadClient} = require('./engine/lib/game-dump-client.cjs');
    const client = await loadClient({...options, note: message => console.log(message)});
    console.log('Output: ' + options.output);
    const report = await dumpGame({...options, client,
      progress: row => console.log(row.part + ' ' + row.path + ': ' + row.captured + '/' + row.size + ' bytes')});
    console.log('Dump verified: ' + report.files.length + ' files; ' + path.join(options.output, 'dump.json'));
    if (report.buildId) console.log('main NSO Build ID: ' + report.buildId);
    return report;
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
module.exports = {parseArgs, main, HELP};
