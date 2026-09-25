# The agent loop

These steps are written for an agent. Put them in the agent's instructions.

1. Finish the change. Run the tests.
2. Optionally, review your own change first: for each line you want to
   explain, run `revue comment <file>:<line> "..."`.
3. Say that the change is ready for review. The reviewer's browser follows
   the working tree, so there is nothing to open; when the reviewer needs a
   link, `revue url` prints one. Then end your turn.
4. When the human resumes you, run `revue feedback`. The output has every
   unresolved thread with the code it was written on, and the notes of the
   reviewer's sends you have not seen. A `stale:` line under a note means
   the code changed after that send: it does not approve the current diff.
5. If a comment needs an answer, run `revue reply <id> "..."`.
6. If the note or the comments ask for changes, change the code. The
   reviewer sees the new diff as you save. A thread whose code you changed
   goes outdated: it moves under its file's header, where the reviewer
   opens the code it was written on, or your change since, in one click.
7. Repeat from step 3 until the threads are resolved or the note says you
   are done. Never pass `--since`: the server knows what you have seen.
8. Commit when the note says so. A commit ends the round: the threads whose
   code it contains land, `feedback` lists them under `landed`, and the
   reviewer archives them from the page. `revue archive --landed` does the
   same from the terminal when the reviewer asks you to.

`revue wait --timeout 10m` is an alternative to step 4 for unattended runs. It
returns as soon as the reviewer sends. A send that lands while no `wait` is
active is not lost: the next `wait` or `feedback` returns it, once, on any
revue server for the repository.

The commands, their JSON output, and the exit codes are in
[cli.md](cli.md). Running the agent inside a container is covered in
[configuration.md](configuration.md).
