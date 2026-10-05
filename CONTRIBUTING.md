# Contributing to NomadVNC

Thanks for helping! Bug reports, fixes, docs improvements, and ideas are
all welcome.

## Reporting bugs and asking for features

Open an issue using one of the templates. For bugs, include your
platform and app version, the VNC server you connect to (macOS Screen
Sharing, TigerVNC, TightVNC, …), whether you're using Tailscale, and the
steps to reproduce. **Never paste passwords, Tailscale auth keys, or
account tokens** into an issue.

Security problems: please report them privately — see
[SECURITY.md](SECURITY.md).

## Making a change

1. Fork the repo and create a branch from `master`.
2. Set up the toolchain and build: [docs/development.md](docs/development.md).
3. Make your change, with tests for behaviour changes.
4. Before opening a pull request, run:
   ```bash
   pnpm turbo run typecheck
   pnpm turbo run test
   pnpm go:test
   ```
   For UI changes, include a screenshot (light and dark mode if the
   change affects colours).
5. Open the pull request with a short description of what changed and
   why. CI runs the same checks and builds installable packages you can
   try.

Keep pull requests focused — one fix or feature each. Commit messages
follow a light conventional style: `fix(desktop): …`, `feat(mobile): …`,
`docs: …`.

## Ground rules for changes

- **Local-first stays intact.** NomadVNC must remain fully usable with no
  account and no Tailscale sign-in, and must never start a Tailscale login
  or contact Tailscale on its own.
- **Secrets stay in secure storage.** VNC passwords, auth keys, and tokens
  never go into plain files, machine records, or logs.
- **Keep the desktop renderer sandboxed.** Privileged operations belong in
  the Electron main process behind validated IPC.
- Desktop and mobile should behave the same where it makes sense; if you
  change one, consider the other.

More conventions: [docs/development.md](docs/development.md#conventions).

## Code of conduct

Participation is covered by our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing you agree that your contributions are licensed under the
project's [Apache-2.0 license](LICENSE).
