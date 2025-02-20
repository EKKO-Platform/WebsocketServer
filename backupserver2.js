import WebSocket from 'ws';
import fetch from 'node-fetch';
import pkg from 'pg';
import { exec } from 'child_process';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pkg;

// Track active connections for each token
const activeConnections = {};

// Helper: Monitor Connection Pool Health
const monitorPoolHealth = () => {
    setInterval(() => {
        console.log(`🩺 Pool Status: ${Object.keys(activeConnections).length} active token pools.`);
    }, 3000); // Log every 3 seconds
};

// Helper: Insert data into the database
const insertData = async (query, values, type, mintAddress) => {
    try {
        const client = await activeConnections[mintAddress].pool.connect();
        await client.query(query, values);
        client.release();
        console.log(`✅ Successfully inserted ${type} data for token: ${mintAddress}.`);
    } catch (err) {
        console.error(`❌ Error inserting ${type} data for token: ${mintAddress}:`, err.message);
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

// SQL Queries
const insertTokenQuery = `
    INSERT INTO tokens (
        signature, mint_address, trader_public_key, tx_type,
        token_amount, sol_amount, bonding_curve_key,
        v_tokens_in_bonding_curve, v_sol_in_bonding_curve,
        market_cap_sol, name, symbol, uri, description,
        twitter, telegram, website, image, timestamp
    ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17, $18, $19
    )
`;

const insertTradeQuery = `
    INSERT INTO trades (
        signature, mint_address, trader_public_key, tx_type,
        sol_amount, bonding_curve_key, v_tokens_in_bonding_curve,
        v_sol_in_bonding_curve, market_cap_sol, timestamp,
        token_amount, new_token_balance
    ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9, $10,
        $11, $12
    )
`;

const insertRaydiumQuery = `
    INSERT INTO raydium_liquidity (
        signature, mint_address, tx_type, market_id,
        market_cap_sol, price, timestamp
    ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7
    )
`;

// Function to handle new token trades and manage database connections dynamically
const handleTokenTrade = async (mintAddress, data) => {
    // Ensure dedicated pool exists for this token
    if (!activeConnections[mintAddress]) {
        const tokenPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: {
                rejectUnauthorized: false,
            },
            max: 3, // Use a single connection for the token
            idleTimeoutMillis: 20000,
            connectionTimeoutMillis: 50000,
        });

        activeConnections[mintAddress] = {
            pool: tokenPool,
            lastActivityTime: Date.now(),
        };
    }

    // Update last activity time for token's pool
    activeConnections[mintAddress].lastActivityTime = Date.now();

    // Perform database insert for token, trade, or Raydium event
    if (data.txType === 'buy' || data.txType === 'sell') {
        const trade = [
            data.signature, data.mint, data.traderPublicKey || 'N/A', data.txType,
            data.solAmount || 0, data.bondingCurveKey || null,
            data.vTokensInBondingCurve || 0, data.vSolInBondingCurve || 0,
            data.marketCapSol || 0, convertTimestamp(data.timestamp),
            data.tokenAmount || 0, data.newTokenBalance || 0,
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

// Monitor inactivity of token-specific pools and close them after 30 seconds of inactivity
const monitorTokenConnections = () => {
    setInterval(() => {
        const now = Date.now();
        for (const mintAddress in activeConnections) {
            const connection = activeConnections[mintAddress];
            if (now - connection.lastActivityTime > 30000) { // 30 seconds inactivity
                connection.pool.end(); // Close the pool connection
                delete activeConnections[mintAddress]; // Remove from active connections
                console.log(`❌ Closed inactive pool for token: ${mintAddress}`);
            }
        }
    }, 5000); // Check every 5 seconds
};

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

            if (data.name && data.mint) {
                console.log(`💎 New token detected: ${data.name} (${data.symbol})`);

                // Subscribe to trades and Raydium for the detected token
                ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [data.mint] }));
                ws.send(JSON.stringify({ method: 'subscribeRaydiumLiquidity', keys: [data.mint] }));
                console.log(`🔔 Subscribed to trades and Raydium for token: ${data.name}`);

                // Fetch metadata and insert token data
                let metadata = {};
                try {
                    metadata = await fetchMetadata(data.uri);
                    console.log('✅ Metadata fetched successfully.');
                } catch (err) {
                    console.error(`❌ Error fetching metadata: ${err.message}`);
                }

                const token = [
                    data.signature, data.mint, data.traderPublicKey, data.txType,
                    data.tokenAmount, data.solAmount, data.bondingCurveKey,
                    data.vTokensInBondingCurve, data.vSolInBondingCurve, data.marketCapSol,
                    data.name, data.symbol || 'UNKNOWN', data.uri, metadata.description || 'N/A',
                    metadata.twitter || 'N/A', metadata.telegram || 'N/A',
                    metadata.website || 'N/A', metadata.image || 'N/A',
                    convertTimestamp(data.timestamp),
                ];

                await insertData(insertTokenQuery, token, 'token', data.mint);
            }

            // Handle trades and Raydium data
            if (data.txType && data.mint) {
                await handleTokenTrade(data.mint, data);
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
        restartScript();
    });
};

// Start WebSocket connection and monitor pool health
startWebSocket();
monitorPoolHealth();
monitorTokenConnections();
