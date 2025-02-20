import WebSocket from 'ws';
import fetch from 'node-fetch';
import pkg from 'pg';
import dotenv from 'dotenv';
import { exec } from 'child_process';
dotenv.config();

// Pool state management
let isShuttingDown = false;
let poolState = {
    isClosing: false,
    isClosed: true,
    lastActivity: Date.now()
};
let pool = null;
let highPriorityPool = null;

const { Pool } = pkg;

// Function to restart the server
const restartServer = () => {
    console.log('🔄 Restarting server...');
    const scriptPath = process.argv[1]; // Get current script path
    exec(`node ${scriptPath}`, (error, stdout, stderr) => {
        if (error) {
            console.error(`❌ Error restarting server: ${error}`);
            return;
        }
        if (stderr) {
            console.error(`Server stderr: ${stderr}`);
        }
        process.exit(0); // Exit current process after new one starts
    });
};

// Parallel operation settings
const MAX_CONCURRENT_OPERATIONS = 50; // Maximum parallel database operations
const OPERATION_TIMEOUT = 10000; // 10 second timeout for operations

// Create a connection pool for high-priority transactions
const createHighPriorityPool = () => {
    return new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 200, // Reduced for better stability
        min: 5,                        // Keep minimum connections ready
        idleTimeoutMillis: 30000,      // Shorter idle timeout
        connectionTimeoutMillis: 3000,  // Faster fail for high priority
        ssl: {
            rejectUnauthorized: false,
        },
        statement_timeout: 30000,       // Increased timeout for statements
        query_timeout: 30000,          // Increased timeout for queries
        keepalive: true
    });
};

// Function to create a new pool
const createPool = () => {
    if (pool && !poolState.isClosed) return pool;

    // Don't create new pool if we're shutting down
    if (poolState.isClosing) return null;

    poolState = {
        isClosing: false,
        isClosed: false,
        lastActivity: Date.now()
    };

    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        // Pooler optimized settings
        connectionTimeoutMillis: 30000, // Increased timeout
        idleTimeoutMillis: 30000,      // Shorter idle timeout
        max: 100,                       // Reduced for better stability
        min: 4,                        // Minimum connections
        ssl: {
            rejectUnauthorized: false,
        },
        statement_timeout: 30000, // 30 second timeout
        query_timeout: 30000,    // 30 second timeout
        keepalive: true
    });

    // Add connection error handler
    pool.on('error', (err, client) => {
        console.error('Database pool error:', err.message);
        // Log additional error details
        if (err.code) {
            console.error('Error code:', err.code);
        }
        if (client) {
            client.release(true); // Force release the client
        }
        // Recreate pool on critical errors
        if (err.code === '28000' || err.code === '28P01' || err.message.includes('Tenant or user not found')) {
            console.log('🔄 Recreating pool due to authentication error...');
            pool = createPool();
        }
        // Handle timeout errors
        if (err.message.includes('timeout')) {
            console.log('🔄 Restarting server due to timeout error...');
            restartServer();
        }
    });

    // Monitor pool events
    pool.on('connect', (client) => {
        console.log('🔌 New database connection established', {
            totalCount: pool.totalCount,
            idleCount: pool.idleCount,
            waitingCount: pool.waitingCount
        });
    });

    pool.on('remove', () => {
        console.log('🔌 Database connection removed from pool', {
            totalCount: pool.totalCount,
            idleCount: pool.idleCount,
            waitingCount: pool.waitingCount
        });
    });

    return pool;
};

// Function to safely close the pool
const closePool = async () => {
    if (!pool) return;
    if (poolState.isClosing) return;

    try {
        poolState.isClosing = true;
        poolState.isClosed = true;
        await pool.end();
        pool = null;
        console.log('✅ Database pool closed successfully');
    } catch (err) {
        console.error('❌ Error closing pool:', err);
        pool = null;
    } finally {
        poolState.isClosing = false;
    }
};

// Initialize pool
createPool();
highPriorityPool = createHighPriorityPool();

// Track last trade timestamps for each token
const lastTradeTimestamps = {
    trades: new Map(), // mint -> last trade timestamp
    tradeCount: new Map() // mint -> number of recent trades
};

// Constants for trade tracking
const TRADE_COUNT_WINDOW = 300000; // 5 minutes
const HIGH_ACTIVITY_THRESHOLD = 1; // Any trade makes token high priority
const INACTIVE_TIMEOUT = 60000; // 60 seconds without activity
let lastActivityTimestamp = Date.now();

// Reset trade counts periodically
const manageSubscriptions = (ws) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();

    // Reset trade counts periodically
    for (const [mint] of lastTradeTimestamps.trades) {
        if (now - (lastTradeTimestamps.trades.get(mint) || 0) > TRADE_COUNT_WINDOW) {
            lastTradeTimestamps.tradeCount.set(mint, 0);
        }
    }

    // Check pool activity
    checkPoolActivity();
};

// Track active subscriptions
const activeSubscriptions = new Set();

// Function to check pool activity
const checkPoolActivity = () => {
    const now = Date.now();
    if (now - poolState.lastActivity > INACTIVE_TIMEOUT && !poolState.isClosed) {
        console.log(`⏰ No activity for ${INACTIVE_TIMEOUT / 1000}s, closing pool connection`);
        closePool();
    }
};

// Track active token subscriptions
const activeTokenSubscriptions = new Set();
const activeRaydiumSubscriptions = new Set();

// Subscription management
const subscribeToken = (ws, mint) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
    ws.send(JSON.stringify({ method: 'subscribeRaydiumLiquidity', keys: [mint] }));
    activeTokenSubscriptions.add(mint);
    activeRaydiumSubscriptions.add(mint);

    // Initialize all tracking data for the token
    lastTradeTimestamps.trades.set(mint, Date.now());
    lastTradeTimestamps.tradeCount.set(mint, 0);
    lastActivityTimestamp = Date.now();

    console.log(`📥 Subscribed to token: ${mint}`);
};

// Resubscribe to all active tokens
const resubscribeAll = (ws) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    console.log(`🔄 Resubscribing to ${activeTokenSubscriptions.size} tokens...`);

    for (const mint of activeTokenSubscriptions) {
        ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
        lastActivityTimestamp = Date.now();
    }

    for (const mint of activeRaydiumSubscriptions) {
        ws.send(JSON.stringify({ method: 'subscribeRaydiumLiquidity', keys: [mint] }));
    }

    console.log('✅ Resubscription complete');
};

// Track trade activity
const trackTradeActivity = (mint) => {
    const now = Date.now();
    const previousCount = lastTradeTimestamps.tradeCount.get(mint) || 0;

    // Initialize or update trade count
    if (!lastTradeTimestamps.tradeCount.has(mint)) {
        lastTradeTimestamps.tradeCount.set(mint, 1);
    } else {
        const newCount = previousCount + 1;
        lastTradeTimestamps.tradeCount.set(mint, newCount);

        // Log if token reaches high activity threshold
        if (newCount >= HIGH_ACTIVITY_THRESHOLD && previousCount < HIGH_ACTIVITY_THRESHOLD) {
            console.log(`🔥 Token moved to high priority status:
              • Mint: ${mint}
              • Trade Count: ${newCount}
              • Time Window: ${TRADE_COUNT_WINDOW / 1000}s
              • Threshold: ${HIGH_ACTIVITY_THRESHOLD}
              • Timestamp: ${new Date().toISOString()}`);
        }
    }
};

// Direct database insertion
const insertData = async (query, values, isHighPriority = false) => {
    let client;
    let targetPool = isHighPriority ? highPriorityPool : pool;

    if (!targetPool || (isHighPriority ? !highPriorityPool : poolState.isClosed)) {
        if (isHighPriority) {
            targetPool = highPriorityPool = createHighPriorityPool();
        } else {
            targetPool = createPool();
        }
    }

    let retries = isHighPriority ? 10 : 5;  // Increased retries for better reliability
    const maxRetryDelay = isHighPriority ? 1000 : 2000; // Longer delays for better recovery
    const startTime = Date.now();

    try {
        // Add timeout to client connection
        const connectPromise = targetPool.connect();
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Connection timeout')), OPERATION_TIMEOUT));

        client = await Promise.race([connectPromise, timeoutPromise]);

        if (!isHighPriority && (poolState.isClosed || poolState.isClosing)) {
            throw new Error('Pool is closed due to inactivity');
        }

        poolState.lastActivity = Date.now(); // Update activity timestamp

        await client.query(query, values).catch(async (error) => {
            if (error.message.includes('timeout') ||
                error.message.includes('Connection terminated') ||
                error.message.includes('Cannot use a pool after calling end')) {
                console.error('🚨 Database timeout detected, restarting server...');
                restartServer();
                throw error; // Propagate to retry logic
            }
            console.error(`Initial query failed (${retries} retries left):`, error.message);
            throw error; // Propagate to retry logic
        });
        console.log(`✅ Successfully inserted data in ${Date.now() - startTime}ms`);
    } catch (error) {
        // Check for timeout errors first
        if (error.message.includes('timeout') ||
            error.message.includes('Connection terminated') ||
            error.message.includes('Cannot use a pool after calling end')) {
            console.error('🚨 Database timeout detected, restarting server...');
            restartServer();
            throw error; // Propagate to retry logic
        }

        console.error(`❌ Database error (${retries} retries left):`, error.message, {
            query: query.split('\n')[0], // Log first line of query for context
            retries,
            elapsed: Date.now() - startTime
        });

        while (retries > 0) {
            try {
                // Exponential backoff with jitter
                const retryDelay = Math.min(100 * (3 - retries), maxRetryDelay);
                const jitter = Math.floor(Math.random() * 200); // Add randomness to prevent thundering herd
                await new Promise(resolve => setTimeout(resolve, retryDelay + jitter));

                // Reuse existing client if possible
                client = await targetPool.connect();

                await client.query(query, values).catch(async (retryError) => {
                    console.error(`Retry query failed (${retries} retries left):`, retryError.message);
                    if (retryError.message.includes('timeout') ||
                        retryError.message.includes('Connection terminated') ||
                        retryError.message.includes('Cannot use a pool after calling end')) {
                        console.error('🚨 Database timeout detected in retry, restarting server...');
                        restartServer();
                        throw retryError; // Propagate to retry logic
                    }
                    throw retryError;
                });

                console.log(`✅ Successfully inserted data after retry in ${Date.now() - startTime}ms`);
                break;
            } catch (retryError) {
                // Check for timeout in retry catch block
                if (retryError.message.includes('timeout') ||
                    retryError.message.includes('Connection terminated') ||
                    retryError.message.includes('Cannot use a pool after calling end')) {
                    console.error('🚨 Database timeout detected in retry catch, restarting server...');
                    restartServer();
                    throw retryError; // Propagate to retry logic
                }

                retries--;
                if (retries > 0) {
                    console.error(`❌ Retry failed (${retries} left):`, retryError.message, {
                        elapsed: Date.now() - startTime
                    });
                }
                if (retries === 0) throw retryError;
            }
        }
    } finally {
        if (client) {
            client.release(); // Release back to pool but don't force close
        }
    }
};

// Helper: Convert timestamp
const convertTimestamp = (timestamp) => {
    if (!timestamp || timestamp === 'null' || timestamp === 'undefined') return new Date().toISOString();
    const parsed = parseInt(timestamp, 10);
    if (isNaN(parsed) || parsed <= 0) return new Date().toISOString();
    return new Date(parsed).toISOString();
};

// Helper: Fetch metadata from URI
const fetchMetadata = async (uri) => {
    if (!uri) return {
        description: 'N/A',
        twitter: 'N/A',
        telegram: 'N/A',
        website: 'N/A',
        image: 'N/A'
    };

    try {
        const ipfsUrl = uri.startsWith('ipfs://')
            ? `https://ipfs.io/ipfs/${uri.split('ipfs://')[1]}`
            : uri;

        const response = await fetch(ipfsUrl);
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        const metadata = await response.json();

        // Ensure image URI is properly formatted for IPFS
        if (metadata.image && metadata.image.startsWith('ipfs://')) {
            metadata.image = `https://ipfs.io/ipfs/${metadata.image.split('ipfs://')[1]}`;
        }

        return metadata;
    } catch (error) {
        console.error('Metadata fetch error:', error.message);
        return {
            description: 'N/A',
            twitter: 'N/A',
            telegram: 'N/A',
            website: 'N/A',
            image: 'N/A'
        };
    }
};

// SQL Queries
const insertTokenQuery = `
    INSERT INTO tokens (
        signature,
        mint_address,
        trader_public_key,
        tx_type,
        sol_amount,
        bonding_curve_key,
        v_tokens_in_bonding_curve,
        v_sol_in_bonding_curve,
        market_cap_sol,
        name,
        symbol,
        uri,
        description,
        twitter,
        telegram,
        website,
        image,
        timestamp,
        initial_buy,
        token_amount,
        holders,
        buys,
        sells
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 1, 1, 0)
    ON CONFLICT (mint_address) DO UPDATE SET
        v_tokens_in_bonding_curve = $7,
        v_sol_in_bonding_curve = $8,
        market_cap_sol = $9,
        timestamp = $18,
        token_amount = $20,
        holders = tokens.holders,
        buys = tokens.buys,
        sells = tokens.sells
`;

const insertTradeQuery = `
    INSERT INTO trades (
        signature,
        mint_address,
        trader_public_key,
        tx_type,
        sol_amount,
        bonding_curve_key,
        initial_buy,
        v_tokens_in_bonding_curve,
        v_sol_in_bonding_curve,
        market_cap_sol,
        timestamp,
        token_amount,
        new_token_balance
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (signature) DO NOTHING
`;

const insertRaydiumQuery = `
    INSERT INTO raydium_liquidity (
        signature,
        mint_address,
        tx_type,
        market_id,
        market_cap_sol,
        price,
        timestamp
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (signature) DO NOTHING
`;

// Graceful shutdown handler
const handleGracefulShutdown = async () => {
    console.log('🔄 Initiating graceful shutdown...');
    poolState.isClosing = true;
    if (highPriorityPool) {
        await highPriorityPool.end();
    }
    await closePool();
    process.exit(0);
};

// Register shutdown handlers
process.on('SIGTERM', handleGracefulShutdown);
process.on('SIGINT', handleGracefulShutdown);
process.on('uncaughtException', (err) => {
    console.error('🚨 Uncaught Exception:', err);
    if (err.message.includes('timeout')) {
        restartServer();
    } else {
        handleGracefulShutdown();
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
    if (reason && reason.message && reason.message.includes('timeout')) {
        restartServer();
    } else {
        handleGracefulShutdown();
    }
});

// WebSocket connection
const startWebSocket = () => {
    const ws = new WebSocket('wss://pumpportal.fun/api/data');
    ws.binaryType = 'arraybuffer';

    // Connection management constants
    const PING_INTERVAL = 30000;
    const RECONNECT_DELAY = 1000; // Faster reconnect
    const MAX_RECONNECT_DELAY = 5000;
    const SUBSCRIPTION_CHECK_INTERVAL = 5000; // Check more frequently for inactive tokens

    let pingInterval;
    let reconnectAttempts = 0;
    let isReconnecting = false;

    const scheduleReconnect = () => {
        if (isReconnecting) return;
        isReconnecting = true;

        // Exponential backoff with max delay
        const delay = Math.min(RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts), MAX_RECONNECT_DELAY);
        reconnectAttempts++;

        console.log(`🔄 Scheduling reconnect attempt ${reconnectAttempts} in ${delay}ms`);
        setTimeout(() => {
            isReconnecting = false;
            startWebSocket();
        }, delay);
    };

    ws.on('open', () => {
        console.log('🌐 WebSocket connection opened');

        // Resubscribe to all tokens if we have any
        if (activeTokenSubscriptions.size > 0) {
            resubscribeAll(ws);
        } else {
            // Only subscribe to new tokens if we don't have any active subscriptions
            ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
        }

        // Reset reconnection state
        reconnectAttempts = 0;
        isReconnecting = false;

        // Clear existing intervals
        if (pingInterval) clearInterval(pingInterval);

        // Keep connection alive with periodic pings
        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        }, PING_INTERVAL);

        // Periodically check for inactive tokens
        setInterval(() => manageSubscriptions(ws), SUBSCRIPTION_CHECK_INTERVAL);
    });

    ws.on('ping', () => {
        ws.pong();
    });

    ws.on('pong', () => {
        // Connection is alive
    });

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            const queueStart = Date.now();
            let messageType = 'unknown';
            let operations = [];

            // Determine message type based on data structure
            if (data.method) {
                messageType = data.method;
            } else if (data.name && data.mint) {
                messageType = 'newToken';
            } else if (data.txType && data.mint) {
                messageType = 'trade';
            } else if (data.marketId && data.mint) {
                messageType = 'raydiumData';
            }
            console.log(`📥 Processing message type: ${messageType}`);

            if (data.name && data.mint) {
                const processStart = Date.now();
                const timestamp = convertTimestamp(data.timestamp);
                const tradeCount = lastTradeTimestamps.tradeCount.get(data.mint) || 0;
                const isHighPriority = tradeCount >= HIGH_ACTIVITY_THRESHOLD;

                const targetPool = isHighPriority ? highPriorityPool : pool;

                // Check if token already exists before processing
                const existingToken = await targetPool.query(
                    'SELECT mint_address FROM tokens WHERE mint_address = $1',
                    [data.mint]
                );

                if (existingToken.rows.length > 0) {
                    console.log(`⚠️ Token ${data.mint} already exists, skipping creation`);
                    return;
                }

                // Fetch metadata first
                const metadata = await fetchMetadata(data.uri);
                console.log(`✅ Fetched metadata for token: ${data.mint}`);

                // Insert token with complete metadata
                try {
                    await insertData(insertTokenQuery, [
                        data.signature, data.mint, data.traderPublicKey, data.txType,
                        data.solAmount, data.bondingCurveKey,
                        data.vTokensInBondingCurve, data.vSolInBondingCurve, data.marketCapSol,
                        data.name, data.symbol || 'UNKNOWN', data.uri || 'N/A',
                        metadata.description || 'N/A',
                        metadata.twitter || 'N/A',
                        metadata.telegram || 'N/A',
                        metadata.website || 'N/A',
                        metadata.image || data.uri || 'N/A',
                        timestamp, data.initialBuy || 0, data.initialBuy || 0
                    ], true);

                    console.log(`✅ Token inserted with metadata: ${data.mint}`);

                    // Insert the initial trade
                    await insertData(insertTradeQuery, [
                        data.signature, data.mint, data.traderPublicKey || 'N/A', 'create',
                        data.solAmount || 0, data.bondingCurveKey || null, data.initialBuy || 0,
                        data.vTokensInBondingCurve || 0, data.vSolInBondingCurve || 0,
                        data.marketCapSol || 0, timestamp,
                        data.initialBuy || 0, data.initialBuy || 0
                    ], true);

                    console.log(`✅ Initial trade inserted for token: ${data.mint}`);

                    // Subscribe to token updates
                    subscribeToken(ws, data.mint);
                    lastActivityTimestamp = Date.now();
                    trackTradeActivity(data.mint);

                    // Log processing time
                    const processingTime = Date.now() - queueStart;
                    if (processingTime > 5000) {
                        console.log(`⚠️ Long processing time for token creation: ${processingTime}ms`);
                    }

                } catch (error) {
                    console.error(`❌ Failed to process token creation:`, {
                        mint: data.mint,
                        error: error.message,
                        stack: error.stack
                    });
                }
            }

            // Handle trades
            if (data.txType && data.mint && data.signature) {
                // Update last trade timestamp
                lastTradeTimestamps.trades.set(data.mint, Date.now());
                const tradeCount = lastTradeTimestamps.tradeCount.get(data.mint) || 0;
                const isHighPriority = tradeCount >= HIGH_ACTIVITY_THRESHOLD;
                lastActivityTimestamp = Date.now();

                trackTradeActivity(data.mint);

                // Add trade operation
                operations.push(insertData(insertTradeQuery, [
                    data.signature, data.mint, data.traderPublicKey || 'N/A', data.txType,
                    data.solAmount || 0, data.bondingCurveKey || null, data.initialBuy || 0,
                    data.vTokensInBondingCurve || 0, data.vSolInBondingCurve || 0,
                    data.marketCapSol || 0, convertTimestamp(data.timestamp),
                    data.tokenAmount || 0, data.newTokenBalance || 0
                ], isHighPriority));

                // Update token metrics in parallel
                operations.push(insertData(
                    'UPDATE tokens SET market_cap_sol = $2, v_tokens_in_bonding_curve = $3, v_sol_in_bonding_curve = $4 WHERE mint_address = $1',
                    [data.mint, data.marketCapSol || 0, data.vTokensInBondingCurve || 0, data.vSolInBondingCurve || 0],
                    isHighPriority
                ));
            }

            // Handle Raydium data
            if (data.marketId && data.mint && data.signature) {
                try {
                    const tradeCount = lastTradeTimestamps.tradeCount.get(data.mint) || 0;
                    const isHighPriority = tradeCount >= HIGH_ACTIVITY_THRESHOLD;
                    const targetPool = isHighPriority ? highPriorityPool : pool;

                    // First check if token exists
                    const tokenCheckResult = await targetPool.query(
                        'SELECT mint_address FROM tokens WHERE mint_address = $1',
                        [data.mint]
                    );

                    if (tokenCheckResult.rows.length > 0) {
                        // Token exists, proceed with Raydium data insertion
                        lastTradeTimestamps.trades.set(data.mint, Date.now());
                        const processStart = Date.now();
                        trackTradeActivity(data.mint);

                        // Add Raydium operation
                        operations.push(insertData(insertRaydiumQuery, [
                            data.signature, data.mint, data.txType, data.marketId,
                            data.marketCapSol || 0, data.price || 0, convertTimestamp(data.timestamp)
                        ], isHighPriority));

                        // Add token metrics update operation
                        operations.push(insertData(
                            'UPDATE tokens SET market_cap_sol = $2, current_token_price_sol = $3 WHERE mint_address = $1',
                            [data.mint, data.marketCapSol || 0, data.price || 0],
                            isHighPriority
                        ));

                        console.log(`✨ Raydium processing completed in ${Date.now() - processStart}ms`);
                    } else {
                        console.log(`⚠️ Skipping Raydium data for non-existent token: ${data.mint}`);
                    }
                } catch (error) {
                    console.error('❌ Error processing Raydium data:', error.message);
                }
            }

            // Execute all operations in parallel if we have any
            if (operations.length > 0) {
                try {
                    await Promise.all(operations.map(op => op.catch(error => {
                        if (!error.message.includes('duplicate key')) {
                            console.error('❌ Operation failed:', error.message);
                        }
                        return null; // Continue with other operations
                    })));
                } catch (error) {
                    console.error('❌ Parallel operation error:', error.message);
                }
            }

            // Log processing time for all messages
            const processingTime = Date.now() - queueStart;
            if (processingTime > 5000) {
                console.log(`⚠️ Long processing time for ${messageType}: ${processingTime}ms`);
            }
        } catch (err) {
            console.error('❌ Error processing data:', err.message, err.stack);
        }
    });
};

// Initialize pools
const initializePools = () => {

};

// Initialize pools
initializePools();

// Start WebSocket connection
startWebSocket();