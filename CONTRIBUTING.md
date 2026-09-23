# Contributing to Editkin

Thank you for improving Editkin. Open an issue first for a large feature or architecture change. A small bug fix can go directly to a pull request.

## Before opening a pull request

1. Use a focused branch and explain the behavior, platform, and affected user journey.
2. Run `npm ci`, `npm test`, and `npm run build` from a clean checkout. Include the results and any relevant native checks in the pull request.
3. For import, edit, preview, save/reopen, or export changes, add a small redistributable fixture and describe the observed result. Review the decoded output when visual behavior changes.
4. List new dependencies, licenses, external services, data access, and permissions. Do not include private footage, paid assets, account data, credentials, local user paths, model weights without redistribution rights, or opaque executables.
5. Sign off every commit with `git commit -s`. The `Signed-off-by:` trailer states that you have the right to submit the contribution under the repository license, as described by the [Developer Certificate of Origin](https://developercertificate.org/).

Do not paste vulnerability details into a public issue. Follow [SECURITY.md](SECURITY.md). Reviewers may ask for a smaller change, further tests, provenance, or a different design. Maintainers control merges and official releases.

Code contributions are under GPL-3.0-or-later unless a file carries a different compatible notice. The DCO does not transfer your copyright and does not grant a separate proprietary relicensing right. Keep third-party notices with any materials you add.
