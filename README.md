# t3code-claude-sync

Two-way chat sync between the **Claude Code CLI** and the **T3 Code** desktop app,
driven by one small sync icon in T3's sidebar.

> Unofficial community mod. It is not affiliated with or supported by the T3 Code team.
> It patches the app bundle on your machine. Each T3 update replaces the patch, so
> re-run `apply.sh` after updating.

## What it does

| Direction | How |
|---|---|
| **Claude Code → T3** | Click the sync icon (left of **New thread** in the sidebar header). Chats you had in the `claude` CLI show up as T3 threads in the matching project. It also syncs on window focus and every 2 minutes. |
| **T3 → Claude Code** | Each Claude thread in T3 already is a Claude Code session in `~/.claude/projects/<folder>/`. Run `claude --resume` in the project folder, or **Option-click** the sync icon to copy `t3cc <threadId>` and paste it into a terminal. |

Both sides resume the **same** Claude session, so the agent has the full conversation
whichever side you continue on.

### How sync works

T3 already has a session importer (`agentSessions.scan` / `agentSessions.import`),
but you can only reach it from the welcome screen. The injected script calls those
RPCs over the app's own authenticated WebSocket. It doesn't need extra credentials,
open a port, or write to T3's database directly.

The stock importer has some problems, so `patch-asar.mjs` patches it:

- **One thread per session.** If you use several Claude profiles that share
  `~/.claude/projects` (for example with `cswitch`), stock T3 imports every chat once
  per profile.
- **No re-imports.** A session T3 already has as a thread is never imported again.
- **No junk.** Sessions with no real conversation (`/login`, `/recap`, no reply) are
  skipped.
- **Recent only.** Only sessions active in the last 14 days are imported
  (`RECENT_DAYS` in `patch-asar.mjs`).
- **Not settled.** Imported chats show as normal threads instead of being forced to
  "settled".

Every patch anchor has to match exactly once. If T3 changes that code, `apply.sh`
stops with an error and leaves the app untouched.

## Requirements

- macOS, T3 Code desktop (tested on `0.1.11-nightly.20261118`)
- Node.js 18+, `sqlite3` (both ship with macOS or Homebrew)
- Claude Code CLI (`claude`) on your `PATH`

## Install

```sh
git clone https://github.com/ridh21/t3code-claude-sync ~/.t3/mods/claude-sync
cd ~/.t3/mods/claude-sync
./apply.sh                 # quit T3 Code when asked; it relaunches patched
```

For a different build (for example stable instead of Nightly):

```sh
T3_APP="/Applications/T3 Code.app" ./apply.sh
```

`apply.sh` does the following:
1. Backs up the current `app.asar` to `backup/app.asar.<version>`, once per T3 version.
2. Injects `inject.js` into `apps/server/dist/client/index.html` and applies the
   importer patches. Every other file in the archive stays byte-for-byte identical.
3. Symlinks `bin/t3cc` into `~/.local/bin`.
4. Waits for T3 to quit, swaps in the patched `app.asar`, and relaunches it.

Re-running it is safe: it's idempotent and keeps other mods that patch `index.html`.

### Uninstall

```sh
./restore.sh               # puts the original app.asar back and removes t3cc
```

## Usage

- **Click** the sync icon to sync now. It spins while syncing, turns red if the last
  sync failed, and shows the last sync time on hover.
- **Option-click** it to copy the command that opens the current thread in the CLI.
- **`t3cc <threadId>`** opens a T3 thread in the Claude Code CLI, in the thread's
  folder or worktree.
- **`t3cc --print <threadId>`** prints that command instead of running it.
- **`t3cc list [dir]`** lists the T3 Claude threads for a folder.

To change the auto-sync interval, edit `AUTO_INTERVAL_MS` in `inject.js`, then
re-run `apply.sh`.

## Integrating this into T3 Code itself

Everything here is a workaround for three small gaps in T3. Natively it would look
like this:

1. **Expose the importer outside the welcome screen.** Add a "Sync Claude Code chats"
   action to the sidebar header or the project menu that calls the existing
   `agentSessions.import` RPC for that project.
2. **Fix the importer** (`apps/server/src/project/AgentSessionScanner.ts` and
   `AgentSessionImporter.ts`):
   - Key sessions by `provider + providerSessionId`, not
     `providerInstanceId + providerSessionId`, so profiles that share a Claude config
     don't create duplicates.
   - In `EventSink.write({ unlessNativeThreadOwned })`, look up ownership across all
     instances of the driver, and only among threads that aren't deleted.
   - Skip transcripts with no real user turn (only `<command-name>…` wrappers) or no
     assistant reply.
   - Don't set `settledOverride: "settled"` for recently active sessions.
3. **Refresh imported history.** Today a session is imported once. Turns you add later
   in the CLI reach the agent, because it resumes the same session, but they don't
   show up in T3's transcript. A native fix would re-read the transcript from its
   recorded byte offset and append the new turns.

PRs or issues upstream that adopt any of this are very welcome. Feel free to link
this repo.

## Files

| File | Purpose |
|---|---|
| `inject.js` | Renderer script: sync icon, RPC calls on the app's socket, auto-sync |
| `patch-asar.mjs` | Rewrites files inside `app.asar` (client HTML and importer fixes) |
| `apply.sh` / `restore.sh` | Install / uninstall, with a per-version backup |
| `bin/t3cc` | CLI helper that reads T3's DB read-only and runs `claude --resume` |

## License

MIT
