# YourBackupAgent

Backup kit for Dagan's Firebase projects (see README.md). Consumed by project
repos (foundation-next first, then your-content-creator, then others) through
`action.yml` and the `templates/backup-kit-wrapper.sh` wrapper, pinned to a tag.

- `kit/backup.sh` must stay bash 3.2 compatible (macOS) and project-agnostic:
  everything project-specific belongs in the project's `backup-kit/backup.env`.
- Before every push: `shellcheck -x -S warning kit/*.sh test/run.sh templates/*.sh`
  and `test/run.sh` (fake Google Cloud; must stay green).
- Offline tests prove logic only. Anything operational is proven by a real
  backup + rebuild drill run by Dagan; say which parts are proven how.
- Release = a new tag; never move an existing tag a project pins.
- Logs may be in public repos: print ids, counts, statuses, never data,
  emails or secret values.
