import WebSocket from 'ws';
import fetch from 'node-fetch';
import pkg from 'pg';
import { exec } from 'child_process';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pkg;

// Main PostgreSQL Pool Settings with Enhanced Monitoring
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // PostgreSQL pooler connection string
    ssl: {
        rejectUnauthorized: false, // Bypass SSL certificate verification
    },
    max: 50, // Reduced max connections for main pool
    min: 10, // Minimum idle connections
    idleTimeoutMillis: 30000, // Time (in ms) before an idle client is closed
    connectionTimeoutMillis: 60000, // Time (in ms) to wait for a connection before timing out
});

// Enhanced connection tracking with metadata
const activeConnections = new Map();

// Track timeout handlers for each token
const tokenTimeouts = new Map();

// Constants for connection management
const TRADE_THRESHOLDS = {
    LEVEL1: 50,   // Scale to 7 connections
    LEVEL2: 100,  // Scale to 11 connections
    LEVEL3: 200   // Scale to 15 connections
};

const TIMEOUT_PERIODS = {
    SCALE_CHECK: 60000,  // Check trade volume every 60 seconds
    FINAL: 600000       // 10 minutes for final cleanup
};

// Track subscription status
const activeSubscriptions = new Set();

// Helper: Monitor Connection Pool Health
const monitorPoolHealth = () => {
    const metrics = {
        totalConnections: 0,
        activeTokens: 0,
        subscriptionCount: 0,
        poolUtilization: 0,
        orphanedTokens: 0,
        poolDistribution: {}
    };

    setInterval(() => {
        // Track tokens without active pools
        const tokensWithoutPools = new Set();

        // Calculate total connections across all token pools
        metrics.totalConnections = Array.from(activeConnections.values())
            .reduce((total, conn) => total + conn.pools.reduce((poolTotal, pool) =>
                poolTotal + (pool.totalCount || 0), 0), 0);

        metrics.activeTokens = activeConnections.size;
        metrics.subscriptionCount = activeSubscriptions.size;

        // Analyze pool distribution
        activeConnections.forEach((conn, mintAddress) => {
            const poolCount = conn.pools.length;
            metrics.poolDistribution[poolCount] = (metrics.poolDistribution[poolCount] || 0) + 1;

            if (poolCount === 0) {
                tokensWithoutPools.add(mintAddress);
            }
        });

        metrics.orphanedTokens = tokensWithoutPools.size;

        // Calculate total maximum possible connections across all pools
        const totalMaxConnections = Array.from(activeConnections.values())
            .reduce((total, conn) => total + conn.pools.reduce((poolTotal, pool) =>
                poolTotal + (pool.options.max || 15), 0), 0);

        metrics.poolUtilization = totalMaxConnections > 0
            ? (metrics.totalConnections / totalMaxConnections) * 100
            : 0;

        console.log('🩺 System Health Report:');
        console.log(`  • Pool Status: ${metrics.totalConnections}/${totalMaxConnections} connections`);
        console.log(`  • Active Tokens: ${metrics.activeTokens}`);
        console.log(`  • Active Subscriptions: ${metrics.subscriptionCount}`);
        console.log(`  • Orphaned Tokens: ${metrics.orphanedTokens}`);
        console.log(`  • Pool Utilization: ${metrics.poolUtilization.toFixed(2)}%`);
        console.log('  • Pool Distribution:');
        Object.entries(metrics.poolDistribution)
            .sort(([a], [b]) => Number(a) - Number(b))
            .forEach(([poolCount, tokenCount]) => {
                console.log(`    - ${poolCount} pools: ${tokenCount} tokens`);
            });
        console.log(`  • Waiting Requests: ${Array.from(activeConnections.values())
            .reduce((total, conn) => total + conn.pools.reduce((poolTotal, pool) =>
                poolTotal + (pool.waitingCount || 0), 0), 0)}`);

        // Clean up orphaned tokens if found
        if (metrics.orphanedTokens > 0) {
            tokensWithoutPools.forEach(mintAddress => {
                console.log(`⚠️ Cleaning up orphaned token: ${mintAddress}`);
                activeConnections.delete(mintAddress);
                activeSubscriptions.delete(mintAddress);
                if (tokenTimeouts.has(mintAddress)) {
                    clearTimeout(tokenTimeouts.get(mintAddress));
                    tokenTimeouts.delete(mintAddress);
                }
            });
        }
    }, 5000);
};

// Enhanced error handling with retries
const withRetry = async (operation, maxRetries = 3) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt === maxRetries) throw error;
            const delay = Math.min(1000 * attempt, 3000);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
};

// Helper: Insert data into the database
const insertData = async (query, values, type, mintAddress) => {
    try {
        // Ensure connection exists
        let connectionData = activeConnections.get(mintAddress);

        if (!connectionData) {
            // Initialize with 3 connection pools
            const initialPools = Array(3).fill(null).map(() => new Pool({
                connectionString: process.env.DATABASE_URL,
                ssl: {
                    rejectUnauthorized: false,
                },
                max: 15,
                min: 2,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 30000,
            }));

            activeConnections.set(mintAddress, {
                pools: initialPools,
                lastActivityTime: Date.now(),
                trades: 0,
                errors: 0,
                scalingLevel: 0
            });

            console.log(`🔌 New connection pool created for token: ${mintAddress}`);
            connectionData = activeConnections.get(mintAddress);
        }

        // Check if we need to scale up connections
        const currentTrades = connectionData.trades + 1;
        if (currentTrades === TRADE_THRESHOLDS.LEVEL1 && connectionData.pools.length === 3) {
            console.log(`🔼 Scaling up to 7 connections for high-volume token: ${mintAddress}`);
            const newPools = Array(4).fill(null).map(() => new Pool({
                connectionString: process.env.DATABASE_URL,
                ssl: { rejectUnauthorized: false },
                max: 15,
                min: 2,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 30000,
            }));
            connectionData.pools.push(...newPools);
            connectionData.scalingLevel = 1;
        } else if (currentTrades === TRADE_THRESHOLDS.LEVEL2 && connectionData.pools.length === 7) {
            console.log(`🔼 Scaling up to 11 connections for very high-volume token: ${mintAddress}`);
            const newPools = Array(5).fill(null).map(() => new Pool({
                connectionString: process.env.DATABASE_URL,
                ssl: { rejectUnauthorized: false },
                max: 15,
                min: 2,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 30000,
            }));
            connectionData.pools.push(...newPools);
            connectionData.scalingLevel = 2;
        } else if (currentTrades === TRADE_THRESHOLDS.LEVEL3 && connectionData.pools.length === 11) {
            console.log(`🔼 Scaling up to 15 connections for ultra high-volume token: ${mintAddress}`);
            const newPools = Array(5).fill(null).map(() => new Pool({
                connectionString: process.env.DATABASE_URL,
                ssl: { rejectUnauthorized: false },
                max: 15,
                min: 2,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 30000,
            }));
            connectionData.pools.push(...newPools);
            connectionData.scalingLevel = 3;
        }

        // Round-robin between available pools
        const poolIndex = connectionData.trades % connectionData.pools.length;

        await withRetry(async () => {
            const client = await connectionData.pools[poolIndex].connect();
            try {
                await client.query(query, values);
            } finally {
                client.release();
            }
        });

        // Update connection metadata
        connectionData.lastActivityTime = Date.now();
        connectionData.trades = currentTrades;

        // Reset timeout for this token
        resetTokenTimeout(mintAddress);

        console.log(`✅ Successfully inserted ${type} data for token: ${mintAddress}.`);
    } catch (err) {
        console.error(`❌ Error inserting ${type} data for token: ${mintAddress}:`, err.message);
        throw err; // Propagate error for proper handling
    }
};

// Helper: Restart WebSocket connection
const restartScript = () => {
    exec('node server.js', (err, stdout, stderr) => {
        if (err) {
            console.error(`❌ Error restarting script: ${err.message}`);
            return;
        }
        console.log(`ℹ️ Script restarted. Output:\n${stdout}`);
        if (stderr) {
            console.error(`ℹ️ Script restart errors:\n${stderr}`);
        }
    });
};

// Helper: Convert timestamp
const convertTimestamp = (timestamp) => {
    if (!timestamp) return new Date().toISOString();
    const parsed = parseInt(timestamp, 10);
    if (isNaN(parsed) || parsed <= 0) throw new RangeError('Invalid timestamp');
    return new Date(parsed).toISOString();
};

// Helper: Fetch metadata from URI
const fetchMetadata = async (uri) => {
    if (!uri || (!uri.startsWith('ipfs://') && !uri.startsWith('https://'))) {
        throw new Error(`Invalid URI: ${uri}`);
    }
    const ipfsUrl = uri.startsWith('ipfs://')
        ? `https://ipfs.io/ipfs/${uri.split('ipfs://')[1]}`
        : uri;

    const response = await fetch(ipfsUrl);
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
    const contentType = response.headers.get('content-type');
    if (!contentType.includes('application/json')) throw new Error('Invalid content type');
    return await response.json();
};

// Helper: Reset token timeout
const resetTokenTimeout = (mintAddress) => {
    // Clear existing timeout if any
    if (tokenTimeouts.has(mintAddress)) {
        clearTimeout(tokenTimeouts.get(mintAddress));
    }

    const connectionData = activeConnections.get(mintAddress);
    if (!connectionData) return;

    // Set new timeout based on connection state
    const timeoutHandler = setTimeout(() => {
        const connectionData = activeConnections.get(mintAddress);
        if (!connectionData) return;

        // Calculate trades in the last minute
        const tradesLastMinute = connectionData.trades - (connectionData.lastTradeCount || 0);
        connectionData.lastTradeCount = connectionData.trades;

        if (tradesLastMinute < 50) {
            // Scale down based on current pool size
            if (connectionData.pools.length === 15) {
                // Scale down to 11 connections
                const poolsToClose = connectionData.pools.splice(11, 4);
                Promise.all(poolsToClose.map(pool => pool.end()))
                    .then(() => {
                        console.log(`🔽 Scaled down to 11 connections for token: ${mintAddress}`);
                        connectionData.scalingLevel = 2;
                        resetTokenTimeout(mintAddress);
                    });
            } else if (connectionData.pools.length === 11) {
                // Scale down to 7 connections
                const poolsToClose = connectionData.pools.splice(7, 4);
                Promise.all(poolsToClose.map(pool => pool.end()))
                    .then(() => {
                        console.log(`🔽 Scaled down to 7 connections for token: ${mintAddress}`);
                        connectionData.scalingLevel = 1;
                        resetTokenTimeout(mintAddress);
                    });
            } else if (connectionData.pools.length === 7 && tradesLastMinute === 0) {
                // Set final timeout for remaining connections if no activity
                setTimeout(() => {
                    if (activeConnections.has(mintAddress)) {
                        Promise.all(connectionData.pools.map(pool => pool.end()))
                            .then(() => {
                                console.log(`📊 Final stats for ${mintAddress}:`);
                                console.log(`  • Total trades processed: ${connectionData.trades}`);
                                console.log(`  • Error count: ${connectionData.errors}`);
                                activeConnections.delete(mintAddress);
                                activeSubscriptions.delete(mintAddress);
                                tokenTimeouts.delete(mintAddress);
                                console.log(`❌ Closed all connections for token: ${mintAddress}`);
                            });
                    }
                }, TIMEOUT_PERIODS.FINAL);
            }
        } else {
            // Reset timeout if still active
            resetTokenTimeout(mintAddress);
        }
    }, TIMEOUT_PERIODS.SCALE_CHECK);

    tokenTimeouts.set(mintAddress, timeoutHandler);
};

// Monitor idle connections and close if inactive
const monitorTokenConnections = () => { }; // Removed as we now use individual timeouts

// SQL Queries
const insertTokenQuery = `
    SELECT insert_token($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
`;

const insertTradeQuery = `
    SELECT insert_trade($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
`;

const insertRaydiumQuery = `
    SELECT insert_raydium_liquidity($1, $2, $3, $4, $5, $6, $7)
`;

// Function to handle new token trades and manage database connections dynamically
const handleTokenTrade = async (mintAddress, data) => {
    console.log('\n🔄 handleTokenTrade called with:');
    console.log('  • Mint Address:', mintAddress);
    console.log('  • Transaction Type:', data.txType);
    console.log('  • Token Amount:', data.tokenAmount);
    console.log('  • Initial Buy:', data.initialBuy);

    // Create or get token connection
    const connection = activeConnections.get(mintAddress);
    if (connection) {
        connection.lastActivityTime = Date.now();
        connection.trades++;
    }

    // Perform database insert for token, trade, or Raydium event
    if (data.txType === 'buy' || data.txType === 'sell' || data.txType === 'create') {
        console.log('\n💫 Processing trade transaction:');
        console.log('  • Type:', data.txType);
        console.log('  • Initial Buy:', data.initialBuy);
        console.log('  • Token Amount:', data.tokenAmount);

        // Handle token amount differently for create transactions
        const tokenAmount = data.txType === 'create' ? data.initialBuy || 0 : data.tokenAmount || 0;
        const newTokenBalance = data.txType === 'create' ? data.initialBuy || 0 : data.newTokenBalance || 0;
        console.log('  • Final Token Amount:', tokenAmount);
        console.log('  • New Token Balance:', newTokenBalance);

        const trade = [
            data.signature, data.mint, data.traderPublicKey || 'N/A', data.txType,
            data.solAmount || 0, data.bondingCurveKey || null, data.initialBuy || 0,
            data.vTokensInBondingCurve || 0, data.vSolInBondingCurve || 0,
            data.marketCapSol || 0, convertTimestamp(data.timestamp),
            tokenAmount, newTokenBalance,
        ];
        await insertData(insertTradeQuery, trade, 'trade', mintAddress);
    }

    if (data.marketId) {
        const raydium = [
            data.signature, data.mint, data.txType, data.marketId,
            data.marketCapSol || 0, data.price || 0, convertTimestamp(data.timestamp),
        ];
        await insertData(insertRaydiumQuery, raydium, 'Raydium event', mintAddress);
    }
};

// Graceful shutdown handler
const handleGracefulShutdown = async () => {
    console.log('🔄 Initiating graceful shutdown...');

    // Close all pools for all tokens
    const closePromises = Array.from(activeConnections.values())
        .flatMap(conn => conn.pools.map(pool => pool.end()));

    try {
        await Promise.all(closePromises);
        await pool.end();
        console.log('✅ All database connections closed successfully');
        process.exit(0);
    } catch (err) {
        console.error('❌ Error during shutdown:', err);
        process.exit(1);
    }
};

// Register shutdown handlers
process.on('SIGTERM', handleGracefulShutdown);
process.on('SIGINT', handleGracefulShutdown);

// WebSocket for tokens, trades, and Raydium
const startWebSocket = () => {
    const ws = new WebSocket('wss://pumpportal.fun/api/data');

    ws.on('open', () => {
        console.log('🌐 WebSocket connection opened.');
        ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    });

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());

            // Enhanced logging for message data
            console.log('\n📨 Received WebSocket message:');
            console.log('  • Message Type:', data.method || 'data');
            console.log('  • Transaction Type:', data.txType);
            console.log('  • Has Token Info:', !!(data.name && data.mint));
            console.log('  • Mint Address:', data.mint);
            console.log('  • Initial Buy:', data.initialBuy);
            console.log('  • Market Cap SOL:', data.marketCapSol);
            console.log('  • Full Data:', JSON.stringify(data, null, 2));

            if (data.name && data.mint) {
                console.log(`\n💎 TOKEN CREATION EVENT:`);
                console.log('RAW TOKEN DATA:', JSON.stringify(data, null, 2));
                console.log('  • Name:', data.name);
                console.log('  • Symbol:', data.symbol);
                console.log('  • Mint:', data.mint);
                console.log('  • Initial Buy:', data.initialBuy);
                console.log('  • Market Cap SOL:', data.marketCapSol);
                console.log('  • vTokens in Bonding Curve:', data.vTokensInBondingCurve);
                console.log('  • vSOL in Bonding Curve:', data.vSolInBondingCurve);
                console.log('  • Original txType:', data.txType);
                console.log('  • Timestamp:', data.timestamp);
                console.log('  • Signature:', data.signature);

                // 1. Subscribe to trades and Raydium immediately
                ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [data.mint] }));
                ws.send(JSON.stringify({ method: 'subscribeRaydiumLiquidity', keys: [data.mint] }));
                console.log(`🔔 Subscribed to trades and Raydium for token: ${data.name}`);
                console.log('🔍 Starting create transaction processing...');
                activeSubscriptions.add(data.mint);

                // Process the create transaction first (always for new tokens)
                try {
                    console.log('📝 Preparing create trade data for insertion:');
                    const trade = [
                        data.signature, data.mint, data.traderPublicKey || 'N/A', 'create',
                        data.solAmount || 0, data.bondingCurveKey || null, data.initialBuy || 0,
                        data.vTokensInBondingCurve || 0, data.vSolInBondingCurve || 0,
                        data.marketCapSol || 0, convertTimestamp(data.timestamp),
                        data.initialBuy || 0, data.initialBuy || 0,
                    ];
                    console.log('Trade Data Array:', trade);
                    console.log('🔄 Attempting to insert create trade...');
                    await insertData(insertTradeQuery, trade, 'create trade', data.mint);
                    console.log(`✅ Create trade processed for ${data.mint}`);
                } catch (err) {
                    console.error('\n❌ CREATE TRADE INSERTION ERROR:');
                    console.error('  • Mint Address:', data.mint);
                    console.error('  • Error Message:', err.message);
                    console.error('  • Stack Trace:', err.stack);
                    console.error('  • Full Error Object:', err);
                }

                // 3. Start metadata fetch and token insertion
                fetchMetadata(data.uri)
                    .then(async (metadata) => {
                        console.log('✅ Metadata fetched successfully.');

                        // Build token data with metadata
                        const token = [
                            data.signature, data.mint, data.traderPublicKey, data.txType,
                            data.solAmount, data.bondingCurveKey,
                            data.vTokensInBondingCurve, data.vSolInBondingCurve, data.marketCapSol,
                            data.name, data.symbol || 'UNKNOWN', data.uri, metadata.description || 'N/A',
                            metadata.twitter || 'N/A', metadata.telegram || 'N/A',
                            metadata.website || 'N/A', metadata.image || 'N/A',
                            convertTimestamp(data.timestamp), data.initialBuy || 0, data.initialBuy || 0,
                        ];

                        // 4. Insert token data to database
                        await insertData(insertTokenQuery, token, 'token', data.mint);
                    })
                    .catch(err => {
                        console.error(`❌ Error fetching metadata: ${err.message}`);
                        // Still insert token with default values if metadata fetch fails
                        const token = [
                            data.signature, data.mint, data.traderPublicKey, data.txType,
                            data.solAmount, data.bondingCurveKey,
                            data.vTokensInBondingCurve, data.vSolInBondingCurve, data.marketCapSol,
                            data.name, data.symbol || 'UNKNOWN', data.uri, 'N/A',
                            'N/A', 'N/A', 'N/A', 'N/A',
                            convertTimestamp(data.timestamp), data.initialBuy || 0, data.initialBuy || 0,
                        ];
                        return insertData(insertTokenQuery, token, 'token', data.mint);
                    });
            }

            // Handle trades and Raydium data
            if (data.txType && data.mint) {
                try {
                    await handleTokenTrade(data.mint, data);
                } catch (err) {
                    const connection = activeConnections.get(data.mint);
                    if (connection) {
                        connection.errors++;
                    }
                    console.error(`❌ Error processing trade for ${data.mint}:`, err.message);
                }
            }
        } catch (err) {
            console.error('❌ Error processing data:', err.message);
            restartScript();
        }
    });

    ws.on('error', (err) => {
        console.error('🚨 WebSocket error:', err);
        restartScript();
    });

    ws.on('close', () => {
        console.log('❌ WebSocket connection closed. Restarting script...');
        for (const [mintAddress, connection] of activeConnections.entries()) {
            connection.pool.end().catch(console.error);
        }
        activeConnections.clear();
        activeSubscriptions.clear();
        restartScript();
    });
};

// Start WebSocket connection and monitor pool health
startWebSocket();
monitorPoolHealth();