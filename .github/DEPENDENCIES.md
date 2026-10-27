# Dependency maintenance

Dependabot opens weekly review-first pull requests for the applicable manifests and GitHub Actions. There is no auto-merge. Keep existing SHA pins and review upstream changes before accepting updates.

The npm lockfile is audited for production and development at `--audit-level=low`: all known advisories block CI. The existing production-only MeetingBot gate is not weakened. Node 24 LTS is the tested runtime.
