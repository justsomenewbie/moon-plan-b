// Chung's FE handoff allows 180 seconds per ordinary producer request.
export const producerTimeoutMs = 180_000;
export const browserTimeoutMs = producerTimeoutMs + 10_000;
