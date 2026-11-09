'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {PROFILES, fromEnvironment, environment, confirmExperimentalSd, assertAllocationCost} =
  require('../engine/shared/acquisition-profile.cjs');
const {startEngine} = require('../run.cjs');

test('internal accounting is the default and SD requires explicit acknowledgment', () => {
  assert.equal(fromEnvironment({}), PROFILES.internal);
  assert.equal(PROFILES.internal.expectedBytes, 13616);
  assert.equal(PROFILES.sd.expectedBytes, 14992);
  assert.throws(() => fromEnvironment({NS2_ACQUISITION_PROFILE: 'sd'}), /requires confirmation/);
  assert.equal(fromEnvironment(environment(PROFILES.sd)), PROFILES.sd);
  for (const name of ['auto', 'constructor', '__proto__', 'other'])
    assert.throws(() => fromEnvironment({NS2_ACQUISITION_PROFILE: name}), /Unknown acquisition profile/);
  assert.throws(() => environment({...PROFILES.sd, confirmed: false}), /unconfirmed/);
  assert.throws(() => environment({...PROFILES.internal, expectedBytes: 14992}), /Invalid/);
});

for (const phase of ['Pinning storage', 'Candidate storage']) {
  test(phase + ' accepts only the selected exact cost and provides an actionable mismatch', () => {
    assert.doesNotThrow(() => assertAllocationCost(PROFILES.internal, 13616, phase));
    assert.doesNotThrow(() => assertAllocationCost(PROFILES.sd, 14992, phase));
    assert.throws(() => assertAllocationCost(PROFILES.internal, 14992, phase), error => {
      assert.match(error.message, /Move the SmileBASIC 4 application itself/);
      assert.match(error.message, /--experimental-sd/);
      assert.match(error.message, /unvalidated/);
      assert.deepEqual(error.allocationMismatch, {phase, observedBytes: 14992, expectedBytes: 13616,
        selectedProfile: 'internal', detectedProfile: 'sd-like'});
      return true;
    });
    assert.throws(() => assertAllocationCost(PROFILES.sd, 13616, phase), /without --experimental-sd/);
    for (const profile of [PROFILES.internal, PROFILES.sd])
      for (const cost of [0, 14000, 14993, NaN, Infinity, '14992'])
        assert.throws(() => assertAllocationCost(profile, cost, phase), /allocation mismatch/);
  });
}

for (const answer of ['', 'n', 'anything']) test('experimental prompt rejects ' + JSON.stringify(answer), async () => {
  let closed = false, prompted = false;
  await assert.rejects(confirmExperimentalSd({input: {isTTY: true}, output: {write() {}},
    createInterface: () => ({question: async () => {prompted = true; return answer;}, close() {closed = true;}})}), /cancelled/);
  assert.equal(closed, true); assert.equal(prompted, true);
});

test('experimental prompt explains the limitation and returns SD only after an affirmative answer', async () => {
  let text = '', closed = false;
  const profile = await confirmExperimentalSd({input: {isTTY: true}, output: {write: bytes => {text += bytes;}},
    createInterface: () => ({question: async prompt => {text += prompt; return ' YES ';}, close() {closed = true;}})});
  assert.equal(profile, PROFILES.sd); assert.equal(closed, true);
  assert.match(text, /14992/); assert.match(text, /not been validated on hardware/);
  assert.match(text, /success is not guaranteed/); assert.match(text, /\[y\/N\]/);
});

test('piped input cannot approve SD mode or start pairing', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../run.cjs'), '--experimental-sd', '192.0.2.1'],
    {input: 'yes\n', encoding: 'utf8', timeout: 3000});
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /interactive terminal confirmation/);
  assert.doesNotMatch(result.stdout, /Waiting for Switch 2/);
});

test('runner forwards the chosen profile to children and shows allocation hints without verbose mode', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-forward-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const seen = [];
  t.mock.method(console, 'log', text => seen.push(text));
  const oldProfile = process.env.NS2_ACQUISITION_PROFILE;
  const oldConfirmed = process.env.NS2_EXPERIMENTAL_SD_CONFIRMED;
  try {
    process.env.NS2_ACQUISITION_PROFILE = 'sd';
    process.env.NS2_EXPERIMENTAL_SD_CONFIRMED = '1';
    for (const selected of [PROFILES.sd, undefined]) {
      const directory = path.join(root, selected?.name || 'default');
      await fs.mkdir(path.join(directory, 'switch2'), {recursive: true});
      await fs.writeFile(path.join(directory, 'switch2/pipeline.cjs'), `
        process.on('message', row => {if (row.type === 'release') process.exit(0);});
        console.log(JSON.stringify({profile: process.env.NS2_ACQUISITION_PROFILE,
          confirmed: process.env.NS2_EXPERIMENTAL_SD_CONFIRMED}));
        console.log('Acquisition: observed 14992; move SmileBASIC or use --experimental-sd');
        process.send({type: 'held-ready', session: 'test'});
      `);
      const engine = await startEngine(directory, null, true, selected);
      try {
        await engine.ready;
        assert.equal((await engine.release()).code, 0);
        const report = JSON.parse((await fs.readFile(path.join(directory, 'run.log'), 'utf8')).split('\n')[0]);
        assert.deepEqual(report, {profile: selected?.name || 'internal', confirmed: selected ? '1' : '0'});
      } finally {if (engine.child.exitCode === null) {engine.child.kill('SIGTERM'); await engine.finished;}}
    }
  } finally {
    if (oldProfile === undefined) delete process.env.NS2_ACQUISITION_PROFILE;
    else process.env.NS2_ACQUISITION_PROFILE = oldProfile;
    if (oldConfirmed === undefined) delete process.env.NS2_EXPERIMENTAL_SD_CONFIRMED;
    else process.env.NS2_EXPERIMENTAL_SD_CONFIRMED = oldConfirmed;
  }
  assert.equal(seen.filter(line => line.startsWith('Acquisition: ')).length, 2);
});
