# Juice Shop quality: proof of concept

Playwright + TypeScript suite for the top 3 risks in the case-study strategy, plus a failure-triage agent whose output a person reviews before anything is filed.

| | |
|:--|:--|
| Risk areas covered | R1 Customer data isolation · R2 Checkout and payment · R3 Login and account security |
| REST endpoints in those areas | 68; 64 called as every role (anonymous, customer, deluxe, accounting, admin), 4 skip a role for a [stated reason](#coverage-map) |
| Tests | 527 (487 API, 40 UI) in about 55 seconds, against 38 minutes for the old 60-test UI suite |
| Extra piece (step 2) | Failure-triage agent with a human review gate |
| Latest report | [dholman7.github.io/juice-shop-quality](https://dholman7.github.io/juice-shop-quality/), published by CI from `main` and nightly |

## Run it

Needs Docker, Node (version in `.nvmrc`), and Yarn 1 (version in `package.json` → `packageManager`; `corepack enable` provides it).

```bash
yarn install --frozen-lockfile
yarn playwright install chromium
yarn all
```

`yarn all` starts a fresh Juice Shop container, runs every test, asks the triage agent to propose a cause for each new failure, and writes:

- `reports/index.html`: summary, progress against the strategy's day-90 measures with a trend across runs, triage proposals waiting for review, open bugs, and the endpoint-by-role coverage grid
- `reports/history.json`: one summary per run; CI carries it forward between published runs, so the trend survives
- `reports/playwright/index.html`: every test with traces and screenshots for failures
- `docs/coverage.md`: the coverage map, regenerated from the run

It exits non-zero if any test fails that is not an approved open bug.

| Command | What it does |
|:--|:--|
| `yarn app:up` / `app:down` | Fresh Juice Shop with per-worker staff test accounts / remove it |
| `yarn test`, `yarn test:api`, `yarn test:ui` | Playwright only, against the running app |
| `yarn triage` | Propose a cause for each failure group (offline rules) |
| `TRIAGE_PROVIDER=claude yarn triage` | Same, classified by Claude through the local `claude` CLI |
| `yarn triage:review` | A person accepts, changes, or rejects each proposal |
| `yarn report`, `yarn coverage:map` | Rebuild the report or coverage map from the last run |
| `yarn test:unit` | Unit tests for the triage agent (redaction, rules, validation, grouping) |

> [!IMPORTANT]
> Only run this against your own local container. The security checks send attack payloads (SQL injection, forged tokens).

## How the suite is built

- **One catalog, generated tests.** [`src/catalog.ts`](src/catalog.ts) lists every endpoint in the 3 areas with who should be allowed to call it. That is the product's intended policy, not what Juice Shop does today. [`access-matrix.spec.ts`](tests/api/access-matrix.spec.ts) sends a valid request for each endpoint as each role ([`src/probes.ts`](src/probes.ts)). Allowed roles must succeed and every other role must be refused.
- **Isolation tests for the basket leak.** [`isolation.spec.ts`](tests/api/isolation.spec.ts) creates a victim customer and attempts every owner-only action on their records as every role. It checks the response *and* re-reads the victim's data as the victim, so a "refused" status that still changed data fails.
- **Behavior tests** for each area check totals, limits, coupons, wallet, 2FA, and password flows ([`customer-data`](tests/api/customer-data.spec.ts), [`checkout`](tests/api/checkout.spec.ts), [`auth`](tests/api/auth.spec.ts)). **UI tests** cover the same flows through the real pages ([`tests/ui`](tests/ui)).
- **No shared state.** Every customer and deluxe test registers its own account. Staff roles get one admin and one accounting account per Playwright worker, seeded when the container starts ([`scripts/juice-shop.ts`](scripts/juice-shop.ts)). Shared seed accounts were the first source of flakiness I hit (see below).
- **Bugs fail, and stay visible.** Juice Shop's security flaws are treated as real bugs, so assertions state the correct behavior and those tests fail. Once a person approves a failure as a product bug, it goes into [`known-bugs.json`](known-bugs.json). The test then runs as an *expected* failure, with the assertion unchanged. If the bug is fixed, the test passes, Playwright flags the unexpected pass, and the entry must be removed. `IGNORE_KNOWN_BUGS=1` shows the raw failures.
- **Test environment config.** The container turns off Juice Shop's training pop-ups (solved-challenge toasts, tutorial, welcome banner), which cover buttons and make UI tests flaky. Product behavior is unchanged.

## Coverage map

Full grid: [`docs/coverage.md`](docs/coverage.md), regenerated each run from test annotations, so it cannot claim coverage a test does not have.

| Area | Endpoints | API tests | UI flows |
|:--|--:|:--|:--|
| R1 Customer data isolation | 24 | Role matrix; cross-customer isolation for baskets, items, addresses, cards, user records; lists only show own records; basket limits and stock; address and card validation; card masking; data export | Basket quantity and remove (customer, deluxe); save address and card (all signed-in roles); order history; admin page (admin sees users, others refused) |
| R2 Checkout and payment | 21 | Role matrix; checkout totals (list and deluxe price, delivery); basket emptied; stock reduced; empty or incomplete orders refused; coupons; wallet top-up and payment; deluxe purchase; accounting order list and delivery status; product price changes | Checkout with card (customer, deluxe); deluxe price shown; coupon valid and invalid; wallet top-up; buy deluxe; track order (anonymous, customer); accounting marks delivered; no accounting page for other roles |
| R3 Login and account security | 23 | Role matrix; sign-up rules; login errors, SQL injection, rate limit, unsigned tokens; password hash never returned; 2FA setup, login, wrong code, disable; password change and reset; security answers | Register; log in (every role); wrong password; log out; change password (customer, deluxe); forgot password; 2FA setup and 2FA login |

Not run, with the reason recorded in the catalog note:

- **2FA setup and disable as staff:** turning on 2FA for the shared staff seed accounts would lock other tests out.
- **Successful passkey ceremonies:** need a real authenticator. A forged assertion is tested instead.
- **Stock updates:** limited to an office IP allow-list, so every caller from a test machine is refused.

## What the suite found

Each item below is a failing test today. Severity follows the area's risk rank.

| Area | Finding | Severity |
|:--|:--|:--|
| R1 | Any signed-in user can read any customer's basket by id (`GET /rest/basket/:id`). This is the production incident. | Critical |
| R1 | Any signed-in user can list, read, change, and delete other customers' basket items | Critical |
| R1 | Sending `BasketId` twice adds items to another customer's basket | Critical |
| R1 | Updating another customer's address succeeds and moves it to the caller's account | Critical |
| R1 | Any signed-in user can read any user record and the full user list, including login details | High |
| R1 | Saving a card echoes the full card number | High |
| R1 | Zero and negative quantities are accepted, producing negative order totals | High |
| R1 | The data export CAPTCHA returns its own answer, and is skipped if never requested | Medium |
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
| R3 | The password hash is in the session token and in three API responses | High |
| R3 | Changing the password does not require the current one | High |
| R3 | No rate limit on wrong passwords | Medium |
| R3 | Sign-up accepts mismatched passwords; some unauthenticated calls return 500 instead of 401 | Low |
| R3 | The 2FA settings page sends "Save" without its setup token if clicked before the QR code loads (found while chasing a flaky test) | Low |

## Why the triage agent (step 2)

The brief's numbers point at triage. The old suite failed 1 run in 5 for no clear reason, so the team ignored it. A suite that finds 73 failures on its first run is ignored just as fast unless someone sorts them. Sorting is the job testers do by hand today, and it is where their time goes.

The agent turns 73 failing tests into 39 groups, each with a proposed cause (product bug, test bug, environment, flaky, or needs a person) and a quote from the failure as evidence. A tester reviews groups, not tests.

The authorization checks the brief also lists come with the functional suite, since basket access is risk #1. A ZAP scan or k6 script would add less in this repo: ZAP finds generic issues that the targeted tests already cover, and load numbers from one laptop do not predict a sales event. Both are in the strategy as next steps.

How it works ([`triage/`](triage)):

1. [`collect.ts`](triage/collect.ts) reads the Playwright JSON report and keeps new failures and flaky passes. Approved bugs are already decided and skipped.
2. [`redact.ts`](triage/redact.ts) strips tokens, emails, password hashes, card numbers, and secrets before any text leaves the machine.
3. Failures that share an endpoint and an error signature form one group (the same defect seen by 4 roles is one decision).
4. A provider proposes a category:
   - **`heuristic`** (default, offline): deterministic rules. It is the baseline and the fallback.
   - **`claude`**: Claude through the local `claude` CLI, with a JSON schema for the answer. In CI it would call the Claude API with a key from the pipeline's secret store.
5. [`model.ts`](triage/model.ts) validates every model answer: the evidence must be a verbatim quote from the failure text, and "flaky" requires a retry that passed. If either check fails, the answer drops to `needs-human`. The model never gets the final say.
6. `yarn triage:review` shows each group to a person: accept, change category, reject, or skip. Only accepted product bugs reach `known-bugs.json`, with the reviewer's name and date. Every decision is logged in `triage/decisions.jsonl`.

**First real run, Claude (Haiku) against the rules on the same 39 groups:**

- They agreed on 31.
- Claude sent the other 8 to a person. All 8 are business-rule expectations, such as "an empty basket can't be checked out" or "a quantity of 0 is refused", which the failure text alone cannot prove. That is the caution the prompt asks for, and it shows where a tester's judgment is needed.
- One answer's reasoning was literally "Placeholder; to be replaced after reading the test source." Validation now rejects unfinished reasoning, and a unit test pins that exact answer.

Agreement is not accuracy: neither side is ground truth. Accuracy needs a labeled set (see [Next steps](#next-steps)).

## What the AI produced that I changed or rejected

Built with Claude Code. Most of the AI's mistakes surfaced the same way: run the tests, then check each failure against the actual response, trace, or Juice Shop source before calling it a product bug. Nothing was labeled a bug on the AI's word.

| What the AI produced | What was wrong | What I did |
|:--|:--|:--|
| Deluxe test fixture that used the token returned by the upgrade call | That token has no basket id, so every deluxe basket call failed with 401. It looked like 15 product bugs. | Fixture logs in again after upgrading. Kept a separate test for the token problem, which is a real bug. |
| Staff tests using the shared admin and accounting seed accounts | Parallel tests collided: duplicate basket items (500s) and one test's checkout emptying another's basket. That is the old suite's flakiness, recreated. | Seeded one admin and one accounting account per worker at container start. |
| Expected `400` from a malformed passkey verify call | WebAuthn verify returns 401 for any failed ceremony by design. That was not a bug. | Dropped the expectation; documented the gap. |
| A test that a "99% off" coupon is refused | It encoded a business rule nobody gave us. | Removed it; reported coupon forgery as a finding instead. |
| Data export probe that sent no CAPTCHA and passed | It passed only because of a bug (the CAPTCHA is skipped if never requested). | Probe now follows the real page flow; the bypass is its own failing test. |
| Address UI test that opened the form URL directly | The form goes "back" after saving, which left the app. Not a product bug. | Test starts from the saved-address list, as a customer does. |
| 2FA UI test with a comment that the page reuses the API's secret | Each status call issues a new secret, so the code never matched. | Test reads the secret from the page's own response. |
| First fix for the remaining 2FA flake (wait out the 30-second code window) | Wrong diagnosis: still failed 1 in 8. Capturing the request showed it had no setup token. | Test now waits for the QR code, as a person would. The race is logged as a low-severity bug. |
| Admin UI test asserting `email.toContain('@test.local')` | A check on test data, not the page. It could never fail. | Replaced with a check that the page lists customers. |
| Triage evidence quoting only `Expected: 400` | Not enough for a reviewer to decide. | Evidence now quotes the expected and received pair. |
| A model triage answer with the reasoning "Placeholder; to be replaced after reading the test source." | The answer was unfinished, and the validation let it through. | Validation rejects unfinished reasoning; a unit test uses that exact answer. |
| Report's by-area table, which read the risk area from test titles | UI test titles don't name an area, so all 40 UI tests were silently missing from it. Found by a review pass over the code. | Falls back to the area of the endpoint the test covers; all 527 tests now counted. |

## Secrets

No keys are in the repo. The staff test accounts are created inside a disposable local container. The Claude provider uses the developer's own `claude` login.

In a shared pipeline:

- the model API key and any staff test credentials live in the CI secret store (GitHub Actions secrets, or a vault for longer-lived environments);
- they are injected as environment variables at run time;
- they are never printed, because the redaction step runs before any failure text leaves the job.

## Next steps

- Review the 39 proposed groups with the testers and fill `known-bugs.json`, so CI goes green on known bugs and red on new ones.
- **Evaluate triage against labeled failures.** Reviewed decisions plus deliberately broken tests, outages, and planted races give known causes. Score accuracy per category, product-bug precision, and confident-but-wrong answers with confidence intervals, on a frozen held-out split, replayed keyless in CI. Same method as [agent-eval-gate](https://github.com/dholman7/agent-eval-gate).
- Add the other step-2 options as separate jobs: an OWASP ZAP baseline scan, and k6 checkout load tests with pass/fail thresholds in a production-like environment.
- Extend the catalog to the next risk areas: file upload and complaints, product reviews, and admin functions.
