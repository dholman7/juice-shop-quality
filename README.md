# Juice Shop quality: proof of concept

Playwright + TypeScript suite for the top 3 risks in the case-study strategy, a failure-triage agent whose output a person reviews before anything is filed, and an OWASP ZAP baseline scan.

| | |
|:--|:--|
| Risk areas covered | R1 Customer data isolation · R2 Checkout and payment · R3 Login and account security |
| REST endpoints in those areas | 68; 66 called as every role (anonymous, customer, deluxe, accounting, admin), 2 skip staff roles for a [stated reason](#coverage-map) |
| Tests | 532 (492 API, 40 UI) in about a minute, against 38 minutes for the old 60-test UI suite |
| Extra piece (step 2) | Failure-triage agent with a human review gate |
| Human review | `yarn review`: one local page where a tester decides each failure group, bug severity, and scan finding. Nothing is filed without their name. |
| Security scan | OWASP ZAP baseline (passive) on every run; medium and high findings fail the run until a person decides on them |
| Latest report | [dholman7.github.io/juice-shop-quality](https://dholman7.github.io/juice-shop-quality/), published by CI from `main` and nightly |

**How a team would use it.** This repo can stay central. A squad's pull request triggers the tests its change touches (by risk-area tag or endpoint) and gets the results back on that pull request, so testing never waits for release time. Moving tests next to the product code is an option, not a requirement.

## Run it

### 1. Set up (once)

Needs Docker (running), Node (version in `.nvmrc`), and Yarn 1 (`corepack enable` provides the version in `package.json`).

```bash
git clone https://github.com/dholman7/juice-shop-quality.git
cd juice-shop-quality
corepack enable
yarn install --frozen-lockfile
yarn playwright install chromium
```

### 2. See the review work: demo mode

The repo holds a finished review (26 approved bugs), so a normal run has nothing left to decide. Demo mode copies that review into `.demo/` (git-ignored), undoes five decisions, and never changes the committed files. The dashboard keeps CI's real run history ([`demo/history.json`](demo/history.json)).

```bash
yarn demo
yarn demo:review
```

1. `yarn demo` runs everything (about two minutes; the first run also downloads the Juice Shop and ZAP images). Open `reports/index.html`: 6 new failures in 3 groups, 69 tests on open bugs, and the trend across past runs.
2. `yarn demo:review` opens the review page at `http://127.0.0.1:4321`. Enter your name and decide the five items, one per feature:

   | Item | What to do |
   |:--|:--|
   | BUG-010's severity doesn't match its score | **Set to high**, or change the scores with a reason |
   | `DELETE /api/BasketItems/:id` on another customer's item | Pick the suggested duplicate, BUG-001 |
   | The password change response returns the password hash | No suggestion: search `hash`, pick BUG-008 |
   | An address with an invalid name is accepted | **A new bug**: a Jira key (e.g. `SHOP-240`), a title, impact and likelihood |
   | ZAP: wildcard CORS header | Dismiss with a reason, or file it as a bug |

3. `yarn demo:rerun` runs again with your decisions: those tests now count as open bugs, not new failures. Stop the page with Ctrl+C first.

`yarn demo` again starts over. The page's **Save the review** section explains what it would commit; in demo mode it commits nothing.

### 3. Run it for real

```bash
yarn all
yarn review
```

`yarn all` starts a fresh Juice Shop container, runs the ZAP baseline scan, runs every test, asks the triage agent to propose a cause for each new failure, and writes:

- `reports/index.html`: the dashboard: summary, progress against the strategy's day-90 measures with a trend across runs, triage proposals waiting for review, open bugs, and the endpoint-by-role coverage grid (hover or tap a cell to see its tests and their results)
- `reports/zap/zap.html`: ZAP's own report of the scan
- `reports/history.json`: one summary per run; CI carries it forward between published runs, so the trend survives
- `reports/playwright/index.html`: every test with traces and screenshots for failures
- `docs/coverage.md`: the coverage map, regenerated from the run

It exits non-zero if any test fails that is not an approved open bug, if an approved bug's test starts passing, if the scan raises a medium or high finding nobody has decided on, or if a bug's severity doesn't match its impact × likelihood score. It takes about two minutes.

`yarn review` opens the same review page on the committed state. Its decisions go into `known-bugs.json`, `triage/decisions.jsonl`, and `security/zap-findings.json`. When done, **Save the review** commits only those files (and `docs/coverage.md`), with your name in a `Reviewed-by:` line, on the current branch, and can push. No git commands needed; see [the triage agent](#why-the-triage-agent-step-2).

**In CI** ([`tests.yml`](.github/workflows/tests.yml)): every pull request, push to `main`, and nightly run (07:00 UTC) runs the typecheck, unit tests, and `yarn all`, and uploads the report as a build artifact. Runs on `main` also publish it to GitHub Pages, carrying `history.json` forward so the trend builds without a database.

| Command | What it does |
|:--|:--|
| `yarn demo`, `demo:review`, `demo:rerun` | Demo mode: the committed review with five decisions undone, in `.demo/`, with CI's run history; the committed files are untouched |
| `yarn review` | **The review, on a local web page** (opens `http://127.0.0.1:4321`): severity check, failure groups, and scan findings, with the same rules and files as the terminal reviews below. Stop with Ctrl+C. |
| `yarn app:up` / `app:down` | Fresh Juice Shop with per-worker staff test accounts / remove it |
| `yarn test`, `yarn test:api`, `yarn test:ui` | Playwright only, against the running app |
| `yarn playwright test --grep @R1` | One risk area's tests, API and UI (`@R1`, `@R2`, `@R3`); every test carries its endpoint's area tag |
| `yarn security:zap` | ZAP baseline scan of the running app only |
| `REVIEWER="Your Name" yarn security:review` | A person files each new medium or high finding as a bug, or dismisses it with a reason |
| `SKIP_ZAP=1 yarn all` | Everything except the scan |
| `yarn triage` | Propose a cause for each failure group (offline rules) |
| `TRIAGE_PROVIDER=claude yarn triage` | Same, classified by Claude through the local `claude` CLI |
| `REVIEWER="Your Name" yarn triage:review` | A person accepts, changes, or rejects each group. The screen shows the rule being tested, the likely cause, quoted evidence, and severity. |
| `REVIEWER="Your Name" yarn triage:rate` | A person changes an open bug's impact and likelihood scores with a reason; the severity follows, and the change is kept on the bug and shown in the report |
| `yarn report`, `yarn coverage:map` | Rebuild the report or coverage map from the last run |
| `yarn test:unit` | Unit tests for triage (redaction, rules, validation, grouping, duplicate suggestions, bug filing, Jira keys, severity scoring), run history, the software passkey, and the scan gate |

> [!IMPORTANT]
> Only run this against your own local container. The security checks send attack payloads (SQL injection, forged tokens).

## How the suite is built

- **One catalog, generated tests.** [`src/catalog.ts`](src/catalog.ts) lists every endpoint in the 3 areas with who should be allowed to call it. That is the product's intended policy, not what Juice Shop does today. [`access-matrix.spec.ts`](tests/api/access-matrix.spec.ts) sends a valid request for each endpoint as each role ([`src/probes.ts`](src/probes.ts)). Allowed roles must succeed and every other role must be refused.
- **Isolation tests for the basket leak.** [`isolation.spec.ts`](tests/api/isolation.spec.ts) creates a victim customer and attempts every owner-only action on their records as every role. It checks the response *and* re-reads the victim's data as the victim, so a "refused" status that still changed data fails.
- **Behavior tests** for each area check totals, limits, coupons, wallet, 2FA, and password flows ([`customer-data`](tests/api/customer-data.spec.ts), [`checkout`](tests/api/checkout.spec.ts), [`auth`](tests/api/auth.spec.ts)). **UI tests** cover the same flows through the real pages ([`tests/ui`](tests/ui)).
- **No shared state.** Every customer and deluxe test registers its own account. Staff roles get one admin and one accounting account per Playwright worker, seeded when the container starts ([`scripts/juice-shop.ts`](scripts/juice-shop.ts)). Shared seed accounts were the first source of flakiness I hit (see below).
- **Bugs fail, and stay visible.** Juice Shop's security flaws are treated as real bugs, so assertions state the correct behavior and those tests fail. Once a person approves a failure as a product bug, it goes into [`known-bugs.json`](known-bugs.json). The test then runs as an *expected* failure, with the assertion unchanged. If the bug is fixed, the test passes, Playwright flags the unexpected pass, and the entry must be removed. `IGNORE_KNOWN_BUGS=1` shows the raw failures. A green run means no *new* failures; it is not a release decision. An open critical bug is a no-go unless the QA manager accepts it by name.
- **Test environment config.** The container turns off Juice Shop's training pop-ups (solved-challenge toasts, tutorial, welcome banner), which cover buttons and make UI tests flaky. Product behavior is unchanged.

## Coverage map

Full grid: [`docs/coverage.md`](docs/coverage.md), regenerated each run from test annotations, so it cannot claim coverage a test does not have.

| Area | Endpoints | API tests | UI flows |
|:--|--:|:--|:--|
| R1 Customer data isolation | 24 | Role matrix; cross-customer isolation for baskets, items, addresses, cards, user records; lists only show own records; basket limits and stock; address and card validation; card masking; data export | Basket quantity and remove (customer, deluxe); save address and card (all signed-in roles); order history; admin page (admin sees users, others refused) |
| R2 Checkout and payment | 21 | Role matrix; checkout totals (list and deluxe price, delivery); basket emptied; stock reduced; empty or incomplete orders refused; coupons; wallet top-up and payment; deluxe purchase; accounting order list and delivery status; product price changes | Checkout with card (customer, deluxe); deluxe price shown; coupon valid and invalid; wallet top-up; buy deluxe; track order (anonymous, customer); accounting marks delivered; no accounting page for other roles |
| R3 Login and account security | 23 | Role matrix; sign-up rules; login errors, SQL injection, rate limit, unsigned tokens; password hash never returned; 2FA setup, login, wrong code, disable; passkey sign-in, wrong-key signature, credential hijack (software authenticator); password change and reset; security answers | Register; log in (every role); wrong password; log out; change password (customer, deluxe); forgot password; 2FA setup and 2FA login |

Not run, with the reason recorded in the catalog note:

- **2FA setup and disable as staff:** later tests on the same worker sign in with that staff account, and 2FA would lock them out. A dedicated staff account per 2FA test would close this.
- **Stock updates:** limited to an office IP allow-list, so every caller from a test machine is refused.
- **Basket and checkout pages as staff:** the pages are the same for every signed-in role, so the UI runs them as customer and deluxe. All five roles are covered at the API layer.

## What the suite found

Each item below is a failing test today, unless noted. Severity is impact × likelihood, scored per finding.

| Area | Finding | Severity |
|:--|:--|:--|
| R1 | Any signed-in user can read any customer's basket by id (`GET /rest/basket/:id`). This is the production incident. | Critical |
| R1 | Any signed-in user can list, read, change, and delete other customers' basket items | Critical |
| R1 | Sending `BasketId` twice adds items to another customer's basket | High |
| R1 | Updating another customer's address succeeds and moves it to the caller's account | Critical |
| R1 | Any signed-in user can read any user record and the full user list, including login details | Critical |
| R1 | Saving a card echoes the full card number | High |
| R1 | Zero and negative quantities are accepted, producing negative order totals | High |
| R1 | The data export CAPTCHA returns its own answer, and is skipped if never requested | Medium |
| R1 | An address with no name is accepted | Low |
| R2 | Anyone, even without logging in, can change a product's price | Critical |
| R2 | Any signed-in user can apply a coupon to, or check out, another customer's basket | Critical |
| R2 | Non-admins can create products | High |
| R2 | Checkout accepts an empty basket and orders with no address or payment | High |
| R2 | Negative wallet top-ups and deluxe membership without payment are accepted | High |
| R2 | The token issued at deluxe upgrade cannot use the basket (401) until the customer logs in again | Medium |
| R2 | Coupons are an encoding, not a signature: anyone who knows the format can make one (found while writing the coupon helper; not a test) | High |
| R3 | SQL injection in the login email logs in as admin | Critical |
| R3 | Sign-up accepts `role: admin` | Critical |
| R3 | Unsigned session tokens (`alg: none`) are accepted | Critical |
| R3 | Passkey sign-in ignores the signature: anyone with a credential id signs in as its owner | Critical |
| R3 | Registering a credential id that belongs to another account replaces its key, taking over that passkey | Critical |
| R3 | The password hash is in the session token and in three API responses | High |
| R3 | Changing the password does not require the current one | High |
| R3 | No rate limit on wrong passwords | High |
| R3 | Sign-up accepts mismatched passwords; some unauthenticated calls return 500 instead of 401 | Low |
| R3 | The 2FA settings page sends "Save" without its setup token if clicked before the QR code loads (found while chasing a flaky test; not a test) | Low |

## Why the triage agent (step 2)

The brief's numbers point at triage. The old suite failed 1 run in 5 for no clear reason, so the team ignored it. A suite that finds 75 failures on its first run is ignored just as fast unless someone sorts them. Sorting is the job testers do by hand today, and it is where their time goes.

The agent turns 75 failing tests into 41 groups, each with a proposed cause (product bug, test bug, environment, flaky, or needs a person) and a quote from the failure as evidence. A tester reviews groups, not tests.

The authorization checks the brief also lists come with the functional suite, since basket access is risk #1. A [ZAP baseline scan](#security-scan) is added as well: security had no coverage, and a passive scan is safe on every run. A k6 load test is not: numbers from one laptop do not predict a sales event, so it waits for a production-like environment.

How it works ([`triage/`](triage)):

1. [`collect.ts`](triage/collect.ts) reads the Playwright JSON report and keeps new failures and flaky passes. Approved bugs are already decided and skipped.
2. [`redact.ts`](triage/redact.ts) strips tokens, emails, password hashes, card numbers, and secrets before any text leaves the machine.
3. Failures that share an endpoint and an error signature form one group (the same defect seen by 4 roles is one decision).
4. A provider proposes a likely cause:
   - **`heuristic`** (default, offline): deterministic rules. It is the baseline and the fallback.
   - **`claude`**: Claude through the local `claude` CLI, with a JSON schema for the answer. In CI it would call the Claude API with a key from the pipeline's secret store.
   - The model sees the first failure in the group (12 redacted lines) and the endpoint's access rule, not the test source or the trace. A team version would add both.
5. [`model.ts`](triage/model.ts) validates every model answer: the evidence must be a verbatim quote from the failure text, and "flaky" requires a retry that passed. If either check fails, the answer drops to `needs-human`. The model never gets the final say.
6. `yarn review` (a local web page) or `yarn triage:review` (the terminal) shows each group to a person: accept, change the likely cause, reject, or skip. For an accepted product bug, [`duplicates.ts`](triage/duplicates.ts) lists up to three open bugs it may duplicate, each with the reason (same endpoint, same records, similar title), so the reviewer picks a number instead of remembering bug ids. Typing a word searches open bug titles. A new bug needs the Jira key it is reported in; a key already on file adds the group to that bug. Only accepted product bugs reach `known-bugs.json`, with the Jira key, the reviewer's name, the date, and impact and likelihood scores (1–5). Severity is computed from them: risk = impact × likelihood, 20+ critical, 12+ high, 6+ medium, else low. Review starts with any bug whose severity doesn't match its score; `yarn all` stays red until it does. Every decision is logged in `triage/decisions.jsonl`.

**First real run (73 failures, 39 groups), Claude (Haiku) against the rules on the same groups:**

- They agreed on 31.
- Claude sent the other 8 to a person. All 8 are business-rule expectations, such as "an empty basket can't be checked out" or "a quantity of 0 is refused", which the failure text alone cannot prove. That is the caution the prompt asks for, and it shows where a tester's judgment is needed.
- One answer's reasoning was literally "Placeholder; to be replaced after reading the test source." Validation now rejects unfinished reasoning, and a unit test pins that exact answer.

Agreement is not accuracy: neither side is ground truth. Accuracy needs a labeled set (see [Next steps](#next-steps)).

## Security scan

[`security/zap.ts`](security/zap.ts) runs an [OWASP ZAP](https://www.zaproxy.org/) baseline scan in `yarn all`, on the fresh app before the tests change its data.

- **Passive only:** ZAP spiders the app for a minute and checks responses (headers, cookies, CORS, information leaks). No attack traffic.
- **Local only:** ZAP runs inside the Juice Shop container's network, so `localhost:3000` is the only target it can reach.
- **Pinned:** ZAP 2.17.0 by image digest, so every run uses the same rules.
- **Gate:** medium and high findings fail the run until a person, in `yarn review` or `yarn security:review`, files each as a bug or dismisses it with a reason. Decisions go in [`security/zap-findings.json`](security/zap-findings.json) with name and date, the same gate as `known-bugs.json`. Low and informational findings are listed, never gating.
- The report's security section shows every finding and its decision, and links ZAP's own report.

First scan (2 medium, 4 low, 3 informational):

| Risk | Finding | Seen on |
|:--|:--|:--|
| Medium | No Content-Security-Policy header | Home page, `/ftp` files, `sitemap.xml` |
| Medium | `Access-Control-Allow-Origin: *` | Home page, scripts, styles, assets |
| Low | Cross-Origin-Embedder-Policy and Cross-Origin-Opener-Policy missing; deprecated `Feature-Policy` header | Pages and scripts |
| Low | `bypassSecurityTrustHtml` (Angular's HTML sanitizer bypass) in the bundled JS | `main.js` and one chunk |

The baseline sees only what an anonymous spider reaches. The access, injection, and token bugs above come from the targeted tests, not from ZAP.

## What the AI produced that I changed or rejected

Built with Claude Code. Most of the AI's mistakes surfaced the same way: run the tests, then check each failure against the actual response, trace, or Juice Shop source before calling it a product bug. Nothing was labeled a bug on the AI's word.

| What the AI produced | What was wrong | What I did |
|:--|:--|:--|
| Deluxe test fixture that used the token returned by the upgrade call | That token has no basket id, so every deluxe basket call failed with 401. It looked like 15 product bugs. | Fixture logs in again after upgrading. Kept a separate test for the token problem, which is a real bug. |
| Staff tests using the shared admin and accounting seed accounts | Parallel tests collided: duplicate basket items (500s) and one test's checkout emptying another's basket. That is the old suite's flakiness, recreated. | Seeded one admin and one accounting account per worker at container start. |
| Expected `400` from a malformed passkey verify call, and "any failed ceremony returns 401 by design" | Half true: 401 only for an unknown credential. Reading the route source showed a bad signature on a real credential still signs in. | Tested with a software authenticator instead of guessing (below). |
| Passkey verify skipped for 9 role checks: "needs a real authenticator" | I rejected the skip. A software authenticator (real key pair, real signatures; only the hardware is simulated) runs Juice Shop's own verification. | All 30 passkey role checks run; it found two critical bugs (sign-in without a valid signature, credential hijack). Unit tests check its signatures with Node's crypto, independent of Juice Shop. |
| Forged passkey test sent its payload as `response` | The route reads `assertion`, so the request was refused before any passkey check. The test passed and tested nothing. | Sends a real assertion; separate tests for unknown credential, wrong key, and hijack. |
| A test that a "99% off" coupon is refused | It encoded a business rule nobody gave us. | Removed it; reported coupon forgery as a finding instead. |
| Data export probe that sent no CAPTCHA and passed | It passed only because of a bug (the CAPTCHA is skipped if never requested). | Probe now follows the real page flow; the bypass is its own failing test. |
| Address UI test that opened the form URL directly | The form goes "back" after saving, which left the app. Not a product bug. | Test starts from the saved-address list, as a customer does. |
| 2FA UI test with a comment that the page reuses the API's secret | Each status call issues a new secret, so the code never matched. | Test reads the secret from the page's own response. |
| First fix for the remaining 2FA flake (wait out the 30-second code window) | Wrong diagnosis: still failed 1 in 8. Capturing the request showed it had no setup token. | Test now waits for the QR code, as a person would. The race is logged as a low-severity bug. |
| Admin UI test asserting `email.toContain('@test.local')` | A check on test data, not the page. It could never fail. | Replaced with a check that the page lists customers. |
| That replacement waited only for the page heading, with the default 5 s | Flaked in CI: the user data arrived in about 1 s, but by the end of a run the page renders several hundred accounts (208 KB), and the rows appeared after 5 s. The trace's failure screenshot showed them already there. | Waits for the user-list response, then allows 15 s to render; the assertion is unchanged. Caught by the dashboard's "runs failing for reasons other than a product bug" measure on its first CI run. |
| Triage evidence quoting only `Expected: 400` | Not enough for a reviewer to decide. | Evidence now quotes the expected and received pair. |
| A model triage answer with the reasoning "Placeholder; to be replaced after reading the test source." | The answer was unfinished, and the validation let it through. | Validation rejects unfinished reasoning; a unit test uses that exact answer. |
| Review screen that labeled the agent's guess `proposal:` with bare category names | I was the reviewer and couldn't tell what I was approving: no rule stated, no meaning for each category, severity mixed in. | Shows the rule under test in plain words, "likely cause" with a legend of what each one triggers, and severity separately. |
| Coverage grid tooltips: native `title` text such as "3 test(s); failed" | They appeared only after a delay and never on touch, so the live page showed nothing on hover. When they did show, they read as "3 tests failed" when only 1 had. | Each cell lists its tests and each one's result, on hover, tap, or keyboard focus. |
| Report's by-area table, which read the risk area from test titles | UI test titles don't name an area, so all 40 UI tests were silently missing from it. Found by a review pass over the code. | Falls back to the area of the endpoint the test covers; every test is now counted. |
| Reason in this README for not adding ZAP: "ZAP finds generic issues that the targeted tests already cover" | Wrong once tested: the first scan found a missing Content-Security-Policy and a wildcard CORS header, which no targeted test checks. | Added the [baseline scan](#security-scan) with the same human gate as known bugs. |
| README summary of the scan's low findings as "`eval`-style functions in bundled JS" | The scan's evidence is `bypassSecurityTrustHtml`, Angular's sanitizer bypass, not `eval`. | Rewrote the row from the evidence in `zap.json`. |
| Duplicate-bug suggestions for the review screen, matching on same endpoint and title word overlap | Replayed on the 41 real groups, it offered suggestions for 23, mostly noise: role names and template words made `GET /api/Users` look 75% like `GET /api/BasketItems`. | Compare content words only, need two shared words, and give endpoint matches weight only when both are access checks. Replayed again: 9 suggestions, covering every finding this README groups together. Each rule has a unit test. The real review merged 15 groups into existing bugs; replayed in order, the check suggested the right bug for 5, with 4 wrong suggestions. Counting any shared endpoint found 8 but made 17 wrong. Most misses are a known defect on a new endpoint, which matching can't see, so review also searches bug titles. |
| Password change and reset tests that also checked for the password hash | The hash check ran first. Once the hash bug was registered, the whole test became an expected failure, so a broken change or reset would go unseen. | Hash checks moved to their own tests with the same assertion. The change and reset tests now pass on their own. |
| Review CLI that filed each bug under its endpoint's risk area | Reviewing the first 41 groups filed "unsigned tokens", an R3 login test that probes a basket endpoint, as R1. The report already used the test's own area, so the two disagreed. | The CLI takes the test's own area first, matching the report. |
| Severity picked by hand at review, apart from the strategy's impact × likelihood | Scoring all 26 bugs afterwards, 3 didn't match their score: readable user records were rated high but score 25, critical. | Each bug stores both scores and its severity is computed. `yarn all` fails on a mismatch, and review starts with any. |
| Triage rule: 502, 503, or 504 anywhere in the error means the app was down | It matched file paths and line numbers. Under a folder named `claude-502`, real product bugs were proposed as "environment". | Stack and code-frame lines are left out of that check; a unit test pins the case. |
| Terminal prompts as the tester's review tool | Too much for a manual tester. My own review hit two bugs: a mistyped key skipped a bug and the review exited as if it had crashed, and an extra argument crashed `yarn all`. | Both fixed. `yarn review` puts the same review on one local page, writing the same files through the same code. |
| Review page cards built from nested lists, and redrawn on every decision | Found by driving the demo in a browser: suggested duplicates showed as "[object HTMLLabelElement]", and a search typed in one card vanished when another card was decided. | Lists flatten fully, and cards persist between redraws; the browser run now types in one card, decides two others, then uses the search. |

## Secrets

No keys are in the repo. The staff test accounts are created inside a disposable local container. The Claude provider uses the developer's own `claude` login.

In a shared pipeline:

- the model API key and any staff test credentials live in the CI secret store (GitHub Actions secrets, or a vault for longer-lived environments);
- they are injected as environment variables at run time;
- they are never printed, because the redaction step runs before any failure text leaves the job.

## Next steps

- **Host the review page as a team app.** A static frontend with a small backend: single sign-on (the reviewer is the signed-in user, not a typed name), Jira tickets created from the page, and approvals posted as pull-request reviews on GitHub or Bitbucket. A database keeps triage runs, decisions, and scores, so agent agreement and time to decide are tracked over time. Approved bugs still reach `known-bugs.json` through a pull request the app opens, so CI reads git and never depends on the app being up.
- Confirm three assumed rules with the product owner: a 429 within 20 wrong passwords, an address needs a name, and admins can't read customer baskets through the customer API.
- **Evaluate triage against labeled failures.** Reviewed decisions plus deliberately broken tests, outages, and planted races give known causes. Score accuracy per category, product-bug precision, and confident-but-wrong answers with confidence intervals, on a frozen held-out split, replayed keyless in CI. Same method as [agent-eval-gate](https://github.com/dholman7/agent-eval-gate).
- Authenticated and active ZAP scans nightly on staging; the baseline sees only what an anonymous spider reaches.
- k6 checkout load tests with pass/fail thresholds in a production-like environment.
- Extend the catalog to the next risk areas: file upload and complaints, product reviews, and admin functions.
