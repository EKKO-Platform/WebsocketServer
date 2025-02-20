// Utility to pause execution
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry function with exponential backoff
async function retry(
    fn,
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    shouldRetry
) {
    let attempts = 0;

    while (true) {
        try {
            return await fn();
        } catch (error) {
            attempts++;

            // Check if we should retry
            if (attempts >= maxRetries || (shouldRetry && !shouldRetry(error))) {
                throw error;
            }

            // Calculate delay with exponential backoff and jitter
            const backoffDelay = Math.min(maxDelay, initialDelay * Math.pow(2, attempts));
            const jitter = Math.random() * 200;
            const finalDelay = backoffDelay + jitter;

            // Log retry attempt
            console.info(`Retry attempt ${attempts} of ${maxRetries} after ${finalDelay}ms`);

            await sleep(finalDelay);
        }
    }
}

// Batch array processing to avoid rate limits
async function processBatch(items, batchSize, processor, delayMs = 100) {
    const results = [];

    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.all(
            batch.map((item) => retry(() => processor(item)))
        );
        results.push(...batchResults);
        if (i + batchSize < items.length) {
            await sleep(delayMs);
        }
    }

    return results;
}

// Validate token names and symbols
function isValidTokenName(str) {
    if (!str || typeof str !== 'string') return false;

    // Remove common spam patterns
    const cleaned = str
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .trim();

    // Check length
    if (cleaned.length < 2 || cleaned.length > 30) return false;

    // Blacklist common spam words
    const blacklist = [
        'test',
        'spam',
        'scam',
        'fake',
        'token',
        'coin',
        'airdrop',
    ];

    if (blacklist.some((word) => cleaned.includes(word))) return false;

    return true;
}

module.exports = {
    sleep,
    retry,
    processBatch,
    isValidTokenName,
};
