# ControlDeck CI Gate

GitHub Action that runs a [ControlDeck](https://controldeck.dev)
workflow against a pull request and blocks merge on failure.

## Usage

```yaml
name: scan
on: pull_request

jobs:
  secrets-scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write  # only needed if `comment: true`
    steps:
      - uses: cogniumhq/ci-gate@v1
        with:
          workflow: secrets-scan
          token: ${{ secrets.CONTROLDECK_TOKEN }}
          comment: true
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `workflow` | yes | — | Workflow name defined in ControlDeck (e.g. `secrets-scan`) |
| `token` | yes | — | ControlDeck admin API key (`cdk_*`), issued in the Guardrails console |
| `branch` | no | `${{ github.ref_name }}` | Branch to scan |
| `api-url` | no | `https://api.controldeck.dev` | API base URL (override for staging) |
| `comment` | no | `false` | Post a summary comment on the PR |
| `timeout-minutes` | no | `10` | Overall wall-clock timeout |
| `github-token` | no | `${{ github.token }}` | Token for posting the PR comment |

## Outputs

| Output | Description |
|---|---|
| `status` | `done`, `failed`, `cancelled`, or `timeout` |
| `run-id` | ControlDeck run id (`run_*`) |
| `run-url` | Link to the run in the ControlDeck web app |
| `pr-url` | URL of the PR opened by the workflow's `@cognium/github` step, if any |

## Exit code

- `0` when the workflow reports `done`.
- `1` for any other outcome (`failed`, `cancelled`, `timeout`, or an
  unresolvable input).

## Setup

1. Install the ControlDeck GitHub App on your repo:
   [`app.controldeck.dev/connect-github`](https://app.controldeck.dev/connect-github).
2. In the Guardrails console → **API keys**, create an admin API key
   (`cdk_*`). Store it as a repo/org secret named `CONTROLDECK_TOKEN`.
3. Define the workflow you want to run under **Workflows** in the
   ControlDeck web app.
4. Add the snippet above to `.github/workflows/`.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build     # regenerates dist/index.js
```

`dist/` is checked into the repo. CI verifies it's fresh; commit a
rebuild alongside any change under `src/`.

## License

MIT. See [LICENSE](./LICENSE).
