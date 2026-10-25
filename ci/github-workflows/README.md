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
