import WebSocket from 'ws';

const ws = new WebSocket('wss://pumpportal.fun/api/data');

ws.on('open', function open() {
    // Subscribing to all trades on tokens
    const payload = {
        method: "subscribeTokenTrade",
        keys: ["*"] // Empty array or wildcard to indicate all trades
    };
    ws.send(JSON.stringify(payload));
});

ws.on('message', function message(data) {
    console.log(JSON.parse(data));
});
