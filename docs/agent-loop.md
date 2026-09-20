# The agent loop

These steps are written for an agent. Put them in the agent's instructions.

1. Finish the change. Run the tests.
2. Say that the change is ready for review. The reviewer's browser follows
   the working tree, so there is nothing to open; when the reviewer needs a
   link, `revue url` prints one. Then end your turn.
3. When the human resumes you, run `revue feedback`. The output has every
   unresolved thread with the code it was written on, the note of the
   reviewer's last send, and a `cursor`.
4. If a comment needs an answer, run `revue reply --thread <id> -m "..."`.
5. If the note or the comments ask for changes, change the code. The
   reviewer sees the new diff as you save. A thread whose code you changed
   shows as outdated on their side, with the old code one click away.
6. Repeat from step 2 until the threads are resolved or the note says you
   are done. `revue feedback --since <cursor>` lists only what happened since.

`revue wait --timeout 10m` is an alternative to step 3 for unattended runs. It
returns as soon as the reviewer sends. A send that lands while no `wait` is
active is not lost: the next `wait` or `feedback` returns it.

The commands, their JSON output, and the exit codes are in
[cli.md](cli.md). Running the agent inside a container is covered in
[configuration.md](configuration.md).
