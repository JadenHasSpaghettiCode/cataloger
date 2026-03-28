cataloger is a bun cli tool for turborepos using workspaces it scans for shared dependencies and moves them into the root catalog in package.json so version control is less annoying.

`bun install` then `bun link` and run `cataloger sync` from your repo root

use `--dry-run` if you just want to see what it would change.
use `--yes` if you don't want to be asked questions.
