# Reference

Detailed configuration, layout and CI/CD reference for [aws-sam-solana-bot](../README.md). The main README covers the architecture, the swap flow and the engineering design; this page holds the lookup tables.

## Contents

- [Deployed resources](#deployed-resources)
- [Error taxonomy](#error-taxonomy)
- [Repository layout](#repository-layout)
- [Configuration](#configuration)
- [GitHub Actions deploy](#github-actions-deploy)

## Deployed resources

The deployed infrastructure is small and is all defined in [`template.yaml`](../template.yaml):

| Resource | Details |
| --- | --- |
| `SolanaBotProcessorFunction` | Container-image Lambda (`processor-lambda/Dockerfile`, `public.ecr.aws/lambda/nodejs:20`), x86_64, 512 MB, 300 s timeout |
| Implicit `ServerlessRestApi` | REST API with one route, `POST /processor` |
| IAM policy | `AWSSecretsManagerGetSecretValuePolicy`, scoped to the one secret named by the `SecretName` parameter, plus `dynamodb:PutItem` on `ProcessedSignaturesTable` only |
| `ProcessedSignaturesTable` | DynamoDB table, on-demand billing, hash key `signature`, TTL on `expiresAt` (7 days). Holds one item per leader transaction signature already claimed. |

## Error taxonomy

Typed errors in `src/errors/` decide the retry policy.

| Class | Types | Handling |
| --- | --- | --- |
| `WorkerError` | `SWAP_NOT_SUPPORTED`, `NO_TOKEN_BALANCE`, `TOKEN_ACCOUNT_NOT_FOUND`, `LOW_POOL_LIQUIDITY`, `FREEZE_AUTHORITY`, `MINT_AUTHORITY`, `MINT_NOT_INITIALIZED`, `PRICE_NOT_FOUND` | Liquidity, authority and balance errors are terminal. A zero token balance (`NO_TOKEN_BALANCE`) is reported as `SWAP INVALID`; a missing token account (`TOKEN_ACCOUNT_NOT_FOUND`, for example when the leader sells a token the bot never bought) is reported as `SWAP ERROR`. |
| `JupiterError` | `QUOTE_FAIL`, `SWAP_TRANSACTION_FAIL`, `TOKEN_NOT_TRADABLE` | Retried. `TOKEN_NOT_TRADABLE` switches the route to Raydium. |
| `TransactionError` | `SLIPPAGE`, `BLOCKHASH_EXPIRED`, `ACCOUNT_FROZEN`, `SIMULATION_FAILED` | Retried with a rebuilt, re-signed transaction, except `SIMULATION_FAILED` (dry-run only), which is terminal. Carries the inputs and accumulated elapsed time, and adds a Jupiter swap link to its message. |
| `HeliusError` | `PRIORITY_FEE_FAIL` | Logged. The configured default fee is used instead. |

Unclassified errors are retried up to three times. Every error message that reaches Telegram is HTML-escaped.

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
│   ├── REFERENCE.md              # This page
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
    │   ├── idempotency.ts        # DynamoDB conditional-put claim on the leader's signature
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

The secret is a JSON object. Its name comes from the `SECRET_ID` environment variable, which the template sets from the `SecretName` parameter (default `prod/SolanaBot`). The region is `AWS_REGION`. [`docs/secret.example.json`](secret.example.json) has every key with a placeholder value.

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
| `IDEMPOTENCY_TABLE` | Template (`ProcessedSignaturesTable`) | DynamoDB table used to claim each leader signature once. When unset, the duplicate-delivery guard is off. |
| `ENABLE_EXECUTION` | Template (`EnableExecution`, default `'false'`) | `true` broadcasts real transactions. `false` only simulates them. Parsed as a case-insensitive `true`/`false`. When the value is absent the default is `true`; any other present value (such as `0`, `no` or `off`) fails closed and disables execution. Order of precedence: the secret, then this variable, then the default. |
| `AWS_REGION` | Lambda runtime | Region of the Secrets Manager client. Locally the SDK's normal region resolution applies. |
| `NODE_ENV` | Optional | Selects the node-config override file (`config/<NODE_ENV>.json`). |
| `RUN_E2E` | Developer | `1` switches Jest to the live end-to-end suite. |

There is no `.env` loader: everything is read straight from `process.env`. For local scripts, export the variables in your shell, or set them through `sam local invoke --parameter-overrides`.

### Tuning (node-config)

[`processor-lambda/config/default.cjs`](../processor-lambda/config/default.cjs) is bundled into the image next to `app.js`. Files named after `NODE_ENV` (`prod.json`, `test.json`) override it, and both are currently empty.

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

## GitHub Actions deploy

| Workflow | Trigger | What it does |
| --- | --- | --- |
| [`ci.yml`](../.github/workflows/ci.yml) | Push to `main`, every pull request | Installs with `--frozen-lockfile`, then runs `typecheck`, `lint`, `unit` and `bundle`, then `docker build`. It needs no credentials and never runs the e2e suite. |
| [`deploy.yml`](../.github/workflows/deploy.yml) | Manual (`workflow_dispatch`), choosing `testing` or `production` | Runs `sam build --use-container` and assumes an AWS role through GitHub OIDC (no long-lived keys). It then runs `sam deploy --role-arn ... --parameter-overrides SecretName=... EnableExecution=...`. |

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
- A CloudFormation execution role that can create the stack's resources, including IAM roles (the deploy uses `CAPABILITY_IAM`), Lambda, API Gateway and DynamoDB.
- The S3 artifacts bucket and the ECR repository, created before the first run.
