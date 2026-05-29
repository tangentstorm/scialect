# Rebase & Merge Integration Guide

You have been authorized to integrate your branch into the `main` branch. This is the final step of your assignment!

Please follow this exact protocol:

## 1. Prepare and Rebase
- Fetch the latest changes from the origin: `git fetch origin main`
- Rebase your branch onto `origin/main`: `git rebase origin/main`
- If you encounter any conflicts during the rebase, resolve them using standard git conflict resolution tools, and then `git rebase --continue`.

## 2. Local Verification
Once the rebase is complete and your branch is fully updated, you must run all local continuous integration checks:
1. `lake exe cache get`
2. `lake build Jacobian.Solution` (must have no unexpected warnings)
3. `python3 scripts/blueprint_audit.py`
4. `python3 scripts/blueprint_graph_audit.py`

If any of these checks fail, you must fix the code, test again, and amend your commits as necessary until they pass.

## 3. Push and Pull Request
Once all local checks pass successfully:
1. Force push your branch to GitHub: `git push -u origin worker-jcX --force` (replace `worker-jcX` with your current branch name)
2. Use the GitHub CLI to create a Pull Request against the `main` branch: `gh pr create --title "Integrate worker-jcX" --body "Automated integration of worker-jcX." --base main`
   - *Note: if a pull request for this branch already exists, you do not need to create a new one.*

## 4. Final Status
Once the PR has been created and pushed, change your `.sci/status-line` file to:
`PR-AWAIT: PR created, waiting for CI`

Then remain idle. The manager will monitor the GitHub CI status and automatically merge the PR when it goes green.
