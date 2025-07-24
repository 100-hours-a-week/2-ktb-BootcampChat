class MockRedisClient {
  constructor() {
    this.store = new Map();
    this.isConnected = true;
    console.log('Using in-memory Redis mock (Redis server not available)');
  }

  async connect() {
    return this;
  }

  async set(key, value, options = {}) {
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    this.store.set(key, { value: stringValue, expires: options.ttl ? Date.now() + (options.ttl * 1000) : null });
    return 'OK';
  }

  async get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    
    if (item.expires && Date.now() > item.expires) {
      this.store.delete(key);
      return null;
    }
    
    try {
      return JSON.parse(item.value);
    } catch {
      return item.value;
    }
  }

  async setEx(key, seconds, value) {
    return this.set(key, value, { ttl: seconds });
  }

  async del(key) {
    return this.store.delete(key) ? 1 : 0;
  }

  async expire(key, seconds) {
    const item = this.store.get(key);
    if (item) {
      item.expires = Date.now() + (seconds * 1000);
      return 1;
    }
    return 0;
  }

  async quit() {
    this.store.clear();
    console.log('Mock Redis connection closed');
  }

  async keys(pattern) {
    const store = this.store;
    return Array.from(store.keys()).filter(key =>
      new RegExp('^' + pattern.replace(/\*/g, '.*') + '$').test(key)
    );
  }

  async hset(key, field, value) {
    const hashKey = `${key}:${field}`;
    return this.set(hashKey, value);
  }

  async hget(key, field) {
    const hashKey = `${key}:${field}`;
    return this.get(hashKey);
  }

  async hdel(key, field) {
    const hashKey = `${key}:${field}`;
    return this.del(hashKey);
  }

  async hincrby(key, field, increment) {
    const hashKey = `${key}:${field}`;
    let currentValue = await this.get(hashKey);
    currentValue = parseInt(currentValue || '0', 10);
    const newValue = currentValue + increment;
    await this.set(hashKey, newValue.toString());
    return newValue;
  }

  async hvals(key) {
    const prefix = `${key}:`;
    const values = [];
    for (const [k, item] of this.store.entries()) {
      if (k.startsWith(prefix)) {
        try {
          values.push(JSON.parse(item.value));
        } catch {
          values.push(item.value);
        }
      }
    }
    return values;
  }
}

module.exports = MockRedisClient;