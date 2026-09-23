# Install

Each release ships one archive per platform: `revue_<os>_<arch>.tar.gz` with a
single `revue` binary inside, plus `checksums.txt`. The asset names do not
change between versions, so the `latest` URL works in a Dockerfile.

```sh
# Linux (Debian names amd64 and arm64 match the archive names)
ARCH="$(dpkg --print-architecture)"
curl -fsSL "https://github.com/rphf/revue/releases/latest/download/revue_linux_${ARCH}.tar.gz" \
  | tar -xz -C /usr/local/bin revue

# macOS
ARCH="$(uname -m | sed 's/x86_64/amd64/')"
curl -fsSL "https://github.com/rphf/revue/releases/latest/download/revue_darwin_${ARCH}.tar.gz" \
  | tar -xz -C ~/.local/bin revue
```

If the repository is private for you, download with the GitHub CLI instead:
`gh release download -R rphf/revue -p 'revue_linux_arm64.tar.gz'`.

To upgrade later, run `revue update`. It replaces the binary where it is and
restarts the running servers on the new version. It needs write access to the
binary's directory, so for `/usr/local/bin` run it as the owner of that
directory.

To build from source, see [development.md](development.md).
