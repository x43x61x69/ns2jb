# Switch 2 FS demo

You need **SmileBASIC 4.4.9 (and now the demo version works as well!)**, **system software 23.0.1**, **Node.js 22+** on
macOS or Linux, and over **20 MiB free** in the SmileBASIC save. The computer and
console must be on the same reachable network connected via ethernet.

Notes:

- Always use ethernet on the device you run the exploit and your Switch 2, or
  the fs exploit won't work as it's very timing sensitive.
- Keep the game on internal storage of the console, not SD.
- FS exploit is still very unstable. At best you might get a 20% success rate.
- This repo isn't intended to use as an API to build other apps on. Use it for
  debugging only.
- 

## One-time setup

In SmileBASIC’s **Make a Program**, enter `bootstrap.bas` into slot 0 and save it
as `NS2`. A USB keyboard helps. The ZIP is a computer package, not a SmileBASIC
import file; there is no published download key.

For the demo version, you have to use code to save the file in direct mode:

```basic
PRGEDIT 0:C$="":FOR I=0 TO PRGSIZE(0)-1:C$=C$+PRGGET$() :NEXT:SAVEV "TXT:NS2",C$
```

## Run

1. Restart the console, open SmileBASIC, and enter Direct mode.
2. On the computer, open a terminal in the extracted folder and run:

   ```sh
   node run.cjs
   ```

   If asked, select the computer address reachable by the console. You can also
   supply it directly: `node run.cjs 192.168.1.10`. The connection uses port 39380.
3. In SmileBASIC, load the saved program and enter these commands separately:

   ```basic
   LOAD "TXT:NS2"
   RUN
   REMOVE NSR,&H60000000,&H3FFFFFFF
   ```

   Confirm the load. The **Out of memory** message from `REMOVE` is expected.
   Then enter the **`V=START(...)`** line printed by the computer.

   If SmileBASIC says **Wrong number of arguments**, your saved `NS2` may be
   the older nine-argument bootstrap. Use the second `V=START(...)` line the
   computer prints: it has the same port and four IP numbers, followed by
   `,0,0,0,0`. Do **not** repeat `RUN` or `REMOVE`; enter just that replacement
   `START` command while the computer is still waiting. The `bootstrap.bas`
   supplied with this repo uses the normal five-argument form, so alternatively
   you can rewrite the bootstrap.

Keep SmileBASIC open and the computer awake until **FS execution verified**.
Restart the console when finished; that also restores the original RO process.
This demo does not install custom firmware or persistence.

## Optional held RPC

To keep the same SmileBASIC-backed RPC available after the 4/4 checks, start a
fresh run with `node run.cjs --rpc [computer-IP]`. If you use the local keyboard
launcher, run `./connect-upstream.sh --rpc [computer-IP]` from its parent folder.
The normal run still closes its RPC after verification.

Once 4/4 is verified, the runner prints its `runs/switch2-*` folder and stays
open. In this mode it keeps both the SmileBASIC RPC and the existing FS memory
endpoint alive; it does not retire the FS worker after verification. The FS
instruction changes have already been restored, and the temporary RO donor
files have been cleaned up. In another terminal, check the connection with:

```sh
node rpc.cjs runs/switch2-RUNID status
```

The client also accepts one JSON bridge request, for example
`node rpc.cjs runs/switch2-RUNID '{"command":"query","address":4294967296}'`.
This is the existing native RPC, not a new process or unrestricted FS API.
It can read or change live process memory; incorrect calls can crash the app or
console. Requests are serialized, and a timed-out native request must not be
replayed because its outcome is uncertain. The bridge listens only on the PC's
loopback interface; it has no authentication, so use a trusted PC and stop it
when finished.

Keep SmileBASIC open. This RPC does **not** survive fully closing the app or a
console restart. Press Ctrl-C in the runner terminal when finished; only then
does the runner retire the FS endpoint and close the bridge and console
connection. A disconnect also ends the held run and attempts cleanup. A failed
or interrupted cleanup may require a console restart. Tools that use the FS
endpoint must finish their requests before the held run is stopped.

If a run fails, keep the `runs` folder and restart the console before trying
again. Enter `REMOVE` only once per application process. Logs and temporary
memory captures stay in `runs`; they are not part of the distributable.

## Game file dumps: ExeFS and RomFS

Start a normal held run and wait for all checks to pass:

```sh
node run.cjs --rpc <computer-IP>
```

Keep that runner and SmileBASIC open. In another terminal, use the **run folder
printed by that runner** and the game's 16-digit program Title ID:

```sh
# Both filesystems (the default)
node dump-game.cjs runs/switch2-RUNID <title-id> --both --out game-dumps/my-game

# Select only one filesystem; each output directory must be new
node dump-game.cjs runs/switch2-RUNID <title-id> --exefs --out game-dumps/my-game-code
node dump-game.cjs runs/switch2-RUNID <title-id> --romfs --out game-dumps/my-game-data
```

`--out` is optional; the default is a unique directory below
`game-dumps/<title-id>/`. Existing destinations, including empty directories,
are refused. The output contains extracted files, not NSP/XCI packages or raw
RomFS images:

```text
my-game/
  exefs/          main, main.npdm, sdk, rtld, subsdk*, and other listed files
  romfs/          the original directory tree, including empty directories
  dump.json       selection, source methods, verified file hashes and status
  files.jsonl     append-only records of completed files
  progress.json   current file and byte count
```

ExeFS uses the same retained Loader root as the existing system-code capture.
`--storage` selects its content location: `2` = gamecard, `3` = built-in system,
`4` = internal user storage (default), `5` = SD. For example, add `--storage 2`
for a gamecard. `--attributes 0..15` overrides the Loader content attributes
(default `1`, matching the existing CodeFS capture).

RomFS opens FSP `OpenDataFileSystemByProgramId` (command 9). The OS resolves
that program's data filesystem; the command does not select an arbitrary NCA
or explicitly choose/merge a particular base/update revision. `--storage` and
`--attributes` apply only to ExeFS. The source methods are recorded separately
in `dump.json`. Match the recorded `main` NSO Build ID to the executable version
you intend to patch; the tool also prints that Build ID after a complete dump.

Reads are bounded to 256 KiB and use the existing console-side SHA-256 transfer
verification. Completed local files are synced and read back for SHA-256 before
publication. Directory enumeration continues to EOF rather than the old
128-entry probe limit. Unexpected names/types, duplicate entries, short reads,
changing file sizes, and more than one million total entries stop the export.
On case-insensitive host volumes, colliding game filenames also stop the dump;
use a case-sensitive volume for games containing such names.

Use one dumper per run and do not run other RPC/save/modloader operations at
the same time. A `game-dump.lock` prevents overlapping dump commands. On failure,
`dump.json` stays incomplete and partial data remains under `.partials/`; no
native operation is replayed. An uncertain native failure blocks further
requests and records retained allocation/handle identities. Restart the console
when the error reports deferred cleanup. After an interrupted host process,
check that it has exited. If complete cleanup was not recorded in `dump.json`,
restart the console and establish a fresh held run before another dump; do not
remove the stale lock merely to retry against the old session. Resume/overwrite is
not implemented; a new attempt needs a new destination. A failed dump never
clears an earlier output or the existing firmware `dumps/` directory.

This host command can use a completed compatible held run without copying or patching its
engine source. The console requests open, enumerate and read content; they do
not write game/save files. Access is still subject to the filesystem services
available in that session. **ExeFS and RomFS exports have offline regression
coverage but have not been validated on hardware.** Permission/mount failures
are reported rather than treated as empty or successful dumps.

Protocol references:
[libnx FSP wrappers](https://github.com/switchbrew/libnx/blob/master/nx/source/services/fs.c),
[libnx Loader wrappers](https://github.com/switchbrew/libnx/blob/master/nx/source/services/fsldr.c).

## Optional system-code dump

To capture installed system-program code from your own console, use this
command **instead of** `node run.cjs` for a fresh attempt:

```sh
node dump-firmware.cjs [computer-IP]
```

Follow the same SmileBASIC steps above. The command first completes the normal
4/4 exploit and verifies that the temporary FS instruction changes were
restored. Before the runner closes its RPC, it asks NCM for the installed,
full system-program IDs and reads each accessible CodeFS `main.npdm` and `main`
file. If the dump completes, it then performs the normal exploit cleanup. You
do not need to race to start a second command after 4/4; the ordinary `run.cjs`
closes its RPC at the end. `node run.cjs --dump-firmware [computer-IP]` is
equivalent. You can combine `--dump-firmware --rpc` to hold the RPC after the
dump finishes.

The output is in the repo-root `dumps/` directory. Open
`dumps/firmware-dump.json` for the title inventory, per-file SHA-256 hashes,
and entries whose CodeFS was unavailable. Captured files are in
`dumps/<title-id>/` directories, alongside `dumps/ncm-system-programs.bin`.
Starting another firmware-dump run clears the previous `dumps/` contents;
ordinary `run.cjs` runs do not touch them. An unrecognized nonempty `dumps/`
directory is never cleared automatically. Copy any partial or completed dump
you want to keep before starting another dump run. Run logs remain in `runs/`.

At startup, the runner checks the roots of SmileBASIC's inspected `save` and
`tmp` mounts and deletes every file or directory whose name starts with
`NS2_GAP`. Directories are deleted recursively. This no longer depends on
previous run reports or checks the entry's contents, so do not keep personal
files with that prefix on either mount. Other names and mounts are untouched;
the runner does not wipe all of `tmp`.

The metadata probe now selects a 16 KiB or 4 KiB window from the observed
allocator link, and the later layout check validates the captured SDK page
while discovering the domain vtable independently. These paths matched saved
hardware captures from both observed layouts.

Physically tested on October 21, 2026: both FS instruction challenges,
restoration, and cleanup passed. Acquisition is timing-sensitive: the test
passed on the third fresh boot. The first two attempts stopped at validation
checks and cleaned up.



## What this fork improves

This fork aims to make the exploit work across the two Switch 2 memory layouts
we observed before and after installing the microSD Express support update. The
original could get through the initial exploit, then fail while starting its
native helper; this fork adapts to either observed layout.

Supports demo version.

To check for the microSD Express support update, open **System Settings →
Support/Health & Safety** and look at item 3. On our test console it showed
**(B)** after the update. If yours shows **(B)**, use this fork: the original
fixed-layout version may fail on the layout we observed after the update. This
fork also supports the layout we observed before the update, so you can use it
even if item 3 does not show **(B)**.

It also reduces some avoidable failures: it spends less time searching memory,
gives timing-sensitive steps more bounded chances to succeed, accepts a valid
memory pattern the original rejected, and handles leftover temporary files
from interrupted runs. A free-space check that could reject exactly enough
space is fixed, and failures produce more useful diagnostics.

These changes improve compatibility and recovery, but the exploit is still
timing-sensitive. They are not a guarantee that every attempt—or every
console—will succeed.

The host now waits up to 3 minutes of inactivity for a native-bridge request
and up to 2 minutes for each console response after pairing. The initial
console greeting still has a 10-second limit. These longer waits can avoid
aborting a slow request that would work otherwise.

Runs two small native functions inside FS, checks their results, and restores the
original instructions. Switch 2 only; no npm install or compiler needed.

## Update history

Times below use UTC+08:00 (Asia/Taipei) and record when changes were committed
in this derivative. The base is
[kurumuz/ns2jb](https://gitlab.com/kurumuz/ns2jb) at `81d5bb1`.

### 2026-11-09 16:13 — game filesystem export command

- Add `dump-game.cjs` with `--exefs`, `--romfs` and `--both` for a completed
  held session, plus ExeFS storage/attribute selection.
- Export recursive directory trees with bounded, verified reads, per-file
  SHA-256, an NSO Build ID, progress records and an incomplete-on-failure journal.
- Refuse existing destinations and concurrent dump commands; stop native
  requests after uncertain failures and retain resource identities for diagnosis.
- Add offline coverage for streamed exports, directory pagination, stale proofs,
  malformed paths, incomplete reads and cleanup uncertainty. Hardware validation
  remains pending.

### 2026-11-09 15:25 — documentation cleanup

- Restore setup instructions to the top of the README and move integration
  details beside the code documentation.
- Reduce additional maintenance credit to one line and refresh the README
  checksum; runtime code is unchanged.

### 2026-11-09 15:13 — savekit integration and acquisition diagnostics

- Add CMIF/HIPC pointer descriptors and mounted-filesystem inspection for the
  [save toolkit](https://github.com/x43x61x69/ns2-savekit).
- Support selectable NCM storage and metadata/install types, plus repeated
  inventories in the same run.
- Report connection errors in bridge status and session initialization.
- Allow three initial pin-window attempts, 24 metadata move attempts by default
  (`NS2_METADATA_ATTEMPTS`), and a ten-minute pairing timeout by default
  (`NS2_PAIR_TIMEOUT_MS`).
- Preserve separate acquisition logs and a supervisor report; retry only after
  the same session proves cleanup with no retained resources, pending
  operations or cache restoration.
- Preserve worker identity and planned calls on timeout, save failure details
  before diagnostic RPC, and label event waits and signals. Planned calls do
  not establish which call was executing.
- Add acquisition/timeout regression tests and GitHub CI.

The native-batch hang remains unresolved. These changes improve diagnostics
and retry handling; they do not establish hardware reliability. Restart the
console when cleanup cannot be proven.

## Code

`run.cjs` is the host entrypoint. `engine/switch2/pipeline.cjs` contains the fixed
launch sequence; `engine/switch2/process/fs-execute.cjs` contains the FS demo.
The native helper and its source are in `engine/switch2/ro/payload/`.
Developers can reproduce it with Zig 0.15.2:
`node engine/build-payload.cjs --check --zig /path/to/zig`.

## Credits

Original ns2jb contributors are credited in the preserved GitLab history.
Toolkit integration patches originate from dougchansan/ns2-savekit.
Additional maintenance: [@x43x61x69](https://github.com/x43x61x69).
