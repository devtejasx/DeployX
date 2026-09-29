import redisConnection from '../db/redis.js';
import { deploymentChannel } from './deploymentEvents.js';

// Receives deployment events for live log streams (SSE).
//
// A Redis connection in subscriber mode cannot run other commands, so this is
// the API's one extra connection: a single subscriber shared by every open
// stream. Each deployment channel is subscribed once, while at least one
// stream listens to it, and unsubscribed when the last one goes away.
let subscriber = null;
const listenersByChannel = new Map();
let lastError = null;

function getSubscriber() {
  if (!subscriber) {
    subscriber = redisConnection.duplicate({
      lazyConnect: false,
      // Queue SUBSCRIBE while (re)connecting; ioredis re-subscribes to every
      // channel automatically after a reconnect.
      enableOfflineQueue: true,
    });
    subscriber.on('error', (err) => {
      const message = err.message || err.code || String(err);
      if (message !== lastError) {
        console.error('[events] subscriber connection error:', message);
        lastError = message;
      }
    });
    subscriber.on('ready', () => {
      lastError = null;
    });
    subscriber.on('message', (channel, message) => {
      const listeners = listenersByChannel.get(channel);
      if (!listeners) return;
      let event;
      try {
        event = JSON.parse(message);
      } catch {
        return; // not one of ours
      }
      for (const listener of listeners) listener(event);
    });
  }
  return subscriber;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Redis subscribe timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Calls `listener(event)` for every event of this deployment. Returns
// { unsubscribe, live }: `live` is false if Redis could not be subscribed to
// (callers then rely on polling the database).
export async function subscribeToDeployment(deploymentId, listener) {
  const channel = deploymentChannel(deploymentId);
  let listeners = listenersByChannel.get(channel);
  const first = !listeners;
  if (first) {
    listeners = new Set();
    listenersByChannel.set(channel, listeners);
  }
  listeners.add(listener);

  let live = true;
  if (first) {
    try {
      await withTimeout(getSubscriber().subscribe(channel), 2000);
    } catch (err) {
      live = false;
      console.warn(`[events] live events unavailable for deployment ${deploymentId}:`, err.message || err);
    }
  }

  let active = true;
  function unsubscribe() {
    if (!active) return;
    active = false;
    listeners.delete(listener);
    if (listeners.size === 0 && listenersByChannel.get(channel) === listeners) {
      listenersByChannel.delete(channel);
      subscriber?.unsubscribe(channel).catch(() => {});
    }
  }

  return { unsubscribe, live };
}

// Channels with at least one listener, and the listener total (for tests
// and diagnostics).
export function subscriptionStats() {
  let listeners = 0;
  for (const set of listenersByChannel.values()) listeners += set.size;
  return { channels: [...listenersByChannel.keys()], listeners };
}

export async function closeSubscriber() {
  listenersByChannel.clear();
  if (subscriber) {
    const current = subscriber;
    subscriber = null;
    await current.quit().catch(() => current.disconnect());
  }
}
