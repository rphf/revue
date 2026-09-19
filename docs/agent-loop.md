# The agent loop

These steps are written for an agent. Put them in the agent's instructions.

1. Finish the change. Run the tests.
2. Run `revue open --no-browser --reuse main...HEAD`. The output has a `url`
   and a `cursor`.
3. Give the URL to the human. Then end your turn.
4. When the human resumes you, run `revue feedback --since <cursor>`. The
   output has the verdict and every thread with quoted code.
5. If a comment needs an answer, run `revue reply --thread <id> -m "..."`.
6. If the verdict is "request changes", change the code. Then run the same
   `revue open --reuse` command again, or `revue round`. Both add a round.
7. Repeat from step 3 until the verdict is "approve".

`revue wait --timeout 10m` is an alternative to step 4 for unattended runs. It
returns as soon as the reviewer submits. A submission that lands while no
`wait` is active is not lost: the next `wait` or `feedback` returns it.

The commands, their JSON output, and the exit codes are in
[cli.md](cli.md). Running the agent inside a container is covered in
[configuration.md](configuration.md).
