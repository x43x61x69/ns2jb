'use strict';
const PROFILES = Object.freeze({
  internal: Object.freeze({name: 'internal', expectedBytes: 13616, experimental: false, confirmed: false}),
  sd: Object.freeze({name: 'sd', expectedBytes: 14992, experimental: true, confirmed: true}),
});
const WARNING = 'Experimental SD acquisition profile: 14992 bytes. This mode has not been validated on hardware and success is not guaranteed. It changes allocation accounting only; all timing, canary, restoration and cleanup checks remain enabled.';

function fromEnvironment(env = process.env) {
  const name = env.NS2_ACQUISITION_PROFILE || 'internal';
  if (!Object.hasOwn(PROFILES, name)) throw Error('Unknown acquisition profile: ' + name);
  if (name === 'sd' && env.NS2_EXPERIMENTAL_SD_CONFIRMED !== '1')
    throw Error('Experimental SD mode requires confirmation through node run.cjs --experimental-sd');
  return PROFILES[name];
}

function environment(profile = PROFILES.internal) {
  if (!profile || !Object.hasOwn(PROFILES, profile.name) ||
      profile.expectedBytes !== PROFILES[profile.name].expectedBytes ||
      profile.name === 'sd' && profile.confirmed !== true)
    throw Error('Invalid or unconfirmed acquisition profile');
  return {NS2_ACQUISITION_PROFILE: profile.name,
    NS2_EXPERIMENTAL_SD_CONFIRMED: profile.name === 'sd' ? '1' : '0'};
}

async function confirmExperimentalSd({input = process.stdin, output = process.stdout, createInterface} = {}) {
  if (!input.isTTY) throw Error('Experimental SD mode requires interactive terminal confirmation; piped input cannot authorize it.');
  output.write(WARNING + '\n');
  const terminal = (createInterface || require('node:readline/promises').createInterface)({input, output});
  try {
    const answer = await terminal.question('Continue with experimental SD mode? [y/N]: ');
    if (!/^(y|yes)$/i.test(answer.trim())) throw Error('Experimental SD mode cancelled; use internal storage without --experimental-sd.');
  } finally {terminal.close();}
  return PROFILES.sd;
}

function assertAllocationCost(profile, actual, phase) {
  if (Number.isSafeInteger(actual) && actual === profile.expectedBytes) return;
  let advice;
  if (profile.name === 'internal' && actual === PROFILES.sd.expectedBytes)
    advice = 'An SD-like allocation was observed. Move the SmileBASIC 4 application itself (not just its save) to console internal storage and reboot, or start a fresh boot with node run.cjs --experimental-sd. SD mode is unvalidated and requires interactive confirmation.';
  else if (profile.name === 'sd' && actual === PROFILES.internal.expectedBytes)
    advice = 'The internal-storage allocation was observed. Start a fresh boot without --experimental-sd.';
  else advice = 'This allocation is unsupported by the selected profile; do not bypass its checks. Use internal storage or investigate the recorded layout.';
  const error = Error(phase + ' allocation mismatch: observed ' + actual + ' bytes, expected ' + profile.expectedBytes +
    ' (' + profile.name + '). ' + advice);
  error.allocationMismatch = {phase, observedBytes: actual, expectedBytes: profile.expectedBytes,
    selectedProfile: profile.name, detectedProfile: actual === 14992 ? 'sd-like' : actual === 13616 ? 'internal-like' : 'unknown'};
  throw error;
}

module.exports = {PROFILES, WARNING, fromEnvironment, environment, confirmExperimentalSd, assertAllocationCost};
