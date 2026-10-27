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

`esp32:esp32` and `esp8266:esp8266` are **not** in the default Arduino index. Both firmware
workflows therefore run

```yaml
arduino-cli config init --overwrite || true
arduino-cli config add board_manager.additional_urls \
  https://espressif.github.io/arduino-esp32/package_esp32_index.json \
  https://arduino.esp8266.com/stable/package_esp8266com_index.json
arduino-cli core update-index
```

before installing a core. If that step is missing, the core install fails, every compile is
skipped (they are `continue-on-error`) and the run finishes with **no firmware binaries**:
the site is published, but every board page says "not built yet". A healthy run lists the
binaries under *Firmware binaries collected* in the job summary.

If the workflows already exist in `.github/workflows/` on the default branch, remember that
the automation token cannot update them - apply this change with an account/token that has
the `workflows` permission (or run `node tools/install-workflows.mjs` and commit the result).
