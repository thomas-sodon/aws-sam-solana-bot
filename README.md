# aws-sam-solana-bot

[![CI](https://github.com/thomas-sodon/aws-sam-solana-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/thomas-sodon/aws-sam-solana-bot/actions/workflows/ci.yml)

A serverless Solana copy-trading bot built on AWS SAM. A Helius enhanced-transaction webhook watches one or more "leader" wallets. When a leader swaps, Helius POSTs the parsed transaction to API Gateway, and a containerised TypeScript Lambda mirrors the trade from the bot's own wallet with a capped position size. Before it trades, the Lambda runs on-chain token safety checks and checks pool liquidity. It then routes the swap through Jupiter, falls back to building a Raydium AMM v4 swap directly, and broadcasts the signed transaction across a rotating pool of RPC providers. It reports each trade to Telegram by editing a single status message in place.

> **Warning:** this software signs and sends real transactions on Solana mainnet with real funds. Read the [disclaimer](#disclaimer) before running any of it.

## Contents

- [Architecture](#architecture)
- [How a swap flows](#how-a-swap-flows)
- [Engineering highlights](#engineering-highlights)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Configuration](#configuration)
- [Local development](#local-development)
- [Deployment](#deployment)
- [Testing](#testing)
- [Known limitations and future work](#known-limitations-and-future-work)
- [Disclaimer](#disclaimer)
- [License](#license)

## Architecture

```mermaid
flowchart LR
  L[Leader wallet swaps on Solana] --> HW[Helius enhanced webhook]
  HW -- "POST /processor<br/>Authorization header" --> APIGW[API Gateway REST API]
  APIGW --> LMB["Lambda (container image, Node 20)<br/>app.lambdaHandler"]
  SM[(AWS Secrets Manager)] -->|"wallet key, API keys,<br/>Telegram settings"| LMB

  subgraph Safety["Safety checks and pool discovery"]
    CLS{"Classify swap<br/>buy / sell / unsupported"}
    MINT["Mint checks<br/>initialised, no freeze or mint authority"]
    DS["DexScreener pairs<br/>+ on-chain Raydium v4 decode"]
    SHY["Shyft GraphQL fallback<br/>vault + OpenBook liquidity"]
    CLS --> MINT --> DS
    DS -. "lookup failed" .-> SHY
  end

  LMB --> CLS
  DS --> FEE[Helius getPriorityFeeEstimate]
  SHY --> FEE
  FEE --> ROUTE{Router}
  ROUTE -->|default| JUP["Jupiter v6 quote + swap<br/>public API, then QuickNode Metis"]
  ROUTE -->|TOKEN_NOT_TRADABLE| RAY["Raydium SDK<br/>AMM v4 swap instructions"]
  JUP --> SIGN[Sign VersionedTransaction]
  RAY --> SIGN
  SIGN --> RPC["RPC connection pool<br/>shuffled round-robin<br/>Helius / Alchemy / Chainstack /<br/>Syndica / HelloMoon / Shyft"]
  RPC --> SOL[(Solana mainnet)]
  RPC -->|"rebroadcast + getSignatureStatus<br/>until lastValidBlockHeight"| CONF{Confirmed?}
  CONF -->|"slippage / expired:<br/>rebuild + re-sign"| ROUTE
  CONF -->|yes| TG[Telegram Bot API<br/>edit status message]
  LMB -. "processing / errors / RPC alerts" .-> TG
```

The deployed infrastructure is small and is all defined in [`template.yaml`](template.yaml):

| Resource | Details |
| --- | --- |
| `SolanaBotProcessorFunction` | Container-image Lambda (`processor-lambda/Dockerfile`, `public.ecr.aws/lambda/nodejs:20`), x86_64, 512 MB, 300 s timeout |
| Implicit `ServerlessRestApi` | REST API with one route, `POST /processor` |
| IAM policy | `AWSSecretsManagerGetSecretValuePolicy`, scoped to the one secret named by the `SecretName` parameter |

## How a swap flows

1. **Entry and auth** (`src/app.ts`). `lambdaHandler` builds a `WorkerContext`, which loads the secret, decodes the wallet keypair and builds the RPC pool. The request is processed only if the `Authorization` header equals `HELIUS_WEBHOOK_AUTH_HEADER` and the body is not empty. Otherwise the handler returns `200 {"message":"Not processed"}`. The body is a JSON array of Helius `EnrichedTransaction`s, and only the first element is used. A "Processing" message goes to Telegram without being awaited.
2. **Filtering** (`src/handler/request-handler.ts`). Only `type === "SWAP"` transactions that have an `events.swap` payload go on. Anything else is reported to Telegram as ignored.
3. **Classification and sizing** (`src/handler/swap-handler.ts`). SOL, USDC and USDT count as the "base" side.
   - **Buy** (base in, token out). The bot buys with WSOL, spending the leader's SOL amount capped at `max.buy.sol` (0.01 SOL by default). Stablecoin-funded buys are mirrored as a `max.buy.sol`-sized SOL buy.
   - **Sell** (token in, base out). The bot sells its whole associated-token-account balance of that token. If the token is USDC and the leader moved less than `max.buy.usdc`, the bot uses the leader's exact amount instead.
   - **Anything else** (token to token, multi-hop or empty) is rejected with `SWAP_NOT_SUPPORTED`. A zero balance is rejected with `NO_TOKEN_BALANCE`.
4. **Token safety** (`src/pool-info.ts`, `getMintInfo`). The mint must be initialised and must have no freeze authority and no mint authority. USDC is exempt from both authority checks.
5. **Pool discovery and liquidity** (`getPoolInfo`).
   - DexScreener is queried first. The bot keeps Solana pairs quoted in WSOL that report liquidity, and takes the deepest.
   - On buys, the swap is rejected with `LOW_POOL_LIQUIDITY` if that pool holds less than `minimumPoolLiquidity` (USD 9,000). Leader wallets listed in `SKIP_LIQUIDITY_CHECK` are exempt.
   - The pair address is then decoded on-chain as a Raydium AMM v4 account plus its OpenBook market and LP mint, giving a full `ApiPoolInfoV4`.
   - If the DexScreener lookup fails, the bot falls back to Shyft's GraphQL indexer. In that path it computes liquidity itself (see the highlights). A low-liquidity verdict from DexScreener is final and does not fall back.
6. **Priority fee** (`src/helius/index.ts`). The bot asks a Helius endpoint for `getPriorityFeeEstimate` on the target mint at `heliusPriorityFeelevel` (Medium). If the estimate is above `maxPrioritizationFeeLamports`, it asks again at Low. If that is still too high, or the call fails, it uses the configured default.
7. **Routing**.
   - **Jupiter v6** is the default. The bot requests a quote with `computeAutoSlippage=true` from the public API, falling back to a QuickNode Metis endpoint, then calls `/swap` with `dynamicComputeUnitLimit` to get a serialised `VersionedTransaction`.
   - If Jupiter answers `TOKEN_NOT_TRADABLE`, which is common for very new tokens, the bot switches to **Raydium**. In `src/raydium/` it calls `Liquidity.fetchInfo` and `computeAmountOut` (5% slippage), then `makeSwapInstructionSimple` with a compute-unit price, and builds a V0 message on a fresh `confirmed` blockhash.
8. **Sign, send, confirm** (`src/handler/transaction-handler.ts`).
   - The transaction is signed locally. Until the block height passes `lastValidBlockHeight`, each loop iteration sends the raw transaction three times without awaiting (`skipPreflight: true`), each send on the next RPC in the pool.
   - `getSignatureStatus` is checked on every other iteration. `confirmed` or `finalized` with no error is a success.
   - Instruction error `Custom 6001` maps to `SLIPPAGE`, `Custom 17` to `ACCOUNT_FROZEN`, and anything else to `BLOCKHASH_EXPIRED`.
9. **Retry**. The outer loop allows up to 7 attempts (`MAX_NUM_RETRIES = 6`), sleeping `rateLimit.executeSwapRetry` (1 s) between them. Each attempt rebuilds the swap and re-signs it with a fresh blockhash.
10. **Report**. In `finally`, the handler edits the original Telegram "Processing" message into the result. A success message links Solscan, Rugcheck, DexCheck, DexScreener, the leader's Birdeye profile and a Jupiter swap link. A fresh message is sent only when no "Processing" message was started; if a Telegram call fails, the invocation throws.

Dry-run mode: when `ENABLE_EXECUTION` is `false`, step 8 is replaced by one `simulateTransaction` call. Its logs are printed and success is taken from `value.err`. Nothing is broadcast. A successful simulation is reported as `SWAP NOT EXECUTED` with no Solscan link, and a failed simulation is reported as a `SIMULATION_FAILED` error without retrying.

## Engineering highlights

### RPC pool rotation and 429 handling

`src/connection-pool.ts` wraps every RPC call.

- **Pool contents.** One connection is built for each of the single-key providers (Alchemy, Chainstack, Syndica, Helius). One more is added for every key in the comma-separated pool secrets (Helius, HelloMoon, Chainstack, Alchemy, Shyft).
- **Rotation.** The list is Fisher-Yates shuffled at cold start, and each `executeWithConnection` call moves a round-robin index forward. Consecutive calls and retries are therefore spread across providers and free-tier keys. A caller can pin a provider, as the Helius priority-fee call does.
- **Rate limits.** Pool connections set `disableRetryOnRateLimit`, which turns off web3.js's built-in backoff. On an HTTP 429 the pool instead moves to the next connection with bounded exponential backoff: 250, 500, 1000, 2000 and then 4000 ms, at most 5 times (`rateLimit.connection429`). These 429 retries do not use up the caller's own retry budget.
- **Other errors.** These retry with the per-method budget and delay from `connectionOptions.*`, and send an HTML-escaped operational alert to Telegram. The alert is not awaited, and a failure to send it is caught.
- **Error tags.** Errors are tagged `PROVIDER:<last 4 chars of endpoint>:<method>`, so failures can be traced to a provider without printing the full endpoint in the tag. For providers that put the key at the end of the URL (Helius, Alchemy, Syndica, HelloMoon, Shyft), those 4 characters are the end of the key.

### Priority fees via Helius

The fee estimate is scoped to the token being traded (`accountKeys: [mint]`), not taken as a global median. It steps down from Medium to Low and then to a configured default, under a ceiling (`maxPrioritizationFeeLamports`). Raydium receives the value as a compute-unit price in micro-lamports, which is the unit Helius returns. Jupiter receives the same number as `prioritizationFeeLamports` (or `"auto"` when there is no usable estimate), which is a unit mismatch; see [Known limitations](#known-limitations-and-future-work).

### Token safety and liquidity checks

- **Rug-pull defences.** Mints that still have a freeze authority, which could freeze the bot's tokens, or a mint authority, which allows unlimited dilution, are rejected before any quote is requested.
- **Liquidity floor on buys.** Buys need a minimum of USD 9,000 in pool liquidity. Pool keys are decoded from on-chain account layouts (`LIQUIDITY_STATE_LAYOUT_V4`, `MARKET_STATE_LAYOUT_V3`) rather than trusted from an API.
- **Shyft fallback liquidity.** In the Shyft path, liquidity is vault balances plus OpenBook open-order totals minus `NeedTakePnl`, priced in USD.
- **Position caps.** Buy size is limited by `max.buy.sol` and `max.buy.usdc`.

### Jupiter first, Raydium fallback

Jupiter gives the best aggregated route. Building Raydium AMM v4 instructions directly covers tokens that Jupiter has not indexed yet. The switch is driven by a typed `JupiterError(TOKEN_NOT_TRADABLE)`, not by matching error strings.

### Error taxonomy

Typed errors in `src/errors/` decide the retry policy.

| Class | Types | Handling |
| --- | --- | --- |
| `WorkerError` | `SWAP_NOT_SUPPORTED`, `NO_TOKEN_BALANCE`, `TOKEN_ACCOUNT_NOT_FOUND`, `LOW_POOL_LIQUIDITY`, `FREEZE_AUTHORITY`, `MINT_AUTHORITY`, `MINT_NOT_INITIALIZED`, `PRICE_NOT_FOUND` | Liquidity, authority and balance errors are terminal. A zero token balance (`NO_TOKEN_BALANCE`) is reported as `SWAP INVALID`; a missing token account (`TOKEN_ACCOUNT_NOT_FOUND`, for example when the leader sells a token the bot never bought) is reported as `SWAP ERROR`. |
| `JupiterError` | `QUOTE_FAIL`, `SWAP_TRANSACTION_FAIL`, `TOKEN_NOT_TRADABLE` | Retried. `TOKEN_NOT_TRADABLE` switches the route to Raydium. |
| `TransactionError` | `SLIPPAGE`, `BLOCKHASH_EXPIRED`, `ACCOUNT_FROZEN`, `SIMULATION_FAILED` | Retried with a rebuilt, re-signed transaction, except `SIMULATION_FAILED` (dry-run only), which is terminal. Carries the inputs and accumulated elapsed time, and adds a Jupiter swap link to its message. |
| `HeliusError` | `PRIORITY_FEE_FAIL` | Logged. The configured default fee is used instead. |

Unclassified errors are retried up to three times. Every error message that reaches Telegram is HTML-escaped.

### Configuration through Secrets Manager

All credentials sit in a single JSON secret that is read at runtime. The secret name is a stack parameter, and the IAM policy is scoped to that one secret. Nothing sensitive is in the image, the template or the environment. See [Configuration](#configuration).

## Tech stack

| Area | Choices |
| --- | --- |
| Runtime | Node.js 20, TypeScript 5 (strict), bundled with esbuild into a single CommonJS file |
| AWS | SAM, Lambda (container image), API Gateway REST, Secrets Manager, CloudFormation |
| Solana | `@solana/web3.js`, `@solana/spl-token`, `@raydium-io/raydium-sdk`, `@project-serum/serum` (OpenBook open orders), `bs58` |
| Market data and routing | Helius (webhooks, priority fees, RPC), Jupiter v6 API (`@jup-ag/api` types), DexScreener, Shyft GraphQL (`graphql-request`), Jupiter price API |
| RPC providers | Helius, Alchemy, Chainstack, Syndica, HelloMoon, Shyft |
| Notifications | Telegram Bot API (HTML parse mode) |
| Config | Secrets Manager, Lambda environment variables, [`node-config`](https://github.com/node-config/node-config) |
| Tooling | Yarn 1, ESLint and Prettier, Jest with ts-jest, tsx, Docker, GitHub Actions |

## Repository layout

```text
.
├── template.yaml                 # SAM template: function, REST API, Secrets Manager policy, parameters
├── events/                       # Sample events with placeholder data
│   ├── event.json                #   API Gateway POST /processor event (0.1 SOL -> BONK buy)
│   ├── swapEvent.json            #   Same webhook body as a bare EnrichedTransaction[]
│   ├── getPriorityFeeEstimate.json
│   └── telegramResponse.json
├── docs/
│   └── secret.example.json       # Every Secrets Manager key, with placeholder values
├── .github/workflows/
│   ├── ci.yml                    # typecheck, lint, unit, bundle, docker build
│   └── deploy.yml                # Manual SAM deploy through GitHub OIDC
└── processor-lambda/
    ├── Dockerfile                # Two-stage build on public.ecr.aws/lambda/nodejs:20
    ├── config/                   # node-config tuning (default.cjs, plus per-NODE_ENV overrides)
    ├── scripts/
    │   └── check-rpc-health.ts   # getHealth against every pool endpoint (yarn check:rpc)
    ├── src/
    │   ├── app.ts                # Lambda handler: auth, orchestration, Telegram status message
    │   ├── worker-context.ts     # Per-invocation context: env, wallet, connection pool
    │   ├── config.ts             # Token constants, provider URLs, ENABLE_EXECUTION parsing
    │   ├── secrets.ts            # Secrets Manager loader
    │   ├── connection-pool.ts    # Rotating multi-provider RPC pool with 429 backoff
    │   ├── pool-info.ts          # Mint safety checks, DexScreener and Shyft pool discovery
    │   ├── wallet.ts             # Keypair decoding, token balance lookup
    │   ├── handler/              # request -> swap -> transaction handlers
    │   ├── jupiter/              # Jupiter v6 quote and swap
    │   ├── raydium/              # Raydium AMM v4 swap builder
    │   ├── helius/               # Priority fee estimate
    │   ├── telegram/             # Bot API client and HTML message helpers
    │   └── errors/               # Typed error taxonomy
    └── test/
        ├── unit/                 # Hermetic Jest suite (runs in CI)
        ├── setup/hermetic.ts     # Blocks sockets, fetch and AWS credentials during unit tests
        ├── e2e/                  # Live mainnet suite, gated behind RUN_E2E=1
        └── util/                 # Event and EnrichedTransaction factories
```

## Configuration

Configuration comes from three places: a Secrets Manager secret for credentials, two Lambda environment variables, and node-config files for tuning values.

### Secrets Manager

The secret is a JSON object. Its name comes from the `SECRET_ID` environment variable, which the template sets from the `SecretName` parameter (default `prod/SolanaBot`). The region is `AWS_REGION`. [`docs/secret.example.json`](docs/secret.example.json) has every key with a placeholder value.

| Key | Required | Purpose |
| --- | --- | --- |
| `WALLET_PRIVATE_KEY` | Yes | Base58-encoded 64-byte secret key of the bot wallet that signs every trade. |
| `HELIUS_WEBHOOK_AUTH_HEADER` | Yes | Shared secret. Requests whose `Authorization` header does not match it exactly are not processed. Set the same value as the Helius webhook `authHeader`. |
| `TELEGRAM_BOT_TOKEN` | Yes | Bot API token used for status messages and RPC alerts. |
| `TELEGRAM_CHAT_ID` | Yes | Chat that receives the messages (numeric id). |
| `HELIUS_RPC_API_KEY` | Yes | Helius key. Its RPC connection is always in the pool. |
| `ALCHEMY_RPC_API_KEY` | Yes | Alchemy key. Its RPC connection is always in the pool. |
| `CHAINSTACK_RPC_API_KEY` | Yes | Path segment of a Chainstack Solana endpoint. Always in the pool. |
| `SYNDICA_RPC_API_KEY` | Yes | Syndica API token. Always in the pool. |
| `QUICKNODE_JUPITER_API_KEY` | Yes | Path after `https://jupiter-swap-api.quiknode.pro/` for the QuickNode Metis Jupiter endpoint. Used when the public Jupiter API fails. |
| `HELIUS_RPC_POOL_API_KEYS` | No | Comma-separated extra Helius keys added to the pool. |
| `HELLOMOON_RPC_POOL_API_KEYS` | No | Comma-separated HelloMoon keys added to the pool. |
| `CHAINSTACK_RPC_POOL_API_KEYS` | No | Comma-separated Chainstack endpoint paths added to the pool. |
| `ALCHEMY_RPC_POOL_API_KEYS` | No | Comma-separated extra Alchemy keys added to the pool. |
| `SHYFT_RPC_POOL_API_KEYS` | Recommended | Comma-separated Shyft keys. They are added to the RPC pool and also used for the Shyft GraphQL pool-discovery fallback, which cannot work without at least one key. |
| `SKIP_LIQUIDITY_CHECK` | No | Comma-separated leader wallet addresses whose buys skip the minimum-liquidity check. |
| `ENABLE_EXECUTION` | No | Optional override, `true` or `false`. If present in the secret it **overrides** the environment variable (see below). The example sets it to `false`. |

Comma-separated values are trimmed, blank entries are dropped, and a missing pool key becomes an empty list.

### Environment variables

| Variable | Set by | Purpose |
| --- | --- | --- |
| `SECRET_ID` | Template (`SecretName`) | Secrets Manager secret to load. Defaults to `prod/SolanaBot` when unset. |
| `ENABLE_EXECUTION` | Template (`EnableExecution`, default `'true'`) | `true` broadcasts real transactions. `false` only simulates them. Parsed as a case-insensitive `true`/`false`. When the value is absent the default is `true`; any other present value (such as `0`, `no` or `off`) fails closed and disables execution. Order of precedence: the secret, then this variable, then the default. |
| `AWS_REGION` | Lambda runtime | Region of the Secrets Manager client. Locally the SDK's normal region resolution applies. |
| `NODE_ENV` | Optional | Selects the node-config override file (`config/<NODE_ENV>.json`). |
| `RUN_E2E` | Developer | `1` switches Jest to the live end-to-end suite. |

There is no `.env` loader: everything is read straight from `process.env`. For local scripts, export the variables in your shell, or set them through `sam local invoke --parameter-overrides`.

### Tuning (node-config)

[`processor-lambda/config/default.cjs`](processor-lambda/config/default.cjs) is bundled into the image next to `app.js`. Files named after `NODE_ENV` (`prod.json`, `test.json`) override it, and both are currently empty.

| Key | Default | Meaning |
| --- | --- | --- |
| `max.buy.sol` | `10000000` | Maximum SOL per mirrored buy, in lamports (0.01 SOL). |
| `max.buy.usdc` | `5000000` | USDC sells below this raw amount (5 USDC) mirror the leader's exact amount. |
| `minimumPoolLiquidity` | `9000` | Minimum pool liquidity in USD for buys. |
| `maxPrioritizationFeeLamports` | `100000` | Highest Helius fee estimate accepted. Above it the bot steps down to Low, then to the default. |
| `heliusPriorityFeelevel` | `'Medium'` | First priority level requested from Helius. |
| `jupiter.publicPath` | `https://quote-api.jup.ag/v6` | Primary Jupiter API base URL. |
| `jupiter.prioritizationFeeLamports` | `"auto"` | Jupiter fee when no usable estimate exists. |
| `jupiter.dynamicComputeUnitLimit` | `true` | Lets Jupiter size the compute-unit limit. |
| `raydium.computeUnitPriceMicroLamports` | `100000` | Raydium compute-unit price when no usable estimate exists. |
| `raydium.slippage` | `5` | Raydium slippage tolerance, in percent. |
| `rateLimit.executeSwapRetry` | `1000` | Delay between swap attempts, in milliseconds. |
| `rateLimit.connection429.*` | `5`, `250`, `4000` | Most 429 retries, and the base and maximum backoff in milliseconds. |
| `connectionOptions.<method>` | see file | Per-method RPC `retries` and `retryDelay` (`getAccountInfo`, `getMint`, `getTokenAccountBalance`, `getPoolInfoFromDexScreener`, `executeTransaction`). |
| `maxRetries` | `undefined` | Passed to `sendRawTransaction` as the RPC node's own rebroadcast count. |

## Local development

Prerequisites: Node.js 20 (see [`.nvmrc`](.nvmrc)), Docker, and the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) for the SAM steps. The repo pins Yarn 1.22.22 through `packageManager`. If Yarn is not installed, use `npx yarn@1.22.22` or Corepack.

```bash
cd processor-lambda
yarn install --frozen-lockfile

yarn typecheck   # tsc --noEmit over src, test, scripts
yarn lint        # ESLint and Prettier rules (yarn lint:fix / yarn format to fix)
yarn unit        # hermetic Jest suite; no network or AWS access
yarn build       # typecheck, then esbuild bundle to dist/app.js
```

None of the commands above touch the network apart from `yarn install`.

Build the container image the same way CI does:

```bash
cd processor-lambda
docker build --tag solana-bot-processor:local .
```

### SAM build and local invoke

`sam local invoke` runs the real handler. It **calls Secrets Manager with your local AWS credentials as soon as the handler starts**, before the auth check. If the event's `Authorization` header matches your secret, it then goes on to call DexScreener, Helius, Jupiter, the RPC providers and Telegram. Point it at a non-production secret and force dry-run mode:

```bash
sam build
sam local invoke SolanaBotProcessorFunction \
  --event events/event.json \
  --parameter-overrides SecretName=dev/SolanaBot EnableExecution=false
```

- **Auth header.** `events/event.json` carries the placeholder header `example-helius-webhook-auth-header`. Unless your secret uses that value, the handler returns `Not processed` after loading the secret, which is a safe way to smoke-test the image and the secret wiring.
- **Real processing.** To process the sample BONK buy, set the event's header to your secret's `HELIUS_WEBHOOK_AUTH_HEADER`. Do not leave `ENABLE_EXECUTION` set to `true` in the secret, because the secret value overrides `EnableExecution=false`.

`sam local start-api` serves the same function at `http://127.0.0.1:3000/processor`.

### RPC health check

```bash
cd processor-lambda
SECRET_ID=dev/SolanaBot AWS_REGION=us-east-1 yarn check:rpc
```

This loads the secret, builds the connection pool and sends `getHealth` to every endpoint. It prints only the endpoints that are not healthy, tagged `PROVIDER:<last 4 chars>`. It needs AWS credentials and makes live RPC calls, but it never signs or sends a transaction.

## Deployment

### First deploy with the SAM CLI

1. Create the secret in the target region from [`docs/secret.example.json`](docs/secret.example.json):

   ```bash
   aws secretsmanager create-secret \
     --name prod/SolanaBot \
     --secret-string file://my-secret.json   # keep this file out of git
   ```

2. Build and deploy:

   ```bash
   sam build
   sam deploy --guided
   ```

   `--guided` prompts for the stack name, region and two parameters. `SecretName` is the secret from step 1. `EnableExecution` should be `'false'` for a first deploy, so the bot only simulates trades until you have watched it behave. Allow SAM to create the IAM role and an ECR repository for the image. SAM also warns that `SolanaBotProcessorFunction has no authentication`; answer `y`, because requests are authenticated in the handler against `HELIUS_WEBHOOK_AUTH_HEADER` rather than by an API Gateway authorizer. Your answers are saved to `samconfig.toml`, which is git-ignored.

3. Copy the `SolanaBotProcessorApi` output (`https://<api-id>.execute-api.<region>.amazonaws.com/Prod/processor/`) into a Helius enhanced webhook:
   - transaction type `SWAP`
   - the leader wallet addresses
   - `authHeader` set to the secret's `HELIUS_WEBHOOK_AUTH_HEADER`

4. When you are ready to trade, set `"ENABLE_EXECUTION": "true"` in the secret, or remove the key from the secret and redeploy with `EnableExecution=true`. The secret value wins over the parameter, so with the example secret's `"false"` a redeploy alone keeps the bot in dry-run mode. Remove the stack with `sam delete`.

### GitHub Actions

| Workflow | Trigger | What it does |
| --- | --- | --- |
| [`ci.yml`](.github/workflows/ci.yml) | Push to `main`, every pull request | Installs with `--frozen-lockfile`, then runs `typecheck`, `lint`, `unit` and `bundle`, then `docker build`. It needs no credentials and never runs the e2e suite. |
| [`deploy.yml`](.github/workflows/deploy.yml) | Manual (`workflow_dispatch`), choosing `testing` or `production` | Runs `sam build --use-container` and assumes an AWS role through GitHub OIDC (no long-lived keys). It then runs `sam deploy --role-arn ... --parameter-overrides SecretName=... EnableExecution=...`. |

`deploy.yml` reads these [variables](https://docs.github.com/en/actions/learn-github-actions/variables) from the selected GitHub environment:

| Variable | Purpose |
| --- | --- |
| `AWS_REGION` | Region to deploy to |
| `PIPELINE_EXECUTION_ROLE_ARN` | Role assumed through OIDC. Its trust policy must allow this repository and environment. |
| `CLOUDFORMATION_EXECUTION_ROLE_ARN` | Role CloudFormation uses to create the stack resources |
| `ARTIFACTS_BUCKET` | S3 bucket for SAM artifacts |
| `IMAGE_REPOSITORY` | ECR repository URI for the Lambda image |
| `STACK_NAME` | CloudFormation stack name |
| `SECRET_NAME` | Secrets Manager secret name. There is no fallback, so each environment must point at its own secret. |

All variables are required: the first step fails the run if any is empty. The workflow passes `EnableExecution=true` only for `production` and `EnableExecution=false` for every other environment. An `ENABLE_EXECUTION` value in the environment's secret still takes precedence. Add required reviewers to the `production` environment to gate production deploys.

Prerequisites in the AWS account (`sam pipeline bootstrap` can create most of them):

- An IAM OIDC identity provider for `token.actions.githubusercontent.com` with audience `sts.amazonaws.com`.
- A pipeline role whose trust policy allows `sts:AssumeRoleWithWebIdentity` from that provider, with a `sub` condition such as `repo:<owner>/aws-sam-solana-bot:environment:production`. It needs `iam:PassRole` on the CloudFormation execution role, CloudFormation stack and change-set permissions, read/write on the artifacts bucket and push rights on the ECR repository.
- A CloudFormation execution role that can create the stack's resources, including IAM roles (the deploy uses `CAPABILITY_IAM`), Lambda and API Gateway.
- The S3 artifacts bucket and the ECR repository, created before the first run.

## Testing

| Suite | Command | Network | Runs in CI |
| --- | --- | --- | --- |
| Unit (`test/unit/`) | `yarn unit` | None. Blocked at the socket, TLS and `fetch` level. | Yes |
| Coverage | `yarn test:coverage` | None | No |
| End-to-end (`test/e2e/`) | `yarn test:e2e` (`RUN_E2E=1`) | AWS, Solana mainnet, Jupiter, Helius, DexScreener, Telegram | **Never** |

The **unit suite** mocks the wallet, the connection pool, Telegram and the HTTP clients. It covers:

- swap classification and sizing (including the buy cap, stablecoin and zero-balance cases)
- `ENABLE_EXECUTION` parsing and precedence
- the Jupiter-to-Raydium fallback and priority-fee step-down
- RPC rotation and the exact 429 backoff schedule
- signature-status mapping, and simulation mode
- Telegram payloads and HTML escaping
- the handler's auth and response paths

`test/setup/hermetic.ts` makes every socket, TLS connection and `fetch` throw, and clears AWS credentials. A missing mock therefore fails the test instead of reaching a real service, and `test/unit/hermetic-guard.test.ts` checks that the guard is active.

> **Warning: the e2e suite spends real money.** It loads production secrets from Secrets Manager, signs with the bot wallet, and sends real swaps to Solana mainnet. Every run costs SOL in swap amounts, fees and slippage. It is `describe.skip` unless `RUN_E2E=1` is set. Never run it in CI or with a wallet you are not prepared to lose funds from.

## Known limitations and future work

This is a working personal trading tool, not a hardened product. These are the known gaps:

- **Synchronous processing behind API Gateway.**
  - API Gateway REST integrations time out after 29 seconds, but a swap with retries and confirmation polling can take longer. The Lambda timeout is 300 s.
  - When the timeout hits, Helius gets a 504 while the Lambda keeps trading. Helius may then retry the delivery.
  - The right design is a thin receiver that validates the request, enqueues it on SQS (with a DLQ) and returns `200` at once, plus a worker Lambda that consumes the queue.
- **No idempotency.** Nothing deduplicates on the leader's transaction signature, so a webhook retry or redelivery can mirror the same trade twice. A conditional write keyed on the signature, for example in DynamoDB, should guard execution.
- **No persistence of swap history.** Results go only to CloudWatch Logs and Telegram. There is no trade ledger, PnL tracking or position state.
- **Per-invocation setup.** The secret is fetched and the connection pool is built on every invocation, before the auth check, and the auth comparison is not constant-time. Caching the context on warm starts and checking auth first would cut latency and cost.
- **Narrow trade model.**
  - Only the first transaction in each webhook batch is handled, and only SOL/USDC/USDT-to-token swaps (in either direction) are mirrored.
  - Stablecoin-funded buys are copied as fixed-size SOL buys, and sells usually liquidate the whole position.
  - Raydium support is AMM v4 only (no CPMM or CLMM).
- **External APIs have moved on.** Some pinned endpoints have since been deprecated or replaced, including `quote-api.jup.ag/v6` and `price.jup.ag/v4`, and DexScreener pairs from non-Raydium DEXes fall through to the Shyft path.
- **Dependency vulnerabilities.**
  - `yarn audit` still reports advisories in transitive dependencies, mostly through `helius-sdk`, `@raydium-io/raydium-sdk` and `@project-serum/serum` (axios, elliptic, secp256k1, base-x, ws).
  - Clearing them needs major-version upgrades of the Solana, Raydium and Helius SDKs, which have not been done. Unused dependencies have been removed and the AWS SDK is current.
- **Mainnet only.** Provider URLs and token constants are hardcoded for Solana mainnet, and there is no devnet profile.
- **Operational gaps.**
  - There is one wallet per deployment.
  - There are no CloudWatch alarms or metrics beyond logs, and the secret is not created by IaC.
  - The confirmation loop rebroadcasts with no delay between iterations.
- **Logging can expose RPC keys.** Transport errors from `node-fetch` (used by web3.js and the Jupiter/QuickNode clients) include the full request URL, which for most providers contains the API key. The connection pool logs these errors to CloudWatch and forwards them to Telegram.
- **Priority-fee unit mismatch.** Helius returns micro-lamports per compute unit. Jupiter receives that number as `prioritizationFeeLamports`, which it reads as total lamports, and `maxPrioritizationFeeLamports` is compared against the micro-lamport value despite its name. Only the Raydium path uses the unit correctly.
- **Telegram failures fail the invocation.** If editing or sending the result message fails, the handler throws instead of falling back to a new message.

## Disclaimer

This project is published as a portfolio and educational example. It is **not financial advice** and comes with **no warranty** of any kind. Automated trading of Solana tokens is highly risky: copied traders can lose money, tokens can be scams despite the safety checks, transactions can fail or land at bad prices, and bugs can drain the wallet. The software signs and broadcasts **real transactions with real funds** whenever `ENABLE_EXECUTION` is `true`. Use it at your own risk, only with a dedicated wallet holding funds you can afford to lose, and in line with the laws and the terms of service of every provider you use.

## License

[MIT](LICENSE) © 2024 Thomas Sodon
