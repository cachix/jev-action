# Jev GitHub Action

Run [Jev](https://github.com/model-clis/jev) on a GitHub Actions event. The action installs a pinned Jev release, sends a typed request, and exposes Jev's JSON response to later workflow steps. It does not modify issues or pull requests itself; the workflow decides what to do with the answers.

## Choose an interface

Use one of these inputs per action step:

| Input | Use it when | Jev receives |
| --- | --- | --- |
| `labels` | You want one label chosen from repository labels. | A generated `choice` question named `label`, with the GitHub event as state. |
| `questions` | You want to define one or more Jev questions. | Your questions, with the GitHub event as state unless you set `state-file`. |
| `request-file` | You want to control the entire Jev request. | The file's `state` and `questions` exactly as provided. |

For label triage, `labels: repository` fetches every repository label and uses its description as a choice criterion. Use `labels: '["bug", "documentation", "needs-triage"]'` to fetch only those labels, or supply a JSON object to provide names and descriptions yourself. The chosen name is in `fromJSON(steps.<id>.outputs.response).answers.label.choice`.

For a custom question, pass Jev's question JSON directly. This example uses the event payload as state and fails the step if Jev judges that manual review is likely needed:

```yaml
- id: review
  uses: cachix/jev-action@v1
  with:
    api-key: ${{ secrets.JEV_API_KEY }}
    questions: |
      {
        "needs_review": {
          "type": "noul",
          "instructions": "Does this pull request need manual review?",
          "criteria": {
            "true": "Changes authentication, billing, or deployment",
            "false": "Routine content or tests"
          }
        }
      }
    assert: answers.needs_review.noul <= 0.5
```

For a complete request, pass `request-file` as shown below. You can also use `state-file` with either `labels` or `questions` to replace the event payload.

## Pull request label triage

Create a `JEV_API_KEY` repository secret, give your repository labels useful descriptions, and add this workflow to the default branch:

```yaml
name: Triage pull requests
on:
  pull_request_target:
    types: [opened, reopened, edited]

jobs:
  label:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - id: triage
        uses: cachix/jev-action@v1
        with:
          api-key: ${{ secrets.JEV_API_KEY }}
          github-token: ${{ github.token }}
          labels: repository
      - name: Apply label
        env:
          GH_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          LABEL: ${{ fromJSON(steps.triage.outputs.response).answers.label.choice }}
          AVAILABLE_LABELS: ${{ steps.triage.outputs.labels }}
        run: |
          jq -e --arg label "$LABEL" 'has($label)' <<< "$AVAILABLE_LABELS" >/dev/null
          gh api "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/labels" \
            -X POST -f "labels[]=$LABEL"
```

`pull_request_target` lets a base repository secret and a write token be used for fork PRs. Keep the workflow on the trusted base branch. Do not check out or execute code from the PR head in this job. Jev receives the event payload as data, including the PR title and body. See [GitHub's guidance on `pull_request_target`](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).

## Inputs and output

| Input | Meaning |
| --- | --- |
| `api-key` | Required. TypeSafe API key. |
| `github-token` | GitHub token for reading repository labels. Pass `${{ github.token }}` with `labels: repository` or a JSON array. |
| `labels` | `repository` to fetch all repository labels, a JSON array of names to use a selected subset, or a JSON object mapping names to descriptions. Creates a Jev `label` choice question. |
| `questions` | JSON object of Jev questions. Uses the GitHub event payload as state by default. |
| `state-file` | JSON file to use as state instead of the event payload. Requires `labels` or `questions`. |
| `request-file` | Complete Jev request JSON file. Cannot be combined with `labels`, `questions`, or `state-file`. |
| `assert` | Optional [Jev assertion](https://github.com/model-clis/jev#assertions-answers-to-exit-codes). A false assertion fails the action with exit code 3. |
| `version` | Jev release tag. Defaults to `v2026.919.0`; update this input to use another release. |

Set exactly one of `labels`, `questions`, or `request-file`. In `repository` and JSON array modes, the action fetches labels from the GitHub API using `github-token`, including pagination. The token needs `pull-requests: read` or `issues: read` permission; the example's `pull-requests: write` permission also permits reading. Labels with no description use their name as the Jev criterion. To limit the choices, pass an array such as `labels: '["bug", "documentation", "needs-triage"]'`. Include a fallback such as `needs-triage` if some events may not fit a specific label. For `state-file` and `request-file`, check out the trusted branch first if the file lives in the repository. The action supports Linux x86_64 and macOS arm64 runners. The example's label application step uses `jq` and `gh`, which are available on GitHub hosted Ubuntu runners.

The `response` output is a single-line JSON object. Access an answer with `fromJSON(steps.<id>.outputs.response).answers.<question-id>`. When `labels` is set, the `labels` output contains the JSON object of available choices, so later steps can check a chosen label before applying it. Jev's native nonzero exit codes fail the action. On an assertion failure, the response output remains available to steps using `if: failure()`.

Jev calls the TypeSafe API with the request state. Review which event fields or file contents you send before using the action with private data.

## Full request file

To control the entire request, commit a JSON file and pass it to `request-file`:

```yaml
- uses: actions/checkout@v4
- id: judge
  uses: cachix/jev-action@v1
  with:
    api-key: ${{ secrets.JEV_API_KEY }}
    request-file: .jev/review-request.json
    assert: answers.safe.noul >= 0.8
```

The file must follow [Jev's request format](https://github.com/model-clis/jev#login-and-usage). For event driven requests, use `questions` to include the event payload automatically.

For example, `.jev/review-request.json` could contain:

```json
{
  "state": { "change": "A deployment configuration change to review" },
  "questions": {
    "safe": {
      "type": "noul",
      "instructions": "Is this change safe to deploy?",
      "criteria": {
        "true": "No significant deployment risk",
        "false": "Needs human review before deployment"
      }
    }
  }
}
```

## Development

The action runs on Node.js 24. Its TypeScript source is in `src/`; `dist/` is compiled and committed so consumers do not need to install npm packages. To change the action, run `npm ci`, `npm run build`, and `npm test`, then commit the updated `dist/` files.

## License

Apache-2.0. See [LICENSE](LICENSE).
