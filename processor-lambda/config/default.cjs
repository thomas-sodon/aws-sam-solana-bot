module.exports = {
    maxPrioritizationFeeLamports: 100000,
    jupiter: {
      prioritizationFeeLamports: "auto",
      publicPath: "https://quote-api.jup.ag/v6",
      dynamicComputeUnitLimit: true
    },
    raydium: {
      // Fallback compute-unit price (micro-lamports per CU) when no Helius estimate is available
      computeUnitPriceMicroLamports: 100000,
      slippage: 5
    },
    connectionOptions:{
      getAccountInfo: {
        retries: 5,
        retryDelay: 1000
      },
      executeTransaction: {
        retries: 1
      },
      getTokenAccountBalance: {
        retries: 2,
        retryDelay: 15000
      },
      getPoolInfoFromDexScreener: {
        retries: 1,
        retryDelay: 5000
      },
      getMint: {
        retries: 3,
        retryDelay: 1000
      },
    },
    rateLimit: {
      executeSwapRetry: 1000,
      // Bounded exponential backoff for HTTP 429s in ConnectionPool.executeWithConnection
      connection429: {
        maxRetries: 5,
        baseDelay: 250,
        maxDelay: 4000
      }
    },
    maxRetries: undefined,
    minimumPoolLiquidity: 9000,
    heliusPriorityFeelevel: 'Medium',
    max: {
        buy: {
            sol: 10000000,
            usdc: 5000000
        }
    }
  }
