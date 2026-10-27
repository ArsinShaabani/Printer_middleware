# GitHub Actions workflows

These are the canonical CI workflows for this project:

| file | what it does |
| --- | --- |
| `test.yml` | runs the unit tests (`npm test`) and the catalog validation on every push and pull request |
| `deploy-pages.yml` | builds the web assets + manifests, compiles every board/variant pair, publishes the installer site to GitHub Pages |
| `build-firmware.yml` | compiles the same matrix and attaches the binaries to a GitHub release on tag pushes |

## Why are they here and not in .github/workflows?

The automated agent credentials used to prepare this branch are a GitHub App without the
`workflows` permission, so GitHub refuses to create `.github/workflows/*` from this branch.
The files are kept here (and are complete and ready to run) so nothing is lost.

## Enable them

```bash
# copy them into place and commit with a token/account that has the workflows permission
node tools/install-workflows.mjs
```

or manually:

```bash
mkdir -p .github/workflows
cp ci/github-workflows/*.yml .github/workflows/
git add .github/workflows && git commit -m 'ci: enable the workflows' && git push
```

After that, enable **Settings → Pages → Source: GitHub Actions** once and the installer site
(including the browser flashing page) is published on every push to `main`.

## Important: the board-manager URLs

`esp32:esp32` and `esp8266:esp8266` are **not** in the default Arduino index, so a plain
`arduino-cli core install` on a workstation fails unless the URLs are registered first. Both
firmware workflows therefore run

```yaml
arduino-cli config init --overwrite || true
arduino-cli config add board_manager.additional_urls \
  https://espressif.github.io/arduino-esp32/package_esp32_index.json \
  https://arduino.esp8266.com/stable/package_esp8266com_index.json
arduino-cli core update-index
```

before installing a core. GitHub's runner image already resolves `esp32:esp32` on its own, so this
step is about determinism (other runners, other `arduino-cli` versions) rather than being the
reason a build fails.

**A green run does not mean the firmware was built.** The compile steps are `continue-on-error`,
so a sketch that does not compile still ends with a green run - it simply uploads no artifacts.
Always read the job summary: it must list the binaries under *Firmware binaries collected*.

If the firmware is missing, open a *Compile …* job and look for `error:`. The fastest way to catch
that class of problem before pushing is

```bash
npm run check:firmware   # includes firmware/tools/check-syntax.mjs
```

which compiles the core-independent translation units with your local C++ compiler against a small
Arduino stub. (Balanced braces and resolvable includes are not enough: three real type errors
slipped through `check-sources.mjs` and only appeared in CI.)
