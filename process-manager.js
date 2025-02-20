import WebSocket from 'ws';
import fetch from 'node-fetch';
import pkg from 'pg';
import cluster from 'cluster';
import { Worker } from 'worker_threads';
import os from 'os';
import dotenv from 'dotenv';
dotenv.config();

// Define WebSocket connection function first
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

    // WebSocket event handlers
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
            // Add message queue tracking
            const queueStart = Date.now();
            let messageType = 'unknown';

            try {
                // Process data using worker threads
                await processDataWithWorker(data, false);
            } catch (error) {
                console.error('Worker thread processing error:', error);
                // Fall back to direct processing if worker fails
                if (data.name && data.mint) {
                    // ... existing token processing code ...
                } else if (data.txType && data.mint && data.signature) {
                    // ... existing trade processing code ...
                } else if (data.marketId && data.mint && data.signature) {
                    // ... existing Raydium data processing code ...
                }
            }

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

                // First, insert the token
                try {
                    await insertData(insertTokenQuery, [
                        data.signature, data.mint, data.traderPublicKey, data.txType,
                        data.solAmount, data.bondingCurveKey,
                        data.vTokensInBondingCurve, data.vSolInBondingCurve, data.marketCapSol,
                        data.name, data.symbol || 'UNKNOWN', data.uri || 'N/A', 'N/A',
                        'N/A', 'N/A', 'N/A', data.uri || 'N/A', // Store URI as image initially
                        timestamp, data.initialBuy || 0, data.initialBuy || 0
                    ], true);

                    console.log(`✅ Token inserted: ${data.mint}`);

                    // After successful token insertion, insert the initial trade
                    await insertData(insertTradeQuery, [
                        data.signature, data.mint, data.traderPublicKey || 'N/A', 'create',
                        data.solAmount || 0, data.bondingCurveKey || null, data.initialBuy || 0,
                        data.vTokensInBondingCurve || 0, data.vSolInBondingCurve || 0,
                        data.marketCapSol || 0, timestamp,
                        data.initialBuy || 0, data.initialBuy || 0
                    ], true);

                    console.log(`✅ Initial trade inserted for token: ${data.mint}`);

                    // Only subscribe after successful database insertions
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
                    return; // Don't proceed with metadata if token insertion failed
                }

                // Update metadata in background
                if (data.uri) {
                    fetchMetadata(data.uri).then(async metadata => {
                        const isHighPriority = lastTradeTimestamps.tradeCount.get(data.mint) >= HIGH_ACTIVITY_THRESHOLD;
                        try {
                            await insertData(
                                'UPDATE tokens SET description=$2, twitter=$3, telegram=$4, website=$5, image=$6 WHERE mint_address=$1',
                                [data.mint, metadata.description || 'N/A', metadata.twitter || 'N/A',
                                metadata.telegram || 'N/A', metadata.website || 'N/A', metadata.image || data.uri || 'N/A']
                                , isHighPriority);
                            console.log(`✅ Metadata updated for token: ${data.mint}`);
                        } catch (error) {
                            console.error(`❌ Failed to update token metadata:`, {
                                mint: data.mint,
                                error: error.message
                            });
                        }
                    });
                }
                console.log(`✨ Initial processing completed in ${Date.now() - processStart}ms`);
            }

            // Handle trades
            if (data.txType && data.mint && data.signature) {
                // Update last trade timestamp
                lastTradeTimestamps.trades.set(data.mint, Date.now());
                const tradeCount = lastTradeTimestamps.tradeCount.get(data.mint) || 0;
                const isHighPriority = tradeCount >= HIGH_ACTIVITY_THRESHOLD;
                lastActivityTimestamp = Date.now();

                trackTradeActivity(data.mint);

                // Process trade immediately
                insertData(insertTradeQuery, [
                    data.signature, data.mint, data.traderPublicKey || 'N/A', data.txType,
                    data.solAmount || 0, data.bondingCurveKey || null, data.initialBuy || 0,
                    data.vTokensInBondingCurve || 0, data.vSolInBondingCurve || 0,
                    data.marketCapSol || 0, convertTimestamp(data.timestamp),
                    data.tokenAmount || 0, data.newTokenBalance || 0
                ], isHighPriority).catch(error => {
                    if (!error.message.includes('duplicate key')) {
                        console.error(`❌ Failed to process trade:`, {
                            mint: data.mint,
                            error: error.message
                        });
                    }
                });
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

                        // Log high priority Raydium activity
                        if (isHighPriority) {
                            console.log(`⚡ Processing high priority Raydium activity:
                                • Mint: ${data.mint}
                                • Market: ${data.marketId}
                                • Signature: ${data.signature}
                                • Trade Count: ${tradeCount}
                                • Price: ${data.price || 0}
                                • Timestamp: ${new Date().toISOString()}`);
                        }

                        await insertData(insertRaydiumQuery, [
                            data.signature, data.mint, data.txType, data.marketId,
                            data.marketCapSol || 0, data.price || 0, convertTimestamp(data.timestamp)
                        ], isHighPriority).catch(error => {
                            console.error('❌ Failed to insert Raydium data:', error.message);
                        });

                        // Update token metrics after Raydium data
                        try {
                            await insertData(
                                'UPDATE tokens SET market_cap_sol = $2, current_token_price_sol = $3 WHERE mint_address = $1',
                                [data.mint, data.marketCapSol || 0, data.price || 0],
                                isHighPriority
                            );
                        } catch (error) {
                            console.error('❌ Failed to update token metrics:', error.message);
                        }

                        console.log(`✨ Raydium processing completed in ${Date.now() - processStart}ms`);
                    } else {
                        console.log(`⚠️ Skipping Raydium data for non-existent token: ${data.mint}`);
                    }
                } catch (error) {
                    console.error('❌ Error processing Raydium data:', error.message);
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

    ws.on('error', (err) => {
        console.error('🚨 WebSocket error:', err);
        if (!isShuttingDown) {
            scheduleReconnect();
        }
    });

    ws.on('close', () => {
        console.log('❌ WebSocket connection closed. Restarting...');
        if (pingInterval) clearInterval(pingInterval);
        if (!isShuttingDown) {
            scheduleReconnect();
        }
    });
};
